import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';
import { apply } from '../src/index.mjs';

test('occurrences preserve global identity and legacy source queries', () => {
  const s = open(':memory:');
  try {
    const a = s.put({ text: 'shared source text', source: 'doc:A', documentId: 'A', chapter: 1, para: 2 });
    const b = s.put({ text: 'shared source text', source: 'doc:B', documentId: 'B', chapter: 3, para: 4 });
    s.put({ text: 'shared source text', source: 'doc:B', documentId: 'B', chapter: 3, para: 4 });
    assert.equal(a.id, b.id);
    assert.equal(b.inserted, false);
    assert.equal(s.occurrencesV1(a.id).length, 2);
    assert.equal(s.bySourcePrefix('doc:B').length, 0);
    assert.equal(s.bySourcePrefixV1('doc:B')[0].documentId, 'B');
    assert.equal(s.bySourcePrefix('doc:A')[0].source, 'doc:A');
    const c = s.put({ text: 'unknown source text' });
    assert.deepEqual({ ...s.occurrencesV1(c.id)[0] }, { memoryId: c.id, source: null, documentId: null, chapter: null, para: null });
    s.raw().prepare('DELETE FROM memories WHERE id = ?').run(a.id);
    assert.deepEqual(s.occurrencesV1(a.id), []);
  } finally { s.close(); }
});

