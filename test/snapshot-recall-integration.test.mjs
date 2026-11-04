import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../src/index.mjs';
import { open } from '../src/store.mjs';
import { createContentSnapshotView } from '../src/content-snapshot-view.mjs';

test('snapshot recall uses current external content and service stays read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-snapshot-recall-'));
  const path = join(dir, 'fixture.db');
  const tools = new Map();
  let service, store, app, other;
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network disabled'); };
  const ctx = { tools: { register: t => (tools.set(t.name, t), () => {}) },
    systemPrompt: { section: () => () => {} }, provide: (_n, s) => { service = s; return () => {}; },
    effect: fn => fn(), on: () => () => {} };
  try {
    app = apply(ctx, { dbPath: path, vector: false, expand: false, llmSelect: false, experimentalSnapshotRecall: true },
      { storeFactory(p, o) { store = open(p, o); return store; } });
    const item = await tools.get('memjudge_remember').execute({ text: '港口人数为27人。' });
    const id = item.id;
    other = new DatabaseSync(path);
    other.prepare('UPDATE memories SET text=? WHERE id=?').run('港口人数为31人。', id);
    const before = store.get(id, false).access_count;
    const result = await service.recallByQuery('港口人数');
    assert.ok(result.hits.some(h => h.text.includes('31')));
    assert.equal(store.get(id, false).access_count, before);
    const tool = await tools.get('memjudge_recall').execute({ query: '港口人数' });
    assert.ok(tool.hits.some(h => h.text.includes('31')));
    assert.equal(store.get(id, false).access_count, before + 1);
    const pendingService = service.recallByQuery('港口人数');
    other.prepare('UPDATE memories SET text=? WHERE id=?').run('港口人数为32人。', id);
    await assert.rejects(pendingService, /stale/);
    const pendingTool = tools.get('memjudge_recall').execute({ query: '港口人数' });
    other.prepare('UPDATE memories SET text=? WHERE id=?').run('港口人数为33人。', id);
    await assert.rejects(pendingTool, /stale/);
    other.prepare('DELETE FROM memories WHERE id=?').run(id);
    assert.equal((await service.recallByQuery('港口人数')).hits.length, 0);
  } finally {
    other?.close(); app?.dispose(); globalThis.fetch = fetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('touch rollback failure faults the shared store', () => {
  let fault;
  const store = open(':memory:', { onFault: error => { fault = error; } });
  const db = store.raw();
  const exec = db.exec;
  try {
    const a = store.put({ text: '港口人数为27人。' });
    const view = createContentSnapshotView(store, () => 0);
    db.exec = function(sql) {
      if (sql === 'ROLLBACK') throw new Error('rollback fixture');
      return exec.call(this, sql);
    };
    assert.throws(() => store.touchSnapshot([a.id, 'missing'], 123, view.version, () => 0), /cleanup failed/);
    assert.ok(fault);
    assert.throws(() => store.get(a.id), /store fault/);
  } finally {
    db.exec = exec;
    if (db.isTransaction) db.exec('ROLLBACK');
    store.close();
  }
});

test('snapshot configuration rejects incompatible settings before opening store', () => {
  const ctx = { tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} }, effect: fn => fn(), on: () => () => {} };
  let opened = false;
  assert.throws(() => apply(ctx, { experimentalSnapshotRecall: true, vector: true },
    { storeFactory() { opened = true; throw new Error('opened'); } }), /requires vector/);
  assert.equal(opened, false);
});

for (const entry of ['stats', 'forget']) {
  test(`snapshot ${entry} ignores mutated vector setting`, async () => {
    const tools = new Map();
    const ctx = { tools: { register: t => (tools.set(t.name, t), () => {}) },
      systemPrompt: { section: () => () => {} }, effect: fn => fn(), on: () => () => {} };
    const previousFetch = globalThis.fetch;
    let reads = 0, writes = 0, network = 0;
    globalThis.fetch = () => { network++; throw new Error('network disabled'); };
    const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, experimentalSnapshotRecall: true },
      { storeFactory(p, opts) {
        const store = open(p, opts);
        store.allVectors = () => { reads++; throw new Error('vector read prohibited'); };
        store.putVectors = () => { writes++; throw new Error('vector write prohibited'); };
        return store;
      } });
    try {
      await tools.get('memjudge_remember').execute({ text: '港口人数为27人。' });
      assert.equal((await tools.get('memjudge_stats').execute({})).memories, 1);
      await tools.get('memjudge_remember').execute({ text: '港口人数为31人。' });
      app.config.vector = true;
      if (entry === 'stats') {
        const result = await tools.get('memjudge_stats').execute({});
        assert.equal(result.memories, 2);
      } else {
        const result = await tools.get('memjudge_forget').execute({ query: '港口人数', limit: 1 });
        assert.equal(result.count, 1);
        assert.equal((await tools.get('memjudge_stats').execute({})).memories, 1);
      }
      assert.equal(reads, 0);
      assert.equal(writes, 0);
      assert.equal(network, 0);
    } finally { app.dispose(); globalThis.fetch = previousFetch; }
  });
}

