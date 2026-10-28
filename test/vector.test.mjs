process.env.MEMJUDGE_NO_SECRETS = "1";
// 向量层与 RRF 融合的契约测试 —— 全程不碰网络。
//
// 三条不变量在这里钉死：
//   1. 无 key / 超时 / 非 200 / 结构不对 → embed() 返回 null，绝不抛错（静默降级）。
//   2. 同文本第二次embed 不再发请求（缓存按 sha256 命中）。
//   3. searchAsync 在没有向量时与 search() 结果逐字相同（融合是增强，不是替换）。
//
// 运行：node --test test/vector.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quantize, cosineInt8, embed, embedOne, vecStats, resetVecStats } from '../src/vector.mjs';
import { rrfFuse, SearchIndex, index, search } from '../src/search.mjs';

// ── 量化与相似度 ───────────────────────────────────────────────────────────

test('量化：[-1,1] 映射到 [-127,127]，越界钳位', () => {
  const q = quantize([0, 1, -1, 2, -2, 0.5]);
  assert.equal(q.length, 6);
  assert.equal(q[0], 0);
  assert.equal(q[1], 127);
  assert.equal(q[2], -127);
  assert.equal(q[3], 127, '越界上限要钳到 127，不能溢出 Int8');
  assert.equal(q[4], -127);
  assert.equal(q[5], 64); // 0.5*127 = 63.5 → 64
});

test('余弦：同向为 1、反向为 -1、形状不符为 0', () => {
  const a = quantize([1, 0, 0]);
  const b = quantize([1, 0, 0]);
  const c = quantize([-1, 0, 0]);
  assert.equal(cosineInt8(a, b), 1);
  assert.equal(cosineInt8(a, c), -1);
  assert.equal(cosineInt8(a, quantize([1, 0])), 0, '维度不同必须返回 0，不能抛');
  assert.equal(cosineInt8(a, null), 0);
});

// ── 静默降级 ───────────────────────────────────────────────────────────────

test('embed：无 key 时返回 null 且不抛错', async () => {
  const saved = process.env.MEMJUDGE_LLM_KEY;
  delete process.env.MEMJUDGE_LLM_KEY;
  try {
    resetVecStats();
    const r = await embed(['任意文本'], { dims: 64 });
    assert.equal(r, null);
    assert.equal(await embedOne('任意文本', { dims: 64 }), null);
    assert.ok(vecStats().failures >= 1, '失败要计数，便于诊断');
  } finally {
    if (saved !== undefined) process.env.MEMJUDGE_LLM_KEY = saved;
  }
});

test('embed：HTTP 非 200 时返回 null，不把异常抛给召回路径', async () => {
  const saved = { key: process.env.MEMJUDGE_LLM_KEY, fetch: globalThis.fetch };
  process.env.MEMJUDGE_LLM_KEY = 'sk-test-fake-key-for-unit-test';
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  try {
    const r = await embed(['x'], { dims: 64, cacheDir: null });
    assert.equal(r, null);
  } finally {
    process.env.MEMJUDGE_LLM_KEY = saved.key;
    globalThis.fetch = saved.fetch;
  }
});

test('embed：返回结构不对（维度不符）也算失败，不写坏数据', async () => {
  const saved = { key: process.env.MEMJUDGE_LLM_KEY, fetch: globalThis.fetch };
  process.env.MEMJUDGE_LLM_KEY = 'sk-test-fake-key-for-unit-test';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3 } }),
  });
  try {
    const r = await embed(['x'], { dims: 64, cacheDir: null });
    assert.equal(r, null, '要 64 维却给 2 维，必须整批失败而不是拿半个向量去算余弦');
  } finally {
    process.env.MEMJUDGE_LLM_KEY = saved.key;
    globalThis.fetch = saved.fetch;
  }
});

test('embed：成功一次后同文本走缓存，第二次零请求', async () => {
  const saved = { key: process.env.MEMJUDGE_LLM_KEY, fetch: globalThis.fetch };
  let calls = 0;
  process.env.MEMJUDGE_LLM_KEY = 'sk-test-fake-key-for-unit-test';
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.input.map(() => ({ embedding: Array.from({ length: body.dimensions }, (_, i) => (i % 7) / 7) })),
        usage: { prompt_tokens: 5 },
      }),
    };
  };
  try {
    const a = await embed(['同一段文本', '另一段'], { dims: 64, cacheDir: null });
    assert.equal(calls, 1, '两条一次批量，只发一次请求');
    assert.equal(a.length, 2);
    const b = await embed(['同一段文本'], { dims: 64, cacheDir: null });
    assert.equal(calls, 1, '第二次必须命中缓存，不发请求');
    assert.equal(b[0].length, 64);
  } finally {
    process.env.MEMJUDGE_LLM_KEY = saved.key;
    globalThis.fetch = saved.fetch;
  }
});

