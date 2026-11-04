import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/store.mjs';
import { adaptContentSnapshot } from '../src/content-snapshot-adapter.mjs';
import { toDoc } from '../src/index.mjs';

for (const disk of [false, true]) test(`adapter matches dump: disk=${disk}`, () => {
  const dir = disk ? mkdtempSync(join(tmpdir(), 'memjudge-adapter-')) : null;
  const store = open(disk ? join(dir, 'fixture.db') : ':memory:');
  try {
    assert.deepEqual(adaptContentSnapshot(store.contentSnapshot()).memories, []);
    const a = store.put({ text: '港口人数为27人。😀\0甲', chapter: 5, para: 2, importance: 0 });
    const b = store.put({ text: '港口人数为31人。', source: 'doc:B', supersedes: [a.id] });
    store.put({ text: '港口人数为35人。', supersedes: [b.id, a.id] });
    const snapshot = store.contentSnapshot();
    const result = adaptContentSnapshot(snapshot);
    assert.deepEqual(result.memories, store.dump());
    assert.deepEqual(result.docs, store.dump().map(toDoc));
    assert.deepEqual(result.docs[0], {
      id: a.id, text: result.memories[0].text, source: { chapter: 5, para: 2 },
      importance: result.memories[0].importance, accessCount: result.memories[0].accessCount,
      createdAt: result.memories[0].createdAt, lastAccessed: result.memories[0].lastAccessed,
      supersededBy: result.memories[0].supersededBy,
    });
    const [key, entries] = snapshot.facts.slot.entries().next().value;
    assert.deepEqual(result.factsSlot(key), entries);
    result.factsSlot(key)[0].fact.value = 'changed';
    result.memories[0].facts[0].value = 'changed';
    assert.deepEqual(result.factsSlot(key), entries);
    assert.notEqual(snapshot.facts.byOrd.get(snapshot.rows[0].ord)[0].value, 'changed');
    assert.throws(() => store.contentSnapshot({ maxRows: 0 }), /limit exceeded/);
    const malformed = { ...snapshot, rows: snapshot.rows.map((r, i) => i ? r : { ...r, supersedes: '{' }) };
    assert.throws(() => adaptContentSnapshot(malformed), SyntaxError);
    assert.throws(() => adaptContentSnapshot(null), TypeError);
  } finally { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); }
});

test('actual toDoc equivalence for source, zero values, revisions and ordering', () => {
  const store = open(':memory:');
  try {
    const a = store.put({ text: '人数为27人。', chapter: 5, para: 2 });
    const b = store.put({ text: '人数为31人。', supersedes: [a.id] });
    const c = store.put({ text: '人数为35人。', supersedes: [a.id, b.id] });
    const db = store.raw();
    const update = db.prepare('UPDATE memories SET source=?, importance=0, access_count=0, created_at=0, last_accessed=0 WHERE id=?');
    for (const source of ['', '{}', '{"chapter":0,"para":0}', '{"chapter":"8","para":"0"}', '{broken', 'doc:B', null]) {
      update.run(source, a.id);
      const result = adaptContentSnapshot(store.contentSnapshot());
      const dump = store.dump();
      assert.deepEqual(result.memories, dump);
      assert.deepEqual(result.docs, dump.map(toDoc), `source=${source}`);
      assert.deepEqual(result.memories.find(x => x.id === a.id).supersededBy, [b.id, c.id]);
      for (const memory of result.memories) {
        assert.deepEqual(memory.facts, [...memory.facts].sort((x, y) => x.at - y.at));
      }
    }
  } finally { store.close(); }
});
