// assistant 文本里的「动作型事实」抽取（T90 A7–A9）。
//
// 为什么单独抽一层而不是把整段话塞进库：
//   一轮工作里最有检索价值的信息不是叙述，而是三件硬事实——
//   改了什么文件、跑了什么命令得到什么结果、结论是已修还是还差什么。
//   这三件事在原文里是散落的（一段话里可能只出现一次），整段入库时
//   BM25 会被叙述性词汇稀释，用 `auto-capture-assistant.mjs` 这类路径片段
//   反而不一定命中。抽成结构化清单后，路径与命令本身就是高频 token。
//
// 设计约束：
//   - 只读取，不改写原文；抽不到就是空清单，绝不猜测补全。
//   - 所有正则都锚在「动作词 / 命令词 / 结论词」上，宁可少抽也不抽错：
//     一条错误事实的检索危害远大于漏掉一条。
//   - 不依赖外部词表文件，规则全部内联，便于测试逐条钉死。

import { splitSentences } from './judge.mjs';

/** 动作词 → 归一后的动作标签。顺序即优先级，长词在前避免被短词截胡。 */
const ACTIONS = Object.freeze([
  ['重写', '重写'],
  ['移植', '移植'],
  ['同步', '同步'],
  ['接入', '接入'],
  ['新增', '新增'],
  ['添加', '新增'],
  ['创建', '新增'],
  ['新建', '新增'],
  ['修改', '修改'],
  ['改动', '修改'],
  ['修复', '修复'],
  ['修好', '修复'],
  ['删除', '删除'],
  ['移除', '删除'],
  ['替换', '替换'],
  ['改成', '修改'],
  ['更新', '更新'],
  ['补上', '新增'],
  ['补了', '新增'],
  ['挂上', '接入'],
  ['抽出', '新增'],
]);

