import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, STORE_SCHEMA_VERSION } from '../src/store.mjs';

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-schema-isolated-'));
  try { run(join(dir, 'synthetic.sqlite')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function seed(file) {
  const store = open(file);
  try {
    store.raw().exec(`INSERT INTO memories
      (id,text,text_hash,created_at,last_accessed,access_count,importance,source,kind,tier)
      VALUES ('synthetic-id','synthetic text','synthetic-hash',1,1,0,0,'synthetic-source','event',3)`);
  } finally { store.close(); }
}

function inspect(file, fn) {
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
}

test('future version and prior data are preserved', () => fixture(file => {
  seed(file);
  inspect(file, db => db.exec(`UPDATE meta SET v='999' WHERE k='schema_version';
    UPDATE memories SET kind='invalid', tier=9 WHERE id='synthetic-id';
    CREATE TABLE facts (marker TEXT); INSERT INTO facts VALUES ('synthetic');`));
  assert.throws(() => open(file), /future schema version/);
  inspect(file, db => {
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '999');
    assert.deepEqual({ ...db.prepare("SELECT kind,tier FROM memories WHERE id='synthetic-id'").get() }, { kind: 'invalid', tier: 9 });
    assert.equal(db.prepare("SELECT marker FROM facts").get().marker, 'synthetic');
  });
}));

test('unknown trigger blocks migration without changes', () => fixture(file => {
  seed(file);
  inspect(file, db => db.exec(`UPDATE meta SET v='6' WHERE k='schema_version';
    DELETE FROM meta WHERE k='occurrences_v1_migrated';
    DELETE FROM memory_occurrences;
    UPDATE memories SET kind='invalid' WHERE id='synthetic-id';
    CREATE TRIGGER synthetic_fail BEFORE UPDATE OF kind ON memories
    BEGIN SELECT RAISE(ABORT, 'synthetic migration fault'); END;`));
  assert.throws(() => open(file), /unrecognized versioned database/);
  inspect(file, db => {
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '6');
    assert.equal(db.prepare("SELECT count(*) AS n FROM meta WHERE k='occurrences_v1_migrated'").get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_occurrences').get().n, 0);
    assert.equal(db.prepare("SELECT kind FROM memories WHERE id='synthetic-id'").get().kind, 'invalid');
    db.exec('BEGIN IMMEDIATE; ROLLBACK;');
  });
}));
