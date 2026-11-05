import test from 'node:test';
import assert from 'node:assert/strict';
import { index } from '../src/search.mjs';
import { apply } from '../src/index.mjs';

const text = '😀钟摆停止';
const ix = () => index([{ id: 'm1', text, kind: 'event', source: { chapter: 1, para: 1 }, createdAt: Date.now(), lastAccessed: Date.now() }]);

test('sync, async and expanded recall preserve surrogate pairs and evidence windows', async () => {
  for (const method of ['search', 'searchAsync', 'searchExpanded']) {
    const idx = ix();
    const opts = { expandFn: async q => ({ expanded: true, queries: [q, '停止'], ms: 0 }) };
    for (const [budget, expected, truncated] of [[1, '', true], [2, '钟摆', true], [3, '钟摆停', true], [text.length, text, false]]) {
      const result = await idx[method]('钟摆', { ...opts, maxChars: budget });
      assert.equal(result.hits.length, 1, `${method} budget=${budget}`);
      assert.equal(result.hits[0].text, expected);
      assert.ok(text.includes(result.hits[0].text));
      assert.ok(result.hits[0].text.length <= budget);
      assert.equal(result.hits[0].text.isWellFormed(), true);
      assert.equal(result.hits[0].truncated, truncated);
      assert.equal(result.chars, expected.length);
      assert.equal(result.hits[0].chars, expected.length);
    }
    const empty = await idx[method]('zzzzunmatched', { ...opts, maxChars: 1, expandFn: async q => ({ expanded: false, queries: [q] }) });
    assert.deepEqual(empty.hits, []);
  }
});

test('tool and read-only service propagate truncated, including empty prefix', async () => {
  const tools = new Map();
  const services = new Map();
  const ctx = {
    tools: { register: x => { tools.set(x.name, x); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    provide: (name, service) => { services.set(name, service); return () => {}; },
    effect: fn => fn(), on: () => () => {},
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, autoInject: false });
  try {
    await tools.get('memjudge_remember').execute({ text, kind: 'event' });
    const tool = tools.get('memjudge_recall');
    assert.equal(tool.output.schema.properties.hits.items.properties.truncated.type, 'boolean');
    for (const [budget, expected, truncated] of [[1, '', true], [text.length, text, false]]) {
      const result = await tool.execute({ query: '钟摆', budget });
      assert.equal(result.denied, false);
      assert.equal(result.hits[0].text, expected);
      assert.equal(result.hits[0].truncated, truncated);
      assert.equal(result.chars, expected.length);
      assert.equal(JSON.stringify(tool.output.render({}, result)).includes('截断'), truncated);
      const service = await services.get('memjudge').recallByQuery('钟摆', { budget });
      assert.equal(service.hits[0].text, expected);
      assert.equal(service.hits[0].truncated, truncated);
    }
    const empty = await tools.get('memjudge_recall').execute({ query: 'zzzzunmatched', budget: 1 });
    assert.equal(empty.denied, true);
    assert.deepEqual(empty.hits, []);
  } finally { app.dispose(); }
});
