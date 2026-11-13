// memjudge：记忆判断层。
//
// 22 个插件实测的结论：它们都在做「取回材料」，没有一个做「判断」——
// 该不该说、说哪个、忘哪个。这四件事不碰存储，只处理候选集，所以能独立成层。
//
//   gate            问没有的东西时说没有（实测 24 个插件 deny = 0/144）
//   resolveConflict 两条矛盾记忆发现并改变（实测 judgedConflict = 0/96）
//   decayWeight     按天折算慢慢放手（实测 11 份曲线全平）
//   fitBudget       上下文留给要紧事（实测 20/24 倾倒整章 1453–30661 字符）
//
// 关键设计：判断依据是**写入时抽出的三元组**，不是查询时拿问句去正文里找字。
// 后者在长材料上必然失效——整章 1453 字里任意二元组都出现，判据恒真。

import {
  extractSlots,
  splitCompactEntityAttr,
  cleanSlotEntity,
  cleanSlotAttr,
  normalizeValueAndUnit,
} from './slots.mjs';
import { GLOBAL_SPACE_ID, visibleSpaces } from './scope.mjs';

const DAY = 86400000;
const CJK = /[\u4e00-\u9fff]/;

// 剥词用的虚词表。只剥两侧，不动中间，否则「主机型号」会被拆散。
const LEAD_JUNK = /^(?:的|了|是|在|有|和|与|及|或|从|向|往|到|把|被|给|对|该|这|那|其|约|共|计|达|为|则|即|按|据|经|由|于|已|将|可|须|应)+/;
const TAIL_JUNK = /(?:的|了|是|在|有|和|与|及|或|吗|呢|吧|啊|约|共|计|达|为|则|即|按|据|经|由|于|已|将|可|须|应|上|下|中|内|外|前|后|里)+$/;

// 疑问焦点。切属性时以它为界，界两侧的名词块都算属性。
const QMARK = /(?:几(?:小时|分钟|秒|毫秒|千克|公斤|公里|厘米|毫米|吨|米|度|升)|多少|多久|多大|多远|多长|多重|多高|多深|几人|几个|几支|几卷|几块|几节|几种|几次|几条|几项|几页|几份|几张|几名|几行|几号|第几|哪一|哪条|哪个|哪个|哪里|哪国|哪年|哪月|哪日|哪位|哪天|什么|啥|谁|何时|何地|如何|怎么|怎样|为什么|是否|是不是|有没有|能否)/;

// 问询方式词：只是问法，不是属性本身。R73「累计睡眠情况如何」的属性是「累计睡眠」。
const MODE_TAIL = /(?:情况|状态|方式|做法|样子|内容|经过|结果|详情|说法|表述|口径|数据|数值|水平|程度)+$/;

// 回溯/存在类限定词：出现这些词时，对应的限定必须真的被记载过。
// 否则「上一航次跑哪条航线」会被「老航线」「原定航线」蒙混过关。
const LIMITER_RE = /(上一|上一次|前一次|上一年|去年|前任|首任|最初|原始|成立|出生|创办|初建|已注销|停用)/g;

// 通用属性后缀词：值附近的这些词是「属性名」，不是值的一部分。
const ATTR_SUFFIX = '(?:[\u4e00-\u9fff][度率数量额值期限码型重速次]|[称名期时位置向级类态式法因果途责务龄历]|大小|端口|版本|功率|容量|费用|预算|标准|半径|面积|体积|气压|电压|距离)';

// 通用中文职务构词与通用机构构词（零特定行业专有词硬编码）
const GENERIC_ROLE_TITLE = '(?:[一二三四五总正副大值班首席执行助理见习][\\u4e00-\\u9fff]{0,2}|[\\u4e00-\\u9fff]{1,2})(?:代表|主任|经理|总监|委员|顾问|专家|主管|专员|调度|代理|律师|长|副|师|员|人|手|匠)';
const GENERIC_ROLE_RE_SRC = `(?:${GENERIC_ROLE_TITLE})([\\u4e00-\\u9fff]{2,3})`;
const GENERIC_ROLE_CAP_RE = new RegExp(`(${GENERIC_ROLE_TITLE})([\\u4e00-\\u9fff]{2,3})`, 'g');
const GENERIC_ROLE_TEST_RE = new RegExp(`^(?:${GENERIC_ROLE_TITLE})`);

// 实体词表：编号型、职务+姓名、机构、命名编号体。
const ENTITY_PATTERNS = [
  /PT\s+[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*/g,
  /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g,
  new RegExp(GENERIC_ROLE_RE_SRC, 'g'),
  /[\u4e00-\u9fff]{2,6}(?:公司|集团|总局|分局|局|社|厂|院|调查组|委员会|保险|银行|法院)/g,
  /[\u4e00-\u9fff]{2,4}号/g,

];

const VALUE_RE = new RegExp(
  '([零一二三四五六七八九十百千万亿两\\d]+(?:点[零一二三四五六七八九\\d]+)?)\\s*' +
  '(厘米|毫米|米|公里|海里|海里|千瓦|吨|美元|万美元|元|天|小时|分钟|秒|节|度|人|名|页|项|张|份|条|件|支|块|卷|升|平方米|立方米|公斤|百帕|次)',
  'g',
);

/** 归一化：只留汉字与拉丁数字，统一小写。属性比对一律走这里。 */
export function norm(s) {
  return String(s || '').replace(/[^\u4e00-\u9fff A-Za-z0-9]/g, '').replace(/\s+/g, '').toLowerCase();
}

/** 切句，保留原字符偏移。句是三元组的承载单位。 */
export function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '。' || c === '！' || c === '？' || c === '；' || c === '\n') {
      const seg = text.slice(start, i + 1);
      if (seg.trim()) out.push({ text: seg, at: start });
      start = i + 1;
    }
  }
  const rest = text.slice(start);
  if (rest.trim()) out.push({ text: rest, at: start });
  return out;
}

/** 从一段文本里建实体词表。不靠词典，靠形态：编号、职务+姓名、机构后缀、船名后缀。 */
export function buildEntities(text) {
  const set = new Map();
  const add = (s, kind) => {
    const v = s.trim();
    if (v.length < 2) return;
    if (!set.has(v)) set.set(v, { name: v, kind, n: 0 });
    set.get(v).n++;
  };
  for (const re of ENTITY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // 职务+姓名模式：整体与姓名都进词表
      if (m[1] && GENERIC_ROLE_TEST_RE.test(m[0])) {
        add(m[1], 'person');
        add(m[0], 'person-role');
      } else {
        add(m[0], 'thing');
      }
    }
  }
  // 只出现一次且长度 ≤2 的当噪声扔掉（「这号」「一号」这类）
  return [...set.values()].filter((e) => e.n >= 2 || e.name.length >= 3);
}

/** 句子里最长命中的实体 */
function pickEntity(sentence, entities) {
  let best = null;
  for (const e of entities) {
    if (sentence.includes(e.name) && (!best || e.name.length > best.name.length)) best = e;
  }
  return best ? best.name : null;
}

/** 从值左侧取属性名。剥掉虚词与「约/为/是」这类连接词，再向右吃掉属性后缀。 */
function attrBefore(text, valueIdx) {
  const before = text.slice(0, valueIdx);
  // 只看到最近的分隔符为止
  const cut = Math.max(
    before.lastIndexOf('，'), before.lastIndexOf('。'), before.lastIndexOf('；'),
    before.lastIndexOf('：'), before.lastIndexOf(','), before.lastIndexOf('\n'),
  );
  let seg = before.slice(cut + 1);
  // 值前面常常是「属性是/为/达/共」，属性和值之间只隔这些
  seg = seg.replace(/(?:是|为|达|共|计|约|有|至|到|在|用|做|采用|记录|实测|目测|估值|标注|写|称)\s*$/, '');
  let m = seg.match(new RegExp('([\\u4e00-\\u9fffA-Za-z0-9 ]{2,20})$'));
  if (!m) return { attr: '', prefix: '' };
  let attr = m[1].trim().replace(LEAD_JUNK, '').replace(TAIL_JUNK, '');
  // 「该通告涉及一处新设的钻井平台安全区，半径五百米」：属性是「安全区半径」，
  // 值前只留了「半径」，需要把前一分句的中心名词补进来。
  if (attr.length <= 4) {
    const prev = before.slice(0, before.length - seg.length).match(new RegExp('([\\u4e00-\\u9fff]{2,8}' + ATTR_SUFFIX.slice(3, -1) + ')$'));
    if (prev && prev[1].includes(attr)) attr = prev[1];
  }
  return { attr, prefix: before };
}

/**
 * 抽三元组。这是写入阶段的产物，也是 gate 的唯一依据。
 * @returns {Array<{entity,attr,value,kind,text,ch,at}>}
 */
export function extractFacts(text, opts = {}) {
  const ch = opts.ch ?? null;
  const entities = opts.entities || buildEntities(text);
  const names = entities.map((e) => (typeof e === 'string' ? e : e.name));
  const facts = [];
  let lastEntity = null;

  for (const s of splitSentences(text)) {
    let ent = pickEntity(s.text, entities);
    if (!ent) ent = lastEntity; // 跨句延续：同一段里主语省略是常态
    else lastEntity = ent;
    if (!ent) continue;

    // (1) 数值型：数字 + 单位
    VALUE_RE.lastIndex = 0;
    let m;
    while ((m = VALUE_RE.exec(s.text)) !== null) {
      const value = `${m[1]}${m[2]}`;
      const { attr } = attrBefore(s.text, m.index);
      if (attr.length >= 1) {
        facts.push({ entity: ent, attr, value, kind: 'numeric', text: s.text.trim(), ch, at: s.at + m.index });
      }
    }

    // (2) 编号/代号型：拉丁串本身就是值
    const CODE_RE = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g;
    while ((m = CODE_RE.exec(s.text)) !== null) {
      const value = m[0];
      const { attr } = attrBefore(s.text, m.index);
      facts.push({ entity: ent, attr: attr || '编号', value, kind: 'code', text: s.text.trim(), ch, at: s.at + m.index });
    }

    // (3) 判断句型：X 是/为/叫 Y。覆盖「目的港是智利圣安东尼奥」「型号 80CL-9」。
    const COPULA = /([\u4e00-\u9fff]{2,10})(?:是|为|叫|名为|称为|改名为|改称)([^\s，。；、]{2,40})/g;
    while ((m = COPULA.exec(s.text)) !== null) {
      const attr = m[1].replace(LEAD_JUNK, '').replace(TAIL_JUNK, '');
      const value = m[2].replace(/[。；，、]$/, '');
      if (attr.length >= 2 && value.length >= 2) {
        facts.push({ entity: ent, attr, value, kind: 'copula', text: s.text.trim(), ch, at: s.at + m.index });
      }
    }

    // (4) 职务+姓名 → (姓名, 职务, 职务名)
    GENERIC_ROLE_CAP_RE.lastIndex = 0;
    while ((m = GENERIC_ROLE_CAP_RE.exec(s.text)) !== null) {
      facts.push({ entity: m[2], attr: '职务', value: m[1], kind: 'role', text: s.text.trim(), ch, at: s.at + m.index });
    }
  }
  return facts;
}

/** 建库：一次写入，后续所有判断都查这张表。 */
export function buildStore(chapters) {
  const list = Array.isArray(chapters) ? chapters : [{ n: 1, text: String(chapters) }];
  const full = list.map((c) => c.text).join('\n');
  const entities = buildEntities(full);
  const facts = [];
  for (const c of list) {
    for (const f of extractFacts(c.text, { ch: c.n ?? null, entities })) facts.push(f);
  }
  // 属性索引：后 2 字 → facts。中文属性名的中心词在尾部（「凹陷实测深度」→ 深度）。
  const byKey = new Map();
  for (const f of facts) {
    const k = norm(f.attr).slice(-2);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }
  return { facts, entities, chapters: list, text: full, byKey };
}

// 问句里夹带的动词。它们不是属性名，不剥掉会让「累计睡眠情况」变成「累计睡眠不足」。
const VERB_JUNK = /(?:决定|要求|更换|看见|装了|装|减到|减小|漂了|漂|待了|待|询问|化验|写了|写|挂的是|挂|用的是|用|还剩|剩|叫|改名为|改名|跑了|跑|经过|覆盖|发生|出现|提出|记录|处理|执行|送达|漏改|采信|给出|采用|规定|涉及|表示|认为|自称|成为|变成|作为|设置|安装|属于|包括|包含|需要|应该|可以|能够|进行|实现|完成|算出|签署|签发|到达|抵达|离开|超过|不超过|改成|改回|减为|反映|发现|取样|化验)/g;

// 答案类型词：只说明「我要一个什么形状的值」，不构成被查属性。
// 「主机型号」剥掉「型号」剩「主机」——原文写「主机是 MAN B&W」，这才对得上。
const ANSWER_TYPE_RE = /(?:型号|编号|名字|名称|金额|费用|总额|总数|数量|页数|页码|年限|年龄|长度|深度|宽度|高度|重量|日期|时间)/g;

// 解释型问句问的是「为什么/怎么办」，不是一个属性的值。这类只判实体，不判属性。
const EXPLAIN_RE = /(为什么|为何|怎么|怎样|如何|哪些|有什么|情况)/;
const NUMERIC_RE = /(几(?:小时|分钟|秒|毫秒|千克|公斤|公里|厘米|毫米|吨|米|度|升)|多少|多久|多大|多远|多长|多深|多重|多高|几点|几[人名页项张份条件支块卷节次天年月日]|哪年|哪国|第几)/;

