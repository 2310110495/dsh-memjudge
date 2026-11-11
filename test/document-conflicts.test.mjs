import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { documentConflicts } from '../src/judge.mjs';

test('document conflicts preserve identity and never infer ordering', async () => {
  const tools = new Map(), services = new Map();
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    provide: (name, value) => { services.set(name, value); return () => {}; },
    effect: fn => fn(), on: () => () => {},
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
    const svc = services.get('memjudge');
    const mems = svc.byKind('event').map(m => ({ id: m.id, text: m.text, occurrences: svc.occurrencesV1(m.id) }));
    const conflicts = documentConflicts(mems);
    assert.equal(conflicts.length, 1);
    const conflict = conflicts[0];
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

test('comparison cap stops candidate generation in stable order', () => {
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
});
