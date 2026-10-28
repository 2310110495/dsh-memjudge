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
import { extractL1 } from './extract.mjs';

export const STORE_SCHEMA_VERSION = 5;
export const STORAGE_LIMIT_BYTES = 200 * 1024;

// ── 预算（抄 PerryLink/dsh-memento lib/budget.mjs:17-51，逐行移植） ──────────
// memento 的红线：硬上限报错 BUDGET_EXCEEDED、绝不静默截断。单位是 text.length
// （UTF-16 code unit），不是字节、不是 token。与 STORAGE_LIMIT_BYTES 正交：
// 那个是 200KB 字节的验收阈值，这个是「库还能不能再吃一条」的写入闸门。

/**
 * 当前库正文用量：Σ text.length（memento entryUsage 的 memjudge 形态）。
 * 参数是 dump() 的行（或任意带 text 字段的对象数组）。
 */
export function entryUsage(rows) {
  let sum = 0;
  for (const row of rows ?? []) sum += String(row?.text ?? '').length;
  return sum;
}

/**
 * 写入前校验：used + addition 是否仍在预算内（memento checkBudget 逐行同构）。
 * 返回 { ok:true } 或 { ok:false, used, limit, needed }；needed = 还差多少字符。
 * 纯函数，不落库、不改状态。
 */
export function checkBudget(used, limit, addition) {
  if (!Number.isFinite(limit) || limit <= 0) return { ok: true };
  if (used + addition <= limit) return { ok: true };
  return { ok: false, used, limit, needed: used + addition - limit };
}

/** 领域错误：写满即拒，绝不截断（memento errors.mjs 的 BUDGET_EXCEEDED 同码）。 */
export class BudgetExceededError extends Error {
  constructor({ used, limit, needed }) {
    super(`写入超出预算：已用 ${used} 字符 + 本条需要 ${needed} 字符 > 上限 ${limit} 字符`);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.details = { used, limit, needed };
  }
}

// ── 机械切段（抄 QiDouZu/retcon-form retcon.py:39-56，逐行移植） ─────────────
// 为什么按标点硬切：标点断句是人类写东西时自带的边界，机械切不会把主谓拆散。
// retcon 的 verdict 写得很直白——固定 400 字窗切出的段，换行位置可能正好劈在
// 主语和谓语中间，读起来像被人从中间撕开。按标点是「没有内容模型时的最优近似」。
export const SPLIT_RE = /[，。！？；：\n、]+|——|--/;
const CH = /[一-鿿]/;

/**
 * split_segments 的 JS 移植：先按 SPLIT_RE 切，太短（<2 个汉字）的段合并到前段。
 * 用途与 Python 版一致：把长文本变成段列表。返回段文本数组（不含分隔符）。
 */
export function splitSegments(text) {
  // 先按空行进块，块内再切。这层隔离是段数口径的前提：适配器是把章按空行切成
  // 多条 memory、每条各自切段的，若短碎片合并能跨过空行，整章切与逐块切会给出
  // 不同段数（实测 2704 vs 2706），段层与磨损统计就随写入粒度漂移。
  // 分块后恒有 splitSegments(a + '\n\n' + b) === splitSegments(a) ++ splitSegments(b)。
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
    const chCount = (part.match(/[一-鿿]/g) ?? []).length;
    if (chCount < 2 && segs.length) {
      segs[segs.length - 1] = `${segs[segs.length - 1]} ${part}`;
    } else {
      segs.push(part);
    }
  }
  return segs;
}

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

// 段表只记「覆盖位图」：段文本、长度、时间戳全部从 memory.text 现切现算，不落盘。
// 这是 200KB 预算下的形状——2704 个句级段若每段都存 id/hash/长度/时间戳，
// 光元数据就 76KB（实测），加进 152KB 的章级基线直接超预算。落盘只留
// (ord, seg_count, covered) 一行/条 memory：实测 2704 段 = 1 页。
// hashSegment 保留为纯函数给调用方做完整性校验（不占库）。

/**
 * 段级短指纹（纯函数，不落库）：FNV-1a 32 位整数。
 * 段不做幂等去重——hash 只是完整性指纹，不是唯一键；与 memories.text_hash
 * 的 32 位十六进制幂等键是两个用途。保留给调用方校验「段文本未被改写」。
 */
