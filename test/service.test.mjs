// memjudge 只读服务契约（ctx.provide('memjudge', ...)）的验收测试。
// 运行：node --test test/service.test.mjs
//
// 这套用例对着四个真实风险面写：
//   1. 「只读」被写脏：服务面上出现任何写方法就必须在装配期当场炸，不能等下游调了才发现。
//   2. 前缀查询把 `_` / `%` 当通配符：自动采集的 source 是 `auto:chat#<8位token>-t<轮>`，
//      token 里出现 `_` 时含糊匹配会把别人的记忆读进来。
//   3. 下游每轮观测都调一次召回会刷新 lastAccessed / accessCount，把衰减数据冲成噪声。
//      「只读」必须能证明：调用前后 access_count 逐行相等，且对照组（真工具）确实会 +1。
//   4. MockContext 没有 provide（与 auto-capture 接线时踩过的 `.on` 缺失是同一个坑）：
//      apply 里的注册必须守卫，否则既有测试整体崩掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { open } from '../src/store.mjs';
import {
  createService, SERVICE_NAME, SERVICE_VERSION, FORBIDDEN_METHODS,
} from '../src/service.mjs';
import { apply, TOOL_NAMES } from '../src/index.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-service-'));
const T0 = Date.UTC(2026, 9, 27);

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows 上 SQLite 句柄偶尔晚一拍释放，留给系统清理。
  }
});

const FORBIDDEN_RE = new RegExp(FORBIDDEN_METHODS.join('|'), 'i');

/** 递增假时钟：保证 created_at 严格递增，升序断言才有区分力。 */
function clock(start = T0) {
  let t = start;
  return () => {
    t += 1000;
    return t;
  };
}

// ---------------------------------------------------------------- 宿主 mock

/** 复刻 @deepseek-ai/dsh-scope 的 NamedEntries：同层重名直接抛错，不静默覆盖。 */
class NamedEntries {
  constructor(kind) {
    this.kind = kind;
    this.map = new Map();
  }

  insert(name, value) {
    if (this.map.has(name)) throw new Error(`${this.kind} "${name}" is already registered`);
    this.map.set(name, value);
    return () => {
      this.map.delete(name);
    };
  }
}

/**
 * 复刻 cordis Context 的 tools / systemPrompt / effect 三个面，外加 provide。
 * `provide: false` 时不装 provide —— 那是 test/plugin.test.mjs 里真实 MockContext 的形状。
 */
class MockContext {
  constructor(opts = {}) {
    this.tools = new NamedEntries('tool');
    this.systemPrompt = new NamedEntries('prompt section');
    this._effects = [];
    this.services = new Map();
    if (opts.provide !== false) {
      this.provide = (name, service) => {
        if (this.services.has(name)) throw new Error(`service "${name}" is already registered`);
        this.services.set(name, service);
        return () => {
          this.services.delete(name);
        };
      };
    }
  }

  effect(fn) {
    const cleanup = fn();
    const entry = { cleanup, active: true };
    this._effects.push(entry);
    return () => {
      if (!entry.active) return;
      entry.active = false;
      if (typeof entry.cleanup === 'function') entry.cleanup();
    };
  }

  dispose() {
    for (const entry of this._effects.splice(0).reverse()) {
      if (!entry.active) continue;
      entry.active = false;
      if (typeof entry.cleanup === 'function') entry.cleanup();
    }
  }
}

