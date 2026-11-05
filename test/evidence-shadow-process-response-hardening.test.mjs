import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { createEvidenceShadowProcess } from '../src/evidence-shadow-process.mjs';

const valid = () => ({ disabled: 0, invalid: 0, overBudget: 0, failed: 0, analyzed: 1, unsupported: 0, noEvidence: 1, candidates: 0, ambiguous: 0, uncertain: 0, conflict: 0, semanticUncertain: 0, contextIncomplete: 0 });

async function respond(message, afterMessage = () => {}) {
  const original = childProcess.fork;
  const child = new EventEmitter();
  child.send = () => {};
  child.kill = () => true;
  childProcess.fork = () => child;
  syncBuiltinESMExports();
  let observer;
  let pending;
  try {
    observer = createEvidenceShadowProcess({ enabled: true });
    pending = observer.observe('synthetic', []);
  } finally {
    childProcess.fork = original;
    syncBuiltinESMExports();
  }
  child.emit('message', message);
  afterMessage();
  child.emit('close', 0, null);
  const result = await pending;
  await observer.close();
  return result;
}

test('projects valid own data fields before returning IPC response', async () => {
  const message = valid();
  const result = await respond(message, () => { message.analyzed = 0; });
  assert.equal(result.analyzed, 1);
  assert.notStrictEqual(result, message);
  assert.deepEqual(result, valid());
});

test('rejects inherited field replaced with extra enumerable field without invoking inherited getter', async () => {
  let calls = 0;
  const message = valid();
  delete message.analyzed;
  message.forged = 0;
  Object.setPrototypeOf(message, { get analyzed() { calls++; return 1; } });
  assert.equal((await respond(message)).failed, 1);
  assert.equal(calls, 0);
});

test('rejects own accessors without invoking getter', async () => {
  let calls = 0;
  const message = valid();
  Object.defineProperty(message, 'analyzed', { enumerable: true, get() { calls++; return 1; } });
  assert.equal((await respond(message)).failed, 1);
  assert.equal(calls, 0);
});

test('rejects hidden and symbol extras, missing fields, and invalid values', async () => {
  const hidden = valid();
  Object.defineProperty(hidden, 'extra', { value: 0 });
  const symbol = valid();
  symbol[Symbol('extra')] = 0;
  const missing = valid();
  delete missing.analyzed;
  const invalid = valid();
  invalid.analyzed = 2;
  for (const message of [hidden, symbol, missing, invalid, null, []]) {
    assert.equal((await respond(message)).failed, 1);
  }
});

test('descriptor trap errors fail closed', async () => {
  const message = new Proxy(valid(), { getOwnPropertyDescriptor() { throw Error('synthetic'); } });
  assert.equal((await respond(message)).failed, 1);
});

test('rejects all-zero and mutually conflicting terminal and status counts', async () => {
  const zero = Object.fromEntries(Object.keys(valid()).map(key => [key, 0]));
  const invalid = [zero, { ...valid(), failed: 1 }, { ...valid(), candidates: 1 },
    { ...valid(), analyzed: 0 }, { ...zero, failed: 1, invalid: 1 }];
  for (const message of invalid) assert.deepEqual(await respond(message), { ...zero, failed: 1 });
});

test('validates flags against analyzed and status without inventing flag exclusions', async () => {
  const zero = Object.fromEntries(Object.keys(valid()).map(key => [key, 0]));
  for (const terminal of ['disabled', 'invalid', 'overBudget', 'failed']) {
    for (const flag of ['conflict', 'semanticUncertain', 'contextIncomplete']) {
      assert.deepEqual(await respond({ ...zero, [terminal]: 1, [flag]: 1 }), { ...zero, failed: 1 });
    }
  }
  for (const status of ['unsupported', 'noEvidence', 'candidates', 'ambiguous', 'uncertain']) {
    for (const conflict of [0, 1]) for (const semanticUncertain of [0, 1]) for (const contextIncomplete of [0, 1]) {
      const message = { ...zero, analyzed: 1, [status]: 1, conflict, semanticUncertain, contextIncomplete };
      const validCombination = status === 'unsupported' ? !conflict && !semanticUncertain && !contextIncomplete :
        semanticUncertain || contextIncomplete ? status === 'uncertain' :
        conflict ? status === 'ambiguous' : status === 'candidates' || status === 'noEvidence';
      assert.deepEqual(await respond(message), validCombination ? message : { ...zero, failed: 1 }, JSON.stringify(message));
    }
  }
  for (const terminal of ['disabled', 'invalid', 'overBudget', 'failed']) {
    const message = { ...zero, [terminal]: 1 };
    assert.deepEqual(await respond(message), message);
  }
});
