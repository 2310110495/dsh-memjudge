import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { open } from '../src/store.mjs';
import { workspaceSpaceId } from '../src/scope.mjs';

const cwdA = 'F:/recall-scope-fixture/alpha';
const cwdB = 'F:/recall-scope-fixture/beta';
const spaceA = workspaceSpaceId(cwdA), spaceB = workspaceSpaceId(cwdB);
const query = '星河项目的重试次数是3吗？';

function fixture() {
  const tools = new Map();
  let store;
  const app = apply({
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name); } },
    systemPrompt: { section() { return () => {}; } },
  }, { dbPath: ':memory:', autoInject: false, autoCapture: false, touchOnRecall: false,
    vector: false, rerank: false, expand: false, llmSelect: false, metabolismIntervalMs: 0 },
  { now: () => 1700000000000, storeFactory: (...args) => (store = open(...args)) });
  for (const [id, spaceId, label] of [
    ['public', 'global', 'GLOBAL'], ['alpha', spaceA, 'ALPHA'], ['beta', spaceB, 'BETA'],
  ]) store.put({ id, spaceId, category: 'experience', chapter: id === 'public' ? 1 : id === 'alpha' ? 2 : 3,
    text: '星河项目的重试次数是3。来源标记 ' + label + '。',
    slots: [{ entity: '星河项目', attr: '重试次数', value: '3', unit: '', polarity: 'affirm', confidence: 1,
      quote: '星河项目的重试次数是3。' }],
  });
  const recall = (args = {}, exec) => tools.get('memjudge_recall').execute({ query, budget: 2000, topChapters: 4, ...args }, exec);
  return { app, store, recall };
}
function ids(result) {
  assert.equal(result.denied, false, JSON.stringify(result));
  return result.hits.map(h => h.id).sort();
}

test('recall without execution identity is global-only, never all workspaces', async () => {
  const f = fixture();
  try {
    for (const exec of [undefined, {}, { agent: {} }, { agent: { session: {} } },
      { agent: { session: { header: { id: 'no-cwd' } } } }]) {
      assert.deepEqual(ids(await f.recall({}, exec)), ['public']);
    }
    assert.deepEqual(ids(await f.recall({ space: '  ' })), ['public']);
  } finally { f.app.dispose(); }
});

test('session workspace scope includes global but excludes a sibling workspace', async () => {
  const f = fixture();
  try {
    const execA = { agent: { session: { header: { id: 'header-only', cwd: cwdA } } } };
    const execB = { agent: { session: { id: 'same-session', cwd: cwdB } } };
    assert.deepEqual(ids(await f.recall({}, execA)), ['alpha', 'public']);
    assert.deepEqual(ids(await f.recall({}, execB)), ['beta', 'public']);
    assert.deepEqual(ids(await f.recall({}, execA)), ['alpha', 'public']);
  } finally { f.app.dispose(); }
});

test('explicit all is an owner opt-in, and cannot poison later default-scope cache entries', async () => {
  const f = fixture();
  try {
    assert.deepEqual(ids(await f.recall({ space: 'all' })), ['alpha', 'beta', 'public']);
    assert.deepEqual(ids(await f.recall()), ['public']);
    assert.deepEqual(ids(await f.recall({ space: spaceA })), ['alpha', 'public']);
    assert.deepEqual(ids(await f.recall({ space: 'all' })), ['alpha', 'beta', 'public']);
    assert.deepEqual(ids(await f.recall()), ['public']);
  } finally { f.app.dispose(); }
});

test('explicit workspace and global requests retain their documented semantics', async () => {
  const f = fixture();
  try {
    assert.deepEqual(ids(await f.recall({ space: cwdA })), ['alpha', 'public']);
    assert.deepEqual(ids(await f.recall({ space: spaceB })), ['beta', 'public']);
    assert.deepEqual(ids(await f.recall({ space: 'global' }, { agent: { session: { header: { cwd: cwdA } } } })), ['public']);
  } finally { f.app.dispose(); }
});

test('no-identity recall neither reveals nor refreshes a private-only matching record', async () => {
  const f = fixture();
  try {
    f.store.forget({ ids: ['public'] });
    assert.equal(f.store.get('public', true), null);
    const before = f.store.get('alpha', true);
    const result = await f.recall();
    assert.equal(result.denied, true, JSON.stringify(result));
    assert.deepEqual(result.hits, []);
    const after = f.store.get('alpha', true);
    assert.equal(after.accessCount, before.accessCount);
    assert.equal(after.lastAccessed, before.lastAccessed);
    assert.deepEqual(ids(await f.recall({ space: 'all' })), ['alpha', 'beta']);
  } finally { f.app.dispose(); }
});
