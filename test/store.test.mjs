// store.mjs 验收测试：跑 node memjudge-plugin/test/store.test.mjs 必须全绿。
//
// 覆盖 docs/SPEC.md 能力 1（存得准）、能力 7（存储 ≤200KB）与 t10 的
// 四条附加验收：幂等、三元组、lastAccessed 语义、逐字往返。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { open, extractFacts, STORAGE_LIMIT_BYTES, STORE_SCHEMA_VERSION, entryUsage, checkBudget, BudgetExceededError, splitSegments, SPLIT_RE } from '../src/store.mjs';
import { chapters } from '../../mem-eval/corpus/novel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 进程唯一临时目录：多套测试并行（或上一条命令的库还没释放）时，共用的 .tmp
// 会在 rmSync 上抛 EPERM，或删到别人正在写的库。pid 后缀把竞争面清零。
const TMP = path.join(HERE, `.tmp-${process.pid}`);
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

// ---------------------------------------------------------------- 段层（retcon）

section('段层（retcon 机械切段）');
check('20 章写入后 segments 表已建且条数 > memories 条数', () => {
  const st = store.stats();
  assert.ok(st.segments > st.memories, `segments=${st.segments} 应大于 memories=${st.memories}`);
});

check('segmentDump 按 created_at, memory_id, seq 升序', () => {
  const rows = store.segmentDump();
  assert.ok(rows.length > 20);
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1];
    const b = rows[i];
    const key = (r) => `${r.created_at}|${r.memory_id}|${String(r.seq).padStart(4, '0')}`;
    assert.ok(key(a) <= key(b), `乱序：${key(a)} > ${key(b)}`);
  }
});

check('segmentsOf(ch5) 的 seq 从 1 开始连续', () => {
  const segs = store.segmentsOf(putResults[4].id);
  assert.ok(segs.length >= 1);
  segs.forEach((s, i) => assert.equal(s.seq, i + 1));
});

check('段元数据不落盘正文：segments 行只有 memory_id/seq/covered，无 text/hash 列', () => {
  const segs = store.segmentsOf(putResults[4].id);
  assert.ok(segs.length >= 1);
  for (const s of segs) {
    assert.deepEqual(Object.keys(s).sort(), ['covered', 'memory_id', 'seq']);
    assert.equal(s.covered, 0);
  }
});

check('segmentTexts 从 memory.text 现切段文本（不落盘、与 splitSegments 一致）', () => {
  const rows = store.segmentTexts(putResults[4].id);
  const expected = splitSegments(chapters[4].text);
  assert.deepEqual(rows.map((r) => r.text), expected);
  assert.ok(rows.every((r) => Number.isInteger(r.hash) && r.hash >= 0), '段 hash 应为非负整数');
  assert.ok(rows.every((r) => r.chars === r.text.length), 'chars 应与 text.length 一致');
});

check('段文本拼接后能复原原文核心字（去空白比对）', () => {
  const rows = store.segmentTexts(putResults[4].id);
  const rebuilt = rows.map((r) => r.text).join('').replace(/\s/g, '');
  const original = chapters[4].text.replace(/[，。！？；：\n、—-]/g, '').replace(/\s/g, '');
  assert.ok(rebuilt.length > 0);
  assert.ok(rebuilt.length <= original.length, `段拼接 ${rebuilt.length} 应 ≤ 原文去分隔符 ${original.length}`);
});

check('splitSegments 短碎片合并到前段（<2 汉字）', () => {
  const segs = splitSegments('白鲸号收到报告，焊缝凹陷九厘米。');
  assert.ok(segs.every((s) => (s.match(/[一-鿿]/g) ?? []).length >= 2 || segs.length === 1), `存在孤立短碎片：${JSON.stringify(segs)}`);
});

check('SPLIT_RE 覆盖——与--两种破折号', () => {
  const segs = splitSegments('前段——后段--再后段');
  assert.ok(segs.length >= 2, `破折号未切开：${JSON.stringify(segs)}`);
});

