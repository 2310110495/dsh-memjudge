// memjudge L1 层：把 memories.text（L0 原文）抽成可判定的 (entity, attr, value, sent) 四元组。
//
// 与 L0 的分工：L0 只保证原文一字不改；L1 负责把「哪一段、哪个实体、哪个属性、什么值」
// 变成结构，让 (entity, attr) 存在性判定有前提。
//
// 三条硬约束（来自 docs/SPEC.md 与 t13 契约）：
//   - Grounding：sent 必须是 text 的逐字子串，写不进就丢这条，绝不编造。
//   - attr 必须是值左侧紧邻的名词性短语，不是定长滑窗切出来的碎片。
//   - 每条 value 带 valueType（number/date/time/percent/id/coord/enum/text），单位单列。
//
// 设计取舍：本文件是 store.mjs 旧 extractFacts 的替代实现，但保留其 kind/列语义
// （value/role/id/coord 四类 + key 取 attr 末 2 字），否则 facts 表与冲突检测的
// 跨章归一会一起失效。改进集中在三处：attr 边界收紧、值形态补全、实体清洗。

import { splitSentences } from './judge.mjs';

const NUM = '[零一二三四五六七八九十百千万亿两\\d]+(?:点[零一二三四五六七八九\\d]+)?';
// 单位按长度降序，长单位先试，避免「平方米」被「米」截走。
const UNITS = [
  '平方米', '平方公里', '海里', '公里', '厘米', '毫米', '分钟', '小时',
  '美元', '万元', '吨', '度', '米', '节', '年', '岁', '天', '秒',
  '件', '人', '项', '处', '次', '份', '层', '台', '根', '条', '元',
];
const UNIT_RE = new RegExp(`(${NUM})\\s*(${UNITS.join('|')})`, 'g');

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
  '其中', '其他', '中间', '之后', '以前', '共计', '约有', '最多',
]);
// 「十海里以东 / 三米以内」这类是方位短语，不是「某物的某属性」
const ATTR_DIRECTION = /^[东西南北方位前后]?(?:以东|以西|以南|以北|以上|以下|以内|以外|之后|之前|左右)$/;

// 名词性后缀：命中这些尾巴的属性块优先被认成名词短语，而不是被截成两字碎片。
const ATTR_SUFFIX = /(?:编号|代号|型号|呼号|名称|名字|日期|时间|深度|长度|宽度|高度|厚度|半径|面积|体积|重量|吨位|人数|页数|数量|件数|金额|费用|费率|流量|速度|温度|气压|湿度|角度|距离|续航|功率|电压|比重|含量|浓度|盐度|压力|工期|时限|期限|吃水|载重|航速|航次|容量|排量|定额|标准|结论|原因|用途|去向|位置|坐标|方向|等级|类别|方式|方法|状态|结果|记录|报告|证书|合同|图纸|清单|台账|纪要|批复|申请|计划|方案|措施|要求|意见|责任|职务|岗位|姓名|年龄|工龄|资历|经历|目的港|装货港|卸货港|船籍港|港区|港口|海峡|航线|码头|锚地|水道|运河)$/;

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

// 值形态补全：旧实现只有「数字+单位」，日期/时刻/百分比全部漏抽，
// 而这些正是「更换日期」「离港时间」「硫含量」这类问句的落点。
const DATE_RE = /([零〇一二三四五六七八九]{2,4}年(?:[零一二三四五六七八九十]{1,3}月)?(?:[零一二三四五六七八九十]{1,3}日)?|[零一二三四五六七八九十]{1,3}月[零一二三四五六七八九十]{1,3}日)/g;
const TIME_RE = /([零一二三四五六七八九十]{1,3}时(?:[零一二三四五六七八九十]{1,3}分)?(?:整|半)?)/g;
const PCT_RE = /(百分之[零一二三四五六七八九十百点]+|\d+(?:\.\d+)?%)/g;
// 判断句：X 是/为/叫/记作 Y —— 覆盖「目的港是智利圣安东尼奥」「型号 80CL-9」。
// 值前可能有空格（「航次代号是 NBL-2303-11」），否则整条断言匹配失败。
const COPULA_RE = /([\u4e00-\u9fff]{2,10})(?:是|为|叫|名为|称为|称作|改名为|改称|记作|写作|标注为)\s*([^\s，。；、：]{2,30})/g;

