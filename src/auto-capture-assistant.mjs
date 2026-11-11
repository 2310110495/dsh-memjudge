// auto-capture 的 assistant 侧（T87）：把助手自己的结论变成记忆。
//
// 为什么必须单独一份判定内核，而不是给 CAPTURE_KINDS 加一个 'model'：
//   1. 用户与助手的噪声分布完全不同。用户的一句话通常就是结论本身；助手的一条消息
//      90% 是过程（"我先看一下"、工具调用、表格、命令清单），结论只在少数几句里。
//      用同一套 12-600 字的闸去卡助手输出，等于把整篇回答灌进库里。
//   2. 既有测试把 user 通路的每条阈值钉死了（test/auto-capture.test.mjs L65-93 断言
//      CAPTURE_KINDS 必须恰好是 ['user']，L168-190 钉死 0.8462/0.8605 两侧）。
//      动那份白名单就是改契约；独立模块让两条通路各自演进、互不回归。
//
// 五道闸（顺序即短路顺序）：
//   A1 身份：role==='assistant' 且 source.kind==='model'（排除插件/hook 注入的假助手消息）
//   A2 形态：只留 text 块。reasoning（思考链）与 tool-call（函数名 + JSON 参数）整块剔除。
//   A3 代码围栏：先删掉 ``` 围栏内的内容（代码不是结论，且会把相似度算法带偏），再判余量。
//   A4 长度：去空白后 < minChars（200）→ 太短无信息；> maxChars（1200）→ 整篇回答，不截断直接弃。
//   A5 纯格式化：表格 / 目录树 / 命令清单 / 项目符号占比 ≥60% → 弃（人能读，检索读不懂）。
//   A6 近重复：与既有库语料 3-gram 多集 Jaccard ≥ 0.85 → 弃（助手爱重复自己说过的话）。
//
// T90：A3–A6 现在作用在**段**上，而不是整条消息上。真实回复普遍 800–3000 字，整条过
// maxChars 只会被扔；切成 200–1200 的语义段后，每段独立过闸、独立落库、独立去重
// （切点规则与合并规则见 src/auto-capture-segment.mjs 的文件头）。
// 一轮结束还会额外产出一条「工作状态」摘要，作为跨会话接手的钥匙。
//
// 与 user 通路共享的只有工具函数（normalizeText / nearDup / similarity）与配置解析习惯，
// 不共享任何阈值常量。所有入口 fail-open：判定出错返回"不采"，绝不抛给宿主。

import { hasUnpairedSurrogate } from './text-wellformed.mjs';
import { nearDup, similarity } from './auto-capture.mjs';
import { planSegments, segmentWeight } from './auto-capture-segment.mjs';
import { buildWorkState, extractActionFacts, renderFacts, scoreSegment } from './auto-capture-facts.mjs';
import { splitSentences } from './judge.mjs';

/**
 * assistant 侧默认值。与 AUTO_DEFAULTS 刻意不同，每个数字都有理由：
 *   minChars 200：助手一句结论极少短于 200 字，低于这个数一般是过渡句（"好的，我来看看"）。
 *   maxChars 1200：超过这个长度的消息是整篇回答，里面通常混着代码与解释，整条记下来
 *                  会污染检索（记忆库要的是可复用结论，不是聊天存档）。
 *                  T90 之后这个数不再是"丢弃线"，而是**切段上限**：超了按 Markdown 结构切。
 *   perTurnLimit 6：实测一轮累积中位 2535 字（max 7912），planSegments 切出 3–5 段。
 *                  落库构型 = 「分数最高 4 段 + 1 条动作清单 + 1 条工作状态」= 6。
 *                  为什么是 4 段而不是 3：四小节回复（根因/改动/验证/还差）里，砍到 3 段时
 *                  实测被砍掉的正是「## 根因定位」——它字多、路径少、事实密度最低，按分排序
 *                  永远垫底。而它恰恰是下次开工最该读到的一段，所以宁可多留一席。
 *                  再多（7+）就是把同一轮的过程话分七份重复存一遍，检索时互相抢分。
 *                  量化账（50 轮/天）：6 条/轮，实际落库中位 4 条（近重复 0.85 还要再砍）→
 *                  约 200 条/天 × 平均 650 字 ≈ 130K 字/天 ≈ 390KB 正文/天，一个月 ≈ 12MB。
 *                  现有库 132 条 / 106KB，SQLite 毫无压力；真正的成本是注入面：
 *                  2000 字符硬顶只装得下十几条 descriptor，所以段条目靠 recall 检索、
 *                  只有状态摘要才配进注入面（见 STATUS_IMPORTANCE）。
 *   sessionLimit 120：6 条/轮 × 20 轮满额，或按实测中位 4 条/轮覆盖 30 轮。
 *                  取 60 的话 10 轮就打满，一个正常工作日的中段会静默断采——那比不采更糟，
 *                  因为用户会以为记了。近重复闸（0.85）在实际流量里通常还会再砍三到五成。
 *   importance 0.12：略高于用户条目的 0.1（我们自己的结论要能被召回），
 *                   但坚决留在 cold 档（<0.6），不许自动条目冒充人工事实。
 */