test('legacy mode retains dynamic vector setting', async () => {
  const tools = new Map();
  const ctx = { tools: { register: t => (tools.set(t.name, t), () => {}) },
    systemPrompt: { section: () => () => {} }, effect: fn => fn(), on: () => () => {} };
  let reads = 0;
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false },
    { storeFactory(p, opts) {
      const store = open(p, opts);
      store.allVectors = () => { reads++; throw new Error('vector read sentinel'); };
      return store;
    } });
  try {
    app.config.vector = true;
    await assert.rejects(tools.get('memjudge_stats').execute({}), /vector read sentinel/);
    assert.equal(reads, 1);
  } finally { app.dispose(); }
});

test('snapshot mode remains fixed when exposed config changes', async () => {
  const tools = new Map();
  const ctx = { tools: { register: t => (tools.set(t.name, t), () => {}) },
    systemPrompt: { section: () => () => {} }, effect: fn => fn(), on: () => () => {} };
  let snapshots = 0;
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, experimentalSnapshotRecall: true },
    { storeFactory(p, opts) {
      const store = open(p, opts);
      const snapshot = store.contentSnapshot;
      store.contentSnapshot = (...args) => { snapshots++; return snapshot(...args); };
      return store;
    } });
  try {
    await tools.get('memjudge_remember').execute({ text: '港口人数为27人。' });
    app.config.experimentalSnapshotRecall = false;
    app.config.expand = true;
    app.config.llmSelect = true;
    app.config.vector = true;
    const result = await tools.get('memjudge_recall').execute({ query: '港口人数' });
    assert.ok(result.hits.some(h => h.text.includes('27')));
    assert.equal(snapshots, 1);
  } finally { app.dispose(); }
});

test('batch touch rolls back on missing row and stale version', () => {
  const store = open(':memory:');
  try {
    const a = store.put({ text: '港口人数为27人。' });
    const view = createContentSnapshotView(store, () => 0);
    assert.throws(() => store.touchSnapshot([a.id, 'missing'], 123, view.version, () => 0), /stale/);
    assert.equal(store.get(a.id, false).access_count, 0);
    assert.throws(() => store.touchSnapshot([a.id], 123, view.version, () => 1), /stale/);
    assert.equal(store.get(a.id, false).access_count, 0);
    assert.equal(store.raw().isTransaction, false);
  } finally { store.close(); }
});

test('external version change blocks touch and post-commit change invalidates view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-touch-version-'));
  const path = join(dir, 'fixture.db');
  const store = open(path);
  const other = new DatabaseSync(path);
  const db = store.raw();
  const exec = db.exec;
  try {
    const item = store.put({ text: '港口人数为27人。' });
    const old = createContentSnapshotView(store, () => 0);
    other.prepare('UPDATE memories SET text=? WHERE id=?').run('港口人数为31人。', item.id);
    assert.throws(() => store.touchSnapshot([item.id], 123, old.version, () => 0), /stale/);
    assert.equal(store.get(item.id, false).access_count, 0);
    const view = createContentSnapshotView(store, () => 0);
    db.exec = function(sql) {
      const result = exec.call(this, sql);
      if (sql === 'COMMIT') other.prepare('UPDATE memories SET text=? WHERE id=?').run('港口人数为33人。', item.id);
      return result;
    };
    assert.throws(() => store.touchSnapshot([item.id], 123, view.version, () => 0), /stale/);
    assert.throws(() => view.assertCurrent(), /stale/);
    assert.equal(store.get(item.id, false).access_count, 1);
  } finally {
    db.exec = exec; other.close(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uncertain commit faults store even after rollback', () => {
  const store = open(':memory:');
  const db = store.raw();
  const exec = db.exec;
  try {
    const item = store.put({ text: '港口人数为27人。' });
    const view = createContentSnapshotView(store, () => 0);
    db.exec = function(sql) {
      if (sql === 'COMMIT') throw new Error('commit fixture');
      return exec.call(this, sql);
    };
    assert.throws(() => store.touchSnapshot([item.id], 123, view.version, () => 0), /commit fixture/);
    assert.throws(() => store.get(item.id), /store fault/);
  } finally { db.exec = exec; if (db.isTransaction) db.exec('ROLLBACK'); store.close(); }
});

test('batch trigger failure rolls back earlier touches', () => {
  const store = open(':memory:');
  try {
    const a = store.put({ text: '港口人数为27人。' });
    const b = store.put({ text: '港口人数为31人。' });
    const db = store.raw();
    db.exec(`CREATE TRIGGER fail_touch BEFORE UPDATE OF access_count ON memories WHEN OLD.id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'touch fixture'); END`);
    const view = createContentSnapshotView(store, () => 0);
    assert.throws(() => store.touchSnapshot([a.id, b.id], 123, view.version, () => 0), /touch fixture/);
    assert.equal(store.get(a.id, false).access_count, 0);
    assert.equal(store.get(b.id, false).access_count, 0);
    assert.equal(db.isTransaction, false);
  } finally { store.close(); }
});

