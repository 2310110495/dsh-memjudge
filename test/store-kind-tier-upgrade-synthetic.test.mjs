import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

function row(store, id) {
  return { ...store.raw().prepare('SELECT id, kind, tier FROM memories WHERE id = ?').get(id) };
}

for (const kind of ['person', 'promise']) {
  for (const explicitTier of [undefined, 5]) {
    test(`event to ${kind}, explicit tier ${explicitTier}`, () => {
      const store = open(':memory:');
      try {
        const text = `synthetic ${kind} ${explicitTier}`;
        const initial = store.put({ text, kind: 'event', tier: 4, source: 'first' });
        const upgrade = store.put({ text, kind, tier: explicitTier, source: 'second' });
        assert.equal(upgrade.id, initial.id);
        assert.equal(upgrade.inserted, false);
        assert.equal(upgrade.kind, kind);
        assert.equal(upgrade.tier, 1);
        assert.deepEqual(row(store, initial.id), { id: initial.id, kind, tier: 1 });
        const repeat = store.put({ text, kind, tier: explicitTier, source: 'second' });
        assert.equal(repeat.id, initial.id);
        assert.equal(repeat.inserted, false);
        assert.equal(repeat.kind, kind);
        assert.equal(repeat.tier, 1);
        assert.deepEqual(row(store, initial.id), { id: initial.id, kind, tier: 1 });
        assert.equal(store.raw().prepare('SELECT count(*) AS n FROM memories').get().n, 1);
        assert.equal(store.occurrencesV1(initial.id).length, 2);
      } finally { store.close(); }
    });
  }
}

test('explicit downgrade retains existing tier unless explicitly changed', () => {
  const store = open(':memory:');
  try {
    const initial = store.put({ text: 'synthetic downgrade', kind: 'person' });
    const downgrade = store.put({ text: 'synthetic downgrade', kind: 'event' });
    assert.equal(downgrade.kind, 'event');
    assert.equal(downgrade.tier, 1);
    assert.deepEqual(row(store, initial.id), { id: initial.id, kind: 'event', tier: 1 });
    const explicit = store.put({ text: 'synthetic downgrade', kind: 'event', tier: 5 });
    assert.equal(explicit.tier, 5);
    assert.deepEqual(row(store, initial.id), { id: initial.id, kind: 'event', tier: 5 });
  } finally { store.close(); }
});

test('occurrence failure rolls back kind and tier together', () => {
  const store = open(':memory:');
  try {
    const initial = store.put({ text: 'synthetic rollback', kind: 'event', tier: 4, source: 'first' });
    store.raw().exec("CREATE TRIGGER reject_occurrence BEFORE INSERT ON memory_occurrences BEGIN SELECT RAISE(ABORT, 'synthetic occurrence failure'); END");
    assert.throws(() => store.put({ text: 'synthetic rollback', kind: 'promise', source: 'second' }), /synthetic occurrence failure/);
    assert.deepEqual(row(store, initial.id), { id: initial.id, kind: 'event', tier: 4 });
    assert.equal(store.occurrencesV1(initial.id).length, 1);
    assert.equal(store.raw().isTransaction, false);
    store.raw().exec('DROP TRIGGER reject_occurrence');
    const retry = store.put({ text: 'synthetic rollback', kind: 'promise', source: 'second' });
    assert.equal(retry.tier, 1);
    assert.deepEqual(row(store, initial.id), { id: initial.id, kind: 'promise', tier: 1 });
  } finally { store.close(); }
});

for (const kind of ['person', 'promise']) {
  test(`${kind} omitted kind and explicit tier remains pinned`, () => {
    const store = open(':memory:');
    try {
      const text = `omitted ${kind}`;
      const initial = store.put({ text, kind });
      const result = store.put({ text, tier: 5 });
      assert.equal(result.kind, kind);
      assert.equal(result.tier, 1);
      assert.deepEqual(row(store, initial.id), { id: initial.id, kind, tier: 1 });
    } finally { store.close(); }
  });

  test(`${kind} dirty tier repaired and rollback on occurrence failure`, () => {
    const store = open(':memory:');
    try {
      const text = `dirty ${kind}`;
      const initial = store.put({ text, kind, source: 'first' });
      store.raw().prepare('UPDATE memories SET tier = 4 WHERE id = ?').run(initial.id);
      store.raw().exec("CREATE TRIGGER reject_dirty BEFORE INSERT ON memory_occurrences BEGIN SELECT RAISE(ABORT, 'dirty failure'); END");
      assert.throws(() => store.put({ text, kind, source: 'second' }), /dirty failure/);
      assert.deepEqual(row(store, initial.id), { id: initial.id, kind, tier: 4 });
      assert.equal(store.raw().isTransaction, false);
      assert.equal(store.occurrencesV1(initial.id).length, 1);
      store.raw().exec('DROP TRIGGER reject_dirty');
      const result = store.put({ text, kind, source: 'second' });
      assert.equal(result.tier, 1);
      assert.deepEqual(row(store, initial.id), { id: initial.id, kind, tier: 1 });
    } finally { store.close(); }
  });
}

