import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

function capture(fn) {
  try { return { value: fn(), threw: false }; } catch (value) { return { value, threw: true }; }
}

for (const primary of [undefined, new Error('begin fault')]) {
  test(`begin takes effect then throws ${String(primary)}`, () => {
    const store = open(':memory:', { extractL1: () => [] });
    const db = store.raw(), exec = db.exec;
    try {
      db.exec = function(sql) {
        if (sql === 'BEGIN DEFERRED') { exec.call(this, sql); throw primary; }
        return exec.call(this, sql);
      };
      const result = capture(() => store.scanConflictsV2());
      assert.equal(result.threw, true);
      assert.equal(result.value, primary);
      assert.equal(db.isTransaction, false);
      db.exec = exec;
      assert.equal(store.scanConflictsV2().total, 0);
      assert.equal(store.put({ id: 'x', text: 'synthetic' }).inserted, true);
    } finally { db.exec = exec; if (db.isTransaction) db.exec('ROLLBACK'); store.close(); }
  });
}

test('silent begin is detected and connection remains usable', () => {
  const store = open(':memory:', { extractL1: () => [] });
  const db = store.raw(), exec = db.exec;
  try {
    db.exec = function(sql) { if (sql === 'BEGIN DEFERRED') return; return exec.call(this, sql); };
    assert.throws(() => store.scanConflictsV2(), /begin did not start/);
    assert.equal(db.isTransaction, false);
    db.exec = exec;
    assert.equal(store.scanConflictsV2().total, 0);
  } finally { db.exec = exec; store.close(); }
});

test('cleanup fault seals other flows and preserves callback failure', () => {
  const notification = new Error('notification');
  let store, notified, reentry;
  store = open(':memory:', { extractL1: () => [], onFault: cause => {
    notified = cause;
    reentry = capture(() => store.scanConflictsV2());
    throw notification;
  } });
  const db = store.raw(), exec = db.exec;
  try {
    db.exec = function(sql) { if (sql === 'ROLLBACK') return; return exec.call(this, sql); };
    const result = capture(() => store.scanConflictsV2());
    assert.ok(result.value instanceof AggregateError);
    assert.equal(result.value.errors[0], notified);
    assert.equal(result.value.errors[1], notification);
    assert.match(notified.message, /active transaction/);
    assert.equal(reentry.threw, true);
    assert.throws(() => store.put({ id: 'x', text: 'synthetic' }), /store fault/);
    assert.throws(() => store.contentSnapshot(), /store fault/);
    assert.throws(() => store.scanConflictsV2(), /store fault/);
  } finally { db.exec = exec; if (db.isTransaction) db.exec('ROLLBACK'); store.close(); }
});

test('option getter reentry is rejected without touching an external transaction', () => {
  const store = open(':memory:', { extractL1: () => [] });
  const db = store.raw();
  try {
    const options = { get limits() {
      assert.throws(() => store.scanConflictsV2(), /idle connection/);
      db.exec('BEGIN');
      return {};
    } };
    assert.throws(() => store.scanConflictsV2(options), /idle connection/);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    assert.equal(store.scanConflictsV2().total, 0);
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); store.close(); }
});
