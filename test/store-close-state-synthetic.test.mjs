import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

test('close failure preserves thrown values and permits retry only', () => {
  for (const failure of [undefined, null, new Error('synthetic close failure')]) {
    const s = open(':memory:');
    const db = s.raw(), original = db.close;
    let calls = 0, caught = false;
    db.close = function() { if (++calls === 1) throw failure; return original.call(this); };
    try { s.close(); } catch (error) { caught = true; assert.equal(error, failure); }
    assert.equal(caught, true);
    assert.throws(() => s.stats(), /关闭/);
    assert.throws(() => s.allFacts(), /关闭/);
    s.close();
    s.close();
    assert.equal(calls, 2);
  }
});

test('closing reentry throws and does not start another close', () => {
  const s = open(':memory:');
  const db = s.raw(), original = db.close;
  let calls = 0;
  db.close = function() {
    calls++;
    assert.throws(() => s.close(), /already in progress/);
    assert.throws(() => s.stats(), /关闭/);
    return original.call(this);
  };
  s.close();
  assert.equal(calls, 1);
});

test('a throw after physical close remains uncertain and retries the backend', () => {
  const s = open(':memory:');
  const db = s.raw(), original = db.close;
  const first = new Error('closed then threw'), second = new Error('retry failed');
  let calls = 0;
  db.close = function() {
    calls++;
    if (calls === 1) { original.call(this); throw first; }
    if (calls === 2) throw second;
  };
  assert.throws(() => s.close(), error => error === first);
  assert.throws(() => s.stats(), /关闭/);
  assert.throws(() => s.close(), error => error === second);
  s.close();
  s.close();
  assert.equal(calls, 3);
});

test('publication blocks close and fault does not block cleanup', async () => {
  const s = open(':memory:');
  const db = s.raw(), exec = db.exec;
  s.put({ id: 'fixture', text: 'synthetic.' });
  let checked = false;
  db.exec = function(sql) {
    if (sql === 'BEGIN IMMEDIATE') {
      assert.throws(() => s.close(), /publication in progress/);
      checked = true;
    }
    if (sql === 'ROLLBACK') throw new Error('synthetic rollback failure');
    return exec.call(this, sql);
  };
  await assert.rejects(s.rebuildFactsHybrid({ extractHybrid: async () => ({ source: 'llm', perEntry: [[]] }) }), /synthetic rollback failure/);
  assert.equal(checked, true);
  assert.throws(() => s.stats(), /store fault/);
  db.exec = exec;
  s.close();
  s.close();
});
