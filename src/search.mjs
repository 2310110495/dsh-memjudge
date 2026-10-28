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
//
// t12 升级（来源：TencentDB-Agent-Memory src/core/store/sqlite.ts:156-280）：
//   CJK 切分由「相邻二元组」换成 jieba 搜索引擎模式 cutForSearch(text, true)。
//   抄三件：懒加载单例 + require 失败置 null 永不重试（:166-178）、搜索模式而非精确模式
//   （cutForSearch 同时产出整词与子词，「北京烤鸭」→ 北京/烤鸭/北京烤鸭，长词不会被切丢）、
//   ZH_STOP_WORDS 小停用词表（:184-189）。不抄它的 FTS5 引号 OR 拼装——memjudge 自带倒排与 BM25。
//   为什么换：二元组把「凹陷深度」切成 凹陷/陷深/深度，凭空造出「陷深」这个不存在的词，
//   IDF 被噪声摊薄；jieba 只给 凹陷/深度。
//   @node-rs/jieba 在 optionalDependencies 里，装不上（离线/无预编译包）自动退回二元组，
//   两条路径都通、结果都在同一处（tokenize）。强制降级：MEMJUDGE_NO_JIEBA=1。
//   保留不变：Latin 整词 + 小写化 + 英语停用词 + Porter 词干（meow 那套），只换 CJK 切分。
//   Latin/假名边界仍由 run 扫描决定，只把含汉字的 run 交给 jieba（纯假名交给 jieba 会被
//   中文词典切碎，仍走二元组）。

import { createRequire } from 'node:module';
import { rankWeight, decayFactor, DECAY } from './schema.mjs';

export const SEARCH_DEFAULTS = Object.freeze({
  k1: 1.5, // BM25 词频饱和参数（与 mem-eval worker 的 buildBM25Index 同值）
  b: 0.75, // 长度归一化强度。1=完全归一，0=不归一；段级语料取 0.75 让长段不吃亏
  singleCharDiscount: 0.35, // 单汉字 token 的分数折扣（只降权，不禁止）
  subwordDiscount: 0.35, // jieba 子词的分数折扣（「轮机」之于「轮机长」：同一处证据，不重复计满权）
  decayFloor: 0, // 0 = 严格按衰减公式（能力 12 要求 30 天 ≤0.25）；>0 会放宽旧条目
  halfLifeDays: null, // null = 用 schema 双档（warm 120 / cold 12）；数值 = 统一覆盖（RestRegular 风格）
  topChapters: 3, // 章级聚合取前几章。旧实测 1→0.946、2→0.989（bigram 时代）；jieba 接入后词级候选更稀疏，取 2 会让「一章只有一段强命中」的章整体落选（R10 的正确段在第 3 章），取 3 同时保住召回 91/92 与能力 4 的 0.583
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

/** 单字符分类：CJK → 词切分路径；字母/数字 → 整词路径；其余（标点/符号/emoji）→ 丢弃。 */
function classify(cp) {
  if (CJK.test(cp)) return 'cjk';
  if (WORD.test(cp)) return 'word';
  return 'skip';
}

// ── jieba（腾讯 MemoryCore 抄来的懒加载单例） ──────────────────────────────
// 语义照抄 sqlite.ts:166-178：undefined = 还没试过；null = 试过且不可用，**永不重试**。
// 后者是关键——依赖没装时每次 tokenize 都去 require 一次会把 3 万字的索引构建拖成灾难。
const nodeRequire = createRequire(import.meta.url);

/** 腾讯 :184-189 原表，只保留高频功能词。 */
const ZH_STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那',
  '吗', '吧', '呢', '啊', '呀', '哦', '嗯',
]);

/** 只对含汉字的 run 用 jieba；纯假名（タワー/ひらがな）走二元组，中文词典切不好它们。 */
const HAN = /[\p{Script=Han}]/u;

let _jieba; // undefined = 未尝试 | null = 不可用 | 对象 = 可用

