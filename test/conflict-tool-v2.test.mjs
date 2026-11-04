import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../src/index.mjs';

function fixture(dbPath) {
  const tools = new Map();
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide: () => () => {}, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath, vector: false });
  return { tools, app };
}

test('v2 executes and renders bounded candidate scans without changing v1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conflict-tool-v2-'));
  try {
    for (const path of [':memory:', join(dir, 'test.db')]) {
      const { tools, app } = fixture(path);
      try {
        const put = args => tools.get('memjudge_remember').execute(args);
        for (const n of [10, 20, 30]) await put({ text: `桥梁长度${n}米。`, documentId: 'doc', source: `s${n}` });
        const tool = tools.get('memjudge_conflicts_v2');
        const result = await tool.execute({ limit: 1 });
        assert.equal(result.total, 1);
        assert.equal(result.scanIncomplete, true);
        assert.equal(result.reason, 'conflicts');
        assert.equal(result.totalExact, false);
        assert.ok(Buffer.byteLength(JSON.stringify(tool.output.render({}, result))) <= 65536);
        assert.equal((await tools.get('memjudge_conflicts_v1').execute({})).total, 3);
        await assert.rejects(tool.execute({ limit: 51 }), /invalid conflict scan limit/);
        await assert.rejects(tool.execute({ unexpected: 1 }), /invalid conflict scan arguments/);
      } finally { app.dispose(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tool propagates scan and rollback faults with actual transaction state', async () => {
  const { tools, app } = fixture(':memory:');
  const prepare = DatabaseSync.prototype.prepare;
  const exec = DatabaseSync.prototype.exec;
  let connection;
  try {
    DatabaseSync.prototype.prepare = function(sql) {
      if (sql.includes('length(CAST(id AS BLOB))')) { connection = this; throw new Error('scan fault'); }
      return prepare.call(this, sql);
    };
    DatabaseSync.prototype.exec = function(sql) {
      if (this === connection && sql === 'ROLLBACK') { exec.call(this, sql); throw new Error('rollback fault'); }
      return exec.call(this, sql);
    };
    await assert.rejects(tools.get('memjudge_conflicts_v2').execute({}), error =>
      error instanceof AggregateError && error.errors.map(e => e.message).join(',') === 'scan fault,rollback fault');
    assert.ok(connection);
    assert.equal(connection.isTransaction, false);
    assert.equal(prepare.call(connection, 'SELECT 1 AS n').get().n, 1);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    DatabaseSync.prototype.exec = exec;
    app.dispose();
  }
});

test('double encoded emoji and escaped evidence is dropped as a whole', async () => {
  const { tools, app } = fixture(':memory:');
  try {
    const put = args => tools.get('memjudge_remember').execute(args);
    await put({ text: '桥梁长度10米。', source: '😀"\\'.repeat(5000), documentId: 'doc' });
    await put({ text: '桥梁长度20米。', source: 'b', documentId: 'doc' });
    const tool = tools.get('memjudge_conflicts_v2');
    const result = await tool.execute({});
    const size = Buffer.byteLength(JSON.stringify(tool.output.render({}, result)));
    assert.ok(size <= 65536);
    assert.equal(result.total, result.conflicts.length);
    if (result.outputTruncated) assert.equal(result.totalExact, false);
  } finally { app.dispose(); }
});

test('actual rendered envelope keeps a full group at 65536 and drops it at 65537', async () => {
  const prepare = DatabaseSync.prototype.prepare;
  let db;
  let app;
  try {
    DatabaseSync.prototype.prepare = function(sql) {
      db = this;
      return prepare.call(this, sql);
    };
    const fixtureResult = fixture(':memory:');
    app = fixtureResult.app;
    DatabaseSync.prototype.prepare = prepare;
    const tools = fixtureResult.tools;
    const put = args => tools.get('memjudge_remember').execute(args);
    await put({ text: '桥梁长度10米。', source: 'initial', documentId: 'doc' });
    await put({ text: '桥梁长度20米。', source: 'other', documentId: 'doc' });
    const id = db.prepare('SELECT id FROM memories WHERE text = ?').get('桥梁长度10米。').id;
    const insert = db.prepare('INSERT INTO memory_occurrences (memory_id, source, document_id) VALUES (?, ?, ?)');
    for (let i = 0; i < 17; i++) insert.run(id, `${i}:${'😀"\\'.repeat(300)}`, 'doc');
    insert.run(id, 'padding:', 'doc');
    const tool = tools.get('memjudge_conflicts_v2');
    const size = result => Buffer.byteLength(JSON.stringify(tool.output.render({}, result)), 'utf8');
    const baseline = await tool.execute({});
    assert.equal(baseline.conflicts.length, 1);
    assert.equal(baseline.outputTruncated, false);
    const padding = 65536 - size(baseline);
    assert.ok(padding > 0 && padding < 4096);
    const update = db.prepare('UPDATE memory_occurrences SET source = ? WHERE memory_id = ? AND source = ?');
    const source = `padding:${'x'.repeat(padding)}`;
    update.run(source, id, 'padding:');
    const exact = await tool.execute({});
    assert.equal(size(exact), 65536);
    assert.equal(exact.conflicts.length, 1);
    assert.equal(exact.total, 1);
    assert.equal(exact.totalExact, true);
    assert.equal(exact.outputTruncated, false);
    assert.equal(exact.scanIncomplete, false);
    const evidence = exact.conflicts[0].evidence.find(item => item.memoryId === id);
    assert.ok(evidence);
    assert.equal(evidence.positions.length, 19);
    const oversized = structuredClone(exact);
    const position = oversized.conflicts[0].evidence.find(item => item.memoryId === id).positions.find(item => item.source === source);
    position.source += 'x';
    assert.equal(size(oversized), 65537);
    update.run(`${source}x`, id, source);
    const truncated = await tool.execute({});
    assert.deepEqual(truncated.conflicts, []);
    assert.equal(truncated.total, 0);
    assert.equal(truncated.outputTruncated, true);
    assert.equal(truncated.totalExact, false);
    assert.equal(truncated.scanIncomplete, false);
    assert.ok(size(truncated) <= 65536);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    app?.dispose();
  }
});
