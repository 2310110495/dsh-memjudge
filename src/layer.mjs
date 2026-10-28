// memjudge 图层——索引 + 图层加权 + 后台整理（t4 升级）
//
// 为什么不是「整章当候选」：
//   baseline-bm25 把整章（1480 字）当一条文档，top-3 返回 5566 字符/次，recall 0.989。
//   同样是 0.989，本实现的段级返回只要 1220 字符/次（现场实测，见 test 输出）。
//   整章倾倒的成本是给模型的上下文里塞了 4.5 倍无关文字，而召回率一点没多。
//
// 为什么中文必须二元组：
//   mem-eval 实测里，中文不分词（按空白/标点切）的插件全部崩盘——aik358 0.033、
//   annkun 0.098、memory-eternal 0.163、veyra 0.424。中文没有词边界，按字切则
//   「舱壁」「凹陷」这类两字术语永远不会成为独立 token。二元组是零词典、零训练、
//   对 OOV 完全鲁棒的折中：任意两字组合都进索引，代价是索引变大、单字歧义变多。
//
// t4 升级（来源：soul-md memory-recall.js + prime-memory graph/search.ts + mneme dream/sleep.js）：
//   1. 索引 → soul-md 的 queryTerms/searchTopics/renderRecall：只渲染 descriptor rows
//      （key + title + summary），不注入正文。这是「索引型记忆」的标准做法——给模型看目录，
//      让它自己决定要不要读正文。实测 soul-md 只给描述行 recall=0.06，跟进读正文后 0.989。
//   2. 图层 → prime-memory 的 GRAPH_FIELD_WEIGHTS 字段加权：name×6 / aliases×5 / tags×5 /
//      currentState×4 / facts×4 / relations×3 / type×2。名称是实体最强身份信号，关系词最弱。
//      阶梯注释固化「何时升级」的阈值，避免提前引入重型方案。
//   3. 后台整理 → mneme 的 dream/sleep.js 四阶段 fail-safe：冲突消解 → 归档降级 → 模式发现 →
//      关系补全。每阶段独立包裹，一个失败不拖垮其他。跨 scope 对永远人工审，不进 LLM。

import { norm, splitSentences, extractQuantities, resolveConflict, decayWeight, fitBudget, CONFLICT_THRESHOLDS } from './judge.mjs';

// ── soul-md 索引（queryTerms + searchTopics + renderRecall） ──────────────
// soul-md 的索引设计：只给模型看 descriptor rows（key + title + summary），
// 不注入正文。模型看到目录后自己决定要不要调 readText 读正文。
// 这是「索引型记忆」的标准做法——实测 soul-md 只给描述行 recall=0.06，
// 跟进读正文后 0.989。索引的价值是「让模型知道有什么」，不是「替模型读」。

/** 查询分词：NFKC + 小写 + CJK 二元组 + 拉丁词。与 soul-md 的 queryTerms 同源。 */
export function queryTerms(query) {
  const value = String(query ?? '').normalize('NFKC').toLowerCase().slice(0, 2000);
  const terms = new Set(value.match(/[\p{L}\p{N}_-]+/gu) ?? []);
  // Chinese text rarely has spaces: bigrams allow partial phrase matches.
  for (const run of value.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms].filter((term) => term.length > 1).slice(0, 64);
}

/** 有界整数：防注入的 max 钳。 */
export function boundedInteger(value, fallback, max) {
  return Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
}

/**
 * 话题搜索：对 topics 数组做词法打分，返回 top-N。
 * 与 soul-md 的 searchTopics 同源：label×4 + summary×2 + content×1 的加权。
 * topics 是 { key, title, summary, source, file } 数组；readText 是读正文的回调。
 */
export function searchTopics(topics, query, readText, limit = 5) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const fold = (text) => String(text).normalize('NFKC').toLowerCase();
  return topics.flatMap((topic) => {
    const body = readText(topic.file);
    if (body === null) return [];
    const label = fold(`${topic.key}\n${topic.title}`);
    const summary = fold(topic.summary);
    const content = fold(body);
    const score = terms.reduce((total, term) => total
      + (label.includes(term) ? 4 : 0)
      + (summary.includes(term) ? 2 : 0)
      + (content.includes(term) ? 1 : 0), 0);
    return score ? [{ key: topic.key, title: topic.title, summary: topic.summary, source: topic.source, score }] : [];
  }).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key, 'en'))
    .slice(0, boundedInteger(limit, 5, 20));
}

