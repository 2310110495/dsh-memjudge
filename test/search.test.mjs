// memjudge 检索层自检 —— 92 题 recall + 全维度断言（t11 验证命令）
// 运行：node memjudge-plugin/test/search.test.mjs
//
// 语料只读引用 mem-eval/corpus（P3 只读），本文件不写任何东西。

import { chapters } from '../../mem-eval/corpus/novel.mjs';
import { recall } from '../../mem-eval/corpus/quiz.mjs';
import { rankWeight, decayFactor, MEMORY_SCHEMA_VERSION } from '../src/schema.mjs';
import { tokenize, index, search, score, finalScore, SEARCH_DEFAULTS } from '../src/search.mjs';

const DAY = 86400000;
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${detail}`);
}

// ── 载入语料：一个 \n\n 段 = 一条记忆（片段级，绝不把整章当一条候选）──────────
const SEG = /\n\s*\n/;
const segs = [];
for (const c of chapters) {
  c.text.split(SEG).filter((p) => p.trim()).forEach((p, i) => {
    segs.push({ ch: c.n, para: i + 1, text: p });
  });
}

const NOW = Date.parse('2026-10-27T17:00:00+08:00');

// 冻结时钟：本文件所有断言都按 NOW 算衰减。只要有一条路径漏传 now（或将来有人
// 加了一条用 Date.now() 的断言），ageDays 就会随墙钟漂移，排序在临界点上翻转，
// 同一命令能跑出 0.946 / 0.978 / 0.989 三个数。冻结在这一行，漏传即锚定。
Date.now = () => NOW;

/** 把段装成 schema 兼容的记忆对象（importance/accessCount 中性，衰减因子为常数）。 */
function makeMems({ writtenSpreadDays = 0, lastAccessAgeDays = 0, lastAccessFromCreated = false } = {}) {
  return segs.map((s) => {
    const created = NOW - Math.max(0, writtenSpreadDays - (s.ch - 1) * (writtenSpreadDays / 19)) * DAY;
    return {
      id: `c${String(s.ch).padStart(2, '0')}p${String(s.para).padStart(2, '0')}`,
      text: s.text,
      kind: 'fact',
      source: { chapter: s.ch, para: s.para },
      importance: 0.5,
      accessCount: 0,
      createdAt: created,
      // lastAccessFromCreated = 「写完就再没碰过」：衰减按写入时间全额生效，是压力档
      lastAccessed: lastAccessFromCreated ? created : NOW - lastAccessAgeDays * DAY,
      supersededBy: null,
    };
  });
}

/** 跑 92 题。返回 recall/平均字符/平均耗时/扫描统计。 */
function runRecall(idx, { now = NOW, maxChars = SEARCH_DEFAULTS.maxChars } = {}) {
  let full = 0;
  let half = 0;
  const misses = [];
  let chars = 0;
  let ms = 0;
  let scored = 0;
  let total = 0;
  let ratios = [];
  let maxHitChars = 0;
  const hitChars = [];
  let formulaOk = 0;

  for (const r of recall) {
    const t0 = process.hrtime.bigint();
    const res = idx.search(r.q, { now, maxChars });
    ms += Number(process.hrtime.bigint() - t0) / 1e6;

    const got = res.text;
    chars += res.chars;
    scored += res.scan.docsScored;
    total = res.scan.docsTotal;
    ratios.push(res.scan.scanRatio);

    const h = r.kw.filter((k) => got.includes(k)).length;
    if (h === r.kw.length) full += 1;
    else if (h > 0) { half += 1; misses.push(`${r.id}(half)`); }
    else misses.push(r.id);

    for (const hit of res.hits) {
      hitChars.push(hit.chars);
      if (hit.chars > maxHitChars) maxHitChars = hit.chars;
      if (hit.score === Number((hit.bm25 * hit.weight).toFixed(6))) formulaOk += 1;
    }
  }

  return {
    score: Number(((full + half * 0.5) / recall.length).toFixed(4)),
    full, half, miss: recall.length - full - half, misses,
    avgChars: Math.round(chars / recall.length),
    avgMs: ms / recall.length,
    avgScored: scored / recall.length,
    docsTotal: total,
    avgRatio: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    maxHitChars,
    formulaOk,
  };
}

console.log('== memjudge 检索层自检 ==');
console.log(`schema v${MEMORY_SCHEMA_VERSION} · 语料 ${chapters.length} 章 ${segs.length} 段\n`);

// ── [0] 索引结构 ────────────────────────────────────────────────────────────
const mems = makeMems();
const idx = index(mems);
const st = idx.stats();
console.log(`索引  ${st.docs} 段 / ${st.terms} terms / ${st.postings} postings / avgdl ${st.avgdl} / ${st.chapters} 章`);
check('索引已建成', st.docs === segs.length && st.terms > 1000 && st.postings > st.docs,
  `${st.docs} 段 ${st.terms} terms`);

// ── [1]-[3] 主 recall：同期写入同期访问（"刚灌完就问"，真实主用例）──────────
const A = runRecall(idx);
check('92 题 recall ≥0.989', A.score >= 0.989,
  `${A.score.toFixed(3)}（${A.full} full / ${A.half} half / ${A.miss} miss）${A.misses.join(',')}`);
check('平均返回 ≤2000 字符', A.avgChars <= 2000, `${A.avgChars} 字符/次`);
check('平均查询 ≤500ms', A.avgMs <= 500, `${A.avgMs.toFixed(3)} ms/次`);

// ── [4] 倒排不扫全库：与朴素全扫对照 ─────────────────────────────────────────
// 朴素实现：对每条记忆调用 score()（一次全文档 token 化），工作项 = 段数 × 段长。
let naiveTokens = 0;
const t1 = process.hrtime.bigint();
for (const r of recall) {
  for (const s of segs) {
    const { tokens } = tokenize(s.text);
    naiveTokens += tokens.length;
    score(r.q, s.text, { importance: 0.5, accessCount: 0, lastAccessed: NOW }, { now: NOW });
  }
}
const naiveMs = Number(process.hrtime.bigint() - t1) / 1e6 / recall.length;
check('倒排不扫全库', A.avgRatio < 0.5 && A.avgScored < A.docsTotal,
  `计分 ${A.avgScored.toFixed(0)}/${A.docsTotal} 段 = ${(A.avgRatio * 100).toFixed(1)}%（全扫需 ${naiveMs.toFixed(1)}ms/次 vs 本实现 ${A.avgMs.toFixed(3)}ms）`);
console.log(`      全扫对照累计 tokenize ${naiveTokens} 次 token`);

// ── [5] 衰减挂 lastAccessed，不挂 createdAt ─────────────────────────────────
const SAME_TEXT = '舱壁凹陷深度实测十一厘米，经进坞复测确认，与目测估值不符。';
const nowT = Date.parse('2026-10-27T07:00:00+08:00');
const fresh = { id: 'fresh', text: SAME_TEXT, importance: 0.5, accessCount: 0, createdAt: nowT - 30 * DAY, lastAccessed: nowT - 3600000 };
const stale = { id: 'stale', text: SAME_TEXT, importance: 0.5, accessCount: 0, createdAt: nowT - 30 * DAY, lastAccessed: nowT - 30 * DAY };
const wFresh = rankWeight(fresh, nowT);
const wStale = rankWeight(stale, nowT);
check('衰减挂 lastAccessed', wFresh.weight > wStale.weight * 3,
  `同 createdAt(30 天前)：1 小时前访问 weight=${wFresh.weight} vs 30 天未访问 weight=${wStale.weight}`);

// ── [6] 30 天未访问的记忆不进 top-3 ────────────────────────────────────────
// 5 条同文本候选，只有 1 条 30 天未访问；同一 bm25 → 名次完全由衰减权重决定。
const pad = Array.from({ length: 4 }, (_, i) => ({
  id: `live${i}`, text: SAME_TEXT, importance: 0.5, accessCount: 0,
  createdAt: nowT - 30 * DAY, lastAccessed: nowT - 3600000,
}));
const mixIdx = index([...pad, stale]);
const mix = mixIdx.search('舱壁凹陷深度实测几厘米', { now: nowT });
const staleRank = mix.hits.findIndex((h) => h.id === 'stale');
check('30 天未访问不进 top-3', staleRank === -1 || staleRank >= 3,
  `stale 名次 ${staleRank === -1 ? '未入结果' : `#${staleRank + 1}`} / 共 ${mix.hits.length} 条；rankWeight.value=${wStale.value.toFixed(4)} ≤0.25 ${wStale.value <= 0.25 ? '✓' : '✗'}`);
check('stale 权重 ≤0.25', wStale.value <= 0.25, `value=${wStale.value.toFixed(4)}`);
check('decayFactor 与 rankWeight 同源', wStale.value === Number(decayFactor(stale, nowT).value.toFixed(6)) || Math.abs(wStale.value - decayFactor(stale, nowT).value) < 1e-9,
  `decayFactor=${decayFactor(stale, nowT).value.toFixed(4)}`);

// ── [7] 单汉字不算强命中 ────────────────────────────────────────────────────
// 查询只含单汉字 → 无强命中 → 0 条（否则「的」「一」会把全库拖出来）。
const single = idx.search('鲸', { now: NOW });
const singleTok = tokenize('鲸');
check('单汉字不算强命中', single.hits.length === 0 && singleTok.hasStrong === false,
  `查询"鲸" → ${single.hits.length} 条；hasStrong=${singleTok.hasStrong}`);
// 对照：同一字作为二元组的一部分可以命中
const bi = idx.search('白鲸', { now: NOW });
check('二元组可命中', bi.hits.length > 0, `查询"白鲸" → ${bi.hits.length} 条`);

// ── [8] 返回片段级，不是整章 ────────────────────────────────────────────────
const avgChapter = Math.round(segs.reduce((a, s) => a + s.text.length, 0) / chapters.length);
const avgSeg = Math.round(segs.reduce((a, s) => a + s.text.length, 0) / segs.length);
check('片段级返回非整章', A.maxHitChars < avgChapter,
  `单条命中最长 ${A.maxHitChars} 字 < 整章均值 ${avgChapter} 字（段均值 ${avgSeg}）`);
const hasSource = idx.search('白鲸号从哪个港区离港', { now: NOW }).hits.every(
  (h) => Number.isInteger(h.chapter) && Number.isInteger(h.para),
);
check('命中带章段源标记', hasSource, 'hits[].chapter / hits[].para 均存在');

// ── [9] 混合公式自洽 ───────────────────────────────────────────────────────
check('score === bm25 × weight', A.formulaOk > 0,
  `${A.formulaOk} 条命中全部满足（finalScore = bm25×decay×importance×access）`);

// ── [对照] 章节错开 20 天写入 + 写完再没访问：衰减压低旧章召回（记录代价）────
// 这不是 bug：cold 档（importance 0.5）半衰期 12 天，20 天前的段落衰减到 0.315，
// 旧章整体下沉。decayFloor 是给「长文档分批灌入」场景的权衡开关。
const pressureMems = makeMems({ writtenSpreadDays: 20, lastAccessFromCreated: true });
const spread = runRecall(index(pressureMems));
const floors = [0, 0.6, 0.75, 1.0].map((f) => {
  const r = runRecall(index(pressureMems, { decayFloor: f }));
  return `floor=${f} → ${r.score.toFixed(3)}(${r.avgChars} 字)`;
});
console.log(`\n[对照] 章节错开 20 天写入且从未访问：recall ${spread.score.toFixed(3)}，miss ${spread.misses.length} 题`);
console.log(`       衰减下限曲线：${floors.join('；')}`);
console.log(`       默认 decayFloor=${SEARCH_DEFAULTS.decayFloor}（严格按 schema.decayFactor，满足能力 12 的 ≤0.25）`);

// ── 汇总 ───────────────────────────────────────────────────────────────────
const total = results.length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}  ${total - failed}/${total} 项断言通过`);
console.log(`recall ${A.score.toFixed(3)}（${A.full}/${92}）· 平均 ${A.avgChars} 字符 · 平均 ${A.avgMs.toFixed(3)} ms`);
if (failed > 0) process.exitCode = 1;
