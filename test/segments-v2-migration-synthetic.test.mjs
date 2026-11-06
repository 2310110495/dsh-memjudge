import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync as RealDatabase } from 'node:sqlite';
import { registerHooks } from 'node:module';
let current, injectFault = false;
globalThis.__syntheticDatabase = class {
  constructor(file) {
    assert.equal(file, ':memory:');
    return new Proxy(current, { get(target, key) {
      if (key === 'close') return () => {};
      if (key === 'prepare') return sql => {
        if (injectFault && sql === 'INSERT INTO segments (ord, bits) VALUES (?, ?)') throw new Error('synthetic fault');
        return target.prepare(sql);
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
};
const hooks = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith('/src/store.mjs')) {
    const source = String(result.source);
    const original = "import { DatabaseSync } from 'node:sqlite';";
    assert.ok(source.includes(original));
    return { ...result, source: source.replace(original, 'const DatabaseSync = globalThis.__syntheticDatabase;') };
  }
  return result;
} });
const { open } = await import('../src/store.mjs');
hooks.deregister();
function fixture(fn) {
  current = new RealDatabase(':memory:');
  try {
    const store = open(':memory:');
    store.raw().exec(`INSERT INTO memories (rowid,id,text,text_hash,created_at,last_accessed,kind,tier)
      VALUES (17,'a','甲乙，丙丁，戊己','a',1,1,'event',3), (41,'b','天地，玄黄，宇宙','b',2,2,'event',3)`);
    store.raw().exec(`DROP TABLE segments;
      CREATE TABLE segments (ord INTEGER PRIMARY KEY, seg_count INTEGER NOT NULL, covered TEXT NOT NULL DEFAULT '') WITHOUT ROWID;
      INSERT INTO segments VALUES (17,3,'111'),(41,3,'1'); UPDATE meta SET v='2' WHERE k='schema_version'`);
    store.close();
    fn(current);
  } finally { current.close(); current = undefined; injectFault = false; }
}
test('v2 coverage and wear survive repeated opens', () => fixture(db => {
  for (let n = 0; n < 2; n++) {
    const store = open(':memory:');
    try {
      assert.deepEqual(store.segmentsOf('a').map(x => x.covered), [1, 1, 1]);
      assert.deepEqual(store.segmentsOf('b').map(x => x.covered), [1, 0, 0]);
      assert.deepEqual(store.wear(), { segments: 6, worn: 2, wear: 0.3333 });
      assert.equal(Buffer.from(db.prepare('SELECT bits FROM segments WHERE ord=17').get().bits).toString('hex'), '000307');
    } finally { store.close(); }
  }
}));
for (const [name, damage] of [
  ['missing row', 'DELETE FROM segments WHERE ord=17'],
  ['orphan row', 'UPDATE segments SET ord=18 WHERE ord=17'],
  ['wrong count', 'UPDATE segments SET seg_count=2 WHERE ord=17'],
  ['invalid count', 'UPDATE segments SET seg_count=-1 WHERE ord=17'],
  ['invalid type', "UPDATE segments SET covered=x'31' WHERE ord=17"],
  ['unknown layout', 'ALTER TABLE segments ADD COLUMN extra TEXT'],

]) {
  test(`${name} rolls back`, () => fixture(db => {
    db.exec(damage);
    assert.throws(() => open(':memory:'), /segments migration|synthetic fault/);
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '2');
    assert.ok(db.prepare('PRAGMA table_info(segments)').all().some(c => c.name === 'covered'));
    assert.equal(db.isTransaction, false);
  }));
}
test('write fault after dropping old table rolls back', () => fixture(db => {
  injectFault = true;
  assert.throws(() => open(':memory:'), /synthetic fault/);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '2');
  assert.equal(db.prepare('SELECT covered FROM segments WHERE ord=17').get().covered, '111');
  assert.equal(db.isTransaction, false);
}));