export const ASSISTANT_DEFAULTS = Object.freeze({
  enabled: true,
  minChars: 200,
  maxChars: 1200,
  perTurnLimit: 6,
  sessionLimit: 120,
  dupThreshold: 0.85,
  importance: 0.12,
  turnFlushChars: 2400,
});

/**
 * 「本轮工作状态」条目的重要度。比普通自动条目高（0.12 → 0.35），因为它回答的是
 * "上次我做了什么、结论是什么、下一步是什么"，是下次开工最该被注入的那一条；
 * 但仍 < 0.6 —— 它依旧是机器摘要，不许冒充人工事实挤掉 person/promise 的固定席位。
 */
export const STATUS_IMPORTANCE = 0.35;

/** A1 唯一白名单：assistant 消息的 source.kind。实测宿主只发 'model'（message.js 构造点）。 */
export const ASSISTANT_SOURCE_KINDS = Object.freeze(new Set(['model']));

const WS_RE = /\s+/g;
const FENCE_RE = /^[ \t]*(?:```|~~~)[^\n]*$/;
const LIST_LINE_RE = /^[ \t]*(?:[-*+]\s|\d+[.)]\s|#+\s|\$\s|>\s)/;
const TREE_LINE_RE = /^[ \t]*[├└│┌┐┘┬┴┼─]/;
const TABLE_LINE_RE = /^[ \t]*\|/;
const SENTENCE_END_RE = /[。；;！!？?]/;

/** 去空白后的有效长度。与 user 通路同一把尺，保证"长度"这个词只有一个含义。 */
function weight(text) {
  return String(text ?? '').replace(WS_RE, '').length;
}

/**
 * 删除代码围栏块（含 ```lang 起始行与闭合行）。未闭合的围栏删到结尾：
 * 宁可丢掉半条叙述，也不把一段代码当结论写进记忆。
 * @returns {string}
 */
export function stripCodeFences(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return '';
  const lines = raw.split('\n');
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inside = !inside;
      continue;
    }
    if (!inside) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 格式化行占比。表格/树/列表/命令行超过 60% 视为"排版产物"而不是结论。
 * 60% 而不是 50%：结论后常跟一个三行小列表，那仍是结论；整篇都是列表才是清单。
 * @returns {number} 0..1
 */
export function formatRatio(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return 0;
  let formatted = 0;
  for (const line of lines) {
    if (LIST_LINE_RE.test(line) || TREE_LINE_RE.test(line) || TABLE_LINE_RE.test(line)) formatted += 1;
  }
  return formatted / lines.length;
}

/** A5：纯格式化判定。没有任何句读且格式化行占多数 → 是清单/表格，不是结论。 */
export function isFormattedOnly(text) {
  const body = String(text ?? '');
  if (!SENTENCE_END_RE.test(body)) {
    // 完全没有句号的块，句读为零；此时只要格式化行过半就判死。
    return formatRatio(body) >= 0.5;
  }
  return formatRatio(body) >= 0.6;
}

/**
 * A2：从 assistant 消息的 content 里抽 text 块。
 * reasoning（思考链）与 tool-call（函数名 + 参数 JSON）必须整块剔除 —— 前者不是给用户看的，
 * 后者是代码片段，两者进库都会让检索命中一堆无意义 token。
 *
 * @returns {{problem: string|null, text: string, dropped: {reasoning: number, tool: number, other: number}}}
 */
export function inspectAssistantMessage(message) {
  const dropped = { reasoning: 0, tool: 0, other: 0 };
  try {
    if (!message || typeof message !== 'object') return { problem: 'not-message', text: '', dropped };

    if (message.role !== 'assistant') return { problem: 'role', text: '', dropped };

    const kind = message?.source?.kind;
    if (typeof kind !== 'string' || !ASSISTANT_SOURCE_KINDS.has(kind)) return { problem: 'source', text: '', dropped };

    const blocks = Array.isArray(message.content) ? message.content : [];
    const parts = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') { dropped.other += 1; continue; }
      if (block.type === 'reasoning') { dropped.reasoning += 1; continue; }
      if (block.type === 'tool-call' || block.type === 'tool-result' || block.type === 'tool_use') { dropped.tool += 1; continue; }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') { parts.push(block.text); continue; }
      dropped.other += 1;
    }

    const text = parts.join('\n');
    if (text === '') return { problem: 'no-text', text: '', dropped };
    if (hasUnpairedSurrogate(text)) return { problem: 'unpaired-surrogate', text: '', dropped };
    return { problem: null, text, dropped };
  } catch {
    // content 的 getter 抛错（第三方构造的假消息）不该把调用方拖下水。
    return { problem: 'error', text: '', dropped };
  }
}

