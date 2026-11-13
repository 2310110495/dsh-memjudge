// memjudge 图层——索引 + 图层加权 + 衰减分层 + 后台整理（Schema v8 & v2 升级）
//
// 架构对齐《memjudge-v2-架构与实施计划书》：
//   1. 衰减与分层：基于 Schema v8 五类法定范畴（rule/profile/decision/experience/state）
//      及真实访问时间 lastAccessed/last_accessed_at、访问频次 accessCount/access_count、
//      重要性 importance 计算加权衰减分与动态分层。
//      - rule / profile / state 恒温常驻（L0，永不衰减，衰减分=1.0）
//      - decision / experience 温水原子（L1，基于双半衰期艾宾浩斯衰减与命中频次增强）
//   2. 兼容性导出：保留存量导出（queryTerms, searchTopics, renderRecall, GRAPH_FIELD_WEIGHTS,
//      searchGraphNodes, sleepPhase, WIKI_VERSION, TRIAGE, PAGE_STATUS, compileWiki, diffWiki,
//      groundingViolations, planWrite, triageMark, parseTriageMark, rawDigest, conflictJudgments），
//      并新增规范要求导出的 decayScore, computeTier, partitionMemories。

import {
  norm,
  splitSentences,
  extractQuantities,
  extractFacts,
  resolveConflict,
  decayWeight,
  fitBudget,
  CONFLICT_THRESHOLDS,
} from './judge.mjs';

import {
  normalizeKind,
  normalizeTier,
  MEMORY_TIER_PINNED,
  MEMORY_TIER_MAX,
  TIER_IDLE_DAYS,
  TIER_PROMOTE_ACCESS,
} from './store.mjs';

import {
  TIER_L0,
  TIER_L1,
  TIER_L2,
  TIER_L3,
  normalizeCategory,
  kindToCategory,
} from './schema.mjs';

const DAY_MS = 86400000;

// ── v8 动态加权衰减与分层引擎（decayScore / computeTier / partitionMemories） ──

/**
 * 判断条目是否显式 Pinned 或处于核心恒温层（L0）。
 * 注意：必须严格区分 v8 的 TIER_L1 (1) 与旧版 MEMORY_TIER_PINNED (1)。
 * 只有在显式 pinned 字段为真、tier 为 0 或 category 为 rule/profile/state 时才视为 L0。
 */
function isL0Constant(mem, cat) {
  if (cat === 'rule' || cat === 'profile' || cat === 'state') return true;
  if (mem.pinned === true || mem.pinned === 1) return true;
  if (mem.tier === TIER_L0) return true;
  // 旧版兼容器：若明确声明了旧版 kind 为 person / promise，即使 tier 是 1 也算 pinned
  if (mem.kind === 'person' || mem.kind === 'promise') return true;
  return false;
}

/**
 * 计算记忆条目的综合动态衰减分（0.0 ~ 1.0）。
 *
 * 核心规则：
 * 1. rule / profile / state（以及人工 pinned）为 L0 恒温层，永不衰减，固定返回 1.0。
 * 2. 状态为 superseded 或 archived 的条目，基底衰减折半。
 * 3. 基于 lastAccessed 时间差与双半衰期模型计算艾宾浩斯遗忘曲线：
 *    - 双半衰期：近期半衰期（如 7 天）快速过滤一次性噪声；远期半衰期（如 30 天）平缓保持稳定记忆。
 * 4. 访问频次 log 强化：每次命中展宽遗忘曲线，高频访问条目衰减地板提升。
 * 5. importance 重要度兜底：高重要度（>=0.6）提供 0.6 的衰减地板。
 *
 * @param {object} mem 记忆对象或行记录
 * @param {number} [now] 当前时间戳（ms）
 * @param {object} [opts] 参数（halfLifeDays, longHalfLifeDays, floor, importanceFloor）
 * @returns {number} 归一化衰减分 0.0 ~ 1.0
 */
