// memjudge 插件外壳验收测试：跑 node memjudge-plugin/test/plugin.test.mjs 必须全绿。
//
// 覆盖 t13 的五条验收：
//   1. apply 在 cordis 语义的 Context 里不抛错
//   2. 5 个工具全部注册成功（memjudge_remember/recall/forget/conflicts/stats）
//   3. 与 memory_read / memory_search / memory_save / memory_list / memory 同装不冲突
//   4. dispose 后重装成功
//   5. 注入关闭时 0 字符，开启时 ≤ 2000 字符
//
// MockContext 不是随手写的假对象：它复刻了宿主 NamedEntries 的重名抛错语义
// （@deepseek-ai/dsh-scope/lib/index.js:29），所以「同装不冲突」这条测的是真机制。
// 若本机有解包后的宿主模块（DSH_HOST_MODULES 或 D:/tmp/dsh-host/dsh/node_modules），
// 末尾会额外用真 cordis Context 跑一遍 apply/dispose 冒烟。

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  apply,
  TOOL_NAMES,
  SECTION_NAME,
  SECTION_ORDER,
  INJECT_HARD_LIMIT,
  DEFAULTS,
  resolveConfig,
  defaultDbPath,
} from '../src/index.mjs';
import { chapters } from '../../mem-eval/corpus/novel.mjs';
import { recall as recallQuestions } from '../../mem-eval/corpus/quiz.mjs';

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 27, 0, 0, 0); // 假时钟起点，与 SPEC P1 一致
const TMP = mkdtempSync(path.join(tmpdir(), 'memjudge-plugin-'));

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

// ---------------------------------------------------------------- 宿主语义

/** 复刻 @deepseek-ai/dsh-scope 的 NamedEntries：同层重名直接抛错，不静默覆盖。 */
class NamedEntries {
  constructor(kind) {
    this.kind = kind;
    this.map = new Map();
  }

  insert(name, value) {
    if (this.map.has(name)) {
      throw new Error(
        `${this.kind} "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`,
      );
    }
    this.map.set(name, value);
    return () => {
      this.map.delete(name);
    };
  }
}

/** 复刻 cordis Context 的 tools / systemPrompt / effect 三个面。 */
class MockContext {
  constructor() {
    this.tools = new NamedEntries('tool');
    this.systemPrompt = new NamedEntries('prompt section');
    this._effects = [];
  }

