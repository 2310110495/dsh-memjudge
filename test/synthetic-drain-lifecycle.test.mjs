import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticDrainLifecycle } from '../src/synthetic-drain-lifecycle.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('synchronous seal, async unregister, drain and shared close', async () => {
  const gate = deferred(), events = [];
  const lifecycle = createSyntheticDrainLifecycle({
    unregister: [async () => { events.push('start'); await gate.promise; events.push('end'); }],
    close: () => events.push('close'),
  });
  const release = lifecycle.acquire();
  const closing = lifecycle.shutdown();
  assert.strictEqual(lifecycle.shutdown(), closing);
  assert.equal(lifecycle.state, 'closing');
  assert.throws(() => lifecycle.acquire(), /closing/);
  assert.deepEqual(events, []);
  await Promise.resolve();
  assert.deepEqual(events, ['start']);
  gate.resolve();
  await gate.promise;
  await Promise.resolve();
  assert.deepEqual(events, ['start', 'end']);
  assert.equal(release(), true);
  assert.equal(release(), false);
  await closing;
  assert.equal(lifecycle.state, 'closed');
  assert.deepEqual(events, ['start', 'end', 'close']);
  assert.strictEqual(lifecycle.shutdown(), closing);
});

test('unregister errors continue and aggregate with close error', async () => {
  const events = [], closeError = Error('close');
  const lifecycle = createSyntheticDrainLifecycle({
    unregister: [() => { events.push(1); throw undefined; }, async () => { events.push(2); throw Error('unregister'); }, () => events.push(3)],
    close: () => { events.push(4); throw closeError; },
  });
  const release = lifecycle.acquire();
  const closing = lifecycle.shutdown(), outcome = closing.catch(error => error);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.deepEqual(events, [1, 2, 3]);
  release();
  const error = await outcome;
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 3);
  assert.equal(error.errors[0], undefined);
  assert.equal(error.errors[1].message, 'unregister');
  assert.strictEqual(error.errors[2], closeError);
  assert.deepEqual(events, [1, 2, 3, 4]);
  assert.strictEqual(lifecycle.shutdown(), closing);
  assert.equal(lifecycle.state, 'closed');
});

test('run releases on synchronous throw, async rejection and success', async () => {
  const lifecycle = createSyntheticDrainLifecycle({ close() {} });
  const syncError = Error('sync');
  assert.throws(() => lifecycle.run(() => { throw syncError; }), error => error === syncError);
  assert.equal(lifecycle.activeLeases, 0);
  const gate = deferred(), running = lifecycle.run(() => gate.promise);
  assert.equal(lifecycle.activeLeases, 1);
  const closing = lifecycle.shutdown();
  gate.resolve(42);
  assert.equal(await running, 42);
  await closing;
  const another = createSyntheticDrainLifecycle({ close() {} }), rejection = Error('async');
  await assert.rejects(another.run(async () => { throw rejection; }), error => error === rejection);
  assert.equal(another.activeLeases, 0);
  await another.shutdown();
});

test('leaked lease keeps close pending until released', async () => {
  let closed = 0, settled = false;
  const lifecycle = createSyntheticDrainLifecycle({ close: () => { closed++; } });
  const release = lifecycle.acquire();
  const closing = lifecycle.shutdown().finally(() => { settled = true; });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(closed, 0);
  assert.equal(lifecycle.activeLeases, 1);
  release();
  await closing;
  assert.equal(closed, 1);
});

test('validates inputs and snapshots unregister list', async () => {
  assert.throws(() => createSyntheticDrainLifecycle({ unregister: [null], close() {} }), TypeError);
  assert.throws(() => createSyntheticDrainLifecycle({ close: null }), TypeError);
  const events = [], unregister = [() => events.push('original')];
  const lifecycle = createSyntheticDrainLifecycle({ unregister, close: () => events.push('close') });
  unregister.push(() => events.push('late'));
  assert.throws(() => lifecycle.run(null), TypeError);
  await lifecycle.shutdown();
  assert.deepEqual(events, ['original', 'close']);
});

test('rejects sparse arrays, including holes with inherited functions', () => {
  assert.throws(() => createSyntheticDrainLifecycle({ unregister: Array(1), close() {} }), TypeError);
  const entries = [() => {}, , () => {}];
  assert.throws(() => createSyntheticDrainLifecycle({ unregister: entries, close() {} }), TypeError);
  const inherited = Array(1);
  const prototype = Object.create(Array.prototype);
  prototype[0] = () => {};
  Object.setPrototypeOf(inherited, prototype);
  assert.throws(() => createSyntheticDrainLifecycle({ unregister: inherited, close() {} }), TypeError);
});

