process.env.MEMJUDGE_NO_SECRETS = "1";
// llm-select 单测：全程零网络（fetchImpl 注入）。重点钉住「降级必须可观测」与「只重排不丢段」。
import assert from 'node:assert/strict';
import { select, parsePicks, selectEnabled, clearSelectCache, selectCacheSize, LS_DEFAULTS } from '../src/llm-select.mjs';
import { SearchIndex } from '../src/search.mjs';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`);
  }
}

const KEY = 'test-key-not-real';
process.env.MEMJUDGE_LLM_KEY = KEY;

function mockFetch(content, status = 200, usage = { prompt_tokens: 1300, completion_tokens: 8 }) {
  const calls = { n: 0, bodies: [] };
  calls.fn = async (_url, init) => {
    calls.n += 1;
    calls.bodies.push(JSON.parse(init.body));
    return { ok: status === 200, status, json: async () => ({ choices: [{ message: { content } }], usage }) };
  };
  return calls;
}

const CANDIDATES = [
  '报告对 OTS-9 提出两项整改建议。',
  '改航使航程增加一百八十七海里，多出十三个多小时。',
  'OTS-9 的回复由调度员何维桢签发，电报编号 OTS-230323-04。',
  '触损时间：三月二十六日三时零八分。',
];

console.log('\n[解析]');
await check('parsePicks 吃裸 JSON / 围栏 / 带废话；1-based 转 0-based', () => {
  assert.deepEqual(parsePicks('{"picks":[2,3]}', 4), [1, 2]);
  assert.deepEqual(parsePicks('```json\n{"picks":[1]}\n```', 4), [0]);
  assert.deepEqual(parsePicks('结果：{"picks":[4,2]} 完', 4), [3, 1]);
  assert.deepEqual(parsePicks('{"picks":[]}', 4), []);
});

await check('parsePicks 丢弃越界/非整数/重复，格式不符返回 null', () => {
  assert.deepEqual(parsePicks('{"picks":[1,9,0,-1,2,2,"x"]}', 4), [0, 1]);
  assert.equal(parsePicks('no json', 4), null);
  assert.equal(parsePicks('', 4), null);
  assert.equal(parsePicks('{"other":1}', 4), null);
});

console.log('\n[降级可观测]');
await check('无 key → degraded:"no-key"，零请求，picks 为空', async () => {
  const saved = process.env.MEMJUDGE_LLM_KEY;
  delete process.env.MEMJUDGE_LLM_KEY;
  clearSelectCache();
  const m = mockFetch('{"picks":[1]}');
  const r = await select('问题', CANDIDATES, { fetchImpl: m.fn });
  assert.equal(r.degraded, 'no-key');
  assert.deepEqual(r.picks, []);
  assert.equal(m.n, 0);
  process.env.MEMJUDGE_LLM_KEY = saved;
});

await check('HTTP 500 → "http"；非 JSON → "parse"；抛错 → "http"；超时 → "timeout"', async () => {
  clearSelectCache();
  assert.equal((await select('q1', CANDIDATES, { fetchImpl: mockFetch('', 500).fn })).degraded, 'http');
  clearSelectCache();
  assert.equal((await select('q2', CANDIDATES, { fetchImpl: mockFetch('我不是 json').fn })).degraded, 'parse');
  clearSelectCache();
  assert.equal((await select('q3', CANDIDATES, { fetchImpl: async () => { throw new Error('ECONNRESET'); } })).degraded, 'http');
  clearSelectCache();
  const slow = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  assert.equal((await select('q4', CANDIDATES, { fetchImpl: slow, timeoutMs: 30 })).degraded, 'timeout');
});

await check('timeoutMs 显式传 undefined 时回落到默认值（不会 setTimeout(NaN) 立刻 abort）', async () => {
  clearSelectCache();
  const r = await select('q5', CANDIDATES, { fetchImpl: mockFetch('{"picks":[1]}').fn, timeoutMs: undefined });
  assert.equal(r.degraded, 'none');
  assert.deepEqual(r.picks, [0]);
});

console.log('\n[正常路径]');
await check('成功 → picks 按模型给出的顺序、下标指向 candidates、带 token', async () => {
  clearSelectCache();
  const m = mockFetch('{"picks":[2,3]}', 200, { prompt_tokens: 1234, completion_tokens: 9 });
  const r = await select('改航后航程增加多少海里', CANDIDATES, { fetchImpl: m.fn });
  assert.equal(r.degraded, 'none');
  assert.deepEqual(r.picks, [1, 2]);
  assert.equal(r.tokensIn, 1234);
  assert.equal(r.tokensOut, 9);
  assert.equal(m.n, 1);
  assert.equal(m.bodies[0].temperature, 0);
  assert.match(m.bodies[0].messages[0].content, /只输出 JSON/);
});

await check('候选按 snippetChars 截断，prompt 里出现编号 [1]..[n]', async () => {
  clearSelectCache();
  const long = 'x'.repeat(900);
  const m = mockFetch('{"picks":[]}');
  await select('q', [long, '短段'], { fetchImpl: m.fn, snippetChars: 300 });
  const content = m.bodies[0].messages[0].content;
  assert.ok(content.includes('x'.repeat(300)));
  assert.ok(!content.includes('x'.repeat(301)), 'snippetChars 截断没生效');
  assert.match(content, /\[1\]/);
  assert.match(content, /\[2\]/);
});

await check('模型返回空数组也是 success（degraded:"none"、picks 为空）——不是降级', async () => {
  clearSelectCache();
  const r = await select('q-empty', CANDIDATES, { fetchImpl: mockFetch('{"picks":[]}').fn });
  assert.equal(r.degraded, 'none');
  assert.deepEqual(r.picks, []);
});

await check('缓存：同 (query, 候选集合) 第二次命中', async () => {
  clearSelectCache();
  const m = mockFetch('{"picks":[1]}');
  await select('q-cache', CANDIDATES, { fetchImpl: m.fn });
  const r2 = await select('q-cache', CANDIDATES, { fetchImpl: m.fn });
  assert.equal(m.n, 1, `第二次应命中缓存，实际 ${m.n}`);
  assert.equal(r2.cached, true);
  assert.equal(selectCacheSize(), 1);
  // 候选变了就不该命中
  await select('q-cache', [...CANDIDATES, '新段'], { fetchImpl: m.fn });
  assert.equal(m.n, 2);
});

console.log('\n[装填：只重排不丢段]');
function buildIndex() {
  const docs = [
    '报告对 OTS-9 提出两项整改建议。',
    '改航使航程增加一百八十七海里。',
    'OTS-9 的回复由调度员何维桢签发。',
    '台风夜横摇二十八度，三卷钢卷滚落。',
    '船舶证书在有效期内。',
  ];
  const idx = new SearchIndex({ maxChars: 2000 });
  idx.addAll(docs.map((text, i) => ({ id: `d${i}`, text, source: { chapter: i + 1, para: 1 }, importance: 0, accessCount: 0, createdAt: 0, lastAccessed: 0, supersededBy: null })));
  return idx;
}

await check('priorityIds 让被选中的段优先进预算，且原结果一段不丢', async () => {
  const idx = buildIndex();
  const base = idx.search('OTS-9 回复 报告', { maxChars: 2000, topChapters: 1 });
  const out = await idx.searchAsync('OTS-9 回复 报告', {
    maxChars: 2000,
    topChapters: 1,
    llmSelect: true,
    // 选最后一段：它来自第 5 章，topChapters=1 时本来进不了装填
    selectFn: async (_q, docs) => ({ picks: [docs.length - 1], degraded: 'none', ms: 0, tokensIn: 0, tokensOut: 0, pool: docs.length }),
  });
  assert.ok(out.hits.length >= base.hits.length, `装填反而变少：${out.hits.map((h) => h.id)}`);
  assert.equal(out.scan.selection.picks, 1);
  assert.equal(out.scan.selection.degraded, 'none');
  // 原 query 的段不能丢
  for (const h of base.hits) assert.ok(out.hits.some((x) => x.id === h.id), `原结果 ${h.id} 被丢了`);
});

await check('降级（无 key）时 searchAsync 与不选段的结果逐字相同', async () => {
  const saved = process.env.MEMJUDGE_LLM_KEY;
  delete process.env.MEMJUDGE_LLM_KEY;
  clearSelectCache();
  const idx = buildIndex();
  const a = await idx.searchAsync('改航 航程', { maxChars: 2000, topChapters: 2, llmSelect: true });
  const b = await idx.searchAsync('改航 航程', { maxChars: 2000, topChapters: 2 });
  assert.deepEqual(a.hits.map((h) => h.id), b.hits.map((h) => h.id));
  assert.equal(a.text, b.text);
  assert.equal(a.scan.selection.degraded, 'no-key');
  process.env.MEMJUDGE_LLM_KEY = saved;
});

console.log(`\n${failures.length ? 'FAILURES' : 'ALL PASS'}  ${passed}/${passed + failures.length} 项断言通过`);
if (failures.length) process.exitCode = 1;
