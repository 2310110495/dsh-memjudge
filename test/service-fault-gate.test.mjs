import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.mjs';

function fixture(recall = async () => ({ hits: [] })) {
  let calls = 0, fault = null;
  const store = Object.fromEntries(['stats', 'bySourcePrefix', 'occurrencesV1', 'bySourcePrefixV1', 'byKind']
    .map(name => [name, () => { calls++; return name; }]));
  const guard = () => { if (fault) throw fault; };
  const service = createService(null, { store, recall: (...args) => { calls++; return recall(...args); }, guard });
  return { service, store, get calls() { return calls; }, fail: error => { fault = error; } };
}

test('fault precedes argument validation and blocks all service reads', async () => {
  const f = fixture();
  const fault = new Error('fixture fault');
  f.fail(fault);
  assert.equal(f.service.version, '1');
  for (const call of [() => f.service.stats(), () => f.service.bySourcePrefix(null),
    () => f.service.occurrencesV1(null), () => f.service.bySourcePrefixV1(null), () => f.service.byKind('event')]) {
    assert.throws(call, error => error === fault);
  }
  await assert.rejects(f.service.recallByQuery(''), error => error === fault);
  assert.equal(f.calls, 0);
});

for (const outcome of ['resolve', 'reject']) test(`in-flight recall ${outcome} checks fault first`, async () => {
  let settle;
  const f = fixture(() => new Promise((resolve, reject) => { settle = outcome === 'resolve' ? resolve : reject; }));
  const pending = f.service.recallByQuery('clock');
  const fault = new Error('fixture fault');
  f.fail(fault);
  settle(outcome === 'resolve' ? { hits: [] } : new Error('underlying'));
  await assert.rejects(pending, error => error === fault);
  assert.equal(f.calls, 1);
});

test('legacy construction and guard validation', async () => {
  const f = fixture();
  const legacy = createService(null, { store: f.store, recall: async () => ({ hits: [] }) });
  assert.equal(legacy.stats(), 'stats');
  assert.deepEqual((await legacy.recallByQuery('clock')).hits, []);
  for (const guard of [null, false, 0, 'guard']) {
    assert.throws(() => createService(null, { store: f.store, guard }), /deps.guard/);
  }
  const underlying = new Error('underlying');
  const rejected = createService(null, { store: f.store, recall: async () => { throw underlying; } });
  await assert.rejects(rejected.recallByQuery('clock'), error => error === underlying);
});
