import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';
import { createContentSnapshotView } from '../src/content-snapshot-view.mjs';

test('memory view has a single source and detects local generation', () => {
  const store = open(':memory:');
  try {
    store.put({ text: '港口人数为27人。' });
    let gen = 0;
    const view = createContentSnapshotView(store, () => gen);
    assert.match(view.fullText(), /27/);
    assert.ok(view.search('港口人数').hits.some(h => h.text.includes('27')));
    assert.ok(view.allFacts().some(f => String(f.value).includes('27')));
    view.allFacts()[0].value = 'mutated';
    assert.ok(view.allFacts().some(f => String(f.value).includes('27')));
    store.raw().exec('BEGIN');
    assert.throws(() => view.assertCurrent(), /idle connection/);
    store.raw().exec('ROLLBACK');
    store.put({ text: '仓库人数为31人。' });
    view.assertCurrent(); // SQLite does not advance data_version for this connection.
    gen++;
    assert.throws(() => view.assertCurrent(), /stale/);
    assert.throws(() => createContentSnapshotView(store, () => gen, { snapshot: { maxRows: 0 } }), /limit exceeded/);
    assert.equal(store.dump().length, 2);
  } finally { store.close(); }
});

for (const mode of ['WAL', 'DELETE']) test(`external changes invalidate ${mode} view`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-view-'));
  const path = join(dir, 'fixture.db');
  const store = open(path);
  const other = new DatabaseSync(path);
  try {
    store.raw().exec(`PRAGMA journal_mode=${mode}`);
    const item = store.put({ text: '港口人数为27人。' });
    const old = createContentSnapshotView(store, () => 0);
    other.prepare('UPDATE memories SET text=? WHERE id=?').run('港口人数为31人。', item.id);
    assert.throws(() => old.assertCurrent(), /stale/);
    const current = createContentSnapshotView(store, () => 0);
    assert.match(current.fullText(), /31/);
    assert.ok(current.allFacts().some(f => String(f.value).includes('31')));
    assert.ok(current.search('港口人数').hits.some(h => h.text.includes('31')));
    assert.ok(store.allFacts().some(f => String(f.value).includes('27')));
    const isolated = createContentSnapshotView({ raw: () => store.raw(), contentSnapshot: (...args) => store.contentSnapshot(...args), allFacts: () => { throw new Error('unexpected fallback'); } }, () => 0);
    assert.ok(isolated.allFacts().some(f => String(f.value).includes('31')));
    other.prepare('DELETE FROM memories WHERE id=?').run(item.id);
    assert.throws(() => current.assertCurrent(), /stale/);
    assert.equal(createContentSnapshotView(store, () => 0).fullText(), '');
  } finally { other.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('generation change during build prevents publication', () => {
  const store = open(':memory:');
  try {
    let calls = 0;
    assert.throws(() => createContentSnapshotView(store, () => calls++), /stale/);
  } finally { store.close(); }
});