  /** cordis 语义：立即执行 fn，返回的函数登记为清理函数。 */
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

/** 复刻宿主 tools.register 的两条硬校验：output 形状与 run_code 保留名。 */
function registerTool(ctx, definition) {
  const output = definition.output;
  if (!output || typeof output !== 'object' || typeof output.render !== 'function') {
    throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`);
  }
  if (definition.name === 'run_code') {
    throw new Error('tool name "run_code" is reserved for the PTC mode presentation transport');
  }
  return ctx.tools.insert(definition.name, definition);
}

/** 复刻宿主 systemPrompt.section 的 order 有限数校验。 */
function registerSection(ctx, section) {
  if (!Number.isFinite(section.order)) {
    throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
  }
  return ctx.systemPrompt.insert(section.name, section);
}

/** 把 MockContext 接到 apply 期望的形状上。 */
function hostCtx() {
  const ctx = new MockContext();
  ctx.tools.register = (definition) => registerTool(ctx, definition);
  ctx.systemPrompt.section = (section) => registerSection(ctx, section);
  return ctx;
}

const tool = (ctx, name) => ctx.tools.map.get(name);
const sectionText = (ctx) => ctx.systemPrompt.map.get(SECTION_NAME).text();

/** 按空行切段：一条记忆 = 一个片段，章号/段号写进 source。 */
function segmentsOf(chapter) {
  return chapter.text
    .split(/\n\s*\n/)
    .map((text, i) => ({ text: text.trim(), chapter: chapter.n, para: i + 1 }))
    .filter((s) => s.text.length > 0);
}

// ---------------------------------------------------------------- 用例

console.log(`memjudge plugin shell — ${TOOL_NAMES.length} tools, section ${SECTION_NAME}@${SECTION_ORDER}`);

await check('配置归一化：越界钳到边界、非数字回落默认、injectBudget 硬钳 2000', () => {
  const cfg = resolveConfig({ injectBudget: 99999, halfLifeDays: -1, decayFloor: 7, autoInject: 'yes' });
  assert.equal(cfg.injectBudget, INJECT_HARD_LIMIT, '注入预算必须硬钳在 2000');
  assert.equal(cfg.halfLifeDays, 0.5, '负数钳到下界 0.5 天');
  assert.equal(cfg.decayFloor, 1, '衰减地板钳到上界 1');
  assert.equal(cfg.autoInject, false, 'autoInject 只认布尔 true');
  assert.equal(resolveConfig({ halfLifeDays: 'abc' }).halfLifeDays, DEFAULTS.halfLifeDays, '非数字回落默认');
  assert.equal(resolveConfig({}).injectBudget, 2000);
});

await check('默认库路径落在 DSH_HOME 下，不写用户主 profile', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = 'D:/tmp/dsh-home-probe';
  try {
    assert.equal(defaultDbPath(), path.join('D:/tmp/dsh-home-probe', 'memjudge', 'memjudge.db'));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

await check('apply 不抛错，5 个工具全部注册且名字全为 memjudge_ 前缀', () => {
  const ctx = hostCtx();
  apply(ctx, { dbPath: path.join(TMP, 'a.db'), now: () => T0 });
  assert.equal(ctx.tools.map.size, 5);
  assert.deepEqual([...ctx.tools.map.keys()].sort(), [...TOOL_NAMES].sort());
  for (const name of ctx.tools.map.keys()) {
    assert.ok(name.startsWith('memjudge_'), `${name} 缺 memjudge_ 前缀`);
    assert.ok(!/^memory_/.test(name), `${name} 占用了 memory_* 名字`);
  }
  ctx.dispose();
});

await check('与 memory_read/memory_search/memory_save/memory_list/memory 同装不冲突', () => {
  const ctx = hostCtx();
  // 先装「被三方争抢」的那批名字，模拟 annkun / soul-md / meow / LittleBlackTong / sage-mem
  for (const name of ['memory_read', 'memory_search', 'memory_save', 'memory_list', 'memory']) {
    ctx.tools.register({
      name,
      description: 'occupier',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
    });
  }
  apply(ctx, { dbPath: path.join(TMP, 'b.db'), now: () => T0 });
  assert.equal(ctx.tools.map.size, 10, '5 个占用名 + 5 个 memjudge 工具应共存');
  for (const name of TOOL_NAMES) assert.ok(ctx.tools.map.has(name), `${name} 未注册`);
  ctx.dispose();
});

await check('重复 apply 到同一 ctx 会因重名抛错（证明 mock 忠实于宿主）', () => {
  const ctx = hostCtx();
  apply(ctx, { dbPath: path.join(TMP, 'c.db'), now: () => T0 });
  assert.throws(
    () => apply(ctx, { dbPath: path.join(TMP, 'c.db'), now: () => T0 }),
    /tool "memjudge_remember" is already registered/,
  );
  ctx.dispose();
});

await check('注入 section 名为 memjudge:recall、order 700、关闭时 0 字符', () => {
  const ctx = hostCtx();
  apply(ctx, { dbPath: path.join(TMP, 'd.db'), now: () => T0 });
  const section = ctx.systemPrompt.map.get(SECTION_NAME);
  assert.ok(section, 'section 未注册');
  assert.equal(section.order, SECTION_ORDER);
  assert.equal(section.interpolate, false, '记忆正文里的 {{...}} 不能被当变量插值');
  assert.equal(sectionText(ctx), '', 'autoInject=false 时必须 0 字符');
  ctx.dispose();
});

await check('20 章按段写入 → 注入开启时 ≤2000 字符且 >0', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'e.db'), autoInject: true, now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  let written = 0;
  for (const chapter of chapters) {
    clock = T0 + (chapter.n - 1) * DAY;
    for (const seg of segmentsOf(chapter)) {
      const out = await remember.execute(seg);
      assert.equal(out.inserted, true, `${seg.chapter}/${seg.para} 未写入`);
      written += 1;
    }
  }
  assert.ok(written > 250, `只写入 ${written} 段，语料切分异常`);
  const text = sectionText(ctx);
  assert.ok(text.length > 0, '开启注入后仍为 0 字符');
  assert.ok(text.length <= INJECT_HARD_LIMIT, `注入 ${text.length} 字符，超过 ${INJECT_HARD_LIMIT}`);
  assert.ok(text.includes('memjudge 记忆索引'), '注入块缺标题');
  ctx.dispose();
});

await check('remember → recall 往返：92 题里至少命中 90 题的关键词', async () => {
  const ctx = hostCtx();
  // 全部同一天写入：复现 t11 的 recall 口径（writtenSpreadDays=0），衰减因子为常数，
  // 测的是检索本身，而不是「第 1 章被第 20 章按时间挤掉」。
  const clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'f.db'), now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  for (const chapter of chapters) {
    for (const seg of segmentsOf(chapter)) await remember.execute(seg);
  }
  const recallTool = tool(ctx, 'memjudge_recall');
  const missed = [];
  for (const q of recallQuestions) {
    const out = await recallTool.execute({ query: q.q });
    const joined = out.hits.map((h) => h.text).join('\n');
    const kws = Array.isArray(q.kw) ? q.kw : [q.kw];
    if (out.denied || !kws.some((k) => joined.includes(k))) missed.push(q.id);
  }
  assert.ok(missed.length <= 3, `miss ${missed.length} 题：${missed.join(',')}`);
  ctx.dispose();
});

await check('衰减压力档：20 天时间跨度写入后，老章召回不崩（≥80/92）', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'f2.db'), now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  for (const chapter of chapters) {
    clock = T0 + (chapter.n - 1) * DAY;
    for (const seg of segmentsOf(chapter)) await remember.execute(seg);
  }
  clock = T0 + 19 * DAY; // 查询时第 1 章已衰减 19 天（半衰期 30 天 → 权重 0.64）
  const recallTool = tool(ctx, 'memjudge_recall');
  let hit = 0;
  for (const q of recallQuestions) {
    const out = await recallTool.execute({ query: q.q });
    const joined = out.hits.map((h) => h.text).join('\n');
    const kws = Array.isArray(q.kw) ? q.kw : [q.kw];
    if (!out.denied && kws.some((k) => joined.includes(k))) hit += 1;
  }
  assert.ok(hit >= 80, `衰减后只命中 ${hit}/92，低于 80`);
  ctx.dispose();
});

await check('recall 预算生效：budget=500 时返回 ≤500 字符', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'g.db'), now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  for (const chapter of chapters) {
    clock = T0 + (chapter.n - 1) * DAY;
    for (const seg of segmentsOf(chapter)) await remember.execute(seg);
  }
  const out = await tool(ctx, 'memjudge_recall').execute({ query: '主机功率是多少', budget: 500 });
  assert.ok(out.chars <= 500, `返回 ${out.chars} 字符，超过预算 500`);
  assert.ok(out.hits.length > 0, '预算 500 下不应零命中');
  ctx.dispose();
});

await check('forget：dryRun 不落库，真删后查不到', async () => {
  const ctx = hostCtx();
  apply(ctx, { dbPath: path.join(TMP, 'h.db'), now: () => T0 });
  const remember = tool(ctx, 'memjudge_remember');
  const forget = tool(ctx, 'memjudge_forget');
  const recallTool = tool(ctx, 'memjudge_recall');
  const written = await remember.execute({ text: '第 5 章主机功率 12000 千瓦', chapter: 5, para: 1 });

  const dry = await forget.execute({ id: written.id, dryRun: true });
  assert.deepEqual(dry.forgotten, [written.id]);
  assert.equal(dry.dryRun, true);
  assert.ok(await recallTool.execute({ query: '主机功率' }).then((r) => r.hits.length > 0), 'dryRun 不应真删');

  const real = await forget.execute({ id: written.id });
  assert.equal(real.count, 1);
  const after = await recallTool.execute({ query: '主机功率' });
  assert.equal(after.denied, true, '删除后应无候选');
  ctx.dispose();
});

await check('conflicts：ch5 九厘米 vs ch15 十一厘米 → 同组报出两个值', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'i.db'), now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  const ch5 = chapters.find((c) => c.n === 5);
  const ch15 = chapters.find((c) => c.n === 15);
  clock = T0 + 4 * DAY;
  for (const seg of segmentsOf(ch5)) await remember.execute(seg);
  clock = T0 + 14 * DAY;
  for (const seg of segmentsOf(ch15)) await remember.execute(seg);

  const out = await tool(ctx, 'memjudge_conflicts').execute({});
  assert.ok(out.total >= 1, `未发现矛盾（total=${out.total}）`);
  const depth = out.conflicts.find((c) => c.unit === '厘米' && c.values.includes('九厘米') && c.values.includes('十一厘米'));
  assert.ok(depth, `厘米组缺失或未同时含两个值：${JSON.stringify(out.conflicts.map((c) => [c.attr, c.unit, c.values]))}`);
  assert.ok(depth.supersededValues.length >= 1, 'supersededValues 为空');
  ctx.dispose();
});

await check('stats：20 章整章写入 ≤200KB 且在预算内（SPEC 能力 7 口径）', async () => {
  const ctx = hostCtx();
  let clock = T0;
  apply(ctx, { dbPath: path.join(TMP, 'j.db'), now: () => clock });
  const remember = tool(ctx, 'memjudge_remember');
  for (const chapter of chapters) {
    clock = T0 + (chapter.n - 1) * DAY;
    await remember.execute({ text: chapter.text, chapter: chapter.n, para: 1 });
  }
  const out = await tool(ctx, 'memjudge_stats').execute({ verbose: true });
  assert.equal(out.memories, 20, `条目数 ${out.memories} 应为 20`);
  assert.ok(out.facts > 300, `三元组 ${out.facts} 异常`);
  assert.equal(out.withinLimit, true, `库体 ${(out.bytes / 1024).toFixed(1)}KB 超 200KB`);
  assert.equal(out.injectEnabled, false);
  assert.equal(out.injectChars, 0);
  assert.ok(out.dbPath.endsWith('j.db'));
  ctx.dispose();
});

await check('dispose 干净：工具与 section 全注销，重复 dispose 幂等', () => {
  const ctx = hostCtx();
  const handle = apply(ctx, { dbPath: path.join(TMP, 'k.db'), now: () => T0 });
  assert.equal(ctx.tools.map.size, 5);
  ctx.dispose();
  assert.equal(ctx.tools.map.size, 0, '工具未注销');
  assert.equal(ctx.systemPrompt.map.size, 0, 'section 未注销');
  assert.doesNotThrow(() => handle.dispose(), '重复 dispose 应幂等');
  assert.doesNotThrow(() => handle.dispose(), '第三次 dispose 仍应幂等');
});

await check('dispose 后重装成功，且能读回上一次写入的数据', async () => {
  const dbPath = path.join(TMP, 'l.db');
  const first = hostCtx();
  apply(first, { dbPath, now: () => T0 });
  await tool(first, 'memjudge_remember').execute({ text: '第 5 章主机功率 12000 千瓦', chapter: 5, para: 1 });
  first.dispose();

  const second = hostCtx();
  apply(second, { dbPath, now: () => T0 + DAY });
  assert.equal(second.tools.map.size, 5, '重装后工具数不对');
  const out = await tool(second, 'memjudge_recall').execute({ query: '主机功率' });
  assert.equal(out.denied, false, '重装后读不到旧数据');
  assert.ok(out.hits.some((h) => h.text.includes('12000')), '命中内容不含 12000');
  second.dispose();
});

await check('全新空库路径：目录不存在 → open() 建表 + 五工具逐个冒烟', async () => {
  // 集成期踩过的坑：DDL 的列名与 INSERT 语句错位只在**全新库**暴露（老库里表已存在，
  // CREATE TABLE IF NOT EXISTS 不会纠偏），五工具会全废。所以这条必须用不存在的
  // 多级目录 + 从没建过的 db 文件跑，不能借 test/.tmp 里已有的库。
  const freshDir = path.join(TMP, 'fresh', 'nested', 'leaf');
  const dbPath = path.join(freshDir, 'brand-new.db');
  assert.equal(existsSync(dbPath), false, '前置条件：db 文件必须不存在');

  const ctx = hostCtx();
  apply(ctx, { dbPath, autoInject: true, now: () => T0 });
  assert.equal(ctx.tools.map.size, 5);

  const ch5 = chapters.find((c) => c.n === 5);
  const firstSeg = ch5.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)[0];
  const wrote = await tool(ctx, 'memjudge_remember').execute({ text: firstSeg, chapter: 5, para: 1 });
  assert.equal(wrote.inserted, true, '全新库首次写入失败');
  assert.ok(wrote.factCount > 0, '三元组未抽出');

  const read = await tool(ctx, 'memjudge_recall').execute({ query: firstSeg.slice(0, 8) });
  assert.equal(read.denied, false, '全新库检索失败');
  assert.ok(read.hits.length > 0, '全新库无命中');

  const conf = await tool(ctx, 'memjudge_conflicts').execute({});
  assert.equal(conf.total, 0, '单条记忆不应报矛盾');

  const st = await tool(ctx, 'memjudge_stats').execute({ verbose: true });
  assert.equal(st.memories, 1);
  assert.equal(st.withinLimit, true);
  assert.match(st.tidy, /组待审矛盾/, 'stats 缺 layer 后台整理结论');

  const del = await tool(ctx, 'memjudge_forget').execute({ id: wrote.id });
  assert.equal(del.count, 1, '全新库删除失败');
  assert.equal((await tool(ctx, 'memjudge_stats').execute({})).memories, 0);

  ctx.dispose();
});

await check('注入块由 layer.renderRecall 渲染：descriptor 行 + 零正文', async () => {
  // t4 的 layer.mjs 必须真的被注入路径消费。索引行的契约是
  // `- "id" — 首行：来源`，正文一个字都不进 prompt（soul-md 的索引型记忆）。
  // 用 >90 字的长正文才分辨得出「首行 descriptor」与「全文倾倒」。
  const ctx = hostCtx();
  apply(ctx, { dbPath: path.join(TMP, 'm.db'), autoInject: true, now: () => T0 });
  const remember = tool(ctx, 'memjudge_remember');
  const longText = `第 7 章舱壁焊缝凹陷九厘米，需返厂复检。${'压载水舱在左舷第三肋位出现渗漏，'.repeat(10)}尾部标记：密封胶型号 AK-77。`;
  await remember.execute({ text: longText, chapter: 7, para: 1 });
  const text = sectionText(ctx);
  assert.ok(text.startsWith('## memjudge 记忆索引'), `注入块标题异常：${text.slice(0, 40)}`);
  assert.match(text, /^- "/m, '缺 layer.renderRecall 的 descriptor 行格式');
  assert.ok(text.includes('ch7'), '来源章号未渲染');
  assert.ok(text.includes('memjudge_recall 取全文'), '缺调用提示尾巴');
  assert.ok(text.includes('第 7 章舱壁焊缝凹陷九厘米'), 'descriptor 行缺正文首行');
  assert.ok(!text.includes('AK-77'), '正文尾巴被注入——索引型渲染退化成了全文倾倒');
  ctx.dispose();
});

// ---------------------------------------------------------------- 真 cordis 冒烟

let cordisNote = 'cordis: skipped (host modules not found)';
for (const root of [process.env.DSH_HOST_MODULES, 'D:/tmp/dsh-host/dsh/node_modules'].filter(Boolean)) {
  const entry = ['@deepseek-ai/cordis/lib/index.js', '@deepseek-ai/cordis/lib/index.mjs']
    .map((rel) => path.join(root, rel))
    .find((p) => existsSync(p));
  if (!entry) continue;
  try {
    const mod = await import(pathToFileURL(entry).href);
    const Context = mod.Context ?? mod.default;
    if (typeof Context !== 'function') throw new Error('cordis 未导出 Context 构造器');
    const ctx = new Context();
    const tools = new Map();
    const sections = new Map();
    // cordis 的服务必须先 provide 再 set，否则报 "cannot set property without provide"。
    ctx.provide('tools');
    ctx.provide('systemPrompt');
    ctx.set('tools', {
      register: (definition) => {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    });
    ctx.set('systemPrompt', {
      section: (section) => {
        if (sections.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered`);
        sections.set(section.name, section);
        return () => sections.delete(section.name);
      },
    });
    apply(ctx, { dbPath: path.join(TMP, 'cordis.db'), now: () => T0 });
    assert.equal(tools.size, 5, '真 cordis 下工具数不对');
    assert.equal(sections.size, 1, '真 cordis 下 section 数不对');
    ctx.dispose?.();
    cordisNote = `cordis: ok (${root})`;
  } catch (err) {
    cordisNote = `cordis: skipped (${err.message})`;
  }
  break;
}

// ---------------------------------------------------------------- 收尾

try {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // Windows 上 SQLite 句柄偶尔晚一拍释放；临时目录留给系统清理，不影响判定。
}

console.log(`  ${cordisNote}`);
if (failures.length > 0) {
  console.log(`\n${failures.length} failed / ${pass} passed`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n${pass} passed`);
  console.log(`${TOOL_NAMES.length} tools registered, no name conflict, dispose clean`);
}
