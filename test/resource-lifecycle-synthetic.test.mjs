import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceScope, withStore } from '../src/resource-lifecycle.mjs';

test('cleanup is sequential, asynchronous, reverse ordered and shared', async () => {
  const scope = createResourceScope();
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  scope.defer(() => events.push('first'));
  scope.defer(async () => { events.push('second-start'); await gate; events.push('second-end'); });
  const closing = scope.close();
  assert.strictEqual(scope.close(), closing);
  assert.throws(() => scope.defer(() => {}));
  await Promise.resolve();
  assert.deepEqual(events, ['second-start']);
  release();
  await closing;
  assert.deepEqual(events, ['second-start', 'second-end', 'first']);
  assert.strictEqual(scope.close(), closing);
});

test('cleanup keeps all failures and continues including thrown undefined', async () => {
  const scope = createResourceScope();
  const error = Error('synthetic');
  const events = [];
  scope.defer(() => { events.push(1); throw undefined; });
  scope.defer(() => { events.push(2); });
  scope.defer(async () => { events.push(3); throw error; });
  const closing = scope.close();
  await assert.rejects(closing, e => e instanceof AggregateError && e.errors.length === 2 && e.errors[0] === error && e.errors[1] === undefined);
  assert.deepEqual(events, [3, 2, 1]);
  assert.strictEqual(scope.close(), closing);
  await assert.rejects(scope.close(), AggregateError);
});

test('returning or awaiting reentrant close fails and remaining cleanup runs', { timeout: 1000 }, async () => {
  for (const dispose of [scope => () => scope.close(), scope => async () => { await Promise.resolve(); await scope.close(); }]) {
    const scope = createResourceScope();
    const events = [];
    scope.defer(() => events.push('remaining'));
    scope.defer(dispose(scope));
    const closing = scope.close();
    assert.strictEqual(scope.close(), closing);
    await assert.rejects(closing, error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0].code === 'ERR_RESOURCE_SCOPE_REENTRANT_CLOSE');
    assert.deepEqual(events, ['remaining']);
    assert.strictEqual(scope.close(), closing);
  }
});

test('nested scopes detect an active ancestor and preserve failures', { timeout: 1000 }, async () => {
  const outer = createResourceScope();
  const inner = createResourceScope();
  const events = [];
  const failure = Error('inner failure');
  outer.defer(() => events.push('outer remaining'));
  outer.defer(() => inner.close());
  inner.defer(() => { events.push('inner remaining'); throw failure; });
  inner.defer(async () => { await Promise.resolve(); return outer.close(); });
  await assert.rejects(outer.close(), error => {
    const nested = error.errors[0];
    return error instanceof AggregateError && nested instanceof AggregateError && nested.errors[0].code === 'ERR_RESOURCE_SCOPE_REENTRANT_CLOSE' && nested.errors[1] === failure;
  });
  assert.deepEqual(events, ['inner remaining', 'outer remaining']);
});

test('detached async context expires after its disposer completes', { timeout: 1000 }, async () => {
  const scope = createResourceScope();
  let release;
  let detached;
  const gate = new Promise(resolve => { release = resolve; });
  scope.defer(() => { detached = gate.then(() => scope.close()); });
  const closing = scope.close();
  await closing;
  release();
  await detached;
  assert.strictEqual(scope.close(), closing);
});

test('external concurrent close shares promise while disposer is active', { timeout: 1000 }, async () => {
  const scope = createResourceScope();
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  scope.defer(async () => { started(); await gate; });
  const closing = scope.close();
  await ready;
  assert.strictEqual(scope.close(), closing);
  release();
  await closing;
});

test('independently started two and three scope cycles settle and run remaining cleanup', { timeout: 1000 }, async () => {
  for (const count of [2, 3]) {
    const scopes = Array.from({ length: count }, () => createResourceScope());
    const events = [];
    const failure = Error('cleanup failure');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    scopes.forEach((scope, index) => {
      scope.defer(() => { events.push(index); if (index === 0) throw failure; });
      scope.defer(async () => { await gate; return scopes[(index + 1) % count].close(); });
    });
    const closings = scopes.map(scope => scope.close());
    release();
    const results = await Promise.allSettled(closings);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.deepEqual([...events].sort(), scopes.map((_, index) => index));
    const hasError = (error, predicate, seen = new Set()) => {
      if (predicate(error)) return true;
      if (!(error instanceof AggregateError) || seen.has(error)) return false;
      seen.add(error);
      return error.errors.some(item => hasError(item, predicate, seen));
    };
    assert.ok(results.some(result => hasError(result.reason, error => error?.code === 'ERR_RESOURCE_SCOPE_REENTRANT_CLOSE')));
    assert.ok(results.some(result => hasError(result.reason, error => error === failure)));
    scopes.forEach((scope, index) => assert.strictEqual(scope.close(), closings[index]));
  }
});

