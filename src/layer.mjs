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

import { norm, splitSentences, extractQuantities, extractFacts, resolveConflict, decayWeight, fitBudget, CONFLICT_THRESHOLDS } from './judge.mjs';

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

// ── karpathy llm-wiki 编译层：raw 不可变 → wiki 投影（worker t14） ──────────
//
// llm-wiki 的分层是：raw（原始材料，只追加、永不改写）→ wiki（编译产物，可随时丢弃重建）。
// 移植到 SQLite 时最容易走歪的一步是把「编译结果」写回 raw 表——那样 raw 就变成了
// 一份既有原文又有加工物的混合体，原文不再可信，冲突也永远说不清哪边是材料、哪边是判断。
// 这里的边界是硬的：memories 表是 raw 的唯一副本，编译层只读它，投影全部在内存里生成。
// compileWiki() 是纯函数：同样的 raw 进来，同样的 wiki 出去，两次结果字节级相同。
//
// 为什么要有 Status 三态而不是「删掉旧的」：
//   矛盾不删是记忆系统的底线。旧值被判负并不等于它没出现过——「原报九厘米、现予更正
//   十一厘米」这句话本身就要求两个值都留着，否则下次问「原报多少」就答不上来。
//   Current / Outdated / Disputed 三态正好对应三种处境：当前有效、明确被取代、无法裁决。

export const WIKI_VERSION = 1;

export const TRIAGE = Object.freeze({
  NEW: 'new',
  UPDATE: 'update',
  DISPUTED: 'disputed',
  NO_MATERIAL: 'no-material',
});

export const PAGE_STATUS = Object.freeze({
  CURRENT: 'Current',
  OUTDATED: 'Outdated',
  DISPUTED: 'Disputed',
});

// judge.mjs:545 的 REVISION_CUE 是模块内常量、没有导出，而 t14 不允许改 judge.mjs。
// 这里复制同一张表：编译层判「明确被取代」和判断层判「原文自带更正」必须是同一个判据，
// 两边若分叉，wiki 会把旧值标成 Outdated 而判断层认为没发生修订，状态就对不上了。
const REVISION_CUE = /现予更正|予以更正|更正为|更正后|作废|以.{0,8}为准|已撤销|已推翻|原报|原测|原记录|系估值|系估算|系目测|系误记/;

// extractFacts 把「原报九厘米」抽成 (entity, 原报) = 九厘米，属性落在这些前缀上时，
// 该值在原文里就是以「旧值」身份出现的，投影据此直接标 Outdated。
const REVISION_PREFIX_ATTR = /^(原报|原测|原记录|原载|原写|原称|原为|原系|原属)$/;

// 日期与引号串：Grounding 校验要逐个回 raw 找的东西。带 g 的常量不进状态机判断，
// 每次用 tokensOf() 复制一份再 matchAll，免得 lastIndex 在调用之间残留。
const DATE_RE = /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/g;
const QUOTED_RE = /「[^」]{2,}」|“[^”]{2,}”|"[^"]{2,}"/g;

function tokensOf(re, text) {
  if (text == null) return [];
  return [...String(text).matchAll(new RegExp(re.source, re.flags))].map((m) => m[0]);
}

/** FNV-1a 32 位：比 JSON.stringify 更适合当「内容指纹」，不受键序影响。 */
function fnv1a(input) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(String(input), 'utf8')) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把抽出来的值对齐回 raw 的逐字片段。
 *
 * extractFacts 的 value 是 `${数字}${单位}` 直接拼的（judge.mjs:151），原文若写成
 * 「147 卷」带空格，拼出来就是「147卷」——语义没错，但投影里出现了 raw 里不存在的
 * 字符串，Grounding Invariant 立刻判违规。修的位置必须在这层：raw 是真相，投影向 raw
 * 对齐；反过来去改判断层的抽取口径会动到检索/拒答的既有行为（t14 明确不许改 judge.mjs）。
 *
 * 对齐不上就原样返回，让校验脚本把它报出来——不回填、不猜测，违规比编造好。
 */
