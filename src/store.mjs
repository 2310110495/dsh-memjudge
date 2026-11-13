// memjudge 存储层（Schema v8）：node:sqlite 八表正交存储引擎 + v7 无损原子迁移 + 100% 存量 API 兼容层。
//
// 核心架构（对照《memjudge-v2-架构与实施计划书》）：
//   1. 八张正交核心表：spaces, memories, memory_revisions, entity_slots, vectors,
//      wiki_pages, ingest_queue, meta（彻底废除 segments / vector_blob / memory_occurrences 落盘冗余表）。
//   2. 并发与完整性：开启 WAL（:memory: 自动跳过）+ synchronous=NORMAL + foreign_keys=ON + busy_timeout=5000。
//   3. 五类法定记忆（rule / profile / decision / experience / state）与旧三分（person / promise / event）双向无损映射。
//   4. 单活状态槽位（idx_memories_active_slot 部分唯一索引）+ 原地覆写自动归档修订链（memory_revisions）。
//   5. 向量显式主键绑定（vectors.memory_id + space_id + content_hash + ON DELETE CASCADE），根除 VACUUM rowid 漂移。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  STORE_SCHEMA_VERSION as SCHEMA_V8,
  MEMORY_CATEGORIES,
  DEFAULT_MEMORY_CATEGORY,
  MEMORY_KINDS,
  DEFAULT_MEMORY_KIND,
  MEMORY_STATUSES,
  TIER_L0,
  TIER_L1,
  TIER_L2,
  TIER_L3,
  makeId,
  contentHash,
  kindToCategory,
  categoryToKind,
  normalizeCategory,
  defaultCategoryTier,
  isPinnedMemory,
} from './schema.mjs';
import { extractL1 } from './extract.mjs';
import { hasUnpairedSurrogate } from './text-wellformed.mjs';
import { quantizeWithScale, asSignedVec, cosineInt8, DEFAULT_SCALE } from './vector.mjs';

export const STORE_SCHEMA_VERSION = SCHEMA_V8;
export {
  MEMORY_CATEGORIES,
  DEFAULT_MEMORY_CATEGORY,
  MEMORY_KINDS,
  DEFAULT_MEMORY_KIND,
  MEMORY_STATUSES,
  TIER_L0,
  TIER_L1,
  TIER_L2,
  TIER_L3,
  contentHash,
  kindToCategory,
  categoryToKind,
  normalizeCategory,
  defaultCategoryTier,
  isPinnedMemory,
};

/**
 * 旧 kind 归一化：支持直接传 person/promise/event，也兼容传入五类 category 自动转旧视图。
 * 非法值一律归 'event'，绝不因标签脏值丢失记忆。
 */
export function normalizeKind(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (MEMORY_KINDS.includes(v)) return v;
  if (MEMORY_CATEGORIES.includes(v)) return categoryToKind(v);
  return DEFAULT_MEMORY_KIND;
}

// ── 存量层级常量与兼容函数（供尚未升级的 layer.mjs / nightly.mjs / 存量单测无缝调用） ──
export const MEMORY_TIER_PINNED = 1;
export const MEMORY_TIER_EVENT = 3;
export const MEMORY_TIER_MIN = 1;
export const MEMORY_TIER_MAX = 5;

export const TIER_IDLE_DAYS = 30;
export const TIER_PROMOTE_ACCESS = 5;

/** 旧 kind → 默认 tier（兼容层口径：person/promise→1，event→3）。 */
export function defaultTier(kind) {
  const k = normalizeKind(kind);
  return k === 'person' || k === 'promise' ? MEMORY_TIER_PINNED : MEMORY_TIER_EVENT;
}

/**
 * 旧 tier 归一化兼容函数：
 *   - 若记忆为 person/promise（或 v8 tier === 0 钉住层），统一识别为 MEMORY_TIER_PINNED (1)；
 *   - 其余钳到 1..5。
 */
export function normalizeTier(value, kind) {
  const k = normalizeKind(kind);
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultTier(k);
  if (k === 'person' || k === 'promise' || Math.trunc(n) === 0) return MEMORY_TIER_PINNED;
  return Math.min(MEMORY_TIER_MAX, Math.max(MEMORY_TIER_MIN, Math.trunc(n)));
}

const pinTierWarned = new Set();
function warnPinnedTierClamp(kind, tier) {
  const key = `${kind}:${String(tier)}`;
  if (pinTierWarned.has(key)) return;
  pinTierWarned.add(key);
  console.warn(
    `[memjudge] store.put: kind=${kind} 必须是 tier ${MEMORY_TIER_PINNED}（钉住），`
    + `收到 tier=${String(tier)} 已钳回 ${MEMORY_TIER_PINNED}——身份与约定不允许进入淘汰区`,
  );
}

export function resetPinTierWarnings() {
  pinTierWarned.clear();
}

export function escapeLikePattern(value) {
  return String(value ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function clampQueryLimit(limit, fallback = 50, max = 10000) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(n)));
}

/** 默认物理存储容量上限升至 10 MB；调用方传自定义 limitBytes/storageLimitBytes 时严格按传入值校验。 */
export const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024;

// ── 字符预算硬闸门（memento 兼容契约） ─────────────────────────────────────

export function entryUsage(rows) {
  let sum = 0;
  for (const row of rows ?? []) sum += String(row?.text ?? '').length;
  return sum;
}

export function checkBudget(used, limit, addition) {
  if (!Number.isFinite(limit) || limit <= 0) return { ok: true };
  if (used + addition <= limit) return { ok: true };
  return { ok: false, used, limit, needed: used + addition - limit };
}

export class BudgetExceededError extends Error {
  constructor({ used, limit, needed }) {
    super(`写入超出预算：已用 ${used} 字符 + 本条需要 ${needed} 字符 > 上限 ${limit} 字符`);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.details = { used, limit, needed };
  }
}

// ── 机械切段（retcon 纯函数兼容导出） ──────────────────────────────────────

export const SPLIT_RE = /[，。！？；：\n、]+|——|--/;

export function splitSegments(text) {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .flatMap((block) => splitBlock(block));
}

