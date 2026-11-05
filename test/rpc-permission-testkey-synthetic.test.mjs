import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/rpc.mjs', import.meta.url), 'utf8');
const names = 'CRED_GROUPS configReport envLockedFlags moduleFlags rawConfig saveConfig saveKey chatBaseUrl embedBaseUrl rerankBaseUrl chatKey embedKey rerankKey chatModel embedModel rerankModel embedDims groupReport maxChars storageLimitBytes'.split(' ');
const groups = ['chat', 'embed', 'rerank'];
const snapshot = value => JSON.parse(JSON.stringify(value));

async function fixture(overrides = {}) {
  const calls = [];
  const settings = Object.fromEntries(groups.map(g => [g, {
    baseUrl: `https://${g}.invalid/v1`, model: `${g}-fixture-model`, key: `${g}-fixture-secret`, enabled: true,
  }]));
  for (const group of groups) Object.assign(settings[group], overrides[group]);
  const config = {
    CRED_GROUPS: groups,
    configReport: () => ({ fixture: true }), envLockedFlags: () => ({}), moduleFlags: () => ({}), rawConfig: () => ({}),
    saveConfig: patch => { calls.push(['saveConfig', snapshot(patch)]); for (const group of groups) for (const field of ['baseUrl', 'model']) { const name = group + field[0].toUpperCase() + field.slice(1); if (Object.hasOwn(patch, name)) settings[group][field] = patch[name]; } },
    saveKey: (group, key) => { calls.push(['saveKey', group, key]); settings[group].key = key; },
    embedDims: () => 2, maxChars: () => 123, storageLimitBytes: () => 456,
    groupReport: group => ({ ...settings[group], key: undefined, keyConfigured: !!settings[group].key }),
  };
  for (const group of groups) for (const field of ['baseUrl', 'key', 'model']) {
    config[`${group}${field[0].toUpperCase()}${field.slice(1)}`] = () => settings[group][field];
  }
  if (overrides.throwCredential) config.embedKey = () => { throw Error('synthetic-private-error'); };
  if (overrides.internalError) config.chatKey = () => { throw Error(overrides.internalError); };
  const response = overrides.response ?? { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }], data: [{ embedding: [0.1, 0.2] }], results: [{ index: 0, relevance_score: 0.8 }] }) };
  const fetch = async (url, options) => {
    calls.push(['fetch', url, { method: options.method, headers: snapshot(options.headers), body: JSON.parse(options.body), signal: options.signal }]);
    if (overrides.fetchError) throw overrides.fetchError;
    const result = await (overrides.fetch ? overrides.fetch(url, options) : response);
    if (!result.body && result.text) {
      let done = false;
      result.body = { getReader: () => ({ async read() { if (done) return { done: true }; done = true; return { value: new TextEncoder().encode(await result.text()), done: false }; }, cancel() {}, releaseLock() {} }) };
    }
    return result;
  };
  const context = vm.createContext({ URL, AbortController, TextDecoder, performance, setImmediate, setTimeout: overrides.setTimeout ?? setTimeout, clearTimeout: overrides.clearTimeout ?? clearTimeout, fetch, console });
  const configModule = new vm.SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, config[name]);
  }, { context });
  const storeModule = new vm.SyntheticModule(['open'], function () {
    this.setExport('open', () => { throw Error('unexpected synthetic store access'); });
  }, { context });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    if (specifier === './config.mjs') return configModule;
    if (specifier === './store.mjs') return storeModule;
    throw Error(`unexpected import: ${specifier}`);
  });
  await module.evaluate();
  let handler, registration;
  const dispose = () => {};
  const connection = { rpc: { handle(...args) { registration = args; handler = args[1]; return dispose; } } };
  const returned = module.namespace.installMemjudgeRpc({ get: name => name === 'connection' ? connection : undefined }, { dbPath: 'synthetic-only' });
  return { handler, registration, dispose, returned, calls, settings };
}

test('registration passes channel, handler and loopback option to host stub', async () => {
  const f = await fixture();
  assert.equal(f.registration.length, 3);
  assert.equal(f.registration[0], '/memjudge');
  assert.equal(f.registration[1], f.handler);
  assert.deepEqual(snapshot(f.registration[2]), { authority: 'loopback' });
  assert.equal(f.returned, f.dispose);
});