/**
 * 配置归一。只读 config 对象，不往 resolveAutoConfig 的返回值里加键
 * （那条 deepEqual 断言是既有契约，加键就破）。
 */
export function resolveAssistantConfig(settings) {
  const src = settings && typeof settings === 'object' ? settings : {};
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  const frac = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0.5, n));
  };

  const enabled = src.autoCapture !== false && src.autoCaptureAssistant !== false;
  const minChars = num(src.autoCaptureAssistantMinChars, ASSISTANT_DEFAULTS.minChars, 120, 400);
  const maxChars = Math.max(minChars, num(src.autoCaptureAssistantMaxChars, ASSISTANT_DEFAULTS.maxChars, 400, 4000));

  return {
    enabled,
    minChars,
    maxChars,
    perTurnLimit: num(src.autoCaptureAssistantPerTurn, ASSISTANT_DEFAULTS.perTurnLimit, 1, 8),
    sessionLimit: num(src.autoCaptureAssistantLimitPerSession, ASSISTANT_DEFAULTS.sessionLimit, 1, 200),
    dupThreshold: frac(src.autoCaptureAssistantDupThreshold, ASSISTANT_DEFAULTS.dupThreshold),
    importance: ASSISTANT_DEFAULTS.importance,
    turnFlushChars: num(src.autoCaptureAssistantTurnFlushChars, ASSISTANT_DEFAULTS.turnFlushChars, 600, 12000),
  };
}

/**
 * 单条 assistant 消息的全链路判定（除配额）。
 * @param {object} message 宿主 AssistantMessage（{role, content, source})
 * @param {object} [options] assistant 配置 + {existing}
 * @returns {{ok: boolean, reason: string, text: string, importance: number}}
 */
export function assistantVerdict(message, options = {}) {
  const miss = { ok: false, reason: 'error', text: '', importance: 0 };
  try {
    const cfg = options && typeof options === 'object' ? options : {};
    const conf = {
      enabled: cfg.enabled !== false,
      minChars: Number.isFinite(Number(cfg.minChars)) ? Number(cfg.minChars) : ASSISTANT_DEFAULTS.minChars,
      maxChars: Number.isFinite(Number(cfg.maxChars)) ? Number(cfg.maxChars) : ASSISTANT_DEFAULTS.maxChars,
      dupThreshold: Number.isFinite(Number(cfg.dupThreshold)) ? Number(cfg.dupThreshold) : ASSISTANT_DEFAULTS.dupThreshold,
      importance: Number.isFinite(Number(cfg.importance)) ? Number(cfg.importance) : ASSISTANT_DEFAULTS.importance,
    };
    if (!conf.enabled) return { ...miss, reason: 'disabled' };

    const { problem, text } = inspectAssistantMessage(message);
    if (problem !== null) return { ...miss, reason: problem };

    // A3：先剥围栏再量长度。否则一段 800 字代码能把三句叙述顶到"够长"。
    const body = stripCodeFences(text);
    if (body.trim() === '') return { ...miss, reason: 'code-fence' };

    // A4：长度。太短与太长都不截断 —— 截断会造出库里没有、原文也没有的半句话。
    const len = weight(body);
    if (len < conf.minChars) return { ...miss, reason: 'too-short' };
    if (len > conf.maxChars) return { ...miss, reason: 'too-long' };

    // A5：纯格式化。
    if (isFormattedOnly(body)) return { ...miss, reason: 'formatted-only' };

    // A6：近重复。语料缺省则跳过。
    const existing = options?.existing;
    if (existing !== undefined && existing !== null) {
      const near = nearDup(body, existing, { threshold: conf.dupThreshold });
      if (near.dup) return { ...miss, reason: 'near-dup', text: body, importance: conf.importance };
    }

    return { ok: true, reason: 'assistant-conclusion', text: body, importance: conf.importance };
  } catch {
    return miss;
  }
}

