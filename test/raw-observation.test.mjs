import test from 'node:test';
import assert from 'node:assert/strict';
import { observeRaw } from '../src/raw-observation.mjs';
import { RawRepository } from '../src/raw-repository.mjs';
import { DatabaseSync } from 'node:sqlite';
import { fromUtf16le } from '../src/raw-codec.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('chunked host text preserves UTF-16 and rolls back unknown evidence atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-host-text-'));
  const file = path.join(root, 'raw.sqlite');
  const repo = new RawRepository(file, { namespace: 'test', assertWritable() {} });
  const db = new DatabaseSync(file);
  try {
    repo.ingest({ fullSessionId: 's', event: { seq: 0, text: 'old' } });
    const text = 'x'.repeat(4200000) + '\ud800' + 'end' + '\udfff';
    const base = { fullSessionId: 's', source: { origin: 'host' }, readId: 'r1', slot: 0, startSeq: 0, endSeq: 1, text, unknown: false };
    repo.recordHostText(base);
    const bytes = db.prepare('SELECT bytes FROM raw_host_text_chunks ORDER BY part').all().map(row => Buffer.from(row.bytes));
    assert.equal(fromUtf16le(Buffer.concat(bytes)), text);
    assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next, 1);
    assert.throws(() => repo.recordHostText(base), /raw-host-text-duplicate/);
    db.exec("CREATE TRIGGER fail_text_chunk BEFORE INSERT ON raw_host_text_chunks BEGIN SELECT RAISE(ABORT,'chunk-fault'); END");
    assert.throws(() => repo.recordHostText({ ...base, readId: 'r2', text: 'unknown', unknown: true }), /chunk-fault/);
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_texts').get().n, 1);
    assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next, 1);
    db.exec('DROP TRIGGER fail_text_chunk');
    repo.recordHostText({ ...base, readId: 'r2', text: 'unknown', unknown: true });
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_pending').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_uncertainty').get().n, 1);
    assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next, 0);
    let calls = 0;
    assert.throws(() => repo.recordHostText({ ...base, get text() { calls++; return 'bad'; } }), /raw-invalid-host-text/);
    assert.throws(() => repo.recordHostText(new Proxy(base, { getOwnPropertyDescriptor() { calls++; throw Error('trap'); } })), /raw-invalid-host-text/);
    assert.equal(calls, 0);
    assert.throws(() => repo.recordHostText({ ...base, readId: 'r3', text: 'x'.repeat(16777217) }), /raw-invalid-host-text/);
  } finally { db.close(); repo.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('host text lease failure rolls back evidence and markers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-text-lease-'));
  const file = path.join(root, 'raw.sqlite');
  let checks = 0, fail = false;
  const repo = new RawRepository(file, { namespace: 'test', assertWritable() { if (fail && ++checks === 3) throw Error('lease-revoked'); } });
  const db = new DatabaseSync(file);
  try {
    fail = true;
    assert.throws(() => repo.recordHostText({ fullSessionId: 's', source: null, readId: 'r', slot: 0, startSeq: 0, endSeq: 1, text: 'kept', unknown: true }), /lease-revoked/);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('raw_host_texts','raw_host_pending')").get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_uncertainty').get().n, 0);
  } finally { db.close(); repo.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('observation limits ignore inherited configuration and reject accessors and proxies', () => {
  let calls = 0, result;
  try {
    Object.defineProperty(Object.prototype, 'nodes', { configurable: true, get() { calls++; return 0; }, set() { calls++; } });
    result = observeRaw({ text: 'kept' });
  } finally { delete Object.prototype.nodes; }
  assert.equal(calls, 0);
  assert.ok(result.records.some(record => record.value === 'kept'));
  assert.throws(() => observeRaw('x', { get nodes() { calls++; return 1; } }), /invalid-nodes-limit/);
  assert.throws(() => observeRaw('x', new Proxy({}, { getOwnPropertyDescriptor() { calls++; throw Error('trap'); } })), /invalid-nodes-limit/);
  assert.equal(calls, 0);
});

test('observation transaction keeps each sampled variant and tightens its source watermark', () => {
  const lease = { namespace: 'test', assertWritable() {} };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-samples-'));
  const file = path.join(root, 'raw.sqlite');
  const repo = new RawRepository(file, lease);
  try {
    repo.ingest({ fullSessionId: 's', event: { seq: 0, text: 'old' } });
    const source = { origin: 'host' };
    const sample = text => observeRaw({ text, get opaque() { throw Error('getter'); } });
    const first = repo.recordHostObservation({ fullSessionId: 's', source, observation: sample('\ud800first'), startSeq: 0, endSeq: 1 });
    const second = repo.recordHostObservation({ fullSessionId: 's', source, observation: sample('second'), startSeq: 0, endSeq: 1 });
    assert.notEqual(first.observationId, second.observationId);
    assert.equal(first.rawCommittedNextSeq, 0);
    assert.equal(first.observedPartial, true);
    assert.equal(first.hiddenSlotsUnverified, true);
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare('SELECT * FROM raw_host_samples ORDER BY rowid').all();
      assert.equal(rows.length, 2);
      assert.equal(JSON.parse(fromUtf16le(rows[0].observation)).records.find(r => r.kind === 'string').value, '\ud800first');
      assert.equal(JSON.parse(fromUtf16le(rows[1].observation)).records.find(r => r.kind === 'string').value, 'second');
      assert.equal(db.prepare('SELECT count(*) n FROM raw_conflicts').get().n, 0);
      db.exec("CREATE TRIGGER fail_sample BEFORE INSERT ON raw_host_samples BEGIN SELECT RAISE(ABORT,'sample-fault'); END");
      assert.throws(() => repo.recordHostObservation({ fullSessionId: 'other', source, observation: sample('x'), startSeq: 0, endSeq: 1 }), /sample-fault/);
      assert.equal(db.prepare('SELECT count(*) n FROM raw_host_samples').get().n, 2);
      assert.equal(db.prepare('SELECT count(*) n FROM raw_watermarks WHERE session_id=?').get(JSON.stringify('other')).n, 0);
    } finally { db.close(); }
  } finally { repo.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy sample table migration preserves read location and rolls back atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-sample-migrate-'));
  const file = path.join(root, 'raw.sqlite');
  const repo = new RawRepository(file, { namespace: 'test', assertWritable() {} });
  const db = new DatabaseSync(file);
  let calls = 0;
  try {
    db.exec("CREATE TABLE raw_host_samples(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, source BLOB NOT NULL, observation BLOB NOT NULL, observed_partial INTEGER NOT NULL, hidden_slots_unverified INTEGER NOT NULL); INSERT INTO raw_host_samples VALUES('legacy','test','s',x'00',x'00',1,1); CREATE TRIGGER fail_upgrade_sample BEFORE INSERT ON raw_host_samples BEGIN SELECT RAISE(ABORT,'upgrade-fault'); END");
    const base = { fullSessionId: 's', source: { origin: 'stable' }, observation: observeRaw({ text: '\ud800value' }), startSeq: 2, endSeq: 3, readId: '\ud800read', phase: 'first', offset: 2, revision: '\udfffversion', slot: 0, pending: true };
    assert.throws(() => repo.recordHostObservation(base), /upgrade-fault/);
    assert.equal(db.prepare('PRAGMA table_info(raw_host_samples)').all().length, 7);
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_samples').get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='raw_host_pending'").get().n, 0);
    db.exec('DROP TRIGGER fail_upgrade_sample');
    repo.recordHostObservation(base);
    repo.recordHostObservation({ ...base, readId: 'second', phase: 'page', slot: 1 });
    const rows = db.prepare('SELECT * FROM raw_host_samples ORDER BY rowid').all();
    assert.equal(rows[0].start_seq, null);
    assert.equal(rows[1].start_seq, 2);
    assert.equal(rows[1].end_seq, 3);
    assert.equal(fromUtf16le(rows[1].read_id), '\ud800read');
    assert.equal(fromUtf16le(rows[1].revision), '\udfffversion');
    assert.equal(fromUtf16le(rows[2].read_id), 'second');
    assert.equal(fromUtf16le(rows[2].phase), 'page');
    assert.equal(rows[2].read_offset, 2);
    assert.equal(rows[2].slot, 1);
    assert.deepEqual(rows[1].source, rows[2].source);
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_pending').get().n, 1);
    const getter = { ...base, get readId() { calls++; return 'bad'; } };
    assert.throws(() => repo.recordHostObservation(getter), /raw-invalid-observation/);
    assert.throws(() => repo.recordHostObservation(new Proxy(base, { getOwnPropertyDescriptor() { calls++; throw Error('trap'); } })), /raw-invalid-observation/);
    for (const change of [{ slot: -1 }, { offset: 1.5 }, { revision: null }, { readId: '' }, { phase: {} }]) assert.throws(() => repo.recordHostObservation({ ...base, ...change }), /raw-invalid-observation-scope/);
    assert.equal(calls, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_samples').get().n, 3);
  } finally { db.close(); repo.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('pending observation and watermark commit or roll back together', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-pending-observation-'));
  const file = path.join(root, 'raw.sqlite');
  const repo = new RawRepository(file, { namespace: 'test', assertWritable() {} });
  const db = new DatabaseSync(file);
  const source = { origin: 'stable' }, observation = observeRaw({ text: 'kept', get bad() { throw Error('getter'); } });
  try {
    repo.ingest({ fullSessionId: 's', event: { seq: 0, text: 'old' } });
    db.exec("CREATE TABLE raw_host_pending(namespace TEXT NOT NULL,session_id TEXT NOT NULL,source BLOB NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(namespace,session_id,source)); CREATE TRIGGER fail_pending_sample BEFORE INSERT ON raw_host_pending BEGIN SELECT RAISE(ABORT,'pending-sample-fault'); END");
    assert.throws(() => repo.recordHostObservation({ fullSessionId: 's', source, observation, startSeq: 0, endSeq: 1, pending: true }), /pending-sample-fault/);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='raw_host_samples'").get().n, 0);
    assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next, 1);
    db.exec('DROP TRIGGER fail_pending_sample');
    repo.recordHostObservation({ fullSessionId: 's', source, observation, startSeq: 0, endSeq: 1, pending: true });
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_pending').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_samples').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM raw_host_uncertainty').get().n, 1);
    assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next, 0);
  } finally { db.close(); repo.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects active observation inputs without invoking user code or changing storage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-observation-input-'));
  const file = path.join(root, 'raw.sqlite');
  const repo = new RawRepository(file, { namespace: 'test', assertWritable() {} });
  const db = new DatabaseSync(file);
  let calls = 0;
  try {
    const valid = observeRaw({ text: 'real' });
    const getter = { ...valid };
    Object.defineProperty(getter, 'observedPartial', { enumerable: true, get() { calls++; if (calls === 4) throw Error('late-getter'); return false; } });
    const malicious = { ...valid, toJSON() { calls++; return { fabricated: true }; } };
    const nested = { ...valid, records: new Proxy(valid.records, { ownKeys() { calls++; return []; } }) };
    const dynamic = new Proxy(valid, { get() { calls++; throw Error('proxy-get'); }, ownKeys() { calls++; return []; } });
    const inputProxy = new Proxy({ fullSessionId: 's', source: null, observation: valid }, { get() { calls++; throw Error('input-proxy'); } });
    for (const input of [getter, malicious, nested, dynamic]) {
      assert.throws(() => repo.recordHostObservation({ fullSessionId: 's', source: null, observation: input }), /raw-invalid-observation/);
    }
    assert.throws(() => repo.recordHostObservation(inputProxy), /raw-invalid-observation/);
    const sourceProxy = new Proxy({}, { ownKeys() { calls++; return []; } });
    assert.throws(() => repo.recordHostObservation({ fullSessionId: 's', source: sourceProxy, observation: valid }), /raw-invalid-observation/);
    assert.equal(calls, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='raw_host_samples'").get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM raw_watermarks').get().n, 0);
    const receipt = repo.recordHostObservation({ fullSessionId: 's', source: null, observation: valid });
    const row = db.prepare('SELECT * FROM raw_host_samples').get();
    const stored = JSON.parse(fromUtf16le(row.observation));
    assert.equal(receipt.observedPartial, stored.observedPartial);
    assert.equal(receipt.hiddenSlotsUnverified, stored.hiddenSlotsUnverified);
    assert.equal(row.observed_partial, Number(stored.observedPartial));
    assert.equal(row.hidden_slots_unverified, Number(stored.hiddenSlotsUnverified));
  } finally { db.close(); repo.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('bounded accessor observation persists with explicit incomplete state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-observation-wide-'));
  const file = path.join(root, 'raw.sqlite');
  const repo = new RawRepository(file, { namespace: 'test', assertWritable() {} });
  let calls = 0;
  try {
    const input = {};
    for (let i = 0; i < 8192; i++) Object.defineProperty(input, `k${i}`, { get() { calls++; } });
    const observation = observeRaw(input);
    assert.equal(observation.limitHit, true);
    assert.equal(observation.observedPartial, true);
    repo.recordHostObservation({ fullSessionId: 's', source: null, observation });
    const db = new DatabaseSync(file);
    try {
      const stored = JSON.parse(fromUtf16le(db.prepare('SELECT observation FROM raw_host_samples').get().observation));
      assert.equal(stored.limitHit, true);
      assert.equal(stored.observedPartial, true);
      assert.equal(calls, 0);
    } finally { db.close(); }
  } finally { repo.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('separates visible completeness from hidden-slot uncertainty', () => {
  const result = observeRaw({ a: 'ok' });
  assert.equal(result.observedPartial, false);
  assert.equal(result.hiddenSlotsUnverified, true);
  assert.equal(result.completeGraph, false);
  assert.equal(observeRaw({ get a() { throw Error(); } }).observedPartial, true);
});

test('stores long ancestor keys once instead of expanding every path', () => {
  const key = 'a'.repeat(100);
  const result = observeRaw({ [key]: { a: 'x', b: 'y', c: 'z' } });
  assert.equal(result.format, 'raw-observation-v2');
  assert.equal(JSON.stringify(result).split(key).length - 1, 1);
});

const pathOf = (result, location) => {
  const path = [];
  while (result.locations[location].parent !== null) {
    const entry = result.locations[location];
    path.unshift(entry.key);
    location = entry.parent;
  }
  return path;
};
const strings = result => result.records.filter(record => record.kind === 'string').map(record => ({ ...record, path: pathOf(result, record.location) }));
const reasons = result => result.records.filter(record => record.kind === 'unknown' && record.reason !== 'internal-slots-unverified').map(record => record.reason);

test('does not expose an over-budget key in its path', () => {
  const result = observeRaw({ abcdefgh: 'x' }, { codeUnits: 0 });
  const record = result.records.find(item => item.reason === 'key-code-unit-limit');
  assert.deepEqual(pathOf(result, record.location), []);
  assert.equal(record.value, '');
  assert.equal(record.length, 8);
  assert.equal(record.preserved, false);
  assert.equal(record.subtreeObserved, false);
  assert.equal(JSON.stringify(result).includes('abcdefgh'), false);
});

test('marks internal slots unverified even after prototype replacement', () => {
  const values = [new WeakRef({}), new FinalizationRegistry(() => {})];
  for (const value of values) {
    Object.setPrototypeOf(value, Object.prototype);
    const result = observeRaw(value);
    assert.equal(result.partial, true);
    assert.ok(result.records.some(record => record.reason === 'internal-slots-unverified'));
  }
});

test('preserves UTF-16 code units, empty strings, paths, order and flags', () => {
  const input = { first: '\ufeff\ud800X\udfff', empty: '' };
  Object.defineProperty(input, 'hidden', { value: 'text', enumerable: false, writable: false, configurable: true });
  const result = observeRaw(input);
  assert.deepEqual(strings(result).map(({ path, value }) => [path, value]), [
    [['first'], '\ufeff\ud800X\udfff'], [['empty'], ''], [['hidden'], 'text'],
  ]);
  assert.deepEqual(result.records.find(record => pathOf(result, record.location)[0] === 'hidden' && record.kind === 'property').flags,
    { enumerable: false, configurable: true, writable: false });
  assert.equal(JSON.parse(JSON.stringify(result)).records.find(record => record.kind === 'string').value, input.first);
  assert.equal(result.identity, false);
  assert.equal(result.completeGraph, false);
});

test('records accessors without executing them', () => {
  let calls = 0;
  const input = { get text() { calls++; throw new Error('must not run'); }, value: 'kept' };
  const result = observeRaw(input);
  assert.equal(calls, 0);
  assert.ok(reasons(result).includes('accessor'));
  assert.equal(result.partial, true);
  assert.equal(strings(result)[0].value, 'kept');
});

test('ignores inherited descriptor properties under prototype pollution', () => {
  let calls = 0;
  const input = { get text() { calls++; throw new Error('must not run'); } };
  let result;
  try {
    Object.prototype.value = 'fabricated';
    result = observeRaw(input);
  } finally {
    delete Object.prototype.value;
  }
  assert.equal(calls, 0);
  assert.equal(result.observedPartial, true);
  assert.ok(result.records.some(record => record.kind === 'property' && record.descriptor === 'accessor'));
  assert.ok(reasons(result).includes('accessor'));
  assert.equal(strings(result).some(record => record.value === 'fabricated'), false);
});

test('does not invoke dynamic or revoked proxy traps', () => {
  let calls = 0;
  const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error('trap'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const result = observeRaw({ proxy, revoked: revoked.proxy });
  assert.equal(calls, 0);
  assert.deepEqual(reasons(result), ['proxy', 'proxy']);
});

test('records shared references and cycles without recursion loops', () => {
  const shared = { text: 'once' }; shared.self = shared;
  const result = observeRaw({ a: shared, b: shared });
  assert.deepEqual(result.records.filter(record => record.kind === 'reference').map(record => [pathOf(result, record.location), pathOf(result, record.target)]),
    [[['a', 'self'], ['a']], [['b'], ['a']]]);
});

test('marks budget exhaustion with partial text and continues describing fields', () => {
  const result = observeRaw({ a: '12345', b: 'next' }, { codeUnits: 4 });
  assert.equal(result.partial, true);
  assert.ok(reasons(result).includes('code-unit-limit'));
  const truncated = result.records.find(record => record.reason === 'code-unit-limit' && pathOf(result, record.location)[0] === 'a');
  assert.equal(truncated.length, 5);
  assert.equal(truncated.value, '123');
  assert.ok(result.records.some(record => pathOf(result, record.location).length === 0 && record.order === 1 && record.reason === 'key-code-unit-limit'));
  const lone = observeRaw('\ud800X', { codeUnits: 1 });
  assert.equal(lone.records[0].value, '\ud800');
  assert.equal(lone.records[0].length, 2);
  assert.equal(lone.records[0].preserved, false);
  assert.equal(observeRaw('', { codeUnits: 0 }).records[0].value, '');
  assert.equal(observeRaw('abc', { codeUnits: 3 }).partial, false);
  assert.ok(reasons(observeRaw({ a: 1 }, { properties: 0 })).includes('property-limit'));
  assert.ok(reasons(observeRaw({ a: {} }, { depth: 0 })).includes('depth-limit'));
  assert.throws(() => observeRaw({}, { nodes: -1 }), RangeError);
});

test('marks internal slots, custom prototypes and symbol values as unknown', () => {
  for (const value of [new Map([['k', 'secret']]), new Date(0), Symbol('secret'), Object.create({ hidden: 'x' })]) {
    const result = observeRaw(value);
    assert.equal(result.partial, true);
    assert.ok(reasons(result).length > 0);
  }
});

test('records unobservable symbol keys and function values', () => {
  const result = observeRaw({ [Symbol('hidden')]: 'unknown', f() {} });
  assert.deepEqual(reasons(result), ['function', 'symbol-key']);
});