test('independent acyclic dependencies wait and preserve reverse order', { timeout: 1000 }, async () => {
  const a = createResourceScope();
  const b = createResourceScope();
  const c = createResourceScope();
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  a.defer(() => events.push('a remaining'));
  a.defer(async () => { await gate; await b.close(); events.push('a dependency'); });
  b.defer(() => events.push('b remaining'));
  b.defer(async () => { await gate; await c.close(); events.push('b dependency'); });
  c.defer(async () => { await gate; events.push('c'); });
  const closings = [a.close(), b.close(), c.close()];
  assert.strictEqual(a.close(), closings[0]);
  release();
  await Promise.all(closings);
  assert.deepEqual(events, ['c', 'b dependency', 'b remaining', 'a dependency', 'a remaining']);
});

test('expired disposer context creates no dependency edge', { timeout: 1000 }, async () => {
  const a = createResourceScope();
  const b = createResourceScope();
  let release;
  let detached;
  const gate = new Promise(resolve => { release = resolve; });
  a.defer(() => { detached = gate.then(() => b.close()); });
  await a.close();
  b.defer(() => a.close());
  release();
  await detached;
  await b.close();
});

test('unawaited close is conservatively treated as a dependency until disposer ends', { timeout: 1000 }, async () => {
  const a = createResourceScope();
  const b = createResourceScope();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  a.defer(async () => { b.close().catch(() => {}); await gate; });
  b.defer(() => a.close());
  const closing = a.close();
  await Promise.resolve();
  release();
  await closing;
  await assert.rejects(b.close(), error => error.errors[0].code === 'ERR_RESOURCE_SCOPE_REENTRANT_CLOSE');
});

test('regression detached active branches synchronously reject unawaited self and ancestor close', { timeout: 1000 }, async () => {
  const outer = createResourceScope();
  const inner = createResourceScope();
  const errors = [];
  outer.defer(() => inner.close());
  inner.defer(async () => {
    await Promise.resolve().then(() => {
      for (const scope of [inner, outer]) {
        let returned = false;
        assert.throws(() => { scope.close(); returned = true; }, error => {
          errors.push(error.code);
          return error.code === 'ERR_RESOURCE_SCOPE_REENTRANT_CLOSE';
        });
        assert.equal(returned, false);
      }
    });
  });
  await outer.close();
  assert.deepEqual(errors, ['ERR_RESOURCE_SCOPE_REENTRANT_CLOSE', 'ERR_RESOURCE_SCOPE_REENTRANT_CLOSE']);
});

test('regression repeated target close shares promise and edges clear between disposers', { timeout: 1000 }, async () => {
  const a = createResourceScope();
  const b = createResourceScope();
  let releaseA;
  let releaseB;
  let readyA;
  let readyB;
  const holdA = new Promise(resolve => { releaseA = resolve; });
  const holdB = new Promise(resolve => { releaseB = resolve; });
  const aReady = new Promise(resolve => { readyA = resolve; });
  const bReady = new Promise(resolve => { readyB = resolve; });
  let first;
  let second;
  b.defer(async () => { await holdB; const closing = a.close(); readyB(); await closing; });
  const bClosing = b.close();
  a.defer(async () => { readyA(); await holdA; });
  a.defer(() => { first = b.close(); second = b.close(); });
  const aClosing = a.close();
  await aReady;
  assert.strictEqual(first, bClosing);
  assert.strictEqual(second, first);
  releaseB();
  await bReady;
  releaseA();
  await Promise.all([aClosing, bClosing]);
  assert.strictEqual(a.close(), aClosing);
  assert.strictEqual(b.close(), bClosing);
});

test('withStore returns result and awaits asynchronous close', async () => {
  const events = [];
  const store = { async close() { await Promise.resolve(); events.push('close'); } };
  const value = await withStore(() => store, s => { assert.strictEqual(s, store); events.push('use'); return 42; });
  assert.equal(value, 42);
  assert.deepEqual(events, ['use', 'close']);
});

test('withStore preserves each error and handles simultaneous failures', async () => {
  const useError = Error('use');
  const closeError = Error('close');
  let closes = 0;
  const open = fail => () => ({ close() { closes++; if (fail) throw closeError; } });
  await assert.rejects(withStore(open(false), () => { throw useError; }), e => e === useError);
  await assert.rejects(withStore(open(true), () => 1), e => e === closeError);
  await assert.rejects(withStore(open(true), () => { throw useError; }), e => e instanceof AggregateError && e.errors[0] === useError && e.errors[1] === closeError);
  await assert.rejects(withStore(open(true), () => { throw undefined; }), e => e instanceof AggregateError && e.errors[0] === undefined && e.errors[1] === closeError);
  assert.equal(closes, 4);
});

test('opening failure is preserved and use is not called', async () => {
  const error = Error('open');
  let used = false;
  await assert.rejects(withStore(() => { throw error; }, () => { used = true; }), e => e === error);
  assert.equal(used, false);
});