export function decayScore(mem, now = Date.now(), opts = {}) {
  if (!mem || typeof mem !== 'object') return 0;

  // 范畴判定：支持 category 与 legacy kind
  const cat = mem.category
    ? normalizeCategory(mem.category)
    : (mem.kind ? kindToCategory(mem.kind) : 'experience');

  if (isL0Constant(mem, cat)) {
    return 1.0;
  }

  const {
    halfLifeDays = 7,
    longHalfLifeDays = 30,
    floor = 0.15,
    importanceFloor = 0.6,
  } = opts;

  const lastAccess = Number.isFinite(mem.lastAccessed)
    ? mem.lastAccessed
    : Number.isFinite(mem.last_accessed_at)
      ? mem.last_accessed_at
      : (Number.isFinite(mem.created_at) ? mem.created_at : (Number.isFinite(mem.createdAt) ? mem.createdAt : now));

  const accessCount = Number(mem.accessCount ?? mem.access_count ?? 0) || 0;
  const importance = Number(mem.importance ?? 0) || 0;
  const status = typeof mem.status === 'string' ? mem.status : 'active';

  const idleDays = Math.max(0, (now - lastAccess) / DAY_MS);

  // 双半衰期热度模型：
  // 短期衰减权重 0.7，长期平缓权重 0.3
  const shortDecay = Math.pow(0.5, idleDays / Math.max(1, halfLifeDays));
  const longDecay = Math.pow(0.5, idleDays / Math.max(halfLifeDays, longHalfLifeDays));
  let base = 0.7 * shortDecay + 0.3 * longDecay;

  // 重要度地板
  const effFloor = importance >= importanceFloor ? Math.max(floor, 0.6) : floor;
  base = Math.max(effFloor, base);

  // 访问频次强化：log2(1 + count) 增益
  const freqBoost = 1 + 0.18 * Math.log2(1 + accessCount);
  let score = base * freqBoost;

  // 失效/归档条目惩罚
  if (status === 'superseded') {
    score *= 0.5;
  } else if (status === 'archived') {
    score *= 0.25;
  }

  return Math.min(1.0, Math.max(0.0, score));
}

/**
 * 根据衰减分与元数据判定记忆所属的层级（Tier 0 ~ Tier 3 / L0 ~ L3）。
 *
 * @param {object} mem 记忆对象
 * @param {number} [now] 当前时间戳
 * @param {object} [opts] 参数（scoreThresholdL1, scoreThresholdL2）
 * @returns {number} 0 (L0), 1 (L1), 2 (L2), 3 (L3)
 */
export function computeTier(mem, now = Date.now(), opts = {}) {
  if (!mem || typeof mem !== 'object') return TIER_L3;

  const cat = mem.category
    ? normalizeCategory(mem.category)
    : (mem.kind ? kindToCategory(mem.kind) : 'experience');

  if (isL0Constant(mem, cat)) {
    return TIER_L0;
  }

  const status = typeof mem.status === 'string' ? mem.status : 'active';
  if (status === 'archived') {
    return TIER_L3;
  }

  const score = decayScore(mem, now, opts);
  const l1Threshold = opts.scoreThresholdL1 ?? 0.65;
  const l2Threshold = opts.scoreThresholdL2 ?? 0.35;

  if (score >= l1Threshold) return TIER_L1;
  if (score >= l2Threshold) return TIER_L2;
  return TIER_L3;
}

/**
 * 按 L0 ~ L3 四级对记忆集合进行热冷分层划分。
 *
 * @param {Array<object>} memories 记忆集合
 * @param {number} [now] 当前时间戳
 * @param {object} [opts] 选项
 * @returns {{ L0: Array, L1: Array, L2: Array, L3: Array, stats: { total: number, l0: number, l1: number, l2: number, l3: number } }}
 */
export function partitionMemories(memories, now = Date.now(), opts = {}) {
  const L0 = [];
  const L1 = [];
  const L2 = [];
  const L3 = [];

  const list = Array.isArray(memories) ? memories : [];
  for (const m of list) {
    const tier = computeTier(m, now, opts);
    if (tier === TIER_L0) L0.push(m);
    else if (tier === TIER_L1) L1.push(m);
    else if (tier === TIER_L2) L2.push(m);
    else L3.push(m);
  }

  return {
    L0,
    L1,
    L2,
    L3,
    stats: {
      total: list.length,
      l0: L0.length,
      l1: L1.length,
      l2: L2.length,
      l3: L3.length,
    },
  };
}

// ── soul-md 索引（queryTerms + searchTopics + renderRecall） ──────────────

/** 查询分词：NFKC + 小写 + CJK 二元组 + 拉丁词。与 soul-md 的 queryTerms 同源。 */
export function queryTerms(query) {
  const value = String(query ?? '').normalize('NFKC').toLowerCase().slice(0, 2000);
  const terms = new Set(value.match(/[\p{L}\p{N}_-]+/gu) ?? []);
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
    if (matchedFields.length === 1 && matchedFields[0] === 'relations') return [];
    if (!matchedFields.length) return [];
    const matchReason = matchedFields.map((f) => FIELD_LABELS[f]).join('+');
    return [{ ...node, score, matchedFields, matchReason }];
  }).sort((a, b) => b.score - a.score)
    .slice(0, boundedInteger(limit, 10, 50));
}