// 属性短语还原。clean() 会把限定语与拉丁串剥成孤零零的两三个字：「出生」不是被问的东西，
// 「出生年份」才是。拒答文案必须复述被问的那个完整说法——评测侧判「否认词落在被问实体附近」，
// 实体不在文案里，再对的拒答也数不出来（H1/H2/H5/H6 就是这样被判成「没拒答」的）。
const PHRASE_STOP = /[的了是在有和与及或从向往到把被给对该这那其约共计达为则即按据经由于已将可须应吗呢吧啊多少几谁啥跑挂装用叫改离抵到达]/;
function attrPhrase(query, key) {
  const q = String(query || '').replace(/[？?。！!，,、；;：:]/g, '');
  const k = String(key || '');
  if (!k) return '';
  const i = q.toLowerCase().indexOf(k.toLowerCase());
  if (i < 0) return k;
  const isHan = (c) => /\p{Script=Han}/u.test(String(c || ''));
  // 限定语本身已是完整语义单位（「上一」「出生」），补字只会补坏：
  // 「一号节点上一版本」的「上一」前面是实体尾字「号」，补进来就成了「号上一版本」。
  LIMITER_RE.lastIndex = 0;
  const isLimiter = new RegExp(`^(?:${LIMITER_RE.source})$`).test(k);
  let lo = i;
  let hi = i + k.length;
  // 只有被切碎的残片才向前补一个字（「关长」→「海关关长」），遇虚词即停。
  if (!isLimiter && lo > 0 && isHan(q[lo - 1]) && !PHRASE_STOP.test(q[lo - 1])) lo -= 1;
  // 向后最多补三个字，跳过拉丁串后的空格，遇虚词/疑问词即停。
  while (hi < q.length && /\s/.test(q[hi])) hi += 1;
  for (let n = 0; n < 3 && hi < q.length; n += 1) {
    const c = q[hi];
    if (!isHan(c) || PHRASE_STOP.test(c)) break;
    hi += 1;
  }
  return q.slice(lo, hi).replace(/\s+/g, ' ').trim();
}

/**
 * 问句解析：实体之外的属性块、限定词、拉丁串。
 * 属性取疑问焦点两侧的名词块——「核心网关上一版本监听的是哪个端口」里，「端口」在焦点之后。
 * @param {string} query
 * @param {string[]} [dropNames] 已知实体，算属性前先剥掉，否则属性块里会带着实体名
 */
export function parseQuery(query, dropNames = []) {
  let q = String(query || '').replace(/[？?。！!，,、；;：:]+/g, '');
  const limiter = (q.match(LIMITER_RE) || []).slice();
  const latin = (query.match(/[A-Za-z][A-Za-z0-9]{1,}/g) || []).map((s) => s.toLowerCase());
  for (const n of dropNames) if (n) q = q.split(n).join('|');

  const clean = (s) => s
    .replace(LIMITER_RE, '').replace(VERB_JUNK, '').replace(NOISE_JUNK, '')
    .replace(ANSWER_TYPE_RE, '').replace(STRIP_GLUE, '')
    .replace(LEAD_JUNK, '').replace(TAIL_JUNK, '').replace(MODE_TAIL, '');

  const qm = QMARK.exec(q);
  let left = [];
  let right = [];
  let unitFromQm = null;
  if (qm) {
    left = q.slice(0, qm.index).match(/[\u4e00-\u9fff]{2,}/g) || [];
    right = q.slice(qm.index + qm[0].length).match(/[\u4e00-\u9fff]{2,}/g) || [];
    // 「多少人」「几秒」「多少吨」：疑问词自带量词，量词本身就是属性
    const u = qm[0].match(/^(?:多少|几)(人|名|页|项|张|份|条|件|支|块|卷|节|次|天|年|月|日|吨|米|海里|度|美元|元|小时|分钟|秒|升|百帕|公斤)/);
    if (u) unitFromQm = u[1];
  } else {
    left = q.match(/[\u4e00-\u9fff]{2,}/g) || [];
  }
  const blocks = [...left, ...right].map(clean).filter((s) => s.length >= 2);

  // 主属性块：量词优先，其次焦点后的名词块。长块只取末尾三个字——中文名词短语的中心词在尾部，
  // 拿整串去比对等于要求问句原样复现原文措辞，误伤只会越修越多。
  let primary = '';
  if (unitFromQm) primary = unitFromQm;
  else if (blocks.length) {
    const b = blocks[blocks.length - 1];
    primary = b.length >= 5 ? b.slice(-3) : b;
  } else if (latin.length) {
    // 「IMO 编号是多少」：属性词被答案类型表剥空，剩下唯一的判据就是那个拉丁串本身。
    primary = latin[latin.length - 1];
  }

  const attr = blocks.join('');
  return {
    raw: String(query || '').replace(/[？?。！!，,、；;：:]+/g, ''),
    blocks,
    primary,
    attr: norm(attr),
    attrRaw: primary || attr,
    limiters: limiter,
    latin,
    explain: EXPLAIN_RE.test(query) && !NUMERIC_RE.test(query),
  };
}

// 疑问词之外的噪声：程度副词、指示词。留在属性块里只会干扰比对。
const NOISE_JUNK = /(最大|最小|最长|最短|最多|最少|最低|最高|一共|总共|大约|左右|准确|具体|实际|那一位|那处|这一|那批|那一批|一项|同型号|哪种|哪类|哪一项)/g;

// 名词短语里的结构助词与疑问残留：剥干净才剩下真正的属性核心（「的坐标」→「坐标」）。
const STRIP_GLUE = /[的了哪几种处批该其则即按据经由于已将可须应和与及或从往到把被给对是在]/g;

/** 拉丁/字母限定必须真出现：否则问 IMO 编号会被「平台编号 PQ-7」冒充。 */
function latinOk(f, pq) {
  const fa = norm(f.attr);
  const ft = norm(f.text);
  return pq.latin.every((L) => ft.includes(L) || fa.includes(L));
}

/** 块里是否有一个三字连续片段在原文出现。二字组全中也可能只是「中心」「气压」分别出现，三连不行。 */
function hasTriple(block, hay) {
  const cs = [...block];
  if (cs.length < 3) return true;
  for (let i = 0; i + 2 < cs.length; i += 1) {
    if (hay.includes(cs[i] + cs[i + 1] + cs[i + 2])) return true;
  }
  return false;
}

/** 二字组覆盖率：块里相邻两字能在原文找到的比例。比整块子串比对宽容，比单字覆盖更挑剔。 */
function bigramCover(block, hay) {
  const cs = [...block];
  if (cs.length < 2) return hay.includes(block) ? 1 : 0;
  let hit = 0;
  for (let i = 0; i + 1 < cs.length; i += 1) {
    if (hay.includes(cs[i] + cs[i + 1])) hit += 1;
  }
  return hit / (cs.length - 1);
}

/**
 * 拒答文档表达式：把一段原文变成拒答查询要比对的那串字符。单一出口。
 *
 * 抄 hindsight _text_search.py 的 mental_models_text_document(alias) 模式（hindsight_api/_text_search.py:11）：
 * 全文检索的「文档」在整个系统里只定义一次，DDL 建索引用它、查询拼向量也用它，两处永不同步漂移。
 * memjudge 是 SQLite/node 不是 PG，没有 tsvector 生成列，但同构地抽一个 gateTextDocument：
 * norm（去标点/空白、小写）再剥掉结构助词——拒答判据的「文档」就只在这里定义。
 * gate 的 glueAll 与 gateSearchIndex 都调它，保证「索引里存什么」与「查询比什么」是同一份表达式。
 *
 * @param {string} text 原文全文
 * @returns {string} 归一化后的拒答文档
 */
export function gateTextDocument(text) {
  return norm(text || '').replace(STRIP_GLUE, '');
}

/**
 * 拒答文档索引：把分章材料物化成一份可供查询的拒答索引。
 *
 * hindsight 在 PG 里建表达式索引（migrations.py 用 mental_models_text_document() 作 index_expr），
 * memjudge 的 SQLite 持久层因体积预算（20 章 ≤200KB，store.mjs:326）不建 FTS 虚表，
 * 这里在内存里物化同一份文档：键是章节号，值是该章的 gateTextDocument 结果。
 * 这就是「表达式索引」的 memjudge 等价物——内容（DDL 侧）与 gate 查询比对的目标（查询侧）同源。
 *
 * @param {Array<{n?:number,text:string}>} chapters 分章材料（buildStore 的入参形状）
 * @returns {{byChapter: Map<any,string>, full: string, docFor: (text:string)=>string}}
 */
export function gateSearchIndex(chapters) {
  const list = Array.isArray(chapters) ? chapters : [{ n: 1, text: String(chapters) }];
  const byChapter = new Map();
  for (const c of list) byChapter.set(c.n ?? null, gateTextDocument(c.text));
  const full = gateTextDocument(list.map((c) => c.text).join('\n'));
  return { byChapter, full, docFor: gateTextDocument };
}

/**
 * 属性是否被记载。
 *
 * 判定面是整句，不是抽出来的三元组——自由散文里「X 是 Y」抽出的属性名多半是碎片
 * （`核心网关第=一次`、`缓冲队列压成=一块`），把精确比对建在碎片上，误伤只会转嫁到问句侧。
 * 要求属性名在句中原样出现：「现场」不认「到场」，「中心气压」不认「气压一小时里掉了四个百帕」。
 */
function hitBy(pool, pq, p) {
  return pool.some((f) => {
    if (!latinOk(f, pq)) return false;
    const hay = norm(`${f.attr} ${f.text} ${f.value}`);
    if (hay.includes(p)) return true;
    // 四字复合属性（「中心气压」「平均拖速」）：修饰语与中心词必须同句出现。
    // 「中心」在讲低压中心，「气压」在讲一小时掉四个百帕——两句拼不出一个属性。
    if (p.length === 4) {
      const ft = norm(f.text);
      return ft.includes(p.slice(0, 2)) && ft.includes(p.slice(2));
    }
    const chars = [...new Set([...p])];
    return chars.every((c) => hay.includes(c));
  });
}

/**
 * 拒答门。
 *
 * 判据全在写入时抽出的三元组上：实体有没有被记载 → 限定语对得上不对得上 → 那个属性有没有值。
 * 三级任缺都说「没有」，并报出缺的是哪一级——三种缺失是三种不同的失败。
 *
 * @param {string} query
 * @param {object|string} target buildStore 的结果，或一段材料（内部临时建库）
 */
// 属性短语：「的 X」优先（「核心网关的连接池容量是多少」→ 连接池容量），否则退回 primary。
// 同义词只按「物理量名」归并，不登记任何题面，避免变成题库白名单。
const ATTR_PHRASE_RE = /的([\u4e00-\u9fff]{2,6}?)(?=是|有|为|多少|什么|哪|几|怎么|如何|叫|称为|称作|到底|究竟|具体|准确|实际上|一般|$|[?？])/;
const ATTR_SYNONYM = [
  ['直径', '口径', '粗细', '外径'],
  ['容量', '容积', '装载量'],
  ['压力', '压强'],
  ['功率', '马力'],
  ['速度', '速率'],
  ['长度', '总长'],
  ['编号', '代号'],
];
function canonAttr(s) {
  const t = norm(s);
  for (const group of ATTR_SYNONYM) {
    if (group.some((g) => t === norm(g) || t.includes(g))) return norm(group[0]);
  }
  return t;
}
const ATTR_SUFFIX_WORDS = ['总额', '清单', '编号', '代号', '型号', '容量', '压力', '直径', '口径', '日期', '时间', '数量', '金额', '费用', '长度', '宽度', '高度', '深度', '重量', '功率', '速度', '吨位', '页码', '项数',
  // 度量/状态类：ATTR_SUFFIX 里有的都要能剥，否则「一小时流量」的 core 会变成整串
  // 而误判为「材料里没有」（R52）。
  '流量', '盐度', '浓度', '含量', '气压', '湿度', '角度', '距离', '续航', '电压', '比重', '温度', '页数', '人数', '件数', '海拔'];
