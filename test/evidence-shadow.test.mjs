import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceShadow, safeEvidenceSnapshot } from '../src/evidence-shadow.mjs';

const q = 'bm25的颜色是什么';
const h = text => ({ text });
const keys = ['disabled','invalid','overBudget','failed','analyzed','unsupported','noEvidence','candidates','ambiguous','uncertain','conflict','semanticUncertain','contextIncomplete'];
const check = r => { assert.deepEqual(Object.keys(r), keys); for (const v of Object.values(r)) assert.ok(Number.isSafeInteger(v) && v >= 0); };

test('disabled never examines inputs or calls analyzer', () => {
  let calls = 0; const p = new Proxy({}, { get() { throw Error('access'); } });
  const r = createEvidenceShadow().observe(p, p);
  check(r); assert.equal(r.disabled, 1); assert.equal(calls, 0);
});
test('snapshot permits ignored metadata without touching it or forwarding it', () => {
  let calls = 0; const input = { text: '秘密', originalText: '秘密', windowStart: 0, windowEnd: 2, truncated: false, startsAtBoundary: true };
  Object.defineProperty(input, 'id', { get() { throw Error('id read'); }, enumerable: true });
  Object.defineProperty(input, 'extra', { get() { throw Error('extra read'); }, enumerable: true });
  const before = Object.getOwnPropertyDescriptors(input);
  const snapshot = safeEvidenceSnapshot(q, [input]);
  assert.equal(snapshot.query, q); assert.notEqual(snapshot.hits[0], input); assert.equal(Object.getPrototypeOf(snapshot.hits[0]), null); assert.deepEqual(Object.keys(snapshot.hits[0]), ['text','originalText','windowStart','windowEnd','truncated','startsAtBoundary']);
  const r = createEvidenceShadow({enabled:true}).observe(q, [input]); check(r); assert.equal(r.analyzed, 1); assert.deepEqual(Object.getOwnPropertyDescriptors(input), before); assert.ok(!JSON.stringify(r).includes('秘密'));
});
test('snapshot construction bypasses inherited array index accessors', () => {
  const hits = [{text:'synthetic first'}, {text:'synthetic second'}];
  const previous = [0, 1].map(i => Object.getOwnPropertyDescriptor(Array.prototype, String(i)));
  let reads = 0, writes = 0, captured, result;

  try {
    for (let i = 0; i < 2; i++) Object.defineProperty(Array.prototype, String(i), {configurable:true, get() { reads++; }, set() { writes++; }});
    result = safeEvidenceSnapshot('synthetic query', hits); captured = result.hits;
  } finally {
    for (let i = 0; i < 2; i++) {
      if (previous[i]) Object.defineProperty(Array.prototype, String(i), previous[i]);
      else delete Array.prototype[i];
    }
  }
  assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(result.query, 'synthetic query');
  assert.ok(Array.isArray(captured)); assert.equal(Object.getPrototypeOf(captured), Array.prototype);
  assert.deepEqual(captured.map(item => item.text), ['synthetic first', 'synthetic second']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(captured, '0'), {value:captured[0], writable:true, enumerable:true, configurable:true});
});
test('rejects proxies, getters, inherited fields and sparse arrays without invoking traps', () => {
  let traps = 0; const s = createEvidenceShadow({ enabled: true });
  const proxy = new Proxy({}, { get() { traps++; throw Error(); }, ownKeys() { traps++; throw Error(); } });
  const getter = {}; Object.defineProperty(getter, 'text', { get() { traps++; throw Error(); } });
  for (const hits of [proxy, [proxy], [getter], [Object.create({ text: 'x' })], Array(1)]) assert.equal(s.observe(q, hits).invalid, 1);
  assert.equal(traps, 0);
});
test('limits inclusive and excess skips entire analysis', () => {
  const s = createEvidenceShadow({ enabled: true });
  assert.equal(s.observe('q'.repeat(1024), [h('x'.repeat(8192))]).analyzed, 1);
  assert.equal(s.observe('q'.repeat(1025), []).overBudget, 1);
  assert.equal(s.observe(q, Array.from({length:65}, () => h(''))).overBudget, 1);
  assert.equal(s.observe(q, [h('x'.repeat(8193))]).overBudget, 1);
  assert.equal(s.observe(q, [{text:'', originalText:'x'.repeat(16385)}]).overBudget, 1);
  const hits = Array.from({length:16}, () => h('x'.repeat(8192)));
  assert.equal(s.observe('', hits).analyzed, 1); assert.equal(s.observe('x', hits).overBudget, 1);
  assert.equal(s.observe('', Array.from({length:64}, () => h(''))).analyzed, 1);
  assert.equal(s.observe('', [{text:'', originalText:'x'.repeat(16384)}]).analyzed, 1);
});
test('real analyzer status and independent flags are projected without content', () => {
  const s = createEvidenceShadow({enabled:true});
  const r = s.observe(q, [h('BM25的颜色是红色。'), h('BM25的颜色是蓝色。'), h('后来改为绿色。')]);
  check(r); assert.equal(r.analyzed, 1); assert.equal(r.uncertain, 1); assert.equal(r.conflict, 1); assert.equal(r.semanticUncertain, 1); assert.equal(r.contextIncomplete, 0);
  assert.equal(s.observe('other', []).unsupported, 1);
});
test('injected rejected promise analyzers are never invoked under strict rejection handling', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `import { createEvidenceShadow } from './src/evidence-shadow.mjs';
    let calls = 0;
    const analyzers = [() => { calls++; const p = Promise.reject(Error('rejected')); Object.defineProperty(p, 'constructor', { get() { throw Error('constructor'); } }); return p; }, () => { calls++; const p = Promise.reject(Error('rejected')); Object.setPrototypeOf(p, null); return p; }, async () => { calls++; throw Error('rejected'); }];
    for (const analyze of analyzers) {
      try { createEvidenceShadow({ enabled: true, analyze }); process.exit(2); }
      catch (error) { if (!(error instanceof TypeError)) process.exit(4); }
    }
    if (calls !== 0) process.exit(3);
    setImmediate(() => process.stdout.write('handled'));`;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {cwd: process.cwd(), encoding:'utf8'});
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'handled');
});
test('legacy analyze is rejected synchronously without evaluating accessors or callbacks', () => {
  let calls = 0;
  for (const enabled of [true, false, undefined]) {
    for (const value of [undefined, null, () => { calls++; }]) {
      assert.throws(() => createEvidenceShadow({enabled, analyze:value}), /analyze option is no longer supported/);
    }
    const options = {enabled};
    Object.defineProperty(options, 'analyze', {get() { calls++; throw Error('unexpected access'); }});
    assert.throws(() => createEvidenceShadow(options), TypeError);
    const inherited = Object.create(options);
    assert.throws(() => createEvidenceShadow(inherited), TypeError);
  }
  assert.equal(calls, 0);
});
test('option proxies and enabled accessors are rejected without traps or getters', () => {
  let calls = 0;
  const proxy = new Proxy({}, {get() { calls++; }, getOwnPropertyDescriptor() { calls++; }, getPrototypeOf() { calls++; }});
  assert.throws(() => createEvidenceShadow(proxy), TypeError);
  assert.throws(() => createEvidenceShadow(Object.create(proxy)), TypeError);
  const options = {};
  Object.defineProperty(options, 'enabled', {get() { calls++; return true; }});
  assert.throws(() => createEvidenceShadow(options), TypeError);
  assert.equal(calls, 0);
});
