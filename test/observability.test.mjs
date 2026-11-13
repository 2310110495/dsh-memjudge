import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from '../src/store.mjs';
import { createInjectionObserver, resolveObservationScope, collectObservationCounts, buildObservabilitySnapshot } from '../src/observability.mjs';

const cwd = 'F:/isolated-observability/project-a';
const scope = (extra = {}) => resolveObservationScope({ cwd, sessionId: 'session-a', ...extra });
const scopedText = () => ({ ...scope(), explicit: true, includeText: true });
const record = (o, data = {}) => o.record({ sessionId: 'session-a', spaceId: scope().spaceId, tierS: '规则😀', tierD: '事实中文', ...data });

test('observations are real UTF-16/UTF-8 measurements and default status never returns text', () => {
  const o = createInjectionObserver({ now: () => 1234 });
  assert.equal(o.read(scope()).current, null);
  record(o, { separator: '\n\n', query: 'NEVER LOG THIS', key: 'NEVER LOG KEY' });
  const hidden = o.read(scope());
  assert.equal(hidden.current, null);
  assert.equal(hidden.unavailableReason, 'explicit-scoped-text-request-required');
  assert.doesNotMatch(JSON.stringify(hidden), /规则|事实|NEVER LOG/);
  const current = o.read(scopedText()).current;
  assert.equal(current.tierS.text, '规则😀');
  assert.equal(current.tierS.chars, '规则😀'.length);
  assert.equal(current.tierS.bytes, Buffer.byteLength('规则😀'));
  assert.equal(current.totalChars, '规则😀\n\n事实中文'.length);
  assert.equal(current.totalBytes, Buffer.byteLength('规则😀\n\n事实中文'));
  assert.equal(current.at, new Date(1234).toISOString());
  assert.equal(o.read(scope({ sessionId: 'session-b', includeInjectionText: true })).current, null);
  assert.equal(o.read(scope({ sessionId: 'session-b' })).events.length, 0);
  assert.equal(o.read(scope({ spaceId: 'global' })).events.length, 0);
  assert.equal(o.read(resolveObservationScope({ cwd })).events.length, 0);
});

test('S/D pairing requires same context, session and scope; partial and anonymous channels stay unknown', () => {
  const o = createInjectionObserver();
  const token = {};
  const channel = { sessionId: 'session-a', spaceId: scope().spaceId };
  o.record({ ...channel, token, tier: 'tierS', text: 'S' });
  assert.equal(o.read(scopedText()).current, null);
  o.record({ ...channel, token: {}, tier: 'tierD', text: 'D' });
  assert.equal(o.read(scopedText()).current, null);
  o.record({ ...channel, token, tier: 'tierS', text: 'S' });
  o.record({ ...channel, token, tier: 'tierD', text: '' });
  assert.equal(o.read(scopedText()).current.tierD.chars, 0);
  o.record({ ...channel, token, tier: 'tierD', text: 'later D on reused context' });
  assert.equal(o.read(scopedText()).current, null, 'completed frame token is consumed');
  o.record({ ...channel, token, sessionId: 'session-b', tier: 'tierD', text: 'other' });
  assert.equal(o.read(scopedText()).current, null);
  o.record({ ...channel, tier: 'tierS', text: 'S' });
  o.record({ ...channel, tier: 'tierD', text: 'D' });
  assert.equal(o.read(scopedText()).current, null, 'undefined token must not pair');
  record(o, { sessionId: null });
  assert.equal(o.read(scopedText()).current, null);
});

test('abandoned partial frame cannot pair after an async boundary even if host reuses context object', async () => {
  const o = createInjectionObserver();
  const token = {};
  const channel = { sessionId: 'session-a', spaceId: scope().spaceId, token };
  o.record({ ...channel, tier: 'tierS', text: 'abandoned S' });
  await Promise.resolve();
  o.record({ ...channel, tier: 'tierD', text: 'later context refresh' });
  assert.equal(o.read(scopedText()).current, null);
  assert.equal(o.read(scopedText()).events.at(-1).details.complete, false);
  // A fresh synchronous assembly using the same object may pair its own S/D.
  o.record({ ...channel, tier: 'tierS', text: 'fresh S' });
  o.record({ ...channel, tier: 'tierD', text: 'fresh D' });
  assert.equal(o.read(scopedText()).current.tierS.text, 'fresh S');
});