for (const stage of ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']) {
  test(`${stage} throws after taking effect`, () => {
    const store = open(':memory:');
    const db = store.raw();
    const exec = db.exec;
    try {
      const a = store.put({ text: '港口人数为27人。' });
      const view = createContentSnapshotView(store, () => 0);
      db.exec = function(sql) {
        const result = exec.call(this, sql);
        if (sql === stage) throw new Error('after fixture');
        return result;
      };
      const ids = stage === 'ROLLBACK' ? [a.id, 'missing'] : [a.id];
      assert.throws(() => store.touchSnapshot(ids, 123, view.version, () => 0), /after fixture|cleanup failed/);
      assert.equal(db.isTransaction, false);
      if (stage === 'BEGIN IMMEDIATE') assert.equal(store.get(a.id, false).access_count, 0);
      else assert.throws(() => store.get(a.id, false), /store fault/);
    } finally { db.exec = exec; if (db.isTransaction) db.exec('ROLLBACK'); store.close(); }
  });
}

test('empty snapshot result does not touch records', async () => {
  const tools = new Map();
  const ctx = { tools: { register: t => (tools.set(t.name, t), () => {}) },
    systemPrompt: { section: () => () => {} }, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, experimentalSnapshotRecall: true });
  try {
    const result = await tools.get('memjudge_recall').execute({ query: '港口人数' });
    assert.equal(result.hits.length, 0);
    assert.equal(result.denied, true);
  } finally { app.dispose(); }
});

test('default mode remains legacy after exposed experimental flag changes', async () => {
  const tools = new Map();
  const ctx = { tools: { register: t => (tools.set(t.name, t), () => {}) },
    systemPrompt: { section: () => () => {} }, effect: fn => fn(), on: () => () => {} };
  let snapshots = 0;
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false },
    { storeFactory(p, opts) {
      const store = open(p, opts);
      const snapshot = store.contentSnapshot;
      store.contentSnapshot = (...args) => { snapshots++; return snapshot(...args); };
      return store;
    } });
  try {
    await tools.get('memjudge_remember').execute({ text: '港口人数为27人。' });
    app.config.experimentalSnapshotRecall = true;
    const result = await tools.get('memjudge_recall').execute({ query: '港口人数' });
    assert.ok(result.hits.length);
    assert.equal(snapshots, 0);
  } finally { app.dispose(); }
});

test('snapshot limit failure propagates through recall without touch', async () => {
  const tools = new Map();
  const ctx = { tools: { register: t => (tools.set(t.name, t), () => {}) },
    systemPrompt: { section: () => () => {} }, effect: fn => fn(), on: () => () => {} };
  let store;
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, experimentalSnapshotRecall: true },
    { storeFactory(p, opts) {
      store = open(p, opts);
      const snapshot = store.contentSnapshot;
      store.contentSnapshot = () => snapshot({ maxRows: 0 });
      return store;
    } });
  try {
    const item = await tools.get('memjudge_remember').execute({ text: '港口人数为27人。' });
    await assert.rejects(tools.get('memjudge_recall').execute({ query: '港口人数' }), /limit/);
    assert.equal(store.get(item.id, false).access_count, 0);
    assert.equal(store.raw().isTransaction, false);
  } finally { app.dispose(); }
});

for (const mode of ['WAL', 'DELETE']) {
  test(`${mode} external writes are checked around the touch lock`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'memjudge-touch-lock-'));
    const path = join(dir, 'fixture.db');
    const store = open(path);
    const db = store.raw();
    const other = new DatabaseSync(path);
    const exec = db.exec;
    try {
      db.exec(`PRAGMA journal_mode=${mode}`);
      other.exec('PRAGMA busy_timeout=0');
      const item = store.put({ text: '港口人数为27人。' });
      const old = createContentSnapshotView(store, () => 0);
      db.exec = function(sql) {
        if (sql === 'BEGIN IMMEDIATE') other.prepare('UPDATE memories SET text=? WHERE id=?').run('港口人数为31人。', item.id);
        return exec.call(this, sql);
      };
      assert.throws(() => store.touchSnapshot([item.id], 123, old.version, () => 0), /stale/);
      db.exec = exec;
      const current = createContentSnapshotView(store, () => 0);
      let locked = false;
      db.exec = function(sql) {
        const result = exec.call(this, sql);
        if (sql === 'BEGIN IMMEDIATE') {
          assert.throws(() => other.prepare('UPDATE memories SET text=? WHERE id=?').run('港口人数为32人。', item.id), /locked|busy/i);
          locked = true;
        }
        return result;
      };
      store.touchSnapshot([item.id], 123, current.version, () => 0);
      assert.equal(locked, true);
      assert.equal(store.get(item.id, false).access_count, 1);
    } finally {
      db.exec = exec; other.close(); store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
