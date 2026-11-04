import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { documentConflicts } from '../src/judge.mjs';

test('document conflicts preserve identity and never infer ordering', async () => {
  const tools = new Map();
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    provide: () => () => {}, effect: fn => fn(), on: () => () => {},
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false });
  try {
    const put = args => tools.get('memjudge_remember').execute(args);
    const first = await put({ text: '桥梁长度为10米。', documentId: 'A', source: 'a', chapter: 1, para: 1 });
    await put({ text: '桥梁长度为10米。', documentId: 'B', source: 'b', chapter: 1, para: 1 });
    await put({ text: '桥梁长度为10米。', documentId: 'A', source: 'a2', chapter: 3, para: 2 });
    const second = await put({ text: '桥梁长度为20米。', documentId: 'A', source: 'a3', chapter: 2, para: 4 });
    await put({ text: '桥梁长度为30米。', documentId: 'C', chapter: 1 });
    await put({ text: '桥梁长度为40米。', chapter: 1 });
    await put({ text: '桥梁长度为50米。', chapter: 1 });
    const result = await tools.get('memjudge_conflicts_v1').execute({});
    assert.equal(result.total, 1);
    const conflict = result.conflicts[0];
    assert.equal(conflict.documentId, 'A');
    assert.deepEqual(new Set(conflict.values), new Set(['10米', '20米']));
    assert.deepEqual(new Set(conflict.evidence.map(x => x.memoryId)), new Set([first.id, second.id]));
    assert.deepEqual(conflict.evidence.find(x => x.memoryId === first.id).positions.map(x => [x.chapter, x.para]), [[1, 1], [3, 2]]);
    assert.equal('current' in conflict, false);
    assert.equal('currentMemId' in conflict, false);
    const legacy = await tools.get('memjudge_conflicts').execute({});
    assert.ok(Array.isArray(legacy.conflicts));
    assert.ok('supersededCount' in legacy);
    if (legacy.conflicts.length) assert.ok('currentMemId' in legacy.conflicts[0]);
  } finally { app.dispose(); }
});

test('pairs exclude unrelated and transitively connected evidence', () => {
  const occurrence = { documentId: 'A', source: 'a', chapter: 1, para: 1 };
  const rows = [
    ['a', '桥梁长度为10米。'], ['b', '桥梁长度为20米。'],
    ['c', '隧道宽度为30米。'], ['d', '隧道桥梁为40米。'],
  ].map(([id, text]) => ({ id, text, occurrences: [{ ...occurrence, memoryId: id }] }));
  const pairs = documentConflicts(rows);
  assert.ok(pairs.some(p => p.evidence.map(e => e.memoryId).join(',') === 'a,b'));
  assert.ok(!pairs.some(p => p.evidence.some(e => e.memoryId === 'a') && p.evidence.some(e => e.memoryId === 'c')));
  assert.ok(pairs.every(p => p.evidence.length === 2 && p.values.length === 2));
});

test('unknown identity compares only within one memory', () => {
  const rows = [
    { id: 'a', text: '桥梁长度为10米。桥梁长度为20米。', occurrences: [] },
    { id: 'b', text: '桥梁长度为30米。', occurrences: [] },
  ];
  const pairs = documentConflicts(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].documentId, null);
  assert.deepEqual(pairs[0].evidence.map(e => e.memoryId), ['a', 'a']);
});

test('long sentence evidence remains verbatim', () => {
  const text = `桥梁长度为10米${'甲'.repeat(10000)}。桥梁长度为20米。`;
  const pairs = documentConflicts([{ id: 'a', text, occurrences: [] }]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].evidence[0].text, `桥梁长度为10米${'甲'.repeat(10000)}。`);
});

test('tool reports limit and bounded complete evidence', async () => {
  const tools = new Map();
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {}, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: ':memory:', vector: false });
  try {
    const put = args => tools.get('memjudge_remember').execute(args);
    for (const n of [10, 20, 30]) await put({ text: `桥梁长度为${n}米。`, documentId: 'A' });
    const result = await tools.get('memjudge_conflicts_v1').execute({ limit: 1 });
    assert.equal(result.total, 3);
    assert.equal(result.totalExact, true);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.limitTruncated, true);
    assert.equal(result.budgetTruncated, false);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(tools.get('memjudge_conflicts_v1').output.render({}, result))) <= 65536);
    const all = await tools.get('memjudge_conflicts_v1').execute({ limit: 3 });
    assert.equal(all.conflicts.length, 3);
    assert.equal(all.truncated, false);
    assert.ok(Buffer.byteLength(JSON.stringify(tools.get('memjudge_conflicts_v1').output.render({}, all))) <= 65536);
  } finally { app.dispose(); }
});