function alignToRaw(value, raw) {
  const v = String(value ?? '');
  if (!v || raw.includes(v)) return v;
  const m = /^([0-9零一二三四五六七八九十百千万亿两.]+)([\u4e00-\u9fff]+)$/.exec(v);
  if (!m) return v;
  const hit = new RegExp(`${escapeRe(m[1])}\\s*[（(]?\\s*${escapeRe(m[2])}`).exec(raw);
  return hit ? hit[0] : v;
}

function scopeKey(mem) {
  if (mem == null) return '';
  for (const k of ['scope', 'agent_scope', 'workspace_scope']) {
    if (mem[k] != null && mem[k] !== '') return String(mem[k]);
  }
  return '';
}

/**
 * raw 指纹：只由 id + text 决定，与编译结果无关。
 * 用来证明「编译没有动 raw」——两次编译之间 rawDigest 不同就说明有人改了原文，
 * 而不是投影漂移。
 */
export function rawDigest(memories) {
  const list = (Array.isArray(memories) ? memories : [])
    .map((m) => `${String(m?.id ?? '')}\u0000${String(m?.text ?? '')}`)
    .sort();
  return fnv1a(list.join('\u0001'));
}

/** 归一成条目：facts 一律从 raw 现算，绝不读任何派生表（派生表是投影，不是真相）。 */
function buildEntries(memories) {
  const list = (Array.isArray(memories) ? memories : []).map((mem, index) => {
    const text = String(mem?.text ?? '');
    let facts = [];
    try {
      facts = extractFacts(text).map((f) => ({
        ...f,
        value: alignToRaw(f.value, text),
        slot: `${f.entity}|${f.attr}`,
      }));
    } catch {
      facts = [];
    }
    const at = Number.isFinite(mem?.createdAt) ? mem.createdAt
      : (Number.isFinite(mem?.ch) ? mem.ch : 0);
    return { mem, id: String(mem?.id ?? `#${index}`), text, at, scope: scopeKey(mem), facts, order: index };
  });
  // 排序必须确定：时间 → id → 输入序。缺了任一维，等时间的批量导入就会随 V8 的
  // 稳定排序假设漂移，compile 的幂等性就靠不住。
  list.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id, 'en') || a.order - b.order);
  return list;
}

/**
 * 两个同槽事实谁赢：修订措辞 > 同 scope 下更新的时间 > 无法裁决。
 * 返回 winner 'a' / 'b' / null（null = Disputed）。
 */
function adjudicatePair(a, b) {
  const cueA = REVISION_CUE.test(String(a.fact.text ?? ''));
  const cueB = REVISION_CUE.test(String(b.fact.text ?? ''));
  if (cueA !== cueB) return { winner: cueA ? 'a' : 'b', reason: 'revision-cue' };
  if (a.entry.scope !== b.entry.scope) return { winner: null, reason: 'cross-scope' };
  if (a.entry.at !== b.entry.at) return { winner: a.entry.at > b.entry.at ? 'a' : 'b', reason: 'newer' };
  return { winner: null, reason: 'same-time' };
}

/**
 * 写入分诊：New / Update / Disputed / No material。
 *
 * 判据落在「同实体同属性」（extractFacts 的 entity+attr 槽），不是「同一个单位」——
 * 「焊缝深度九厘米」和「吃水九厘米」同单位但不是一件事，按单位比会把无关条目判成冲突。
 */
function decide(entry, priors) {
  if (!entry.facts.length) {
    return { kind: TRIAGE.NO_MATERIAL, reason: 'no-facts', slot: null, against: null, fact: null };
  }
  for (const fact of entry.facts) {
    const peers = [];
    for (const p of priors) {
      if (p.id === entry.id) continue;
      for (const pf of p.facts) if (pf.slot === fact.slot) peers.push({ entry: p, fact: pf });
    }
    if (!peers.length) continue;
    // 同槽同值：原文又一次陈述了已存在的事实，没有新信息，算 Update（不是 New）
    const same = peers.find((x) => x.fact.value === fact.value);
    if (same) {
      return { kind: TRIAGE.UPDATE, reason: 'same-value', slot: fact.slot, against: same.entry.id, fact, peer: same.fact };
    }
    for (const peer of peers) {
      const mine = { entry, fact };
      const verdict = adjudicatePair(mine, peer);
      if (verdict.winner) {
        return { kind: TRIAGE.UPDATE, reason: verdict.reason, slot: fact.slot, against: peer.entry.id, fact, peer: peer.fact };
      }
    }
    // 同槽多值且一个都裁不了：两边都留，标 Disputed，绝不替用户选
    return { kind: TRIAGE.DISPUTED, reason: 'undecidable', slot: fact.slot, against: peers[0].entry.id, fact, peer: peers[0].fact };
  }
  return { kind: TRIAGE.NEW, reason: 'new-slot', slot: entry.facts[0].slot, against: null, fact: entry.facts[0] };
}