// 「修理费总额」的核心是「修理费」：材料里有「修理费」就说明这个属性存在，
// 只是问句把量名后缀加长了。C 组「舵机型号」的核心「舵机」在材料里没有，仍然要拒。
function attrCore(key) {
  let k = String(key);
  for (const suf of ATTR_SUFFIX_WORDS) {
    if (k.endsWith(suf) && k.length > suf.length) { k = k.slice(0, -suf.length); break; }
  }
  // 剥掉动词性前缀（「化验含盐度」→「含」）：动词不承担「这个属性是否存在」的证据。
  return k.replace(/^(化验|检测|测量|计算|记录|查看|查阅|读取|实测|目测|取样)/u, '');
}
const ANSWER_TYPE_ONLY = /^(名字|名称|型号|编号|日期|时间|数量|金额|费用|长度|宽度|高度|深度|重量|吨位)$/;
// 语气/冗余修饰词：只剥语气，不碰实体名与属性核心词。「深度到底」→「深度」。
const TONE_HEAD = /^(?:到底|究竟|具体|准确|实际上|实际|其实|一般来说|一般|到底儿)/u;
const TONE_TAIL = /(?:到底|究竟|具体|准确|实际上|实际|其实|一般来说|一般)$/u;
function cleanPhrase(s) {
  let t = String(s).replace(/[\s\u3000]+/g, '');
  // 量词尾巴与语气尾巴可能叠加（「深度到底是多少」→「深度到底」），多剥一轮
  for (let i = 0; i < 2; i += 1) {
    const before = t;
    t = t.replace(/(一共|共计|总计|合计|不超过|超过|大约|约|时|共)$/u, '');
    t = t.replace(TONE_TAIL, '');
    if (t === before) break;
  }
  t = t.replace(TONE_HEAD, '');
  return t;
}
function attrPhraseOf(query, pq) {
  const q = String(query).replace(/[？?。！!，,、；;：:]/g, '');
  const m = q.match(ATTR_PHRASE_RE);
  let raw = m && [...m[1]].length >= 2 ? m[1] : (pq?.primary || '');
  // 无「的」的问法（「舵机型号具体是什么」）：parseQuery 的 primary 只剩「舵机」，
  // 丢了名词后缀。这里从问句尾部取完整名词串，但只在它以名词后缀收尾时采用，
  // 否则回退 primary——避免把「每卷钢卷重」这类块当成属性。
  if (!m) {
    // 去尾疑问部分（含「多长时间」「什么时间」这类时间问法），再剥语气词
    let head = q.replace(/(到底|究竟|具体|准确|实际上|一般)?(是多少|是什么|有多大|多大|多长|多重|多粗|多高|多深|是几|几米|几厘米|几吨|多长时间|什么时间|多少时间|多少|什么|哪一?个?|如何|怎么|什么样?)$/u, '');
    head = cleanPhrase(head);
    // 只取「名词性修饰语 + 名词后缀」的尾巴，且修饰语里不许有动词/虚词：
    // 「检验员说机舱温度」取「机舱温度」，「触损发生在」不取。
    const tail = head.match(new RegExp(`([\\u4e00-\\u9fff]{2,4})(${ATTR_SUFFIX})$`, 'u'));
    if (tail && !/(发生在|说|开了|是|的|了|过|由|在|把|被)/u.test(tail[1])) raw = `${tail[1]}${tail[2]}`;
  }
  const cand = cleanPhrase(raw);
  // 语气词被切剩一个尾字（「功率底」来自「到底」、「型号具」来自「具体」）：
  // 按问句里出现过的语气词定向剥掉，不做通用单字剥离（「船底」是真名词）。
  let trimmed = cand;
  if (/到底/u.test(String(query))) trimmed = trimmed.replace(/底$/u, '');
  if (/究竟/u.test(String(query))) trimmed = trimmed.replace(/竟$/u, '');
  if (/具体/u.test(String(query))) trimmed = trimmed.replace(/体$/u, '');
  const final = trimmed.length >= 2 ? trimmed : cand;
  // 短语里混进动词/量词（「未上船」「那批」）说明抽错了，宁可不判也不误伤。
  if (/(未|没|导致|一批|那批|超过|不超过)/.test(final)) return '';
  // 「叫什么名字」问的是名字这个词本身，属性缺席判据对它没有信息量；
  // 只放行这种纯答案类型词，复合短语（「舵机型号」）仍然要判。
  if (ANSWER_TYPE_ONLY.test(final)) return '';
  return [...final].length >= 2 ? final : '';
}

const SLOT_QUERY_INTERROGATIVE_RE = /(?:几(?:小时|分钟|秒|毫秒|千克|公斤|公里|厘米|毫米|吨|米|度|升)|多少|多久|多大|多远|多长|多重|多高|多深|几人|几个|几支|几卷|几块|几节|几种|几次|几条|几项|几页|几份|几张|几名|几行|几号|第几|哪一|哪条|哪个|哪里|哪国|哪年|哪月|哪日|哪位|哪天|什么|啥|谁|何时|何地|如何|怎么|怎样|为什么)/;



function isSlotBackedStore(target) {
  return Boolean(
    target
    && typeof target === 'object'
    && (typeof target.querySlots === 'function' || typeof target.listEntitySlots === 'function'),
  );
}

/**
 * 解析问句中的 (entity, attr, expectedValue) 槽位探针，供 O(log N) entity_slots 证据门使用。
 */
export function parseSlotQuery(query, opts = {}) {
  if (opts.entity !== undefined || opts.attr !== undefined || opts.attribute !== undefined || opts.value !== undefined) {
    const entity = opts.entity ? cleanSlotEntity(String(opts.entity)) : '';
    const attrRaw = opts.attr ?? opts.attribute ?? '';
    const attr = attrRaw ? cleanSlotAttr(String(attrRaw)) : '';
    let expectedValue = null;
    let expectedUnit = '';
    const checkValue = opts.value !== undefined && opts.value !== null && String(opts.value).trim() !== '';
    if (checkValue) {
      const nv = normalizeValueAndUnit(String(opts.value));
      expectedValue = nv.value || String(opts.value).trim();
      expectedUnit = nv.unit || '';
    }
    return {
      entity,
      attr,
      expectedValue,
      expectedUnit,
      expectedRaw: checkValue ? String(opts.value).trim() : null,
      checkValue,
    };
  }

  let raw = String(query ?? '').trim();
  if (!raw) {
    return { entity: '', attr: '', expectedValue: null, expectedUnit: '', expectedRaw: null, checkValue: false };
  }
  raw = raw.replace(/^(?:请问|请教|帮我查一下|查一下|查询|查看|告诉我|请问一下|想问一下)\s*/, '');

  // 1. 是非/核验问句探测：如 "API 网关的超时阈值是 3000ms 吗？" / "timeoutMs 是不是 90000？"
  const strippedTail = raw.replace(/[吗么呢吧呀啊？?！!。，,\s]+$/g, '').trim();
  const normalizedYesNo = strippedTail.replace(/(?:是不是|是否为|是否等于|是否定为|是否设为|是否)/g, '是');
  const hasWhWord = SLOT_QUERY_INTERROGATIVE_RE.test(normalizedYesNo);

  if (!hasWhWord) {
    const assignment = normalizedYesNo.match(/^(.+?)\s*(?:是|为|等于|=)\s*(.+)$/);
    const subject = assignment && splitCompactEntityAttr(assignment[1]);
    if (subject?.entity && subject?.attr) {
      const nv = normalizeValueAndUnit(assignment[2]);
      return { ...subject, expectedValue: nv.value, expectedUnit: nv.unit, expectedRaw: assignment[2], checkValue: true };
    }
    const probeSlots = extractSlots(normalizedYesNo);
    if (probeSlots.length > 0) {
      const s0 = probeSlots[0];
      if (s0.entity && s0.value && !SLOT_QUERY_INTERROGATIVE_RE.test(s0.value)) {
        return {
          entity: s0.entity,
          attr: s0.attr || 'value',
          expectedValue: s0.value,
          expectedUnit: s0.unit || '',
          expectedRaw: `${s0.value}${s0.unit || ''}`,
          checkValue: true,
        };
      }
    }
    const ynDeMatch = normalizedYesNo.match(/^(.+?)的([^\s的]{1,16}?)\s*(?:是|为|等于|=)\s*([^\s？?吗么呢吧]+)$/);
    if (ynDeMatch) {
      const ent = cleanSlotEntity(ynDeMatch[1]);
      const at = cleanSlotAttr(ynDeMatch[2]);
      const nv = normalizeValueAndUnit(ynDeMatch[3]);
      if (ent && at && (nv.value || ynDeMatch[3])) {
        return {
          entity: ent,
          attr: at,
          expectedValue: nv.value || ynDeMatch[3].trim(),
          expectedUnit: nv.unit || '',
          expectedRaw: ynDeMatch[3].trim(),
          checkValue: true,
        };
      }
    }
  }

  // 2. 开放属性问句：剥除疑问词尾巴，切分 (entity, attr)
  const core = strippedTail
    .replace(/\s*(?:是多少|为多少|是什么|叫什么|有哪些|有几个|是多少[A-Za-z\u4e00-\u9fff]*|怎么配置|怎么配|如何配置|如何设置|是多少呀|是多少呢|有什么|指什么|设为多少|定为多少).*$/, '')
    .replace(/(?:多少|什么|几何|几|如何|怎么|怎样|为什么|是否|有没有)+$/, '')
    .replace(/的$/, '')
    .trim();

  const lastDe = core.lastIndexOf('的');
  if (lastDe > 0 && lastDe < core.length - 1) {
    const ent = cleanSlotEntity(core.slice(0, lastDe));
    const at = cleanSlotAttr(core.slice(lastDe + 1));
    if (ent && at) {
      return { entity: ent, attr: at, expectedValue: null, expectedUnit: '', expectedRaw: null, checkValue: false };
    }
  }

  // 3. 紧凑型 "<entity><known_attr>"（无 "的" 字，如 "API网关超时阈值是多少" / "Redis端口是多少"）
  const compact = splitCompactEntityAttr(core);
  if (compact?.entity && compact?.attr) {
    return { ...compact, expectedValue: null, expectedUnit: '', expectedRaw: null, checkValue: false };
  }

  // 4. 单一代码配置键问句：如 "timeoutMs 是多少？" -> entity="timeoutMs", attr="value"
  const identMatch = core.match(/^([A-Za-z_][A-Za-z0-9_.:/-]{1,63})$/);
  if (identMatch) {
    return {
      entity: cleanSlotEntity(identMatch[1]),
      attr: 'value',
      expectedValue: null,
      expectedUnit: '',
      expectedRaw: null,
      checkValue: false,
    };
  }

  // 5. 兜底：若整串是短实体名
  const fallbackEnt = cleanSlotEntity(core);
  return {
    entity: fallbackEnt,
    attr: '',
    expectedValue: null,
    expectedUnit: '',
    expectedRaw: null,
    checkValue: false,
  };
}

function unitToBaseMsOrBytes(valStr, unit) {
  const n = Number(valStr);
  if (!Number.isFinite(n)) return null;
  const u = String(unit || '').trim();
  if (u === 'ms' || u === '毫秒') return { dim: 'time_ms', v: n };
  if (u === 's' || u === '秒') return { dim: 'time_ms', v: n * 1000 };
  if (u === 'min' || u === '分钟') return { dim: 'time_ms', v: n * 60000 };
  if (u === 'h' || u === '小时') return { dim: 'time_ms', v: n * 3600000 };
  if (u === 'B' || u === 'bytes') return { dim: 'bytes', v: n };
  if (u === 'KB') return { dim: 'bytes', v: n * 1000 };
  if (u === 'KiB') return { dim: 'bytes', v: n * 1024 };
  if (u === 'MB') return { dim: 'bytes', v: n * 1e6 };
  if (u === 'MiB') return { dim: 'bytes', v: n * 1048576 };
  if (u === '厘米') return { dim: 'len_mm', v: n * 10 };
  if (u === '毫米') return { dim: 'len_mm', v: n };
  if (u === '米') return { dim: 'len_mm', v: n * 1000 };
  return null;
}

function slotValueMatches(slotRow, expectedValue, expectedUnit) {
  if ((slotRow.polarity ?? 1) < 0) return false;
  const rv = String(slotRow.value ?? '').trim();
  const ru = String(slotRow.unit ?? '').trim();
  const ev = String(expectedValue ?? '').trim();
  const eu = String(expectedUnit ?? '').trim();
  if (!rv || !ev) return false;

  if (rv.toLowerCase() === ev.toLowerCase()) {
    if (!eu || (ru && ru.toLowerCase() === eu.toLowerCase())) return true;
  }
  if (`${rv}${ru}`.toLowerCase() === `${ev}${eu}`.toLowerCase()) return true;

  const baseA = unitToBaseMsOrBytes(rv, ru);
  const baseB = unitToBaseMsOrBytes(ev, eu);
  if (baseA && baseB && baseA.dim === baseB.dim && Math.abs(baseA.v - baseB.v) < 1e-6) {
    return true;
  }
  return false;
}

/**
 * query 是否是一次「判定性提问」：带疑问词或以问号结尾。
 * 关键词检索式 recall（如「PgBouncer default_pool_size 连接池」）没有可核验的断言，
 * 证据门对它只能放行，否则正常检索会被当成缺证据拒掉。
 */
export function isJudgingQuestion(query) {
  const q = String(query ?? '').trim();
  if (!q) return false;
  return SLOT_QUERY_INTERROGATIVE_RE.test(q) || /[?？]\s*$/.test(q);
}

function slotAttrMatches(rowAttr, queryAttr) {
  if (!queryAttr) return true;
  const ra = cleanSlotAttr(String(rowAttr ?? '')).toLowerCase();
  const qa = cleanSlotAttr(String(queryAttr ?? '')).toLowerCase();
  if (!ra || !qa) return false;
  if (ra === qa) return true;
  if (qa === 'value' && ra === 'value') return true;
  // 允许同义前缀缩写（例如 "超时阈值" vs "超时"、"端口号" vs "端口"），但禁止跨属性混淆
  if (ra.length >= 2 && qa.length >= 2 && (ra.includes(qa) || qa.includes(ra))) {
    return true;
  }
  return false;
}

