// 专项验收测试：[P3] 三路 RRF 混合检索、O(logN) 槽位证据门与保 KV Cache 两段式动态注入
// 覆盖模块：src/search.mjs, src/rerank.mjs, src/judge.mjs, src/inject.mjs, src/query-expand.mjs, src/llm-select.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import storeMod from '../src/store.mjs';
import {
  SearchIndex,
  index as buildIndex,
  hybridSearch,
  rrfFuse,
} from '../src/search.mjs';
import { rerankCandidates, clearRerankCache } from '../src/rerank.mjs';
import {
  gate,
  gateSlots,
  classifyConflict,
  resolveConflict,
  extractQuantities,
} from '../src/judge.mjs';
import {
  TIER_S_MAX_CHARS,
  TIER_D_MAX_CHARS,
  TOTAL_INJECT_MAX_CHARS,
  createInjector,
  composeTierS,
} from '../src/inject.mjs';

// ============================================================================
// Part 1: 前置作用域过滤、三路 RRF (k=60)、去互斥协同、slot_key 多样性与 Rerank 优雅降级
// ============================================================================

test('1.1 前置 space_id 硬过滤与空间加权（workspace:alpha 1.0 > global 0.85，隔离 workspace:beta）', async () => {
  const store = storeMod.open(':memory:');
  try {
    store.put({
      id: 'mem-ws-alpha',
      spaceId: 'workspace:alpha0000001',
      category: 'fact',
      text: '数据库连接池最大连接数配置为 64，空闲回收间隔 30 秒。',
    });
    store.put({
      id: 'mem-global',
      spaceId: 'global',
      category: 'fact',
      text: '数据库连接池最大连接数默认配置为 32，空闲回收间隔 60 秒。',
    });
    store.put({
      id: 'mem-ws-beta',
      spaceId: 'workspace:beta00000002',
      category: 'fact',
      text: '数据库连接池最大连接数机密配置为 256，空闲回收间隔 10 秒。',
    });

    const res = await hybridSearch(store, '数据库连接池最大连接数配置', {
      spaceId: 'workspace:alpha0000001',
    });

    const hitIds = res.hits.map((h) => h.id);
    assert.ok(hitIds.includes('mem-ws-alpha'), '应命中当前工作区记忆');
    assert.ok(hitIds.includes('mem-global'), '应命中 global 共享记忆');
    assert.ok(!hitIds.includes('mem-ws-beta'), '严禁跨工作区泄露 workspace:beta 记忆');
    assert.equal(res.hits[0].id, 'mem-ws-alpha', '同等相关度下当前工作区 (1.0) 应排在 global (0.85) 之前');
  } finally {
    store.close();
  }
});