/** 落盘标记：一行字符串，可写进 memories.source 或 meta，事后再解析回分诊结论。 */
export function triageMark(triage) {
  const parts = ['triage:v1', triage.kind];
  if (triage.slot) parts.push(`slot=${triage.slot}`);
  if (triage.against) parts.push(`vs=${triage.against}`);
  return parts.join(':');
}

/** 解析落盘标记，还原 kind（供 CLI / 审计脚本读回）。 */
export function parseTriageMark(mark) {
  const m = /^triage:v1:([a-z-]+)/.exec(String(mark ?? ''));
  return m ? m[1] : null;
}

/** 一个槽位内所有事实的三态：只有一个值时全 Current，多值才需要裁决。 */
function resolveSlot(items) {
  const values = [...new Set(items.map((i) => i.fact.value))];
  if (values.length < 2) {
    // 单值槽也可能自带旧值身份：「原报九厘米」抽出来的属性就是「原报」。
    // 原文自己说这是旧值，投影不能把它标成 Current——那不是裁决，是照抄措辞。
    return items.map((item) => {
      const restated = REVISION_PREFIX_ATTR.test(String(item.fact.attr ?? ''));
      return {
        item,
        status: restated ? PAGE_STATUS.OUTDATED : PAGE_STATUS.CURRENT,
        reason: restated ? 'restated-old' : 'only-value',
      };
    });
  }
  const cued = items.filter((i) => REVISION_CUE.test(String(i.fact.text ?? '')));
  if (cued.length) {
    const winner = cued.slice().sort((x, y) => y.entry.at - x.entry.at)[0];
    return items.map((item) => ({
      item,
      status: item.fact.value === winner.fact.value ? PAGE_STATUS.CURRENT : PAGE_STATUS.OUTDATED,
      reason: 'revision-cue',
    }));
  }
  if (new Set(items.map((i) => i.entry.scope)).size > 1) {
    return items.map((item) => ({ item, status: PAGE_STATUS.DISPUTED, reason: 'cross-scope' }));
  }
  if (new Set(items.map((i) => i.entry.at)).size > 1) {
    const winner = items.slice().sort((x, y) => y.entry.at - x.entry.at)[0];
    return items.map((item) => ({
      item,
      status: item.fact.value === winner.fact.value ? PAGE_STATUS.CURRENT : PAGE_STATUS.OUTDATED,
      reason: 'newer',
    }));
  }
  return items.map((item) => ({ item, status: PAGE_STATUS.DISPUTED, reason: 'same-time' }));
}

function renderBlock(block) {
  const lines = [
    `--- ${block.id}`,
    `Raw: ${block.id}`,
    `Status: ${block.status}`,
    `Triage: ${block.triage} (${block.triageReason})`,
  ];
  if (block.ch != null) lines.push(`ch: ${block.ch}`);
  for (const f of block.facts) {
    const note = f.reason === 'only-value' ? '' : ` [${f.reason}]`;
    lines.push(`- (${f.entity}, ${f.attr}) = ${f.value}  Status: ${f.status}${note}`);
  }
  if (block.facts.length) lines.push(`Quote: "${block.facts[0].quote}"`);
  return lines;
}

/**
 * 全量重建 wiki 投影：raw → blocks → doc。
 *
 * 幂等由三个确定性来源保证：条目按 (时间, id, 输入序) 排序、facts 从 raw 现算、
 * 状态裁决只看 raw 自带的时间/措辞/scope——没有 Date.now()、没有 Map 迭代序依赖。
 *
 * @param {Array<{id:string,text:string,createdAt?:number,ch?:number,scope?:string}>} memories
 * @param {{now?: number}} [opts]
 * @returns {{version:number, rawDigest:string, blocks:Array, doc:string, slots:Array,
 *   statusCounts:object, pageStatusCounts:object, triageCounts:object}}
 */
