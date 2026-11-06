import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

const entry = { id: 'synthetic', text: '船长是张三。' };
const extractL1 = () => [];
const options = { extractHybrid: async () => ({ source: 'llm', perEntry: [[{ attr: '标记', value: '张三' }]] }) };

async function rejection(promise) {
  let rejected = false;
  let reason;
  try { await promise; } catch (error) { rejected = true; reason = error; }
  assert.equal(rejected, true, 'expected rejection even for undefined');
  return reason;
}

for (const stage of ['before-begin', 'after-begin', 'snapshot']) {
  test(`undefined thrown at ${stage} rejects and retains the snapshot`, async () => {
    const store = open(':memory:', { extractL1 });
    store.put(entry);
    const before = store.get(entry.id).facts;
    const db = store.raw(), exec = db.exec, prepare = db.prepare;
    let begun = false;
    db.exec = function (sql) {
      if (sql === 'BEGIN IMMEDIATE') {
        if (stage === 'before-begin') throw undefined;
        const result = exec.call(this, sql);
        begun = true;
        if (stage === 'after-begin') throw undefined;
        return result;
      }
      return exec.call(this, sql);
    };
    db.prepare = function (sql) {
      if (begun && stage === 'snapshot' && sql.startsWith('SELECT total_changes()')) throw undefined;
      return prepare.call(this, sql);
    };
    try {
      assert.equal(await rejection(store.rebuildFactsHybrid(options)), undefined);
      assert.equal(db.isTransaction, false);
      assert.deepEqual(store.get(entry.id).facts, before);
      db.exec = exec;
      db.prepare = prepare;
      await store.rebuildFactsHybrid(options);
      assert.equal(store.get(entry.id).facts[0].attr, '标记');
    } finally {
      db.exec = exec;
      db.prepare = prepare;
      if (db.isTransaction) db.exec('ROLLBACK');
      store.close();
    }
  });
}

for (const cleanupMode of ['throws-error', 'throws-undefined', 'silent']) {
  test(`undefined primary failure and ${cleanupMode} retain both causes`, async () => {
    let notified;
    const store = open(':memory:', { extractL1, onFault: error => { notified = error; } });
    store.put(entry);
    const db = store.raw(), exec = db.exec;
    db.exec = function (sql) {
      if (sql === 'BEGIN IMMEDIATE') { exec.call(this, sql); throw undefined; }
      if (sql === 'ROLLBACK') {
        if (cleanupMode === 'throws-error') throw new Error('synthetic rollback');
        if (cleanupMode === 'throws-undefined') throw undefined;
        return;
      }
      return exec.call(this, sql);
    };
    try {
      const error = await rejection(store.rebuildFactsHybrid(options));
      assert.equal(error, notified);
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], undefined);
      if (cleanupMode === 'throws-undefined') assert.equal(error.errors[1], undefined);
      else assert.match(error.errors[1].message, /synthetic rollback|cleanup left an active transaction/);
      assert.equal(db.isTransaction, true);
      assert.throws(() => store.get(entry.id), /store fault/);
    } finally {
      db.exec = exec;
      if (db.isTransaction) db.exec('ROLLBACK');
      store.close();
    }
  });
}

test('undefined cleanup failure after publication faults the store', async () => {
  let called = false;
  let notified = 'not called';
  const store = open(':memory:', { extractL1, onFault: error => { called = true; notified = error; } });
  store.put(entry);
  const db = store.raw(), exec = db.exec;
  db.exec = function (sql) {
    if (sql === 'ROLLBACK') throw undefined;
    return exec.call(this, sql);
  };
  try {
    assert.equal(await rejection(store.rebuildFactsHybrid(options)), undefined);
    assert.equal(called, true);
    assert.equal(notified, undefined);
    assert.equal(db.isTransaction, true);
    assert.throws(() => store.get(entry.id), /store fault/);
  } finally {
    db.exec = exec;
    if (db.isTransaction) db.exec('ROLLBACK');
    store.close();
  }
});
