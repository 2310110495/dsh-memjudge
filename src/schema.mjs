// memjudge 记忆条目 schema —— 全项目唯一真源（Schema v8 + v1 兼容契约）。
//
// 核心约束：
//   1. 时间一律 epoch 毫秒。假时钟直接替换 Date，避免时区折算偏差。
//   2. 五类法定记忆（v2）：rule / profile / decision / experience / state，
//      双向兼容旧三分 kind（person / promise / event）。
//   3. 原文哈希统一采用 UTF-8 SHA-256 64 位小写 hex（contentHash）。
//   4. 保留 assertTextStable 供存量不可变路径调用；单活状态覆写与代谢压缩走 store 事务修订链。

import { createHash } from 'node:crypto';

export const MEMORY_SCHEMA_VERSION = 1;
export const STORE_SCHEMA_VERSION = 8;

// 语料章数。source.chapter 的合法上界，与评测语料 chapters 长度一致。
export const CHAPTER_COUNT = 20;

// 法定五类记忆体系（v2）与旧三分（v1/v6）双向兼容枚举
export const MEMORY_CATEGORIES = Object.freeze([
  'rule',
  'profile',
  'decision',
  'experience',
  'state',
]);
export const DEFAULT_MEMORY_CATEGORY = 'experience';

export const MEMORY_KINDS = Object.freeze(['person', 'promise', 'event']);
export const DEFAULT_MEMORY_KIND = 'event';

export const MEMORY_STATUSES = Object.freeze(['active', 'superseded', 'archived', 'deleted']);
export const SPACE_KINDS = Object.freeze(['global', 'workspace', 'session', 'custom']);

// L0–L3 四级热冷代谢层常量
export const TIER_L0 = 0;
export const TIER_L1 = 1;
export const TIER_L2 = 2;
export const TIER_L3 = 3;

// 衰减参数：唯一实现，能力 11/12 的验收直接引用这里的输出。
// warm（importance ≥ 0.6）：半衰期 120 天；cold（importance < 0.6）：半衰期 12 天。
export const DECAY = Object.freeze({
  dayMs: 86_400_000,
  warmImportance: 0.6,
  hlWarm: 120,
  hlCold: 12,
  retainThreshold: 0.15,
});

export class MemorySchemaError extends Error {
  constructor(field, detail) {
    super(`memory schema: ${field} — ${detail}`);
    this.name = 'MemorySchemaError';
    this.field = field;
  }
}

export const TYPES = Object.freeze({
  memory: 'memory',
  KINDS: Object.freeze(['fact', 'event', 'conclusion', 'procedure']),
  CATEGORIES: MEMORY_CATEGORIES,
  FIELDS: Object.freeze({
    id: 'string',
    text: 'string',
    kind: 'enum:fact|event|conclusion|procedure',
    category: 'enum:rule|profile|decision|experience|state?',
    spaceId: 'string?',
    slotKey: 'string|null?',
    status: 'enum:active|superseded|archived|deleted?',
    contentHash: 'sha256_hex?',
    tier: 'integer?',
    createdAt: 'epoch_ms',
    updatedAt: 'epoch_ms?',
    lastAccessed: 'epoch_ms',
    accessCount: 'integer>=0',
    importance: 'number0..1',
    supersedes: 'string[]',
    supersededBy: 'string|null',
    facts: 'fact[]',
    source: 'source',
    meta: 'object?',
  }),
  REQUIRED: Object.freeze([
    'id',
    'text',
    'createdAt',
    'lastAccessed',
    'accessCount',
    'importance',
    'supersedes',
    'facts',
    'source',
  ]),
  FACT: Object.freeze({
    entity: 'string',
    attribute: 'string',
    value: 'string|number',
    unit: 'string?',
    quote: 'string?(必须是 text 的逐字子串)',
    at: 'epoch_ms?',
  }),
  SOURCE: Object.freeze({
    chapter: `integer 1..${CHAPTER_COUNT}`,
    para: 'integer>=1（章内第几段，1 起算）',
  }),
});