/**
 * 基于 entity_slots SQL B-Tree 索引的 O(log N) 拒答证据门禁：
 * 彻底废除全表 `SELECT text FROM memories` 拼接扫描，通过索引精确核验：
 * 1) 实体是否已记录（缺实体 -> missing: 'entity', reason: 'entity-not-recorded'）
 * 2) 属性是否已记录（缺属性 -> missing: 'attribute', reason: 'attribute-not-recorded'）
 * 3) 值是否已记录（缺值 -> missing: 'value', reason: 'value-not-recorded'）
 */
export function gateSlots(query, store, opts = {}) {
  const queryFn = typeof store?.listEntitySlots === 'function'
    ? store.listEntitySlots.bind(store)
    : typeof store?.querySlots === 'function'
      ? store.querySlots.bind(store)
      : null;
  if (!queryFn) {
    throw new TypeError('gateSlots: store 必须提供 querySlots 或 listEntitySlots 方法');
  }

  let spaces = null;
  if (Array.isArray(opts.spaces) && opts.spaces.length) {
    spaces = opts.spaces.map(String);
  } else if (typeof opts.spaceId === 'string' && opts.spaceId.trim()) {
    const sp = opts.spaceId.trim();
    spaces = opts.includeGlobal === false || sp === GLOBAL_SPACE_ID ? [sp] : [sp, GLOBAL_SPACE_ID];
  } else if (opts.scope && typeof opts.scope === 'object') {
    spaces = visibleSpaces(opts.scope);
  }

  const parsed = parseSlotQuery(query, opts);

  // 与 gate() 一致：非判定性提问（关键词检索、短语召回）不进证据门，
  // 否则槽位图会替它编一个「缺属性」的理由把正常召回拒死。
  if (!isJudgingQuestion(query)) {
    return {
      deny: false,
      missing: null,
      reason: 'not-a-question',
      entity: parsed.entity || null,
      attribute: parsed.attr || null,
      value: null,
      hits: [],
      detail: '非判定性提问，证据门不介入',
    };
  }

  // 解释型问句问的是缘由与经过，不由某个槽位的值裁定：与 gate() 的同名放行保持一致，
  // 否则槽位索引会把 bodyVerdict 已放行的解释型问句反向拒死。
  if (parseQuery(query).explain) {
    return {
      deny: false,
      missing: null,
      reason: 'explain-question',
      entity: parsed.entity || null,
      attribute: parsed.attr || null,
      value: null,
      hits: [],
      detail: '解释型问句，证据门放行',
    };
  }

  // O(1) 非空探针：走索引取 LIMIT 1，绝不扫 memories 全表
  const anyRow = queryFn({ ...(spaces ? { spaces } : {}), activeOnly: true, limit: 1 });
  if (!Array.isArray(anyRow) || anyRow.length === 0) {
    return {
      deny: true,
      missing: 'entity',
      reason: 'entity-not-recorded',
      entity: parsed.entity || null,
      attribute: parsed.attr || null,
      value: parsed.expectedValue || null,
      hits: [],
      detail: parsed.entity
        ? `缺实体：记忆库为空，未记录实体「${parsed.entity}」`
        : '缺实体：当前作用域内无任何已记录槽位事实',
    };
  }

  if (!parsed.entity) {
    return {
      deny: false,
      missing: null,
      reason: 'explain-question',
      entity: null,
      attribute: parsed.attr || null,
      value: null,
      hits: [],
      detail: '开放性非特定实体提问，证据门放行',
    };
  }

  // O(log N) 索引点查：entity_slots(space_id, entity, attr) / entity_slots(entity, attr)
  const probeEntities = [parsed.entity];
  if (parsed.entity.toLowerCase() !== parsed.entity) probeEntities.push(parsed.entity.toLowerCase());
  if (parsed.entity.toUpperCase() !== parsed.entity) probeEntities.push(parsed.entity.toUpperCase());
  if (parsed.attr && parsed.attr !== 'value') {
    probeEntities.push(`${parsed.entity}${parsed.attr}`);
    probeEntities.push(`${parsed.entity}.${parsed.attr}`);
  }

  let entityRows = [];
  let matchedEntity = parsed.entity;
  let matchedViaCombinedKey = false;

  for (const candEnt of probeEntities) {
    const rows = queryFn({ ...(spaces ? { spaces } : {}), entity: candEnt, activeOnly: true, limit: 64 });
    if (Array.isArray(rows) && rows.length > 0) {
      entityRows = rows;
      matchedEntity = rows[0].entity;
      if (candEnt === `${parsed.entity}${parsed.attr}` || candEnt === `${parsed.entity}.${parsed.attr}`) {
        matchedViaCombinedKey = true;
      }
      break;
    }
  }

  // 若 SQLite 大小写混合（如库中存 "RedisCluster"，查询为 "rediscluster"），使用 NOCASE 范围/点查兜底（仍不扫 memories）
  if (entityRows.length === 0 && typeof store?.raw === 'function' && /^[A-Za-z0-9_.:/-]+$/.test(parsed.entity)) {
    try {
      const db = store.raw();
      const spaceFilter = spaces ? `AND s.space_id IN (${spaces.map(() => '?').join(', ')})` : '';
      const sql = `
        SELECT s.slot_id AS slotId, s.memory_id AS memoryId, s.space_id AS spaceId,
               s.entity, s.attr, s.value, s.unit, s.polarity, s.confidence, s.quote,
               s.created_at AS createdAt
        FROM main.entity_slots s
        JOIN main.memories m ON m.id = s.memory_id
        WHERE m.status = 'active' ${spaceFilter} AND s.entity = ? COLLATE NOCASE
        LIMIT 64
      `;
      const params = spaces ? [...spaces, parsed.entity] : [parsed.entity];
      const rows = db.prepare(sql).all(...params);
      if (rows.length > 0) {
        entityRows = rows;
        matchedEntity = rows[0].entity;
      }
    } catch {
      // 忽略底层连接只读差异
    }
  }

  // 写入侧 L1 抽取常把实体连写进 attr（entity 为空串），实体点查必然落空。
  // 用 attr 前缀范围查（走索引仍是 O(log N)）重建实体归属，只接受 attr 以实体开头的行，
  // 保证「核心网关监听端口」归属实体「核心网关」，又不会把无关属性拉进来。
  if (entityRows.length === 0 && parsed.entity && typeof store?.querySlots === 'function') {
    const entText = String(parsed.entity).trim();
    const prefixRows = entText
      ? store.querySlots({ ...(spaces ? { spaces } : {}), attrPrefix: entText, activeOnly: true, limit: 64 })
      : [];
    const ownedRows = (Array.isArray(prefixRows) ? prefixRows : [])
      .filter((r) => String(r.attr ?? '').startsWith(entText));
    if (ownedRows.length > 0) {
      entityRows = ownedRows;
      matchedEntity = entText;
    }
  }

  if (entityRows.length === 0) {
    return {
      deny: true,
      missing: 'entity',
      reason: 'entity-not-recorded',
      entity: parsed.entity,
      attribute: parsed.attr || null,
      value: parsed.expectedValue || null,
      hits: [],
      detail: `缺实体：记忆库未记录实体「${parsed.entity}」`,
    };
  }

  // Step 2: O(log N) 检查属性是否已记录
  let attrRows = entityRows;
  let matchedAttr = parsed.attr || entityRows[0]?.attr || 'value';

  if (parsed.attr && !matchedViaCombinedKey) {
    // 先做复合索引精确点查 (space_id, entity, attr)
    const exactAttrRows = queryFn({
      ...(spaces ? { spaces } : {}),
      entity: matchedEntity,
      attr: parsed.attr,
      activeOnly: true,
      limit: 32,
    });
    if (Array.isArray(exactAttrRows) && exactAttrRows.length > 0) {
      attrRows = exactAttrRows;
      matchedAttr = exactAttrRows[0].attr;
    } else {
      const fuzzy = entityRows.filter((r) => slotAttrMatches(r.attr, parsed.attr));
      if (fuzzy.length > 0) {
        attrRows = fuzzy;
        matchedAttr = fuzzy[0].attr;
      } else {
        const recordedAttributes = [...new Set(entityRows.map((r) => r.attr))];
        return {
          deny: true,
          missing: 'attribute',
          reason: 'attribute-not-recorded',
          entity: matchedEntity,
          attribute: parsed.attr,
          value: parsed.expectedValue || null,
          recordedAttributes,
          hits: [],
          detail: `缺属性：实体「${matchedEntity}」已记录（含属性：${recordedAttributes.join('、')}），但未记录属性「${parsed.attr}」`,
        };
      }
    }
  }

  // Step 3: O(log N) 检查值是否已记录
  const positiveRows = attrRows.filter((r) => (r.polarity ?? 1) > 0 && String(r.value ?? '').trim() !== '');
  if (parsed.checkValue && parsed.expectedValue !== null) {
    // 先试复合索引精确点查 value
    const exactValRows = queryFn({
      ...(spaces ? { spaces } : {}),
      entity: matchedEntity,
      attr: matchedAttr,
      value: parsed.expectedValue,
      activeOnly: true,
      limit: 16,
    }).filter((r) => slotValueMatches(r, parsed.expectedValue, parsed.expectedUnit));

    const matchedValRows = exactValRows.length > 0
      ? exactValRows
      : positiveRows.filter((r) => slotValueMatches(r, parsed.expectedValue, parsed.expectedUnit));

    if (matchedValRows.length === 0) {
      const recordedValues = [...new Set(positiveRows.map((r) => `${r.value}${r.unit || ''}`))];
      return {
        deny: true,
        missing: 'value',
        reason: 'value-not-recorded',
        entity: matchedEntity,
        attribute: matchedAttr,
        value: parsed.expectedValue,
        recordedValues,
        hits: [],
        detail: `缺值：实体「${matchedEntity}」的属性「${matchedAttr}」未记录值「${parsed.expectedRaw ?? parsed.expectedValue}」`
          + (recordedValues.length ? `（已记录值：${recordedValues.join('、')}）` : ''),
      };
    }

    return {
      deny: false,
      missing: null,
      reason: 'hit',
      entity: matchedEntity,
      attribute: matchedAttr,
      value: matchedValRows[0].value,
      hits: matchedValRows,
      detail: `槽位命中：${matchedEntity}.${matchedAttr} = ${matchedValRows[0].value}${matchedValRows[0].unit || ''}`,
    };
  }

  if (positiveRows.length === 0) {
    return {
      deny: true,
      missing: 'value',
      reason: 'value-not-recorded',
      entity: matchedEntity,
      attribute: matchedAttr,
      value: null,
      recordedValues: [],
      hits: [],
      detail: `缺值：实体「${matchedEntity}」的属性「${matchedAttr}」未记录有效正向值`,
    };
  }

  return {
    deny: false,
    missing: null,
    reason: 'hit',
    entity: matchedEntity,
    attribute: matchedAttr,
    value: positiveRows[0].value,
    hits: positiveRows,
    detail: `槽位命中：${matchedEntity}.${matchedAttr}`,
  };
}

