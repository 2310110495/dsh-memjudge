import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/store.mjs';

test('raw connection can create persistent facts and bypass forget path', () => {
  const store = open(':memory:');
  try {
    const { id } = store.put({ text: 'Synthetic boundary text.' });
    const db = store.raw();
    db.exec('CREATE TABLE facts (memory_id TEXT NOT NULL, value TEXT NOT NULL)');
    db.prepare('INSERT INTO facts VALUES (?, ?)').run(id, 'synthetic historical value');
    db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get().n, 0);
    assert.equal(db.prepare('SELECT value FROM facts').get().value, 'synthetic historical value');
  } finally { store.close(); }
});

test('integer orphan can alias a reused rowid', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY); CREATE TABLE facts (memory_id INTEGER, value TEXT); INSERT INTO memories(rowid,id) VALUES (7,'old'); INSERT INTO facts VALUES (7,'old fact'); DELETE FROM memories WHERE id='old'; INSERT INTO memories(rowid,id) VALUES (7,'new');");
    assert.equal(db.prepare('SELECT facts.value FROM facts JOIN memories ON facts.memory_id=memories.rowid WHERE memories.id=?').get('new').value, 'old fact');
  } finally { db.close(); }
});

test('startup write transaction excludes a competing schema writer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'facts-boundary-'));
  const file = join(dir, 'synthetic.sqlite');
  let a, b;
  try {
    a = new DatabaseSync(file);
    b = new DatabaseSync(file);
    a.exec('BEGIN IMMEDIATE');
    assert.throws(() => b.exec('CREATE TABLE facts (memory_id TEXT)'), /locked/);
    a.exec('ROLLBACK');
    b.exec('CREATE TABLE facts (memory_id TEXT)');
    b.close(); b = null;
    a.close(); a = null;
    assert.throws(() => open(file), /unrecognized|persisted facts/);
  } finally {
    if (a?.isTransaction) a.exec('ROLLBACK');
    a?.close(); b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
