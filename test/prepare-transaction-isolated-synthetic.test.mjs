import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/store.mjs';

test('prepare failure rolls back initialization and permits a later successful open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-prepare-transaction-'));
  const file = join(dir, 'synthetic.sqlite');
  const inspect = (fn) => {
    const db = new DatabaseSync(file);
    try { return fn(db); } finally { db.close(); }
  };
  try {
    const seed = open(file);
    try {
      seed.raw().exec("INSERT INTO memories (id,text,text_hash,created_at,last_accessed,source,kind,tier) VALUES ('id','text','hash',1,1,'source','event',3)");
    } finally { seed.close(); }
    inspect(db => db.exec("UPDATE meta SET v='6' WHERE k='schema_version'; DELETE FROM meta WHERE k='occurrences_v1_migrated'; DELETE FROM memory_occurrences; DROP TABLE vector_blob; UPDATE memories SET kind='invalid'"));
    const snapshot = () => inspect(db => ({
      schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all().map(row => ({ ...row })),
      meta: db.prepare('SELECT * FROM meta ORDER BY k').all().map(row => ({ ...row })),
      memories: db.prepare('SELECT * FROM memories ORDER BY id').all().map(row => ({ ...row })),
      occurrences: db.prepare('SELECT * FROM memory_occurrences').all().map(row => ({ ...row })),
      segments: db.prepare('SELECT ord,hex(bits) AS bits FROM segments ORDER BY ord').all().map(row => ({ ...row })),
    }));
    const before = snapshot();
    const prepare = DatabaseSync.prototype.prepare;
    let injected = false;
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql === 'SELECT id, text, kind, tier FROM memories WHERE text_hash = ?') {
        injected = true;
        throw new Error('synthetic statement prepare failure');
      }
      return prepare.call(this, sql);
    };
    try { assert.throws(() => open(file), /synthetic statement prepare failure/); }
    finally { DatabaseSync.prototype.prepare = prepare; }
    assert.equal(injected, true);
    assert.deepEqual(snapshot(), before);
    inspect(db => db.exec('BEGIN IMMEDIATE; ROLLBACK'));
    const reopened = open(file);
    try {
      assert.equal(reopened.raw().prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '7');
      assert.equal(reopened.raw().prepare('SELECT kind FROM memories').get().kind, 'event');
      assert.equal(reopened.occurrencesV1('id').length, 1);
      assert.equal(reopened.raw().prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='vector_blob'").get().n, 1);
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