/**
 * 一个 step 的 assistant 消息 → 待写入候选。与 extractCandidates 同形，便于接线层复用。
 * 配额是会话级短路：被拦即停，不再试后续消息。
 */
export function extractAssistantCandidates(messages, options = {}) {
  try {
    const cfg = options && typeof options === 'object' ? options : {};
    if (cfg.enabled === false) return [];
    if (!Array.isArray(messages)) return [];

    const existing = cfg.existing;
    const quota = cfg.quota;
    const sessionId = cfg.sessionId;
    const turn = cfg.turn;
    const at = Number.isFinite(Number(cfg.now)) ? Number(cfg.now) : undefined;

    const out = [];
    for (const message of messages) {
      const verdict = assistantVerdict(message, { ...cfg, existing });
      if (!verdict.ok) continue;
      if (quota && typeof quota.admit === 'function') {
        const gate = quota.admit(sessionId, turn, at);
        if (!gate?.ok) break;
      }
      out.push({ text: verdict.text, importance: verdict.importance, reason: verdict.reason });
    }
    return out;
  } catch {
    return [];
  }
}

/** 只读自检：给测试与排障看两条文本的相似度（复用 user 通路的算法，不做第二套）。 */
export function assistantSimilarity(a, b) {
  return similarity(a, b);
}

// ---------------------------------------------------------------- 轮级分段采集（T90）

/** 段条目的 reason 标签，供落库与诊断共用同一个字符串。 */
export const SEGMENT_REASON = 'assistant-segment';
export const STATE_REASON = 'assistant-turn-state';
export const FACTS_REASON = 'assistant-turn-facts';

/**
 * 一轮累积文本 → 待落库候选（段 + 工作状态 + 动作清单）。
 *
 * 这是 T90 的真正入口。它不碰配额（配额是会话级状态，属于接线层），
 * 只回答「这一轮的文本里有哪些东西值得记、按什么顺序记」。
 *
 * 闸门一个都不少，只是作用域从「整条消息」变成「段」：
 *   stripCodeFences → isFormattedOnly → 长度 → nearDup，逐段独立。
 * 段内残留的未闭合围栏要再剥一次（planSegments 已丢完整围栏块，但段尾可能带残片）。
 *
 * @param {string} text 一轮累积的助手正文
 * @param {object} [options] assistant 配置 + {existing, sessionId, turn}
 * @returns {{
 *   candidates: {text: string, importance: number, reason: string, part: string}[],
 *   segments: {text: string, index: number, weight: number, score: number}[],
 *   dropped: {reason: string, lines: string[], weight: number}[],
 *   facts: {paths: object[], commands: object[], conclusions: object[], total: number},
 *   state: string|null,
 *   reasons: Record<string, number>,
 *   weight: number,
 * }}
 */