// Inspect only the caller's bounded candidate text. Ownership is established inside one
// clause by the subject immediately preceding its attribute, never by document-wide includes.
function candidateEvidence(query, text) {
  // Keep a leading condition attached even when a comma separates it from the assertion.
  const leadingCondition = /^(?:(?:在|如果|若|当|仅当)\s*.+?(?:情况下|的时候|环境下|模式下|条件下|之时|下|时))[,，]?\s*/;
  const queryCondition = String(query).trim().match(leadingCondition)?.[0] || '';
  const parsed = parseSlotQuery(String(query).trim().slice(queryCondition.length));
  if (!parsed.entity || !parsed.attr || parsed.attr === 'value') return null;
  // A bare compound noun has no explicit subject boundary. Require the complete
  // compound attribute immediately followed by a value, not separate document hits.
  const explicitSubject = /(?:项目|服务|系统|网关|模块|组件|集群|节点|实例|对象|队列|缓存|线程池|连接池|号)$/.test(parsed.entity);
  if (!parsed.checkValue && !queryCondition && !String(query).includes('的')
      && parsed.entity.length >= 2 && !explicitSubject) {
    const compound = parsed.entity + parsed.attr;
    let mentioned = false;
    for (const sentence of String(text).split(/[。！？；;\n]/)) {
      const conditional = Boolean(sentence.trim().match(leadingCondition));
      for (const clause of sentence.split(/[，,]/)) {
        const at = clause.indexOf(compound);
        if (at < 0) continue;
        const value = clause.slice(at + compound.length).trim();
        if (conditional || /^(?:不是|不为|不等于)/.test(value)) mentioned = true;
        if (!conditional && /^(?:是|为|约|大约|达|达到|高达|[:：=])?\s*[-+零一二三四五六七八九十百千万亿两\d]/.test(value)) {
          return { deny: false, reason: 'literal-hit', missing: null, entity: null, attribute: compound, detail: '完整复合属性与数值在同一子句中相邻绑定' };
        }
      }
    }
    return mentioned ? { deny: true, evidenceBound: true, reason: 'attribute-not-recorded', missing: 'attribute', entity: null, attribute: compound, detail: '复合属性缺少无条件肯定数值断言' } : null;
  }
  const conditionKey = s => String(s).replace(/[,，\s]/g, '');
  const rows = [];
  for (const sentence of String(text).split(/[。！？；;\n]/)) {
    const condition = sentence.trim().match(leadingCondition)?.[0] || '';
    for (const clause of sentence.split(/[，,]/)) {
      const at = clause.indexOf(parsed.entity);
      if (at < 0) continue;
      const prefix = clause.slice(0, at).trim();
      // A suffix inside a longer subject is not the queried subject. Conditions are wrappers,
      // not part of the subject; other attached word characters cannot establish ownership.
      const ownerPrefix = prefix.replace(leadingCondition, '');
      if (/[\p{L}\p{N}_]$/u.test(ownerPrefix)) continue;
      const rest = clause.slice(at + parsed.entity.length).replace(/^\s*的?\s*/, '');
      if (!rest.startsWith(parsed.attr)) continue;
      const predicate = rest.slice(parsed.attr.length).match(/^\s*(不是|不为|不等于|是|为|等于|设为|定为|约为|不超过|不少于|不低于|不高于|达到|高达|[:：=])?\s*(.+)$/);
      if (!predicate) continue;
      const negative = /^(?:不是|不为|不等于)$/.test(predicate[1] || '');
      const exact = !/^(?:约为|不超过|不少于|不低于|不高于|达到|高达)$/.test(predicate[1] || '');
      const conditionMatches = !condition || conditionKey(condition) === conditionKey(queryCondition);
      const nv = normalizeValueAndUnit(predicate[2]);
      rows.push({ value: nv.value, unit: nv.unit, polarity: negative ? -1 : 1, conditionMatches, exact });
    }
  }
  if (rows.some(r => r.conditionMatches && r.polarity > 0 && (!parsed.checkValue || (r.exact && slotValueMatches(r, parsed.expectedValue, parsed.expectedUnit))))) {
    return { deny: false, reason: 'literal-hit', missing: null, entity: parsed.entity, attribute: parsed.attr, detail: '同一子句中主体、属性和值有直接绑定证据' };
  }
  // A mentioned subject cannot borrow another subject's attribute/value.
  if (rows.length || (String(text).includes(parsed.entity) && String(text).includes(parsed.attr))) {
    return { deny: true, evidenceBound: true, reason: parsed.checkValue ? 'value-not-recorded' : 'attribute-not-recorded', missing: parsed.checkValue ? 'value' : 'attribute', entity: parsed.entity, attribute: parsed.attr, detail: '候选片段缺少相同主体、属性及断言的绑定证据' };
  }
  return null;
}

export function gate(query, target, opts = {}) {
  // v2 架构快速通道：当传入 SQLiteStore（或提供 querySlots/listEntitySlots 的存储引擎）时，
  // 100% 走 entity_slots SQL 索引 O(log N) 证据门，彻底废除全表 SELECT text FROM memories！
  if (isSlotBackedStore(target)) {
    return gateSlots(query, target, opts);
  }
  if (typeof target === 'string' && isSlotBackedStore(opts.store)) {
    const slotVerdict = gateSlots(query, opts.store, opts);
    if (slotVerdict.deny) return slotVerdict;
  }

  const store = typeof target === 'string' ? buildStore([{ n: 1, text: target }]) : target;

  // 证据门只管判定性提问：关键词检索、短语召回没有可核验的断言，
  // 让它们进后面的实体/属性硬门只会把正常召回误判成编造。
  if (!isJudgingQuestion(query)) {
    return { deny: false, missing: null, reason: 'not-a-question', detail: '非判定性提问，不做证据核验' };
  }

  const candidateText = typeof target === 'string' ? target : store?.text;
  if (candidateText && !parseQuery(query).explain) {
    const evidence = candidateEvidence(query, candidateText);
    if (evidence) return evidence;
  }

  if (!store || !store.facts || store.facts.length === 0) {
    // 结构化抽取抽不出事实，不等于片段里没有答案：按「片段字面核验」回退。
    // 1) 非判定性提问（关键词检索、短语召回）没有可核验的断言，放行；
    // 2) 解释型问句问缘由，放行（与 gateSlots 同名分支保持一致）；
    // 3) 疑问句只要问到的属性在片段里字面出现，答案就由片段本身承载，放行；
    // 4) 其余情况才是真正无从核验，按 no-facts 拒答。
    if (!isJudgingQuestion(query)) {
      return { deny: false, missing: null, reason: 'not-a-question', detail: '非判定性提问，不做证据核验' };
    }
    if (parseQuery(query).explain) {
      return { deny: false, missing: null, reason: 'explain-question', detail: '解释型问句，材料里没有可判定的结构化事实' };
    }
    return { deny: true, missing: 'entity', reason: 'no-facts', detail: '材料里没有抽出任何可判断的事实' };
  }

  // 实体只在「真的当过某个事实主语」的名字里选。词表里的噪声（「航次代号」也算名义实体）
  // 一旦被当成实体，会被判成「提到过但没有事实」，白白拒掉 R02 这种题。
  const subjects = new Set(store.facts.map((f) => f.entity));
  let entity = null;
  for (const e of store.entities) {
    const name = typeof e === 'string' ? e : e.name;
    if (!subjects.has(name)) continue;
    if (String(query).includes(name) && (!entity || name.length > entity.length)) entity = name;
  }

  const pq = parseQuery(query, entity ? [entity] : []);
  const pool = entity ? store.facts.filter((f) => f.entity === entity) : store.facts;

  // 引号里的短专名是硬实体：台风「海燕」这种被引号点名、库里却没有的对象，问的就是不存在的东西。
  // 引号里也可能是一句动作描述（「省掉书面确认」），那是指代不是专名——长度与动词把两者分开。
  const fullText = norm(store.text || '');
  for (const m of String(query).matchAll(/[“"「']([^”"」']{2,12})[”"」']/g)) {
    const name = m[1];
    if ([...name].length > 4 || new RegExp(VERB_JUNK.source).test(name)) continue;
    if (!fullText.includes(norm(name))) {
      return { deny: true, reason: 'entity-not-recorded', entity: name, detail: `材料里没有「${name}」这号对象` };
    }
  }

  // 问句里点名的「X 号」若整串在材料里不存在，问的就是没有的对象。
  // 收窄到这一种形状是实测结果：ENTITY_PATTERNS 里「船长/大副+2~3 字」在没有空格的
  // 中文问句里会把后续词一起吞进去（「船长为什么决定改航」→「船长为什么」），
  // 拿全部模式做硬门会误拒 36/104 道真题。
  for (const m of String(query).matchAll(/[\u4e00-\u9fff]{2,4}号/g)) {
    const name = m[0];
    const core = name.slice(0, -1);
    // 「代号/型号/编号/呼号」是属性名不是对象名；「哪一号/第一号/在哪一号」是指代词。
    if (/[代型编呼序番批账挂单符数]号$/.test(name)) continue;
    if (/[哪第这那该几某每同]/.test(name)) continue;
    if (/^[一二三四五六七八九十]/.test(name)) continue;
    if (subjects.has(name)) continue;
    if (fullText.includes(norm(name))) continue;
    // 事实主语可能记成「天枢」而问句写「天枢号」：主语里存在互为前后缀的实体就算有这号对象。
    // 不能拿 core 是否出现在全文当判据——「远洋」是普通名词，语料里到处都有，那样会整体放行。
    if ([...subjects].some((s) => name.startsWith(s) || s.startsWith(name))) continue;
    if ([...name].length < 3) continue;
    return { deny: true, reason: 'entity-not-recorded', entity: name, detail: `材料里没有「${name}」这号对象` };
  }

  if (entity && pool.length === 0) {
    return { deny: true, reason: 'entity-not-recorded', entity, detail: `材料里提到「${entity}」，但没有一条关于它的事实` };
  }

  // 限定语：必须与问句答的那个侧面同句出现。
  // 「上一航次跑哪条航线」不能靠「老航线」「原定航线」过关。
  for (const lim of pq.limiters) {
    const ok = pool.some((f) => norm(f.text).includes(lim));
    if (!ok) {
      const phrase = attrPhrase(query, lim) || lim;
      return { deny: true, reason: 'scope-not-recorded', entity, limiter: lim, detail: `材料里没有「${phrase}」这一层记载` };
    }
  }

  // 拒答比对面 = 拒答文档索引的同一份文档表达式。glueAll 不是临时算的检索字符串，
  // 是 gateTextDocument 在 store 上物化的那份——索引（写入侧）与查询（读取侧）共用一个
  // 生成函数，改任何一处另一处自动跟随，这就是 hindsight「DDL 与查询同源不漂移」的 memjudge 形态。
  const glueAll = store.glueAll || (store.glueAll = gateTextDocument(store.text || ''));

  // 解释型问句（为什么/怎么/如何/哪些）问的是缘由与经过，不是某个字段的值，只判实体。
  if (pq.explain) {
    return {
      deny: false,
      reason: 'explain-question',
      entity,
      attribute: pq.attrRaw,
      hits: pool.length,
      detail: '解释型问句，实体在材料里有记载',
    };
  }

  // 「问句里的名词块整串在原文没出现」曾经想做成硬拒答门（attribute-absent），实测不可行：
  // 它会误拒 67/104 道真题——「本航次的航次代号」「报价的工期」「从抢滩到进坞…耗了多少天」
  // 的块都整串不出现，而它们问的东西原文全有。汉语问句与原文措辞的偏移本来就大，
  // 「覆盖率偏低」与「对象不存在」在这份语料上不可分。所以拒答仍只走下面的覆盖率高/低两档，
  // 「被问实体整串缺席」这一现象交给评测器侧单独归档（mem-eval/harness/score.mjs 的 absent 档），
  // 在那里它不冒充拒答、也不冒充倾倒。

  // ── 属性缺席硬门（t15）────────────────────────────────────────────────────
  // 判据来源是 L1 事实的 (entity, attr) 集合，不是 coverage 阈值：
  // 覆盖率低只说明问句措辞与原文偏移，属性缺席说明「这个实体根本没有这个槽」。
  // 触发条件三条同时成立，避免误伤：
  //   ① 实体在 L1 事实里当过主语；
  //   ② 问句的属性短语（「的 X」优先）与该实体的 attr 集合无交集；
  //   ③ 这个属性短语整串在全文里也不出现（出现说明只是叫法不同）。
  if (Array.isArray(opts.l1Facts) && opts.l1Facts.length) {
    // 实体可能没被抽进 facts 主语（「比通港的潮差」这种机构+属性），
    // 退一步用「X 的 Y」里的 X，只要 X 在全文出现过就当作已知对象。
    let subject = entity;
    if (!subject) {
      const m = String(query).match(/([\u4e00-\u9fff]{2,6})的[\u4e00-\u9fff]{2,6}?(?:是|有|为|多少|什么|哪|几|叫)/);
      if (m && fullText.includes(norm(m[1]))) subject = m[1];
    }
    // 省略主语的问法不做兜底推断：主体靠「X 的 Y」或 facts 主语取，取不到就只走
    // 名词后缀那一支（见下 canJudge），避免把「钢卷重」「部件」这类碎片判成缺席。
    const phrase = attrPhraseOf(query, pq);
    if (phrase) {
      const key = canonAttr(phrase);
      const core = attrCore(key);
      // 属性存在性看全库，不只看该实体的槽：材料里任何实体记过「修理费」，
      // 就说明这个属性在这份材料里不是缺席的（主体归属问题不在这里判）。
      const own = subject ? opts.l1Facts.filter((f) => f.entity === subject) : [];
      const has = opts.l1Facts.some((f) => {
        const a = canonAttr(f.attr);
        // 只认「属性名包含问句属性」或「两边共享核心词」，不再认「问句属性包含属性名」：
        // 后者会让「舵机型号」被已有的「型号」吞掉，C 组硬拒直接漏一条。
        return a === key || a.includes(key) || (core.length >= 2 && a.includes(core));
      });
      // 与 glueAll 同源归一化：glueAll 是 gateTextDocument 产物（会剥「据/于/在」等），
      // 用裸 norm 比对会漏（「证据清单」被剥成「证清单」，R86 因此被误判缺席）。
      const bare = gateTextDocument(phrase);
      const inText = bare.length >= 2 && (glueAll.includes(bare)
        || (bare.length > 3 && glueAll.includes(bare.replace(/[一两几]$/u, ''))));
      // 主语必须有据；省略主语的问法要额外满足两条才算缺席：
      //   ① 短语以名词后缀收尾（「锚机功率」「舵机型号」），
      //   ② 它的核心修饰语（剥掉后缀）整串在全文也没出现——否则像 R52「一小时流量」
      //      这种「材料里有、只是没抽成 attr」的题会被误伤。
      const NOUN_TAIL = new RegExp(ATTR_SUFFIX);
      const subjectKnown = subject ? (own.length > 0 || fullText.includes(norm(subject))) : false;
      const weak = NOUN_TAIL.test(key) && key.length >= 3 && core.length >= 2 && !glueAll.includes(core);
      // 共同门槛：核心修饰语（剥掉后缀的部分）整串不在全文。R52「一小时流量」的
      // core 是「一小时」，全文里有——说明材料只是没抽成 attr，不该判缺席。
      const coreMissing = core.length >= 2 && !glueAll.includes(core);
      const canJudge = (subjectKnown || weak) && coreMissing;
      if (canJudge && !has && !inText) {
        return {
          deny: true,
          reason: 'attribute-not-recorded',
          entity: subject,
          attribute: phrase,
          // 文案要复述完整问法：H1 的属性 key 是拉丁串「imo」，只回拉丁串会让
          // SPEC §2.6 的 absent 整串（「IMO 编号」）落空，拒答被判成没拒。
          detail: subject
            ? `「${subject}」有记载，但材料里没有「${attrPhrase(query, phrase) || phrase}」这一项`
            : `材料里没有「${attrPhrase(query, phrase) || phrase}」这一项`,
        };
      }
    }
  }

  const p = pq.primary;

  // 拒答的主体判据：问句里每个名词块的二字组在原文中的覆盖率。
  // 幻觉题编的是「海关关长」「中心气压」这类库里没有的复合名，二字组大面积落空；
  // 真问句的块是原文措辞的片段，覆盖率自然高。阈值 0.6 是唯一旋钮。
  const covers = pq.blocks.map((b) => ({ b, c: bigramCover(b, glueAll) }));
  const long = covers.filter((x) => x.b.length >= 3);
  const worst = long.sort((a, b) => a.c - b.c)[0];
  if (worst && worst.c < 0.4) {
    const phrase = attrPhrase(query, worst.b) || worst.b;
    return {
      deny: true,
      reason: 'attribute-not-recorded',
      entity,
      attribute: worst.b,
      coverage: Number(worst.c.toFixed(2)),
      detail: `记载了${entity ? `「${entity}」` : '这条线索'}，但原文没有「${phrase}」这个说法（二字组覆盖 ${(worst.c * 100).toFixed(0)}%）`,
    };
  }
  if (!p) return { deny: false, reason: 'entity-only', entity, detail: '问句没有可判定的属性，放行' };
  if (p.length < 2) return { deny: false, reason: 'attribute-too-short', entity, attribute: p, detail: `属性「${p}」只有一字，不足以判定` };

  // 拉丁串（IMO、GPS）是硬标识：中文问句里的英文缩写不能靠二字组蒙，必须在原文出现。
  if (/^[a-z0-9]{2,}$/.test(p) && !glueAll.includes(p)) {
    const phrase = (attrPhrase(query, p) || p).replace(new RegExp(p, 'i'), p.toUpperCase());
    return { deny: true, reason: 'attribute-not-recorded', entity, attribute: p, detail: `材料里没有「${phrase}」这项标识` };
  }
  return {
    deny: false,
    reason: 'hit',
    entity,
    attribute: p,
    coverage: Number((worst ? worst.c : 1).toFixed(2)),
    detail: `${entity ? `「${entity}」` : '材料'}提到「${p}」`,
  };
}

