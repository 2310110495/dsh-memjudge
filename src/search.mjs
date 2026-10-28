// memjudge 检索层 —— BM25 + CJK 二元组 + 倒排索引 + 混合排序（t11 + t1 升级）
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
//
// t1 升级（来源：meow bm25.ts + RestRegular scoring.ts）：
//   1. 分词器 → meow 类别路由：CJK bigram + Latin 整词（小写化） + NFKC +
//      英语停用词 + Porter 词干还原。NFKC 解决全角ＢＭ２５→bm25、半角片假名→全角；
//      停用词+Porter 解决英语查询的屈折变化（caches/caching/cached 归同一词干）。
//   2. 打分 → RestRegular recordScore()：lexical × recency × importance × access × penalty
//      五因子乘性。公式与 schema.rankWeight 同源，但 halfLifeDays 暴露为可配置参数。
//   3. 衰减 → RestRegular recencyFactor(ageDays, halfLifeDays)：
//      Math.pow(0.5, ageDays/halfLifeDays)，半衰期可配置（SEARCH_DEFAULTS.halfLifeDays）。
//      null = 沿用 schema 双档（warm 120 天 / cold 12 天）；数值 = 统一覆盖。
//
// 与源的三处有意偏离（不是抄漏，逐条可核，验收见 test/retrieval-port.test.mjs）：
//   a. meow 的 CJK run 长度 <2 时不产出 token；本实现保留单字进倒排（打分乘
//      singleCharDiscount=0.35），因为「单汉字不算强命中」闸门需要单字先进索引才能被计数拦下。
//   b. meow 只在 promptLang=en 时做停用词+Porter；本实现无条件做。中文 bigram 不受影响
//      （normalizeEn 只动纯字母词），写入侧与检索侧走同一函数，命中一致性不破。
//   c. 默认衰减走 schema 双档（warm/cold），只有显式传 halfLifeDays 数值才是 RestRegular
//      的统一半衰期。两条路径的乘性因子同源（0.5+0.5·imp / 1+0.1·ln(1+acc) / 0.3 罚）。

import { rankWeight, decayFactor, DECAY } from './schema.mjs';

export const SEARCH_DEFAULTS = Object.freeze({
  k1: 1.5, // BM25 词频饱和参数（与 mem-eval worker 的 buildBM25Index 同值）
  b: 0.75, // 长度归一化强度。1=完全归一，0=不归一；段级语料取 0.75 让长段不吃亏
  singleCharDiscount: 0.35, // 单汉字 token 的分数折扣（只降权，不禁止）
  decayFloor: 0, // 0 = 严格按衰减公式（能力 12 要求 30 天 ≤0.25）；>0 会放宽旧条目
  halfLifeDays: null, // null = 用 schema 双档（warm 120 / cold 12）；数值 = 统一覆盖（RestRegular 风格）
  topChapters: 2, // 章级聚合取前几章（实测：1→0.946，2→0.989，3→0.978）
  chapterAgg: 3, // 章分 = 章内 top-N 段分之和
  maxChars: 2000, // 单次返回字符预算（能力 8 阈值）
  limit: 16, // 单次返回段数上限（防极短段填满预算）
});

// ── meow 分词器（类别路由 v0.20.0 + en 归一化） ────────────────────────────
// CJK 类：汉字（\p{Script=Han} 覆盖基本区+Ext A~I）+ 假名 + 日文词内符号（々 叠字 / ー
// 长音符——script=Common，但必须随 CJK run，"人々/タワー"才能整体成词）
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]/u;
// 字母/数字类：é ü ñ、西里尔、希腊、谚文、全角英数（NFKC 后）……一切语言的字母数字
const WORD = /[\p{L}\p{N}]/u;

/** 单字符分类：CJK → bigram 路径；字母/数字 → 整词路径；其余（标点/符号/emoji）→ 丢弃。 */
function classify(cp) {
  if (CJK.test(cp)) return 'cjk';
  if (WORD.test(cp)) return 'word';
  return 'skip';
}

// 英语停用词（含撇号切分碎片 s/t/d/ll/ve/re/m）。功能词不承载检索意义。
const EN_STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'cannot', 'could', 'd', 'did', 'do', 'does', 'doing', 'don', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'just', 'll', 'm', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  're', 's', 'same', 'she', 'should', 'so', 'some', 'such', 't', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 've', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

