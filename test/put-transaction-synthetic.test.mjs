import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

const extractL1 = () => [{ attr: 'synthetic', value: 'value' }];
const entry = { id: 'one', text: 'synthetic entry' };

for (const duplicate of [false, true]) {
  for (const mode of ['begin-after', 'begin-silent', 'commit-silent', 'commit-after', 'rollback-throws', 'rollback-after', 'rollback-silent']) {
    test(`${duplicate ? 'duplicate' : 'insert'} ${mode}`, () => {
      let notification;
      const store = open(':memory:', { extractL1, onFault: error => { notification = error; } });
      const db = store.raw();
      const original = db.exec;
      try {
        if (duplicate) store.put(entry);
        const before = db.prepare('SELECT count(*) AS n FROM memory_occurrences').get().n;
        db.exec = function(sql) {
          if (sql === 'BEGIN IMMEDIATE' && mode === 'begin-after') {
            original.call(this, sql);
            throw new Error('synthetic begin after');
          }
          if (sql === 'BEGIN IMMEDIATE' && mode === 'begin-silent') return;
          if (sql === 'COMMIT') {
            if (mode === 'commit-after') {
              original.call(this, sql);
              throw new Error('synthetic commit after');
            }
            if (mode === 'commit-silent' || mode.startsWith('rollback-')) return;
          }
          if (sql === 'ROLLBACK') {
            if (mode === 'rollback-throws') throw new Error('synthetic rollback failure');
            if (mode === 'rollback-after') {
              original.call(this, sql);
              throw new Error('synthetic rollback after');
            }
            if (mode === 'rollback-silent') return;
          }
          return original.call(this, sql);
        };
        assert.throws(() => store.put(duplicate ? { ...entry, kind: 'person' } : entry));
        const faulted = mode === 'commit-after' || mode.startsWith('rollback-');
        if (faulted) {
          assert.ok(notification);
          assert.throws(() => store.get(entry.id), /store fault/);
          if (mode.startsWith('rollback-')) {
            assert.ok(notification instanceof AggregateError);
            assert.match(notification.errors[0].message, /commit left/);
          }
        } else {
          assert.equal(notification, undefined);
          assert.equal(db.isTransaction, false);
          assert.equal(db.prepare('SELECT count(*) AS n FROM memory_occurrences').get().n, before);
          assert.equal(store.get(entry.id)?.facts.length ?? 0, duplicate ? 1 : 0);
          if (duplicate) assert.equal(store.get(entry.id).kind, 'event');
          db.exec = original;
          assert.equal(store.put(entry).inserted, !duplicate);
        }
      } finally {
        db.exec = original;
        if (db.isTransaction) db.exec('ROLLBACK');
        store.close();
      }
    });
  }
}

test('extractor failure rolls back without publishing facts', () => {
  const store = open(':memory:', { extractL1: () => { throw new Error('synthetic extraction failure'); } });
  try {
    assert.throws(() => store.put(entry), /synthetic extraction failure/);
    assert.equal(store.raw().isTransaction, false);
    assert.equal(store.get(entry.id), null);
    assert.deepEqual(store.allFacts(), []);
  } finally { store.close(); }
});