/** 取 jieba 单例；不可用返回 null（调用方据此退回二元组）。 */
function getJieba() {
  if (_jieba !== undefined) return _jieba;
  if (process.env.MEMJUDGE_NO_JIEBA === '1') {
    _jieba = null; // 显式降级（模拟 optionalDependency 未装 / 离线）
    return _jieba;
  }
  try {
    const { Jieba } = nodeRequire('@node-rs/jieba');
    const { dict } = nodeRequire('@node-rs/jieba/dict');
    const inst = Jieba.withDict(dict);
    _jieba = typeof inst?.cutForSearch === 'function' ? inst : null;
  } catch {
    _jieba = null; // 装不上就永久走二元组，不重试
  }
  return _jieba;
}

/** 供测试/诊断：读当前是否真的用上了 jieba（不改状态）。 */
export function jiebaActive() {
  return getJieba() !== null;
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
 * 分词（meow 类别路由 + jieba CJK 切分 + en 归一化）：
 * - CJK 类（汉字+假名）：
 *     · 含汉字的 run 且 jieba 可用 → cutForSearch(run, true) 搜索引擎模式，
 *       整词与子词同时产出（「北京烤鸭」→ 北京/烤鸭/北京烤鸭），滤标点/中文停用词/本 run 内重复；
 *     · jieba 不可用、或纯假名 run、或切完为空 → 相邻二元组（零依赖兜底，run<2 保留单字）；
 * - 字母/数字类（\p{L}\p{N}）：连续段整词 + 小写化（café/привет/한국어/全角英数…）；
 * - 其余（标点/空白/符号/emoji）：跳过——信息量为零，不污染 IDF。
 * 文本先 NFKC 归一化（全角ＢＭ２５→bm25、半角片假名→全角）；Array.from 按 code point
 * 迭代，emoji/Ext B 汉字等 surrogate pair 不切半。
 *
 * 返回三类结果，区分「进索引」与「算强命中」是两层：
 *   tokens —— 全部进索引的 token（含单汉字）
 *   strong —— 长度 ≥2 的 token（词或二元组或拉丁词），只有它们能单独支撑一条命中
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
      const runText = run.join('');
      const jb = HAN.test(runText) ? getJieba() : null;
      let emitted = 0;
      if (jb) {
        const seen = new Set();
        const picked = [];
        for (const t of jb.cutForSearch(runText, true)) {
          const w = String(t).trim();
          if (!w || !WORD.test(w) || ZH_STOP_WORDS.has(w) || seen.has(w)) continue;
          seen.add(w);
          picked.push(w);
        }
        // 子词不再删除，只登记到 tokenize 的 weak 集合由打分侧折扣。
        // 腾讯那边用 FTS5 的 OR 串，重复词不重复计分，所以它不用管；
        // memjudge 带 tf 权重，必须把「轮机/机长/轮机长」的重复计分压下去，
        // 但同一批子词对「硫含量/检验员机舱」这类问法是唯一的召回桥梁，不能删。
        for (const w of picked) {
          raw.push(w);
          emitted += 1;
        }
      }
      // 兜底：jieba 不可用 / 纯假名 / 切完被停用词滤空 → 二元组
      if (emitted === 0) {
        if (run.length >= 2) {
          for (let k = 0; k + 1 < run.length; k += 1) raw.push(run[k] + run[k + 1]);
        } else {
          raw.push(run[0]); // 单字保留（memjudge 需要单字 token 进索引，打分时降权）
        }
      }
    } else {
      raw.push(run.join('').toLowerCase());
    }
    i = j;
  }
  // 英语归一化：停用词 + Porter 词干还原
  const tokens = normalizeEn(raw);
  const strong = tokens.filter((t) => t.length >= 2);
  // 子词归并表：子词 → 包含它的整词。cutForSearch 把「轮机长」同时吐成 轮机/机长/轮机长，
  // 三者是同一处证据。全部照收会让 tf 变成三倍（同一句里出现两次 = 6），把只含子词的段落
  // 顶到正确段之上（实测 R10 误命中 c16p11 得分 13.64）；全部删掉又会丢掉子词级召回
  // （R12「硫含量」被整词盖住后 body 覆盖率从 0.56 掉到 0.33，被拒答门误杀）。
  // 所以既不删也不重复计：整词在场时，子词的计数归并给它（由 add()/scoreTerms() 执行）。
  const covers = new Map();
  for (const a of tokens) {
    if (a.length < 2) continue;
    for (const b of tokens) {
      if (b.length > a.length && b.includes(a)) { covers.set(a, b); break; }
    }
  }
  return { tokens, strong, hasStrong: strong.length > 0, covers };
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
    const { tokens, covers } = tokenize(text);
    const tfAll = new Map();
    for (const t of tokens) tfAll.set(t, (tfAll.get(t) ?? 0) + 1);
    // 整词在场 → 子词计数归并（不重复计分）；整词缺席 → 子词照常保留自己的 tf。
    const tf = new Map();
    for (const [t, f] of tfAll) {
      const whole = covers.get(t);
      if (whole && tfAll.has(whole)) continue;
      tf.set(t, f);
    }
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
    const { tokens, strong, covers: qCovers } = tokenize(query);
    const qAll = new Set(tokens);
    // 查询侧同样归并：整词已在，子词不再单独加一次分（否则一次提问被数三遍）。
    const qTerms = [...qAll].filter((t) => {
      const whole = qCovers.get(t);
      return !(whole && qAll.has(whole));
    });
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
    let chapterRank = [...perChapter.entries()]
      .map(([chapter, list]) => ({
        chapter,
        champ: list.slice(0, o.chapterAgg).reduce((a, x) => a + x.score, 0),
        best: list[0],
      }))
      .sort((a, b) => b.champ - a.champ || a.chapter - b.chapter);
    // 条件式第 3 章：词级切分下正确段可能独占一章、章分只有一段撑着（R10 的第 3 章、
    // S06 的第 14 章）。固定取 3 章会把无关段一起拉进 body（H1 的拒答就是被拉进来的
    // 呼号段搅掉的），所以只在「第 3 章分数够接近第 2 章」时才多取一章。
    const keep = o.topChapters;
    const extra = chapterRank.length > keep && chapterRank[keep].champ >= 0.8 * chapterRank[keep - 1].champ ? 1 : 0;
    chapterRank = chapterRank.slice(0, keep + extra);

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

    // 预算比最短候选段还小时，逐段整取会一个都装不下 —— 那等于「有命中却报零结果」，
    // 下游看到的是 denied=true，比返回一段截断原文更糟。这里退回「最高分段的截断片段」，
    // 并且只在整取结果为空时才触发，不影响正常预算下的装填。
    if (!out.length && scored.length && o.maxChars > 0) {
      const top = scored[0];
      const cut = top.doc.text.slice(0, o.maxChars);
      out.push({ ...top, doc: { ...top.doc, text: cut }, truncated: true });
      chars = cut.length;
    }

    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const hits = out.map((s) => ({
      id: s.doc.id,
      chapter: s.doc.chapter,
      para: s.doc.para,
      text: s.doc.text,
      chars: s.doc.text.length,
      truncated: Boolean(s.truncated),
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
  const qt = tokenize(queryText);
  const q = new Set(qt.tokens);
  const strong = new Set(qt.strong);
  const dt = tokenize(docText);
  const { tokens, covers: docCovers } = dt;
  const tfAll = new Map();
  for (const t of tokens) tfAll.set(t, (tfAll.get(t) ?? 0) + 1);
  // 与 add()/scoreTerms() 同一套子词归并：整词在场时子词不再重复计分。
  const tf = new Map();
  for (const [t, f] of tfAll) {
    const whole = docCovers.get(t);
    if (whole && tfAll.has(whole)) continue;
    tf.set(t, f);
  }
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
export default { SEARCH_DEFAULTS, tokenize, terms, index, search, score, finalScore, SearchIndex, jiebaActive };
