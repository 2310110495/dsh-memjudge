// 记忆三分（人 / 约 / 事）+ 注入分区：v6 迁移、kind 写入语义、三段配额。
//
// 这套用例对着四个真实失败面写：
//   1. 老库升级必须是 ALTER 而不是「请重建库」——且重复打开不能重复 ALTER。
//   2. kind 是模型给的标签，写错不该让内容正确的记忆丢掉 → 非法值归 event。
//   3. person / promise 不进 recency 淘汰，否则身份与约定会被刚写的待办挤出注入面。
//   4. 三分之后总预算仍是 2000，event 段可以被压缩，person 段不许被整体丢弃。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { open, STORE_SCHEMA_VERSION, MEMORY_KINDS, normalizeKind } from '../src/store.mjs';
import { apply, SECTION_NAME, INJECT_HARD_LIMIT, INJECT_SEGMENTS } from '../src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, `.tmp-kind-${process.pid}`);
const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 27);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows 上 SQLite 句柄偶尔晚一拍释放，留给系统清理。
  }
});

// ---------------------------------------------------------------- 宿主 mock

class NamedEntries {
  constructor(kind) {
    this.kind = kind;
    this.map = new Map();
  }

  insert(name, value) {
    if (this.map.has(name)) throw new Error(`${this.kind} "${name}" is already registered`);
    this.map.set(name, value);
    return () => this.map.delete(name);
  }
}

class MockContext {
  constructor() {
    this.tools = new NamedEntries('tool');
    this.systemPrompt = new NamedEntries('prompt section');
    this._effects = [];
  }

  effect(fn) {
    const cleanup = fn();
    const entry = { cleanup, active: true };
    this._effects.push(entry);
    return () => {
      if (!entry.active) return;
      entry.active = false;
      if (typeof entry.cleanup === 'function') entry.cleanup();
    };
  }

  dispose() {
    for (const entry of this._effects.splice(0).reverse()) {
      if (!entry.active) continue;
      entry.active = false;
      if (typeof entry.cleanup === 'function') entry.cleanup();
    }
  }
}

function hostCtx() {
  const ctx = new MockContext();
  ctx.tools.register = (definition) => ctx.tools.insert(definition.name, definition);
  ctx.systemPrompt.section = (section) => ctx.systemPrompt.insert(section.name, section);
  return ctx;
}

const tool = (ctx, name) => ctx.tools.map.get(name);
const sectionText = (ctx) => ctx.systemPrompt.map.get(SECTION_NAME).text();

// ---------------------------------------------------------------- v5 → v6

