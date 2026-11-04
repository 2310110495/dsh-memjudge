import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';
import { scanConflictsV2 } from '../src/conflict-scan-v2.mjs';

test('memory scan rejects existing transactions and reentrancy without closing connection', () => {
  const store = open(':memory:');
  try {
    assert.equal(store.scanConflictsV2().total, 0);
    const db = store.raw();
    db.exec('BEGIN');
    assert.throws(() => store.scanConflictsV2(), /idle connection/);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    const options = { get limits() { assert.throws(() => store.scanConflictsV2(), /idle connection/); return {}; } };
    assert.equal(store.scanConflictsV2(options).total, 0);
    assert.equal(db.prepare('SELECT 1 AS n').get().n, 1);
  } finally { store.close(); }
});

test('file scan matches file facade and releases external write lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-scan-'));
  const file = join(dir, 'test.db');
  const store = open(file);
  let other;
  try {
    store.put({ text: '桥梁长度10米。', source: 'a', documentId: 'doc' });
    store.put({ text: '桥梁长度20米。', source: 'b', documentId: 'doc' });
    const result = store.scanConflictsV2();
    assert.equal(result.total, 1);
    assert.deepEqual(result, scanConflictsV2(file));
    other = new DatabaseSync(file);
    other.exec('BEGIN IMMEDIATE; COMMIT');
    assert.equal(store.raw().isTransaction, false);
  } finally { other?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('scan and rollback failures retain both errors without closing the main connection', () => {
  const store = open(':memory:');
  const db = store.raw();
  const originalPrepare = db.prepare;
  const originalExec = db.exec;
  try {
    db.prepare = function(sql) { if (sql.includes('length(CAST(id AS BLOB))')) throw new Error('scan fault'); return originalPrepare.call(this, sql); };
    db.exec = function(sql) { if (sql === 'ROLLBACK') { originalExec.call(this, sql); throw new Error('rollback fault'); } return originalExec.call(this, sql); };
    assert.throws(() => store.scanConflictsV2(), error => error instanceof AggregateError && error.errors.map(e => e.message).join(',') === 'scan fault,rollback fault');
    assert.equal(db.isTransaction, false);
    assert.equal(originalPrepare.call(db, 'SELECT 1 AS n').get().n, 1);
  } finally { db.prepare = originalPrepare; db.exec = originalExec; store.close(); }
});

test('dynamic budgets are read once for memory and file scans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-budget-'));
  const file = join(dir, 'test.db');
  const memory = open(':memory:');
  const disk = open(file);
  try {
    for (const store of [memory, disk]) store.put({ text: '桥梁长度10米。', source: 's' });
    for (const scan of [options => memory.scanConflictsV2(options), options => disk.scanConflictsV2(options), options => scanConflictsV2(file, options)]) {
      let outer = 0, records = 0, sentences = 0;
      const snapshot = new Proxy({ get records() { records++; return records === 1 ? 0 : 1001; } }, {});
      const limits = new Proxy({ get sentences() { sentences++; return sentences === 1 ? 0 : 10001; } }, {});
      const options = { get snapshot() { outer++; return snapshot; }, get limits() { outer++; return limits; } };
      const result = scan(options);
      assert.equal(result.reason, 'snapshot:records');
      assert.equal(records, 1);
      assert.equal(sentences, 1);
      assert.equal(outer, 2);
      assert.equal(scan().scanIncomplete, false);
    }
    const other = new DatabaseSync(file);
    try { other.exec('BEGIN IMMEDIATE; COMMIT'); } finally { other.close(); }
  } finally { memory.close(); disk.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('throwing and reentrant budget access leaves both connections usable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-budget-errors-'));
  const file = join(dir, 'test.db');
  const store = open(file);
  try {
    for (const scan of [options => store.scanConflictsV2(options), options => scanConflictsV2(file, options)]) {
      const snapshot = new Proxy({ records: 1 }, { get() { throw new Error('budget fault'); } });
      assert.throws(() => scan({ snapshot }), /budget fault/);
      assert.throws(() => scan({ limits: { sentences: -1 } }), /invalid limit/);
      assert.equal(store.raw().isTransaction, false);
      const other = new DatabaseSync(file);
      try { other.exec('BEGIN IMMEDIATE; COMMIT'); } finally { other.close(); }
    }
    let calls = 0;
    const options = { snapshot: { get records() { calls++; assert.throws(() => store.scanConflictsV2(), /idle connection/); return 0; } } };
    store.scanConflictsV2(options);
    assert.equal(calls, 1);
    assert.equal(store.raw().isTransaction, false);
    assert.equal(store.raw().prepare('SELECT 1 AS n').get().n, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
