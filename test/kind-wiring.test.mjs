import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_TIER_EVENT,
  MEMORY_TIER_PINNED,
  open,
  resetPinTierWarnings,
} from '../src/store.mjs';
import { CAPTURE_KINDS, formatSource } from '../src/auto-capture.mjs';
import { classifyCaptureKind } from '../src/kind-classify.mjs';
import { apply } from '../src/index.mjs';

// ═══ 一、store 层的钉住闸门 ═══════════════════════════════════════════════

test('strictPinnedTier：手工 put({kind:"person", tier:4}) 直接被拒且不落库', () => {
  const store = open(':memory:', { strictPinnedTier: true });
  try {
    assert.throws(
      () => store.put({ text: '我一般用 pnpm 管依赖', kind: 'person', tier: 4 }),
      (err) => err instanceof TypeError && /必须钉在 tier 1/.test(err.message),
    );
    assert.equal(store.stats().memories, 0, '被拒的写入不该留下任何行');

    // 不显式给 tier 时走 defaultTier，正常钉在 1
    const ok = store.put({ text: '我是做后端的，主要写 Node 服务', kind: 'person' });
    assert.equal(ok.tier, MEMORY_TIER_PINNED);
    assert.equal(ok.kind, 'person');
  } finally {
    store.close();
    resetPinTierWarnings();
  }
});

test('默认模式保持既有契约：person 的显式 tier 被钳回 1，并留下一次可查的告警', () => {
  resetPinTierWarnings();
  const said = [];
  const original = console.warn;
  console.warn = (...args) => { said.push(args.map(String).join(' ')); };
  try {
    const store = open(':memory:');
    try {
      const res = store.put({ text: '我讨厌荧光灯的色温', kind: 'person', tier: 4 });
      assert.equal(res.tier, MEMORY_TIER_PINNED);
      assert.equal(Number(store.get(res.id, false).tier), MEMORY_TIER_PINNED);
      // 同一条 (kind,tier) 第二次不再刷屏
      store.put({ text: '我讨厌荧光灯的色温太冷', kind: 'person', tier: 4 });
    } finally {
      store.close();
    }
  } finally {
    console.warn = original;
  }
  const mine = said.filter((line) => line.includes('kind=person') && line.includes('钳回'));
  assert.equal(mine.length, 1, `应当只有一次告警，实际：${JSON.stringify(said)}`);
});

// ═══ 二、降级通道 ═════════════════════════════════════════════════════════

test('setKind 降级：person → event，tier 从 Pinned 落到 event 档，正文与 id 不变', () => {
  const store = open(':memory:');
  try {
    const { id } = store.put({
      text: '我一般用 pnpm 管依赖，很少装全局包',
      kind: 'person',
      source: 'auto:chat:v2#eDoxOHQx|k:person',
    });
    assert.equal(Number(store.get(id, false).tier), MEMORY_TIER_PINNED);

    assert.deepEqual(store.setKind(id, 'event'), {
      id, kindBefore: 'person', tierBefore: 1, kind: 'event', tier: 3, changed: true,
    });
    const row = store.get(id, false);
    assert.equal(row.kind, 'event');
    assert.equal(Number(row.tier), MEMORY_TIER_EVENT);
    assert.equal(row.text, '我一般用 pnpm 管依赖，很少装全局包', '正文必须一字不动');
    assert.equal(store.stats().kinds.person, 0);
    assert.equal(store.stats().kinds.event, 1);

    // 幂等：再降一次是 no-op，不报错也不改 tier
    assert.deepEqual(store.setKind(id, 'event'), {
      id, kindBefore: 'event', tierBefore: 3, kind: 'event', tier: 3, changed: false,
    });

    // 反向提升同样走这条通道（人工纠正后再改回来）
    assert.equal(store.setKind(id, 'person').tier, MEMORY_TIER_PINNED);
    assert.equal(store.stats().kinds.person, 1);

    assert.equal(store.setKind('no-such-id', 'event'), null);
  } finally {
    store.close();
  }
});

// ═══ 三、apply 端到端 ═════════════════════════════════════════════════════

function fixture(options = {}) {
  const tools = new Map();
  const hooks = new Map();
  let api = null;
  // 假时钟：采集配额的冷却（默认 5s）在换轮时判定，测试必须能推进时间。
  let clock = 1_700_000_000_000;
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    provide: (_name, value) => { api = value; return () => {}; },
    effect: (fn) => fn(),
    on: (name, fn) => { hooks.set(name, fn); return () => {}; },
  };
  apply(ctx, { dbPath: ':memory:', vector: false, now: () => clock, ...options });
  const step = (sessionId, turn, texts) => {
    clock += 60_000;
    const messages = texts.map((text) => ({
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
    }));
    const decision = { kind: 'enter', messages };
    return hooks.get('agent/pre-step')({ agent: { session: { id: sessionId } }, turn }, async () => decision);
  };
  return { step, tools, api: () => api };
}

const CONVERSATION = [
  { turn: 1, text: '记住，提交前必须跑测试，别再直接推 main', kind: 'promise' },
  { turn: 2, text: '以后都用 pnpm 装依赖，别用 npm 装', kind: 'promise' },
  { turn: 3, text: '我一般用 pnpm 管依赖，很少装全局包', kind: 'person' },
  { turn: 4, text: '我讨厌荧光灯的色温，写代码只开暖光', kind: 'person' },
  { turn: 5, text: '我现在很累，明天再改这块代码', kind: 'event' },
];

