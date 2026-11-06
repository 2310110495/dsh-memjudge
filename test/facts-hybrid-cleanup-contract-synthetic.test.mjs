import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

const entry = { id: 'synthetic', text: '船长是张三。' };
const valid = { source: 'llm', perEntry: [[{ attr: '标记', value: '张三' }]] };
const extract = result => ({ extractHybrid: async () => result });

test('malformed facts and sources preserve the previous snapshot', async () => {
  const s = open(':memory:');
  try {
    s.put(entry);
    const before = s.get(entry.id).facts;
    const bad = [{ attr: '标记' }, { attr: '', value: 'x' }, { attr: 'x', value: 2 },
      { attr: 'x', value: 'y', entity: {} }, { attr: 'x', value: 'y', at: -1 },
      { attr: 'x', value: 'y', valueType: 'unknown' }, null];
    for (const fact of bad) {
      await assert.rejects(s.rebuildFactsHybrid(extract({ source: 'llm', perEntry: [[fact]] })), /invalid extraction/);
      assert.deepEqual(s.get(entry.id).facts, before);
    }
    for (const result of [null, {}, { source: 'unknown' }]) {
      await assert.rejects(s.rebuildFactsHybrid(extract(result)), /invalid extraction/);
      assert.deepEqual(s.get(entry.id).facts, before);
    }
    await s.rebuildFactsHybrid(extract(valid));
    assert.equal(s.get(entry.id).facts[0].attr, '标记');
  } finally { s.close(); }
});

test('rejected busy request does not supersede an accepted request', async () => {
  const s = open(':memory:');
  try {
    s.put(entry);
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const first = s.rebuildFactsHybrid({ extractHybrid: async () => { await wait; return valid; } });
    const db = s.raw();
    db.exec('BEGIN');
    await assert.rejects(s.rebuildFactsHybrid(extract(valid)), /idle connection/);
    db.exec('ROLLBACK');
    release();
    await first;
    assert.equal(s.get(entry.id).facts[0].attr, '标记');
  } finally { s.close(); }
});

for (const mode of ['silent', 'throws', 'stale-silent', 'stale-throws']) {
  test(`cleanup ${mode} faults without publishing and retains causes`, async () => {
    let notified;
    const s = open(':memory:', { onFault: error => { notified = error; } });
    s.put(entry);
    const db = s.raw(), original = db.exec;
    const before = s.get(entry.id).facts;
    db.exec = function(sql) {
      if (sql === 'ROLLBACK') {
        if (mode.endsWith('silent')) return;
        throw new Error('synthetic rollback failure');
      }
      return original.call(this, sql);
    };
    try {
      let release;
      const wait = new Promise(resolve => { release = resolve; });
      const pending = s.rebuildFactsHybrid({ extractHybrid: async () => { await wait; return valid; } });
      if (mode.startsWith('stale')) s.put({ id: 'other', text: '货物重量为三吨。' });
      release();
      let error;
      try { await pending; assert.fail('expected rejection'); } catch (e) { error = e; }
      assert.equal(error, notified);
      if (mode.startsWith('stale')) {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /snapshot stale/);
        assert.match(error.errors[1].message, /cleanup left|rollback failure/);
      } else assert.match(error.message, /cleanup left|rollback failure/);
      assert.equal(db.isTransaction, true);
      assert.throws(() => s.get(entry.id), /store fault/);
      assert.ok(before.length);
    } finally {
      db.exec = original;
      if (db.isTransaction) db.exec('ROLLBACK');
      s.close();
    }
  });
}

for (const source of ['rules', 'rules-fallback']) {
  test(`${source} keeps old facts but still validates under a write lock`, async () => {
    const s = open(':memory:');
    try {
      s.put(entry);
      const db = s.raw(), original = db.exec, statements = [];
      const before = s.get(entry.id).facts;
      db.exec = function(sql) { statements.push(sql); return original.call(this, sql); };
      try {
        const result = await s.rebuildFactsHybrid(extract({ source }));
        assert.equal(result.source, source);
        assert.deepEqual(s.get(entry.id).facts, before);
        assert.ok(statements.includes('BEGIN IMMEDIATE'));
        assert.ok(statements.includes('ROLLBACK'));
      } finally { db.exec = original; }
    } finally { s.close(); }
  });
}
