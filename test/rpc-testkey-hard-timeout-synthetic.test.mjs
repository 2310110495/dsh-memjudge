import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Evaluate only the target function with synthetic dependencies; no module imports or I/O.
const source = readFileSync(new URL('../src/rpc.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function testKey(group, key) {');
const end = source.indexOf('\n}\n', start) + 2;
assert.ok(start >= 0 && end > start);
const functionSource = source.slice(start, end);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(fetch, realTimer = false, timeoutMs = 8000, clock = performance, wallClock = Date, spec = {}) {
  let callback, cleared = 0, delay, signal;
  const context = {
    probeSpec: () => ({ endpoint: 'https://fixture.invalid', model: 'synthetic', body: () => ({}), ...spec }),
    TEST_KEY_TIMEOUT_MS: timeoutMs,
    URL, AbortController, TextDecoder, performance: clock, Date: wallClock, JSON, Error, Set, setImmediate,
    fetch: async (url, options) => {
      signal = options.signal;
      const result = await fetch(url, options);
      if (!result.body && result.text) {
        let done = false;
        result.body = { getReader: () => ({ async read() { if (done) return { done: true }; done = true; return { value: new TextEncoder().encode(await result.text()), done: false }; }, cancel() {}, releaseLock() {} }) };
      }
      return result;
    },
    setTimeout: (fn, ms) => { callback = fn; delay = ms; return realTimer ? setTimeout(fn, ms) : 1; },
    clearTimeout: id => { if (realTimer) clearTimeout(id); else assert.equal(id, 1); cleared++; },
  };
  const run = vm.runInNewContext(`(${functionSource})`, context);
  return { run: () => run('chat', 'synthetic-key'), fire: () => callback(),
    get cleared() { return cleared; }, get delay() { return delay; }, get signal() { return signal; } };
}

test('fetch ignoring abort times out, cleans timer and consumes late rejection', async () => {
  const wait = deferred();
  const f = fixture(() => wait.promise);
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const result = f.run();
    assert.equal(f.delay, 8000);
    f.fire();
    assert.equal((await result).code, 'timeout');
    assert.equal(f.signal.aborted, true);
    assert.equal(f.cleared, 1);
    wait.reject(new Error('late fetch rejection'));
    await flush();
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});

test('late response skips text and consumes cancellation failures', async () => {
  for (const cancel of [() => { throw Error('cancel throw'); }, () => Promise.reject(Error('cancel reject')), () => new Promise(() => {})]) {
    const wait = deferred();
    let reads = 0, cancels = 0;
    const f = fixture(() => wait.promise);
    const unhandled = [];
    const listener = error => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
      const pending = f.run();
      f.fire();
      const result = await pending;
      assert.equal(result.code, 'timeout');
      wait.resolve({ body: { cancel: () => { cancels++; return cancel(); } }, text: () => { reads++; } });
      await flush();
      assert.equal(result.code, 'timeout');
      assert.equal(reads, 0);
      assert.equal(cancels, 1);
      assert.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', listener); }
  }
});

test('body ignoring abort times out and consumes late rejection', async () => {
  const wait = deferred();
  const f = fixture(async () => ({ ok: true, status: 200, text: () => wait.promise }));
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const result = f.run();
    await flush();
    f.fire();
    assert.equal((await result).code, 'timeout');
    assert.equal(f.signal.aborted, true);
    assert.equal(f.cleared, 1);
    const error = new Error('late body rejection');
    error.name = 'AbortError';
    wait.reject(error);
    await flush();
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});

test('success, network error and body error retain contracts and clear timer', async () => {
  const cases = [
    [async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'yes' } }] }) }), true, undefined],
    [async () => { throw new Error('network'); }, false, 'network-error'],
    [async () => ({ ok: true, status: 200, text: async () => { throw new Error('body'); } }), false, 'invalid-response'],
    [async () => ({ ok: false, status: 401, text: async () => 'denied' }), false, 'http-error'],
  ];
  for (const [fetch, ok, code] of cases) {
    const f = fixture(fetch);
    const result = await f.run();
    assert.equal(result.ok, ok);
    assert.equal(result.code, code);
    assert.equal(f.cleared, 1);
    assert.equal(f.signal.aborted, false);
  }
});

test('timeout wins against synchronous abort-induced rejection and late completion', async () => {
  const f = fixture((_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('abort listener')));
  }));
  const result = f.run();
  f.fire();
  assert.equal((await result).code, 'timeout');
  assert.equal(f.cleared, 1);
  await flush();
});

