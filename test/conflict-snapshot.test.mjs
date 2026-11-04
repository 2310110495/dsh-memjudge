import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openConflictSnapshot, POSITION_QUERY } from '../src/conflict-snapshot.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-snapshot-'));
  const file = join(dir, 'test.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE memories(id TEXT PRIMARY KEY, text TEXT NOT NULL);
    CREATE TABLE memory_occurrences(memory_id TEXT, source TEXT, document_id TEXT, chapter INTEGER, para INTEGER);
    CREATE UNIQUE INDEX ux_memory_occurrences_position ON memory_occurrences
      (memory_id, source IS NULL, coalesce(source, ''), document_id IS NULL,
       coalesce(document_id, ''), chapter IS NULL, coalesce(chapter, 0), para IS NULL, coalesce(para, 0));
    INSERT INTO memories VALUES ('a','中文'),('b','second');
    INSERT INTO memory_occurrences VALUES ('a','x','doc',1,1),('a','y','doc',1,2),('b',NULL,NULL,NULL,NULL);`);
  return { db, file, cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('snapshot preserves positions and exact budget completion', () => {
  const f = fixture();
  try {
    const s = openConflictSnapshot(f.file, { records: 2, occurrences: 3, textBytes: 12 });
    assert.equal(s.next().value.occurrences.length, 2);
    assert.equal(s.next().value.id, 'b');
    assert.deepEqual(s.next(), { done: true, scanIncomplete: false, reason: null });
    s.close(); s.close();
    assert.throws(() => s.next(), /closed/);
  } finally { f.cleanup(); }
});

test('file facade keeps its public shape and stable terminal responses', () => {
  const f = fixture();
  try {
    const s = openConflictSnapshot(f.file, { records: 1 });
    assert.deepEqual(Object.keys(s).sort(), ['close', 'next']);
    assert.equal(s.next().value.id, 'a');
    const terminal = { done: true, scanIncomplete: true, reason: 'records' };
    assert.deepEqual(s.next(), terminal);
    assert.deepEqual(s.next(), terminal);
    s.close(); s.close();
    assert.throws(() => s.next(), /closed/);
    f.db.exec("INSERT INTO memories VALUES ('c','new')");
  } finally { f.cleanup(); }
});

test('production index delivers positions in key order without sorting', () => {
  const f = fixture();
  try {
    f.db.exec(`INSERT INTO memory_occurrences VALUES ('a','z','doc',1,3),('a','b','doc',1,4),('a',NULL,'doc',1,5)`);
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${POSITION_QUERY}`).all('a').map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH memory_occurrences USING (?:COVERING )?INDEX ux_memory_occurrences_position/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
    const s = openConflictSnapshot(f.file);
    assert.deepEqual(s.next().value.occurrences.map(p => p.source), ['b','x','y','z',null]);
    s.close();
    const limited = openConflictSnapshot(f.file, { occurrences: 4 });
    assert.deepEqual(limited.next(), { done: true, scanIncomplete: true, reason: 'occurrences' });
    limited.close();
  } finally { f.cleanup(); }
});

test('oversized rowid errors close the snapshot', () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO memories(rowid,id,text) VALUES(9007199254740992,'big','value')");
    const s = openConflictSnapshot(f.file);
    s.next(); s.next();
    assert.throws(() => s.next(), /too large to be represented/);
    assert.throws(() => s.next(), /closed/);
    f.db.exec("INSERT INTO memories VALUES ('c','new')");
  } finally { f.cleanup(); }
});

