import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';

let current;
globalThis.__preflightFixtureDatabase = class {
  constructor(file) {
    assert.equal(file, ':memory:');
    return new Proxy(current, { get(target, key) {
      if (key === 'close') return () => {};
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
};
const hooks = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/src/store.mjs')) return result;
  const source = String(result.source);
  const original = "import { DatabaseSync } from 'node:sqlite';";
  assert.ok(source.includes(original));
  return { ...result, source: source.replace(original, 'const DatabaseSync = globalThis.__preflightFixtureDatabase;') };
} });
const { open } = await import('../src/store.mjs');
hooks.deregister();


function fixture(fn) {
  current = new DatabaseSync(':memory:');
  try {
    const store = open(':memory:');
    store.raw().exec("INSERT INTO memories (rowid,id,text,text_hash,created_at,last_accessed) VALUES (17,'id','text','hash',1,1)");
    store.close();
    fn(current);
  } finally { current.close(); current = undefined; }
}
function v2(db, extra = '') {
  db.exec(`DROP TABLE segments;
    CREATE TABLE segments (ord INTEGER PRIMARY KEY, seg_count INTEGER NOT NULL, covered TEXT NOT NULL DEFAULT '' ${extra}) WITHOUT ROWID;
    INSERT INTO segments (ord,seg_count,covered) VALUES (17,1,'1');
    UPDATE meta SET v='2' WHERE k='schema_version'`);
}
function snapshot(db) {
  return JSON.stringify({
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    meta: db.prepare('SELECT * FROM meta ORDER BY k').all(),
    memories: db.prepare('SELECT * FROM memories').all(),
    segments: db.prepare('SELECT * FROM segments').all(),
    occurrence: db.prepare('SELECT * FROM memory_occurrences').all(),
  });
}
function rejectsPreserving(db, message) {
  const before = snapshot(db);
  assert.throws(() => open(':memory:'), message);
  assert.equal(db.isTransaction, false);
  assert.equal(snapshot(db), before);
}

test('old preflight loses a disguised segments index during v2 rebuild', () => fixture(db => {
  v2(db);
  db.exec('DROP INDEX ux_memories_hash; CREATE INDEX ux_memories_hash ON segments(covered)');
  const index = db.prepare("SELECT type,name FROM sqlite_master WHERE name='ux_memories_hash'").get();
  assert.equal(`${index.type}:${index.name}`, 'index:ux_memories_hash');
  db.exec('DROP TABLE segments');
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='ux_memories_hash'").get().n, 0);
}));
for (const name of ['ux_memories_hash', 'ux_memory_occurrences_position']) {
  test(`${name} attached to v2 segments is preserved`, () => fixture(db => {
    v2(db);
    db.exec(`DROP INDEX ${name}; CREATE INDEX ${name} ON segments(covered)`);
    rejectsPreserving(db, /unrecognized database index/);
  }));
}
for (const [name, sql] of [
  ['ux_memories_hash', 'CREATE INDEX ux_memories_hash ON memories(text_hash)'],
  ['ux_memories_hash', 'CREATE UNIQUE INDEX ux_memories_hash ON memories(text_hash) WHERE text_hash <> \'\''],
  ['ux_memory_occurrences_position', 'CREATE UNIQUE INDEX ux_memory_occurrences_position ON memory_occurrences(memory_id)'],
]) {
  test(`${name} with incorrect definition is preserved`, () => fixture(db => {
    db.exec(`DROP INDEX ${name}; ${sql}`);
    rejectsPreserving(db, /unrecognized database index/);
  }));
}
for (const generated of ['VIRTUAL', 'STORED']) {
  test(`v2 segments with ${generated} generated column is preserved`, () => fixture(db => {
    v2(db, `, extra TEXT GENERATED ALWAYS AS (covered) ${generated}`);
    rejectsPreserving(db, /segments migration: unrecognized layout/);
  }));
  test(`current segments with ${generated} generated column is preserved`, () => fixture(db => {
    db.exec(`DROP TABLE segments; CREATE TABLE segments (ord INTEGER PRIMARY KEY, bits BLOB NOT NULL, extra INTEGER GENERATED ALWAYS AS (length(bits)) ${generated}) WITHOUT ROWID; INSERT INTO segments(ord,bits) VALUES (17,x'000101')`);
    rejectsPreserving(db, /segments migration: unrecognized layout/);
  }));
}
test('canonical indices and v2 segments migrate and reopen', () => fixture(db => {
  v2(db);
  for (let i = 0; i < 2; i++) {
    const store = open(':memory:');
    try { assert.deepEqual(store.segmentsOf('id').map(x => x.covered), [1]); }
    finally { store.close(); }
  }
  assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE name='ux_memories_hash'").get().tbl_name, 'memories');
}));
for (const version of [2, 7]) {
  for (const check of ['CHECK(1)', "CHECK(length('CHECK ( 1 )') > 0)"]) {
    test(`v${version} disguised ${check} is rejected unchanged`, () => fixture(db => {
      db.exec('DROP TABLE segments');
      if (version === 2) {
        db.exec(`CREATE TABLE segments (ord INTEGER PRIMARY KEY, seg_count INTEGER NOT NULL, covered TEXT NOT NULL DEFAULT '' ${check}) WITHOUT ROWID;
          INSERT INTO segments VALUES (17,1,'1'); UPDATE meta SET v='2' WHERE k='schema_version'`);
      } else {
        db.exec(`CREATE TABLE segments (ord INTEGER PRIMARY KEY, bits BLOB NOT NULL ${check}) WITHOUT ROWID;
          INSERT INTO segments VALUES (17,x'000101')`);
      }
      rejectsPreserving(db, /segments migration: unrecognized layout/);
    }));
  }
}
test('missing historical indexes are recreated', () => fixture(db => {
  v2(db);
  db.exec('DROP INDEX ux_memories_hash; DROP INDEX ux_memory_occurrences_position');
  const store = open(':memory:');
  store.close();
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='index' AND name IN ('ux_memories_hash','ux_memory_occurrences_position')").get().n, 2);
}));
