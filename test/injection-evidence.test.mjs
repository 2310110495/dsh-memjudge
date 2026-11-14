import test from 'node:test';
import assert from 'node:assert/strict';
import { createInjector } from '../src/inject.mjs';
import { SearchIndex } from '../src/search.mjs';
import { open } from '../src/store.mjs';

const query = '星河项目的重试次数是3吗？';
const cases = [
  ['affirmative', '星河项目的重试次数是3。', query, true],
  ['wrong value', '星河项目的重试次数是4。', query, false],
  ['negation', '星河项目的重试次数不是3。', query, false],
  ['conditional comma', '在开发环境下，星河项目的重试次数是3。', query, false],
  ['restrictive conditional', '仅在开发环境下，星河项目的重试次数是3。', query, false],
  ['restrictive wrong condition', '仅在开发环境下，星河项目的重试次数是3。', '仅在生产环境下星河项目的重试次数是3吗？', false],
  ['restrictive matching condition', '仅在开发环境下，星河项目的重试次数是3。', '仅在开发环境下星河项目的重试次数是3吗？', true],
  ['restrictive list condition', '- **仅在开发环境下**，星河项目的重试次数是3。', query, false],
  ['matching condition', '在开发环境下，星河项目的重试次数是3。', '在开发环境下星河项目的重试次数是3吗？', true],
  ['comparison is not equality', '星河项目的重试次数不超过3。', query, false],
  ['keyword narrative', '星河项目部署失败后采用逐级回退方案。', '星河项目部署回退方案', true],
];
// Force the retrieval route, not the evidence verdict. Authoritative text still
// comes from real SQLite; deliberately lossy affirmative slots stress the gate.
function setup(text, route, overrides = {}) {
  const store = open(':memory:');
  store.put({ id: 'candidate', spaceId: 'workspace:a', category: 'experience', text,
    slots: [{ entity: '星河项目', attr: '重试次数', value: '3', unit: '', polarity: 'affirm', confidence: 1,
      quote: '星河项目的重试次数是3。' }], ...overrides });
  const index = new SearchIndex().addAll(store.list({ includeText: true }));
  const hit = { id: 'candidate', spaceId: 'workspace:a', text, routes: route, bm25: 100, vecScore: 1 };
  index.search = () => ({ hits: [hit] });
  index.searchAsync = async () => ({ hits: [hit] });
  const injector = createInjector({ store, searchIndex: index });
  return { store, injector, index, hit };
}
for (const mode of ['sync', 'async']) for (const route of [['slot'], ['bm25'], ['bm25', 'slot'], ['vector']]) {
  for (const [name, text, q, allowed] of cases) test(mode + ' ' + route.join('+') + ': ' + name, async () => {
    const f = setup(text, route);
    try {
      const ctx = { sessionId: 'case', spaceId: 'workspace:a', queryVector: new Int8Array([100, 0]),
        vectors: new Map([['candidate', new Int8Array([100, 0])]]) };
      const out = mode === 'sync' ? f.injector.getTierDSync(q, ctx) : await f.injector.getTierD(q, ctx);
      assert.equal(out.text.length > 0, allowed, JSON.stringify(out));
      if (!allowed) assert.deepEqual(out.ids, []);
      if (allowed) assert.ok(out.text.includes(text));
      assert.ok(out.chars <= 900);
    } finally { f.injector.dispose(); f.store.close(); }
  });
}

test('source denial is not marked seen; a later valid query still injects', () => {
  const f = setup('在开发环境下，星河项目的重试次数是3。', ['slot']);
  try {
    const ctx = { sessionId: 'seen', spaceId: 'workspace:a' };
    assert.equal(f.injector.getTierDSync(query, ctx).text, '');
    assert.ok(f.injector.getTierDSync('在开发环境下星河项目的重试次数是3吗？', ctx).text);
    assert.equal(f.injector.getTierDSync('在开发环境下星河项目的重试次数是3吗？', ctx).text, '');
    f.injector.onCompaction('seen');
    assert.ok(f.injector.getTierDSync('在开发环境下星河项目的重试次数是3吗？', ctx).text);
  } finally { f.injector.dispose(); f.store.close(); }
});

