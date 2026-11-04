import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../src/index.mjs';
import { SearchIndex } from '../src/search.mjs';
import { decayFactor } from '../src/schema.mjs';

function fixture(options = {}) {
  let time = Date.UTC(2026, 0, 1);
  const tools = new Map();
  const sections = new Map();
  const services = new Map();
  const hooks = new Map();
  const ctx = {
    tools: { register: x => { tools.set(x.name, x); return () => {}; } },
    systemPrompt: { section: x => { sections.set(x.name, x); return () => {}; } },
    provide: (name, service) => { services.set(name, service); return () => {}; },
    effect: fn => fn(),
    on: (name, handler) => { hooks.set(name, handler); return () => {}; },
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, autoInject: true, now: () => time, ...options });
  return { tools, sections, services, hooks, app, advance: n => { time += n; } };
}

test('recall refreshes score and warmed injection', async () => {
  const f = fixture();
  try {
    await f.tools.get('memjudge_remember').execute({ text: '钟摆停在七点', source: 'auto:chat#abcdef12-t0', kind: 'event' });
    const inject = [...f.sections.values()][0].text;
    assert.doesNotMatch(inject(), /钟摆停在七点/);
    f.advance(30 * 86400000);
    const service = f.services.get('memjudge');
    const before = await service.recallByQuery('钟摆');
    const tool = f.tools.get('memjudge_recall');
    const hit = await tool.execute({ query: '钟摆' });
    assert.equal(hit.denied, false);
    assert.match(inject(), /钟摆停在七点/);
    const after = await service.recallByQuery('钟摆');
    assert.ok(after.hits[0].score > before.hits[0].score);
    const repeat = await tool.execute({ query: '钟摆' });
    assert.equal(repeat.denied, false);
  } finally { f.app.dispose(); }
});

test('touch keeps the index alive while vector warming is pending', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.MEMJUDGE_EMBED_KEY;
  const oldSearch = SearchIndex.prototype.search;
  const indexes = [];
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  process.env.MEMJUDGE_EMBED_KEY = 'fixture-key-12345';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    started();
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: Array(body.dimensions).fill(0.5) })) }) };
  };
  SearchIndex.prototype.search = function (...args) { indexes.push(this); return oldSearch.apply(this, args); };
  let f;
  try {
    f = fixture({ vector: true, vectorCacheDir: '' });
    await f.tools.get('memjudge_remember').execute({ text: '预热竞态钟摆七点', kind: 'event' });
    const tool = f.tools.get('memjudge_recall');
    await tool.execute({ query: '预热竞态钟摆' });
    await entered;
    await Promise.all([tool.execute({ query: '预热竞态钟摆' }), tool.execute({ query: '预热竞态钟摆' })]);
    assert.ok(indexes.length >= 3);
    assert.ok(indexes.every(ix => ix === indexes[0]));
    assert.equal(indexes[0].docs[0].accessCount, 3);
    release();
    for (let i = 0; i < 100 && !indexes[0].hasVectors; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(indexes[0].hasVectors, true);
  } finally {
    release?.();
    f?.app.dispose();
    SearchIndex.prototype.search = oldSearch;
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MEMJUDGE_EMBED_KEY;
    else process.env.MEMJUDGE_EMBED_KEY = oldKey;
  }
});

test('read-only and no-hit recalls retain cached index and injection', async () => {
  const original = DatabaseSync.prototype.prepare;
  let dumps = 0, updates = 0;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql === 'SELECT * FROM memories ORDER BY created_at, id') dumps++;
    const statement = original.call(this, sql, ...args);
    if (!sql.startsWith('UPDATE memories SET last_accessed = ?')) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === 'run') return (...params) => { updates++; return target.run(...params); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  let f;
  try {
    f = fixture();
    await f.tools.get('memjudge_remember').execute({ text: '钟摆停在七点', kind: 'event' });
    const inject = [...f.sections.values()][0].text;
    const service = f.services.get('memjudge');
    inject();
    await service.recallByQuery('钟摆');
    const warmed = dumps;
    await service.recallByQuery('钟摆');
    await f.tools.get('memjudge_recall').execute({ query: 'zzzzunmatched' });
    inject();
    assert.equal(dumps, warmed);
    assert.equal(updates, 0);
  } finally {
    f?.app.dispose();
    DatabaseSync.prototype.prepare = original;
  }
});

