import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// This entry runs directly: no test runner child processes or real host state.
const blocked = /^(?:node:)?(?:net|http|https|http2|dns|dgram|tls|undici)(?:\/|$)/;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (blocked.test(specifier)) throw new Error('T1_NETWORK_MODULE_BLOCKED');
  return nextResolve(specifier, context);
} });
globalThis.fetch = () => { throw new Error('T1_FETCH_BLOCKED'); };
globalThis.WebSocket = class { constructor() { throw new Error('T1_WEBSOCKET_BLOCKED'); } };
assert.equal(process.permission.has('fs.write'), false);
assert.equal(process.permission.has('child'), false);
assert.equal(process.permission.has('worker'), false);
assert.equal(process.permission.has('addons'), false);
assert.throws(() => readFileSync('F:/T1_FORBIDDEN_SYNTHETIC/config.json'), { code: 'ERR_ACCESS_DENIED' });
await assert.rejects(import('node:net'), /T1_NETWORK_MODULE_BLOCKED/);
assert.throws(() => fetch('https://t1.invalid'), /T1_FETCH_BLOCKED/);
assert.throws(() => new WebSocket('wss://t1.invalid'), /T1_WEBSOCKET_BLOCKED/);
console.log('PASS isolation: fs/child/worker/addon denied; network module/fetch/WebSocket blocked');

