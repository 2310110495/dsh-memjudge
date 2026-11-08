import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(process.argv[2] ?? 'INVALID');
assert.match(root.replaceAll('\\', '/'), /^F:\/记忆库\/\.t2-fixtures\/completion-t2-[a-f0-9-]+$/);
const file = name => { assert.match(name, /^[a-z0-9-]+\.sqlite$/); return path.join(root, name); };
registerHooks({ resolve(s, c, next) {
  if (/^(?:node:)?(?:net|http|https|http2|dns|dgram|tls|undici)(?:\/|$)/.test(s)) throw new Error('T2_NETWORK_BLOCKED');
  return next(s, c);
} });
globalThis.fetch = () => { throw new Error('T2_FETCH_BLOCKED'); };
globalThis.WebSocket = class { constructor() { throw new Error('T2_WEBSOCKET_BLOCKED'); } };
assert.equal(process.env.MEMJUDGE_NO_JIEBA, '1');
assert.equal(process.env.MEMJUDGE_NO_SECRETS, '1');
assert.equal(process.permission.has('worker'), false);
assert.equal(process.permission.has('addons'), false);
assert.throws(() => readFileSync('F:/T2_FORBIDDEN_SYNTHETIC/config.json'), { code: 'ERR_ACCESS_DENIED' });
await assert.rejects(import('node:net'), /T2_NETWORK_BLOCKED/);
assert.throws(() => fetch('https://t2.invalid'), /T2_FETCH_BLOCKED/);
assert.throws(() => new WebSocket('wss://t2.invalid'), /T2_WEBSOCKET_BLOCKED/);
if (process.argv[3] === '--child-delete') {
  assert.equal(process.permission.has('child'), false);
  const db = new DatabaseSync(file('multiprocess.sqlite'));
  db.prepare('DELETE FROM memories WHERE source = ?').run('child-target');
  db.close();
  console.log('PASS controlled child commit');
} else {
const { open } = await import('../src/store.mjs');
const { apply, toDoc } = await import('../src/index.mjs');
const { createContentSnapshotView } = await import('../src/content-snapshot-view.mjs');
const { adaptContentSnapshot } = await import('../src/content-snapshot-adapter.mjs');
let passed = 0, failed = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); passed++; results.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (e) { failed++; results.push({ name, status: 'failed', error: e.stack }); console.log('FAIL ' + name + '\n' + e.stack); }
}
function pair(name) { const p = file(name + '.sqlite'); return [open(p), open(p)]; }
function empty(s) {
  assert.equal(s.dump().length, 0); assert.equal(s.allFacts().length, 0);
  assert.equal(s.raw().prepare('SELECT count(*) AS n FROM segments').get().n, 0);
  assert.equal(s.raw().prepare('SELECT count(*) AS n FROM memory_occurrences').get().n, 0);
  assert.equal(s.injectionSnapshot().candidates.length, 0);
  assert.equal(s.contentSnapshot().rows.length, 0);
}
function fixture(name, snapshot = false, expandFn) {
  const tools = new Map(), services = new Map(); let store, render;
  const p = file(name + '.sqlite');
  const forbidden = () => { throw new Error('T2_DISABLED_DEPENDENCY'); };
  const app = apply({ tools: { register(t) { tools.set(t.name, t); return () => {}; } },
    systemPrompt: { section(section) { render = section.text; return () => {}; } },
    provide(n, s) { services.set(n, s); return () => {}; }, effect: f => f(), on: () => () => {},
  }, { dbPath: p, vector: false, expand: Boolean(expandFn), llmSelect: false, autoCapture: false,
    autoInject: true, experimentalSnapshotRecall: snapshot, touchOnRecall: false }, {
    storeFactory(given, opts) { assert.equal(given, p); return store = open(p, opts); },
    maxChars: () => 0, storageLimitBytes: () => 2 * 1024 * 1024,
    installRpc: () => () => {}, autoCapture: () => ({ enabled: false }),
    defaultDbPath: forbidden, configReport: () => ({}), embedDims: forbidden, expand: expandFn ?? forbidden, select: forbidden,
  });
  return { store, tools, service: services.get('memjudge'), render: () => { assert.equal(typeof render, 'function'); return render(); }, dispose: app.dispose };
}
await check('dual connection exact source deletion preserves shared text and all other occurrences', () => {
  const [a,b] = pair('sources');
  try {
    const shared = a.put({ text: '甲船的颜色是红色。', source: 'source-A', documentId: 'doc-A', chapter: 1, para: 1 });
    a.put({ text: '甲船的颜色是红色。', source: 'source-A', documentId: 'doc-A', chapter: 1, para: 2 });
    a.put({ text: '甲船的颜色是红色。', source: 'source-B', documentId: 'doc-B', chapter: 2, para: 1 });
    const unique = a.put({ text: '只属来源甲的灯塔。', source: 'source-A' });
    const unknown = a.put({ id: 'mem-c99-p99-unknown', text: '未知身份的灯塔。' });
    assert.equal(b.occurrencesV1(shared.id).length, 3);
    const before = b.contentVersion();
    const dry = a.forget({ source: 'source-A', dryRun: true });
    assert.ok(dry.forgotten.includes(unique.id)); assert.equal(b.contentVersion(), before);
    const result = a.forget({ source: 'source-A' });
    assert.ok(result.retained.includes(shared.id)); assert.ok(result.forgotten.includes(unique.id));
    assert.equal(b.get(unique.id, false), null);
    assert.equal(b.get(shared.id, false).source, 'source-B');
    assert.deepEqual(b.occurrencesV1(shared.id).map(o => [o.source, o.para]), [['source-B', 1]]);
    assert.equal(b.bySourcePrefixV1('source-A').length, 0);
    assert.equal(b.occurrencesV1(unknown.id)[0].chapter, null);
    assert.equal(b.occurrencesV1(unknown.id)[0].source, null);
    assert.equal(toDoc(b.get(unknown.id, false)).source.chapter, 0);
    const ad = adaptContentSnapshot(b.contentSnapshot());
    assert.equal(ad.docs.find(d => d.id === unknown.id).source.chapter, 0);
    assert.equal(b.dump().length, 2); assert.ok(b.allFacts().length > 0);
    a.forget({ source: 'missing-source' }); assert.equal(b.dump().length, 2);
    a.forget({ source: 'source-B' }); assert.equal(b.allFacts().length, 0);
    assert.equal(b.get(unknown.id, false).text, '未知身份的灯塔。');
  } finally { a.close(); b.close(); }
});
await check('raw SQL update/delete refresh facts segments and invalidate every old snapshot accessor', () => {
  const [a,b] = pair('raw');
  try {
    const m = a.put({ text: '甲船的颜色是红色。', source: 'raw' });
    assert.ok(b.allFacts().length > 0);
    const view = createContentSnapshotView(b, () => 0, { search: { vector: false, expand: false, llmSelect: false } });
    a.raw().prepare('UPDATE memories SET text = ? WHERE id = ?').run('甲船的颜色是蓝色。第二段。', m.id);
    assert.ok(b.allFacts().some(f => f.value.includes('蓝')));
    assert.ok(!b.allFacts().some(f => f.value.includes('红')));
    assert.ok(b.segmentTexts(m.id).length > 0);
    for (const read of [() => view.search('甲船'), () => view.fullText(), () => view.allFacts(), () => view.factsSlot('颜色')]) assert.throws(read, /stale/);
    const local = createContentSnapshotView(b, () => 0);
    b.raw().prepare('DELETE FROM memories WHERE id = ?').run(m.id);
    assert.throws(() => local.fullText(), /stale/);
    empty(b); empty(a);
  } finally { a.close(); b.close(); }
});
await check('asynchronous extraction rejects stale publish and next read refreshes without rebuild', async () => {
  const [a,b] = pair('async');
  try {
    const m = a.put({ text: '甲船的颜色是红色。', source: 'async' }); b.allFacts();
    let release; const pending = b.rebuildFactsHybrid({ extractHybrid: () => new Promise(r => { release = r; }) });
    a.forget({ ids: [m.id] }); release({ source: 'llm', perEntry: [[{ attr: '颜色', value: '红色', entity: '甲船' }]] });
    await assert.rejects(pending, /stale/); empty(b);
  } finally { a.close(); b.close(); }
});
for (const snapshot of [false, true]) await check('tool/service/index/context deletion closure snapshot=' + snapshot, async () => {
  const f = fixture('consumer-' + snapshot, snapshot), b = open(file('consumer-' + snapshot + '.sqlite'));
  try {
    const m = f.store.put({ text: '灯塔的颜色是红色。', source: 'consumer-source', kind: 'person' });
    const recall = f.tools.get('memjudge_recall');
    assert.equal((await recall.execute({ query: '灯塔', budget: 2000 })).denied, false);
    assert.equal((await f.service.recallByQuery('灯塔')).denied, false);
    assert.ok(f.render().includes('灯塔'));
    b.forget({ source: 'consumer-source' });
    assert.equal((await recall.execute({ query: '灯塔' })).hits.length, 0);
    assert.equal((await f.service.recallByQuery('灯塔')).hits.length, 0);
    assert.equal(f.service.occurrencesV1(m.id).length, 0);
    assert.equal(f.service.bySourcePrefixV1('consumer-source').length, 0);
    assert.ok(!f.render().includes('灯塔')); empty(f.store);
    const second = f.store.put({ text: '来源工具删除灯塔。', source: 'tool-source' });
    const out = await f.tools.get('memjudge_forget').execute({ source: 'tool-source' });
    assert.ok(out.forgotten.includes(second.id)); empty(f.store);
  } finally { b.close(); await f.dispose(); }
});
await check('conflict legacy/V1/V2 consumers drop deleted source evidence', async () => {
  const f = fixture('conflicts'), b = open(file('conflicts.sqlite'));
  try {
    f.store.put({ text: '灯塔水箱容量为100吨。灯塔水箱容量为200吨。', source: 'conflict-source', documentId: 'conflict-doc', chapter: 1, para: 1 });
    for (const name of ['memjudge_conflicts', 'memjudge_conflicts_v1', 'memjudge_conflicts_v2']) {
      assert.ok((await f.tools.get(name).execute({})).total > 0, name + ' positive control');
    }
    b.forget({ source: 'conflict-source' });
    for (const name of ['memjudge_conflicts', 'memjudge_conflicts_v1', 'memjudge_conflicts_v2']) {
      const result = await f.tools.get(name).execute({}); assert.equal(result.total, 0, name);
      assert.ok(!JSON.stringify(result).includes('100吨'));
    }
    empty(f.store);
  } finally { b.close(); await f.dispose(); }
});
await check('tool and service async recall reject external deletion before publishing', async () => {
  let release;
  const f = fixture('async-consumer', false, () => new Promise(r => { release = r; }));
  const b = open(file('async-consumer.sqlite'));
  try {
    for (const service of [false, true]) {
      f.store.put({ text: '异步召回灯塔的颜色是红色。', source: 'async-source' });
      const pending = service ? f.service.recallByQuery('灯塔') : f.tools.get('memjudge_recall').execute({ query: '灯塔' });
      assert.equal(typeof release, 'function'); b.forget({ source: 'async-source' });
      release({ queries: ['灯塔'], expanded: false }); await assert.rejects(pending, /stale/);
      empty(f.store);
    }
  } finally { b.close(); await f.dispose(); }
});
await check('controlled multiprocess commit invalidates open reader and survives restart', () => {
  const p = file('multiprocess.sqlite'), a = open(p);
  try {
    a.put({ text: '多进程灯塔的颜色是红色。', source: 'child-target' }); a.allFacts();
    const childArgs = ['--permission', '--allow-fs-read=' + path.resolve('src'), '--allow-fs-read=' + path.resolve('test/completion-t2-deletion-2026-11-06.mjs'), '--allow-fs-read=' + root, '--allow-fs-write=' + root, path.resolve('test/completion-t2-deletion-2026-11-06.mjs'), root, '--child-delete'];
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, MEMJUDGE_NO_JIEBA: '1', MEMJUDGE_NO_SECRETS: '1', DSH_HOME: path.join(root, 'no-config') };
    const result = spawnSync(process.execPath, childArgs, { cwd: path.resolve('.'), env, stdio: 'inherit', windowsHide: true, timeout: 20000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0); empty(a);
  } finally { a.close(); }
  const reopened = open(p); try { empty(reopened); } finally { reopened.close(); }
});
await check('rollback failure quarantines writer and preserves committed source from other connection', () => {
  const [a,b] = pair('rollback');
  const db = a.raw(), original = db.exec;
  try {
    const m = a.put({ text: '回滚灯塔的颜色是红色。', source: 'rollback-source' });
    a.allFacts();
    db.exec = function(sql) {
      if (sql === 'ROLLBACK') throw new Error('T2_INJECTED_ROLLBACK_FAILURE');
      if (sql === 'COMMIT') throw new Error('T2_INJECTED_COMMIT_FAILURE');
      return original.call(this, sql);
    };
    assert.throws(() => a.forget({ ids: [m.id] }), /rollback failed/);
    assert.throws(() => a.allFacts(), /store fault/);
    db.exec = original; original.call(db, 'ROLLBACK');
    assert.equal(b.get(m.id, false).text, '回滚灯塔的颜色是红色。');
  } finally { db.exec = original; a.close(); b.close(); }
});
await check('ordinary derived reads and deletion do not inherit bounded snapshot field limit', () => {
  const [a,b] = pair('large-field');
  try {
    const text = '无属性正文'.repeat(15000);
    const m = a.put({ text, source: 'large-source' });
    assert.equal(b.get(m.id, false).text, text); assert.equal(b.dump().length, 1);
    assert.throws(() => b.contentSnapshot(), /limit exceeded/);
    a.forget({ source: 'large-source' }); empty(b);
  } finally { a.close(); b.close(); }
});
await check('empty and nonempty historical persistent facts both retain fail-safe startup gate', () => {
  for (const populated of [false, true]) {
    const p = file('legacy-' + populated + '.sqlite'), s = open(p);
    s.put({ text: '历史结构合成原文。', source: 'legacy-fixture' });
    s.raw().exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, value TEXT)');
    if (populated) s.raw().exec("INSERT INTO facts VALUES (1, 'synthetic')");
    s.close();
    const hashBefore = readFileSync(p).toString('hex');
    assert.throws(() => open(p), /persisted facts require forget-safe migration/);
    assert.equal(readFileSync(p).toString('hex'), hashBefore);
  }
});
console.log(JSON.stringify({ root, passed, failed, results }, null, 2));
if (failed) process.exitCode = 1;
}