test('oversized evidence is omitted whole and explicitly reported', async () => {
  const tools = new Map();
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {}, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: ':memory:', vector: false });
  try {
    const put = args => tools.get('memjudge_remember').execute(args);
    await put({ text: '桥梁长度为10米。', documentId: 'A', source: 'x'.repeat(70000) });
    await put({ text: '桥梁长度为20米。', documentId: 'A' });
    const result = await tools.get('memjudge_conflicts_v1').execute({});
    assert.equal(result.total, 1);
    assert.equal(result.totalExact, true);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.budgetTruncated, true);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(tools.get('memjudge_conflicts_v1').output.render({}, result))) <= 65536);
  } finally { app.dispose(); }
});

test('rendered JSON boundary includes escaped unicode evidence and multiple groups', async () => {
  async function sample(size) {
    const tools = new Map();
    const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
      systemPrompt: { section: () => () => {} }, provide: () => () => {}, effect: fn => fn(), on: () => () => {} };
    const app = apply(ctx, { dbPath: ':memory:', vector: false });
    try {
      const put = args => tools.get('memjudge_remember').execute(args);
      await put({ text: '桥梁长度为10米。', documentId: 'A', source: '汉😀"\\\n' + 'x'.repeat(size) });
      await put({ text: '桥梁长度为20米。', documentId: 'A' });
      await put({ text: '桥梁长度为30米。', documentId: 'A' });
      const tool = tools.get('memjudge_conflicts_v1');
      const value = await tool.execute({ limit: 1 });
      return { value, bytes: Buffer.byteLength(JSON.stringify(tool.output.render({}, value)), 'utf8') };
    } finally { app.dispose(); }
  }
  let low = 0, high = 70000;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await sample(mid)).value.conflicts.length) low = mid; else high = mid;
  }
  const fit = await sample(low), over = await sample(high);
  assert.equal(fit.bytes, 65536);
  assert.equal(fit.value.limitTruncated, true);
  assert.equal(over.value.budgetTruncated, true);
  assert.deepEqual(over.value.conflicts, []);
  assert.ok(over.bytes <= 65536);
  assert.equal(fit.value.conflicts[0].evidence[0].positions[0].source, '汉😀"\\\n' + 'x'.repeat(low));
});

test('comparison cap stops candidate generation in stable order', async () => {
  const text = Array.from({ length: 300 }, (_, i) => `桥梁长度为${i + 1}米。`).join('');
  const rows = [{ id: 'a', text, occurrences: [] }];
  const scan = {};
  const result = documentConflicts(rows, { maxComparisons: 10000, scan });
  assert.equal(scan.comparisons, 10000);
  assert.equal(scan.incomplete, true);
  assert.equal(result.length, 10000);
  const scan2 = {};
  assert.deepEqual(documentConflicts(rows, { maxComparisons: 10000, scan: scan2 }), result);
  const exact = {};
  documentConflicts([{ id: 'b', text: '桥梁长10米。桥梁长20米。', occurrences: [] }], { maxComparisons: 1, scan: exact });
  assert.deepEqual(exact, { comparisons: 1, incomplete: false });
  const tools = new Map();
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {}, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: ':memory:', vector: false });
  try {
    await tools.get('memjudge_remember').execute({ text });
    const tool = tools.get('memjudge_conflicts_v1');
    const value = await tool.execute({ limit: 1 });
    assert.equal(value.scanIncomplete, true);
    assert.equal(value.total, 10000);
    assert.equal(value.totalExact, false);
    assert.match(tool.description, /下界/);
    assert.ok(tool.output.schema.required.includes('totalExact'));
    assert.equal(value.comparisons, 10000);
    assert.equal(value.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(tool.output.render({}, value))) <= 65536);
  } finally { app.dispose(); }
});