/** 实体候选清洗：吞了虚词/疑问/动词的词块不是实体。 */
const ENTITY_LEAD_BAD = /^(?:又|再|还|就|才|也|都|只|仅|已|曾|正|在|把|被|对|向|从|和|与|及|或|而|但|则|因|所|每|各|该|此|其|本|这|那|谁|哪|什么|怎么|为什么|是否|没有|不是|不是|决定|要求|发现|表示|认为|自称|成为|变成|作为|设置|安装|属于|包括|包含|需要|应该|可以|能够|进行|实现|完成|算出|签署|签发|离港|抵港|到达|抵达|离开|驶离|超过|不超过|改成|改回|减为|挂靠|反映|取样|化验|看到|看见|听见|敲|报|问|说|讲)/;
const ENTITY_INNER_BAD = /[对把被了过着的吗呢吧啊]/;

export function cleanEntity(name) {
  if (!name) return null;
  const s = String(name).trim();
  if (s.length < 2) return null;
  // 「航次代号」「平台编号」也会被 `{2,5}号` 这条船名规则吃进来，先挡掉。
  if (/(?:代号|编号|型号|呼号|名号)$/.test(s)) return null;
  if (ENTITY_LEAD_BAD.test(s)) return null;
  if (ENTITY_INNER_BAD.test(s)) return null;
  return s;
}

/** 属性必须是名词性短语：含量词/序号/日期形态、或带「的」的长块都不算。 */
const ATTR_SEQ_BAD = /^(?:最后|首先|其次|第一|第二|第三|第四|第五|其中|其他|另一|同一|此|该|每|各|本|上|下|前|后|这条|那条|这艘|那艘|该船|本船|船上|全船)/;
const ATTR_VALUE_LIKE = /[年月日时分]|百分之|^[零〇一二三四五六七八九十百千两\d]+/;
// 动词/状态词：剥完只剩这些说明窗口里没有名词核心
const ATTR_VERB_BAD = /^(?:服役|航行|停泊|装货|卸货|离港|抵港|值班|交接|签收|化验|检测|检验|检查|确认|通知|报告完毕)$/;
export function attrIsNoun(attr) {
  const a = String(attr || '');
  if (a.length < 2 || a.length > 8) return false;
  // 「的」按结构助词判：「目的港」「目的地」里的「的」是词内字，不能一票否决。
  if (a.replace(/目的/g, '目地').includes('的')) return false;
  if (ATTR_REJECT.has(a)) return false;
  if (ATTR_SEQ_BAD.test(a)) return false;
  if (ATTR_VERB_BAD.test(a)) return false;
  // 含这些字的是动词短语或介词残块（「大副名叫林砚舟」「签名下面写着时间」）
  if (/着|过|了|名叫|叫作|写着|每隔|同姓|以及|也要|在过去|但|被|判定|来源/.test(a)) return false;
  if (/[被在与和及但也都还就才又均里]$/.test(a)) return false;
  if (ATTR_VALUE_LIKE.test(a) && !ATTR_SUFFIX.test(a)) return false;
  return true;
}

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

// 长块收紧：旧窗口回看 26 字，句内没标点时会把整句吃成属性
// （「白鲸号本航次装载一万八千四百吨袋装水泥与」）。这里先用连词/介词断尾，
// 再按名词后缀锚定，最后才退到「末 4 字」。
const ATTR_BREAK = ['的', '在', '了', '与', '和', '及', '把', '被', '对', '向', '从', '是', '为', '将', '由', '按', '经'];
function tightenAttr(attr) {
  let a = stripAttr(attr);
  // 先在整段上断尾：「白鲸号的航次代号」的属性是「航次代号」，不是含「的」的整块。
  // 「目的港」里的「的」是词内字，替换成同长占位后再找切点，切点索引不变。
  const probe = a.replace(/目的/g, '目地');
  let cut = -1;
  for (const c of ATTR_BREAK) cut = Math.max(cut, probe.lastIndexOf(c));
  if (cut >= 0 && cut < a.length - 2) a = stripAttr(a.slice(cut + 1));
  if (a.length <= 8) return a;
  // 后缀锚定：名词短语的中心词在尾部，从后缀词起点向前留 2 字修饰语
  const m = a.match(new RegExp(`([\\u4e00-\\u9fff]{0,3}${ATTR_SUFFIX.source.slice(3, -2)})$`));
  if (m) return stripAttr(m[1]) || a.slice(-4);
  return stripAttr(a.slice(-4));
}

