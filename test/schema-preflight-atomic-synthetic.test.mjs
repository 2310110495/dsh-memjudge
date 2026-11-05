import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/store.mjs';

test('sqlite-prefixed user object is not hidden by LIKE wildcard', () => fixture(file => {
  seed(file);
  inspect(file, db => db.exec("CREATE TABLE sqliteXuser (v TEXT); INSERT INTO sqliteXuser VALUES ('keep')"));
  assert.throws(() => open(file), /unrecognized versioned database/);
  inspect(file, db => assert.equal(db.prepare('SELECT v FROM sqliteXuser').get().v, 'keep'));
}));
test('a forged canonical trigger is blocked before it runs', () => fixture(file => {
  seed(file);
  inspect(file, db => db.exec("DROP TRIGGER memory_occurrences_delete; CREATE TRIGGER memory_occurrences_delete AFTER DELETE ON memories BEGIN DELETE FROM memories; END"));
  assert.throws(() => open(file), /unrecognized database trigger/);
  inspect(file, db => assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n, 1));
}));
test('unversioned occurrence rows remain present after migration', () => fixture(file => {
  inspect(file, db => db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0, supersedes TEXT, source TEXT); INSERT INTO memories VALUES ('legacy','legacy text','hash',1,1,0,0,NULL,'source'); CREATE TABLE memory_occurrences (memory_id TEXT NOT NULL, source TEXT, document_id TEXT, chapter INTEGER, para INTEGER); INSERT INTO memory_occurrences VALUES ('legacy','other','doc',2,3)"));
  const store = open(file);
  try { assert.equal(store.occurrencesV1('legacy').length, 2); } finally { store.close(); }
  inspect(file, db => assert.equal(db.prepare("SELECT document_id FROM memory_occurrences WHERE source='other'").get().document_id, 'doc'));
}));