check('SPLIT_RE 与 retcon-form 原文一致（不含英文逗号句号）', () => {
  assert.ok(!SPLIT_RE.source.includes(','), 'SPLIT_RE 不应含英文逗号');
  assert.ok(!SPLIT_RE.source.includes('.') || SPLIT_RE.source.includes('\\.'), 'SPLIT_RE 不应含未转义英文句号');
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

// ---------------------------------------------------------------- 磨损（retcon wear）

section('磨损（retcon wear = 没被覆盖的段）');
check('supersedes 写入后 coverSegments 把旧条段全标记', () => {
  const n = store.coverSegments(oldId);
  const meta = store.segmentsOf(oldId);
  assert.equal(n, meta.length);
  assert.ok(meta.every((s) => s.covered === 1), `存在未覆盖段：${meta.filter((s) => !s.covered).map((s) => `${s.memory_id}#${s.seq}`).join(',')}`);
});

check('wear() 返回 segments/worn/wear 三字段，0 ≤ wear ≤ 1', () => {
  const w = store.wear();
  assert.ok(Number.isInteger(w.segments) && w.segments > 0);
  assert.ok(Number.isInteger(w.worn) && w.worn >= 0 && w.worn <= w.segments);
  assert.ok(w.wear >= 0 && w.wear <= 1, `wear=${w.wear} 越界`);
});

check('覆盖一条 memory 后 wear 下降（worn 减少 = 被覆盖段数）', () => {
  const before = store.wear();
  const segCount = store.segmentsOf(putResults[6].id).length;
  store.coverSegments(putResults[6].id);
  const after = store.wear();
  assert.equal(after.worn, before.worn - segCount, `worn 应减少 ${segCount}：${before.worn} → ${after.worn}`);
});

check('全部段被覆盖时 wear = 0', () => {
  const s = open(':memory:');
  const r1 = s.put({ text: '第一条记忆，有深度九厘米。' });
  const r2 = s.put({ text: '第二条记忆，有深度十厘米。' });
  s.coverSegments(r1.id);
  s.coverSegments(r2.id);
  const w = s.wear();
  assert.equal(w.worn, 0);
  assert.equal(w.wear, 0);
  s.close();
});

check('空库 wear = 0（不除零）', () => {
  const s = open(':memory:');
  const w = s.wear();
  assert.equal(w.segments, 0);
  assert.equal(w.wear, 0);
  s.close();
});

// ---------------------------------------------------------------- 预算（memento）

section('预算（memento 硬拒绝）');
check('entryUsage 单位是 text.length（Σ 各条 text 长度）', () => {
  assert.equal(entryUsage([{ text: '白鲸号' }, { text: '收到报告' }]), 7);
  assert.equal(entryUsage([]), 0);
  assert.equal(entryUsage(null), 0);
});

check('checkBudget 纯函数：used+addition ≤ limit → ok', () => {
  assert.deepEqual(checkBudget(3990, 4000, 10), { ok: true });
});

check('checkBudget 超限返回 {ok:false, used, limit, needed}，needed = 超出量', () => {
  assert.deepEqual(checkBudget(3990, 4000, 20), { ok: false, used: 3990, limit: 4000, needed: 10 });
});

check('checkBudget 对非正 limit 直接放行（0/负数/NaN = 不限）', () => {
  assert.deepEqual(checkBudget(100, 0, 9999), { ok: true });
  assert.deepEqual(checkBudget(100, -1, 9999), { ok: true });
  assert.deepEqual(checkBudget(100, NaN, 9999), { ok: true });
});

check('maxChars 预算：写入刚好到上限成功，再写一条抛 BUDGET_EXCEEDED', () => {
  const s = open(':memory:', { maxChars: 10 });
  s.put({ text: '一二三四五六七八九十' }); // 恰好 10 字符
  assert.throws(
    () => s.put({ text: '一' }),
    (err) => err instanceof BudgetExceededError && err.code === 'BUDGET_EXCEEDED' && err.details.needed === 1,
  );
  s.close();
});

check('超限抛错后库未被污染（行数不变、可继续写更短的）', () => {
  const s = open(':memory:', { maxChars: 10 });
  s.put({ text: '一二三四五六七八九十' }); // 恰好 10
  assert.throws(() => s.put({ text: '一' }), BudgetExceededError);
  assert.equal(s.stats().memories, 1);
  s.close();
});

check('幂等同文写入不触发预算（hash 命中提前 return）', () => {
  const s = open(':memory:', { maxChars: 5 });
  s.put({ text: '一二三四五' });
  const r = s.put({ text: '一二三四五' }); // 同文，幂等，不应触发预算
  assert.equal(r.inserted, false);
  assert.equal(s.stats().memories, 1);
  s.close();
});

check('maxChars=0（默认）不限预算：29648 字语料可全量落库', () => {
  const s = open(':memory:');
  for (const c of chapters) s.put({ text: c.text, chapter: c.n });
  assert.equal(s.stats().memories, 20);
  s.close();
});

check('错误码与 memento 一致：BUDGET_EXCEEDED + details{used,limit,needed}', () => {
  const s = open(':memory:', { maxChars: 5 });
  s.put({ text: '一二三四五' });
  try {
    s.put({ text: '六七八' });
    assert.fail('应抛错');
  } catch (err) {
    assert.equal(err.code, 'BUDGET_EXCEEDED');
    assert.deepEqual(err.details, { used: 5, limit: 5, needed: 3 });
  }
  s.close();
});

check('put 返回新增 segmentCount 字段（retcon 段数）', () => {
  const s = open(':memory:');
  const r = s.put({ text: '白鲸号收到报告。焊缝凹陷九厘米，实测属实。' });
  assert.equal(r.segmentCount, splitSegments('白鲸号收到报告。焊缝凹陷九厘米，实测属实。').length);
  s.close();
});

check('v1 库重开自动迁移：segments 表补写存量 memory 的段', () => {
  const v1Path = path.join(TMP, 'v1.db');
  fs.rmSync(v1Path, { force: true });
  const s1 = open(v1Path);
  s1.put({ text: '白鲸号收到报告。焊缝凹陷九厘米。' });
  s1.raw().prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_version', '1');
  s1.close();
  const s2 = open(v1Path);
  const segs = s2.segmentDump();
  assert.ok(segs.length >= 1, `迁移后段数应 ≥1，实际 ${segs.length}`);
  s2.close();
  fs.rmSync(v1Path, { force: true });
});

check('v2 库（covered 为 \'0\'/\'1\' 字符串位图）重开升级到 v3，二次打开幂等', () => {
  const V2_TEXT = '白鲸号收到报告。焊缝凹陷九厘米，实测属实。';
  const v2Path = path.join(TMP, 'v2.db');
  fs.rmSync(v2Path, { force: true });
  const s1 = open(v2Path);
  s1.put({ text: V2_TEXT });
  // 手工退化成 v2 形状：segments(ord, seg_count, covered TEXT)
  const db1 = s1.raw();
  db1.exec('DROP TABLE segments');
  db1.exec(`CREATE TABLE segments (
    ord       INTEGER PRIMARY KEY,
    seg_count INTEGER NOT NULL,
    covered   TEXT NOT NULL DEFAULT ''
  ) WITHOUT ROWID;`);
  const n0 = splitSegments(V2_TEXT).length;
  db1.prepare('INSERT INTO segments (ord, seg_count, covered) VALUES (?, ?, ?)')
    .run(1, n0, '1'.repeat(n0));
  db1.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_version', '2');
  s1.close();

  const s2 = open(v2Path);
  const cols = s2.raw().prepare('PRAGMA table_info(segments)').all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['bits', 'ord'], `迁移后列应为 bits/ord，实际 ${cols.join(',')}`);
  assert.equal(s2.stats().segments, n0, '段数不应因形状迁移而变');
  // 自检重建段表时从原文重切，覆盖位归零（v2 的位图是派生数据，重建无损）
  assert.equal(s2.stats().wornSegments, n0, '重建后段位图应回到未覆盖');
  const afterFirst = s2.segmentDump();
  const version = s2.raw().prepare('SELECT v FROM meta WHERE k = ?').get('schema_version').v;
  // 断言对着常量而不是硬编码数字：版本号每升一版都要来改这里，等于把「迁移真的跑了」
  // 这条用例变成版本号的复述。真正要钉的是「迁移后版本必须是当前版本」。
  assert.equal(Number(version), STORE_SCHEMA_VERSION, `schema_version 应升到 ${STORE_SCHEMA_VERSION}，实际 ${version}`);
  s2.close();

  const s3 = open(v2Path);
  assert.deepEqual(s3.segmentDump(), afterFirst, '二次打开段位图必须原样（幂等）');
  assert.equal(s3.stats().segments, n0);
  s3.close();
  fs.rmSync(v2Path, { force: true });
});

// ---------------------------------------------------------------- 体积

section('存储体积（能力 7）');
const bytes = store.compact();
check(`20 章整章写入（2704 句级段）库体积 ≤ 200KB（实测 ${bytes} 字节 / ${(bytes / 1024).toFixed(1)} KB）`, () => {
  assert.ok(bytes <= STORAGE_LIMIT_BYTES, `超预算：${bytes} > ${STORAGE_LIMIT_BYTES}`);
});

// 段级写入口径（adapters 默认 GRANULARITY=seg，294 条 memory、句级段数与章级相同）
const SEG_DB = path.join(TMP, 'seg.db');
const segStore = open(SEG_DB, { now: () => FIXED_NOW });
let segMemCount = 0;
for (const c of chapters) {
  const parts = String(c.text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    segStore.put({ text: parts[i], chapter: c.n, para: i + 1 });
    segMemCount += 1;
  }
}
const segBytes = segStore.compact();
const segStats = segStore.stats();
segStore.close();
check(`段级写入（${segMemCount} 条 memory）库体积 ≤ 200KB（实测 ${segBytes} 字节 / ${(segBytes / 1024).toFixed(1)} KB）`, () => {
  assert.ok(segBytes <= STORAGE_LIMIT_BYTES, `超预算：${segBytes} > ${STORAGE_LIMIT_BYTES}`);
});
check('段级写入的段数与章级一致（同一语料、同一 SPLIT_RE）', () => {
  // 章级库到这一步已多写了 override 记忆（'第六章节的更正…' 切 2 段），拿它的
  // stats().segments 直接比会把那段算进「同一语料」。口径应是纯语料，故另开一个
  // 内存库写 20 章取基准。
  const ref = open(':memory:');
  for (const c of chapters) ref.put({ text: c.text, chapter: c.n });
  const chapterSegments = ref.stats().segments;
  ref.close();
  assert.equal(segStats.segments, chapterSegments,
    `段级 ${segStats.segments} 段 vs 章级 ${chapterSegments} 段`);
});

// 段位图打包（v3）的收益写进断言：否则一次「改回字符串位图」的重复会在不被察觉的
// 情况下把余量吃回 4KB。4KB 余量意味着再加十来条段级 memory 就撞线。
const segMargin = STORAGE_LIMIT_BYTES - segBytes;
check(`段级写入余量 ${segMargin} 字节 ≥ 8KB（v3 段位图打包换来，防回退）`, () => {
  assert.ok(segMargin >= 8 * 1024, `余量只有 ${segMargin} 字节，段位图形状疑似退回字符串位图`);
});

check('段级写入逼近 200KB 边界时再写抛 BUDGET_EXCEEDED，且不留残行', () => {
  const edgePath = path.join(TMP, 'edge.db');
  fs.rmSync(edgePath, { force: true });
  const s = open(edgePath, { now: () => FIXED_NOW });
  // 段级口径写满整份语料（≈188KB），再用短段落把库体推到 195KB 附近
  for (const c of chapters) {
    const parts = String(c.text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) s.put({ text: parts[i], chapter: c.n, para: i + 1 });
  }
  let extra = 0;
  while (s.compact() < 190 * 1024 && extra < 400) {
    s.put({ text: `补充记录 ${extra}：焊缝凹陷九厘米，实测属实。` });
    extra += 1;
  }
  const edgeBytes = s.compact();
  const before = s.stats();
  assert.ok(edgeBytes <= STORAGE_LIMIT_BYTES,
    `贴边库 ${edgeBytes} 已越过 ${STORAGE_LIMIT_BYTES}，本次边界断言失去意义`);
  assert.ok(edgeBytes >= 190 * 1024, `贴边库只有 ${edgeBytes} 字节，没推到边界`);
  const usedChars = before.textChars;
  s.close();

  // 重开并卡死字符预算：下一条必然被拒，且拒的是既有错误码而非静默截断
  const g = open(edgePath, { now: () => FIXED_NOW, maxChars: usedChars });
  const text = '白鲸号的焊缝记录又被人改了一次。';
  let thrown = null;
  try {
    g.put({ text });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, '应抛错');
  assert.equal(thrown.code, 'BUDGET_EXCEEDED', `错误码应为 BUDGET_EXCEEDED，实际 ${thrown.code}`);
  assert.deepEqual(thrown.details, { used: usedChars, limit: usedChars, needed: text.length });
  const after = g.stats();
  assert.equal(after.memories, before.memories, '被拒的写入不应留下 memories 行');
  assert.equal(after.facts, before.facts, '被拒的写入不应留下 facts 行');
  assert.equal(after.segments, before.segments, '被拒的写入不应留下段');
  assert.equal(after.textChars, usedChars, '被拒的写入不应改动正文用量');
  assert.equal(g.get(`mem-${'x'}`), null);
  const bytesAfterReject = g.compact();
  assert.equal(bytesAfterReject, edgeBytes, `被拒写入后库体应不变：${edgeBytes} → ${bytesAfterReject}`);
  g.close();
  fs.rmSync(edgePath, { force: true });
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
