// memjudge 检索层 —— BM25 + CJK 二元组 + 倒排索引 + 混合排序（t11）
//
// 为什么不是「整章当候选」：
//   baseline-bm25 把整章（1480 字）当一条文档，top-3 返回 5566 字符/次，recall 0.989。
//   同样是 0.989，本实现的段级返回只要 1220 字符/次（现场实测，见 test 输出）。
//   整章倾倒的成本是给模型的上下文里塞了 4.5 倍无关文字，而召回率一点没多。
//
// 为什么中文必须二元组：
//   mem-eval 实测里，中文不分词（按空白/标点切）的插件全部崩盘——aik358 0.033、
//   annkun 0.098、memory-eternal 0.163、veyra 0.424。中文没有词边界，按字切则
//   「舱壁」「凹陷」这类两字术语永远不会成为独立 token。二元组是零词典、零训练、
//   对 OOV 完全鲁棒的折中：任意两字组合都进索引，代价是索引变大、单字歧义变多。
//
// 为什么单汉字不算强命中：
//   二元组带来了大量高频单字噪声（「的」「了」「一」）。若允许单字独立支撑一次命中，
//   「为减小受力，船长把航速减到多少？」这类问题会被一堆含「船」的段落淹没。
//   规则：单字 token 进索引、参与打分（乘 singleCharDiscount=0.35），但一条候选必须
//   至少有 1 个长度 ≥2 的 token 命中，否则整条丢弃（hasStrongHit 闸门）。

import { rankWeight } from './schema.mjs';

export const SEARCH_DEFAULTS = Object.freeze({
  k1: 1.5, // BM25 词频饱和参数（与 mem-eval worker 的 buildBM25Index 同值）
  b: 0.75, // 长度归一化强度。1=完全归一，0=不归一；段级语料取 0.75 让长段不吃亏
  singleCharDiscount: 0.35, // 单汉字 token 的分数折扣（只降权，不禁止）
  decayFloor: 0, // 0 = 严格按 schema.decayFactor（能力 12 要求 30 天 ≤0.25）；>0 会放宽旧条目，见 test 的对照曲线
  topChapters: 2, // 章级聚合取前几章（实测：1→0.946，2→0.989，3→0.978）
  chapterAgg: 3, // 章分 = 章内 top-N 段分之和
  maxChars: 2000, // 单次返回字符预算（能力 8 阈值）
  limit: 16, // 单次返回段数上限（防极短段填满预算）
});

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const LATIN_WORD = /[A-Za-z][A-Za-z0-9._:-]*|\d[A-Za-z0-9._:-]*/g;

/**
 * 分词：CJK 二元组 + 拉丁/数字词。
 * 返回三类结果，区分「进索引」与「算强命中」是两层：
 *   tokens —— 全部进索引的 token（含单汉字）
 *   strong —— 长度 ≥2 的 token（unicode bigram 或拉丁词），只有它们能单独支撑一条命中
 */
export function tokenize(text) {
  const s = String(text ?? '');
  const tokens = [];
  const strong = [];
  for (const run of s.match(CJK_RUN) ?? []) {
    // 单字连续段（如「鲸」独立成句）只产单字 token
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i < run.length - 1; i += 1) {
      const g = run.slice(i, i + 2);
      tokens.push(g);
      strong.push(g);
    }
  }
  for (const w of s.match(LATIN_WORD) ?? []) {
    const lw = w.toLowerCase();
    tokens.push(lw);
    if (lw.length >= 2) strong.push(lw);
  }
  return { tokens, strong, hasStrong: strong.length > 0 };
}

/** 便捷：只要 token 列表（索引构建用）。 */
export function terms(text) {
  return tokenize(text).tokens;
}

