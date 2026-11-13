import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  open,
  STORE_SCHEMA_VERSION,
  STORAGE_LIMIT_BYTES,
  MEMORY_KINDS,
  MEMORY_CATEGORIES,
  DEFAULT_MEMORY_CATEGORY,
} from '../src/store.mjs';
import {
  quantize,
  quantizeWithScale,
  dequantize,
  cosineInt8,
  findMissingVectors,
  syncStoreVectors,
  searchVectors,
} from '../src/vector.mjs';
import {
  contentHash,
  kindToCategory,
  categoryToKind,
  normalizeCategory,
  isPinnedMemory,
  assertTextStable,
} from '../src/schema.mjs';

function tmpDbPath(prefix = 'v2-v8-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'test.db');
}

test('Schema v8: 八张正交核心表结构与外键/索引完整就绪', (t) => {
  const dbPath = tmpDbPath('v8-ddl-');
  const store = open(dbPath);
  const db = store.raw();

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const expectedTables = [
    'spaces',
    'memories',
    'memory_revisions',
    'entity_slots',
    'vectors',
    'wiki_pages',
    'ingest_queue',
    'meta',
  ];
  for (const exp of expectedTables) {
    assert.ok(tables.includes(exp), `核心表 ${exp} 必须存在，当前库内表: ${tables.join(', ')}`);
  }

  // 验证 spaces 表存在 global 默认空间
  const spaces = store.listSpaces();
  assert.ok(spaces.length >= 1);
  assert.ok(spaces.some((s) => s.spaceId === 'global'));

  // 验证 PRAGMA 外键与 WAL
  const fk = db.prepare('PRAGMA foreign_keys').get();
  assert.equal(fk.foreign_keys, 1, 'PRAGMA foreign_keys 必须开启');

  // 验证单活状态槽位部分唯一索引存在
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(indexes.includes('idx_memories_active_slot'), 'idx_memories_active_slot 部分唯一索引必须存在');
  assert.ok(indexes.includes('idx_slots_lookup'), 'idx_slots_lookup 索引必须存在');
  assert.ok(indexes.includes('idx_vectors_space'), 'idx_vectors_space 索引必须存在');

  store.close();
});

test('Schema v8: 空间空间管理 upsertSpace 与 listSpaces', () => {
  const store = open(':memory:');
  const sp1 = store.upsertSpace({
    spaceId: 'workspace:c001',
    kind: 'workspace',
    rootPath: 'F:/Dev/ProjectX',
    label: 'Project X',
    now: () => 1700000000000,
  });
  assert.equal(sp1.spaceId, 'workspace:c001');
  assert.equal(sp1.kind, 'workspace');

  const list = store.listSpaces();
  assert.ok(list.some((s) => s.spaceId === 'workspace:c001' && s.label === 'Project X'));
  assert.ok(list.some((s) => s.spaceId === 'global'));

  store.close();
});

test('Schema v8: 单活状态槽位 putState 幂等与修订版本链 (memory_revisions)', () => {
  const store = open(':memory:');

  // 首次写入状态槽
  const r1 = store.putState({
    spaceId: 'session:s1',
    slotKey: 'user:location',
    text: '用户当前在上海办公室',
    source: 'session:s1',
    reason: 'initial-location',
    now: () => 1000,
  });
  assert.ok(r1.id);
  assert.equal(r1.updated, true);

  // 读回验证状态与槽位
  const m1 = store.get(r1.id);
  assert.equal(m1.text, '用户当前在上海办公室');
  assert.equal(m1.category, 'state');
  assert.equal(m1.slotKey, 'user:location');
  assert.equal(m1.status, 'active');
  assert.equal(m1.tier, 0); // state 驻 L0

  // 相同内容幂等写入：不追加修订，仅返回 updated: false
  const r2 = store.putState({
    spaceId: 'session:s1',
    slotKey: 'user:location',
    text: '用户当前在上海办公室',
    now: () => 1050,
  });
  assert.equal(r2.id, r1.id);
  assert.equal(r2.updated, false);
  const revs1 = store.listRevisions(r1.id);
  assert.equal(revs1.length, 0, '相同内容幂等不产生 revisions');

  // 状态值更新：原地更新 memories，旧快照写入 memory_revisions，保持同 (spaceId, slotKey) 单活 1 行！
  const r3 = store.putState({
    spaceId: 'session:s1',
    slotKey: 'user:location',
    text: '用户已移动到杭州分部',
    reason: 'relocation',
    now: () => 2000,
  });
  assert.equal(r3.id, r1.id);
  assert.equal(r3.updated, true);

  const m3 = store.get(r1.id);
  assert.equal(m3.text, '用户已移动到杭州分部');
  assert.equal(m3.updatedAt, 2000);

  // 验证 memory_revisions
  const revs2 = store.listRevisions(r1.id);
  assert.equal(revs2.length, 1);
  assert.equal(revs2[0].prevText, '用户当前在上海办公室');
  assert.equal(revs2[0].reason, 'relocation');

  // 验证唯一索引保护：同一 (spaceId, slotKey) 下 active 的行只有 1 行
  const activeCount = store.raw().prepare(
    "SELECT COUNT(*) AS c FROM memories WHERE space_id = 'session:s1' AND slot_key = 'user:location' AND status = 'active'"
  ).get().c;
  assert.equal(activeCount, 1);

  store.close();
});

