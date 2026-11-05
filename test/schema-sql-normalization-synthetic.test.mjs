import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/store.mjs';

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-sql-normalization-'));
  const file = join(dir, 'synthetic.sqlite');
  try {
    const store = open(file);
    store.close();
    fn(file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function mutate(file, sql) {
  const db = new DatabaseSync(file);
  try { db.exec(sql); } finally { db.close(); }
}

test('plugin-created multiline index and trigger reopen', () => fixture(file => {
  const db = new DatabaseSync(file);
  try {
    for (const name of ['ux_memory_occurrences_position', 'memory_occurrences_delete']) {
      assert.match(db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name).sql, /\n/);
    }
  } finally { db.close(); }
  const store = open(file);
  store.close();
}));

test('plugin-created multiline trigger is checked independently', () => fixture(file => {
  mutate(file, 'DROP INDEX ux_memory_occurrences_position');
  const store = open(file);
  store.close();
}));

for (const value of [' ', '  ', '\t', '\n']) {
  test(`index with nonempty literal ${JSON.stringify(value)} is rejected`, () => fixture(file => {
    mutate(file, `DROP INDEX ux_memory_occurrences_position;
      CREATE UNIQUE INDEX ux_memory_occurrences_position ON memory_occurrences
      (memory_id, source IS NULL, coalesce(source, '${value}'), document_id IS NULL,
       coalesce(document_id, ''), chapter IS NULL, coalesce(chapter, 0), para IS NULL, coalesce(para, 0))`);
    assert.throws(() => open(file), /unrecognized database index/);
  }));
}

test('forged multiline trigger is rejected', () => fixture(file => {
  mutate(file, `DROP TRIGGER memory_occurrences_delete;
    CREATE TRIGGER memory_occurrences_delete AFTER DELETE ON memories BEGIN
    DELETE FROM memory_occurrences WHERE memory_id != OLD.id; END`);
  assert.throws(() => open(file), /unrecognized database trigger/);
}));