for (const value of ['1x', '1010', '1\u0000', '１１', ' 1', '1\n']) {
  test(`anomalous covered ${JSON.stringify(value)} rolls back byte-for-byte`, () => fixture(db => {
    db.prepare('UPDATE segments SET covered=? WHERE ord=41').run(value);
    const before = db.prepare('SELECT hex(CAST(covered AS BLOB)) AS bytes FROM segments WHERE ord=41').get().bytes;
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='segments'").get().sql;
    assert.throws(() => open(':memory:'), /anomalous covered string/);
    assert.equal(db.prepare('SELECT hex(CAST(covered AS BLOB)) AS bytes FROM segments WHERE ord=41').get().bytes, before);
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='segments'").get().sql, schema);
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '2');
    assert.equal(db.isTransaction, false);
  }));
}
test('empty historical coverage remains compatible across reopen', () => fixture(db => {
  db.exec("UPDATE segments SET covered='' WHERE ord=41");
  for (let i = 0; i < 2; i++) {
    const store = open(':memory:');
    try { assert.deepEqual(store.segmentsOf('b').map(x => x.covered), [0, 0, 0]); }
    finally { store.close(); }
  }
}));

const factsDDL = `CREATE TABLE facts (
  memory_id INTEGER NOT NULL,
  entity TEXT,
  attr TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
)`;
function historical(version, run, facts = null) {
  current = new RealDatabase(':memory:');
  try {
    current.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version','${version}');
      CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
        importance REAL NOT NULL DEFAULT 0, supersedes TEXT, source TEXT);
      CREATE UNIQUE INDEX ux_memories_hash ON memories(text_hash);
      INSERT INTO memories (rowid,id,text,text_hash,created_at,last_accessed) VALUES (17,'a','甲乙，丙丁，戊己','hash',1,1);
      ${version === 2 ? "CREATE TABLE segments (ord INTEGER PRIMARY KEY, seg_count INTEGER NOT NULL, covered TEXT NOT NULL DEFAULT '') WITHOUT ROWID; INSERT INTO segments VALUES (17,3,'101');" : "CREATE TABLE segments (ord INTEGER PRIMARY KEY, bits BLOB NOT NULL) WITHOUT ROWID; INSERT INTO segments VALUES (17,x'000305');"}
      ${facts ? `${facts};
      INSERT INTO facts(rowid,memory_id,entity,attr,key,value,unit,kind,at) VALUES
        (9,17,NULL,'depth','d','001',NULL,'value',3),
        (37,17,x'00ff','attr','k',x'4100','unit','id',4);` : ''}`);
    run(current);
  } finally { current.close(); current = undefined; injectFault = false; }
}
function factsSnapshot(db) {
  return db.prepare(`SELECT rowid, memory_id, typeof(memory_id) mt, hex(entity) e, typeof(entity) et,
    attr, key, hex(value) v, typeof(value) vt, unit, kind, at, typeof(at) att FROM facts ORDER BY rowid`).all().map(x => ({...x}));
}
for (const version of [2, 3]) {
  test(`historical v${version} without facts migrates coverage and reopens`, () => historical(version, db => {
    for (let i = 0; i < 2; i++) {
      const store = open(':memory:');
      try {
        assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '7');
        assert.deepEqual(store.segmentsOf('a').map(x => x.covered), [1, 0, 1]);
      } finally { store.close(); }
    }
  }));
  test(`historical v${version} facts block migration without mutation`, () => historical(version, db => {
    const before = factsSnapshot(db);
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='facts'").get().sql;
    const root = db.prepare("SELECT rootpage FROM sqlite_master WHERE name='facts'").get().rootpage;
    const snapshot = metaSnapshot(db);
    for (let i = 0; i < 2; i++) {
      assert.throws(() => open(':memory:'), /persisted facts require forget-safe migration/);
      assert.deepEqual(factsSnapshot(db), before);
      assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='facts'").get().sql, ddl);
      assert.equal(db.prepare("SELECT rootpage FROM sqlite_master WHERE name='facts'").get().rootpage, root);
      assert.deepEqual(metaSnapshot(db), snapshot);
      assert.equal(db.isTransaction, false);
    }
  }, factsDDL));
}
for (const [name, change] of [
  ['extra index', 'CREATE INDEX facts_extra ON facts(value)'],
  ['extra trigger', 'CREATE TRIGGER facts_extra AFTER INSERT ON facts BEGIN SELECT 1; END'],
  ['extra object', 'CREATE TABLE unknown_object(x)'],
]) test(`historical facts reject ${name} without mutation`, () => historical(2, db => {
  db.exec(change);
  const before = factsSnapshot(db);
  assert.throws(() => open(':memory:'), /persisted facts require forget-safe migration/);
  assert.deepEqual(factsSnapshot(db), before);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '2');
  assert.equal(db.isTransaction, false);
}, factsDDL));
for (const [name, ddl] of [
  ['extra constraint', factsDDL.replace('value TEXT NOT NULL', 'value TEXT NOT NULL CHECK(length(value)>0)')],
  ['extra column', factsDDL.replace('at INTEGER NOT NULL', 'at INTEGER NOT NULL, other TEXT')],
]) test(`historical facts reject ${name}`, () => historical(2, db => {
  const before = factsSnapshot(db);
  assert.throws(() => open(':memory:'), /persisted facts require forget-safe migration/);
  assert.deepEqual(factsSnapshot(db), before);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '2');
}, ddl));
test('historical segments remain unchanged after migration fault', () => historical(2, db => {
  const before = metaSnapshot(db);
  injectFault = true;
  assert.throws(() => open(':memory:'), /synthetic fault/);
  assert.deepEqual(metaSnapshot(db), before);
  assert.equal(db.prepare('SELECT covered FROM segments').get().covered, '101');
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '2');
  assert.equal(db.isTransaction, false);
}));
function metaSnapshot(db) {
  return {
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all().map(row => ({ ...row })),
    meta: db.prepare('SELECT k,v FROM meta ORDER BY k').all().map(row => ({ ...row })),
    segments: db.prepare('SELECT * FROM segments ORDER BY ord').all().map(row => ({ ...row })),
  };
}
for (const [name, ddl] of [
  ['extra unique value', 'CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL UNIQUE)'],
  ['table unique', 'CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL, UNIQUE(v,k))'],
  ['replace policy', 'CREATE TABLE meta (k TEXT PRIMARY KEY ON CONFLICT REPLACE, v TEXT NOT NULL)'],
  ['check constraint', 'CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL CHECK(length(v)>0))'],
  ['collation', 'CREATE TABLE meta (k TEXT PRIMARY KEY COLLATE NOCASE, v TEXT NOT NULL)'],
  ['without rowid', 'CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID'],
]) {
  test(`meta ${name} is rejected unchanged`, () => historical(2, db => {
    db.exec(`ALTER TABLE meta RENAME TO old_meta; ${ddl}; INSERT INTO meta SELECT * FROM old_meta; DROP TABLE old_meta; INSERT INTO meta VALUES ('other','7')`);
    const before = metaSnapshot(db);
    assert.throws(() => open(':memory:'), /unrecognized meta/);
    assert.deepEqual(metaSnapshot(db), before);
    assert.equal(db.isTransaction, false);
  }));
}
test('meta extra index is rejected unchanged', () => historical(2, db => {
  db.exec('CREATE INDEX meta_extra ON meta(v)');
  const before = metaSnapshot(db);
  assert.throws(() => open(':memory:'), /unrecognized meta indexes/);
  assert.deepEqual(metaSnapshot(db), before);
}));
test('meta upgrade retains unrelated row with same target value', () => historical(2, db => {
  db.exec("INSERT INTO meta VALUES ('other','7')");
  open(':memory:').close();
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '7');
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='other'").get().v, '7');
}));
test('meta migration fault restores metadata and old table', () => historical(2, db => {
  db.exec("INSERT INTO meta VALUES ('other','7')");
  const before = metaSnapshot(db);
  injectFault = true;
  assert.throws(() => open(':memory:'), /synthetic fault/);
  assert.deepEqual(metaSnapshot(db), before);
  assert.equal(db.isTransaction, false);
}));
test('unversioned historical facts are conservatively rejected', () => historical(2, db => {
  db.exec("DELETE FROM meta WHERE k='schema_version'");
  const before = factsSnapshot(db);
  assert.throws(() => open(':memory:'), /unrecognized unversioned database: persisted facts require forget-safe migration/);
  assert.deepEqual(factsSnapshot(db), before);
}, factsDDL));
