// memjudge 精排层：Qwen3-Reranker-8B（SiliconFlow /v1/rerank）接在检索候选之后。
//
// 为什么需要它：BM25 的排序信号是「词重合」，跨章综合题要的是「这段是不是在回答这个问题」。
// 两段都含「凹陷」时字面分拉不开，而 reranker 直接给 query-document 的相关性判断。
//
// 三条硬约束（都来自实测，不是推测）：
//   1. 只用 node 的 fetch。bash 的 `curl -d '{"query":"中文"}'` 会被 shell 吃掉编码，
//      服务端返回 20015 参数非法；要 curl 必须 `--data-binary @file`。
//   2. relevance_score 的绝对值随 query/文档尺度漂移（同一模型上见过 0.9995 与 0.0046
//      两种量级），**只能拿来排序，绝不能当阈值过滤**——按 0.5 之类的直觉阈值切会把候选
//      整个滤光。本模块不导出任何「最低分」参数，就是为了让调用方没法这么用。
//   3. 失败/超时/无 key 一律返回 null，由调用方退回未精排顺序。检索是主路径，
//      精排是加分项，不许因为远端抖动把召回打崩。
//
// 成本：一次请求打包全部候选（默认 20 条），不逐条调用；同一 (query, 候选集合)
// 在进程内做短 TTL 缓存，评测里同题多次查询不会重复付费。

export const RERANK_MODEL = 'Qwen/Qwen3-Reranker-8B';
export const RERANK_ENDPOINT = 'https://api.siliconflow.cn/v1/rerank';

export const RERANK_DEFAULTS = Object.freeze({
  topN: 8,
  timeoutMs: 8000,
  cacheTtlMs: 120000,
  cacheMax: 128,
  model: RERANK_MODEL,
});

/** key 只从环境读，绝不落盘、不进日志、不进 commit。 */
export function rerankEnabled() {
  return Boolean(llmKey());
}

/**
 * 是否允许把精排接进检索管道。默认关。
 *
 * 实测（20 章 294 段语料，12 道跨章综合题 + 92 道召回）：
 *   综合题 0.583 → 0.583（零增量）、召回 0.989（91/92）→ 0.989（不降也不涨），
 *   代价是每次查询 +490~750ms（20 文档一次打包，中位 488ms）。
 * 也就是说：本语料上的瓶颈是 2000 字符返回预算与章级取章数，不是排序。
 * 所以默认不接；要用必须显式 MEMJUDGE_RERANK=1，否则白白多付半秒。
 */
export function rerankOptIn() {
  const v = String(process.env.MEMJUDGE_RERANK ?? '').trim().toLowerCase();
  return rerankEnabled() && (v === '1' || v === 'true' || v === 'yes' || v === 'on');
}

import { llmKey } from './config.mjs';

const cache = new Map(); // `${digest}` → { at, results }
export const rerankStats = {
  calls: 0,
  cacheHits: 0,
  failures: 0,
  docsSent: 0,
  lastMs: 0,
  totalMs: 0,
  lastInputTokens: 0,
};

export function clearRerankCache() {
  cache.clear();
}

export function rerankCacheSize() {
  return cache.size;
}

/** 缓存键：query + 候选集合（顺序敏感——顺序变了就是另一批输入）。 */
function digest(query, docs) {
  let h = 0x811c9dc5;
  const feed = (s) => {
    for (let i = 0; i < s.length; i += 1) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
  };
  feed(query);
  feed('\u0001');
  for (const d of docs) {
    feed(d);
    feed('\u0002');
  }
  return `${h.toString(16).padStart(8, '0')}:${docs.length}`;
}

/**
 * 精排：返回按 relevance_score 降序的 [{index, score}]，最多 topN 条。
 *
 * @param {string} query
 * @param {string[]} docs 候选文本（与调用方的候选数组同序）
 * @param {{topN?:number, timeoutMs?:number, cacheTtlMs?:number, model?:string,
 *          fetchImpl?:Function, cache?:boolean}} [opts]
 * @returns {Promise<Array<{index:number, score:number}>|null>} null = 精排不可用，调用方退回原序
 */
export async function rerank(query, docs, opts = {}) {
  const o = { ...RERANK_DEFAULTS, ...opts };
  const q = String(query ?? '').trim();
  const list = (Array.isArray(docs) ? docs : []).map((d) => String(d ?? ''));
  if (!q || !list.length) return null;
  if (!rerankEnabled()) return null;

  const key = digest(q, list);
  const useCache = o.cache !== false;
  if (useCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at <= o.cacheTtlMs) {
      rerankStats.cacheHits += 1;
      return hit.results;
    }
  }

  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, o.timeoutMs));
  const started = performance.now();
  rerankStats.calls += 1;
  try {
    const res = await fetchImpl(RERANK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmKey()}`,
      },
      // 一次打包所有候选：逐条调用会把延迟与费用乘 20 倍
      body: JSON.stringify({ model: o.model, query: q, documents: list }),
      signal: ctrl.signal,
    });
    if (!res || !res.ok) {
      rerankStats.failures += 1;
      return null;
    }
    const json = await res.json();
    const results = json?.results;
    if (!Array.isArray(results) || !results.length) {
      rerankStats.failures += 1;
      return null;
    }
    const ranked = results
      .filter((r) => Number.isInteger(r?.index) && r.index >= 0 && r.index < list.length)
      .map((r) => ({ index: r.index, score: Number(r.relevance_score) }))
      .filter((r) => Number.isFinite(r.score))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, Math.max(1, o.topN));
    if (!ranked.length) {
      rerankStats.failures += 1;
      return null;
    }
    const elapsed = performance.now() - started;
    rerankStats.lastMs = Number(elapsed.toFixed(2));
    rerankStats.totalMs = Number((rerankStats.totalMs + elapsed).toFixed(2));
    rerankStats.docsSent += list.length;
    rerankStats.lastInputTokens = Number(json?.meta?.tokens?.input_tokens ?? 0);

    if (useCache) {
      cache.set(key, { at: Date.now(), results: ranked });
      while (cache.size > Math.max(1, o.cacheMax)) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
    }
    return ranked;
  } catch {
    // 超时 / 网络 / 解析失败都走这里：精排是加分项，不许把主路径拖崩
    rerankStats.failures += 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把精排结果套回候选数组：ranked 里的 index 按精排序提到前面，其余保持原序。
 * 纯函数，方便单测与「精排只改顺序、不改集合」这条不变量的验证。
 *
 * @template T
 * @param {T[]} items
 * @param {Array<{index:number, score:number}>|null} ranked
 * @returns {{items:T[], moved:number, applied:boolean}}
 */
export function applyRerank(items, ranked) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (!Array.isArray(ranked) || !ranked.length || !list.length) {
    return { items: list, moved: 0, applied: false };
  }
  const seen = new Set();
  const head = [];
  for (const r of ranked) {
    if (!Number.isInteger(r?.index) || r.index < 0 || r.index >= list.length) continue;
    if (seen.has(r.index)) continue;
    seen.add(r.index);
    head.push(list[r.index]);
  }
  if (!head.length) return { items: list, moved: 0, applied: false };
  const tail = list.filter((_, i) => !seen.has(i));
  return { items: [...head, ...tail], moved: head.length, applied: true };
}

export default { rerank, applyRerank, rerankEnabled, rerankOptIn, clearRerankCache, rerankCacheSize, rerankStats, RERANK_DEFAULTS, RERANK_MODEL, RERANK_ENDPOINT };
