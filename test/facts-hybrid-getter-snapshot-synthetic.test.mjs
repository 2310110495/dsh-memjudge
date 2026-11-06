import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

function fixture() {
  const s = open(':memory:', { extractL1: () => [{ attr: 'old', value: 'kept' }] });
  s.put({ id: 'a', text: 'abcdef' });
  return s;
}
const run = (s, result) => s.rebuildFactsHybrid({ extractHybrid: async () => result });

test('source getter read once and rules cannot clear existing facts', async () => {
  const s = fixture();
  try {
    const before = s.allFacts(); let reads = 0;
    const out = await run(s, { get source() { return ++reads === 1 ? 'rules' : 'llm'; } });
    assert.equal(reads, 1); assert.equal(out.source, 'rules'); assert.deepEqual(s.allFacts(), before);
  } finally { s.close(); }
});

test('each fact field and array index is read once before publication', async () => {
  const s = fixture();
  try {
    const values = { attr: 'x', value: 'ok', entity: 'e', valueType: 'text', at: 0, sentOff: 0, sentLen: 1, sent: 'a' };
    const counts = {}; const fact = {};
    for (const [key, value] of Object.entries(values)) Object.defineProperty(fact, key, { get() { counts[key] = (counts[key] || 0) + 1; return key === 'value' && counts[key] >= 3 ? 42 : value; } });
    let entryReads = 0, factReads = 0, perReads = 0;
    const entry = [fact]; Object.defineProperty(entry, 0, { get() { factReads++; return fact; } });
    const per = [entry]; Object.defineProperty(per, 0, { get() { entryReads++; return entry; } });
    await run(s, { source: 'llm', get perEntry() { perReads++; return per; } });
    assert.deepEqual(Object.values(counts), Array(8).fill(1));
    assert.deepEqual([entryReads, factReads, perReads], [1, 1, 1]);
    assert.equal(s.allFacts()[0].value, 'ok');
  } finally { s.close(); }
});

test('getter exceptions leave existing facts intact', async () => {
  const s = fixture();
  try {
    const before = s.allFacts(); const error = new Error('getter failure');
    await assert.rejects(run(s, { source: 'llm', perEntry: [[{ attr: 'x', get value() { throw error; } }]] }), e => e === error);
    assert.deepEqual(s.allFacts(), before);
    await run(s, { source: 'llm', perEntry: [[{ attr: 'x', value: 'ok' }]] });
    assert.equal(s.allFacts()[0].value, 'ok');
  } finally { s.close(); }
});

test('synchronous mutation while reading an array index invalidates the snapshot', async () => {
  const s = fixture();
  try {
    const entry = [{ attr: 'x', value: 'ok' }];
    Object.defineProperty(entry, 0, { get() { s.put({ id: 'b', text: 'new' }); return { attr: 'x', value: 'ok' }; } });
    await assert.rejects(run(s, { source: 'llm', perEntry: [entry] }), /snapshot stale/);
    assert.equal(s.allFacts().length, 2); assert.equal(s.get('a').facts[0].attr, 'old');
  } finally { s.close(); }
});
