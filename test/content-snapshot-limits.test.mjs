import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/store.mjs';

function fixture() {
  const store = open(':memory:');
  const db = store.raw();
  const insert = db.prepare('INSERT INTO memories (id,text,text_hash,created_at,last_accessed,access_count,importance,source,kind,tier) VALUES (?,?,?,?,?,?,?,?,?,?)');
  return { store, db, add(id, text) { insert.run(id, text, `hash-${id}`, 1, 1, 0, 0.5, null, 'event', 3); } };
}

test('row, raw and decoded field and cumulative budgets are inclusive', () => {
  const { store, add } = fixture();
  try {
    add('a', '😀\0甲');
    const row = store.contentSnapshot().rows[0];
    const fields = ['id', 'text', 'text_hash', 'supersedes', 'source', 'kind'];
    const sizes = fields.map(k => Buffer.byteLength(row[k] ?? ''));
    const total = sizes.reduce((a, b) => a + b, 0), field = Math.max(...sizes);
    assert.equal(store.contentSnapshot({ maxRows: 1, maxBytes: total, maxFieldBytes: field, maxExtractBytes: 8 }).rows[0].text, '😀\0甲');
    for (const options of [{ maxRows: 0 }, { maxBytes: total - 1 }, { maxFieldBytes: field - 1 }, { maxExtractBytes: 7 }]) {
      assert.throws(() => store.contentSnapshot(options), /limit/);
      assert.equal(store.raw().isTransaction, false);
    }
    assert.throws(() => store.contentSnapshot({ maxRows: Infinity }), /invalid maxRows/);
  } finally { store.close(); }
});

test('invalid UTF-8 expansion and hostile SQLite types fail without publishing', () => {
  const { store, db, add } = fixture();
  try {
    add('a', 'x');
    db.exec("UPDATE memories SET text=CAST(X'8080' AS TEXT)");
    assert.throws(() => store.contentSnapshot({ maxFieldBytes: 5 }), /limit/);
    assert.equal(store.contentSnapshot({ maxFieldBytes: 16 }).rows[0].text, '\ufffd\ufffd');
    db.exec("UPDATE memories SET text=X'6162'");
    assert.throws(() => store.contentSnapshot(), /limit/);
    db.exec("UPDATE memories SET text='x', importance=1e999");
    assert.throws(() => store.contentSnapshot(), /limit/);
    assert.equal(db.isTransaction, false);
  } finally { store.close(); }
});

test('facts budget is checked before publishing any snapshot', () => {
  const { store, add } = fixture();
  try {
    add('a', '港口人数为27人。');
    const full = store.contentSnapshot();
    assert.ok(full.facts.total > 0);
    assert.equal(store.contentSnapshot({ maxFacts: full.facts.total }).facts.total, full.facts.total);
    assert.throws(() => store.contentSnapshot({ maxFacts: full.facts.total - 1 }), /facts limit/);
    assert.equal(store.contentSnapshot().facts.total, full.facts.total);
  } finally { store.close(); }
});

test('unique file database preserves cumulative limits across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'content-limit-'));
  const path = join(dir, 'fixture.sqlite');
  let store;
  try {
    store = open(path);
    store.put({ text: '第一条 😀\0甲' });
    store.put({ text: '第二条 😀\0乙' });
    store.close();
    store = open(path);
    const snapshot = store.contentSnapshot();
    const fields = ['id', 'text', 'text_hash', 'supersedes', 'source', 'kind'];
    const total = snapshot.rows.reduce((n, row) => n + fields.reduce((sum, key) => sum + Buffer.byteLength(row[key] ?? ''), 0), 0);
    assert.equal(store.contentSnapshot({ maxRows: 2, maxBytes: total }).rows.length, 2);
    assert.throws(() => store.contentSnapshot({ maxRows: 1 }), /limit/);
    assert.throws(() => store.contentSnapshot({ maxBytes: total - 1 }), /limit/);
  } finally { if (store) store.close(); rmSync(dir, { recursive: true, force: true }); }
});