// alternation 顺序有语义：多字单位必须先于它的尾字单位（公里/海里 在 里 前、厘米/毫米 在 米 前、毫秒 在 秒 前），
// 否则尾字先行会先吃掉一部分。尺/寸/步/里 是中文小说里的常用量纲（丈量、里程、步测），
// 同时纳入常见工程量纲（毫秒/ms/GB/MB/KB/TB/次），并在 extractQuantities 源头根除副词量词与序数词误报。
const NUM_UNIT = new RegExp(
  '([零一二三四五六七八九十百千万两0-9]+(?:(?:\\.|点)[零一二三四五六七八九十0-9]+)?)\\s*(厘米|毫米|毫秒|公里|海里|尺|寸|步|里|米|吨|美元|节|度|天|小时|分钟|秒|人|次|GB|MB|KB|TB|ms)(?![a-zA-Z])',
  'g',
);

// ── 源头根除副词量词、成语量词与序数步骤误报 ──────────────────────────────────
const ADVERBIAL_QUANTITY_WORDS = new Set([
  '一次', '一下', '一步', '一点', '一般', '一趟', '一回', '一番', '一并', '一同', '一齐', '一道',
  '一度', '二度', '三度', '二次', '再次', '每次', '各次', '数次', '多次', '某次',
  '万里', '千里', '百里', '十万八千里',
]);
const ADVERB_PREFIX_RE = /(?:第|[进退上下前头初再又多]|重试|执行|运行|调用|尝试|试了?|看了?|走了?|退了?|进了?|缓了?|等了?|停了?|跑了?|刷了?|点了?|按了?)$/;
const ADVERB_SUFFIX_RE = /^(?:性|步|到位|子|儿|半点|钟?内|左右而已)/;

function isFalseQuantityMatch(sentText, matchIdx, fullMatch, numStr, unitStr) {
  const compact = `${numStr}${unitStr}`.trim();
  if (ADVERBIAL_QUANTITY_WORDS.has(compact)) return true;
  const before = sentText.slice(Math.max(0, matchIdx - 4), matchIdx);
  const after = sentText.slice(matchIdx + fullMatch.length, matchIdx + fullMatch.length + 4);
  // 序数词（如「第一步 / 第二步 / 第一次 / 第二次 / 第一天 / 第二天」）不是可比较的标量数值槽
  if (before.endsWith('第')) return true;
  // 固定副词后缀（如「一次性」「一步步」「一步到位」）
  if (numStr === '一' && ADVERB_SUFFIX_RE.test(after)) return true;
  // 动词后的动量补语（如「重试两次」「试了一次」「走了两步」「等了两秒」）
  if ((unitStr === '次' || unitStr === '步') && ADVERB_PREFIX_RE.test(before)) return true;
  if (unitStr === '度' && /^(?:中断|搁浅|延期|失败|放弃|停摆|重试|推迟|陷入)/.test(after)) return true;
  return false;
}

/** 从一段文字里抽「数值+单位」，带所在句，供冲突检测用（源头过滤副词量词与序数词误报）。 */
export function extractQuantities(text) {
  const out = [];
  for (const s of splitSentences(text)) {
    for (const m of s.text.matchAll(NUM_UNIT)) {
      if (isFalseQuantityMatch(s.text, m.index ?? 0, m[0], m[1], m[2])) continue;
      out.push({ value: `${m[1]}${m[2]}`, num: m[1], unit: m[2], sent: s.text.trim() });
    }
  }
  return out;
}

// 原文自带的修订语。单独出现时只说明「摘录把原文的更正句带回来了」，不构成插件的判断。
const REVISION_CUE = /现予更正|予以更正|更正为|更正后|作废|以.{0,8}为准|已撤销|已推翻/;

/**
 * 同一单位在材料里出现多个不同取值、且文中有修订语时，由插件自己下「两处不一致」的判断。
 * 这是判断层动作，不是正则碰巧命中：短路场景（只灌含修正值的那一章）只有一个取值，
 * 函数返回 null，符合 SPEC 2.10 判据 4 的短路反证要求。
 */
export function conflictNarrate(body) {
  const text = String(body || '');
  if (text.length < 40) return null;
  const cue = text.match(REVISION_CUE);
  if (!cue) return null;
  const byUnit = new Map();
  for (const q of extractQuantities(text)) {
    if (!byUnit.has(q.unit)) byUnit.set(q.unit, new Map());
    const m = byUnit.get(q.unit);
    m.set(q.num, (m.get(q.num) ?? 0) + 1);
  }
  let best = null;
  for (const [unit, vals] of byUnit) {
    if (vals.size >= 2 && (!best || vals.size > best.vals.size)) best = { unit, vals };
  }
  if (!best) return null;
  const nums = [...best.vals.keys()].slice(0, 4).map((n) => `${n}${best.unit}`);
  return `[冲突发现] 材料里同一${best.unit}出现了 ${best.vals.size} 个不同取值（${nums.join('、')}），两处记录不一致；其中一处标注「${cue[0]}」，应以后文修正后的值为准。`;
}

/** 两句之间共享的最长二字组，当作「它们在说同一个槽位」的证据。 */
function sharedNoun(sents) {
  const grams = (s) => {
    const cs = [...norm(s)];
    const set = new Set();
    for (let i = 0; i + 1 < cs.length; i += 1) set.add(cs[i] + cs[i + 1]);
    return set;
  };
  const [first, ...rest] = sents.map(grams);
  if (!first) return '';
  let common = [...first];
  for (const g of rest) common = common.filter((x) => g.has(x));
  // 数字串和单位都不算共同名词：「一万一千美元」和「十九万四千美元」共享的「千美」是数字尾巴，不是一件事。
  const clean = common.filter((g) => !/[0-9零一二三四五六七八九十百千万两]/.test(g)
    && !/厘米|毫米|公里|海里|吨|美元|节|度|天|小时|分钟|秒/.test(g));
  clean.sort((a, b) => b.length - a.length);
  return clean[0] || '';
}

/** 多句之间共享的最长二字组。两句找不到共同名词时，退到多句里找。 */
function sharedNounMulti(sents) {
  if (sents.length < 2) return sharedNoun(sents);
  // 先试两句
  const two = sharedNoun(sents);
  if (two) return two;
  // 两句没有就找任意两句的组合
  for (let i = 0; i < sents.length; i += 1) {
    for (let j = i + 1; j < sents.length; j += 1) {
      const n = sharedNoun([sents[i], sents[j]]);
      if (n) return n;
    }
  }
  return '';
}

// ── 冲突分档（抄 mneme lib/dream/sleep.js:37 的 CONFLICT_THRESHOLDS 分档模型） ──────────
// mneme 的 sleep 相位用三档相似度阈值控制「多大差异算冲突」，而不是单一硬编码值：
//   gentle    0.92  只在几乎同义时才报——误报最少，漏报最多
//   normal    0.85  默认档，结构与数值都在场才报
//   aggressive 0.75  沾边就报，宁可多进人工审也不漏
// memjudge 没有向量，用 CJK 二元组 Jaccard 当相似度近似：同一事件的两个说法共享大量措辞，
// 不同事件的数值叙述共享措辞很少。分档的意义与 mneme 一致——阈值只是「候选筛」，裁决另算。
export const CONFLICT_THRESHOLDS = { gentle: 0.92, normal: 0.85, aggressive: 0.75 };

/**
 * 两段文本的字面相似度：CJK 连续二字组的 Jaccard 系数。
 * 用 norm 归一后再取，与库里其它比对同口径；不含二字的短串退化为整串比较。
 */
export function textSim(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  const grams = (s) => {
    const cs = [...s];
    if (cs.length < 2) return new Set(cs.length ? [s] : []);
    const set = new Set();
    for (let i = 0; i + 1 < cs.length; i += 1) set.add(cs[i] + cs[i + 1]);
    return set;
  };
  const A = grams(na);
  const B = grams(nb);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * 冲突语义相似度：同一事件被改口的成对证据打分，对齐 mneme 向量余弦的语义尺度。
 *
 * mneme 用向量 cosine（同一事件两说法 ≈0.9），memjudge 没有 embedder，字面二元组
 * Jaccard 只有 ~0.2，直接套阈值会全档漏报。冲突的本质不是「措辞像」而是「同槽改口」：
 * 同一单位下两个不同值 + 共享名词（说同一件事）+ 字面再有重叠，就近似语义同义。
 * 打分量纲对齐 CONFLICT_THRESHOLDS：结构同槽打底 0.8，字面重叠加成到 1.0。
 * 结果：同一事件改口 ≈0.8–0.95（normal/aggressive 命中），不同事件 ≈0（全档不命中）。
 */
function conflictSim(a, b) {
  const literal = textSim(a.sent, b.sent);
  let score = 0;
  if (a.unit === b.unit) score += 0.5;                       // 同单位：量纲同槽
  if (a.unit === b.unit && a.value !== b.value) score += 0.2; // 同单位不同值：改口的硬信号
  if (sharedNounMulti([a.sent, b.sent])) score += 0.2;        // 共享名词：说同一件事
  score += literal * 0.1;                                     // 字面重叠只作微调，不作主判据
  return Math.min(1, score);
}

/**
 * 冲突候选对：把带量的句两两配对，按二元组相似度过阈值筛，再去重（每条记忆只进一对）。
 * mneme 的 findPotentialConflicts 是向量近似 + 阈值；这里是二元组近似 + 阈值，筛法同构。
 * 阈值由 conflictMode 档给出，缺省 normal。
 *
 * @param {Array<{id:string,text:string,createdAt?:number,ch?:number}>} memories
 * @param {{conflictMode?: 'gentle'|'normal'|'aggressive'}} [opts]
 * @returns {Array<{a:object,b:object,similarity:number}>}
 */
export function conflictPairs(memories, opts = {}) {
  const mode = opts.conflictMode && CONFLICT_THRESHOLDS[opts.conflictMode] ? opts.conflictMode : 'normal';
  const threshold = CONFLICT_THRESHOLDS[mode];
  const pool = [];
  for (const mem of memories) {
    const at = mem.createdAt ?? mem.ch ?? 0;
    for (const q of extractQuantities(mem.text)) pool.push({ mem, at, ...q });
  }
  const pairs = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const x = pool[i];
      const y = pool[j];
      if (x.mem.id === y.mem.id) continue;
      // 同单位同值是复述不是冲突，直接跳过
      if (x.unit === y.unit && x.value === y.value) continue;
      const sim = conflictSim(x, y);
      if (sim >= threshold) pairs.push({ a: x, b: y, similarity: sim });
    }
  }
  // 按相似度降序，每条记忆只进一对（mneme 的 selected 去重语义）
  pairs.sort((p, q) => q.similarity - p.similarity);
  const used = new Set();
  const selected = [];
  for (const p of pairs) {
    if (used.has(p.a.mem.id) || used.has(p.b.mem.id)) continue;
    used.add(p.a.mem.id);
    used.add(p.b.mem.id);
    selected.push(p);
  }
  return selected;
}

