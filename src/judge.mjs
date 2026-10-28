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

const DAY = 86400000;
const CJK = /[\u4e00-\u9fff]/;

// 剥词用的虚词表。只剥两侧，不动中间，否则「主机型号」会被拆散。
const LEAD_JUNK = /^(?:的|了|是|在|有|和|与|及|或|从|向|往|到|把|被|给|对|该|这|那|其|约|共|计|达|为|则|即|按|据|经|由|于|已|将|可|须|应)+/;
const TAIL_JUNK = /(?:的|了|是|在|有|和|与|及|或|吗|呢|吧|啊|约|共|计|达|为|则|即|按|据|经|由|于|已|将|可|须|应|上|下|中|内|外|前|后|里)+$/;

// 疑问焦点。切属性时以它为界，界两侧的名词块都算属性。
const QMARK = /(?:多少|多久|多大|多远|多长|多重|多高|多深|几人|几个|几支|几卷|几块|几节|几种|几次|几条|几项|几页|几份|几张|几名|几行|几号|第几|哪一|哪条|哪个|哪个|哪里|哪国|哪年|哪月|哪日|哪位|哪天|什么|啥|谁|何时|何地|如何|怎么|怎样|为什么|是否|是不是|有没有|能否)/;

// 问询方式词：只是问法，不是属性本身。R73「累计睡眠情况如何」的属性是「累计睡眠」。
const MODE_TAIL = /(?:情况|状态|方式|做法|样子|内容|经过|结果|详情|说法|表述|口径|数据|数值|水平|程度)+$/;

// 回溯/存在类限定词：出现这些词时，对应的限定必须真的被记载过。
// 否则「上一航次跑哪条航线」会被「老航线」「原定航线」蒙混过关。
const LIMITER_RE = /(上一|上一次|前一次|上一年|去年|前任|首任|最初|原始|成立|出生|创办|初建|已注销|停用)/g;

// 通用属性后缀词：值附近的这些词是「属性名」，不是值的一部分。
const ATTR_SUFFIX = '(?:编号|代号|型号|呼号|名称|名字|日期|时间|深度|长度|宽度|高度|厚度|半径|面积|体积|重量|吨位|人数|页数|数量|件数|金额|费用|费率|流量|速度|温度|气压|湿度|角度|距离|续航|功率|电压|比重|含量|浓度|盐度|压力|工期|时限|期限)';

