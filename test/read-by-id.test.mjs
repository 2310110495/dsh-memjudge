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
    const written = await tools.get('memjudge_remember').execute({ text: original });
    assert.ok(tools.get('memjudge_remember').output.schema.properties.version);
    assert.match(JSON.stringify(tools.get('memjudge_remember').output.render({}, written)), new RegExp(written.version));
    const duplicate = await tools.get('memjudge_remember').execute({ text: original });
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.version, written.version);
    const hit = await tools.get('memjudge_recall').execute({ query: '灯塔记忆', budget: 5 });
    assert.equal(hit.hits[0].truncated, true);
    const read = tools.get('memjudge_read');
    const id = hit.hits[0].id;
    store.raw().prepare('UPDATE memories SET last_accessed_at = ?, access_count = ? WHERE id = ?').run(1234, 7, id);
    const before = store.get(id, false);
    assert.equal(before.last_accessed, 1234);
    assert.equal(before.access_count, 7);
    assert.equal(written.id, id);
    const first = read.execute({ id, version: written.version });
    assert.equal(first.nextOffset, 1999);
    assert.match(first.version, /^[a-f0-9]{64}$/);
    assert.equal(first.version, written.version);
    const second = read.execute({ id, offset: first.nextOffset, version: first.version });
    assert.equal(second.version, first.version);
    assert.equal(first.text + second.text, original);
    assert.equal(second.truncated, false);
    const after = store.get(id, false);
    assert.equal(after.last_accessed, before.last_accessed);
    assert.equal(after.access_count, before.access_count);
    assert.equal(read.execute({ id: 'absent' }).found, false);
    assert.throws(() => read.execute({ id, offset: 2000 }), /invalid offset/);
    assert.throws(() => read.execute({ id, limit: 1 }), /invalid arguments/);
    assert.throws(() => read.execute({ id, version: '' }), /invalid arguments/);
    store.raw().prepare('UPDATE memories SET text = ? WHERE id = ?').run('新\0😀内容', id);
    assert.throws(() => read.execute({ id, version: written.version }), /stale version/);
    assert.throws(() => read.execute({ id, offset: first.nextOffset, version: first.version }), /stale version/);
    const fresh = read.execute({ id, limit: 2 });
    assert.equal(fresh.text, '新\0');
    const next = read.execute({ id, offset: fresh.nextOffset, limit: 2, version: fresh.version });
    assert.equal(next.text, '😀');
    assert.ok(next.nextOffset > fresh.nextOffset);
    store.raw().prepare('UPDATE memories SET text = ? WHERE id = ?').run('', id);
    const empty = read.execute({ id });
    assert.equal(empty.text, '');
    assert.equal(empty.nextOffset, 0);
    assert.equal(empty.truncated, false);
    assert.equal(read.execute({ id, version: empty.version }).version, empty.version);
    store.raw().prepare('DELETE FROM memories WHERE id = ?').run(id);
    assert.throws(() => read.execute({ id, version: empty.version }), /stale version/);
    assert.equal(read.execute({ id }).found, false);
  } finally { app.dispose(); }
});

test('tool and service evidence can be verified against the original version', async () => {
  const tools = new Map(), services = new Map();
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    provide: (name, value) => { services.set(name, value); return () => {}; },
    effect: fn => fn(), on: () => () => {},
  };
  let store;
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false, touchOnRecall: false }, {
    storeFactory: (...args) => (store = open(...args)),
  });
  try {
    const original = '甲。'.repeat(300) + '😀中途罗盘😀' + '乙。'.repeat(300);
    const written = await tools.get('memjudge_remember').execute({ text: original });
    const recall = tools.get('memjudge_recall');
    for (const call of [() => recall.execute({ query: '中途罗盘', budget: 24 }), () => services.get('memjudge').recallByQuery('中途罗盘', { budget: 24 })]) {
      const result = await call();
      const hit = result.hits[0];
      assert.equal(hit.id, written.id);
      assert.equal(hit.version, written.version);
      assert.ok(hit.windowStart > 0);
      assert.ok(hit.text.length <= 24);
      assert.ok(hit.text.isWellFormed());
      const page = tools.get('memjudge_read').execute({ id: hit.id, offset: hit.windowStart, limit: hit.windowEnd - hit.windowStart, version: hit.version });
      assert.equal(page.text, hit.text);
      assert.equal(page.nextOffset, hit.windowEnd);
      assert.match(JSON.stringify(recall.output.render({}, result)), new RegExp(hit.version));
      assert.match(JSON.stringify(recall.output.render({}, result)), new RegExp(`${hit.windowStart}:${hit.windowEnd}`));
    }
    store.raw().prepare('UPDATE memories SET text = ? WHERE id = ?').run('修改后的原文', written.id);
    assert.throws(() => tools.get('memjudge_read').execute({ id: written.id, version: written.version }), /stale version/);
  } finally { app.dispose(); }
});
