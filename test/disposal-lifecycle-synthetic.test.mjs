import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisposal, initializeWithDisposal } from '../src/disposal.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('reverse order waits for each disposer before closing and shares the promise', async () => {
  const events = [];
  const gate = deferred();
  const lifecycle = createDisposal({ close: () => events.push('close') });
  lifecycle.track(() => events.push('first'));
  lifecycle.track(async () => { events.push('second:start'); await gate.promise; events.push('second:end'); });
  const a = lifecycle.dispose();
  assert.equal(lifecycle.dispose(), a);
  await Promise.resolve();
  assert.deepEqual(events, ['second:start']);
  gate.resolve();
  await a;
  assert.deepEqual(events, ['second:start', 'second:end', 'first', 'close']);
  assert.equal(lifecycle.dispose(), a);
});

test('all thrown values survive and later disposers and close still execute', async () => {
  const events = [];
  const failure = new Error('disposer');
  const lifecycle = createDisposal({ close: () => { events.push('close'); throw undefined; } });
  lifecycle.track(() => { events.push('first'); throw failure; });
  lifecycle.track(async () => { events.push('second'); throw 'rejected'; });
  const attempt = lifecycle.dispose();
  await assert.rejects(attempt, (e) => {
    assert.deepEqual(e.errors, ['rejected', failure, undefined]);
    return true;
  });
  assert.deepEqual(events, ['second', 'first', 'close']);
});

test('failed close retries without rerunning registrations and preserves earlier failures', async () => {
  let closes = 0;
  let releases = 0;
  let clears = 0;
  const failure = new Error('close');
  const lifecycle = createDisposal({
    close: async () => { if (++closes === 1) throw failure; },
    clear: () => { clears++; },
  });
  lifecycle.track(() => { releases++; });
  const first = lifecycle.dispose();
  assert.equal(first, lifecycle.dispose());
  await assert.rejects(first, (e) => e.errors[0] === failure);
  const retry = lifecycle.dispose();
  assert.notEqual(retry, first);
  assert.equal(retry, lifecycle.dispose());
  await assert.rejects(retry, (e) => e.errors[0] === failure);
  assert.equal(lifecycle.dispose(), retry);
  assert.deepEqual([closes, releases, clears], [2, 1, 1]);
  assert.throws(() => lifecycle.track(() => {}), /already started/);
});

test('initialization and effect registration failures start shared rollback', async () => {
  for (const failEffect of [false, true]) {
    const original = new Error('startup');
    const cleanup = new Error('cleanup');
    const reports = [];
    const events = [];
    let hostDisposer;
    const life = createDisposal({ close: () => { events.push('close'); throw cleanup; } });
    const ctx = { effect: (fn) => { hostDisposer = fn(); if (failEffect) throw original; } };
    assert.throws(() => initializeWithDisposal(ctx, life.dispose, () => {
      life.track(async () => { events.push('release'); });
      throw original;
    }, (error) => reports.push(error)), (error) => error === original);
    const same = hostDisposer();
    await assert.rejects(same, (e) => e.errors[0] === cleanup);
    await Promise.resolve();
    assert.deepEqual(events, failEffect ? ['close'] : ['release', 'close']);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].errors[0], cleanup);
  }
});

test('close is awaited before disposal settles', async () => {
  const gate = deferred();
  let finished = false;
  const lifecycle = createDisposal({ close: () => gate.promise });
  const attempt = lifecycle.dispose().then(() => { finished = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  gate.resolve();
  await attempt;
  assert.equal(finished, true);
});
