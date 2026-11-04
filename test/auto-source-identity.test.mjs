import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { formatSource, similarity } from '../src/auto-capture.mjs';

function fixture(options = {}) {
  const tools = new Map(), hooks = new Map(), services = new Map();
  const ctx = {
    tools: { register: x => { tools.set(x.name, x); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    provide: (name, value) => { services.set(name, value); return () => {}; },
    effect: fn => fn(), on: (name, fn) => { hooks.set(name, fn); return () => {}; },
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, autoCaptureLimitPerSession: 1,
    autoCaptureCooldownMs: 0, ...options });
  const run = async (id, turn, text) => {
    const decision = { kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] };
    assert.equal(await hooks.get('agent/pre-step')({ agent: { session: { id } }, turn }, async () => decision), decision);
  };
  return { app, run, hooks, tools, api: services.get('memjudge') };
}

const fact = '这个项目的包管理器用 pnpm，别用 npm';

test('invalid surrogate is reported without consuming host capture quota', async () => {
  const f = fixture();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await f.run('utf16', 1, `${fact}\ud800`);
    assert.equal(f.api.bySourcePrefix('').length, 0);
    assert.ok(warnings.some(line => line.includes('auto-capture skipped: unpaired-surrogate')));
    assert.ok(warnings.every(line => !line.includes(fact)));
    await f.run('utf16', 1, fact);
    assert.equal(f.api.bySourcePrefixV1(formatSource('utf16', 1)).length, 1);
  } finally { console.warn = original; f.app.dispose(); }
});

test('history replay and duplicates never invent additional sources', async () => {
  const f = fixture();
  try {
    await f.run('first', 1, fact);
    const id = f.api.bySourcePrefixV1(formatSource('first', 1))[0].id;
    const initial = f.api.occurrencesV1(id);
    await f.run('first', 1, fact);
    assert.deepEqual(f.api.occurrencesV1(id), initial);
    for (let turn = 1; turn <= 20; turn++) await f.run('second', turn, fact);
    assert.deepEqual(f.api.occurrencesV1(id), initial);
    await f.run('second', 2, '每周四下午安排项目测试和发布工作');
    assert.equal(f.api.bySourcePrefixV1(formatSource('second', 2)).length, 1);
    assert.equal(f.api.bySourcePrefix('').length, 2);
  } finally { f.app.dispose(); }
});

test('near duplicates and disabled capture do not add associations', async () => {
  const f = fixture();
  try {
    await f.run('one', 1, fact);
    const id = f.api.bySourcePrefixV1(formatSource('one', 1))[0].id;
    const near = `${fact}。`;
    assert.ok(similarity(fact, near) >= 0.85);
    await f.run('two', 1, near);
    assert.equal(f.api.occurrencesV1(id).length, 1);
    assert.equal(f.api.bySourcePrefix('').length, 1);
  } finally { f.app.dispose(); }
  const disabled = fixture({ autoCapture: false });
  try { await disabled.run('one', 1, fact); assert.equal(disabled.api.bySourcePrefix('').length, 0); }
  finally { disabled.app.dispose(); }
});

test('invalid turn never fabricates a source or consumes quota', async () => {
  const f = fixture();
  try {
    for (const turn of [undefined, null, NaN, Infinity, -1, 1.5, '1', {}, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => formatSource('one', turn));
      await f.run('one', turn, fact);
    }
    assert.equal(f.api.bySourcePrefix('').length, 0);
    await f.run('one', 0, fact);
    assert.equal(f.api.bySourcePrefixV1(formatSource('one', 0)).length, 1);
  } finally { f.app.dispose(); }
});

test('rewritten and concurrent duplicate messages do not add occurrences', async () => {
  const f = fixture({ autoCaptureLimitPerSession: 10 });
  try {
    await f.run('one', 1, fact);
    const id = f.api.bySourcePrefixV1(formatSource('one', 1))[0].id;
    const original = f.api.occurrencesV1(id);
    const message = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
    const handler = f.hooks.get('agent/pre-step');
    const decision = { kind: 'enter', messages: [message(fact)] };
    await handler({ agent: { session: { id: 'rewriter' } }, turn: 8, messages: [message('另一条实际输入原文')] }, async () => decision);
    assert.deepEqual(f.api.occurrencesV1(id), original);
    const fresh = '窗台上的蓝色台灯每天晚上八点亮起';
    const duplicateDecision = { kind: 'enter', messages: [message(fresh), message(fresh)] };
    await handler({ agent: { session: { id: 'same-batch' } }, turn: 1 }, async () => duplicateDecision);
    const rows = f.api.bySourcePrefixV1(formatSource('same-batch', 1));
    assert.equal(rows.length, 1);
    assert.equal(f.api.occurrencesV1(rows[0].id).length, 1);
    const remember = f.tools.get('memjudge_remember');
    await remember.execute({ text: fact, source: 'manual:second', documentId: 'doc:second' });
    assert.equal(f.api.occurrencesV1(id).length, 2);
    assert.equal(f.api.bySourcePrefixV1('manual:second')[0].documentId, 'doc:second');
  } finally { f.app.dispose(); }
});