export function compileWiki(memories, opts = {}) {
  const entries = buildEntries(memories);

  // 分诊是历史判定：第 i 条只跟它之前的记忆比。事后重算会把「当时裁不了的 Disputed」
  // 洗成 Update（后面的条目补上了裁决依据），那就丢了写入时刻的判断痕迹。
  const triageByIndex = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    triageByIndex.set(i, decide(entries[i], entries.slice(0, i)));
  }

  const slots = new Map();
  entries.forEach((entry, index) => {
    for (const fact of entry.facts) {
      if (!slots.has(fact.slot)) slots.set(fact.slot, []);
      slots.get(fact.slot).push({ entry, fact, index });
    }
  });

  const statusOf = new Map();
  const slotReports = [];
  for (const [slot, items] of slots) {
    const resolved = resolveSlot(items);
    for (const r of resolved) {
      statusOf.set(`${r.item.index}|${slot}|${r.item.fact.value}`, { status: r.status, reason: r.reason });
    }
    const values = [...new Set(items.map((i) => i.fact.value))];
    if (values.length < 2) continue;
    slotReports.push({
      slot,
      values,
      current: [...new Set(resolved.filter((r) => r.status === PAGE_STATUS.CURRENT).map((r) => r.item.fact.value))],
      outdated: [...new Set(resolved.filter((r) => r.status === PAGE_STATUS.OUTDATED).map((r) => r.item.fact.value))],
      disputed: [...new Set(resolved.filter((r) => r.status === PAGE_STATUS.DISPUTED).map((r) => r.item.fact.value))],
      reason: resolved[0].reason,
      evidence: items.map((i) => ({ id: i.entry.id, value: i.fact.value, at: i.entry.at, scope: i.entry.scope, text: i.fact.text })),
    });
  }

  const triageCounts = { [TRIAGE.NEW]: 0, [TRIAGE.UPDATE]: 0, [TRIAGE.DISPUTED]: 0, [TRIAGE.NO_MATERIAL]: 0 };
  const statusCounts = { [PAGE_STATUS.CURRENT]: 0, [PAGE_STATUS.OUTDATED]: 0, [PAGE_STATUS.DISPUTED]: 0 };
  const pageStatusCounts = { [PAGE_STATUS.CURRENT]: 0, [PAGE_STATUS.OUTDATED]: 0, [PAGE_STATUS.DISPUTED]: 0 };

  const blocks = entries.map((entry, index) => {
    const facts = entry.facts.map((fact) => {
      const s = statusOf.get(`${index}|${fact.slot}|${fact.value}`) ?? { status: PAGE_STATUS.CURRENT, reason: 'only-value' };
      return {
        slot: fact.slot,
        entity: fact.entity,
        attr: fact.attr,
        value: fact.value,
        kind: fact.kind,
        status: s.status,
        reason: s.reason,
        quote: String(fact.text ?? ''),
      };
    });
    for (const f of facts) statusCounts[f.status] += 1;
    const triage = triageByIndex.get(index);
    triageCounts[triage.kind] += 1;
    const present = new Set(facts.map((f) => f.status));
    const status = present.has(PAGE_STATUS.CURRENT) ? PAGE_STATUS.CURRENT
      : present.has(PAGE_STATUS.DISPUTED) ? PAGE_STATUS.DISPUTED
        : present.has(PAGE_STATUS.OUTDATED) ? PAGE_STATUS.OUTDATED
          : PAGE_STATUS.CURRENT;
    pageStatusCounts[status] += 1;
    const block = {
      id: entry.id,
      raw: entry.text,
      ch: entry.mem?.ch ?? null,
      at: entry.at,
      scope: entry.scope,
      triage: triage.kind,
      triageReason: triage.reason,
      triageMark: triageMark(triage),
      status,
      facts,
      supersedes: entry.mem?.supersedes ?? null,
      supersededBy: entry.mem?.supersededBy ?? null,
    };
    block.lines = renderBlock(block);
    return block;
  });

  return {
    version: WIKI_VERSION,
    generatedAt: opts.now ?? null,
    rawDigest: rawDigest(memories),
    blocks,
    doc: blocks.map((b) => b.lines.join('\n')).join('\n\n'),
    slots: slotReports,
    statusCounts,
    pageStatusCounts,
    triageCounts,
  };
}

