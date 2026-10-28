#!/usr/bin/env node
// t11 独立复验探针：不复用 scripts/check-generality.mjs 的 23 条，也不用 SPEC 的六道幻觉题。
//
// 三组问法，每组的关键词（实体名或属性名整串）先自证在语料 grep 计数为 0：
//   A 组 7 条：「X号」形态的陌生实体，属性是语料里有的通用档（船籍港/总长/呼号…）。
//   B 组 3 条：非「号」形态的陌生机构/地名（船厂/船级社/港口）。
//   C 组 6 条：实体存在（白鲸号）但问的属性整串在语料里从没出现。
//
// 判据：isHardDeny 是否 true。硬拒总数/16 即硬拒率。
//
// 用法：cd memjudge-plugin && node reports/generality-probe.mjs
import { buildStore, gate, parseQuery } from '../src/judge.mjs';
import { isHardDeny } from '../src/index.mjs';
import { chapters, recall, synthesis } from '../../mem-eval/corpus/quiz.mjs';

const store = buildStore(chapters.map((c) => ({ n: c.n, text: c.text })));
const body = chapters.map((c) => c.text).join('\n');

/** [组, 关键词整串（必须语料计数 0）, 问法] */
const CASES = [
  ['A', '振华号', '振华号的船籍港是哪里？'],
  ['A', '银鲸号', '银鲸号的总长是多少米？'],
  ['A', '龙远号', '龙远号的造船厂是哪家？'],
  ['A', '金锚号', '金锚号的夏季载重吨是多少？'],
  ['A', '蓝鲸号', '蓝鲸号的呼号是什么？'],
  ['A', '铁锚号', '铁锚号的船级社是哪个？'],
  ['A', '长虹号', '长虹号的交付日期是什么？'],
  ['B', '永宁船厂', '永宁船厂承建过几条船？'],
  ['B', '渤海船级社', '渤海船级社的评级是什么？'],
  ['B', '海州港', '海州港的泊位水深是多少？'],
  ['C', '锚链直径', '白鲸号的锚链直径是多少？'],
  ['C', '救生艇定员', '白鲸号的救生艇定员是多少？'],
  ['C', '消防泵排量', '白鲸号的消防泵排量是多少？'],
  ['C', '冷藏箱数量', '白鲸号的冷藏箱数量是多少？'],
  ['C', '压载水处理装置', '白鲸号的压载水处理装置是什么型号？'],
  ['C', '燃油舱容量', '白鲸号的燃油舱容量是多少立方米？'],
];

const count = (kw) => body.split(kw).length - 1;

const stats = { A: [0, 0], B: [0, 0], C: [0, 0] };
const rows = [];
let bad = 0;

for (const [group, kw, q] of CASES) {
  const hits = count(kw);
  if (hits !== 0) {
    bad += 1;
    console.log(`[标签不成立] 「${kw}」在语料出现 ${hits} 次，该条不算缺席问法`);
    continue;
  }
  const g = gate(q, store);
  const hard = isHardDeny(g, q, body);
  stats[group][1] += 1;
  if (hard) stats[group][0] += 1;
  rows.push({ group, kw, q, hard, reason: g.reason, cov: g.coverage ?? null, entity: g.entity ?? null });
  console.log(`${hard ? 'REJECT' : '放过  '} [${group}] ${q}  ← ${kw}（语料 ${hits} 次）| ${g.reason} cov=${g.coverage ?? '-'} entity=${g.entity ?? '-'}`);
}

const total = stats.A[1] + stats.B[1] + stats.C[1];
const denied = stats.A[0] + stats.B[0] + stats.C[0];
console.log(`\n自造缺席问法：${total} 条，硬拒 ${denied}/${total} = ${(denied / total * 100).toFixed(0)}%`);
for (const k of ['A', 'B', 'C']) {
  const [d, t] = stats[k];
  console.log(`  ${k} 组：${d}/${t}`);
}
if (bad) console.log(`  ⚠ ${bad} 条关键词语料计数非 0，已排除`);

// 104 道真题误伤
const falseDeny = [];
for (const item of [...recall, ...synthesis]) {
  const g = gate(item.q, store);
  if (isHardDeny(g, item.q, body)) falseDeny.push(`${item.id} ${item.q}（${g.reason} cov=${g.coverage ?? '-'}）`);
}
console.log(`\n真题误伤：${falseDeny.length}/${recall.length + synthesis.length}`);
for (const f of falseDeny) console.log(`  ${f}`);

// 覆盖率 0.43–0.5 的 5 条真题：确认 0.4 门限之后它们仍在安全侧
const watch = ['R90', 'R36', 'R78', 'S01', 'S02'];
console.log('\n0.4 门限相邻档真题（应该全部放行，coverage ≥ 0.4）：');
for (const id of watch) {
  const item = [...recall, ...synthesis].find((x) => x.id === id);
  if (!item) { console.log(`  ${id} 不在题库里`); continue; }
  const g = gate(item.q, store);
  console.log(`  ${id} ${item.q}\n       reason=${g.reason} cov=${g.coverage ?? '-'} deny=${g.deny} hardDeny=${isHardDeny(g, item.q, body)}`);
}