function hashSegment(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- 表结构

// 段层表：一条 memory 一行，段数 + 覆盖位图打进一个 BLOB。
// 为什么不是「一段一行」：一段一行实测 2704 行吃掉 92KB（memory_id 是 21 字符的
// 物理键，WITHOUT ROWID 每行 32B），直接把能力 7 的 200KB 红线打穿到 252KB。
// 为什么不是 '0'/'1' 字符串位图（v2 形状）：字符串每段占 1 字节，段级写入
// （294 条 memory / 2704 段）时 segments 表实测 3 页 12288B，占全库 6%；
// 打包成位（8 段/字节）后同样数据降到 1 页 4096B，实测整库 200704B → 192512B。
// 逻辑段数仍是 2704（bitsCount 解出），段文本本来就不落盘——「原文只此一份」
// 的 retcon 语义不受影响，段级信息零损失。
//
// 键用 ord（= memories.rowid 的代理键）而不是 21 字符的字符串 id：facts 与 segments
// 两张表把 id 重复存了 684 行，实测多付 16KB，段级写入（294 条）就此顶到 220KB。
// 换成 8 字节整数后两表各省约 2 页；对外 API 仍原样收发字符串 id，映射在 SQL 里做。
const SEGMENTS_DDL = `CREATE TABLE IF NOT EXISTS segments (
  ord  INTEGER PRIMARY KEY,
  bits BLOB NOT NULL
) WITHOUT ROWID;`;

// ── 覆盖位图编解码 ────────────────────────────────────────────────────────
// 布局：[uint16 大端段数][ceil(n/8) 字节位图，第 i 段 = 第 i>>3 字节的第 i&7 位]。
// 位图被外力截短时缺位一律算「未覆盖」（宁可报脏也不静默忽略，与 v2 语义一致）。
const BITS_MAX_SEGMENTS = 0xffff;

/** 段数 + 可选 '0'/'1' 串 → BLOB。covered 缺省时全 0（未覆盖）。 */
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

/** 一条 memory 的全部段标记为已覆盖（coverSegments 用）。 */
function packAllCovered(n) {
  const buf = packCovered(n);
  const full = Math.floor(n / 8);
  for (let i = 0; i < full; i += 1) buf[2 + i] = 0xff;
  for (let i = full * 8; i < n; i += 1) buf[2 + (i >> 3)] |= 1 << (i & 7);
  return buf;
}

const asBytes = (v) => (v == null ? new Uint8Array(0) : v instanceof Uint8Array ? v : new Uint8Array(v));

/** BLOB → 段数（缺列/短包按 0 处理） */
function bitsCount(blob) {
  const b = asBytes(blob);
  if (b.length < 2) return 0;
  return (b[0] << 8) | b[1];
}

/** BLOB + 段序号（0 基）→ 1/0 */
function bitAt(blob, i) {
  const b = asBytes(blob);
  const byte = 2 + (i >> 3);
  if (byte >= b.length) return 0;
  return (b[byte] >> (i & 7)) & 1;
}

// facts 层 v4：字符串字典化 + 句子指针。
//
// 为什么要换编码：v3 的 facts 每行自带 entity/attr/key 三份字符串，704 行时表占 45KB，
// 把 SPEC §2.7 的 200KB 预算顶穿。同一批数据换表示后：
//   - entity/attr 存整数外键（重复度越高越省）；
//   - key（attr 末 2 字）不再落盘，读时算；
//   - sent 不存原文，只存 (sent_off, sent_len) 指针，grounding 时回 memories.text 切片比对。
// 信息一条不丢：原文是唯一真相，facts 只记「哪一句、哪个槽、什么值」。
// facts 层 v5：不落盘，改内存派生层。
//
// 依据 SPEC §2.7 判据 2「计入范围只含落盘记忆库与索引」：facts 可由 memories.text
// 100% 重建，属派生数据，不写盘就不进体积预算。落盘的只有原文（memories）、
// 段位图（segments）与 meta——能力 7 的判据因此只看这三张表。
//
// 代价是启动时要重建一次（实测见 rebuildFacts 的日志），换来的是 facts 行数不再
// 受 200KB 约束：700 行、2000 行都可以，句子指针也留在内存里不额外占页。
const FACTS_DDL = '';

// vtype 落整数（内存里也一样：便于按类型聚类，也省字符串比对）。
const VTYPE = { number: 1, date: 2, time: 3, percent: 4, id: 5, coord: 6, enum: 7, text: 8 };
const VTYPE_NAME = Object.fromEntries(Object.entries(VTYPE).map(([k, v]) => [v, k]));

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
${SEGMENTS_DDL}
${FACTS_DDL}
`;

// 体积预算是硬指标（20 章 ≤200KB），而 text 本身就要 88KB，
// 所以除幂等键外不建任何索引：20 行 memories / 数百行 facts 全表扫的开销
// 远小于索引占的页。facts 原有的 ix_facts_key 在集成期删除——store 侧没有按
// 属性键查 facts 的路径（factsOf 按 ord 查、冲突检测走 judge 的内存索引），
// 那 3 页 12KB 是纯支出；要恢复按 key 检索时再加，别凭空留着。
//
// segments 表不存段文本：段文本从 memory.text 现切（splitSegments 是纯函数，
// 同输入恒同输出），落盘只记 seg_count/covered 位图。这样 retcon 的
// 「原文只此一份」在 SQLite 里成立——改 memory.text 即改所有段，没有第二份
// 副本可以悄悄漂移；同时 20 章 29648 字的段元数据只增加 1 页，不击穿 200KB。

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

  // ── facts 内存派生层（v5：不落盘） ────────────────────────────────────────
  // 结构：byOrd（ord → Fact[]，供 factsOf/dump）与 slot（attr → [{ord,fact}]，
  // 供 (entity, attr) 存在性查询）。句子指针留在 fact 上，grounding 时回
  // memories.text 切片，不需要在库里再抄一份原文。
  const memFacts = { byOrd: new Map(), slot: new Map(), total: 0 };
  function addMemFact(ord, f) {
    const vtype = VTYPE[f.valueType ?? 'text'] ?? VTYPE.text;
    const fact = {
      entity: f.entity ?? null,
      attr: f.attr,
      key: f.attr.length <= 2 ? f.attr : f.attr.slice(-2),
      value: f.value,
      unit: null,
      kind: vtype === VTYPE.enum ? 'role' : vtype === VTYPE.coord ? 'coord' : vtype === VTYPE.id ? 'id' : 'value',
      at: f.at ?? 0,
      sent_off: f.sentOff ?? f.at ?? 0,
      sent_len: f.sentLen ?? 0,
    };
    let list = memFacts.byOrd.get(ord);
    if (!list) { list = []; memFacts.byOrd.set(ord, list); }
    list.push(fact);
    memFacts.total += 1;
    let slot = memFacts.slot.get(f.attr);
    if (!slot) { slot = []; memFacts.slot.set(f.attr, slot); }
    slot.push({ ord, fact });
  }
  function buildFactsFor(ord, text) {
    const facts = extractL1(text);
    for (const f of facts) addMemFact(ord, f);
    return facts.length;
  }
  /** 从 memories.text 全量重建内存 facts。返回 {facts, memories, ms} 以便打印耗时。 */
  function rebuildFacts(reason = 'startup') {
    const t0 = Date.now();
    memFacts.byOrd.clear();
    memFacts.slot.clear();
    memFacts.total = 0;
    const rows = db.prepare('SELECT rowid AS ord, text FROM memories ORDER BY created_at, id').all();
    for (const m of rows) buildFactsFor(m.ord, m.text);
    const ms = Date.now() - t0;
    const info = { facts: memFacts.total, memories: rows.length, ms, reason };
    // 重建耗时是 captain 要看的数字：磁盘库默认打一行到 stderr；
    // 内存库只在 MEMJUDGE_VERBOSE 时打，免得测试输出被刷屏。
    if (!isMemory || process.env.MEMJUDGE_VERBOSE) {
      console.error(`[memjudge] facts 重建：${info.facts} 条 / ${info.memories} 条记忆 / ${ms}ms（${reason}）`);
    }
    return info;
  }
  // ── 表结构自检：CREATE TABLE IF NOT EXISTS 不会纠偏已存在的同名表 ──────────
  // segments 缺 bits（v2 的 '0'/'1' 字符串位图，或更早的「一段一行 (memory_id, seq)」
  // 形态）或缺 ord 整数键时重建；段元数据完全可以从 memory.text 重切
  // （splitSegments 是纯函数），零信息损失。facts 的 memory_id 若是 TEXT（老库按
  // 21 字符字符串 id 存）也重建，三元组由 extractFacts 从原文重抽，同样无损。
  const segCols = db.prepare('PRAGMA table_info(segments)').all().map((c) => c.name);
  let rebuiltSegs = false;
  if (segCols.length > 0 && (!segCols.includes('bits') || !segCols.includes('ord'))) {
    db.exec('DROP TABLE segments');
    db.exec(SEGMENTS_DDL);
    rebuiltSegs = true;
  }
  // v5：facts 不再落盘，老库的 facts/str_dict 一并清掉（数据可由原文重建，零损失）。
  db.exec('DROP TABLE IF EXISTS facts');
  db.exec('DROP INDEX IF EXISTS ux_facts_slot');
  db.exec('DROP TABLE IF EXISTS str_dict');
  db.exec('DROP TABLE IF EXISTS entity_dict');
  db.exec('DROP TABLE IF EXISTS attr_dict');

  // ── schema v1/v2 → v3 迁移：段层形状演进 ────────────────────────────────
  // v1 无 segments 表（DDL 的 IF NOT EXISTS 已建空表），v2 是 '0'/'1' 字符串位图
  // （自检已 DROP 重建）。两种都在这里从 memory.text 重切补写段数 + 位图，
  // 幂等：INSERT OR IGNORE + 全 0 位图，重开会话不会改写已有覆盖状态。
  const versionRow = db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
  const fromVersion = versionRow ? Number(versionRow.v) : 0;
  if (fromVersion < STORE_SCHEMA_VERSION || rebuiltSegs) {
    const mems = db.prepare('SELECT rowid AS ord, text FROM memories ORDER BY created_at, id').all();
    const insSegMig = db.prepare('INSERT OR IGNORE INTO segments (ord, bits) VALUES (?, ?)');
    for (const m of mems) {
      const n = splitSegments(m.text).length;
      insSegMig.run(m.ord, packCovered(n));
    }
  }
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(STORE_SCHEMA_VERSION));
  // 表结构定稿后重建内存 facts（captain 要的重建耗时在这里打印）。
  const rebuildStats = rebuildFacts('startup');

  // 库级字符预算（memento 语义）：maxChars > 0 时超限抛 BUDGET_EXCEEDED，不截断。
  // 默认 0 = 不限——评测语料 29648 字必须能全量落库；调用方要「写满即拒」就显式传。
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? Math.trunc(opts.maxChars) : 0;

  const stmt = {
    byHash: db.prepare('SELECT id, text FROM memories WHERE text_hash = ?'),
    byId: db.prepare('SELECT * FROM memories WHERE id = ?'),
    insMem: db.prepare(`INSERT INTO memories
      (id, text, text_hash, created_at, last_accessed, access_count, importance, supersedes, source)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`),
    touch: db.prepare('UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM memories'),
    countFacts: null, // 改为读内存 memFacts.total（见 stats）
    rowidOf: db.prepare('SELECT rowid AS ord FROM memories WHERE id = ?'),
    sizes: db.prepare('SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes FROM memories'),
    insSeg: db.prepare('INSERT OR IGNORE INTO segments (ord, bits) VALUES (?, ?)'),
    segRow: db.prepare(`SELECT m.id AS memory_id, s.bits
      FROM segments s JOIN memories m ON m.rowid = s.ord WHERE m.id = ?`),
    allSegs: db.prepare(`SELECT s.ord, m.id AS memory_id, s.bits, m.created_at
      FROM segments s JOIN memories m ON m.rowid = s.ord`),
    allBits: db.prepare('SELECT bits FROM segments'),
    coverMem: db.prepare('UPDATE segments SET bits = ? WHERE ord = (SELECT rowid FROM memories WHERE id = ?)'),
  };

  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error('store 已关闭');
  };

  function factsOf(id) {
    // v5：从内存派生层取（facts 不落盘）。字段形状与 v3/v4 保持一致，
    // 上层（dump / conflicts / 渲染）不需要知道存储形态变过。
    const row = stmt.rowidOf.get(id);
    if (!row) return [];
    const list = memFacts.byOrd.get(row.ord) || [];
    return list.slice().sort((a, b) => a.at - b.at);
  }

  /** 删除某条记忆的内存 facts（forget 路径用；落盘层已没有 facts 表）。 */
  function dropFactsOf(id) {
    const row = stmt.rowidOf.get(id);
    if (!row) return 0;
    const list = memFacts.byOrd.get(row.ord) || [];
    for (const f of list) {
      const slot = memFacts.slot.get(f.attr);
      if (slot) {
        const i = slot.findIndex((x) => x.ord === row.ord && x.fact === f);
        if (i >= 0) slot.splice(i, 1);
      }
    }
    memFacts.total -= list.length;
    memFacts.byOrd.delete(row.ord);
    return list.length;
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

    // ── memento 预算硬拒绝：幂等命中之后再查预算，超限抛 BUDGET_EXCEEDED ──
    // 语义：库满即拒写，绝不截断这条 text、绝不静默丢。预算单位是 text.length。
    if (maxChars > 0) {
      const used = stmt.sizes.get().chars;
      const verdict = checkBudget(used, maxChars, text.length);
      if (!verdict.ok) throw new BudgetExceededError(verdict);
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
      const ord = Number(stmt.insMem.run(id, text, hash, createdAt, createdAt, importance, supersedes, source).lastInsertRowid);
      // retcon 不可变原文层：机械切段落 segments，与原文同事务。段文本不复制
      // 整条的存储开销——落盘的只有段数与覆盖位图（BLOB，8 段/字节）。
      const segs = splitSegments(text);
      stmt.insSeg.run(ord, packCovered(segs.length));
      const factCount = buildFactsFor(ord, text);
      db.exec('COMMIT');
      return { id, inserted: true, factCount, segmentCount: segs.length };
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
    const w = wear();
    return {
      memories: stmt.count.get().n,
      facts: memFacts.total,
      textChars: s.chars,
      textBytes: s.bytes,
      bytes: bytes(),
      limitBytes: STORAGE_LIMIT_BYTES,
      withinLimit: bytes() <= STORAGE_LIMIT_BYTES,
      segments: w.segments,
      wornSegments: w.worn,
      wear: w.wear,
      maxChars,
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

  // ---------------------------------------------------------- 段层（retcon）

  /** 一条段行 → 逐段对象数组（位图展开，物理上仍是一条 memory 一行）。 */
  function expandSegs(row) {
    if (!row) return [];
    const n = bitsCount(row.bits);
    const out = [];
    for (let i = 1; i <= n; i += 1) {
      out.push({ memory_id: row.memory_id, seq: i, covered: bitAt(row.bits, i - 1) });
    }
    return out;
  }

  /** 一条 memory 的段元数据（按 seq 升序）。段文本从 memory.text 现切，不落盘。 */
  function segmentsOf(memoryId) {
    assertOpen();
    return expandSegs(stmt.segRow.get(memoryId));
  }

  /** 全库的段位图（按 created_at, memory_id, seq 升序）。 */
  function segmentDump() {
    assertOpen();
    return stmt.allSegs.all()
      .sort((a, b) => a.created_at - b.created_at
        || (a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0))
      .flatMap((row) => expandSegs(row).map((s) => ({ ...s, created_at: row.created_at })));
  }

  /**
   * 一条 memory 的段文本列表（retcon 机械切段，从 memory.text 现切）。
   * 段文本不落盘——segments 表只存 covered 位图，既省 200KB 预算，
   * 又保证「原文只此一份、改无可改」（retcon 不可变语义的 SQLite 形态）。
   * 每段附 hash（hashSegment 纯函数），供调用方校验完整性。
   */
  function segmentTexts(memoryId) {
    assertOpen();
    const row = stmt.byId.get(memoryId);
    if (!row) return [];
    return splitSegments(row.text).map((text, i) => ({
      id: `${memoryId}/${i + 1}`,
      seq: i + 1,
      text,
      chars: text.length,
      hash: hashSegment(text),
    }));
  }

  /**
   * 把一条 memory 的所有段标记为「已被新结论覆盖」（retcon 的 cover 语义）。
   * 由写入方在 supersedes 链建立后调用；covered=1 的段不计入磨损。
   */
  function coverSegments(memoryId) {
    assertOpen();
    const row = stmt.segRow.get(memoryId);
    if (!row) return 0;
    const n = bitsCount(row.bits);
    stmt.coverMem.run(packAllCovered(n), memoryId);
    return n;
  }

  /**
   * 磨损度（retcon wear）：covered=0 的段占比。0 = 全部都被覆盖，1 = 全部还在裸奔。
   * retcon.py:175-181 的语义是「没被任何 cover 的 reads 覆盖的段」——这里的
   * covered 是写入侧维护的标记位，不是查询时现算，与 retcon 的物化方向相反但同义。
   * 位图按段数截断读取：位图被外力截短时缺位算「未覆盖」，宁可报脏也不静默忽略。
   */
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
    rebuildFacts,
    rebuildStats,
    dropFactsOf,
    factsSlot: (attr) => memFacts.slot.get(attr) || [],
    allFacts: () => {
      // 供 gate 做 (entity, attr) 存在性判定：扁平数组，形状与 extractL1 输出一致。
      const out = [];
      for (const list of memFacts.byOrd.values()) for (const f of list) out.push(f);
      return out;
    },
    segmentsOf,
    segmentDump,
    segmentTexts,
    coverSegments,
    wear,
    maxChars,
    close,
    /** 直接拿底层连接做诊断查询（只读用法） */
    raw: () => db,
  };
}

export default { open, extractFacts, STORAGE_LIMIT_BYTES, STORE_SCHEMA_VERSION, entryUsage, checkBudget, BudgetExceededError, SPLIT_RE, splitSegments };
