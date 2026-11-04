#!/usr/bin/env node
// memjudge 夜间整理：记忆层级（tier）升降。**默认 dry-run，只打印不动库。**
//
// 为什么要这个脚本：tier 是「这条记忆现在该不该占注入席位」的时效判断，它必须由
// 时间和命中率推动，不能由会话里的模型随手改。src/layer.mjs 的 sleepPhase 只出提案
// （纯函数、不写库），真正落库收敛到这一个入口，且必须显式 --apply。
//
// 两条规则（都只对 event 生效，人 / 约恒 tier=1 永不参与）：
//   到期下沉：last_accessed 距今 > 30 天        → tier = MIN(5, tier + 1)
//   命中上浮：access_count >= 5 且 tier > 1     → tier = tier - 1
// 两者**互斥**：下沉那条额外要求 access_count < 5。一条被读过 5 次以上的记忆即使
// 30 天没被再读也不下沉——「被反复读过」是比「最近没读」更强的信号，让后者把前者
// 摁下去，这套分层就退化成只看最后访问时间的 LRU。
//
// 用法：
//   node scripts/nightly.mjs                     # 默认 dry-run：打印将要写什么
//   node scripts/nightly.mjs --dry-run           # 同上（显式写法）
//   node scripts/nightly.mjs --apply             # 真写库（写前自动备份）
//   node scripts/nightly.mjs --db <path>         # 指定库文件
//   node scripts/nightly.mjs --verbose           # 逐条打印提案
// 退出码：0 = 正常；1 = 库不可用/写入失败；2 = 库还没迁移到 v7（缺 tier 列）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  open as openStore,
  TIER_IDLE_DAYS,
  TIER_PROMOTE_ACCESS,
  MEMORY_TIER_MAX,
  MEMORY_TIER_PINNED,
  MEMORY_TIER_EVENT,
} from '../src/store.mjs';

const DAY_MS = 86400000;
const PINNED_KINDS = ['person', 'promise'];

function parseArgs(argv) {
  const out = { apply: false, dbPath: '', verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--db') {
      out.dbPath = String(argv[i + 1] ?? '');
      i += 1;
    } else if (a.startsWith('--db=')) out.dbPath = a.slice(5);
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`未知参数：${a}`);
  }
  return out;
}

/** 与 src/index.mjs 的 defaultDbPath 同口径：<DSH_HOME|~/.dsh>/memjudge/memjudge.db */
function defaultDbPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'memjudge', 'memjudge.db');
}

const HELP = `memjudge nightly —— 记忆层级（tier）升降，默认 dry-run

  node scripts/nightly.mjs [--apply] [--db <path>] [--verbose]

  --apply    真写库（默认只打印；写前自动备份到 <db>.bak-nightly-<时间戳>）
  --db       指定库文件（默认 ${'<DSH_HOME|~/.dsh>'}/memjudge/memjudge.db）
  --verbose  逐条打印升降提案

规则（只对 event 生效，人/约恒 tier=1）：
  到期下沉  last_accessed 距今 > ${TIER_IDLE_DAYS} 天        → tier = MIN(${MEMORY_TIER_MAX}, tier + 1)
  命中上浮  access_count >= ${TIER_PROMOTE_ACCESS} 且 tier > ${MEMORY_TIER_PINNED}   → tier = tier - 1
  两条互斥：下沉要求 access_count < ${TIER_PROMOTE_ACCESS}
`;

/**
 * 只读统计一条 SQL 的命中行（dry-run 用）。readOnly 连接保证不产生 -wal/-journal，
 * 库文件一个字节都不变——验收项要求 dry-run 前后 sha256 相等，靠的就是这条。
 */
function countRows(db, where, params) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(...params).n) || 0;
}