// 阈值敏感性：只调 0.4 这个数能不能补上 C 组？看缺席问法与真题的覆盖率是否重叠。
const scores = [];
for (const [, kw, q] of CASES) {
  if (count(kw) !== 0) continue;
  const g = gate(q, store);
  if (g.reason !== 'attribute-not-recorded') continue;
  scores.push({ q, cov: g.coverage ?? 0, ghost: true });
}
const real = [];
for (const item of [...recall, ...synthesis]) {
  const g = gate(item.q, store);
  if (g.reason === 'attribute-not-recorded') real.push({ id: item.id, q: item.q, cov: g.coverage ?? 0 });
}
console.log('\n门限敏感性（attribute 门限 t：cov<t 才硬拒）：');
for (const t of [0.4, 0.5, 0.6, 0.7]) {
  const ghostHit = scores.filter((s) => s.cov < t).length;
  const realHit = real.filter((r) => r.cov < t);
  console.log(`  t=${t}: 缺席问法拦住 ${ghostHit}/${scores.length}，真题误伤 ${realHit.length}${realHit.length ? `（${realHit.map((r) => `${r.id}@${r.cov}`).join(' ')}）` : ''}`);
}

// 修复 2 是否真的产生过行为差异？用旧判据（coverage === 0）对照新判据（coverage < 0.4）。
// gate 只在 worst.c < 0.4 时才吐 attribute-not-recorded 且带 coverage，
// 若两套判据在全部样本上结论一致，说明放宽本身零效果，真正生效的门限在 judge.mjs:499。
const oldHard = (g) => {
  const r = g?.reason;
  if (r === 'entity-not-recorded' || r === 'scope-not-recorded') return true;
  if (r === 'attribute-not-recorded') return typeof g.coverage !== 'number' || g.coverage === 0;
  if (r === 'no-facts') {
    const latin = (String(g.query ?? '').match(/[A-Za-z][A-Za-z0-9]{1,}/g) || []);
    return latin.length > 0;
  }
  return false;
};
let diffOldNew = 0;
const diffSamples = [];
for (const item of [...recall, ...synthesis]) {
  const g = gate(item.q, store);
  const neu = isHardDeny(g, item.q, body);
  if (g.reason === 'attribute-not-recorded') {
    const old = typeof g.coverage !== 'number' || g.coverage === 0;
    if (old !== neu) { diffOldNew += 1; diffSamples.push(`${item.id} cov=${g.coverage}`); }
  }
}
console.log(`\n修复 2 对照（旧 coverage===0 vs 新 coverage<0.4）：真题上 ${diffOldNew} 条判定不同${diffSamples.length ? `（${diffSamples.join(' ')}）` : ''}`);
let gainGhost = 0;
const gainList = [];
for (const [, kw, q] of CASES) {
  if (count(kw) !== 0) continue;
  const g = gate(q, store);
  if (g.reason !== 'attribute-not-recorded') continue;
  const old = typeof g.coverage !== 'number' || g.coverage === 0;
  const neu = isHardDeny(g, q, body);
  if (!old && neu) { gainGhost += 1; gainList.push(`${q} cov=${g.coverage}`); }
}
console.log(`                 缺席问法上 ${gainGhost} 条由放过变硬拒${gainList.length ? `：${gainList.join('；')}` : ''}`);

// 口径对照：覆盖率若按「该实体的句子集合」而非全文算，C 组会不会落到门限以下？
// 这不是改后实测，只是证明缺口的位置在口径而不是阈值——全文里「锚链」「直径」出现在别处，
// 把整块的二字组覆盖率抬到 0.57~0.67，与「白鲸号有没有记录这个属性」无关。
const sents = body.split(/[。！？；\n]+/).map((s) => s.trim()).filter(Boolean);
const bi = (t) => {
  const n = t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const out = new Set();
  if (/^[a-z0-9]+$/.test(n)) { if (n.length > 1) out.add(n); return out; }
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
  return out;
};
const covIn = (blk, text) => {
  const parts = [...bi(blk)];
  if (!parts.length) return 1;
  const hay = bi(text);
  return parts.filter((x) => hay.has(x)).length / parts.length;
};
// 从块里取「在正文出现过的最长前缀」当实体（块本身是实体+属性黏在一起，整块不出现）。
const entOf = (blk) => {
  for (let len = blk.length - 1; len >= 2; len--) {
    const p = blk.slice(0, len);
    if (body.includes(p)) return p;
  }
  return null;
};
console.log('\n口径对照（同一块，全文 vs 实体句子集合）：');
for (const [, kw, q] of CASES) {
  if (count(kw) !== 0) continue;
  const pq = parseQuery(q);
  const blk = (pq.blocks || []).filter((b) => b.length >= 3).sort((a, b) => covIn(a, body) - covIn(b, body))[0];
  if (!blk) continue;
  const ent = entOf(blk);
  const scope = ent ? sents.filter((s) => s.includes(ent)).join('。') : body;
  console.log(`  [${kw}] block=${blk} ent=${ent ?? '-'} 全文=${covIn(blk, body).toFixed(2)} 实体句集=${covIn(blk, scope).toFixed(2)}`);
}
let lowReal = [];
for (const item of [...recall, ...synthesis]) {
  const pq = parseQuery(item.q);
  const blks = (pq.blocks || []).filter((b) => b.length >= 3);
  if (!blks.length) continue;
  const worst = blks.map((b) => ({ b, c: covIn(b, body) })).sort((x, y) => x.c - y.c)[0];
  const ent = entOf(worst.b);
  const scope = ent ? sents.filter((s) => s.includes(ent)).join('。') : body;
  const c = covIn(worst.b, scope);
  if (c < 0.4) lowReal.push(`${item.id} ${item.q} block=${worst.b} cov=${c.toFixed(2)}`);
}
console.log(`  实体句集口径下 104 真题中 cov<0.4 的：${lowReal.length} 条${lowReal.length ? `（${lowReal.join('；')}）` : ''}`);

const rate = denied / total;
const pass = rate >= 0.8 && falseDeny.length === 0 && bad === 0;
console.log(`\n${pass ? 'PASS' : 'FAIL'}（硬拒率 ${(rate * 100).toFixed(0)}% / 门槛 80%，误伤 ${falseDeny.length}）`);
process.exit(pass ? 0 : 1);
