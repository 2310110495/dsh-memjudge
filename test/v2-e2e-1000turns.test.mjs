/**
 * T8 [P4-C] v2 端到端记忆能力实测与 1000 轮容量收敛压测套件
 *
 * 覆盖三大硬性验收场景：
 * - 场景 A：v7 -> v8 无损升迁实证（自包含 v7 SQLite 固件 + 本地线上真库只读沙盒拷贝双轨验证）
 *   验证 schema_version === '8'、7 条核心记忆 100% 落入 space_id='global'、正文 UTF-16 SHA-256 逐字无损、
 *   范畴映射（promise->rule, person->profile, event->experience）、tier=1 保留在 L0 常驻保护层、重复 open() 3 次幂等。
 * - 场景 B：跨会话记住“自己说过的话与做过的事” + 单活状态覆写 + 噪声零入库 + 工作区物理隔离 + 两段式注入
 *   验证 Session 1 自动脱水 40-160 字 decision/experience（剥离代码块尸块）、state 同 slot_key 3 次变更原地覆写且
 *   前 2 次保存在 memory_revisions、催促短句（“继续”、“好的快弄”）与 subagent 汇报严格 0 入库、工作区 B 物理隔离；
 *   验证 Session 2 多步工具循环 Tier-S 逐字节 100% 恒定（<= 600 chars）、追问历史决策/Bug 时 Tier-D 精准召回（<= 900 chars，
 *   工作区 B 零串味）、寒暄或无关提问时 Tier-D 严格返回 0 chars。
 * - 场景 C：1,000 轮连续对话全链路代谢收敛与 P95 延迟压测
 *   驱动 1,000 轮真实分布对话 + processIngestQueue + 周期 runMetabolism（L0 保守、L1 双半衰期衰减、L2 wiki_pages 编译、
 *   L3 远期归档压缩 + SQLite VACUUM 空间回收）：
 *   1) 1,000 轮落盘后物理 .db 文件字节数 <= 262,144 bytes（256 KB）；
 *   2) 全程任意单步 Tier-S + Tier-D 总注入字符数 <= 1500 chars（Tier-S <= 600, Tier-D <= 900）；
 *   3) 1,000 轮落盘后 100 次三路混合检索查询延迟 P95 < 15 ms。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import { apply, SECTION_NAME, CONTEXT_NAME } from '../src/index.mjs';
import { open } from '../src/store.mjs';
import { TIER_L0 } from '../src/schema.mjs';
import { GLOBAL_SPACE_ID, resolveScope } from '../src/scope.mjs';
import { computeTier, partitionMemories } from '../src/layer.mjs';
import { createTurnCollector } from '../src/turn-collector.mjs';
import { processIngestQueue } from '../src/distiller.mjs';
import { runMetabolism } from '../src/lifecycle.mjs';
import {
  InjectionEngine,
  TIER_S_MAX_CHARS,
  TIER_D_MAX_CHARS,
  TOTAL_INJECT_MAX_CHARS,
} from '../src/inject.mjs';
import { SearchIndex, hybridSearch } from '../src/search.mjs';

const LIVE_V7_DB_PATH = 'C:\\Users\\23101\\.dsh\\memjudge\\memjudge.db';

/** 计算字符串的 UTF-16LE 码元级 SHA-256 摘要（逐 UTF-16 code unit 严格校验无损）。 */
function utf16Sha256(str) {
  return crypto.createHash('sha256').update(Buffer.from(String(str), 'utf16le')).digest('hex');
}

/** 计算磁盘文件的原始字节级 SHA-256 摘要（用于证明线上真库 100% 未被触碰）。 */
function fileBytesSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 在 os.tmpdir() 中分配独立沙盒目录，确保测后 100% 物理清理零残留。 */
async function withSandboxDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    assert.equal(fs.existsSync(dir), false, `沙盒临时目录必须 100% 清理无残留: ${dir}`);
  }
}

/** 构造确定性 16 维归一化测试向量（供三路 RRF 混合检索压测使用，不依赖外部网络）。 */
function deterministicEmbed(texts) {
  return texts.map((t) => {
    const vec = new Float32Array(16);
    const s = String(t || '');
    for (let i = 0; i < s.length; i++) {
      vec[i % 16] += ((s.charCodeAt(i) * 31 + i * 17) % 97) / 97;
    }
    let norm = 0;
    for (let d = 0; d < 16; d++) norm += vec[d] * vec[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < 16; d++) vec[d] /= norm;
    return vec;
  });
}

/**
 * 构建自包含 v7 SQLite 数据库固件：
 * - 5 条 promise (tier=1, source=null)
 * - 1 条 person  (tier=1, source=null)
 * - 1 条 event   (tier=1, source=null)
 * - 10 条脏 auto 记录 (kind='event', tier=3, source='auto:...', 含孤儿引用与旧版 vector_blob)
 */
