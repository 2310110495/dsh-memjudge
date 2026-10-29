// auto-capture T1：采集判定内核（纯函数，不接线）。
//
// 三条不可协商的约束：
//   1. 零外部依赖：不引 fs / sqlite / cordis / 宿主模块，不发任何网络请求。
//      拒绝标准（spec §10 T1）：任何一条判定依赖真实 DB 或宿主模块即不合格。
//   2. fail-open：任何形状不对的输入返回「没有候选」「不拦」「解析失败」，绝不抛错。
//      这条路径将来挂在 agent/pre-step 的 waterfall 上，抛错会 reject 整条链并毁掉
//      该轮对话（spec §7.1 实测 T5）。所以每个导出函数的入口都是 try 包裹的最外层。
//   3. 永不截断候选文本：超长整条丢弃（spec §3.1 G3）。记忆库立身之本是逐字可信，
//      截断等于制造库里没有、原文也没有的半句话。sessionToken 取会话 id 前 8 位是
//      标记格式规定（spec §4.2），不是文本截断。
//
// 设计真源：docs/auto-capture-spec.md §2.2（判定顺序）/ §3.1-§3.6（六道闸与取值）/
// §4.2（source 标记）/ §6.3（配置键）。接线（pre-step 挂载、store.put、章号分配）
// 属 T2，本文件不碰。

/** 全部默认值集中一处：面板、测试与 T2 共用同一份真源（spec §3.1 表）。 */
export const AUTO_DEFAULTS = Object.freeze({
  /** 采集总开关。默认开：默认关等于没做（spec §6.1）。 */
  enabled: true,
  /** G2 最小长度（去空白后的字符数）。12 = 排除寒暄、不误伤最短事实的交点。 */
  minChars: 12,
  /** G3 最大长度（原文长度）。超长整条丢弃，绝不截断。 */
  maxChars: 600,
  /** G6 单轮上限。 */
  perTurnLimit: 2,
  /** G6 单会话累计上限。 */
  sessionLimit: 40,
  /** G6 同会话冷却毫秒数。 */
  cooldownMs: 5000,
  /** G5 近重复阈值：3-gram 多集 Jaccard ≥ 此值即判重。 */
  dupThreshold: 0.85,
  /** 普通自动条目的 importance：落在 cold 档（半衰期 12 天），两周没人再提就沉底。 */
  importance: 0.1,
  /** 带约定标记的条目：仍低于 0.6，不进 warm 档，但检索里排得靠前（spec §3.5）。 */
  directiveImportance: 0.55,
});

/** 配额表最多记多少个会话（进程内状态，超出按 lastAt 淘汰最旧，spec §3.4）。 */
const MAX_QUOTA_SESSIONS = 64;

/**
 * G1 唯一白名单。用白名单不用黑名单：source.kind 是开放字符串，本机已数出 14 种以上，
 * 第三方插件随时能造新 kind。黑名单漏一种就灌一次垃圾，白名单漏一种只是少记一条。
 */
export const CAPTURE_KINDS = Object.freeze(new Set(['user']));

