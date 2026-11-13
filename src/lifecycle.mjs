// memjudge 热冷生命周期代谢引擎（Lifecycle & Wiki Aggregation Engine）
//
// 架构对齐《F:/记忆库/10-计划/memjudge-v2-架构与实施计划书.md》Phase 2-B：
// 1. 四级热冷代谢模型：
//    - L0（核心恒温层，Tier 0）：rule、profile、活跃 state，永不衰减，永不被 FIFO 淘汰，常驻注入底座。
//    - L1（温水原子层，Tier 1）：新鲜 decision 与 experience，双半衰期热度模型，按访问刷新，低于阈值自然下沉。
//    - L2（落盘 Wiki 聚合页，Tier 2）：按 (space_id, slug) 聚类历史原子记忆并编译合并为 Markdown 知识卡片，
//      调用 store.upsertWikiPage 持久化在 wiki_pages 表中，支持脏页增量标记与编译。
//    - L3（远期冷归档层，Tier 3）：对超期沉底、长期无访问条目多对一归档合并（压缩比 >= 5:1），
//      调用 store.compactMemory 标记冷冻并释放主索引与向量容量。
// 2. runMetabolism(store, opts)：
//    扫描存储容量；当超过软上限（如 200KB / 204800 字节）或条目数阈值时，严格按 L3 归档 -> L2 聚合 -> L1 降级
//    顺序进行代谢淘汰，保证 1000 轮长期运行存储容量严格收敛在指标范围内（<=256KB）。

import {
  TIER_L0,
  TIER_L1,
  TIER_L2,
  TIER_L3,
  normalizeCategory,
  kindToCategory,
} from './schema.mjs';

import {
  decayScore,
  computeTier,
  partitionMemories,
  compileWiki,
} from './layer.mjs';

const DAY_MS = 86400000;

/**
 * 提取聚类 slug。
 * 优先取 slotKey 中的实体标识，其次根据 text 提取主体名词或 source 标签，兜底为 'general-notes'。
 */
