import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scanConflictsV2, scanConflictReaderV2, jsonBytes } from '../src/conflict-scan-v2.mjs';
import { openConflictSnapshot } from '../src/conflict-snapshot.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'conflict-v2-')), file = join(dir, 'test.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE memories(id TEXT PRIMARY KEY, text TEXT NOT NULL);
    CREATE TABLE memory_occurrences(memory_id TEXT, source TEXT, document_id TEXT, chapter INTEGER, para INTEGER);
    CREATE UNIQUE INDEX ux_memory_occurrences_position ON memory_occurrences
    (memory_id, source IS NULL, coalesce(source, ''), document_id IS NULL,
     coalesce(document_id, ''), chapter IS NULL, coalesce(chapter, 0), para IS NULL, coalesce(para, 0));
    INSERT INTO memories VALUES ('a','桥梁长度10米。'),('b','桥梁长度20米。'),('c','桥梁长度30米。');
    INSERT INTO memory_occurrences VALUES ('a','s1','doc',1,1),('a','s2','doc',1,2),
     ('b','s3','doc',1,3),('c','s4',NULL,1,4);`);
  return { db, file, cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('cross-page documents preserve positions and isolate unknown identities', () => {
  const f = fixture();
  try {
    const result = scanConflictsV2(f.file);
    assert.equal(result.total, 1);
    assert.equal(result.totalExact, true);
    assert.equal(result.conflicts[0].documentId, 'doc');
    assert.equal(result.conflicts[0].evidence[0].positions.length, 2);
    assert.deepEqual(result.conflicts[0].values, ['10米','20米']);
  } finally { f.cleanup(); }
});

test('all budgets report incomplete instead of inventing completeness', () => {
  const f = fixture();
  try {
    for (const [options, reason] of [
      [{ snapshot: { records: 1 } }, 'snapshot:records'],
      [{ snapshot: { occurrences: 1 } }, 'snapshot:occurrences'],
      [{ snapshot: { recordTextBytes: 1 } }, 'snapshot:recordTextBytes'],
      [{ limits: { sentences: 0 } }, 'sentences'],
      [{ limits: { sentenceBytes: 1 } }, 'sentenceBytes'],
      [{ limits: { quantities: 0 } }, 'quantities'],
      [{ limits: { entries: 0 } }, 'entries'],
      [{ limits: { comparisons: 0 } }, 'comparisons'],
      [{ limits: { conflicts: 0 } }, 'conflicts'],
    ]) {
      const result = scanConflictsV2(f.file, options);
      assert.equal(result.reason, reason);
      assert.equal(result.scanIncomplete, true);
      assert.equal(result.totalExact, false);
      f.db.exec('BEGIN IMMEDIATE; ROLLBACK');
    }
    assert.equal(scanConflictsV2(f.file, { limits: { sentences: 3, comparisons: 1, conflicts: 1 } }).totalExact, true);
    assert.throws(() => scanConflictsV2(f.file, { limits: { sentences: -1 } }), /invalid limit/);
    assert.throws(() => scanConflictsV2(f.file, { snapshot: { records: 1001 } }), /invalid snapshot limit/);
  } finally { f.cleanup(); }
});

test('invalid document identity is reported and transaction released', () => {
  const f = fixture();
  try {
    f.db.exec("UPDATE memory_occurrences SET document_id = x'00' WHERE source = 's1'");
    const result = scanConflictsV2(f.file);
    assert.equal(result.reason, 'invalidPosition');
    assert.equal(result.totalExact, false);
    f.db.exec("INSERT INTO memories VALUES ('d','value')");
  } finally { f.cleanup(); }
});

test('unknown identity pairs within one text and oversized text is omitted whole', () => {
  const f = fixture();
  try {
    f.db.exec("UPDATE memories SET text='桥梁长度30米。桥梁长度40米。' WHERE id='c'");
    const result = scanConflictsV2(f.file);
    assert.equal(result.total, 2);
    const unknown = result.conflicts.find(c => c.documentId === null);
    assert.deepEqual(unknown.evidence.map(e => e.memoryId), ['c', 'c']);
    f.db.exec("UPDATE memories SET text=replace(hex(zeroblob(70000)),'00','x') WHERE id='c'");
    const limited = scanConflictsV2(f.file);
    assert.equal(limited.reason, 'snapshot:recordTextBytes');
    assert.equal(limited.totalExact, false);
  } finally { f.cleanup(); }
});

test('read exception closes snapshot', () => {
  const f = fixture(), prepare = DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare = function(sql) {
      const stmt = prepare.call(this, sql);
      return sql.startsWith('SELECT id, text') ? { get() { throw new Error('injected'); } } : stmt;
    };
    assert.throws(() => scanConflictsV2(f.file), /injected/);
    f.db.exec("INSERT INTO memories VALUES ('d','value')");
  } finally { DatabaseSync.prototype.prepare = prepare; f.cleanup(); }
});

test('internal reader matches file wrapper across pages and budgets', () => {
  const f = fixture();
  const defaults = { sentences: 10000, sentenceBytes: 16384, quantities: 10000,
    comparisons: 100000, entries: 20000, conflicts: 1000, resultBytes: 65536 };
  try {
    for (const [snapshot, limits] of [
      [{}, {}], [{ records: 1 }, {}], [{}, { comparisons: 0 }],
      [{}, { resultBytes: 512 }],
    ]) {
      const expected = scanConflictsV2(f.file, { snapshot, limits });
      const reader = openConflictSnapshot(f.file, snapshot);
      try {
        assert.equal(JSON.stringify(scanConflictReaderV2(reader, { ...defaults, ...limits })), JSON.stringify(expected));
      } finally { reader.close(); }
    }
    f.db.exec('BEGIN IMMEDIATE; ROLLBACK');
  } finally { f.cleanup(); }
});

test('read and cleanup failures retain both errors and release lock', () => {
  const f = fixture(), prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close;
  let closes = 0;
  try {
    DatabaseSync.prototype.prepare = function(sql) {
      const stmt = prepare.call(this, sql);
      return sql.startsWith('SELECT id, text') ? { get() { throw new Error('read fault'); } } : stmt;
    };
    DatabaseSync.prototype.close = function() {
      closes++;
      close.call(this);
      throw new Error('cleanup fault');
    };
    assert.throws(() => scanConflictsV2(f.file), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map(e => e.message), ['read fault', 'cleanup fault']);
      assert.equal(error.cause.message, 'read fault');
      return true;
    });
    assert.equal(closes, 1);
    f.db.exec('BEGIN IMMEDIATE; ROLLBACK');
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    DatabaseSync.prototype.close = close;
    f.cleanup();
  }
});

test('serialized result is bounded with repeated positions', () => {
  const f = fixture();
  try {
    f.db.exec('DELETE FROM memory_occurrences; DELETE FROM memories');
    const memory = f.db.prepare('INSERT INTO memories VALUES (?, ?)');
    const pos = f.db.prepare('INSERT INTO memory_occurrences VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 46; i++) {
      const id = `id${i}`;
      memory.run(id, `桥梁长度${i}米。`);
      for (let j = 0; j < 100; j++) pos.run(id, `s${j}`, 'doc', 1, j);
    }
    const result = scanConflictsV2(f.file);
    assert.equal(result.reason, 'resultBytes');
    assert.equal(result.outputTruncated, true);
    assert.equal(result.totalExact, false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
    f.db.exec('BEGIN IMMEDIATE; ROLLBACK');
    assert.throws(() => scanConflictsV2(f.file, { limits: { resultBytes: 1 } }), /minimum envelope/);
    const tiny = scanConflictsV2(f.file, { limits: { resultBytes: 512 } });
    assert.equal(tiny.outputTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(tiny)) <= 512);
  } finally { f.cleanup(); }
});

test('quantity budget and exact original UTF-16 sentence offsets', () => {
  const f = fixture();
  try {
    const first = '  😀 "桥梁"长度10米。';
    const second = '\t😀 "桥梁"长度20米。';
    f.db.prepare('UPDATE memories SET text=? WHERE id=?').run(first, 'a');
    f.db.prepare('UPDATE memories SET text=? WHERE id=?').run(second, 'b');
    const result = scanConflictsV2(f.file);
    for (const evidence of result.conflicts[0].evidence) {
      const source = evidence.memoryId === 'a' ? first : second;
      assert.equal(source.slice(evidence.start, evidence.end), evidence.text);
      assert.equal(evidence.text, source);
    }
    f.db.prepare('UPDATE memories SET text=? WHERE id=?').run('桥梁' + '1米'.repeat(3000), 'a');
    assert.equal(scanConflictsV2(f.file, { limits: { quantities: 0 } }).reason, 'quantities');
    assert.equal(scanConflictsV2(f.file, { limits: { quantities: 1 } }).reason, 'quantities');
  } finally { f.cleanup(); }
});

test('exact quantity limit completes only when no further match exists', () => {
  const f = fixture();
  try {
    f.db.exec("DELETE FROM memory_occurrences; DELETE FROM memories; INSERT INTO memories VALUES ('a','桥梁1米2米3米。')");
    assert.equal(scanConflictsV2(f.file, { limits: { quantities: 3 } }).scanIncomplete, false);
    const limited = scanConflictsV2(f.file, { limits: { quantities: 2 } });
    assert.equal(limited.reason, 'quantities');
    assert.equal(limited.outputTruncated, false);
  } finally { f.cleanup(); }
});

test('escaped candidate fits exactly and is never stringified during scanning', () => {
  const f = fixture(), original = JSON.stringify;
  try {
    f.db.prepare('UPDATE memories SET text=? WHERE id=?').run('  😀 "桥梁"\\长度10米。', 'a');
    f.db.prepare('UPDATE memories SET text=? WHERE id=?').run('\t😀 "桥梁"\\长度20米。', 'b');
    f.db.prepare('UPDATE memory_occurrences SET source=? WHERE source=?').run('引号"反斜杠\\\n', 's1');
    const baseline = scanConflictsV2(f.file);
    const exact = Buffer.byteLength(original(baseline), 'utf8');
    JSON.stringify = () => { throw new Error('unexpected serialization'); };
    const fit = scanConflictsV2(f.file, { limits: { resultBytes: exact } });
    const short = scanConflictsV2(f.file, { limits: { resultBytes: exact - 1 } });
    assert.equal(fit.total, 1);
    assert.equal(fit.scanIncomplete, false);
    assert.equal(short.total, 0);
    assert.equal(short.reason, 'resultBytes');
    assert.equal(short.scanIncomplete, true);
    assert.equal(short.outputTruncated, true);
    assert.ok(Buffer.byteLength(original(fit), 'utf8') <= exact);
    assert.ok(Buffer.byteLength(original(short), 'utf8') <= exact - 1);
  } finally { JSON.stringify = original; f.cleanup(); }
});

test('counter matches native JSON for escapes and isolated surrogates', () => {
  const values = ['', '\ud800', '\udfff', '😀\u2028\u2029"\\\b\t\n\f\r\u0000\u001f',
    { a: ['\ud800x\udfff', 0, 10, null, true, false], b: '中文' }];
  for (const value of values) {
    const actual = Buffer.byteLength(JSON.stringify(value), 'utf8');
    assert.equal(jsonBytes(value, actual), actual);
    assert.ok(jsonBytes(value, actual - 1) > actual - 1);
  }
});

test('empty output and terminal metadata growth use actual byte budget', () => {
  const f = fixture();
  try {
    f.db.exec('DELETE FROM memory_occurrences; DELETE FROM memories');
    const empty = scanConflictsV2(f.file);
    const bytes = Buffer.byteLength(JSON.stringify(empty));
    assert.deepEqual(scanConflictsV2(f.file, { limits: { resultBytes: bytes } }), empty);
    assert.throws(() => scanConflictsV2(f.file, { limits: { resultBytes: bytes - 1 } }), /minimum envelope/);
    f.db.exec("INSERT INTO memories VALUES ('a','桥梁1米2米3米4米5米6米7米8米9米10米11米12米。')");
    const all = scanConflictsV2(f.file);
    assert.ok(all.comparisons >= 10);
    const exact = Buffer.byteLength(JSON.stringify(all));
    assert.deepEqual(scanConflictsV2(f.file, { limits: { resultBytes: exact } }), all);
    const reduced = scanConflictsV2(f.file, { limits: { resultBytes: exact - 1 } });
    assert.ok(Buffer.byteLength(JSON.stringify(reduced)) <= exact - 1);
    assert.equal(reduced.outputTruncated, true);
    f.db.exec('BEGIN IMMEDIATE; ROLLBACK');
  } finally { f.cleanup(); }
});

test('comparison digit growth evicts a whole conflict only at terminal accounting', () => {
  const f = fixture();
  try {
    f.db.exec("DELETE FROM memory_occurrences; DELETE FROM memories; INSERT INTO memories VALUES ('a','桥梁1米2米2米2米2米。')");
    const baseline = scanConflictsV2(f.file);
    assert.equal(baseline.comparisons, 10);
    assert.equal(baseline.total, 4);
    const atNine = { ...baseline, comparisons: 9 };
    const cap = Buffer.byteLength(JSON.stringify(atNine));
    assert.equal(Buffer.byteLength(JSON.stringify(baseline)), cap + 1);
    const result = scanConflictsV2(f.file, { limits: { resultBytes: cap } });
    assert.equal(result.comparisons, 10);
    assert.equal(result.reason, null);
    assert.equal(result.scanIncomplete, false);
    assert.equal(result.outputTruncated, true);
    assert.equal(result.totalExact, false);
    assert.deepEqual(result.conflicts, baseline.conflicts.slice(0, -1));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= cap);
  } finally { f.cleanup(); }
});

test('terminal empty envelope failure releases the snapshot lock', () => {
  const f = fixture();
  try {
    f.db.exec("DELETE FROM memory_occurrences; DELETE FROM memories; INSERT INTO memories VALUES ('a','桥梁1米1米1米1米1米。')");
    const baseline = scanConflictsV2(f.file);
    assert.equal(baseline.total, 0);
    assert.equal(baseline.comparisons, 10);
    const cap = Buffer.byteLength(JSON.stringify({ ...baseline, comparisons: 0 }));
    assert.throws(() => scanConflictsV2(f.file, { limits: { resultBytes: cap } }), /terminal envelope/);
    const second = new DatabaseSync(f.file);
    try {
      second.exec("BEGIN IMMEDIATE; INSERT INTO memories VALUES ('b','写入成功'); COMMIT");
      assert.equal(second.prepare('SELECT count(*) AS n FROM memories').get().n, 2);
    } finally { second.close(); }
  } finally { f.cleanup(); }
});