for (const state of ['missing', 'deleted', 'wrong-space', 'stale', 'throwing']) test('external index cannot inject ' + state + ' source', async () => {
  const f = setup('星河项目的重试次数是3。', ['bm25']);
  try {
    if (state === 'missing') f.hit.id = 'not-in-store';
    if (state === 'deleted') f.store.forget({ ids: ['candidate'] });
    if (state === 'wrong-space') f.store.raw().prepare('UPDATE memories SET space_id=? WHERE id=?').run('workspace:b', 'candidate');
    if (state === 'stale') f.store.raw().prepare('UPDATE memories SET text=? WHERE id=?').run('星河项目的重试次数不是3。', 'candidate');
    if (state === 'throwing') f.store.get = () => { throw new Error('source unavailable'); };
    // The sync path independently recovers a legitimate different slot hit.
    // Use mocked async search for the missing-id case to isolate its sole hit.
    const ctx = { sessionId: 'source', spaceId: 'workspace:a' };
    const out = state === 'missing' ? await f.injector.getTierD(query, ctx) : f.injector.getTierDSync(query, ctx);
    assert.equal(out.text, '', JSON.stringify(out));
    assert.deepEqual(out.ids, []);
  } finally { f.injector.dispose(); f.store.close(); }
});

test('budget truncation cannot remove the only affirmative evidence and still mark it seen', () => {
  const text = '背景说明。'.repeat(30) + '星河项目的重试次数是3。';
  const f = setup(text, ['slot']);
  try {
    const ctx = { sessionId: 'truncate', spaceId: 'workspace:a', tierDMaxChars: 80 };
    assert.equal(f.injector.getTierDSync(query, ctx).text, '');
    const full = f.injector.getTierDSync(query, { ...ctx, tierDMaxChars: 900 });
    assert.ok(full.text.includes('重试次数是3。'));
  } finally { f.injector.dispose(); f.store.close(); }
});

test('conflict sibling cannot reintroduce a rejected assertion', () => {
  // Multiple disputed siblings are supported by the plain-memory API; SQLite
  // enforces one active slotKey row and therefore is not a valid pair fixture.
  const memories = [
    { id: 'candidate', category: 'experience', spaceId: 'workspace:a', slotKey: 'retry', text: '星河项目的重试次数是3。' },
    { id: 'denied-sibling', category: 'experience', spaceId: 'workspace:a', slotKey: 'retry', text: '在生产环境下，星河项目的重试次数是3。' },
  ];
  const index = new SearchIndex().addAll(memories);
  index.search = () => ({ hits: [{ ...memories[0], routes: ['slot'], bm25: 100 }] });
  const injector = createInjector({ searchIndex: index });
  try {
    const out = injector.getTierDSync(query, { memories, sessionId: 'conflict', spaceId: 'workspace:a' });
    assert.ok(out.text.includes('星河项目的重试次数是3。'));
    assert.ok(!out.text.includes('生产环境'), out.text);
    assert.ok(!out.ids.includes('denied-sibling'));
  } finally { injector.dispose(); }
});

test('source-local no-facts fallback cannot borrow another memory or unsupported quote', () => {
  const f = setup('未说明星河项目的重试次数。', ['slot']);
  try {
    f.store.put({ id: 'other', spaceId: 'workspace:b', category: 'experience', text: '星河项目的重试次数是3。' });
    const out = f.injector.getTierDSync(query, { sessionId: 'foreign', spaceId: 'workspace:a' });
    assert.equal(out.text, '');
    assert.deepEqual(out.ids, []);
  } finally { f.injector.dispose(); f.store.close(); }
});

for (const [q, text] of [
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 消费组重平衡超时参数 session.timeout.ms 已调优为 45000ms。'],
  ['SQLite 锁等待 busy_timeout 设为多少？', 'SQLite 锁等待 busy_timeout 设为 5000 毫秒。'],
]) test('local fallback retains mixed-language condition: ' + q, async () => {
  const f = setup('在开发环境下，' + text, ['bm25']);
  try {
    const ctx = { sessionId: 'technical-condition', spaceId: 'workspace:a' };
    assert.equal((await f.injector.getTierD(q, ctx)).text, '');
    assert.equal(f.injector.sessionStats(ctx.sessionId).dynamicSeen, 0);
    assert.equal((await f.injector.getTierD('在生产环境下' + q, ctx)).text, '');
    assert.ok((await f.injector.getTierD('在开发环境下' + q, ctx)).text.includes(text));
  } finally { f.injector.dispose(); f.store.close(); }
});

