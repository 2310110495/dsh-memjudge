import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';

function fixture(injectBudget = 2000) {
  const tools = new Map(), sections = new Map();
  const ctx = {
    tools: { register: x => { tools.set(x.name, x); return () => {}; } },
    systemPrompt: { section: x => { sections.set(x.name, x); return () => {}; } },
    effect: fn => fn(),
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, autoInject: true, injectBudget });
  return { app, tools, inject: () => [...sections.values()][0].text() };
}

test('injection truncates title and source without splitting pairs and caches the result', async () => {
  const f = fixture();
  try {
    const text = 'a'.repeat(88) + '\ud83d\ude00' + 'tail';
    const source = 'b'.repeat(22) + '\ud83d\ude00' + 'tail';
    await f.tools.get('memjudge_remember').execute({ text, source, kind: 'person' });
    const output = f.inject();
    assert.ok(output.includes('a'.repeat(88) + '…'));
    assert.ok(output.includes('b'.repeat(22) + '…'));
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(output));
    assert.equal(f.inject(), output);
    assert.ok(output.length <= 2000);
  } finally { f.app.dispose(); }
});

test('exact boundaries, ordinary truncation and tiny budgets preserve rendering semantics', async () => {
  const f = fixture();
  try {
    const remember = f.tools.get('memjudge_remember');
    await remember.execute({ text: 'c'.repeat(88) + '\ud83d\ude00', source: 'd'.repeat(22) + '\ud83d\ude00', kind: 'person' });
    await remember.execute({ text: 'e'.repeat(91), source: 'f'.repeat(25), kind: 'promise' });
    const output = f.inject();
    assert.ok(output.includes('c'.repeat(88) + '\ud83d\ude00'));
    assert.ok(output.includes('d'.repeat(22) + '\ud83d\ude00'));
    assert.ok(output.includes('e'.repeat(89) + '…'));
    assert.ok(output.includes('f'.repeat(23) + '…'));
  } finally { f.app.dispose(); }
  const small = fixture(1);
  try {
    await small.tools.get('memjudge_remember').execute({ text: 'tiny \ud83d\ude00 value', kind: 'person' });
    assert.equal(small.inject(), '');
    assert.equal(small.inject(), '');
  } finally { small.app.dispose(); }
});