test('a touch that writes then throws still invalidates both caches', async () => {
  const original = DatabaseSync.prototype.prepare;
  let fail = false;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const statement = original.call(this, sql, ...args);
    if (!sql.startsWith('UPDATE memories SET last_accessed = ?')) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === 'run') return (...params) => {
        const result = target.run(...params);
        if (fail) throw new Error('fixture after touch');
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  let f;
  try {
    f = fixture();
    await f.tools.get('memjudge_remember').execute({ text: '钟摆停在七点', source: 'auto:chat#abcdef12-t0', kind: 'event' });
    const inject = [...f.sections.values()][0].text;
    assert.doesNotMatch(inject(), /钟摆停在七点/);
    f.advance(30 * 86400000);
    const service = f.services.get('memjudge');
    const before = await service.recallByQuery('钟摆');
    fail = true;
    await assert.rejects(() => f.tools.get('memjudge_recall').execute({ query: '钟摆' }), /fixture after touch/);
    fail = false;
    assert.match(inject(), /钟摆停在七点/);
    const after = await service.recallByQuery('钟摆');
    assert.ok(after.hits[0].score > before.hits[0].score);
  } finally {
    f?.app.dispose();
    DatabaseSync.prototype.prepare = original;
  }
});

for (const mode of ['before-first', 'before-second', 'after-second']) test(`multi-hit failure ${mode} rebuilds from database`, async () => {
  const prepare = DatabaseSync.prototype.prepare;
  let db, count = 0, enabled = false, dumps = 0;
  const attempted = [];
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql === 'SELECT * FROM memories ORDER BY created_at, id') dumps++;
    const statement = prepare.call(this, sql, ...args);
    if (!sql.startsWith('UPDATE memories SET last_accessed = ?')) return statement;
    db = this;
    return new Proxy(statement, { get(target, key) {
      if (key === 'run') return (...params) => {
        if (enabled) attempted.push(params.at(-1));
        if (enabled && ++count === (mode === 'before-first' ? 1 : 2) && mode !== 'after-second') throw new Error('fixture failure');
        const result = target.run(...params);
        if (enabled && count === 2 && mode === 'after-second') throw new Error('fixture failure');
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const oldSearch = SearchIndex.prototype.search;
  const indexes = [];
  SearchIndex.prototype.search = function (...args) { indexes.push(this); return oldSearch.apply(this, args); };
  let f;
  try {
    f = fixture();
    const remember = f.tools.get('memjudge_remember');
    await remember.execute({ text: '钟摆观察记录甲段七点', kind: 'event', source: 'auto:chat#abcdef12-t0' });
    await remember.execute({ text: '钟摆观察记录乙段八点', kind: 'event', source: 'auto:chat#abcdef12-t1' });
    const inject = [...f.sections.values()][0].text;
    const hook = f.hooks.get('agent/pre-step');
    const step = () => hook({ agent: { session: { id: 'fixture-session' } }, turn: 1 }, async () => ({ kind: 'enter', messages: [] }));
    await step();
    assert.doesNotMatch(inject(), /钟摆观察记录/);
    const service = f.services.get('memjudge');
    const before = await service.recallByQuery('钟摆观察记录');
    assert.equal(before.hits.length, 2);
    const oldIndex = indexes.at(-1);
    f.advance(12 * 86400000);
    enabled = true;
    await assert.rejects(() => f.tools.get('memjudge_recall').execute({ query: '钟摆观察记录' }), /fixture failure/);
    enabled = false;
    const rows = db.prepare('SELECT id, access_count, last_accessed FROM memories').all();
    assert.equal(rows.reduce((n, row) => n + row.access_count, 0), mode === 'before-first' ? 0 : mode === 'before-second' ? 1 : 2);
    for (const row of rows) {
      const changed = mode !== 'before-first' && (row.id === attempted[0] || (mode === 'after-second' && row.id === attempted[1]));
      assert.equal(row.access_count, changed ? 1 : 0, row.id);
      assert.equal(row.last_accessed, changed ? Date.UTC(2026, 0, 13) : Date.UTC(2026, 0, 1), row.id);
    }
    const injection = inject();
    for (const row of rows) {
      const text = oldIndex.docs.find(d => d.id === row.id).text;
      assert.equal(injection.includes(text), row.access_count === 1, row.id);
    }
    const cachedDumps = dumps;
    await step();
    assert.equal(dumps, cachedDumps);
    await service.recallByQuery('钟摆观察记录');
    const rebuilt = indexes.at(-1);
    assert.notEqual(rebuilt, oldIndex);
    for (const row of rows) {
      const doc = rebuilt.docs.find(d => d.id === row.id);
      assert.equal(doc.accessCount, row.access_count);
      assert.equal(doc.lastAccessed, row.last_accessed);
    }
  } finally {
    f?.app.dispose();
    DatabaseSync.prototype.prepare = prepare;
    SearchIndex.prototype.search = oldSearch;
  }
});

test('delayed old-generation recall rejects after content change', async () => {
  const original = SearchIndex.prototype.searchAsync;
  const vectorDescriptor = Object.getOwnPropertyDescriptor(SearchIndex.prototype, 'hasVectors');
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.MEMJUDGE_EMBED_KEY;
  const oldNoSecrets = process.env.MEMJUDGE_NO_SECRETS;
  process.env.MEMJUDGE_NO_SECRETS = '1';
  process.env.MEMJUDGE_EMBED_KEY = 'fixture-generation-key';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: Array(body.dimensions).fill(0.5) })) }) };
  };
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const indexes = [];
  Object.defineProperty(SearchIndex.prototype, 'hasVectors', { configurable: true, get: () => true });
  SearchIndex.prototype.searchAsync = async function (...args) {
    indexes.push(this);
    const result = this.search(...args);
    if (indexes.length === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  let f;
  try {
    f = fixture({ vector: true, vectorCacheDir: '' });
    const remember = f.tools.get('memjudge_remember');
    await remember.execute({ text: '异步代际钟摆七点', kind: 'event' });
    const pending = f.tools.get('memjudge_recall').execute({ query: '异步代际钟摆' });
    await entered;
    await remember.execute({ text: '另一个语料记录', kind: 'event' });
    await f.services.get('memjudge').recallByQuery('异步代际钟摆');
    assert.notEqual(indexes[0], indexes[1]);
    release();
    await assert.rejects(pending, /memjudge recall stale: content changed/);
    assert.equal(indexes[1].docs.find(d => d.text === '异步代际钟摆七点').accessCount, 0);
  } finally {
    release?.();
    f?.app.dispose();
    SearchIndex.prototype.searchAsync = original;
    Object.defineProperty(SearchIndex.prototype, 'hasVectors', vectorDescriptor);
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MEMJUDGE_EMBED_KEY;
    else process.env.MEMJUDGE_EMBED_KEY = oldKey;
    if (oldNoSecrets === undefined) delete process.env.MEMJUDGE_NO_SECRETS;
    else process.env.MEMJUDGE_NO_SECRETS = oldNoSecrets;
  }
});