test('端到端 5 条真实风格消息：kind 判定 → 独立配额 → 落库 tier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mj-kw-'));
  const dbPath = join(dir, 'memjudge.db');
  const f = fixture({ dbPath });
  const landed = [];
  try {
    for (const item of CONVERSATION) {
      await f.step('e2e', item.turn, [item.text]);
      const rows = f.api().bySourcePrefix(formatSource('e2e', item.turn), 10);
      assert.equal(rows.length, 1, `turn${item.turn} 应恰好落一条，实际 ${rows.length}`);
      landed.push({ ...item, id: rows[0].id, storedKind: rows[0].kind, source: rows[0].source });
    }

    for (const row of landed) {
      assert.equal(row.storedKind, row.kind, `turn${row.turn} kind 不符：${row.text}`);
    }

    // 非 event 的自动写入必须带可追溯标记；event 不得带（存量事件流格式不变）
    const tagged = landed.filter((row) => row.kind !== 'event');
    assert.equal(tagged.length, 4);
    for (const row of tagged) {
      assert.ok(row.source.endsWith(`|k:${row.kind}`), `缺 kind 标记：${row.source}`);
    }
    assert.equal(landed[4].source.includes('|k:'), false, 'event 不该带 kind 标记');

    const stats = await f.tools.get('memjudge_stats').execute({});
    assert.equal(stats.kinds.person, 2);
    assert.equal(stats.kinds.promise, 2);
    assert.equal(stats.kinds.event, 1);

    // 落库 tier：person/promise 钉在 1，event 在 3。另开只读连接核对盘上真实值
    const disk = open(dbPath);
    try {
      for (const row of landed) {
        const expect = row.kind === 'event' ? MEMORY_TIER_EVENT : MEMORY_TIER_PINNED;
        assert.equal(Number(disk.get(row.id, false).tier), expect, `id ${row.id} tier 不符`);
      }
      assert.deepEqual(disk.stats().kinds, { person: 2, promise: 2, event: 1 });
    } finally {
      disk.close();
    }
  } finally {
    // Windows 上 apply 的库连接仍持有句柄，删临时目录可能 EPERM；内容校验已在上面完成。
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 交给系统临时目录回收 */ }
  }
});

test('同轮两条 person：过独立配额只写第一条（1 条/轮）', async () => {
  const f = fixture();
  await f.step('q1', 1, [
    '我一般用 pnpm 管依赖，很少装全局包',
    '我讨厌荧光灯的色温，写代码只开暖光',
  ]);
  const stats = await f.tools.get('memjudge_stats').execute({});
  assert.equal(stats.kinds.person, 1, '同轮第二条 person 必须被 1 条/轮 配额挡掉');
  assert.equal(stats.kinds.event, 0, '超配额的条目整条丢弃，不降级成 event 顶包');
  assert.equal(stats.memories, 1);

  // 下一轮重新有额度（换一条不同属性的事实，避免撞上同槽判重）
  await f.step('q1', 2, ['我在合肥工作，主要写 Node 服务']);
  assert.equal((await f.tools.get('memjudge_stats').execute({})).kinds.person, 2);
});

test('同实体同属性不重复写：同槽事实被挡，改值则允许更新', async () => {
  const f = fixture();
  await f.step('d1', 1, ['我的编辑器是VSCode，平时不换']);
  assert.equal((await f.tools.get('memjudge_stats').execute({})).kinds.person, 1);

  // 同一槽位的更短表述：核心串互为子串 → 判重（相似度低于 dupThreshold，确实走到槽比对）
  await f.step('d1', 2, ['我的编辑器是VSCode']);
  assert.equal((await f.tools.get('memjudge_stats').execute({})).kinds.person, 1, '同槽重复不该再写');

  // 同属性不同取值：是更新，允许写入
  await f.step('d1', 3, ['我的编辑器是Zed，不再用VSCode']);
  assert.equal((await f.tools.get('memjudge_stats').execute({})).kinds.person, 2, '改值应当允许');
});

test('memjudge_demote 工具：person 降成 event 后 stats 归位，read/recall 仍拿得到原文', async () => {
  const f = fixture();
  await f.step('m1', 1, ['我的编辑器是VSCode，平时不换']);
  const [row] = f.api().byKind('person', 50);
  assert.ok(row, '应当先有一条 person');

  assert.deepEqual(await f.tools.get('memjudge_demote').execute({ id: row.id }), {
    found: true, id: row.id, changed: true,
    kindBefore: 'person', tierBefore: 1, kind: 'event', tier: 3,
  });

  const stats = await f.tools.get('memjudge_stats').execute({});
  assert.equal(stats.kinds.person, 0);
  assert.equal(stats.kinds.event, 1);

  const read = await f.tools.get('memjudge_read').execute({ id: row.id });
  assert.equal(read.found, true);
  assert.ok(read.text.includes('VSCode'), '降级不删内容');

  const recall = await f.tools.get('memjudge_recall').execute({ query: '编辑器 VSCode' });
  assert.equal(recall.denied, false);
  assert.ok(recall.hits.some((hit) => hit.id === row.id), '降级后仍应能召回');

  assert.equal((await f.tools.get('memjudge_demote').execute({ id: row.id })).changed, false);
  assert.equal((await f.tools.get('memjudge_demote').execute({ id: 'nope' })).found, false);
});

test('person 的来源白名单没被放宽：CAPTURE_KINDS 仍只含 user，assistant 内容永不升格', () => {
  assert.deepEqual([...CAPTURE_KINDS], ['user']);
  const looksLikeUser = '我是做后端的，主要写 Node 服务';
  assert.equal(classifyCaptureKind(looksLikeUser, { role: 'assistant' }).kind, 'event');
  assert.equal(classifyCaptureKind(looksLikeUser, { role: 'user' }).kind, 'person');
});