test('Schema v8: 显式主键向量存储 putVector、getVectors 与删除', () => {
  const store = open(':memory:');
  const mem = store.put({
    text: '这是测试向量绑定的记忆正文',
    kind: 'promise',
  });

  const int8 = new Int8Array([10, -20, 30, -40]);
  const putRes = store.putVector({
    memoryId: mem.id,
    spaceId: 'global',
    model: 'qwen3-embed',
    dims: 4,
    scale: 0.1,
    vec: int8,
    contentHash: mem.contentHash,
  });
  assert.equal(putRes.written, true);

  const list = store.getVectors({ spaces: ['global'], model: 'qwen3-embed', dims: 4 });
  assert.equal(list.length, 1);
  assert.equal(list[0].memoryId, mem.id);
  assert.equal(list[0].dims, 4);
  assert.equal(list[0].scale, 0.1);
  assert.equal(list[0].vec[0], 10);
  assert.equal(list[0].vec[1], -20);

  // CAS 防异步晚写测试：若 contentHash 与 DB memories 当前 contentHash 不符，拒绝写入
  const staleRes = store.putVector({
    memoryId: mem.id,
    spaceId: 'global',
    model: 'qwen3-embed',
    dims: 4,
    scale: 0.1,
    vec: int8,
    contentHash: 'stale-hash-123456',
    expectedContentHash: 'stale-hash-123456',
  });
  assert.equal(staleRes.written, false, 'CAS 校验失败时应当跳过写入');

  // 显式删除向量
  const delRes = store.deleteVector(mem.id);
  assert.equal(delRes, true);
  const afterDel = store.getVectors({ spaces: ['global'], model: 'qwen3-embed', dims: 4 });
  assert.equal(afterDel.length, 0);

  store.close();
});

test('Schema v8: entity_slots 槽位查询 replaceSlots 与 querySlots', () => {
  const store = open(':memory:');
  const mem = store.put({ text: '周允棠担任白鲸号船长，航速十四节', kind: 'event' });

  store.replaceSlots(mem.id, 'global', [
    { entity: '白鲸号', attr: '船长', value: '周允棠', unit: null, polarity: 1, confidence: 0.95 },
    { entity: '白鲸号', attr: '航速', value: '14', unit: '节', polarity: 1, confidence: 0.9 },
  ]);

  const slots = store.querySlots({ spaces: ['global'], entity: '白鲸号' });
  assert.equal(slots.length, 2);

  const speedSlot = store.querySlots({ spaces: ['global'], entity: '白鲸号', attr: '航速' });
  assert.equal(speedSlot.length, 1);
  assert.equal(speedSlot[0].value, '14');
  assert.equal(speedSlot[0].unit, '节');

  store.close();
});

test('Schema v8: wiki_pages 与 ingest_queue 管理', () => {
  const store = open(':memory:');

  // wiki pages
  const w1 = store.upsertWikiPage({
    spaceId: 'global',
    slug: 'rules/safety',
    title: '安全守则',
    summary: '航行安全守则总则',
    sourceIds: ['mem-1', 'mem-2'],
    dirty: 1,
    now: () => 1000,
  });
  assert.equal(w1.slug, 'rules/safety');

  const dirtyList = store.listWikiPages({ spaceId: 'global', dirtyOnly: true });
  assert.equal(dirtyList.length, 1);
  assert.equal(dirtyList[0].slug, 'rules/safety');

  store.markWikiClean(w1.pageId, 2, 1050);
  const cleanList = store.listWikiPages({ spaceId: 'global', dirtyOnly: true });
  assert.equal(cleanList.length, 0);

  // ingest queue
  const q1 = store.enqueueIngest({
    spaceId: 'session:s1',
    sessionId: 'sess-abc',
    turnNo: 1,
    payload: { prompt: 'hello', response: 'hi' },
  });
  assert.ok(q1.jobId);
  assert.equal(q1.status, 'pending');

  const jobs = store.claimIngestJobs(10);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, q1.jobId);
  assert.equal(jobs[0].status, 'processing');

  store.completeIngestJob(q1.jobId, 'completed');
  const remaining = store.claimIngestJobs(10);
  assert.equal(remaining.length, 0);

  store.close();
});

