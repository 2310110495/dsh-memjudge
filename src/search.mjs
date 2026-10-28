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
import { embed as defaultEmbed, cosineInt8 } from './vector.mjs';
import { expand as defaultExpand } from './query-expand.mjs';
import { select as defaultSelect } from './llm-select.mjs';

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

/**
 * RRF 融合：score = Σ 1/(k + rank_i)。k=60 是原论文的默认值，这里也没调——
 * 实测等权就是最优点（wVec=2 反而让 R02 掉出，wVec=3/5 掉 4–5 题）。
 * 两臂各自按自己的序给分，不比较绝对分值：BM25 的分是 jieba 词权重、向量的分是余弦，
 * 两者量纲不可比，唯一可比的是「在各自排序里排第几」。
 */
export function rrfFuse(bm25Ranked, vecRanked, k = 60) {
  const m = new Map();
  bm25Ranked.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1)));
  vecRanked.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1)));
  return m;
}

/**
 * 章级聚合 + 预算装填。search() 与 searchAsync() 共用这一份：
 * 两条路径各写一遍装填迟早会漂移，而 0.989 是压在这套装填上的硬底线。
 */
function fillFromScored(scored, o) {
  // 融合路径也必须走章级聚合：实测把章聚合跳过（纯 RRF 序直接装填）会让召回从
  // 91/92 掉到 87/92——RRF 排序再准，装填时不保证跨章覆盖，正确段照样被长段挤掉。
  // 这段话留着是因为「跳过章聚合」看起来更合理，但数据说不行。

  const perChapter = new Map();
  for (const s of scored) {
    let bucket = perChapter.get(s.doc.chapter);
    if (!bucket) { bucket = []; perChapter.set(s.doc.chapter, bucket); }
    bucket.push(s);
  }
  // LLM 选段（t27）通过 priorityIds 影响装填：含优先段的章必须被选进来，否则
  // 「选了段却被章级聚合丢掉」——这正是 t25/t26 里向量段被挤掉的同一种死法。
  const pri = o.priorityIds instanceof Set ? o.priorityIds : null;
  const priRank = new Map();
  if (pri) {
    let i = 0;
    for (const s of scored) {
      if (pri.has(s.doc.id) && !priRank.has(s.doc.id)) priRank.set(s.doc.id, i);
      i += 1;
    }
  }
  const chapterHasPri = (list) => (pri ? list.some((x) => pri.has(x.doc.id)) : false);
  let chapterRank = [...perChapter.entries()]
    .map(([chapter, list]) => ({
      chapter,
      champ: list.slice(0, o.chapterAgg).reduce((a, x) => a + x.score, 0),
      best: list[0],
      hasPri: chapterHasPri(list),
    }))
    .sort((a, b) => Number(b.hasPri) - Number(a.hasPri) || b.champ - a.champ || a.chapter - b.chapter);
  // 条件式第 3 章：词级切分下正确段可能独占一章、章分只有一段撑着（R10 的第 3 章、
  // S06 的第 14 章）。固定取 3 章会把无关段一起拉进 body（H1 的拒答就是被拉进来的
  // 呼号段搅掉的），所以只在「第 3 章分数够接近第 2 章」时才多取一章。
  const keep = o.topChapters;
  const extra = chapterRank.length > keep && chapterRank[keep].champ >= 0.8 * chapterRank[keep - 1].champ ? 1 : 0;
  // 有 LLM 优先段时，「含优先章的章」排在前面但**不挤掉原来的选章**：
  // 只重排、不丢段是这个功能的前提（第一版直接 slice(0, keep+extra) 会把原第 1 章挤出去，
  // 单测里 d1 就这么消失过）。
  if (pri) {
    const priChapters = chapterRank.filter((c) => c.hasPri);
    const restChapters = chapterRank.filter((c) => !c.hasPri).slice(0, keep + extra);
    chapterRank = [...priChapters, ...restChapters];
  } else {
    chapterRank = chapterRank.slice(0, keep + extra);
  }

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
    const list = perChapter.get(chapter).slice().sort((a, b) => {
      if (pri) {
        const pa = priRank.has(a.doc.id);
        const pb = priRank.has(b.doc.id);
        if (pa !== pb) return pa ? -1 : 1;
        if (pa && pb) return priRank.get(a.doc.id) - priRank.get(b.doc.id);
      }
      return b.score - a.score;
    });
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
  return { out, chars, chapterRank };
}

