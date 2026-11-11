/**
 * 采集侧 kind 判定：把「用户在陈述自己是谁」和「双方定下的规矩」从 event 里分出来。
 *
 * 为什么必须保守（这是本文件唯一的设计纲领）：
 *   person/promise 被 store 钉在 tier 1（见 store.mjs normalizeTier），永不衰减、永不被
 *   淘汰，而且每轮都占注入面的固定席位（index.mjs INJECT_SEGMENTS 人 800 / 约 600）。
 *   判错一条 = 一个错误的人设被永久复述给模型；判漏一条的代价只是它落回 event，
 *   下一轮对话还能再判一次。所以这里的每条规则都先写好「什么不许命中」，再写「什么命中」。
 *
 * 纯函数、零依赖：判据必须可单测、可回溯，任何一次误判都能在测试里复现到具体规则名。
 */

// 采集侧回到 user 通路的 kind 白名单（assistant 说的话永远成不了 person）。
export const KIND_SOURCE_ROLES = Object.freeze(new Set(['user']));

/** 自动写入 person/promise 时挂在 source 尾部的可追溯标记：`|k:person`。 */
export const AUTO_KIND_TAG_PREFIX = '|k:';

/** 自动写入的 kind 标记串（event 不加，保持老 source 原样）。 */
export function autoKindSource(source, kind) {
  const s = typeof source === 'string' ? source : '';
  if (kind !== 'person' && kind !== 'promise') return s;
  if (s.endsWith(`${AUTO_KIND_TAG_PREFIX}${kind}`)) return s;
  return `${s}${AUTO_KIND_TAG_PREFIX}${kind}`;
}

/** 从 source 尾部读回自动写入时的 kind 标记；没有标记返回 null（人工条目/老条目）。 */
export function parseAutoKindTag(source) {
  const s = typeof source === 'string' ? source : '';
  if (s.endsWith(`${AUTO_KIND_TAG_PREFIX}person`)) return 'person';
  if (s.endsWith(`${AUTO_KIND_TAG_PREFIX}promise`)) return 'promise';
  return null;
}

// ---------------------------------------------------------------- 共用判据

// 与 auto-capture.mjs 的 QUESTION_RE 同口径（那份是私有的，这里不能反向依赖它）。
const QUESTION_RE = /[?？]\s*$|^(如何|怎么|怎样|为什么|为何|是否|哪|多少|能不能|可不可以)|(吗|呢)\s*$/;

// 与 auto-capture.mjs DIRECTIVE_RE 逐字一致：它是「第一判据」，命中只说明这句话带指令语气。
const DIRECTIVE_RE = /(记住|记一下|记下|以后|今后|永远|别再|不要再|总是|一律|必须|约定|规则|规范|习惯上)/;

// 第二判据 A：句子本身就是祈使句（以指令动词开头）。「必须」刻意不在表内——
// 「这个测试必须是绿的」以「必须」为状语而非祈使，留在表里会把陈述句全升格。
const IMPERATIVE_HEAD_RE = /^(记住|记着|记一下|记下|别再|不要再|不要|一律|永远|请|务必|麻烦|约定|说好了|说好)/;

// 第二判据 B：以「以后/今后」开头时，后面必须紧跟指令性成分才算约定。
// 「以后都用 pnpm」是约定；「以后会好起来的」是预测，不能升格。
const FUTURE_HEAD_RE = /^(以后|今后)(我们|咱们|咱|你|您|都|请|要|必须|一律|统一|直接|先|别|不要|记得|只用|都用)/;

// 第二判据 C：句中出现第二人称/共同指代，说明这句话对着「谁」说，属于双方的约定。
const SECOND_PERSON_RE = /(你|您|咱|咱们|我们|给我|帮我|请你|麻烦你)/;

// ---------------------------------------------------------------- promise

/**
 * 约定判定：DIRECTIVE_RE 命中（第一判据）+ 指令指向（第二判据）。
 *
 * 只有第一判据的后果是「所有带『必须/规则/规范』的描述句都变约定」——那是污染。
 * 第二判据取「祈使句首 / 以后+指令 / 出现第二人称」三条之一，命不中就算描述性。
 *
 * @param {string} text
 * @returns {{promise: boolean, reason: string}}
 */
