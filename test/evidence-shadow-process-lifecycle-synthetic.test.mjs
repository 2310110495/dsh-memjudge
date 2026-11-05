import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { createEvidenceShadowProcess } from '../src/evidence-shadow-process.mjs';

const valid = () => ({ disabled: 0, invalid: 0, overBudget: 0, failed: 0, analyzed: 1, unsupported: 0, noEvidence: 1, candidates: 0, ambiguous: 0, uncertain: 0, conflict: 0, semanticUncertain: 0, contextIncomplete: 0 });
const failed = () => ({ ...valid(), analyzed: 0, noEvidence: 0, failed: 1 });

function start(setup = () => {}) {
  const child = new EventEmitter();
  child.send = () => {};
  child.kill = () => true;
  setup(child);
  const original = childProcess.fork;
  childProcess.fork = () => child;
  syncBuiltinESMExports();
  try {
    const observer = createEvidenceShadowProcess({ enabled: true, timeoutMs: 1000 });
    const pending = observer.observe('synthetic query', []);
    return { child, observer, pending };
  } finally {
    childProcess.fork = original;
    syncBuiltinESMExports();
  }
}

test('synchronous close inside kill resolves close and preserves cancelled result', async () => {
  let kills = 0;
  const { child, observer, pending } = start(c => {
    c.kill = () => { kills++; c.emit('close', null, 'SIGTERM'); return true; };
  });
  child.emit('message', valid());
  const closing = observer.close();
  assert.strictEqual(observer.close(), closing);
  await closing;
  assert.deepEqual(await pending, failed());
  assert.equal(kills, 1);
  assert.equal((await observer.observe('synthetic', [])).disabled, 1);
});

test('duplicate messages cancel and hold the slot until close', async () => {
  let kills = 0;
  const { child, observer, pending } = start(c => { c.kill = () => { kills++; return true; }; });
  child.emit('message', valid());
  child.emit('message', valid());
  assert.deepEqual(await pending, failed());
  assert.equal(kills, 1);
  assert.equal((await observer.observe('synthetic', [])).overBudget, 1);
  child.emit('message', valid());
  child.emit('close', 0, null);
  await observer.close();
});

for (const message of [false, true]) {
  test(`nonzero close fails with valid response present: ${message}`, async () => {
    const { child, observer, pending } = start();
    if (message) child.emit('message', valid());
    child.emit('close', 7, null);
    assert.deepEqual(await pending, failed());
    await observer.close();
  });
}

for (const mode of ['callback', 'throw']) {
  test(`IPC send ${mode} settles failed and retains slot until close`, async () => {
    let kills = 0;
    const { child, observer, pending } = start(c => {
      c.kill = () => { kills++; return true; };
      c.send = (_snapshot, callback) => {
        if (mode === 'throw') throw Error('synthetic send error');
        callback(Error('synthetic send error'));
      };
    });
    assert.deepEqual(await pending, failed());
    assert.equal(kills, 1);
    assert.equal((await observer.observe('synthetic', [])).overBudget, 1);
    child.emit('message', valid());
    child.emit('close', 0, null);
    await observer.close();
  });
}

test('option accessors and proxies are rejected without invoking user code', () => {
  let calls = 0;
  for (const key of ['enabled', 'timeoutMs', 'analyze']) {
    const options = {};
    Object.defineProperty(options, key, { get() { calls++; throw Error('unexpected getter'); } });
    assert.throws(() => createEvidenceShadowProcess(options), TypeError);
    assert.throws(() => createEvidenceShadowProcess(Object.create(options)), TypeError);
  }
  const proxy = new Proxy({}, { get() { calls++; }, getOwnPropertyDescriptor() { calls++; }, getPrototypeOf() { calls++; } });
  assert.throws(() => createEvidenceShadowProcess(proxy), TypeError);
  assert.throws(() => createEvidenceShadowProcess(Object.create(proxy)), TypeError);
  assert.equal(calls, 0);
});

test('legacy analyze is rejected regardless of enabled or value', () => {
  let calls = 0;
  for (const enabled of [true, false, undefined]) for (const analyze of [undefined, null, () => { calls++; }]) {
    assert.throws(() => createEvidenceShadowProcess({ enabled, analyze }), /analyze option is no longer supported/);
    assert.throws(() => createEvidenceShadowProcess(Object.create({ enabled, analyze })), /analyze option is no longer supported/);
  }
  assert.equal(calls, 0);
});

test('data options retain defaults, inherited values, and timeout bounds', async () => {
  for (const options of [undefined, {}, { enabled: undefined, timeoutMs: undefined }, Object.create({ enabled: false, timeoutMs: 1 })]) {
    const observer = createEvidenceShadowProcess(options);
    assert.equal((await observer.observe('synthetic', [])).disabled, 1);
    await observer.close();
  }
  for (const timeoutMs of [null, 0, 30001, 1.5, '1000']) assert.throws(() => createEvidenceShadowProcess({ timeoutMs }), RangeError);
  assert.throws(() => createEvidenceShadowProcess(null), TypeError);
  const { child, observer, pending } = start();
  child.emit('message', valid());
  child.emit('close', 0, null);
  assert.deepEqual(await pending, valid());
  await observer.close();
});