test('Schema v8: compactMemory 代谢压缩与归档降级', () => {
  const store = open(':memory:');
  const m = store.put({
    text: '第一版较长的事实描述细节...',
    kind: 'event',
    importance: 0.5,
  });

  const compacted = store.compactMemory({
    id: m.id,
    newText: '压缩后的精简事实',
    newTier: 2,
    reason: 'metabolic-compression',
    now: () => 5000,
  });

  assert.equal(compacted.id, m.id);
  assert.equal(compacted.text, '压缩后的精简事实');
  assert.equal(compacted.tier, 2);

  const revs = store.listRevisions(m.id);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].prevText, '第一版较长的事实描述细节...');
  assert.equal(revs[0].reason, 'metabolic-compression');

  store.close();
});

test('Schema v7 → v8 真实同构库无损自动迁移与 VACUUM 显式主键绑定实测', () => {
  const dbPath = tmpDbPath('v7-to-v8-test-');

  // 1. 手工构造与存量真实线上 v7 完全同构的数据库（含 7 条核心记忆：5 promise + 1 person + 1 event）
  {
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO meta (k, v) VALUES ('schema_version', '7');
      INSERT INTO meta (k, v) VALUES ('occurrences_v1_migrated', '1');

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        importance REAL NOT NULL DEFAULT 0,
        supersedes TEXT,
        source TEXT,
        kind TEXT NOT NULL DEFAULT 'event',
        tier INTEGER NOT NULL DEFAULT 3
      );
      CREATE UNIQUE INDEX ux_memories_hash ON memories(text_hash);

      CREATE TABLE memory_occurrences (
        memory_id TEXT NOT NULL,
        source TEXT,
        document_id TEXT,
        chapter INTEGER,
        para INTEGER
      );

      CREATE TABLE segments (
        ord INTEGER PRIMARY KEY,
        bits BLOB NOT NULL
      );

      CREATE TABLE vector_blob (
        k TEXT PRIMARY KEY,
        dims INTEGER NOT NULL,
        blob BLOB NOT NULL
      );
    `);

    // 写入 7 条样本：5 条 promise，1 条 person，1 条 event
    const sampleMemories = [
      { id: 'mem-p1', text: '约定1：所有密码必须加密存储', kind: 'promise', tier: 1 },
      { id: 'mem-p2', text: '约定2：日志严禁记录明文凭据', kind: 'promise', tier: 1 },
      { id: 'mem-p3', text: '约定3：生产数据库变更走工作流', kind: 'promise', tier: 1 },
      { id: 'mem-p4', text: '约定4：每次发布必须具备回滚方案', kind: 'promise', tier: 1 },
      { id: 'mem-p5', text: '约定5：接口向后兼容至少维持两个大版本', kind: 'promise', tier: 1 },
      { id: 'mem-u1', text: '用户是技术总监，偏好精炼架构报告', kind: 'person', tier: 1 },
      { id: 'mem-e1', text: '2026年11月10日系统完成核心集群机房搬迁', kind: 'event', tier: 3 },
    ];

    const insMem = rawDb.prepare(`
      INSERT INTO memories (id, text, text_hash, created_at, last_accessed, access_count, importance, supersedes, source, kind, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let t = 1700000000000;
    for (const sm of sampleMemories) {
      const h = createHash('sha256').update(sm.text).digest('hex');
      insMem.run(sm.id, sm.text, h, t, t, 1, 0.8, null, 'manual', sm.kind, sm.tier);
      t += 1000;
    }

    rawDb.close();
  }

  // 2. 使用 open(dbPath) 打开该 v7 库，验证自动触发 Schema v7 → v8 原子无损迁移
  const store = open(dbPath);
  const db = store.raw();

  // ① 验证 meta.schema_version 升至 8
  const vRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(vRow.value, '8', 'schema_version 必须无损升至 8');

  // ② 验证 spaces 自动初始化并包含 global
  const spaces = store.listSpaces();
  assert.ok(spaces.some((s) => s.spaceId === 'global'));

  // ③ 验证 7 条记忆 100% 完整保留、零丢失
  const dumped = store.dump();
  assert.equal(dumped.length, 7, '7 条历史记忆必须一条不丢');

  const p1 = store.get('mem-p1');
  assert.ok(p1);
  assert.equal(p1.text, '约定1：所有密码必须加密存储');
  assert.equal(p1.spaceId, 'global');
  assert.equal(p1.category, 'rule', 'promise 必须精准映射为 rule');
  assert.equal(p1.kind, 'promise', '向后兼容视图中 kind 必须保留为 promise');
  assert.equal(p1.tier, 0, 'promise/rule 在 v8 应当归入 L0 (tier 0)');

  const u1 = store.get('mem-u1');
  assert.ok(u1);
  assert.equal(u1.category, 'profile', 'person 必须精准映射为 profile');
  assert.equal(u1.kind, 'person', '向后兼容视图中 kind 必须保留为 person');
  assert.equal(u1.tier, 0, 'person/profile 在 v8 应当归入 L0 (tier 0)');

  const e1 = store.get('mem-e1');
  assert.ok(e1);
  assert.equal(e1.category, 'experience', 'event 必须精准映射为 experience');
  assert.equal(e1.kind, 'event', '向后兼容视图中 kind 必须保留为 event');
  assert.equal(e1.tier, 3, 'event 原 tier 3 必须如实保留');

  // ④ 验证新 vectors 显式主键绑定与 VACUUM 重排免疫性（彻底告别 rowid 漂移 Bug！）
  // 为 7 条记忆分别写入维度为 4 的向量（互不共线以保证唯一确定性检索）
  const vData = [
    [100, 20, 10, 5],
    [15, 80, 35, 10],
    [20, 30, 90, 15],
    [25, 35, 45, 85],
    [30, 40, 50, 60],
    [-10, -20, -30, -40],
    [5, 10, 15, 20],
  ];

  for (let i = 0; i < dumped.length; i += 1) {
    const memItem = dumped[i];
    const vecInt8 = new Int8Array(vData[i]);
    store.putVector({
      memoryId: memItem.id,
      spaceId: 'global',
      model: 'test-model',
      dims: 4,
      scale: 0.1,
      vec: vecInt8,
      contentHash: memItem.contentHash,
    });
  }

  // 执行 VACUUM 物理重排数据库文件！
  db.exec('VACUUM;');

  // VACUUM 之后读出向量，比对 memory_id 与向量内容是否发生任何漂移
  for (let i = 0; i < dumped.length; i += 1) {
    const memItem = dumped[i];
    const vecs = store.getVectors({ spaces: ['global'], model: 'test-model', dims: 4 });
    const match = vecs.find((v) => v.memoryId === memItem.id);
    assert.ok(match, `VACUUM 重排后 memory ${memItem.id} 的向量必须依然精确匹配`);
    assert.equal(match.contentHash, memItem.contentHash, 'content_hash 必须精确一致');
    assert.deepEqual(Array.from(match.vec), vData[i], '向量 byte 内容在 VACUUM 后绝不错位');
  }

  // ⑤ 向量差集发现与增量同步测试
  const missing = findMissingVectors(store, { spaces: ['global'], model: 'test-model', dims: 4 });
  assert.equal(missing.length, 0, '全部补齐后差集应当为空');

  // 写入一条新记忆
  const newMem = store.put({
    text: '新入库的第八条重要规范',
    kind: 'promise',
  });
  const missingAfterAdd = findMissingVectors(store, { spaces: ['global'], model: 'test-model', dims: 4 });
  assert.equal(missingAfterAdd.length, 1);
  assert.equal(missingAfterAdd[0].id, newMem.id);

  // 向量余弦检索：以 mem-p1 专属方向向量检索，最高分必为 mem-p1
  const searchRes = store.vectorSearch(new Int8Array([100, 20, 10, 5]), {
    spaces: ['global'],
    model: 'test-model',
    dims: 4,
    topK: 3,
  });
  assert.ok(searchRes.length >= 1);
  assert.equal(searchRes[0].id, 'mem-p1', '余弦最高匹配应当是 mem-p1');

  store.close();
});
