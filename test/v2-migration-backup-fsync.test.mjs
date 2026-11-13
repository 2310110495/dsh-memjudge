import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';

const TEXT = 'Windows migration must preserve 原文 🧪 without skipping durable backup.';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-backup-fsync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'legacy.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '7');
      CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_accessed INTEGER, kind TEXT, tier INTEGER);`);
    db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-1', TEXT, 1000, 1000, 'promise', 1);
  } finally { db.close(); }
  return { file, dir, backup: file + '.v7.bak' };
}

function assertLegacy(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '7');
    assert.equal(db.prepare('SELECT text FROM memories WHERE id=?').get('legacy-1').text, TEXT);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
}

test('disk v7 migration durably publishes a readable old-schema backup and reopens v8', (t) => {
  const { file, backup, dir } = fixture(t);
  const store = open(file); // Real fsync: Windows rejects a read-only descriptor with EPERM.
  try {
    assert.equal(store.raw().prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '8');
    assert.equal(store.get('legacy-1').text, TEXT);
    assert.equal(store.get('legacy-1').spaceId, 'global');
  } finally { store.close(); }
  assertLegacy(backup);
  const oldBackup = fs.readFileSync(backup);
  const reopened = open(file);
  try { assert.equal(reopened.get('legacy-1').text, TEXT); } finally { reopened.close(); }
  assert.deepEqual(fs.readFileSync(backup), oldBackup, 'idempotent open must preserve rollback history');
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.snapshot-')), []);
});

test('snapshot flush uses a non-truncating writable descriptor before atomic publication', (t) => {
  const { file } = fixture(t);
  const nativeOpen = fs.openSync;
  const nativeFsync = fs.fsyncSync;
  const nativeLink = fs.linkSync;
  let snapshotFd;
  let flushed = false;
  let published = false;
  t.mock.method(fs, 'openSync', (name, flags, ...args) => {
    if (String(name).endsWith('snapshot.db')) {
      assert.equal(flags, 'r+', 'FlushFileBuffers on Windows needs write access, without truncating the snapshot');
      snapshotFd = nativeOpen(name, flags, ...args);
      return snapshotFd;
    }
    return nativeOpen(name, flags, ...args);
  });
  t.mock.method(fs, 'fsyncSync', fd => {
    assert.equal(fd, snapshotFd);
    nativeFsync(fd);
    flushed = true;
  });
  t.mock.method(fs, 'linkSync', (...args) => {
    assert.equal(flushed, true, 'durability must precede publishing the rollback point');
    nativeLink(...args);
    published = true;
  });
  const store = open(file);
  try { assert.equal(store.get('legacy-1').text, TEXT); } finally { store.close(); }
  assert.equal(flushed, true);
  assert.equal(published, true);
});

test('fsync failure remains fatal before migration DDL and cleans temporary snapshot', (t) => {
  const { file, backup, dir } = fixture(t);
  const failure = Object.assign(new Error('injected snapshot flush failure'), { code: 'EIO' });
  t.mock.method(fs, 'fsyncSync', () => { throw failure; });
  assert.throws(() => open(file), error => error === failure);
  assert.equal(fs.existsSync(backup), false, 'failed flush must never publish an unsafe backup');
  assertLegacy(file);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.snapshot-')), []);
});

test('an existing rollback backup is never overwritten or treated as fresh', (t) => {
  const { file, backup } = fixture(t);
  const history = Buffer.from('previous backup must survive');
  fs.writeFileSync(backup, history);
  assert.throws(() => open(file), /migration backup already exists/);
  assert.deepEqual(fs.readFileSync(backup), history);
  assertLegacy(file);
});