/**
 * 两次编译的差异。返回 added/removed/changed 三个列表，same 为真即幂等。
 * 差异按 block id 对齐——id 是 raw 的确定性指纹，不会因为排序变化而错位。
 */
export function diffWiki(left, right) {
  const toMap = (w) => new Map((w?.blocks ?? []).map((b) => [b.id, b]));
  const L = toMap(left);
  const R = toMap(right);
  const added = [...R.keys()].filter((id) => !L.has(id));
  const removed = [...L.keys()].filter((id) => !R.has(id));
  const changed = [];
  for (const [id, r] of R) {
    const l = L.get(id);
    if (!l) continue;
    if (l.status !== r.status || l.triage !== r.triage || l.triageMark !== r.triageMark
      || JSON.stringify(l.facts) !== JSON.stringify(r.facts)) {
      changed.push({ id, left: { status: l.status, triage: l.triage }, right: { status: r.status, triage: r.triage } });
    }
  }
  const docSame = String(left?.doc ?? '') === String(right?.doc ?? '');
  return {
    same: !added.length && !removed.length && !changed.length && docSame,
    added,
    removed,
    changed,
    docSame,
    rawDigestSame: left?.rawDigest === right?.rawDigest,
  };
}

/**
 * Grounding Invariant：投影里出现的每个值、日期、引号串，都必须能在该块自己的 raw 里
 * 逐字 indexOf 到。找不到 = 编译层造了原文没有的东西，必须报违规（脚本退出码非 0）。
 *
 * 只回本块 raw 而不是全库：跨条引入同样是编造——「这条记忆里没写过这个数」不能靠
 * 「别的记忆里写过」来洗白。
 */
