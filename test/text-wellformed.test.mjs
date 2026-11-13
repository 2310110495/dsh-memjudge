import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { open } from '../src/store.mjs';
import { hasUnpairedSurrogate } from '../src/text-wellformed.mjs';
import {
  createTurnCollector,
  sanitizeTurnText,
  sanitizeToolSummary,
  sliceWellFormed,
} from '../src/turn-collector.mjs';

const bad = ['\ud800', '\udc00', 'prefix\ud800x', 'x\udc00suffix', '\ud800\ud800\udc00'];
const valid = ['normal😀text', 'before\0after', 'real\ufffdvalue'];

test('invalid code units have no transaction or data side effects', () => {
  const store = open(':memory:');
  try {
    const db = store.raw();
    for (const text of bad) {
      assert.equal(hasUnpairedSurrogate(text), true);
      assert.throws(() => store.put({ text }), /unpaired UTF-16 surrogate/);
      assert.equal(db.isTransaction, false);
      assert.equal(store.dump().length, 0);
    }
    for (const text of valid) {
      assert.equal(hasUnpairedSurrogate(text), false);
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
    const ids = valid.map((text) => store.put({ text }).id);
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

test('turn-collector guards against unpaired surrogates before enqueueing and preserves surrogate pairs at truncation boundaries', () => {
  const store = open(':memory:');
  try {
    const reports = [];
    const collector = createTurnCollector({
      store,
      spaceId: 'workspace:utf16',
      sessionId: 'sess-utf16',
      turnNo: 1,
      onInvalidText: (reason) => reports.push(reason),
    });

    for (const text of bad) {
      assert.equal(sanitizeTurnText(text, false), '');
      const dropped = collector.closeTurn({
        userText: `约定使用 pnpm 管理依赖 ${text}`,
        assistantConclusion: `已记录 ${text}`,
      });
      assert.equal(dropped.enqueued, false);
      assert.equal(dropped.filtered, true);
      assert.equal(dropped.reason, 'unpaired-surrogate');
    }

    assert.equal(reports.length, bad.length * 2);
    assert.ok(reports.every((r) => r === 'unpaired-surrogate'));
    assert.equal(collector.turnNo, 1, '脏轮次不应推进 turnNo');
    assert.equal(store.claimIngestJobs(10).length, 0);

    // 验证边界截断绝不拆散合法 UTF-16 代理对
    const pairAt100 = `${'a'.repeat(99)}😀tail`;
    assert.equal(sliceWellFormed(pairAt100, 100), 'a'.repeat(99));
    assert.equal(hasUnpairedSurrogate(sliceWellFormed(pairAt100, 100)), false);

    const toolLines = sanitizeToolSummary([
      `bad\ud800tool`,
      `${'b'.repeat(159)}😀tail`,
    ], (r) => reports.push(r));
    assert.equal(toolLines.length, 1);
    assert.equal(hasUnpairedSurrogate(toolLines[0]), false);

    // 合法代理对正常入队
    collector.recordUser('项目默认使用 valid😀text 作为标识规范');
    collector.recordTool('edit', { description: pairAt100 }, {}, true);
    collector.recordAssistant('已将 valid😀text 写入工程配置并验证通过。');
    const ok = collector.closeTurn({ now: 1700000000000 });
    assert.equal(ok.enqueued, true);
    assert.equal(collector.turnNo, 2);

    const jobs = store.claimIngestJobs(10);
    assert.equal(jobs.length, 1);
    const payload = typeof jobs[0].payload === 'object' && jobs[0].payload !== null
      ? jobs[0].payload
      : JSON.parse(jobs[0].payload_json ?? jobs[0].payloadJson);
    assert.match(payload.userText, /valid😀text/);
    assert.equal(hasUnpairedSurrogate(payload.userText), false);
    assert.equal(hasUnpairedSurrogate(payload.assistantConclusion), false);
    assert.equal(hasUnpairedSurrogate(payload.toolSummary[0]), false);
  } finally {
    store.close();
  }
});
