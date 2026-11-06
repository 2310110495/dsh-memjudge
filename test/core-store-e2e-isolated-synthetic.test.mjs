import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/store.mjs';
import { SearchIndex } from '../src/search.mjs';

test('synthetic store persistence, lookup, conflict scan and manual deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-core-synthetic-'));
  const file = join(dir, 'synthetic.sqlite');
  const a = '桥梁长度10米。';
  const b = '桥梁长度20米。';
  const calls = [];
  const extractL1 = text => {
    calls.push(text);
    assert.ok(text === a || text === b);
    return [{ entity: '桥梁', attr: '长度', value: text === a ? '10米' : '20米', valueType: 'text' }];
  };
  const recalledIds = store => {
    const documents = store.dump().map(row => ({ ...row, source: { chapter: 1 } }));
    const result = new SearchIndex().addAll(documents).search('桥梁长度');
    return new Set(result.hits.map(hit => hit.id));
  };
  let store;
  try {
    store = open(file, { extractL1 });
    const first = store.put({ text: a, source: 'synthetic', documentId: 'synthetic-doc', chapter: 1 });
    const second = store.put({ text: b, source: 'synthetic', documentId: 'synthetic-doc', chapter: 1 });
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, true);
    assert.equal(store.put({ text: a, source: 'synthetic', documentId: 'synthetic-doc', chapter: 1 }).inserted, false);
    assert.equal(store.stats().memories, 2);
    assert.deepEqual(recalledIds(store), new Set([first.id, second.id]));
    store.close();
    store = open(file, { extractL1 });
    assert.equal(store.get(first.id).text, a);
    assert.equal(store.get(second.id).text, b);
    assert.deepEqual(recalledIds(store), new Set([first.id, second.id]));
    assert.deepEqual(new Set(store.bySourcePrefix('synthetic').map(row => row.text)), new Set([a, b]));
    assert.equal(store.stats().facts, 2);
    const conflict = store.scanConflictsV2();
    assert.equal(conflict.scanIncomplete, false);
    assert.equal(conflict.total, 1);
    const db = store.raw();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM segments WHERE ord = (SELECT rowid FROM memories WHERE id = ?)').run(first.id);
      assert.equal(db.prepare('DELETE FROM memories WHERE id = ?').run(first.id).changes, 1);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    store.rebuildFacts('synthetic deletion');
    assert.equal(store.get(first.id), null);
    assert.equal(store.get(second.id).text, b);
    assert.equal(store.stats().facts, 1);
    assert.equal(store.scanConflictsV2().total, 0);
    assert.deepEqual(recalledIds(store), new Set([second.id]));
    store.close();
    store = open(file, { extractL1 });
    assert.equal(store.get(first.id), null);
    assert.equal(store.get(second.id).text, b);
    assert.equal(store.stats().facts, 1);
    assert.deepEqual(recalledIds(store), new Set([second.id]));
    assert.ok(calls.length >= 5);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