test('occurrence insertion failure rolls back new and duplicate memory updates', () => {
  const s = open(':memory:');
  try {
    const a = s.put({ text: 'existing text', source: 'a' });
    s.raw().exec(`CREATE TRIGGER fail_occ BEFORE INSERT ON memory_occurrences BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    assert.throws(() => s.put({ text: 'new text', source: 'b' }), /fixture failure/);
    assert.equal(s.stats().memories, 1);
    assert.throws(() => s.put({ text: 'existing text', source: 'b', kind: 'person' }), /fixture failure/);
    assert.equal(s.get(a.id).kind, 'event');
    assert.equal(s.occurrencesV1(a.id).length, 1);
  } finally { s.close(); }
});

test('concurrent writers recheck identity and budget under the write lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-writers-'));
  const file = path.join(dir, 'fixture.db');
  const a = open(file, { maxChars: 6 });
  const b = open(file, { maxChars: 6 });
  const exec = DatabaseSync.prototype.exec;
  let inject = () => b.put({ text: 'shared', source: 'B' });
  try {
    DatabaseSync.prototype.exec = function (sql) {
      if (this === a.raw() && sql === 'BEGIN IMMEDIATE' && inject) {
        const f = inject; inject = null; f();
      }
      return exec.call(this, sql);
    };
    const result = a.put({ text: 'shared', source: 'A' });
    assert.equal(result.inserted, false);
    assert.equal(a.stats().memories, 1);
    assert.deepEqual(a.occurrencesV1(result.id).map(x => x.source).sort(), ['A', 'B']);
    a.put({ text: 'shared' });
    a.put({ text: 'shared' });
    assert.equal(a.occurrencesV1(result.id).length, 3);
    assert.throws(() => a.put({ text: 'x', source: 'C' }), /budget/i);
    assert.equal(a.stats().memories, 1);
    b.raw().exec('BEGIN IMMEDIATE');
    assert.throws(() => a.put({ text: 'shared', source: 'C' }), /locked|busy/i);
    b.raw().exec('ROLLBACK');
    assert.equal(a.put({ text: 'shared', source: 'C' }).inserted, false);
    assert.equal(a.occurrencesV1(result.id).length, 4);
  } finally {
    DatabaseSync.prototype.exec = exec;
    a.close(); b.close();
  }
});

test('competing insert changes budget before lock acquisition', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-budget-race-'));
  const file = path.join(dir, 'fixture.db');
  const a = open(file, { maxChars: 6 });
  const b = open(file, { maxChars: 6 });
  const exec = DatabaseSync.prototype.exec;
  let inject = true;
  try {
    DatabaseSync.prototype.exec = function (sql) {
      if (this === a.raw() && sql === 'BEGIN IMMEDIATE' && inject) {
        inject = false;
        b.put({ text: '1234', source: 'B' });
      }
      return exec.call(this, sql);
    };
    assert.throws(() => a.put({ text: 'abc', source: 'A' }), /budget/i);
    assert.equal(a.stats().memories, 1);
    assert.equal(a.put({ text: '12', source: 'A' }).inserted, true);
    assert.equal(a.stats().memories, 2);
  } finally {
    DatabaseSync.prototype.exec = exec;
    a.close(); b.close();
  }
});

test('legacy migration and restart preserve only known fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-occurrences-'));
  const file = path.join(dir, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
    importance REAL NOT NULL DEFAULT 0, supersedes TEXT, source TEXT);
    INSERT INTO memories VALUES ('legacy', 'legacy text', 'legacy-hash', 1, 1, 0, 0, NULL, 'legacy:source');`);
  db.close();
  let s = open(file);
  assert.deepEqual({ ...s.occurrencesV1('legacy')[0] }, { memoryId: 'legacy', source: 'legacy:source', documentId: null, chapter: null, para: null });
  s.close();
  s = open(file);
  assert.equal(s.occurrencesV1('legacy').length, 1);
  s.close();
});

test('failed occurrence migration releases lock and preserves legacy data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-failed-migration-'));
  const file = path.join(dir, 'fixture.db');
  let db = new DatabaseSync(file);
  db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
    importance REAL NOT NULL DEFAULT 0, supersedes TEXT, source TEXT);
    INSERT INTO memories VALUES ('legacy', 'legacy text', 'legacy-hash', 1, 1, 0, 0, NULL, 'legacy:source');
    CREATE TABLE memory_occurrences (memory_id TEXT NOT NULL, source TEXT, document_id TEXT, chapter INTEGER, para INTEGER);
    CREATE TRIGGER fail_migration BEFORE INSERT ON memory_occurrences BEGIN SELECT RAISE(ABORT, 'migration fixture'); END;`);
  db.close();
  assert.throws(() => open(file), /migration fixture/);
  db = new DatabaseSync(file);
  try {
    db.exec('BEGIN IMMEDIATE; ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) AS n FROM meta').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_occurrences').get().n, 0);
    assert.equal(db.prepare("SELECT text FROM memories WHERE id = 'legacy'").get().text, 'legacy text');
    db.exec('DROP TRIGGER fail_migration');
  } finally { db.close(); }
  const s = open(file);
  assert.equal(s.occurrencesV1('legacy').length, 1);
  s.close();
  const reopened = open(file);
  assert.equal(reopened.occurrencesV1('legacy').length, 1);
  reopened.close();
});

test('initialization failures close connection and preserve original exception', () => {
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  for (const phase of ['ddl', 'migration', 'prepare', 'rollback']) {
    const failure = new Error(`fixture ${phase}`);
    let closed = false;
    const originalPrepare = DatabaseSync.prototype.prepare;
    try {
      DatabaseSync.prototype.exec = function (sql) {
        if ((phase === 'ddl' && sql.includes('CREATE TABLE IF NOT EXISTS meta')) ||
            (phase === 'migration' && sql.includes('BEGIN IMMEDIATE;')) ||
            (phase === 'rollback' && sql.includes('CREATE TABLE IF NOT EXISTS meta'))) throw failure;
        if (phase === 'rollback' && sql === 'ROLLBACK') throw new Error('rollback fixture');
        return originalExec.call(this, sql);
      };
      DatabaseSync.prototype.prepare = function (sql) {
        if (phase === 'prepare') throw failure;
        return originalPrepare.call(this, sql);
      };
      DatabaseSync.prototype.close = function () { closed = true; return originalClose.call(this); };
      assert.throws(() => open(':memory:'), err => err === failure);
      assert.equal(closed, true, phase);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.prepare = originalPrepare;
      DatabaseSync.prototype.close = originalClose;
    }
  }
});

test('marker insertion failure rolls back migrated occurrences', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-failed-marker-'));
  const file = path.join(dir, 'fixture.db');
  let db = new DatabaseSync(file);
  db.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TRIGGER fail_marker BEFORE INSERT ON meta WHEN NEW.k = 'occurrences_v1_migrated'
      BEGIN SELECT RAISE(ABORT, 'marker fixture'); END;
    CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
      importance REAL NOT NULL DEFAULT 0, supersedes TEXT, source TEXT);
    INSERT INTO memories VALUES ('legacy', 'legacy text', 'legacy-hash', 1, 1, 0, 0, NULL, 'legacy:source');`);
  db.close();
  assert.throws(() => open(file), /marker fixture/);
  db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE; INSERT INTO meta VALUES ('independent_write', 'ok'); COMMIT;");
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_occurrences').get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM meta WHERE k = 'occurrences_v1_migrated'").get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get().n, 1);
  } finally { db.close(); }
});

test('manual remember and forget preserve occurrence transaction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-occurrence-tool-'));
  const file = path.join(dir, 'fixture.db');
  const tools = new Map();
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: file, vector: false, autoInject: false });
  const remember = tools.get('memjudge_remember');
  const a = await remember.execute({ text: 'manual fixture text', source: 'doc:A', documentId: 'A', chapter: 1 });
  await remember.execute({ text: 'manual fixture text', source: 'doc:B', documentId: 'B', chapter: 2 });
  const s = open(file);
  assert.equal(s.occurrencesV1(a.id).length, 2);
  s.close();
  await tools.get('memjudge_forget').execute({ id: a.id });
  app.dispose();
  const reopened = open(file);
  assert.equal(reopened.get(a.id), null);
  assert.deepEqual(reopened.occurrencesV1(a.id), []);
  reopened.close();
});