// ── mneme 后台整理（dream/sleep.js 四阶段 fail-safe） ──────────────────────

export function sleepPhase(memories, opts = {}) {
  const errors = [];
  const results = { conflicts: [], archived: [], tierWrites: [], patterns: [], relations: [], errors };

  // Phase 1: 冲突消解
  try {
    const { conflicts } = resolveConflict(memories);
    results.conflicts = conflicts;
  } catch (e) {
    errors.push({ phase: 'conflict', error: e.message });
  }

  // Phase 2: 归档降级提案
  try {
    const archiveDays = opts.archiveDays ?? 30;
    const compressDays = opts.compressDays ?? 90;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    for (const mem of memories) {
      const age = (now - (mem.createdAt ?? mem.created_at ?? mem.ch ?? 0)) / DAY_MS;
      if (age > compressDays) {
        results.archived.push({ id: mem.id, action: 'archive', age: Math.round(age), proposal: true });
      } else if (age > archiveDays) {
        results.archived.push({ id: mem.id, action: 'demote', age: Math.round(age), proposal: true });
      }
    }
  } catch (e) {
    errors.push({ phase: 'archive', error: e.message });
  }

  // Phase 2b: 层级升降提案（支持 v8 范畴规则与热度模型）
  try {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const rows = Array.isArray(opts.tierRows) && opts.tierRows.length ? opts.tierRows : memories;
    for (const row of rows) {
      const id = row?.id;
      if (!id) continue;
      const rawKind = row.kind ?? (row.category ? row.category : 'event');
      const kind = normalizeKind(rawKind);
      const cat = row.category ? normalizeCategory(row.category) : kindToCategory(kind);

      // L0 常驻层（rule / profile / state / person / promise）
      if (cat === 'rule' || cat === 'profile' || cat === 'state' || kind === 'person' || kind === 'promise') {
        const tier = normalizeTier(row.tier, kind);
        if (tier !== MEMORY_TIER_PINNED && Number(row.tier) !== TIER_L0) {
          results.tierWrites.push({
            id,
            kind,
            action: 'pin',
            from: tier,
            to: MEMORY_TIER_PINNED,
            reason: '核心恒温层(L0)常驻不衰减',
          });
        }
        continue;
      }

      const tier = normalizeTier(row.tier, kind);
      const lastAccess = Number.isFinite(row.lastAccessed)
        ? row.lastAccessed
        : Number.isFinite(row.last_accessed_at)
          ? row.last_accessed_at
          : Number.isFinite(row.last_accessed)
            ? row.last_accessed
            : (Number.isFinite(row.createdAt) ? row.createdAt : (Number.isFinite(row.created_at) ? row.created_at : now));
      const accessCount = Number(row.accessCount ?? row.access_count ?? 0) || 0;
      const idleDays = (now - lastAccess) / DAY_MS;

      if (accessCount >= TIER_PROMOTE_ACCESS && tier > MEMORY_TIER_PINNED) {
        results.tierWrites.push({
          id, kind, action: 'promote', from: tier, to: tier - 1, reason: `命中 ${accessCount} 次`,
        });
      } else if (accessCount < TIER_PROMOTE_ACCESS && idleDays > TIER_IDLE_DAYS && tier < MEMORY_TIER_MAX) {
        results.tierWrites.push({
          id,
          kind,
          action: 'demote',
          from: tier,
          to: Math.min(MEMORY_TIER_MAX, tier + 1),
          reason: `距上次命中 ${Math.round(idleDays)} 天`,
        });
      }
    }
  } catch (e) {
    errors.push({ phase: 'tier', error: e.message });
  }

  // Phase 3: 模式发现
  try {
    const llm = typeof opts.llm === 'function' ? opts.llm : null;
    if (llm) {
      const recent = memories
        .slice()
        .sort((a, b) => (b.createdAt ?? b.created_at ?? b.ch ?? 0) - (a.createdAt ?? a.created_at ?? a.ch ?? 0))
        .slice(0, 50);
      const prompt = `从以下记忆中提取模式（重复出现的主题、规律、趋势）：\n${recent.map((m) => m.text).join('\n')}`;
      const response = llm(prompt);
      if (response) results.patterns.push({ type: 'pattern', text: response, evidence: recent.map((m) => m.id) });
    }
  } catch (e) {
    errors.push({ phase: 'pattern', error: e.message });
  }

  // Phase 4: 关系补全
  try {
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

// ── karpathy llm-wiki 编译层：raw 不可变 → wiki 投影 ──────────

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

const REVISION_CUE = /现予更正|予以更正|更正为|更正后|作废|以.{0,8}为准|已撤销|已推翻|原报|原测|原记录|系估值|系估算|系目测|系误记/;
const REVISION_PREFIX_ATTR = /^(原报|原测|原记录|原载|原写|原称|原为|原系|原属)$/;
const DATE_RE = /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/g;
const QUOTED_RE = /「[^」]{2,}」|“[^”]{2,}”|"[^"]{2,}"/g;

function tokensOf(re, text) {
  if (text == null) return [];
  return [...String(text).matchAll(new RegExp(re.source, re.flags))].map((m) => m[0]);
}

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
  for (const k of ['scope', 'space_id', 'agent_scope', 'workspace_scope']) {
    if (mem[k] != null && mem[k] !== '') return String(mem[k]);
  }
  return '';
}

