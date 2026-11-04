import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.mjs';
import { open } from '../src/store.mjs';
import { SearchIndex } from '../src/search.mjs';

test('synchronous initialization notification has initialized fault state', () => {
  const tools = new Map(), sections = new Map();
  const ctx = { tools: { register: t => (tools.set(t.name, t), () => {}) },
    systemPrompt: { section: s => (sections.set(s.name, s), () => {}) },
    effect: fn => fn(), on: () => () => {} };
  const primary = new Error('initialization fault');
  const app = apply(ctx, { dbPath: ':memory:', vector: false }, { storeFactory(path, opts) {
    opts.onFault(primary);
    return open(path, opts);
  } });
  try { assert.throws([...sections.values()][0].text, error => error.cause === primary); }
  finally { app.dispose(); }
});

for (const after of [false, true]) test(`snapshot fault gates instance after=${after}`, { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-fault-instance-'));
  const tools = new Map(), sections = new Map();
  let service, store, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const oldSearch = SearchIndex.prototype.searchExpanded, oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network disabled'); };
  SearchIndex.prototype.searchExpanded = async function(query, options) {
    const result = this.search(query, options);
    entered();
    await new Promise(resolve => { release = resolve; });
    return result;
  };
  const ctx = { tools: { register: t => (tools.set(t.name, t), () => {}) },
    systemPrompt: { section: s => (sections.set(s.name, s), () => {}) },
    provide: (_name, value) => { service = value; return () => {}; },
    effect: fn => fn(), on: () => () => {} };
  let app, db, exec;
  try {
    app = apply(ctx, { dbPath: join(dir, 'fixture.db'), vector: false, expand: true, autoInject: true },
      { storeFactory(path, opts) { store = open(path, opts); return store; } });
    await tools.get('memjudge_remember').execute({ text: '白鲸号焊缝凹陷九厘米。' });
    const inject = [...sections.values()][0].text;
    assert.match(inject(), /白鲸号/);
    assert.ok(service.stats().memories > 0);
    const pending = service.recallByQuery('白鲸号');
    await started;
    db = store.raw(); exec = db.exec;
    db.exec = function(sql) {
      if (sql === 'ROLLBACK') { if (after) exec.call(this, sql); throw new Error('rollback fixture'); }
      return exec.call(this, sql);
    };
    assert.throws(() => store.contentSnapshot(), /rollback fixture/);
    assert.throws(inject, /instance fault/);
    assert.throws(() => service.stats(), /instance fault/);
    release();
    await assert.rejects(pending, /instance fault/);
  } finally {
    release?.();
    if (db && exec) db.exec = exec;
    app?.dispose();
    SearchIndex.prototype.searchExpanded = oldSearch;
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
