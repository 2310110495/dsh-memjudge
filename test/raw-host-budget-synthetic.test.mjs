import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightRawHostBudget as check, RAW_HOST_BUDGET_CEILINGS as ceilings } from './raw-host-budget-prototype.mjs';

test('both exact limits pass; either excess blocks', () => {
  assert.equal(check({ sizeBytes: ceilings.maxBytes, eventCount: ceilings.maxEvents }, ceilings).allowed, true);
  assert.equal(check({ sizeBytes: ceilings.maxBytes + 1, eventCount: 0 }, ceilings).reason, 'budget-exceeded');
  assert.equal(check({ sizeBytes: 0, eventCount: ceilings.maxEvents + 1 }, ceilings).reason, 'budget-exceeded');
  assert.equal(check({ sizeBytes: 0, eventCount: 0 }, { maxBytes: 0, maxEvents: 0 }).allowed, true);
});

test('missing, inherited, malformed or unsafe metadata fails closed', () => {
  for (const value of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1n]) {
    assert.equal(check({ sizeBytes: value, eventCount: 0 }, ceilings).reason, 'unknown-metadata');
    assert.equal(check({ sizeBytes: 0, eventCount: value }, ceilings).reason, 'unknown-metadata');
  }
  assert.equal(check(Object.create({ sizeBytes: 1, eventCount: 1 }), ceilings).reason, 'unknown-metadata');
  assert.equal(check(null, ceilings).reason, 'unknown-metadata');
  assert.equal(check(new Proxy({}, { getOwnPropertyDescriptor() { throw Error('trap'); } }), ceilings).reason, 'unknown-metadata');
  assert.equal(check({ get sizeBytes() { throw Error('getter'); }, eventCount: 0 }, ceilings).reason, 'unknown-metadata');
});

test('budgets must be explicit finite safe nonnegative integers under ceilings', () => {
  for (const budget of [undefined, {}, { maxBytes: -1, maxEvents: 1 }, { maxBytes: 1, maxEvents: NaN },
    { maxBytes: ceilings.maxBytes + 1, maxEvents: 1 }, { maxBytes: 1, maxEvents: ceilings.maxEvents + 1 },
    { maxBytes: '1', maxEvents: 1 }, new Proxy({}, { getOwnPropertyDescriptor() { throw Error('trap'); } })]) {
    assert.equal(check({ sizeBytes: 0, eventCount: 0 }, budget).reason, 'invalid-budget');
  }
});

test('pure decision does not mutate inputs or call getters', () => {
  const metadata = Object.freeze({ sizeBytes: 3, eventCount: 2 });
  const budget = Object.freeze({ maxBytes: 3, maxEvents: 2 });
  assert.deepEqual(check(metadata, budget), { allowed: true, reason: 'within-budget' });
  assert.deepEqual(metadata, { sizeBytes: 3, eventCount: 2 });
});
