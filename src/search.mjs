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
import { createHash } from 'node:crypto';
import { rankWeight, decayFactor, DECAY } from './schema.mjs';
import { embed as defaultEmbed, cosineInt8 } from './vector.mjs';
import { expand as defaultExpand, expandForHybrid } from './query-expand.mjs';
import { select as defaultSelect, selectFromFused } from './llm-select.mjs';
import { rerank as defaultRerank, applyRerank, rerankCandidates, rerankOptIn } from './rerank.mjs';
import { extractSlots, cleanSlotEntity, cleanSlotAttr, normalizeValueAndUnit } from './slots.mjs';
import { tokenize as codeTokenize } from './tokenizer.mjs';
import {
  GLOBAL_SPACE_ID,
  GLOBAL_SPACE_WEIGHT,
  CURRENT_SPACE_WEIGHT,
  spaceWeight,
  visibleSpaces,
  visibleSpaceWeights,
} from './scope.mjs';

export const SEARCH_DEFAULTS = Object.freeze({
  k1: 1.5, // BM25 词频饱和参数（与 mem-eval worker 的 buildBM25Index 同值）
  b: 0.75, // 长度归一化强度。1=完全归一，0=不归一；段级语料取 0.75 让长段不吃亏
  singleCharDiscount: 0.35, // 单汉字 token 的分数折扣（只降权，不禁止）
  subwordDiscount: 0.35, // jieba 子词的分数折扣（子词之于复合整词：同一处证据，不重复计满权）
  decayFloor: 0, // 0 = 严格按衰减公式（能力 12 要求 30 天 ≤0.25）；>0 会放宽旧条目
  halfLifeDays: null, // null = 用 schema 双档（warm 120 / cold 12）；数值 = 统一覆盖（RestRegular 风格）
  topChapters: 3, // 章级聚合取前几章。旧实测 1→0.946、2→0.989（bigram 时代）；jieba 接入后词级候选更稀疏，取 2 会让「一章只有一段强命中」的章整体落选（R10 的正确段在第 3 章），取 3 同时保住召回 91/92 与能力 4 的 0.583
  chapterAgg: 3, // 章分 = 章内 top-N 段分之和
  maxChars: 2000, // 单次返回字符预算（能力 8 阈值）
  limit: 16, // 单次返回段数上限（防极短段填满预算）
  rrfK: 60, // RRF 平滑因子 k=60
  dedupeSlotKey: true, // 按 slot_key 去重与多样性装填
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
        // memjudge 带 tf 权重，必须把复合词与其子词的重复计分压下去，
        // 但同一批子词对短词组问法是唯一的召回桥梁，不能删。
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
  // 协同 src/tokenizer.mjs：对包含代码复合标识符（camelCase/snake_case/kebab-case/路径/semver/hex/URL）
  // 的文本补充结构化 token 与拆分后的子词，既不扰动纯自然语言语料的词长分布，又让代码符号精准命中。
  if (/[/_\\.:]|(?:[a-z][A-Z])|(?:[A-Z]{2,}[a-z])|0x[0-9a-fA-F]{2,}|[a-zA-Z0-9]+-[a-zA-Z0-9]+/.test(s)) {
    const existing = new Set(tokens);
    const extraCodeTokens = codeTokenize(s, { mode: 'index', useJieba: false });
    for (const ct of extraCodeTokens) {
      if (!ct || ct.length < 2 || existing.has(ct)) continue;
      // 跳过纯 CJK 二元组（已由上方 jieba/bigram 处理）
      if (HAN.test(ct) && !/[a-zA-Z0-9_./:-]/.test(ct)) continue;
      existing.add(ct);
      tokens.push(ct);
    }
  }
  const strong = tokens.filter((t) => t.length >= 2);
  // 子词归并表：子词 → 包含它的整词。cutForSearch 会把三字复合词同时吐成二字子词与三字整词，
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
 * 通用余弦相似度：Int8Array 走高速定点 cosineInt8，Float32Array / Array 走浮点余弦。
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  if (a instanceof Int8Array && b instanceof Int8Array) return cosineInt8(a, b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const va = Number(a[i]) || 0;
    const vb = Number(b[i]) || 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * 构建前置作用域过滤器与空间权重表（支持 workspace:<id> + global 硬过滤与加权）。
 * 未传入任何空间参数时 enabled=false，保持全量零开销兼容。
 */
export function buildScopeGuard(opts = {}) {
  const explicitSpaces = opts.spaces;
  const rawSpaceId = opts.spaceId ?? opts.space_id ?? opts.space ?? null;
  const customWeights = opts.spaceWeights && typeof opts.spaceWeights === 'object' ? opts.spaceWeights : null;

  if (!explicitSpaces && !rawSpaceId && !customWeights) {
    return {
      enabled: false,
      primarySpace: GLOBAL_SPACE_ID,
      spaces: null,
      weights: new Map(),
      allow: () => true,
      weight: () => 1,
    };
  }

  const weights = new Map();
  const spaces = [];
  const addSpace = (id, w) => {
    const normId = String(id || GLOBAL_SPACE_ID).trim() || GLOBAL_SPACE_ID;
    if (!weights.has(normId)) spaces.push(normId);
    weights.set(normId, Number.isFinite(w) && w > 0 ? Number(w) : 1);
  };

  if (Array.isArray(explicitSpaces) && explicitSpaces.length > 0) {
    const primary = typeof rawSpaceId === 'string' && rawSpaceId.trim()
      ? rawSpaceId.trim()
      : (typeof explicitSpaces[0] === 'string' ? explicitSpaces[0] : explicitSpaces[0]?.spaceId ?? GLOBAL_SPACE_ID);
    for (const item of explicitSpaces) {
      if (typeof item === 'string') {
        addSpace(item, spaceWeight(item, primary));
      } else if (item && typeof item === 'object' && item.spaceId) {
        addSpace(item.spaceId, item.weight ?? spaceWeight(item.spaceId, primary));
      }
    }
  } else if (explicitSpaces && typeof explicitSpaces === 'object' && !(explicitSpaces instanceof Set)) {
    for (const [sp, w] of Object.entries(explicitSpaces)) addSpace(sp, Number(w));
  } else if (explicitSpaces instanceof Set) {
    const arr = [...explicitSpaces];
    const primary = rawSpaceId ?? arr[0] ?? GLOBAL_SPACE_ID;
    for (const sp of arr) addSpace(sp, spaceWeight(sp, primary));
  } else if (rawSpaceId) {
    const strict = Boolean(opts.strictSpace || opts.includeGlobal === false);
    if (strict) {
      const sp = String(rawSpaceId).trim();
      addSpace(sp, 1.0);
    } else {
      const sp = String(rawSpaceId).trim();
      if (/^workspace:/i.test(sp) || /^session:/i.test(sp)) {
        for (const entry of visibleSpaceWeights(sp, opts)) {
          addSpace(entry.spaceId, entry.weight);
        }
      } else {
        // 自定义或字面 space_id（如 project-x、global 等），直接作为主空间纳入，并附加 global
        addSpace(sp, 1.0);
        addSpace(GLOBAL_SPACE_ID, GLOBAL_SPACE_WEIGHT);
      }
    }
  }

  if (customWeights) {
    for (const [sp, w] of Object.entries(customWeights)) {
      if (weights.has(sp) || (!explicitSpaces && !rawSpaceId)) {
        addSpace(sp, Number(w));
      }
    }
  }

  const primarySpace = spaces[0] ?? GLOBAL_SPACE_ID;
  const allowedSet = new Set(spaces);
  return {
    enabled: allowedSet.size > 0,
    primarySpace,
    spaces,
    weights,
    allow: (docSpaceId) => allowedSet.has(String(docSpaceId || GLOBAL_SPACE_ID)),
    weight: (docSpaceId) => weights.get(String(docSpaceId || GLOBAL_SPACE_ID)) ?? spaceWeight(docSpaceId, primarySpace),
  };
}

/**
 * 多路 RRF 倒数排名融合：score(doc) = sum_{route}(1 / (k + rank_{route}))，其中 rank_{route} 为 1-based。
 * 同时兼容历史二路签名 `rrfFuse(bm25Ranked, vecRanked, k = 60)`、
 * 三路及多路可变参数 `rrfFuse(bm25Ranked, vecRanked, slotRanked, 60)`、
 * 以及路由数组形式 `rrfFuse([routeA, routeB, routeC], 60)`。
 */
export function rrfFuse(...args) {
  let k = 60;
  let rawRoutes = args;
  if (rawRoutes.length >= 2 && typeof rawRoutes[rawRoutes.length - 1] === 'number' && Number.isFinite(rawRoutes[rawRoutes.length - 1])) {
    k = rawRoutes[rawRoutes.length - 1];
    rawRoutes = rawRoutes.slice(0, -1);
  }
  // 支持 rrfFuse([routeA, routeB, routeC], k) 单数组嵌套调用
  if (
    rawRoutes.length === 1 &&
    Array.isArray(rawRoutes[0]) &&
    (rawRoutes[0].length === 0 || Array.isArray(rawRoutes[0][0]) || (rawRoutes[0][0] && typeof rawRoutes[0][0] === 'object' && Array.isArray(rawRoutes[0][0].ids)))
  ) {
    rawRoutes = rawRoutes[0];
  }

  const m = new Map();
  for (const route of rawRoutes) {
    if (!route) continue;
    const ids = Array.isArray(route) ? route : Array.isArray(route.ids) ? route.ids : [];
    const routeWeight = typeof route === 'object' && !Array.isArray(route) && Number.isFinite(route.weight) ? route.weight : 1;
    const seenInRoute = new Set();
    let rank = 0;
    for (const rawId of ids) {
      if (rawId === null || rawId === undefined) continue;
      const id = String(rawId);
      if (seenInRoute.has(id)) continue;
      seenInRoute.add(id);
      rank += 1;
      m.set(id, (m.get(id) ?? 0) + routeWeight / (k + rank));
    }
  }
  return m;
}

const GENERIC_SLOT_ATTRS = new Set([
  '状态', '时间', '数值', '结果', '情况', '配置', '版本', '端口', '地址', '数量', '大小', '名称', '类型', '参数', '值',
  'status', 'state', 'time', 'value', 'version', 'port', 'host', 'url', 'name', 'type', 'count', 'size',
]);

const SLOT_STRONG_SUB_CACHE = new Map();

/**
 * 路 C：entity_slots 槽位图匹配（对接 slots.mjs 与 store.listEntitySlots / store.querySlots / 内存槽位表）。
 * 按 (entity, attr, value) 结构化图边匹配度排序返回文档 ID 列表及详细命中记录。
 */
export function matchEntitySlots(queries, opts = {}) {
  const qList = (Array.isArray(queries) ? queries : [queries])
    .map((q) => String(q ?? '').trim())
    .filter(Boolean);
  if (!qList.length) return { rankedIds: [], hits: [] };

  const scopeGuard = opts.scopeGuard ?? buildScopeGuard(opts);
  const topN = Number.isInteger(opts.topN) && opts.topN > 0 ? opts.topN : 40;
  const store = opts.store ?? null;
  const memSlots = Array.isArray(opts.slots) ? opts.slots : [];

  // 1. 提取查询中的槽位线索：结构化槽位 + 词元集合 + 归一化数值集合
  const parsedSlots = [];
  const qNormStrings = [];
  const strongTokens = new Set();
  const normValues = new Set();

  for (const q of qList) {
    const qLower = q.normalize('NFKC').toLowerCase();
    qNormStrings.push(qLower);
    for (const s of extractSlots(q)) parsedSlots.push(s);
    for (const t of tokenize(q).strong) strongTokens.add(t.toLowerCase());
    for (const ct of codeTokenize(q, { mode: 'query', useJieba: false })) {
      if (ct && ct.length >= 2) strongTokens.add(ct.toLowerCase());
    }
    const nv = normalizeValueAndUnit(q);
    if (nv && nv.unit) normValues.add(`${nv.value}${nv.unit}`.toLowerCase());
  }

  // 2. 拉取作用域内的候选 entity_slots（优先走 store SQL 索引查询，兼容 listEntitySlots 与 querySlots）
  let candidateSlots = [];
  const querySlotsFn = store
    ? (typeof store.listEntitySlots === 'function'
      ? store.listEntitySlots.bind(store)
      : typeof store.querySlots === 'function'
        ? store.querySlots.bind(store)
        : null)
    : null;

  if (querySlotsFn) {
    const seenSlotIds = new Set();
    const pushRows = (rows) => {
      if (!Array.isArray(rows)) return;
      for (const r of rows) {
        const key = r.slotId ?? `${r.memoryId}:${r.entity}:${r.attr}:${r.value}`;
        if (seenSlotIds.has(key)) continue;
        seenSlotIds.add(key);
        candidateSlots.push(r);
      }
    };
    const baseFilter = {
      ...(scopeGuard.enabled && scopeGuard.spaces ? { spaces: scopeGuard.spaces } : {}),
      activeOnly: opts.includeInactive ? false : true,
    };
    // 对解析出的明确实体先走索引精确点查
    for (const ps of parsedSlots) {
      const ent = cleanSlotEntity(ps.entity);
      if (ent) {
        pushRows(querySlotsFn({ ...baseFilter, entity: ent, limit: 64 }));
      }
    }
    // 补充当前可见作用域的活跃槽位图边（SQLite 索引扫描）
    pushRows(querySlotsFn({ ...baseFilter, limit: opts.slotScanLimit ?? 600 }));
  }

  if (memSlots.length) {
    for (const s of memSlots) {
      const sp = s.spaceId ?? s.space_id ?? GLOBAL_SPACE_ID;
      if (scopeGuard.enabled && !scopeGuard.allow(sp)) continue;
      if (!opts.includeInactive && s.status && s.status !== 'active') continue;
      candidateSlots.push(s);
    }
  }

  if (!candidateSlots.length) return { rankedIds: [], hits: [] };

  // 3. 评估每条槽位边 (entity --attr--> value) 与查询的图匹配得分
  const bestByMem = new Map();
  const queryTermMemo = new Map();
  const matchTerm = (target) => {
    if (!target) return false;
    const tl = String(target).normalize('NFKC').toLowerCase().trim();
    if (!tl) return false;
    const cached = queryTermMemo.get(tl);
    if (cached !== undefined) return cached;

    let hit = false;
    if (qNormStrings.some((qs) => qs.includes(tl)) || strongTokens.has(tl)) {
      hit = true;
    } else {
      // 支持复合实体/属性的子词强匹配（长度≥2 且至少命中核心词），复用模块级分词缓存
      let sub = SLOT_STRONG_SUB_CACHE.get(tl);
      if (sub === undefined) {
        sub = tokenize(tl).strong;
        if (SLOT_STRONG_SUB_CACHE.size >= 4096) SLOT_STRONG_SUB_CACHE.clear();
        SLOT_STRONG_SUB_CACHE.set(tl, sub);
      }
      if (sub.length >= 2) {
        let matched = 0;
        for (const st of sub) {
          if (strongTokens.has(st) || qNormStrings.some((qs) => qs.includes(st))) matched += 1;
        }
        if (matched >= Math.ceil(sub.length * 0.67)) hit = true;
      }
    }
    queryTermMemo.set(tl, hit);
    return hit;
  };

  for (const slot of candidateSlots) {
    const memId = String(slot.memoryId ?? slot.memory_id ?? slot.id ?? '');
    if (!memId) continue;
    const sp = String(slot.spaceId ?? slot.space_id ?? GLOBAL_SPACE_ID);
    if (scopeGuard.enabled && !scopeGuard.allow(sp)) continue;

    const ent = cleanSlotEntity(slot.entity ?? '');
    const attr = cleanSlotAttr(slot.attr ?? '');
    const val = String(slot.value ?? '').trim();
    const unit = String(slot.unit ?? '').trim();

    const entHit = ent ? matchTerm(ent) : false;
    const attrHit = attr ? matchTerm(attr) : false;
    const fullVal = unit && !val.endsWith(unit) ? `${val}${unit}` : val;
    const valHit = fullVal.length >= 2
      ? (matchTerm(fullVal) || normValues.has(fullVal.toLowerCase()))
      : false;

    // 过滤泛化属性单边误命中：仅有泛化属性词但无实体且无特定值时不入路 C
    if (!entHit && !(attrHit && valHit) && !(attrHit && attr.length >= 3 && !GENERIC_SLOT_ATTRS.has(attr.toLowerCase()))) {
      continue;
    }

    let rawScore = 0;
    if (entHit) rawScore += 3.0;
    if (attrHit) rawScore += 2.5;
    if (valHit) rawScore += 2.0;
    if (entHit && attrHit) rawScore += 4.0; // (Entity, Attr) 图边精确锁定加成
    if (entHit && attrHit && valHit) rawScore += 2.0;

    // 若查询解析出了同槽位结构，额外加权
    for (const ps of parsedSlots) {
      if (ps.entity && ent && ps.entity.toLowerCase() === ent.toLowerCase()) rawScore += 1.5;
      if (ps.attr && attr && ps.attr.toLowerCase() === attr.toLowerCase()) rawScore += 1.5;
    }

    if (rawScore <= 0) continue;
    const conf = Number.isFinite(slot.confidence) ? Math.max(0.1, Number(slot.confidence)) : 1.0;
    const finalSlotScore = rawScore * conf * scopeGuard.weight(sp);

    const prev = bestByMem.get(memId);
    if (!prev || finalSlotScore > prev.score) {
      bestByMem.set(memId, {
        memoryId: memId,
        spaceId: sp,
        entity: ent,
        attr,
        value: val,
        unit,
        score: finalSlotScore,
        entHit,
        attrHit,
        valHit,
      });
    }
  }

  const hits = [...bestByMem.values()]
    .sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId))
    .slice(0, topN);

  return {
    rankedIds: hits.map((h) => h.memoryId),
    hits,
  };
}

/**
 * 章级聚合 + 预算装填。search() 与 searchAsync() 共用这一份：
 * 两条路径各写一遍装填迟早会漂移，而 0.989 是压在这套装填上的硬底线。
 */
function normalizedTextMap(text) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let compatibility = '';
  const starts = [], ends = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const part = segment.normalize('NFKC');
    compatibility += part;
    for (let i = 0; i < part.toLowerCase().length; i++) {
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  // Lowercase the whole normalized text so contextual mappings (final sigma) apply.
  if (compatibility !== text.normalize('NFKC')) return null;
  const normalized = compatibility.toLowerCase();
  if (normalized.length !== starts.length) return null;
  return { normalized, starts, ends };
}

function evidenceWindow(text, query, budget, requireMatch = false) {
  let start = 0, found = false;
  if (budget > 0 && text.length > budget) {
    const candidates = [String(query ?? ''), ...tokenize(query).strong].filter(Boolean).sort((a, b) => b.length - a.length);
    let mapping;
    for (const candidate of candidates) {
      const needle = candidate.normalize('NFKC').toLowerCase();
      if (!needle) continue;
      if (mapping === undefined) mapping = normalizedTextMap(text);
      if (!mapping) break;
      const index = mapping.normalized.indexOf(needle);
      const match = index < 0 ? null : { start: mapping.starts[index], end: mapping.ends[index + needle.length - 1] };
      if (match && match.end - match.start <= budget) {
        start = Math.max(0, Math.min(match.start - Math.floor((budget - (match.end - match.start)) / 2), text.length - budget));
        found = true;
        break;
      }
    }
  }
  if (requireMatch && !found) return null;
  if (start > 0 && text.charCodeAt(start) >= 0xDC00 && text.charCodeAt(start) <= 0xDFFF &&
      text.charCodeAt(start - 1) >= 0xD800 && text.charCodeAt(start - 1) <= 0xDBFF) start++;
  let end = Math.min(text.length, start + budget);
  const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
  if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end--;
  return { text: text.slice(start, end), start, end, startsAtBoundary: start === 0 || /[。！？!?;；\n.]/u.test(text[start - 1]) };
}

function fillFromScored(scored, o, query) {
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
  const ordered = [];
  let chars = 0;
  const dedupeSlot = o.dedupeSlotKey !== false;
  const maxPerSlotKey = Number.isInteger(o.maxPerSlotKey) && o.maxPerSlotKey > 0 ? o.maxPerSlotKey : 1;
  const maxPerEntity = Number.isInteger(o.maxPerEntity) && o.maxPerEntity > 0 ? o.maxPerEntity : Infinity;
  const slotCounts = new Map();
  const entityCounts = new Map();
  const deferredForDiversity = [];

  const getSlotGroupKey = (doc) => {
    const sk = doc?.slotKey ?? doc?.slot_key ?? null;
    if (!sk) return null;
    return o.dedupeSlotAcrossSpaces === false
      ? `${doc.spaceId ?? GLOBAL_SPACE_ID}::${sk}`
      : String(sk);
  };
  const getEntityPrefix = (doc) => {
    const sk = doc?.slotKey ?? doc?.slot_key ?? null;
    if (!sk) return null;
    const sep = String(sk).indexOf('::');
    return sep > 0 ? String(sk).slice(0, sep) : null;
  };

  const tryAccept = (s, ignoreEntityCap = false) => {
    if (picked.has(s.idx) || out.length >= o.limit) return false;
    if (chars + s.doc.text.length > o.maxChars) return false;
    if (dedupeSlot) {
      const sk = getSlotGroupKey(s.doc);
      if (sk) {
        const used = slotCounts.get(sk) ?? 0;
        if (used >= maxPerSlotKey) return false;
      }
    }
    const entPrefix = getEntityPrefix(s.doc);
    if (!ignoreEntityCap && entPrefix && maxPerEntity < Infinity) {
      const entUsed = entityCounts.get(entPrefix) ?? 0;
      if (entUsed >= maxPerEntity) {
        deferredForDiversity.push(s);
        return false;
      }
    }
    if (dedupeSlot) {
      const sk = getSlotGroupKey(s.doc);
      if (sk) slotCounts.set(sk, (slotCounts.get(sk) ?? 0) + 1);
    }
    if (entPrefix) entityCounts.set(entPrefix, (entityCounts.get(entPrefix) ?? 0) + 1);
    picked.add(s.idx);
    out.push(s);
    chars += s.doc.text.length;
    return true;
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
    for (const s of list) { ordered.push(s); tryAccept(s, false); }
  }
  // 若开启了实体多样性软上限且预算尚有富余，用延后项补齐剩余空间（仍遵守 slot_key 硬去重）
  for (const s of deferredForDiversity) {
    if (out.length >= o.limit) break;
    tryAccept(s, true);
  }

  if (out.length && out.length < o.limit && o.maxChars - chars >= 16) {
    const budget = o.maxChars - chars;
    for (const s of ordered) {
      if (picked.has(s.idx) || s.doc.text.length <= budget) continue;
      const cut = evidenceWindow(s.doc.text, query, budget, true);
      if (cut === null) continue;
      const at = out.findIndex(existing => ordered.indexOf(existing) > ordered.indexOf(s));
      out.splice(at < 0 ? out.length : at, 0, { ...s, originalText: s.doc.text, doc: { ...s.doc, text: cut.text }, window: cut, truncated: true });
      chars += cut.text.length;
      break;
    }
  }

  // 预算比最短候选段还小时，逐段整取会一个都装不下 —— 那等于「有命中却报零结果」，
  // 下游看到的是 denied=true，比返回一段截断原文更糟。这里退回「最高分段的截断片段」，
  // 并且只在整取结果为空时才触发，不影响正常预算下的装填。
  if (!out.length && scored.length && o.maxChars > 0) {
    const top = scored[0];
    const cut = evidenceWindow(top.doc.text, query, o.maxChars);
    out.push({ ...top, originalText: top.doc.text, doc: { ...top.doc, text: cut.text }, window: cut, truncated: true });
    chars = cut.text.length;
  }
  return { out, chars, chapterRank };
}

class SearchIndex {
  /** @type {Map<string, Int8Array>|null} 文档向量（int8），由 store 注入；缺省为 null = 纯 BM25 */
  #vectors = null;
  /** @type {object|null} 绑定的持久化 SQLiteStore（用于路 B searchVectors 与路 C listEntitySlots/querySlots） */
  #store = null;
  /** @type {Array<object>|null} 显式注入的槽位表 */
  #slots = null;
  /** @type {Array<object>|null} 内存文档懒抽取的槽位缓存 */
  #lazySlots = null;

  /** @param {object} [opts] SEARCH_DEFAULTS 覆盖项 */
  constructor(opts = {}) {
    this.opts = { ...SEARCH_DEFAULTS, ...opts };
    if (opts.store) this.#store = opts.store;
    if (Array.isArray(opts.slots)) this.#slots = opts.slots.slice();
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
    const id = String(mem?.id ?? `doc-${idx}`);
    const spaceId = String(mem?.spaceId ?? mem?.space_id ?? GLOBAL_SPACE_ID);
    const slotKey = mem?.slotKey ?? mem?.slot_key ?? null;
    const doc = {
      id,
      text,
      spaceId,
      slotKey,
      category: mem?.category ?? null,
      status: mem?.status ?? 'active',
      chapter: normNum(mem?.source?.chapter ?? mem?.chapter, 0),
      para: normNum(mem?.source?.para ?? mem?.para, idx + 1),
      kind: mem?.kind ?? 'fact',
      len: tokens.length,
      tf,
      importance: Math.min(1, Math.max(0, normNum(mem?.importance, 0.5))),
      accessCount: Math.max(0, normNum(mem?.accessCount, 0)),
      createdAt: nowMs,
      lastAccessed: normNum(mem?.lastAccessed, nowMs),
      supersededBy: mem?.supersededBy ?? null,
    };
    if (Array.isArray(mem?.slots) && mem.slots.length) {
      if (!this.#slots) this.#slots = [];
      for (const s of mem.slots) {
        this.#slots.push({ ...s, memoryId: s.memoryId ?? id, spaceId: s.spaceId ?? spaceId });
      }
    }
    this.#lazySlots = null;
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

  /** 写入单条文档向量到内存向量表。 */
  setVector(id, vec) {
    if (!id || !vec) return this;
    if (!this.#vectors) this.#vectors = new Map();
    this.#vectors.set(String(id), vec);
    return this;
  }

  /** 清空内存文档向量表。 */
  clearVectors() {
    if (this.#vectors) this.#vectors.clear();
    this.#vectors = null;
    return this;
  }

  /** 绑定持久化 store（供三路 RRF 的向量检索与 entity_slots SQL 索引查询使用）。 */
  setStore(store) {
    this.#store = store ?? null;
    return this;
  }

  /** 显式注入内存 entity_slots 边列表。 */
  setSlots(slots) {
    this.#slots = Array.isArray(slots) ? slots.slice() : null;
    return this;
  }

  /** 向量臂是否就绪（只读诊断用）。 */
  get hasVectors() {
    return Boolean((this.#vectors && this.#vectors.size) || this.#store);
  }

  /** 懒构建内存文档的 entity_slots 图边（仅在无外部 store 时供路 C 使用）。 */
  #getMemorySlots(autoExtract = true) {
    if (this.#slots && this.#slots.length) return this.#slots;
    if (!autoExtract) return [];
    if (this.#lazySlots) return this.#lazySlots;
    const built = [];
    for (const d of this.docs) {
      if (d.status && d.status !== 'active') continue;
      for (const s of extractSlots(d.text)) {
        built.push({
          ...s,
          memoryId: d.id,
          spaceId: d.spaceId,
          status: d.status,
        });
      }
    }
    this.#lazySlots = built;
    return built;
  }

  /** BM25 命中 → 混合分候选，按 score 降序。search 与 searchAsync 共用。 */
  #buildScored(acc, nowMs, o, scopeGuard = null) {
    // 强命中闸门：只命中单汉字的候选一律不进结果
    const scored = [];
    for (const [docIdx, e] of acc) {
      if (e.strongHits === 0 || e.bm25 <= 0) continue;
      const d = this.docs[docIdx];
      const mix = finalScore(e.bm25, d, nowMs, o);
      const wSpace = scopeGuard?.enabled ? scopeGuard.weight(d.spaceId) : 1;
      scored.push({
        idx: docIdx,
        doc: d,
        ...mix,
        score: mix.score * wSpace,
        spaceWeight: wSpace,
      });
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
   * 支持前置 space_id 硬过滤。返回 Map<docIdx, {bm25, strongHits}> 与工作量统计。
   */
  scoreTerms(query, opts = {}) {
    const o = { ...this.opts, ...opts };
    const scopeGuard = opts.scopeGuard ?? buildScopeGuard(o);
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
        if (scopeGuard.enabled && !scopeGuard.allow(d.spaceId)) continue;
        if (!o.includeInactive && d.status && d.status !== 'active') continue;
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
        ...(scopeGuard.enabled ? { spaces: scopeGuard.spaces } : {}),
      },
    };
  }

  /**
   * 同步检索主入口。
   * 两阶段：前置作用域硬过滤 + 段级 BM25 → 章级聚合选章 → 章内按混合分与 slot_key 去重装填预算。
   */
  search(query, opts = {}) {
    const o = { ...this.opts, ...opts };
    const scopeGuard = opts.scopeGuard ?? buildScopeGuard(o);
    const nowMs = normNum(opts.now ?? Date.now(), Date.now());
    const t0 = process.hrtime.bigint();

    const { acc, scan } = this.scoreTerms(query, { ...o, scopeGuard });
    const scored = this.#buildScored(acc, nowMs, o, scopeGuard);

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

    const { out, chars, chapterRank } = fillFromScored(scored, o, query);

    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const hits = out.map((s) => ({
      id: s.doc.id,
      spaceId: s.doc.spaceId,
      slotKey: s.doc.slotKey,
      category: s.doc.category,
      chapter: s.doc.chapter,
      para: s.doc.para,
      text: s.doc.text,
      version: createHash('sha256').update(s.originalText ?? s.doc.text, 'utf16le').digest('hex'),
      chars: s.doc.text.length,
      truncated: Boolean(s.truncated),
      ...(s.window ? { windowStart: s.window.start, windowEnd: s.window.end, startsAtBoundary: s.window.startsAtBoundary } : {}),
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
   * 查询扩展检索（向下兼容接口）：原 query 结果为底，子查询补尾。
   */
  async searchExpanded(query, opts = {}) {
    const o = { ...this.opts, ...opts };
    const t0 = process.hrtime.bigint();
    const qe = await expandForHybrid(query, {
      expandFn: opts.expandFn ?? defaultExpand,
      timeoutMs: o.expandTimeoutMs,
      cacheTtlMs: o.expandCacheTtlMs,
      maxQueries: o.expandMaxQueries,
      fetchImpl: opts.expandFetch,
      cache: opts.expandCache,
      model: o.expandModel,
    });

    if (!qe.expanded || qe.queries.length < 2) {
      const single = this.search(query, o);
      return { ...single, expansion: { expanded: false, degraded: qe.degraded, queries: qe.queries, ms: qe.ms } };
    }

    const scopeGuard = buildScopeGuard(o);
    const baseRes = this.search(query, { ...o, scopeGuard });
    const baseIds = new Set(baseRes.hits.map((h) => h.id));
    let chars = baseRes.chars;
    const extra = [];
    const idxById2 = new Map(this.docs.map((d, i) => [d.id, i]));
    const seenSlots = new Set(baseRes.hits.map((h) => h.slotKey).filter(Boolean));
    const merged2 = new Map();
    qe.queries.slice(1).forEach((sub, qi) => {
      const r = this.search(sub, { ...o, scopeGuard, maxChars: Number.MAX_SAFE_INTEGER, limit: 1e6 });
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
      if (o.dedupeSlotKey !== false && doc.slotKey && seenSlots.has(doc.slotKey)) continue;
      if (chars + doc.text.length > o.maxChars) continue;
      if (doc.slotKey) seenSlots.add(doc.slotKey);
      extra.push({
        id: doc.id, spaceId: doc.spaceId, slotKey: doc.slotKey, category: doc.category,
        chapter: doc.chapter, para: doc.para, text: doc.text,
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

  /**
   * 三路 RRF 混合检索主引擎（彻底解除 expand / vector / slot / rerank / llmSelect 互斥限制）：
   * - 前置 space_id 硬过滤与空间加权（workspace:<id> 1.0 + global 0.85）；
   * - 路 A：BM25（支持协同 query-expand 子查询扩展）；
   * - 路 B：Int8 向量检索（对接 store.searchVectors / store.vectorSearch 或内存 cosineSimilarity）；
   * - 路 C：entity_slots 槽位图匹配（对接 slots.mjs 与 store.listEntitySlots / store.querySlots 或内存槽位图）；
   * - 三路统一倒数排名融合 RRF（k=60）：score(doc) = sum_{route}(1 / (k + rank_{route}))；
   * - 可选在线介入 rerank.mjs（超时/异常优雅回退 RRF）与 llm-select.mjs；
   * - 按 slot_key 去重与多样性装填。
   */
  async searchAsync(query, opts = {}) {
    const o = { ...this.opts, ...opts };
    const scopeGuard = buildScopeGuard(o);
    const store = o.store ?? this.#store ?? null;
    const nowMs = normNum(opts.now ?? Date.now(), Date.now());
    const rrfK = Number.isFinite(o.rrfK) && o.rrfK > 0 ? o.rrfK : 60;
    const t0 = process.hrtime.bigint();

    // ── Step 0: 可选协同查询扩展（不再与 vector / slot / llmSelect 互斥） ─────────
    let expansion = { expanded: false, degraded: 'disabled', queries: [String(query ?? '')], ms: 0 };
    if (o.expand || typeof opts.expandFn === 'function') {
      expansion = await expandForHybrid(query, {
        expandFn: opts.expandFn ?? defaultExpand,
        timeoutMs: o.expandTimeoutMs,
        cacheTtlMs: o.expandCacheTtlMs,
        maxQueries: o.expandMaxQueries,
        fetchImpl: opts.expandFetch,
        cache: o.expandCache,
        model: o.expandModel,
      });
    }
    const queryList = expansion.queries?.length ? expansion.queries : [String(query ?? '')];

    // ── 路 A: BM25（含前置 space_id 过滤 + 扩展子查询补尾） ─────────────────────
    const { acc, scan } = this.scoreTerms(query, { ...o, scopeGuard });
    const scored = this.#buildScored(acc, nowMs, o, scopeGuard);
    const bm25ArmSet = new Set(
      scored.length
        ? fillFromScored(
            scored,
            { ...o, dedupeSlotKey: false, maxChars: Number.MAX_SAFE_INTEGER, limit: o.bm25TopN ?? 60 },
            query,
          ).out.map((s) => s.doc.id)
        : [],
    );
    const extraScoredById = new Map();
    if (expansion.expanded && queryList.length > 1) {
      for (let qi = 1; qi < queryList.length; qi += 1) {
        const subQ = queryList[qi];
        const subAcc = this.scoreTerms(subQ, { ...o, scopeGuard }).acc;
        const subScored = this.#buildScored(subAcc, nowMs, o, scopeGuard);
        for (const s of subScored.slice(0, 24)) {
          if (!bm25ArmSet.has(s.doc.id)) bm25ArmSet.add(s.doc.id);
          if (!extraScoredById.has(s.doc.id)) extraScoredById.set(s.doc.id, { ...s, score: s.score * 0.7 });
        }
      }
    }
    const bm25Arm = [...bm25ArmSet];

    // ── 路 B: Int8 向量检索（对接 store.searchVectors / vectorSearch 或内存向量） ──
    const vecMap = o.vectors instanceof Map ? o.vectors : this.#vectors;
    const vecSearchFn = store
      ? (typeof store.searchVectors === 'function'
        ? store.searchVectors.bind(store)
        : typeof store.vectorSearch === 'function'
          ? store.vectorSearch.bind(store)
          : null)
      : null;
    const vecInfo = { used: false, vecCandidates: 0, rrfK };
    let vecRanked = [];
    const storeDocCache = new Map();

    if (o.vector !== false && (o.queryVector || (vecMap && vecMap.size) || vecSearchFn)) {
      try {
        let qv = o.queryVector ?? null;
        if (!qv && (typeof opts.embed === 'function' || (vecMap && vecMap.size) || o.vector === true)) {
          const embedFn = opts.embed ?? defaultEmbed;
          const rawVec = await embedFn([query], { dims: o.dims, cacheDir: o.cacheDir });
          qv = Array.isArray(rawVec) ? (rawVec[0] ?? null) : rawVec;
        }
        if (qv) {
          const vecTopN = o.vecTopN ?? 40;
          if (vecSearchFn) {
            const rows = vecSearchFn(qv, {
              topK: vecTopN,
              minScore: o.minVecScore ?? -1,
              ...(scopeGuard.enabled && scopeGuard.spaces ? { spaces: scopeGuard.spaces } : {}),
            });
            if (Array.isArray(rows) && rows.length) {
              const weightedRows = rows
                .filter((r) => !scopeGuard.enabled || scopeGuard.allow(r.spaceId ?? r.space_id))
                .map((r) => {
                  const id = String(r.memoryId ?? r.id);
                  const sp = String(r.spaceId ?? r.space_id ?? GLOBAL_SPACE_ID);
                  storeDocCache.set(id, r);
                  return { id, sim: Number(r.score ?? 0) * scopeGuard.weight(sp) };
                })
                .sort((a, b) => b.sim - a.sim)
                .slice(0, vecTopN);
              vecRanked = weightedRows.map((x) => x.id);
            }
          }
          if (!vecRanked.length && vecMap && vecMap.size) {
            const docByIdLocal = new Map(this.docs.map((d) => [d.id, d]));
            vecRanked = [...vecMap.entries()]
              .filter(([id]) => {
                if (!scopeGuard.enabled) return true;
                const d = docByIdLocal.get(String(id));
                return d ? scopeGuard.allow(d.spaceId) : true;
              })
              .map(([id, v]) => {
                const d = docByIdLocal.get(String(id));
                const wSp = d && scopeGuard.enabled ? scopeGuard.weight(d.spaceId) : 1;
                return { id: String(id), cos: cosineSimilarity(qv, v) * wSp };
              })
              .sort((a, b) => b.cos - a.cos)
              .slice(0, vecTopN)
              .map((x) => x.id);
          }
          if (vecRanked.length > 0 || qv) {
            vecInfo.used = vecRanked.length > 0 || Boolean(vecMap && vecMap.size);
            vecInfo.vecCandidates = vecRanked.length;
          }
        }
      } catch {
        vecRanked = [];
      }
    }

    // ── 路 C: entity_slots 槽位图匹配（对接 slots.mjs 与 store SQL 索引/内存槽位） ──
    const slotInfo = { used: false, slotCandidates: 0 };
    let slotRanked = [];
    const enableSlotRoute = o.slotRoute !== false && (
      Boolean(store) ||
      Boolean(Array.isArray(o.slots) && o.slots.length) ||
      Boolean(this.#slots && this.#slots.length) ||
      o.slotRoute === true ||
      this.docs.some((d) => Boolean(d.slotKey))
    );
    if (enableSlotRoute) {
      try {
        const memSlots = Array.isArray(o.slots)
          ? o.slots
          : store
            ? (this.#slots ?? [])
            : this.#getMemorySlots(true);
        const slotMatch = matchEntitySlots(queryList, {
          store,
          slots: memSlots,
          scopeGuard,
          topN: o.slotTopN ?? 40,
          slotScanLimit: o.slotScanLimit,
          includeInactive: o.includeInactive,
        });
        slotRanked = slotMatch.rankedIds;
        slotInfo.used = slotRanked.length > 0;
        slotInfo.slotCandidates = slotRanked.length;
      } catch {
        slotRanked = [];
      }
    }

    // ── 三路统一 RRF 融合（k=60）：score(doc) = sum_{route}(1 / (k + rank_{route})) ──
    const byId = new Map(scored.map((x) => [x.doc.id, x]));
    for (const [id, ex] of extraScoredById) {
      if (!byId.has(id)) byId.set(id, ex);
    }
    const idxById = new Map(this.docs.map((d, i) => [d.id, i]));
    const routeMembership = new Map();
    const markRoute = (ids, routeName) => {
      for (const id of ids) {
        let s = routeMembership.get(id);
        if (!s) { s = []; routeMembership.set(id, s); }
        if (!s.includes(routeName)) s.push(routeName);
      }
    };
    markRoute(bm25Arm, 'bm25');
    markRoute(vecRanked, 'vector');
    markRoute(slotRanked, 'slot');

    let fused = scored;
    if (expansion.expanded && extraScoredById.size > 0 && !vecRanked.length && !slotRanked.length && !o.forceRrf) {
      fused = [...scored, ...[...extraScoredById.values()].filter((x) => !scored.some((s) => s.doc.id === x.doc.id))];
    }

    if (vecRanked.length > 0 || slotRanked.length > 0 || o.forceRrf) {
      const activeRoutes = [bm25Arm, vecRanked, slotRanked].filter((r) => r.length > 0);
      const rrf = rrfFuse(activeRoutes, rrfK);
      let virtualIdx = this.docs.length + 100000;

      const resolveCandidateDoc = (id) => {
        const di = idxById.get(id);
        if (di !== undefined) return { di, doc: this.docs[di] };
        let rawMem = storeDocCache.get(id);
        if (!rawMem && store && typeof store.get === 'function') {
          rawMem = store.get(id);
        }
        if (!rawMem || !rawMem.text) return null;
        const sp = String(rawMem.spaceId ?? rawMem.space_id ?? GLOBAL_SPACE_ID);
        if (scopeGuard.enabled && !scopeGuard.allow(sp)) return null;
        const vIdx = virtualIdx++;
        return {
          di: vIdx,
          doc: {
            id: String(rawMem.id ?? rawMem.memoryId ?? id),
            text: String(rawMem.text),
            spaceId: sp,
            slotKey: rawMem.slotKey ?? rawMem.slot_key ?? null,
            category: rawMem.category ?? null,
            status: rawMem.status ?? 'active',
            chapter: normNum(rawMem?.source?.chapter ?? rawMem?.chapter, 0),
            para: normNum(rawMem?.source?.para ?? rawMem?.para, vIdx),
            kind: rawMem.kind ?? 'fact',
            len: tokenize(rawMem.text).tokens.length,
            importance: Math.min(1, Math.max(0, normNum(rawMem.importance, 0.5))),
            accessCount: Math.max(0, normNum(rawMem.accessCount, 0)),
            createdAt: normNum(rawMem.createdAt, nowMs),
            lastAccessed: normNum(rawMem.lastAccessed, nowMs),
            supersededBy: rawMem.supersededBy ?? null,
          },
        };
      };

      fused = [...rrf.entries()]
        .map(([id, r]) => {
          const exist = byId.get(id);
          const resolved = exist ? { di: exist.idx, doc: exist.doc } : resolveCandidateDoc(id);
          if (!resolved) return null;
          const wSpace = scopeGuard.enabled ? scopeGuard.weight(resolved.doc.spaceId) : 1;
          const weightedRrf = r * wSpace;
          if (exist) {
            return {
              ...exist,
              rrf: r,
              score: weightedRrf,
              spaceWeight: wSpace,
              routes: routeMembership.get(id) ?? ['bm25'],
            };
          }
          const mix = finalScore(0, resolved.doc, nowMs, o);
          return {
            idx: resolved.di,
            doc: resolved.doc,
            ...mix,
            bm25: 0,
            rrf: r,
            score: weightedRrf,
            spaceWeight: wSpace,
            routes: routeMembership.get(id) ?? [],
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || (b.bm25 ?? 0) - (a.bm25 ?? 0) || a.doc.id.localeCompare(b.doc.id));
    } else {
      fused = fused.map((item) => ({
        ...item,
        routes: routeMembership.get(item.doc.id) ?? ['bm25'],
      }));
    }

    if (!fused.length) {
      return {
        hits: [],
        text: '',
        chars: 0,
        scan: { ...scan, chaptersConsidered: 0, candidates: 0, vector: vecInfo, slots: slotInfo },
        expansion,
        elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
      };
    }

    // ── Step 4: 在线可选介入 src/rerank.mjs（超时/异常时优雅降级回退 RRF 结果） ────
    let rerankInfo = { used: false, degraded: 'disabled', ms: 0, candidates: 0 };
    const shouldRerank = Boolean(o.rerank === true || typeof o.rerankFn === 'function' || (o.rerank !== false && rerankOptIn()));
    if (shouldRerank) {
      const rr = await rerankCandidates(query, fused, {
        topN: o.rerankTopN,
        poolSize: o.rerankPoolSize,
        timeoutMs: o.rerankTimeoutMs,
        cacheTtlMs: o.rerankCacheTtlMs,
        model: o.rerankModel,
        fetchImpl: o.rerankFetch,
        cache: o.rerankCache,
        apiKey: o.rerankApiKey,
        rerankFn: o.rerankFn ?? defaultRerank,
      });
      fused = rr.items;
      rerankInfo = { used: rr.used, degraded: rr.degraded, ms: rr.ms, candidates: rr.candidates };
    }

    // ── Step 5: 可选介入 src/llm-select.mjs（直接消费融合候选池，解除互斥限制） ────
    let selection = { picks: [], degraded: 'empty', ms: 0, tokensIn: 0, tokensOut: 0, pool: 0 };
    if (o.llmSelect) {
      const poolOrder = fillFromScored(fused, {
        ...o,
        dedupeSlotKey: false,
        maxChars: Number.MAX_SAFE_INTEGER,
        limit: o.selectPool ?? 16,
      }, query).out;
      const sel = await selectFromFused(query, poolOrder, {
        selectFn: o.selectFn ?? defaultSelect,
        maxPicks: o.selectMaxPicks,
        snippetChars: o.selectSnippetChars,
        poolSize: o.selectPool ?? 16,
        timeoutMs: o.selectTimeoutMs,
        cacheTtlMs: o.selectCacheTtlMs,
        fetchImpl: o.selectFetch,
        cache: o.selectCache,
        model: o.selectModel,
      });
      selection = sel;
      if (sel.priorityIds.size > 0) {
        const mergedPri = new Set(o.priorityIds instanceof Set ? o.priorityIds : []);
        for (const id of sel.priorityIds) mergedPri.add(id);
        o.priorityIds = mergedPri;
      }
    }

    const { out, chars, chapterRank } = fillFromScored(fused, o, query);
    const hits = out.map((s) => ({
      id: s.doc.id,
      spaceId: s.doc.spaceId,
      slotKey: s.doc.slotKey,
      category: s.doc.category,
      chapter: s.doc.chapter,
      para: s.doc.para,
      text: s.doc.text,
      version: createHash('sha256').update(s.originalText ?? s.doc.text, 'utf16le').digest('hex'),
      chars: s.doc.text.length,
      truncated: Boolean(s.truncated),
      ...(s.window ? { windowStart: s.window.start, windowEnd: s.window.end, startsAtBoundary: s.window.startsAtBoundary } : {}),
      score: s.score,
      bm25: s.bm25,
      rrf: s.rrf ?? null,
      rerankScore: s.rerankScore ?? null,
      routes: s.routes ?? ['bm25'],
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
        slots: slotInfo,
        rerank: rerankInfo,
        selection: { picks: selection.picks.length, degraded: selection.degraded, pool: selection.pool },
        ...(expansion.degraded !== 'disabled' ? { expansion: { expanded: expansion.expanded, degraded: expansion.degraded, queries: expansion.queries.length } } : {}),
      },
      expansion,
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

/**
 * 统一三路 RRF 混合检索便捷入口：
 * target 可传 SearchIndex 实例，也可直接传 SQLiteStore 实例（按可见 space_id 拉取活跃记忆建索引并融合三路）。
 */
export async function hybridSearch(target, query, opts = {}) {
  if (target instanceof SearchIndex) {
    return target.searchAsync(query, opts);
  }
  if (target && typeof target === 'object' && typeof target.list === 'function') {
    const scopeGuard = buildScopeGuard(opts);
    const mems = target.list({
      ...(scopeGuard.enabled && scopeGuard.spaces ? { spaces: scopeGuard.spaces } : {}),
      status: 'active',
      includeText: true,
    });
    const idx = new SearchIndex({ ...opts, store: target }).addAll(mems);
    return idx.searchAsync(query, { ...opts, store: target });
  }
  throw new TypeError('hybridSearch: target 必须是 SearchIndex 或 SQLiteStore 实例');
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
export default {
  SEARCH_DEFAULTS,
  tokenize,
  terms,
  index,
  search,
  hybridSearch,
  score,
  finalScore,
  SearchIndex,
  jiebaActive,
  rrfFuse,
  cosineSimilarity,
  buildScopeGuard,
  matchEntitySlots,
};
