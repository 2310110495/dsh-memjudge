import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/rpc.mjs', import.meta.url), 'utf8');
const names = 'CRED_GROUPS configReport envLockedFlags moduleFlags rawConfig saveConfig saveKey chatBaseUrl embedBaseUrl rerankBaseUrl chatKey embedKey rerankKey chatModel embedModel rerankModel embedDims groupReport maxChars storageLimitBytes'.split(' ');

async function fixture(failures = {}) {
  const calls = [];
  const invoke = (name, value) => {
    calls.push(name);
    if (Object.hasOwn(failures, name)) throw failures[name];
    return value;
  };
  const store = {
    stats: () => invoke('stats', { memories: 1, facts: 2 }),
    allFacts: () => invoke('allFacts', [{ attr: 'height', value: 1 }, { attr: 'height', value: 2 }]),
    list: options => { calls.push(['options', options]); return invoke('list', [{ id: 'mem-c02-p03-example', text: 'hello' }]); },
    close: () => invoke('close'),
  };
  const context = vm.createContext({ console, URL });
  const config = new vm.SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, name === 'CRED_GROUPS' ? ['chat', 'embed', 'rerank'] : name === 'maxChars' ? () => 123 : name === 'storageLimitBytes' ? () => 456 : name === 'configReport' ? () => invoke('configReport', { fixture: true }) : () => { throw Error(`unexpected config call: ${name}`); });
  }, { context });
  const storage = new vm.SyntheticModule(['open'], function () {
    this.setExport('open', (path, opts) => { calls.push(['openArgs', path, opts]); return invoke('open', store); });
  }, { context });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    if (specifier === './store.mjs') return storage;
    if (specifier === './config.mjs') return config;
    throw Error(`unexpected import: ${specifier}`);
  });
  await module.evaluate();
  let handler;
  const dispose = () => {};
  const returned = module.namespace.installMemjudgeRpc({ connection: { rpc: { handle(channel, fn, options) {
    assert.equal(channel, '/memjudge');
    assert.equal(options.authority, 'loopback');
    handler = fn;
    return dispose;
  } } } }, { dbPath: 'synthetic-only' });
  assert.equal(returned, dispose);
  return { handler, calls };
}

for (const [endpoint, stages] of Object.entries({ status: ['stats', 'allFacts'], memories: ['list', 'stats'], conflicts: ['allFacts'] })) {
  test(`${endpoint}: successful RPC closes after synchronous query`, async () => {
    const { handler, calls } = await fixture();
    const result = await handler(endpoint, { limit: 3, order: 'asc', cap: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.filter(x => typeof x === 'string'), ['open', ...stages, 'close', ...(endpoint === 'status' ? ['configReport'] : [])]);
    assert.equal(calls[0][1], 'synthetic-only');
    assert.equal(calls[0][2].maxChars, 123);
    assert.equal(calls[0][2].storageLimitBytes, 456);
    if (endpoint === 'status') assert.equal(result.value.stats.attrCount, 1);
    if (endpoint === 'memories') {
      assert.equal(result.value.total, 1);
      assert.equal(result.value.order, 'asc');
      assert.equal(result.value.rows[0].chapter, '2');
      const options = calls.find(x => Array.isArray(x) && x[0] === 'options')[1];
      assert.equal(options.limit, 3);
      assert.equal(options.includeText, true);
      assert.equal(options.order, 'asc');
    }
    if (endpoint === 'conflicts') assert.equal(result.value.conflicts[0].values.length, 2);
  });
  for (const stage of ['open', ...stages, 'close']) {
    for (const double of stage !== 'open' && stage !== 'close' ? [false, true] : [false]) {
      test(`${endpoint}: ${stage} failure${double ? ' plus close failure' : ''}`, async () => {
        const failures = { [stage]: Error(`${stage} failure`) };
        if (double) failures.close = Error('close failure');
        const { handler, calls } = await fixture(failures);
        const result = await handler(endpoint, {});
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'bad-request');
        assert.equal(result.error.message, `${stage} failure`);
        assert.equal(calls.filter(x => x === 'close').length, stage === 'open' ? 0 : 1);
      });
    }
  }
}

test('thrown undefined retains precedence over close failure', async () => {
  const { handler, calls } = await fixture({ allFacts: undefined, close: Error('close failure') });
  const result = await handler('conflicts', {});
  assert.equal(result.error.message, 'undefined');
  assert.equal(calls.filter(x => x === 'close').length, 1);
});

test('memories retains default ordering and limit', async () => {
  const { handler, calls } = await fixture();
  const result = await handler('memories');
  const options = calls.find(x => Array.isArray(x) && x[0] === 'options')[1];
  assert.equal(result.value.order, 'desc');
  assert.equal(options.limit, 120);
  assert.equal(options.order, 'desc');
});