function buildSelfContainedV7Fixture(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    INSERT INTO meta (k, v) VALUES ('schema_version', '7');

    CREATE TABLE memories (
      id             TEXT PRIMARY KEY,
      text           TEXT NOT NULL,
      text_hash      TEXT NOT NULL UNIQUE,
      created_at     INTEGER NOT NULL,
      last_accessed  INTEGER NOT NULL,
      access_count   INTEGER NOT NULL DEFAULT 0,
      importance     REAL NOT NULL DEFAULT 0,
      supersedes     TEXT,
      source         TEXT,
      kind           TEXT NOT NULL DEFAULT 'event',
      tier           INTEGER NOT NULL DEFAULT 3
    );

    CREATE TABLE memory_occurrences (
      memory_id   TEXT NOT NULL,
      source_key  TEXT NOT NULL DEFAULT '',
      chapter_key INTEGER NOT NULL DEFAULT -1,
      para_key    INTEGER NOT NULL DEFAULT -1,
      document_id TEXT,
      source      TEXT,
      chapter     INTEGER,
      para        INTEGER,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (memory_id, source_key, chapter_key, para_key)
    );

    CREATE TABLE segments (
      memory_id TEXT NOT NULL,
      seq       INTEGER NOT NULL,
      text      TEXT NOT NULL,
      PRIMARY KEY (memory_id, seq)
    );

    CREATE TABLE vector_blob (
      slot INTEGER PRIMARY KEY CHECK (slot = 0),
      data BLOB NOT NULL
    );
  `);

  const baseTs = Date.UTC(2026, 0, 10, 8, 0, 0);
  const coreRecords = [
    {
      id: 'mem-v7-promise-1',
      kind: 'promise',
      tier: 1,
      importance: 0.95,
      source: null,
      text: '【十二项能力标准】存得准、原样回原文、找得回、不胡编、未记载明确拒答，UTF-16 表情 🧪🚀 与引号「原话」逐字保持。',
    },
    {
      id: 'mem-v7-promise-2',
      kind: 'promise',
      tier: 1,
      importance: 0.92,
      source: null,
      text: '【团队协作铁律】复杂记忆插件演进必须通过专家编排分派实现与独立评审，禁止单对话硬写全部模块。',
    },
    {
      id: 'mem-v7-promise-3',
      kind: 'promise',
      tier: 1,
      importance: 0.9,
      source: null,
      text: '【借鉴准则】借鉴外部项目只看核心源码实现与真实数据结构，绝不轻信 README 宣传吹嘘。',
    },
    {
      id: 'mem-v7-promise-4',
      kind: 'promise',
      tier: 1,
      importance: 0.9,
      source: null,
      text: '【目标导向】不为抄袭而抄袭，仅在确需补齐核心短板时精准吸收，杜绝臃肿拼凑。',
    },
    {
      id: 'mem-v7-promise-5',
      kind: 'promise',
      tier: 1,
      importance: 0.95,
      source: null,
      text: '【质量红线】绝不交付缩水简化版，严格验证边界、并发、持久层事务与物理体积收敛。',
    },
    {
      id: 'mem-v7-person-1',
      kind: 'person',
      tier: 1,
      importance: 0.95,
      source: null,
      text: '【用户基础设施】YG 拥有本地高性能工作站、云服务器集群、DeepSeek API Key 与本地嵌入向量模型。',
    },
    {
      id: 'mem-v7-event-pinned-1',
      kind: 'event',
      tier: 1,
      importance: 0.88,
      source: null,
      text: '【已知跨路由故障】同一会话中途切换不同上游 LLM Provider 会引发工具调用历史签名断裂，需固定单会话路由。',
    },
  ];

  const dirtyAutoRecords = Array.from({ length: 10 }, (_, idx) => ({
    id: `mem-v7-auto-${idx + 1}`,
    kind: 'event',
    tier: 3,
    importance: 0.25,
    source: `auto:legacy-session-${(idx % 3) + 1}:turn-${idx + 1}`,
    text: `历史自动抓取流水记录 #${idx + 1}：执行临时调试脚本输出状态码 200，耗时 ${15 + idx}ms。`,
  }));

  const insMem = db.prepare(`
    INSERT INTO memories (id, text, text_hash, created_at, last_accessed, access_count, importance, supersedes, source, kind, tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `);
  const insOcc = db.prepare(`
    INSERT INTO memory_occurrences (memory_id, source_key, chapter_key, para_key, document_id, source, chapter, para, created_at)
    VALUES (?, ?, 0, ?, ?, ?, 0, ?, ?)
  `);

  for (let i = 0; i < coreRecords.length; i++) {
    const r = coreRecords[i];
    const h = crypto.createHash('sha256').update(r.text, 'utf8').digest('hex');
    insMem.run(r.id, r.text, h, baseTs + i * 1000, baseTs + i * 1000, 3, r.importance, r.source, r.kind, r.tier);
    insOcc.run(r.id, 'manual', i, 'doc-core', '手动写入', i, baseTs + i * 1000);
  }

  for (let i = 0; i < dirtyAutoRecords.length; i++) {
    const r = dirtyAutoRecords[i];
    const h = crypto.createHash('sha256').update(r.text, 'utf8').digest('hex');
    const ts = baseTs + (i + 20) * 1000;
    insMem.run(r.id, r.text, h, ts, ts, 0, r.importance, r.source, r.kind, r.tier);
    insOcc.run(r.id, r.source, i, null, r.source, i, ts);
  }
  // 故意插入 1 条孤儿 occurrence 模拟 v7 脏残留
  insOcc.run('mem-v7-orphan-ghost', 'auto:ghost', 99, null, 'auto:ghost', 99, baseTs);
  db.prepare('INSERT INTO vector_blob (slot, data) VALUES (0, ?)').run(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  db.close();
}

/**
 * 在任意待测 v7 SQLite 库路径上提取迁移前基线快照，并执行完整的 v7 -> v8 无损升迁与 3 次幂等重开断言。
 */
function verifyV7ToV8LosslessMigration(v7DbPath, label) {
  // 1. 提取迁移前 v7 原始基线（全表记录 + 7 条 tier=1 核心记忆）
  const preDb = new DatabaseSync(v7DbPath);
  const preSchemaVer = preDb.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()?.v;
  assert.equal(preSchemaVer, '7', `[${label}] 迁移前 schema_version 应为 '7'`);

  const preAllRows = preDb
    .prepare('SELECT id, text, kind, tier, importance, source, created_at FROM memories ORDER BY created_at ASC, id ASC')
    .all();
  preDb.close();

  const preCoreRows = preAllRows.filter((r) => Number(r.tier) === 1);
  const prePromises = preCoreRows.filter((r) => r.kind === 'promise');
  const prePersons = preCoreRows.filter((r) => r.kind === 'person');
  const prePinnedEvents = preCoreRows.filter((r) => r.kind === 'event');

  assert.equal(preCoreRows.length, 7, `[${label}] 应包含 7 条 tier=1 核心记忆`);
  assert.equal(prePromises.length, 5, `[${label}] 核心记忆应包含 5 条 promise`);
  assert.equal(prePersons.length, 1, `[${label}] 核心记忆应包含 1 条 person`);
  assert.equal(prePinnedEvents.length, 1, `[${label}] 核心记忆应包含 1 条 tier=1 event`);

  const preUtf16HashById = new Map(preAllRows.map((r) => [r.id, utf16Sha256(r.text)]));

  // 2. 连续重复 open() 3 次，验证升迁准确性与幂等性
  const future90DaysMs = Date.now() + 90 * 86_400_000;
  let migratedSummary = null;

  for (let round = 1; round <= 3; round++) {
    const store = open(v7DbPath);
    try {
      const stats = store.stats();
      assert.equal(stats.schemaVersion, 8, `[${label}][open #${round}] stats.schemaVersion 必须为 8`);

      const raw = store.raw();
      const metaSchemaVer = raw.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()?.v;
      assert.equal(metaSchemaVer, '8', `[${label}][open #${round}] meta.schema_version 必须为 '8'`);

      // 全表行数零丢失、零重复膨胀
      const postRows = raw
        .prepare('SELECT id, space_id, category, tier, status, text FROM memories')
        .all();
      assert.equal(
        postRows.length,
        preAllRows.length,
        `[${label}][open #${round}] 迁移后总记录数必须与 v7 完全一致（无丢失、无重复）`,
      );

      const postById = new Map(postRows.map((r) => [r.id, r]));

      // 逐条对账全部记忆的正文 UTF-16 SHA-256
      for (const pre of preAllRows) {
        const post = postById.get(pre.id);
        assert.ok(post, `[${label}][open #${round}] 记忆 ${pre.id} 迁移后不得丢失`);
        assert.equal(
          utf16Sha256(post.text),
          preUtf16HashById.get(pre.id),
          `[${label}][open #${round}] 记忆 ${pre.id} 正文 UTF-16 SHA-256 必须逐字无损一致`,
        );
        const viaApi = store.get(pre.id);
        assert.ok(viaApi, `[${label}][open #${round}] store.get(${pre.id}) 必须可读`);
        assert.equal(
          utf16Sha256(viaApi.text),
          preUtf16HashById.get(pre.id),
          `[${label}][open #${round}] store.get(${pre.id}).text UTF-16 SHA-256 必须无损一致`,
        );
      }

      // 重点核验 7 条核心记忆：100% 落入 global、范畴准确映射、保留在 L0 常驻保护层
      const coreCategoryCounts = { rule: 0, profile: 0, experience: 0 };
      const coreViaApi = [];
      for (const corePre of preCoreRows) {
        const post = postById.get(corePre.id);
        assert.equal(
          post.space_id,
          GLOBAL_SPACE_ID,
          `[${label}][open #${round}] 核心记忆 ${corePre.id} 必须落入 space_id='global'`,
        );
        assert.equal(post.status, 'active', `[${label}][open #${round}] 核心记忆 ${corePre.id} 必须为 active`);

        const expectedCategory =
          corePre.kind === 'promise' ? 'rule' : corePre.kind === 'person' ? 'profile' : 'experience';
        assert.equal(
          post.category,
          expectedCategory,
          `[${label}][open #${round}] 核心记忆 ${corePre.id} (${corePre.kind}) 应映射为 ${expectedCategory}`,
        );
        coreCategoryCounts[post.category] += 1;

        assert.equal(
          Number(post.tier),
          TIER_L0,
          `[${label}][open #${round}] 原 tier=1 核心记忆 ${corePre.id} 底层 tier 应映射为 L0 (0)`,
        );

        const memObj = store.get(corePre.id);
        coreViaApi.push(memObj);
        assert.equal(
          computeTier(memObj, { now: future90DaysMs }),
          TIER_L0,
          `[${label}][open #${round}] 核心记忆 ${corePre.id} 在 90 天后仍必须锁定在 L0 常驻保护层`,
        );
      }

      assert.deepEqual(
        coreCategoryCounts,
        { rule: 5, profile: 1, experience: 1 },
        `[${label}][open #${round}] 7 条核心记忆范畴分布应精确为 5 rule + 1 profile + 1 experience`,
      );

      const partitioned = partitionMemories(coreViaApi, { now: future90DaysMs });
      assert.equal(partitioned.L0.length, 7, `[${label}][open #${round}] 7 条核心记忆在 partitionMemories 下必须 100% 位于 L0`);

      // 脏 auto 记录（v7 kind='event', tier=3）同样无损映射为 experience 且位于 global
      const autoPreRows = preAllRows.filter((r) => Number(r.tier) !== 1);
      for (const autoPre of autoPreRows) {
        const post = postById.get(autoPre.id);
        assert.equal(post.space_id, GLOBAL_SPACE_ID);
        assert.equal(post.category, 'experience');
      }

      if (round === 3) {
        store.compact();
        migratedSummary = {
          label,
          totalMigrated: postRows.length,
          coreCount: preCoreRows.length,
          dirtyAutoCount: autoPreRows.length,
          coreCategoryCounts,
          compactBytes: store.bytes(),
        };
      }
    } finally {
      store.close();
    }
  }

  assert.ok(fs.existsSync(`${v7DbPath}.v7.bak`), `[${label}] 迁移前应自动生成 .v7.bak 热备文件`);
  return migratedSummary;
}

