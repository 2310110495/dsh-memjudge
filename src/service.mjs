// memjudge 只读服务契约：把记忆库以 `ctx.provide('memjudge', createService(ctx, deps))`
// 的形式暴露给**同进程**的其他插件（dsh-workbench 的收尾观测、任何要读记忆库的插件）。
//
// 为什么只有这一条通路是干净的：
//   - RPC（src/rpc.mjs 的 `/memjudge` 频道）是 browser↔host 且 authority:'loopback'，
//     宿主的另一个插件进程内根本调不到；
//   - HTTP 明确不起端口——这个插件装在一个本地 harness 里，开端口是净负债；
//   - 直接 `import` 对端的 store.mjs 会绑死装机绝对路径，且哪天内部 API 一改就断，
//     而版本号（version: '1'）就是给下游判代的。
//
// **只读是硬约束**：这份 API 面上没有任何写方法。忘记、删除、写入只能走 memjudge_*
// 工具，由会话里的模型显式决定；下游插件不该借这条通路悄悄改用户的记忆库。
// 所以这里连 `touchOnRecall` 的访问计数刷新都关掉了（见 index.mjs 的 recall 接线），
// 「读」真的只读，不会在衰减数据里留下脚印。

/** 服务名。与插件 name 同名：下游 `inject: ['memjudge']` 或 `ctx.get('memjudge')`。 */
export const SERVICE_NAME = 'memjudge';

/** 契约版本。下游靠它判代；破坏性改动才升。 */
export const SERVICE_VERSION = '1';

/**
 * 禁止出现在服务面上的方法名（不区分大小写匹配）。
 * 这不是文档，是装配期自检的判据：将来有人往 api 上加一个 `update`，
 * 插件当场装不上，而不是等下游悄悄调了才发现契约被写脏。
 */
export const FORBIDDEN_METHODS = Object.freeze([
  'forget', 'delete', 'remember', 'update', 'put', 'remove',
  'save', 'write', 'set', 'insert', 'drop', 'clear',
]);

/** 单次召回结果的字符预算上限（与 INJECT_HARD_LIMIT 同口径，防下游传 1e9 打爆内存）。 */
const RECALL_MAX_BUDGET = 2000;

/** 召回默认预算：不传就是满预算，与 memjudge_recall 的默认一致。 */
const RECALL_DEFAULT_BUDGET = 2000;

/** 召回章级聚合的默认取章数，与 memjudge_recall 的默认一致（实测 2→0.989）。 */
const RECALL_DEFAULT_TOP_CHAPTERS = 2;

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/**
 * 装配期自检：api 面上出现任何写方法名就抛错。
 * 用正则而不是精确匹配，是为了连 `deleteById` / `removeAll` 这类变体一起挡掉。
 */
function assertReadOnlySurface(api) {
  const pattern = new RegExp(FORBIDDEN_METHODS.join('|'), 'i');
  for (const key of Object.keys(api)) {
    if (pattern.test(key)) {
      throw new Error(`memjudge service: 服务面上不允许出现写方法「${key}」`);
    }
  }
}

/**
 * 构造只读服务对象。
 *
 * @param {object|null} ctx 宿主 Context。当前实现不读它——保留这个位置是为了调用形状
 *   稳定（将来要打日志/埋点就从这里取 ctx.logger），而不是为了假装在用它。
 * @param {{store: object, recall?: (query: string, opts: object) => Promise<object>}} deps
 *   store 必填：任何带 bySourcePrefix/byKind 的 memjudge store（见 src/store.mjs）。
 *   recall 可选：检索链的注入点。给了就复用宿主插件里那条完整链路（BM25 → 章级聚合
 *   → 预算装填 → 拒答门），不给则 recallByQuery 抛错——装配错误要在启动期暴露，
 *   不能返回一个「看起来查了其实没查」的空结果。
 * @returns {Readonly<object>} 冻结的只读服务对象
 */