const WS_RE = /\s+/g;
const NORMALIZE_PUNCT_RE = /[，。！？；：、,.!?;:'"「」()（）]/g;
const PUNCT_ONLY_RE = /^[\p{P}\p{S}]+$/u;
const PSEUDO_SYSTEM_RE = /^<[a-z][a-z0-9-]*>/i;
const QUESTION_RE = /[?？]\s*$|^(如何|怎么|怎样|为什么|为何|是否|哪|多少|能不能|可不可以)|(吗|呢)\s*$/;
const DIRECTIVE_RE = /(记住|记一下|记下|以后|今后|永远|别再|不要再|总是|一律|必须|约定|规则|规范|习惯上)/;

/**
 * 寒暄词表。只在「整条消息无空白、且归一后精确等于其中之一」时命中。
 * 12 字的 G2 已经吃掉绝大部分寒暄；这张表是防「把 minChars 调低」之后的漏网。
 */
const GREETINGS = new Set([
  'ok', 'okay', '好', '好的', '好滴', '嗯', '嗯嗯', '哦', '收到', '继续', '看一下',
  '行', '可以', '是的', '明白', '了解', '谢谢', '多谢', 'thx', 'thanks', 'nice', 'go',
]);

// ---------------------------------------------------------------- 小工具

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function clampNum(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function stripWs(text) {
  return String(text ?? '').replace(WS_RE, '');
}

function charLength(text) {
  return [...String(text ?? '')].length;
}

/** 出现最多的那个字符占总字符数的比例（按码点计，emoji 不会被拆成两半）。 */
function topCharRatio(text) {
  const counts = new Map();
  let top = 0;
  const chars = [...String(text ?? '')];
  for (const ch of chars) {
    const n = (counts.get(ch) ?? 0) + 1;
    counts.set(ch, n);
    if (n > top) top = n;
  }
  return chars.length === 0 ? 0 : top / chars.length;
}

// ---------------------------------------------------------------- 配置归一

/**
 * 归一化配置。非法值一律回落默认，绝不抛错（沿用 src/index.mjs 的 resolveConfig 风格：
 * 「插件装不上比参数被钳更糟」）。
 *
 * 同时认两套键名：spec §6.3 的面板键（autoCapture / autoCaptureLimitPerSession /
 * autoCaptureMinChars）与本文件内部的短名，这样 T2 可以直接把 memjudge 的 cfg 传进来。
 * 对已归一过的对象幂等。
 *
 * @param {object} [raw]
 */
export function resolveAutoConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (...keys) => {
    for (const k of keys) if (src[k] !== undefined) return src[k];
    return undefined;
  };

  const minChars = clampInt(pick('autoCaptureMinChars', 'minChars'), 4, 200, AUTO_DEFAULTS.minChars);
  const maxChars = clampInt(pick('autoCaptureMaxChars', 'maxChars'), 12, 20000, AUTO_DEFAULTS.maxChars);
  const enabledRaw = pick('autoCapture', 'enabled');

  return {
    enabled: enabledRaw !== false,
    minChars,
    // 不让 minChars > maxChars 造出「无解区间」：调小上限的一方让步。
    maxChars: Math.max(maxChars, minChars),
    perTurnLimit: clampInt(pick('autoCapturePerTurn', 'perTurnLimit'), 1, 20, AUTO_DEFAULTS.perTurnLimit),
    sessionLimit: clampInt(
      pick('autoCaptureLimitPerSession', 'sessionLimit'),
      1,
      200,
      AUTO_DEFAULTS.sessionLimit,
    ),
    cooldownMs: clampInt(pick('autoCaptureCooldownMs', 'cooldownMs'), 0, 3_600_000, AUTO_DEFAULTS.cooldownMs),
    dupThreshold: clampNum(
      pick('autoCaptureDupThreshold', 'dupThreshold'),
      0.5,
      1,
      AUTO_DEFAULTS.dupThreshold,
    ),
    importance: clampNum(pick('autoCaptureImportance', 'importance'), 0, 1, AUTO_DEFAULTS.importance),
    directiveImportance: clampNum(
      pick('autoCaptureDirectiveImportance', 'directiveImportance'),
      0,
      1,
      AUTO_DEFAULTS.directiveImportance,
    ),
  };
}

// ---------------------------------------------------------------- G1 + 形态：单条消息

/** 把消息里所有 type==='text' 的非空 block 按序拼起来。不用 firstText：它只取第一个且截 80 字。 */
function joinTextBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
    .map((b) => b.text)
    .join('\n');
}

/**
 * 单条消息的判定轨迹。返回 {problem, text}：problem 为 null 表示这条消息过了来源闸与形态闸，
 * text 是可以进入文本闸的原文（未做任何改写）。
 */