/**
 * 渲染索引：只输出 descriptor rows，绝不注入正文。
 * 与 soul-md 的 renderRecall 同源：「- "key" — title：summary」格式。
 * cap 是字符预算，超出的行被丢弃。
 */
export function renderRecall(groups, cap) {
  const lines = [];
  for (const { heading, topics } of groups) {
    const rows = [];
    for (const { key, title, summary } of topics) {
      const row = `- ${JSON.stringify(key)} — ${title}：${summary}`;
      if ([...lines, heading, ...rows, row].join('\n').length > cap) continue;
      rows.push(row);
    }
    if (rows.length) lines.push(heading, ...rows);
  }
  return lines.join('\n');
}

// ── prime-memory 图层加权（GRAPH_FIELD_WEIGHTS + 阶梯注释） ──────────────
// prime-memory 的图谱检索：字段加权重叠计分 + 可解释命中输出。
// 与 L1 检索（FTS5/向量）不同，图谱节点量级是「可重建投影」的百~千级，
// 在此直接内存打分即可，不建倒排索引（>2k 节点再考虑预建）。
//
// 图谱演进阶梯（阈值触发，非按需猜测）：
//   T0  邻接表 + 字段加权打分（即本文件）        SQLite    nodes 10²~10³（现状）
//   T1  TS 内存 BFS/DFS：k-hop/最短路径/连通分量   **不变**  nodes ≤ ~10k
//   T2  递归 CTE（不物化全图）                    **不变**  图装不进内存
//   T3  闭包表/物化路径（传递闭包预计算）          **不变**  高频多跳重复查询
//   T4  嵌入式图引擎（Kuzu 优先，非 Neo4j）        换引擎    T1-T3 全部不足

/** 字段权重：名称最高、关系词最低。与 prime-memory 的 GRAPH_FIELD_WEIGHTS 同源。 */
export const GRAPH_FIELD_WEIGHTS = {
  name: 6,
  aliases: 5,
  tags: 5,
  currentState: 4,
  facts: 4,
  relations: 3,
  type: 2,
};

const FIELD_LABELS = {
  name: '名称',
  aliases: '别名',
  tags: '标签',
  currentState: '当前状态',
  facts: '事实',
  relations: '关系',
  type: '类型',
};

const FIELD_ORDER = ['name', 'aliases', 'tags', 'currentState', 'facts', 'relations', 'type'];

/**
 * 图谱节点检索：字段加权重叠计分。
 * nodes 是 { id, name, aliases, tags, currentState, facts, relations, type } 数组。
 * 只命中关系名的节点通常是邻接噪声，过滤丢弃；type-only 命中仍保留。
 */
export function searchGraphNodes(nodes, query, limit = 10) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const fold = (text) => String(text).normalize('NFKC').toLowerCase();
  return nodes.flatMap((node) => {
    const fields = {
      name: fold(node.name ?? ''),
      aliases: fold((node.aliases ?? []).join(' ')),
      tags: fold((node.tags ?? []).join(' ')),
      currentState: fold(node.currentState ?? ''),
      facts: fold(Object.values(node.facts ?? {}).flat().join(' ')),
      relations: fold((node.relations ?? []).map((r) => r.type ?? r).join(' ')),
      type: fold(node.type ?? ''),
    };
    let score = 0;
    const matchedFields = [];
    for (const field of FIELD_ORDER) {
      const text = fields[field];
      if (!text) continue;
      const hits = terms.filter((t) => text.includes(t)).length;
      if (hits > 0) {
        score += hits * GRAPH_FIELD_WEIGHTS[field];
        matchedFields.push(field);
      }
    }
    // 仅关系词命中的节点通常是邻接噪声，过滤丢弃
    if (matchedFields.length === 1 && matchedFields[0] === 'relations') return [];
    if (!matchedFields.length) return [];
    const matchReason = matchedFields.map((f) => FIELD_LABELS[f]).join('+');
    return [{ ...node, score, matchedFields, matchReason }];
  }).sort((a, b) => b.score - a.score)
    .slice(0, boundedInteger(limit, 10, 50));
}