test('event ring is bounded metadata, snapshots detached, raw text evicted and lifecycle cleared', () => {
  const o = createInjectionObserver({ limit: 999 });
  for (let i = 0; i < 70; i += 1) record(o);
  const data = o.read(scopedText());
  assert.equal(data.events.length, 32);
  data.events[0].details.sessionId = 'tampered';
  data.current.tierS.text = 'tampered';
  assert.equal(o.read(scopedText()).events.length, 32);
  assert.equal(o.read(scopedText()).current.tierS.text, '规则😀');
  record(o, { sessionId: 'session-b' });
  assert.equal(o.read(scopedText()).current, null, 'only one raw candidate, not a session prompt archive');
  o.clear('session-a');
  assert.deepEqual(o.read(scope()).events, []);
  o.clear();
  assert.deepEqual(o.read(scope({ sessionId: 'session-b' })).events, []);
  record(o, { tierS: 'x'.repeat(601) });
  assert.equal(o.read(scopedText()).current, null, 'never truncate oversized text and report as actual');
});

test('scope selection excludes unrelated workspace and all; raw text requires explicit scope', () => {
  assert.deepEqual(scope().spaces, [scope().spaceId, 'global']);
  assert.deepEqual(scope({ spaceId: 'global' }).spaces, ['global']);
  for (const spaceId of ['all', 'workspace:ffffffffffff', "x') OR 1=1 --"]) {
    const selected = scope({ spaceId, includeInjectionText: true });
    assert.equal(selected.spaceId, null);
    assert.deepEqual(selected.spaces, []);
  }
  assert.equal(scope({ sessionId: 'arbitrary user text' }).sessionId, null);
});

test('scoped aggregates are SELECT-only, no raw memory body, no access refresh, and no cross-workspace counts', () => {
  const store = open(':memory:');
  try {
    const a = scope().spaceId;
    const b = resolveObservationScope({ cwd: 'F:/isolated-observability/project-b' }).spaceId;
    store.put({ text: 'global正文😀', category: 'rule', spaceId: 'global' });
    store.put({ text: 'current正文', category: 'experience', spaceId: a });
    store.put({ text: 'unrelated私密正文', category: 'decision', spaceId: b });
    const before = store.raw().prepare('SELECT * FROM memories ORDER BY id').all();
    const generation = store.dataGeneration();
    const data = collectObservationCounts(store, scope());
    assert.equal(data.unavailable, false);
    assert.equal(data.spaces.reduce((n, s) => n + s.memoryCount, 0), 2);
    assert.equal(data.categories.rule, 1);
    assert.equal(data.categories.experience, 1);
    assert.equal(data.categories.decision, 0);
    assert.equal(data.textChars, [...'global正文😀current正文'].length, 'SQLite LENGTH is codepoints, not UTF16 injection units');
    assert.equal(data.indexes.vectors, 0);
    assert.equal(data.indexes.searchIndex, null);
    assert.doesNotMatch(JSON.stringify(data), /正文|私密/);
    assert.equal(store.dataGeneration(), generation);
    assert.deepEqual(store.raw().prepare('SELECT * FROM memories ORDER BY id').all(), before);
    assert.equal(collectObservationCounts(store, scope({ spaceId: b })).unavailable, true);
    assert.equal(collectObservationCounts({}, scope()).textChars, null);
    assert.equal(collectObservationCounts({ raw() { throw new Error('closed'); } }, scope()).unavailable, true);
  } finally { store.close(); }
});

test('storage uses actual store.bytes physical semantics, never injection size; builder is pure and unknown-safe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-observation-storage-'));
  const dbPath = path.join(dir, 'isolated.db');
  const store = open(dbPath);
  try {
    store.put({ text: 'small', category: 'rule', spaceId: 'global' });
    const stats = store.stats();
    const physical = ['', '-wal', '-journal'].reduce((n, suffix) => n + (fs.existsSync(dbPath + suffix) ? fs.statSync(dbPath + suffix).size : 0), 0);
    assert.equal(stats.bytes, physical);
    const counts = collectObservationCounts(store, scope());
    const input = { capturedAt: 'now', stats, counts, config: { autoInject: true, injectBudget: 50 }, dbPath };
    const before = JSON.stringify(input);
    const snap = buildObservabilitySnapshot(input);
    assert.equal(JSON.stringify(input), before);
    assert.equal(snap.storage.logicalBytes, physical);
    assert.match(snap.storage.semantics, /main.*WAL.*journal/);
    assert.equal(snap.injection.current, null);
    assert.equal(snap.injection.measurement, 'configured');
    assert.equal(snap.injection.tierSBudgetChars, 50);
    assert.equal(snap.injection.tierDBudgetChars, 50);
    assert.equal(snap.capabilities.hostContextTokens, false);
    const unknown = buildObservabilitySnapshot();
    assert.equal(unknown.storage.logicalBytes, null);
    assert.equal(unknown.storage.textChars, null);
    assert.equal(unknown.capabilities.scopedCounts, false);
    assert.equal(unknown.indexes.modules.vector, null);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
