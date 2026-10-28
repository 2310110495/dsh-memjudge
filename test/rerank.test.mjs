process.env.MEMJUDGE_NO_SECRETS = "1";
// rerank.mjs 单测：不依赖网络（fetchImpl 注入），只验排序/截断/缓存/降级四条不变量。
//
// 用固定 mock 候选集，分数照 capten 实测的量级给（0.004579 / 0.002011 / 0.000044），
// 专门钉住「不许拿绝对值当阈值」——0.000044 那条必须仍然出现在返回里。
import assert from 'node:assert/strict';
import {
  rerank,
  applyRerank,
  rerankEnabled,
  clearRerankCache,
  rerankCacheSize,
  rerankStats,
  rerankOptIn,
  RERANK_DEFAULTS,
} from '../src/rerank.mjs';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`);
  }
}

// 固定 mock：分数乱序返回，验证模块自己排序
const DOCS = ['凹陷深度约九厘米。', '凹陷实测深度为十一厘米。', '船首油漆剥落。'];
const MOCK_RESULTS = [
  { index: 2, relevance_score: 0.000044 },
  { index: 0, relevance_score: 0.004579 },
  { index: 1, relevance_score: 0.002011 },
];

function mockFetch(payload = { results: MOCK_RESULTS }, status = 200) {
  const calls = { n: 0, bodies: [] };
  calls.fn = async (_url, init) => {
    calls.n += 1;
    calls.bodies.push(JSON.parse(init.body));
    return { ok: status === 200, status, json: async () => payload };
  };
  return calls;
}

process.env.MEMJUDGE_LLM_KEY = 'test-key-not-real';

console.log('\n[rerank 排序]');
await checkAsync('按 relevance_score 降序返回，且保留低分项（不做阈值过滤）', async () => {
  clearRerankCache();
  const out = await rerank('凹陷深度', DOCS, { fetchImpl: mockFetch().fn });
  assert.deepEqual(out.map((r) => r.index), [0, 1, 2], `排序错：${JSON.stringify(out)}`);
  assert.ok(out[2].score < 0.001, '低分项 0.000044 必须仍在返回里——它证明没有阈值过滤');
  assert.equal(out.length, 3);
});

await checkAsync('topN 截断：默认 8，显式传 2 时只回 2 条', async () => {
  clearRerankCache();
  assert.equal(RERANK_DEFAULTS.topN, 8);
  const out = await rerank('凹陷深度', DOCS, { fetchImpl: mockFetch().fn, topN: 2 });
  assert.deepEqual(out.map((r) => r.index), [0, 1]);
});

await checkAsync('同分时按 index 升序，输出稳定', async () => {
  clearRerankCache();
  const fn = mockFetch({ results: [{ index: 2, relevance_score: 0.01 }, { index: 0, relevance_score: 0.01 }] }).fn;
  const out = await rerank('x', DOCS, { fetchImpl: fn });
  assert.deepEqual(out.map((r) => r.index), [0, 2]);
});

console.log('\n[请求形态]');
await checkAsync('一次请求打包全部候选，body 带 model/query/documents', async () => {
  clearRerankCache();
  const m = mockFetch();
  await rerank('凹陷深度', DOCS, { fetchImpl: m.fn });
  assert.equal(m.n, 1, `应只发 1 次请求，实际 ${m.n}`);
  assert.equal(m.bodies[0].documents.length, DOCS.length);
  assert.equal(m.bodies[0].query, '凹陷深度');
  assert.equal(m.bodies[0].model, RERANK_DEFAULTS.model);
});

await checkAsync('越界 index 被丢弃，不会污染调用方候选序', async () => {
  clearRerankCache();
  const fn = mockFetch({ results: [{ index: 99, relevance_score: 0.9 }, { index: 1, relevance_score: 0.2 }] }).fn;
  const out = await rerank('q', DOCS, { fetchImpl: fn });
  assert.deepEqual(out.map((r) => r.index), [1]);
});

console.log('\n[缓存]');
await checkAsync('同 (query, 候选集合) 第二次命中缓存，不再发请求', async () => {
  clearRerankCache();
  const m = mockFetch();
  await rerank('凹陷深度', DOCS, { fetchImpl: m.fn });
  await rerank('凹陷深度', DOCS, { fetchImpl: m.fn });
  assert.equal(m.n, 1, `第二次应命中缓存，实际请求 ${m.n} 次`);
  assert.equal(rerankCacheSize(), 1);
});

await checkAsync('候选集合变化则不命中缓存', async () => {
  clearRerankCache();
  const m = mockFetch();
  await rerank('凹陷深度', DOCS, { fetchImpl: m.fn });
  await rerank('凹陷深度', [...DOCS, '附加一段'], { fetchImpl: m.fn });
  assert.equal(m.n, 2, `候选变了应重新请求，实际 ${m.n}`);
});

await checkAsync('cache:false 时每次都请求', async () => {
  clearRerankCache();
  const m = mockFetch();
  await rerank('q2', DOCS, { fetchImpl: m.fn, cache: false });
  await rerank('q2', DOCS, { fetchImpl: m.fn, cache: false });
  assert.equal(m.n, 2);
});

console.log('\n[降级]');
await checkAsync('无 key → null，且一次 fetch 都不发', async () => {
  const saved = process.env.MEMJUDGE_LLM_KEY;
  delete process.env.MEMJUDGE_LLM_KEY;
  rerankEnabled();
  const m = mockFetch();
  const out = await rerank('q3', DOCS, { fetchImpl: m.fn });
  assert.equal(out, null);
  assert.equal(m.n, 0, '没有 key 不应发请求');
  process.env.MEMJUDGE_LLM_KEY = saved;
});

await checkAsync('HTTP 非 200 → null（不抛错）', async () => {
  clearRerankCache();
  const out = await rerank('q4', DOCS, { fetchImpl: mockFetch({}, 500).fn });
  assert.equal(out, null);
});

await checkAsync('fetch 抛错 → null（不抛错）', async () => {
  clearRerankCache();
  const out = await rerank('q5', DOCS, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(out, null);
});

await checkAsync('空 results / 空候选 / 空 query → null', async () => {
  clearRerankCache();
  assert.equal(await rerank('q6', DOCS, { fetchImpl: mockFetch({ results: [] }).fn }), null);
  assert.equal(await rerank('q6', [], { fetchImpl: mockFetch().fn }), null);
  assert.equal(await rerank('', DOCS, { fetchImpl: mockFetch().fn }), null);
});

await checkAsync('超时 abort → null（timeoutMs 生效）', async () => {
  clearRerankCache();
  const slow = (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const out = await rerank('q7', DOCS, { fetchImpl: slow, timeoutMs: 30 });
  assert.equal(out, null);
});

console.log('\n[接线开关]');
check('默认不接管道：有 key 但没开 MEMJUDGE_RERANK 时 rerankOptIn() 为 false', () => {
  const saved = process.env.MEMJUDGE_RERANK;
  delete process.env.MEMJUDGE_RERANK;
  assert.equal(rerankOptIn(), false, '默认必须是关——实测零收益 + 半秒延迟');
  process.env.MEMJUDGE_RERANK = '1';
  assert.equal(rerankOptIn(), true);
  const key = process.env.MEMJUDGE_LLM_KEY;
  delete process.env.MEMJUDGE_LLM_KEY;
  assert.equal(rerankOptIn(), false, '没有 key 时开关无意义');
  process.env.MEMJUDGE_LLM_KEY = key;
  if (saved === undefined) delete process.env.MEMJUDGE_RERANK; else process.env.MEMJUDGE_RERANK = saved;
});

console.log('\n[套回候选序]');
check('applyRerank 把精排命中的项提到前面，其余保持原序（集合不变）', () => {
  const items = ['a', 'b', 'c', 'd'];
  const r = applyRerank(items, [{ index: 2, score: 0.9 }, { index: 0, score: 0.5 }]);
  assert.equal(r.applied, true);
  assert.deepEqual(r.items, ['c', 'a', 'b', 'd']);
  assert.equal(r.moved, 2);
  assert.deepEqual(items, ['a', 'b', 'c', 'd'], '不得原地改动入参');
});

check('applyRerank：null / 空 / 全越界 → 原序返回，applied=false', () => {
  const items = ['a', 'b'];
  assert.deepEqual(applyRerank(items, null).items, items);
  assert.equal(applyRerank(items, null).applied, false);
  assert.deepEqual(applyRerank(items, [{ index: 9, score: 1 }]).items, items);
  assert.equal(applyRerank(items, []).applied, false);
});

check('统计：调过几次、失败几次、送过多少文档', () => {
  assert.ok(rerankStats.calls > 0);
  assert.ok(rerankStats.failures > 0, `失败计数没涨：${JSON.stringify(rerankStats)}`);
  assert.ok(rerankStats.docsSent > 0);
});

console.log(`\n${failures.length ? 'FAILURES' : 'ALL PASS'}  ${passed}/${passed + failures.length} 项断言通过`);
if (failures.length) process.exitCode = 1;
