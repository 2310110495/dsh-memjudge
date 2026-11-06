import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/store.mjs';

const base = `CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version','1');
CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
 importance REAL NOT NULL DEFAULT 0, supersedes TEXT, source TEXT);
CREATE UNIQUE INDEX ux_memories_hash ON memories(text_hash);
INSERT INTO memories VALUES ('id','synthetic text','hash',1,1,0,0,NULL,NULL);`;

function snapshot(db) {
  return {
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all().map(x => ({ ...x })),
    meta: db.prepare('SELECT * FROM meta').all().map(x => ({ ...x })),
    memories: db.prepare('SELECT rowid,* FROM memories').all().map(x => ({ ...x })),
    facts: db.prepare('SELECT rowid,*,typeof(memory_id) AS memory_type,typeof(value) AS value_type,typeof(at) AS at_type FROM facts').all().map(x => ({ ...x })),
  };
}

for (const type of ['TEXT', 'INTEGER']) {
  test(`persistent ${type} facts block migration and preserve schema, values and storage types`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'memjudge-facts-guard-'));
    const file = join(dir, 'synthetic.sqlite');
    try {
      let db = new DatabaseSync(file);
      db.exec(`${base} CREATE TABLE facts (memory_id ${type} NOT NULL, entity TEXT, attr TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, unit TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE INDEX ix_facts_key ON facts(key);
        INSERT INTO facts VALUES (${type === 'TEXT' ? "'id'" : '1'}, NULL, 'a', 'k', x'00ff', NULL, 'kind', 5);`);
      const before = snapshot(db);
      db.close();
      assert.throws(() => open(file), /persisted facts require forget-safe migration/);
      assert.throws(() => open(file), /persisted facts require forget-safe migration/);
      db = new DatabaseSync(file);
      assert.deepEqual(snapshot(db), before);
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('current deletion SQL leaves historical facts behind', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`${base} CREATE TABLE facts (memory_id TEXT NOT NULL, entity TEXT, attr TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, unit TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX ix_facts_key ON facts(key);
      INSERT INTO facts VALUES ('id', NULL, 'a', 'k', 'sensitive sentinel', NULL, 'kind', 1);
      BEGIN; DELETE FROM memories WHERE id='id'; COMMIT;`);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get().n, 0);
    assert.equal(db.prepare('SELECT value FROM facts').get().value, 'sensitive sentinel');
  } finally { db.close(); }
});
