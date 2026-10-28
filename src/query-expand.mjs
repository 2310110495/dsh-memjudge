// 查询扩展：把长问句拆成 2–4 条短子查询，各自检索后合并候选。
//
// 为什么需要它（t25 的实测结论）：综合题的丢分 kw 段落与问句「零词面重合」——
// S01 问「两次省掉书面确认的动作」，证据段写的是「航程增加一百八十七海里」；
// S07 问「货移的直接原因」，证据段写的是「147 卷、每卷十四点二吨」。单条 BM25 够不到，
// 64/128 维向量臂也够不到。但把问句拆成「改航 航程增加」「装货 钢卷 件数」这类子查询后，
// 子查询与目标段的距离就缩短了。
//
// 三条硬约束：
//   1. key 只从环境读，绝不落盘、不进日志、不进 commit。
//   2. **降级必须可观测**：返回值里永远带 `expanded` 与 `degraded`。
//      t25 的教训——`searchAsync` 里把字符串传给批量接口，异常被 catch 吞掉，静默降级回纯 BM25，
//      导致 t21 报的所有「融合」数字其实都是纯 BM25 的。这里不允许再出现「不知道跑没跑」的状态。
//   3. 查询扩展是**查询时**算的，不落盘、不进索引，库体预算不受影响。

import { llmKey } from './config.mjs';
import { chat, resolveModel } from './llm-client.mjs';

// 端点不在这里定义：由 llm-client 从 config 的 baseUrl 拼，面板改了就跟着改。
// MODEL 常量只作 QE_DEFAULTS 的历史兜底值；实际请求模型取 chatModel()（见 resolveModel）。
const MODEL = 'deepseek-ai/DeepSeek-V4-Flash';

export const QE_DEFAULTS = Object.freeze({
  maxQueries: 4,
  minQueries: 2,
  timeoutMs: 150_000,
  cacheTtlMs: 300_000,
  cacheMax: 256,
  model: MODEL,
});

export const qeStats = {
  calls: 0,
  cacheHits: 0,
  failures: 0,
  expanded: 0,
  degraded: 0,
  ms: 0,
  lastError: null,
};

const SYSTEM_PROMPT = [
  '你是检索查询拆解器。把用户的长问题拆成 2–4 条**短**检索子查询，用于词法检索（BM25）。',
  '要求：',
  '1. 每条子查询 2–8 个字词，用空格分隔关键词，不要写成完整句子。',
  '2. 覆盖不同角度：实体+属性、事件+数值、时间线/位置、因果或责任人。',
  '3. **保留原问题里出现的实体名、编号、数值**（如「白鲸号」「OTS-9」「147」），不要替换成同义说法。',
  '4. 不要编造原问题里没有的实体或数值。',
  '5. 只输出 JSON：{"queries":["...","..."]}，不要任何解释。',
].join('\n');

function buildUserPrompt(query) {
  return `问题：${query}\n\n请输出 JSON。`;
}

/** 从模型输出里抠出 queries 数组；格式不符返回 null（调用方据此降级）。 */
export function parseQueries(content) {
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
  const arr = Array.isArray(obj?.queries) ? obj.queries : Array.isArray(obj) ? obj : null;
  if (!arr) return null;
  const out = arr
    .map((q) => String(q ?? '').trim())
    .filter((q) => q.length >= 2 && q.length <= 60);
  return out.length ? out : null;
}

const cache = new Map(); // query → { at, queries }

export function clearExpandCache() {
  cache.clear();
}

export function expandCacheSize() {
  return cache.size;
}

export function expandEnabled() {
  return Boolean(llmKey());
}

/**
 * 拆子查询。
 *
 * @param {string} query
 * @param {{maxQueries?:number, timeoutMs?:number, cacheTtlMs?:number, fetchImpl?:Function,
 *          cache?:boolean, model?:string}} [opts]
 * @returns {Promise<{queries:string[], expanded:boolean,
 *   degraded:null|'no-key'|'timeout'|'http'|'parse'|'empty', ms:number, cached:boolean}>}
 *   queries 永远至少含原 query（放在第 0 位），所以调用方可以直接把它当检索清单用。
 */