/**
 * 构建模拟 DSH 宿主上下文，支持插件全生命周期事件驱动与两段式注入调用。
 */
function createMockHost({ initialSessions = {} } = {}) {
  const tools = new Map();
  const sections = new Map();
  const contexts = new Map();
  const routes = new Map();
  const provided = new Map();
  const cleanups = [];
  const sessionListeners = new Set();
  const sessionHeaders = new Map(Object.entries(initialSessions));

  const sessionsService = {
    getHeader(sessionId) {
      return sessionHeaders.get(sessionId) ?? null;
    },
    setHeader(sessionId, header) {
      sessionHeaders.set(sessionId, header);
    },
    subscribeEvents(fn) {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
  };

  const host = {
    tools: {
      register(name, def) {
        tools.set(name, def);
        return () => tools.delete(name);
      },
    },
    systemPrompt: {
      section(nameOrSpec, fn) {
        const name = typeof nameOrSpec === 'object' ? nameOrSpec.name : nameOrSpec;
        const cb = typeof nameOrSpec === 'object' ? nameOrSpec.text : fn;
        sections.set(name, cb);
        return () => sections.delete(name);
      },
      context(nameOrSpec, fn) {
        const name = typeof nameOrSpec === 'object' ? nameOrSpec.name : nameOrSpec;
        const cb = typeof nameOrSpec === 'object' ? nameOrSpec.text : fn;
        contexts.set(name, cb);
        return () => contexts.delete(name);
      },
    },
    connection: {
      fetch: {
        register(route, handler) {
          routes.set(route, handler);
          return () => routes.delete(route);
        },
      },
    },
    provide(name, val) {
      provided.set(name, val);
    },
    effect(fn) {
      const stop = fn();
      if (typeof stop === 'function') cleanups.push(stop);
    },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('sessions')) {
        const sctx = {
          sessions: sessionsService,
          on(evName, fn) {
            if (evName === 'session/event') {
              sessionListeners.add(fn);
              return () => sessionListeners.delete(fn);
            }
            return () => {};
          },
        };
        const stop = cb(sctx);
        if (typeof stop === 'function') cleanups.push(stop);
      }
    },
    on(event, fn) {
      if (event === 'dispose') cleanups.push(fn);
      if (event === 'session/event') {
        sessionListeners.add(fn);
        return () => sessionListeners.delete(fn);
      }
    },
    emitSessionEvent(sessionId, ev) {
      const header = sessionHeaders.get(sessionId) ?? { id: sessionId };
      const sessionObj = { id: sessionId, header };
      for (const fn of sessionListeners) fn(sessionObj, { sessionId, ...ev });
    },
    async dispose() {
      while (cleanups.length) {
        const fn = cleanups.pop();
        try {
          await fn();
        } catch {}
      }
    },
    _tools: tools,
    _sections: sections,
    _contexts: contexts,
    _provided: provided,
    _sessionsService: sessionsService,
  };

  return host;
}

let turnCounter = 0;
/** 驱动完整一轮对话事件并在微任务/定时器结算后等待 ingest_queue 清空。 */
async function driveHostTurn(host, rawStore, { sessionId, turnNo, userText, toolEvents = [], assistantText }) {
  const tNo = Number.isInteger(turnNo) ? turnNo : (turnCounter += 1);
  host.emitSessionEvent(sessionId, { type: 'turn/start', turn: tNo });
  if (userText !== undefined) {
    host.emitSessionEvent(sessionId, { type: 'user/message', turn: tNo, message: { content: userText } });
  }
  for (const te of toolEvents) {
    host.emitSessionEvent(sessionId, {
      type: 'tool/result',
      turn: tNo,
      toolName: te.toolName,
      isError: Boolean(te.isError),
      output: te.summary ?? 'ok',
    });
  }
  if (assistantText !== undefined) {
    host.emitSessionEvent(sessionId, { type: 'assistant/message', turn: tNo, message: { content: assistantText } });
  }
  host.emitSessionEvent(sessionId, { type: 'turn/end', turn: tNo });

  // 等待 scheduleIngestDrain(0) 异步落库完成
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
    const pending = rawStore
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM ingest_queue WHERE status IN ('pending', 'processing')")
      .get().n;
    if (pending === 0) break;
  }
}