test('1.2 三路 RRF (k=60) 精确融合：BM25 + Int8 向量 + entity_slots 槽位图互补召回', async () => {
  // 校验 RRF 数学公式：score(doc) = sum_{route}(1 / (60 + rank_{route}))
  const fusedMap = rrfFuse(
    [['doc-tri', 'doc-bm25-only'], ['doc-vec-only', 'doc-tri'], ['doc-tri', 'doc-slot-only']],
    60,
  );
  const expectedTri = 1 / 61 + 1 / 62 + 1 / 61;
  assert.ok(Math.abs(fusedMap.get('doc-tri') - expectedTri) < 1e-12, '三路 RRF k=60 公式必须严格精确');

  const store = storeMod.open(':memory:');
  try {
    // Doc 1: 词汇面刻意错开查询词（BM25 不命中），但靠向量高余弦召回
    store.put({
      id: 'm-vec-hit',
      spaceId: 'workspace:w1',
      category: 'fact',
      chapter: 1,
      text: '主干集群心跳探针在断网重连阶段采用指数退避算法。',
    });
    // Doc 2: 含精确结构化槽位 (Redis网关, 超时阈值, 4500ms)
    store.put({
      id: 'm-slot-tri',
      spaceId: 'workspace:w1',
      category: 'fact',
      chapter: 2,
      slotKey: 'redis网关::超时阈值',
      text: 'Redis网关的超时阈值是 4500ms。',
      slots: [{ entity: 'Redis网关', attr: '超时阈值', value: '4500', unit: 'ms', polarity: 'affirm', confidence: 0.95, quote: 'Redis网关的超时阈值是 4500ms' }],
    });
    // Doc 3: 仅普通词项弱沾边
    store.put({
      id: 'm-bm25-weak',
      spaceId: 'workspace:w1',
      category: 'fact',
      chapter: 3,
      text: '日志采集代理记录了一次网关超时事件。',
    });

    store.putVector({ memoryId: 'm-vec-hit', vec: new Int8Array([100, 90, 0, 0]) });
    store.putVector({ memoryId: 'm-slot-tri', vec: new Int8Array([95, 85, 10, 0]) });
    store.putVector({ memoryId: 'm-bm25-weak', vec: new Int8Array([-50, 10, 80, 0]) });

    const res = await hybridSearch(store, 'Redis网关的超时阈值是多少', {
      spaceId: 'workspace:w1',
      queryVector: new Int8Array([98, 88, 5, 0]),
      rrfK: 60,
    });

    assert.equal(res.hits[0].id, 'm-slot-tri', '同时命中 BM25 + Vector + Slot 三路的文档必须以最高 RRF 分置顶');
    assert.deepEqual(
      res.hits[0].routes.slice().sort(),
      ['bm25', 'slot', 'vector'],
      '置顶命中必须完整标记三条召回路来源',
    );
    assert.ok(res.hits.some((h) => h.id === 'm-vec-hit'), 'BM25 零命中但向量高相似的文档应经路 B 召回进入融合结果');
  } finally {
    store.close();
  }
});

test('1.3 解除互斥限制：expand + vector + slot + rerank + llmSelect 五阶段同轮协同与超时优雅降级', async () => {
  clearRerankCache();
  const idx = buildIndex([
    {
      id: 'd1',
      spaceId: 'workspace:p3',
      chapter: 1,
      slotKey: 'auth::token_ttl',
      text: '鉴权服务 JWT 令牌有效期为 7200 秒。',
      slots: [{ entity: '鉴权服务', attr: '令牌有效期', value: '7200', unit: '秒' }],
    },
    {
      id: 'd2',
      spaceId: 'workspace:p3',
      chapter: 2,
      slotKey: 'auth::refresh_ttl',
      text: '刷新票据轮换窗口设定为 14 天。',
      slots: [{ entity: '刷新票据', attr: '轮换窗口', value: '14', unit: '天' }],
    },
    {
      id: 'd3',
      spaceId: 'workspace:p3',
      chapter: 3,
      slotKey: 'cdn::cache_ttl',
      text: '边缘节点静态资源缓存周期为 3600 秒。',
    },
  ]);
  idx.setVectors(new Map([
    ['d1', new Int8Array([80, 20, 10, 0])],
    ['d2', new Int8Array([85, 40, 20, 0])],
    ['d3', new Int8Array([10, 90, 0, 0])],
  ]));

  // 五路协同全开：expand 扩出「刷新票据轮换窗口」+ vector + slot + rerank + llmSelect
  const fullRes = await idx.searchAsync('鉴权令牌有效期与会话续期策略', {
    spaceId: 'workspace:p3',
    expand: true,
    expandFn: async (q) => ({
      queries: [q, '刷新票据 轮换窗口'],
      expanded: true,
      degraded: null,
      ms: 2,
    }),
    embed: async () => [new Int8Array([82, 35, 15, 0])],
    rerank: true,
    rerankFn: async (_q, docs) => docs.map((_, i) => ({ index: i, score: 0.9 - i * 0.1 })),
    llmSelect: true,
    selectFn: async (_q, pool) => {
      const pickIdx = pool.findIndex((t) => t.includes('刷新票据'));
      return { picks: pickIdx >= 0 ? [pickIdx] : [0], degraded: 'none', ms: 3, tokensIn: 50, tokensOut: 5, pool: pool.length };
    },
  });

  assert.equal(fullRes.expansion.expanded, true, 'query-expand 应与 vector/slot/llmSelect 同轮生效');
  assert.equal(fullRes.scan.vector.used, true, '向量路应同轮生效');
  assert.equal(fullRes.scan.slots.used, true, 'entity_slots 槽位路应同轮生效');
  assert.equal(fullRes.scan.rerank.used, true, 'rerank 应同轮生效');
  assert.equal(fullRes.scan.selection.degraded, 'none', 'llm-select 应直接消费融合池生效');
  assert.equal(fullRes.hits[0].id, 'd2', 'llm-select 选中的扩展融合段应成功置顶');

  // 验证在线 rerank 超时/抛错时优雅降级回退 RRF 原序
  const fallbackRes = await idx.searchAsync('鉴权服务 令牌有效期', {
    spaceId: 'workspace:p3',
    embed: async () => [new Int8Array([90, 15, 5, 0])],
    rerank: true,
    rerankFn: async () => {
      throw new Error('upstream reranker timeout 504');
    },
  });
  assert.equal(fallbackRes.scan.rerank.used, false);
  assert.equal(fallbackRes.scan.rerank.degraded, 'fallback-rrf');
  assert.equal(fallbackRes.hits[0].id, 'd1', 'rerank 异常时必须无损回退三路 RRF 第一名');

  // 直接验证 rerankCandidates 辅助函数在 null 返回时保留原序
  const rrDirect = await rerankCandidates('测试', [{ doc: { id: 'a', text: '甲' }, score: 0.5 }], {
    rerankFn: async () => null,
  });
  assert.equal(rrDirect.used, false);
  assert.equal(rrDirect.items[0].doc.id, 'a');
});

