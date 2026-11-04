import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, TOOL_NAMES } from '../src/index.mjs';
import { open } from '../src/store.mjs';

test('recall id reads exact text in bounded surrogate-safe pages', async () => {
  const tools = new Map();
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {},
    effect: fn => fn(), on: () => () => {},
  };
  let store;
  const app = apply(ctx, { dbPath: ':memory:', vector: false, autoInject: false, touchOnRecall: false }, {
    storeFactory: (...args) => (store = open(...args)),
  });
  try {
    assert.deepEqual([...tools.keys()].sort(), [...TOOL_NAMES].sort());
    assert.ok(TOOL_NAMES.includes('memjudge_read'));
    const original = '灯塔记忆' + '甲'.repeat(1995) + '😀' + '\0尾段';
    await tools.get('memjudge_remember').execute({ text: original });
    const hit = await tools.get('memjudge_recall').execute({ query: '灯塔记忆', budget: 5 });
    assert.equal(hit.hits[0].truncated, true);
    const read = tools.get('memjudge_read');
    const id = hit.hits[0].id;
    store.raw().prepare('UPDATE memories SET last_accessed = ?, access_count = ? WHERE id = ?').run(1234, 7, id);
    const before = store.get(id, false);
    assert.equal(before.last_accessed, 1234);
    assert.equal(before.access_count, 7);
    const first = read.execute({ id });
    assert.equal(first.nextOffset, 1999);
    const second = read.execute({ id, offset: first.nextOffset });
    assert.equal(first.text + second.text, original);
    assert.equal(second.truncated, false);
    const after = store.get(id, false);
    assert.equal(after.last_accessed, before.last_accessed);
    assert.equal(after.access_count, before.access_count);
    assert.equal(read.execute({ id: 'absent' }).found, false);
    assert.throws(() => read.execute({ id, offset: 2000 }), /invalid offset/);
    assert.throws(() => read.execute({ id, limit: 1 }), /invalid arguments/);
  } finally { app.dispose(); }
});