test('position iterator consumes at most the budget plus one', () => {
  const f = fixture();
  const prepare = DatabaseSync.prototype.prepare;
  let steps = 0;
  try {
    f.db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO memory_occurrences SELECT 'a', printf('p%04d', x), 'doc', 1, x FROM n`);
    DatabaseSync.prototype.prepare = function (sql) {
      const stmt = prepare.call(this, sql);
      if (sql !== POSITION_QUERY) return stmt;
      return { *iterate(id) { for (const row of stmt.iterate(id)) { steps++; yield row; } } };
    };
    const s = openConflictSnapshot(f.file, { occurrences: 7 });
    assert.deepEqual(s.next(), { done: true, scanIncomplete: true, reason: 'occurrences' });
    assert.equal(steps, 8);
    s.close();
  } finally { DatabaseSync.prototype.prepare = prepare; f.cleanup(); }
});

test('limits stop before returning incomplete records', () => {
  const f = fixture();
  try {
    for (const [options, reason] of [
      [{ records: 0 }, 'records'], [{ recordTextBytes: 5 }, 'recordTextBytes'],
      [{ textBytes: 5 }, 'textBytes'], [{ occurrences: 1 }, 'occurrences'],
      [{ occurrenceBytes: 3 }, 'occurrenceBytes'], [{ identifierBytes: 0 }, 'identifierBytes'],
    ]) {
      const s = openConflictSnapshot(f.file, options);
      assert.deepEqual(s.next(), { done: true, scanIncomplete: true, reason });
      s.close();
    }
    assert.throws(() => openConflictSnapshot(f.file, { records: -1 }), /invalid limit/);
  } finally { f.cleanup(); }
});

test('read snapshot blocks commit until close and sees original state', () => {
  const f = fixture();
  try {
    const s = openConflictSnapshot(f.file);
    f.db.exec("BEGIN IMMEDIATE; INSERT INTO memories VALUES ('c','new')");
    assert.throws(() => f.db.exec('COMMIT'), /locked/);
    assert.equal(s.next().value.id, 'a');
    assert.equal(s.next().value.id, 'b');
    assert.equal(s.next().scanIncomplete, false);
    s.close();
    f.db.exec('COMMIT');
    const fresh = openConflictSnapshot(f.file);
    assert.equal(fresh.next().value.id, 'a');
    assert.equal(fresh.next().value.id, 'b');
    assert.equal(fresh.next().value.id, 'c');
    fresh.close();
  } finally { f.cleanup(); }
});

test('close failures are sticky and retain rollback and close errors', () => {
  for (const rollback of ['ok', 'before', 'after']) for (const closing of ['ok', 'before', 'after']) {
    const f = fixture(), exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
    const rollbackError = new Error('rollback fault'), closeError = new Error('close fault');
    let owned, rollbacks = 0, closes = 0, physicallyClosed = false, rolledBack = false;
    try {
      DatabaseSync.prototype.exec = function(sql) {
        if (this !== f.db && sql === 'BEGIN DEFERRED') owned = this;
        if (this === owned && sql === 'ROLLBACK') {
          rollbacks++;
          if (rollback === 'before') throw rollbackError;
          const value = exec.call(this, sql); rolledBack = true;
          if (rollback === 'after') throw rollbackError;
          return value;
        }
        return exec.call(this, sql);
      };
      DatabaseSync.prototype.close = function() {
        if (this === owned) {
          closes++;
          if (closing === 'before') throw closeError;
          const value = close.call(this); physicallyClosed = true;
          if (closing === 'after') throw closeError;
          return value;
        }
        return close.call(this);
      };
      const reader = openConflictSnapshot(f.file);
      let first, failed = false;
      try { reader.close(); } catch (error) { first = error; failed = true; }
      const errors = [...(rollback === 'ok' ? [] : [rollbackError]), ...(closing === 'ok' ? [] : [closeError])];
      assert.equal(failed, errors.length > 0);
      if (errors.length === 2) { assert.ok(first instanceof AggregateError); assert.deepEqual(first.errors, errors); assert.equal(first.cause, rollbackError); }
      else if (errors.length === 1) assert.equal(first, errors[0]);
      if (failed) assert.throws(() => reader.close(), error => error === first);
      else reader.close();
      assert.equal(rollbacks, 1); assert.equal(closes, 1);
      assert.throws(() => reader.next(), /closed/);
      if (!physicallyClosed && !rolledBack) {
        assert.throws(() => f.db.exec("INSERT INTO memories VALUES ('c','new')"), /locked/);
      } else f.db.exec("INSERT INTO memories VALUES ('c','new')");
    } finally {
      DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close;
      if (owned && !physicallyClosed) { if (!rolledBack) exec.call(owned, 'ROLLBACK'); close.call(owned); }
      f.cleanup();
    }
  }
});

test('initialization failure releases read transaction', () => {
  const f = fixture();
  try {
    f.db.exec('DROP TABLE memory_occurrences');
    assert.throws(() => openConflictSnapshot(f.file), /memory_occurrences/);
    f.db.exec("INSERT INTO memories VALUES ('c','new')");
  } finally { f.cleanup(); }
});

test('initialization preserves rollback and close faults and closes only its connection', () => {
  for (const [rollbackFault, closeFault] of [[true, false], [false, true], [true, true]]) {
    const f = fixture();
    const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
    const primary = new Error('initialization fault'), rollbackError = new Error('rollback fault'), closeError = new Error('close fault');
    let owned, rollbackCalls = 0, closeCalls = 0;
    try {
      DatabaseSync.prototype.prepare = function (sql) {
        if (this !== f.db && sql.startsWith('SELECT rowid AS ord')) { owned = this; throw primary; }
        return prepare.call(this, sql);
      };
      DatabaseSync.prototype.exec = function (sql) {
        if (this === owned && sql === 'ROLLBACK') {
          rollbackCalls++;
          if (rollbackFault) throw rollbackError;
        }
        return exec.call(this, sql);
      };
      DatabaseSync.prototype.close = function () {
        if (this === owned) {
          closeCalls++;
          close.call(this);
          if (closeFault) throw closeError;
          return;
        }
        return close.call(this);
      };
      assert.throws(() => openConflictSnapshot(f.file), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.deepEqual(error.errors, [primary, ...(rollbackFault ? [rollbackError] : []), ...(closeFault ? [closeError] : [])]);
        return true;
      });
      assert.equal(rollbackCalls, 1);
      assert.equal(closeCalls, 1);
      f.db.exec("INSERT INTO memories VALUES ('c','new')");
    } finally {
      DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close;
      f.cleanup();
    }
  }
});

test('failed rollback and close before releasing connection can retain lock', () => {
  const f = fixture();
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  let owned;
  try {
    DatabaseSync.prototype.prepare = function (sql) {
      if (this !== f.db && sql.startsWith('SELECT rowid AS ord')) { owned = this; throw new Error('init'); }
      return prepare.call(this, sql);
    };
    DatabaseSync.prototype.exec = function (sql) {
      if (this === owned && sql === 'ROLLBACK') throw new Error('rollback');
      return exec.call(this, sql);
    };
    DatabaseSync.prototype.close = function () {
      if (this === owned) throw new Error('close');
      return close.call(this);
    };
    assert.throws(() => openConflictSnapshot(f.file), error => {
      assert.deepEqual(error.errors.map(e => e.message), ['init', 'rollback', 'close']);
      return true;
    });
    assert.throws(() => f.db.exec("INSERT INTO memories VALUES ('c','new')"), /locked/);
    exec.call(owned, 'ROLLBACK'); close.call(owned); owned = null;
    f.db.exec("INSERT INTO memories VALUES ('c','new')");
  } finally {
    DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close;
    if (owned) { try { close.call(owned); } catch {} }
    f.cleanup();
  }
});

test('failed BEGIN does not roll back a transaction it did not start', () => {
  const f = fixture();
  const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  const primary = new Error('begin fault');
  let rollbacks = 0, closes = 0;
  try {
    DatabaseSync.prototype.exec = function (sql) {
      if (this !== f.db && sql === 'BEGIN DEFERRED') throw primary;
      if (this !== f.db && sql === 'ROLLBACK') rollbacks++;
      return exec.call(this, sql);
    };
    DatabaseSync.prototype.close = function () { if (this !== f.db) closes++; return close.call(this); };
    assert.throws(() => openConflictSnapshot(f.file), error => error === primary);
    assert.equal(rollbacks, 0); assert.equal(closes, 1);
    f.db.exec("INSERT INTO memories VALUES ('c','new')");
  } finally {
    DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close; f.cleanup();
  }
});

test('read failure releases the snapshot lock', () => {
  const f = fixture();
  const prepare = DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (!sql.startsWith('SELECT id, text')) return statement;
      return { get() { throw new Error('injected read failure'); } };
    };
    const s = openConflictSnapshot(f.file);
    assert.throws(() => s.next(), /injected read failure/);
    assert.throws(() => s.next(), /closed/);
    f.db.exec("INSERT INTO memories VALUES ('c','new')");
  } finally { DatabaseSync.prototype.prepare = prepare; f.cleanup(); }
});

test('negative rowids are visited in stable order', () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO memories(rowid,id,text) VALUES(-1,'negative','value')");
    f.db.exec("INSERT INTO memory_occurrences(rowid,memory_id,source) VALUES(-1,'negative','origin')");
    const s = openConflictSnapshot(f.file);
    const item = s.next().value;
    assert.equal(item.id, 'negative');
    assert.equal(item.occurrences[0].source, 'origin');
    s.close();
  } finally { f.cleanup(); }
});