export async function expand(query, opts = {}) {
  // 显式兜底：调用方传 `{ timeoutMs: undefined }` 会覆盖默认值（展开运算符照抄 undefined），
  // setTimeout(NaN) 会立刻 abort，于是每次都静默降级成 timeout——必须逐个字段判有限值。
  const o = { ...QE_DEFAULTS, ...opts };
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) o.timeoutMs = QE_DEFAULTS.timeoutMs;
  if (!Number.isInteger(o.maxQueries) || o.maxQueries < 2) o.maxQueries = QE_DEFAULTS.maxQueries;
  if (!Number.isFinite(o.cacheTtlMs)) o.cacheTtlMs = QE_DEFAULTS.cacheTtlMs;
  // 模型跟着面板配置走：只有调用方**显式**传 opts.model 时才覆盖 chatModel()。
  // 读 opts.model 而不是 o.model —— 后者已被 QE_DEFAULTS.model 填成常量。
  o.model = resolveModel(opts.model);
  const q = String(query ?? '').trim();
  const fallback = {
    queries: q ? [q] : [],
    expanded: false,
    degraded: 'empty',
    ms: 0,
    cached: false,
  };
  if (!q) return fallback;

  if (!expandEnabled()) return { ...fallback, degraded: 'no-key', queries: [q] };

  const useCache = o.cache !== false;
  if (useCache) {
    const hit = cache.get(q);
    if (hit && Date.now() - hit.at <= o.cacheTtlMs) {
      qeStats.cacheHits += 1;
      return { queries: hit.queries, expanded: hit.queries.length > 1, degraded: null, ms: 0, cached: true };
    }
  }

  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ...fallback, degraded: 'no-key', queries: [q] };

  const t0 = Date.now();
  qeStats.calls += 1;
  try {
    // 超时由 llm-client 用 o.timeoutMs 建 AbortController；非 2xx 抛 ChatHttpError，
    // 落到下面的 catch 分支仍是 degraded:'http'，对外语义不变。
    const json = await chat({
      model: o.model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(q) },
      ],
    }, { timeoutMs: o.timeoutMs, fetchImpl });
    const sub = parseQueries(json?.choices?.[0]?.message?.content);
    const ms = Date.now() - t0;
    qeStats.ms += ms;
    if (!sub) {
      qeStats.failures += 1;
      qeStats.degraded += 1;
      qeStats.lastError = 'parse';
      return { ...fallback, degraded: 'parse', queries: [q], ms };
    }
    // 原 query 永远排第 0 位：子查询是补充，不能把原问句挤掉
    const queries = [q, ...sub.filter((s) => s !== q)].slice(0, Math.max(1, o.maxQueries));
    if (queries.length < 2) {
      qeStats.degraded += 1;
      return { ...fallback, degraded: 'empty', queries: [q], ms };
    }
    qeStats.expanded += 1;
    if (useCache) {
      cache.set(q, { at: Date.now(), queries });
      while (cache.size > Math.max(1, o.cacheMax)) cache.delete(cache.keys().next().value);
    }
    return { queries, expanded: true, degraded: null, ms, cached: false };
  } catch (err) {
    // 超时/网络/解析失败：静默退回单查询，但把原因写进返回值与统计
    const ms = Date.now() - t0;
    qeStats.failures += 1;
    qeStats.degraded += 1;
    qeStats.lastError = String(err?.message || err);
    const timedOut = /abort|AbortError/i.test(String(err?.name || err?.message || err));
    return { ...fallback, degraded: timedOut ? 'timeout' : 'http', queries: [q], ms };
  }
}

export default { expand, parseQueries, expandEnabled, clearExpandCache, expandCacheSize, qeStats, QE_DEFAULTS };