export function promiseVerdict(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return { promise: false, reason: 'empty' };
  if (!DIRECTIVE_RE.test(s)) return { promise: false, reason: 'no-directive' };
  if (IMPERATIVE_HEAD_RE.test(s)) return { promise: true, reason: 'imperative-head' };
  if (FUTURE_HEAD_RE.test(s)) return { promise: true, reason: 'future-head' };
  if (SECOND_PERSON_RE.test(s)) return { promise: true, reason: 'second-person' };
  return { promise: false, reason: 'descriptive' };
}

// ---------------------------------------------------------------- person

// 强特征：命中即为「关于用户本人的稳定事实」。每条带一个属性槽名，供去重用。
// 顺序 = 优先级：习惯/偏好先于身份，避免「我一般不做后端」被身份规则抢走。
const PERSON_STRONG = Object.freeze([
  { re: /我(?:习惯|一般|通常|总是|经常|一贯|向来|平时)(?!不)/, attr: 'habit' },
  { re: /我(?:不|从不|很少|不太)(?:喜欢|用|吃|喝|玩|看|写|碰|会)/, attr: 'preference' },
  { re: /我(?:讨厌|喜欢|偏好|偏爱|更倾向|更喜欢)/, attr: 'preference' },
  { re: /我(?:是|在)(?:一[名个位])?(?:做|搞|干|写|后端|前端|全栈|开发|工程师|程序|学生|设计师)/, attr: 'identity' },
  { re: /我(?:在|于)[^，。！？]{1,24}(?:工作|上班|上学|读书|实习)/, attr: 'workplace' },
  { re: /我的(?:项目|机器|电脑|环境|编辑器|系统|服务器|配置|公司|团队|笔记本)[^，。！？]{0,20}(?:是|用|在|跑|装|叫)/, attr: 'environment' },
]);

// 否决权优先于任何强特征：一次性动作、临时状态、问句都不是「用户是谁」。
// 时间词必须紧贴「我」——「我一般现在都这样」不算一次性，因为中间隔了「一般」。
const TRANSIENT_RE = /我(?:今天|明天|昨天|前天|后天|刚才|刚刚|刚|现在|今晚|上午|下午|晚上|本周|这周|上周|下周|马上|待会|等下|一会儿)/;
const EPISODIC_RE = /我(?:去|来|跑|做|看|吃|买|打|开|写|改|装|发|提交|推)(?:了|过|完|一下)/;
const TEMP_STATE_RE = /我现在(?:很|有点|比较|特别|太)?(?:累|困|忙|饿|烦|高兴|有空|没空|没睡)/;
// 「我来问个问题」里的「我是来…」是意图不是身份；「我是来」开头的句子整体不算事实。
const INTENT_HEAD_RE = /^我(?:是)?(?:来|想|要|打算|准备)/;

/**
 * 用户本人稳定事实判定（保守优先）。
 *
 * 判定顺序：有没有「我」→ 是不是问句 → 是不是一次性/临时 → 强特征。任何一步否决即停。
 * 弱特征（我有一台机器 / 我是自由职业）故意不做：它们与一次性陈述几乎无法用正则区分，
 * 误判的代价是永久人设污染，漏判的代价只是这条留在 event。
 *
 * @param {string} text
 * @returns {{person: boolean, attr: string|null, reason: string}}
 */
export function personVerdict(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return { person: false, attr: null, reason: 'empty' };
  if (!/我/.test(s)) return { person: false, attr: null, reason: 'no-first-person' };
  if (QUESTION_RE.test(s)) return { person: false, attr: null, reason: 'question' };
  if (/^我(?:能不能|可不可以|要不要|该不该|是不是|有没有)/.test(s)) {
    return { person: false, attr: null, reason: 'question' };
  }
  if (TEMP_STATE_RE.test(s)) return { person: false, attr: null, reason: 'temporary-state' };
  if (TRANSIENT_RE.test(s)) return { person: false, attr: null, reason: 'one-off' };
  if (EPISODIC_RE.test(s)) return { person: false, attr: null, reason: 'episodic' };
  if (INTENT_HEAD_RE.test(s)) return { person: false, attr: null, reason: 'intent' };
  for (const rule of PERSON_STRONG) {
    if (rule.re.test(s)) return { person: true, attr: rule.attr, reason: 'strong' };
  }
  return { person: false, attr: null, reason: 'no-strong-match' };
}

// ---------------------------------------------------------------- 合成

/**
 * 一条消息该落哪个 kind。assistant 侧永远 event：CAPTURE_KINDS 只含 user 这条规矩
 * 在采集内核，这里再挡一层，防止调用方把 role 传错就写出一个人设。
 *
 * @param {string} text
 * @param {{role?: string}} [options]
 * @returns {{kind: 'person'|'promise'|'event', attr: string|null, reason: string}}
 */
