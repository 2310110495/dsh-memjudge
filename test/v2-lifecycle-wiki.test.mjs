// test/v2-lifecycle-wiki.test.mjs
// Phase 2-B: L0–L3 四级热冷代谢引擎、落盘 Wiki 聚合页与动态衰减专项验收测试

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { open } from '../src/store.mjs';
import {
  TIER_L0,
  TIER_L1,
  TIER_L2,
  TIER_L3,
  MEMORY_CATEGORIES,
} from '../src/schema.mjs';

import {
  decayScore,
  computeTier,
  partitionMemories,
} from '../src/layer.mjs';

import {
  deriveClusterSlug,
  formatWikiMarkdown,
  buildWikiPage,
  compileDirtyWikiPages,
  markClusterDirty,
  archiveColdMemories,
  runMetabolism,
} from '../src/lifecycle.mjs';

const DAY_MS = 86400000;

test('Phase 2-B 专项验收：L0–L3 四级热冷代谢、落盘 Wiki 与 1000 轮收敛测试', async (t) => {
  let tmpDir = null;
  let dbPath = null;

  t.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-lifecycle-test-'));
    dbPath = path.join(tmpDir, 'lifecycle-test.db');
  });

  t.afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore on Windows file lock transient
      }
    }
  });

  await t.test('1. L0 核心恒温层永不衰减测试', () => {
    const baseTime = Date.now();
    const l0Rule = {
      id: 'rule-1',
      category: 'rule',
      tier: TIER_L0,
      text: '严禁越权访问用户私有存储',
      lastAccessed: baseTime - 180 * DAY_MS, // 180 天未访问
      accessCount: 1,
      importance: 0.9,
    };
    const l0Profile = {
      id: 'prof-1',
      category: 'profile',
      tier: TIER_L0,
      text: '用户身份偏好：精通 Rust/C++ 系统编程',
      lastAccessed: baseTime - 365 * DAY_MS, // 1 年未访问
      accessCount: 0,
      importance: 0.8,
    };
    const l0State = {
      id: 'state-1',
      category: 'state',
      tier: TIER_L0,
      text: '当前会话调试断点：session_id=worker-09',
      lastAccessed: baseTime - 60 * DAY_MS,
      accessCount: 2,
    };

    // 衰减分永远固定为 1.0
    assert.equal(decayScore(l0Rule, baseTime), 1.0, 'rule 衰减分应为 1.0');
    assert.equal(decayScore(l0Profile, baseTime), 1.0, 'profile 衰减分应为 1.0');
    assert.equal(decayScore(l0State, baseTime), 1.0, 'state 衰减分应为 1.0');

    // 计算分层永远归属 TIER_L0
    assert.equal(computeTier(l0Rule, baseTime), TIER_L0, 'rule 应归属 TIER_L0');
    assert.equal(computeTier(l0Profile, baseTime), TIER_L0, 'profile 应归属 TIER_L0');
    assert.equal(computeTier(l0State, baseTime), TIER_L0, 'state 应归属 TIER_L0');
  });

  await t.test('2. L1 温水层双半衰期计算与热度刷新测试', () => {
    const baseTime = Date.now();
    const freshDecision = {
      id: 'dec-1',
      category: 'decision',
      tier: TIER_L1,
      text: '决定将网络请求重试间隔设置为 500ms 指数退避',
      lastAccessed: baseTime, // 刚访问
      accessCount: 1,
      importance: 0.5,
    };

    // 新鲜条目衰减分接近 1.0
    const freshScore = decayScore(freshDecision, baseTime, { halfLifeDays: 7 });
    assert.ok(freshScore >= 0.95, `新鲜条目分数应该 >= 0.95，实测: ${freshScore}`);
    assert.equal(computeTier(freshDecision, baseTime), TIER_L1, '新鲜条目应判定为 TIER_L1');

    // 经过 1 个半衰期（7 天），衰减分显著下降
    const decayedScore7d = decayScore(freshDecision, baseTime + 7 * DAY_MS, { halfLifeDays: 7 });
    assert.ok(decayedScore7d < freshScore, '7天后衰减分必须低于初始');
    assert.ok(decayedScore7d <= 0.8, `7天后衰减分应合理下沉，实测: ${decayedScore7d}`);

    // 经过 30 天无访问，下沉到 L2 / L3
    const decayedScore30d = decayScore(freshDecision, baseTime + 30 * DAY_MS, { halfLifeDays: 7 });
    const tier30d = computeTier(freshDecision, baseTime + 30 * DAY_MS, { halfLifeDays: 7 });
    assert.ok(tier30d >= TIER_L2, `30天无访问应沉降到 L2 或 L3，实测 tier: ${tier30d}, score: ${decayedScore30d}`);

    // 模拟热度刷新：高频访问强化
    const boostedDecision = {
      ...freshDecision,
      lastAccessed: baseTime + 30 * DAY_MS, // 刚刚重新访问
      accessCount: 20, // 访问频次强化
    };
    const boostedScore = decayScore(boostedDecision, baseTime + 30 * DAY_MS, { halfLifeDays: 7 });
    assert.ok(boostedScore >= 0.9, `访问刷新并提升频次后应恢复高热度，实测: ${boostedScore}`);
    assert.equal(computeTier(boostedDecision, baseTime + 30 * DAY_MS), TIER_L1);
  });

  await t.test('3. L2 Wiki 聚合页在 SQLite wiki_pages 表持久化落盘与增量脏页标记', () => {
    const store = open(dbPath);
    try {
      const now = Date.now();
      // 写入两批不同主题的原子经验
      const id1 = store.put({
        spaceId: 'backend',
        category: 'experience',
        slotKey: 'sqlite:wal-mode',
        text: 'SQLite 开启 WAL 模式可提升多进程并发读性能至 3 倍以上',
        now,
      }).id;

      const id2 = store.put({
        spaceId: 'backend',
        category: 'experience',
        slotKey: 'sqlite:checkpoint',
        text: 'SQLite 定期执行 PRAGMA wal_checkpoint(TRUNCATE) 可防止 WAL 文件无限扩张',
        now,
      }).id;

      // 验证聚类 slug 提取
      assert.equal(deriveClusterSlug({ slotKey: 'sqlite:wal-mode' }), 'sqlite');

      // 编译并持久化 Wiki 聚合页
      const page = buildWikiPage(store, {
        spaceId: 'backend',
        slug: 'sqlite',
        title: 'SQLite 并发与存储最佳实践',
        now,
      });

      assert.ok(page.pageId, 'Wiki 页面必须成功分配 pageId');
      assert.equal(page.spaceId, 'backend');
      assert.equal(page.slug, 'sqlite');
      assert.equal(page.dirty, 0);
      assert.ok(page.summary.includes('## 核心事实与要点汇总'));
      assert.ok(page.summary.includes('SQLite 开启 WAL 模式'));
      assert.ok(page.summary.includes('wal_checkpoint'));

      // 直接从 SQLite 查询 wiki_pages 验证真实物理落盘
      const pagesInDb = store.listWikiPages({ spaceId: 'backend' });
      assert.equal(pagesInDb.length, 1);
      assert.equal(pagesInDb[0].slug, 'sqlite');
      assert.equal(Boolean(pagesInDb[0].dirty), false);

      // 增量标记 dirty 并重编
      markClusterDirty(store, 'backend', 'sqlite');
      const dirtyList = store.listWikiPages({ spaceId: 'backend', dirtyOnly: true });
      assert.equal(dirtyList.length, 1, '脏页必须正确检索出');
      assert.equal(Boolean(dirtyList[0].dirty), true);

      // 执行脏页增量重编
      const compiledList = compileDirtyWikiPages(store, { now: now + 1000 });
      assert.equal(compiledList.length, 1);
      assert.equal(Boolean(compiledList[0].dirty), false);

      const cleanList = store.listWikiPages({ spaceId: 'backend', dirtyOnly: true });
      assert.equal(cleanList.length, 0, '增量编译后脏页列表应清空');
    } finally {
      store.close();
    }
  });

  await t.test('4. L3 归档合并与 compactMemory 容量释放测试', () => {
    const store = open(dbPath);
    try {
      const now = Date.now();
      const coldIds = [];
      for (let i = 1; i <= 6; i++) {
        const id = store.put({
          spaceId: 'cluster-a',
          category: 'experience',
          tier: TIER_L2,
          text: `历史冷数据片段第 ${i} 项：记录旧环境的测试指标详情与监控波动数据 ${i}`,
          now: now - 90 * DAY_MS,
        }).id;
        coldIds.push(id);
      }

      const coldList = store.list({ spaceId: 'cluster-a', includeText: true });
      assert.equal(coldList.length, 6);

      // 执行多对一归档（6:1 压缩）
      const archiveResult = archiveColdMemories(store, coldList, {
        spaceId: 'cluster-a',
        now,
        purgeRetired: true,
      });

      assert.equal(archiveResult.archivedCount, 6);
      assert.ok(archiveResult.archiveMemoryId, '必须生成新的归档条目');

      // 原条目被清理，剩余 1 条合并后的归档汇总记录
      const remaining = store.list({ spaceId: 'cluster-a', includeText: true });
      assert.equal(remaining.length, 1, '原6条记录被物理合并收敛为1条归档');
      assert.equal(remaining[0].id, archiveResult.archiveMemoryId);
      assert.equal(remaining[0].tier, TIER_L3);
      assert.ok(remaining[0].text.includes('【L3冷归档汇编】'));
    } finally {
      store.close();
    }
  });

  await t.test('5. 1000 轮代谢循环压力测试，验证总记忆体积严格收敛在指标范围内 (<=256KB)', () => {
    const store = open(dbPath);
    try {
      const softLimitBytes = 180 * 1024; // 180KB
      const hardLimitBytes = 256 * 1024; // 256KB

      let simulatedTime = Date.now();
      const store = open(dbPath, { now: () => simulatedTime });

      // 先写入 3 条核心恒温层 L0 记录（永不衰减、永不被淘汰）
      const l0Ids = [
        store.put({
          category: 'rule',
          tier: TIER_L0,
          text: '核心底座恒温规则 01：用户隐私与认证信息全局最高权限保护',
          createdAt: simulatedTime,
        }).id,
        store.put({
          category: 'profile',
          tier: TIER_L0,
          text: '核心底座恒温档案 02：系统架构师 YG，技术栈 TypeScript, Rust, SQLite',
          createdAt: simulatedTime,
        }).id,
        store.putState({
          slotKey: 'session_active_tenant',
          text: 'enterprise-node-01',
          now: simulatedTime,
        }).id,
      ];

      // 运行 1000 轮写入与热冷代谢循环
      // 每轮模拟推进时间、写入温水记忆、偶尔命中历史记忆、触发 runMetabolism
      for (let round = 1; round <= 1000; round++) {
        simulatedTime += 2 * 3600 * 1000; // 每轮推进 2 小时

        // 每轮写入 1~2 条新经验/决策（L1）
        store.put({
          category: round % 3 === 0 ? 'decision' : 'experience',
          tier: TIER_L1,
          slotKey: `module-${round % 5}:metric-${round}`,
          text: `第 ${round} 轮运行记录：服务实例 node-${round % 10} 响应延时与心跳指标稳定在 ${round * 3}ms，包含详细堆栈追踪信息与环境上下文载荷。`,
          createdAt: simulatedTime,
        });

        // 随机挑选 L0 条目进行访问，保证常驻
        if (round % 10 === 0) {
          store.updateAccess(l0Ids[0], simulatedTime);
        }

        // 每 20 轮执行一次四级热冷代谢引擎
        if (round % 20 === 0) {
          const report = runMetabolism(store, {
            now: simulatedTime,
            softLimitBytes,
            hardLimitBytes,
            halfLifeDays: 7,
            archiveBatchSize: 5,
            vacuumOnPressure: true,
          });

          // 断言：代谢后体积必须受控在硬上限 256KB 内
          assert.ok(
            report.withinHardLimit,
            `第 ${round} 轮代谢后数据库大小必须 <= 256KB，实测: ${report.bytesAfter} 字节`,
          );
        }
      }

      // 最终全面体检
      const finalReport = runMetabolism(store, {
        now: simulatedTime,
        softLimitBytes,
        hardLimitBytes,
        halfLifeDays: 7,
        archiveBatchSize: 5,
        vacuumOnPressure: true,
      });

      const finalStats = store.stats();

      // 1. 验证总容量 <= 256KB 指标
      assert.ok(
        finalStats.bytes <= hardLimitBytes,
        `1000 轮长期运行后总存储字节 (${finalStats.bytes}) 必须严格收敛在 256KB (${hardLimitBytes}) 以内`,
      );

      // 2. 验证 L0 核心恒温层完好无损（3条最初的 rule/profile/state 依然完整存在且为 active）
      for (const id of l0Ids) {
        const row = store.get(id);
        assert.ok(row, `L0 核心恒温记录 ${id} 必须完好存在`);
        assert.equal(row.status, 'active', `L0 核心恒温记录 ${id} 状态必须为 active`);
        assert.equal(row.tier, TIER_L0, `L0 核心恒温记录 ${id} 层级必须固定为 TIER_L0`);
      }

      // 3. 验证 Wiki 页面已落盘在 SQLite 中
      const wikiPages = store.listWikiPages({});
      assert.ok(wikiPages.length >= 1, '必须生成并落盘了 Markdown 知识聚合页');
    } finally {
      store.close();
    }
  });
});