test('dual decay and capture corpus remain consistent through touch', async () => {
  const prepare = DatabaseSync.prototype.prepare;
  const search = SearchIndex.prototype.search;
  let dumps = 0, db, current;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql === 'SELECT * FROM memories ORDER BY created_at, id') dumps++;
    if (sql.startsWith('UPDATE memories SET last_accessed = ?')) db = this;
    return prepare.call(this, sql, ...args);
  };
  SearchIndex.prototype.search = function (...args) { current = this; return search.apply(this, args); };
  let f;
  try {
    f = fixture();
    const remember = f.tools.get('memjudge_remember');
    await remember.execute({ text: '双档钟摆冷记录七点', kind: 'event', importance: 0.4, source: 'auto:chat#abcdef12-t0' });
    await remember.execute({ text: '双档钟摆暖记录八点', kind: 'event', importance: 0.8, source: 'auto:chat#abcdef12-t1' });
    const inject = [...f.sections.values()][0].text;
    const hook = f.hooks.get('agent/pre-step');
    const step = () => hook({ agent: { session: { id: 'fixture-session' } }, turn: 1 }, async () => ({ kind: 'enter', messages: [] }));
    await step();
    const corpusDumps = dumps;
    await step();
    assert.equal(dumps, corpusDumps);
    assert.doesNotMatch(inject(), /双档钟摆/);
    const service = f.services.get('memjudge');
    const initial = await service.recallByQuery('双档钟摆');
    f.advance(12 * 86400000);
    const before = await service.recallByQuery('双档钟摆');
    assert.equal(before.hits.length, 2);
    const ix = current;
    const beforeDocs = ix.docs.map(d => ({ ...d }));
    const at = Date.UTC(2026, 0, 13);
    assert.ok(Math.abs(decayFactor(beforeDocs.find(d => d.importance === 0.4), at).value - 0.5) < 1e-6);
    assert.ok(Math.abs(decayFactor(beforeDocs.find(d => d.importance === 0.8), at).value - Math.pow(0.5, 0.1)) < 1e-6);
    for (const hit of before.hits) {
      const doc = beforeDocs.find(d => d.id === hit.id);
      const baseline = initial.hits.find(h => h.id === hit.id);
      const expected = doc.importance === 0.4 ? 0.5 : Math.pow(0.5, 0.1);
      assert.ok(Math.abs(hit.score / baseline.score - expected) < 1e-6, `${hit.id}: ${hit.score / baseline.score}`);
    }
    await f.tools.get('memjudge_recall').execute({ query: '双档钟摆' });
    const rows = db.prepare('SELECT id, access_count, last_accessed FROM memories').all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const doc = ix.docs.find(d => d.id === row.id);
      assert.equal(row.access_count, 1);
      assert.equal(doc.accessCount, row.access_count);
      assert.equal(doc.lastAccessed, row.last_accessed);
      assert.equal(decayFactor(doc, at).value, 1);
    }
    assert.match(inject(), /双档钟摆/);
    const after = await service.recallByQuery('双档钟摆');
    assert.equal(current, ix);
    for (const hit of after.hits) assert.ok(hit.score > before.hits.find(h => h.id === hit.id).score);
    const afterOtherWork = dumps;
    await step();
    assert.equal(dumps, afterOtherWork);
  } finally {
    f?.app.dispose();
    DatabaseSync.prototype.prepare = prepare;
    SearchIndex.prototype.search = search;
  }
});