test('snapshots each accessor once before validating and propagates getter errors', async () => {
  let reads = 0;
  const events = [], entries = [];
  Object.defineProperty(entries, 0, { configurable: true, get() { reads++; return reads === 1 ? () => events.push('first') : undefined; } });
  const lifecycle = createSyntheticDrainLifecycle({ unregister: entries, close: () => events.push('close') });
  assert.equal(reads, 1);
  Object.defineProperty(entries, 0, { value: () => events.push('replacement') });
  await lifecycle.shutdown();
  assert.equal(reads, 1);
  assert.deepEqual(events, ['first', 'close']);

  const invalid = [];
  Object.defineProperty(invalid, 0, { get() { return undefined; } });
  assert.throws(() => createSyntheticDrainLifecycle({ unregister: invalid, close() {} }), TypeError);
  const error = Error('getter failed'), throwing = [];
  Object.defineProperty(throwing, 0, { get() { throw error; } });
  assert.throws(() => createSyntheticDrainLifecycle({ unregister: throwing, close() {} }), value => value === error);
});

test('accessor side effects are reflected in the single ordered snapshot', async () => {
  const events = [], entries = [null, () => events.push('old')];
  Object.defineProperty(entries, 0, { get() { entries[1] = () => events.push('new'); return () => events.push('first'); } });
  const lifecycle = createSyntheticDrainLifecycle({ unregister: entries, close: () => events.push('close') });
  entries[1] = () => events.push('late');
  await lifecycle.shutdown();
  assert.deepEqual(events, ['first', 'new', 'close']);
});

test('getter pushes beyond the captured length without adding an unregister callback', async () => {
  const events = [], entries = [null, () => events.push('second')];
  Object.defineProperty(entries, 0, { get() {
    events.push('getter');
    entries.push(() => events.push('pushed'));
    return () => events.push('first');
  } });
  const lifecycle = createSyntheticDrainLifecycle({ unregister: entries, close: () => events.push('close') });
  assert.equal(entries.length, 3);
  assert.deepEqual(events, ['getter']);
  await lifecycle.shutdown();
  assert.deepEqual(events, ['getter', 'first', 'second', 'close']);
});

test('getter shortening length leaves later captured indexes invalid despite inherited functions', () => {
  const events = [], entries = [null, () => events.push('removed')];
  const prototype = Object.create(Array.prototype);
  prototype[1] = () => events.push('inherited');
  Object.setPrototypeOf(entries, prototype);
  Object.defineProperty(entries, 0, { configurable: true, get() {
    events.push('getter');
    entries.length = 1;
    return () => events.push('first');
  } });
  assert.throws(() => createSyntheticDrainLifecycle({ unregister: entries, close() {} }), TypeError);
  assert.equal(entries.length, 1);
  assert.equal(Object.hasOwn(entries, 1), false);
  assert.deepEqual(events, ['getter']);
});

test('getter deletion is checked per index and validation waits for later getters', () => {
  const events = [], entries = [null, () => events.push('deleted'), null];
  const prototype = Object.create(Array.prototype);
  prototype[1] = () => events.push('inherited');
  Object.setPrototypeOf(entries, prototype);
  Object.defineProperty(entries, 0, { get() {
    events.push('first getter');
    delete entries[1];
    return () => events.push('first');
  } });
  Object.defineProperty(entries, 2, { get() {
    events.push('third getter');
    return () => events.push('third');
  } });
  assert.throws(() => createSyntheticDrainLifecycle({ unregister: entries, close() {} }), TypeError);
  assert.equal(entries.length, 3);
  assert.equal(Object.hasOwn(entries, 1), false);
  assert.deepEqual(events, ['first getter', 'third getter']);
});

test('waits for thenables and allows non-awaiting shutdown reentry', async () => {
  const gate = deferred(), events = [];
  let lifecycle, reentered;
  lifecycle = createSyntheticDrainLifecycle({
    unregister: [() => { reentered = lifecycle.shutdown(); events.push('unregister'); return { then(resolve) { gate.promise.then(resolve); } }; }],
    close: () => events.push('close'),
  });
  const closing = lifecycle.shutdown();
  await Promise.resolve();
  assert.strictEqual(reentered, closing);
  assert.deepEqual(events, ['unregister']);
  gate.resolve();
  await closing;
  assert.deepEqual(events, ['unregister', 'close']);
});
