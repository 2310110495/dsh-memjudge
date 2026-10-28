process.env.MEMJUDGE_NO_SECRETS = "1";
// query-expand 单测：全程不碰网络（fetchImpl / expandFn 注入）。
//
// 重点钉两件事：
//   1. 每条降级路径都必须**可观测**（degraded 取值明确），不许静默退回还装作没事。
//      t25 的教训：searchAsync 把字符串传给批量 embed，异常被 catch 吞掉，静默降级回纯 BM25，
//      导致 t21 整轮「融合」数字其实是纯 BM25 的。
//   2. 扩展只补尾、不改写原 query 的结果序（否则 S03/S09 那种原本满分的题会掉）。
import assert from 'node:assert/strict';
import { expand, parseQueries, expandEnabled, clearExpandCache, expandCacheSize, QE_DEFAULTS } from '../src/query-expand.mjs';
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

function mockFetch(content, status = 200) {
  const calls = { n: 0, bodies: [] };
  calls.fn = async (_url, init) => {
    calls.n += 1;
    calls.bodies.push(JSON.parse(init.body));
    return { ok: status === 200, status, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return calls;
}

const GOOD = '{"queries":["改航 航程增加 海里","谁决定改航","改航 原因"]}';

console.log('\n[解析]');
await check('parseQueries 吃裸 JSON / ```json 围栏 / 前后废话', () => {
  assert.deepEqual(parseQueries(GOOD), ['改航 航程增加 海里', '谁决定改航', '改航 原因']);
  assert.deepEqual(parseQueries('```json\n' + GOOD + '\n```'), ['改航 航程增加 海里', '谁决定改航', '改航 原因']);
  assert.deepEqual(parseQueries('好的，结果如下：' + GOOD + ' 完毕'), ['改航 航程增加 海里', '谁决定改航', '改航 原因']);
});

await check('parseQueries 过滤过短/过长子查询，全被过滤时返回 null', () => {
  assert.deepEqual(parseQueries('{"queries":["a","有效的子查询","' + 'x'.repeat(80) + '"]}'), ['有效的子查询']);
  assert.equal(parseQueries('{"queries":["a"]}'), null);
  assert.equal(parseQueries('not json'), null);
  assert.equal(parseQueries(''), null);
  assert.equal(parseQueries(null), null);
});

console.log('\n[降级可观测]');
await check('无 key → degraded:"no-key"，queries 只剩原 query，且不发请求', async () => {
  const saved = process.env.MEMJUDGE_LLM_KEY;
  delete process.env.MEMJUDGE_LLM_KEY;
  clearExpandCache();
  const m = mockFetch(GOOD);
  const r = await expand('改航后航程增加了多少海里', { fetchImpl: m.fn });
  assert.equal(r.expanded, false);
  assert.equal(r.degraded, 'no-key');
  assert.deepEqual(r.queries, ['改航后航程增加了多少海里']);
  assert.equal(m.n, 0, '没有 key 不应发请求');
  process.env.MEMJUDGE_LLM_KEY = saved;
});

await check('HTTP 500 → degraded:"http"，退回单查询', async () => {
  clearExpandCache();
  const r = await expand('q-http', { fetchImpl: mockFetch(GOOD, 500).fn });
  assert.equal(r.expanded, false);
  assert.equal(r.degraded, 'http');
  assert.deepEqual(r.queries, ['q-http']);
});

await check('返回非 JSON → degraded:"parse"', async () => {
  clearExpandCache();
  const r = await expand('q-parse', { fetchImpl: mockFetch('我不是 json').fn });
  assert.equal(r.degraded, 'parse');
});

await check('fetch 抛错 → degraded:"http"，不抛给调用方', async () => {
  clearExpandCache();
  const r = await expand('q-throw', { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(r.degraded, 'http');
  assert.equal(r.queries.length, 1);
});

await check('超时 abort → degraded:"timeout"；timeoutMs 传 undefined 必须回落到默认值', async () => {
  clearExpandCache();
  const slow = (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const r = await expand('q-timeout', { fetchImpl: slow, timeoutMs: 30 });
  assert.equal(r.degraded, 'timeout');
  // 显式传 undefined：展开运算符会覆盖默认值 → setTimeout(NaN) → 立刻 abort（t26 实测踩过）
  const r2 = await expand('q-undef', { fetchImpl: mockFetch(GOOD).fn, timeoutMs: undefined });
  assert.equal(r2.expanded, true, `timeoutMs=undefined 时不应立刻超时：${JSON.stringify(r2)}`);
});

console.log('\n[正常路径]');
await check('成功 → expanded:true，queries[0] 是原问句，总长 ≤ maxQueries', async () => {
  clearExpandCache();
  const m = mockFetch(GOOD);
  const r = await expand('改航后航程增加了多少海里，这个决定是谁下的', { fetchImpl: m.fn });
  assert.equal(r.expanded, true);
  assert.equal(r.degraded, null);
  assert.equal(r.queries[0], '改航后航程增加了多少海里，这个决定是谁下的');
  assert.ok(r.queries.length >= 2 && r.queries.length <= QE_DEFAULTS.maxQueries);
  assert.equal(m.n, 1, '应只发 1 次请求');
  assert.equal(m.bodies[0].temperature, 0);
  assert.match(m.bodies[0].messages[0].content, /子查询/);
});

await check('子查询与原问句重复时去重，不会重复检索', async () => {
  clearExpandCache();
  const Q = '改航后航程增加了多少海里';
  const r = await expand(Q, { fetchImpl: mockFetch(JSON.stringify({ queries: [Q, '改航 航程'] })).fn });
  assert.equal(r.queries.filter((x) => x === Q).length, 1);
  assert.ok(r.queries.includes('改航 航程'));
});

await check('缓存：同 query 第二次命中，不再发请求', async () => {
  clearExpandCache();
  const m = mockFetch(GOOD);
  await expand('q-cache', { fetchImpl: m.fn });
  const r2 = await expand('q-cache', { fetchImpl: m.fn });
  assert.equal(m.n, 1, `第二次应命中缓存，实际 ${m.n} 次`);
  assert.equal(r2.cached, true);
  assert.equal(r2.expanded, true);
  assert.equal(expandCacheSize(), 1);
});

console.log('\n[检索合并：只补尾，不改原序]');
function buildIndex() {
  const docs = [
    '白鲸号于二〇二三年三月十四日二十二时十七分离港。',
    '改航使航程增加一百八十七海里。',
    'OTS-9 的回复由调度员何维桢签发，电报编号 OTS-230323-04。',
    '船舶证书、入级证书与坞修记录都在有效期内。',
    '台风夜横摇二十八度，三卷钢卷滚落。',
  ];
  const idx = new SearchIndex({ maxChars: 2000 });
  idx.addAll(docs.map((text, i) => ({ id: `d${i}`, text, source: { chapter: i + 1, para: 1 }, importance: 0, accessCount: 0, createdAt: 0, lastAccessed: 0, supersededBy: null })));
  return idx;
}

await check('无 key 降级时 searchExpanded 与 search() 逐字相同（且 expansion.degraded 有值）', async () => {
  const saved = process.env.MEMJUDGE_LLM_KEY;
  delete process.env.MEMJUDGE_LLM_KEY;
  clearExpandCache();
  const idx = buildIndex();
  const a = idx.search('改航 航程', { maxChars: 2000, topChapters: 3 });
  const b = await idx.searchExpanded('改航 航程', { maxChars: 2000, topChapters: 3 });
  assert.deepEqual(b.hits.map((h) => h.id), a.hits.map((h) => h.id));
  assert.equal(b.text, a.text);
  assert.equal(b.expansion.expanded, false);
  assert.equal(b.expansion.degraded, 'no-key');
  process.env.MEMJUDGE_LLM_KEY = saved;
});

await check('扩展时原 query 的结果顺序被保留，子查询只补尾部', async () => {
  clearExpandCache();
  const idx = buildIndex();
  const expandFn = async () => ({ queries: ['改航 航程', '何维桢 电报 编号', '钢卷 滚落'], expanded: true, degraded: null, ms: 0, cached: false });
  const base = idx.search('改航 航程', { maxChars: 2000, topChapters: 3 });
  const out = await idx.searchExpanded('改航 航程', { maxChars: 2000, topChapters: 3, expandFn });
  const baseIds = base.hits.map((h) => h.id);
  assert.deepEqual(out.hits.slice(0, baseIds.length).map((h) => h.id), baseIds, '原 query 的顺序被改写了');
  assert.ok(out.hits.length > baseIds.length, '子查询没有补进任何新段');
  assert.equal(out.expansion.expanded, true);
  assert.ok(out.expansion.added >= 1);
});

await check('补尾不超预算、不超 limit', async () => {
  const idx = buildIndex();
  const expandFn = async () => ({ queries: ['x', '何维桢', '钢卷', '离港'], expanded: true, degraded: null, ms: 0, cached: false });
  const out = await idx.searchExpanded('改航', { maxChars: 60, topChapters: 3, limit: 2, expandFn });
  assert.ok(out.chars <= 60, `超预算：${out.chars}`);
  assert.ok(out.hits.length <= 2, `超 limit：${out.hits.length}`);
});

console.log(`\n${failures.length ? 'FAILURES' : 'ALL PASS'}  ${passed}/${passed + failures.length} 项断言通过`);
if (failures.length) process.exitCode = 1;
