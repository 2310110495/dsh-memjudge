// memjudge 存储层：node:sqlite 单文件 + 写入时实体-属性-值三元组抽取。
//
// 三条硬约束来自 docs/SPEC.md：
//   - 能力 1：text 写入后一字不改，dump 必须与输入字符级相等
//   - 能力 1：同 text 重复写入幂等，不产生重复行
//   - 能力 7：20 章 29648 字全量写入后库文件 ≤ 200KB
//
// 体积上唯一的坑是幂等索引：若直接对 text 建 UNIQUE 索引，索引里要再存一份
// 29648 字（≈89KB），预算当场用掉一半。所以幂等键用 text_hash（16 位十六进制
// + 长度），命中后再比对 text 全文，冲突即抛错 —— 既省空间又不靠概率。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { makeId } from './schema.mjs';

export const STORE_SCHEMA_VERSION = 1;
export const STORAGE_LIMIT_BYTES = 200 * 1024;

// ---------------------------------------------------------------- 抽取

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

const ORG_TAIL = /([\u4e00-\u9fff]{2,8}(?:船级社|海事局|造船厂|船厂|保险公司|保险公估|研究院|设计院|委员会|协会|调查组|法庭|港务局|航运公司|有限公司|公司))/g;
const VESSEL = /([\u4e00-\u9fff]{2,5}号)/g;

const ROLES = [
  '船东代表', '货主代表', '值班水手', '轮机长', '大管轮', '二管轮', '三管轮',
  '水手长', '验船师', '质检员', '调查员', '公估人', '引航员', '电机员',
  '船长', '大副', '二副', '三副', '木匠', '大厨',
];
// 姓氏白名单是过滤「船长证书 / 大副收据 / 二副要去机」这类非人名的唯一可靠手段：
// 职务词后面的字不在姓氏表里就直接不认。
const SURNAME = '赵钱孙李周吴郑王冯陈蒋沈韩杨朱许何吕张孔曹严金魏陶姜谢邹苏潘葛范彭鲁韦马方俞任袁柳史唐薛雷贺倪汤罗毕郝安常傅余顾孟黄萧姚邵汪毛戴宋庞熊纪舒屈项董梁杜阮蓝季贾江郭林钟徐邱骆高夏蔡田樊胡凌霍万卢莫房解应丁邓郁单洪包左石崔龚程邢陆荣翁荀曲封靳段富焦侯全班秋仲伊宫宁武刘景詹龙叶黎白怀蒲鄂索赖卓屠蒙池乔翟谭劳姬申冉雍桑桂牛通边燕尚农温庄晏柴瞿阎慕连茹艾容向古易廖居衡步都耿满匡国文寇广禄东欧沃利越隆师巩聂晁融冷辛简饶曾沙鞠丰巢关查荆红游权盖益桓公哈';

const ROLE_RE = new RegExp(`(${ROLES.join('|')})([${SURNAME}][\\u4e00-\\u9fff]{1,2})`, 'g');
const ID_RE = /\b[A-Z]{2,5}(?:-[A-Z]{1,5})?-\d{4,6}(?:-[A-Z0-9]{2,8})+\b/g;
const COORD_RE = /(南纬|北纬|东经|西经)([零一二三四五六七八九十百千两]+度[零一二三四五六七八九十点两]+分)/g;