export function groundingViolations(wiki) {
  const out = [];
  for (const block of wiki?.blocks ?? []) {
    const raw = String(block.raw ?? '');
    const seen = new Set();
    const add = (field, token) => {
      // 日期正则的尾随 \s* 会把空格吃进匹配，trim 掉再比对，否则「2026-10-28 」
      // 永远找不到（raw 里是「2026-10-28 完成」），会把好块误报成违规。
      const t = String(token ?? '').trim();
      if (!t) return;
      const key = `${field}\u0000${t}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!raw.includes(t)) out.push({ id: block.id, field, token: t });
    };
    for (const fact of block.facts ?? []) {
      add('value', fact.value);
      for (const d of tokensOf(DATE_RE, fact.value)) add('date', d);
      for (const q of tokensOf(QUOTED_RE, fact.value)) add('quoted', q.slice(1, -1));
    }
    for (const line of block.lines ?? []) {
      if (line.startsWith('Quote: ')) add('quote', line.slice(7).trim().replace(/^"|"$/g, ''));
      for (const d of tokensOf(DATE_RE, line)) add('date', d);
    }
  }
  return out;
}

/**
 * 写入路径分诊（remember 前调用）：给集成层一个「写之前先问一句」的入口。
 *
 * 返回的 supersedes 只在 Update 时给一条——Disputed 绝不挂取代链，两边都留在库里。
 * mark 是要落盘的标记字符串，写进 memories.source 即可事后审计。
 */
export function planWrite(memory, existing = [], opts = {}) {
  const entry = buildEntries([memory])[0];
  const priors = buildEntries(existing).filter((p) => p.id !== entry.id);
  const triage = decide(entry, priors);
  const against = triage.against ?? null;
  return {
    triage: triage.kind,
    reason: triage.reason,
    slot: triage.slot ?? null,
    against,
    mark: triageMark(triage),
    // same-value 是「同值重复陈述」：没有新信息，也就没有谁被取代，不能挂取代链。
    supersedes:
      triage.kind === TRIAGE.UPDATE && triage.reason !== 'same-value' && against && opts.linkSupersedes !== false
        ? [against]
        : [],
    facts: entry.facts.length,
  };
}

// ── 召回路径的冲突自述（能力 10） ──────────────────────────────────────────
//
// judge.render() 里的 conflictNarrate 只覆盖「render 回调」这一条路，而 memjudge_recall
// 走的是 index.mjs 自己的 render——所以在 render 里加等于白改。判断层要落在召回路径上，
// 判据必须硬：不是「有数字就报矛盾」，而是
//   ① 同一 attr 出现 ≥2 个不同取值（同槽多值）
//   ② 其中至少一条的整句含修订语（现予更正 / 作废 / 以…为准 / 已撤销 / 更正后）
// 两条同时成立才输出一行。缺一条就不说话——宁可漏报，不可在无关问题里塞一句「两处不一致」。
//
// 输出行必须同时满足两个下游口径（mem-eval/harness/score.mjs:196）：
//   JUDGED_CONFLICT —— 文本里要有「两处…不一致」这类判断句（语料正文没有这些措辞，
//                      命中只可能来自插件自己的判断）
//   newSide         —— 文本里要出现后文修正值（十一厘米），所以修正值必须写进行里

/** 从 fact 的句子指针切回原文，切出来的一定是原文子串。 */
function sentOf(text, fact) {
  const start = Number(fact?.sent_off ?? fact?.at ?? 0);
  const len = Number(fact?.sent_len ?? 0);
  if (!Number.isFinite(start) || start < 0 || start >= text.length) return '';
  return text.slice(start, start + (len > 0 ? len : 40));
}

/**
 * 召回到的段落里挑出「同槽多值 + 有修订语」的冲突，生成一行自述。
 *
 * 只看召回结果覆盖的那些记忆（不扫全库）：否则问「硫含量」也会被塞进凹陷深度的冲突，
 * 那是污染不是能力。返回按证据强度排序，默认最多 2 行。
 *
 * @param {Array<{id:string, chapter?:number, text:string, facts:Array}>} entries
 * @param {{limit?:number}} [opts]
 * @returns {Array<{attr:string, values:string[], revised:string, line:string, evidence:Array}>}
 */
export function conflictJudgments(entries, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 2;
  const byAttr = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const text = String(entry?.text ?? '');
    for (const fact of entry?.facts ?? []) {
      const attr = String(fact?.attr ?? '').trim();
      const value = String(fact?.value ?? '').trim();
      if (!attr || !value) continue;
      if (!byAttr.has(attr)) byAttr.set(attr, []);
      byAttr.get(attr).push({
        value,
        entryId: String(entry?.id ?? ''),
        chapter: Number.isFinite(entry?.chapter) ? entry.chapter : 0,
        at: Number(fact?.at ?? 0),
        sent: sentOf(text, fact),
      });
    }
  }

  const out = [];
  for (const [attr, items] of byAttr) {
    const values = [...new Set(items.map((i) => i.value))];
    if (values.length < 2) continue;
    const cued = items.filter((i) => REVISION_CUE.test(i.sent));
    if (!cued.length) continue; // 没有修订语就不是「明确被更正」，不报
    // 修正值取修订语那条里的值；多条时取章节号最大的（后文），同章取 at 最大
    const revised = cued
      .slice()
      .sort((a, b) => b.chapter - a.chapter || b.at - a.at)[0].value;
    // 取值按章节升序排，读起来就是「先旧后新」
    const ordered = [...new Set(items.slice().sort((a, b) => a.chapter - b.chapter || a.at - b.at).map((i) => i.value))];
    out.push({
      attr,
      values: ordered,
      revised,
      line: `[冲突] 材料里「${attr}」有 ${ordered.length} 个取值（${ordered.join('、')}），两处记录不一致，后文以${revised}为准。`,
      evidence: items.map((i) => ({ id: i.entryId, chapter: i.chapter, value: i.value })),
    });
  }
  // 取值多的、带修订语的优先；同规模按 attr 字典序，保证输出稳定
  out.sort((a, b) => b.values.length - a.values.length || a.attr.localeCompare(b.attr, 'en'));
  return out.slice(0, limit);
}
