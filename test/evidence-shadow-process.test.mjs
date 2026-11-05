import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { createEvidenceShadowProcess } from '../src/evidence-shadow-process.mjs';

test('disabled and closed avoid inspecting hostile inputs', async () => {
  const input = new Proxy({}, { get() { throw Error('access'); } });
  const s = createEvidenceShadowProcess();
  assert.equal((await s.observe(input, input)).disabled, 1);
  await s.close();
  assert.equal((await s.observe(input, input)).disabled, 1);
});
test('fixed worker returns counts without query or snippets', async () => {
  const s = createEvidenceShadowProcess({ enabled: true, timeoutMs: 10000 });
  const r = await s.observe('bm25的颜色是什么', [{text:'BM25的颜色是红色。'}, {text:'BM25的颜色是蓝色。'}]);
  assert.equal(r.analyzed, 1); assert.equal(r.ambiguous, 1); assert.equal(r.conflict, 1);
  assert.ok(!JSON.stringify(r).includes('BM25'));
  await s.close();
});
test('input limits, zero queue, and close cancellation', async () => {
  const s = createEvidenceShadowProcess({ enabled: true, timeoutMs: 10000 });
  assert.equal((await s.observe('x'.repeat(1025), [])).overBudget, 1);
  const pending = s.observe('q', []);
  assert.equal((await s.observe('q', [])).overBudget, 1);
  await s.close();
  assert.equal((await pending).failed, 1);
  assert.equal((await s.observe('q', [])).disabled, 1);
});
test('timeout settles and retains the slot until worker closes', async () => {
  const s = createEvidenceShadowProcess({ enabled: true, timeoutMs: 1 });
  assert.equal((await s.observe('q', [])).failed, 1);
  const next = await s.observe('q', []);
  assert.equal(next.failed + next.overBudget, 1);
  await s.close().catch(error => assert.equal(error.code, 'ERR_SHADOW_CLOSE_TIMEOUT'));
});
test('array prototype toJSON cannot inspect snapshot', async () => {
  const s = createEvidenceShadowProcess({ enabled: true, timeoutMs: 10000 });
  let calls = 0;
  let pending;
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  try {
    Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value() { calls++; throw Error('hook'); } });
    pending = s.observe('synthetic query', [{ text: 'synthetic text' }]);
  } finally {
    if (previous) Object.defineProperty(Array.prototype, 'toJSON', previous);
    else delete Array.prototype.toJSON;
  }
  assert.equal(calls, 0);
  assert.equal((await pending).analyzed, 1);
  await s.close();
});

test('array index accessors do not observe process snapshot construction', async () => {
  const s = createEvidenceShadowProcess({ enabled: true });
  const hits = [{text:'synthetic process text'}];
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  const stringify = JSON.stringify;
  let reads = 0, writes = 0, captured, pending;
  try {
    JSON.stringify = value => { captured = value; throw Error('stop before worker'); };
    Object.defineProperty(Array.prototype, '0', {configurable:true, get() { reads++; }, set() { writes++; }});
    pending = s.observe('synthetic query', hits);
  } finally {
    if (previous) Object.defineProperty(Array.prototype, '0', previous);
    else delete Array.prototype[0];
    JSON.stringify = stringify;
  }
  assert.equal(reads, 0); assert.equal(writes, 0);
  assert.equal(Object.getPrototypeOf(captured.hits), null);
  assert.equal(captured.hits[0].text, 'synthetic process text');
  assert.equal((await pending).failed, 1);
  await s.close();
});
test('serialization exceptions become failed results', async () => {
  const s = createEvidenceShadowProcess({ enabled: true });
  const stringify = JSON.stringify;
  let pending;
  try {
    JSON.stringify = () => { throw Error('synthetic serialization failure'); };
    pending = s.observe('synthetic', []);
  } finally { JSON.stringify = stringify; }
  assert.equal((await pending).failed, 1);
  await s.close();
});

