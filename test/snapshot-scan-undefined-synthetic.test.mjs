import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

function caught(fn) {
  try { fn(); } catch (value) { return { threw: true, value }; }
  return { threw: false };
}

for (const kind of ['snapshot', 'scan']) {
  for (const primary of [undefined, new Error('primary')]) {
    for (const cleanupMode of ['ok', 'before', 'after', ...['silent']]) {
      test(`${kind} primary=${String(primary)} cleanup=${cleanupMode}`, () => {
        const store = open(':memory:', { extractL1: () => [] });
        const db = store.raw(), prepare = db.prepare, exec = db.exec;
        const cleanup = new Error('cleanup');
        try {
          db.prepare = function(sql) {
            if (kind === 'snapshot' ? sql.startsWith('WITH measured AS (') : sql.includes('length(CAST(id AS BLOB))')) throw primary;
            return prepare.call(this, sql);
          };
          db.exec = function(sql) {
            if (sql === 'ROLLBACK') {
              if (cleanupMode === 'before') throw cleanup;
              if (cleanupMode === 'silent') return;
              if (cleanupMode === 'after') { exec.call(this, sql); throw cleanup; }
            }
            return exec.call(this, sql);
          };
          const result = caught(() => kind === 'snapshot' ? store.contentSnapshot() : store.scanConflictsV2());
          assert.equal(result.threw, true);
          if (cleanupMode === 'ok') {
            assert.equal(result.value, primary);
            assert.equal(db.isTransaction, false);
          } else {
            assert.ok(result.value instanceof AggregateError);
            assert.equal(result.value.errors[0], primary);
            assert.equal(result.value.cause, primary);
            if (cleanupMode === 'silent') assert.match(result.value.errors[1].message, /active transaction/);
            else assert.equal(result.value.errors[1], cleanup);
            assert.equal(db.isTransaction, cleanupMode !== 'after');
            assert.throws(() => store.stats(), /store fault/);
          }
          db.prepare = prepare;
          db.exec = exec;
          if (db.isTransaction) db.exec('ROLLBACK');
          if (kind === 'scan' && cleanupMode === 'ok') assert.equal(store.scanConflictsV2().total, 0);
          if (kind === 'snapshot' && cleanupMode === 'ok') assert.equal(store.contentSnapshot().rows.length, 0);
        } finally {
          db.prepare = prepare;
          db.exec = exec;
          if (db.isTransaction) db.exec('ROLLBACK');
          store.close();
        }
      });
    }
  }
}

for (const kind of ['snapshot', 'scan']) test(`${kind} cleanup error with successful work is preserved`, () => {
  const store = open(':memory:', { extractL1: () => [] });
  const db = store.raw(), exec = db.exec;
  const cleanup = new Error('cleanup-only');
  try {
    db.exec = function(sql) { if (sql === 'ROLLBACK') { exec.call(this, sql); throw cleanup; } return exec.call(this, sql); };
    const result = caught(() => kind === 'snapshot' ? store.contentSnapshot() : store.scanConflictsV2());
    assert.equal(result.threw, true);
    assert.equal(result.value, cleanup);
    assert.equal(db.isTransaction, false);
  } finally { db.exec = exec; store.close(); }
});