function listRows(db, where, params, tierExpr = 'tier', limit = 50) {
  return db.prepare(`SELECT id, kind, ${tierExpr} AS tier, access_count AS accessCount,
    last_accessed AS lastAccessed FROM memories WHERE ${where} LIMIT ?`).all(...params, limit);
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  const dst = `${file}.bak-nightly-${stamp}`;
  fs.copyFileSync(file, dst);
  return dst;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const dbPath = path.resolve(args.dbPath || defaultDbPath());
  if (!fs.existsSync(dbPath)) {
    console.error(`[nightly] 库不存在：${dbPath}`);
    return 1;
  }

  const mode = args.apply ? 'apply' : 'dry-run';
  const now = Date.now();
  const idleCutoff = now - TIER_IDLE_DAYS * DAY_MS;

  // 两段规则与上面的注释一一对应；下沉那条额外要求 access_count < 上浮阈值（互斥）。
  // dry-run 里 tier 可能还不存在（v6 库还没被插件打开过），此时把「迁移后的基线层级」
  // 当常量估：人/约 → t1、事 → t3——一个字节不写也能报出真实的下沉/上浮量。
  const pinnedSql = PINNED_KINDS.map((k) => `'${k}'`).join(', ');
  const tierBaseline = `CASE WHEN kind IN (${pinnedSql}) THEN ${MEMORY_TIER_PINNED} ELSE ${MEMORY_TIER_EVENT} END`;
  const wherePromote = (tierExpr) => `kind NOT IN (${pinnedSql})`
    + ` AND access_count >= ${TIER_PROMOTE_ACCESS}`
    + ` AND ${tierExpr} > ${MEMORY_TIER_PINNED}`;
  const whereDemote = (tierExpr) => `kind NOT IN (${pinnedSql})`
    + ` AND access_count < ${TIER_PROMOTE_ACCESS}`
    + ` AND last_accessed < ?`
    + ` AND ${tierExpr} < ${MEMORY_TIER_MAX}`;

  if (!args.apply) {
    // ── dry-run：只读连接，不迁移、不写 meta、不建索引 ────────────────────
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const hasTier = db.prepare('PRAGMA table_info(memories)').all().some((c) => c.name === 'tier');
      const tierExpr = hasTier ? 'tier' : tierBaseline;
      const promoteWhere = wherePromote(tierExpr);
      const demoteWhere = whereDemote(tierExpr);
      const total = Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n) || 0;
      const pinned = Number(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE kind IN (${pinnedSql})`).get().n) || 0;
      const promote = countRows(db, promoteWhere, []);
      const demote = countRows(db, demoteWhere, [idleCutoff]);
      const skipped = Math.max(0, total - promote - demote);
      const dist = hasTier
        ? db.prepare('SELECT tier, COUNT(*) AS n FROM memories GROUP BY tier ORDER BY tier').all()
          .map((r) => `t${r.tier}:${r.n}`).join(' ')
        : `（v6 库无 tier 列，按迁移后基线预估：人/约 t${MEMORY_TIER_PINNED}、事 t${MEMORY_TIER_EVENT}）`;
      const tag = hasTier ? '[dry-run]' : '[dry-run·v6预估]';
      console.log(`${tag} 升级 ${promote} 条 / 下沉 ${demote} 条 / 跳过 ${skipped} 条（库内 ${total} 条，其中人+约 ${pinned} 条恒 t${MEMORY_TIER_PINNED}）`);
      console.log(`${tag} ${hasTier ? '当前分布' : '分布'} ${dist || '（空库）'}；库文件未改动：${dbPath}`);
      if (args.verbose) {
        for (const r of listRows(db, promoteWhere, [], tierExpr)) {
          console.log(`  ↑ ${r.id} (${r.kind}) t${r.tier} → t${r.tier - 1}  命中 ${r.accessCount} 次`);
        }
        for (const r of listRows(db, demoteWhere, [idleCutoff], tierExpr)) {
          const days = Math.round((now - Number(r.lastAccessed)) / DAY_MS);
          console.log(`  ↓ ${r.id} (${r.kind}) t${r.tier} → t${Math.min(MEMORY_TIER_MAX, r.tier + 1)}  闲置 ${days} 天`);
        }
      }
      return 0;
    } finally {
      db.close();
    }
  }

  // ── apply：走 store.open（真源迁移 + 落库），写前备份 ──────────────────
  const bak = backup(dbPath);
  console.log(`[apply] 已备份 ${bak}`);
  const store = openStore(dbPath);
  try {
    const db = store.raw();
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n) || 0;
    const pinned = Number(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE kind IN (${pinnedSql})`).get().n) || 0;
    db.exec('BEGIN');
    let promoted = 0;
    let demoted = 0;
    try {
      // 先上浮后下沉：两条 WHERE 互斥（下沉要求 access_count < 阈值），顺序不影响结果，
      // 但显式定序让日志可复现。
      promoted = Number(db.prepare(`UPDATE memories SET tier = tier - 1 WHERE ${wherePromote('tier')}`).run().changes) || 0;
      demoted = Number(db.prepare(`UPDATE memories SET tier = MIN(${MEMORY_TIER_MAX}, tier + 1) WHERE ${whereDemote('tier')}`).run(idleCutoff).changes) || 0;
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const skipped = Math.max(0, total - promoted - demoted);
    const dist = db.prepare('SELECT tier, COUNT(*) AS n FROM memories GROUP BY tier ORDER BY tier').all()
      .map((r) => `t${r.tier}:${r.n}`).join(' ');
    console.log(`[apply] 升级 ${promoted} 条 / 下沉 ${demoted} 条 / 跳过 ${skipped} 条（库内 ${total} 条，其中人+约 ${pinned} 条恒 t${MEMORY_TIER_PINNED}）`);
    console.log(`[apply] 写入后分布 ${dist || '（空库）'}；回滚副本 ${bak}`);
    return 0;
  } finally {
    store.close();
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(`[nightly] 失败：${err?.stack ?? err}`);
  process.exitCode = 1;
});