function inspectMessage(message) {
  if (!message || typeof message !== 'object') return { problem: 'not-message', text: '' };

  // ① 角色：非 user 一律不采（assistant / tool / system 本就不会出现在 pre-step 的 messages 里，
  //    这里是防御性判定）。
  if (message.role !== 'user') return { problem: 'role', text: '' };

  // ② 来源：白名单。同时干掉 runtime-context / agent-instructions / goal / hook / 各路插件注入。
  const kind = message?.source?.kind;
  if (typeof kind !== 'string' || !CAPTURE_KINDS.has(kind)) return { problem: 'source', text: '' };

  // ③ 形态：只取 text block，纯图片/纯附件直接出局。
  const text = joinTextBlocks(message.content);
  if (text === '') return { problem: 'no-text', text: '' };

  // ④ 伪系统块：用户粘贴的 <system-reminder> / <attached-file> 之类整条跳过（不做聪明的剥离）。
  if (PSEUDO_SYSTEM_RE.test(text.trimStart())) return { problem: 'pseudo-system', text: '' };

  return { problem: null, text };
}

/**
 * G1 候选文本提取：role === 'user' 且 source.kind === 'user' 才可能返回非 null。
 *
 * @param {object} message 宿主 UserMessage（{role, content, source}）
 * @returns {string|null}
 */
