#!/usr/bin/env node
// memjudge 安装验证：装到隔离 profile，灌 20 章语料，跑 6 道幻觉题 + 4 道冲突题，打印达标情况。
//
// 用法：
//   node memjudge-plugin/scripts/verify-install.mjs                  # 临时隔离 profile，跑完删除
//   node memjudge-plugin/scripts/verify-install.mjs --keep           # 保留 profile 目录
//   node memjudge-plugin/scripts/verify-install.mjs --profile ./tmp  # 指定 profile 目录
//   node memjudge-plugin/scripts/verify-install.mjs --mock           # 不用真 cordis，走 mock 宿主
//   node memjudge-plugin/scripts/verify-install.mjs --report-only    # 不达标也退出 0
//
// 判定口径来自 docs/SPEC.md，不是 mem-eval/harness/score.mjs：
//   score.mjs:26 的 denyNearEntity 定义了却零调用，scoreHallucination 从不产出 deny，
//   所以历史 24 份结果的 halluDeny 结构性恒 0。本脚本按 SPEC §2.6 自己实现判定。
//
// 退出码：0 = 全部达标；1 = 有项不达标（脚本本身跑通）。加了 --report-only 则恒为 0。

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
const WORKSPACE = path.dirname(PLUGIN_ROOT);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const KEEP = flag('--keep');
const FORCE_MOCK = flag('--mock');
const REPORT_ONLY = flag('--report-only');
const JSON_OUT = flag('--json');

// 假时钟起点，与 SPEC P1 一致。
const T0 = Date.UTC(2026, 9, 27, 0, 0, 0);

// SPEC §2.6 逐字复制：DENY 与 NEAR_WINDOW 不得放宽。
const DENY = /没有|未记载|未提及|不存在|无法确定|资料中没有|原文没有|未说明|不详|查不到|没有提到|未包含|没有相关|无此信息|未见记载|未给出/;
const NEAR_WINDOW = 80;

const norm = (s) => String(s || '').replace(/[^\u4e00-\u9fff A-Za-z0-9]/g, '').replace(/\s+/g, '').toLowerCase();

/** SPEC §2.6 判据 1：否认词必须落在被问实体附近。 */
function denyNearEntity(text, absent) {
  const a = norm(text);
  const p = a.indexOf(norm(absent));
  if (p < 0) return false;
  const lo = Math.max(0, p - NEAR_WINDOW);
  const hi = Math.min(a.length, p + norm(absent).length + NEAR_WINDOW);
  return DENY.test(a.slice(lo, hi));
}

/** kw 里哪几项是数值（「十一厘米」是，「作废」不是）。 */
const NUMERIC = /^[零一二三四五六七八九十百千万亿两\d]+(?:点[零一二三四五六七八九\d]+)?(?:厘米|毫米|米|海里|节|吨|天|小时|分钟|美元|元|度|百帕|人|页)$/;

// ---------------------------------------------------------------- 隔离 profile

const profileDir = path.resolve(opt('--profile', mkdtempSync(path.join(tmpdir(), 'memjudge-verify-'))));
mkdirSync(profileDir, { recursive: true });
// defaultDbPath() 在 apply 内读取，这里设好即落在隔离目录。
process.env.DSH_HOME = profileDir;

const { apply, TOOL_NAMES, SECTION_NAME, INJECT_HARD_LIMIT } =
  await import(pathToFileURL(path.join(PLUGIN_ROOT, 'src', 'index.mjs')).href);
const { chapters } = await import(pathToFileURL(path.join(WORKSPACE, 'mem-eval', 'corpus', 'novel.mjs')).href);
const quiz = await import(pathToFileURL(path.join(WORKSPACE, 'mem-eval', 'corpus', 'quiz.mjs')).href);

// ---------------------------------------------------------------- 宿主装载

/** 复刻宿主 NamedEntries：重名直接抛错（@deepseek-ai/dsh-scope/lib/index.js:27）。 */
class NamedEntries {
  constructor(kind) {
    this.kind = kind;
    this.map = new Map();
  }

  insert(name, value) {
    if (this.map.has(name)) throw new Error(`${this.kind} "${name}" is already registered`);
    this.map.set(name, value);
    return () => this.map.delete(name);
  }
}