for (const group of groups) {
  test(`${group}: configured endpoint, model and stored synthetic key reach intercepted fetch`, async () => {
    const f = await fixture();
    const result = await f.handler('testKey', { group }, new AbortController().signal, { id: 'peer-a' });
    assert.equal(result.ok, true);
    assert.equal(result.value.ok, true);
    assert.equal(result.value.model, "[REDACTED]");
    assert.equal(result.value.endpoint, "[REDACTED]");
    assert.equal(typeof result.value.latencyMs, "number");
    const [call] = f.calls.filter(c => c[0] === 'fetch');
    const suffix = { chat: 'chat/completions', embed: 'embeddings', rerank: 'rerank' }[group];
    assert.equal(call[1], `https://${group}.invalid/v1/${suffix}`);
    assert.equal(call[2].method, 'POST');
    assert.equal(call[2].headers.Authorization, `Bearer ${group}-fixture-secret`);
    assert.equal(call[2].headers['Content-Type'], 'application/json');
    assert.equal(call[2].body.model, `${group}-fixture-model`);
    assert.ok(call[2].signal instanceof AbortSignal);
    if (group === 'chat') assert.deepEqual(call[2].body, { model: 'chat-fixture-model', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false });
    if (group === 'embed') assert.deepEqual(call[2].body, { model: 'embed-fixture-model', input: 'ping', dimensions: 2 });
    if (group === 'rerank') assert.deepEqual(call[2].body, { model: 'rerank-fixture-model', query: 'ping', documents: ['ping'] });
    assert.equal(JSON.stringify(result).includes(`${group}-fixture-secret`), false);
  });
}

test('explicit key is trimmed and overrides stored key; default group is chat', async () => {
  const f = await fixture();
  const result = await f.handler('testKey', { key: '  supplied-fixture-secret  ' });
  assert.equal(result.value.ok, true);
  assert.equal(f.calls[0][2].headers.Authorization, 'Bearer supplied-fixture-secret');
  assert.equal(result.value.group, 'chat');
});

test("historical, partial and encoded secrets stay hidden and requests retain originals", async () => {
  const historical = "historic-secret-123";
  for (const value of [historical, historical.slice(0, 9), encodeURIComponent("historic/secret"), Buffer.from(historical).toString("base64"), "ordinary-model"]) {
    const baseUrl = "https://fixture.invalid/" + value;
    const f = await fixture({ chat: { baseUrl, model: value, key: "current-key" } });
    const result = await f.handler("testKey", {});
    assert.equal(result.value.model, "[REDACTED]");
    assert.equal(result.value.endpoint, "[REDACTED]");
    assert.equal(f.calls[0][1], baseUrl + "/chat/completions");
    assert.equal(f.calls[0][2].body.model, value);
    assert.equal(f.calls[0][2].headers.Authorization, "Bearer current-key");
    assert.equal(typeof result.value.latencyMs, "number");
  }
});

test('different peer values do not change saveSettings, saveKey, or testKey branches', async () => {
  const observations = [];
  for (const peer of [{ id: 'fixture-a' }, { id: 'fixture-b', denied: true }, undefined]) {
    const f = await fixture();
    const signal = new AbortController().signal;
    const settings = await f.handler('saveSettings', { settings: { chatBaseUrl: 'https://chosen.invalid/v1', chatModel: 'chosen-model' } }, signal, peer);
    const key = await f.handler('saveKey', { group: 'chat', key: ' supplied-fixture ' }, signal, peer);
    const tested = await f.handler('testKey', { group: 'chat' }, signal, peer);
    observations.push({ settings: snapshot(settings), key: snapshot(key), tested: { ok: tested.ok, probeOk: tested.value.ok, group: tested.value.group }, calls: f.calls.map(c => c[0] === 'fetch' ? [c[0], c[1], { ...c[2], signal: 'signal' }] : c) });
  }
  assert.deepEqual(observations[0], observations[1]);
  assert.deepEqual(observations[0], observations[2]);
  assert.equal(observations[0].settings.ok, true);
  assert.equal(observations[0].key.ok, true);
  assert.equal(observations[0].tested.probeOk, true);
  assert.equal(observations[0].calls[2][1], 'https://chosen.invalid/v1/chat/completions');
  assert.equal(observations[0].calls[2][2].body.model, 'chosen-model');
  assert.equal(observations[0].calls[2][2].headers.Authorization, 'Bearer supplied-fixture');
});