function registerTool(ctx, definition) {
  const output = definition.output;
  if (!output || typeof output !== 'object' || typeof output.render !== 'function') {
    throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`);
  }
  if (definition.name === 'run_code') throw new Error('tool name "run_code" is reserved');
  return ctx.tools.insert(definition.name, definition);
}

function registerSection(ctx, section) {
  if (!Number.isFinite(section.order)) {
    throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
  }
  return ctx.systemPrompt.insert(section.name, section);
}

function hostCtx(opts = {}) {
  const ctx = new MockContext(opts);
  ctx.tools.register = (definition) => registerTool(ctx, definition);
  ctx.systemPrompt.section = (section) => registerSection(ctx, section);
  return ctx;
}

/** 只读打开同一个库文件读 access_count：验证「读」没在衰减数据上留脚印。 */
function accessCounts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT access_count FROM memories ORDER BY created_at ASC, id ASC')
      .all()
      .map((r) => Number(r.access_count));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- 契约面

test('契约面：version + 六个只读方法，没有任何写方法', () => {
  const store = open(':memory:');
  try {
    const api = createService(null, { store });
    assert.equal(api.version, SERVICE_VERSION);
    assert.equal(api.version, '1');

    const keys = Object.keys(api).sort();
    assert.deepEqual(keys, ['byKind', 'bySourcePrefix', 'bySourcePrefixV1', 'occurrencesV1', 'recallByQuery', 'stats', 'version']);

    // 验收要求的那条断言：写方法名一个都不许出现在服务面上。
    for (const key of keys) {
      assert.ok(!FORBIDDEN_RE.test(key), `服务面出现写方法「${key}」`);
    }
    for (const banned of ['forget', 'delete', 'remember', 'update', 'put', 'remove']) {
      assert.equal(
        keys.some((k) => k.toLowerCase().includes(banned)),
        false,
        `服务面出现「${banned}」变体`,
      );
    }

    assert.equal(typeof api.stats, 'function');
    assert.equal(typeof api.recallByQuery, 'function');
    assert.equal(typeof api.bySourcePrefix, 'function');
    assert.equal(typeof api.byKind, 'function');

    // 冻结 + ESM 严格模式：下游改不动契约，装配期就定型。
    assert.ok(Object.isFrozen(api), '服务对象必须冻结');
    assert.throws(() => {
      api.remember = () => {};
    }, TypeError);
  } finally {
    store.close();
  }
});

test('装配校验：deps.store 缺失或方法不全 → TypeError（装配错要在启动期炸）', () => {
  assert.throws(() => createService(null), TypeError);
  assert.throws(() => createService(null, {}), TypeError);
  assert.throws(() => createService(null, { store: { stats() {} } }), TypeError);
  assert.throws(
    () => createService(null, { store: { stats() {}, bySourcePrefix() {}, byKind: 1 } }),
    TypeError,
  );
});

// ---------------------------------------------------------------- stats

test('versioned occurrence service preserves sources, nulls, limits and deletion', async () => {
  const ctx = hostCtx();
  apply(ctx, { dbPath: ':memory:', vector: false });
  try {
    const api = ctx.services.get(SERVICE_NAME);
    const remember = ctx.tools.map.get('memjudge_remember');
    const a = await remember.execute({ text: 'shared occurrence text', source: 'source:A', documentId: 'doc-A', chapter: 1, para: 2 });
    const b = await remember.execute({ text: 'shared occurrence text', source: 'source:B', documentId: 'doc-B', chapter: 3, para: 4 });
    const unknown = await remember.execute({ text: 'unknown occurrence text' });
    assert.equal(a.id, b.id);
    assert.deepEqual(api.occurrencesV1(a.id).map(r => r.source), ['source:A', 'source:B']);
    assert.deepEqual({ ...api.occurrencesV1(unknown.id)[0] }, { memoryId: unknown.id, source: null, documentId: null, chapter: null, para: null });
    assert.equal(api.bySourcePrefix('source:B').length, 0);
    assert.equal(api.bySourcePrefix('source:A')[0].id, a.id);
    assert.equal(api.bySourcePrefixV1('source:B')[0].documentId, 'doc-B');
    assert.equal(api.bySourcePrefixV1('doc-B').length, 0);
    assert.equal(api.bySourcePrefixV1('source:', 1).length, 1);
    assert.equal(api.bySourcePrefixV1('source:', 0).length, 1);
    assert.equal(api.bySourcePrefixV1('source:', Infinity).length, 2);
    assert.equal(api.bySourcePrefixV1('source:', 10001).length, 2);
    assert.throws(() => api.occurrencesV1(''), TypeError);
    assert.throws(() => api.occurrencesV1(null), TypeError);
    assert.throws(() => api.bySourcePrefixV1(null), TypeError);
    await ctx.tools.map.get('memjudge_forget').execute({ id: a.id });
    assert.deepEqual(api.occurrencesV1(a.id), []);
    assert.deepEqual(api.bySourcePrefixV1('source:'), []);
  } finally { ctx.dispose(); }
});

test('versioned capabilities missing or failing are explicit', () => {
  const store = { stats() {}, bySourcePrefix() {}, byKind() {} };
  const api = createService(null, { store });
  assert.throws(() => api.occurrencesV1('id'), /occurrencesV1.*缺失/);
  assert.throws(() => api.bySourcePrefixV1('x'), /bySourcePrefixV1.*缺失/);
  const failure = new Error('fixture failure');
  store.occurrencesV1 = () => { throw failure; };
  store.bySourcePrefixV1 = () => { throw failure; };
  assert.throws(() => api.occurrencesV1('id'), e => e === failure);
  assert.throws(() => api.bySourcePrefixV1('x'), e => e === failure);
});

test('versioned host queries count occurrences and leave stored rows unchanged', () => {
  const store = open(':memory:');
  const ctx = hostCtx();
  ctx.provide(SERVICE_NAME, createService(ctx, { store }));
  try {
    const first = store.put({ text: 'same body', source: 'origin:one', documentId: 'doc:alpha', chapter: 1, para: 1 });
    store.put({ text: 'same body', source: 'origin:one', documentId: 'doc:beta', chapter: 1, para: 2 });
    store.put({ text: 'different body', source: 'doc:alpha', documentId: 'origin:one', chapter: 2, para: 3 });
    const api = ctx.services.get(SERVICE_NAME);
    const snapshot = () => ({
      memories: store.raw().prepare('SELECT * FROM memories ORDER BY rowid').all(),
      occurrences: store.raw().prepare('SELECT * FROM memory_occurrences ORDER BY rowid').all(),
    });
    const before = snapshot();
    const one = api.bySourcePrefixV1('origin:one', 1);
    const two = api.bySourcePrefixV1('origin:one', 2);
    assert.deepEqual(one.map(r => [r.id, r.documentId, r.para]), [[first.id, 'doc:alpha', 1]]);
    assert.deepEqual(two.map(r => [r.id, r.documentId, r.para]), [[first.id, 'doc:alpha', 1], [first.id, 'doc:beta', 2]]);
    assert.deepEqual(api.bySourcePrefixV1('doc:alpha').map(r => r.source), ['doc:alpha']);
    assert.deepEqual(api.occurrencesV1(first.id).map(r => r.documentId), ['doc:alpha', 'doc:beta']);
    assert.deepEqual(snapshot(), before);
  } finally { store.close(); }
});

test('versioned host prefix follows SQLite escaping and v2 byte matching', () => {
  const store = open(':memory:');
  const ctx = hostCtx();
  ctx.provide(SERVICE_NAME, createService(ctx, { store }));
  try {
    const sources = ['pct%tail', 'pctXtail', 'under_tail', 'underXtail', 'slash\\tail', 'slashXtail',
      'éclair', 'e\u0301clair', 'auto:chat:v2#Ab😀_x', 'auto:chat:v2#ab😀_x'];
    sources.forEach((source, i) => store.put({ text: `prefix fixture ${i}`, source }));
    const api = ctx.services.get(SERVICE_NAME);
    const matches = prefix => api.bySourcePrefixV1(prefix).map(r => r.source);
    assert.deepEqual(matches('pct%'), ['pct%tail']);
    assert.deepEqual(matches('under_'), ['under_tail']);
    assert.deepEqual(matches('slash\\'), ['slash\\tail']);
    assert.deepEqual(matches('é'), ['éclair']);
    assert.deepEqual(matches('e\u0301'), ['e\u0301clair']);
    assert.deepEqual(matches('auto:chat:v2#Ab😀_'), ['auto:chat:v2#Ab😀_x']);
    assert.deepEqual(matches('auto:chat:v2#ab😀_'), ['auto:chat:v2#ab😀_x']);
    assert.deepEqual(matches('auto:chat:v2#Ab😀%'), []);
  } finally { store.close(); }
});

test('stats 原样透传 store.stats()，不改口径', () => {
  const store = open(':memory:');
  try {
    store.put({ text: '我是他的助手。', kind: 'person', createdAt: T0 });
    const api = createService(null, { store });
    assert.deepEqual(api.stats(), store.stats());
    assert.equal(api.stats().memories, 1);
    assert.deepEqual(api.stats().kinds, store.stats().kinds);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------- bySourcePrefix

test('bySourcePrefix：同前缀 3 条 + 异前缀 1 条，只回 3 条且 created_at 升序', () => {
  const store = open(':memory:');
  try {
    store.put({ text: '自动采集第一条：钟摆停在七点。', source: 'auto:chat#abcdef12-t0', kind: 'event', createdAt: T0 + 1000 });
    store.put({ text: '自动采集第二条：齿轮缺了一颗。', source: 'auto:chat#abcdef12-t1', kind: 'event', createdAt: T0 + 2000 });
    store.put({ text: '自动采集第三条：修好了。', source: 'auto:chat#abcdef12-t2', kind: 'event', createdAt: T0 + 3000 });
    store.put({ text: '别的前缀：另一个会话。', source: 'auto:chat#99999999-t0', kind: 'event', createdAt: T0 + 4000 });

    const api = createService(null, { store });
    const rows = api.bySourcePrefix('auto:chat#abcdef12');

    assert.equal(rows.length, 3, '只回同前缀的 3 条');
    assert.deepEqual(
      rows.map((r) => r.source),
      ['auto:chat#abcdef12-t0', 'auto:chat#abcdef12-t1', 'auto:chat#abcdef12-t2'],
    );
    assert.deepEqual(rows.map((r) => r.createdAt), [T0 + 1000, T0 + 2000, T0 + 3000]);
    for (const r of rows) {
      assert.deepEqual(
        Object.keys(r).sort(),
        ['createdAt', 'id', 'importance', 'kind', 'source', 'text'],
      );
      assert.equal(typeof r.text, 'string');
      assert.equal(r.kind, 'event');
    }
  } finally {
    store.close();
  }
});

test('bySourcePrefix：前缀是字面量，`_` / `%` / `\\` 都不通配', () => {
  const store = open(':memory:');
  try {
    store.put({ text: '下划线前缀真身。', source: 'auto:chat#ab_cd-t0', createdAt: T0 + 10 });
    store.put({ text: '下划线位被顶替的邻居。', source: 'auto:chat#abXcd-t0', createdAt: T0 + 11 });
    store.put({ text: '百分号前缀真身。', source: 'pct%a-t0', createdAt: T0 + 20 });
    store.put({ text: '百分号位被顶替的邻居。', source: 'pctXXXa-t0', createdAt: T0 + 21 });
    store.put({ text: '反斜杠前缀真身。', source: 'bs\\x-t0', createdAt: T0 + 30 });
    store.put({ text: '反斜杠位被顶替的邻居。', source: 'bsyx-t0', createdAt: T0 + 31 });

    const api = createService(null, { store });

    const underscore = api.bySourcePrefix('auto:chat#ab_cd');
    assert.equal(underscore.length, 1, '`_` 必须字面匹配，不能吃掉 abXcd');
    assert.equal(underscore[0].source, 'auto:chat#ab_cd-t0');

    const percent = api.bySourcePrefix('pct%a');
    assert.equal(percent.length, 1, '`%` 必须字面匹配，不能吃掉 pctXXXa');
    assert.equal(percent[0].source, 'pct%a-t0');

    const backslash = api.bySourcePrefix('bs\\');
    assert.equal(backslash.length, 1, '`\\` 必须字面匹配，不能吃掉 bsyx');
    assert.equal(backslash[0].source, 'bs\\x-t0');
  } finally {
    store.close();
  }
});

test('bySourcePrefix：非字符串抛 TypeError，空串返回所有带 source 的记忆', () => {
  const store = open(':memory:');
  try {
    store.put({ text: '有 source 的。', source: 'a-t0', createdAt: T0 });
    store.put({ text: '没 source 的。', createdAt: T0 + 1 });
    const api = createService(null, { store });

    assert.throws(() => api.bySourcePrefix(123), TypeError);
    assert.throws(() => api.bySourcePrefix(null), TypeError);
    assert.throws(() => api.bySourcePrefix(undefined), TypeError);

    const all = api.bySourcePrefix('');
    assert.equal(all.length, 1, '空串 = 只匹配「带 source」的行，NULL source 不进结果');
    assert.equal(all[0].source, 'a-t0');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------- byKind

test('byKind：person/promise/event 各自命中，非法值归 event（与写入路径同口径）', () => {
  const store = open(':memory:');
  try {
    store.put({ text: '我是他的后端工程师。', kind: 'person', createdAt: T0 });
    store.put({ text: '说好每次改完都给实测输出。', kind: 'promise', createdAt: T0 + 1 });
    store.put({ text: '今天跑完了验收。', kind: 'event', createdAt: T0 + 2 });
    store.put({ text: '脏 kind 也该落到 event。', kind: 'nonsense', createdAt: T0 + 3 });

    const api = createService(null, { store });

    const person = api.byKind('person');
    assert.equal(person.length, 1);
    assert.equal(person[0].kind, 'person');
    assert.equal(person[0].createdAt, T0);

    assert.equal(api.byKind('promise').length, 1);

    const events = api.byKind('event');
    assert.equal(events.length, 2, 'event + 非法值归 event');
    assert.deepEqual(events.map((r) => r.createdAt), [T0 + 2, T0 + 3]);
    assert.equal(api.byKind('nonsense').length, 2, '非法 kind 与 event 等价');
    assert.deepEqual(
      api.byKind('nonsense').map((r) => r.id),
      api.byKind('event').map((r) => r.id),
    );
  } finally {
    store.close();
  }
});

test('limit 归一化：非有限值回落 50，越界钳到 1..10000', () => {
  const store = open(':memory:');
  try {
    for (let i = 0; i < 3; i += 1) {
      store.put({ text: `第 ${i} 条前缀命中。`, kind: 'event', createdAt: T0 + i, source: 's-t0' });
    }
    const api = createService(null, { store });

    assert.equal(api.bySourcePrefix('s', 1).length, 1);
    assert.equal(api.bySourcePrefix('s', 0).length, 1, '0 钳到下界 1');
    assert.equal(api.bySourcePrefix('s', -5).length, 1, '负数钳到下界 1');
    assert.equal(api.bySourcePrefix('s', Infinity).length, 3, 'Infinity 回落 50');
    assert.equal(api.bySourcePrefix('s', NaN).length, 3);
    assert.equal(api.bySourcePrefix('s').length, 3, '缺省 50');

    assert.equal(api.byKind('event', 1).length, 1);
    assert.equal(api.byKind('event', 0).length, 1);
    assert.equal(api.byKind('event', Infinity).length, 3);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------- recallByQuery

test('recallByQuery：空 query → TypeError，recall 未接线 → Error（不返回假空结果）', async () => {
  const store = open(':memory:');
  try {
    const api = createService(null, { store });
    await assert.rejects(() => api.recallByQuery(''), TypeError);
    await assert.rejects(() => api.recallByQuery('   '), TypeError);
    await assert.rejects(() => api.recallByQuery(null), TypeError);
    await assert.rejects(() => api.recallByQuery('钟摆'), /recall 未接线/);
  } finally {
    store.close();
  }
});

test('recallByQuery：预算钳到 1..2000 / 取章数 1..4，结果裁掉工具层字段', async () => {
  const store = open(':memory:');
  try {
    let seen = null;
    const api = createService(null, {
      store,
      recall: async (query, opts) => {
        seen = { query, opts };
        return {
          denied: false,
          reason: '',
          detail: '',
          chars: 42,
          elapsedMs: 7,
          conflictLine: '工具层自述，不应出现在服务结果里',
          hits: [{ id: 'm1', chapter: 1, para: 2, chars: 42, score: 0.5, text: '正文', extra: 'x' }],
        };
      },
    });

    const r = await api.recallByQuery('  钟摆  ', { budget: 99999, topChapters: 0 });
    assert.deepEqual(seen, { query: '钟摆', opts: { budget: 2000, topChapters: 1 } });
    assert.deepEqual(Object.keys(r).sort(), ['chars', 'denied', 'detail', 'hits', 'reason']);
    assert.equal('elapsedMs' in r, false);
    assert.equal('conflictLine' in r, false);
    assert.equal(r.denied, false);
    assert.equal(r.chars, 42);
    assert.equal(r.hits.length, 1);
    assert.deepEqual(Object.keys(r.hits[0]).sort(), ['chapter', 'chars', 'id', 'para', 'score', 'text', 'truncated']);
    assert.equal(r.hits[0].truncated, false);

    await api.recallByQuery('钟摆');
    assert.deepEqual(seen.opts, { budget: 2000, topChapters: 2 }, '缺省与 memjudge_recall 一致');

    // 拒答路径同样透传，不吞 reason/detail。
    const denied = createService(null, {
      store,
      recall: async () => ({ denied: true, reason: 'no-candidates', detail: '检索无候选段', chars: 0, hits: [] }),
    });
    const d = await denied.recallByQuery('不存在的词');
    assert.equal(d.denied, true);
    assert.equal(d.reason, 'no-candidates');
    assert.equal(d.detail, '检索无候选段');
    assert.deepEqual(d.hits, []);
  } finally {
    store.close();
  }
});

test('v2 pre-step validates before quota and preserves decision identity', async () => {
  const ctx = hostCtx();
  let handler;
  ctx.on = (name, fn) => { if (name === 'agent/pre-step') handler = fn; return () => {}; };
  apply(ctx, { dbPath: ':memory:', autoCaptureLimitPerSession: 1, autoCaptureCooldownMs: 0 });
  const { formatSource } = await import('../src/auto-capture.mjs');
  const decision = { kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '这个项目的包管理器用 pnpm，别用 npm' }] }] };
  const run = (id, turn) => handler({ agent: { session: { id } }, turn }, async () => decision);
  try {
    assert.equal(typeof handler, 'function');
    for (const id of [null, 42, {}, '', ' ', '\ud800']) assert.equal(await run(id, 1), decision);
    for (const turn of [Symbol('bad'), Number.MAX_SAFE_INTEGER + 1, { valueOf() { throw new Error('private'); } }]) assert.equal(await run('valid', turn), decision);
    const api = ctx.services.get(SERVICE_NAME);
    assert.equal(api.bySourcePrefix('').length, 0);
    assert.equal(await run('valid', 1), decision);
    assert.equal(api.bySourcePrefix(formatSource('valid', 1)).length, 1);
    if (process.env.B01_WORKBENCH_URL) {
      const { enrichFromMemjudge } = await import(process.env.B01_WORKBENCH_URL);
      const evidence = enrichFromMemjudge(api, 'valid', { limit: 1 });
      assert.equal(evidence.count, 1);
      assert.equal(evidence.samples[0], '这个项目的包管理器用 pnpm，别用 npm');
      assert.equal(evidence.truncated, true);
    }
    assert.equal(await run('valid', 2), decision);
    assert.equal(api.bySourcePrefix('').length, 1);
  } finally { ctx.dispose(); }
});

// ---------------------------------------------------------------- 端到端（apply）

test('apply：带 provide 的 Context 上注册 memjudge 服务，与 5 个工具共存', async () => {
  const ctx = hostCtx();
  const dbPath = path.join(TMP, 'e2e.db');
  apply(ctx, { dbPath, now: clock() });

  try {
    assert.equal(ctx.tools.map.size, TOOL_NAMES.length);
    assert.deepEqual([...ctx.tools.map.keys()].sort(), [...TOOL_NAMES].sort());

    const api = ctx.services.get(SERVICE_NAME);
    assert.ok(api, 'ctx.provide 必须收到 memjudge 服务');
    assert.equal(api.version, '1');

    const remember = ctx.tools.map.get('memjudge_remember');
    const r1 = await remember.execute({
      text: '林港在旧船坞里修一台坏掉的钟，钟摆停在七点。', kind: 'person',
    });
    const r2 = await remember.execute({ text: '说好每周三晚九点通一次电话。', kind: 'promise' });
    const r3 = await remember.execute({ text: '硫含量测了三次，结果都是 0.47%。', kind: 'event' });
    assert.equal(r1.inserted, true);
    assert.equal(r2.inserted, true);
    assert.equal(r3.inserted, true);

    // 服务与工具看到的是同一个库。
    assert.equal(api.stats().memories, 3);
    const toolStats = await ctx.tools.map.get('memjudge_stats').execute({});
    assert.equal(toolStats.memories, 3, '工具与服务的条目数必须同一口径');
    assert.equal(toolStats.facts, api.stats().facts);
    assert.equal(api.byKind('person').length, 1);
    assert.equal(api.byKind('promise').length, 1);

    const recalled = await api.recallByQuery('钟摆');
    assert.equal(recalled.denied, false);
    assert.ok(recalled.hits.length >= 1, '必须命中那条修钟的记忆');
    assert.ok(recalled.hits.some((h) => /钟摆|船坞/.test(h.text)));
  } finally {
    ctx.dispose();
  }
});

test('只读名副其实：服务召回不刷新 access_count，真工具对照会 +1', async () => {
  const ctx = hostCtx();
  const dbPath = path.join(TMP, 'readonly.db');
  apply(ctx, { dbPath, now: clock() });

  try {
    const remember = ctx.tools.map.get('memjudge_remember');
    await remember.execute({ text: '林港在旧船坞里修一台坏掉的钟，钟摆停在七点。', kind: 'person' });
    await remember.execute({ text: '说好每周三晚九点通一次电话。', kind: 'promise' });

    const api = ctx.services.get(SERVICE_NAME);
    assert.deepEqual(accessCounts(dbPath), [0, 0], '写入不刷访问计数');

    const hit = await api.recallByQuery('钟摆');
    assert.equal(hit.denied, false);
    assert.ok(hit.hits.length >= 1, '服务确实命中（否则下面的 0 是假证据）');
    assert.deepEqual(accessCounts(dbPath), [0, 0], 'recallByQuery 不得改动 lastAccessed/accessCount');

    // 再调一次：连续观测也不留脚印（下游每轮都会调）。
    await api.recallByQuery('钟摆');
    assert.deepEqual(accessCounts(dbPath), [0, 0]);

    // 对照组：同一个库、同一个 query 走真工具，access_count 必须涨。
    await ctx.tools.map.get('memjudge_recall').execute({ query: '钟摆' });
    const after = accessCounts(dbPath);
    assert.ok(after.reduce((a, b) => a + b, 0) >= 1, '工具路径必须刷访问计数（证明服务路径的静默是有意为之）');
  } finally {
    ctx.dispose();
  }
});

test('dispose 后服务注销，不留悬空注册', () => {
  const ctx = hostCtx();
  apply(ctx, { dbPath: path.join(TMP, 'dispose.db'), now: clock() });
  assert.ok(ctx.services.has(SERVICE_NAME));
  ctx.dispose();
  assert.equal(ctx.services.has(SERVICE_NAME), false, 'provide 返回的 disposer 必须被 track 到');
});

test('Context 没有 provide 时不崩，5 个工具照常注册（MockContext 缺 .provide 的老坑）', () => {
  const ctx = hostCtx({ provide: false });
  assert.equal(typeof ctx.provide, 'undefined');
  apply(ctx, { dbPath: path.join(TMP, 'noprov.db'), now: clock() });
  assert.equal(ctx.tools.map.size, TOOL_NAMES.length);
  for (const name of TOOL_NAMES) assert.ok(ctx.tools.map.has(name), `${name} 未注册`);
  ctx.dispose();
});