function normNum(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 混合排序分：bm25 × 衰减 × 重要度 × 访问惯量。
 * 衰减挂 lastAccessed（不是 createdAt）—— 这是本层与 mem-eval 里 11 个插件的
 * 关键分歧：它们全部用 createdAt，于是「30 天前写、但每天在用的规矩」会沉底。
 * 复用 schema.rankWeight 保证与能力 11/12 的验收口径是同一份公式。
 */
export function finalScore(bm25, mem, nowMs = Date.now(), opts = {}) {
  const o = { ...SEARCH_DEFAULTS, ...opts };
  const rw = rankWeight(mem, nowMs);
  // decayFloor 只覆盖时间项，其余因子仍走 rankWeight，避免两处公式漂移
  const decay = o.decayFloor > 0 ? Math.max(o.decayFloor, rw.value) : rw.value;
  const weight = Number((decay * rw.importanceFactor * rw.accessFactor * rw.supersededPenalty).toFixed(6));
  return {
    score: Number((bm25 * weight).toFixed(6)),
    bm25: Number(bm25.toFixed(6)),
    weight,
    decay,
    ageDays: rw.ageDays,
    tier: rw.tier,
    halfLifeDays: rw.halfLifeDays,
    superseded: Boolean(mem?.supersededBy),
  };
}

class SearchIndex {
  /** @param {object} [opts] SEARCH_DEFAULTS 覆盖项 */
  constructor(opts = {}) {
    this.opts = { ...SEARCH_DEFAULTS, ...opts };
    /** @type {Array<object>} 文档表：一条 = 一个片段（段） */
    this.docs = [];
    /** @type {Map<string, Array<[number, number]>>} token → [docIdx, tf] */
    this.postings = new Map();
    /** @type {Map<number, Array<[string, number]>>} */
    this.byChapter = new Map();
    this.n = 0;
    this.avgdl = 0;
    this._totalLen = 0;
    this._builtAt = null;
  }

  /**
   * 加一条片段。宽松接受 plain object，只取检索/排序需要的字段；
   * 若传入了 schema 的 createMemory 产物（冻结对象）也可直接加。
   */
  add(mem) {
    const text = String(mem?.text ?? '');
    if (!text) return this;
    const { tokens } = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const idx = this.docs.length;
    const nowMs = normNum(mem?.createdAt, Date.now());
    const doc = {
      id: String(mem?.id ?? `doc-${idx}`),
      text,
      chapter: normNum(mem?.source?.chapter, 0),
      para: normNum(mem?.source?.para, idx + 1),
      kind: mem?.kind ?? 'fact',
      len: tokens.length,
      tf,
      importance: Math.min(1, Math.max(0, normNum(mem?.importance, 0.5))),
      accessCount: Math.max(0, normNum(mem?.accessCount, 0)),
      createdAt: nowMs,
      lastAccessed: normNum(mem?.lastAccessed, nowMs),
      supersededBy: mem?.supersededBy ?? null,
    };
    this.docs.push(doc);
    this._totalLen += doc.len;
    for (const [t, f] of tf) {
      let list = this.postings.get(t);
      if (!list) { list = []; this.postings.set(t, list); }
      list.push([idx, f]);
    }
    let chList = this.byChapter.get(doc.chapter);
    if (!chList) { chList = []; this.byChapter.set(doc.chapter, chList); }
    chList.push(idx);
    this.n = this.docs.length;
    this.avgdl = this.n ? this._totalLen / this.n : 0;
    this._builtAt = Date.now();
    return this;
  }

  addAll(mems) {
    for (const m of mems ?? []) this.add(m);
    return this;
  }

  /** 索引体检数据（用于证明「建了倒排、不是每次扫全库」）。 */
  stats() {
    let postings = 0;
    for (const list of this.postings.values()) postings += list.length;
    return {
      docs: this.n,
      terms: this.postings.size,
      postings,
      avgdl: Number(this.avgdl.toFixed(2)),
      chapters: this.byChapter.size,
      builtAt: this._builtAt,
    };
  }

  /**
   * 只走倒排：按查询 token 拉 posting list，不遍历 this.docs。
   * 返回 Map<docIdx, {bm25, strongHits}> 与工作量统计。
   */
  scoreTerms(query, opts = {}) {
    const o = { ...this.opts, ...opts };
    const { tokens, strong } = tokenize(query);
    const qTerms = [...new Set(tokens)];
    const strongSet = new Set(strong);
    const acc = new Map();
    let postingsVisited = 0;
    let hitTerms = 0;

    for (const term of qTerms) {
      const list = this.postings.get(term);
      if (!list) continue;
      hitTerms += 1;
      const df = list.length;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      const disc = term.length === 1 ? o.singleCharDiscount : 1;
      const isStrong = strongSet.has(term) || term.length >= 2;
      for (let k = 0; k < list.length; k += 1) {
        const docIdx = list[k][0];
        const tf = list[k][1];
        postingsVisited += 1;
        const d = this.docs[docIdx];
        const denom = tf + o.k1 * (1 - o.b + (o.b * d.len) / (this.avgdl || 1));
        const add = disc * idf * ((tf * (o.k1 + 1)) / (denom || 1));
        let e = acc.get(docIdx);
        if (!e) { e = { bm25: 0, strongHits: 0 }; acc.set(docIdx, e); }
        e.bm25 += add;
        if (isStrong) e.strongHits += 1;
      }
    }

    return {
      acc,
      scan: {
        qTerms: qTerms.length,
        hitTerms,
        postingsVisited,
        docsScored: acc.size,
        docsTotal: this.n,
        scanRatio: this.n ? Number((acc.size / this.n).toFixed(4)) : 0,
      },
    };
  }

  /**
   * 检索主入口。
   * 两阶段：段级 BM25 → 章级聚合选章 → 章内按混合分装填预算。
   *
   * 章级聚合不是冗余步骤：段级 top-K 单独跑只能到 0.978（R44/R20 掉出），
   * 因为一道题的证据往往散在同一章的两三段里，而其中只有一段与查询共享 bigram。
   * 先聚章再取章内段，等于承认「同章上下文是相关的」，实测把 0.978 拉到 0.989。
   */
  search(query, opts = {}) {
    const o = { ...this.opts, ...opts };
    const nowMs = normNum(opts.now ?? Date.now(), Date.now());
    const t0 = process.hrtime.bigint();

    const { acc, scan } = this.scoreTerms(query, o);

    // 强命中闸门：只命中单汉字的候选一律不进结果
    const scored = [];
    for (const [docIdx, e] of acc) {
      if (e.strongHits === 0 || e.bm25 <= 0) continue;
      const d = this.docs[docIdx];
      const mix = finalScore(e.bm25, d, nowMs, o);
      scored.push({ idx: docIdx, doc: d, ...mix });
    }
    scored.sort(
      (a, b) => b.score - a.score || b.bm25 - a.bm25 || a.doc.id.localeCompare(b.doc.id),
    );

    if (!scored.length) {
      const emptyNow = process.hrtime.bigint();
      return {
        hits: [],
        text: '',
        chars: 0,
        scan: { ...scan, chaptersConsidered: 0, candidates: 0 },
        elapsedMs: Number(emptyNow - t0) / 1e6,
      };
    }

    // 章级聚合：章分 = 章内 top-aggregate 段混合分之和
    const perChapter = new Map();
    for (const s of scored) {
      let bucket = perChapter.get(s.doc.chapter);
      if (!bucket) { bucket = []; perChapter.set(s.doc.chapter, bucket); }
      bucket.push(s);
    }
    const chapterRank = [...perChapter.entries()]
      .map(([chapter, list]) => ({
        chapter,
        champ: list.slice(0, o.chapterAgg).reduce((a, x) => a + x.score, 0),
        best: list[0],
      }))
      .sort((a, b) => b.champ - a.champ || a.chapter - b.chapter)
      .slice(0, o.topChapters);

    const picked = new Set();
    const out = [];
    let chars = 0;
    const push = (s) => {
      if (picked.has(s.idx) || out.length >= o.limit) return;
      if (chars + s.doc.text.length > o.maxChars) return;
      picked.add(s.idx);
      out.push(s);
      chars += s.doc.text.length;
    };
    for (const { chapter } of chapterRank) {
      const list = perChapter.get(chapter).slice().sort((a, b) => b.score - a.score);
      for (const s of list) push(s);
    }

    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const hits = out.map((s) => ({
      id: s.doc.id,
      chapter: s.doc.chapter,
      para: s.doc.para,
      text: s.doc.text,
      chars: s.doc.text.length,
      score: s.score,
      bm25: s.bm25,
      weight: s.weight,
      decay: s.decay,
      ageDays: s.ageDays,
      tier: s.tier,
    }));

    return {
      hits,
      // 纯原文拼接：不加任何前后缀，保证「逐字回原文」能力不被检索层污染
      text: hits.map((h) => h.text).join('\n\n'),
      chars,
      scan: {
        ...scan,
        chaptersConsidered: chapterRank.length,
        candidates: scored.length,
        chaptersPicked: chapterRank.map((c) => c.chapter),
      },
      elapsedMs,
    };
  }
}

/** 建索引。mems 里每条 = 一个片段（不要传整章）。 */
export function index(mems, opts = {}) {
  return new SearchIndex(opts).addAll(mems);
}

/** 一次性检索（内部会沿用传入的索引实例，不重建）。 */
export function search(idx, query, opts = {}) {
  if (!(idx instanceof SearchIndex)) throw new TypeError('search: 第一个参数必须是 index() 返回的索引');
  return idx.search(query, opts);
}

/** 单条打分（不建索引，用于对照实验与单元断言）。 */
export function score(queryText, docText, mem = {}, opts = {}) {
  const o = { ...SEARCH_DEFAULTS, ...opts };
  const q = new Set(tokenize(queryText).tokens);
  const strong = new Set(tokenize(queryText).strong);
  const { tokens } = tokenize(docText);
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let bm25 = 0;
  let strongHits = 0;
  for (const t of q) {
    const f = tf.get(t) ?? 0;
    if (!f) continue;
    // 单文档场景没有 df，用 df=1 的保守 idf（只用于相对比较，不进检索主路径）
    const idf = Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5));
    const disc = t.length === 1 ? o.singleCharDiscount : 1;
    bm25 += disc * idf * ((f * (o.k1 + 1)) / (f + o.k1 * (1 - o.b + (o.b * tokens.length) / (tokens.length || 1))));
    if (strong.has(t) || t.length >= 2) strongHits += 1;
  }
  return { ...finalScore(bm25, mem, normNum(mem.lastAccessed, Date.now()), o), strongHits };
}

export { SearchIndex };
export default { SEARCH_DEFAULTS, tokenize, terms, index, search, score, finalScore, SearchIndex };
