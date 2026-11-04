import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, resolveConfig } from '../src/index.mjs';
import { open } from '../src/store.mjs';

function fixture(config = {}) {
  const sections = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-daily-fixture-'));
  const dbPath = config.dbPath || path.join(dir, 'test.db');
  const app = apply({ tools: { register: () => () => {} }, systemPrompt: { section: x => { sections.set(x.name, x); return () => {}; } }, effect: f => f() }, { vector: false, autoInject: true, ...config, dbPath });
  const store = open(dbPath, { now: config.now });
  return { store, dispose: () => { store.close(); app.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }, inject: () => [...sections.values()][0].text() };
}

test('daily boundary, rollback and protected categories', () => {
  let clock = 100 * 86400000;
  const f = fixture({ now: () => clock, experimentalInjectMode: 'daily', experimentalInjectHalfLifeDays: 1, experimentalInjectFloor: 0 });
  try {
    f.store.put({ text: 'old-event', importance: 0.8 });
    f.store.put({ text: 'person-stays', importance: 0.2, kind: 'person' });
    f.store.put({ text: 'promise-stays', importance: 0.2, kind: 'promise' });
    clock += 86399999;
    f.store.put({ text: 'new-event', importance: 0.6 });
    assert.ok(f.inject().indexOf('old-event') < f.inject().indexOf('new-event'));
    clock++;
    let out = f.inject();
    assert.ok(out.indexOf('new-event') < out.indexOf('old-event'));
    assert.ok(out.includes('person-stays') && out.includes('promise-stays'));
    clock -= 2 * 86400000;
    out = f.inject();
    assert.ok(out.indexOf('old-event') < out.indexOf('new-event'));
    assert.ok(out.length <= 2000);
  } finally { f.dispose(); }
});

test('daily reads new commits and sorts before forty-row truncation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-daily-'));
  const file = path.join(dir, 'test.db');
  let clock = 100 * 86400000;
  const f = fixture({ dbPath: file, now: () => clock, experimentalInjectMode: 'daily', experimentalInjectHalfLifeDays: 1, experimentalInjectFloor: 0 });
  const other = open(file, { now: () => clock });
  try {
    for (let i = 0; i < 41; i++) other.put({ text: `old-${String(i).padStart(2, '0')}`, importance: 0.8 });
    f.inject();
    clock += 86400000;
    other.put({ text: 'newest-winner', importance: 0.7 });
    assert.ok(f.inject().includes('newest-winner'));
  } finally { other.close(); f.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('incomplete snapshot, clock and experimental configuration are explicit', () => {
  for (const cfg of [{ experimentalInjectMode: 'typo' }, { experimentalInjectFloor: NaN }, { experimentalInjectFloor: -1 }, { experimentalInjectHalfLifeDays: 0 }, { experimentalInjectHalfLifeDays: '30' }]) assert.throws(() => resolveConfig(cfg), TypeError);
  const f = fixture({ experimentalInjectMode: 'daily', now: () => NaN });
  try { assert.throws(() => f.inject(), /invalid injection clock/); } finally { f.dispose(); }
  const g = fixture({ experimentalInjectMode: 'daily' });
  try {
    g.store.raw().prepare('INSERT INTO memories (id,text,text_hash,created_at,last_accessed,access_count,importance,kind) VALUES (?,?,?,?,?,?,?,?)').run('x', 'x'.repeat(65537), 'hash', 1, 1, 0, 0.5, 'event');
    assert.throws(() => g.inject(), /snapshot incomplete/);
  } finally { g.dispose(); }
});
