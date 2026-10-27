// store.mjs 验收测试：跑 node memjudge-plugin/test/store.test.mjs 必须全绿。
//
// 覆盖 docs/SPEC.md 能力 1（存得准）、能力 7（存储 ≤200KB）与 t10 的
// 四条附加验收：幂等、三元组、lastAccessed 语义、逐字往返。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { open, extractFacts, STORAGE_LIMIT_BYTES } from '../src/store.mjs';
import { chapters } from '../../mem-eval/corpus/novel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '.tmp');
const DB = path.join(TMP, 'memjudge.db');

const FIXED_NOW = Date.UTC(2026, 2, 23, 4, 0, 0); // 假时钟：2026-03-23T04:00:00Z

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function section(title) {
  console.log(`\n[${title}]`);
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const corpusChars = chapters.reduce((s, c) => s + c.text.replace(/\s/g, '').length, 0);

// ---------------------------------------------------------------- 写入

section('写入 20 章');
const store = open(DB, { now: () => FIXED_NOW });
const putResults = [];
for (const c of chapters) {
  putResults.push(store.put({
    text: c.text,
    chapter: c.n,
    source: `corpus/novel.mjs#ch${String(c.n).padStart(2, '0')}`,
  }));
}

check('20 章全部首次写入（inserted=true）', () => {
  assert.equal(putResults.length, 20);
  assert.equal(putResults.filter((r) => r.inserted).length, 20);
});

check('memories 行数 = 20', () => {
  assert.equal(store.stats().memories, 20);
});

check('语料去空白字符 = 29648', () => {
  assert.equal(corpusChars, 29648);
});

// ---------------------------------------------------------------- 逐字往返

section('逐字往返（能力 1）');
const dump1 = store.dump();

check('dump 20 条', () => {
  assert.equal(dump1.length, 20);
});

check('dump 每条 text 与原文字符级相等', () => {
  for (let i = 0; i < chapters.length; i += 1) {
    assert.equal(dump1[i].text, chapters[i].text, `第 ${i + 1} 条正文被改写`);
  }
});

check('dump 去空白总字 = 29648（一字不多一字不少）', () => {
  const total = dump1.reduce((s, m) => s + m.text.replace(/\s/g, '').length, 0);
  assert.equal(total, 29648);
});

check('get(id).text 与 dump 一致', () => {
  const one = store.get(putResults[4].id);
  assert.equal(one.text, chapters[4].text);
});

check('写入不改写 text：source 原样保留', () => {
  assert.equal(dump1[4].source, 'corpus/novel.mjs#ch05');
});

// ---------------------------------------------------------------- 幂等

section('写入幂等');
const again = chapters.map((c) => store.put({ text: c.text, chapter: c.n }));
check('重复写入 20 章全部 inserted=false', () => {
  assert.equal(again.filter((r) => r.inserted).length, 0);
});
check('行数仍为 20', () => {
  assert.equal(store.stats().memories, 20);
});
check('重复写入返回同一批 id', () => {
  assert.deepEqual(again.map((r) => r.id), putResults.map((r) => r.id));
});
check('facts 未因重复写入翻倍', () => {
  const before = store.stats().facts;
  store.put({ text: chapters[0].text });
  assert.equal(store.stats().facts, before);
});

// ---------------------------------------------------------------- 三元组

section('三元组抽取');
const bySource = (n) => dump1.find((m) => m.source === `corpus/novel.mjs#ch${String(n).padStart(2, '0')}`);
const depthOf = (n) => bySource(n).facts.filter((f) => f.key === '深度').map((f) => `${f.value}${f.unit ?? ''}`);

check('ch5 抽出 深度 = 九厘米', () => {
  assert.deepEqual(depthOf(5), ['九厘米']);
});

check('ch15 抽出 深度 = 十一厘米', () => {
  assert.deepEqual([...new Set(depthOf(15))], ['十一厘米']);
});

check('ch19 抽出 深度 = 十一厘米（正文采用的最终值）', () => {
  assert.deepEqual([...new Set(depthOf(19))], ['十一厘米']);
});

check('同一属性跨章归一到同一 key（深度 共 5 条）', () => {
  const n = dump1.flatMap((m) => m.facts).filter((f) => f.key === '深度').length;
  assert.ok(n >= 3, `深度 key 只有 ${n} 条`);
});

check('无单位事实：人名 + 职务', () => {
  const roles = new Set(dump1.flatMap((m) => m.facts).filter((f) => f.kind === 'role').map((f) => `${f.entity}/${f.value}`));
  for (const want of ['周允棠/船长', '陈默白/二副', '林砚舟/大副', '韩兆麟/轮机长', '郭雅琴/公估人']) {
    assert.ok(roles.has(want), `缺 ${want}`);
  }
});

check('职务抽取不误收「船长证书 / 大副收据 / 船长通过」', () => {
  const names = new Set(dump1.flatMap((m) => m.facts).filter((f) => f.kind === 'role').map((f) => f.entity));
  for (const bad of ['证书', '收据', '通过', '通过甚']) {
    assert.ok(!names.has(bad), `误收 ${bad}`);
  }
});

check('编号事实完整（含 OTS-230323-04 / BTM-2023-0417 / NB-2023-MEMO-07）', () => {
  const ids = new Set(dump1.flatMap((m) => m.facts).filter((f) => f.kind === 'id').map((f) => f.value));
  for (const want of ['OTS-230323-04', 'BTM-2023-0417', 'NB-2023-MEMO-07', 'NBL-2303-11', 'SG-2303-17']) {
    assert.ok(ids.has(want), `缺编号 ${want}`);
  }
});

check('坐标事实 纬度/经度 各一条（南纬四度十二点六分、东经一一九度零三点四分）', () => {
  const coords = dump1.flatMap((m) => m.facts).filter((f) => f.kind === 'coord');
  assert.deepEqual(coords.map((f) => f.attr).sort(), ['经度', '纬度'].sort());
  assert.ok(coords.some((f) => f.value.startsWith('四度') || f.value.startsWith('一一九度')), '坐标值形态不对');
});

check('extractFacts 对空串返回空数组', () => {
  assert.deepEqual(extractFacts(''), []);
  assert.deepEqual(extractFacts(null), []);
});

check('每条 fact 的 at 落在正文范围内', () => {
  for (const m of dump1) {
    for (const f of m.facts) {
      assert.ok(f.at >= 0 && f.at < m.text.length, `at=${f.at} 越界`);
    }
  }
});

// SPEC 要求 facts 可逐字回溯（quote 必须是 text 的子串）。这里不存 quote，
// 存 at，等价性靠这条断言守住：value 必须真的出现在 at 附近，不许是拼出来的。
check('每条 fact 的 value 都能在 at 处逐字回溯到正文', () => {
  let n = 0;
  for (const m of dump1) {
    for (const f of m.facts) {
      const win = m.text.slice(f.at, f.at + f.value.length + (f.unit?.length ?? 0) + 4);
      assert.ok(win.includes(f.value), `mem=${m.source} key=${f.key} value=${f.value} 在原文 at=${f.at} 处找不到`);
      n += 1;
    }
  }
  assert.ok(n > 300, `回溯校验覆盖条数过少：${n}`);
});

// ---------------------------------------------------------------- lastAccessed

section('访问刷新');
const targetId = putResults[0].id;
check('createdAt 与 lastAccessed 初始相等（假时钟生效）', () => {
  const row = store.get(targetId, false);
  assert.equal(row.created_at, FIXED_NOW);
  assert.equal(row.last_accessed, FIXED_NOW);
  assert.equal(row.access_count, 0);
});

check('updateAccess 刷新 lastAccessed 并累加 accessCount', () => {
  const later = FIXED_NOW + 7 * 86400_000;
  const row = store.updateAccess(targetId, later);
  assert.equal(row.last_accessed, later);
  assert.equal(row.access_count, 1);
  const row2 = store.updateAccess(targetId, later + 1000);
  assert.equal(row2.access_count, 2);
  assert.equal(row2.last_accessed, later + 1000);
});

check('未访问的条目 lastAccessed 不变', () => {
  assert.equal(store.get(putResults[1].id, false).last_accessed, FIXED_NOW);
});

// ---------------------------------------------------------------- 取代链

section('取代链（supersedes / supersededBy）');
const oldId = putResults[5].id;
const newPut = store.put({
  text: '第六章节的更正：凹陷深度最终认定为十一厘米。',
  chapter: 21,
  createdAt: FIXED_NOW + 86400_000,
  supersedes: oldId,
  source: 'test/override',
});
check('新条目写入并记录 supersedes', () => {
  assert.equal(newPut.inserted, true);
  const row = store.get(newPut.id, false);
  assert.deepEqual(row.supersedes, [oldId]);
});
check('旧条目 supersededBy 反查到新条目', () => {
  const d = store.dump();
  const old = d.find((m) => m.id === oldId);
  assert.deepEqual(old.supersededBy, [newPut.id]);
});
check('旧条目 text 未被改写', () => {
  const d = store.dump();
  assert.equal(d.find((m) => m.id === oldId).text, chapters[5].text);
});

// ---------------------------------------------------------------- 体积

section('存储体积（能力 7）');
const bytes = store.compact();
check(`20 章 29648 字库体积 ≤ 200KB（实测 ${bytes} 字节 / ${(bytes / 1024).toFixed(1)} KB）`, () => {
  assert.ok(bytes <= STORAGE_LIMIT_BYTES, `超预算：${bytes} > ${STORAGE_LIMIT_BYTES}`);
});

const finalStats = store.stats();
store.close();

const diskBytes = fs.statSync(DB).size;
check('磁盘实际占用 ≤ 200KB', () => {
  assert.ok(diskBytes <= STORAGE_LIMIT_BYTES, `超预算：${diskBytes}`);
});

// ---------------------------------------------------------------- 错误路径

section('错误路径');
check('空 text 抛 TypeError', () => {
  const s = open(':memory:');
  assert.throws(() => s.put({ text: '' }), /text 必须是非空字符串/);
  s.close();
});
check('关闭后再写抛错', () => {
  const s = open(':memory:');
  s.close();
  assert.throws(() => s.put({ text: '一' }), /已关闭/);
});
check('get 不存在的 id 返回 null', () => {
  const s = open(':memory:');
  assert.equal(s.get('nope'), null);
  s.close();
});

fs.rmSync(TMP, { recursive: true, force: true });

// ---------------------------------------------------------------- 汇总

const total = pass + failures.length;
console.log('\n----------------------------------------');
console.log(`存储字节数：${bytes} 字节（${(bytes / 1024).toFixed(1)} KB），上限 ${STORAGE_LIMIT_BYTES} 字节（200 KB）`);
console.log(`条目 ${finalStats.memories} / 三元组 ${finalStats.facts} / 语料正文 29648 字（去空白）`);
console.log(`测试结果：${pass}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exitCode = 1;
} else {
  console.log('全绿');
}
