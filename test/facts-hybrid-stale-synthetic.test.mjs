import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/store.mjs';

function gate() {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  return { release, extractHybrid: async entries => {
    await wait;
    return { source: 'llm', perEntry: entries.map(e => [{ attr: '标记', value: e.text }]) };
  } };
}
const a = { id: 'a', text: '船长是张三。' };
const b = { id: 'b', text: '货物重量为三吨。' };
const extractL1 = text => [{ attr: '合成标记', value: text }];

test('put publishes after commit and rollback preserves llm facts', async () => {
  const s = open(':memory:', { extractL1 });
  const db = s.raw(), exec = db.exec;
  let commits = 0;
  try {
    s.put(a);
    await s.rebuildFactsHybrid({ extractHybrid: async () => ({ source: 'llm', perEntry: [[{ attr: '独有标记', value: '甲' }]] }) });
    const before = s.allFacts();
    db.exec = function (sql) {
      if (sql === 'COMMIT') { commits++; throw new Error('synthetic commit failure'); }
      return exec.call(this, sql);
    };
    assert.throws(() => s.put(b), /synthetic commit failure/);
    assert.equal(commits, 1);
    assert.equal(db.isTransaction, false);
    assert.equal(s.get('b'), null);
    assert.deepEqual(s.allFacts(), before);
    assert.equal(s.get('a').facts[0].attr, '独有标记');
    db.exec = function (sql) {
      if (sql === 'COMMIT') commits++;
      return exec.call(this, sql);
    };
    assert.equal(s.put(b).inserted, true);
    assert.equal(commits, 2);
    assert.equal(s.put(b).inserted, false);
    assert.equal(commits, 3);
    assert.equal(s.get('a').facts[0].attr, '独有标记');
    assert.ok(s.get('b').facts.length);
  } finally { db.exec = exec; s.close(); }
});

test('commit then throw faults the store', async () => {
  let fault;
  const s = open(':memory:', { extractL1, onFault: error => { fault = error; } });
  const db = s.raw(), exec = db.exec;
  let commits = 0;
  try {
    s.put(a);
    await s.rebuildFactsHybrid({ extractHybrid: async () => ({ source: 'llm', perEntry: [[{ attr: '独有标记', value: '甲' }]] }) });
    db.exec = function (sql) {
      if (sql === 'COMMIT') {
        commits++;
        exec.call(this, sql);
        throw new Error('synthetic commit after');
      }
      return exec.call(this, sql);
    };
    assert.throws(() => s.put(b), /synthetic commit after/);
    assert.equal(commits, 1);
    assert.ok(fault);
    assert.throws(() => s.get('a'), /store fault/);
    assert.throws(() => s.allFacts(), /store fault/);
  } finally { db.exec = exec; s.close(); }
});

test('put leaves a caller-owned transaction untouched', async () => {
  const s = open(':memory:', { extractL1 }), db = s.raw();
  try {
    s.put(a);
    db.exec('BEGIN');
    assert.throws(() => s.put(b), /idle connection/);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); s.close(); }
});

test('put during extraction preserves new facts and rejects stale result', async () => {
  const s = open(':memory:', { extractL1 });
  try {
    s.put(a); const g = gate(); const p = s.rebuildFactsHybrid(g);
    s.put(b); const facts = s.get('b').facts; assert.ok(facts.length);
    g.release(); await assert.rejects(p, /snapshot stale/);
    assert.deepEqual(s.get('b').facts, facts);
  } finally { s.close(); }
});

test('later request wins regardless of completion order', async () => {
  const s = open(':memory:', { extractL1 });
  try {
    s.put(a); const x = gate(), y = gate();
    const p = s.rebuildFactsHybrid(x), q = s.rebuildFactsHybrid(y);
    y.release(); await q; x.release(); await assert.rejects(p, /snapshot stale/);
    assert.equal(s.get('a').facts[0].attr, '标记');
  } finally { s.close(); }
});

test('same-connection delete and rowid reuse rejects stale snapshot', async () => {
  const s = open(':memory:', { extractL1 });
  try {
    s.put(a); const g = gate(); const p = s.rebuildFactsHybrid(g);
    const db = s.raw(); s.dropFactsOf('a');
    db.prepare('DELETE FROM segments WHERE ord = (SELECT rowid FROM memories WHERE id=?)').run('a');
    db.prepare('DELETE FROM memories WHERE id=?').run('a');
    s.put(b); const facts = s.get('b').facts;
    g.release(); await assert.rejects(p, /snapshot stale/);
    assert.deepEqual(s.get('b').facts, facts);
  } finally { s.close(); }
});

test('external connection mutation rejects stale snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hybrid-synthetic-'));
  let s;
  try {
    s = open(join(dir, 'fixture.sqlite'), { extractL1 });
    s.put(a); const g = gate(); const p = s.rebuildFactsHybrid(g);
    const db = new DatabaseSync(join(dir, 'fixture.sqlite'));
    try { db.prepare('UPDATE memories SET text=? WHERE id=?').run('changed', 'a'); } finally { db.close(); }
    g.release(); await assert.rejects(p, /snapshot stale/);
  } finally { try { s?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } }
});

test('close while extracting rejects and does not publish', async () => {
  const s = open(':memory:', { extractL1 }); s.put(a); const g = gate();
  const p = s.rebuildFactsHybrid(g); s.close(); g.release();
  await assert.rejects(p, /已关闭/);
});

test('malformed result and extraction errors leave old facts intact', async () => {
  const s = open(':memory:', { extractL1 });
  try {
    s.put(a); const before = s.get('a').facts;
    await assert.rejects(s.rebuildFactsHybrid({ extractHybrid: async () => ({ source: 'llm', perEntry: [] }) }), /invalid extraction/);
    await assert.rejects(s.rebuildFactsHybrid({ extractHybrid: async () => { throw new Error('synthetic failure'); } }), /synthetic failure/);
    assert.deepEqual(s.get('a').facts, before);
  } finally { s.close(); }
});
