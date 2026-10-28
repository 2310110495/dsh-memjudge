// T8-1：wiki 编译层接线。
// 只验三件事：投影可用、落盘只多两个 meta 键、raw 不变时不重复编译。
// 注入面不在本文件里验——注入面要求逐字节对比，由独立的实测脚本取证。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply, SECTION_NAME } from '../src/index.mjs';
import { open } from '../src/store.mjs';

/** 复刻宿主 Context 的 tools / systemPrompt / effect 三个面（够 apply 用）。 */
function hostCtx() {
  const tools = new Map();
  const sections = new Map();
  return {
    tools: {
      map: tools,
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      map: sections,
      section(entry) {
        if (!Number.isFinite(entry.order)) throw new TypeError('section order must be a finite number');
        sections.set(entry.name, entry);
        return () => sections.delete(entry.name);
      },
    },
    effect(fn) {
      const cleanup = fn();
      return () => {
        if (typeof cleanup === 'function') cleanup();
      };
    },
  };
}

function freshHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mj-wiki-'));
  return { dir, dbPath: path.join(dir, 'memjudge.db') };
}

/** stats.wiki 是唯一对外可观测的编译计数口径，解析它而不是去读闭包。 */
function compileCounters(stats) {
  const m = /编译 (\d+) 次，digest 命中跳过 (\d+) 次/.exec(String(stats.wiki ?? ''));
  assert.ok(m, `stats 缺 wiki 编译计数：${stats.wiki}`);
  return { compiles: Number(m[1]), skipped: Number(m[2]) };
}

function readMeta(dbPath) {
  const store = open(dbPath);
  try {
    return {
      meta: new Map(store.raw().prepare('SELECT k, v FROM meta').all().map((r) => [r.k, String(r.v)])),
      tables: store.raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    };
  } finally {
    store.close();
  }
}

test('wiki 接线：写入即产出内存投影，落盘只多 wiki_version 与 raw_digest 两键', async () => {
  const { dir, dbPath } = freshHome();
  const ctx = hostCtx();
  const inst = apply(ctx, { dbPath });
  try {
    const remember = ctx.tools.map.get('memjudge_remember');
    const stats = ctx.tools.map.get('memjudge_stats');
    await remember.execute({ text: '白鲸号吃水九厘米。', chapter: 1, para: 1 });
    await remember.execute({ text: '主机功率 12000 千瓦。', chapter: 1, para: 2 });

    const st = await stats.execute({});
    assert.match(st.wiki, /^v1 投影 2 块\/verified/, `投影没建起来：${st.wiki}`);
    assert.equal(compileCounters(st).compiles, 2, '两次改变 raw 的写入应各编一次');
    inst.dispose();

    const { meta, tables } = readMeta(dbPath);
    assert.equal(meta.get('wiki_version'), '1');
    assert.match(meta.get('raw_digest'), /^[0-9a-f]{8}$/, `raw_digest 形状不对：${meta.get('raw_digest')}`);
    const bytes = Buffer.byteLength(meta.get('wiki_version'), 'utf8') + Buffer.byteLength(meta.get('raw_digest'), 'utf8');
    assert.ok(bytes < 200, `两个键合计 ${bytes} 字节，超出 200`);

    const planned = new Set(['schema_version', 'wiki_version', 'raw_digest']);
    const extra = [...meta.keys()].filter((k) => !planned.has(k));
    assert.deepEqual(extra, [], `meta 出现计划外的键：${extra.join(',')}`);

    // 投影不落盘：没有 wiki / page / fts 表，memories 里也没有多出来的行。
    assert.deepEqual(tables.filter((t) => /wiki|page|fts/i.test(t)), [], `出现投影表：${tables.join(',')}`);
    assert.equal(meta.size, planned.size, 'meta 只该有 schema_version + 计划内的两个键');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiki 接线：raw 未变的重复写入不重编（digest 命中跳过）', async () => {
  const { dir, dbPath } = freshHome();
  const ctx = hostCtx();
  const inst = apply(ctx, { dbPath });
  try {
    const remember = ctx.tools.map.get('memjudge_remember');
    const stats = ctx.tools.map.get('memjudge_stats');
    const text = '白鲸号吃水九厘米。';
    await remember.execute({ text, chapter: 1, para: 1 });
    const before = compileCounters(await stats.execute({}));

    const again = await remember.execute({ text, chapter: 1, para: 1 });
    assert.equal(again.inserted, false, '幂等重写应命中未插入');
    const after = compileCounters(await stats.execute({}));

    assert.equal(after.compiles, before.compiles, '同一条幂等重写不该再编一次');
    assert.equal(after.skipped, before.skipped + 1, '应记一次 digest 命中跳过');
    inst.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiki 接线：forget 后投影跟着重建，编译计数增加而块数减少', async () => {
  const { dir, dbPath } = freshHome();
  const ctx = hostCtx();
  const inst = apply(ctx, { dbPath });
  try {
    const remember = ctx.tools.map.get('memjudge_remember');
    const forget = ctx.tools.map.get('memjudge_forget');
    const stats = ctx.tools.map.get('memjudge_stats');
    const a = await remember.execute({ text: '白鲸号吃水九厘米。', chapter: 1, para: 1 });
    await remember.execute({ text: '主机功率 12000 千瓦。', chapter: 2, para: 1 });
    const before = await stats.execute({});
    assert.match(before.wiki, /投影 2 块/);

    const gone = await forget.execute({ id: a.id });
    assert.equal(gone.count, 1);
    const after = await stats.execute({});
    assert.match(after.wiki, /投影 1 块/, `删除后投影没重建：${after.wiki}`);
    assert.equal(compileCounters(after).compiles, compileCounters(before).compiles + 1, '删除改变了 raw，应重编一次');
    inst.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiki 接线：注入关闭时 section 仍是 0 字符（接线不动注入面）', async () => {
  const { dir, dbPath } = freshHome();
  const ctx = hostCtx();
  const inst = apply(ctx, { dbPath });
  try {
    await ctx.tools.map.get('memjudge_remember').execute({ text: '白鲸号吃水九厘米。', chapter: 1, para: 1 });
    const text = ctx.systemPrompt.map.get(SECTION_NAME).text();
    assert.equal(text, '', 'autoInject 默认关时注入必须是空串');
    inst.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiki 接线：重开库时 meta.raw_digest 命中，只重编一次而不当成全新库', async () => {
  const { dir, dbPath } = freshHome();
  const first = hostCtx();
  const inst1 = apply(first, { dbPath });
  await first.tools.map.get('memjudge_remember').execute({ text: '白鲸号吃水九厘米。', chapter: 1, para: 1 });
  const digest1 = readMeta(dbPath).meta.get('raw_digest');
  inst1.dispose();

  const second = hostCtx();
  const inst2 = apply(second, { dbPath });
  try {
    const st = await second.tools.map.get('memjudge_stats').execute({});
    assert.match(st.wiki, /投影 1 块\/verified/);
    assert.equal(compileCounters(st).compiles, 1, '重启后懒编一次即可，不应重复编');
    // 落盘书签没被改写：raw 没变，digest 必须还是原来那个。
    assert.equal(readMeta(dbPath).meta.get('raw_digest'), digest1);
    inst2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
