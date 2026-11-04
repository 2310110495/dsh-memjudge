import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';

test('budget counts UTF-16 units after emoji and embedded NUL; duplicate stays free', () => {
  const s = open(':memory:', { maxChars: 6 });
  try {
    const text = 'a\0😀b';
    assert.equal(text.length, 5);
    assert.equal(s.put({ text }).inserted, true);
    assert.equal(s.stats().textChars, 1);
    assert.equal(s.put({ text }).inserted, false);
    assert.equal(s.put({ text: 'z' }).inserted, true);
    assert.throws(() => s.put({ text: 'x' }), /budget/i);
    assert.equal(s.stats().memories, 2);
  } finally { s.close(); }
});

test('competing connection is included after write lock acquisition', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-utf16-budget-'));
  const file = path.join(dir, 'fixture.db');
  const a = open(file, { maxChars: 5 });
  const b = open(file, { maxChars: 5 });
  const exec = DatabaseSync.prototype.exec;
  let inject = true;
  try {
    DatabaseSync.prototype.exec = function (sql) {
      if (this === a.raw() && sql === 'BEGIN IMMEDIATE' && inject) {
        inject = false;
        b.put({ text: '😀\0x' });
      }
      return exec.call(this, sql);
    };
    assert.throws(() => a.put({ text: 'ab' }), /budget/i);
    assert.equal(a.put({ text: 'a' }).inserted, true);
    assert.equal(a.stats().memories, 2);
  } finally {
    DatabaseSync.prototype.exec = exec;
    a.close(); b.close();
  }
});
