import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';

test('numeric projection rejects invalid and unsafe values before SQLite decodes integers', () => {
  const store = open(':memory:');
  const db = store.raw();
  try {
    store.put({ text: 'numeric' });
    const invalid = {
      created_at: ['9223372036854775807', '-9223372036854775808', '1e999'],
      last_accessed: ['9223372036854775807', '-9223372036854775808', '-1e999'],
      access_count: ['9223372036854775807', '-1', '1.5', '1e999'],
      importance: ['9223372036854775807', '-1', '1.1', '1e999'],
    };
    for (const [field, values] of Object.entries(invalid)) {
      for (const value of values) {
        db.exec(`UPDATE memories SET ${field} = ${value}`);
        assert.deepEqual(store.injectionSnapshot(), { complete: false, candidates: [] }, `${field}=${value}`);
      }
      db.exec(`UPDATE memories SET ${field} = ${field === 'importance' ? '0.5' : '1'}`);
    }
    db.exec('UPDATE memories SET created_at=1.5, last_accessed=9007199254740991, access_count=9007199254740991, importance=1');
    assert.equal(store.injectionSnapshot().complete, true);
  } finally { store.close(); }
});

test('decoded UTF-8 byte limits apply to every projected string field', () => {
  const store = open(':memory:');
  const db = store.raw();
  try {
    store.put({ text: 'x', id: 'i', source: 's' });
    for (const field of ['id', 'text', 'source', 'kind']) {
      const old = db.prepare(`SELECT ${field} AS value FROM memories`).get().value;
      db.exec(`UPDATE memories SET ${field} = CAST(X'8080808080' AS TEXT)`);
      const full = store.injectionSnapshot();
      assert.equal(full.complete, true);
      const actual = db.prepare('SELECT id, text, source, kind FROM memories').get();
      const total = [actual.id, actual.text, actual.source, actual.kind].reduce((n, v) => n + Buffer.byteLength(v ?? ''), 0);
      assert.equal(Buffer.byteLength(actual[field]), 15);
      assert.deepEqual(store.injectionSnapshot({ maxFieldBytes: 14 }), { complete: false, candidates: [] });
      assert.deepEqual(store.injectionSnapshot({ maxBytes: total - 1 }), { complete: false, candidates: [] });
      db.prepare(`UPDATE memories SET ${field} = ?`).run(old);
    }
    db.exec("UPDATE memories SET kind = 'x'");
    assert.deepEqual(store.injectionSnapshot({ maxFieldBytes: 4 }), { complete: false, candidates: [] });
    assert.deepEqual(store.injectionSnapshot({ maxBytes: 4 }), { complete: false, candidates: [] });
  } finally { store.close(); }
});

test('iterator exception releases active statement and reentrancy guard', () => {
  const store = open(':memory:');
  const db = store.raw();
  const prepare = db.prepare;
  try {
    store.put({ text: 'one' });
    db.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (!sql.includes('WITH measured AS')) return statement;
      return { *iterate(args) { for (const row of statement.iterate(args)) { yield row; throw new Error('iterator fault'); } } };
    };
    assert.throws(() => store.injectionSnapshot(), /iterator fault/);
    db.prepare = prepare;
    assert.equal(db.isTransaction, false);
    db.exec('BEGIN IMMEDIATE; ROLLBACK');
    assert.equal(store.injectionSnapshot().complete, true);
  } finally { db.prepare = prepare; store.close(); }
});

test('snapshot enforces rows and all string bytes without returning partial results', () => {
  const store = open(':memory:');
  try {
    store.put({ text: '你好\0😀', source: 's' });
    const result = store.injectionSnapshot();
    assert.equal(result.complete, true);
    const row = result.candidates[0];
    const size = [row.id, row.text, row.source, row.kind].reduce((n, v) => n + Buffer.byteLength(v ?? ''), 0);
    const field = Math.max(...[row.id, row.text, row.source, row.kind].map(v => Buffer.byteLength(v ?? '')));
    assert.equal(store.injectionSnapshot({ maxRows: 1, maxFieldBytes: field, maxBytes: size }).complete, true);
    for (const options of [{ maxRows: 0 }, { maxFieldBytes: field - 1 }, { maxBytes: size - 1 }]) {
      assert.deepEqual(store.injectionSnapshot(options), { complete: false, candidates: [] });
    }
    store.raw().prepare('UPDATE memories SET access_count = ?').run('not numeric');
    assert.deepEqual(store.injectionSnapshot(), { complete: false, candidates: [] });
  } finally { store.close(); }
});

test('existing transactions, failures and reentrancy leave connection usable', () => {
  const store = open(':memory:');
  const db = store.raw();
  const prepare = db.prepare;
  try {
    db.exec('BEGIN');
    assert.throws(() => store.injectionSnapshot(), /idle connection/);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    assert.throws(() => store.injectionSnapshot({ get maxRows() { store.injectionSnapshot(); } }), /idle connection/);
    db.prepare = () => { throw new Error('snapshot fault'); };
    assert.throws(() => store.injectionSnapshot(), /snapshot fault/);
    db.prepare = prepare;
    assert.equal(store.injectionSnapshot().complete, true);
    assert.equal(db.isTransaction, false);
  } finally { db.prepare = prepare; store.close(); }
});

test('file snapshots see committed changes on the next read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inject-snapshot-'));
  const file = join(dir, 'test.db');
  const store = open(file);
  let other;
  try {
    store.put({ text: 'first' });
    other = new DatabaseSync(file);
    assert.equal(store.injectionSnapshot().candidates.length, 1);
    other.prepare("INSERT INTO memories (id,text,text_hash,created_at,last_accessed,access_count,importance,kind,tier) VALUES ('other','second','hash-other',2,2,0,0,'event',3)").run();
    assert.equal(store.injectionSnapshot().candidates.length, 2);
    store.raw().exec('PRAGMA journal_mode=WAL');
    const db = store.raw();
    const prepare = db.prepare;
    try {
      db.prepare = function(sql) {
        const statement = prepare.call(this, sql);
        if (!sql.includes('WITH measured AS')) return statement;
        return { *iterate(args) {
          let first = true;
          for (const row of statement.iterate(args)) {
            if (first) {
              first = false;
              other.prepare("INSERT INTO memories (id,text,text_hash,created_at,last_accessed,access_count,importance,kind,tier) VALUES ('third','third','hash-third',3,3,0,0,'event',3)").run();
            }
            yield row;
          }
        } };
      };
      assert.equal(store.injectionSnapshot().candidates.length, 2);
    } finally { db.prepare = prepare; }
    assert.equal(store.injectionSnapshot().candidates.length, 3);
    other.exec('BEGIN IMMEDIATE; COMMIT');
  } finally { other?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