/** 路径：Windows 绝对 / POSIX 绝对 / 带已知源目录前缀的相对路径。 */
const PATH_PATTERNS = Object.freeze([
  /[A-Za-z]:[\\/][^\s"'`，。；、）)\]】|]+/g,
  /(?:^|[\s（(])((?:\/[\w.-]+){2,}\.[A-Za-z0-9]{1,8})/g,
  /(?:^|[\s（(])((?:src|test|tests|lib|docs|scripts|tools|bin|config)\/[\w.\/-]+\.[A-Za-z0-9]{1,8})/g,
]);

/** 命令：反引号内、整行、以及句子中间的行内调用。 */
const COMMAND_PATTERNS = Object.freeze([
  /`([^`\n]{4,200})`/g,
  /^[ \t]*((?:node|npm|pnpm|yarn|python|py|git|pwsh|powershell|bash|cargo|go)[ \t][^\n]{0,200})$/gm,
  // 行内：命令后面跟中文标点就收口，避免把整段话吸进命令。
  /(?:^|[\s（(，、：])((?:node|npm|pnpm|yarn|python|git|pwsh|powershell|bash|cargo|go)[ \t][^\s，。；、）)|`]{2,}(?:[ \t][^\s，。；、）)|`]{1,}){0,12})/g,
]);

/** 可执行前缀白名单：只有这些开头的反引号内容才当命令。 */
const COMMAND_HEADS = Object.freeze([
  'node ', 'npm ', 'pnpm ', 'yarn ', 'python', 'py ', 'git ', 'pwsh ', 'powershell',
  'bash ', 'cargo ', 'go ', 'ffmpeg ', 'curl ',
]);

/** 命令结果的锚点。全部带捕获组，抽出来直接当证据片段。 */
const RESULT_PATTERNS = Object.freeze([
  /\b(\d{1,5})\s*\/\s*(\d{1,5})\b/,          // 51/51
  /\bexit\s*(?:code\s*)?([0-9]{1,3})\b/i,    // exit 0
  /\b(\d{1,5})\s+(?:passed|passing)\b/i,     // 51 passed
  /\b(\d{1,5})\s+(?:failed|failing|fail)\b/i,
  /\b(PASS|FAIL|OK|ERROR)\b/,
  // 中文表述：实测助手最常说「51 项全绿」「67 过 5 败」，不认这两种就等于漏掉一半结果。
  /\b(\d{1,5})\s*项\s*(?:全绿|全过|通过|通过率)/,
  /\b(\d{1,5})\s*过\s*(\d{1,5})\s*败/,
  /(全绿|全部通过|零失败|退出码\s*0|返回\s*0)/,
]);

/** 结论词 → 分类。四类对应「做过什么 / 结论是什么 / 还差什么 / 下一步」。 */
const CONCLUSION_KINDS = Object.freeze([
  ['根因是', 'root-cause'],
  ['原因是', 'root-cause'],
  ['根因在', 'root-cause'],
  ['已修', 'fixed'],
  ['已修复', 'fixed'],
  ['修好了', 'fixed'],
  ['已解决', 'fixed'],
  ['验证', 'verified'],
  ['实跑', 'verified'],
  ['跑通', 'verified'],
  ['全绿', 'verified'],
  ['剩下', 'remaining'],
  ['还差', 'remaining'],
  ['待办', 'remaining'],
  ['没做', 'remaining'],
  ['下一步', 'next'],
  ['接下来', 'next'],
  ['结论是', 'conclusion'],
  ['结论：', 'conclusion'],
]);

const WS_RE = /\s+/g;
const MAX_FACTS = 12;

/** 去空白长度。与 segment / assistant 模块同一把尺。 */
function weight(text) {
  return String(text ?? '').replace(WS_RE, '').length;
}

/** 路径尾部去标点，避免把中文句读吸进路径。 */
function trimPath(raw) {
  return String(raw ?? '').replace(/[.,;:'")\]}】]+$/u, '');
}

/**
 * 在句子中找「动作词 + 路径」的配对。窗口是 ±28 字，超出视为无关叙述。
 * @returns {{action: string, path: string, sentence: string}|null}
 */
function pairActionPath(sentence) {
  for (const pattern of PATH_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(sentence)) !== null) {
      const path = trimPath(m[1] ?? m[0]);
      if (!path || path.length < 4) continue;
      const at = m.index;
      const windowStart = Math.max(0, at - 28);
      const windowEnd = Math.min(sentence.length, at + path.length + 28);
      const around = sentence.slice(windowStart, windowEnd);
      for (const [word, label] of ACTIONS) {
        if (around.includes(word)) return { action: label, path, sentence: sentence.trim() };
      }
    }
  }
  return null;
}

/** 从命令周围找结果锚点。 */
function findResult(text) {
  for (const pattern of RESULT_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return m[2] !== undefined ? `${m[1]}/${m[2]}` : m[0].trim();
  }
  return '';
}

/**
 * 抽动作型事实。
 *
 * @param {string} text 助手正文（已剥围栏的段落或整轮文本都行）
 * @returns {{
 *   paths: {action: string, path: string, sentence: string}[],
 *   commands: {command: string, result: string, sentence: string}[],
 *   conclusions: {kind: string, sentence: string}[],
 *   total: number,
 * }}
 */
export function extractActionFacts(text) {
  const out = { paths: [], commands: [], conclusions: [], total: 0 };
  try {
    const body = typeof text === 'string' ? text : '';
    if (body.trim() === '') return out;

    let sentences;
    try {
      sentences = splitSentences(body);
    } catch {
      sentences = [{ text: body }];
    }
    if (!Array.isArray(sentences) || sentences.length === 0) sentences = [{ text: body }];

    const seenPath = new Set();
    const seenCommand = new Set();
    const seenConclusion = new Set();

    for (const item of sentences) {
      const sentence = typeof item?.text === 'string' ? item.text : '';
      if (sentence.trim() === '') continue;

      // 1. 路径 + 动作
      const pair = pairActionPath(sentence);
      if (pair && out.paths.length < MAX_FACTS) {
        const key = `${pair.action}|${pair.path}`;
        if (!seenPath.has(key)) {
          seenPath.add(key);
          out.paths.push(pair);
        }
      }

      // 2. 命令 + 结果：命令与结果可以分处相邻句，所以先在整句里找命令，
      //    再看同句是否带结果锚点；没有就向后多看一句（命令与统计常被换行隔开）。
      for (const pattern of COMMAND_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(sentence)) !== null) {
          const command = String(m[1] ?? m[0]).trim();
          if (command === '') continue;
          const lower = command.toLowerCase();
          if (!COMMAND_HEADS.some((head) => lower.startsWith(head))) continue;
          const key = command.slice(0, 160);
          if (seenCommand.has(key)) continue;
          seenCommand.add(key);
          if (out.commands.length < MAX_FACTS) {
            out.commands.push({ command: key, result: findResult(sentence), sentence: sentence.trim() });
          }
        }
      }

      // 3. 结论句
      for (const [word, kind] of CONCLUSION_KINDS) {
        if (!sentence.includes(word)) continue;
        if (weight(sentence) < 8) continue; // 光一个词不算结论，得成句
        const key = `${kind}|${sentence.trim().slice(0, 80)}`;
        if (seenConclusion.has(key)) continue;
        seenConclusion.add(key);
        if (out.conclusions.length < MAX_FACTS) {
          out.conclusions.push({ kind, sentence: sentence.trim() });
        }
      }
    }

    out.total = out.paths.length + out.commands.length + out.conclusions.length;
    return out;
  } catch {
    return { paths: [], commands: [], conclusions: [], total: 0 };
  }
}

/** 动作清单的紧凑渲染。一行一条，路径与命令原样保留（检索靠它们）。 */
export function renderFacts(facts, options = {}) {
  const cfg = options && typeof options === 'object' ? options : {};
  const limit = Number.isFinite(Number(cfg.limit)) && Number(cfg.limit) > 0 ? Number(cfg.limit) : 8;
  const lines = [];
  for (const p of (facts?.paths ?? []).slice(0, limit)) lines.push(`- ${p.action} ${p.path}`);
  for (const c of (facts?.commands ?? []).slice(0, limit)) {
    lines.push(c.result ? `- 命令 ${c.command} → ${c.result}` : `- 命令 ${c.command}`);
  }
  const seenKind = new Set();
  for (const c of facts?.conclusions ?? []) {
    if (seenKind.has(c.kind)) continue;
    seenKind.add(c.kind);
    lines.push(`- ${c.sentence}`);
  }
  const body = lines.join('\n');
  if (cfg.title) return body === '' ? '' : `${cfg.title}\n${body}`;
  return body;
}

/**
 * 本轮工作状态摘要：300–800 字。
 *
 * 只取「结论 / 剩余 / 下一步」三类句子 + 动作清单，绝不把整轮对话塞进来。
 * 长度不足 300 时用动作清单补，补不够 300 就返回 null（宁缺毋滥：
 * 一条 120 字的碎片只会占席位、检索不到东西）。
 *
 * @returns {string|null}
 */
export function buildWorkState(text, facts, options = {}) {
  try {
    const cfg = options && typeof options === 'object' ? options : {};
    const minChars = Number.isFinite(Number(cfg.minChars)) && Number(cfg.minChars) > 0 ? Number(cfg.minChars) : 300;
    const maxChars = Number.isFinite(Number(cfg.maxChars)) && Number(cfg.maxChars) > 0 ? Number(cfg.maxChars) : 800;

    const body = typeof text === 'string' ? text : '';
    const picked = [];
    const seen = new Set();
    const wanted = new Set(['conclusion', 'root-cause', 'fixed', 'verified', 'remaining', 'next']);
    for (const c of facts?.conclusions ?? []) {
      if (!wanted.has(c.kind)) continue;
      const key = c.sentence.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(key);
      if (picked.length >= 8) break;
    }

    const parts = [];
    if (picked.length > 0) parts.push(picked.join('\n'));
    const renderedFacts = renderFacts(facts, { limit: 6 });
    if (renderedFacts) parts.push(renderedFacts);

    // splitSentences 的片段不带换行，直接 += 会把「750/381」和下一句粘成
    // 「750/381跑…」，检索时看不出边界，也会让人误读成命令的一部分。
    const joinPiece = (acc0, piece) => (acc0 === '' || acc0.endsWith('\n') ? acc0 + piece : `${acc0}\n${piece}`);

    let state = parts.join('\n').trim();
    if (state === '') return null;

    // 超上限：按句截到 800 以内，末尾不加省略号（那是"半句话"，检索里看不出截断）。
    if (weight(state) > maxChars) {
      let acc = '';
      let sentences;
      try {
        sentences = splitSentences(state);
      } catch {
        sentences = [];
      }
      for (const s of (Array.isArray(sentences) ? sentences : [])) {
        const piece = typeof s?.text === 'string' ? s.text : '';
        if (piece === '') continue;
        if (weight(joinPiece(acc, piece)) > maxChars) break;
        acc = joinPiece(acc, piece);
      }
      state = acc.trim();
    }

    if (weight(state) < minChars) {
      // 不够 300：用原文首段补齐（只补到 minChars 为止，最多一次）。
      const filler = String(body ?? '').trim();
      if (filler !== '' && weight(state + filler) >= minChars) {
        let acc = state;
        let sentences;
        try {
          sentences = splitSentences(filler);
        } catch {
          sentences = [];
        }
        for (const s of (Array.isArray(sentences) ? sentences : [])) {
          const piece = typeof s?.text === 'string' ? s.text : '';
          if (piece === '') continue;
          if (state.includes(piece.trim().slice(0, 20))) continue;
          if (weight(joinPiece(acc, piece)) > maxChars) break;
          acc = joinPiece(acc, piece);
          if (weight(acc) >= minChars) break;
        }
        state = acc.trim();
      }
    }

    if (weight(state) < minChars) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * 段打分：决定这一轮里哪几段值得落库。
 *
 * 权重构成（全部可解释，不引入随机或模型）：
 *   - 长度分：越接近 maxChars 越值钱（信息密度高），但封顶。
 *   - 事实分：含路径/命令/结论词的段，检索命中率显著更高。
 *   - 标题分：带小节标题的段自带上文，单独可读。
 *   - 主旨分：标题里带「根因 / 结论 / 验证 / 还差 / 下一步」的段，是这一轮最该被记住的
 *     那几句的所在地。实测（smoke-plan.mjs）不加这一项时，一段「## 根因定位」会被
 *     「## 改动清单」挤掉——因为改动清单的路径多、事实密度高，而根因段往往只有一两句话。
 */
export function scoreSegment(text, facts) {
  const body = typeof text === 'string' ? text : '';
  const w = weight(body);
  let score = Math.min(1, w / 1200);
  if (facts && Number(facts.total) > 0) score += Math.min(0.5, 0.15 * Number(facts.total));
  if (/^[ \t]{0,3}#{1,6}[ \t]+\S/m.test(body)) score += 0.2;
  const titleLine = body.split('\n')[0] ?? '';
  if (/(根因|结论|验证|跑通|还差|剩下|下一步|待办)/.test(titleLine)) score += 0.45;
  return Math.round(score * 1000) / 1000;
}