test('constructor scope is enforced even when custom index ignores search options', () => {
  const f = setup('星河项目的重试次数是3。', ['bm25']);
  const scoped = createInjector({ store: f.store, searchIndex: f.index, spaceId: 'workspace:b' });
  try {
    const out = scoped.getTierDSync(query, { sessionId: 'constructor-scope' });
    assert.equal(out.text, '');
    assert.deepEqual(out.ids, []);
  } finally { scoped.dispose(); f.injector.dispose(); f.store.close(); }
});

test('an explicit empty source list does not authorize external index text', () => {
  const index = new SearchIndex().addAll([{ id: 'foreign', text: '星河项目的重试次数是3。', spaceId: 'workspace:a' }]);
  index.search = () => ({ hits: [{ id: 'foreign', text: '星河项目的重试次数是3。', spaceId: 'workspace:a', routes: ['slot'] }] });
  const injector = createInjector({ searchIndex: index });
  try {
    assert.equal(injector.getTierDSync(query, { memories: [], sessionId: 'empty', spaceId: 'workspace:a' }).text, '');
  } finally { injector.dispose(); }
});

test('unrelated affirmative fact cannot launder a filtered conditional clause in the same source', async () => {
  const f = setup('在开发环境下，Kafka 消费组重平衡超时参数 session.timeout.ms 已调优为 45000ms。其他服务监听端口为8080。', ['bm25']);
  try {
    const ctx = { sessionId: 'same-source-launder', spaceId: 'workspace:a' };
    const q = 'Kafka 消费组 session.timeout.ms 参数是多少？';
    assert.equal((await f.injector.getTierD(q, ctx)).text, '');
    assert.ok((await f.injector.getTierD('在开发环境下' + q, ctx)).text.includes('45000ms'));
  } finally { f.injector.dispose(); f.store.close(); }
});

for (const q of [
  'Kafka 消费组 session.timeout.ms 参数是45000ms吗？',
  'SQLite 锁等待 busy_timeout 是5000毫秒吗？',
  'SQLite 锁等待 busy_timeout 是多少？',
  'Kafka 消费组 session.timeout.ms 参数是多少？',
]) test('unparsed explicit equality must not recover through legacy coverage: ' + q, async () => {
  const f = setup('Kafka 消费组重平衡超时参数 session.timeout.ms 不超过 45000ms。', ['slot']);
  try {
    assert.equal(f.injector.getTierDSync(q, { sessionId: 'exact-sync', spaceId: 'workspace:a' }).text, '');
    assert.equal((await f.injector.getTierD(q, { sessionId: 'exact-async', spaceId: 'workspace:a' })).text, '');
  } finally { f.injector.dispose(); f.store.close(); }
});

