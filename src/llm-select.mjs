// LLM 在环选段：把 top-N 候选段的原文交给 LLM，让它挑出「能回答这个问题」的段。
//
// 与 t22 的 reranker 不是一回事（这轮必须说清区别）：
//   - reranker（Qwen3-Reranker-8B）是 cross-encoder，对 (query, doc) 打分，判的是
//     「字面/浅层语义相关度」。它看不出「多绕了一百八十七海里」等于「航程增加」。
//   - 这里把段原文整段摊给 chat 模型，让它做**推理判断**：「147 卷钢卷每卷十四点二吨」
//     能不能回答「货移的直接原因」。这是 rerank 做不到的一步。
//
// 降级必须可观测（t25/t26 的教训）：返回值永远带 degraded ∈ no-key|timeout|http|parse|none。
// 静默降级会让整轮实验测的都是降级版本而没人知道。

import { chatKey } from './config.mjs';
import { chat, resolveModel } from './llm-client.mjs';

// 端点不在这里定义：由 llm-client 从 chat 组的 baseUrl 拼，面板改了就跟着改。
// MODEL 常量只作 LS_DEFAULTS 的历史兜底值；实际请求模型取 chatModel()（见 resolveModel）。
const MODEL = 'deepseek-ai/DeepSeek-V4-Flash';

export const LS_DEFAULTS = Object.freeze({
  maxPicks: 6,
  snippetChars: 300,
  poolSize: 16,
  timeoutMs: 150_000,
  cacheTtlMs: 300_000,
  cacheMax: 128,
  model: MODEL,
});

export const lsStats = {
  calls: 0,
  cacheHits: 0,
  failures: 0,
  picked: 0,
  tokensIn: 0,
  tokensOut: 0,
  ms: 0,
  lastError: null,
};

function buildPrompt(query, snippets, maxPicks) {
  const body = snippets
    .map((s, i) => `[${i + 1}] ${s}`)
    .join('\n\n');
  return [
    `问题：${query}`,
    '',
    `下面是 ${snippets.length} 个候选段落。请挑出**含有回答问题所需事实**的段落编号，按相关程度排序，最多 ${maxPicks} 个。`,
    '判断标准（满足任一条就选）：段落里出现了答案所需的数值、日期、编号、人名职务、地点，或能推出答案的因果叙述。',
    '不必整段都在回答问题——只要这一段里有那个关键事实，就选它。措辞不像也没关系，看事实。',
    '示例：问题「白鲸号从哪个港区离港？」+ 段落「白鲸号于二〇二三年三月十四日离开宁波北仑港区…」→ 必须选中该段。',
    '只有当所有段落都没有任何答案所需的事实时，才返回空数组。',
    '',
    body,
    '',
    '只输出 JSON：{"picks":[3,1]}，编号从 1 开始，不要解释。',
  ].join('\n');
}

/** 从模型输出里抠 picks（1-based）；格式不符返回 null。 */
export function parsePicks(content, total) {
  if (typeof content !== 'string' || !content.trim()) return null;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  const arr = Array.isArray(obj?.picks) ? obj.picks : Array.isArray(obj) ? obj : null;
  if (!arr) return null;
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > total) continue;
    if (seen.has(n - 1)) continue;
    seen.add(n - 1);
    out.push(n - 1); // 内部统一 0-based
  }
  return out;
}

const cache = new Map();

export function clearSelectCache() {
  cache.clear();
}

export function selectCacheSize() {
  return cache.size;
}

export function selectEnabled() {
  return Boolean(chatKey());
}

function digest(query, snippets) {
  let h = 0x811c9dc5;
  const feed = (s) => { for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; };
  feed(query);
  feed('\u0001');
  for (const s of snippets) { feed(s); feed('\u0002'); }
  return `${h.toString(16).padStart(8, '0')}:${snippets.length}`;
}

/**
 * LLM 选段。
 *
 * @param {string} query
 * @param {string[]} candidates 候选段原文（内部按 snippetChars 截断）
 * @param {{maxPicks?:number, snippetChars?:number, poolSize?:number, timeoutMs?:number,
 *          cacheTtlMs?:number, fetchImpl?:Function, cache?:boolean, model?:string}} [opts]
 * @returns {Promise<{picks:number[], degraded:null|'no-key'|'timeout'|'http'|'parse', ms:number,
 *   cached:boolean, tokensIn:number, tokensOut:number, pool:number}>}
 *   picks 是 **0-based** 下标，指向传入的 candidates；降级时 picks=[]（调用方按原序继续）。
 */