function splitBlock(block) {
  const parts = String(block)
    .split(SPLIT_RE)
    .map((p) => p.trim())
    .filter(Boolean);
  const segs = [];
  for (const part of parts) {
    const chCount = (part.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (chCount < 2 && segs.length) {
      segs[segs.length - 1] = `${segs[segs.length - 1]} ${part}`;
    } else {
      segs.push(part);
    }
  }
  return segs;
}

function hashSegment(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ── 通用结构化事实抽取（按原有规则精准回溯原文） ──────────────────────────

const NUM = '(?:[零一二三四五六七八九十百千万两]+(?:点[零一二三四五六七八九]+)?|\\d+(?:\\.\\d+)?)';
// 单位按长度降序，长单位先试，避免「平方米」被「米」截走。
const UNITS = [
  '平方米', '平方公里', '海里', '公里', '厘米', '毫米', '分钟', '小时',
  '美元', '万元', '吨', '度', '米', '节', '年', '岁', '天', '秒',
  '件', '人', '项', '处', '次', '份', '层', '台', '根', '条', '元',
];
const VALUE_RE = new RegExp(`(${NUM})\\s*(${UNITS.join('|')})`, 'g');

// 属性块尾部要剥的虚词/动词。「实测/目测/估值」必须在表里，否则
// ch15「凹陷实测深度为十一厘米」与 ch5「凹陷深度约九厘米」会分不到同一 key。
const TAIL_STRIP = /(采用|记录|实测|目测|估值|记作|写作|认定|认为|估计|大约|至少|超过|不足|达到|还有|约|为|是|达|有|共|计|在|到|以|上|下|中|内|外|前|后|系|即|均|已|仅|只|该|此|其|本|各|之|于|的)+$/;
const HEAD_STRIP = /^(报告|材料|照片|数据显示|据|按|经|由|将|把|被|让|对|向|从|和|与|及|或|而|又|也|就|都|还|只|仅|已|曾|正|在|该|此|其|本|各|均|约|为|是|达|有|共|计|于)+/;

// 名字禁用字：ROLES 后面跟的不一定都是人名，「船长通过甚高频电台」会被
// 抽成「通过甚」。姓氏表挡不住，这里再用名字部分的高频动词/虚词挡一层。
const NAME_STOP = new Set('过甚知常讯报道说问话信行用事情定在有的是的活和与及把将对从向为被让给替由就都还只又也才正已曾并且或但而则因所以到至自同跟吃喝看听走跑坐站拿放开上下进出回来去'.split(''));
// 人名尾字的边界：落在这些字上说明名字只有 2 字，第 3 字属于句子
const EDGE_CHARS = new Set('的在与和及把将对从向为被让给替由就都还只又也才正已曾并且或但而则所以到至自同跟进出来去说问答'.split(''));

// 剥完仍是动词短语的属性块说明窗口里没有真正的名词核心，丢弃比编造好。
const ATTR_REJECT = new Set([
  '采用', '记录', '实测', '目测', '认定', '估计', '认为', '大约', '至少',
  '超过', '不足', '达到', '记作', '写作', '还有', '以上', '以下', '之间', '左右',
  '最后', '发现', '一次', '目前', '当时', '现在', '后来', '首先', '其次',
  '其中', '其他', '中间', '之后', '以前', '共计', '约有', '至少', '最多',
]);
// 「十海里以东 / 三米以内」这类是方位短语，不是「某物的某属性」
const ATTR_DIRECTION = /^[东西南北方位前后]?(?:以东|以西|以南|以北|以上|以下|以内|以外|之后|之前|左右)$/;

// 通用机构后缀构词（零特定行业专有词硬编码）
const ORG_TAIL = /([\u4e00-\u9fff]{2,8}(?:委员会|研究院|设计院|研究所|实验室|事务所|调查组|工作组|保险公司|保险公估|公估|协会|学会|法庭|法院|有限公司|公司|总局|分局|局|社|厂))(?![\u4e00-\u9fff])/g;
const NAMED_OBJ = /([\u4e00-\u9fff]{2,5}号)/g;

// 姓氏白名单是过滤「证书 / 收据 / 要去机」这类非人名的可靠手段
const SURNAME = '赵钱孙李周吴郑王冯陈蒋沈韩杨朱许何吕张孔曹严金魏陶姜谢邹苏潘葛范彭鲁韦马方俞任袁柳史唐薛雷贺倪汤罗毕郝安常傅余顾孟黄萧姚邵汪毛戴宋庞熊纪舒屈项董梁杜阮蓝季贾江郭林钟徐邱骆高夏蔡田樊胡凌霍万卢莫房解应丁邓郁单洪包左石崔龚程邢陆荣翁荀曲封靳段富焦侯全班秋仲伊宫宁武刘景詹龙叶黎白怀蒲鄂索赖卓屠蒙池乔翟谭劳姬申冉雍桑桂牛通边燕尚农温庄晏柴瞿阎慕连茹艾容向古易廖居衡步都耿满匡国文寇广禄东欧沃利越隆师巩聂晁融冷辛简饶曾沙鞠丰巢关查荆红游权盖益桓公哈';

// 通用中文职务后缀构词（零特定行业专有词硬编码）：修饰词素 + 中心词尾 + 姓氏人名
const TITLE_STOP_PREFIX = /^(?:与|和|及|在|于|由|向|对|把|将|被|让|跟|同|开展|带领|通知|联系|配合|陪同|干部)/;
const ROLE_RE = new RegExp(
  `((?:[一二三四五总正副大值班首席执行助理见习][\\u4e00-\\u9fff]{0,2}|[\\u4e00-\\u9fff]{1,2})(?:代表|主任|经理|总监|委员|顾问|专家|主管|专员|长|副|师|员|人|手|匠|厨))([${SURNAME}][\\u4e00-\\u9fff]{1,2})`,
  'g',
);
const ID_RE = /\b[A-Z]{2,5}(?:-[A-Z]{1,5})?-\d{4,6}(?:-[A-Z0-9]{2,8})+\b/g;
const COORD_RE = /([东西南北])([经纬])([零一二三四五六七八九十百千两]+度[零一二三四五六七八九十点两]+分)/g;

function stripAttr(raw) {
  let s = raw;
  for (let i = 0; i < 6; i += 1) {
    let t = s.replace(TAIL_STRIP, '');
    const head = t.replace(HEAD_STRIP, '');
    if (head.length >= 2) t = head;
    if (t === s) break;
    s = t;
  }
  return s;
}

// 属性 = 值前面紧邻的名词块。回看 26 字，只取末尾连续汉字，
// 逗号/顿号天然断句，所以「凹陷，凹陷深度约」只会拿到「凹陷深度约」。
function attributeBefore(text, idx) {
  const win = text.slice(Math.max(0, idx - 26), idx);
  const m = win.match(/[\u4e00-\u9fff]{2,26}$/);
  if (!m) return null;
  const attr = stripAttr(m[0]);
  if (attr.length < 2) return null;
  if (ATTR_REJECT.has(attr)) return null;
  if (/^[\d零一二三四五六七八九十百千万两]+$/.test(attr)) return null;
  // 「做了十次 / 用了八小时 / 发现一处」剥完剩下的是动词短语，不是属性
  if (/[了过着]$/.test(attr)) return null;
  // 序数块（「后第一次」「第二次」）不是属性
  if (attr.includes('第')) return null;
  if (ATTR_DIRECTION.test(attr)) return null;
  return attr;
}

  function entityBefore(text, idx) {
    const win = text.slice(Math.max(0, idx - 60), idx);
    const orgs = [...win.matchAll(ORG_TAIL)];
    if (orgs.length) return orgs[orgs.length - 1][1];
    const named = [...win.matchAll(NAMED_OBJ)];
    if (named.length) return named[named.length - 1][1];
    return null;
  }

/**
 * 从一段文本抽「实体 + 属性 + 值 + 单位」四元组。
 *
 * 四类来源，kind 区分：
 *   value 数字+单位（含坐标里被拆出来的数字，坐标本身另行用 coord 覆盖）
 *   role  职务+人名，无单位事实（「船长周允棠」这类）
 *   id    官方编号（OTS-230323-04 / BTM-2023-0417）
 *   coord 经纬度整串
 *
 * 属性归一化 key 取 attr 末 2 字：这是让 ch5「凹陷深度」与 ch15「凹陷实测深度」
 * 落到同一组、进而被冲突检测看见的唯一办法。
 */
export function extractFacts(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const seen = new Set();
  const push = (f) => {
    const sig = `${f.kind}|${f.entity ?? ''}|${f.attr}|${f.value}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push(f);
  };

  // 坐标先登记，占住区间，避免「四度十二点六分」被当成长度
  const coordSpans = [];
  COORD_RE.lastIndex = 0;
  let cm;
  while ((cm = COORD_RE.exec(text)) !== null) {
    if (!(cm[2] === '纬' ? '南北' : '东西').includes(cm[1])) continue;
    const attr = `${cm[2]}度`;
    push({
      entity: entityBefore(text, cm.index),
      attr,
      key: attr.slice(-2),
      value: cm[3],
      unit: null,
      kind: 'coord',
      at: cm.index,
    });
    coordSpans.push([cm.index, cm.index + cm[0].length]);
  }
  const inCoord = (i) => coordSpans.some(([a, b]) => i >= a && i < b);

  VALUE_RE.lastIndex = 0;
  let m;
  while ((m = VALUE_RE.exec(text)) !== null) {
    if (inCoord(m.index)) continue;
    const attr = attributeBefore(text, m.index);
    if (!attr) continue;
    push({
      entity: entityBefore(text, m.index),
      attr,
      key: attr.slice(-2),
      value: m[1],
      unit: m[2],
      kind: 'value',
      at: m.index,
    });
  }

  ROLE_RE.lastIndex = 0;
  let rm;
  while ((rm = ROLE_RE.exec(text)) !== null) {
    let who = rm[2];
    // 抽出来的三字名字若尾字落在句中虚词边界，退回二字姓名
    if (who.length === 3 && EDGE_CHARS.has(who[2])) who = who.slice(0, 2);
    // 「船长证书」「大副收据」靠姓氏表挡；「船长通过甚高频」靠名字禁用字挡
    if (who.length < 2 || who.startsWith('老')) continue;
    if ([...who.slice(1)].some((ch) => NAME_STOP.has(ch))) continue;
    push({
      entity: who,
      attr: '职务',
      key: '职务',
      value: rm[1],
      unit: null,
      kind: 'role',
      at: rm.index,
    });
  }

  ID_RE.lastIndex = 0;
  let im;
  while ((im = ID_RE.exec(text)) !== null) {
    push({
      entity: entityBefore(text, im.index),
      attr: '编号',
      key: '编号',
      value: im[0],
      unit: null,
      kind: 'id',
      at: im.index,
    });
  }

  return out.sort((a, b) => a.at - b.at);
}

// ── 兼容覆盖位图工具（仅驻连接级 TEMP 表供旧段接口查询，零磁盘页占用） ────

const BITS_MAX_SEGMENTS = 0xffff;

function packCovered(n, covered) {
  if (!Number.isInteger(n) || n < 0 || n > BITS_MAX_SEGMENTS) {
    throw new RangeError(`segments: 段数越界（${n}）`);
  }
  const buf = new Uint8Array(2 + Math.ceil(n / 8));
  buf[0] = (n >> 8) & 0xff;
  buf[1] = n & 0xff;
  if (covered) {
    for (let i = 0; i < n; i += 1) if (covered[i] === '1') buf[2 + (i >> 3)] |= 1 << (i & 7);
  }
  return buf;
}

function packAllCovered(n) {
  const buf = packCovered(n);
  const full = Math.floor(n / 8);
  for (let i = 0; i < full; i += 1) buf[2 + i] = 0xff;
  for (let i = full * 8; i < n; i += 1) buf[2 + (i >> 3)] |= 1 << (i & 7);
  return buf;
}

const asBytes = (v) => (v == null ? new Uint8Array(0) : v instanceof Uint8Array ? v : new Uint8Array(v));

function bitsCount(blob) {
  const b = asBytes(blob);
  if (b.length < 2) return 0;
  return (b[0] << 8) | b[1];
}

function bitAt(blob, i) {
  const b = asBytes(blob);
  const byte = 2 + (i >> 3);
  if (byte >= b.length) return 0;
  return (b[byte] >> (i & 7)) & 1;
}

// ── Schema v8 八张正交核心表 DDL ───────────────────────────────────────────

const SCHEMA_V8_DDL = `
CREATE TABLE IF NOT EXISTS main.spaces (
  space_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  root_path TEXT,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS main.memories (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL DEFAULT 'global',
  category TEXT NOT NULL DEFAULT 'experience',
  tier INTEGER NOT NULL DEFAULT 1,
  slot_key TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  supersedes_json TEXT NOT NULL DEFAULT '[]',
  facts_json TEXT NOT NULL DEFAULT '[]',
  chapter INTEGER NOT NULL DEFAULT 0,
  para INTEGER NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS main.idx_memories_space_status_cat
  ON memories(space_id, status, category, tier);
CREATE INDEX IF NOT EXISTS main.idx_memories_updated
  ON memories(space_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS main.idx_memories_active_slot
  ON memories(space_id, slot_key) WHERE status = 'active' AND slot_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS main.idx_memories_space_hash
  ON memories(space_id, content_hash);

CREATE TABLE IF NOT EXISTS main.memory_revisions (
  rev_id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  slot_key TEXT,
  prev_text TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  reason TEXT,
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS main.idx_revisions_mem
  ON memory_revisions(memory_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS main.entity_slots (
  slot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  attr TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  polarity INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.8,
  quote TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS main.idx_slots_lookup
  ON entity_slots(space_id, entity, attr);
CREATE INDEX IF NOT EXISTS main.idx_slots_entity
  ON entity_slots(entity, attr);
CREATE INDEX IF NOT EXISTS main.idx_slots_mem
  ON entity_slots(memory_id);

CREATE TABLE IF NOT EXISTS main.vectors (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'default',
  dims INTEGER NOT NULL,
  scale REAL NOT NULL,
  vec BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS main.idx_vectors_space
  ON vectors(space_id);

CREATE TABLE IF NOT EXISTS main.wiki_pages (
  page_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  dirty INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  UNIQUE(space_id, slug)
);

CREATE TABLE IF NOT EXISTS main.ingest_queue (
  job_id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_no INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, turn_no)
);
CREATE INDEX IF NOT EXISTS main.idx_ingest_status
  ON ingest_queue(status, created_at ASC);

CREATE TABLE IF NOT EXISTS main.meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// 连接级 TEMP 兼容层：让尚未升级的外部脚本/存量测试执行 `SELECT v FROM meta WHERE k = ?`
// 或 `PRAGMA table_info(segments)` 时零报错，同时保证磁盘物理库 main 100% 只有 Schema v8 八张纯净核心表。
const TEMP_COMPAT_DDL = `
CREATE TEMP VIEW IF NOT EXISTS meta AS
  SELECT key, value, key AS k, value AS v FROM main.meta;

CREATE TEMP TRIGGER IF NOT EXISTS tr_temp_meta_ins
INSTEAD OF INSERT ON temp.meta
BEGIN
  INSERT OR REPLACE INTO main.meta(key, value)
  VALUES (COALESCE(NEW.key, NEW.k), COALESCE(NEW.value, NEW.v));
END;

CREATE TEMP TRIGGER IF NOT EXISTS tr_temp_meta_upd
INSTEAD OF UPDATE ON temp.meta
BEGIN
  UPDATE main.meta
  SET key = COALESCE(NEW.key, NEW.k, OLD.key),
      value = COALESCE(NEW.value, NEW.v, OLD.value)
  WHERE key = COALESCE(OLD.key, OLD.k);
END;

CREATE TEMP TRIGGER IF NOT EXISTS tr_temp_meta_del
INSTEAD OF DELETE ON temp.meta
BEGIN
  DELETE FROM main.meta WHERE key = COALESCE(OLD.key, OLD.k);
END;

CREATE TEMP TABLE IF NOT EXISTS segments (
  ord INTEGER PRIMARY KEY,
  bits BLOB NOT NULL
) WITHOUT ROWID;

CREATE TEMP TABLE IF NOT EXISTS memory_occurrences (
  memory_id TEXT NOT NULL,
  source TEXT,
  document_id TEXT,
  chapter INTEGER,
  para INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS temp.idx_temp_occ_mem ON memory_occurrences(memory_id);
`;

const VTYPE = { number: 1, date: 2, time: 3, percent: 4, id: 5, coord: 6, enum: 7, text: 8 };

function safeParseJsonArray(raw) {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeFactObject(raw, text = '') {
  if (!raw || typeof raw !== 'object') return null;
  const attr = String(raw.attr ?? raw.attribute ?? '').trim();
  const val = raw.value !== undefined && raw.value !== null ? String(raw.value).trim() : '';
  if (!attr || !val) return null;
  const entity = raw.entity != null ? String(raw.entity).trim() : '';
  const unit = raw.unit != null && String(raw.unit).trim() ? String(raw.unit).trim() : null;
  const vtype = VTYPE[raw.valueType ?? 'text'] ?? VTYPE.text;
  const kind = raw.kind
    || (vtype === VTYPE.enum ? 'role' : vtype === VTYPE.coord ? 'coord' : vtype === VTYPE.id ? 'id' : 'value');
  const at = Number.isFinite(Number(raw.at)) ? Math.max(0, Math.trunc(Number(raw.at))) : 0;
  const sentOff = Number.isFinite(Number(raw.sentOff ?? raw.sent_off))
    ? Math.max(0, Math.trunc(Number(raw.sentOff ?? raw.sent_off)))
    : at;
  const sentLen = Number.isFinite(Number(raw.sentLen ?? raw.sent_len))
    ? Math.max(0, Math.trunc(Number(raw.sentLen ?? raw.sent_len)))
    : 0;
  let quote = typeof raw.quote === 'string' && raw.quote
    ? raw.quote
    : (typeof raw.sent === 'string' && raw.sent ? raw.sent : null);
  if (!quote && text && sentLen > 0 && sentOff + sentLen <= text.length) {
    quote = text.slice(sentOff, sentOff + sentLen);
  }
  const polarity = Number.isInteger(raw.polarity) ? raw.polarity : 1;
  const confidence = Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.8;
  return {
    entity: entity || null,
    attr,
    key: attr.length <= 2 ? attr : attr.slice(-2),
    value: val,
    unit,
    kind,
    at,
    sent_off: sentOff,
    sent_len: sentLen,
    quote,
    polarity,
    confidence,
  };
}

function inferSpaceKind(spaceId) {
  const s = String(spaceId || 'global');
  if (s === 'global') return 'global';
  if (s.startsWith('workspace:')) return 'workspace';
  if (s.startsWith('session:')) return 'session';
  return 'custom';
}

function makeStateId(spaceId, slotKey) {
  const digest = contentHash(`${spaceId}\u0000${slotKey}`).slice(0, 16);
  return `mem-state-${digest}`;
}

/**
 * 打开（或新建 / 自动迁移至 Schema v8）一个记忆库。
 *
 * @param {string} [dbPath] ':memory:' 或磁盘文件路径
 * @param {{
 *   now?: () => number,
 *   maxChars?: number,
 *   storageLimitBytes?: number,
 *   limitBytes?: number,
 *   strictPinnedTier?: boolean,
 *   backupOnMigrate?: boolean,
 *   extractL1?: (text: string) => any[],
 *   onFault?: (cause: unknown) => void,
 * }} [opts]
 */
export function open(dbPath = ':memory:', opts = {}) {
  const isMemory = dbPath === ':memory:';
  const file = isMemory ? ':memory:' : path.resolve(dbPath);
  if (!isMemory) fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  try {
    let readingInjectionSnapshot = false;
    let storeFault = null;
    function failStore(cause) {
      if (storeFault) return storeFault.cause;
      storeFault = new Error('store fault', { cause });
      try {
        if (typeof opts.onFault === 'function') opts.onFault(cause);
      } catch (notification) {
        const combined = new AggregateError([cause, notification], 'store fault notification failed', { cause });
        storeFault = new Error('store fault', { cause: combined });
        return combined;
      }
      return cause;
    }

    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const extractFn = opts.extractL1 ?? extractL1;

    // 1. WAL 与连接级 PRAGMA（:memory: 跳过 WAL 避免内存模式不支持告警/报错）
    if (!isMemory) {
      db.exec('PRAGMA journal_mode = WAL;');
    }
    db.exec('PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

    // Capture before schema inspection: any external commit until the migration write lock
    // invalidates both our schema decision and the rollback snapshot.
    const migrationDataVersion = db.prepare('PRAGMA data_version').get().data_version;

    // 2. 检测既有物理表结构与版本，决定走全新初始化、幂等打开还是 v7->v8 单事务原子迁移
    const existingTables = new Set(
      db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    );

    let fromVersion = 0;
    let metaHasKeyValue = false;
    if (existingTables.has('meta')) {
      const metaCols = db.prepare('PRAGMA main.table_info(meta)').all().map((c) => c.name);
      metaHasKeyValue = metaCols.includes('key') && metaCols.includes('value');
      const vRow = metaHasKeyValue
        ? db.prepare("SELECT value AS v FROM main.meta WHERE key = 'schema_version'").get()
        : (metaCols.includes('k') && metaCols.includes('v')
          ? db.prepare("SELECT v FROM main.meta WHERE k = 'schema_version'").get()
          : null);
      if (vRow != null) {
        const parsed = Number(vRow.v);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          if (parsed > STORE_SCHEMA_VERSION) throw new Error('unsupported future schema version');
          fromVersion = parsed;
        }
      }
    }

    const memColNames = existingTables.has('memories')
      ? db.prepare('PRAGMA main.table_info(memories)').all().map((c) => c.name)
      : [];
    const isV8Memories = memColNames.includes('space_id')
      && memColNames.includes('category')
      && memColNames.includes('content_hash')
      && memColNames.includes('last_accessed_at')
      && memColNames.includes('supersedes_json')
      && memColNames.includes('facts_json');
    const hasLegacyTables = existingTables.has('segments')
      || existingTables.has('vector_blob')
      || existingTables.has('memory_occurrences')
      || existingTables.has('facts')
      || existingTables.has('str_dict');

    const isFreshEmpty = existingTables.size === 0;
    const needsMigration = !isFreshEmpty && (
      fromVersion < STORE_SCHEMA_VERSION
      || !metaHasKeyValue
      || !isV8Memories
      || hasLegacyTables
    );

    if (isFreshEmpty) {
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec('BEGIN IMMEDIATE;');
      db.exec(SCHEMA_V8_DDL);
      const t0 = now();
      db.prepare(`INSERT OR IGNORE INTO main.spaces
        (space_id, kind, root_path, label, created_at, last_seen_at)
        VALUES ('global', 'global', NULL, 'Global', ?, ?)`).run(t0, t0);
      db.prepare("INSERT OR REPLACE INTO main.meta (key, value) VALUES ('schema_version', ?)").run(
        String(STORE_SCHEMA_VERSION),
      );
      db.prepare("INSERT OR IGNORE INTO main.meta (key, value) VALUES ('data_generation', '1')").run();
      db.exec('COMMIT;');
    } else if (needsMigration) {
      // VACUUM INTO includes committed WAL even while an old reader pins its snapshot.
      // It cannot run in a transaction: data_version closes the snapshot -> writer-lock
      // race conservatively by rejecting any intervening external commit.
      let snapshotDir = null;
      let snapshotPath = null;
      const bakPath = `${file}.v${fromVersion || 7}.bak`;
      db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;');
      try {
        if (!isMemory && opts.backupOnMigrate !== false) {
          // Existing history is not evidence of a fresh rollback point. Never replace it.
          if (fs.existsSync(bakPath)) throw new Error('migration backup already exists: ' + bakPath);
          snapshotDir = fs.mkdtempSync(file + '.snapshot-');
          snapshotPath = path.join(snapshotDir, 'snapshot.db');
          db.exec("VACUUM main INTO '" + snapshotPath.replace(/'/g, "''") + "'");
          const verify = new DatabaseSync(snapshotPath, { readOnly: true });
          try {
            const checks = verify.prepare('PRAGMA integrity_check').all();
            if (checks.length !== 1 || checks[0].integrity_check !== 'ok') {
              throw new Error('migration backup integrity check failed');
            }
          } finally { verify.close(); }
          const fd = fs.openSync(snapshotPath, 'r');
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        db.exec('BEGIN IMMEDIATE;');
        if (db.prepare('PRAGMA data_version').get().data_version !== migrationDataVersion) {
          throw new Error('concurrent commit during migration snapshot; retry with quiescent writers');
        }
        if (snapshotPath) {
          // Same-volume hard-link publishes a COMPLETE snapshot atomically, no overwrite.
          // EEXIST/unsupported filesystem/permission failures abort before any migration DDL.
          fs.linkSync(snapshotPath, bakPath);
        }
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK;');
        throw err;
      } finally {
        if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
      }
      try {
        const tMig = now();

        // 2.1 提取旧 meta 键值（剔除已废弃的 v1 内部迁移标记）
        const preservedMeta = new Map();
        if (existingTables.has('meta')) {
          const mCols = db.prepare('PRAGMA main.table_info(meta)').all().map((c) => c.name);
          const rows = mCols.includes('key') && mCols.includes('value')
            ? db.prepare('SELECT key AS k, value AS v FROM main.meta').all()
            : (mCols.includes('k') && mCols.includes('v')
              ? db.prepare('SELECT k, v FROM main.meta').all()
              : []);
          for (const r of rows) {
            if (r.k && r.k !== 'occurrences_v1_migrated') {
              preservedMeta.set(String(r.k), String(r.v ?? ''));
            }
          }
        }

        // 2.2 若存在旧 memory_occurrences，抢救其 chapter / para / source 位置元数据
        const occByMem = new Map();
        if (existingTables.has('memory_occurrences')) {
          const oCols = db.prepare('PRAGMA main.table_info(memory_occurrences)').all().map((c) => c.name);
          if (oCols.includes('memory_id')) {
            const occRows = db.prepare('SELECT * FROM main.memory_occurrences ORDER BY rowid ASC').all();
            for (const o of occRows) {
              if (!occByMem.has(o.memory_id)) {
                occByMem.set(o.memory_id, o);
              } else {
                const cur = occByMem.get(o.memory_id);
                if (cur.chapter == null && o.chapter != null) cur.chapter = o.chapter;
                if (cur.para == null && o.para != null) cur.para = o.para;
                if (!cur.source && o.source) cur.source = o.source;
              }
            }
          }
        }

        // 2.3 读取旧 memories 全部行并无损映射至 Schema v8 形状
        const oldMemRows = existingTables.has('memories')
          ? db.prepare('SELECT * FROM main.memories ORDER BY created_at ASC, id ASC').all()
          : [];

        // 反查 superseded_by 关系（旧 v7 仅存正向 supersedes）
        const supersededByLookup = new Map();
        for (const r of oldMemRows) {
          const supRaw = r.supersedes_json ?? r.supersedes;
          for (const oldId of safeParseJsonArray(supRaw)) {
            if (typeof oldId === 'string' && oldId && !supersededByLookup.has(oldId)) {
              supersededByLookup.set(oldId, String(r.id));
            }
          }
        }

        const migratedMemories = [];
        const spacesToEnsure = new Set(['global']);

        for (const r of oldMemRows) {
          const id = String(r.id);
          const text = String(r.text ?? '');
          const spaceId = typeof r.space_id === 'string' && r.space_id ? r.space_id : 'global';
          spacesToEnsure.add(spaceId);

          const rawKind = typeof r.kind === 'string' ? r.kind.trim().toLowerCase() : 'event';
          const category = typeof r.category === 'string' && MEMORY_CATEGORIES.includes(r.category)
            ? r.category
            : (rawKind === 'promise' ? 'rule' : rawKind === 'person' ? 'profile' : 'experience');

          const rawTier = Number(r.tier);
          const hasRawTier = r.tier !== undefined && r.tier !== null && Number.isFinite(rawTier);
          const tier = (
            rawKind === 'promise'
            || rawKind === 'person'
            || category === 'rule'
            || category === 'profile'
            || (hasRawTier && (Math.trunc(rawTier) === 1 || Math.trunc(rawTier) === 0))
          )
            ? 0
            : (hasRawTier ? Math.max(1, Math.min(5, Math.trunc(rawTier))) : 3);

          const slotKey = r.slot_key != null && String(r.slot_key) ? String(r.slot_key) : null;
          const cHash = contentHash(text);
          const occ = occByMem.get(id);
          const source = r.source != null ? String(r.source) : (occ?.source != null ? String(occ.source) : null);
          const status = typeof r.status === 'string' && MEMORY_STATUSES.includes(r.status) ? r.status : 'active';
          const supersedesArr = safeParseJsonArray(r.supersedes_json ?? r.supersedes);
          const supersededBy = r.superseded_by != null
            ? String(r.superseded_by)
            : (supersededByLookup.get(id) ?? null);

          const chapter = Number.isSafeInteger(r.chapter)
            ? r.chapter
            : (Number.isSafeInteger(occ?.chapter) ? occ.chapter : 0);
          const para = Number.isSafeInteger(r.para)
            ? r.para
            : (Number.isSafeInteger(occ?.para) ? occ.para : 0);

          const importance = Number.isFinite(Number(r.importance)) ? Number(r.importance) : 0.5;
          const accessCount = Number.isFinite(Number(r.access_count))
            ? Math.max(0, Math.trunc(Number(r.access_count)))
            : 0;
          const createdAt = Number.isFinite(Number(r.created_at)) ? Number(r.created_at) : tMig;
          const lastAccessedAt = Number.isFinite(Number(r.last_accessed_at ?? r.last_accessed))
            ? Number(r.last_accessed_at ?? r.last_accessed)
            : createdAt;
          const updatedAt = Number.isFinite(Number(r.updated_at)) ? Number(r.updated_at) : lastAccessedAt;

          const existingFacts = safeParseJsonArray(r.facts_json ?? r.facts);
          const rawExtracted = existingFacts.length ? existingFacts : extractFn(text);
          const normalizedFacts = [];
          for (const f of rawExtracted) {
            const nf = normalizeFactObject(f, text);
            if (nf) normalizedFacts.push(nf);
          }

          migratedMemories.push({
            id,
            spaceId,
            category,
            tier,
            slotKey,
            text,
            contentHash: cHash,
            source,
            status,
            supersededBy,
            supersedesJson: JSON.stringify(supersedesArr),
            factsJson: JSON.stringify(normalizedFacts),
            facts: normalizedFacts,
            chapter,
            para,
            importance,
            accessCount,
            createdAt,
            updatedAt,
            lastAccessedAt,
          });
        }

        // 2.4 清理旧触发器与废弃冗余表，重建纯净 Schema v8 表结构
        db.exec(`
          DROP TRIGGER IF EXISTS main.memory_occurrences_delete;
          DROP TABLE IF EXISTS main.segments;
          DROP TABLE IF EXISTS main.vector_blob;
          DROP TABLE IF EXISTS main.memory_occurrences;
          DROP TABLE IF EXISTS main.facts;
          DROP INDEX IF EXISTS main.ux_facts_slot;
          DROP TABLE IF EXISTS main.str_dict;
          DROP TABLE IF EXISTS main.entity_dict;
          DROP TABLE IF EXISTS main.attr_dict;
        `);

        if (existingTables.has('memories') && !isV8Memories) {
          db.exec('DROP INDEX IF EXISTS main.ux_memories_hash;');
          db.exec('DROP TABLE main.memories;');
        }
        if (existingTables.has('meta') && !metaHasKeyValue) {
          db.exec('DROP TABLE main.meta;');
        }

        db.exec(SCHEMA_V8_DDL);

        const insSpaceMig = db.prepare(`INSERT OR IGNORE INTO main.spaces
          (space_id, kind, root_path, label, created_at, last_seen_at)
          VALUES (?, ?, NULL, ?, ?, ?)`);
        for (const sp of spacesToEnsure) {
          insSpaceMig.run(sp, inferSpaceKind(sp), sp === 'global' ? 'Global' : sp, tMig, tMig);
        }

        if (!isV8Memories || !existingTables.has('memories')) {
          const insMemMig = db.prepare(`INSERT INTO main.memories (
            id, space_id, category, tier, slot_key, text, content_hash, source,
            status, superseded_by, supersedes_json, facts_json,
            chapter, para, importance, access_count, created_at, updated_at, last_accessed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

          const insSlotMig = db.prepare(`INSERT INTO main.entity_slots (
            memory_id, space_id, entity, attr, value, unit, polarity, confidence, quote, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

          for (const m of migratedMemories) {
            insMemMig.run(
              m.id, m.spaceId, m.category, m.tier, m.slotKey, m.text, m.contentHash, m.source,
              m.status, m.supersededBy, m.supersedesJson, m.factsJson,
              m.chapter, m.para, m.importance, m.accessCount, m.createdAt, m.updatedAt, m.lastAccessedAt,
            );
            for (const f of m.facts) {
              insSlotMig.run(
                m.id,
                m.spaceId,
                f.entity ?? '',
                f.attr,
                f.value,
                f.unit,
                f.polarity,
                f.confidence,
                f.quote,
                m.createdAt,
              );
            }
          }
        } else {
          // 若 memories 已是 v8 形状但缺 entity_slots，按已有行补齐
          const slotCount = db.prepare('SELECT COUNT(*) AS n FROM main.entity_slots').get().n;
          if (slotCount === 0 && migratedMemories.length > 0) {
            const insSlotMig = db.prepare(`INSERT INTO main.entity_slots (
              memory_id, space_id, entity, attr, value, unit, polarity, confidence, quote, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const m of migratedMemories) {
              for (const f of m.facts) {
                insSlotMig.run(
                  m.id, m.spaceId, f.entity ?? '', f.attr, f.value, f.unit,
                  f.polarity, f.confidence, f.quote, m.createdAt,
                );
              }
            }
          }
        }

        const insMetaMig = db.prepare('INSERT OR REPLACE INTO main.meta (key, value) VALUES (?, ?)');
        for (const [k, v] of preservedMeta) {
          if (k !== 'schema_version') insMetaMig.run(k, v);
        }
        insMetaMig.run('schema_version', String(STORE_SCHEMA_VERSION));
        if (!preservedMeta.has('data_generation')) {
          insMetaMig.run('data_generation', '1');
        }

        db.exec('COMMIT;');
      } catch (migErr) {
        if (db.isTransaction) {
          try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
        }
        throw migErr;
      } finally {
        db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
      }
    } else {
      // 已是干净的 Schema v8 库：零写放大开启外键并补齐幂等索引定义
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(SCHEMA_V8_DDL);
      const hasGlobal = db.prepare("SELECT 1 FROM main.spaces WHERE space_id = 'global'").get();
      if (!hasGlobal) {
        const t0 = now();
        db.prepare(`INSERT OR IGNORE INTO main.spaces
          (space_id, kind, root_path, label, created_at, last_seen_at)
          VALUES ('global', 'global', NULL, 'Global', ?, ?)`).run(t0, t0);
      }
    }

    // 3. 挂载连接级 TEMP 兼容层（不写入磁盘，不出现在 main.sqlite_master）
    db.exec(TEMP_COMPAT_DDL);

    // ── 内存事实与连接级段位图派生层 ─────────────────────────────────────────
    let memFacts = { byId: new Map(), slot: new Map(), total: 0 };
    let factsRevision = 0;
    let hybridRequest = 0;
    let hybridPublishing = false;
    let derivedStamp = null;
    let derivedTexts = new Map();
    const databaseEpoch = () => `${db.prepare('PRAGMA data_version').get().data_version}:${db.prepare('SELECT total_changes() AS n').get().n}`;
    let derivedEpoch;

    const SNAPSHOT_MEMORIES_SQL = `
      SELECT quote(rowid) AS r, id, space_id, category, quote(tier) AS tier, slot_key,
             text, content_hash, source, status, superseded_by, supersedes_json,
             quote(importance) AS imp, quote(created_at) AS ca, quote(updated_at) AS ua
      FROM main.memories
      ORDER BY rowid
    `;

    function readSnapshotStamp() {
      const gen = db.prepare("SELECT value FROM main.meta WHERE key = 'data_generation'").get()?.value ?? '1';
      return JSON.stringify([gen, db.prepare(SNAPSHOT_MEMORIES_SQL).all()]);
    }

    function bumpDataGeneration() {
      const row = db.prepare("SELECT value FROM main.meta WHERE key = 'data_generation'").get();
      const next = (Number.parseInt(row?.value ?? '0', 10) || 0) + 1;
      db.prepare("INSERT OR REPLACE INTO main.meta (key, value) VALUES ('data_generation', ?)").run(String(next));
      return next;
    }

    function dataGeneration() {
      assertOpen();
      const row = db.prepare("SELECT value FROM main.meta WHERE key = 'data_generation'").get();
      return Number.parseInt(row?.value ?? '1', 10) || 1;
    }

    function addMemFact(memoryId, nf, target = memFacts) {
      const fact = {
        entity: nf.entity ?? null,
        attr: nf.attr,
        key: nf.key,
        value: nf.value,
        unit: nf.unit ?? null,
        kind: nf.kind,
        at: nf.at ?? 0,
        sent_off: nf.sent_off ?? nf.at ?? 0,
        sent_len: nf.sent_len ?? 0,
        quote: nf.quote ?? null,
        polarity: nf.polarity ?? 1,
        confidence: nf.confidence ?? 0.8,
      };
      let list = target.byId.get(memoryId);
      if (!list) {
        list = [];
        target.byId.set(memoryId, list);
      }
      list.push(fact);
      target.total += 1;
      let slot = target.slot.get(fact.attr);
      if (!slot) {
        slot = [];
        target.slot.set(fact.attr, slot);
      }
      slot.push({ memoryId, fact });
    }

    function extractNormalizedFacts(text, explicitFacts) {
      const raw = Array.isArray(explicitFacts) ? explicitFacts : extractFn(text);
      const out = [];
      for (const item of raw) {
        const nf = normalizeFactObject(item, text);
        if (nf) out.push(nf);
      }
      return out;
    }

    function buildFactsFor(memoryId, text, explicitFacts, target = memFacts) {
      const list = extractNormalizedFacts(text, explicitFacts);
      for (const nf of list) addMemFact(memoryId, nf, target);
      return list;
    }

    function syncTempSegments() {
      const rows = db.prepare('SELECT rowid AS ord, text FROM main.memories ORDER BY rowid').all();
      db.exec('DELETE FROM temp.segments WHERE ord NOT IN (SELECT rowid FROM main.memories)');
      const replaceSeg = db.prepare('INSERT OR REPLACE INTO temp.segments (ord, bits) VALUES (?, ?)');
      const hasSeg = db.prepare('SELECT 1 FROM temp.segments WHERE ord = ?');
      for (const row of rows) {
        if (derivedTexts.get(row.ord) !== row.text || !hasSeg.get(row.ord)) {
          replaceSeg.run(row.ord, packCovered(splitSegments(row.text).length));
        }
      }
      derivedTexts = new Map(rows.map((row) => [row.ord, row.text]));
    }

    function rebuildFacts(reason = 'startup') {
      const t0 = Date.now();
      const next = { byId: new Map(), slot: new Map(), total: 0 };
      const rows = db.prepare(
        'SELECT rowid AS ord, id, text, facts_json FROM main.memories WHERE status != \'deleted\' ORDER BY created_at, id',
      ).all();
      for (const m of rows) {
        const stored = safeParseJsonArray(m.facts_json);
        buildFactsFor(m.id, m.text, stored.length ? stored : undefined, next);
      }
      syncTempSegments();
      memFacts = next;
      factsRevision += 1;
      const ms = Date.now() - t0;
      const info = { facts: memFacts.total, memories: rows.length, ms, reason };
      if (!isMemory && process.env.MEMJUDGE_VERBOSE) {
        console.error(`[memjudge] facts 重建：${info.facts} 条 / ${info.memories} 条记忆 / ${ms}ms（${reason}）`);
      }
      return info;
    }

    const rebuildStats = rebuildFacts('startup');

    function contentVersion() {
      assertOpen();
      if (db.isTransaction) throw new Error('content version requires an idle connection');
      const before = db.prepare('PRAGMA data_version').get().data_version;
      const result = readSnapshotStamp();
      if (before !== db.prepare('PRAGMA data_version').get().data_version) {
        throw new Error('content version changed during read');
      }
      return result;
    }

    function ensureFresh() {
      if (db.isTransaction) throw new Error('derived read requires an idle connection');
      const stamp = contentVersion();
      if (stamp === derivedStamp && databaseEpoch() === derivedEpoch) return;
      const next = { byId: new Map(), slot: new Map(), total: 0 };
      let rows;
      let finalStamp = stamp;
      let committing = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        finalStamp = readSnapshotStamp();
        // Keep compatibility probe query shape for fault-gate tests
        const ordRows = db.prepare('SELECT rowid AS ord, text FROM main.memories ORDER BY rowid').all();
        rows = db.prepare('SELECT rowid AS ord, id, text, facts_json FROM main.memories ORDER BY rowid').all();
        for (const row of rows) {
          const stored = safeParseJsonArray(row.facts_json);
          buildFactsFor(row.id, row.text, stored.length ? stored : undefined, next);
        }
        db.exec('DELETE FROM temp.segments WHERE ord NOT IN (SELECT rowid FROM main.memories)');
        const replaceSeg = db.prepare('INSERT OR REPLACE INTO temp.segments (ord, bits) VALUES (?, ?)');
        const hasSeg = db.prepare('SELECT 1 FROM temp.segments WHERE ord = ?');
        for (const row of ordRows) {
          if (derivedTexts.get(row.ord) !== row.text || !hasSeg.get(row.ord)) {
            replaceSeg.run(row.ord, packCovered(splitSegments(row.text).length));
          }
        }
        committing = true;
        db.exec('COMMIT');
        if (db.isTransaction) throw new Error('derived refresh commit left an active transaction');
        derivedTexts = new Map(ordRows.map((row) => [row.ord, row.text]));
      } catch (error) {
        if (db.isTransaction) {
          try { db.exec('ROLLBACK'); }
          catch (cleanup) { throw failStore(new AggregateError([error, cleanup], 'derived refresh and rollback failed')); }
        }
        if (committing) throw failStore(error);
        throw error;
      }
      memFacts = next;
      derivedStamp = finalStamp;
      derivedEpoch = databaseEpoch();
      factsRevision += 1;
    }

    async function rebuildFactsHybrid(hOpts = {}) {
      assertOpen();
      if (db.isTransaction) throw new Error('hybrid rebuild requires an idle connection');
      const request = ++hybridRequest;
      const dataVersion = db.prepare('PRAGMA data_version').get().data_version;
      const changes = db.prepare('SELECT total_changes() AS n').get().n;
      const revision = factsRevision;
      const rows = db.prepare(
        "SELECT rowid AS ord, id, space_id, text FROM main.memories WHERE status = 'active' ORDER BY created_at, id",
      ).all();
      const extract = hOpts.extractHybrid ?? (await import('./extract.mjs')).extractL1Hybrid;
      const r = await extract(rows.map((x) => ({ text: x.text })), hOpts);
      hOpts.signal?.throwIfAborted();
      assertOpen();
      const next = { byId: new Map(), slot: new Map(), total: 0 };
      const perMemNormalized = new Map();
      const source = r?.source;
      if (!['llm', 'rules', 'rules-fallback'].includes(source)) {
        throw new Error('hybrid rebuild invalid extraction result');
      }
      if (source === 'llm') {
        const maxEntries = 100000;
        const maxFactsPerEntry = 10000;
        const maxFactsTotal = 100000;
        const perEntry = r.perEntry;
        if (!Array.isArray(perEntry)) throw new Error('hybrid rebuild invalid extraction result');
        const entryCount = perEntry.length;
        if (!Number.isSafeInteger(entryCount) || entryCount < 0
            || entryCount > maxEntries || entryCount !== rows.length) {
          throw new Error('hybrid rebuild invalid extraction result');
        }
        let factsTotal = 0;
        for (let i = 0; i < entryCount; i += 1) {
          const row = rows[i];
          const entry = perEntry[i];
          if (!Array.isArray(entry)) throw new Error('hybrid rebuild invalid extraction result');
          const length = entry.length;
          if (!Number.isSafeInteger(length) || length < 0 || length > maxFactsPerEntry
              || length > maxFactsTotal - factsTotal) {
            throw new Error('hybrid rebuild invalid extraction result: fact budget exceeded or invalid length');
          }
          factsTotal += length;
          const memList = [];
          for (let j = 0; j < length; j += 1) {
            const raw = entry[j];
            if (!raw || typeof raw !== 'object') throw new Error('hybrid rebuild invalid extraction result');
            const f = {
              attr: raw.attr, value: raw.value, entity: raw.entity, valueType: raw.valueType,
              at: raw.at, sentOff: raw.sentOff, sentLen: raw.sentLen, sent: raw.sent,
            };
            if (!f || typeof f !== 'object' || typeof f.attr !== 'string' || !f.attr.trim()
                || typeof f.value !== 'string' || !f.value.trim()
                || (f.entity != null && typeof f.entity !== 'string')
                || (f.valueType != null && (typeof f.valueType !== 'string' || !Object.hasOwn(VTYPE, f.valueType)))
                || ['at', 'sentOff', 'sentLen'].some((k) => f[k] != null && (!Number.isSafeInteger(f[k]) || f[k] < 0))
                || (f.at ?? 0) > row.text.length || (f.sentOff ?? f.at ?? 0) > row.text.length
                || (f.sentLen ?? 0) > row.text.length - (f.sentOff ?? f.at ?? 0)
                || (f.sent != null && (typeof f.sent !== 'string'
                  || row.text.slice(f.sentOff ?? f.at ?? 0, (f.sentOff ?? f.at ?? 0) + (f.sentLen ?? 0)) !== f.sent))) {
              throw new Error('hybrid rebuild invalid extraction result');
            }
            const nf = normalizeFactObject(f, row.text);
            if (nf) {
              addMemFact(row.id, nf, next);
              memList.push(nf);
            }
          }
          perMemNormalized.set(row.id, { spaceId: row.space_id, facts: memList });
        }
      }
      assertOpen();
      if (db.isTransaction) throw new Error('hybrid rebuild requires an idle connection');
      let locked = false;
      let failure;
      let failed = false;
      const previous = memFacts;
      let published = false;
      hybridPublishing = true;
      try {
        db.exec('BEGIN IMMEDIATE');
        locked = true;
        if (request !== hybridRequest || revision !== factsRevision
            || changes !== db.prepare('SELECT total_changes() AS n').get().n
            || dataVersion !== db.prepare('PRAGMA data_version').get().data_version) {
          throw new Error('hybrid rebuild snapshot stale');
        }
        const current = db.prepare(
          "SELECT rowid AS ord, id, space_id, text FROM main.memories WHERE status = 'active' ORDER BY created_at, id",
        ).all();
        if (current.length !== rows.length || current.some((row, i) =>
          row.ord !== rows[i].ord || row.id !== rows[i].id || row.text !== rows[i].text)) {
          throw new Error('hybrid rebuild snapshot stale');
        }
        if (source === 'llm') {
          memFacts = next;
          published = true;
        }
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        if (locked || db.isTransaction) {
          try { db.exec('ROLLBACK'); }
          catch (cleanup) {
            const cause = failed
              ? new AggregateError([failure, cleanup], 'hybrid rebuild and cleanup failed', { cause: failure })
              : cleanup;
            throw failStore(cause);
          }
        }
        if (db.isTransaction) {
          const cleanup = new Error('hybrid rebuild cleanup left an active transaction');
          const cause = failed
            ? new AggregateError([failure, cleanup], 'hybrid rebuild and cleanup failed', { cause: failure })
            : cleanup;
          throw failStore(cause);
        }
        if (failed) throw failure;
        if (published) factsRevision += 1;
        return { facts: memFacts.total, memories: rows.length, source };
      } catch (error) {
        if (published) memFacts = previous;
        throw error;
      } finally {
        hybridPublishing = false;
      }
    }

    function injectionSnapshot(options = {}) {
      if (readingInjectionSnapshot || db.isTransaction) throw new Error('injection snapshot requires an idle connection');
      readingInjectionSnapshot = true;
      try {
        const { maxRows = 1000, maxFieldBytes = 65536, maxBytes = 1048576 } = options;
        for (const [name, value, ceiling] of [
          ['maxRows', maxRows, 100000],
          ['maxFieldBytes', maxFieldBytes, 1048576],
          ['maxBytes', maxBytes, 16777216],
        ]) {
          if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) throw new RangeError(`invalid ${name}`);
        }
        if (db.isTransaction) throw new Error('injection snapshot requires an idle connection');
        const strings = ['id', 'text', 'source', 'category', 'space_id'];
        const checks = strings.map((c) => {
          const nullable = c === 'source' ? ' OR source IS NULL' : '';
          return `((typeof(${c}) = 'text' AND length(CAST(${c} AS BLOB)) <= $field)${nullable})`;
        }).join(' AND ');
        const numeric = ['created_at', 'last_accessed_at'].map(
          (c) => `(typeof(${c}) IN ('integer','real') AND ${c} BETWEEN -9007199254740991 AND 9007199254740991)`,
        ).concat([
          "(typeof(access_count) IN ('integer','real') AND access_count BETWEEN 0 AND 9007199254740991 AND access_count = CAST(access_count AS INTEGER))",
          "(typeof(importance) IN ('integer','real') AND importance BETWEEN 0 AND 1)",
        ]).join(' AND ');
        const byteExpr = strings.map((c) => `coalesce(length(CAST(${c} AS BLOB)), 0)`).join(' + ');
        const projected = strings.map(
          (c) => `CASE WHEN valid AND rn <= $rows AND total_bytes <= $total THEN ${c} ELSE NULL END AS ${c}`,
        ).join(', ');
        const sql = `WITH measured AS (
          SELECT *, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn,
            (${checks} AND ${numeric}) AS valid, (${byteExpr}) AS row_bytes
          FROM main.memories
          WHERE status = 'active'
        ), budgeted AS (
          SELECT *, SUM(row_bytes) OVER (ORDER BY rn) AS total_bytes FROM measured
        ) SELECT rn, valid, total_bytes, ${projected},
          CASE WHEN valid AND rn <= $rows AND total_bytes <= $total THEN slot_key END AS slot_key,
          CASE WHEN valid AND rn <= $rows AND total_bytes <= $total THEN tier END AS tier,
          CASE WHEN valid AND rn <= $rows AND total_bytes <= $total THEN created_at END AS created_at,
          CASE WHEN valid AND rn <= $rows AND total_bytes <= $total THEN last_accessed_at END AS last_accessed_at,
          CASE WHEN valid AND rn <= $rows AND total_bytes <= $total THEN access_count END AS access_count,
          CASE WHEN valid AND rn <= $rows AND total_bytes <= $total THEN importance END AS importance
        FROM budgeted WHERE rn <= $rows + 1 ORDER BY rn`;
        const rows = [];
        let decodedBytes = 0;
        let candidateBytes = 0;
        for (const row of db.prepare(sql).iterate({ $rows: maxRows, $field: maxFieldBytes, $total: maxBytes })) {
          if (row.rn > maxRows || !row.valid || row.total_bytes > maxBytes) return { complete: false, candidates: [] };
          for (const field of strings) {
            const value = row[field];
            if (field === 'source' && value === null) continue;
            if (typeof value !== 'string') return { complete: false, candidates: [] };
            const size = Buffer.byteLength(value, 'utf8');
            decodedBytes += size;
            if (size > maxFieldBytes || decodedBytes > maxBytes) return { complete: false, candidates: [] };
          }
          const category = normalizeCategory(row.category);
          const candidate = {
            id: row.id,
            spaceId: row.space_id,
            category,
            kind: categoryToKind(category),
            tier: Number(row.tier ?? 1),
            slotKey: row.slot_key ?? null,
            text: row.text,
            source: row.source,
            createdAt: row.created_at,
            lastAccessed: row.last_accessed_at,
            accessCount: row.access_count,
            importance: row.importance,
          };
          for (const field of ['id', 'text', 'source', 'kind']) {
            const size = Buffer.byteLength(candidate[field] ?? '', 'utf8');
            candidateBytes += size;
            if (size > maxFieldBytes || candidateBytes > maxBytes) return { complete: false, candidates: [] };
          }
          rows.push(candidate);
        }
        return { complete: true, candidates: rows };
      } finally {
        readingInjectionSnapshot = false;
      }
    }

    const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? Math.trunc(opts.maxChars) : 0;
    const rawLimitBytes = opts.limitBytes !== undefined ? opts.limitBytes : opts.storageLimitBytes;
    const storageLimitBytes = Number.isFinite(rawLimitBytes) && rawLimitBytes > 0
      ? Math.trunc(rawLimitBytes)
      : STORAGE_LIMIT_BYTES;

    const stmt = {
      bySpaceHash: db.prepare(
        "SELECT * FROM main.memories WHERE space_id = ? AND content_hash = ? AND status = 'active'",
      ),
      byId: db.prepare('SELECT * FROM main.memories WHERE id = ?'),
      rowidOf: db.prepare('SELECT rowid AS ord FROM main.memories WHERE id = ?'),
      insSpace: db.prepare(`INSERT OR IGNORE INTO main.spaces
        (space_id, kind, root_path, label, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)`),
      touchSpace: db.prepare('UPDATE main.spaces SET last_seen_at = ? WHERE space_id = ?'),
      insMem: db.prepare(`INSERT INTO main.memories (
        id, space_id, category, tier, slot_key, text, content_hash, source,
        status, superseded_by, supersedes_json, facts_json,
        chapter, para, importance, access_count, created_at, updated_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`),
      setSupersededBy: db.prepare('UPDATE main.memories SET superseded_by = ?, updated_at = ? WHERE id = ?'),
      setCatTier: db.prepare('UPDATE main.memories SET category = ?, tier = ?, updated_at = ? WHERE id = ?'),
      touchUpdated: db.prepare('UPDATE main.memories SET updated_at = ? WHERE id = ?'),
      touchAccess: db.prepare(
        'UPDATE main.memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
      ),
      delSlotsByMem: db.prepare('DELETE FROM main.entity_slots WHERE memory_id = ?'),
      insSlot: db.prepare(`INSERT INTO main.entity_slots (
        memory_id, space_id, entity, attr, value, unit, polarity, confidence, quote, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      setFactsJson: db.prepare('UPDATE main.memories SET facts_json = ? WHERE id = ?'),
      insRev: db.prepare(`INSERT INTO main.memory_revisions (
        memory_id, space_id, slot_key, prev_text, prev_hash, reason, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`),
      listRevs: db.prepare(`SELECT
        rev_id AS revId, memory_id AS memoryId, space_id AS spaceId, slot_key AS slotKey,
        prev_text AS prevText, prev_hash AS prevHash, reason, changed_at AS changedAt
        FROM main.memory_revisions WHERE memory_id = ? ORDER BY changed_at DESC, rev_id DESC LIMIT ?`),
      activeSlot: db.prepare(
        "SELECT * FROM main.memories WHERE space_id = ? AND slot_key = ? AND status = 'active'",
      ),
      countActive: db.prepare("SELECT COUNT(*) AS n FROM main.memories WHERE status != 'deleted'"),
      sizes: db.prepare(
        "SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes FROM main.memories WHERE status != 'deleted'",
      ),
      budgetTexts: db.prepare("SELECT text FROM main.memories WHERE status = 'active'"),
      insSeg: db.prepare('INSERT OR REPLACE INTO temp.segments (ord, bits) VALUES (?, ?)'),
      segRow: db.prepare(
        'SELECT m.id AS memory_id, s.bits FROM temp.segments s JOIN main.memories m ON m.rowid = s.ord WHERE m.id = ?',
      ),
      allSegs: db.prepare(
        'SELECT s.ord, m.id AS memory_id, s.bits, m.created_at FROM temp.segments s JOIN main.memories m ON m.rowid = s.ord',
      ),
      allBits: db.prepare('SELECT bits FROM temp.segments'),
      coverMem: db.prepare('UPDATE temp.segments SET bits = ? WHERE ord = (SELECT rowid FROM main.memories WHERE id = ?)'),
      bySourcePrefix: db.prepare(`SELECT *
        FROM main.memories
        WHERE status != 'deleted' AND source IS NOT NULL
          AND substr(CAST(source AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB)
        ORDER BY created_at ASC, id ASC LIMIT ?`),
      hasOcc: db.prepare(
        'SELECT 1 FROM temp.memory_occurrences WHERE memory_id = ? AND source IS ? AND document_id IS ? AND chapter IS ? AND para IS ? LIMIT 1',
      ),
      insOcc: db.prepare(
        'INSERT INTO temp.memory_occurrences (memory_id, source, document_id, chapter, para, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      delOccByMem: db.prepare('DELETE FROM temp.memory_occurrences WHERE memory_id = ?'),
      occByMem: db.prepare(
        'SELECT memory_id, source, document_id, chapter, para FROM temp.memory_occurrences WHERE memory_id = ? ORDER BY rowid ASC',
      ),
      occCountByMem: db.prepare(
        'SELECT COUNT(*) AS cnt FROM temp.memory_occurrences WHERE memory_id = ?',
      ),
      occBySourcePrefix: db.prepare(`SELECT o.memory_id, o.source AS occ_source, o.document_id, o.chapter AS occ_chapter, o.para AS occ_para, m.*
        FROM temp.memory_occurrences o
        JOIN main.memories m ON m.id = o.memory_id
        WHERE m.status != 'deleted' AND o.source IS NOT NULL
          AND substr(CAST(o.source AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB)
        ORDER BY o.rowid ASC LIMIT ?`),
      byCategory: db.prepare(`SELECT *
        FROM main.memories
        WHERE status != 'deleted' AND category = ?
        ORDER BY created_at ASC, id ASC LIMIT ?`),
      byLegacyEventCats: db.prepare(`SELECT *
        FROM main.memories
        WHERE status != 'deleted' AND category IN ('experience', 'decision', 'state')
        ORDER BY created_at ASC, id ASC LIMIT ?`),
    };

    db.exec(`INSERT INTO temp.memory_occurrences (memory_id, source, document_id, chapter, para, created_at)
      SELECT id, source, NULL,
             CASE WHEN chapter > 0 THEN chapter ELSE NULL END,
             CASE WHEN para > 0 THEN para ELSE NULL END,
             created_at
        FROM main.memories
       WHERE status != 'deleted'
         AND NOT EXISTS (SELECT 1 FROM temp.memory_occurrences LIMIT 1)`);

    let closeState = 'OPEN';
    const assertOpen = () => {
      if (closeState !== 'OPEN') throw new Error('store 已关闭或关闭状态未知');
      if (storeFault) throw storeFault;
      if (hybridPublishing) throw new Error('hybrid rebuild publication in progress');
    };

    function ensureSpaceRow(spaceId, ts) {
      const sid = String(spaceId || 'global');
      stmt.insSpace.run(sid, inferSpaceKind(sid), null, sid === 'global' ? 'Global' : sid, ts, ts);
    }

    function factsOf(id) {
      const list = memFacts.byId.get(String(id));
      if (list) return list.slice().sort((a, b) => a.at - b.at);
      const row = stmt.byId.get(String(id));
      if (!row) return [];
      return safeParseJsonArray(row.facts_json).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    }

    /**
     * 将数据库行转换为新旧双向兼容视图：
     * 同时携带 v2 字段（category, spaceId, slotKey, status, contentHash, updatedAt）
     * 与 v1 字段（kind, createdAt, lastAccessed, accessCount, supersedes, supersededBy, facts, source, tier）。
     */
    function toMemoryView(row, viewOpts = {}) {
      if (!row) return null;
      const includeText = viewOpts.includeText !== false;
      const withFacts = viewOpts.withFacts === true;
      const includeCompatSnake = viewOpts.includeCompatSnake === true;
      const category = normalizeCategory(row.category);
      const kind = categoryToKind(category);
      const supersedesArr = safeParseJsonArray(row.supersedes_json);
      const supersedesOut = viewOpts.nullEmptySupersedes
        ? (supersedesArr.length ? supersedesArr : null)
        : supersedesArr;
      const supersededByOut = viewOpts.supersededByOverride !== undefined
        ? viewOpts.supersededByOverride
        : (row.superseded_by ?? null);

      const view = {
        id: row.id,
        spaceId: row.space_id,
        category,
        kind,
        tier: Number(row.tier),
        slotKey: row.slot_key ?? null,
        status: row.status,
        contentHash: row.content_hash,
        source: row.source ?? null,
        chapter: Number(row.chapter ?? 0),
        para: Number(row.para ?? 0),
        importance: Number(row.importance ?? 0.5),
        accessCount: Number(row.access_count ?? 0),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        lastAccessed: Number(row.last_accessed_at),
        supersedes: supersedesOut,
        supersededBy: supersededByOut,
      };
      if (includeText) view.text = row.text;
      if (withFacts) view.facts = factsOf(row.id);
      if (includeCompatSnake) {
        view.space_id = row.space_id;
        view.slot_key = row.slot_key ?? null;
        view.text_hash = row.content_hash;
        view.created_at = Number(row.created_at);
        view.updated_at = Number(row.updated_at);
        view.last_accessed = Number(row.last_accessed_at);
        view.last_accessed_at = Number(row.last_accessed_at);
        view.access_count = Number(row.access_count ?? 0);
      }
      return view;
    }

    function replaceSlotsInternal(memoryId, spaceId, slotsInput, ts) {
      const mid = String(memoryId);
      const sid = String(spaceId || 'global');
      const t = Number.isFinite(ts) ? ts : now();
      const memRow = stmt.byId.get(mid);
      const text = memRow?.text ?? '';
      stmt.delSlotsByMem.run(mid);
      const normalized = [];
      for (const raw of slotsInput ?? []) {
        const nf = normalizeFactObject(raw, text);
        if (!nf) continue;
        normalized.push(nf);
        stmt.insSlot.run(
          mid,
          sid,
          nf.entity ?? '',
          nf.attr,
          nf.value,
          nf.unit,
          nf.polarity,
          nf.confidence,
          nf.quote,
          t,
        );
      }
      if (memRow) {
        stmt.setFactsJson.run(JSON.stringify(normalized), mid);
      }
      return normalized;
    }

    function syncMemFactsForId(memoryId, normalizedList) {
      const mid = String(memoryId);
      const oldList = memFacts.byId.get(mid) || [];
      for (const f of oldList) {
        const slot = memFacts.slot.get(f.attr);
        if (slot) {
          const idx = slot.findIndex((x) => x.memoryId === mid && x.fact === f);
          if (idx >= 0) slot.splice(idx, 1);
        }
      }
      memFacts.total -= oldList.length;
      memFacts.byId.delete(mid);
      for (const nf of normalizedList) addMemFact(mid, nf, memFacts);
      factsRevision += 1;
    }

    // ── 1. 空间管理（spaces） ────────────────────────────────────────────────

    function upsertSpace(input = {}) {
      assertOpen();
      if (db.isTransaction) throw new Error('upsertSpace requires an idle connection');
      const spaceId = typeof input.spaceId === 'string' && input.spaceId.trim()
        ? input.spaceId.trim()
        : '';
      if (!spaceId) throw new TypeError('upsertSpace: spaceId 必须是非空字符串');
      const kind = typeof input.kind === 'string' && input.kind.trim()
        ? input.kind.trim()
        : inferSpaceKind(spaceId);
      const rootPath = input.rootPath === undefined ? undefined : (input.rootPath == null ? null : String(input.rootPath));
      const label = input.label === undefined ? undefined : (input.label == null ? null : String(input.label));
      const t = Number.isFinite(input.now) ? input.now : now();

      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT * FROM main.spaces WHERE space_id = ?').get(spaceId);
        if (!existing) {
          db.prepare(`INSERT INTO main.spaces
            (space_id, kind, root_path, label, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(
            spaceId,
            kind,
            rootPath ?? null,
            label ?? (spaceId === 'global' ? 'Global' : spaceId),
            t,
            t,
          );
        } else {
          db.prepare(`UPDATE main.spaces
            SET kind = ?,
                root_path = ?,
                label = ?,
                last_seen_at = ?
            WHERE space_id = ?`).run(
            input.kind !== undefined ? kind : existing.kind,
            rootPath !== undefined ? rootPath : existing.root_path,
            label !== undefined ? label : existing.label,
            t,
            spaceId,
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      const row = db.prepare('SELECT * FROM main.spaces WHERE space_id = ?').get(spaceId);
      return {
        spaceId: row.space_id,
        kind: row.kind,
        rootPath: row.root_path,
        label: row.label,
        createdAt: Number(row.created_at),
        lastSeenAt: Number(row.last_seen_at),
      };
    }

    function listSpaces() {
      assertOpen();
      return db.prepare(`SELECT * FROM main.spaces
        ORDER BY CASE WHEN space_id = 'global' THEN 0 ELSE 1 END ASC, last_seen_at DESC, space_id ASC`)
        .all()
        .map((r) => ({
          spaceId: r.space_id,
          kind: r.kind,
          rootPath: r.root_path,
          label: r.label,
          createdAt: Number(r.created_at),
          lastSeenAt: Number(r.last_seen_at),
        }));
    }

    // ── 2. 单活状态槽位（putState：原地覆写 + 修订链归档 + 失效旧向量） ──────

    function putState(input = {}) {
      assertOpen();
      if (db.isTransaction) throw new Error('putState requires an idle connection');
      const spaceId = typeof input.spaceId === 'string' && input.spaceId.trim()
        ? input.spaceId.trim()
        : 'global';
      const slotKey = typeof input.slotKey === 'string' ? input.slotKey.trim() : '';
      if (!slotKey) throw new TypeError('putState: slotKey 必须是非空字符串');
      const text = input.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new TypeError('putState: text 必须是非空字符串');
      }
      if (hasUnpairedSurrogate(text)) throw new TypeError('putState: text contains unpaired UTF-16 surrogate');

      const hash = contentHash(text);
      const source = input.source == null ? null : String(input.source);
      const importance = Number.isFinite(input.importance)
        ? Math.min(1, Math.max(0, Number(input.importance)))
        : 0.8;
      const reason = typeof input.reason === 'string' && input.reason ? input.reason : 'state-update';
      const t = typeof input.now === 'function'
        ? Number(input.now())
        : (Number.isFinite(input.now) ? Number(input.now) : now());

      let outId = null;
      let updated = false;
      let inserted = false;
      let normalizedSlots = null;
      let committing = false;

      try {
        db.exec('BEGIN IMMEDIATE');
        ensureSpaceRow(spaceId, t);
        const existing = stmt.activeSlot.get(spaceId, slotKey);

        if (existing) {
          outId = existing.id;
          if (existing.content_hash === hash && existing.text === text) {
            db.prepare(
              'UPDATE main.memories SET updated_at = ?, last_accessed_at = ? WHERE id = ?',
            ).run(t, t, existing.id);
            committing = true;
            db.exec('COMMIT');
            derivedStamp = readSnapshotStamp();
            derivedEpoch = databaseEpoch();
            return {
              id: existing.id,
              updated: false,
              inserted: false,
              spaceId,
              slotKey,
              category: 'state',
              kind: 'event',
              tier: Number(existing.tier),
              contentHash: hash,
            };
          }

          // 内容变化：旧快照归入 memory_revisions，原地更新单活行，刷新槽位并失效旧向量
          stmt.insRev.run(
            existing.id,
            spaceId,
            slotKey,
            existing.text,
            existing.content_hash,
            reason,
            t,
          );
          normalizedSlots = extractNormalizedFacts(text, input.slots ?? input.facts);
          db.prepare(`UPDATE main.memories
            SET category = 'state',
                tier = 0,
                text = ?,
                content_hash = ?,
                source = COALESCE(?, source),
                importance = ?,
                facts_json = ?,
                updated_at = ?,
                last_accessed_at = ?
            WHERE id = ?`).run(
            text,
            hash,
            source,
            importance,
            JSON.stringify(normalizedSlots),
            t,
            t,
            existing.id,
          );
          replaceSlotsInternal(existing.id, spaceId, normalizedSlots, t);
          db.prepare('DELETE FROM main.vectors WHERE memory_id = ?').run(existing.id);
          const ordRow = stmt.rowidOf.get(existing.id);
          if (ordRow) {
            stmt.insSeg.run(ordRow.ord, packCovered(splitSegments(text).length));
            derivedTexts.set(ordRow.ord, text);
          }
          bumpDataGeneration();
          updated = true;
        } else {
          let candidateId = typeof input.id === 'string' && input.id ? input.id : makeStateId(spaceId, slotKey);
          if (stmt.byId.get(candidateId)) {
            candidateId = `${candidateId}-${t.toString(36)}`;
          }
          outId = candidateId;
          normalizedSlots = extractNormalizedFacts(text, input.slots ?? input.facts);
          const ord = Number(
            stmt.insMem.run(
              outId,
              spaceId,
              'state',
              TIER_L0,
              slotKey,
              text,
              hash,
              source,
              'active',
              null,
              '[]',
              JSON.stringify(normalizedSlots),
              0,
              0,
              importance,
              t,
              t,
              t,
            ).lastInsertRowid,
          );
          replaceSlotsInternal(outId, spaceId, normalizedSlots, t);
          stmt.insSeg.run(ord, packCovered(splitSegments(text).length));
          derivedTexts.set(ord, text);
          bumpDataGeneration();
          updated = true;
          inserted = true;
        }

        committing = true;
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) {
          try { db.exec('ROLLBACK'); }
          catch (cleanup) { throw failStore(new AggregateError([err, cleanup], 'putState and cleanup failed')); }
        } else if (committing) {
          throw failStore(err);
        }
        throw err;
      }

      if (normalizedSlots) syncMemFactsForId(outId, normalizedSlots);
      derivedStamp = readSnapshotStamp();
      derivedEpoch = databaseEpoch();

      return {
        id: outId,
        updated,
        inserted,
        spaceId,
        slotKey,
        category: 'state',
        kind: 'event',
        tier: TIER_L0,
        contentHash: hash,
      };
    }

    // ── 3. 实体槽位表（replaceSlots / querySlots） ───────────────────────────

    function replaceSlots(memoryId, spaceId = 'global', slots = [], ts) {
      assertOpen();
      if (!memoryId || typeof memoryId !== 'string') {
        throw new TypeError('replaceSlots: memoryId 必须是非空字符串');
      }
      const inTx = db.isTransaction;
      const t = Number.isFinite(ts) ? ts : now();
      let normalized = [];
      try {
        if (!inTx) db.exec('BEGIN IMMEDIATE');
        normalized = replaceSlotsInternal(memoryId, spaceId, slots, t);
        if (!inTx) {
          bumpDataGeneration();
          db.exec('COMMIT');
        }
      } catch (err) {
        if (!inTx && db.isTransaction) {
          try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        }
        throw err;
      }
      syncMemFactsForId(memoryId, normalized);
      if (!inTx) {
        derivedStamp = readSnapshotStamp();
        derivedEpoch = databaseEpoch();
      }
      return normalized.length;
    }

    function querySlots(qOpts = {}) {
      assertOpen();
      const spaces = Array.isArray(qOpts.spaces) && qOpts.spaces.length
        ? qOpts.spaces.map(String)
        : (typeof qOpts.spaceId === 'string' && qOpts.spaceId ? [qOpts.spaceId] : null);
      const activeOnly = qOpts.activeOnly !== false;
      const limit = clampQueryLimit(qOpts.limit, 100, 10000);

      const clauses = [];
      const params = [];
      if (activeOnly) clauses.push("m.status = 'active'");
      if (spaces) {
        clauses.push(`s.space_id IN (${spaces.map(() => '?').join(', ')})`);
        params.push(...spaces);
      }
      if (qOpts.entity !== undefined && qOpts.entity !== null) {
        clauses.push('s.entity = ?');
        params.push(String(qOpts.entity));
      }
      if (qOpts.attr !== undefined && qOpts.attr !== null) {
        clauses.push('s.attr = ?');
        params.push(String(qOpts.attr));
      }
      // 属性前缀范围查（走 attr 索引，仍是 O(log N)）：用于实体被连写进 attr 的写入形态
      if (typeof qOpts.attrPrefix === 'string' && qOpts.attrPrefix) {
        clauses.push('s.attr >= ? AND s.attr < ?');
        params.push(qOpts.attrPrefix, `${qOpts.attrPrefix}\uffff`);
      }
      if (qOpts.value !== undefined && qOpts.value !== null) {
        clauses.push('s.value = ?');
        params.push(String(qOpts.value));
      }
      if (qOpts.memoryId !== undefined && qOpts.memoryId !== null) {
        clauses.push('s.memory_id = ?');
        params.push(String(qOpts.memoryId));
      }

      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const joinSql = activeOnly ? 'JOIN main.memories m ON m.id = s.memory_id' : '';
      params.push(limit);

      const sql = `
        SELECT s.slot_id AS slotId, s.memory_id AS memoryId, s.space_id AS spaceId,
               s.entity, s.attr, s.value, s.unit, s.polarity, s.confidence, s.quote,
               s.created_at AS createdAt
        FROM main.entity_slots s
        ${joinSql}
        ${whereSql}
        ORDER BY s.created_at DESC, s.slot_id DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(...params);
    }

    // ── 4. 显式主键向量表（vectors：根除 VACUUM rowid 漂移 + 兼容旧接口） ─────

    function putVector(input = {}) {
      assertOpen();
      const memoryId = typeof input.memoryId === 'string' ? input.memoryId : '';
      if (!memoryId) throw new TypeError('putVector: memoryId 必须是非空字符串');
      if (!input.vec) throw new TypeError('putVector: vec 不能为空');

      const mem = stmt.byId.get(memoryId);
      if (!mem || mem.status !== 'active') {
        return { written: false, reason: 'missing_or_inactive' };
      }
      if (input.expectedContentHash !== undefined && mem.content_hash !== String(input.expectedContentHash)) {
        return { written: false, reason: 'content_hash_mismatch' };
      }

      const q = input.vec instanceof Int8Array
        ? {
          vec: input.vec,
          scale: Number.isFinite(input.scale) && input.scale > 0 ? Number(input.scale) : DEFAULT_SCALE,
        }
        : (input.vec instanceof Uint8Array
          ? {
            vec: new Int8Array(input.vec.buffer, input.vec.byteOffset, input.vec.byteLength),
            scale: Number.isFinite(input.scale) && input.scale > 0 ? Number(input.scale) : DEFAULT_SCALE,
          }
          : quantizeWithScale(input.vec, input.scale));

      const dims = Number.isInteger(input.dims) && input.dims > 0 ? input.dims : q.vec.length;
      if (dims !== q.vec.length || dims === 0) {
        throw new RangeError(`putVector: dims(${dims}) 与向量长度(${q.vec.length})不符`);
      }

      const spaceId = typeof input.spaceId === 'string' && input.spaceId ? input.spaceId : mem.space_id;
      const model = typeof input.model === 'string' && input.model ? input.model : 'default';
      const cHash = typeof input.contentHash === 'string' && input.contentHash
        ? input.contentHash
        : mem.content_hash;
      const t = Number.isFinite(input.now) ? input.now : now();
      const blob = new Uint8Array(q.vec.buffer, q.vec.byteOffset, q.vec.byteLength);

      db.prepare(`INSERT OR REPLACE INTO main.vectors
        (memory_id, space_id, model, dims, scale, vec, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        memoryId,
        spaceId,
        model,
        dims,
        q.scale,
        blob,
        cHash,
        t,
      );

      return {
        written: true,
        memoryId,
        spaceId,
        model,
        dims,
        scale: q.scale,
        contentHash: cHash,
      };
    }

    function putEmbedding(memoryId, vec, eOpts = {}) {
      return putVector({
        memoryId,
        vec,
        spaceId: eOpts.spaceId,
        model: eOpts.model,
        dims: eOpts.dims,
        scale: eOpts.scale,
        contentHash: eOpts.contentHash,
        expectedContentHash: eOpts.expectedContentHash,
        now: eOpts.now,
      });
    }

    function getVectors(vOpts = {}) {
      assertOpen();
      const spaces = Array.isArray(vOpts.spaces) && vOpts.spaces.length
        ? vOpts.spaces.map(String)
        : (typeof vOpts.spaceId === 'string' && vOpts.spaceId ? [vOpts.spaceId] : null);
      const activeOnly = vOpts.activeOnly !== false;
      const clauses = [];
      const params = [];

      if (activeOnly) {
        clauses.push("m.status = 'active'");
        clauses.push('v.content_hash = m.content_hash');
      }
      if (spaces) {
        clauses.push(`v.space_id IN (${spaces.map(() => '?').join(', ')})`);
        params.push(...spaces);
      }
      if (Number.isInteger(vOpts.dims) && vOpts.dims > 0) {
        clauses.push('v.dims = ?');
        params.push(vOpts.dims);
      }
      if (typeof vOpts.model === 'string' && vOpts.model) {
        clauses.push("(v.model = ? OR v.model = 'default')");
        params.push(vOpts.model);
      }

      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT v.memory_id, v.space_id, v.model, v.dims, v.scale, v.vec, v.content_hash, v.updated_at
        FROM main.vectors v
        JOIN main.memories m ON m.id = v.memory_id
        ${whereSql}
        ORDER BY v.memory_id ASC
      `).all(...params);

      return rows.map((r) => {
        const bytesBuf = r.vec instanceof Uint8Array ? r.vec : new Uint8Array(r.vec);
        const signed = new Int8Array(bytesBuf.byteLength);
        signed.set(new Int8Array(bytesBuf.buffer, bytesBuf.byteOffset, bytesBuf.byteLength));
        return {
          memoryId: r.memory_id,
          spaceId: r.space_id,
          model: r.model,
          dims: Number(r.dims),
          scale: Number(r.scale),
          vec: signed,
          contentHash: r.content_hash,
          updatedAt: Number(r.updated_at),
        };
      });
    }

    function missingVectors(mOpts = {}) {
      assertOpen();
      const dims = Number.isInteger(mOpts.dims) && mOpts.dims > 0 ? mOpts.dims : 128;
      const model = typeof mOpts.model === 'string' && mOpts.model ? mOpts.model : 'default';
      const spaces = Array.isArray(mOpts.spaces) && mOpts.spaces.length ? mOpts.spaces.map(String) : null;
      const params = [dims, model];
      let spaceClause = '';
      if (spaces) {
        spaceClause = ` AND m.space_id IN (${spaces.map(() => '?').join(', ')})`;
        params.push(...spaces);
      }
      return db.prepare(`
        SELECT m.id, m.space_id AS spaceId, m.text, m.content_hash AS contentHash
        FROM main.memories m
        LEFT JOIN main.vectors v ON v.memory_id = m.id
        WHERE m.status = 'active'
          AND (
            v.memory_id IS NULL
            OR v.content_hash != m.content_hash
            OR v.dims != ?
            OR (v.model != ? AND v.model != 'default')
          )${spaceClause}
        ORDER BY m.created_at ASC, m.id ASC
      `).all(...params);
    }

    /**
     * 删除向量：
     *   - 传入 memoryId：按主键精准删除单条向量；
     *   - 不传参数（兼容旧 v7 全表清空签名）：清空全部向量。
     */
    function deleteVector(memoryId) {
      assertOpen();
      if (memoryId !== undefined && memoryId !== null && memoryId !== '') {
        return db.prepare('DELETE FROM main.vectors WHERE memory_id = ?').run(String(memoryId)).changes > 0;
      }
      return db.prepare('DELETE FROM main.vectors').run().changes > 0;
    }

    /** 兼容旧批量写入接口：Map<id, Int8Array> 或 [[id, Int8Array]] -> 写入新 vectors 表。 */
    function putVectors(entries, vOpts = {}) {
      assertOpen();
      const list = entries instanceof Map ? [...entries.entries()] : [...(entries ?? [])];
      if (!list.length) return 0;
      const t = Number.isFinite(vOpts.now) ? vOpts.now : now();
      let written = 0;
      const inTx = db.isTransaction;
      if (!inTx) db.exec('BEGIN IMMEDIATE');
      try {
        for (const item of list) {
          if (Array.isArray(item)) {
            const [id, vec] = item;
            if (!id || !vec || !vec.length) continue;
            const res = putVector({
              memoryId: String(id),
              vec,
              model: vOpts.model,
              scale: vOpts.scale,
              now: t,
            });
            if (res.written) written += 1;
          } else if (item && typeof item === 'object' && item.memoryId) {
            const res = putVector({ ...item, now: item.now ?? t });
            if (res.written) written += 1;
          }
        }
        if (!inTx) db.exec('COMMIT');
      } catch (err) {
        if (!inTx && db.isTransaction) try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      return written;
    }

    /** 兼容旧全量读取接口：返回 Map<memoryId, Int8Array>（严格按 memory_id 精确映射）。 */
    function allVectors(dim = 0, vOpts = {}) {
      assertOpen();
      const d = Number.isInteger(dim) && dim > 0 ? dim : undefined;
      const rows = getVectors({ dims: d, spaces: vOpts.spaces, spaceId: vOpts.spaceId, model: vOpts.model });
      const out = new Map();
      for (const r of rows) {
        out.set(r.memoryId, r.vec);
      }
      return out;
    }

    function vectorSearch(queryVec, sOpts = {}) {
      assertOpen();
      if (!queryVec) return [];
      const qSigned = queryVec instanceof Int8Array
        ? queryVec
        : (queryVec instanceof Uint8Array
          ? asSignedVec(queryVec)
          : quantizeWithScale(queryVec).vec);
      if (!qSigned || !qSigned.length) return [];

      const topK = clampQueryLimit(sOpts.topK, 20, 10000);
      const minScore = Number.isFinite(sOpts.minScore) ? Number(sOpts.minScore) : -Infinity;
      const spaces = Array.isArray(sOpts.spaces) && sOpts.spaces.length
        ? sOpts.spaces.map(String)
        : (typeof sOpts.spaceId === 'string' && sOpts.spaceId ? [sOpts.spaceId] : null);

      const clauses = ["m.status = 'active'", 'v.content_hash = m.content_hash', 'v.dims = ?'];
      const params = [qSigned.length];
      if (spaces) {
        clauses.push(`v.space_id IN (${spaces.map(() => '?').join(', ')})`);
        params.push(...spaces);
      }
      if (typeof sOpts.model === 'string' && sOpts.model) {
        clauses.push("(v.model = ? OR v.model = 'default')");
        params.push(sOpts.model);
      }

      const rows = db.prepare(`
        SELECT v.memory_id, v.space_id, v.vec, v.content_hash,
               m.text, m.category, m.tier, m.slot_key, m.source, m.importance, m.created_at
        FROM main.vectors v
        JOIN main.memories m ON m.id = v.memory_id
        WHERE ${clauses.join(' AND ')}
      `).all(...params);

      const scored = [];
      for (const r of rows) {
        const vec = asSignedVec(r.vec);
        const score = cosineInt8(qSigned, vec);
        if (score < minScore) continue;
        const category = normalizeCategory(r.category);
        scored.push({
          id: r.memory_id,
          memoryId: r.memory_id,
          spaceId: r.space_id,
          score,
          text: r.text,
          category,
          kind: categoryToKind(category),
          tier: Number(r.tier),
          slotKey: r.slot_key ?? null,
          source: r.source ?? null,
          importance: Number(r.importance),
          createdAt: Number(r.created_at),
          contentHash: r.content_hash,
        });
      }
      scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return scored.slice(0, topK);
    }

    function vectorStats() {
      assertOpen();
      const row = db.prepare(`
        SELECT COUNT(*) AS rows,
               COALESCE(MAX(dims), 0) AS dims,
               COALESCE(SUM(LENGTH(vec)), 0) AS bytes
        FROM main.vectors
      `).get();
      return {
        rows: Number(row?.rows ?? 0),
        dims: Number(row?.dims ?? 0),
        bytes: Number(row?.bytes ?? 0),
      };
    }

    // ── 5. 持久化 Wiki 综合页（wiki_pages） ──────────────────────────────────

    function upsertWikiPage(input = {}) {
      assertOpen();
      if (db.isTransaction) throw new Error('upsertWikiPage requires an idle connection');
      const spaceId = typeof input.spaceId === 'string' && input.spaceId.trim()
        ? input.spaceId.trim()
        : 'global';
      const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
      if (!slug) throw new TypeError('upsertWikiPage: slug 必须是非空字符串');
      const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : slug;
      const summary = typeof input.summary === 'string' ? input.summary : '';
      const sourceIds = Array.isArray(input.sourceIds) ? input.sourceIds.map(String) : [];
      const dirty = input.dirty ? 1 : 0;
      const t = Number.isFinite(input.now) ? input.now : now();

      let pageId = typeof input.pageId === 'string' && input.pageId.trim()
        ? input.pageId.trim()
        : `wiki:${spaceId}:${slug}`;

      db.exec('BEGIN IMMEDIATE');
      try {
        ensureSpaceRow(spaceId, t);
        const existing = db.prepare(
          'SELECT * FROM main.wiki_pages WHERE (space_id = ? AND slug = ?) OR page_id = ? LIMIT 1',
        ).get(spaceId, slug, pageId);

        if (existing) {
          pageId = existing.page_id;
          const nextVersion = Number.isInteger(input.version) && input.version > 0
            ? input.version
            : Number(existing.version) + 1;
          db.prepare(`UPDATE main.wiki_pages
            SET space_id = ?, slug = ?, title = ?, summary = ?, source_ids = ?,
                dirty = ?, version = ?, updated_at = ?
            WHERE page_id = ?`).run(
            spaceId,
            slug,
            title,
            summary,
            JSON.stringify(sourceIds),
            dirty,
            nextVersion,
            t,
            pageId,
          );
        } else {
          const initVersion = Number.isInteger(input.version) && input.version > 0 ? input.version : 1;
          db.prepare(`INSERT INTO main.wiki_pages
            (page_id, space_id, slug, title, summary, source_ids, dirty, version, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            pageId,
            spaceId,
            slug,
            title,
            summary,
            JSON.stringify(sourceIds),
            dirty,
            initVersion,
            t,
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }

      const saved = db.prepare('SELECT * FROM main.wiki_pages WHERE page_id = ?').get(pageId);
      return {
        pageId: saved.page_id,
        spaceId: saved.space_id,
        slug: saved.slug,
        title: saved.title,
        summary: saved.summary,
        sourceIds: safeParseJsonArray(saved.source_ids),
        dirty: Boolean(saved.dirty),
        version: Number(saved.version),
        updatedAt: Number(saved.updated_at),
      };
    }

    function listWikiPages(wOpts = {}) {
      assertOpen();
      const spaces = Array.isArray(wOpts.spaces) && wOpts.spaces.length
        ? wOpts.spaces.map(String)
        : (typeof wOpts.spaceId === 'string' && wOpts.spaceId ? [wOpts.spaceId] : null);
      const clauses = [];
      const params = [];
      if (spaces) {
        clauses.push(`space_id IN (${spaces.map(() => '?').join(', ')})`);
        params.push(...spaces);
      }
      if (wOpts.dirtyOnly) {
        clauses.push('dirty = 1');
      }
      const limit = clampQueryLimit(wOpts.limit, 200, 10000);
      params.push(limit);
      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(
        `SELECT * FROM main.wiki_pages ${whereSql} ORDER BY updated_at DESC, slug ASC LIMIT ?`,
      ).all(...params).map((r) => ({
        pageId: r.page_id,
        spaceId: r.space_id,
        slug: r.slug,
        title: r.title,
        summary: r.summary,
        sourceIds: safeParseJsonArray(r.source_ids),
        dirty: Boolean(r.dirty),
        version: Number(r.version),
        updatedAt: Number(r.updated_at),
      }));
    }

    function markWikiClean(pageId, ts) {
      assertOpen();
      if (!pageId) return false;
      const t = Number.isFinite(ts) ? ts : now();
      const res = db.prepare('UPDATE main.wiki_pages SET dirty = 0, updated_at = ? WHERE page_id = ?').run(
        t,
        String(pageId),
      );
      return res.changes > 0;
    }

    // ── 6. 持久化采集队列（ingest_queue：幂等入队 + 原子认领 + 结单恢复） ────

    function enqueueIngest(input = {}) {
      assertOpen();
      if (db.isTransaction) throw new Error('enqueueIngest requires an idle connection');
      const spaceId = typeof input.spaceId === 'string' && input.spaceId.trim()
        ? input.spaceId.trim()
        : 'global';
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
      if (!sessionId) throw new TypeError('enqueueIngest: sessionId 必须是非空字符串');
      if (!Number.isSafeInteger(input.turnNo) || input.turnNo < 0) {
        throw new TypeError('enqueueIngest: turnNo 必须是非负安全整数');
      }
      const payloadJson = typeof input.payload === 'string'
        ? input.payload
        : JSON.stringify(input.payload ?? {});
      const t = Number.isFinite(input.now) ? input.now : now();

      let result;
      db.exec('BEGIN IMMEDIATE');
      try {
        ensureSpaceRow(spaceId, t);
        const existing = db.prepare(
          'SELECT * FROM main.ingest_queue WHERE session_id = ? AND turn_no = ?',
        ).get(sessionId, input.turnNo);

        if (!existing) {
          const ins = db.prepare(`INSERT INTO main.ingest_queue
            (space_id, session_id, turn_no, payload_json, status, attempts, error, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`).run(
            spaceId,
            sessionId,
            input.turnNo,
            payloadJson,
            t,
            t,
          );
          result = {
            jobId: Number(ins.lastInsertRowid),
            enqueued: true,
            updated: false,
            status: 'pending',
          };
        } else if (existing.status === 'pending' || existing.status === 'failed') {
          db.prepare(`UPDATE main.ingest_queue
            SET space_id = ?, payload_json = ?, status = 'pending', error = NULL, updated_at = ?
            WHERE job_id = ?`).run(spaceId, payloadJson, t, existing.job_id);
          result = {
            jobId: Number(existing.job_id),
            enqueued: true,
            updated: true,
            status: 'pending',
          };
        } else {
          result = {
            jobId: Number(existing.job_id),
            enqueued: false,
            updated: false,
            status: existing.status,
          };
        }
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      return result;
    }

    function claimIngestJobs(limit = 10, ts, cOpts = {}) {
      assertOpen();
      if (db.isTransaction) throw new Error('claimIngestJobs requires an idle connection');
      const n = clampQueryLimit(limit, 10, 1000);
      const t = Number.isFinite(ts) ? ts : now();
      const staleMs = Number.isFinite(cOpts.staleMs) && cOpts.staleMs >= 0 ? cOpts.staleMs : 300_000;
      const maxAttempts = Number.isInteger(cOpts.maxAttempts) && cOpts.maxAttempts > 0 ? cOpts.maxAttempts : 5;

      let claimed = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const candidates = db.prepare(`
          SELECT * FROM main.ingest_queue
          WHERE (
            status = 'pending'
            OR (status = 'processing' AND updated_at <= ?)
          ) AND attempts < ?
          ORDER BY created_at ASC, job_id ASC
          LIMIT ?
        `).all(t - staleMs, maxAttempts, n);

        const upd = db.prepare(
          "UPDATE main.ingest_queue SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE job_id = ?",
        );
        for (const row of candidates) {
          upd.run(t, row.job_id);
          let parsedPayload = null;
          try { parsedPayload = JSON.parse(row.payload_json); } catch { parsedPayload = row.payload_json; }
          claimed.push({
            jobId: Number(row.job_id),
            spaceId: row.space_id,
            sessionId: row.session_id,
            turnNo: Number(row.turn_no),
            payload: parsedPayload,
            payloadJson: row.payload_json,
            status: 'processing',
            attempts: Number(row.attempts) + 1,
            error: row.error ?? null,
            createdAt: Number(row.created_at),
            updatedAt: t,
          });
        }
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      return claimed;
    }

    // Release only leases still owned by this claim; cancellation is not a failed attempt.
    // The attempts + updated_at fence prevents an old consumer releasing a newer claim.
    function releaseIngestJobs(jobs = [], ts) {
      assertOpen();
      const t = Number.isFinite(ts) ? ts : now();
      const release = db.prepare(`UPDATE main.ingest_queue
        SET status = 'pending', attempts = MAX(0, attempts - 1), error = NULL, updated_at = ?
        WHERE job_id = ? AND status = 'processing' AND attempts = ? AND updated_at = ?`);
      let released = 0;
      for (const job of jobs) {
        released += Number(release.run(t, job.jobId, job.attempts, job.updatedAt).changes);
      }
      return { released };
    }

    function completeIngestJob(jobId, status = 'done', error = null, ts) {
      assertOpen();
      const jid = Number(jobId);
      if (!Number.isSafeInteger(jid) || jid <= 0) {
        throw new TypeError('completeIngestJob: jobId 必须是正整数');
      }
      const normStatus = status === 'completed' || status === 'succeeded'
        ? 'done'
        : String(status || 'done');
      const errText = error == null ? null : (error instanceof Error ? error.message : String(error));
      const t = Number.isFinite(ts) ? ts : now();
      const res = db.prepare(
        'UPDATE main.ingest_queue SET status = ?, error = ?, updated_at = ? WHERE job_id = ?',
      ).run(normStatus, errText, t, jid);
      return {
        jobId: jid,
        status: normStatus,
        error: errText,
        updated: res.changes > 0,
      };
    }

    // ── 7. 记忆修订历史与生命周期压缩（listRevisions / compactMemory） ───────

    function listRevisions(memoryId, rOpts = {}) {
      assertOpen();
      if (!memoryId) return [];
      const limit = clampQueryLimit(rOpts.limit, 100, 10000);
      return stmt.listRevs.all(String(memoryId), limit);
    }

    function compactMemory(input = {}) {
      assertOpen();
      if (db.isTransaction) throw new Error('compactMemory requires an idle connection');
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id) throw new TypeError('compactMemory: id 必须是非空字符串');

      const row = stmt.byId.get(id);
      if (!row) return null;

      const t = Number.isFinite(input.now) ? input.now : now();
      const reason = typeof input.reason === 'string' && input.reason ? input.reason : 'lifecycle-compact';
      const hasNewText = typeof input.newText === 'string' && input.newText.trim().length > 0;
      if (hasNewText && hasUnpairedSurrogate(input.newText)) {
        throw new TypeError('compactMemory: newText contains unpaired UTF-16 surrogate');
      }

      const textChanged = hasNewText && input.newText !== row.text;
      const nextText = textChanged ? input.newText : row.text;
      const nextHash = textChanged ? contentHash(nextText) : row.content_hash;
      const nextTier = Number.isInteger(input.newTier) ? input.newTier : Number(row.tier);
      const nextStatus = typeof input.newStatus === 'string' && MEMORY_STATUSES.includes(input.newStatus)
        ? input.newStatus
        : row.status;
      const nextSupersededBy = input.supersededBy !== undefined
        ? (input.supersededBy == null ? null : String(input.supersededBy))
        : row.superseded_by;

      let normalizedSlots = null;
      let committing = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        if (textChanged) {
          stmt.insRev.run(
            row.id,
            row.space_id,
            row.slot_key,
            row.text,
            row.content_hash,
            reason,
            t,
          );
          normalizedSlots = extractNormalizedFacts(nextText);
          replaceSlotsInternal(row.id, row.space_id, normalizedSlots, t);
          db.prepare('DELETE FROM main.vectors WHERE memory_id = ?').run(row.id);
        } else if (nextStatus !== 'active' || nextTier >= TIER_L3) {
          // 归档、被取代或下沉至冷归档层时释放向量占用
          db.prepare('DELETE FROM main.vectors WHERE memory_id = ?').run(row.id);
        }

        db.prepare(`UPDATE main.memories
          SET text = ?,
              content_hash = ?,
              tier = ?,
              status = ?,
              superseded_by = ?,
              facts_json = COALESCE(?, facts_json),
              updated_at = ?
          WHERE id = ?`).run(
          nextText,
          nextHash,
          nextTier,
          nextStatus,
          nextSupersededBy,
          normalizedSlots ? JSON.stringify(normalizedSlots) : null,
          t,
          id,
        );

        if (textChanged) {
          const ordRow = stmt.rowidOf.get(id);
          if (ordRow) {
            stmt.insSeg.run(ordRow.ord, packCovered(splitSegments(nextText).length));
            derivedTexts.set(ordRow.ord, nextText);
          }
        }
        bumpDataGeneration();
        committing = true;
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) {
          try { db.exec('ROLLBACK'); }
          catch (cleanup) { throw failStore(new AggregateError([err, cleanup], 'compactMemory and cleanup failed')); }
        } else if (committing) {
          throw failStore(err);
        }
        throw err;
      }

      if (normalizedSlots) syncMemFactsForId(id, normalizedSlots);
      derivedStamp = readSnapshotStamp();
      derivedEpoch = databaseEpoch();

      return toMemoryView(stmt.byId.get(id), { withFacts: true, includeCompatSnake: true });
    }

    // ── 8. 核心写入 / 删除 / 查询（双向兼容 v2 + v1 全套签名） ──────────────

    function forget({ ids = [], source, spaceId, dryRun = false } = {}) {
      assertOpen();
      if (db.isTransaction) throw new Error('forget requires an idle connection');
      if (source !== undefined && (typeof source !== 'string' || !source.length)) {
        throw new TypeError('forget source must be nonempty');
      }
      let committing = false;
      const forgotten = [];
      const retained = [];
      try {
        db.exec('BEGIN IMMEDIATE');
        let targets;
        if (source === undefined) {
          if (ids.length > 0 && spaceId) {
            const uniqueIds = [...new Set(ids.map(String))];
            const ph = uniqueIds.map(() => '?').join(', ');
            targets = db.prepare(
              `SELECT id FROM main.memories WHERE space_id = ? AND id IN (${ph})`,
            ).all(String(spaceId), ...uniqueIds).map((r) => r.id);
          } else if (ids.length > 0) {
            targets = [...new Set(ids.map(String))];
          } else if (spaceId) {
            targets = db.prepare(
              'SELECT id FROM main.memories WHERE space_id = ?',
            ).all(String(spaceId)).map((r) => r.id);
          } else {
            targets = [];
          }
        } else if (spaceId) {
          targets = db.prepare(
            'SELECT id FROM main.memories WHERE source = ? AND space_id = ?',
          ).all(source, String(spaceId)).map((r) => r.id);
        } else {
          targets = db.prepare('SELECT id FROM main.memories WHERE source = ?').all(source).map((r) => r.id);
        }

        const delStmt = db.prepare('DELETE FROM main.memories WHERE id = ?');
        for (const id of targets) {
          if (delStmt.run(id).changes) {
            stmt.delOccByMem.run(id);
            forgotten.push(id);
          }
        }
        if (forgotten.length > 0 && !dryRun) {
          bumpDataGeneration();
        }
        committing = !dryRun;
        db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
        if (db.isTransaction) throw new Error('forget cleanup left an active transaction');
      } catch (error) {
        if (db.isTransaction) {
          try { db.exec('ROLLBACK'); }
          catch (cleanup) { throw failStore(new AggregateError([error, cleanup], 'forget transaction and rollback failed')); }
        }
        if (committing || db.isTransaction) throw failStore(error);
        throw error;
      }
      if (!dryRun) {
        try {
          ensureFresh();
        } catch (error) {
          throw failStore(error);
        }
      }
      return { forgotten, retained, count: forgotten.length, dryRun };
    }

    function dropFactsOf(id) {
      const mid = String(id);
      const list = memFacts.byId.get(mid) || [];
      if (!list.length) return 0;
      factsRevision += 1;
      for (const f of list) {
        const slot = memFacts.slot.get(f.attr);
        if (slot) {
          const idx = slot.findIndex((x) => x.memoryId === mid && x.fact === f);
          if (idx >= 0) slot.splice(idx, 1);
        }
      }
      memFacts.total -= list.length;
      memFacts.byId.delete(mid);
      return list.length;
    }

    let putting = false;
    function put(input = {}) {
      assertOpen();
      putting = true;
      try {
        if (db.isTransaction) throw new Error('put requires an idle connection');
        const text = input.text;
        if (typeof text !== 'string' || text.length === 0) {
          throw new TypeError('put: text 必须是非空字符串');
        }
        if (hasUnpairedSurrogate(text)) throw new TypeError('put: text contains unpaired UTF-16 surrogate');

        const spaceId = typeof input.spaceId === 'string' && input.spaceId.trim()
          ? input.spaceId.trim()
          : 'global';
        const hash = contentHash(text);
        const source = input.source == null ? null : String(input.source);
        const occDocId = typeof input.documentId === 'string' && input.documentId.trim()
          ? input.documentId.trim()
          : null;
        const slotKey = input.slotKey == null || input.slotKey === '' ? null : String(input.slotKey);
        const chapter = Number.isSafeInteger(input.chapter) ? input.chapter : 0;
        const para = Number.isSafeInteger(input.para) ? input.para : 0;
        const occChapter = Number.isSafeInteger(input.chapter) && input.chapter > 0 ? input.chapter : null;
        const occPara = Number.isSafeInteger(input.para) && input.para > 0 ? input.para : null;

        const categoryExplicit = input.category !== undefined && input.category !== null && input.category !== '';
        const kindGiven = input.kind !== undefined && input.kind !== null && input.kind !== '';
        const category = categoryExplicit
          ? normalizeCategory(input.category, input.kind)
          : kindToCategory(normalizeKind(input.kind));
        const kind = categoryToKind(category);

        const tierGiven = input.tier != null && input.tier !== '' && Number.isFinite(Number(input.tier));
        if (!categoryExplicit && tierGiven && (kind === 'person' || kind === 'promise')
            && Number(input.tier) !== MEMORY_TIER_PINNED) {
          if (opts.strictPinnedTier === true) {
            throw new TypeError(
              `put: kind ${kind} 必须钉在 tier ${MEMORY_TIER_PINNED}，收到 tier ${String(input.tier)}`,
            );
          }
          warnPinnedTierClamp(kind, input.tier);
        }

        let tier;
        if (categoryExplicit) {
          tier = tierGiven
            ? Math.max(0, Math.min(MEMORY_TIER_MAX, Math.trunc(Number(input.tier))))
            : defaultCategoryTier(category);
        } else {
          tier = tierGiven ? normalizeTier(input.tier, kind) : defaultTier(kind);
        }

        const tNow = Number.isFinite(input.createdAt) ? input.createdAt : now();
        let committing = false;

        try {
          db.exec('BEGIN IMMEDIATE');
          if (!db.isTransaction) throw new Error('put begin did not start a transaction');
          ensureSpaceRow(spaceId, tNow);

          const hit = stmt.bySpaceHash.get(spaceId, hash);
          if (hit) {
            if (hit.text !== text) throw new Error(`put: content_hash 冲突（${hash}）`);
            const effectiveCategory = (categoryExplicit || kindGiven) ? category : normalizeCategory(hit.category);
            const effectiveKind = categoryToKind(effectiveCategory);
            let effectiveTier = Number(hit.tier);
            if (categoryExplicit) {
              effectiveTier = tierGiven ? tier : defaultCategoryTier(effectiveCategory);
            } else if (effectiveKind === 'person' || effectiveKind === 'promise') {
              effectiveTier = Number(hit.tier) === 0 ? 0 : MEMORY_TIER_PINNED;
            } else if (tierGiven) {
              effectiveTier = normalizeTier(input.tier, effectiveKind);
            }

            if (effectiveCategory !== hit.category || effectiveTier !== Number(hit.tier)) {
              stmt.setCatTier.run(effectiveCategory, effectiveTier, tNow, hit.id);
            } else {
              stmt.touchUpdated.run(tNow, hit.id);
            }
            if (!stmt.hasOcc.get(hit.id, source, occDocId, occChapter, occPara)) {
              stmt.insOcc.run(hit.id, source, occDocId, occChapter, occPara, tNow);
            }
            bumpDataGeneration();
            const factCount = factsOf(hit.id).length;
            committing = true;
            db.exec('COMMIT');
            if (db.isTransaction) throw new Error('put commit left an active transaction');
            derivedStamp = readSnapshotStamp();
            derivedEpoch = databaseEpoch();
            return {
              id: hit.id,
              inserted: false,
              factCount,
              spaceId,
              category: effectiveCategory,
              kind: effectiveKind,
              tier: effectiveTier,
              contentHash: hash,
            };
          }

          if (maxChars > 0) {
            let used = 0;
            for (const row of stmt.budgetTexts.iterate()) used += row.text.length;
            const verdict = checkBudget(used, maxChars, text.length);
            if (!verdict.ok) throw new BudgetExceededError(verdict);
          }

          const id = input.id ?? makeId(input.chapter, input.para, text);
          const importance = Number.isFinite(input.importance)
            ? Math.min(1, Math.max(0, Number(input.importance)))
            : (categoryExplicit ? 0.5 : 0);
          const supersedesList = input.supersedes == null
            ? []
            : (Array.isArray(input.supersedes) ? input.supersedes.map(String) : [String(input.supersedes)]);
          const supersedesJson = JSON.stringify(supersedesList);

          const normalizedSlots = extractNormalizedFacts(text, input.slots ?? input.facts);
          const factsJson = JSON.stringify(normalizedSlots);

          const ord = Number(
            stmt.insMem.run(
              id,
              spaceId,
              category,
              tier,
              slotKey,
              text,
              hash,
              source,
              'active',
              null,
              supersedesJson,
              factsJson,
              chapter,
              para,
              importance,
              tNow,
              tNow,
              tNow,
            ).lastInsertRowid,
          );

          for (const oldId of supersedesList) {
            stmt.setSupersededBy.run(id, tNow, oldId);
          }
          for (const nf of normalizedSlots) {
            stmt.insSlot.run(
              id,
              spaceId,
              nf.entity ?? '',
              nf.attr,
              nf.value,
              nf.unit,
              nf.polarity,
              nf.confidence,
              nf.quote,
              tNow,
            );
          }

          const segs = splitSegments(text);
          stmt.insSeg.run(ord, packCovered(segs.length));
          if (!stmt.hasOcc.get(id, source, occDocId, occChapter, occPara)) {
            stmt.insOcc.run(id, source, occDocId, occChapter, occPara, tNow);
          }
          bumpDataGeneration();

          committing = true;
          db.exec('COMMIT');
          if (db.isTransaction) throw new Error('put commit left an active transaction');

          syncMemFactsForId(id, normalizedSlots);
          derivedTexts.set(ord, text);
          derivedStamp = readSnapshotStamp();
          derivedEpoch = databaseEpoch();

          return {
            id,
            inserted: true,
            factCount: normalizedSlots.length,
            segmentCount: segs.length,
            spaceId,
            category,
            kind,
            tier,
            contentHash: hash,
          };
        } catch (err) {
          if (!db.isTransaction) {
            if (committing) throw failStore(err);
            throw err;
          }
          try { db.exec('ROLLBACK'); }
          catch (cleanup) { throw failStore(new AggregateError([err, cleanup], 'put and cleanup failed', { cause: err })); }
          if (db.isTransaction) {
            throw failStore(new AggregateError([err, new Error('put cleanup left an active transaction')], 'put and cleanup failed', { cause: err }));
          }
          throw err;
        }
      } finally {
        putting = false;
      }
    }

    function setKind(id, kindOrCategory) {
      assertOpen();
      if (db.isTransaction) throw new Error('setKind requires an idle connection');
      const key = String(id);
      const row = stmt.byId.get(key);
      if (!row) return null;

      const isCatArg = typeof kindOrCategory === 'string' && MEMORY_CATEGORIES.includes(kindOrCategory.trim().toLowerCase());
      const nextCategory = isCatArg
        ? normalizeCategory(kindOrCategory)
        : kindToCategory(normalizeKind(kindOrCategory));
      const nextKind = categoryToKind(nextCategory);

      const catBefore = normalizeCategory(row.category);
      const kindBefore = categoryToKind(catBefore);
      const tierBefore = isCatArg ? Number(row.tier) : normalizeTier(row.tier, kindBefore);
      const nextTier = isCatArg ? defaultCategoryTier(nextCategory) : defaultTier(nextKind);

      if (catBefore === nextCategory && Number(row.tier) === nextTier) {
        return {
          id: key,
          categoryBefore: catBefore,
          category: nextCategory,
          kindBefore,
          tierBefore,
          kind: nextKind,
          tier: nextTier,
          changed: false,
        };
      }

      let committing = false;
      const t = now();
      try {
        db.exec('BEGIN IMMEDIATE');
        stmt.setCatTier.run(nextCategory, nextTier, t, key);
        bumpDataGeneration();
        committing = true;
        db.exec('COMMIT');
        if (db.isTransaction) throw new Error('setKind commit left an active transaction');
      } catch (err) {
        if (!db.isTransaction) {
          if (committing) throw failStore(err);
          throw err;
        }
        try { db.exec('ROLLBACK'); }
        catch (cleanup) { throw failStore(new AggregateError([err, cleanup], 'setKind and cleanup failed', { cause: err })); }
        if (db.isTransaction) {
          throw failStore(new AggregateError([err, new Error('setKind cleanup left an active transaction')], 'setKind and cleanup failed', { cause: err }));
        }
        throw err;
      }

      derivedStamp = readSnapshotStamp();
      derivedEpoch = databaseEpoch();

      return {
        id: key,
        categoryBefore: catBefore,
        category: nextCategory,
        kindBefore,
        tierBefore,
        kind: nextKind,
        tier: nextTier,
        changed: true,
      };
    }

    function get(id, withFacts = true) {
      assertOpen();
      const row = stmt.byId.get(String(id));
      if (!row) return null;
      return toMemoryView(row, {
        includeText: true,
        withFacts: Boolean(withFacts),
        includeCompatSnake: true,
        nullEmptySupersedes: true,
      });
    }

    function list(lOpts = {}) {
      assertOpen();
      const limit = Number.isFinite(lOpts.limit) ? lOpts.limit : -1;
      const offset = Number.isFinite(lOpts.offset) ? lOpts.offset : 0;
      const dir = lOpts.order === 'desc' ? 'DESC' : 'ASC';
      const clauses = [];
      const params = [];

      if (lOpts.includeDeleted !== true) {
        clauses.push("status != 'deleted'");
      }
      if (lOpts.status) {
        clauses.push('status = ?');
        params.push(String(lOpts.status));
      }
      if (Array.isArray(lOpts.spaces) && lOpts.spaces.length) {
        clauses.push(`space_id IN (${lOpts.spaces.map(() => '?').join(', ')})`);
        params.push(...lOpts.spaces.map(String));
      } else if (typeof lOpts.spaceId === 'string' && lOpts.spaceId) {
        clauses.push('space_id = ?');
        params.push(lOpts.spaceId);
      }
      if (typeof lOpts.category === 'string' && lOpts.category) {
        clauses.push('category = ?');
        params.push(normalizeCategory(lOpts.category));
      }

      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(limit, offset);

      return db.prepare(
        `SELECT * FROM main.memories ${whereSql} ORDER BY created_at ${dir}, id ${dir} LIMIT ? OFFSET ?`,
      ).all(...params).map((r) => toMemoryView(r, {
        includeText: Boolean(lOpts.includeText),
        withFacts: Boolean(lOpts.withFacts),
        includeCompatSnake: true,
        nullEmptySupersedes: true,
      }));
    }

    const shapeQueryRow = (r) => {
      const category = normalizeCategory(r.category);
      return {
        id: r.id,
        spaceId: r.space_id,
        category,
        kind: categoryToKind(category),
        tier: Number(r.tier),
        slotKey: r.slot_key ?? null,
        status: r.status,
        contentHash: r.content_hash,
        text: r.text,
        importance: Number(r.importance) || 0,
        createdAt: Number(r.created_at) || 0,
        updatedAt: Number(r.updated_at) || 0,
        lastAccessed: Number(r.last_accessed_at) || 0,
        accessCount: Number(r.access_count) || 0,
        source: r.source == null ? null : r.source,
      };
    };

    function bySourcePrefix(prefix, limit = 50) {
      assertOpen();
      const n = clampQueryLimit(limit);
      const p = String(prefix ?? '');
      return stmt.bySourcePrefix.all(p, p, n).map(shapeQueryRow);
    }

    /** 返回记忆在当前连接已知的出现次数。 */
    function occurrenceCount(memoryId) {
      assertOpen();
      const row = stmt.byId.get(String(memoryId));
      if (!row || row.status === 'deleted') return 0;
      const cnt = Number(stmt.occCountByMem.get(row.id)?.cnt ?? 0);
      return cnt > 0 ? cnt : 1;
    }

    function occurrencesV1(memoryId) {
      assertOpen();
      const row = stmt.byId.get(String(memoryId));
      if (!row || row.status === 'deleted') return [];
      const occs = stmt.occByMem.all(row.id);
      if (occs.length > 0) {
        return occs.map((o) => ({
          memoryId: o.memory_id,
          source: o.source ?? null,
          documentId: o.document_id ?? null,
          chapter: o.chapter ?? null,
          para: o.para ?? null,
        }));
      }
      return [{
        memoryId: row.id,
        source: row.source ?? null,
        documentId: null,
        chapter: row.chapter > 0 ? row.chapter : null,
        para: row.para > 0 ? row.para : null,
      }];
    }

    function bySourcePrefixV1(prefix, limit = 50) {
      assertOpen();
      const n = clampQueryLimit(limit);
      const p = String(prefix ?? '');
      return stmt.occBySourcePrefix.all(p, p, n).map((r) => ({
        ...shapeQueryRow(r),
        source: r.occ_source ?? null,
        documentId: r.document_id ?? null,
        chapter: r.occ_chapter ?? null,
        para: r.occ_para ?? null,
      }));
    }

    function byKind(kind, limit = 50) {
      assertOpen();
      const n = clampQueryLimit(limit);
      if (typeof kind === 'string' && MEMORY_CATEGORIES.includes(kind.trim().toLowerCase())) {
        return stmt.byCategory.all(kind.trim().toLowerCase(), n).map(shapeQueryRow);
      }
      const k = normalizeKind(kind);
      if (k === 'promise') return stmt.byCategory.all('rule', n).map(shapeQueryRow);
      if (k === 'person') return stmt.byCategory.all('profile', n).map(shapeQueryRow);
      return stmt.byLegacyEventCats.all(n).map(shapeQueryRow);
    }

    function byCategory(category, optsOrLimit = 50) {
      assertOpen();
      const cat = normalizeCategory(category);
      if (optsOrLimit == null || typeof optsOrLimit === 'number') {
        const n = clampQueryLimit(optsOrLimit ?? 50);
        return stmt.byCategory.all(cat, n).map(shapeQueryRow);
      }
      const o = typeof optsOrLimit === 'object' ? optsOrLimit : {};
      const n = clampQueryLimit(o.limit ?? 50);
      const clauses = [
        o.includeInactive === true ? "status != 'deleted'" : "status = 'active'",
        'category = ?',
      ];
      const params = [cat];
      if (o.includeL3 !== true) {
        clauses.push('tier != 3');
      }
      if (Array.isArray(o.spaces) && o.spaces.length > 0) {
        const validSpaces = o.spaces.map((s) => String(s ?? '').trim()).filter(Boolean);
        if (validSpaces.length === 0) return [];
        clauses.push(`space_id IN (${validSpaces.map(() => '?').join(', ')})`);
        params.push(...validSpaces);
      } else if (typeof o.spaceId === 'string' && o.spaceId.trim() && o.spaceId.trim() !== 'all') {
        clauses.push('space_id = ?');
        params.push(o.spaceId.trim());
      } else if (o.includePrivate !== true) {
        clauses.push("space_id NOT LIKE 'session:%'");
      }
      params.push(n);
      return db
        .prepare(`SELECT * FROM main.memories WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ?`)
        .all(...params)
        .map(shapeQueryRow);
    }

    function updateAccess(id, when) {
      assertOpen();
      const t = Number.isFinite(when) ? when : now();
      stmt.touchAccess.run(t, String(id));
      return get(id, false);
    }

    function dump(dOpts = {}) {
      assertOpen();
      const clauses = [];
      const params = [];
      if (dOpts.includeDeleted !== true) {
        clauses.push("status != 'deleted'");
      }
      if (Array.isArray(dOpts.spaces) && dOpts.spaces.length) {
        clauses.push(`space_id IN (${dOpts.spaces.map(() => '?').join(', ')})`);
        params.push(...dOpts.spaces.map(String));
      } else if (typeof dOpts.spaceId === 'string' && dOpts.spaceId) {
        clauses.push('space_id = ?');
        params.push(dOpts.spaceId);
      }
      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM main.memories ${whereSql} ORDER BY created_at ASC, id ASC`).all(...params);

      const supersededByMap = new Map();
      for (const r of rows) {
        const listIds = safeParseJsonArray(r.supersedes_json);
        for (const oldId of listIds) {
          if (!supersededByMap.has(oldId)) supersededByMap.set(oldId, []);
          supersededByMap.get(oldId).push(r.id);
        }
      }

      return rows.map((r) => {
        const reverseList = supersededByMap.get(r.id)
          ?? (r.superseded_by ? [r.superseded_by] : null);
        return toMemoryView(r, {
          includeText: true,
          withFacts: true,
          includeCompatSnake: false,
          nullEmptySupersedes: true,
          supersededByOverride: reverseList,
        });
      });
    }

    function bytes() {
      assertOpen();
      if (isMemory) {
        const pageSize = db.prepare('PRAGMA page_size').get().page_size;
        const pageCount = db.prepare('PRAGMA page_count').get().page_count;
        return pageSize * pageCount;
      }
      let total = 0;
      for (const suffix of ['', '-wal', '-journal']) {
        const p = file + suffix;
        if (fs.existsSync(p)) total += fs.statSync(p).size;
      }
      return total;
    }

    function categoryCounts() {
      const out = Object.fromEntries(MEMORY_CATEGORIES.map((c) => [c, 0]));
      for (const row of db.prepare(
        "SELECT category, COUNT(*) AS n FROM main.memories WHERE status != 'deleted' GROUP BY category",
      ).all()) {
        out[normalizeCategory(row.category)] += Number(row.n) || 0;
      }
      return out;
    }

    function kindCounts() {
      const out = Object.fromEntries(MEMORY_KINDS.map((k) => [k, 0]));
      for (const row of db.prepare(
        "SELECT category, COUNT(*) AS n FROM main.memories WHERE status != 'deleted' GROUP BY category",
      ).all()) {
        out[categoryToKind(row.category)] += Number(row.n) || 0;
      }
      return out;
    }

    function tierCounts() {
      const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const row of db.prepare(
        "SELECT tier, category, COUNT(*) AS n FROM main.memories WHERE status != 'deleted' GROUP BY tier, category",
      ).all()) {
        const bucket = normalizeTier(row.tier, categoryToKind(row.category));
        out[bucket] += Number(row.n) || 0;
      }
      return out;
    }

    function lTierCounts() {
      const out = { 0: 0, 1: 0, 2: 0, 3: 0 };
      for (const row of db.prepare(
        "SELECT tier, COUNT(*) AS n FROM main.memories WHERE status != 'deleted' GROUP BY tier",
      ).all()) {
        const t = Math.max(0, Math.min(3, Math.trunc(Number(row.tier) || 0)));
        out[t] += Number(row.n) || 0;
      }
      return out;
    }

    function stats() {
      assertOpen();
      const s = stmt.sizes.get();
      const w = wear();
      const b = bytes();
      const vec = vectorStats();
      const pendingJobs = db.prepare(
        "SELECT COUNT(*) AS n FROM main.ingest_queue WHERE status IN ('pending', 'processing')",
      ).get().n;
      return {
        schemaVersion: STORE_SCHEMA_VERSION,
        dataGeneration: dataGeneration(),
        memories: stmt.countActive.get().n,
        categories: categoryCounts(),
        kinds: kindCounts(),
        tiers: tierCounts(),
        lTiers: lTierCounts(),
        facts: memFacts.total,
        vectors: vec.rows,
        pendingIngestJobs: Number(pendingJobs) || 0,
        textChars: s.chars,
        textBytes: s.bytes,
        bytes: b,
        limitBytes: storageLimitBytes,
        withinLimit: b <= storageLimitBytes,
        segments: w.segments,
        wornSegments: w.worn,
        wear: w.wear,
        maxChars,
      };
    }

    function close() {
      if (hybridPublishing) throw new Error('hybrid rebuild publication in progress');
      if (closeState === 'CLOSED') return;
      if (closeState === 'CLOSING') throw new Error('store close already in progress');
      closeState = 'CLOSING';
      try {
        db.close();
        closeState = 'CLOSED';
      } catch (error) {
        closeState = 'UNCERTAIN';
        throw error;
      }
    }

    function compact() {
      assertOpen();
      db.exec('VACUUM;');
      if (!isMemory) {
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* ignore */ }
      }
      return bytes();
    }

    // ── 段层兼容接口（基于 temp.segments 内存镜像，物理库零冗余） ────────────

    function expandSegs(row) {
      if (!row) return [];
      const n = bitsCount(row.bits);
      const out = [];
      for (let i = 1; i <= n; i += 1) {
        out.push({ memory_id: row.memory_id, seq: i, covered: bitAt(row.bits, i - 1) });
      }
      return out;
    }

    function segmentsOf(memoryId) {
      assertOpen();
      return expandSegs(stmt.segRow.get(String(memoryId)));
    }

    function segmentDump() {
      assertOpen();
      return stmt.allSegs.all()
        .sort((a, b) => a.created_at - b.created_at
          || (a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0))
        .flatMap((row) => expandSegs(row).map((s) => ({ ...s, created_at: row.created_at })));
    }

    function segmentTexts(memoryId) {
      assertOpen();
      const row = stmt.byId.get(String(memoryId));
      if (!row) return [];
      return splitSegments(row.text).map((text, i) => ({
        id: `${memoryId}/${i + 1}`,
        seq: i + 1,
        text,
        chars: text.length,
        hash: hashSegment(text),
      }));
    }

    function coverSegments(memoryId) {
      assertOpen();
      const row = stmt.segRow.get(String(memoryId));
      if (!row) return 0;
      const n = bitsCount(row.bits);
      stmt.coverMem.run(packAllCovered(n), String(memoryId));
      return n;
    }

    function wear() {
      assertOpen();
      let total = 0;
      let worn = 0;
      for (const row of stmt.allBits.all()) {
        const n = bitsCount(row.bits);
        total += n;
        for (let i = 0; i < n; i += 1) if (!bitAt(row.bits, i)) worn += 1;
      }
      if (total === 0) return { segments: 0, worn: 0, wear: 0 };
      return { segments: total, worn, wear: Number((worn / total).toFixed(4)) };
    }

    const api = {
      path: file,
      // v2 新增核心接口
      upsertSpace,
      listSpaces,
      putState,
      replaceSlots,
      querySlots,
      putVector,
      putEmbedding,
      getVectors,
      missingVectors,
      vectorSearch,
      upsertWikiPage,
      listWikiPages,
      markWikiClean,
      enqueueIngest,
      claimIngestJobs,
      releaseIngestJobs,
      completeIngestJob,
      listRevisions,
      compactMemory,
      byCategory,
      categoryCounts,
      lTierCounts,
      dataGeneration,
      occurrenceCount,
      // 存量 100% 兼容接口
      put,
      setKind,
      forget,
      contentVersion,
      get,
      list,
      bySourcePrefix,
      occurrencesV1,
      bySourcePrefixV1,
      byKind,
      updateAccess,
      dump,
      bytes,
      stats,
      tierCounts,
      compact,
      rebuildFacts,
      rebuildFactsHybrid,
      rebuildStats,
      dropFactsOf,
      putVectors,
      deleteVector,
      allVectors,
      vectorStats,
      factsSlot: (attr) => memFacts.slot.get(attr) || [],
      allFacts: () => {
        const out = [];
        for (const listItems of memFacts.byId.values()) {
          for (const f of listItems) out.push(f);
        }
        return out;
      },
      segmentsOf,
      segmentDump,
      segmentTexts,
      coverSegments,
      wear,
      maxChars,
      injectionSnapshot,
      close,
      raw: () => db,
    };

    const SKIP_FRESH = new Set([
      'close', 'raw', 'rebuildFactsHybrid',
      'put', 'putState', 'forget', 'setKind', 'updateAccess', 'coverSegments',
      'upsertSpace', 'replaceSlots', 'putVector', 'putEmbedding', 'putVectors', 'deleteVector',
      'upsertWikiPage', 'markWikiClean', 'enqueueIngest', 'claimIngestJobs', 'completeIngestJob',
      'compactMemory', 'injectionSnapshot', 'contentVersion', 'dataGeneration', 'compact', 'bytes',
    ]);

    for (const [name, fn] of Object.entries(api)) {
      if (typeof fn === 'function') {
        api[name] = (...args) => {
          if (name === 'raw') return fn(...args);
          if (putting) {
            const error = new Error('put operation in progress');
            if (name === 'rebuildFactsHybrid') return Promise.reject(error);
            throw error;
          }
          if (name === 'rebuildFactsHybrid') return fn(...args);
          if (name !== 'close') {
            assertOpen();
            if (!SKIP_FRESH.has(name)) ensureFresh();
          }
          return fn(...args);
        };
      }
    }

    derivedStamp = contentVersion();
    derivedEpoch = databaseEpoch();
    return api;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    throw err;
  }
}

export default {
  open,
  extractFacts,
  STORAGE_LIMIT_BYTES,
  STORE_SCHEMA_VERSION,
  MEMORY_CATEGORIES,
  DEFAULT_MEMORY_CATEGORY,
  MEMORY_KINDS,
  DEFAULT_MEMORY_KIND,
  MEMORY_STATUSES,
  normalizeCategory,
  kindToCategory,
  categoryToKind,
  defaultCategoryTier,
  isPinnedMemory,
  normalizeKind,
  MEMORY_TIER_PINNED,
  MEMORY_TIER_EVENT,
  MEMORY_TIER_MIN,
  MEMORY_TIER_MAX,
  TIER_L0,
  TIER_L1,
  TIER_L2,
  TIER_L3,
  defaultTier,
  normalizeTier,
  resetPinTierWarnings,
  TIER_IDLE_DAYS,
  TIER_PROMOTE_ACCESS,
  escapeLikePattern,
  entryUsage,
  checkBudget,
  BudgetExceededError,
  SPLIT_RE,
  splitSegments,
  contentHash,
};