for (const [q, text, allowed] of [
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 消费组重平衡超时参数 session.timeout.ms 已调优为 45000ms。', true],
  ['Kafka 消费组重平衡方案 session.timeout.ms 是45000ms吗？', 'Kafka 消费组重平衡方案已采用 session.timeout.ms 不超过 45000ms 的限制。', false],
  ['Kafka 消费组重平衡方案 session.timeout.ms 是多少？', 'Kafka 消费组重平衡方案已采用 session.timeout.ms 不超过 45000ms 的限制。', false],
  ['SQLite 锁等待 busy_timeout 设为多少？', 'SQLite 锁等待 busy_timeout 设为 5000 毫秒。', true],
  ['PgBouncer 连接池耗尽时 default_pool_size 调成了多少？', '排查 PgBouncer 连接池耗尽故障，现已将 default_pool_size 固定为 64。', true],
  ['Redis 哨兵主节点别名是什么？', 'Redis 哨兵集群主节点别名为 mymaster-prod，故障转移投票法定人数 quorum 设为 2。', true],
  ['Redis 哨兵主节点别名是什么？', 'SQLite 哨兵集群主节点别名为 mymaster-prod。', false],
  ['Redis 哨兵故障排查需要开启什么 sentinel 配置项？', '自动蒸馏的 Redis 哨兵故障排查结论 1：需开启 sentinel resolve-hostnames 配置项 1。', true],
  ['Redis 哨兵故障排查需要开启什么 sentinel 配置项？', 'Redis 哨兵故障排查结论：不需开启 sentinel resolve-hostnames 配置项。', false],
  ['Redis 哨兵故障排查需要开启什么 sentinel 配置项？', 'SQLite 哨兵故障排查结论：需开启 sentinel resolve-hostnames，Redis 仅供比较。', false],
  ['Redis 哨兵故障排查需要开启什么 sentinel 配置项？', 'Redis 背景，SQLite 哨兵故障排查结论：需开启 sentinel resolve-hostnames 配置项。', false],
  ['Redis 哨兵故障排查需要开启什么 sentinel 配置项？', 'Redis 哨兵故障排查结论：未将正式上线前的全部审查说明记录为需开启 sentinel resolve-hostnames 配置项。', false],
  ['Redis 哨兵故障排查需要开启什么 sentinel 配置项？', 'Redis 哨兵故障排查结论：将需开启 sentinel resolve-hostnames 配置项作为建议。', false],
  ['之前 Redis Sentinel 偶发 ECONNRESET 断连的报错根因和 tcpKeepAlive 修复参数是多少？', '已定位 Redis Sentinel 断连报错根因：NAT 网关空闲超时为 60s 而客户端 tcpKeepAlive 设为 120s 导致半开死连接被静默重置，修复方案为将 tcpKeepAlive 调至 30s 并开启探活重连。', true],
  ['之前订单撮合引擎无锁环形队列 Disruptor 架构决策是什么？', '架构决策：撮合引擎核心通道决定采用无锁环形队列（Disruptor RingBuffer）替代互斥锁。', true],
  ['之前订单撮合引擎无锁环形队列 Disruptor 架构决策是什么？', '架构决策：撮合引擎核心通道计划决定采用无锁环形队列（Disruptor RingBuffer）替代互斥锁。', false],
  ['PostgreSQL 的 wal_level 归档策略是什么？', 'PostgreSQL 归档策略：wal_level 设为 replica，保留最近 72 小时预写日志。', true],
  ['PostgreSQL 的 wal_level 归档策略是什么？', 'PostgreSQL 归档策略：wal_level 不是 replica。', false],
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 消费组并非将 session.timeout.ms 调整为 45000ms。', false],
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 消费组仅在开发环境下，session.timeout.ms 已调优为 45000ms。', false],
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 消费组未将 session.timeout.ms 调整为 45000ms。', false],
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 消费组建议 session.timeout.ms 调整为 45000ms。', false],
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 消费组将 session.timeout.ms 调整为 45000ms。', false],
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 消费组 session.timeout.ms 已调优为 45000ms，但仅在开发环境下。', false],
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 故障已解决，SQLite 的 session.timeout.ms 调整为 45000ms。', false],
  ['Kafka 消费组 session.timeout.ms 参数是多少？', 'Kafka 消费组 sessionXtimeoutXms 调整为 45000ms。', false],
  ['SQLite 锁等待 busy_timeout 设为多少？', 'Kafka 消费组重平衡超时参数 session.timeout.ms 已调优为 45000ms。', false],
]) for (const mode of ['sync', 'async']) test('plain-memory source assignment ' + mode + ': ' + q + ' / ' + text, async () => {
  const memories = [{ id: 'a', category: 'experience', spaceId: 'workspace:a', text }];
  const idx = new SearchIndex().addAll(memories);
  idx.search = () => ({ hits: [{ ...memories[0], routes: ['slot'], bm25: 100 }] });
  idx.searchAsync = async () => idx.search();
  const injector = createInjector({ searchIndex: idx });
  try {
    const ctx = { memories, sessionId: 'plain', spaceId: 'workspace:a' };
    const out = mode === 'sync' ? injector.getTierDSync(q, ctx) : await injector.getTierD(q, ctx);
    assert.equal(Boolean(out.text), allowed, JSON.stringify(out));
    if (!allowed) assert.equal(injector.sessionStats(ctx.sessionId).dynamicSeen, 0);
  } finally { injector.dispose(); }
});