/** 属性 = 值左侧紧邻的名词短语。窗口 16 字（旧值 26 会把上半句吃进来）。 */
function attributeBefore(text, idx) {
  // 尾部先剥空格与标点：「航次代号 NBL-2303-11」的值前是空格，不剥会让
  // 汉字正则整块匹配失败，属性被兜底成「编号」。
  const win = text.slice(Math.max(0, idx - 16), idx).replace(/[\s，、：:；;（(「“]+$/, '');
  const m = win.match(/[\u4e00-\u9fff]{2,16}$/);
  if (!m) return null;
  let attr = tightenAttr(m[0]);
  if (attr.length < 2) return null;
  if (ATTR_REJECT.has(attr)) return null;
  if (/^[\d零一二三四五六七八九十百千万两]+$/.test(attr)) return null;
  // 「做了十次 / 用了八小时 / 发现一处」剥完剩下的是动词短语，不是属性
  if (/[了过着]$/.test(attr)) return null;
  // 序数块（「后第一次」「第二次」）不是属性
  if (attr.includes('第')) return null;
  if (ATTR_DIRECTION.test(attr)) return null;
  if (/[不没未]$/.test(attr)) return null;
  if (!attrIsNoun(attr)) return null;
  return attr;
}

// 实体只在能确定时填，抽不到就是 null —— 不猜。
function entityBefore(text, idx) {
  const win = text.slice(Math.max(0, idx - 60), idx);
  const orgs = [...win.matchAll(ORG_TAIL)];
  if (orgs.length) { const e = cleanEntity(orgs[orgs.length - 1][1]); if (e) return e; }
  const ships = [...win.matchAll(VESSEL)];
  if (ships.length) { const e = cleanEntity(ships[ships.length - 1][1]); if (e) return e; }
  return null;
}

/** 句子级实体：句内首个机构/船名，没有就沿用上一句（中文常态省略主语）。 */
function sentenceEntity(sentence, prev) {
  const orgs = [...sentence.matchAll(ORG_TAIL)];
  const ships = [...sentence.matchAll(VESSEL)];
  const cands = [...orgs, ...ships].map((m) => cleanEntity(m[1])).filter(Boolean);
  if (cands.length) return cands[0];
  return prev ?? null;
}

function keyOf(attr) {
  const a = String(attr || '');
  return a.length <= 2 ? a : a.slice(-2);
}

/** 值形态分类：number / date / time / percent / id / coord / enum / text。 */
function valueTypeOf(f) {
  if (f.kind === 'coord') return 'coord';
  if (f.kind === 'id' || f.kind === 'code') return 'id';
  if (f.kind === 'role') return 'enum';
  if (f.kind === 'date') return 'date';
  if (f.kind === 'time') return 'time';
  if (f.kind === 'percent') return 'percent';
  if (f.unit) return 'number';
  return 'text';
}

/**
 * L0 → L1 提取。
 *
 * @param {string} text 一段原文（章、段或整篇）
 * @param {{ch?:number|null}} [opts]
 * @returns {Array<{entity:string|null, attr:string, key:string, value:string, unit:string|null,
 *   kind:string, valueType:string, sent:string, at:number, ch:number|null}>}
 */
export function extractL1(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const ch = opts.ch ?? null;
  const out = [];
  const seen = new Set();
  const push = (f) => {
    // Grounding Invariant：句子不是原文子串就整条丢弃，绝不改写补齐。
    if (!f.sent || !text.includes(f.sent)) return;
    if (!f.attr || f.attr.length < 1) return;
    // 实体名本身不是属性：「白鲸号 | 白鲸号 | 二〇二三年…」这种行没有判定价值。
    if (f.entity && f.attr === f.entity) return;
    const src = f.sourceText ?? '';
    if (src && !text.includes(src)) return;
    // 跨 kind 去重：同一 (entity, attr, value) 只留一条，否则 copula 与数值型
    // 会为同一事实各写一行，key 相同即污染冲突检测。
    const sig = `${f.entity ?? ''}|${f.attr}|${f.value}`;
    if (seen.has(sig)) return;
    // v5 起 facts 不落盘（内存派生层），200KB 预算不再约束行数：
    // 低置信三元组全部保留，能记的都记，交给上层按需过滤。
    seen.add(sig);
    // 单位在 L1 层就并进 value：facts 表不再有 unit 列（SPEC §2.7 省一页）。
    // 前提是合并后的串在原文里连续——「147 件」这种带空格的写法不合并，直接丢，
    // 因为不连续的值过不了 grounding 回溯断言。
    let value = f.value;
    if (f.unit) {
      const merged = `${f.value}${f.unit}`;
      if (!text.includes(merged)) return;
      value = merged;
    }
    out.push({
      entity: f.entity ?? null,
      attr: f.attr,
      key: keyOf(f.attr),
      value,
      unit: null,
      kind: f.kind,
      valueType: f.valueType ?? valueTypeOf(f),
      sent: f.sent,
      // 句子指针：库里只存偏移与长度，grounding 时回 memories.text 切片比对，
      // facts 表不再抄一份原文（SPEC §2.7 体积预算）。
      sentOff: f.sentOff ?? (f.at ?? 0),
      sentLen: f.sentLen ?? String(f.sent || '').length,
      at: f.at ?? 0,
      ch,
    });
  };

  let prevEntity = null;
  for (const s of splitSentences(text)) {
    const sent = text.slice(s.at, s.at + s.text.length);
    const ent = sentenceEntity(sent, prevEntity);
    if (ent) prevEntity = ent;
    const base = { entity: ent, sent, sentOff: s.at, sentLen: s.text.length, ch };

    // 坐标先登记，占住区间，避免「四度十二点六分」被当成长度
    const coordSpans = [];
    COORD_RE.lastIndex = 0;
    let m;
    while ((m = COORD_RE.exec(sent)) !== null) {
      const attr = m[1] === '南纬' || m[1] === '北纬' ? '纬度' : '经度';
      push({ ...base, attr, value: m[2], unit: null, kind: 'coord', at: s.at + m.index });
      coordSpans.push([m.index, m.index + m[0].length]);
    }
    const inCoord = (i) => coordSpans.some(([a, b]) => i >= a && i < b);

    // (1) 数字 + 单位
    UNIT_RE.lastIndex = 0;
    while ((m = UNIT_RE.exec(sent)) !== null) {
      if (inCoord(m.index)) continue;
      const attr = attributeBefore(sent, m.index);
      if (!attr) continue;
      push({
        ...base,
        entity: entityBefore(sent, m.index) ?? ent,
        attr, value: m[1], unit: m[2], kind: 'value',
        sourceText: m[0], at: s.at + m.index,
      });
    }

    // (2) 量名结构：十一吨重油 / 六块舱口盖 / 四页配载图。
    // 中文里「数量+名词」的名词在值右侧，只看左邻会把这些事实整类丢掉；
    // 仅在左侧抽不出属性时启用，避免与 (1) 重复。
    const MEASURE_RE = new RegExp(`(${NUM})(${UNITS.join('|')})([\\u4e00-\\u9fff]{2,8})`, 'g');
    while ((m = MEASURE_RE.exec(sent)) !== null) {
      if (inCoord(m.index)) continue;
      const left = attributeBefore(sent, m.index);
      // 左侧只有「多烧」「共计」这类短动词块时让位给右侧名词：
      // 「多烧十一吨重油」的属性是「重油」，不是「多烧」。
      if (left && (left.length >= 3 || ATTR_SUFFIX.test(left))) continue;
      const noun = m[3];
      const attr = tightenAttr(noun);
      if (!attr || !attrIsNoun(attr)) continue;
      push({
        ...base,
        entity: entityBefore(sent, m.index) ?? ent,
        attr, value: m[1], unit: m[2], kind: 'value',
        sourceText: m[0], at: s.at + m.index,
      });
    }

    // (3) 百分比：旧实现完全没有，硫含量这类问句因此无 fact 可落
    PCT_RE.lastIndex = 0;
    while ((m = PCT_RE.exec(sent)) !== null) {
      const attr = attributeBefore(sent, m.index);
      if (!attr) continue;
      push({
        ...base,
        entity: entityBefore(sent, m.index) ?? ent,
        attr, value: m[0], unit: null, kind: 'percent',
        sourceText: m[0], at: s.at + m.index,
      });
    }

    // (3) 日期：二〇一九年十一月 / 三月十八日
    DATE_RE.lastIndex = 0;
    while ((m = DATE_RE.exec(sent)) !== null) {
      const attr = attributeBefore(sent, m.index);
      if (!attr) continue;
      push({
        ...base,
        entity: entityBefore(sent, m.index) ?? ent,
        attr, value: m[0], unit: null, kind: 'date',
        sourceText: m[0], at: s.at + m.index,
      });
    }

    // (4) 时刻：二十二时十七分 / 十九时整
    TIME_RE.lastIndex = 0;
    while ((m = TIME_RE.exec(sent)) !== null) {
      if (inCoord(m.index)) continue;
      const attr = attributeBefore(sent, m.index);
      if (!attr) continue;
      push({
        ...base,
        entity: entityBefore(sent, m.index) ?? ent,
        attr, value: m[0], unit: null, kind: 'time',
        sourceText: m[0], at: s.at + m.index,
      });
    }

    // (5) 编号/代号：拉丁串本身就是值
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(sent)) !== null) {
      const attr = attributeBefore(sent, m.index);
      push({
        ...base,
        entity: entityBefore(sent, m.index) ?? ent,
        attr: attr || '编号', value: m[0], unit: null, kind: 'id',
        sourceText: m[0], at: s.at + m.index,
      });
    }

    // (6) 判断句：X 是/为/叫 Y
    COPULA_RE.lastIndex = 0;
    while ((m = COPULA_RE.exec(sent)) !== null) {
      const attr = tightenAttr(m[1]);
      const value = m[2].replace(/[。；，、]$/, '');
      if (attr.length < 2 || attr.length > 10 || value.length < 2) continue;
      if (ATTR_REJECT.has(attr) || attr.includes('第')) continue;
      if (!attrIsNoun(attr)) continue;
      // 值必须是短语而不是整句：含标点或过长说明 m[2] 吞了后续小句。
      if (/[，。；、：]/.test(value)) continue;
      if (value.length > 20) continue;
      // 语料里混进问句时（「目的港是哪里？」）不能把疑问词当值入库。
      if (/[?？]|哪里|哪个|什么|多少|几个|是否/.test(value)) continue;
      push({
        ...base,
        entity: entityBefore(sent, m.index) ?? ent,
        attr, value, unit: null, kind: 'value', valueType: 'text',
        // at 必须落在 value 起点：回溯断言按 at 起窗取 value，指向属性块会找不到
        sourceText: m[0], at: s.at + m.index + m[0].length - m[2].length,
      });
    }

    // (7) 职务+姓名：船长周允棠 → (周允棠, 职务, 船长)
    ROLE_RE.lastIndex = 0;
    while ((m = ROLE_RE.exec(sent)) !== null) {
      const name = m[2];
      if ([...name].some((c) => NAME_STOP.has(c))) continue;
      if (EDGE_CHARS.has(name[name.length - 1])) continue;
      const e = cleanEntity(name);
      if (!e) continue;
      push({ ...base, entity: e, attr: '职务', value: m[1], unit: null, kind: 'role', at: s.at + m.index });
    }
  }
  return out;
}

/** 兼容入口：store.mjs 的 facts 写入点调这个。 */
export const extractFacts = extractL1;

/**
 * 全量重建：给定一批 {id, text}，产出按 id 分组的三元组。
 * 纯函数——清表与写回由调用方在同一事务里完成，本函数不碰数据库。
 */
export function rebuildFacts(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const grouped = new Map();
  for (const e of list) {
    const id = e?.id ?? e?.rowid;
    if (id == null) continue;
    const facts = extractL1(String(e.text ?? ''), { ch: e.chapter ?? null, ...opts });
    grouped.set(id, facts);
  }
  return grouped;
}

export default { extractL1, extractFacts, rebuildFacts, cleanEntity };