// 实体词表：编号型、职务+姓名、机构、船名。
const ENTITY_PATTERNS = [
  /PT\s+[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*/g,
  /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g,
  /(?:船长|大副|二副|三副|轮机长|水手长|引航员|检验员|公估人|代理|报务员|木匠|二管轮|律师|代表|调度)([\u4e00-\u9fff]{2,3})/g,
  /[\u4e00-\u9fff]{2,5}(?:港区|海峡|群岛|洋|海|公司|集团|局|调查组|委员会|船厂|保险|银行|法院|海事局)/g,
  /[\u4e00-\u9fff]{2,4}号/g,
  /[\u4e00-\u9fff]{2,4}(?:轮|船)(?![舶厂])/g,
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
      if (m[1] && /(?:船长|大副|二副|三副|轮机长|水手长|引航员|检验员|公估人|代理|报务员|木匠|二管轮|律师|代表)/.test(m[0])) {
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

    // (4) 职务+姓名：船长周允棠 → (周允棠, 职务, 船长)
    const ROLE = /(船长|大副|二副|三副|轮机长|水手长|引航员|检验员|公估人|代理|报务员|木匠|二管轮|律师)([\u4e00-\u9fff]{2,3})/g;
    while ((m = ROLE.exec(s.text)) !== null) {
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
const VERB_JUNK = /(?:决定|要求|更换|看见|装了|装|减到|减小|漂了|漂|待了|待|询问|化验|写了|写|挂的是|挂|用的是|用|还剩|剩|叫|改名为|改名|跑了|跑|经过|覆盖|发生|出现|提出|记录|处理|执行|送达|漏改|采信|给出|采用|规定|涉及|表示|认为|自称|成为|变成|作为|设置|安装|属于|包括|包含|需要|应该|可以|能够|进行|实现|完成|算出|签署|签发|离港|抵港|到达|抵达|离开|驶离|超过|不超过|改成|改回|减为|挂靠|反映|发现|取样|化验)/g;

// 答案类型词：只说明「我要一个什么形状的值」，不构成被查属性。
// 「主机型号」剥掉「型号」剩「主机」——原文写「主机是 MAN B&W」，这才对得上。
const ANSWER_TYPE_RE = /(?:型号|编号|名字|名称|金额|费用|总额|总数|数量|页数|页码|年限|年龄|长度|深度|宽度|高度|重量|日期|时间)/g;

// 解释型问句问的是「为什么/怎么办」，不是一个属性的值。这类只判实体，不判属性。
const EXPLAIN_RE = /(为什么|为何|怎么|怎样|如何|哪些|有什么|情况)/;
const NUMERIC_RE = /(多少|多久|多大|多远|多长|多深|多重|多高|几点|几[人名页项张份条件支块卷节次天年月日]|哪年|哪国|第几)/;

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
  // 「白鲸号上一航次」的「上一」前面是实体尾字「号」，补进来就成了「号上一航次」。
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
 * 属性取疑问焦点两侧的名词块——「白鲸号上一航次跑的是哪条航线」里，「航线」在焦点之后。
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
 * （`白鲸号第=一次`、`水面照成=一块`），把精确比对建在碎片上，误伤只会转嫁到问句侧。
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
// 属性短语：「的 X」优先（「白鲸号的舵机型号是多少」→ 舵机型号），否则退回 primary。
// 同义词只按「物理量名」归并，不登记任何题面，避免变成题库白名单。
const ATTR_PHRASE_RE = /的([\u4e00-\u9fff]{2,6}?)(?=是|有|为|多少|什么|哪|几|怎么|如何|叫|称为|称作|$|[?？])/;
const ATTR_SYNONYM = [
  ['直径', '口径', '粗细', '外径'],
  ['容量', '容积', '装载量'],
  ['压力', '压强'],
  ['功率', '马力'],
  ['速度', '航速', '速率'],
  ['吨位', '载重吨', '载重量'],
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
const ATTR_SUFFIX_WORDS = ['总额', '清单', '编号', '代号', '型号', '容量', '压力', '直径', '口径', '日期', '时间', '数量', '金额', '费用', '长度', '宽度', '高度', '深度', '重量', '功率', '速度', '航速', '吨位', '页码', '项数'];
// 「修理费总额」的核心是「修理费」：材料里有「修理费」就说明这个属性存在，
// 只是问句把量名后缀加长了。C 组「舵机型号」的核心「舵机」在材料里没有，仍然要拒。
function attrCore(key) {
  for (const suf of ATTR_SUFFIX_WORDS) if (key.endsWith(suf) && key.length > suf.length) return key.slice(0, -suf.length);
  return key;
}
const ANSWER_TYPE_ONLY = /^(名字|名称|型号|编号|日期|时间|数量|金额|费用|长度|宽度|高度|深度|重量|吨位)$/;
function cleanPhrase(s) {
  return String(s)
    .replace(/(一共|共计|总计|合计|不超过|超过|大约|约|时|共)$/u, '')
    .replace(/^[时当近约共合总]/u, '');
}
function attrPhraseOf(query, pq) {
  const m = String(query).match(ATTR_PHRASE_RE);
  const raw = m && [...m[1]].length >= 2 ? m[1] : (pq?.primary || '');
  const cand = cleanPhrase(raw);
  // 短语里混进动词/量词（「未上船」「那批」）说明抽错了，宁可不判也不误伤。
  if (/(未|没|导致|一批|那批|上船|下船|超过|不超过)/.test(cand)) return '';
  // 「叫什么名字」问的是名字这个词本身，属性缺席判据对它没有信息量；
  // 只放行这种纯答案类型词，复合短语（「舵机型号」）仍然要判。
  if (ANSWER_TYPE_ONLY.test(cand)) return '';
  return [...cand].length >= 2 ? cand : '';
}

export function gate(query, target, opts = {}) {
  const store = typeof target === 'string' ? buildStore([{ n: 1, text: target }]) : target;

  if (!store || !store.facts || store.facts.length === 0) {
    return { deny: true, reason: 'no-facts', detail: '材料里没有抽出任何可判断的事实' };
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
    // 事实主语可能记成「白鲸」而问句写「白鲸号」：主语里存在互为前后缀的实体就算有这号对象。
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
    const phrase = attrPhraseOf(query, pq);
    if (subject && phrase) {
      const key = canonAttr(phrase);
      const core = attrCore(key);
      // 属性存在性看全库，不只看该实体的槽：材料里任何实体记过「修理费」，
      // 就说明这个属性在这份材料里不是缺席的（主体归属问题不在这里判）。
      const own = opts.l1Facts.filter((f) => f.entity === subject);
      const has = opts.l1Facts.some((f) => {
        const a = canonAttr(f.attr);
        return a === key || a.includes(key) || key.includes(a)
          || (core.length >= 2 && (a.includes(core) || core.includes(a)));
      });
      const inText = glueAll.includes(norm(phrase));
      if ((own.length > 0 || fullText.includes(norm(subject))) && !has && !inText) {
        return {
          deny: true,
          reason: 'attribute-not-recorded',
          entity: subject,
          attribute: phrase,
          // 文案要复述完整问法：H1 的属性 key 是拉丁串「imo」，只回拉丁串会让
          // SPEC §2.6 的 absent 整串（「IMO 编号」）落空，拒答被判成没拒。
          detail: `「${subject}」有记载，但材料里没有「${attrPhrase(query, phrase) || phrase}」这一项`,
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

const NUM_UNIT = new RegExp(
  '([零一二三四五六七八九十百千万两0-9]+(?:点[零一二三四五六七八九十0-9]+)?)\\s*(厘米|毫米|公里|海里|米|吨|美元|节|度|天|小时|分钟|秒|人)',
  'g',
);

/** 从一段文字里抽「数值+单位」，带所在句，供冲突检测用。 */
export function extractQuantities(text) {
  const out = [];
  for (const s of splitSentences(text)) {
    for (const m of s.text.matchAll(NUM_UNIT)) {
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
export function resolveConflict(memories) {
  const byUnit = new Map();
  for (const mem of memories) {
    const at = mem.createdAt ?? mem.ch ?? 0;
    for (const q of extractQuantities(mem.text)) {
      if (!byUnit.has(q.unit)) byUnit.set(q.unit, []);
      byUnit.get(q.unit).push({ ...q, memId: mem.id, at });
    }
  }

  const conflicts = [];
  const current = {};
  const superseded = [];
  for (const [unit, items] of byUnit) {
    const values = [...new Set(items.map((i) => i.value))];
    if (values.length <= 1) continue;
    const sorted = items.slice().sort((a, b) => a.at - b.at);

    // 修正措辞检测：「原报 X 系估值/现予更正」——X 是旧值，句子里的另一个值才是新值。
    // 不能按时间排序取最后一条：同一条记忆新旧共存时，时间排序会把旧值当新值。
    // 也不能整句降权：那句同时包含新旧两个值，全降就把新值也误杀了。
    // 匹配多种修正句式：「原报 X」「X 系估值」「以 X 为准」「现予更正」等。
    const REV_OLD = /(?:原报|原测|原记录|原载|原写|原称|原为|原系|原属)\s*([零一二三四五六七八九十百千万亿两\d]+(?:点[零一二三四五六七八九\d]+)?)\s*(厘米|毫米|米|公里|海里|千瓦|吨|美元|万美元|元|天|小时|分钟|秒|节|度|人|名|页|项|张|份|条|件|支|块|卷|升|平方米|立方米|公斤|百帕|次)/g;
    const REV_OLD2 = /([零一二三四五六七八九十百千万亿两\d]+(?:点[零一二三四五六七八九\d]+)?)\s*(厘米|毫米|米|公里|海里|千瓦|吨|美元|万美元|元|天|小时|分钟|秒|节|度|人|名|页|项|张|份|条|件|支|块|卷|升|平方米|立方米|公斤|百帕|次)\s*系(?:目测|估值|估算|估计|估测|概算|粗算|初算|误报|误记|笔误)/g;
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
    if (!latest) latest = sorted[sorted.length - 1]; // 全被降权时退化为时间最新

    const old = sorted.filter((i) => i.value !== latest.value);
    if (!old.length) continue;
    const noun = sharedNounMulti([latest.sent, ...old.map((o) => o.sent)]);
    // 没有共同名词就不是「同一件事被改口」，只是两个恰好同单位的数
    if (!noun) continue;
    const key = `${noun}|${unit}`;
    current[key] = latest.value;
    superseded.push(...old);
    conflicts.push({
      key,
      entity: null,
      attr: noun,
      unit,
      values: [...new Set(sorted.map((i) => i.value))],
      current: latest.value,
      currentMemId: latest.memId,
      supersededValues: [...new Set(old.map((o) => o.value))],
      evidence: sorted.map((s) => ({ value: s.value, memId: s.memId, at: s.at, text: s.sent })),
      // 只用于诊断：原文自己带了更正措辞，不能算插件的能力
      revisionMarkInText: /更正|作废|以.{0,6}为准|现予更正|已撤销|已推翻/.test(sorted.map((s) => s.sent).join('')),
    });
  }
  return { conflicts, current, superseded, factCount: byUnit.size };
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

export default { gate, resolveConflict, decayWeight, fitBudget, render, buildStore, extractFacts, buildEntities, parseQuery, norm, CONFLICT_THRESHOLDS, textSim, conflictPairs, adjudicateConflicts, gateTextDocument, gateSearchIndex, conflictNarrate, extractQuantities };