export function classifyCaptureKind(text, options = {}) {
  try {
    const role = String(options?.role ?? 'user').trim().toLowerCase() || 'user';
    if (!KIND_SOURCE_ROLES.has(role)) return { kind: 'event', attr: null, reason: 'not-user-role' };
    const promise = promiseVerdict(text);
    if (promise.promise) return { kind: 'promise', attr: 'directive', reason: promise.reason };
    const person = personVerdict(text);
    if (person.person) return { kind: 'person', attr: person.attr, reason: person.reason };
    return { kind: 'event', attr: null, reason: promise.reason === 'descriptive' ? 'descriptive' : person.reason };
  } catch {
    return { kind: 'event', attr: null, reason: 'error' };
  }
}

// ---------------------------------------------------------------- 属性槽去重

/** 去标点与句首人称后的核心串：同属性的两次表述若字面相同，就是同一条事实。 */
function coreOf(text) {
  return String(text ?? '')
    .replace(/[\s，。、；：！？,.!?;:'"「」『』（）()【】\[\]…—－-]/g, '')
    .replace(/^(?:我|我们|咱们|你|您)+/, '');
}

/**
 * 事实槽：{kind, attr, value}。value 是去掉标点/句首人称后的核心串。
 * 抽不出 kind 的句子返回 null（不是事实，谈不上槽）。
 */
export function factSlotOf(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return null;
  const promise = promiseVerdict(s);
  if (promise.promise) return { kind: 'promise', attr: 'directive', value: coreOf(s) };
  const person = personVerdict(s);
  if (person.person) return { kind: 'person', attr: person.attr, value: coreOf(s) };
  return null;
}

/**
 * 两条文本是否落在同一个事实槽上（同实体「我」+ 同属性 + 同一取值）。
 * 只有同 kind 同 attr 且核心串相等/互为子串才算——宁可多写一条，也不要因为
 * 「都是 habit」就把「我一般用 pnpm」与「我一般用 npm」判成重复丢掉新结论。
 */
export function sameFactSlot(a, b) {
  const sa = factSlotOf(a);
  const sb = factSlotOf(b);
  if (!sa || !sb) return false;
  if (sa.kind !== sb.kind || sa.attr !== sb.attr) return false;
  if (sa.value === sb.value) return true;
  return sa.value.includes(sb.value) || sb.value.includes(sa.value);
}

// ---------------------------------------------------------------- 独立配额

function clampPositive(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.trunc(n);
}

/**
 * person/promise 的独立配额：与 event 的「2 条/轮、40 条/会话」分开计时。
 *
 * 为什么要单独一份：注入面 2000 字符是硬顶，人/约段各占 800/600，多写一条废话
 * 就挤掉一条真正有用的；而 event 的通路本来就更宽（每轮 2 条），两条通路共用一个
 * 计数器会让一次闲聊把当轮的约定名额吃掉。
 *
 * @param {{perTurnLimit?: number, sessionLimit?: number}} [options]
 * @returns {{admit: (sessionId: string, turn: number) => {ok: boolean, reason: string}, reset: () => void, size: () => number}}
 */
export function createKindQuota(options = {}) {
  const perTurn = clampPositive(options?.perTurnLimit, 1);
  const perSession = clampPositive(options?.sessionLimit, 10);
  const state = new Map();

  function admit(sessionId, turn) {
    try {
      const key = String(sessionId ?? '').trim();
      if (!key) return { ok: false, reason: 'invalid-session' };
      let entry = state.get(key);
      if (!entry) {
        entry = { turn: null, turnCount: 0, total: 0 };
        if (state.size >= 256) {
          const oldest = state.keys().next();
          if (!oldest.done) state.delete(oldest.value);
        }
        state.set(key, entry);
      }
      const t = Number.isFinite(Number(turn)) ? Number(turn) : null;
      if (t !== null && entry.turn !== t) {
        entry.turn = t;
        entry.turnCount = 0;
      }
      if (entry.total >= perSession) return { ok: false, reason: 'session-limit' };
      if (entry.turnCount >= perTurn) return { ok: false, reason: 'turn-limit' };
      entry.total += 1;
      entry.turnCount += 1;
      return { ok: true, reason: 'ok' };
    } catch {
      return { ok: false, reason: 'error' };
    }
  }

  return {
    admit,
    reset() { state.clear(); },
    size() { return state.size; },
    limits: { perTurnLimit: perTurn, sessionLimit: perSession },
  };
}