// ── RRF 融合 ───────────────────────────────────────────────────────────────

test('rrfFuse：两臂都靠前 > 单臂靠前 > 单臂靠后', () => {
  const m = rrfFuse(['a', 'b', 'c'], ['c', 'b', 'd']);
  assert.ok(m.get('b') > m.get('a'), 'b 两臂都在前列，应高于只在 bm25 第一的 a');
  assert.ok(m.get('c') > m.get('a'), 'c 两臂都在，应高于单臂第一');
  assert.ok(m.get('a') > m.get('d'), 'a 在 bm25 第一，应高于向量末端才出现的 d');
  // b 在两臂都是第 2 位：1/(60+2) × 2 = 1/31
  assert.ok(Math.abs(m.get('b') - 2 / 62) < 1e-12);
});

test('rrfFuse：k 越大分数越平，排序不变', () => {
  const small = rrfFuse(['a', 'b'], ['b', 'a'], 60);
  const big = rrfFuse(['a', 'b'], ['b', 'a'], 600);
  assert.ok(big.get('a') < small.get('a'));
  assert.equal(big.get('a'), big.get('b'), '两臂对称时同分');
});

// ── searchAsync 的三条路径 ─────────────────────────────────────────────────

const MEMS = [
  { id: 'm1', text: '舱壁凹陷深度实测十一厘米', source: { chapter: 1, para: 1 }, importance: 0.5, accessCount: 0, createdAt: 1000, lastAccessed: 1000 },
  { id: 'm2', text: '台风中心气压未记载，只有风力与横摇角度', source: { chapter: 2, para: 1 }, importance: 0.5, accessCount: 0, createdAt: 1000, lastAccessed: 1000 },
  { id: 'm3', text: '修理费报价四十七万八千美元，工期七十天', source: { chapter: 3, para: 1 }, importance: 0.5, accessCount: 0, createdAt: 1000, lastAccessed: 1000 },
];

test('searchAsync：没有向量时与 search() 逐字相同（融合只是增强）', async () => {
  const ix = index(MEMS);
  const a = ix.search('凹陷深度', { now: 2000 });
  const b = await ix.searchAsync('凹陷深度', { now: 2000 });
  assert.deepEqual(b.text, a.text);
  assert.deepEqual(b.hits.map((h) => h.id), a.hits.map((h) => h.id));
  assert.equal(b.scan.vector.used, false);
});

test('searchAsync：向量臂注入后能召回 BM25 零命中的段', async () => {
  const ix = index(MEMS);
  ix.setVectors(new Map([
    ['m1', quantize([1, 0, 0])],
    ['m2', quantize([0, 1, 0])],
    ['m3', quantize([0, 0, 1])],
  ]));
  // 查询与 m3 同向，但词面上「工期」只在 m3 里出现——构造一个词面完全不匹配的场景：
  const r = await ix.searchAsync('完全无关的字面串', {
    now: 2000,
    embed: async () => quantize([0, 0, 1]), // 指向 m3
  });
  assert.equal(r.scan.vector.used, true);
  assert.ok(r.hits.some((h) => h.id === 'm3'), 'BM25 零候选时向量臂仍要能带出 m3');
});

test('searchAsync：embed 抛错时静默退回 BM25，不冒泡', async () => {
  const ix = index(MEMS);
  ix.setVectors(new Map([['m1', quantize([1, 0, 0])]]));
  const r = await ix.searchAsync('凹陷深度', {
    now: 2000,
    embed: async () => { throw new Error('网络炸了'); },
  });
  assert.equal(r.scan.vector.used, false, '抛错要降级，不是让 recall 整体失败');
  assert.ok(r.hits.length > 0);
});

test('setVectors(null) 关闭向量臂', async () => {
  const ix = index(MEMS);
  ix.setVectors(new Map([['m1', quantize([1, 0, 0])]]));
  assert.equal(ix.hasVectors, true);
  ix.setVectors(null);
  assert.equal(ix.hasVectors, false);
  const r = await ix.searchAsync('凹陷深度', { now: 2000, embed: async () => quantize([1, 0, 0]) });
  assert.equal(r.scan.vector.used, false);
});

test('同步 search() 完全不受向量影响（0.989 的底不能动）', () => {
  const plain = index(MEMS);
  const withVec = index(MEMS);
  withVec.setVectors(new Map([['m1', quantize([1, 0, 0])]]));
  const a = plain.search('修理费', { now: 2000 });
  const b = withVec.search('修理费', { now: 2000 });
  assert.deepEqual(b.text, a.text);
  assert.deepEqual(b.hits.map((h) => h.score), a.hits.map((h) => h.score));
});