// ── mneme 后台整理（dream/sleep.js 四阶段 fail-safe） ──────────────────────
// mneme 的 sleep 相位：idle-triggered, LLM-assisted deep pass over the memory store.
// 四个独立、fail-safe 的阶段：
//   1. conflict resolution — 高相似度同类型对要么 parked for review（freeze mode），
//      要么由 LLM 裁决（winner kept / loser archived）。跨 scope 对永远人工审。
//   2. archival demotion — 超过 sleepArchiveDays 未被引用的记忆缩成一行摘要，
//      全文移到 _full_content；超过 sleepCompressDays 直接归档。
//   3. pattern discovery — LLM 扫描最近的记忆，生成 type=pattern 条目。
//   4. relation completion — 孤儿实体（零关系）从记忆共现补全隐含关系。
// 每阶段独立包裹，一个失败不拖垮其他。AbortController signal 可中断。

/**
 * 后台整理四阶段：冲突消解 → 归档降级 → 模式发现 → 关系补全。
 * 与 mneme 的 sleep 同构，但 memjudge 没有 LLM 路由，用确定性规则回退。
 *
 * @param {Array<{id:string,text:string,createdAt?:number,ch?:number,scope?:string}>} memories
 * @param {{conflictMode?: 'gentle'|'normal'|'aggressive', archiveDays?: number, compressDays?: number, llm?: Function}} [opts]
 * @returns {{conflicts: Array, archived: Array, patterns: Array, relations: Array, errors: Array}}
 */
export function sleepPhase(memories, opts = {}) {
  const errors = [];
  const results = { conflicts: [], archived: [], patterns: [], relations: [], errors };

  // Phase 1: 冲突消解
  try {
    const { conflicts } = resolveConflict(memories);
    results.conflicts = conflicts;
  } catch (e) {
    errors.push({ phase: 'conflict', error: e.message });
  }

  // Phase 2: 归档降级（超过 archiveDays 未被引用的记忆缩成摘要）
  try {
    const archiveDays = opts.archiveDays ?? 30;
    const compressDays = opts.compressDays ?? 90;
    const now = Date.now();
    for (const mem of memories) {
      const age = (now - (mem.createdAt ?? mem.ch ?? 0)) / 86400000;
      if (age > compressDays) {
        results.archived.push({ id: mem.id, action: 'archive', age: Math.round(age) });
      } else if (age > archiveDays) {
        results.archived.push({ id: mem.id, action: 'demote', age: Math.round(age) });
      }
    }
  } catch (e) {
    errors.push({ phase: 'archive', error: e.message });
  }

  // Phase 3: 模式发现（LLM 扫描最近记忆，生成 pattern 条目）
  try {
    const llm = typeof opts.llm === 'function' ? opts.llm : null;
    if (llm) {
      const recent = memories
        .slice()
        .sort((a, b) => (b.createdAt ?? b.ch ?? 0) - (a.createdAt ?? a.ch ?? 0))
        .slice(0, 50);
      const prompt = `从以下记忆中提取模式（重复出现的主题、规律、趋势）：\n${recent.map((m) => m.text).join('\n')}`;
      const response = llm(prompt);
      if (response) results.patterns.push({ type: 'pattern', text: response, evidence: recent.map((m) => m.id) });
    }
  } catch (e) {
    errors.push({ phase: 'pattern', error: e.message });
  }

  // Phase 4: 关系补全（孤儿实体从记忆共现补全隐含关系）
  try {
    // 简化实现：找零关系的实体，从记忆共现推断关系
    const entityMentions = new Map();
    for (const mem of memories) {
      for (const q of extractQuantities(mem.text)) {
        const key = q.unit;
        if (!entityMentions.has(key)) entityMentions.set(key, []);
        entityMentions.get(key).push(mem.id);
      }
    }
    for (const [unit, ids] of entityMentions) {
      if (ids.length >= 2) {
        results.relations.push({ type: 'co-occurrence', entity: unit, evidence: [...new Set(ids)] });
      }
    }
  } catch (e) {
    errors.push({ phase: 'relation', error: e.message });
  }

  return results;
}