/** 按 bf46c46 的 DDL 造一个 schema v5 老库（memories 没有 kind 列）。 */
function buildLegacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0,
  supersedes TEXT,
  source TEXT
);
CREATE UNIQUE INDEX ux_memories_hash ON memories(text_hash);
CREATE TABLE segments (ord INTEGER PRIMARY KEY, bits BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE vector_blob (id TEXT PRIMARY KEY, dim INTEGER NOT NULL, slots INTEGER NOT NULL, q BLOB NOT NULL);
`);
  const ins = db.prepare(`INSERT INTO memories
    (id, text, text_hash, created_at, last_accessed, access_count, importance, supersedes, source)
    VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL)`);
  ins.run('mem-c0-p1-000000000001', '用户叫 YG，长期做后端与记忆系统。', 'legacy-1', T0, T0, 0.9);
  ins.run('mem-c0-p2-000000000002', '约定：回话一律用简体中文。', 'legacy-2', T0 + DAY, T0 + DAY, 0.8);
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', '5');
  db.close();
}

test('v5 老库升级：ALTER 补 kind 列，老记录回填 event，版本升到 6', () => {
  const file = path.join(TMP, 'legacy.db');
  buildLegacyDb(file);
  const s = open(file, { now: () => T0 + 10 * DAY });
  const cols = s.raw().prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
  assert.ok(cols.includes('kind'), 'kind 列缺失');
  const rows = s.raw().prepare('SELECT kind FROM memories').all();
  assert.deepEqual(rows.map((r) => r.kind), ['event', 'event'], "老记录必须全部回填 'event'");
  assert.equal(s.raw().prepare("SELECT v FROM meta WHERE k = 'schema_version'").get().v, '6');
  assert.equal(STORE_SCHEMA_VERSION, 6);
  assert.deepEqual(s.stats().kinds, { person: 0, promise: 0, event: 2 });
  s.close();
});

test('迁移幂等：再开两次不报错、不重复 ALTER、段位图不被重写', () => {
  const file = path.join(TMP, 'legacy.db');
  const second = open(file, { now: () => T0 + 11 * DAY });
  const cols = second.raw().prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
  assert.equal(cols.filter((c) => c === 'kind').length, 1, 'kind 列被重复添加');
  const segs = second.raw().prepare('SELECT COUNT(*) AS n FROM segments').get().n;
  assert.equal(segs, 2);
  second.close();

  assert.doesNotThrow(() => {
    const third = open(file, { now: () => T0 + 12 * DAY });
    third.close();
  }, '重复打开必须不报错（duplicate column name 说明 ALTER 没被幂等保护）');
});

test('kind 写入语义：合法三类落库、非法值归 event、未传 kind 不改已有分类', () => {
  const s = open(path.join(TMP, 'kind-write.db'), { now: () => T0 });
  assert.deepEqual([...MEMORY_KINDS], ['person', 'promise', 'event']);
  assert.equal(normalizeKind('PERSON'), 'person', '大小写不该影响分类');
  assert.equal(normalizeKind('  promise  '), 'promise');
  assert.equal(normalizeKind('人物'), 'event', '非法值必须归 event 而不是抛错');
  assert.equal(normalizeKind(undefined), 'event');

  const p = s.put({ text: '用户叫 YG。', kind: 'person' });
  assert.equal(p.kind, 'person');
  const q = s.put({ text: '约定：用简体中文。', kind: 'promise' });
  assert.equal(q.kind, 'promise');
  const e = s.put({ text: '今天跑了 78 项测试。', kind: 'event' });
  assert.equal(e.kind, 'event');
  const bad = s.put({ text: '一条 kind 写错的记忆。', kind: 'bogus' });
  assert.equal(bad.kind, 'event');
  assert.equal(bad.inserted, true, '非法 kind 不该阻止写入');

  // 幂等命中允许纠正分类；不传 kind 的重写不能把已有分类改回去。
  const again = s.put({ text: '今天跑了 78 项测试。', kind: 'person' });
  assert.equal(again.inserted, false);
  assert.equal(again.kind, 'person');
  const plain = s.put({ text: '今天跑了 78 项测试。' });
  assert.equal(plain.kind, 'person', '未传 kind 的重写把 person 改回了 event');

  // 4 条落库：person/promise/event 各一 + 一条非法 kind 归 event；
  // 随后幂等命中把「今天跑了 78 项测试。」从 event 纠正成 person。
  assert.deepEqual(s.stats().kinds, { person: 2, promise: 1, event: 1 });
  assert.equal(s.dump().find((r) => r.text === '用户叫 YG。').kind, 'person');
  assert.equal(s.list({ includeText: true }).find((r) => r.text === '约定：用简体中文。').kind, 'promise');
  s.close();
});

test('memjudge_stats 输出三种 kind 各自的条数', async () => {
  const ctx = hostCtx();
  apply(ctx, { dbPath: path.join(TMP, 'stats.db'), now: () => T0 });
  const remember = tool(ctx, 'memjudge_remember');
  await remember.execute({ text: '用户叫 YG。', kind: 'person' });
  await remember.execute({ text: '约定：先说结论。', kind: 'promise' });
  await remember.execute({ text: '跑了一次迁移。' });
  const st = await tool(ctx, 'memjudge_stats').execute({});
  assert.deepEqual(st.kinds, { person: 1, promise: 1, event: 1 });
  assert.match(tool(ctx, 'memjudge_stats').output.render({}, st)[0].text, /三分 人 1 \/ 约 1 \/ 事 1/);
  ctx.dispose();
});

// ---------------------------------------------------------------- 注入分区

/** 从注入文本里取某段的行数。段标题行为 `人：` / `约：` / `事：`。 */
function segLines(text, label) {
  const lines = text.split('\n');
  const i = lines.indexOf(label);
  if (i < 0) return 0;
  let n = 0;
  for (let j = i + 1; j < lines.length && lines[j].startsWith('- '); j += 1) n += 1;
  return n;
}

test('注入分区：3 person + 3 promise + 20 event → 三段标题都在、六条一条不少、总字符 ≤2000', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'inject-mix.db'), autoInject: true, now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  const persons = [
    '用户叫 YG，长期做后端与记忆系统。',
    '用户的猫叫煤球，三岁，怕生人。',
    '用户讨厌荧光灯和「你应该只是…」这种句式。',
  ];
  const promises = [
    '约定：回话一律用简体中文。',
    '约定：交付前必须真跑验收命令。',
    '约定：不要 git commit 也不要重启 DSH。',
  ];
  for (const text of persons) {
    clock += DAY;
    await remember.execute({ text, kind: 'person', importance: 0.9 });
  }
  for (const text of promises) {
    clock += DAY;
    await remember.execute({ text, kind: 'promise', importance: 0.8 });
  }
  for (let i = 1; i <= 20; i += 1) {
    clock += DAY;
    await remember.execute({ text: `第 ${i} 次操作的经过与结果：跑了第 ${i} 项检查，日志在 reports/${i}.txt。`, importance: 0.1 });
  }

  const text = sectionText(ctx);
  assert.ok(text.length <= INJECT_HARD_LIMIT, `注入 ${text.length} 字符，超过 ${INJECT_HARD_LIMIT}`);
  assert.ok(text.startsWith('## memjudge 记忆索引'), `标题异常：${text.slice(0, 40)}`);
  for (const label of ['人：', '约：', '事：']) assert.ok(text.includes(`\n${label}\n`), `缺 ${label} 段标题`);
  assert.equal(segLines(text, '人：'), 3, 'person 段条数不对');
  assert.equal(segLines(text, '约：'), 3, 'promise 段条数不对');
  for (const p of persons) assert.ok(text.includes(p.slice(0, 10)), `person 被丢：${p.slice(0, 10)}`);
  for (const p of promises) assert.ok(text.includes(p.slice(0, 10)), `promise 被丢：${p.slice(0, 10)}`);
  ctx.dispose();
});

test('注入分区：30 条 person 撑爆 800 → person 不被丢成 0，总字符 ≤2000，event 被压缩', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'inject-heavy.db'), autoInject: true, now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  // importance 递减：段内超限时按 importance 降序取，前 10 条应当胜出。
  for (let i = 1; i <= 30; i += 1) {
    clock += DAY;
    await remember.execute({
      text: `用户的第 ${i} 项稳定偏好：习惯在深夜写代码，讨厌被打断，喜欢先看数据再下结论。`,
      kind: 'person',
      importance: 1 - i / 100,
    });
  }
  for (let i = 1; i <= 20; i += 1) {
    clock += DAY;
    await remember.execute({ text: `第 ${i} 次跑测试的经过与结果：共 ${100 + i} 项断言，日志在 results/${i}.log。` });
  }

  const text = sectionText(ctx);
  assert.ok(text.length <= INJECT_HARD_LIMIT, `注入 ${text.length} 字符，超过 ${INJECT_HARD_LIMIT}`);
  const personRows = segLines(text, '人：');
  assert.ok(personRows > 0, 'person 段被丢成 0 条');
  assert.ok(personRows <= 20, `person 段 ${personRows} 条，800 字符装不下这么多`);
  assert.ok(text.includes('第 1 项稳定偏好'), 'importance 最高的老条目没被保留');
  assert.ok(!text.includes('第 30 项稳定偏好'), 'importance 最低的条目不该挤进 800 字符');
  assert.ok(segLines(text, '事：') > 0, 'event 段被整体丢弃');
  // 段配额之和必须正好是硬上限，否则「三段配额」只是修辞。
  assert.equal(INJECT_SEGMENTS.reduce((s, seg) => s + seg.cap, 0), INJECT_HARD_LIMIT);
  ctx.dispose();
});

test('person 同 importance 时按 created_at 升序：老的身份事实先留', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'inject-order.db'), autoInject: true, now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  const texts = [];
  for (let i = 0; i < 12; i += 1) {
    clock += DAY;
    const text = `第 ${i} 号身份事实：用户的长期习惯编号 ${i}，这条事实足够长以便在 800 字符内尽快被挤掉。`;
    texts.push(text);
    await remember.execute({ text, kind: 'person', importance: 0.5 });
  }
  const out = sectionText(ctx);
  const present = texts
    .map((text, i) => [i, out.indexOf(text.slice(0, 12))])
    .filter(([, pos]) => pos >= 0)
    .map(([i]) => i);
  assert.ok(present.length > 0, '一条身份事实都没进注入');
  assert.ok(present.length < texts.length, `注入里 ${present.length} 条，800 字符应当截掉一部分`);
  assert.deepEqual(present, present.slice().sort((a, b) => a - b), '老的身份事实必须排在前面');
  assert.equal(present[0], 0, '最早的一条必须被保留');
  ctx.dispose();
});

test('event 段：人工优先，auto 最多补 2 席且需 accessCount>0', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'inject-auto.db'), autoInject: true, now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  const recall = tool(ctx, 'memjudge_recall');
  for (let i = 1; i <= 2; i += 1) {
    clock += DAY;
    await remember.execute({ text: `人工留下的事件 ${i}：手工确认过的结论。` });
  }
  // auto 条目：source 走 auto-capture 的格式；前 4 条被 recall 触达过一次，
  // 后 2 条一次都没被读过——它们不该占用仅有的 2 个 auto 席位。
  for (let i = 1; i <= 6; i += 1) {
    clock += DAY;
    await remember.execute({
      text: `自动采集的事件 ${i}：这一轮对话里的经过与结果。`,
      source: `auto:chat#abcdef12-t${i}`,
    });
    if (i <= 4) await recall.execute({ query: `自动采集的事件 ${i}` });
  }
  const out = sectionText(ctx);
  const autoRows = [...out.matchAll(/自动采集的事件/g)].length;
  const manualRows = [...out.matchAll(/人工留下的事件/g)].length;
  assert.equal(manualRows, 2, '人工条目必须全在');
  assert.ok(autoRows <= 2, `auto 段出现 ${autoRows} 条，超过 2 席`);
  assert.ok(autoRows >= 1, 'auto 条目一条都没进来（人工<6 且 accessCount>0 时应当补位）');
  ctx.dispose();
});
