// 记忆分类兼容（人 / 约 / 事 ↔ profile / rule / experience）+ Schema v8 迁移 + 分层注入验收：
//   1. 老库 v5 升级至 Schema v8（8 张核心正交表），老记录无损回填 category='experience' (kind='event')，幂等重复打开不报错。
//   2. kind 是兼容输入标签，非法值归 event，合法 person/promise 映射为 profile/rule 并进入 Tier-S 静态保护区。
//   3. v2 分层注入（Tier-S <= 600 + Tier-D <= 900）下，auto 蒸馏记忆不再受 v1“auto 最多补 2 席且需 accessCount>0”死锁限制；
//      显式 legacy 注入模式仍保留三段配额向后兼容。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { open, STORE_SCHEMA_VERSION, MEMORY_KINDS, normalizeKind } from '../src/store.mjs';
import {
  apply,
  SECTION_NAME,
  CONTEXT_NAME,
  TIER_S_MAX_CHARS,
  TIER_D_MAX_CHARS,
  INJECT_HARD_LIMIT,
  INJECT_SEGMENTS,
} from '../src/index.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-kind-'));
const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 27);

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
  constructor({ withContextHook = false } = {}) {
    this.tools = new NamedEntries('tool');
    this.systemPrompt = new NamedEntries('prompt section');
    this._effects = [];
    this._contextHooks = [];
    if (withContextHook) {
      this.context = {
        register: (fn) => {
          this._contextHooks.push(fn);
          return () => {
            const idx = this._contextHooks.indexOf(fn);
            if (idx >= 0) this._contextHooks.splice(idx, 1);
          };
        },
      };
    }
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

function hostCtx(opts = {}) {
  const ctx = new MockContext(opts);
  ctx.tools.register = (definition) => ctx.tools.insert(definition.name, definition);
  ctx.systemPrompt.section = (section) => ctx.systemPrompt.insert(section.name, section);
  if (opts.withContextHook) {
    ctx.systemPrompt.context = (section) => ctx.systemPrompt.insert(section.name, section);
  }
  return ctx;
}

const tool = (ctx, name) => ctx.tools.map.get(name);
const sectionText = (ctx, env) => ctx.systemPrompt.map.get(SECTION_NAME).text(env);
const contextText = (ctx, env) => ctx.systemPrompt.map.get(CONTEXT_NAME).text(env);

// ---------------------------------------------------------------- v5 → v8

/** 按历史 DDL 造一个 schema v5 老库（memories 没有 kind/category 列）。 */
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

test('v5 老库升级：无损迁移至 Schema v8，老记录回填 experience(event)，版本升到 8', () => {
  const file = path.join(TMP, 'legacy.db');
  buildLegacyDb(file);
  const s = open(file, { now: () => T0 + 10 * DAY });
  const cols = s.raw().prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
  assert.ok(cols.includes('category'), 'category 列缺失');
  assert.ok(cols.includes('tier'), 'tier 列缺失');
  assert.ok(cols.includes('space_id'), 'space_id 列缺失');
  const rows = s.raw().prepare('SELECT category, tier FROM memories ORDER BY created_at ASC').all();
  assert.deepEqual(rows.map((r) => r.category), ['experience', 'experience'], "v5 无 kind 的老记录必须回填为 'experience'");
  assert.deepEqual(rows.map((r) => r.tier), [3, 3], 'v5 无 kind 老记录保留兼容 tier=3');
  assert.equal(s.raw().prepare("SELECT value FROM main.meta WHERE key = 'schema_version'").get().value, '8');
  assert.equal(s.raw().prepare("SELECT v FROM meta WHERE k = 'schema_version'").get().v, '8');
  assert.equal(STORE_SCHEMA_VERSION, 8);
  assert.deepEqual(s.stats().kinds, { person: 0, promise: 0, event: 2 });
  s.close();
});

test('迁移幂等：再开两次不报错、不重复建表、段位图按连接重建完整', () => {
  const file = path.join(TMP, 'legacy.db');
  const second = open(file, { now: () => T0 + 11 * DAY });
  const cols = second.raw().prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
  assert.equal(cols.filter((c) => c === 'category').length, 1, 'category 列唯一');
  const segs = second.raw().prepare('SELECT COUNT(*) AS n FROM segments').get().n;
  assert.equal(segs, 2);
  second.close();

  assert.doesNotThrow(() => {
    const third = open(file, { now: () => T0 + 12 * DAY });
    third.close();
  }, '重复打开必须幂等不报错');
});

test('kind 写入语义：合法三类落库映射 profile/rule/experience、非法值归 event、未传 kind 不改已有分类', () => {
  const s = open(path.join(TMP, 'kind-write.db'), { now: () => T0 });
  assert.deepEqual([...MEMORY_KINDS], ['person', 'promise', 'event']);
  assert.equal(normalizeKind('PERSON'), 'person', '大小写不该影响分类');
  assert.equal(normalizeKind('  promise  '), 'promise');
  assert.equal(normalizeKind('人物'), 'event', '非法值必须归 event 而不是抛错');
  assert.equal(normalizeKind(undefined), 'event');

  const p = s.put({ text: '用户叫 YG。', kind: 'person' });
  assert.equal(p.kind, 'person');
  assert.equal(p.category, 'profile');
  const q = s.put({ text: '约定：用简体中文。', kind: 'promise' });
  assert.equal(q.kind, 'promise');
  assert.equal(q.category, 'rule');
  const e = s.put({ text: '今天跑了 78 项测试。', kind: 'event' });
  assert.equal(e.kind, 'event');
  assert.equal(e.category, 'experience');
  const bad = s.put({ text: '一条 kind 写错的记忆。', kind: 'bogus' });
  assert.equal(bad.kind, 'event');
  assert.equal(bad.inserted, true, '非法 kind 不该阻止写入');

  // 幂等命中允许纠正分类；不传 kind 的重写不能把已有分类改回去。
  const again = s.put({ text: '今天跑了 78 项测试。', kind: 'person' });
  assert.equal(again.inserted, false);
  assert.equal(again.kind, 'person');
  const plain = s.put({ text: '今天跑了 78 项测试。' });
  assert.equal(plain.kind, 'person', '未传 kind 的重写把 person 改回了 event');

  assert.deepEqual(s.stats().kinds, { person: 2, promise: 1, event: 1 });
  assert.equal(s.dump().find((r) => r.text === '用户叫 YG。').kind, 'person');
  assert.equal(s.list({ includeText: true }).find((r) => r.text === '约定：用简体中文。').kind, 'promise');
  s.close();
});

test('memjudge_stats 输出三种 kind 与五种 category 各自的条数', async () => {
  const ctx = hostCtx();
  apply(ctx, { dbPath: path.join(TMP, 'stats.db'), now: () => T0 });
  const remember = tool(ctx, 'memjudge_remember');
  await remember.execute({ text: '用户叫 YG。', kind: 'person' });
  await remember.execute({ text: '约定：先说结论。', kind: 'promise' });
  await remember.execute({ text: '跑了一次迁移。' });
  const st = await tool(ctx, 'memjudge_stats').execute({});
  assert.deepEqual(st.kinds, { person: 1, promise: 1, event: 1 });
  assert.equal(st.categories.profile, 1);
  assert.equal(st.categories.rule, 1);
  assert.equal(st.categories.experience, 1);
  assert.match(tool(ctx, 'memjudge_stats').output.render({}, st)[0].text, /三分 人 1 \/ 约 1 \/ 事 1/);
  ctx.dispose();
});

// ---------------------------------------------------------------- v2 分层注入 & legacy 兼容验证

test('v2 分层注入：person/promise 映射 profile/rule 进 Tier-S 保护区，auto 记忆在 Tier-D 无“最多补 2 席且需 accessCount>0”死锁', async () => {
  const ctx = hostCtx({ withContextHook: true });
  let clock = T0;
  apply(ctx, {
    dbPath: path.join(TMP, 'v2-tiered-inject.db'),
    autoInject: true,
    injectMode: 'tiered',
    now: () => clock,
  });
  const remember = tool(ctx, 'memjudge_remember');

  await remember.execute({ text: '用户叫 YG，长期主导核心后端与记忆架构。', kind: 'person', importance: 0.95 });
  await remember.execute({ text: '铁律：所有交付必须在隔离沙箱跑通测试。', kind: 'promise', importance: 0.9 });

  // 写入 5 条完全未经 recall 触达（accessCount === 0）的 auto: 来源经验记忆与 2 条手工记忆
  for (let i = 1; i <= 2; i += 1) {
    clock += DAY;
    await remember.execute({
      text: `手工记录的部署端口规范 ${i}：网关监听 1808${i} 端口。`,
      importance: 0.6,
    });
  }
  for (let i = 1; i <= 5; i += 1) {
    clock += DAY;
    await remember.execute({
      text: `自动蒸馏的 Redis 哨兵故障排查结论 ${i}：需开启 sentinel resolve-hostnames 配置项 ${i}。`,
      source: `auto:distill#sess-${i}`,
      importance: 0.7,
    });
  }

  // Tier-S 静态底座：包含 profile 与 rule，且字符数严格 <= 600，同会话二次读取字节恒定
  const tierS1 = sectionText(ctx, { sessionId: 'sess-check-1' });
  const tierS2 = sectionText(ctx, { sessionId: 'sess-check-1' });
  assert.ok(tierS1.length > 0 && tierS1.length <= TIER_S_MAX_CHARS, `Tier-S 长度 ${tierS1.length} 越界`);
  assert.equal(tierS1, tierS2, '同一会话内 Tier-S 静态底座必须字节级恒定');
  assert.match(tierS1, /YG/);
  assert.match(tierS1, /隔离沙箱/);
  assert.doesNotMatch(tierS1, /Redis 哨兵/, '普通经验记忆不应挤占 Tier-S 保护区');

  // Tier-D 按问动态召回：即使 auto: 条目 accessCount===0 且数量超过 2 条，也能按相关性召回超过 2 条！
  const tierD = contextText(ctx, {
    sessionId: 'sess-check-1',
    messages: [{ role: 'user', content: 'Redis 哨兵故障排查需要开启什么 sentinel 配置项？' }],
  });
  assert.ok(tierD.length > 0 && tierD.length <= TIER_D_MAX_CHARS, `Tier-D 长度 ${tierD.length} 越界`);
  const matchedAuto = [...tierD.matchAll(/自动蒸馏的 Redis 哨兵故障排查结论/g)].length;
  assert.ok(matchedAuto >= 3, `v2 Tier-D 不应再有 auto 最多 2 席且需 accessCount>0 死锁，实际命中 ${matchedAuto} 条`);

  ctx.dispose();
});

function segLines(text, label) {
  const lines = text.split('\n');
  const i = lines.indexOf(label);
  if (i < 0) return 0;
  let n = 0;
  for (let j = i + 1; j < lines.length && lines[j].startsWith('- '); j += 1) n += 1;
  return n;
}

test('legacy 注入兼容：3 person + 3 promise + 20 event → 三段标题都在、六条一条不少、总字符 ≤2000', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, {
    dbPath: path.join(TMP, 'inject-mix.db'),
    autoInject: true,
    injectMode: 'legacy',
    now: () => clock,
  });
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
  assert.equal(INJECT_SEGMENTS.reduce((s, seg) => s + seg.cap, 0), INJECT_HARD_LIMIT);
  ctx.dispose();
});