test('invalid kind normalizes to event and explicit tier uses event rules', () => {
  const store = open(':memory:');
  try {
    const initial = store.put({ text: 'invalid kind', kind: 'promise' });
    const result = store.put({ text: 'invalid kind', kind: 'invalid', tier: 9 });
    assert.equal(result.kind, 'event');
    assert.equal(result.tier, 5);
    assert.deepEqual(row(store, initial.id), { id: initial.id, kind: 'event', tier: 5 });
    const unchanged = store.put({ text: 'invalid kind', tier: 'invalid' });
    assert.equal(unchanged.tier, 5);
    assert.deepEqual(row(store, initial.id), { id: initial.id, kind: 'event', tier: 5 });
  } finally { store.close(); }
});

for (const [dirty, expected] of [[9, 5], [0, 1], [2.9, 2], ['invalid', 3], ['', 1], [' ', 1], [4, 4]]) {
  test(`duplicate event normalizes stored tier ${JSON.stringify(dirty)} without rewriting`, () => {
    const store = open(':memory:');
    try {
      const text = `stored tier ${JSON.stringify(dirty)}`;
      const initial = store.put({ text, kind: 'event' });
      store.raw().prepare('UPDATE memories SET tier = ? WHERE id = ?').run(dirty, initial.id);
      const before = row(store, initial.id);
      const result = store.put({ text });
      assert.equal(result.tier, expected);
      assert.equal(store.list().find(item => item.id === initial.id).tier, expected);
      assert.deepEqual(row(store, initial.id), before);
    } finally { store.close(); }
  });
}

for (const [kind, expectedKind] of [[null, 'person'], ['', 'person'], [' ', 'event']]) {
  test(`duplicate kind ${JSON.stringify(kind)} preserves existing classification semantics`, () => {
    const store = open(':memory:');
    try {
      const text = `kind ${JSON.stringify(kind)}`;
      const initial = store.put({ text, kind: 'person' });
      const result = store.put({ text, kind });
      assert.equal(result.kind, expectedKind);
      assert.equal(result.tier, 1);
      assert.deepEqual(row(store, initial.id), { id: initial.id, kind: expectedKind, tier: 1 });
    } finally { store.close(); }
  });
}

for (const tier of [null, '', 'invalid']) {
  test(`duplicate event tier ${JSON.stringify(tier)} is treated as omitted`, () => {
    const store = open(':memory:');
    try {
      const initial = store.put({ text: 'omitted tier', kind: 'event', tier: 4 });
      assert.equal(store.put({ text: 'omitted tier', tier }).tier, 4);
      assert.equal(row(store, initial.id).tier, 4);
    } finally { store.close(); }
  });
}

test('duplicate event whitespace tier is explicit and normalizes to 1', () => {
  const store = open(':memory:');
  try {
    const initial = store.put({ text: 'whitespace tier', kind: 'event', tier: 4 });
    assert.equal(store.put({ text: 'whitespace tier', tier: ' ' }).tier, 1);
    assert.equal(row(store, initial.id).tier, 1);
  } finally { store.close(); }
});

for (const kind of ['person', 'promise']) {
  for (const [label, expression, originalType] of [
    ['blob-one', "x'01'", 'blob'],
    ['blob-ascii', "x'31'", 'blob'],
    ['text', "'invalid'", 'text'],
    ['real', '1.5', 'real'],
    ['integer', '4', 'integer'],
    ['numeric-text-affinity', "'1'", 'integer'],
  ]) {
    test(`${kind} repairs ${label} to SQLite integer one`, () => {
      const store = open(':memory:');
      try {
        const text = `physical ${kind} ${label}`;
        const initial = store.put({ text, kind });
        store.raw().prepare(`UPDATE memories SET tier = ${expression} WHERE id = ?`).run(initial.id);
        const inspect = store.raw().prepare('SELECT tier, typeof(tier) AS storage_type FROM memories WHERE id = ?');
        assert.equal(inspect.get(initial.id).storage_type, originalType);
        const result = store.put({ text });
        assert.equal(result.tier, 1);
        assert.deepEqual({ ...inspect.get(initial.id) }, { tier: 1, storage_type: 'integer' });
      } finally { store.close(); }
    });
  }
}

test('duplicate event preserves blob tier without an explicit tier', () => {
  const store = open(':memory:');
  try {
    const initial = store.put({ text: 'event blob', kind: 'event' });
    store.raw().prepare("UPDATE memories SET tier = x'01' WHERE id = ?").run(initial.id);
    const inspect = store.raw().prepare('SELECT tier, typeof(tier) AS storage_type FROM memories WHERE id = ?');
    const before = inspect.get(initial.id);
    assert.equal(before.storage_type, 'blob');
    assert.equal(store.put({ text: 'event blob' }).tier, 1);
    assert.deepEqual(inspect.get(initial.id), before);
  } finally { store.close(); }
});