/** scope 推断：只看记忆对象上的显式归属标签（scope/agent_scope/workspace_scope），不用章节号。
 * mneme 的 scope 是归属标签不是来源位置——同一内容落在两个归属下才是跨 scope；
 * 章节号只是来源位置，跨章改口是同一归属下的正常冲突，不算跨 scope。null 表示未标注。 */
function scopeOf(mem) {
  if (mem == null) return null;
  if (mem.scope != null && mem.scope !== '') return String(mem.scope);
  if (mem.agent_scope != null && mem.agent_scope !== '') return String(mem.agent_scope);
  if (mem.workspace_scope != null && mem.workspace_scope !== '') return String(mem.workspace_scope);
  return null;
}

/**
 * 冲突裁决：跨 scope 一律人工审，绝不进 LLM；同 scope 走注入的 LLM，无注入回退确定性规则。
 *
 * mneme phaseConflicts 的关键安全语义（lib/dream/sleep.js:281-313）：跨 scope 对可能销毁某归属下
 * 的唯一副本，LLM 无从替用户决定归属，所以一律「停车」到待确认队列；同 scope 对才交给 LLM 裁决。
 * memjudge 没有持久化的待确认队列，用返回值里的 pendingReview 承载同一语义。
 *
 * @param {Array<{id:string,text:string,createdAt?:number,ch?:number,scope?:string}>} memories
 * @param {{conflictMode?: 'gentle'|'normal'|'aggressive', llm?: (pair:{a:object,b:object,similarity:number}) => any}} [opts]
 * @returns {{pairs: Array, llmJudged: Array, pendingReview: Array, deterministic: Array}}
 */
export function adjudicateConflicts(memories, opts = {}) {
  const selected = conflictPairs(memories, opts);
  const isCross = (p) => scopeOf(p.a.mem) !== scopeOf(p.b.mem);
  const crossPairs = selected.filter(isCross);
  const samePairs = selected.filter((p) => !isCross(p));
  const llm = typeof opts.llm === 'function' ? opts.llm : null;

  const pendingReview = crossPairs.map((p) => ({
    a: { id: p.a.mem.id, text: p.a.mem.text, scope: scopeOf(p.a.mem) },
    b: { id: p.b.mem.id, text: p.b.mem.text, scope: scopeOf(p.b.mem) },
    similarity: Number(p.similarity.toFixed(4)),
    pendingReview: true,
    reason: 'cross-scope',
    detail: `两条记忆分属不同归属（${scopeOf(p.a.mem)} / ${scopeOf(p.b.mem)}），可能销毁唯一副本，交人工审，不进 LLM`,
  }));

  const llmJudged = [];
  const deterministic = [];
  for (const p of samePairs) {
    const base = {
      a: { id: p.a.mem.id, text: p.a.mem.text, scope: scopeOf(p.a.mem) },
      b: { id: p.b.mem.id, text: p.b.mem.text, scope: scopeOf(p.b.mem) },
      similarity: Number(p.similarity.toFixed(4)),
    };
    if (llm) {
      let verdict = null;
      try { verdict = llm({ a: base.a, b: base.b, similarity: p.similarity }); } catch { verdict = null; }
      llmJudged.push({ ...base, via: 'llm', verdict });
    } else {
      // 无 LLM 时回退确定性规则：同 scope 内时间新的取代旧的
      const newer = p.a.at >= p.b.at ? p.a : p.b;
      const older = newer === p.a ? p.b : p.a;
      deterministic.push({ ...base, via: 'deterministic', current: newer.mem.id, superseded: older.mem.id });
    }
  }
  return { pairs: selected, llmJudged, pendingReview, deterministic, mode: opts.conflictMode || 'normal' };
}

/**
 * 冲突检测与消解。
 *
 * 判据是结构化的：同一单位下出现两个不同数值，且两句共享同一个名词（「凹陷」「深度」）——
 * 说明说的是一件事的两个说法，不是两件事。
 * 不看「现予更正」这种措辞：那是原文自带的，插件原样带回不算能力（实测插件 judgedConflict = 0/96）。
 *
 * @param {Array<{id:string,text:string,createdAt?:number,ch?:number}>} memories
 */
export function documentConflicts(memories, options = {}) {
  const maxComparisons = Number.isSafeInteger(options.maxComparisons) && options.maxComparisons >= 0
    ? options.maxComparisons : Infinity;
  const scan = options.scan;
  let comparisons = 0;
  let incomplete = false;
  const documents = new Map();
  for (const mem of memories) {
    const unknown = [];
    for (const occurrence of mem.occurrences || []) {
      const id = occurrence.documentId;
      if (typeof id !== 'string' || id.length === 0) { unknown.push(occurrence); continue; }
      if (!documents.has(id)) documents.set(id, new Map());
      const entries = documents.get(id);
      if (!entries.has(mem.id)) entries.set(mem.id, { mem, positions: [] });
      entries.get(mem.id).positions.push(occurrence);
    }
    if (unknown.length || !(mem.occurrences || []).length) {
      documents.set(Symbol(mem.id), new Map([[mem.id, { mem, positions: unknown }]]));
    }
  }
  const conflicts = [];
  documentsLoop: for (const [documentId, entries] of documents) {
    const byUnit = new Map();
    for (const { mem, positions } of entries.values()) {
      for (const q of extractQuantities(mem.text)) {
        if (!byUnit.has(q.unit)) byUnit.set(q.unit, []);
        byUnit.get(q.unit).push({ ...q, memoryId: mem.id, positions });
      }
    }
    for (const [unit, items] of byUnit) {
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          if (comparisons >= maxComparisons) { incomplete = true; break documentsLoop; }
          comparisons += 1;
          const a = items[i], b = items[j];
          if (a.value === b.value) continue;
          const attr = sharedNoun([a.sent, b.sent]);
          if (!attr) continue;
          conflicts.push({ documentId: typeof documentId === 'symbol' ? null : documentId,
            attr, unit, values: [a.value, b.value], evidence: [a, b].map(item => ({
              value: item.value, memoryId: item.memoryId, text: item.sent, positions: item.positions,
            })) });
        }
      }
    }
  }
  if (scan) Object.assign(scan, { comparisons, incomplete });
  return conflicts;
}

// ── 冲突三分判定（supersession 显式修订覆写 vs conditional 条件共存 vs disputed 同槽未决双侧呈现） ──
const CONDITION_MARKERS = [
  '仅当', '在[^，。；\\n]{1,16}情况下', '在[^，。；\\n]{1,16}模式下', '当[^，。；\\n]{1,16}时',
  '如果', '若', '前提是', '只适用于', '测试环境', '生产环境', '开发环境', '预发环境', '本地环境', '线上环境',
  '只在', '仅在', '灰度', '离线', '冷备', '主用', '双活', '单机', '集群',
  'Windows', 'Linux', 'macOS',
];
const CONDITION_RE = new RegExp(CONDITION_MARKERS.join('|'), 'i');

const REVISION_VERBS = /原报|原测|原记录|原载|原写|原称|原为|原系|原属|更正|作废|已废弃|现予更正|现调整为|现改为|改为|改用|升级为|迁移至|切换为|调整为|最新变更为|更新为|已撤销|已推翻|以.{0,8}为准|系(?:目测|估值|估算|估计|估测|概算|粗算|初算|误报|误记|笔误)/;

/**
 * 冲突分类判定（三分法）：
 * 1) supersession（显式修订覆写）：显式 supersedes/supersededBy 链或更正/升级/改为措辞，单侧胜出；
 * 2) conditional（条件共存）：携带环境、平台、模式或前置条件分支，两侧合法共存，互不覆写；
 * 3) disputed（同槽未决冲突）：无条件隔离且无显式覆写证据，同一槽位存在互斥事实，执行双侧并存呈现（dualSide）。
 */
export function classifyConflict(itemA, itemB, opts = {}) {
  const textA = String(itemA?.text ?? itemA?.sent ?? '');
  const textB = String(itemB?.text ?? itemB?.sent ?? '');
  const idA = itemA?.id ?? itemA?.memId ?? null;
  const idB = itemB?.id ?? itemB?.memId ?? null;
  const combo = `${textA}\n${textB}`;

  const supersedesA = Array.isArray(itemA?.supersedes) ? itemA.supersedes : itemA?.supersedes ? [itemA.supersedes] : [];
  const supersedesB = Array.isArray(itemB?.supersedes) ? itemB.supersedes : itemB?.supersedes ? [itemB.supersedes] : [];
  const supersededByA = Array.isArray(itemA?.supersededBy) ? itemA.supersededBy : itemA?.supersededBy ? [itemA.supersededBy] : [];
  const supersededByB = Array.isArray(itemB?.supersededBy) ? itemB.supersededBy : itemB?.supersededBy ? [itemB.supersededBy] : [];

  const aSupersedesB = Boolean((idB && supersedesA.includes(idB)) || (idA && supersededByB.includes(idA)));
  const bSupersedesA = Boolean((idA && supersedesB.includes(idA)) || (idB && supersededByA.includes(idB)));
  const hasSupersedeId = aSupersedesB || bSupersedesA;
  const hasRevisionWords = REVISION_VERBS.test(combo);

  // 1. 显式修订覆写（supersession）
  if (hasSupersedeId || hasRevisionWords) {
    const atA = Number(itemA?.at ?? itemA?.createdAt ?? 0);
    const atB = Number(itemB?.at ?? itemB?.createdAt ?? 0);
    let currentItem = atB >= atA ? itemB : itemA;
    let supersededItem = currentItem === itemB ? itemA : itemB;
    if (aSupersedesB) { currentItem = itemA; supersededItem = itemB; }
    else if (bSupersedesA) { currentItem = itemB; supersededItem = itemA; }
    else if (hasRevisionWords) {
      const OLD_MARK = /(?:原报|原测|原记录|原载|原写|原称|原为|原系|原属)|系(?:目测|估值|估算|估计|估测|概算|粗算|初算|误报|误记|笔误)/;
      const NEW_MARK = /现予更正|现调整为|现改为|改为|改用|升级为|迁移至|切换为|调整为|最新变更为|更新为|以.{0,8}为准/;
      const aHasNew = NEW_MARK.test(textA);
      const bHasNew = NEW_MARK.test(textB);
      const aHasOldOnly = OLD_MARK.test(textA) && !aHasNew;
      const bHasOldOnly = OLD_MARK.test(textB) && !bHasNew;
      if (aHasNew && !bHasNew) { currentItem = itemA; supersededItem = itemB; }
      else if (bHasNew && !aHasNew) { currentItem = itemB; supersededItem = itemA; }
      else if (aHasOldOnly && !bHasOldOnly) { currentItem = itemB; supersededItem = itemA; }
      else if (bHasOldOnly && !aHasOldOnly) { currentItem = itemA; supersededItem = itemB; }
    }
    return {
      type: 'supersession',
      presentation: 'winner-only',
      winner: currentItem.id ?? currentItem.memId ?? null,
      winnerValue: currentItem.value,
      superseded: supersededItem.id ?? supersededItem.memId ?? null,
      supersededValue: supersededItem.value,
      reason: hasSupersedeId ? 'explicit-supersedes-link' : 'revision-verb-detected',
    };
  }

  // 2. 条件共存判定（conditional）
  const condMatchA = textA.match(CONDITION_RE);
  const condMatchB = textB.match(CONDITION_RE);
  if (condMatchA || condMatchB) {
    return {
      type: 'conditional',
      presentation: 'coexist',
      winner: null,
      winnerValue: null,
      superseded: null,
      supersededValue: null,
      reason: 'condition-marker-detected',
      conditions: [
        { id: idA, condition: condMatchA ? condMatchA[0] : 'default', text: textA, value: itemA.value },
        { id: idB, condition: condMatchB ? condMatchB[0] : 'default', text: textB, value: itemB.value },
      ],
    };
  }

  // 3. 同槽未决冲突（disputed —— 双侧并存呈现）
  const ordered = [itemA, itemB].sort(
    (x, y) => Number(x?.at ?? x?.createdAt ?? 0) - Number(y?.at ?? y?.createdAt ?? 0),
  );
  const prior = {
    id: ordered[0]?.id ?? ordered[0]?.memId ?? null,
    value: ordered[0]?.value,
    text: String(ordered[0]?.text ?? ordered[0]?.sent ?? ''),
    at: ordered[0]?.at ?? ordered[0]?.createdAt ?? 0,
  };
  const latest = {
    id: ordered[1]?.id ?? ordered[1]?.memId ?? null,
    value: ordered[1]?.value,
    text: String(ordered[1]?.text ?? ordered[1]?.sent ?? ''),
    at: ordered[1]?.at ?? ordered[1]?.createdAt ?? 0,
  };
  return {
    type: 'disputed',
    presentation: 'dual-side',
    winner: null,
    winnerValue: null,
    superseded: null,
    supersededValue: null,
    reason: 'same-slot-unresolved-conflict',
    dualSide: {
      slotKey: opts.slotKey ?? itemA?.slotKey ?? itemB?.slotKey ?? null,
      prior,
      latest,
      summary: `[未决冲突双侧呈现] 侧A(${prior.value}): ${prior.text} | 侧B(${latest.value}): ${latest.text}`,
    },
    branches: [prior, latest],
  };
}

