import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SearchIndex } from '../src/search.mjs';
import { apply, resolveConfig, DEFAULTS } from '../src/index.mjs';

async function scenario(kind) {
  const search = SearchIndex.prototype.searchExpanded;
  const prepare = DatabaseSync.prototype.prepare;
  const exec = DatabaseSync.prototype.exec;
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network disabled'); };
  let release, entered, db, failCommit = false, hold = true;
  const started = new Promise(resolve => { entered = resolve; });
  SearchIndex.prototype.searchExpanded = async function (query, options) {
    const found = this.search(query, options);
    if (hold) { hold = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return found;
  };
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql.startsWith('UPDATE memories SET last_accessed = ?')) db = this;
    return prepare.call(this, sql, ...args);
  };
  DatabaseSync.prototype.exec = function (sql, ...args) {
    if (failCommit && sql === 'COMMIT') throw new Error('fixture commit failure');
    return exec.call(this, sql, ...args);
  };
  const tools = new Map(), services = new Map(), hooks = new Map();
  const ctx = {
    tools: { register: x => { tools.set(x.name, x); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    provide: (name, service) => { services.set(name, service); return () => {}; },
    effect: fn => fn(), on: (name, fn) => { hooks.set(name, fn); return () => {}; },
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: true, autoInject: false });
  try {
    const remember = tools.get('memjudge_remember');
    const forget = tools.get('memjudge_forget');
    const recall = tools.get('memjudge_recall');
    const item = kind === 'empty-write' ? null : await remember.execute({ text: '钟摆记录七点', kind: 'event' });
    const pending = kind === 'service' ? services.get('memjudge').recallByQuery('钟摆') : recall.execute({ query: '钟摆' });
    await started;
    if (kind === 'delete' || kind === 'service' || kind === 'fault') {
      if (kind === 'fault') failCommit = true;
      if (kind === 'fault') await assert.rejects(forget.execute({ id: item.id }), /instance fault/);
      else await forget.execute({ id: item.id });
      failCommit = false;
    } else if (kind === 'empty-write') {
      await remember.execute({ text: '钟摆记录七点', kind: 'event' });
    } else if (kind === 'idempotent') {
      await remember.execute({ text: '钟摆记录七点', kind: 'event' });
    } else if (kind === 'touch') {
      await recall.execute({ query: '钟摆' });
    } else if (kind === 'no-delete') {
      await forget.execute({ id: 'missing-id' });
      await forget.execute({ id: item.id, dryRun: true });
    }
    release();
    if (['delete', 'service', 'empty-write', 'idempotent'].includes(kind)) {
      await assert.rejects(pending, /memjudge recall stale: content changed/);
    } else if (kind === 'fault') {
      await assert.rejects(pending, /memjudge instance fault/);
    } else {
      assert.equal((await pending).denied, false);
    }
    if (kind === 'touch' || kind === 'no-delete' || kind === 'idempotent') {
      const row = db.prepare('SELECT access_count FROM memories WHERE id = ?').get(item.id);
      assert.equal(row.access_count, kind === 'touch' ? 2 : kind === 'no-delete' ? 1 : 0);
    }
  } finally {
    release?.();
    app.dispose();
    SearchIndex.prototype.searchExpanded = search;
    DatabaseSync.prototype.prepare = prepare;
    DatabaseSync.prototype.exec = exec;
    globalThis.fetch = fetch;
  }
}

for (const kind of ['delete', 'empty-write', 'fault', 'service', 'touch', 'no-delete', 'idempotent']) {
  test(`recall content generation: ${kind}`, { timeout: 5000 }, () => scenario(kind));
}

test('configuration defaults and strict booleans', () => {
  assert.equal(resolveConfig({}).expand, DEFAULTS.expand);
  assert.equal(resolveConfig({}).llmSelect, DEFAULTS.llmSelect);
  for (const key of ['expand', 'llmSelect']) {
    assert.equal(resolveConfig({ [key]: true })[key], true);
    for (const value of [false, null, 1, 'true']) assert.equal(resolveConfig({ [key]: value })[key], false);
  }
});

for (const [expand, llmSelect, expected] of [[true, false, 'expanded'], [false, true, 'select'], [true, true, 'expanded']]) {
  test(`branch expand=${expand} select=${llmSelect}`, { timeout: 5000 }, async () => {
    const oldExpanded = SearchIndex.prototype.searchExpanded, oldAsync = SearchIndex.prototype.searchAsync;
    const oldFetch = globalThis.fetch;
    let branch;
    globalThis.fetch = () => { throw new Error('network disabled'); };
    SearchIndex.prototype.searchExpanded = async function (q, opts) { branch = 'expanded'; return this.search(q, opts); };
    SearchIndex.prototype.searchAsync = async function (q, opts) { branch = 'select'; return this.search(q, opts); };
    const tools = new Map();
    const ctx = { tools: { register: x => (tools.set(x.name, x), () => {}) }, systemPrompt: { section: () => () => {} }, effect: fn => fn(), on: () => () => {} };
    let app;
    try {
      app = apply(ctx, { dbPath: ':memory:', vector: false, expand, llmSelect });
      await tools.get('memjudge_recall').execute({ query: 'clock' });
      assert.equal(branch, expected);
    } finally {
      app?.dispose();
      SearchIndex.prototype.searchExpanded = oldExpanded;
      SearchIndex.prototype.searchAsync = oldAsync;
      globalThis.fetch = oldFetch;
    }
  });
}
