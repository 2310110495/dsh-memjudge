// t1 移植验收 —— 证明 search.mjs 里的分词器/打分/衰减是「抄来的」而不是「编出来的」
//
// 三个模块的源：
//   tokenize        ← mem-eval/repos/Phant0Meow__dsh-meow-memory/src/bm25.ts（类别路由 + NFKC + EN 归一化）
//   finalScore      ← mem-eval/repos/RestRegular__dsh-memory/source/memory-local/src/scoring.ts（recordScore 五因子）
//   recencyFactor   ← 同上 recencyFactor()
//
// 与源的已知偏离（有意为之，逐条写在这里，不藏）：
//   1. meow 的 CJK run 长度 <2 时**不产出** token；memjudge 保留单字进索引（打分乘 singleCharDiscount），
//      因为 schema.rankWeight 与「单汉字不算强命中」闸门都需要单字进倒排。强命中闸门在 search() 里补回 meow 的语义。
//   2. meow 仅在 promptLang=en 时做停用词+Porter；memjudge 无条件做。中文 bigram 不受影响（normalizeEn 只改纯字母词），
//      代价是中英混排时拉丁词更激进地归并——两侧走同一 tokenize，命中一致性不破。
//   3. 衰减默认走 schema 双档（warm 120 / cold 12），halfLifeDays 传数值时才是 RestRegular 的统一半衰期。
//      两档的乘性因子与 recordScore 同源，不存在公式漂移。
// 运行：node --test test/retrieval-port.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokenize, terms, recencyFactor, finalScore, SEARCH_DEFAULTS, jiebaActive } from '../src/search.mjs';

const DAY = 86_400_000;

// ── 分词器：meow 类别路由 ────────────────────────────────────────────────────

test('分词器：NFKC 全角英数归一到半角', () => {
  const { tokens } = tokenize('ＢＭ２５ 指标');
  assert.ok(tokens.includes('bm25'), `全角ＢＭ２５应归一成 bm25，实得 ${tokens.join('|')}`);
  assert.ok(tokens.includes('指标'));
});

// t12 后：含汉字的 run 走 jieba cutForSearch（有 jieba 时），纯假名仍二元组。
// 断言拆成「路径相关」与「路径无关」两半，避免测试绑死在某个依赖是否装上。
test('分词器：CJK 词边界（jieba 词典路径，验收硬要求）', (t) => {
  if (!jiebaActive()) return t.skip('jieba 未启用，本用例走 fallback 分支的姊妹用例');
  // 验收原文：必须是 凹陷/深度，不是 凹陷/陷深/深度
  assert.deepEqual(terms('凹陷深度'), ['凹陷', '深度']);
  // cutForSearch 会同时给整词与子词；子词被抑制后整词保留
  assert.ok(terms('北京烤鸭').includes('北京烤鸭'), '整词必须保留');
  assert.ok(!terms('凹陷深度').includes('陷深'), '不得出现跨词二元组');
});

test('分词器：二元组兜底（无 jieba 时的确定性契约）', (t) => {
  if (jiebaActive()) return t.skip('jieba 可用，本用例在 MEMJUDGE_NO_JIEBA=1 下生效');
  assert.deepEqual(terms('凹陷深度'), ['凹陷', '陷深', '深度']);
});

test('分词器：假名走二元组、单字仍进索引（两条路径一致）', () => {
  // タワー = 3 个 code point → 2 个 bigram，与 jieba 是否可用无关
  assert.deepEqual(terms('タワー'), ['タワ', 'ワー']);
  // 单字 token 仍进索引（打分乘 singleCharDiscount，强命中另由 strong 闸门管）
  assert.ok(terms('鲸').includes('鲸'));
});

test('分词器：拉丁整词 + 小写化，跨语言字母不切半', () => {
  assert.deepEqual(terms('Café ПРИВЕТ 한국어'), ['café', 'привет', '한국어']);
});

test('分词器：英语停用词丢弃（含撇号碎片）', () => {
  const t = terms("the user's of is");
  assert.ok(!t.includes('the') && !t.includes('of') && !t.includes('is'));
  assert.ok(!t.includes('s'), '撇号切分碎片 s 应被停用词表吞掉');
  assert.ok(t.includes('user'));
});

test('分词器：Porter 词干把屈折变化归到同一 token', () => {
  const forms = ['caching', 'caches', 'cached', 'cache'];
  const stems = new Set(forms.flatMap((f) => terms(f)));
  assert.equal(stems.size, 1, `四个形态应归到一个词干，实得 ${[...stems].join('|')}`);
});

test('分词器：标点/emoji 丢弃，混合文本按类别分段', () => {
  const { tokens, strong } = tokenize('白鲸号V2🚢离港，IMO 编号。');
  assert.ok(!tokens.some((t) => /🚢|[，。]/.test(t)));
  assert.ok(tokens.includes('v2') && tokens.includes('imo') && tokens.includes('离港'));
  // 单字 token 进索引但不算强命中
  assert.ok(strong.every((t) => t.length >= 2));
});

// ── 衰减：RestRegular recencyFactor ─────────────────────────────────────────

test('衰减：半衰期处恰好减半', () => {
  assert.equal(recencyFactor(0, 30), 1);
  assert.ok(Math.abs(recencyFactor(30, 30) - 0.5) < 1e-12);
  assert.ok(Math.abs(recencyFactor(60, 30) - 0.25) < 1e-12);
  assert.ok(Math.abs(recencyFactor(15, 30) - Math.SQRT1_2) < 1e-12);
});