for (const table of ['facts', 'str_dict', 'entity_dict', 'attr_dict']) {
  test(`disguised version 7 preserves ${table}`, () => fixture(file => {
    seed(file);
    inspect(file, db => db.exec(`CREATE TABLE ${table} (value TEXT); INSERT INTO ${table} VALUES ('keep')`));
    assert.throws(() => open(file), /unrecognized versioned database/);
    inspect(file, db => {
      assert.equal(db.prepare(`SELECT value FROM ${table}`).get().value, 'keep');
      assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '7');
      assert.equal(db.prepare("SELECT text FROM memories WHERE id='id'").get().text, 'text');
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
    });
  }));
}
test('unversioned occurrence table migrates and reopens', () => fixture(file => {
  inspect(file, db => db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0, supersedes TEXT, source TEXT); INSERT INTO memories VALUES ('legacy','legacy text','hash',1,1,0,0,NULL,'source'); CREATE TABLE memory_occurrences (memory_id TEXT NOT NULL, source TEXT, document_id TEXT, chapter INTEGER, para INTEGER)"));
  for (let i = 0; i < 2; i++) { const store = open(file); try { assert.equal(store.occurrencesV1('legacy').length, 1); } finally { store.close(); } }
}));
test('unversioned trigger is preserved without execution', () => fixture(file => {
  inspect(file, db => db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0, supersedes TEXT, source TEXT); INSERT INTO memories VALUES ('legacy','legacy text','hash',1,1,0,0,NULL,'source'); CREATE TABLE memory_occurrences (memory_id TEXT NOT NULL, source TEXT, document_id TEXT, chapter INTEGER, para INTEGER); CREATE TRIGGER fail_migration BEFORE INSERT ON memory_occurrences BEGIN SELECT RAISE(ABORT, 'migration fixture'); END"));
  assert.throws(() => open(file), /unrecognized unversioned database/);
  inspect(file, db => {
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='fail_migration'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='meta'").get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM memory_occurrences').get().n, 0);
    assert.equal(db.prepare('SELECT text FROM memories').get().text, 'legacy text');
  });
}));
test('startup facts rebuild failure rolls back migration', () => fixture(file => {
  seed(file);
  inspect(file, db => db.exec("UPDATE meta SET v='6' WHERE k='schema_version'; DELETE FROM meta WHERE k='occurrences_v1_migrated'; DELETE FROM memory_occurrences"));
  const original = DatabaseSync.prototype.prepare;
  let reads = 0;
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql === 'SELECT rowid AS ord, text FROM memories ORDER BY created_at, id' && ++reads === 2) throw new Error('synthetic rebuild failure');
    return original.call(this, sql);
  };
  try { assert.throws(() => open(file), /synthetic rebuild failure/); }
  finally { DatabaseSync.prototype.prepare = original; }
  inspect(file, db => {
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '6');
    assert.equal(db.prepare("SELECT count(*) n FROM meta WHERE k='occurrences_v1_migrated'").get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM memory_occurrences').get().n, 0);
    db.exec('BEGIN IMMEDIATE; ROLLBACK');
  });
}));

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-preflight-'));
  try { fn(join(dir, 'synthetic.sqlite')); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function inspect(file, fn) {
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
}
function seed(file) {
  const store = open(file);
  try { store.raw().exec("INSERT INTO memories (id,text,text_hash,created_at,last_accessed,source,kind,tier) VALUES ('id','text','hash',1,1,'source','event',3)"); }
  finally { store.close(); }
}
function failKindUpdate(fn, message) {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes('UPDATE memories SET kind')) throw new Error(message);
    return original.call(this, sql);
  };
  try { fn(); } finally { DatabaseSync.prototype.exec = original; }
}
for (const mode of ['delete', 'wal']) {
  test(`future version preserves content and ${mode} mode`, () => fixture(file => {
    seed(file);
    inspect(file, db => { db.exec(`PRAGMA journal_mode=${mode}`); db.exec("UPDATE meta SET v='999' WHERE k='schema_version'; UPDATE memories SET kind='invalid', tier=9; CREATE TABLE facts (marker TEXT); INSERT INTO facts VALUES ('keep')"); });
    assert.throws(() => open(file), /future schema version/);
    inspect(file, db => {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, mode);
      assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '999');
      assert.deepEqual({ ...db.prepare('SELECT kind,tier FROM memories').get() }, { kind: 'invalid', tier: 9 });
      assert.equal(db.prepare('SELECT marker FROM facts').get().marker, 'keep');
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
    });
  }));
}
for (const version of ['0', '7.0', ' 7', '-1', 'garbage', '9007199254740992']) {
  test(`invalid version ${version}`, () => fixture(file => {
    seed(file);
    inspect(file, db => db.prepare("UPDATE meta SET v=? WHERE k='schema_version'").run(version));
    assert.throws(() => open(file), /invalid schema version/);
    inspect(file, db => assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, version));
  }));
}
test('migration fault rolls back occurrence and version changes', () => fixture(file => {
  seed(file);
  inspect(file, db => db.exec("UPDATE meta SET v='6' WHERE k='schema_version'; DELETE FROM meta WHERE k='occurrences_v1_migrated'; DELETE FROM memory_occurrences; UPDATE memories SET kind='invalid'"));
  failKindUpdate(() => assert.throws(() => open(file), /synthetic migration fault/), 'synthetic migration fault');
  inspect(file, db => {
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '6');
    assert.equal(db.prepare("SELECT count(*) n FROM meta WHERE k='occurrences_v1_migrated'").get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM memory_occurrences').get().n, 0);
    assert.equal(db.prepare('SELECT kind FROM memories').get().kind, 'invalid');
    db.exec('BEGIN IMMEDIATE; ROLLBACK');
  });
}));
test('known unversioned shape migrates and reopens', () => fixture(file => {
  inspect(file, db => db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0, supersedes TEXT, source TEXT); INSERT INTO memories VALUES ('legacy','legacy text','hash',1,1,0,0,NULL,'source')"));
  for (let i = 0; i < 2; i++) { const store = open(file); try { assert.equal(store.occurrencesV1('legacy').length, 1); } finally { store.close(); } }
}));
test('unknown versioned database is preserved', () => fixture(file => {
  inspect(file, db => db.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','7'); CREATE TABLE facts (v TEXT); INSERT INTO facts VALUES ('keep')"));
  assert.throws(() => open(file), /unrecognized versioned database/);
  inspect(file, db => assert.equal(db.prepare('SELECT v FROM facts').get().v, 'keep'));
}));
test('unknown unversioned database is preserved', () => fixture(file => {
  inspect(file, db => db.exec("CREATE TABLE alien (v TEXT); INSERT INTO alien VALUES ('keep')"));
  assert.throws(() => open(file), /unrecognized unversioned database/);
  inspect(file, db => assert.equal(db.prepare('SELECT v FROM alien').get().v, 'keep'));
}));
test('new database and repeated opens retain journal mode', () => fixture(file => {
  for (let i = 0; i < 2; i++) { const store = open(file); try { assert.equal(store.raw().prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); } finally { store.close(); } }
}));
test('write lock contention leaves database usable', () => fixture(file => {
  seed(file);
  inspect(file, db => { db.exec('BEGIN IMMEDIATE'); try { assert.throws(() => open(file), /locked/); } finally { db.exec('ROLLBACK'); } });
  const store = open(file); store.close();
}));
test('successful WAL migration preserves mode and advances version', () => fixture(file => {
  seed(file);
  inspect(file, db => db.exec("PRAGMA journal_mode=WAL; UPDATE meta SET v='6' WHERE k='schema_version'"));
  const store = open(file);
  try {
    assert.equal(store.raw().prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(store.raw().prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '7');
  } finally { store.close(); }
}));
test('DDL and occurrence inserts roll back on later fault', () => fixture(file => {
  seed(file);
  inspect(file, db => db.exec("UPDATE meta SET v='6' WHERE k='schema_version'; DELETE FROM meta WHERE k='occurrences_v1_migrated'; DELETE FROM memory_occurrences; DROP TABLE vector_blob; UPDATE memories SET kind='invalid'"));
  failKindUpdate(() => assert.throws(() => open(file), /synthetic fault/), 'synthetic fault');
  inspect(file, db => {
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='vector_blob'").get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM memory_occurrences').get().n, 0);
  });
}));