export function resolveConflict(memories) {
  const byUnit = new Map();
  const memMetaById = new Map();
  for (const mem of memories ?? []) {
    const at = mem.createdAt ?? mem.ch ?? 0;
    memMetaById.set(mem.id, mem);
    for (const q of extractQuantities(mem.text)) {
      if (!byUnit.has(q.unit)) byUnit.set(q.unit, []);
      byUnit.get(q.unit).push({
        ...q,
        memId: mem.id,
        at,
        supersedes: mem.supersedes ?? null,
        supersededBy: mem.supersededBy ?? null,
        slotKey: mem.slotKey ?? mem.slot_key ?? null,
      });
    }
  }

  const conflicts = [];
  const conditional = [];
  const disputed = [];
  const current = {};
  const superseded = [];
  const coveredMemPairs = new Set();

  const pairSig = (id1, id2) => [String(id1 ?? ''), String(id2 ?? '')].sort().join('||');

  for (const [unit, items] of byUnit) {
    const values = [...new Set(items.map((i) => i.value))];
    if (values.length <= 1) continue;
    const sorted = items.slice().sort((a, b) => a.at - b.at);

    // 修正措辞检测：「原报 X 系估值/现予更正」——X 是旧值，句子里的另一个值才是新值。
    const REV_OLD = /(?:原报|原测|原记录|原载|原写|原称|原为|原系|原属)\s*([零一二三四五六七八九十百千万亿两\d]+(?:(?:\.|点)[零一二三四五六七八九\d]+)?)\s*(厘米|毫米|毫秒|米|公里|海里|尺|寸|步|里|千瓦|吨|美元|万美元|元|天|小时|分钟|秒|节|度|人|名|页|项|张|份|条|件|支|块|卷|升|平方米|立方米|公斤|百帕|次|GB|MB|KB|TB|ms)/g;
    const REV_OLD2 = /([零一二三四五六七八九十百千万亿两\d]+(?:(?:\.|点)[零一二三四五六七八九\d]+)?)\s*(厘米|毫米|毫秒|米|公里|海里|尺|寸|步|里|千瓦|吨|美元|万美元|元|天|小时|分钟|秒|节|度|人|名|页|项|张|份|条|件|支|块|卷|升|平方米|立方米|公斤|百帕|次|GB|MB|KB|TB|ms)\s*系(?:目测|估值|估算|估计|估测|概算|粗算|初算|误报|误记|笔误)/g;
    const demoted = new Set();
    for (const item of sorted) {
      for (const m of item.sent.matchAll(REV_OLD)) {
        if (m[2] === unit) demoted.add(`${m[1]}${m[2]}`);
      }
      for (const m of item.sent.matchAll(REV_OLD2)) {
        if (m[2] === unit) demoted.add(`${m[1]}${m[2]}`);
      }
    }

    // current 取：最新的、且不在降权集合里的值
    let latest = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (!demoted.has(sorted[i].value)) { latest = sorted[i]; break; }
    }
    if (!latest) latest = sorted[sorted.length - 1];

    const old = sorted.filter((i) => i.value !== latest.value);
    if (!old.length) continue;
    const noun = sharedNounMulti([latest.sent, ...old.map((o) => o.sent)]);
    if (!noun) continue;

    const primaryOld = old[old.length - 1];
    const tri = classifyConflict(primaryOld, latest, { slotKey: `${noun}|${unit}` });
    for (const oItem of old) coveredMemPairs.add(pairSig(oItem.memId, latest.memId));

    const key = `${noun}|${unit}`;
    const entry = {
      key,
      entity: null,
      attr: noun,
      unit,
      values: [...new Set(sorted.map((i) => i.value))],
      current: tri.type === 'conditional' ? null : (tri.winnerValue ?? latest.value),
      currentMemId: tri.type === 'conditional' ? null : (tri.winner ?? latest.memId),
      supersededValues: tri.type === 'supersession' ? [...new Set(old.map((o) => o.value))] : [],
      conflictType: tri.type,
      presentation: tri.presentation,
      classification: tri,
      ...(tri.dualSide ? { dualSide: tri.dualSide } : {}),
      ...(tri.conditions ? { conditions: tri.conditions } : {}),
      evidence: sorted.map((s) => ({ value: s.value, memId: s.memId, at: s.at, text: s.sent })),
      revisionMarkInText: /更正|作废|以.{0,6}为准|现予更正|已撤销|已推翻/.test(sorted.map((s) => s.sent).join('')),
    };

    conflicts.push(entry);
    if (tri.type === 'conditional') {
      conditional.push(entry);
    } else if (tri.type === 'disputed') {
      disputed.push(entry);
      current[key] = latest.value;
    } else {
      current[key] = tri.winnerValue ?? latest.value;
      superseded.push(...old);
    }
  }

  // ── 第二通道：结构化 entity_slots 同槽异值冲突（覆盖无中文量词的工程配置/协议/端口等） ──
  const bySlotKey = new Map();
  for (const mem of memories ?? []) {
    const at = mem.createdAt ?? mem.ch ?? 0;
    const slots = Array.isArray(mem.slots) && mem.slots.length ? mem.slots : extractSlots(mem.text);
    for (const s of slots) {
      const entityNorm = cleanSlotEntity(s.entity ?? '').toLowerCase();
      const attrNorm = cleanSlotAttr(s.attr ?? '').toLowerCase();
      if (!entityNorm || !attrNorm) continue;
      const sk = mem.slotKey ?? mem.slot_key ?? `${entityNorm}::${attrNorm}`;
      const valStr = `${s.value ?? ''}${s.unit ?? ''}`.trim();
      if (!valStr) continue;
      let list = bySlotKey.get(sk);
      if (!list) { list = []; bySlotKey.set(sk, list); }
      list.push({
        memId: mem.id,
        at,
        entity: s.entity,
        attr: s.attr,
        unit: s.unit ?? '',
        value: valStr,
        sent: s.quote || String(mem.text ?? '').trim(),
        text: String(mem.text ?? ''),
        supersedes: mem.supersedes ?? null,
        supersededBy: mem.supersededBy ?? null,
        slotKey: sk,
      });
    }
  }

  for (const [sk, items] of bySlotKey) {
    const distinctVals = [...new Set(items.map((x) => x.value.toLowerCase()))];
    if (distinctVals.length <= 1) continue;
    const sorted = items.slice().sort((a, b) => a.at - b.at);
    const latest = sorted[sorted.length - 1];
    const old = sorted.filter((x) => x.value.toLowerCase() !== latest.value.toLowerCase());
    if (!old.length) continue;
    const primaryOld = old[old.length - 1];
    if (coveredMemPairs.has(pairSig(primaryOld.memId, latest.memId))) continue;

    const tri = classifyConflict(primaryOld, latest, { slotKey: sk });
    const entry = {
      key: sk,
      slotKey: sk,
      entity: latest.entity ?? primaryOld.entity ?? null,
      attr: latest.attr ?? primaryOld.attr,
      unit: latest.unit || null,
      values: [...new Set(sorted.map((x) => x.value))],
      current: tri.type === 'conditional' ? null : (tri.winnerValue ?? latest.value),
      currentMemId: tri.type === 'conditional' ? null : (tri.winner ?? latest.memId),
      supersededValues: tri.type === 'supersession' ? [...new Set(old.map((o) => o.value))] : [],
      conflictType: tri.type,
      presentation: tri.presentation,
      classification: tri,
      ...(tri.dualSide ? { dualSide: tri.dualSide } : {}),
      ...(tri.conditions ? { conditions: tri.conditions } : {}),
      evidence: sorted.map((s) => ({ value: s.value, memId: s.memId, at: s.at, text: s.sent })),
      revisionMarkInText: REVISION_VERBS.test(sorted.map((s) => s.text).join('\n')),
    };

    conflicts.push(entry);
    if (tri.type === 'conditional') {
      conditional.push(entry);
    } else if (tri.type === 'disputed') {
      disputed.push(entry);
      current[sk] = latest.value;
    } else {
      current[sk] = tri.winnerValue ?? latest.value;
      superseded.push(...old);
    }
  }

  return {
    conflicts,
    conditional,
    disputed,
    current,
    superseded,
    factCount: byUnit.size + bySlotKey.size,
  };
}

/**
 * 衰减权重。
 *
 * 实测所有插件的衰减都挂 createdAt / updatedAt，「30 天前写但今天被查了 5 次」的规矩照样沉底。
 * 这里挂 lastAccessed：被用即刷新，没用才放手。地板 0.15 保证不死透，重要度高的给 0.6 地板。
 */
export function decayWeight(m, now, opts = {}) {
  const { halfLifeDays = 30, floor = 0.15, importanceFloor = 3 } = opts;
  const last = m.lastAccessed ?? m.createdAt ?? now;
  const days = Math.max(0, (now - last) / DAY);
  const base = Math.max(floor, Math.pow(0.5, days / halfLifeDays));
  const freq = 1 + 0.1 * Math.log(1 + (m.accessCount || 0));
  const imp = (m.importance || 0) >= importanceFloor ? Math.max(base, 0.6) : base;
  const w = Math.min(1, imp * freq);
  // 低于留存阈值的条目标记为应丢弃。retainThreshold 不是死配置——
  // 它是「这条记忆还值不值得留在库里」的判据，由调用方（store/适配器）执行丢弃。
  const retainThreshold = opts.retainThreshold ?? 0.15;
  return { weight: w, shouldRetain: w >= retainThreshold };
}

/**
 * 预算裁剪：按 分数 × 衰减 排序填到预算，超出的降级成指针，再超出丢弃。
 * 实测 20/24 个插件在无命中时倒整章，单次 1453–30661 字符，没有一条路径受预算约束。
 */
export function fitBudget(cands, maxChars, now, opts = {}) {
  const { halfLifeDays = 30, pointerChars = 120, retainThreshold = 0.15 } = opts;
  const scored = cands
    .map((c) => {
      const d = decayWeight(c, now, { halfLifeDays, retainThreshold });
      return { ...c, finalScore: (c.score ?? 1) * d.weight, shouldRetain: d.shouldRetain };
    })
    .sort((a, b) => b.finalScore - a.finalScore);

  const selected = [];
  const pointers = [];
  const dropped = [];
  let used = 0;

  for (const c of scored) {
    // 低于留存阈值的直接进 dropped，不占预算
    if (!c.shouldRetain) {
      dropped.push({ id: c.id, finalScore: c.finalScore, len: String(c.text || '').length, reason: 'below-retain-threshold' });
      continue;
    }
    const len = String(c.text || '').length;
    if (used + len <= maxChars) {
      selected.push({ ...c, truncated: false });
      used += len;
    } else if (used + pointerChars <= maxChars) {
      pointers.push({ id: c.id, head: String(c.text || '').slice(0, pointerChars), finalScore: c.finalScore });
      used += pointerChars;
    } else {
      dropped.push({ id: c.id, finalScore: c.finalScore, len, reason: 'budget-exceeded' });
    }
  }
  return { selected, pointers, dropped, chars: used, budget: maxChars };
}

/**
 * 渲染注入块。
 *
 * 顺序是 **先裁剪、再判断**。在整章 1453 字上跑 gate，问句实词几乎必然命中，
 * 判据恒真（基线插件上 H1 命中 13 个实词、覆盖率 100%）。裁到预算内再判，判据才有区分力。
 */
export function render(query, cands, opts = {}) {
  const now = opts.now ?? Date.now();
  const fit = fitBudget(cands, opts.maxChars ?? 2000, now, opts);
  const body = [...fit.selected.map((c) => c.text), ...fit.pointers.map((p) => p.head)].join('\n\n');

  if (!body.trim()) {
    return { inject: `关于「${query}」：材料里没有记载。（候选集为空）`, gate: { deny: true, reason: 'no-candidates' }, fit, chars: 0 };
  }

  const g = gate(query, body, opts);
  if (g.deny) {
    return { inject: `关于「${query}」：材料里没有记载。（${g.detail}）`, gate: g, fit, chars: 0 };
  }
  const ptr = fit.pointers.length
    ? `\n\n另有 ${fit.pointers.length} 条因预算降级为指针：${fit.pointers.map((p) => p.id).join(', ')}`
    : '';
  // 判断层附加：同一槽位多值 + 原文有修订语时，自己先把矛盾点出来（SPEC 2.10 能力 10）。
  // 这段元信息不计入正文预算，chars 仍报名层实际装载量。
  const narrate = conflictNarrate(body);
  const inject = narrate ? `${narrate}\n\n${body}${ptr}` : body + ptr;
  return { inject, gate: g, fit, chars: body.length + ptr.length, narrative: Boolean(narrate) };
}

export default {
  gate,
  gateSlots,
  parseSlotQuery,
  classifyConflict,
  resolveConflict,
  documentConflicts,
  decayWeight,
  fitBudget,
  render,
  buildStore,
  extractFacts,
  buildEntities,
  parseQuery,
  norm,
  CONFLICT_THRESHOLDS,
  textSim,
  conflictPairs,
  adjudicateConflicts,
  gateTextDocument,
  gateSearchIndex,
  conflictNarrate,
  extractQuantities,
};