const MAX_TEXT = 20000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,120}$/;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isInt(v) {
  return Number.isInteger(v);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 统一正文内容哈希：UTF-8 SHA-256 64 位小写十六进制。 */
export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * 旧 kind -> 新五类 category：
 *   promise -> rule
 *   person  -> profile
 *   event / 其他 -> experience（若本身已是五类之一则原样返回）
 */
export function kindToCategory(kind) {
  const v = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  if (MEMORY_CATEGORIES.includes(v)) return v;
  if (v === 'promise') return 'rule';
  if (v === 'person') return 'profile';
  return DEFAULT_MEMORY_CATEGORY;
}

/**
 * 新五类 category -> 旧三分 kind：
 *   rule    -> promise
 *   profile -> person
 *   其余    -> event（若本身已是旧三分之一则原样返回）
 */
export function categoryToKind(category) {
  const v = typeof category === 'string' ? category.trim().toLowerCase() : '';
  if (MEMORY_KINDS.includes(v)) return v;
  if (v === 'rule') return 'promise';
  if (v === 'profile') return 'person';
  return DEFAULT_MEMORY_KIND;
}

/** 归一化五类 category：支持直接传五类或旧 person/promise/event 别名，非法归 experience。 */
export function normalizeCategory(category, fallbackKind) {
  const c = typeof category === 'string' ? category.trim().toLowerCase() : '';
  if (MEMORY_CATEGORIES.includes(c)) return c;
  if (c === 'promise' || c === 'person' || c === 'event') return kindToCategory(c);
  if (fallbackKind !== undefined && fallbackKind !== null && fallbackKind !== '') {
    return kindToCategory(fallbackKind);
  }
  return DEFAULT_MEMORY_CATEGORY;
}

/** 五类 category 的默认热冷层级：rule/profile/state 驻 L0(0)，decision/experience 驻 L1(1)。 */
export function defaultCategoryTier(category) {
  const c = normalizeCategory(category);
  if (c === 'rule' || c === 'profile' || c === 'state') return TIER_L0;
  return TIER_L1;
}

/** 判定记忆是否处于钉住常驻态（兼容 v8 tier=0 与 v7 tier=1 / rule / profile）。 */
export function isPinnedMemory(memOrTier, categoryOrKind) {
  if (isPlainObject(memOrTier)) {
    const t = Number(memOrTier.tier);
    const cat = normalizeCategory(memOrTier.category, memOrTier.kind);
    return t === 0 || t === 1 || cat === 'rule' || cat === 'profile';
  }
  const t = Number(memOrTier);
  const cat = normalizeCategory(categoryOrKind);
  return t === 0 || t === 1 || cat === 'rule' || cat === 'profile';
}

// 确定性 id：同一章同一段同一句永远得到同一个 id，重放与去重都靠它。
export function makeId(chapter, para, text) {
  const ch = String(chapter ?? 0).padStart(2, '0');
  const p = String(para ?? 0).padStart(3, '0');
  return `mem-c${ch}-p${p}-${fnv1a(String(text ?? ''))}`;
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// 建条目：补默认值 → 校验 → 深冻结。
export function createMemory(input = {}) {
  if (!isPlainObject(input)) throw new MemorySchemaError('input', '必须是对象');
  const src = isPlainObject(input.source) ? input.source : {};
  const now = input.createdAt ?? Date.now();
  const draft = {
    id: input.id ?? makeId(src.chapter, src.para, input.text),
    text: input.text ?? '',
    kind: input.kind ?? 'fact',
    createdAt: now,
    lastAccessed: input.lastAccessed ?? now,
    accessCount: input.accessCount ?? 0,
    importance: input.importance ?? 0.5,
    supersedes: input.supersedes ?? [],
    supersededBy: input.supersededBy ?? null,
    facts: input.facts ?? [],
    source: { chapter: src.chapter, para: src.para },
  };
  if (input.category !== undefined) draft.category = normalizeCategory(input.category, input.kind);
  if (input.spaceId !== undefined) draft.spaceId = String(input.spaceId);
  if (input.slotKey !== undefined) draft.slotKey = input.slotKey == null ? null : String(input.slotKey);
  if (input.status !== undefined) draft.status = String(input.status);
  if (input.contentHash !== undefined) draft.contentHash = String(input.contentHash);
  if (input.tier !== undefined) draft.tier = Number(input.tier);
  if (input.updatedAt !== undefined) draft.updatedAt = Number(input.updatedAt);
  if (input.meta !== undefined) draft.meta = input.meta;
  validateMemory(draft);
  return deepFreeze(draft);
}

// 校验。默认只查契约字段；opts.strict 时连未知顶层键也报错（用于防字段漂移）。
export function validateMemory(mem, opts = {}) {
  if (!isPlainObject(mem)) throw new MemorySchemaError('memory', '必须是对象');

  for (const f of TYPES.REQUIRED) {
    if (!(f in mem) || mem[f] === undefined) throw new MemorySchemaError(f, '缺失（必填字段）');
  }

  if (typeof mem.id !== 'string' || !mem.id) throw new MemorySchemaError('id', '必须是非空字符串');
  if (!ID_RE.test(mem.id)) throw new MemorySchemaError('id', '只允许字母数字与 . _ : -，长度 3..121');
  if (mem.kind !== undefined && !TYPES.KINDS.includes(mem.kind) && !MEMORY_KINDS.includes(mem.kind)) {
    throw new MemorySchemaError('kind', `必须是 ${TYPES.KINDS.join('|')}`);
  }
  if (mem.category !== undefined && !MEMORY_CATEGORIES.includes(mem.category)) {
    throw new MemorySchemaError('category', `必须是 ${MEMORY_CATEGORIES.join('|')}`);
  }
  if (mem.status !== undefined && !MEMORY_STATUSES.includes(mem.status)) {
    throw new MemorySchemaError('status', `必须是 ${MEMORY_STATUSES.join('|')}`);
  }

  if (typeof mem.text !== 'string') throw new MemorySchemaError('text', '必须是字符串（原文）');
  if (!mem.text.trim()) throw new MemorySchemaError('text', '不得为空');
  if (mem.text.length > MAX_TEXT) throw new MemorySchemaError('text', `超过 ${MAX_TEXT} 字符上限`);
  if (mem.text.includes('\u0000')) throw new MemorySchemaError('text', '不得包含 NUL');

  for (const f of ['createdAt', 'lastAccessed']) {
    if (!Number.isFinite(mem[f]) || mem[f] <= 0) throw new MemorySchemaError(f, '必须是正的 epoch 毫秒数');
  }
  if (mem.createdAt > mem.lastAccessed) throw new MemorySchemaError('lastAccessed', '不得早于 createdAt');

  if (!isInt(mem.accessCount) || mem.accessCount < 0) throw new MemorySchemaError('accessCount', '必须是非负整数');
  if (!Number.isFinite(mem.importance) || mem.importance < 0 || mem.importance > 1) {
    throw new MemorySchemaError('importance', '必须在 0..1 之间');
  }

  if (!Array.isArray(mem.supersedes)) throw new MemorySchemaError('supersedes', '必须是数组（被本条取代的旧条目 id）');
  const seen = new Set();
  for (const [i, sid] of mem.supersedes.entries()) {
    if (typeof sid !== 'string' || !sid) throw new MemorySchemaError(`supersedes[${i}]`, '必须是非空字符串');
    if (sid === mem.id) throw new MemorySchemaError(`supersedes[${i}]`, '不得指向自身');
    if (seen.has(sid)) throw new MemorySchemaError(`supersedes[${i}]`, '重复项');
    seen.add(sid);
  }
  if (mem.supersededBy !== undefined && mem.supersededBy !== null) {
    if (typeof mem.supersededBy !== 'string' || !mem.supersededBy) {
      throw new MemorySchemaError('supersededBy', '必须是字符串或 null');
    }
    if (mem.supersededBy === mem.id) throw new MemorySchemaError('supersededBy', '不得指向自身');
  }

  if (!Array.isArray(mem.facts)) throw new MemorySchemaError('facts', '必须是数组（写入时抽取的三元组）');
  for (const [i, fact] of mem.facts.entries()) {
    if (!isPlainObject(fact)) throw new MemorySchemaError(`facts[${i}]`, '必须是对象');
    for (const k of ['entity', 'attribute', 'value']) {
      if (fact[k] === undefined || fact[k] === null || fact[k] === '') {
        throw new MemorySchemaError(`facts[${i}].${k}`, '缺失');
      }
    }
    if (typeof fact.entity !== 'string') throw new MemorySchemaError(`facts[${i}].entity`, '必须是字符串');
    if (typeof fact.attribute !== 'string') throw new MemorySchemaError(`facts[${i}].attribute`, '必须是字符串');
    if (typeof fact.value !== 'string' && !Number.isFinite(fact.value)) {
      throw new MemorySchemaError(`facts[${i}].value`, '必须是字符串或数字');
    }
    if (fact.unit !== undefined && typeof fact.unit !== 'string') {
      throw new MemorySchemaError(`facts[${i}].unit`, '必须是字符串');
    }
    if (fact.at !== undefined && !Number.isFinite(fact.at)) {
      throw new MemorySchemaError(`facts[${i}].at`, '必须是 epoch 毫秒数');
    }
    if (fact.quote !== undefined) {
      if (typeof fact.quote !== 'string') throw new MemorySchemaError(`facts[${i}].quote`, '必须是字符串');
      if (fact.quote && !mem.text.includes(fact.quote)) {
        throw new MemorySchemaError(`facts[${i}].quote`, '必须是该条目 text 的逐字子串');
      }
    }
  }

  if (!isPlainObject(mem.source)) throw new MemorySchemaError('source', '必须是对象 {chapter, para}');
  if (!isInt(mem.source.chapter) || mem.source.chapter < 1 || mem.source.chapter > CHAPTER_COUNT) {
    throw new MemorySchemaError('source.chapter', `必须是 1..${CHAPTER_COUNT} 的整数`);
  }
  if (!isInt(mem.source.para) || mem.source.para < 1) {
    throw new MemorySchemaError('source.para', '必须是 ≥1 的整数（章内段号，1 起算）');
  }

  if (opts.strict) {
    const allowed = new Set([...Object.keys(TYPES.FIELDS)]);
    for (const k of Object.keys(mem)) {
      if (!allowed.has(k)) throw new MemorySchemaError(k, '未知字段（strict 模式）');
    }
  }
  return true;
}

// 保留函数签名以兼容存量不可变校验单测；v2 单活状态与代谢压缩请走 store.putState / store.compactMemory。
export function assertTextStable(prevText, nextText) {
  if (String(prevText) !== String(nextText)) {
    throw new MemorySchemaError(
      'text',
      '原文不可改写；请新建条目并以 supersedes 指向旧条目（旧条目只回填 supersededBy）',
    );
  }
  return true;
}

// 时间强度：0.5^(age/HL)。HL 由 importance 分档，写入时固化。
export function decayFactor(mem, nowMs = Date.now(), opts = {}) {
  const { dayMs, hlWarm, hlCold, warmImportance } = { ...DECAY, ...opts };
  const importance = Number(mem?.importance ?? 0.5);
  const tier = importance >= warmImportance ? 'warm' : 'cold';
  const halfLifeDays = tier === 'warm' ? hlWarm : hlCold;
  const last = Number(mem?.lastAccessed ?? mem?.last_accessed_at ?? mem?.last_accessed ?? nowMs);
  const ageDays = Math.max(0, (Number(nowMs) - last) / dayMs);
  return {
    value: Number(Math.pow(0.5, ageDays / halfLifeDays).toFixed(6)),
    ageDays: Number(ageDays.toFixed(3)),
    halfLifeDays,
    tier,
  };
}

// 排序权重：时间强度 × 重要度 × 访问惯量 × 被取代惩罚。
export function rankWeight(mem, nowMs = Date.now(), opts = {}) {
  const d = decayFactor(mem, nowMs, opts);
  const importance = Math.min(1, Math.max(0, Number(mem?.importance ?? 0.5)));
  const accessCount = Math.max(0, Number(mem?.accessCount ?? mem?.access_count ?? 0));
  const importanceFactor = 0.5 + 0.5 * importance;
  const accessFactor = 1 + 0.1 * Math.log1p(accessCount);
  const superseded = mem?.supersededBy ?? mem?.superseded_by;
  const supersededPenalty = superseded ? 0.3 : 1;
  return {
    ...d,
    weight: Number((d.value * importanceFactor * accessFactor * supersededPenalty).toFixed(6)),
    importanceFactor: Number(importanceFactor.toFixed(4)),
    accessFactor: Number(accessFactor.toFixed(4)),
    supersededPenalty,
  };
}