// Porter stemmer（Porter 1980 原始算法，零依赖移植）。词干只用于匹配，不入库、不展示。
const PORTER_STEP2 = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble',
  alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate',
  ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al',
  iviti: 'ive', biliti: 'ble', logi: 'log',
};
const PORTER_STEP3 = {
  icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '',
};

const CONS = '[^aeiou]';
const VOW = '[aeiouy]';
const CONS_SEQ = `${CONS}[^aeiouy]*`;
const VOW_SEQ = `${VOW}[aeiou]*`;
const MGR0 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}`);
const MEQ1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}(${VOW_SEQ})?$`);
const MGR1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}${VOW_SEQ}${CONS_SEQ}`);
const HAS_VOWEL = new RegExp(`^(${CONS_SEQ})?${VOW}`);

/** Porter 词干还原（小写纯字母词；长度 ≤2 原样返回）。 */
export function stemEn(word) {
  let w = word;
  if (w.length <= 2) return w;

  // Step 1a — 复数
  if (/(ss|i)es$/.test(w)) w = w.replace(/(ss|i)es$/, '$1');
  else if (/([^s])s$/.test(w)) w = w.replace(/([^s])s$/, '$1');

  // Step 1b — 过去式/进行时
  if (/eed$/.test(w)) {
    const stem = w.slice(0, -3);
    if (MGR0.test(stem)) w = w.slice(0, -1);
  } else if (/(ed|ing)$/.test(w)) {
    const stem = w.replace(/(ed|ing)$/, '');
    if (HAS_VOWEL.test(stem)) {
      w = stem;
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1); // 双写辅音还原
      else if (new RegExp(`^${CONS_SEQ}${VOW}[^aeiouwxy]$`).test(w)) w += 'e'; // *o 条件
    }
  }

  // Step 1c — y → i
  if (/y$/.test(w)) {
    const stem = w.slice(0, -1);
    if (HAS_VOWEL.test(stem)) w = `${stem}i`;
  }

  // Step 2 / 3 — 派生后缀归并
  for (const [suffix, repl] of Object.entries(PORTER_STEP2)) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      if (MGR0.test(stem)) w = stem + repl;
      break;
    }
  }
  for (const [suffix, repl] of Object.entries(PORTER_STEP3)) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      if (MGR0.test(stem)) w = stem + repl;
      break;
    }
  }

  // Step 4 — 剥离剩余派生后缀（m>1）
  const step4 = /(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  if (step4.test(w)) {
    const stem = w.replace(step4, '');
    if (MGR1.test(stem)) w = stem;
  } else if (/(s|t)(ion)$/.test(w)) {
    const stem = w.replace(/(s|t)(ion)$/, '$1');
    if (MGR1.test(stem)) w = stem;
  }

  // Step 5 — 收尾 e / 双写 l
  if (/e$/.test(w)) {
    const stem = w.slice(0, -1);
    if (MGR1.test(stem) || (MEQ1.test(stem) && !new RegExp(`^${CONS_SEQ}${VOW}[^aeiouwxy]$`).test(stem))) w = stem;
  }
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1);

  return w;
}

/** 停用词丢弃 + 词干还原（纯字母词才还原；数字/混合 token 原样保留）。 */
function normalizeEn(tokens) {
  const out = [];
  for (const t of tokens) {
    if (EN_STOPWORDS.has(t)) continue;
    out.push(/^[a-z]+$/.test(t) ? stemEn(t) : t);
  }
  return out;
}

/**
 * 分词（meow 类别路由 + en 归一化）：
 * - CJK 类（汉字+假名）：连续段相邻 bigram——中文稳定零依赖，日文 n-gram 基线；
 *   run<2 单字不成词丢弃防噪音；汉字-假名交界不断 run，"行く/食べる"自然成词；
 * - 字母/数字类（\p{L}\p{N}）：连续段整词 + 小写化（café/привет/한국어/全角英数…）；
 * - 其余（标点/空白/符号/emoji）：跳过——信息量为零，不污染 IDF。
 * 文本先 NFKC 归一化（全角ＢＭ２５→bm25、半角片假名→全角）；Array.from 按 code point
 * 迭代，emoji/Ext B 汉字等 surrogate pair 不切半。
 *
 * 返回三类结果，区分「进索引」与「算强命中」是两层：
 *   tokens —— 全部进索引的 token（含单汉字）
 *   strong —— 长度 ≥2 的 token（unicode bigram 或拉丁词），只有它们能单独支撑一条命中
 */
export function tokenize(text) {
  const s = String(text ?? '');
  const cps = Array.from(s.normalize('NFKC'));
  const raw = [];
  let i = 0;
  while (i < cps.length) {
    const cls = classify(cps[i]);
    if (cls === 'skip') { i += 1; continue; }
    let j = i + 1;
    while (j < cps.length && classify(cps[j]) === cls) j += 1;
    const run = cps.slice(i, j);
    if (cls === 'cjk') {
      // 连续 CJK → 相邻 bigram（单字不成词，避免噪音）
      if (run.length >= 2) {
        for (let k = 0; k + 1 < run.length; k += 1) raw.push(run[k] + run[k + 1]);
      } else {
        raw.push(run[0]); // 单字保留（memjudge 需要单字 token 进索引，打分时降权）
      }
    } else {
      raw.push(run.join('').toLowerCase());
    }
    i = j;
  }
  // 英语归一化：停用词 + Porter 词干还原
  const tokens = normalizeEn(raw);
  const strong = tokens.filter((t) => t.length >= 2);
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

// ── RestRegular 衰减/打分 ────────────────────────────────────────────────────

/**
 * RestRegular 风格衰减：Math.pow(0.5, ageDays / halfLifeDays)。
 * halfLifeDays 可配置；传入 null 时回退到 schema 双档（warm 120 / cold 12）。
 */
export function recencyFactor(ageDays, halfLifeDays) {
  return Math.pow(0.5, Math.max(0, ageDays) / Math.max(halfLifeDays, 0.001));
}

/**
 * 混合排序分：bm25 × 衰减 × 重要度 × 访问惯量。
 * 衰减挂 lastAccessed（不是 createdAt）—— 这是本层与 mem-eval 里 11 个插件的
 * 关键分歧：它们全部用 createdAt，于是「30 天前写、但每天在用的规矩」会沉底。
 *
 * halfLifeDays 配置链：opts.halfLifeDays > SEARCH_DEFAULTS.halfLifeDays > schema 双档。
 * 公式与 schema.rankWeight 同源（五因子乘性），但半衰期暴露为可配置参数。
 */
export function finalScore(bm25, mem, nowMs = Date.now(), opts = {}) {
  const o = { ...SEARCH_DEFAULTS, ...opts };
  const hl = o.halfLifeDays;
  let rw;
  if (hl !== null && hl !== undefined) {
    // RestRegular 风格：统一半衰期，不走 schema 双档
    const last = normNum(mem?.lastAccessed, nowMs);
    const ageDays = Math.max(0, (nowMs - last) / 86_400_000);
    const decay = recencyFactor(ageDays, hl);
    const importance = Math.min(1, Math.max(0, Number(mem?.importance ?? 0.5)));
    const accessCount = Math.max(0, Number(mem?.accessCount ?? 0));
    const importanceFactor = 0.5 + 0.5 * importance;
    const accessFactor = 1 + 0.1 * Math.log1p(accessCount);
    const supersededPenalty = mem?.supersededBy ? 0.3 : 1;
    rw = {
      value: Number(decay.toFixed(6)),
      ageDays: Number(ageDays.toFixed(3)),
      halfLifeDays: hl,
      tier: 'custom',
      importanceFactor: Number(importanceFactor.toFixed(4)),
      accessFactor: Number(accessFactor.toFixed(4)),
      supersededPenalty,
      weight: Number((decay * importanceFactor * accessFactor * supersededPenalty).toFixed(6)),
    };
  } else {
    rw = rankWeight(mem, nowMs);
  }
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
    // 三个非时间因子原样透传（RestRegular recordScore 的其余三项），
    // 让 explain / 审计能逐项复算 weight，不必反解 decay。
    importanceFactor: rw.importanceFactor,
    accessFactor: rw.accessFactor,
    supersededPenalty: rw.supersededPenalty,
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