export async function select(query, candidates, opts = {}) {
  const o = { ...LS_DEFAULTS, ...opts };
  // 展开运算符会把显式 undefined 抄进 o，逐字段兜底（t26 被 setTimeout(NaN) 坑过）
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) o.timeoutMs = LS_DEFAULTS.timeoutMs;
  if (!Number.isInteger(o.maxPicks) || o.maxPicks < 1) o.maxPicks = LS_DEFAULTS.maxPicks;
  if (!Number.isFinite(o.cacheTtlMs)) o.cacheTtlMs = LS_DEFAULTS.cacheTtlMs;
  // snippetChars 也必须兜底：显式传 undefined 时 `Math.max(40, undefined)` 是 NaN，
  // `slice(0, NaN)` 把每段截成空串 —— prompt 里只剩编号，模型只能说「一段都答不了」，
  // 而 degraded 仍是 'none'（请求成功），极难察觉。t26 在 timeoutMs 上踩过同一个坑，
  // 这次是第二次：{...defaults, ...opts} 会把显式 undefined 抄进来，必须逐字段判有限值。
  if (!Number.isFinite(o.snippetChars) || o.snippetChars < 40) o.snippetChars = LS_DEFAULTS.snippetChars;
  if (!Number.isInteger(o.poolSize) || o.poolSize < 1) o.poolSize = LS_DEFAULTS.poolSize;
  // 模型跟着面板配置走：只有调用方**显式**传 opts.model 时才覆盖 chatModel()。
  // 注意读的是 opts.model 而不是 o.model —— 后者已被 LS_DEFAULTS.model 填成常量。
  o.model = resolveModel(opts.model);

  const q = String(query ?? '').trim();
  const list = (Array.isArray(candidates) ? candidates : []).map((c) => String(c ?? ''));
  const base = { picks: [], degraded: 'no-key', ms: 0, cached: false, tokensIn: 0, tokensOut: 0, pool: list.length };
  if (!q || !list.length) return { ...base, degraded: 'no-key' };
  if (!selectEnabled()) return base;

  const snippets = list.slice(0, Math.max(1, o.poolSize)).map((t) => t.slice(0, Math.max(40, o.snippetChars)));
  const key = digest(q, snippets);
  if (o.cache !== false) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at <= o.cacheTtlMs) {
      lsStats.cacheHits += 1;
      return { picks: hit.picks, degraded: null, ms: 0, cached: true, tokensIn: 0, tokensOut: 0, pool: snippets.length };
    }
  }

  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return base;

  const t0 = Date.now();
  lsStats.calls += 1;
  try {
    // 超时由 llm-client 用 o.timeoutMs 建 AbortController；非 2xx 抛 ChatHttpError，
    // 落到下面的 catch 分支仍是 degraded:'http'，对外语义不变。
    const json = await chat({
      model: o.model,
      temperature: 0,
      messages: [{ role: 'user', content: buildPrompt(q, snippets, o.maxPicks) }],
    }, { timeoutMs: o.timeoutMs, fetchImpl });
    const content = json?.choices?.[0]?.message?.content;
    const picks = parsePicks(content, snippets.length);
    const ms = Date.now() - t0;
    lsStats.ms += ms;
    const tin = Number(json?.usage?.prompt_tokens ?? 0);
    const tout = Number(json?.usage?.completion_tokens ?? 0);
    if (!picks) {
      lsStats.failures += 1;
      lsStats.lastError = 'parse';
      return { ...base, degraded: 'parse', ms, tokensIn: tin, tokensOut: tout };
    }
    lsStats.tokensIn += tin;
    lsStats.tokensOut += tout;
    lsStats.picked += picks.length;
    if (o.cache !== false) {
      cache.set(key, { at: Date.now(), picks });
      while (cache.size > Math.max(1, o.cacheMax)) cache.delete(cache.keys().next().value);
    }
    return { picks, degraded: 'none', ms, cached: false, tokensIn: tin, tokensOut: tout, pool: snippets.length };
  } catch (err) {
    const ms = Date.now() - t0;
    lsStats.failures += 1;
    lsStats.lastError = String(err?.message || err);
    const timedOut = /abort/i.test(String(err?.name || err?.message || err));
    return { ...base, degraded: timedOut ? 'timeout' : 'http', ms };
  }
}

export default { select, parsePicks, selectEnabled, clearSelectCache, selectCacheSize, lsStats, LS_DEFAULTS };