test('completed request wins before timeout callback', async () => {
  const f = fixture(async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"x"}}]}' }));
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(f.cleared, 1);
});

test('actual eight-second timer returns while fetch remains pending', { timeout: 12000 }, async () => {
  const f = fixture(() => new Promise(() => {}), true);
  const started = Date.now();
  const result = await f.run();
  const elapsed = Date.now() - started;
  assert.equal(result.code, 'timeout');
  assert.ok(elapsed >= 7900 && elapsed < 11500, `elapsed=${elapsed}`);
  assert.equal(f.cleared, 1);
});

test('native Response preserves split UTF-8 bytes', async () => {
  const bytes = new TextEncoder().encode('{"choices":[{"message":{"content":"你好"}}]}');
  const stream = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  assert.equal((await fixture(async () => new Response(stream)).run()).ok, true);
});

test('HTTP error returns status without reading or awaiting cancellation', async () => {
  let reads = 0, cancels = 0;
  const body = { getReader() { reads++; }, cancel() { cancels++; return new Promise(() => {}); } };
  const result = await fixture(async () => ({ ok: false, status: 429, body })).run();
  assert.equal(result.code, 'http-error');
  assert.equal(result.status, 429);
  assert.equal(reads, 0);
  assert.equal(cancels, 1);
});

test('no stream never falls back to text', async () => {
  let reads = 0;
  const f = fixture(async () => ({ ok: true, status: 200, body: {}, text() { reads++; } }));
  assert.equal((await f.run()).code, 'invalid-response');
  assert.equal(reads, 0);
});

test('one MiB accepted, oversized bytes cancelled', async () => {
  const prefix = '{"choices":[{"message":{"content":"';
  const suffix = '"}}]}';
  for (const extra of [0, 1]) {
    const bytes = new TextEncoder().encode(prefix + 'x'.repeat(1024 * 1024 - prefix.length - suffix.length + extra) + suffix);
    let cancels = 0, reads = 0;
    const body = { getReader: () => ({ read: async () => ++reads === 1 ? { value: bytes, done: false } : { done: true }, cancel() { cancels++; }, releaseLock() {} }) };
    assert.equal((await fixture(async () => ({ ok: true, status: 200, body })).run()).ok, extra === 0);
    assert.equal(cancels, extra);
    assert.equal(reads, extra ? 1 : 2);
  }
});

test('timeout cancels locked reader and consumes late rejection', async () => {
  const wait = deferred();
  let cancels = 0;
  const body = { getReader: () => ({ read() { return wait.promise; }, cancel() { cancels++; return Promise.reject(Error('cancel')); }, releaseLock() {} }) };
  const f = fixture(async () => ({ ok: true, status: 200, body }));
  const pending = f.run();
  await flush();
  f.fire();
  assert.equal((await pending).code, 'timeout');
  assert.equal(cancels, 1);
  wait.reject(Error('late'));
  await flush();
});

test('499999 ready empty chunks respect a one-ms deadline', { timeout: 3000 }, async () => {
  let reads = 0, cancels = 0;
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const body = { getReader: () => ({
      read: async () => ++reads <= 499999 ? { value: new Uint8Array(0), done: false } : { done: true },
      cancel() { cancels++; return Promise.reject(Error('synthetic cancellation')); },
      releaseLock() {},
    }) };
    const result = await fixture(async () => ({ ok: true, status: 200, body }), true, 1).run();
    await flush();
    assert.equal(result.code, 'timeout');
    assert.ok(reads < 499999, `reads=${reads}`);
    assert.ok(cancels >= 1);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});

test('large ready valid stream progresses with frozen fake timers', { timeout: 3000 }, async () => {
  const bytes = new TextEncoder().encode('{"choices":[{"message":{"content":"' + 'x'.repeat(10000) + '"}}]}');
  let reads = 0, cancels = 0;
  const body = { getReader: () => ({
    read: async () => reads < bytes.length ? { value: bytes.subarray(reads, ++reads), done: false } : { done: true },
    cancel() { cancels++; }, releaseLock() {},
  }) };
  const f = fixture(async () => ({ ok: true, status: 200, body }), false, 8000, { now: () => 100 });
  assert.equal((await f.run()).ok, true);
  assert.equal(reads, bytes.length);
  assert.equal(cancels, 0);
  assert.equal(f.cleared, 1);
});

