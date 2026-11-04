#!/usr/bin/env node
// memjudge 装机校验：源仓 → 装机副本 的**一致性**，不是插件能力验收。
//
// 三项检查（默认全部跑完，任一项 FAIL 退出码非 0）：
//   1. service  装机副本 `src/service.mjs` 存在、能 import 出 `createService`，且按契约
//               能装出一个冻结的只读服务面（用假 store，不碰任何库）。
//   2. sha256   源仓与装机副本**逐文件** SHA256 相等：`src/*.mjs` + `package.json` + `client.js`。
//               装机目录是独立副本（不是符号链接），改了源不同步 = 线上跑的是旧代码。
//   3. tier     库文件能打开，`memories` 表含 `tier` 列（schema v7）。
//               用**只读连接** `PRAGMA table_info`，绝不写库；库还是 v6 时输出
//               `tier:pending(v6)` 并退 0 —— 迁移由插件下次启动完成，不是装机故障。
//
// 输出格式：每个检查一行 `ok <检查名>` 或 `FAIL <检查名>`，结尾一行汇总。
//
// 用法：
//   node scripts/verify-install.mjs                    # 三项装机校验（默认）
//   node scripts/verify-install.mjs --json             # 同上，附带机读 JSON
//   node scripts/verify-install.mjs --install <dir>     # 指定装机目录
//   node scripts/verify-install.mjs --db <file>         # 指定库文件
//   node scripts/verify-install.mjs --capability        # 转去跑 12 项能力验收（较重）
//   node scripts/verify-install.mjs --mock / --keep / --profile <dir> / --report-only / --json
//                                                      # 这些参数一律转给能力验收脚本
//
// 「12 项能力验收」（装到隔离 profile、灌 20 章语料、跑幻觉题与冲突题）在
// `scripts/verify-capability.mjs`；本文件只负责轻量的装机一致性，几十毫秒跑完。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const CAPABILITY = path.join(HERE, 'verify-capability.mjs');

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** 只有这些参数才代表「要跑能力验收」；`--json` 两种模式都认，不是开关。 */
const CAPABILITY_FLAGS = ['--capability', '--mock', '--keep', '--profile', '--report-only'];

/* ---------------------------------------------------------------- 转发能力验收 */

