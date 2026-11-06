import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

const fact = { attr: 'x', value: 'y' };
const lengthProxy = (array, length, onIndex = () => {}) => new Proxy(array, {
  get(target, key, receiver) {
    if (key === 'length') return length;
    if (typeof key === 'string' && /^\d+$/.test(key)) onIndex();
    return Reflect.get(target, key, receiver);
  },
});
function fixture(count = 1) {
  const s = open(':memory:', { extractL1: () => [{ attr: 'old', value: 'kept' }] });
  for (let i = 0; i < count; i++) s.put({ id: String(i), text: `text-${i}` });
  return s;
}
const run = (s, perEntry) => s.rebuildFactsHybrid({ extractHybrid: async () => ({ source: 'llm', perEntry }) });

test('proxy lengths are validated before reading any array index', async () => {
  const s = fixture();
  try {
    const before = s.allFacts();
    for (const n of [-1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, 10001]) {
      let reads = 0;
      await assert.rejects(run(s, [lengthProxy([], n, () => reads++)]), /invalid extraction/);
      assert.equal(reads, 0);
      assert.deepEqual(s.allFacts(), before);
    }
    for (const n of [-1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, 100001]) {
      let reads = 0;
      await assert.rejects(run(s, lengthProxy([], n, () => reads++)), /invalid extraction/);
      assert.equal(reads, 0);
      assert.deepEqual(s.allFacts(), before);
    }
    await run(s, [[fact]]);
    assert.equal(s.allFacts()[0].value, 'y');
  } finally { s.close(); }
});

test('valueType rejects objects and symbols without key coercion', async () => {
  const s = fixture();
  try {
    const before = s.allFacts(); let conversions = 0;
    const valueType = { [Symbol.toPrimitive]() { conversions++; return 'text'; } };
    for (const value of [valueType, Symbol('text'), 1, 'unknown']) {
      await assert.rejects(run(s, [[{ ...fact, valueType: value }]]), /invalid extraction/);
      assert.deepEqual(s.allFacts(), before);
    }
    assert.equal(conversions, 0);
    await run(s, [[{ ...fact, valueType: 'text' }]]);
    assert.equal(s.allFacts()[0].value, 'y');
  } finally { s.close(); }
});

test('aggregate budget rejects before reading the over-budget entry', async () => {
  const s = fixture(11);
  try {
    const before = s.allFacts(); let reads = 0;
    const full = Array(10000).fill(fact);
    const last = lengthProxy([fact], 1, () => reads++);
    await assert.rejects(run(s, [...Array(10).fill(full), last]), /fact budget/);
    assert.equal(reads, 0);
    assert.deepEqual(s.allFacts(), before);
  } finally { s.close(); }
});
