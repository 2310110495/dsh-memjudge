import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { index } from '../src/search.mjs';

test('long memory returns query evidence from beginning middle and end', async () => {
  const tools = new Map();
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {},
    effect: fn => fn(), on: () => () => {},
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false, touchOnRecall: false });
  try {
    const original = '开篇灯塔。' + '甲。'.repeat(600) + '中途罗盘。' + '乙。'.repeat(600) + '结尾银铃😀';
    const written = await tools.get('memjudge_remember').execute({ text: original, chapter: 7, para: 2, source: '小说' });
    for (const term of ['开篇灯塔', '中途罗盘', '结尾银铃']) {
      const result = await tools.get('memjudge_recall').execute({ query: term, budget: 32 });
      assert.equal(result.hits[0].id, written.id);
      assert.equal(result.hits[0].chapter, 7);
      assert.equal(result.hits[0].truncated, true);
      assert.ok(result.hits[0].text.includes(term), term);
      assert.ok(original.includes(result.hits[0].text));
      assert.ok(result.hits[0].text.length <= 32);
    }
    let offset = 0, joined = '';
    do {
      const page = tools.get('memjudge_read').execute({ id: written.id, offset, version: written.version });
      joined += page.text;
      offset = page.nextOffset;
      if (!page.truncated) break;
    } while (true);
    assert.equal(joined, original);
  } finally { app.dispose(); }
});

test('normalized matches retain original UTF-16 evidence', async () => {
  for (const [query, evidence] of [['bm25', 'ＢＭ２５'], ['office', 'oﬃce'], ['café', 'cafe\u0301'], ['ΟΣ', 'ΟΣ']]) {
      const original = '前言。'.repeat(80) + '😀' + evidence + '是100元。😀' + '尾声。'.repeat(80);
      const result = index([{ id: 'fixture', text: original }]).search(query, { maxChars: 24 });
      const hit = result.hits.find(h => h.id === 'fixture');
      assert.ok(hit?.text.includes(evidence), query);
      assert.ok(original.includes(hit.text));
      assert.ok(hit.text.length <= 24);
      assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(hit.text));
  }
});

test('tool recall locates contextual lowercase in long original text', async () => {
  const tools = new Map();
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {},
    effect: fn => fn(), on: () => () => {},
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false, touchOnRecall: false });
  try {
    const original = '甲。'.repeat(300) + 'ΟΣ是100元。' + '乙。'.repeat(300);
    const written = await tools.get('memjudge_remember').execute({ text: original });
    const result = await tools.get('memjudge_recall').execute({ query: 'ΟΣ', budget: 32 });
    assert.equal(result.hits[0]?.id, written.id);
    assert.ok(result.hits[0].text.includes('ΟΣ'));
    assert.ok(original.includes(result.hits[0].text));
  } finally { app.dispose(); }
});

test('multiple candidates preserve longest matching evidence and UTF-16 budget', () => {
  const original = '前。'.repeat(100) + '😀ＢＭ２５' + '中。'.repeat(100) + 'needle' + '后。'.repeat(100);
  const indexed = index([{ id: 'multi', text: original }]);
  const query = 'missinglongword needle bm25';
  for (const maxChars of [16, 24, 32]) {
    const hit = indexed.search(query, { maxChars }).hits[0];
    const expected = indexed.search('needle', { maxChars }).hits[0];
    assert.equal(hit.text, expected.text);
    assert.ok(hit.text.includes('needle'));
    assert.ok(original.includes(hit.text));
    assert.ok(hit.text.length <= maxChars);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(hit.text));
    assert.equal(hit.truncated, true);
  }
});

test('mixed short and long matches use remaining budget without splitting text', () => {
  const short = 'bm25是100元。';
  const long = '甲。'.repeat(200) + '😀ＢＭ２５是100元。😀' + '乙。'.repeat(200);
  const indexed = index([{ id: 'short', text: short, chapter: 1 }, { id: 'long', text: long, chapter: 1 }]);
  const hits = indexed.search('bm25', { maxChars: 64 }).hits;
  assert.equal(hits.length, 2);
  assert.equal(new Set(hits.map(h => h.id)).size, 2);
  const window = hits.find(h => h.id === 'long');
  assert.ok(window.text.includes('ＢＭ２５'));
  assert.ok(long.includes(window.text));
  assert.equal(window.truncated, true);
  assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(window.text));
  assert.ok(hits.reduce((n, h) => n + h.text.length, 0) <= 64);
  assert.deepEqual(indexed.search('bm25', { maxChars: short.length + 15 }).hits.map(h => h.id), ['short']);
  assert.deepEqual(indexed.search('absent', { maxChars: 64 }).hits, []);
});

test('mixed recall is reachable through the in-memory tool', async () => {
  const tools = new Map();
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {}, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false, touchOnRecall: false });
  try {
    const short = await tools.get('memjudge_remember').execute({ text: '罗盘是100元。', chapter: 1 });
    const original = '甲。'.repeat(200) + '😀罗盘是100元。😀' + '乙。'.repeat(200);
    const long = await tools.get('memjudge_remember').execute({ text: original, chapter: 1 });
    const result = await tools.get('memjudge_recall').execute({ query: '罗盘', budget: 64 });
    assert.ok(result.hits.some(h => h.id === short.id));
    const hit = result.hits.find(h => h.id === long.id);
    assert.ok(hit?.text.includes('罗盘'));
    assert.ok(original.includes(hit.text));
    assert.equal(hit.truncated, true);
    assert.ok(result.hits.reduce((n, h) => n + h.text.length, 0) <= 64);
  } finally { app.dispose(); }
});

test('small and near-length budgets locate original evidence', () => {
  for (const [original, query, budget, evidence] of [
    ['甲。'.repeat(20) + '😀罗盘是100元', '罗盘', 8, '罗盘'],
    ['甲'.repeat(25) + 'ＢＭ２５' + '乙'.repeat(3), 'bm25', 20, 'ＢＭ２５'],
    ['甲'.repeat(25) + '😀罗盘', '罗盘', 2, '罗盘'],
  ]) {
    const hit = index([{ id: 'fixture', text: original }]).search(query, { maxChars: budget }).hits[0];
    assert.ok(hit.text.includes(evidence));
    assert.ok(original.includes(hit.text));
    assert.ok(hit.text.length <= budget);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(hit.text));
    assert.equal(hit.truncated, true);
  }
});

test('small budget evidence is reachable through the in-memory tool', async () => {
  const tools = new Map();
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {}, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false, touchOnRecall: false });
  try {
    const original = '甲。'.repeat(20) + '😀罗盘是100元';
    const written = await tools.get('memjudge_remember').execute({ text: original });
    const result = await tools.get('memjudge_recall').execute({ query: '罗盘', budget: 8 });
    const hit = result.hits[0];
    assert.equal(hit.id, written.id);
    assert.ok(hit.text.includes('罗盘'));
    assert.ok(original.includes(hit.text));
    assert.ok(hit.text.length <= 8);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(hit.text));
    assert.equal(hit.truncated, true);
  } finally { app.dispose(); }
});