class SearchIndex {
  /** @type {Map<string, Int8Array>|null} 文档向量（int8），由 store 注入；缺省为 null = 纯 BM25 */
  #vectors = null;

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

  /**
   * 注入文档向量（id → Int8Array）。不注入或注入 null 时 searchAsync 自动退回纯 BM25，
   * 所以调用方不需要判断「今天有没有 key」。
   */
  setVectors(vecs) {
    this.#vectors = vecs instanceof Map && vecs.size ? vecs : null;
    return this;
  }

  /** 向量臂是否就绪（只读诊断用）。 */
  get hasVectors() {
    return Boolean(this.#vectors && this.#vectors.size);
  }

  /** BM25 命中 → 混合分候选，按 score 降序。search 与 searchAsync 共用。 */
  #buildScored(acc, nowMs, o) {
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
    return scored;
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
    const scored = this.#buildScored(acc, nowMs, o);

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

    const { out, chars, chapterRank } = fillFromScored(scored, o);

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

  /**
   * 异步融合检索：BM25 臂 + 向量臂 → RRF → 同一套装填。
   *
   * 为什么不改 search()：0.989 与全部单测压在同步路径上，异步会污染整条链。
   * 这里只做「多一臂」：没有向量、没有 key、超时、429，任何情况都退回 scored 原序，
   * 降级对调用方不可见（不抛错、不改返回结构）。
   */
  /**
   * 查询扩展检索：把长问句拆成 2–4 条子查询，各跑一次 BM25，候选取并集后按秩合并。
   *
   * 为什么不是「把子查询的分数相加」：各子查询的 BM25 量纲不同（短查询 idf 更高），
   * 直接相加等于让最短的子查询说了算。这里用「名次倒数 × 权重」做合并分，原 query 权重 1.0、
   * 子查询 0.7——同一段被多条子查询命中会自然累加，这就是「多角度命中」的加分。
   *
   * 合并后的 scored 交给同一个 fillFromScored（章级聚合 + 2000 字预算 + limit 16），
   * 所以召回路径的装填语义没有被改写，只是候选来源多了一路。
   *
   * 降级可观测：返回值里的 `expansion` 一定带 expanded / degraded / queries / ms，
   * 不允许出现「不知道扩展跑没跑」的状态（t25 的静默降级就是这么埋掉整轮实验的）。
   */
  async searchExpanded(query, opts = {}) {
    const o = { ...this.opts, ...opts };
    const nowMs = normNum(opts.now ?? Date.now(), Date.now());
    const t0 = process.hrtime.bigint();
    const expandFn = opts.expandFn ?? defaultExpand;
    let qe = { queries: [String(query)], expanded: false, degraded: 'empty', ms: 0 };

    try {
      const r = await expandFn(query, {
        timeoutMs: o.expandTimeoutMs,
        cacheTtlMs: o.expandCacheTtlMs,
        maxQueries: o.expandMaxQueries,
        fetchImpl: opts.expandFetch,
        cache: opts.expandCache,
      });
      if (r && Array.isArray(r.queries) && r.queries.length) qe = r;
    } catch {
      qe = { queries: [String(query)], expanded: false, degraded: 'http', ms: 0 };
    }

    if (!qe.expanded || qe.queries.length < 2) {
      const single = this.search(query, o);
      return { ...single, expansion: { expanded: false, degraded: qe.degraded, queries: qe.queries, ms: qe.ms } };
    }

    // ── 原 query 的结果是底，子查询只做补尾 ─────────────────────────────────
    // 第一版按「名次倒数 × 权重」把四路合并后统一排序，实测综合题 0.583 → 0.500：
    // S03 从 1.00 掉到 0.50、S09 从 1.00 掉到 0.00 —— 子查询各有自己的第 1 名，
    // 三条子查询的 0.7 一累加就压过了原 query 的 1.0，把原本正确的段挤出预算。
    // 结论：扩展不能改写原 query 的排序，只能占用它没花掉的预算。
    const baseRes = this.search(query, o);
    const baseIds = new Set(baseRes.hits.map((h) => h.id));
    let chars = baseRes.chars;
    const extra = [];
    const idxById2 = new Map(this.docs.map((d, i) => [d.id, i]));
    const merged2 = new Map();
    qe.queries.slice(1).forEach((sub, qi) => {
      const r = this.search(sub, { ...o, maxChars: Number.MAX_SAFE_INTEGER, limit: 1e6 });
      r.hits.forEach((h, rank) => {
        if (baseIds.has(h.id)) return;
        const add = 1 / (1 + rank + qi * 2);
        merged2.set(h.id, (merged2.get(h.id) ?? 0) + add);
      });
    });
    const rankedExtra = [...merged2.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    for (const id of rankedExtra) {
      if (baseRes.hits.length + extra.length >= o.limit) break;
      const di = idxById2.get(id);
      if (di === undefined) continue;
      const doc = this.docs[di];
      if (chars + doc.text.length > o.maxChars) continue;
      extra.push({
        id: doc.id, chapter: doc.chapter, para: doc.para, text: doc.text,
        chars: doc.text.length, truncated: false, score: merged2.get(id),
        bm25: 0, rrf: null, weight: 1, decay: 1, ageDays: 0, tier: 'warm',
      });
      chars += doc.text.length;
    }
    const hits = [...baseRes.hits, ...extra];
    return {
      hits,
      text: hits.map((h) => h.text).join('\n\n'),
      chars,
      scan: { ...baseRes.scan, expansion: { queries: qe.queries.length, added: extra.length } },
      elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
      expansion: { expanded: true, degraded: null, queries: qe.queries, ms: qe.ms, added: extra.length },
    };
  }

  async searchAsync(query, opts = {}) {
    const o = { ...this.opts, ...opts };
    const nowMs = normNum(opts.now ?? Date.now(), Date.now());
    const t0 = process.hrtime.bigint();
    const { acc, scan } = this.scoreTerms(query, o);
    const scored = this.#buildScored(acc, nowMs, o);

    let fused = scored;
    const vecInfo = { used: false, vecCandidates: 0, rrfK: o.rrfK ?? 60 };
    if (this.#vectors && this.#vectors.size) {
      try {
        const embedFn = opts.embed ?? defaultEmbed;
        // defaultEmbed 是 vector.mjs 的批量接口 embed(texts[], opts) —— 直接传字符串
        // 会在内部 `texts.map` 上抛 TypeError，被下面的 catch 吞掉，于是**每次都静默降级回
        // 纯 BM25**（t25 判定实验发现：vector.used 恒为 false，融合从未真正跑过）。
        // 这里统一按批量接口调用再取第一条，同时兼容注入的「单条」实现（返回向量本身）。
        const rawVec = await embedFn([query], { dims: o.dims, cacheDir: o.cacheDir });
        const qv = Array.isArray(rawVec) ? (rawVec[0] ?? null) : rawVec;
        if (qv) {
          // 向量臂取 top-vecTopN：全库排序太噪，40 是实测里「能补到 BM25 漏掉的目标段、
          // 又不会把噪声段塞满融合池」的位置。
          const vecRanked = [...this.#vectors.entries()]
            .map(([id, v]) => ({ id, cos: cosineInt8(qv, v) }))
            .sort((a, b) => b.cos - a.cos)
            .slice(0, o.vecTopN ?? 40)
            .map((x) => x.id);
          // BM25 臂用 search() 的实际返回序（含章级聚合后的装填序），不是全部 scored：
          // 直接拿 scored 会把几百个低分段也塞进臂 1，把向量的高名次信号稀释掉。
          const bm25Arm = this.search(query, { ...o, maxChars: Number.MAX_SAFE_INTEGER }).hits.map((h) => h.id);
          const rrf = rrfFuse(bm25Arm, vecRanked, o.rrfK ?? 60);
          const byId = new Map(scored.map((x) => [x.doc.id, x]));
          const idxById = new Map(this.docs.map((d, i) => [d.id, i]));
          // 两臂并集：向量臂可能召回 BM25 完全没有候选的段（这是加向量的全部意义），
          // 这些段要在这里补出 doc 条目，而不是被 byId 过滤掉。
          fused = [...rrf.entries()]
            .map(([id, r]) => {
              const exist = byId.get(id);
              if (exist) return { ...exist, rrf: r, score: r };
              const di = idxById.get(id);
              if (di === undefined) return null;
              const d = this.docs[di];
              const mix = finalScore(0, d, nowMs, o);
              return { idx: di, doc: d, ...mix, bm25: 0, rrf: r, score: r };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
          vecInfo.used = true;
          vecInfo.vecCandidates = vecRanked.length;
        }
      } catch {
        fused = scored; // 静默降级：任何异常都回到纯 BM25 顺序
      }
    }

    if (!fused.length) {
      return {
        hits: [],
        text: '',
        chars: 0,
        scan: { ...scan, chaptersConsidered: 0, candidates: 0, vector: vecInfo },
        elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
      };
    }

    // ── LLM 在环选段（t27，MEMJUDGE_LLMSELECT=1）────────────────────────
    // 把 top-N 候选段的原文摊给 chat 模型，让它判「哪几段能回答这个问题」。
    // 与 reranker 的区别：reranker 打浅层相关度，这里做的是推理（「多绕了 = 航程增加」）。
    // 只重排、不丢段：选中段置顶，其余按原序补尾；降级时 selection.degraded 有值。
    let selection = { picks: [], degraded: 'empty', ms: 0, tokensIn: 0, tokensOut: 0, pool: 0 };
    if (o.llmSelect) {
      // 给 LLM 看的池子必须是**章级聚合后的代表段**，不是全局最高分的前 16 段：
      // 全局 top16 往往整段落在同一两个高章分章里（ch19/ch15），跨章的证据段根本不在里面，
      // 于是模型只能说「一段都答不了」（实测 12 题 picks 全 0）。改看装填结果后覆盖面才对。
      const poolRes = this.search(query, { ...o, maxChars: Number.MAX_SAFE_INTEGER, limit: o.selectPool ?? 16 });
      const pool = poolRes.hits.map((h) => ({ doc: { id: h.id, text: h.text } }));
      try {
        const sel = await (o.selectFn ?? defaultSelect)(query, pool.map((s) => s.doc.text), {
          maxPicks: o.selectMaxPicks,
          snippetChars: o.selectSnippetChars,
          poolSize: o.selectPool,
          timeoutMs: o.selectTimeoutMs,
          cacheTtlMs: o.selectCacheTtlMs,
          fetchImpl: o.selectFetch,
          cache: o.selectCache,
        });
        if (sel && Array.isArray(sel.picks)) {
          selection = sel;
          if (sel.picks.length) {
            const ids = sel.picks.map((i) => pool[i]?.doc.id).filter(Boolean);
            o.priorityIds = new Set(ids);
          }
        }
      } catch {
        selection = { picks: [], degraded: 'http', ms: 0, tokensIn: 0, tokensOut: 0, pool: pool.length };
      }
    }

    const { out, chars, chapterRank } = fillFromScored(fused, o);
    const hits = out.map((s) => ({
      id: s.doc.id,
      chapter: s.doc.chapter,
      para: s.doc.para,
      text: s.doc.text,
      chars: s.doc.text.length,
      truncated: Boolean(s.truncated),
      score: s.score,
      bm25: s.bm25,
      rrf: s.rrf,
      weight: s.weight,
      decay: s.decay,
      ageDays: s.ageDays,
      tier: s.tier,
    }));
    return {
      hits,
      text: hits.map((h) => h.text).join('\n\n'),
      chars,
      scan: {
        ...scan,
        chaptersConsidered: chapterRank.length,
        candidates: fused.length,
        chaptersPicked: chapterRank.map((c) => c.chapter),
        vector: vecInfo,
        selection: { picks: selection.picks.length, degraded: selection.degraded, pool: selection.pool },
      },
      elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
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
export default { SEARCH_DEFAULTS, tokenize, terms, index, search, score, finalScore, SearchIndex, jiebaActive, rrfFuse };