const wantsCapability = argv.some((a) =>
  CAPABILITY_FLAGS.some((f) => a === f || a.startsWith(f + '=')),
);
if (wantsCapability) {
  if (!fs.existsSync(CAPABILITY)) {
    console.error(`FAIL capability: 能力验收脚本不存在：${CAPABILITY}`);
    process.exit(1);
  }
  // 深跑：装到隔离 profile、灌 20 章语料、跑幻觉/冲突题。`--capability` 自己不是它的参数。
  const passthrough = argv.filter((a) => a !== '--capability');
  const r = spawnSync(process.execPath, [CAPABILITY, ...passthrough], { stdio: 'inherit' });
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

/* ---------------------------------------------------------------- 三项装机校验 */

const INSTALL = path.resolve(opt('--install', path.join(os.homedir(), '.dsh', 'plugins', 'dsh-memjudge')));
const DB = path.resolve(
  opt('--db', path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memjudge', 'memjudge.db')),
);

/** 参与哈希比对的相对路径：`src/*.mjs` + `package.json` + `client.js`（不要求全量）。 */
function manifestOf(root) {
  const srcDir = path.join(root, 'src');
  const names = fs.existsSync(srcDir)
    ? fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs')).sort()
    : [];
  return [...names.map((f) => 'src/' + f), 'package.json', 'client.js'];
}

const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 检查 1：装机副本的服务模块能 import，且能按契约装出只读服务面。 */
async function checkService() {
  const file = path.join(INSTALL, 'src', 'service.mjs');
  if (!fs.existsSync(file)) {
    throw new Error(`装机副本缺 src/service.mjs（${file}）`);
  }
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.createService !== 'function') {
    throw new Error('src/service.mjs 没有导出 createService');
  }
  // 真构造一次：只为证明导出可用、契约没断；假 store 不打开任何库。
  const fakeStore = { stats: () => ({ memories: 0 }), bySourcePrefix: () => [], byKind: () => [] };
  const api = mod.createService(null, { store: fakeStore });
  const need = ['version', 'stats', 'recallByQuery', 'bySourcePrefix', 'byKind'];
  const miss = need.filter((k) => !(k in api));
  if (miss.length) throw new Error('服务面缺方法：' + miss.join(', '));
  if (!Object.isFrozen(api)) throw new Error('服务对象没有冻结（只读契约破了）');
  return `createService(${Object.keys(api).length} 项，已冻结，v${api.version})`;
}

/** 检查 2：源仓 ↔ 装机副本逐文件哈希相等。 */
function checkSha256() {
  if (path.resolve(SRC) === path.resolve(INSTALL)) {
    throw new Error(`源仓与装机目录是同一个路径（${SRC}），应从源仓运行本脚本`);
  }
  const list = manifestOf(SRC);
  if (!list.length) throw new Error('源仓里找不到 src/*.mjs');
  const diff = [];
  const miss = [];
  let same = 0;
  for (const rel of list) {
    const a = path.join(SRC, rel);
    const b = path.join(INSTALL, rel);
    if (!fs.existsSync(b)) {
      miss.push(rel);
      continue;
    }
    if (sha256Of(a) === sha256Of(b)) same += 1;
    else diff.push({ rel, src: sha256Of(a), dst: sha256Of(b) });
  }
  if (diff.length || miss.length) {
    const parts = [];
    for (const d of diff) parts.push(`${d.rel} 源=${d.src.slice(0, 12)} 装机=${d.dst.slice(0, 12)}`);
    for (const m of miss) parts.push(`${m} 装机缺失`);
    const err = new Error(`${diff.length} 个文件不一致、${miss.length} 个缺失 → 需 cp 同步`);
    err.detail = parts;
    throw err;
  }
  return `${same} 个文件逐一相同（src/*.mjs ${list.length - 2} + package.json + client.js）`;
}

/**
 * 检查 3：库能只读打开，`memories` 表有 tier 列。
 * @returns {{ status:'ok'|'pending'|'skip', detail:string }}
 */
async function checkTier() {
  if (!fs.existsSync(DB)) return { status: 'skip', detail: `库不存在（${DB}），本机还没跑过插件` };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (e) {
    throw new Error('node:sqlite 不可用（Node 版本过低？）：' + ((e && e.message) || e));
  }
  // readOnly：这条连接写出任何字节都算违约，tier 检查绝不能顺手迁移库。
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
      .get();
    if (!table) throw new Error('库里没有 memories 表');
    const cols = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
    let ver = '?';
    try {
      const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
      if (row && row.v != null) ver = String(row.v);
    } catch {
      /* 老库没有 meta 表：版本号当未知，只看列 */
    }
    if (cols.includes('tier')) {
      return { status: 'ok', detail: `tier:ok(v${ver}) memories ${cols.length} 列，含 tier` };
    }
    if (ver === '6') {
      return {
        status: 'pending',
        detail: `tier:pending(v6) 无 tier 列 —— 等插件下次启动自动迁移（本次只读，未写库）`,
      };
    }
    throw new Error(`库自称 v${ver} 却没有 tier 列（列：${cols.join(',')}）`);
  } finally {
    db.close();
  }
}

/* ---------------------------------------------------------------- 执行与输出 */

const results = [];
async function run(name, fn) {
  try {
    const detail = await fn();
    const isObj = detail && typeof detail === 'object';
    const status = isObj ? detail.status : 'ok';
    const text = isObj ? detail.detail : detail;
    results.push({ name, ok: true, status, detail: text });
    // pending / skip 都是「不是故障」，前缀仍是 ok —— 只有真不一致才 FAIL。
    console.log(`ok   ${name}: ${text}`);
  } catch (err) {
    results.push({ name, ok: false, status: 'fail', detail: (err && err.message) || String(err) });
    console.log(`FAIL ${name}: ${(err && err.message) || String(err)}`);
    for (const line of (err && err.detail) || []) console.log(`       ${line}`);
  }
}

console.log(`memjudge 装机校验 — 源仓 ${SRC}`);
console.log(`                    装机 ${INSTALL}`);
console.log(`                    库   ${DB}`);
console.log('');

await run('service', checkService);
await run('sha256', checkSha256);
await run('tier', checkTier);

const failed = results.filter((r) => !r.ok);
const tally = (s) => results.filter((r) => r.ok && r.status === s).length;
const pending = tally('pending');
const skip = tally('skip');
const passed = tally('ok');
const summary = `summary: ${passed} ok / ${failed.length} FAIL / ${pending} pending / ${skip} skip`;
console.log('');
console.log(summary);

if (has('--json')) {
  console.log(
    JSON.stringify(
      {
        src: SRC,
        install: INSTALL,
        db: DB,
        checks: results,
        summary: { total: results.length, passed, failed: failed.length, pending, skip },
      },
      null,
      2,
    ),
  );
}

if (failed.length) {
  console.log(`结论：${failed.map((r) => r.name).join(', ')} 未通过`);
  process.exitCode = 1;
} else {
  console.log('结论：装机一致');
}