describe('T8: memjudge v2 端到端记忆能力实测与 1000 轮容量收敛压测套件', () => {
  test('场景 A（自包含 v7 固件）：v7 -> v8 无损升迁、UTF-16 SHA-256 逐字一致、L0 保护层与 3 次 open 幂等', async (t) => {
    await withSandboxDir('mj-t8-sceneA-fixture-', async (tmpDir) => {
      const dbPath = path.join(tmpDir, 'fixture-v7.db');
      buildSelfContainedV7Fixture(dbPath);

      const summary = verifyV7ToV8LosslessMigration(dbPath, 'self-contained-v7-fixture');
      t.diagnostic(
        `[Scene A - Fixture] migrated=${summary.totalMigrated}, core=${summary.coreCount}, auto=${summary.dirtyAutoCount}, compactBytes=${summary.compactBytes}`,
      );
      assert.equal(summary.totalMigrated, 17);
      assert.equal(summary.coreCount, 7);
    });
  });

  test('场景 A（本地线上真库只读沙盒拷贝）：真库零修改验证 + 92 条记录及 7 条核心记忆 100% 无损升迁 v8', async (t) => {
    if (!fs.existsSync(LIVE_V7_DB_PATH)) {
      t.diagnostic(`[Scene A - Live Copy] 宿主机未发现 ${LIVE_V7_DB_PATH}，跳过真库拷贝分支（已由自包含固件完整覆盖）`);
      return;
    }

    // 事前锁定线上真库的字节长度与字节级 SHA-256，严禁对原库产生任何写入
    const liveBeforeStat = fs.statSync(LIVE_V7_DB_PATH);
    const liveBeforeHash = fileBytesSha256(LIVE_V7_DB_PATH);

    await withSandboxDir('mj-t8-sceneA-livecopy-', async (tmpDir) => {
      const sandboxDbPath = path.join(tmpDir, 'memjudge-live-copy.db');
      fs.copyFileSync(LIVE_V7_DB_PATH, sandboxDbPath);

      const summary = verifyV7ToV8LosslessMigration(sandboxDbPath, 'live-db-readonly-copy');
      assert.ok(summary.totalMigrated >= 7);
      assert.equal(summary.coreCount, 7);

      // 进一步验证：对升迁后的副本执行一次全链路代谢，7 条核心记忆仍 100% 位于 L0，且 85 条陈旧 auto 脏记录归档收敛至 <= 256 KB
      const postStore = open(sandboxDbPath);
      try {
        const metaRep = runMetabolism(postStore, {
          now: Date.now() + 45 * 86_400_000,
          softLimitBytes: 180 * 1024,
          hardLimitBytes: 256 * 1024,
          vacuumOnPressure: true,
        });
        const afterMetabolismBytes = postStore.bytes();
        assert.ok(
          afterMetabolismBytes <= 262_144,
          `真库副本升迁并执行一次代谢后物理体积 (${afterMetabolismBytes}) 应收敛至 <= 262,144 bytes`,
        );
        const l0Check = partitionMemories(postStore.list({ spaceIds: [GLOBAL_SPACE_ID], includeText: true }), {
          now: Date.now() + 45 * 86_400_000,
        });
        assert.equal(l0Check.L0.length, 7, '真库副本代谢收敛后 7 条核心记忆仍必须 100% 锁定在 L0');
        t.diagnostic(
          `[Scene A - Live Copy] migrated=${summary.totalMigrated}, core=${summary.coreCount}, auto=${summary.dirtyAutoCount}, preMetabolismBytes=${summary.compactBytes}, postMetabolismBytes=${afterMetabolismBytes}, archived=${metaRep.actions.l3Archived}`,
        );
      } finally {
        postStore.close();
      }
    });

    // 事后校验线上真库字节数与 SHA-256 纹丝未动
    const liveAfterStat = fs.statSync(LIVE_V7_DB_PATH);
    const liveAfterHash = fileBytesSha256(LIVE_V7_DB_PATH);
    assert.equal(liveAfterStat.size, liveBeforeStat.size, '线上真库文件大小严禁发生任何变化');
    assert.equal(liveAfterHash, liveBeforeHash, '线上真库字节级 SHA-256 严禁发生任何变化');
  });

  test('场景 B：跨会话记住模型自身决策/排障经验 + state 单活原地覆写 + 催促/subagent 零入库 + 工作区隔离 + 两段式注入', async (t) => {
    await withSandboxDir('mj-t8-sceneB-cross-session-', async (tmpDir) => {
      const dbPath = path.join(tmpDir, 'scene-b.db');
      let clock = Date.UTC(2026, 4, 1, 9, 0, 0);

      const wsAPath = 'F:/workspace-alpha';
      const wsBPath = 'D:/other-project';
      const spaceA = resolveScope({ cwd: wsAPath }).spaceId;
      const spaceB = resolveScope({ cwd: wsBPath }).spaceId;
      assert.notEqual(spaceA, spaceB, '工作区 A 与工作区 B 的 space_id 必须物理区分');

      const host = createMockHost({
        initialSessions: {
          'sess-1-alpha': { id: 'sess-1-alpha', cwd: wsAPath, origin: 'user' },
          'sess-subagent-alpha': { id: 'sess-subagent-alpha', cwd: wsAPath, origin: 'subagent' },
          'sess-1-beta': { id: 'sess-1-beta', cwd: wsBPath, origin: 'user' },
          'sess-2-alpha': { id: 'sess-2-alpha', cwd: wsAPath, origin: 'user' },
        },
      });

      let rawStore = null;
      const plugin = apply(
        host,
        {
          dbPath,
          autoInject: true,
          injectMode: 'tiered',
          tierSBudget: 600,
          tierDBudget: 900,
          injectBudget: 1500,
          autoCapture: true,
          llmExtract: false,
          now: () => clock,
        },
        {
          storeFactory: (p, o) => {
            rawStore = open(p, o);
            return rawStore;
          },
        },
      );

      try {
        // 预置 1 条全局规矩与 1 条用户画像供 Tier-S 组装验证
        rawStore.put({
          spaceId: GLOBAL_SPACE_ID,
          category: 'rule',
          text: '全局契约：所有 SQLite 结构变更必须在单事务内完成并保留回滚能力。',
          importance: 0.95,
          now: clock,
        });
        rawStore.put({
          spaceId: GLOBAL_SPACE_ID,
          category: 'profile',
          text: '用户画像：YG 关注微秒级延迟、零内存泄漏与严格自动化实测证据。',
          importance: 0.92,
          now: clock,
        });

        // ── Session 1 (工作区 A) ──────────────────────────────────────────
        // a.1) Assistant 做出架构决策（附带大段 Markdown 代码块尸块，验证脱水剥离）
        clock += 60_000;
        await driveHostTurn(host, rawStore, {
          sessionId: 'sess-1-alpha',
          turnId: 's1-t1',
          userText: '请敲定订单撮合引擎的高并发队列选型方案并落地配置',
          toolEvents: [{ toolName: 'edit', isError: false, summary: 'updated src/order-ring.mjs' }],
          assistantText: [
            '### 撮合队列选型分析',
            '经过压测比对，旧版链表锁存在严重抖动：',
            '```javascript',
            'class LegacyMutexQueue {',
            '  push(item) { this.lock.acquire(); this.list.push(item); this.lock.release(); }',
            '  pop() { return this.list.shift(); }',
            '}',
            '```',
            '架构决策：撮合引擎核心通道决定采用预分配内存的双缓冲无锁环形队列（Disruptor RingBuffer）替代全局互斥锁链表，消除 GC 停顿并将 P99 撮合延迟压降至 2ms 以内。',
          ].join('\n'),
        });

        // a.2) Assistant 定位并修复报错根因（附带大段错误日志代码块，验证脱水生成 experience）
        clock += 60_000;
        await driveHostTurn(host, rawStore, {
          sessionId: 'sess-1-alpha',
          turnId: 's1-t2',
          userText: '排查网关与 Redis Sentinel 偶发 ECONNRESET 断连告警的根因并修复',
          toolEvents: [{ toolName: 'pwsh', isError: false, summary: 'verified sentinel failover' }],
          assistantText: [
            '复盘抓包堆栈如下：',
            '```text',
            'Error: read ECONNRESET at TCP.onStreamRead (node:internal/stream_base_commons:217:20)',
            '  at SentinelPool.acquire (src/redis-pool.js:142:11)',
            '```',
            '已定位 Redis Sentinel 断连报错根因：NAT 网关空闲超时为 60s 而客户端 tcpKeepAlive 设为 120s 导致半开死连接被静默重置，修复方案为将 tcpKeepAlive 调至 30s 并开启探活重连。',
          ].join('\n'),
        });

        // 验证 a)：自动脱水为 40–160 字高密度 decision / experience，绝无 Markdown 代码块尸块
        const memsAfterA = rawStore.list({ spaceIds: [spaceA], includeText: true });
        const decisionsA = memsAfterA.filter((m) => m.category === 'decision');
        const experiencesA = memsAfterA.filter((m) => m.category === 'experience');
        assert.ok(decisionsA.length >= 1, 'Session 1 必须自动提炼出 decision 记忆');
        assert.ok(experiencesA.length >= 1, 'Session 1 必须自动提炼出 experience 记忆');

        for (const m of [...decisionsA, ...experiencesA]) {
          assert.ok(
            m.text.length >= 40 && m.text.length <= 160,
            `自动脱水记忆长度必须落在 40-160 字高密度区间，实际 length=${m.text.length}: ${m.text}`,
          );
          assert.equal(m.text.includes('```'), false, '脱水记忆严禁残留 Markdown 代码块围栏尸块');
          assert.equal(m.text.includes('LegacyMutexQueue'), false, '脱水记忆严禁混入原始代码实现尸块');
        }

        // b) 同一项目任务状态先后经历 3 次变更 -> 单活原地覆写 + memory_revisions 留存前 2 次
        const stateUpdates = [
          '状态更新：当前任务 T6 完成度 30%，已完成接口契约定义与单元测试脚手架搭建，下一步编写核心环形缓冲区逻辑。',
          '状态更新：当前任务 T6 完成度 70%，推进中已完成双缓冲核心编码并通过并发冒烟验证，下一步补充背压边界校验。',
          '状态更新：当前任务 T6 完成度 100%，全部 38 项高并发边界校验通过并已合入主干，下一步进入灰度观测待办收口。',
        ];
        for (let idx = 0; idx < stateUpdates.length; idx++) {
          clock += 60_000;
          await driveHostTurn(host, rawStore, {
            sessionId: 'sess-1-alpha',
            turnId: `s1-state-${idx + 1}`,
            userText: `更新任务 T6 第 ${idx + 1} 阶段执行进度`,
            toolEvents: [{ toolName: 'edit', isError: false, summary: `step ${idx + 1} updated` }],
            assistantText: stateUpdates[idx],
          });
        }

        const statesInA = rawStore
          .list({ spaceIds: [spaceA], includeText: true })
          .filter((m) => m.category === 'state' && m.slotKey === 'task:T6');
        assert.equal(statesInA.length, 1, '同 slot_key (task:T6) 在主表 memories 中必须单活仅存 1 条最新状态');
        assert.ok(statesInA[0].text.includes('38 项高并发边界'), '主表唯一活跃状态必须对应第 3 次最新进度');

        const stateRevisions = rawStore.listRevisions(statesInA[0].id);
        assert.equal(stateRevisions.length, 2, '前 2 次历史状态变更必须完整保存在 memory_revisions 中');
        const revTextsJoined = stateRevisions.map((r) => r.prevText).join('\n');
        assert.ok(revTextsJoined.includes('单元测试脚手架搭建'), 'memory_revisions 应包含第 1 次状态历史');
        assert.ok(revTextsJoined.includes('并发冒烟验证'), 'memory_revisions 应包含第 2 次状态历史');

        // c) 夹杂用户催促短句（“继续”、“好的快弄”）与 origin === 'subagent' 子代理长篇汇报 -> 严格 0 条入库
        const countBeforeNoise = rawStore.raw().prepare('SELECT COUNT(*) AS n FROM memories').get().n;
        const queueBeforeNoise = rawStore.raw().prepare('SELECT COUNT(*) AS n FROM ingest_queue').get().n;

        clock += 30_000;
        await driveHostTurn(host, rawStore, {
          sessionId: 'sess-1-alpha',
          turnId: 's1-noise-urge-1',
          userText: '继续',
          assistantText: '好的，正在继续处理后续检查。',
        });

        clock += 30_000;
        await driveHostTurn(host, rawStore, {
          sessionId: 'sess-1-alpha',
          turnId: 's1-noise-urge-2',
          userText: '好的快弄',
          assistantText: '明白，立刻加速推进。',
        });

        clock += 30_000;
        await driveHostTurn(host, rawStore, {
          sessionId: 'sess-subagent-alpha',
          turnId: 'sub-t1',
          userText: '作为委派子代理执行全仓回归并提交详尽报告',
          toolEvents: [{ toolName: 'pwsh', isError: false, summary: 'ran 120 unit tests' }],
          assistantText:
            '已完成子任务委派验证：架构决策建议与排障验证共执行 120 项回归测试，通过率 100%，所有临时构建产物已清理完毕，现向主控协调器正式汇报结单。',
        });

        const countAfterNoise = rawStore.raw().prepare('SELECT COUNT(*) AS n FROM memories').get().n;
        const queueAfterNoise = rawStore.raw().prepare('SELECT COUNT(*) AS n FROM ingest_queue').get().n;
        assert.equal(queueAfterNoise - queueBeforeNoise, 0, '催促短句与 subagent 子代理回合严禁进入 ingest_queue（0 入队）');
        assert.equal(countAfterNoise - countBeforeNoise, 0, '催促短句与 subagent 子代理长篇汇报必须严格 0 条入库');

        // d) 不同工作区 B (cwd: 'D:/other-project') 会话产生记忆 -> 与工作区 A 严格物理隔离
        clock += 60_000;
        await driveHostTurn(host, rawStore, {
          sessionId: 'sess-1-beta',
          turnId: 'wsb-t1',
          userText: '确定跨境清结算服务对账消息总线方案',
          toolEvents: [{ toolName: 'edit', isError: false, summary: 'configured rocketmq-tx.yml' }],
          assistantText:
            '架构决策：跨境清结算服务决定采用 RocketMQ 事务半消息机制保障银企直连跨行对账最终一致性，彻底废弃定时轮询补单脚本。',
        });

        const memsInB = rawStore.list({ spaceIds: [spaceB], includeText: true });
        assert.ok(memsInB.length >= 1, '工作区 B 应独立落盘自身的架构决策记忆');
        assert.ok(memsInB.some((m) => m.text.includes('RocketMQ')), '工作区 B 记忆应包含 RocketMQ 决策');

        // ── 开启全新 Session 2 (工作区 A) ────────────────────────────────
        const sectionFn = host._sections.get(SECTION_NAME);
        const contextFn = host._contexts.get(CONTEXT_NAME);
        assert.equal(typeof sectionFn, 'function', '宿主必须注册 Tier-S section 渲染器');
        assert.equal(typeof contextFn, 'function', '宿主必须注册 Tier-D context 渲染器');

        // 1) 验证 Tier-S 静态底座在 Session 2 多步工具循环及后台状态变更下逐字节 100% 恒定（<= 600 chars）
        const tierSStep1 = await sectionFn({ sessionId: 'sess-2-alpha', cwd: wsAPath, stepIndex: 0 });
        assert.ok(tierSStep1.length > 0 && tierSStep1.length <= TIER_S_MAX_CHARS, `Tier-S 长度必须 <= 600 chars，实际=${tierSStep1.length}`);
        assert.ok(tierSStep1.includes('任务 T6'), 'Session 2 Tier-S 应携带工作区 A 最新单活状态');
        assert.equal(tierSStep1.includes('RocketMQ'), false, 'Session 2 Tier-S 严禁混入工作区 B 记忆');

        // 模拟中途后台新增另一条工作区 A 状态，验证已冻结的 Session 2 Tier-S 仍然逐字节 100% 恒定（保护 Prefix KV Cache）
        rawStore.putState({
          spaceId: spaceA,
          slotKey: 'build_status',
          text: '构建流水线状态：刚触发新一轮增量编译。',
          now: clock + 5_000,
        });

        const tierSStep2Tool = await sectionFn({ sessionId: 'sess-2-alpha', cwd: wsAPath, stepIndex: 1, isToolStep: true });
        const tierSStep3Tool = await sectionFn({ sessionId: 'sess-2-alpha', cwd: wsAPath, stepIndex: 2, isToolStep: true });
        const tierSStep4NextTurn = await sectionFn({ sessionId: 'sess-2-alpha', cwd: wsAPath, stepIndex: 3 });

        assert.equal(
          Buffer.compare(Buffer.from(tierSStep1, 'utf8'), Buffer.from(tierSStep2Tool, 'utf8')),
          0,
          'Session 2 工具子步 1 的 Tier-S 必须逐字节 100% 恒定',
        );
        assert.equal(
          Buffer.compare(Buffer.from(tierSStep1, 'utf8'), Buffer.from(tierSStep3Tool, 'utf8')),
          0,
          'Session 2 工具子步 2 的 Tier-S 必须逐字节 100% 恒定',
        );
        assert.equal(
          Buffer.compare(Buffer.from(tierSStep1, 'utf8'), Buffer.from(tierSStep4NextTurn, 'utf8')),
          0,
          'Session 2 后续轮次的 Tier-S 必须逐字节 100% 恒定',
        );

        // 工具循环内部子步骤调用 Tier-D 必须零注入（0 chars）
        const tierDOnToolStep = await contextFn({
          sessionId: 'sess-2-alpha',
          cwd: wsAPath,
          isToolSubstep: true,
          query: '我们之前针对撮合引擎定下的无锁环形队列架构决策是什么？',
        });
        assert.equal(tierDOnToolStep.length, 0, '工具调用子步（非用户新提问步）Tier-D 必须返回 0 chars');

        // 2) 当用户追问 Session 1 中模型自己做过的架构决策与修过的 Bug 时，Tier-D 精准召回（<= 900 chars，工作区 B 零串味）
        const tierDDecisionRecall = await contextFn({
          sessionId: 'sess-2-alpha',
          cwd: wsAPath,
          isUserTurn: true,
          query: '我们之前针对订单撮合引擎定下的无锁环形队列 Disruptor 架构选型决策是什么？',
        });
        assert.ok(
          tierDDecisionRecall.length > 0 && tierDDecisionRecall.length <= TIER_D_MAX_CHARS,
          `追问历史决策时 Tier-D 必须非空且 <= 900 chars，实际=${tierDDecisionRecall.length}`,
        );
        assert.ok(
          tierDDecisionRecall.includes('环形队列') || tierDDecisionRecall.includes('Disruptor'),
          'Tier-D 必须精准召回 Session 1 中模型自己做出的环形队列架构决策',
        );
        assert.equal(tierDDecisionRecall.includes('RocketMQ'), false, 'Tier-D 召回严禁出现工作区 B 串味');

        const tierDBugRecall = await contextFn({
          sessionId: 'sess-2-alpha',
          cwd: wsAPath,
          isUserTurn: true,
          query: '之前 Redis Sentinel 偶发 ECONNRESET 断连的报错根因和 tcpKeepAlive 修复参数是多少？',
        });
        assert.ok(
          tierDBugRecall.length > 0 && tierDBugRecall.length <= TIER_D_MAX_CHARS,
          `追问历史修过的 Bug 时 Tier-D 必须非空且 <= 900 chars，实际=${tierDBugRecall.length}`,
        );
        assert.ok(
          tierDBugRecall.includes('tcpKeepAlive') || tierDBugRecall.includes('30s'),
          'Tier-D 必须精准召回 Session 1 中模型自己定位修复的 Redis Sentinel 排障经验',
        );
        assert.equal(tierDBugRecall.includes('RocketMQ'), false, 'Tier-D 召回严禁出现工作区 B 串味');

        // 校验即使跨工作区直接尝试搜 RocketMQ，在工作区 A 作用域下也绝不泄露工作区 B 的私有记忆
        const tierDCrossProbe = await contextFn({
          sessionId: 'sess-2-alpha',
          cwd: wsAPath,
          isUserTurn: true,
          query: '跨境清结算服务 RocketMQ 事务半消息对账方案是什么？',
        });
        assert.equal(tierDCrossProbe.includes('RocketMQ'), false, '跨工作区直接点名探测也必须严格物理隔离零串味');
        assert.equal(tierDCrossProbe.length, 0, '工作区 A 无匹配证据时 Tier-D 应严格返回 0 chars');

        // 3) 当用户发送寒暄或无关问题时，Tier-D 严格返回 0 chars（零无效上下文污染）
        for (const trivialOrUnrelated of [
          '早上好呀，辛苦啦！',
          '谢谢！',
          '明天冰岛雷克雅未克的极光观测指数和气温是多少度？',
          '帮我写一首关于秋日银杏落叶的五言绝句',
        ]) {
          const out = await contextFn({
            sessionId: 'sess-2-alpha',
            cwd: wsAPath,
            isUserTurn: true,
            query: trivialOrUnrelated,
          });
          assert.equal(
            out.length,
            0,
            `寒暄或无关问题必须严格返回 0 chars，实际 length=${out.length}，输入="${trivialOrUnrelated}"`,
          );
        }

        t.diagnostic(
          `[Scene B] Tier-S frozen=${tierSStep1.length}ch, Tier-D decision=${tierDDecisionRecall.length}ch, Tier-D bug=${tierDBugRecall.length}ch, trivial=0ch`,
        );
      } finally {
        try {
          plugin?.dispose?.();
        } catch {}
        await host.dispose();
        try {
          rawStore?.close?.();
        } catch {}
      }
    });
  });

  test('场景 C：1,000 轮连续对话全链路代谢收敛（<= 256 KB）、单步注入预算（<= 1500 chars）与 100 次混合检索延迟（P95 < 15 ms）', async (t) => {
    await withSandboxDir('mj-t8-sceneC-1000turns-', async (tmpDir) => {
      const dbPath = path.join(tmpDir, 'stress-1000turns.db');
      let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
      const wsSpace = 'workspace:stress-alpha';

      const store = open(dbPath, { now: () => clock });
      try {
        store.upsertSpace({
          spaceId: wsSpace,
          kind: 'workspace',
          rootPath: 'F:/StressAlpha',
          label: 'StressAlpha',
          now: () => clock,
        });

        // 写入常驻 L0 全局规矩与画像
        const seedRule = store.put({
          spaceId: GLOBAL_SPACE_ID,
          category: 'rule',
          text: '核心铁律：线上数据库操作必须具备幂等校验与原子事务保护，严禁裸跑无回滚破坏性脚本。',
          importance: 0.96,
          now: clock,
        });
        const seedProfile = store.put({
          spaceId: GLOBAL_SPACE_ID,
          category: 'profile',
          text: '架构师偏好：追求高吞吐低尾延迟架构设计，所有容量与延迟指标均需实测分位数背书。',
          importance: 0.93,
          now: clock,
        });

        const injector = new InjectionEngine({ store });
        let liveSearchIndex = new SearchIndex().setStore(store);
        const rebuildLiveSearchIndex = () => {
          const idx = new SearchIndex().setStore(store);
          idx.addAll(store.list({ spaceIds: [wsSpace, GLOBAL_SPACE_ID], includeText: true }));
          liveSearchIndex = idx;
        };
        rebuildLiveSearchIndex();

        let maxTierSChars = 0;
        let maxTierDChars = 0;
        let maxTotalInjectChars = 0;
        let activeRecallSteps = 0;

        let totalDemotedToL2 = 0;
        let totalArchivedL3 = 0;
        let totalAuxPurged = 0;
        let totalWikiBuilt = 0;

        const decisionTopics = ['gateway-pool', 'raft-lease', 'wal-checkpoint', 'cache-shard', 'jwt-rotation'];
        const bugServices = ['pgbouncer', 'redis-sentinel', 'nats-jetstream', 'sqlite-wal', 'envoy-eds'];

        // 驱动 1,000 轮真实分布对话（跨 40 个会话、每轮推进 2 小时，总跨度约 83.3 天）
        for (let turn = 1; turn <= 1000; turn++) {
          clock += 2 * 3600 * 1000;
          const sessionId = `stress-sess-${Math.ceil(turn / 25)}`;
          const bucket = turn % 10;
          let userPrompt = '';

          if (bucket === 0) {
            // 10% 用户催促短句噪声（验证零入库 + 零动态注入）
            userPrompt = turn % 20 === 0 ? '好的快弄' : '继续';
            const tc = createTurnCollector({ store, spaceId: wsSpace, sessionId, turnNo: turn, origin: 'user' });
            tc.recordUser(userPrompt);
            tc.recordAssistant('收到，立即继续执行当前步骤。');
            tc.closeTurn({ now: clock });
          } else if (bucket === 1) {
            // 10% subagent 子代理执行回报噪声（验证零入库）
            userPrompt = `子代理执行批次 #${turn} 回归套件`;
            const tc = createTurnCollector({
              store,
              spaceId: wsSpace,
              sessionId: `subagent-${turn}`,
              turnNo: 1,
              origin: 'subagent',
            });
            tc.recordUser(userPrompt);
            tc.recordTool({ tool: 'pwsh', ok: true, summary: 'all 64 assertions green' });
            tc.recordAssistant('已完成子任务全量回归验证，64 项断言全部通过，无新增告警。');
            tc.closeTurn({ now: clock });
          } else if (bucket === 2 || bucket === 3) {
            // 20% 项目进度单活状态覆写（4 个任务槽位高频滚动演进）
            const taskSlot = (turn % 4) + 1;
            userPrompt = `同步任务 T${taskSlot} 最新迭代进度与阻塞情况`;
            const tc = createTurnCollector({ store, spaceId: wsSpace, sessionId, turnNo: turn, origin: 'user' });
            tc.recordUser(userPrompt);
            tc.recordTool({ tool: 'edit', ok: true, summary: `updated task T${taskSlot} tracker` });
            tc.recordAssistant(
              `当前进度：任务 T${taskSlot} 已完成第 ${turn} 轮模块压测与代码精简，回归通过率 100%，下一阶段推进灰度联调。`,
            );
            tc.closeTurn({ now: clock });
          } else if (bucket === 4 || bucket === 5) {
            // 20% 架构选型决策（重复聚焦 5 个核心技术主题以触发 L2 Wiki 编译）
            const topic = decisionTopics[turn % decisionTopics.length];
            userPrompt = `评审 ${topic} 模块无锁环形队列架构选型与尾延迟预算`;
            const tc = createTurnCollector({ store, spaceId: wsSpace, sessionId, turnNo: turn, origin: 'user' });
            tc.recordUser(userPrompt);
            tc.recordTool({ tool: 'edit', ok: true, summary: `applied ${topic} architecture config` });
            tc.recordAssistant(
              `架构决策：针对 ${topic} 模块决定采用双缓冲无锁环形队列方案（演进批次 #${turn}），废弃全局互斥锁，确保尾延迟稳定在 ${8 + (turn % 9)}ms 内。`,
            );
            tc.closeTurn({ now: clock });
          } else {
            // 40% 故障根因排查与修复经验（聚焦 5 个基础设施组件）
            const svc = bugServices[turn % bugServices.length];
            userPrompt = `排查 ${svc} 压测空闲连接风暴超时告警根因与修复参数`;
            const tc = createTurnCollector({ store, spaceId: wsSpace, sessionId, turnNo: turn, origin: 'user' });
            tc.recordUser(userPrompt);
            tc.recordTool({ tool: 'pwsh', ok: true, summary: `inspected ${svc} socket stats` });
            tc.recordAssistant(
              `已定位 ${svc} 报错根因（演进批次 #${turn}）：空闲连接回收阈值过低引发重连风暴，修复方案为将 keepalive 调整至 ${30 + (turn % 25)}s 并启用连接池预热。`,
            );
            tc.closeTurn({ now: clock });
          }

          // 实时检验单步 Tier-S + Tier-D 注入预算硬上限（仅非 subagent 会话触发主会话注入）
          if (bucket !== 1) {
            const sRes = injector.getTierS({ sessionId, spaceId: wsSpace, now: clock });
            const dRes = injector.getTierDSync(userPrompt, {
              sessionId,
              spaceId: wsSpace,
              searchIndex: liveSearchIndex,
              isUserTurn: true,
              now: clock,
            });
            const stepTotal = sRes.chars + dRes.chars;

            assert.ok(
              sRes.chars <= TIER_S_MAX_CHARS,
              `Turn ${turn}: Tier-S (${sRes.chars}) 超过 600 chars 上限`,
            );
            assert.ok(
              dRes.chars <= TIER_D_MAX_CHARS,
              `Turn ${turn}: Tier-D (${dRes.chars}) 超过 900 chars 上限`,
            );
            assert.ok(
              stepTotal <= TOTAL_INJECT_MAX_CHARS,
              `Turn ${turn}: Tier-S + Tier-D (${stepTotal}) 超过 1500 chars 硬上限`,
            );

            if (bucket === 0) {
              assert.equal(dRes.chars, 0, `Turn ${turn}: 催促短句 "${userPrompt}" 必须零动态注入`);
            }
            if (dRes.chars > 0) activeRecallSteps += 1;
            if (sRes.chars > maxTierSChars) maxTierSChars = sRes.chars;
            if (dRes.chars > maxTierDChars) maxTierDChars = dRes.chars;
            if (stepTotal > maxTotalInjectChars) maxTotalInjectChars = stepTotal;
          }

          // 消费异步蒸馏队列
          const drainRes = await processIngestQueue({ store, limit: 8, llmOpts: { enabled: false }, now: clock });
          if (drainRes.written > 0 && turn % 5 === 0) {
            rebuildLiveSearchIndex();
          }

          // 每 25 轮（每个会话周期结束）执行一次全链路代谢收敛
          if (turn % 25 === 0) {
            injector.onSessionEnd(sessionId);
            const rep = runMetabolism(store, {
              now: clock,
              softLimitBytes: 180 * 1024,
              hardLimitBytes: 256 * 1024,
              vacuumOnPressure: turn % 200 === 0,
            });
            totalDemotedToL2 += rep.actions.l1DemotedToL2;
            totalArchivedL3 += rep.actions.l3Archived;
            totalAuxPurged += rep.actions.auxRowsPurged;
            totalWikiBuilt += rep.actions.wikiPagesUpdated;
            rebuildLiveSearchIndex();
          }
        }

        // 为活跃记忆补齐 Int8 量化向量（模拟向量臂全量就绪的完整生产负载），再执行终态代谢收敛
        const activeMemsPreVec = store.list({ spaceIds: [wsSpace, GLOBAL_SPACE_ID], includeText: true });
        const vectors = deterministicEmbed(activeMemsPreVec.map((m) => m.text));
        for (let i = 0; i < activeMemsPreVec.length; i++) {
          store.putVector({ memoryId: activeMemsPreVec[i].id, vec: vectors[i], model: 'mock-16d' });
        }

        const finalMetabolism = runMetabolism(store, {
          now: clock,
          softLimitBytes: 180 * 1024,
          hardLimitBytes: 256 * 1024,
          vacuumOnPressure: true,
        });
        totalDemotedToL2 += finalMetabolism.actions.l1DemotedToL2;
        totalArchivedL3 += finalMetabolism.actions.l3Archived;
        totalAuxPurged += finalMetabolism.actions.auxRowsPurged;
        totalWikiBuilt += finalMetabolism.actions.wikiPagesUpdated;

        // 验证 L0 保护层完整留存、L2 Wiki 增量编译产出、L3 归档与辅助表裁剪均实际生效
        assert.ok(store.get(seedRule.id), '1,000 轮代谢后 L0 全局 rule 必须完好留存');
        assert.ok(store.get(seedProfile.id), '1,000 轮代谢后 L0 全局 profile 必须完好留存');
        const activeStates = store
          .list({ spaceIds: [wsSpace], includeText: true })
          .filter((m) => m.category === 'state');
        assert.equal(activeStates.length, 4, '4 个任务槽位 (T1~T4) 的单活 state 必须精准收敛为 4 条');

        const wikiPages = store.listWikiPages({ spaceId: wsSpace });
        assert.ok(wikiPages.length >= 2, `L2 增量编译应生成多页模块主题 Wiki，实际页数=${wikiPages.length}`);
        assert.ok(totalDemotedToL2 > 0, '1,000 轮中 L1 -> L2 双半衰期衰减脱水必须实际发生');
        assert.ok(totalArchivedL3 > 0, '1,000 轮中 L3 远期归档压缩必须实际发生');
        assert.ok(totalAuxPurged > 0, '1,000 轮中已完成队列与陈旧修订裁剪必须实际发生');

        // ── 量化断言 1：物理 .db 文件字节数 <= 262,144 bytes (256 KB) ──
        const dbFileBytes = fs.statSync(dbPath).size;
        const walFileBytes = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
        const totalStoreBytes = store.bytes();

        assert.ok(
          dbFileBytes <= 262_144,
          `[量化断言 1] 1,000 轮后物理 .db 文件字节数 (${dbFileBytes}) 必须 <= 262,144 bytes (256 KB)`,
        );
        assert.ok(
          totalStoreBytes <= 262_144,
          `[量化断言 1] 1,000 轮后含 WAL/Journal 总物理字节数 (${totalStoreBytes}) 必须 <= 262,144 bytes (256 KB)`,
        );

        // ── 量化断言 2：全程任意单步 Tier-S + Tier-D 总注入字符数 <= 1500 chars ──
        assert.ok(activeRecallSteps > 0, '1,000 轮压测期间必须发生实质性动态记忆命中注入');
        assert.ok(
          maxTotalInjectChars > 0 && maxTotalInjectChars <= TOTAL_INJECT_MAX_CHARS,
          `[量化断言 2] 全程最大单步总注入字符数 (${maxTotalInjectChars}) 必须 <= 1500 chars`,
        );

        // ── 量化断言 3：1,000 轮落盘库上执行 100 次三路混合检索查询，P95 < 15 ms ──
        const finalVisibleMems = store.list({ spaceIds: [wsSpace, GLOBAL_SPACE_ID], includeText: true });
        const searchIdx = new SearchIndex().setStore(store);
        searchIdx.addAll(finalVisibleMems);

        const benchmarkQueries = [
          'gateway-pool 无锁环形队列架构选型',
          'pgbouncer 空闲连接回收连接风暴 keepalive',
          'raft-lease 尾延迟架构方案',
          'redis-sentinel 超时告警根因修复',
          'nats-jetstream 压测连接池预热',
          'sqlite-wal 报错根因排查',
          'cache-shard 双缓冲队列决策',
          'jwt-rotation 模块架构选型',
          'envoy-eds 空闲连接风暴修复',
          '任务 T1 最新迭代进度',
        ];

        // JIT 预热 5 次（不计入 100 次正式统计）
        for (let w = 0; w < 5; w++) {
          await hybridSearch(searchIdx, benchmarkQueries[w], {
            spaceId: wsSpace,
            store,
            embed: async (arr) => deterministicEmbed(arr),
            now: clock,
          });
        }

        const latenciesMs = [];
        for (let q = 0; q < 100; q++) {
          const query = benchmarkQueries[q % benchmarkQueries.length];
          const t0 = performance.now();
          const res = await hybridSearch(searchIdx, query, {
            spaceId: wsSpace,
            store,
            embed: async (arr) => deterministicEmbed(arr),
            now: clock,
          });
          const elapsed = performance.now() - t0;
          assert.ok(res.hits.length > 0, `第 ${q + 1} 次混合检索查询 "${query}" 应返回有效命中`);
          latenciesMs.push(elapsed);
        }

        latenciesMs.sort((a, b) => a - b);
        const p50Ms = Number(latenciesMs[49].toFixed(3));
        const p95Ms = Number(latenciesMs[94].toFixed(3));
        const p99Ms = Number(latenciesMs[98].toFixed(3));
        const maxMs = Number(latenciesMs[99].toFixed(3));

        assert.ok(
          p95Ms < 15,
          `[量化断言 3] 100 次混合检索查询 P95 延迟 (${p95Ms} ms) 必须 < 15 ms (P50=${p50Ms}ms, P99=${p99Ms}ms)`,
        );

        t.diagnostic(
          JSON.stringify({
            scene: 'C-1000-turns',
            dbFileBytes,
            walFileBytes,
            totalStoreBytes,
            activeMemories: finalVisibleMems.length,
            wikiPagesCount: wikiPages.length,
            wikiSlugs: wikiPages.map((w) => w.slug),
            metabolismTotals: { totalDemotedToL2, totalArchivedL3, totalAuxPurged, totalWikiBuilt },
            injectMaxChars: { maxTierSChars, maxTierDChars, maxTotalInjectChars, activeRecallSteps },
            hybridSearchLatencyMs: { p50Ms, p95Ms, p99Ms, maxMs },
          }),
        );
      } finally {
        try {
          store.close();
        } catch {}
      }
    });
  });
});