const { apply } = await import('../src/index.mjs');
const { open } = await import('../src/store.mjs');
const { attributeValues } = await import('../src/attribute-evidence.mjs');
const sha = text => createHash('sha256').update(text, 'utf16le').digest('hex');
let passed = 0, failed = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); passed++; results.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (error) { failed++; results.push({ name, status: 'failed', error: error.stack }); console.log('FAIL ' + name + '\n' + error.stack); }
}
function fixture() {
  const tools = new Map(), services = new Map();
  let store;
  const forbidden = () => { throw new Error('T1_DISABLED_DEPENDENCY'); };
  const app = apply({ tools: { register(t) { tools.set(t.name, t); return () => {}; } },
    systemPrompt: { section: () => () => {} }, provide(n, s) { services.set(n, s); return () => {}; },
    effect: f => f(), on: () => () => {},
  }, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false,
    autoCapture: false, autoInject: false, touchOnRecall: true }, {
    storeFactory(path, options) { assert.equal(path, ':memory:'); return store = open(path, options); },
    maxChars: () => 0, storageLimitBytes: () => 2 * 1024 * 1024,
    installRpc: () => () => {}, autoCapture: () => ({ enabled: false }),
    defaultDbPath: forbidden, configReport: () => ({}), embedDims: forbidden, expand: forbidden, select: forbidden,
  });
  return { tools, store, service: services.get('memjudge'), dispose: app.dispose };
}
async function withFixture(fn) { const f = fixture(); try { await fn(f); } finally { await f.dispose(); } }
function reconstruct(read, hit, limit = 7) {
  let text = '', offset = 0, page;
  do {
    page = read.execute({ id: hit.id, version: hit.version, offset, limit });
    assert.equal(page.version, hit.version);
    assert.ok(page.text.isWellFormed());
    assert.ok(page.text.length <= limit);
    assert.ok(page.nextOffset > offset || !page.truncated);
    text += page.text; offset = page.nextOffset;
  } while (page.truncated);
  return text;
}
await check('write -> lexical window -> tool/service -> versioned exact pages and touch contract', () => withFixture(async f => {
  const original = '前序。'.repeat(90) + '\r\n😀Lighthouse标记e\u0301\0' + '尾部。'.repeat(90);
  const written = await f.tools.get('memjudge_remember').execute({ text: original });
  assert.equal(written.version, sha(original));
  const recall = f.tools.get('memjudge_recall'), read = f.tools.get('memjudge_read');
  f.store.raw().prepare('UPDATE memories SET last_accessed = 1234, access_count = 7 WHERE id = ?').run(written.id);
  const before = f.store.get(written.id, false);
  const serviceResult = await f.service.recallByQuery('Lighthouse', { budget: 24 });
  assert.equal(serviceResult.denied, false);
  assert.equal(f.store.get(written.id, false).access_count, before.access_count);
  assert.equal(f.store.get(written.id, false).last_accessed, before.last_accessed);
  const toolResult = await recall.execute({ query: 'Lighthouse', budget: 24 });
  assert.ok(f.store.get(written.id, false).access_count > before.access_count);
  for (const result of [serviceResult, toolResult]) {
    const hit = result.hits[0];
    assert.equal(hit.id, written.id); assert.equal(hit.version, written.version);
    assert.equal(hit.truncated, true); assert.ok(hit.windowStart > 0);
    assert.equal(hit.text, original.slice(hit.windowStart, hit.windowEnd));
    assert.ok(hit.text.length <= 24); assert.ok(hit.text.isWellFormed());
    assert.equal(reconstruct(read, hit), original);
  }
  const rendered = recall.output.render({}, toolResult).map(block => block.text).join('\n');
  assert.ok(rendered.includes(written.version)); assert.ok(rendered.includes(toolResult.hits[0].text));
  assert.ok(rendered.includes(`${toolResult.hits[0].windowStart}:${toolResult.hits[0].windowEnd}`));
  assert.ok(recall.output.schema.properties.hits.items.required.includes('version'));
  assert.ok(recall.output.schema.properties.hits.items.required.includes('truncated'));
}));
await check('Chinese English CRLF emoji combining tiny budgets and full hashes', () => withFixture(async f => {
  for (const original of ['中文灯塔\r\n😀e\u0301尾', 'English beacon\r\n😀e\u0301 tail', '😀😀灯塔']) {
    const written = await f.tools.get('memjudge_remember').execute({ text: original });
    const read = f.tools.get('memjudge_read');
    assert.equal(reconstruct(read, written, 2), original);
    assert.equal(written.version, sha(original));
    for (const budget of [1, 2, 3, 8, 2000]) {
      const result = await f.tools.get('memjudge_recall').execute({ query: original.includes('English') ? 'beacon' : '灯塔', budget });
      assert.ok(result.chars <= budget);
      for (const hit of result.hits ?? []) {
        assert.ok(hit.text.isWellFormed()); assert.ok(hit.text.length <= budget);
        const body = f.store.get(hit.id, false).text;
        assert.equal(hit.version, sha(body));
        assert.equal(hit.text, hit.truncated ? body.slice(hit.windowStart, hit.windowEnd) : body);
      }
    }
  }
}));
await check('update delete empty text and same-value hash boundary', () => withFixture(async f => {
  const original = '版本灯塔😀\r\ne\u0301' + '甲'.repeat(30);
  const written = await f.tools.get('memjudge_remember').execute({ text: original });
  const read = f.tools.get('memjudge_read');
  const first = read.execute({ id: written.id, version: written.version, limit: 2 });
  f.store.raw().prepare('UPDATE memories SET text = ? WHERE id = ?').run('新😀内容', written.id);
  assert.throws(() => read.execute({ id: written.id, offset: first.nextOffset, version: written.version }), /stale version/);
  f.store.raw().prepare('UPDATE memories SET text = ? WHERE id = ?').run('', written.id);
  const empty = read.execute({ id: written.id });
  assert.equal(empty.text, ''); assert.equal(empty.version, sha('')); assert.equal(empty.nextOffset, 0); assert.equal(empty.truncated, false);
  f.store.raw().prepare('UPDATE memories SET text = ? WHERE id = ?').run(original, written.id);
  assert.equal(read.execute({ id: written.id, version: written.version }).version, written.version);
  assert.equal(reconstruct(read, written, 2), original);
  assert.throws(() => read.execute({ id: written.id, offset: 5 }), /invalid offset/);
  assert.throws(() => read.execute({ id: written.id, limit: 1 }), /invalid arguments/);
  await f.tools.get('memjudge_forget').execute({ id: written.id });
  assert.throws(() => read.execute({ id: written.id, version: written.version }), /stale version/);
  assert.equal(read.execute({ id: written.id }).found, false);
}));
await check('attribute missing negative question no-value other-entity and cropped evidence', async () => {
  for (const text of ['甲船的颜色不是红色。', '甲船的颜色是什么？', '甲船的颜色尚无记录。', '乙船的颜色是红色。', '甲船在港口。']) {
    await withFixture(async f => {
      await f.tools.get('memjudge_remember').execute({ text });
      for (const call of [() => f.tools.get('memjudge_recall').execute({ query: '甲船的颜色是什么？', budget: 2000 }), () => f.service.recallByQuery('甲船的颜色是什么？', { budget: 2000 })]) {
        const result = await call();
        assert.equal(result.denied, true, text);
        assert.ok(['no-candidates', 'attribute-evidence-missing'].includes(result.reason));
        assert.equal(result.hits.length, 0);
      }
    });
  }
  await withFixture(async f => {
    await f.tools.get('memjudge_remember').execute({ text: '甲船的颜色是红色。' });
    const full = await f.tools.get('memjudge_recall').execute({ query: '甲船的颜色是什么？', budget: 2000 });
    assert.equal(full.denied, false);
    const tiny = await f.tools.get('memjudge_recall').execute({ query: '甲船的颜色是什么？', budget: 4 });
    assert.equal(tiny.denied, true); assert.equal(tiny.reason, 'attribute-evidence-missing');
    const serviceTiny = await f.service.recallByQuery('甲船的颜色是什么？', { budget: 4 });
    assert.equal(serviceTiny.reason, 'attribute-evidence-missing');
    const rendered = f.tools.get('memjudge_recall').output.render({}, tiny).map(b => b.text).join('\n');
    assert.ok(rendered.includes(tiny.reason)); assert.ok(rendered.includes(tiny.detail));
  });
});
await check('attribute multiple values and free query are not forced single-value', () => withFixture(async f => {
  await f.tools.get('memjudge_remember').execute({ text: '甲船的颜色是红色。甲船的颜色是蓝色。' });
  const result = await f.tools.get('memjudge_recall').execute({ query: '甲船的颜色是什么？', budget: 2000 });
  assert.equal(result.denied, false); assert.ok(result.conflictLine);
  assert.deepEqual(new Set(attributeValues('甲船的颜色是什么？', result.hits)), new Set(['红色', '蓝色']));
  assert.equal(attributeValues('甲船', result.hits), null);
  const free = await f.service.recallByQuery('甲船', { budget: 2000 });
  assert.equal(free.denied, false);
  const serviceMultiple = await f.service.recallByQuery('甲船的颜色是什么？', { budget: 2000 });
  assert.ok(serviceMultiple.conflictLine); assert.equal(serviceMultiple.hits[0].text, result.hits[0].text);
}));
await check('English attribute affirmative and negative use both delivery paths', async () => {
  for (const [text, denied] of [["Beacon's color is red.", false], ["Beacon's color is not red.", true], ["Other's color is red.", true]]) {
    await withFixture(async f => {
      await f.tools.get('memjudge_remember').execute({ text });
      for (const call of [() => f.tools.get('memjudge_recall').execute({ query: "what is Beacon's color?", budget: 2000 }), () => f.service.recallByQuery("what is Beacon's color?", { budget: 2000 })]) {
        const result = await call(); assert.equal(result.denied, denied, text);
        if (!denied) assert.equal(result.hits[0].text, text);
      }
    });
  }
});
await check('empty write and no candidates have explicit reasons', () => withFixture(async f => {
  await assert.rejects(async () => f.tools.get('memjudge_remember').execute({ text: '' }));
  for (const call of [() => f.tools.get('memjudge_recall').execute({ query: '缺失灯塔' }), () => f.service.recallByQuery('缺失灯塔')]) {
    const result = await call();
    assert.equal(result.denied, true); assert.equal(result.reason, 'no-candidates');
  }
}));
await check('V1 delivered evidence UTF16 spans independently verify original slices', async () => {
  const { analyzeAttributeEvidenceV1 } = await import('../src/attribute-evidence-v1.mjs');
  const originalText = '😀前言。甲船的颜色是红色。';
  const text = '甲船的颜色是红色。';
  const hit = { id: 'fixture', version: sha(originalText), text, originalText,
    windowStart: originalText.indexOf(text), windowEnd: originalText.length };
  const result = analyzeAttributeEvidenceV1('甲船的颜色是什么？', [hit]);
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0];
  assert.equal(text.slice(...c.valueSpan), c.rawValue);
  assert.equal(originalText.slice(...c.originalValueSpan), c.rawValue);
  assert.equal(originalText.slice(...c.originalSentenceSpan), c.sentence);
  assert.equal(analyzeAttributeEvidenceV1('自由查询', [hit]).status, 'unsupported');
});
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed) process.exitCode = 1;