function stripAttr(raw) {
  let s = raw;
  for (let i = 0; i < 6; i++) {
    let t = s.replace(TAIL_STRIP, '');
    // 首部只剥不伤主体：剥完仍需剩 ≥2 字，否则「有效期」会被「有」啃成「效期」
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

// 实体只在能确定时填，抽不到就是 null —— 不猜。
function entityBefore(text, idx) {
  const win = text.slice(Math.max(0, idx - 60), idx);
  const orgs = [...win.matchAll(ORG_TAIL)];
  if (orgs.length) return orgs[orgs.length - 1][1];
  const ships = [...win.matchAll(VESSEL)];
  if (ships.length) return ships[ships.length - 1][1];
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
 *
 * @returns {Array<{entity:string|null, attr:string, key:string, value:string, unit:string|null, kind:string, at:number}>}
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
    const attr = cm[1] === '南纬' || cm[1] === '北纬' ? '纬度' : '经度';
    push({
      entity: entityBefore(text, cm.index),
      attr,
      key: attr.slice(-2),
      value: cm[2],
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
    // 「水手长老吴安…」抽出来的名字带着下一个字，尾字是虚词就退回 2 字
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

// ---------------------------------------------------------------- 幂等键

function hashText(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  const hex = (n) => n.toString(16).padStart(8, '0');
  return `${hex(h1)}${hex(h2)}-${s.length}`;
}

// ---------------------------------------------------------------- 表结构

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  text_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  access_count  INTEGER NOT NULL DEFAULT 0,
  importance    REAL NOT NULL DEFAULT 0,
  supersedes    TEXT,
  source        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_memories_hash ON memories(text_hash);
CREATE TABLE IF NOT EXISTS facts (
  memory_id TEXT NOT NULL,
  entity    TEXT,
  attr      TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  unit      TEXT,
  kind      TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_facts_key ON facts(key);
`;

// 体积预算是硬指标（20 章 ≤200KB），而 text 本身就要 88KB，
// 所以除幂等键外不建任何索引：20 行 memories / 数百行 facts 全表扫的开销
// 远小于索引占的页。ix_facts_key 保留，它是冲突检测与属性检索的入口，
// 且只索引 2 字属性键，代价极小。

// ---------------------------------------------------------------- Store

/**
 * 打开（或新建）一个库。
 *
 * @param {string} [dbPath] ':memory:' 或文件路径
 * @param {{now?: () => number}} [opts] now 供假时钟注入，默认 Date.now
 */
export function open(dbPath = ':memory:', opts = {}) {
  const isMemory = dbPath === ':memory:';
  const file = isMemory ? ':memory:' : path.resolve(dbPath);
  if (!isMemory) fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  // journal_mode=DELETE：关库后只剩单个 .db，字节统计不被 -wal 干扰
  if (!isMemory) db.exec('PRAGMA journal_mode = DELETE');
  db.exec(DDL);
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(STORE_SCHEMA_VERSION));

  const stmt = {
    byHash: db.prepare('SELECT id, text FROM memories WHERE text_hash = ?'),
    byId: db.prepare('SELECT * FROM memories WHERE id = ?'),
    insMem: db.prepare(`INSERT INTO memories
      (id, text, text_hash, created_at, last_accessed, access_count, importance, supersedes, source)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`),
    insFact: db.prepare('INSERT INTO facts (memory_id, entity, attr, key, value, unit, kind, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    touch: db.prepare('UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM memories'),
    countFacts: db.prepare('SELECT COUNT(*) AS n FROM facts'),
    sizes: db.prepare('SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes FROM memories'),
  };

  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error('store 已关闭');
  };

  function factsOf(id) {
    return db.prepare('SELECT entity, attr, key, value, unit, kind, at FROM facts WHERE memory_id = ? ORDER BY at').all(id)
      .map((f) => ({ ...f }));
  }

  /**
   * 写入一条记忆。同 text 重复写入不产生新行，直接返回已有 id。
   *
   * @param {{text:string, id?:string, chapter?:number, para?:number, createdAt?:number,
   *          importance?:number, supersedes?:string|string[]|null, source?:string}} input
   * @returns {{id:string, inserted:boolean, factCount:number}}
   */
  function put(input = {}) {
    assertOpen();
    const text = input.text;
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('put: text 必须是非空字符串');
    }
    const hash = hashText(text);
    const hit = stmt.byHash.get(hash);
    if (hit) {
      // 哈希相同但正文不同 → 撞了，宁可炸也不写坏数据
      if (hit.text !== text) throw new Error(`put: text_hash 冲突（${hash}）`);
      return { id: hit.id, inserted: false, factCount: factsOf(hit.id).length };
    }

    const id = input.id ?? makeId(input.chapter, input.para, text);
    const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : now();
    const importance = Number.isFinite(input.importance) ? input.importance : 0;
    const supersedes = input.supersedes == null
      ? null
      : JSON.stringify(Array.isArray(input.supersedes) ? input.supersedes : [input.supersedes]);
    const source = input.source == null ? null : String(input.source);

    db.exec('BEGIN');
    try {
      stmt.insMem.run(id, text, hash, createdAt, createdAt, importance, supersedes, source);
      const facts = extractFacts(text);
      for (const f of facts) {
        stmt.insFact.run(id, f.entity, f.attr, f.key, f.value, f.unit, f.kind, f.at);
      }
      db.exec('COMMIT');
      return { id, inserted: true, factCount: facts.length };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function get(id, withFacts = true) {
    assertOpen();
    const row = stmt.byId.get(id);
    if (!row) return null;
    return {
      ...row,
      supersedes: row.supersedes ? JSON.parse(row.supersedes) : null,
      facts: withFacts ? factsOf(id) : undefined,
    };
  }

  /** 列出条目（默认不含 text，省内存；需要正文时传 includeText） */
  function list(opts2 = {}) {
    assertOpen();
    const limit = Number.isFinite(opts2.limit) ? opts2.limit : -1;
    const offset = Number.isFinite(opts2.offset) ? opts2.offset : 0;
    const cols = opts2.includeText ? '*' : 'id, text_hash, created_at, last_accessed, access_count, importance, supersedes, source';
    return db.prepare(`SELECT ${cols} FROM memories ORDER BY created_at, id LIMIT ? OFFSET ?`).all(limit, offset)
      .map((r) => ({ ...r, supersedes: r.supersedes ? JSON.parse(r.supersedes) : null }));
  }

  /** 命中即刷新：last_accessed = now，access_count + 1 */
  function updateAccess(id, when) {
    assertOpen();
    const t = Number.isFinite(when) ? when : now();
    stmt.touch.run(t, id);
    return get(id, false);
  }

  /** 全量导出，按写入顺序。text 原样返回，供逐字往返校验 */
  function dump() {
    assertOpen();
    const rows = db.prepare('SELECT * FROM memories ORDER BY created_at, id').all();
    const supersededBy = new Map();
    for (const r of rows) {
      if (!r.supersedes) continue;
      for (const oldId of JSON.parse(r.supersedes)) {
        if (!supersededBy.has(oldId)) supersededBy.set(oldId, []);
        supersededBy.get(oldId).push(r.id);
      }
    }
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      createdAt: r.created_at,
      lastAccessed: r.last_accessed,
      accessCount: r.access_count,
      importance: r.importance,
      supersedes: r.supersedes ? JSON.parse(r.supersedes) : null,
      supersededBy: supersededBy.get(r.id) ?? null,
      source: r.source,
      facts: factsOf(r.id),
    }));
  }

  /** 库体字节数：:memory: 读 SQLite 页数，文件读实际磁盘占用 */
  function bytes() {
    assertOpen();
    if (isMemory) {
      const pageSize = db.prepare('PRAGMA page_size').get().page_size;
      const pageCount = db.prepare('PRAGMA page_count').get().page_count;
      return pageSize * pageCount;
    }
    let total = 0;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = file + suffix;
      if (fs.existsSync(p)) total += fs.statSync(p).size;
    }
    return total;
  }

  function stats() {
    assertOpen();
    const s = stmt.sizes.get();
    return {
      memories: stmt.count.get().n,
      facts: stmt.countFacts.get().n,
      textChars: s.chars,
      textBytes: s.bytes,
      bytes: bytes(),
      limitBytes: STORAGE_LIMIT_BYTES,
      withinLimit: bytes() <= STORAGE_LIMIT_BYTES,
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  /** 回收插入过程留下的空闲页。体积验收前调一次，字节数是压缩后口径 */
  function compact() {
    assertOpen();
    db.exec('VACUUM');
    return bytes();
  }

  return {
    path: file,
    put,
    get,
    list,
    updateAccess,
    dump,
    bytes,
    stats,
    compact,
    close,
    /** 直接拿底层连接做诊断查询（只读用法） */
    raw: () => db,
  };
}

export default { open, extractFacts, STORAGE_LIMIT_BYTES, STORE_SCHEMA_VERSION };
