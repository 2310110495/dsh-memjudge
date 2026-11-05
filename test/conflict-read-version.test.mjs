import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { open } from '../src/store.mjs';

test('conflict evidence points to the same version of the source text', async () => {
  const tools = new Map();
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {}, effect: fn => fn(), on: () => () => {} };
  let store;
  const app = apply(ctx, { dbPath: ':memory:', vector: false }, { storeFactory: (...args) => (store = open(...args)) });
  try {
    const put = args => tools.get('memjudge_remember').execute(args);
    await put({ text: '😀前文。桥梁长度10米。', documentId: 'doc', source: 'first' });
    await put({ text: '桥梁长度20米。', documentId: 'doc', source: 'second' });
    const result = await tools.get('memjudge_conflicts_v2').execute({});
    assert.equal(result.conflicts.length, 1);
    const read = tools.get('memjudge_read');
    for (const evidence of result.conflicts[0].evidence) {
      assert.ok(evidence.positions.some(position => position.document_id === 'doc'));
      assert.match(evidence.version, /^[a-f0-9]{64}$/);
      const page = read.execute({ id: evidence.memoryId, offset: evidence.start, version: evidence.version });
      assert.equal(page.text.slice(0, evidence.end - evidence.start), evidence.text);
    }
    const evidence = result.conflicts[0].evidence[0];
    store.raw().prepare('UPDATE memories SET text = ? WHERE id = ?').run('更改后的文本。', evidence.memoryId);
    assert.throws(() => read.execute({ id: evidence.memoryId, offset: evidence.start, version: evidence.version }), /stale version/);
  } finally { app.dispose(); }
});

test('long conflict evidence can be reconstructed across versioned pages', async () => {
  const tools = new Map();
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {}, effect: fn => fn(), on: () => () => {} };
  let store;
  const app = apply(ctx, { dbPath: ':memory:', vector: false }, { storeFactory: (...args) => (store = open(...args)) });
  try {
    const prefix = '桥梁长度10米';
    const sentence = prefix + '甲'.repeat(1999 - prefix.length) + '😀' + '乙'.repeat(1100) + '。';
    const text = '前文。' + sentence + '后文。';
    const put = args => tools.get('memjudge_remember').execute(args);
    await put({ text, documentId: 'doc', source: 'long' });
    await put({ text: '桥梁长度20米。', documentId: 'doc', source: 'short' });
    const result = await tools.get('memjudge_conflicts_v2').execute({});
    assert.equal(result.conflicts.length, 1);
    const evidence = result.conflicts[0].evidence.find(item => item.text === sentence);
    assert.ok(evidence);
    assert.ok(evidence.positions.some(pos => pos.document_id === 'doc'));
    const read = tools.get('memjudge_read');
    let offset = evidence.start, reconstructed = '', pages = 0;
    while (offset < evidence.end) {
      const page = read.execute({ id: evidence.memoryId, offset, version: evidence.version });
      if (pages === 0) assert.equal(page.nextOffset, evidence.start + 1999);
      reconstructed += page.text.slice(0, Math.min(page.nextOffset, evidence.end) - offset);
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
      pages++;
    }
    assert.ok(pages > 1);
    assert.equal(reconstructed, sentence);
    const first = read.execute({ id: evidence.memoryId, offset: evidence.start, version: evidence.version });
    store.raw().prepare('UPDATE memories SET text = ? WHERE id = ?').run(text + '变化', evidence.memoryId);
    assert.throws(() => read.execute({ id: evidence.memoryId, offset: first.nextOffset, version: evidence.version }), /stale version/);
  } finally { app.dispose(); }
});