test('deadline check expires ready stream with frozen timer callback', { timeout: 3000 }, async () => {
  let reads = 0, cancels = 0, now = 0;
  const body = { getReader: () => ({
    read: async () => { reads++; if (reads === 300) now = 8; return { value: new Uint8Array(0), done: false }; },
    cancel() { cancels++; }, releaseLock() {},
  }) };
  const f = fixture(async () => ({ ok: true, status: 200, body }), false, 8, { now: () => now });
  assert.equal((await f.run()).code, 'timeout');
  assert.equal(reads, 300);
  assert.ok(cancels >= 1);
  assert.equal(f.cleared, 1);
});

test('wall clock jumps do not affect deadline or response-header latency', async () => {
  for (const delta of [-100000, 100000]) {
    let wall = 1000, mono = 0;
    const body = { getReader: () => ({
      read: async () => { wall += delta; mono = 2; return { done: true }; },
      cancel() { throw Error('unexpected cancellation'); }, releaseLock() {},
    }) };
    const f = fixture(async () => ({ ok: true, status: 200, body }), false, 8,
      { now: () => mono }, { now: () => wall });
    const result = await f.run();
    assert.equal(result.code, 'invalid-response');
    assert.equal(result.latencyMs, 0);
    assert.equal(f.signal.aborted, false);
  }
});

test('delayed response branches expire before returning and cancel body', async () => {
  for (const status of [200, 429]) {
    let mono = 0, cancels = 0, abortedAtCancel;
    const body = { cancel() { cancels++; abortedAtCancel = f.signal.aborted; } };
    const f = fixture(async () => { mono = 8; return { ok: status === 200, status, body }; }, false, 8, { now: () => mono });
    const result = await f.run();
    assert.equal(result.code, 'timeout');
    assert.equal(cancels, 1);
    assert.equal(abortedAtCancel, false);
    assert.equal(f.signal.aborted, true);
  }
});

test('late EOF and late read failure expire and cancel locked reader', async () => {
  for (const fail of [false, true]) {
    let mono = 0, cancels = 0;
    const body = { getReader: () => ({
      read: async () => { mono = 8; if (fail) throw Error('late read'); return { done: true }; },
      cancel() { cancels++; }, releaseLock() {},
    }) };
    const f = fixture(async () => ({ ok: true, status: 200, body }), false, 8, { now: () => mono });
    assert.equal((await f.run()).code, 'timeout');
    assert.ok(cancels >= 1);
    assert.equal(f.signal.aborted, true);
  }
});

test('late fetch rejection is timeout before frozen timer runs', async () => {
  let mono = 0;
  const f = fixture(async () => { mono = 8; throw Error('late network failure'); }, false, 8, { now: () => mono });
  assert.equal((await f.run()).code, 'timeout');
  assert.equal(f.signal.aborted, true);
});

test('hard timeout serializes no endpoint, model, or late error secrets', async () => {
  const secrets = ['url-timeout-secret-593', 'model-timeout-secret-274', 'error-timeout-secret-816'];
  const wait = deferred();
  const f = fixture(() => wait.promise, false, 8000, performance, Date,
    { endpoint: `https://fixture.invalid/${secrets[0]}`, model: secrets[1] });
  const pending = f.run();
  f.fire();
  const result = JSON.parse(JSON.stringify(await pending));
  assert.deepEqual(Object.keys(result).sort(), ['code', 'endpoint', 'group', 'latencyMs', 'message', 'model', 'ok', 'status']);
  assert.deepEqual({ ...result, latencyMs: 0 }, { ok: false, group: 'chat', status: null, latencyMs: 0, model: '[REDACTED]', endpoint: '[REDACTED]', code: 'timeout', message: '请求超时（8000ms）' });
  assert.equal(typeof result.latencyMs, 'number');
  wait.reject(Error(secrets[2]));
  await flush();
  for (const secret of secrets) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('response-header latency retains signed wall-clock difference', async () => {
  for (const delta of [-100000, 100000]) {
    let wall = 1000;
    const f = fixture(async () => { wall += delta; return { ok: false, status: 429 }; },
      false, 8, { now: () => 0 }, { now: () => wall });
    const result = await f.run();
    assert.equal(result.code, 'http-error');
    assert.equal(result.latencyMs, delta);
    assert.equal(f.signal.aborted, false);
  }
});
