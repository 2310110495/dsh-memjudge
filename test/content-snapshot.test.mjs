import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';

for (const mode of ['DELETE', 'WAL']) test(`snapshot ${mode}: external delete and rowid reuse`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-content-'));
  const path = join(dir, 'test.db');
  const store = open(path);
  const db = store.raw();
  const other = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode=${mode}`);
    store.put({ text: '港口人数为27人。' });
    const old = store.contentSnapshot();
    const original = old.rows[0];
    assert.ok(old.facts.total > 0);
    other.prepare('DELETE FROM memories WHERE id=?').run(original.id);
    other.prepare('INSERT INTO memories (id,text,text_hash,created_at,last_accessed,access_count,importance,kind,tier) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('new-id', '港口人数为31人。', 'new-hash', 1, 1, 0, 0.5, 'event', 3);
    const next = store.contentSnapshot();
    assert.equal(next.rows[0].ord, original.ord);
    assert.equal(next.rows[0].id, 'new-id');
    assert.match(next.rows[0].text, /31/);
    assert.ok([...next.facts.byOrd.values()].flat().some(f => String(f.value).includes('31')));
    assert.ok([...old.facts.byOrd.values()].flat().some(f => String(f.value).includes('27')));
    assert.notEqual(next.dataVersion, old.dataVersion);
  } finally { other.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WAL commit during snapshot rejects without publishing facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-content-'));
  const path = join(dir, 'test.db');
  const store = open(path);
  const db = store.raw();
  const other = new DatabaseSync(path);
  const prepare = db.prepare;
  try {
    db.exec('PRAGMA journal_mode=WAL');
    store.put({ text: '港口人数为27人。' });
    const facts = store.allFacts();
    db.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (!sql.startsWith('WITH measured AS (')) return statement;
      return { *iterate(params) { yield* statement.iterate(params); other.exec('DELETE FROM memories'); } };
    };
    assert.throws(() => store.contentSnapshot(), /changed during read/);
    assert.deepEqual(store.allFacts(), facts);
    assert.equal(db.isTransaction, false);
    db.prepare = prepare;
    assert.equal(store.contentSnapshot().rows.length, 0);
  } finally { db.prepare = prepare; other.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('occupied transaction and cleanup errors never publish partial facts', () => {
  const store = open(':memory:');
  const db = store.raw();
  const exec = db.exec;
  const prepare = db.prepare;
  try {
    store.put({ text: '港口人数为27人。' });
    const facts = store.allFacts();
    db.exec('BEGIN');
    assert.throws(() => store.contentSnapshot(), /idle connection/);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    db.prepare = function(sql) {
      if (sql.startsWith('WITH measured AS (')) throw new Error('read failure');
      return prepare.call(this, sql);
    };
    db.exec = function(sql) {
      if (sql === 'ROLLBACK') throw new Error('cleanup failure');
      return exec.call(this, sql);
    };
    assert.throws(() => store.contentSnapshot(), error => error instanceof AggregateError && error.errors[0].message === 'read failure' && error.errors[1].message === 'cleanup failure');
    assert.equal(db.isTransaction, true);
    assert.throws(() => store.allFacts(), /store fault/);
    db.exec = exec;
    db.prepare = prepare;
    db.exec('ROLLBACK');
    assert.throws(() => store.contentSnapshot(), /store fault/);
  } finally { db.exec = exec; db.prepare = prepare; if (db.isTransaction) db.exec('ROLLBACK'); store.close(); }
});

for (const mode of ['begin-before', 'begin-after', 'rollback-before', 'rollback-after']) {
  test(`snapshot transaction failure ${mode}`, () => {
    const notices = [];
    const store = open(':memory:', { onFault: error => notices.push(error) });
    const db = store.raw(), exec = db.exec;
    try {
      db.exec = function(sql) {
        if (sql === 'BEGIN DEFERRED' && mode === 'begin-before') throw new Error('begin failure');
        if (sql === 'BEGIN DEFERRED' && mode === 'begin-after') { exec.call(this, sql); throw new Error('begin failure'); }
        if (sql === 'ROLLBACK' && mode === 'rollback-before') throw new Error('cleanup failure');
        if (sql === 'ROLLBACK' && mode === 'rollback-after') { exec.call(this, sql); throw new Error('cleanup failure'); }
        return exec.call(this, sql);
      };
      assert.throws(() => store.contentSnapshot(), /failure/);
      db.exec = exec;
      if (mode.startsWith('begin')) {
        assert.equal(notices.length, 0);
        assert.equal(db.isTransaction, false);
        assert.equal(store.contentSnapshot().rows.length, 0);
      } else {
        assert.equal(notices.length, 1);
        assert.throws(() => store.stats(), /store fault/);
        assert.throws(() => store.factsSlot('x'), /store fault/);
        assert.equal(db.isTransaction, mode === 'rollback-before');
      }
    } finally { db.exec = exec; store.close(); }
  });
}

for (const after of [false, true]) test(`notification exception preserves first cause after=${after}`, () => {
  let store, calls = 0, reentrant;
  const primary = new Error('read-primary'), cleanup = new Error('rollback-cleanup'), notification = new Error('notify-failure');
  store = open(':memory:', { onFault() {
    calls++;
    try { store.contentSnapshot(); } catch (error) { reentrant = error; }
    throw notification;
  } });
  const db = store.raw(), exec = db.exec, prepare = db.prepare;
  try {
    db.prepare = function(sql) {
      if (sql.startsWith('WITH measured AS (')) throw primary;
      return prepare.call(this, sql);
    };
    db.exec = function(sql) {
      if (sql === 'ROLLBACK') { if (after) exec.call(this, sql); throw cleanup; }
      return exec.call(this, sql);
    };
    let thrown;
    try { store.contentSnapshot(); } catch (error) { thrown = error; }
    assert.equal(thrown.errors[0].errors[0], primary);
    assert.equal(thrown.errors[0].errors[1], cleanup);
    assert.equal(thrown.cause, thrown.errors[0]);
    assert.equal(thrown.errors[1], notification);
    assert.equal(reentrant.cause, thrown.errors[0]);
    assert.throws(() => store.contentSnapshot(), error => error.cause === thrown);
    assert.equal(calls, 1);
  } finally { db.exec = exec; db.prepare = prepare; store.close(); }
});

test('silent rollback failure preserves read error and faults store', () => {
  const store = open(':memory:');
  const db = store.raw(), exec = db.exec, prepare = db.prepare;
  const primary = new Error('read-primary');
  try {
    db.prepare = function(sql) {
      if (sql.startsWith('WITH measured AS (')) throw primary;
      return prepare.call(this, sql);
    };
    db.exec = function(sql) { if (sql === 'ROLLBACK') return; return exec.call(this, sql); };
    assert.throws(() => store.contentSnapshot(), error => error.cause === primary && /active transaction/.test(error.errors[1].message));
    assert.throws(() => store.stats(), /store fault/);
  } finally { db.exec = exec; db.prepare = prepare; store.close(); }
});