export function createService(ctx, deps = {}) {
  const store = deps?.store;
  if (!store || typeof store.stats !== 'function'
    || typeof store.bySourcePrefix !== 'function' || typeof store.byKind !== 'function') {
    throw new TypeError('memjudge service: deps.store 必须提供 stats/bySourcePrefix/byKind');
  }
  const recall = typeof deps.recall === 'function' ? deps.recall : null;
  if (deps.guard !== undefined && typeof deps.guard !== 'function') {
    throw new TypeError('memjudge service: deps.guard 必须是函数');
  }
  const guard = deps.guard ?? (() => {});
  if (deps.contentVersion !== undefined && typeof deps.contentVersion !== 'function') {
    throw new TypeError('memjudge service: deps.contentVersion must be a function');
  }
  const contentVersion = deps.contentVersion;

  const api = {
    /** 契约版本。下游先读它再决定怎么用其余方法。 */
    version: SERVICE_VERSION,

    /**
     * 库体统计。原样透传 store.stats()（条目数、三分条数、三元组数、字节、磨损度…），
     * 不在服务层改写口径——下游看到的数字必须和 memjudge_stats 工具看到的一致。
     */
    stats() {
      guard();
      return store.stats();
    },

    /**
     * 按自然语言问题检索，返回精简结果及冲突提示。
     *
     * 与 memjudge_recall 走同一条链：给了 deps.recall 时由宿主插件注入，参数口径一致
     * （budget 1..2000、topChapters 1..4）。区别只有一处：这里**不刷新访问时间**，
     * 只读服务不该改动 lastAccessed / accessCount。
     *
     * @param {string} query 非空问题或关键词
     * @param {{budget?:number, topChapters?:number}} [opts]
     * @returns {Promise<{denied:boolean, reason:string, detail:string, chars:number,
     *   hits:Array<{id:string, chapter:number, para:number, chars:number, score:number, text:string, truncated:boolean}>}>}
     */
    async recallByQuery(query, opts = {}) {
      guard();
      const version = contentVersion?.();
      const q = typeof query === 'string' ? query.trim() : '';
      if (!q) throw new TypeError('memjudge service: query 必须是非空字符串');
      if (!recall) throw new Error('memjudge service: recall 未接线（deps.recall 缺失）');
      const budget = clampInt(opts?.budget, 1, RECALL_MAX_BUDGET, RECALL_DEFAULT_BUDGET);
      const topChapters = clampInt(opts?.topChapters, 1, 4, RECALL_DEFAULT_TOP_CHAPTERS);
      let found;
      try { found = await recall(q, { budget, topChapters }); }
      catch (error) { guard(); throw error; }
      guard();
      if (contentVersion && version !== contentVersion()) throw new Error('memjudge recall stale: content changed');
      if (deps.validateRecall) deps.validateRecall(found);
      return {
        denied: found?.denied === true,
        reason: String(found?.reason ?? ''),
        detail: String(found?.detail ?? ''),
        chars: Number(found?.chars) || 0,
        conflictLine: String(found?.conflictLine ?? ''),
        hits: (Array.isArray(found?.hits) ? found.hits : []).map((h) => ({
          id: String(h?.id ?? ''),
          chapter: Number(h?.chapter) || 0,
          para: Number(h?.para) || 0,
          chars: Number(h?.chars) || 0,
          score: Number(h?.score) || 0,
          text: String(h?.text ?? ''),
          version: String(h?.version ?? ''),
          truncated: h?.truncated === true,
          ...(Number.isInteger(h?.windowStart) ? { windowStart: h.windowStart, windowEnd: h.windowEnd, startsAtBoundary: h.startsAtBoundary === true } : {}),
        })),
      };
    },

    /**
     * 按 source 前缀取原文（created_at 升序）。前缀是字面量，`_`/`%` 不通配。
     * 典型用法：`bySourcePrefix('auto:chat#abcdef12')` 取某次会话自动采集的全部记忆。
     *
     * @param {string} prefix 非空字符串前缀（空串合法 = 所有带 source 的记忆）
     * @param {number} [limit] 缺省 50，钳到 1..10000
     */
    bySourcePrefix(prefix, limit) {
      guard();
      if (typeof prefix !== 'string') {
        throw new TypeError('memjudge service: prefix 必须是字符串');
      }
      return store.bySourcePrefix(prefix, limit);
    },

    /** 返回记忆的全部已知位置；未知 source/documentId/chapter/para 保持 null。 */
    occurrencesV1(memoryId) {
      guard();
      if (typeof memoryId !== 'string' || !memoryId.trim()) {
        throw new TypeError('memjudge service: memoryId 必须是非空字符串');
      }
      if (typeof store.occurrencesV1 !== 'function') {
        throw new Error('memjudge service: occurrencesV1 存储能力缺失');
      }
      return store.occurrencesV1(memoryId);
    },

    /** 按 source 前缀查位置，而非 documentId；limit 限制位置数，默认 50、范围 1..10000，无偏移分页。 */
    bySourcePrefixV1(prefix, limit) {
      guard();
      if (typeof prefix !== 'string') {
        throw new TypeError('memjudge service: prefix 必须是字符串');
      }
      if (typeof store.bySourcePrefixV1 !== 'function') {
        throw new Error('memjudge service: bySourcePrefixV1 存储能力缺失');
      }
      return store.bySourcePrefixV1(prefix, limit);
    },

    /**
     * 按 kind 取原文（created_at 升序）。非法 kind 归 'event'——与写入路径同一口径。
     *
     * @param {'person'|'promise'|'event'} kind
     * @param {number} [limit] 缺省 50，钳到 1..10000
     */
    byKind(kind, limit) {
      guard();
      return store.byKind(kind, limit);
    },
  };

  assertReadOnlySurface(api);
  // 冻结：下游插件改不动这个对象上的方法，契约只在 memjudge 这一侧演进。
  return Object.freeze(api);
}

export default { createService, SERVICE_NAME, SERVICE_VERSION, FORBIDDEN_METHODS };