export function rawDigest(memories) {
  const list = (Array.isArray(memories) ? memories : [])
    .map((m) => `${String(m?.id ?? '')}\u0000${String(m?.text ?? '')}`)
    .sort();
  return fnv1a(list.join('\u0001'));
}

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
    const at = Number.isFinite(mem?.createdAt)
      ? mem.createdAt
      : (Number.isFinite(mem?.created_at) ? mem.created_at : (Number.isFinite(mem?.ch) ? mem.ch : 0));
    return { mem, id: String(mem?.id ?? `#${index}`), text, at, scope: scopeKey(mem), facts, order: index };
  });
  list.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id, 'en') || a.order - b.order);
  return list;
}

function adjudicatePair(a, b) {
  const cueA = REVISION_CUE.test(String(a.fact.text ?? ''));
  const cueB = REVISION_CUE.test(String(b.fact.text ?? ''));
  if (cueA !== cueB) return { winner: cueA ? 'a' : 'b', reason: 'revision-cue' };
  if (a.entry.scope !== b.entry.scope) return { winner: null, reason: 'cross-scope' };
  if (a.entry.at !== b.entry.at) return { winner: a.entry.at > b.entry.at ? 'a' : 'b', reason: 'newer' };
  return { winner: null, reason: 'same-time' };
}

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
    return { kind: TRIAGE.DISPUTED, reason: 'undecidable', slot: fact.slot, against: peers[0].entry.id, fact, peer: peers[0].fact };
  }
  return { kind: TRIAGE.NEW, reason: 'new-slot', slot: entry.facts[0].slot, against: null, fact: entry.facts[0] };
}

export function triageMark(triage) {
  const parts = ['triage:v1', triage.kind];
  if (triage.slot) parts.push(`slot=${triage.slot}`);
  if (triage.against) parts.push(`vs=${triage.against}`);
  return parts.join(':');
}

export function parseTriageMark(mark) {
  const m = /^triage:v1:([a-z-]+)/.exec(String(mark ?? ''));
  return m ? m[1] : null;
}

function resolveSlot(items) {
  const values = [...new Set(items.map((i) => i.fact.value))];
  if (values.length < 2) {
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

export function compileWiki(memories, opts = {}) {
  const entries = buildEntries(memories);

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

export function groundingViolations(wiki) {
  const out = [];
  for (const block of wiki?.blocks ?? []) {
    const raw = String(block.raw ?? '');
    const seen = new Set();
    const add = (field, token) => {
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
    supersedes:
      triage.kind === TRIAGE.UPDATE && triage.reason !== 'same-value' && against && opts.linkSupersedes !== false
        ? [against]
        : [],
    facts: entry.facts.length,
  };
}

// ── 召回路径的冲突自述 ──────────────────────────────────────────

function sentOf(text, fact) {
  const start = Number(fact?.sent_off ?? fact?.at ?? 0);
  const len = Number(fact?.sent_len ?? 0);
  if (!Number.isFinite(start) || start < 0 || start >= text.length) return '';
  return text.slice(start, start + (len > 0 ? len : 40));
}

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
    if (!cued.length) continue;
    const revised = cued
      .slice()
      .sort((a, b) => b.chapter - a.chapter || b.at - a.at)[0].value;
    const ordered = [...new Set(items.slice().sort((a, b) => a.chapter - b.chapter || a.at - b.at).map((i) => i.value))];
    out.push({
      attr,
      values: ordered,
      revised,
      line: `[冲突] 材料里「${attr}」有 ${ordered.length} 个取值（${ordered.join('、')}），两处记录不一致，后文以${revised}为准。`,
      evidence: items.map((i) => ({ id: i.entryId, chapter: i.chapter, value: i.value })),
    });
  }
  out.sort((a, b) => b.values.length - a.values.length || a.attr.localeCompare(b.attr, 'en'));
  return out.slice(0, limit);
}
