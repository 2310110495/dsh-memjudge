import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, resolveConfig } from '../src/index.mjs';
import { SearchIndex } from '../src/search.mjs';

const DAY = 86_400_000;
function fixture(options = {}) {
  let time = Date.UTC(2026, 0, 1);
  const tools = new Map();
  const services = new Map();
  const sections = new Map();
  const ctx = {
    tools: { register: value => { tools.set(value.name, value); return () => {}; } },
    systemPrompt: { section: value => { sections.set(value.name, value); return () => {}; } },
    provide: (name, value) => { services.set(name, value); return () => {}; },
    effect: fn => fn(),
    on: () => () => {},
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, now: () => time, ...options });
  return { app, tools, sections, service: services.get('memjudge'), advance: days => { time += days * DAY; } };
}

async function setup(options) {
  const f = fixture(options);
  const remember = f.tools.get('memjudge_remember');
  await remember.execute({ text: '钟摆冷记录七点', kind: 'event', importance: 0.4 });
  await remember.execute({ text: '钟摆暖记录八点', kind: 'event', importance: 0.8 });
  return f;
}

function ratios(initial, later) {
  return later.hits.map(hit => hit.score / initial.hits.find(row => row.id === hit.id).score).sort((a, b) => a - b);
}

for (const [name, options, expected] of [
  ['legacy', { halfLifeDays: 1 }, [0.5, 2 ** -0.1]],
  ['dual', { decayMode: 'dual', halfLifeDays: 1 }, [0.5, 2 ** -0.1]],
  ['uniform 1', { decayMode: 'uniform', halfLifeDays: 1 }, [2 ** -12, 2 ** -12]],
  ['uniform 120', { decayMode: 'uniform', halfLifeDays: 120 }, [2 ** -0.1, 2 ** -0.1]],
  ['uniform floor', { decayMode: 'uniform', halfLifeDays: 1, decayFloor: 0.6 }, [0.6, 0.6]],
]) {
  test(`decay mode: ${name}`, async () => {
    const f = await setup(options);
    try {
      const initial = await f.service.recallByQuery('钟摆');
      f.advance(12);
      const later = await f.service.recallByQuery('钟摆');
      assert.equal(later.hits.length, 2);
      ratios(initial, later).forEach((actual, i) => assert.ok(Math.abs(actual - expected[i]) < 0.00002, `${actual} vs ${expected[i]}`));
      await f.tools.get('memjudge_recall').execute({ query: '钟摆' });
      const touched = await f.service.recallByQuery('钟摆');
      for (const hit of touched.hits) assert.ok(hit.score > later.hits.find(row => row.id === hit.id).score);
    } finally { f.app.dispose(); }
  });
}

test('configuration validation and mount snapshot survive index rebuild', async () => {
  assert.equal(resolveConfig({}).decayMode, 'dual');
  assert.equal(resolveConfig({ decayMode: 'uniform' }).halfLifeDays, 30);
  assert.equal(resolveConfig({ halfLifeDays: -5 }).halfLifeDays, 0.5);
  assert.equal(resolveConfig({ halfLifeDays: 9999 }).halfLifeDays, 3650);
  const f = await setup({ decayMode: 'uniform', halfLifeDays: 120 });
  try {
    await f.service.recallByQuery('钟摆');
    f.app.config.halfLifeDays = 1;
    f.app.config.decayMode = 'dual';
    await f.tools.get('memjudge_remember').execute({ text: '无关风向标', kind: 'event' });
    const initial = await f.service.recallByQuery('钟摆');
    f.advance(12);
    const later = await f.service.recallByQuery('钟摆');
    for (const ratio of ratios(initial, later)) assert.ok(Math.abs(ratio - 2 ** -0.1) < 0.00002);
  } finally { f.app.dispose(); }
});

test('invalid explicit decay configuration fails before opening a store', () => {
  for (const value of [null, undefined, '', 'unifrom', 'DUAL', false, 1]) {
    assert.throws(() => fixture({ decayMode: value }), /decayMode.*dual.*uniform/);
  }
  for (const value of [null, undefined, '', '1', 'bad', true, false, NaN, Infinity, -Infinity, 0.49, 3650.01]) {
    assert.throws(() => fixture({ decayMode: 'uniform', halfLifeDays: value }), /halfLifeDays.*0\.5.*3650/);
  }
  for (const value of [0.5, 3650]) assert.equal(resolveConfig({ decayMode: 'uniform', halfLifeDays: value }).halfLifeDays, value);
  assert.equal(resolveConfig({ decayMode: 'dual', halfLifeDays: 30 }).decayMode, 'dual');
});

test('uniform recall touch refreshes score and cached injection', async () => {
  const f = fixture({ decayMode: 'uniform', halfLifeDays: 1, autoInject: true });
  try {
    await f.tools.get('memjudge_remember').execute({ text: '钟摆停在七点', source: 'auto:chat#abcdef12-t0', kind: 'event' });
    const inject = [...f.sections.values()][0].text;
    assert.doesNotMatch(inject(), /钟摆停在七点/);
    f.advance(12);
    const before = await f.service.recallByQuery('钟摆');
    await f.tools.get('memjudge_recall').execute({ query: '钟摆' });
    assert.match(inject(), /钟摆停在七点/);
    const after = await f.service.recallByQuery('钟摆');
    assert.ok(after.hits[0].score > before.hits[0].score);
  } finally { f.app.dispose(); }
});

test('constructed index carries uniform mode into async and expanded retrieval', async () => {
  const original = SearchIndex.prototype.search;
  let index;
  SearchIndex.prototype.search = function (...args) { index = this; return original.apply(this, args); };
  const f = await setup({ decayMode: 'uniform', halfLifeDays: 120 });
  try {
    await f.service.recallByQuery('钟摆');
    const now = Date.UTC(2026, 0, 13);
    const sync = index.search('钟摆', { now });
    const asyncResult = await index.searchAsync('钟摆', { now });
    const expanded = await index.searchExpanded('钟摆', {
      now,
      expandFn: async () => ({ queries: ['钟摆', '冷记录'], expanded: true, ms: 0 }),
    });
    assert.ok(sync.hits.length > 0);
    assert.deepEqual(asyncResult.hits.map(hit => hit.score), sync.hits.map(hit => hit.score));
    assert.deepEqual(expanded.hits.slice(0, sync.hits.length).map(hit => hit.score), sync.hits.map(hit => hit.score));
    assert.ok(sync.hits.every(hit => Math.abs(hit.decay - 2 ** -0.1) < 0.000002));
  } finally {
    f.app.dispose();
    SearchIndex.prototype.search = original;
  }
});
