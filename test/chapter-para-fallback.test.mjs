// 缺陷 1 回归：显式 source 抢走 source 列后，章/段号必须还能从 id 前缀恢复。
// 判据：recall 返回的 hits[].chapter/para 与写入时给的一致；没给章段时仍是 0/0（不臆造）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, toDoc } from '../src/index.mjs';

function hostCtx() {
  const tools = new Map();
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    provide: () => () => {},
    effect: (fn) => fn(),
    on: () => () => {},
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, autoInject: false, touchOnRecall: false });
  return { tools, app, tool: (name) => tools.get(name) };
}

test('显式 source 不再让 recall 的章段号退化为 0', async () => {
  const { app, tool } = hostCtx();
  try {
    const written = await tool('memjudge_remember').execute({
      text: '量水署核定的堤工期限为三十天。', chapter: 7, para: 1, source: 'novel-ch07',
    });
    // 前置：章号确实只写在 id 里，source 列放的是显式来源串。
    assert.equal(written.id, 'mem-c07-p001-79d6271d');
    const recalled = await tool('memjudge_recall').execute({ query: '堤工期限' });
    assert.equal(recalled.hits.length, 1);
    assert.equal(recalled.hits[0].chapter, 7);
    assert.equal(recalled.hits[0].para, 1);
  } finally { app.dispose(); }
});

test('显式 source 且未给章段时章段号仍是 0（不拿 id 之外的线索臆造）', async () => {
  const { app, tool } = hostCtx();
  try {
    const written = await tool('memjudge_remember').execute({ text: '巡检里程为三里。', source: 'novel-ch11' });
    assert.equal(written.id, 'mem-c00-p000-53045a72');
    const recalled = await tool('memjudge_recall').execute({ query: '巡检里程' });
    assert.equal(recalled.hits.length, 1);
    assert.equal(recalled.hits[0].chapter, 0);
    assert.equal(recalled.hits[0].para, 0);
  } finally { app.dispose(); }
});

test('source 列是章段 JSON 时仍以 source 为准，id 兜底不越位', () => {
  // id 里写着 9/9，但 source 列有合法 JSON —— 两处冲突时 source 是写入者的正解。
  const doc = toDoc({ id: 'mem-c09-p009-00000000', text: 'x', source: '{"chapter":2,"para":3}' });
  assert.deepEqual(doc.source, { chapter: 2, para: 3 });
});

test('id 兜底接受不定长章段号（padStart 只补齐不截断）', () => {
  assert.deepEqual(toDoc({ id: 'mem-c100-p012-abcdef12', text: 'x', source: 'novel' }).source, { chapter: 100, para: 12 });
  assert.deepEqual(toDoc({ id: 'mem-c03-p1000-abcdef12', text: 'x', source: 'novel' }).source, { chapter: 3, para: 1000 });
  // 两处都拿不到才回 0/0：source 是显式串且 id 不合格式。
  assert.deepEqual(toDoc({ id: 'not-a-memory-id', text: 'x', source: 'novel' }).source, { chapter: 0, para: 0 });
  assert.deepEqual(toDoc({ text: 'x' }).source, { chapter: 0, para: 0 });
});