test('1.4 slot_key 去重与多样性装填：防止同槽多版本历史挤占检索预算', () => {
  const idx = buildIndex([
    { id: 'v3', chapter: 1, slotKey: 'api::port', importance: 0.9, text: '网关服务监听端口已定为 8443 端口。' },
    { id: 'v2', chapter: 1, slotKey: 'api::port', importance: 0.6, text: '网关服务监听端口曾设为 8081 端口。' },
    { id: 'v1', chapter: 1, slotKey: 'api::port', importance: 0.4, text: '网关服务监听端口最初是 8080 端口。' },
    { id: 'worker', chapter: 1, slotKey: 'worker::port', importance: 0.5, text: '异步队列服务监听端口定为 9090 端口。' },
  ]);

  const res = idx.search('服务监听端口', { limit: 2, dedupeSlotKey: true });
  assert.equal(res.hits.length, 2);
  assert.deepEqual(
    res.hits.map((h) => h.id),
    ['v3', 'worker'],
    '按 slot_key 去重后应保留最高分 api::port 并装入 worker::port 保证槽位多样性',
  );
});

// ============================================================================
// Part 2: O(log N) entity_slots 证据门与三分冲突判定（零全表扫描 + 根除副词误报）
// ============================================================================

test('2.1 entity_slots SQL 索引毫秒级 O(log N) 证据门：精确区分缺实体/缺属性/缺值，零全表扫描', () => {
  const store = storeMod.open(':memory:');
  try {
    // 灌入 500 条背景记忆验证索引 O(log N) 延迟与零全表扫描
    for (let i = 0; i < 500; i += 1) {
      store.put({
        id: `bg-${i}`,
        spaceId: 'workspace:gate-bench',
        category: 'fact',
        text: `节点Node${i}的并发上限是 ${100 + i} 个。`,
      });
    }
    store.put({
      id: 'target-order-svc',
      spaceId: 'workspace:gate-bench',
      category: 'fact',
      text: '订单引擎的超时时间是 3000ms，重试上限是 3 次。',
      slots: [
        { entity: '订单引擎', attr: '超时时间', value: '3000', unit: 'ms', polarity: 'affirm', confidence: 0.95 },
        { entity: '订单引擎', attr: '重试上限', value: '3', unit: '次', polarity: 'affirm', confidence: 0.95 },
      ],
    });

    // 构造带 SQL 探针的代理 store：一旦任何人调 dump() 或 list({ includeText: true }) 扫全表立即抛错！
    let slotQueryCalls = 0;
    const guardedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'dump') {
          return () => { throw new Error('FORBIDDEN: 严禁证据门全表 dump 扫描 memories.text'); };
        }
        if (prop === 'raw') {
          return () => { throw new Error('FORBIDDEN: 严禁绕过索引直扫底层连接 SELECT text FROM memories'); };
        }
        if (prop === 'querySlots') {
          return (qOpts) => {
            slotQueryCalls += 1;
            return target.querySlots(qOpts);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const t0 = performance.now();
    // 1) 缺实体
    const gMissingEntity = gate('支付网关的超时时间是多少？', guardedStore, { spaceId: 'workspace:gate-bench' });
    // 2) 实体存在，缺属性
    const gMissingAttr = gate('订单引擎的缓存容量是多少？', guardedStore, { spaceId: 'workspace:gate-bench' });
    // 3) 实体+属性存在，核验错误值 -> 缺值
    const gMissingValue = gateSlots('订单引擎的超时时间是 9000ms 吗？', guardedStore, { spaceId: 'workspace:gate-bench' });
    // 4) 实体+属性+正确值 -> 命中放行
    const gHitValue = gate('订单引擎的超时时间是 3000ms 吗？', guardedStore, { spaceId: 'workspace:gate-bench' });
    // 5) 实体+属性开放提问 -> 命中放行
    const gHitOpen = gate('订单引擎的超时时间是多少？', guardedStore, { spaceId: 'workspace:gate-bench' });
    const elapsedMs = performance.now() - t0;

    assert.equal(gMissingEntity.deny, true);
    assert.equal(gMissingEntity.missing, 'entity');
    assert.equal(gMissingEntity.reason, 'entity-not-recorded');

    assert.equal(gMissingAttr.deny, true);
    assert.equal(gMissingAttr.missing, 'attribute');
    assert.equal(gMissingAttr.reason, 'attribute-not-recorded');

    assert.equal(gMissingValue.deny, true);
    assert.equal(gMissingValue.missing, 'value');
    assert.equal(gMissingValue.reason, 'value-not-recorded');

    assert.equal(gHitValue.deny, false);
    assert.equal(gHitValue.missing, null);
    assert.equal(gHitValue.reason, 'hit');

    assert.equal(gHitOpen.deny, false);
    assert.equal(gHitOpen.reason, 'hit');

    assert.ok(slotQueryCalls >= 5, '必须实际走 entity_slots SQL 索引查询');
    assert.ok(elapsedMs < 500, `5 次 O(log N) 证据门总耗时应处于毫秒级（实测 ${elapsedMs.toFixed(2)}ms）`);
  } finally {
    store.close();
  }
});

test('2.2 冲突三分判定（supersession 覆写 vs conditional 条件共存 vs disputed 双侧呈现）与根除副词量词误报', () => {
  // A. 副词量词与序数步骤零误报验证
  const adverbMems = [
    { id: 'adv-1', createdAt: 100, text: '部署脚本第一步先检查一下网关配置，失败时重试一次并退一步记录日志。' },
    { id: 'adv-2', createdAt: 200, text: '部署脚本第二步再核对一般网关配置，异常时重试两次并进一步输出栈信息。' },
  ];
  assert.equal(extractQuantities(adverbMems[0].text).length, 0, '一次/一下/一步/第一步 等副词与序数词不得被抽成物理数值');
  const advRes = resolveConflict(adverbMems);
  assert.equal(advRes.conflicts.length, 0, '副词量词与序数词严禁触发假阳性冲突');

  // B. 1) supersession：显式更正覆写
  const supRes = resolveConflict([
    { id: 's-old', createdAt: 1000, slotKey: 'rpc::timeout', text: '订单RPC调用超时时间原为 2000ms。' },
    { id: 's-new', createdAt: 2000, slotKey: 'rpc::timeout', supersedes: ['s-old'], text: '订单RPC调用超时时间现改为 5000ms。' },
  ]);
  assert.equal(supRes.conflicts.length, 1);
  assert.equal(supRes.conflicts[0].conflictType, 'supersession');
  assert.equal(supRes.conflicts[0].presentation, 'winner-only');
  assert.equal(supRes.conflicts[0].current, '5000ms');
  assert.ok(supRes.superseded.length >= 1, 'supersession 应将旧值归入 superseded');

  // C. 2) conditional：环境条件共存（不互相覆写）
  const condRes = resolveConflict([
    { id: 'c-dev', createdAt: 1000, slotKey: 'db::pool', text: '在开发环境下数据库连接池上限是 10 人。' },
    { id: 'c-prod', createdAt: 2000, slotKey: 'db::pool', text: '在生产环境下数据库连接池上限是 200 人。' },
  ]);
  assert.equal(condRes.conflicts.length, 1);
  assert.equal(condRes.conflicts[0].conflictType, 'conditional');
  assert.equal(condRes.conflicts[0].presentation, 'coexist');
  assert.equal(condRes.superseded.length, 0, 'conditional 条件共存不得销毁任一侧记忆');
  assert.equal(condRes.conditional.length, 1);

  // D. 3) disputed：无条件、无显式修订链的同槽互斥值 -> 双侧呈现
  const dispRes = resolveConflict([
    { id: 'd-a', createdAt: 1000, slotKey: 'pay::port', text: '清算服务监听端口是 7001，对接内部账务总线。' },
    { id: 'd-b', createdAt: 2000, slotKey: 'pay::port', text: '清算服务监听端口是 7009，对接内部账务总线。' },
  ]);
  assert.equal(dispRes.conflicts.length, 1);
  assert.equal(dispRes.conflicts[0].conflictType, 'disputed');
  assert.equal(dispRes.conflicts[0].presentation, 'dual-side');
  assert.equal(dispRes.disputed.length, 1);
  assert.ok(dispRes.conflicts[0].dualSide, 'disputed 必须产出 dualSide 双侧结构');
  assert.equal(dispRes.conflicts[0].dualSide.prior.id, 'd-a');
  assert.equal(dispRes.conflicts[0].dualSide.latest.id, 'd-b');

  // 直接校验 classifyConflict 导出签名
  const directTri = classifyConflict(
    { id: 'x1', text: '归档保留期 30天', value: '30天', at: 1 },
    { id: 'x2', text: '归档保留期 90天', value: '90天', at: 2 },
  );
  assert.equal(directTri.type, 'disputed');
  assert.equal(directTri.presentation, 'dual-side');
});

// ============================================================================
// Part 3: 两段式动态注入引擎（Tier-S 字节恒定保 KV Cache + Tier-D 动态去重与 0 字符准则）
// ============================================================================

test('3.1 根除 manualEvent >= 6 饿死自动记忆 Bug：10 条手工记忆在场时 auto:* 记忆照常动态召回', async () => {
  const store = storeMod.open(':memory:');
  try {
    for (let i = 1; i <= 10; i += 1) {
      store.put({
        id: `manual-ev-${i}`,
        spaceId: 'workspace:deadlock-fix',
        category: 'event',
        source: 'manual:cli',
        text: `历史手工归档纪要第 ${i} 号：前端静态图标样式微调已完成。`,
      });
    }
    store.put({
      id: 'auto-critical-1',
      spaceId: 'workspace:deadlock-fix',
      category: 'fact',
      source: 'auto:chat:v2#sess-99#t3',
      text: 'Kafka 消费组重平衡超时参数 session.timeout.ms 已调优为 45000ms。',
    });

    const injector = createInjector({ store });
    const res = await injector.inject('Kafka 消费组 session.timeout.ms 参数是多少？', {
      sessionId: 'sess-anti-starve',
      spaceId: 'workspace:deadlock-fix',
    });

    assert.ok(res.tierD.includes('45000ms'), '存在 >=6 条手工 event 时，auto:* 自动记忆绝不能被饿死');
    assert.ok(res.tierDIds.includes('auto-critical-1'));
    assert.ok(res.withinBudget);
  } finally {
    store.close();
  }
});

test('3.2 Tier-S 静态热底座：聚合 rule + profile + 冻结 state，<= 600 字符，单会话生命周期内字节 100% 恒定不变', async () => {
  const store = storeMod.open(':memory:');
  try {
    store.put({
      id: 'rule-1',
      spaceId: 'workspace:kv',
      category: 'rule',
      importance: 1.0,
      text: '所有 SQL 查询必须走参数化预编译，严禁字符串拼接。',
    });
    store.put({
      id: 'profile-1',
      spaceId: 'global',
      category: 'profile',
      importance: 0.9,
      text: 'YG 偏好精炼直接的架构级技术汇报，不看空洞套话。',
    });
    store.putState({
      spaceId: 'workspace:kv',
      slotKey: 'release::phase',
      text: '当前发布阶段：v2.0-alpha 联调中。',
    });
    store.putState({
      spaceId: 'workspace:kv',
      slotKey: 'release::phase',
      text: '当前发布阶段：v2.0-rc1 灰度验证中。',
    });
    // 再塞入超长低优 rule 验证 <= 600 硬裁剪
    store.put({
      id: 'rule-long',
      spaceId: 'global',
      category: 'rule',
      importance: 0.1,
      text: `补充规范：${'严格执行自动化回归门禁与确定性压测校验流程，确保零回归。'.repeat(25)}`,
    });

    const injector = createInjector({ store });
    const turn1 = await injector.inject('你好', { sessionId: 'sess-kv-1', spaceId: 'workspace:kv' });

    assert.ok(turn1.tierSChars > 0 && turn1.tierSChars <= TIER_S_MAX_CHARS, `Tier-S 必须 <= 600 字符（实测 ${turn1.tierSChars}）`);
    assert.ok(turn1.tierS.includes('参数化预编译'), 'Tier-S 应包含 rule');
    assert.ok(turn1.tierS.includes('YG 偏好'), 'Tier-S 应包含 profile');
    assert.ok(turn1.tierS.includes('v2.0-rc1'), 'Tier-S 应包含按 slotKey 收敛后的最新单活 state');
    assert.ok(!turn1.tierS.includes('v2.0-alpha'), '同 slotKey 的过期 state 不得混入 Tier-S');

    // 会话中途向数据库新增 rule 与更新 state，模拟在线写入扰动
    store.put({
      id: 'rule-mid-session',
      spaceId: 'workspace:kv',
      category: 'rule',
      importance: 1.0,
      text: '中途新增强制规则：禁止修改线上迁移锁表。',
    });
    store.putState({
      spaceId: 'workspace:kv',
      slotKey: 'release::phase',
      text: '当前发布阶段：v2.0-GA 已全量上线。',
    });

    const turn2 = await injector.inject('继续查看项目结构', { sessionId: 'sess-kv-1', spaceId: 'workspace:kv' });
    assert.equal(turn2.frozenTierS, true);
    assert.equal(
      Buffer.compare(Buffer.from(turn1.tierS, 'utf8'), Buffer.from(turn2.tierS, 'utf8')),
      0,
      '同一会话内 Tier-S 必须逐字节 100% 恒定不变以保住 System Prompt Prefix KV Cache',
    );

    // Compaction 后 Tier-S 依然必须字节恒定不变
    injector.onCompaction('sess-kv-1');
    const turn3 = await injector.inject('帮我看下鉴权逻辑', { sessionId: 'sess-kv-1', spaceId: 'workspace:kv' });
    assert.equal(turn3.tierS, turn1.tierS, '会话 Compaction 不得破坏 Tier-S 静态前缀字节恒定');

    // 会话结束后开启新会话：新会话应加载最新 state (v2.0-GA)
    injector.onSessionEnd('sess-kv-1');
    assert.equal(injector.sessionStats('sess-kv-1').exists, false, 'onSessionEnd 应彻底释放会话状态');

    const newSess = await injector.inject('你好', { sessionId: 'sess-kv-2', spaceId: 'workspace:kv' });
    assert.ok(newSess.tierS.includes('v2.0-GA'), '新会话启动时应冻结最新单活 state');
    assert.ok(newSess.tierSChars <= TIER_S_MAX_CHARS);
  } finally {
    store.close();
  }
});

test('3.3 Tier-D 按问动态召回、SessionSeen 多轮去重、Compaction 重召回与总预算 <= 1500 硬门禁', async () => {
  const store = storeMod.open(':memory:');
  try {
    store.put({
      id: 'r-base',
      spaceId: 'workspace:dyn',
      category: 'rule',
      importance: 1.0,
      text: `核心红线：${'所有核心链路变更必须附带基准压测对比数据与回滚预案。'.repeat(12)}`,
    });
    store.put({
      id: 'f-redis',
      spaceId: 'workspace:dyn',
      category: 'fact',
      slotKey: 'redis::sentinel',
      text: 'Redis 哨兵集群主节点别名为 mymaster-prod，故障转移投票法定人数 quorum 设为 2。',
    });
    store.put({
      id: 'f-pg',
      spaceId: 'workspace:dyn',
      category: 'fact',
      slotKey: 'pg::wal',
      text: `PostgreSQL 归档策略：wal_level 设为 replica，保留最近 72 小时预写日志。${'备份校验每日凌晨执行。'.repeat(40)}`,
    });

    const injector = createInjector({ store });

    // 第 1 轮：命中 Redis 记忆
    const r1 = await injector.inject('Redis 哨兵主节点别名和 quorum 是多少？', {
      sessionId: 'sess-d1',
      spaceId: 'workspace:dyn',
    });
    assert.ok(r1.tierD.includes('mymaster-prod'), '第 1 轮应动态召回并注入 Redis 事实');
    assert.ok(r1.tierDChars <= TIER_D_MAX_CHARS, `Tier-D 必须 <= 900 字符（实测 ${r1.tierDChars}）`);
    assert.ok(r1.totalChars <= TOTAL_INJECT_MAX_CHARS, `总注入必须 <= 1500 字符（实测 ${r1.totalChars}）`);

    // 第 2 轮：重复追问同一事实 -> SessionSeen 拦截，严格 0 字符注入
    const r2 = await injector.inject('再确认下 Redis 哨兵主节点别名和 quorum？', {
      sessionId: 'sess-d1',
      spaceId: 'workspace:dyn',
    });
    assert.equal(r2.tierD, '', '同一会话已注入过的事实不得在后续轮次重复灌入');
    assert.equal(r2.tierDChars, 0);
    assert.equal(r2.tierDReason, 'all-seen');

    // 第 3 轮：换问超长 PostgreSQL 记忆 -> 正常注入新记忆且严格裁剪在 <= 900 字符内
    const r3 = await injector.inject('PostgreSQL 的 wal_level 归档策略是什么？', {
      sessionId: 'sess-d1',
      spaceId: 'workspace:dyn',
    });
    assert.ok(r3.tierD.includes('wal_level'));
    assert.ok(r3.tierDChars > 0 && r3.tierDChars <= TIER_D_MAX_CHARS, `超长记忆装填也必须 <= 900 字符（实测 ${r3.tierDChars}）`);
    assert.ok(r3.totalChars <= TOTAL_INJECT_MAX_CHARS, `单步总注入必须 <= 1500 字符（实测 ${r3.totalChars}）`);

    // 触发会话 Compaction：历史动态消息被折叠后，再次询问 Redis 应允许重新召回！
    const comp = injector.onCompaction('sess-d1');
    assert.ok(comp.releasedDynamic >= 2);
    const r4 = await injector.inject('Redis 哨兵主节点别名是什么？', {
      sessionId: 'sess-d1',
      spaceId: 'workspace:dyn',
    });
    assert.ok(r4.tierD.includes('mymaster-prod'), 'Compaction 释放动态 SessionSeen 后应能重新按需注入');
    assert.equal(r4.tierS, r1.tierS, 'Tier-S 在整个过程中保持逐字节不变');
  } finally {
    store.close();
  }
});

test('3.4 Tier-D 零开销准则：工具子步骤、子代理回执、寒暄与无关提问（含低分向量噪声）严格返回 0 字符', async () => {
  const store = storeMod.open(':memory:');
  try {
    store.put({
      id: 'mem-domain-1',
      spaceId: 'workspace:zero',
      category: 'fact',
      text: '支付清算引擎采用双账本幂等校验协议，批处理窗口为每日 02:00。',
    });
    // 故意写入向量，制造「无关提问在向量表里仍有低余弦候选」的真实陷阱
    store.putVector({ memoryId: 'mem-domain-1', vec: new Int8Array([100, 0, 0, 0]) });

    const injector = createInjector({ store });

    // 1) 工具子步骤
    const subStepRes = await injector.inject('支付清算引擎批处理窗口', {
      sessionId: 'sess-zero',
      spaceId: 'workspace:zero',
      isToolSubstep: true,
    });
    assert.equal(subStepRes.tierD, '');
    assert.equal(subStepRes.tierDChars, 0);
    assert.equal(subStepRes.tierDReason, 'tool-substep');

    // 2) role = tool
    const toolRoleRes = await injector.inject('支付清算引擎', {
      sessionId: 'sess-zero',
      spaceId: 'workspace:zero',
      role: 'tool',
    });
    assert.equal(toolRoleRes.tierD, '');
    assert.equal(toolRoleRes.tierDChars, 0);

    // 3) 子代理会话步
    const subagentRes = await injector.inject('支付清算引擎', {
      sessionId: 'sess-zero',
      spaceId: 'workspace:zero',
      header: { origin: 'subagent', delegationDepth: 1 },
    });
    assert.equal(subagentRes.tierD, '');
    assert.equal(subagentRes.tierDChars, 0);

    // 4) 纯寒暄/确认词
    const greetRes = await injector.inject('好的，收到！', {
      sessionId: 'sess-zero',
      spaceId: 'workspace:zero',
    });
    assert.equal(greetRes.tierD, '');
    assert.equal(greetRes.tierDChars, 0);
    assert.equal(greetRes.tierDReason, 'trivial-utterance');

    // 5) 与记忆库毫无关联的提问（且传入正交/弱相关查询向量，检验向量低置信度门禁）
    const unrelatedRes = await injector.inject('今天雷克雅未克的极光观测指数和气温是多少？', {
      sessionId: 'sess-zero',
      spaceId: 'workspace:zero',
      queryVector: new Int8Array([10, 95, 20, 0]), // cos ≈ 0.10，远低于 0.35 / 0.55 门禁
    });
    assert.equal(unrelatedRes.tierD, '', '无关提问即使开启向量检索也绝不能塞入低置信度噪声记忆');
    assert.equal(unrelatedRes.tierDChars, 0);
  } finally {
    store.close();
  }
});

test('3.5 composeTierS 极端长文本边界校验：任何输入组合下均严格 <= 600 字符', () => {
  const hugeMems = Array.from({ length: 20 }, (_, i) => ({
    id: `huge-${i}`,
    spaceId: 'workspace:bound',
    category: i % 3 === 0 ? 'rule' : i % 3 === 1 ? 'profile' : 'state',
    slotKey: `slot::${i}`,
    importance: 1 - i * 0.02,
    text: `第${i}条超长规则文本：${'必须在高并发场景下保持严格幂等与零锁竞争。'.repeat(10)}`,
  }));
  const res = composeTierS(hugeMems, { spaceId: 'workspace:bound' });
  assert.ok(res.chars <= TIER_S_MAX_CHARS, `composeTierS 输出长度 ${res.chars} 超过 600 上限`);
  assert.equal(res.text.length, res.chars);
});