for (const [label, options, payload, code] of [
  ['unknown group', {}, { group: 'other' }, 'bad-request'],
  ['disabled group', { embed: { enabled: false } }, { group: 'embed' }, 'disabled'],
  ['non-string key', {}, { key: 123 }, 'bad-request'],
  ['blank supplied key', {}, { key: '  ' }, 'missing-key'],
  ['missing stored key', { chat: { key: '' } }, {}, 'missing-key'],
  ['empty endpoint', { chat: { baseUrl: '' } }, {}, 'incomplete-config'],
  ['empty model', { chat: { model: '' } }, {}, 'incomplete-config'],
]) {
  test(`${label} stops before fetch`, async () => {
    const f = await fixture(options);
    const result = await f.handler('testKey', payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(Object.hasOwn(result, 'value'), false);
    assert.equal(Object.hasOwn(result.error, 'model'), false);
    assert.equal(Object.hasOwn(result.error, 'endpoint'), false);
    assert.deepEqual(snapshot(result.error.details), {});
    assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 0);
  });
}

for (const [label, options, expected] of [
  ['HTTP failure', { response: { ok: false, status: 401, text: async () => 'fixture-secret' } }, 'http-error'],
  ['invalid response', { response: { ok: true, status: 200, text: async () => '{}' } }, 'invalid-response'],
  ['fetch failure', { fetchError: Error('fixture-secret') }, 'network-error'],
  ['abort', { fetchError: Object.assign(Error('fixture-secret'), { name: 'AbortError' }) }, 'timeout'],
]) {
  test(`${label} returns probe failure inside successful RPC envelope`, async () => {
    const f = await fixture(options);
    const result = await f.handler('testKey', {});
    assert.equal(result.ok, true);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.code, expected);
    assert.equal(result.value.model, "[REDACTED]");
    assert.equal(result.value.endpoint, "[REDACTED]");
    assert.equal(typeof result.value.latencyMs, "number");
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
    assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 1);
  });
}

test('failure envelopes never serialize secrets from endpoint, model, or errors', async () => {
  const secrets = ['url-private-token-593', 'model-private-token-274', 'error-private-token-816'];
  const [urlSecret, modelSecret, errorSecret] = secrets;
  const chat = { baseUrl: `https://fixture.invalid/${urlSecret}`, model: modelSecret };
  const cases = [
    [{ chat, response: { ok: false, status: 401, text: async () => errorSecret } }, 'http-error', 401, 'HTTP 401'],
    [{ chat, response: { ok: true, status: 200, text: async () => errorSecret } }, 'invalid-response', 200, '响应结构或内容无效'],
    [{ chat, fetchError: Error(errorSecret) }, 'network-error', null, '网络请求失败'],
    [{ chat, fetchError: Object.assign(Error(errorSecret), { name: 'AbortError' }) }, 'timeout', null, '请求超时（8000ms）'],
  ];
  for (const [options, code, status, message] of cases) {
    const f = await fixture(options);
    const result = snapshot(await f.handler('testKey', {}));
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'value']);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.value).sort(), ['code', 'endpoint', 'group', 'latencyMs', 'message', 'model', 'ok', 'status']);
    assert.deepEqual({ ...result.value, latencyMs: 0 }, { ok: false, group: 'chat', status, latencyMs: 0, model: '[REDACTED]', endpoint: '[REDACTED]', code, message });
    assert.equal(typeof result.value.latencyMs, 'number');
    for (const secret of secrets) assert.equal(JSON.stringify(result).includes(secret), false, `${code}: ${secret}`);
  }
  const f = await fixture({ chat, internalError: errorSecret });
  const result = snapshot(await f.handler('testKey', {}));
  assert.deepEqual(result, { ok: false, error: { code: 'internal-error', message: '密钥测试失败', details: {} } });
  assert.equal(Object.hasOwn(result, 'value'), false);
  for (const secret of secrets) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(f.calls.length, 0);
});

