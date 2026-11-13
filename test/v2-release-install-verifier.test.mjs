import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, version = 8) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-install-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  fs.mkdirSync(install);
  fs.cpSync(path.join(source, 'src'), path.join(install, 'src'), { recursive: true });
  for (const name of ['package.json', 'client.js', 'cordis.patch.yml']) fs.copyFileSync(path.join(source, name), path.join(install, name));
  const dbPath = path.join(root, 'fixture.db');
  if (version === 8) { const store = open(dbPath); store.close(); }
  if (version === 7) {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE memories(id TEXT PRIMARY KEY, tier INTEGER); CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES('schema_version', '7');");
    db.close();
  }
  return { root, install, dbPath };
}
function check(f, strict = true) {
  return spawnSync(process.execPath, [path.join(source, 'scripts/verify-install.mjs'), '--install', f.install, '--db', f.dbPath, ...(strict ? ['--require-v8'] : [])], { encoding: 'utf8', timeout: 30000 });
}
test('install verifier: complete v8 copy passes read-only strict checks', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.dbPath);
  const result = check(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /schema:ok\(v8\)/);
  assert.match(result.stdout, /未证明宿主已加载/);
  assert.deepEqual(fs.readFileSync(f.dbPath), before);
});
test('install verifier: missing bundle patch fails the manifest check', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.install, 'cordis.patch.yml'));
  const result = check(f);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /cordis\.patch\.yml 装机缺失/);
});
test('install verifier: v7 remains pending unless strict v8 is required; no migration', t => {
  const f = fixture(t, 7);
  const before = fs.readFileSync(f.dbPath);
  const pending = check(f, false);
  assert.equal(pending.status, 0, pending.stdout + pending.stderr);
  assert.match(pending.stdout, /schema:pending\(v7\)/);
  const strict = check(f);
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  assert.match(strict.stdout, /Schema v8 required; found v7/);
  assert.deepEqual(fs.readFileSync(f.dbPath), before);
});
test('install verifier: missing database fails strict release checks', t => {
  const f = fixture(t, 0);
  const result = check(f);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /database does not exist/);
  assert.equal(fs.existsSync(f.dbPath), false);
});
test('install verifier: version label alone does not make a malformed v8 database pass', t => {
  const f = fixture(t, 7);
  const db = new DatabaseSync(f.dbPath);
  db.exec("UPDATE meta SET v = '8' WHERE k = 'schema_version'"); db.close();
  const result = check(f);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /v8 tables missing or not STRICT/);
});