class MockContext {
  constructor() {
    this.tools = new NamedEntries('tool');
    this.systemPrompt = new NamedEntries('prompt section');
    this._effects = [];
  }

  effect(fn) {
    const entry = { cleanup: fn(), active: true };
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

/** 真 cordis Context：与 test/plugin.test.mjs 同一套 provide/set 路径。 */
async function cordisHost() {
  const roots = [process.env.DSH_HOST_MODULES, 'D:/tmp/dsh-host/dsh/node_modules'].filter(Boolean);
  for (const root of roots) {
    const entry = ['@deepseek-ai/cordis/lib/index.js', '@deepseek-ai/cordis/lib/index.mjs']
      .map((rel) => path.join(root, rel))
      .find((p) => existsSync(p));
    if (!entry) continue;
    const mod = await import(pathToFileURL(entry).href);
    const Context = mod.Context ?? mod.default;
    if (typeof Context !== 'function') throw new Error('cordis 未导出 Context 构造器');
    const ctx = new Context();
    const tools = new NamedEntries('tool');
    const sections = new NamedEntries('prompt section');
    ctx.provide('tools');
    ctx.provide('systemPrompt');
    ctx.set('tools', {
      register: (definition) => {
        if (typeof definition?.output?.render !== 'function') {
          throw new TypeError(`tool "${definition?.name}" must declare output { schema, render }`);
        }
        return tools.insert(definition.name, definition);
      },
    });
    ctx.set('systemPrompt', {
      section: (section) => {
        if (!Number.isFinite(section?.order)) throw new TypeError(`section "${section?.name}" order must be finite`);
        return sections.insert(section.name, section);
      },
    });
    return { ctx, tools, sections, host: `cordis (${root})` };
  }
  throw new Error('host modules not found');
}

async function install() {
  if (!FORCE_MOCK) {
    try {
      const { ctx, tools, sections, host } = await cordisHost();
      const handle = apply(ctx, { dbPath: path.join(profileDir, 'memjudge.db'), now: () => T0 });
      return {
        host,
        tools: tools.map,
        sections: sections.map,
        dispose: () => {
          handle.dispose();
          ctx.dispose?.();
        },
      };
    } catch (err) {
      // 宿主模块不在就退 mock，不影响验证插件本身。
      process.env.MEMJUDGE_MOCK_REASON = err.message;
    }
  }
  const ctx = new MockContext();
  const tools = new NamedEntries('tool');
  const sections = new NamedEntries('prompt section');
  // 与 cordis 宿主同形：插件只认 ctx.tools.register / ctx.systemPrompt.section
  ctx.tools = {
    register: (definition) => {
      if (typeof definition?.output?.render !== 'function') {
        throw new TypeError(`tool "${definition?.name}" must declare output { schema, render }`);
      }
      if (definition.name === 'run_code') throw new TypeError('tool "run_code" is reserved');
      return tools.insert(definition.name, definition);
    },
  };
  ctx.systemPrompt = {
    section: (section) => {
      if (!Number.isFinite(section?.order)) throw new TypeError(`section "${section?.name}" order must be finite`);
      return sections.insert(section.name, section);
    },
  };
  const handle = apply(ctx, { dbPath: path.join(profileDir, 'memjudge.db'), now: () => T0 });
  return {
    host: FORCE_MOCK ? 'mock (--mock)' : `mock (${process.env.MEMJUDGE_MOCK_REASON || 'forced'})`,
    tools: tools.map,
    sections: sections.map,
    dispose: () => {
      handle.dispose();
      ctx.dispose();
    },
  };
}

// ---------------------------------------------------------------- 执行

const out = [];
const say = (line = '') => {
  out.push(line);
  if (!JSON_OUT) console.log(line);
};

const sections = {};
const problems = [];

const installed = await install();
const tool = (name) => {
  const t = installed.tools.get(name);
  if (!t) throw new Error(`工具 ${name} 未注册`);
  return t;
};
const renderOf = (name, args, value) => {
  const blocks = tool(name).output.render(args, value);
  return (Array.isArray(blocks) ? blocks : [blocks]).map((b) => b?.text ?? '').join('');
};

say('memjudge 安装验证');
say(`  profile : ${profileDir}`);
say(`  db      : ${path.join(profileDir, 'memjudge.db')}`);
say(`  host    : ${installed.host}`);
say(`  工具    : ${[...installed.tools.keys()].sort().join(', ')}`);
say(`  section : ${[...installed.sections.keys()].join(', ') || '(none)'}`);

// 1. 注册面
sections.install = {
  tools: installed.tools.size,
  expectedTools: TOOL_NAMES.length,
  sections: installed.sections.size,
  sectionNames: [...installed.sections.keys()],
  collideMemoryPrefix: [...installed.tools.keys()].some((n) => /^memory/.test(n)),
};
say(`  注册    : ${sections.install.tools}/${TOOL_NAMES.length} 工具 + ${sections.install.sections} section，memory_* 前缀占用 ${sections.install.collideMemoryPrefix ? '有' : '无'}`);

// 2. 写入 20 章（按空行切段，与 adapter 同口径）
const segmentsOf = (chapter) => chapter.text
  .split(/\n\s*\n/)
  .map((text, i) => ({ text: text.trim(), chapter: chapter.n, para: i + 1 }))
  .filter((s) => s.text.length > 0);

const remember = tool('memjudge_remember');
const writeStart = Date.now();
let writeChars = 0;
let writeCount = 0;
for (const chapter of chapters) {
  for (const seg of segmentsOf(chapter)) {
    await remember.execute(seg);
    writeChars += seg.text.length;
    writeCount += 1;
  }
}
const writeMs = Date.now() - writeStart;

const stats = await tool('memjudge_stats').execute({ verbose: true });
sections.write = { chapters: chapters.length, memories: writeCount, chars: writeChars, ms: writeMs, bytes: stats.bytes ?? stats.storageBytes ?? null };
say(`  写入    : ${chapters.length} 章 / ${writeCount} 条 / ${writeChars} 字 / ${writeMs}ms`);

// 3. 六道幻觉题 —— 两个口径分开报
const hallu = [];
for (const item of quiz.hallucination) {
  const value = await tool('memjudge_recall').execute({ query: item.q });
  const text = renderOf('memjudge_recall', { query: item.q }, value);
  const specDeny = text.length >= 40 && denyNearEntity(text, item.absent);
  const leak = new RegExp(`${item.absent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]?\\s*[0-9]{2,}`).test(text);
  hallu.push({
    id: item.id,
    absent: item.absent,
    chars: text.length,
    toolDenied: value.denied === true,
    specDeny,
    leak,
    head: text.slice(0, 60).replace(/\s+/g, ' '),
  });
}

sections.hallucination = {
  rows: hallu,
  toolDenied: hallu.filter((h) => h.toolDenied).length,
  specDeny: hallu.filter((h) => h.specDeny).length,
  contaminate: hallu.filter((h) => h.leak).length,
  threshold: 5,
};

say('');
say('6 道幻觉题（SPEC §2.6：口否认词须落在被问实体 80 字内且返回 ≥40 字）');
say('  id  字数  工具拒答  SPEC判deny  邻近泄漏  返回开头');
for (const h of hallu) {
  say(`  ${h.id.padEnd(3)} ${String(h.chars).padStart(5)}  ${(h.toolDenied ? 'yes' : 'no ').padEnd(8)} ${(h.specDeny ? 'yes' : 'no ').padEnd(10)} ${(h.leak ? 'LEAK' : '-').padEnd(8)} ${h.head}`);
}

// 4. 四道冲突题：conflicts 工具（能力 10 的真判据）+ recall 材料层（对照）
const conflictsValue = await tool('memjudge_conflicts').execute({ limit: 50 });
const conflictRows = [];
for (const item of quiz.conflict) {
  const numeric = item.kw.filter((k) => NUMERIC.test(k));
  const groups = conflictsValue.conflicts ?? [];
  // 只认「把这两个值配成一对」的组：values 过长说明是把同单位的值全堆在一起，不算识别出矛盾。
  const pair = groups
    .filter((g) => numeric.every((k) => (g.values ?? []).includes(k)))
    .sort((a, b) => (a.values?.length ?? 0) - (b.values?.length ?? 0))[0];
  const recallValue = await tool('memjudge_recall').execute({ query: item.q });
  const recallText = renderOf('memjudge_recall', { query: item.q }, recallValue);
  conflictRows.push({
    id: item.id,
    numeric,
    pairFound: Boolean(pair),
    values: pair?.values ?? [],
    isolated: Boolean(pair) && pair.values.length <= 3,
    current: pair?.current ?? null,
    newSide: pair?.current === '十一厘米',
    recallHasBoth: numeric.filter((k) => recallText.includes(k)).length,
    recallChars: recallText.length,
  });
}

sections.conflict = {
  rows: conflictRows,
  total: conflictsValue.total ?? 0,
  isolated: conflictRows.filter((c) => c.isolated).length,
  newSide: conflictRows.filter((c) => c.newSide).length,
  threshold: 3,
};

say('');
say('4 道冲突题（能力 10 真判据 = conflicts 工具把两值配成一对 且 current 是后文修正值）');
say('  id  配成对  values数  current    newSide  recall带回kw');
for (const c of conflictRows) {
  say(`  ${c.id.padEnd(3)} ${(c.pairFound ? 'yes' : 'no ').padEnd(7)} ${String(c.values.length).padStart(6)}  ${String(c.current ?? '-').padEnd(9)} ${(c.newSide ? 'yes' : 'no ').padEnd(7)} ${c.recallHasBoth}/${c.numeric.length}（${c.recallChars} 字）`);
}
say(`  conflicts 工具共报 ${sections.conflict.total} 组：`);
for (const g of (conflictsValue.conflicts ?? [])) {
  say(`    - ${g.key}: ${g.values.length} 个值 → ${g.values.join(',')} ；current=${g.current}`);
}

// 5. 判定
const halluOk = sections.hallucination.specDeny >= sections.hallucination.threshold && sections.hallucination.contaminate === 0;
const conflictOk = sections.conflict.newSide >= sections.conflict.threshold;
const installOk = sections.install.tools === TOOL_NAMES.length && sections.install.sections === 1;

sections.verdict = {
  install: installOk,
  hallucination: halluOk,
  conflict: conflictOk,
  all: installOk && halluOk && conflictOk,
};

say('');
say('结论');
say(`  装上            : ${installOk ? 'PASS' : 'FAIL'}（${sections.install.tools}/${TOOL_NAMES.length} 工具 + ${sections.install.sections} section，名字零冲突）`);
say(`  幻觉拒答 ≥5/6   : ${halluOk ? 'PASS' : 'FAIL'}（SPEC 口径 ${sections.hallucination.specDeny}/6；工具自身 denied ${sections.hallucination.toolDenied}/6；污染 ${sections.hallucination.contaminate}/6）`);
say(`  冲突消解 ≥3/4   : ${conflictOk ? 'PASS' : 'FAIL'}（current 取到后文修正值 ${sections.conflict.newSide}/4；配成对的组 ${sections.conflict.isolated}/4）`);
say('');
if (!conflictOk) {
  say('  冲突项为何不达标：conflicts 按「同单位 + 共享名词」聚合，20 章库上把 12 个厘米值');
  say('  混成一组，current 取的是「时间最晚那句」的值，而最晚那句可能在复述旧值。');
  say('  这不是参数问题，是判断层实现缺陷（见 docs/AUDIT.md F4 与 docs/FINAL.md 能力 10）。');
}
if (!halluOk) {
  say('  幻觉项为何不达标：H3/H4 把整段原文倒出来（>600 字），没有否认句；');
  say('  H1/H2/H5/H6 是真拒答，但按 SPEC §2.6 的邻近窗口与 ≥40 字门槛不计数。');
}

// 6. 收尾
const disposeStart = Date.now();
installed.dispose();
sections.dispose = { ms: Date.now() - disposeStart, ok: true };
say(`  卸载            : clean（${sections.dispose.ms}ms）`);

if (JSON_OUT) console.log(JSON.stringify(sections, null, 2));

if (!KEEP) {
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows 上 sqlite 句柄偶尔晚一拍释放；目录留给系统清理，不影响判定。
  }
}

process.exitCode = sections.verdict.all || REPORT_ONLY ? 0 : 1;