test('cancellation is final even when kill throws and messages arrive late', async () => {
  const originalFork = childProcess.fork;
  const child = new EventEmitter();
  child.send = () => {};
  child.kill = () => { throw Error('synthetic kill failure'); };
  childProcess.fork = () => child;
  syncBuiltinESMExports();
  let s;
  let pending;
  try {
    s = createEvidenceShadowProcess({ enabled: true, timeoutMs: 10000 });
    pending = s.observe('synthetic', []);
  } finally {
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  }
  const closing = s.close();
  child.emit('message', { disabled: 0, invalid: 0, overBudget: 0, failed: 0, analyzed: 1, unsupported: 0, noEvidence: 1, candidates: 0, ambiguous: 0, uncertain: 0, conflict: 0, semanticUncertain: 0, contextIncomplete: 0 });
  child.emit('close', 0, null);
  await closing;
  assert.equal((await pending).failed, 1);
});

test('timeout settles when kill returns false and keeps the slot occupied', async () => {
  const originalFork = childProcess.fork;
  const child = new EventEmitter();
  child.send = () => {};
  child.kill = () => false;
  childProcess.fork = () => child;
  syncBuiltinESMExports();
  let s;
  let pending;
  try {
    s = createEvidenceShadowProcess({ enabled: true, timeoutMs: 1 });
    pending = s.observe('synthetic', []);
  } finally {
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  }
  assert.equal((await pending).failed, 1);
  child.emit('message', { disabled: 0, invalid: 0, overBudget: 0, failed: 0, analyzed: 1, unsupported: 0, noEvidence: 1, candidates: 0, ambiguous: 0, uncertain: 0, conflict: 0, semanticUncertain: 0, contextIncomplete: 0 });
  assert.equal((await s.observe('synthetic', [])).overBudget, 1);
  child.emit('close', 0, null);
  await s.close();
});

for (const mode of ['throw', 'false', 'true']) {
  test(`close waits for close event after kill ${mode}, times out, and tolerates late close`, async () => {
    const originalFork = childProcess.fork;
    const child = new EventEmitter();
    let kills = 0;
    child.send = () => {};
    child.kill = () => { kills++; if (mode === 'throw') throw Error('synthetic'); return mode === 'true'; };
    childProcess.fork = () => child;
    syncBuiltinESMExports();
    let s, pending;
    try {
      s = createEvidenceShadowProcess({ enabled: true, timeoutMs: 30 });
      pending = s.observe('synthetic', []);
    } finally {
      childProcess.fork = originalFork;
      syncBuiltinESMExports();
    }
    const closing = s.close();
    assert.strictEqual(s.close(), closing);
    assert.equal((await s.observe('synthetic', [])).disabled, 1);
    assert.equal((await pending).failed, 1);
    child.emit('exit', 0, null);
    await assert.rejects(closing, { code: 'ERR_SHADOW_CLOSE_TIMEOUT' });
    assert.equal(kills, 1);
    child.emit('close', 0, null);
    await assert.rejects(s.close(), { code: 'ERR_SHADOW_CLOSE_TIMEOUT' });
  });
}

test('exit leaves slot occupied and concurrent close waits for child close', async () => {
  const originalFork = childProcess.fork;
  const child = new EventEmitter();
  child.send = () => {};
  child.kill = () => true;
  childProcess.fork = () => child;
  syncBuiltinESMExports();
  let s, pending;
  try {
    s = createEvidenceShadowProcess({ enabled: true, timeoutMs: 1000 });
    pending = s.observe('synthetic', []);
  } finally {
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  }
  child.emit('exit', 0, null);
  assert.equal((await s.observe('synthetic', [])).overBudget, 1);
  const first = s.close();
  const second = s.close();
  assert.strictEqual(first, second);
  let settled = false;
  first.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit('close', 0, null);
  await Promise.all([first, second]);
  assert.equal((await pending).failed, 1);
});