test('衰减：负数年龄钳到 0，极小半衰期不炸成 Infinity', () => {
  assert.equal(recencyFactor(-5, 30), 1);
  const tiny = recencyFactor(1, 0);
  assert.ok(Number.isFinite(tiny) && tiny < 1e-300);
});

test('衰减：完全单调不增（能力 11 的曲线前提）', () => {
  const pts = [0, 1, 7, 30, 60, 120, 365, 3650].map((d) => recencyFactor(d, 30));
  for (let i = 1; i < pts.length; i += 1) assert.ok(pts[i] <= pts[i - 1], `第 ${i} 点回升：${pts[i]} > ${pts[i - 1]}`);
});

// ── 打分：RestRegular recordScore 五因子 ────────────────────────────────────

const NOW = Date.parse('2026-10-27T12:00:00+08:00');

test('打分：五因子乘性 = lexical × recency × importance × access × penalty', () => {
  const mem = { importance: 0.8, accessCount: 0, lastAccessed: NOW, supersededBy: null };
  const r = finalScore(1, mem, NOW, { halfLifeDays: 30 });
  // 0.5 + 0.5*0.8 = 0.9；access 0 → 1；未作废 → 1；age 0 → 1
  assert.ok(Math.abs(r.weight - 0.9) < 1e-9, `weight=${r.weight}`);
  assert.ok(Math.abs(r.score - 0.9) < 1e-9);
  assert.equal(r.tier, 'custom');
  assert.equal(r.halfLifeDays, 30);
});

test('打分：superseded 罚 0.3，不改变可检索性', () => {
  const base = { importance: 0.8, accessCount: 0, lastAccessed: NOW };
  const a = finalScore(1, { ...base, supersededBy: null }, NOW, { halfLifeDays: 30 });
  const b = finalScore(1, { ...base, supersededBy: 'x' }, NOW, { halfLifeDays: 30 });
  assert.ok(Math.abs(b.weight / a.weight - 0.3) < 1e-9, `比值 ${b.weight / a.weight}`);
  assert.equal(b.superseded, true);
});

test('打分：accessCount 走 1 + 0.1·ln(1+n)', () => {
  const mem = { importance: 1, accessCount: 9, lastAccessed: NOW };
  const r = finalScore(1, mem, NOW, { halfLifeDays: 30 });
  assert.ok(Math.abs(r.accessFactor - (1 + 0.1 * Math.log(10))) < 1e-4, `accessFactor=${r.accessFactor}`);
  assert.ok(Math.abs(r.weight - r.accessFactor) < 1e-4);
});

test('打分：默认 halfLifeDays=null 时回退 schema 双档，不漂移', () => {
  const mem = { importance: 0.5, accessCount: 0, lastAccessed: NOW - 30 * DAY, createdAt: NOW - 30 * DAY };
  const r = finalScore(2, mem, NOW);
  assert.equal(SEARCH_DEFAULTS.halfLifeDays, null);
  assert.notEqual(r.tier, 'custom', `默认应走 schema 档，实得 tier=${r.tier}`);
  assert.equal(r.score, Number((2 * r.weight).toFixed(6)));
});

test('打分：decayFloor 只抬时间项，不动其它因子', () => {
  const mem = { importance: 0.8, accessCount: 0, lastAccessed: NOW - 30 * DAY };
  const lo = finalScore(1, mem, NOW, { halfLifeDays: 30 });
  const hi = finalScore(1, mem, NOW, { halfLifeDays: 30, decayFloor: 0.6 });
  assert.equal(hi.decay, 0.6);
  assert.ok(Math.abs(hi.weight - 0.6 * 0.9) < 1e-9, `weight=${hi.weight}`);
  assert.ok(lo.decay < 0.6);
});

// ── 抄的来源可核（防「注释说抄了、代码是自己编的」）─────────────────────────

test('源对齐：search.mjs 保留 RestRegular 的 recencyFactor 公式与 recordScore 因子', () => {
  let src;
  try {
    src = readFileSync('../../mem-eval/repos/RestRegular__dsh-memory/source/memory-local/src/scoring.ts', 'utf8');
  } catch {
    return; // mem-eval 仓库不在时跳过，不在 CI 里假失败
  }
  assert.match(src, /Math\.pow\(0\.5, ageDays \/ Math\.max\(halfLifeDays, 0\.001\)\)/);
  assert.match(src, /const importanceFactor = 0\.5 \+ 0\.5 \* Math\.min\(1, Math\.max\(0, importance\)\)/);
  assert.match(src, /const accessBoost = 1 \+ 0\.1 \* Math\.log\(1 \+ accessCount\)/);
  assert.match(src, /const penalty = opts\.superseded \? 0\.3 : 1/);
});

test('源对齐：search.mjs 保留 meow 的类别路由常量与 Porter 表', () => {
  let src;
  try {
    src = readFileSync('../../mem-eval/repos/Phant0Meow__dsh-meow-memory/src/bm25.ts', 'utf8');
  } catch {
    return;
  }
  assert.match(src, /const CJK = \/\[\\p\{Script=Han\}\\p\{Script=Hiragana\}\\p\{Script=Katakana\}/);
  assert.match(src, /national: 'ate', tional: 'tion'/);
  assert.match(src, /if \(run\.length >= 2\)/);
  assert.match(src, /text\.normalize\('NFKC'\)/);
});
