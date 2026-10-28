process.env.MEMJUDGE_NO_SECRETS = "1";
// LLM 提取层离线自检：不碰真 API，用注入的 fetch 验证 grounding/缓存/重试降级。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBatch, groundFilter, createCache, llmStats, llmEnabled,
} from '../src/llm-extract.mjs';

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  globalThis.fetch = async (url, init) => handler(url, init);
}
function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}
function chatReply(results) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify({ results }) } }] });
}

test('无 key 时 llmEnabled=false 且 extractBatch 返回 null（静默降级）', async () => {
  const saved = process.env.MEMJUDGE_LLM_KEY;
  delete process.env.MEMJUDGE_LLM_KEY;
  assert.equal(llmEnabled(), false);
  const r = await extractBatch([{ text: '白鲸号总长一百八十九点九米。' }]);
  assert.equal(r, null);
  if (saved) process.env.MEMJUDGE_LLM_KEY = saved;
});

test('grounding：编造的 sent 被丢弃并计数，合法的保留', () => {
  const text = '白鲸号总长一百八十九点九米，型宽三十二点二米。';
  const { facts, dropped } = groundFilter([
    { entity: '白鲸号', attr: '总长', value: '一百八十九点九米', vtype: 'number', sent: '白鲸号总长一百八十九点九米' },
    { entity: '白鲸号', attr: '型宽', value: '三十二点二米', vtype: 'number', sent: '这句话原文里根本没有' },
    { entity: '白鲸号', attr: '干舷', value: '五米', vtype: 'number', sent: '白鲸号总长一百八十九点九米' },
  ], text);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].attr, '总长');
  assert.equal(dropped, 2);
});

test('有 key 时批量调用、缓存命中不重复请求、统计正确', async () => {
  process.env.MEMJUDGE_LLM_KEY = 'test-key-not-real';
  const text = '白鲸号总长一百八十九点九米。';
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return chatReply([{ index: 1, triples: [
      { entity: '白鲸号', attr: '总长', value: '一百八十九点九米', vtype: 'number', sent: '白鲸号总长一百八十九点九米' },
    ] }]);
  });
  const cache = createCache(null); // 纯内存
  const before = llmStats.calls;
  const r1 = await extractBatch([{ text }], { cache });
  assert.ok(Array.isArray(r1?.[0]) && r1[0].length === 1);
  assert.equal(calls, 1);
  const r2 = await extractBatch([{ text }], { cache }); // 命中缓存
  assert.equal(calls, 1, '第二遍不该再发请求');
  assert.ok(llmStats.cacheHits >= 1);
  assert.equal(llmStats.calls - before, 1);
  globalThis.fetch = realFetch;
});

test('API 两次失败后返回 null（重试 1 次即降级，不无限重试）', async () => {
  process.env.MEMJUDGE_LLM_KEY = 'test-key-not-real';
  let calls = 0;
  stubFetch(async () => { calls += 1; throw new Error('network down'); });
  const before = llmStats.retries;
  const r = await extractBatch([{ text: '一段没缓存过的原文，避免命中上一个用例。' }], { cache: createCache(null) });
  assert.equal(r, null);
  assert.equal(calls, 2, '一次原始 + 一次重试');
  assert.equal(llmStats.retries - before, 1);
  globalThis.fetch = realFetch;
  delete process.env.MEMJUDGE_LLM_KEY;
});