export function pickCaptureText(message) {
  try {
    const { problem, text } = inspectMessage(message);
    return problem === null ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 近重复（G5）

/** 归一化：去空白、去常见标点、转小写。只用于相似度比较，绝不写回候选文本。 */
export function normalizeText(text) {
  try {
    return String(text ?? '').replace(WS_RE, '').replace(NORMALIZE_PUNCT_RE, '').toLowerCase();
  } catch {
    return '';
  }
}

/** 3-gram 多集（g → 出现次数）。 */
export function trigrams(text) {
  const out = new Map();
  const s = String(text ?? '');
  for (let i = 0; i + 2 < s.length; i += 1) {
    const g = s.slice(i, i + 3);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** 多集 Jaccard（不是集合 Jaccard：同一 gram 出现两次要按次数算交集/并集）。 */
export function jaccard(a, b) {
  let inter = 0;
  let union = 0;
  for (const [g, n] of a) {
    const m = b.get(g) ?? 0;
    inter += Math.min(n, m);
    union += Math.max(n, m);
  }
  for (const [g, n] of b) if (!a.has(g)) union += n;
  return union === 0 ? 1 : inter / union;
}

/**
 * 两条文本的 3-gram 多集 Jaccard 相似度（先各自归一化）。
 * fail-open：任一侧归一后不足 3 字符（无 trigram）返回 0，不判重。
 */
export function similarity(a, b) {
  try {
    const ta = trigrams(normalizeText(a));
    const tb = trigrams(normalizeText(b));
    if (ta.size === 0 || tb.size === 0) return 0;
    return jaccard(ta, tb);
  } catch {
    return 0;
  }
}

/**
 * G5 近重复判定。候选集两种给法：
 *   - 字符串数组（或 {text} 对象数组）：逐条算相似度取最大；
 *   - 回调：`(normalizedText) => number | {score, match}`，交给调用方自查（T4 里换成按章查询）。
 *
 * fail-open 的选择是「判为不重复并放行」：这条闸失效的代价是多写一条可 forget 的条目，
 * 而抛错或误判为重复会让用户说的话彻底丢失。
 *
 * @param {string} text
 * @param {string[]|{text?: string}[]|Function|null} corpus
 * @param {{threshold?: number}} [options]
 * @returns {{dup: boolean, score: number, match: string|null}}
 */
export function nearDup(text, corpus, options = {}) {
  const clean = { dup: false, score: 0, match: null };
  try {
    const threshold = clampNum(options?.threshold, 0.5, 1, AUTO_DEFAULTS.dupThreshold);
    const candidate = normalizeText(text);
    const own = trigrams(candidate);
    if (own.size === 0) return clean;

    if (typeof corpus === 'function') {
      const result = corpus(candidate);
      const score = typeof result === 'number' ? result : Number(result?.score);
      if (!Number.isFinite(score)) return clean;
      const match = typeof result?.match === 'string' ? result.match : null;
      return { dup: score >= threshold, score, match };
    }

    if (!Array.isArray(corpus)) return clean;

    let best = clean;
    for (const item of corpus) {
      const other = typeof item === 'string' ? item : item?.text;
      if (typeof other !== 'string') continue;
      const map = trigrams(normalizeText(other));
      if (map.size === 0) continue;
      const score = jaccard(own, map);
      if (score > best.score) best = { dup: score >= threshold, score, match: other };
    }
    return best;
  } catch {
    return clean;
  }
}

// ---------------------------------------------------------------- G2 / G3 / G4

/**
 * 形态闸（G4）。返回问题码或 null。顺序：纯标点/表情 → 寒暄 → 重复字符 > 60% → 纯提问。
 * 疑问句策略见 spec §3.3：「疑问句一律不记」是错的——带约定标记的祈使句必须记。
 */
function shapeProblem(raw, stripped) {
  if (PUNCT_ONLY_RE.test(stripped)) return 'punctuation-only';
  if (!/\s/.test(String(raw).trim()) && GREETINGS.has(stripped.toLowerCase())) return 'greeting';
  if (topCharRatio(stripped) > 0.6) return 'repetitive';
  if (QUESTION_RE.test(stripped) && !DIRECTIVE_RE.test(stripped)) return 'question';
  return null;
}

/**
 * G2 + G3 + G4：文本闸。只判长度与形态，不判来源（来源在 pickCaptureText 里）。
 *
 * @param {string} text
 * @param {object} [options] 见 resolveAutoConfig
 * @returns {{ok: boolean, reason: string}}
 */
export function shouldCapture(text, options = {}) {
  try {
    const cfg = resolveAutoConfig(options);
    if (typeof text !== 'string' || text === '') return { ok: false, reason: 'not-text' };

    const stripped = stripWs(text);
    // G2：去空白后计长。寒暄与短促应答在这一道被吃掉。
    if (charLength(stripped) < cfg.minChars) return { ok: false, reason: 'too-short' };
    // G3：按原文长度卡上限，超长整条丢弃，绝不截断。
    if (text.length > cfg.maxChars) return { ok: false, reason: 'too-long' };

    const problem = shapeProblem(text, stripped);
    if (problem !== null) return { ok: false, reason: problem };

    return { ok: true, reason: 'ok' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * importance 初值（spec §3.5）：普通 0.1（cold 档，12 天半衰），带约定标记 0.55
 * （仍 < 0.6，不进 warm 档）。不给 0.6：warm 档只留给一次写入永久有效的事实。
 */
export function importanceFor(text, options = {}) {
  try {
    const cfg = resolveAutoConfig(options);
    return DIRECTIVE_RE.test(String(text ?? '')) ? cfg.directiveImportance : cfg.importance;
  } catch {
    return AUTO_DEFAULTS.importance;
  }
}

// ---------------------------------------------------------------- G6 配额状态机

function sessionKey(sessionId) {
  const key = typeof sessionId === 'string' ? sessionId.trim() : '';
  return key === '' ? 'unknown' : key;
}

/**
 * G6 配额状态机（进程内，不落盘；spec §3.4）。
 *
 * 单轮上限与冷却的关系（文档没写死，这里定死并说明）：冷却是防「同一轮多步（工具循环）
 * 反复触发」刷库，所以只在**轮次变化**时检查。同一轮内的第 2 条不受冷却拦——
 * 否则 perTurnLimit=2 永远只能到 1，两个闸互相打死。
 *
 * @param {{sessionLimit?: number, perTurnLimit?: number, cooldownMs?: number,
 *          maxSessions?: number, now?: () => number}} [options]
 */
export function createQuota(options = {}) {
  const cfg = resolveAutoConfig(options);
  const maxSessions = clampInt(options?.maxSessions, 1, 1024, MAX_QUOTA_SESSIONS);
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  /** @type {Map<string, {turn: number, perTurn: number, total: number, lastAt: number|null}>} */
  const states = new Map();

  /**
   * 按 lastAt 淘汰最旧会话。`keep` 是刚插入的那个 key，必须跳过：
   * 新会话的 lastAt 还是 null（尚未写入），按 null 最小会被当成最旧而当场淘汰自己——
   * 淘汰的意义是腾位置给新会话，不是把新会话踢出去。
   */
  const evict = (keep = null) => {
    while (states.size > maxSessions) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, st] of states) {
        if (key === keep) continue;
        const at = st.lastAt ?? -1;
        if (at < oldestAt) {
          oldestAt = at;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      states.delete(oldestKey);
    }
  };

  return {
    /**
     * 申请一条写入额度。任何时刻最多一个字段被改动：成功才推进计数与 lastAt。
     * @param {string} sessionId
     * @param {number} turn
     * @param {number} [atMs] 假时钟注入点
     * @returns {{ok: boolean, reason: string}}
     */
    admit(sessionId, turn, atMs) {
      try {
        const key = sessionKey(sessionId);
        const t = Number.isFinite(Number(turn)) ? Math.trunc(Number(turn)) : 0;
        const at = Number.isFinite(Number(atMs)) ? Number(atMs) : now();

        let st = states.get(key);
        if (!st) {
          st = { turn: t, perTurn: 0, total: 0, lastAt: null };
          states.set(key, st);
          evict(key);
        }

        if (st.total >= cfg.sessionLimit) return { ok: false, reason: 'session-limit' };

        if (st.turn !== t) {
          // 只在换轮时查冷却：同一轮内多步不吃冷却（见上面的说明）。
          if (st.lastAt !== null) {
            const gap = at - st.lastAt;
            if (gap >= 0 && gap < cfg.cooldownMs) return { ok: false, reason: 'cooldown' };
          }
          st.turn = t;
          st.perTurn = 0;
        }

        if (st.perTurn >= cfg.perTurnLimit) return { ok: false, reason: 'turn-limit' };

        st.perTurn += 1;
        st.total += 1;
        st.lastAt = at;
        return { ok: true, reason: 'ok' };
      } catch {
        // fail-open：状态机算错不该断采集，也不该断对话。
        return { ok: false, reason: 'error' };
      }
    },

    /** 只读快照，给面板与测试看。 */
    stats(sessionId) {
      const st = states.get(sessionKey(sessionId));
      return st ? { ...st } : null;
    },

    /** 清空一个会话或全部（面板重置用）。 */
    reset(sessionId) {
      if (sessionId === undefined) states.clear();
      else states.delete(sessionKey(sessionId));
    },

    /** 当前记录了几个会话，供淘汰测试用。 */
    size() {
      return states.size;
    },
  };
}

// ---------------------------------------------------------------- source 标记

/** 会话 id → 标记里的 sessTok：只留字母数字下划线，取前 8 位。空 id 记 unknown（spec §7.4）。 */
export function sessionToken(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (raw === '') return 'unknown';
  const safe = raw.replace(/[^A-Za-z0-9_]/g, '');
  return safe.slice(0, 8) || 'unknown';
}

function turnOf(turn) {
  const n = Number(turn);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/**
 * 生成 source 标记：`auto:chat#<会话 id 前 8 位>-t<turn>`。
 *
 * 为什么是字符串而不是独立字段/JSON：memories 表没有 origin 列，加列要动 schema 版本与
 * 迁移路径；而 decodeSource 对 `{` 开头的 source 一律当章/段号解析，写 JSON 会让自动条目
 * 在面板上全显示成「手动写入」。字符串是唯一零迁移的落点（spec §4.2）。
 */
export function formatSource(sessionId, turn) {
  return `auto:chat#${sessionToken(sessionId)}-t${turnOf(turn)}`;
}

/**
 * 反向解析。给 dump 与面板来源显示用。
 * @param {unknown} source
 * @returns {{auto: true, sessTok: string, turn: number}|null} 非 auto 标记返回 null
 */
export function parseSource(source) {
  if (typeof source !== 'string') return null;
  const m = /^auto:chat#([A-Za-z0-9_]{1,8})-t(\d+)$/.exec(source.trim());
  if (!m) return null;
  return { auto: true, sessTok: m[1], turn: Number(m[2]) };
}

/** 面板/inject 用的快速判据：是不是自动条目的来源串（spec §5.2 的 isAuto）。 */
export function isAutoSource(source) {
  return typeof source === 'string' && source.trim().startsWith('auto:');
}

// ---------------------------------------------------------------- 候选提取

/**
 * 单条消息的全链路判定（除配额）：来源 → 长度 → 形态 → 近重复。
 * 给测试与 T2 排障用，返回的是判定轨迹而不是候选。
 *
 * @param {object} message
 * @param {object} [options] resolveAutoConfig 的入参 + {existing}
 * @returns {{ok: boolean, reason: string, text: string, importance: number}}
 */
export function captureVerdict(message, options = {}) {
  const miss = { ok: false, reason: 'error', text: '', importance: 0 };
  try {
    const cfg = resolveAutoConfig(options);
    if (!cfg.enabled) return { ...miss, reason: 'disabled' };

    const { problem, text } = inspectMessage(message);
    if (problem !== null) return { ...miss, reason: problem };

    const gate = shouldCapture(text, cfg);
    if (!gate.ok) return { ...miss, reason: gate.reason };

    const existing = options?.existing;
    if (existing !== undefined && existing !== null) {
      const near = nearDup(text, existing, { threshold: cfg.dupThreshold });
      if (near.dup) return { ...miss, reason: 'near-dup', text, importance: importanceFor(text, cfg) };
    }

    return { ok: true, reason: DIRECTIVE_RE.test(text) ? 'directive' : 'plain', text, importance: importanceFor(text, cfg) };
  } catch {
    return miss;
  }
}

/**
 * 候选提取：一个 step 的 messages → 待写入候选。
 *
 * 六道闸严格按 spec §3.1 的顺序短路：G1 来源白名单 → G2 minChars → G3 maxChars →
 * G4 形态 → G5 近重复 → G6 配额（单轮 / 单会话 / 冷却）。
 *
 * @param {object[]} messages 宿主 pre-step 的 messages 或 decision.messages
 * @param {object} [options] resolveAutoConfig 的入参，外加：
 *   - existing: string[] | (normText) => number | {score} —— G5 候选集，缺省跳过 G5
 *   - quota: createQuota() 的返回值 —— 缺省跳过 G6
 *   - sessionId / turn / now: 传给 quota.admit
 * @returns {Array<{text: string, importance: number, reason: string}>}
 */
export function extractCandidates(messages, options = {}) {
  try {
    const cfg = resolveAutoConfig(options);
    if (!cfg.enabled) return [];
    if (!Array.isArray(messages)) return [];

    const existing = options?.existing;
    const quota = options?.quota;
    const sessionId = options?.sessionId;
    const turn = options?.turn;
    const at = Number.isFinite(Number(options?.now)) ? Number(options.now) : undefined;

    const out = [];
    for (const message of messages) {
      const verdict = captureVerdict(message, { ...cfg, existing });
      if (!verdict.ok) continue;

      if (quota && typeof quota.admit === 'function') {
        const gate = quota.admit(sessionId, turn, at);
        if (!gate?.ok) break; // 配额是会话级短路：这一轮剩下的不必再试
      }

      out.push({ text: verdict.text, importance: verdict.importance, reason: verdict.reason });
    }
    return out;
  } catch {
    return [];
  }
}