test("unrelated credential getter is not read for explicit key", async () => {
  const f = await fixture({ throwCredential: true });
  const result = await f.handler("testKey", { key: "probe-key" });
  assert.equal(result.value.ok, true);
  assert.equal(result.value.model, "[REDACTED]");
  assert.equal(result.value.endpoint, "[REDACTED]");
});

test("settings reject userinfo, query and fragment", async () => {
  const f = await fixture();
  for (const baseUrl of ["https://user:pass@host.invalid/v1", "https://host.invalid/v1?x=y", "https://host.invalid/v1#part"]) {
    assert.equal((await f.handler("saveSettings", { settings: { chatBaseUrl: baseUrl } })).ok, false);
  }
  assert.equal((await f.handler("saveSettings", { settings: { chatBaseUrl: "https://host.invalid/v1" } })).ok, true);
});

function fakeClock() {
  const timers = new Map();
  let next = 0;
  return {
    timers,
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fire() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } },
  };
}

function abortable(signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(Error('synthetic abort'), { name: 'AbortError' })), { once: true });
  });
}

test('clock regression: abort during pending fetch and clear timer', async () => {
  const clock = fakeClock();
  let signal;
  const f = await fixture({ ...clock, fetch: (_url, opts) => { signal = opts.signal; return abortable(signal); } });
  const pending = f.handler('testKey', {});
  assert.equal([...clock.timers.values()][0].ms, 8000);
  assert.equal(signal.aborted, false);
  clock.fire();
  assert.equal(signal.aborted, true);
  const result = await pending;
  assert.equal(result.value.code, 'timeout');
  assert.equal(clock.timers.size, 0);
});

test('clock regression: abort during response body is timeout', async () => {
  const clock = fakeClock();
  let reading;
  const f = await fixture({ ...clock, fetch: (_url, opts) => ({ ok: true, status: 200, text: () => { reading = abortable(opts.signal); return reading; } }) });
  const pending = f.handler('testKey', {});
  while (!reading) await Promise.resolve();
  clock.fire();
  const result = await pending;
  assert.equal(result.value.code, 'timeout');
  assert.equal(clock.timers.size, 0);
});

test('clock regression: settlement clears timer and host abort is independent', async () => {
  const clock = fakeClock();
  const host = new AbortController();
  let signal, resolveFetch;
  const f = await fixture({ ...clock, fetch: (_url, opts) => { signal = opts.signal; return new Promise(resolve => { resolveFetch = resolve; }); } });
  const pending = f.handler('testKey', {}, host.signal);
  host.abort();
  assert.equal(signal.aborted, false);
  resolveFetch({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' });
  assert.equal((await pending).value.ok, true);
  assert.equal(clock.timers.size, 0);
  clock.fire();
  assert.equal(signal.aborted, false);
});

test('clock regression: non-abort body failure remains invalid response', async () => {
  const clock = fakeClock();
  const f = await fixture({ ...clock, fetch: () => ({ ok: true, status: 200, text: async () => { throw Error('fixture body error'); } }) });
  assert.equal((await f.handler('testKey', {})).value.code, 'invalid-response');
  assert.equal(clock.timers.size, 0);
});

test('clock regression: failed fetch clears timer', async () => {
  const clock = fakeClock();
  const f = await fixture({ ...clock, fetch: async () => { throw Error('synthetic failure'); } });
  assert.equal((await f.handler('testKey', {})).value.code, 'network-error');
  assert.equal(clock.timers.size, 0);
});

test('clock regression: fetch ignoring abort times out before late success', async () => {
  const clock = fakeClock();
  let resolveFetch, signal, reads = 0, cancels = 0;
  const f = await fixture({ ...clock, fetch: (_url, opts) => { signal = opts.signal; return new Promise(resolve => { resolveFetch = resolve; }); } });
  const pending = f.handler('testKey', {});
  clock.fire();
  assert.equal(signal.aborted, true);
  const result = await pending;
  assert.equal(result.value.code, 'timeout');
  resolveFetch({ ok: true, status: 200, body: { cancel: () => { cancels++; } }, text: async () => { reads++; return '{"choices":[{"message":{"content":"ok"}}]}'; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.value.code, 'timeout');
  assert.equal(reads, 0);
  assert.equal(cancels, 1);
  assert.equal(clock.timers.size, 0);
});
