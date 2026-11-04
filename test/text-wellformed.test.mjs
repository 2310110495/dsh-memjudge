import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { open } from '../src/store.mjs';
import { captureVerdict, createQuota, extractCandidates } from '../src/auto-capture.mjs';

const bad = ['\ud800', '\udc00', 'prefix\ud800x', 'x\udc00suffix', '\ud800\ud800\udc00'];
const valid = ['normal😀text', 'before\0after', 'real\ufffdvalue'];
const msg = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

test('invalid code units have no transaction or data side effects', () => {
  const store = open(':memory:');
  try {
    const db = store.raw();
    for (const text of bad) {
      assert.throws(() => store.put({ text }), /unpaired UTF-16 surrogate/);
      assert.equal(db.isTransaction, false);
      assert.equal(store.dump().length, 0);
    }
    for (const text of valid) {
      const first = store.put({ text });
      assert.equal(store.put({ text }).id, first.id);
      assert.equal(store.get(first.id).text, text);
    }
  } finally { store.close(); }
});

test('valid code units survive reopen and duplicate writes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'memjudge-utf16-'));
  const file = path.join(dir, 'test.db');
  try {
    let store = open(file);
    const ids = valid.map(text => store.put({ text }).id);
    store.close();
    store = open(file);
    try {
      valid.forEach((text, i) => {
        assert.equal(store.get(ids[i]).text, text);
        assert.equal(store.put({ text }).id, ids[i]);
      });
      for (const text of bad) assert.throws(() => store.put({ text }), /unpaired UTF-16 surrogate/);
      assert.equal(store.dump().length, valid.length);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('capture reports invalid text before consuming quota', () => {
  const opts = { enabled: true, minChars: 1, maxChars: 600, perTurnLimit: 1, sessionLimit: 1, cooldownMs: 0 };
  const quota = createQuota(opts);
  const reports = [];
  assert.equal(captureVerdict(msg('bad\ud800text'), opts).reason, 'unpaired-surrogate');
  const candidates = extractCandidates([msg('bad\ud800text'), msg('valid😀text')], {
    ...opts, quota, sessionId: 'isolated', turn: 1, onInvalidText: reason => reports.push(reason),
  });
  assert.deepEqual(reports, ['unpaired-surrogate']);
  assert.deepEqual(candidates.map(x => x.text), ['valid😀text']);
  assert.equal(quota.stats('isolated').total, 1);
});