export function planAssistantCapture(text, options = {}) {
  const emptyFacts = { paths: [], commands: [], conclusions: [], total: 0 };
  const miss = { candidates: [], segments: [], dropped: [], facts: emptyFacts, state: null, reasons: {}, weight: 0 };
  try {
    const cfg = options && typeof options === 'object' ? options : {};
    const conf = {
      enabled: cfg.enabled !== false,
      minChars: Number.isFinite(Number(cfg.minChars)) ? Number(cfg.minChars) : ASSISTANT_DEFAULTS.minChars,
      maxChars: Number.isFinite(Number(cfg.maxChars)) ? Number(cfg.maxChars) : ASSISTANT_DEFAULTS.maxChars,
      dupThreshold: Number.isFinite(Number(cfg.dupThreshold)) ? Number(cfg.dupThreshold) : ASSISTANT_DEFAULTS.dupThreshold,
      perTurnLimit: Number.isFinite(Number(cfg.perTurnLimit)) ? Math.trunc(Number(cfg.perTurnLimit)) : ASSISTANT_DEFAULTS.perTurnLimit,
    };
    if (!conf.enabled) return { ...miss, reasons: { disabled: 1 } };

    const raw = typeof text === 'string' ? text : '';
    if (raw.trim() === '') return { ...miss, reasons: { empty: 1 } };

    const reasons = {};
    const bump = (reason) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };

    // A3（整篇）：先把完整围栏块剥掉。planSegments 内部也会丢围栏，这里剥是为了
    // 让「围栏里的代码不算长度」这件事在切段之前就成立。
    const body = stripCodeFences(raw);
    if (body.trim() === '') return { ...miss, reasons: { 'code-fence': 1 } };

    const plan = planSegments(body, { minChars: conf.minChars, maxChars: conf.maxChars });
    const dropped = Array.isArray(plan?.dropped) ? plan.dropped : [];
    for (const item of dropped) bump(item?.reason || 'dropped');

    const existing = cfg.existing;
    const existingList = Array.isArray(existing) ? existing : null;

    const kept = [];
    for (const segment of (Array.isArray(plan?.segments) ? plan.segments : [])) {
      const rawSeg = typeof segment?.text === 'string' ? segment.text : '';
      if (rawSeg.trim() === '') { bump('empty'); continue; }

      // 段内残留围栏（段尾截断的 ```）再剥一次。
      const segBody = stripCodeFences(rawSeg);
      if (segBody.trim() === '') { bump('code-fence'); continue; }

      if (isFormattedOnly(segBody)) { bump('formatted-only'); continue; }

      const w = segmentWeight(segBody);
      if (w < conf.minChars) { bump('too-short'); continue; }
      if (w > conf.maxChars) { bump('too-long'); continue; }

      const factsForSeg = extractActionFacts(segBody);
      kept.push({
        text: segBody,
        index: Number.isFinite(Number(segment?.index)) ? Number(segment.index) : kept.length + 1,
        weight: w,
        score: scoreSegment(segBody, factsForSeg),
      });
    }

    // 段留两个坑给「工作状态」与「动作清单」：它们是这一轮最像"交接条"的两条。
    const segmentSlots = Math.max(0, conf.perTurnLimit - 2);
    const ranked = [...kept].sort((a, b) => b.score - a.score).slice(0, segmentSlots);
    // 输出顺序回到原文顺序：读起来仍是同一轮的时间线。
    ranked.sort((a, b) => a.index - b.index);

    // 去重必须发生在**截断之后**。先按固定规则（分数）决定这一轮该记哪几段，
    // 再拿库里的正文做近重复比对——这样「记哪几段」只由本轮文本决定，与库内容无关。
    // 反过来先按库过滤再截断，会让上一轮被截掉的低分段落，在重放时因为高分段落
    // 被判重复空出名额而冒出来，同一份回复投两次就会多出条目（幂等性破裂）。
    const deduped = [];
    for (const seg of ranked) {
      if (existingList !== null) {
        const near = nearDup(seg.text, existingList, { threshold: conf.dupThreshold });
        if (near?.dup) { bump('near-dup'); continue; }
      }
      deduped.push(seg);
    }

    const facts = extractActionFacts(body);
    const candidates = [];

    // 1) 工作状态排第一：它回答「上次我做了什么、结论是什么、下一步是什么」。
    const state = buildWorkState(body, facts, { minChars: 300, maxChars: 800 });
    if (state !== null) {
      let dup = false;
      if (existingList !== null) {
        const near = nearDup(state, existingList, { threshold: conf.dupThreshold });
        dup = Boolean(near?.dup);
      }
      if (dup) bump('near-dup');
      else candidates.push({ text: state, importance: STATUS_IMPORTANCE, reason: STATE_REASON, part: 'r' });
    } else {
      bump('state-too-thin');
    }

    // 2) 段正文。
    for (const seg of deduped) {
      candidates.push({
        text: seg.text,
        importance: conf.importance ?? ASSISTANT_DEFAULTS.importance,
        reason: SEGMENT_REASON,
        part: `p${seg.index}`,
      });
    }

    // 3) 动作清单：只在抽到 ≥2 项、且状态摘要没把它们整段覆盖时单独落一条。
    let factsText = '';
    if (facts.total >= 2) {
      const title = Number.isFinite(Number(cfg.turn)) ? `本轮动作（t${Number(cfg.turn)}）` : '本轮动作';
      factsText = renderFacts(facts, { limit: 8, title });
      if (factsText !== '' && state !== null && state.includes(factsText.slice(factsText.indexOf('\n') + 1))) {
        // 状态摘要已经完整包含这份清单，不再重复占位。
        factsText = '';
        bump('facts-covered-by-state');
      }
    }
    if (factsText !== '') {
      let dup = false;
      if (existingList !== null) {
        const near = nearDup(factsText, existingList, { threshold: conf.dupThreshold });
        dup = Boolean(near?.dup);
      }
      if (dup) bump('near-dup');
      else candidates.push({ text: factsText, importance: Math.max(STATUS_IMPORTANCE, 0.2), reason: FACTS_REASON, part: 'f' });
    }

    return {
      candidates: candidates.slice(0, Math.max(1, conf.perTurnLimit)),
      segments: deduped,
      dropped,
      facts,
      state,
      reasons,
      weight: segmentWeight(body),
    };
  } catch {
    return miss;
  }
}