export function deriveClusterSlug(mem) {
  if (!mem) return 'general-notes';
  if (typeof mem.slotKey === 'string' && mem.slotKey.trim()) {
    const parts = mem.slotKey.trim().split(/[:/|#]/);
    const candidate = parts[0]?.trim().toLowerCase();
    if (candidate && candidate.length <= 64) return candidate;
  }
  if (typeof mem.slot_key === 'string' && mem.slot_key.trim()) {
    const parts = mem.slot_key.trim().split(/[:/|#]/);
    const candidate = parts[0]?.trim().toLowerCase();
    if (candidate && candidate.length <= 64) return candidate;
  }
  if (typeof mem.source === 'string' && mem.source.trim()) {
    const rawSource = mem.source.trim();
    // 排除单轮对话流水号来源（如 turn:sess:1 / auto:... / lifecycle:archive），避免每轮独占聚类键
    if (!/^(?:turn|auto|lifecycle):/i.test(rawSource)) {
      const sanitized = rawSource.toLowerCase().replace(/[^a-z0-9_\-\u4e00-\u9fa5]/gi, '-').slice(0, 32);
      if (sanitized) return sanitized;
    }
  }
  // 剥离分类前缀标签与常见引导词，优先提取技术组件标识符或核心主题词
  const text = String(mem.text ?? '').trim();
  const clean = text
    .replace(/^(?:[\[【][^\]】]+[\]】]\s*)+/, '')
    .replace(/^(?:架构决策|技术决策|排障经验|报错根因|决定采用|已定位|针对|关于|修复)[:：\s]*/u, '');
  const asciiTopic = clean.match(/[a-zA-Z][a-zA-Z0-9_-]{2,31}/);
  if (asciiTopic && asciiTopic[0]) {
    return asciiTopic[0].toLowerCase();
  }
  const match = clean.match(/[\p{L}\p{N}_-]{2,16}/u);
  if (match && match[0]) {
    return match[0].toLowerCase();
  }
  return 'general-notes';
}

/**
 * 将一组原子记忆聚类编译为 Markdown Wiki 页面正文。
 * 格式遵循 Markdown 知识卡片规范：包含元数据头、条目摘要与关联来源。
 */
export function formatWikiMarkdown({ spaceId, slug, title, memories, now = Date.now() }) {
  const dateStr = new Date(now).toISOString();
  const list = Array.isArray(memories) ? memories : [];
  const lines = [
    `# ${title || slug}`,
    '',
    `> Wiki 知识卡片 | 空间: ${spaceId} | 聚类: ${slug} | 汇总条目数: ${list.length} | 更新时间: ${dateStr}`,
    '',
    '## 核心事实与要点汇总',
  ];

  if (!list.length) {
    lines.push('_暂无条目数据_');
  } else {
    for (const m of list) {
      const id = m.id ?? 'unknown';
      const cat = m.category ?? 'experience';
      const cleanText = String(m.text ?? '').trim().replace(/\r?\n+/g, ' ');
      lines.push(`- **[${cat}]** ${cleanText} \`(${id})\``);
    }
  }

  lines.push('');
  lines.push('## 来源原子索引');
  const sourceIds = list.map((m) => m.id).filter(Boolean);
  lines.push(`- 关联原子条目 (${sourceIds.length} 个): ${sourceIds.join(', ')}`);

  return {
    markdown: lines.join('\n'),
    sourceIds,
    summary: `Wiki 聚合页 [${slug}] 包含 ${list.length} 条原子记录`,
  };
}

/**
 * 标记脏页：当关联原子记忆发生变动时，将对应空间与 slug 的 wiki page 设为 dirty=1。
 */
export function markClusterDirty(store, spaceId, slug) {
  if (!store || typeof store.upsertWikiPage !== 'function') return null;
  return store.upsertWikiPage({
    spaceId,
    slug,
    dirty: 1,
  });
}

/**
 * 编译并持久化 Wiki 聚合页（L2）。
 * 扫描指定空间中属于该 slug 聚类（或全局脏页）的原子记忆，重新编译并写入 wiki_pages 表。
 *
 * @param {object} store 存储实例
 * @param {object} opts
 * @param {string} opts.spaceId
 * @param {string} opts.slug
 * @param {Array<object>} [opts.memories] 可选的指定原子条目集合；未提供时从 store 查询
 * @param {number} [opts.now]
 * @returns {object} upserted wiki page 结果
 */
export function buildWikiPage(store, opts = {}) {
  if (!store || typeof store.upsertWikiPage !== 'function') {
    throw new Error('buildWikiPage requires a valid store with upsertWikiPage');
  }

  const {
    spaceId = 'default',
    slug = 'general-notes',
    title = slug,
    now = Date.now(),
  } = opts;

  let memories = opts.memories;
  if (!Array.isArray(memories)) {
    // 从 store 查询 spaceId 下的所有活跃原子记忆进行匹配
    const all = store.list({ spaceId, includeDeleted: false, includeText: true });
    memories = all.filter((m) => deriveClusterSlug(m) === slug);
  }

  const { markdown, sourceIds, summary } = formatWikiMarkdown({
    spaceId,
    slug,
    title,
    memories,
    now,
  });

  const res = store.upsertWikiPage({
    spaceId,
    slug,
    title,
    summary: markdown, // summary 字段作为正文持久化
    sourceIds,
    dirty: 0,
    now,
  });

  return {
    pageId: res.pageId,
    spaceId,
    slug,
    title,
    summary: markdown,
    sourceIds,
    version: res.version,
    dirty: 0,
  };
}

/**
 * L2 增量编译引擎：扫描所有标记为 dirty=1 的 Wiki 页面并完成全量增量重编。
 */
export function compileDirtyWikiPages(store, opts = {}) {
  if (!store || typeof store.listWikiPages !== 'function') return [];
  const dirtyPages = store.listWikiPages({ dirtyOnly: true, limit: opts.limit ?? 100 });
  const results = [];
  const now = opts.now ?? Date.now();

  for (const page of dirtyPages) {
    const compiled = buildWikiPage(store, {
      spaceId: page.space_id ?? page.spaceId,
      slug: page.slug,
      title: page.title,
      now,
    });
    results.push(compiled);
  }

  return results;
}

/**
 * 远期冷归档合并器（L3 合并）：
 * 将一组超期沉底的原子记忆（>=5条为佳）多对一合并为一条高度精炼的归档卡片（压缩比 >= 5:1），
 * 将聚合摘要条目以 TIER_L3 写入主库，并调用 store.compactMemory / forget
 * 将原条目冻结标记或物理移出主索引，确保主库条目数与体积收敛。
 *
 * @param {object} store 存储实例
 * @param {Array<object>} coldMemories 待归档的冷记忆列表
 * @param {object} [opts]
 * @returns {object} 归档结果 { archiveMemoryId, archivedCount, bytesBefore, bytesAfter }
 */
export function archiveColdMemories(store, coldMemories, opts = {}) {
  if (!store || !Array.isArray(coldMemories) || coldMemories.length === 0) {
    return { archiveMemoryId: null, archivedCount: 0 };
  }

  const now = opts.now ?? Date.now();
  const spaceId = opts.spaceId || coldMemories[0].spaceId || coldMemories[0].space_id || 'default';
  const reason = opts.reason || 'L3 多对一冷归档压缩';

  // 1. 严格实现压缩比 >= 5:1：为每个条目提取紧凑微卡片（slotKey 或首句核心摘要，截断冗余载荷）
  const totalRawChars = coldMemories.reduce((acc, m) => acc + String(m.text ?? '').length, 0);
  const targetMaxChars = Math.max(120, Math.floor(totalRawChars / 5));

  const itemsSummary = [];
  for (const m of coldMemories) {
    const raw = String(m.text ?? '').trim().replace(/\s+/g, ' ');
    // 截取核心摘要：保留前 30 个字符并附加关键特征
    const snippet = raw.length > 30 ? raw.slice(0, 30) + '…' : raw;
    const key = m.slotKey || m.slot_key || (m.id ? m.id.slice(-6) : 'item');
    itemsSummary.push(`${key}:${snippet}`);
  }

  const joinedItems = itemsSummary.join('; ');
  const trimmedSummary = joinedItems.length > targetMaxChars ? joinedItems.slice(0, targetMaxChars) + '…' : joinedItems;

  const archiveText = `【L3冷归档汇编】批次条数:${coldMemories.length}|原长:${totalRawChars}|摘要:${trimmedSummary}`;

  // 2. 写入归档条目（放入 TIER_L3，category: experience，状态 active）
  const archivePut = store.put({
    spaceId,
    category: 'experience',
    tier: TIER_L3,
    status: 'active',
    text: archiveText,
    source: 'lifecycle:archive',
    importance: 0.1,
    now,
  });
  const archiveId = archivePut.id;

  // 3. 对原记忆执行 compactMemory / supersede 标记与向量卸载
  const oldIds = coldMemories.map((m) => m.id);
  for (const old of coldMemories) {
    store.compactMemory({
      id: old.id,
      newTier: TIER_L3,
      newStatus: 'archived',
      supersededBy: archiveId,
      reason,
      now,
    });
  }

  // 4. 若开启 purgeRetired，则对这些已完全沉底并生成了 L3 归档汇编的记录执行物理清理
  if (opts.purgeRetired === true) {
    store.forget({ ids: oldIds, spaceId });
  }

  return {
    archiveMemoryId: archiveId,
    archivedCount: coldMemories.length,
    oldIds,
  };
}

/**
 * 完整四级热冷代谢循环触发器（Metabolism Engine）
 *
 * 调度逻辑：
 * 1. 扫描当前 store 中的全部记忆，使用 computeTier 与 decayScore 进行加权热冷状态重估；
 * 2. L0 核心恒温层（rule/profile/state）永远豁免代谢，绝对常驻；
 * 3. L1 温水原子层：随时间流逝自然衰减，低于阈值者平滑降级沉淀到 L2；
 * 4. L2 Wiki 聚合：将属于同一 (space_id, slug) 聚类的原子条目增量聚类并落盘为 Wiki 页面；
 * 5. L3 冷归档：对长期未访问或沉底的 L2/L3 历史条目分批执行多对一归档（>=5:1 压缩），
 *    调用 compactMemory 卸载向量索引与槽位占用；
 * 6. 若存储总字节数超过软上限（如 softLimitBytes，默认 200KB），强制进行批量归档与清理，
 *    并在必要时触发 store.compact() (VACUUM)，确保长期 1000 轮运行总存储严格稳定在 <=256KB。
 *
 * @param {object} store 存储实例
 * @param {object} [opts] 参数选项
 * @param {number} [opts.now] 模拟时间戳
 * @param {number} [opts.softLimitBytes] 软上限阈值（默认 204800 字节，即 200KB）
 * @param {number} [opts.hardLimitBytes] 硬上限阈值（默认 262144 字节，即 256KB）
 * @param {number} [opts.halfLifeDays] 半衰期天数（默认 7 天）
 * @param {number} [opts.archiveBatchSize] 单批归档数量（默认 5）
 * @param {boolean} [opts.vacuumOnPressure] 容量吃紧时是否执行 VACUUM
 * @returns {object} 代谢执行报告 { cycle, actions, statsBefore, statsAfter }
 */
export function runMetabolism(store, opts = {}) {
  if (!store || typeof store.list !== 'function') {
    throw new Error('runMetabolism requires a valid store');
  }

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const softLimitBytes = opts.softLimitBytes ?? 200 * 1024;
  const hardLimitBytes = opts.hardLimitBytes ?? 256 * 1024;
  const archiveBatchSize = Math.max(2, opts.archiveBatchSize ?? 5);

  const initialStats = store.stats();
  const actions = {
    l0Untouched: 0,
    l1DemotedToL2: 0,
    wikiPagesUpdated: 0,
    l3Archived: 0,
    l3Batches: 0,
    compacted: 0,
    vacuumed: false,
  };

  // 1. 读取所有非 deleted 记忆并执行 L0 ~ L3 分层评估
  const allMems = store.list({ includeDeleted: false, includeText: true });
  const partitioned = partitionMemories(allMems, now, {
    halfLifeDays: opts.halfLifeDays ?? 7,
  });

  actions.l0Untouched = partitioned.L0.length;

  // 2. L1 -> L2 平滑沉降：对已经衰减落入 L2 分区但数据库中仍记录为 TIER_L1 的原子条目进行降级标记
  for (const m of partitioned.L2) {
    if (m.tier === TIER_L1 && m.status === 'active') {
      store.compactMemory({
        id: m.id,
        newTier: TIER_L2,
        reason: '自然衰减降级至 L2 聚合准备区',
        now,
      });
      actions.l1DemotedToL2 += 1;
      actions.compacted += 1;
    }
  }

  // 3. L2 落盘 Wiki 聚合：将属于同一 (space_id, slug) 的 L2/L1 原子记忆聚类落盘为 Markdown Wiki 卡片
  // 按 space_id + slug 聚类（排除已是 L3 归档汇编的条目）
  const clusters = new Map();
  for (const m of allMems) {
    if (m.status !== 'active') continue;
    if (m.tier === TIER_L3 || m.source === 'lifecycle:archive') continue;
    const cat = m.category ? normalizeCategory(m.category) : 'experience';
    // 仅针对可聚类范畴（decision/experience）
    if (cat !== 'decision' && cat !== 'experience') continue;

    const spaceId = m.spaceId || m.space_id || 'default';
    const slug = deriveClusterSlug(m);
    const key = `${spaceId}::${slug}`;
    if (!clusters.has(key)) {
      clusters.set(key, { spaceId, slug, memories: [] });
    }
    clusters.get(key).memories.push(m);
  }

  // 为每个有 >= 2 条原子记忆的聚类生成或更新 Wiki 聚合页（保留最新的原子索引与摘要，控制卡片长度）
  for (const { spaceId, slug, memories } of clusters.values()) {
    if (memories.length >= 2) {
      buildWikiPage(store, {
        spaceId,
        slug,
        title: `${slug} 知识汇编`,
        memories,
        now,
      });
      actions.wikiPagesUpdated += 1;
    }
  }

  // 检查当前存储体积与条目负载，判断是否触发 L3 冷归档淘汰
  // 若当前字节数接近软上限、或存在 L3 冷记忆、或 L2+L3 待归档池膨胀，触发归档多对一合并
  const currentBytes = store.bytes();
  const needPrune = currentBytes >= softLimitBytes || partitioned.L3.length >= archiveBatchSize;

  // 待归档候选池：优先选 L3 冷记忆（排除已是 L3 归档条目本身）；若容量仍紧绷，将超期沉底的早期 L2 记忆也纳入归档
  let candidatesForArchive = partitioned.L3.filter((m) => m.source !== 'lifecycle:archive');
  if (candidatesForArchive.length < archiveBatchSize && currentBytes >= softLimitBytes) {
    // 按 lastAccessed 升序选择最老的 L2 条目作为补充归档候选
    const oldestL2 = [...partitioned.L2]
      .filter((m) => {
        if (m.source === 'lifecycle:archive') return false;
        const cat = m.category ? normalizeCategory(m.category) : 'experience';
        return cat !== 'rule' && cat !== 'profile' && cat !== 'state';
      })
      .sort((a, b) => (a.lastAccessed ?? a.createdAt ?? 0) - (b.lastAccessed ?? b.createdAt ?? 0));
    candidatesForArchive.push(...oldestL2);
  }

  if (candidatesForArchive.length >= 2 && (needPrune || currentBytes >= softLimitBytes)) {
    // 4. L3 远期冷归档：将沉底的冷记忆多对一聚合合并
    const coldGroups = new Map();
    for (const cold of candidatesForArchive) {
      // 豁免 L0 条目
      const cat = cold.category ? normalizeCategory(cold.category) : 'experience';
      if (cat === 'rule' || cat === 'profile' || cat === 'state') continue;

      const sp = cold.spaceId || cold.space_id || 'default';
      if (!coldGroups.has(sp)) coldGroups.set(sp, []);
      coldGroups.get(sp).push(cold);
    }

    for (const [spaceId, group] of coldGroups) {
      // 分批归档，每批 >= archiveBatchSize
      for (let i = 0; i < group.length; i += archiveBatchSize) {
        const batch = group.slice(i, i + archiveBatchSize);
        if (batch.length >= 2) {
          const res = archiveColdMemories(store, batch, {
            spaceId,
            now,
            purgeRetired: true, // 彻底释放主库与索引体积
          });
          actions.l3Archived += res.archivedCount;
          actions.compacted += res.archivedCount;
          actions.l3Batches += 1;
        }
      }
    }
  }

  // 4.1 二次保底收敛：如果已有的历史 L3 归档条目过多导致主库膨胀，将最老的归档条目做超远期二次物理淘汰
  if (store.bytes() >= softLimitBytes) {
    const existingArchives = store.list({ includeDeleted: false, includeText: false })
      .filter((m) => m.source === 'lifecycle:archive' && m.tier === TIER_L3)
      .sort((a, b) => (a.createdAt ?? a.created_at ?? 0) - (b.createdAt ?? b.created_at ?? 0));
    if (existingArchives.length >= 10) {
      const purgeBatch = existingArchives.slice(0, 5).map((m) => m.id);
      store.forget({ ids: purgeBatch });
    }
  }

  // 4.2 辅助表水位收敛：回收 ingest_queue 已终态历史载荷与超额历史修订记录，防止原始对话 JSON 撑爆物理页
  let purgedAuxRows = 0;
  const rawDb = typeof store.raw === 'function' ? store.raw() : null;
  if (rawDb && !rawDb.isTransaction) {
    const keepDoneJobs = Math.max(0, opts.keepDoneIngestJobs ?? 8);
    const maxRevsPerMemory = Math.max(2, opts.maxRevisionsPerMemory ?? 16);
    const ingestRes = rawDb.prepare(`
      DELETE FROM main.ingest_queue
      WHERE status IN ('done', 'failed')
        AND job_id NOT IN (
          SELECT job_id FROM main.ingest_queue
          WHERE status IN ('done', 'failed')
          ORDER BY job_id DESC
          LIMIT ?
        )
    `).run(keepDoneJobs);
    purgedAuxRows += Number(ingestRes?.changes ?? 0);

    const orphanRevRes = rawDb.prepare(`
      DELETE FROM main.memory_revisions
      WHERE memory_id NOT IN (SELECT id FROM main.memories)
    `).run();
    purgedAuxRows += Number(orphanRevRes?.changes ?? 0);

    const excessRevRes = rawDb.prepare(`
      DELETE FROM main.memory_revisions
      WHERE rev_id IN (
        SELECT rev_id FROM (
          SELECT rev_id,
                 ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY changed_at DESC, rev_id DESC) AS rn
          FROM main.memory_revisions
        )
        WHERE rn > ?
      )
    `).run(maxRevsPerMemory);
    purgedAuxRows += Number(excessRevRes?.changes ?? 0);
  }
  actions.auxRowsPurged = purgedAuxRows;

  // 5. 存储物理与 WAL 水位整理：当配置了 vacuumOnPressure 或在归档/队列清理释放空间后，执行 checkpoint/vacuum 截断 WAL
  if (
    opts.vacuumOnPressure !== false
    && (actions.l3Archived > 0 || purgedAuxRows >= 16 || store.bytes() >= softLimitBytes)
  ) {
    if (typeof store.compact === 'function') {
      store.compact();
      actions.vacuumed = true;
    }
  }

  const finalStats = store.stats();

  return {
    now,
    actions,
    bytesBefore: initialStats.bytes,
    bytesAfter: finalStats.bytes,
    withinSoftLimit: finalStats.bytes <= softLimitBytes,
    withinHardLimit: finalStats.bytes <= hardLimitBytes,
    statsBefore: initialStats,
    statsAfter: finalStats,
  };
}
