// Domain-agnostic engineering & factual Entity-Slot-Value extractor for MemJudge v2.
// Zero hardcoded domain-novel dictionaries; URL pre-masking prevents protocol/dot truncation;
// strict substring grounding guarantees `text.includes(slot.quote) === true` for every slot.

const URL_EXTRACT_RE = /https?:\/\/[^\s)>\]"'`，。；！？<>]+/gi;

// Units ordered strictly longest-first so multi-char units ('bytes', '厘米', '小时', 'ms')
// win over single-char prefixes ('B', '米', '时', 's').
export const SLOT_UNITS = [
  'tokens', 'bytes', 'chars',
  '平方千米', '平方米', '平方厘米', '立方米',
  '摄氏度', '华氏度', '人民币',
  'KiB', 'MiB', 'GiB', 'TiB',
  'kbps', 'mbps', 'gbps',
  'kHz', 'MHz', 'GHz',
  'min', 'qps', 'rps', 'fps',
  '毫米', '厘米', '分米', '千米', '公里', '微米', '纳米',
  '毫秒', '微秒', '纳秒', '小时', '分钟', '刻钟', '星期', '个月',
  '千克', '公斤', '毫克',
  '美元', '港元', '日元', '欧元', '英镑', '万元', '亿元',
  'KB', 'MB', 'GB', 'TB', 'ms', 'us', 'μs', 'ns', 'Hz', '°C',
  'B', 's', 'h', '%', '‰', '℃',
  '条', '个', '次', '轮', '行', '页', '尺', '寸', '步', '里', '米',
  '吨', '克', '元', '度', '天', '周', '年', '秒', '人',
  '倍', '层', '级', '维', '位', '章', '段', '篇', '项', '处', '台', '套', '块', '张', '份', '批', '组', '核', '帧',
];

const UNIT_CANONICAL_MAP = new Map([
  ['b', 'B'],
  ['kb', 'KB'],
  ['mb', 'MB'],
  ['gb', 'GB'],
  ['tb', 'TB'],
  ['kib', 'KiB'],
  ['mib', 'MiB'],
  ['gib', 'GiB'],
  ['tib', 'TiB'],
  ['ms', 'ms'],
  ['us', 'us'],
  ['μs', 'μs'],
  ['ns', 'ns'],
  ['min', 'min'],
  ['s', 's'],
  ['h', 'h'],
  ['bytes', 'bytes'],
  ['chars', 'chars'],
  ['tokens', 'tokens'],
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SORTED_UNITS = [...new Set(SLOT_UNITS)].sort((a, b) => b.length - a.length);
const UNIT_ALT_PATTERN = SORTED_UNITS.map(escapeRegex).join('|');
const UNIT_MATCH_RE = new RegExp(`^(?:${UNIT_ALT_PATTERN})$`, 'i');

const CN_DIGIT_VAL = {
  零: 0, 〇: 0,
  一: 1, 壹: 1,
  二: 2, 两: 2, 贰: 2,
  三: 3, 叁: 3,
  四: 4, 肆: 4,
  五: 5, 伍: 5,
  六: 6, 陆: 6,
  七: 7, 柒: 7,
  八: 8, 捌: 8,
  九: 9, 玖: 9,
};

const CN_SMALL_UNIT = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CN_BIG_UNIT = { 万: 10000, 亿: 100000000 };

function parseChineseIntegerPart(str) {
  if (!str) return null;
  if (/^\d+$/.test(str)) return String(Number(str));

  // Pure positional Chinese digits (e.g. '二〇二六' -> '2026', '九' -> '9')
  if (/^[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖]+$/.test(str)) {
    const digits = Array.from(str).map((ch) => String(CN_DIGIT_VAL[ch])).join('');
    return digits.length > 1 && digits.startsWith('0') ? digits : String(Number(digits));
  }

  if (!/^[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万亿]+$/.test(str)) {
    return null;
  }

  let total = 0;
  let section = 0;
  let currentDigit = 0;
  let hasDigit = false;

  for (const ch of str) {
    if (ch in CN_DIGIT_VAL) {
      currentDigit = CN_DIGIT_VAL[ch];
      hasDigit = true;
    } else if (ch in CN_SMALL_UNIT) {
      const unitVal = CN_SMALL_UNIT[ch];
      const mult = hasDigit ? currentDigit : 1; // e.g. '十' / '十五' -> 1 * 10
      section += mult * unitVal;
      currentDigit = 0;
      hasDigit = false;
    } else if (ch in CN_BIG_UNIT) {
      section += currentDigit;
      if (section === 0 && !hasDigit && total === 0) return null;
      if (ch === '亿') {
        total = (total + section) * CN_BIG_UNIT[ch];
      } else {
        total += section * CN_BIG_UNIT[ch];
      }
      section = 0;
      currentDigit = 0;
      hasDigit = false;
    } else {
      return null;
    }
  }

  const finalVal = total + section + currentDigit;
  return String(finalVal);
}

/**
 * Normalize Chinese numbers / decimals / mixed magnitude numerals to canonical numeric string.
 * Returns null if `raw` is not a valid numeric expression.
 */
export function parseChineseNumber(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[,_](?=\d{3}\b)/g, '');
  if (!s) return null;

  let sign = '';
  if (s.startsWith('负') || s.startsWith('-')) {
    sign = '-';
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  if (!s) return null;

  // Plain Arabic integer or decimal
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    return sign + s;
  }

  // Arabic number + Chinese magnitude ('1.5万', '2亿')
  const mixedMag = s.match(/^(\d+(?:\.\d+)?)\s*([万亿])$/);
  if (mixedMag) {
    const num = Number(mixedMag[1]);
    const mult = CN_BIG_UNIT[mixedMag[2]];
    const scaled = Number((num * mult).toPrecision(14));
    return sign + String(scaled);
  }

  // Chinese decimal ('一百八十九点九', '零点八五')
  if (s.includes('点')) {
    const parts = s.split('点');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const intPart = parseChineseIntegerPart(parts[0]);
    if (intPart === null) return null;
    let fracPart = '';
    for (const ch of parts[1]) {
      if (/\d/.test(ch)) fracPart += ch;
      else if (ch in CN_DIGIT_VAL) fracPart += String(CN_DIGIT_VAL[ch]);
      else return null;
    }
    return `${sign}${intPart}.${fracPart}`;
  }

  const intOnly = parseChineseIntegerPart(s);
  return intOnly !== null ? sign + intOnly : null;
}

function canonicalizeUnit(u) {
  if (!u) return '';
  const lower = u.toLowerCase();
  if (UNIT_CANONICAL_MAP.has(lower)) {
    // Distinguish 'B' vs 'b': both map to 'B' when matched as standalone byte unit
    return UNIT_CANONICAL_MAP.get(lower);
  }
  return u;
}

const VALUE_NUMBER_UNIT_RE = new RegExp(
  `^(?:约|大约|大概|近|超|超过|逾|达|多达|高达|至少|至多)?\\s*` +
  `([+-]?(?:\\d[\\d,_]*(?:\\.\\d+)?(?:\\s*[万亿])?|[负]?[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万亿]+(?:点[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖0-9]+)?))` +
  `\\s*(${UNIT_ALT_PATTERN})?$`,
  'i'
);

/**
 * Parse raw value phrase into normalized `{ value, unit, isNumeric }`.
 * Preserves commit hashes (e.g. 'd23c0c0e'), SemVer ('v0.2.2'), paths, and URLs untouched.
 */
export function normalizeValueAndUnit(rawVal) {
  if (typeof rawVal !== 'string') return { value: '', unit: '', isNumeric: false };
  let cleaned = rawVal
    .trim()
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .replace(/[。；！？，、,.!?;\s]+$/g, '')
    .trim();

  if (!cleaned) return { value: '', unit: '', isNumeric: false };

  // Never split hexadecimal hashes, SemVer, or identifiers containing letters before digits
  if (/^[0-9a-f]{7,40}$/i.test(cleaned) && /[a-f]/i.test(cleaned)) {
    return { value: cleaned, unit: '', isNumeric: false };
  }
  if (/^v?\d+\.\d+\.\d+/i.test(cleaned)) {
    return { value: cleaned, unit: '', isNumeric: false };
  }

  const m = cleaned.match(VALUE_NUMBER_UNIT_RE);
  if (m) {
    const rawNum = m[1].trim();
    const rawUnit = (m[2] || '').trim();
    // Guard against matching hex-like '51007b' unless unit is uppercase 'B' or separated by space, or valid unit
    const parsedNum = parseChineseNumber(rawNum);
    if (parsedNum !== null) {
      if (rawUnit && !UNIT_MATCH_RE.test(rawUnit)) {
        return { value: cleaned, unit: '', isNumeric: false };
      }
      return {
        value: parsedNum,
        unit: canonicalizeUnit(rawUnit),
        isNumeric: true,
      };
    }
  }

  return { value: cleaned, unit: '', isNumeric: false };
}

const LEADING_DISCOURSE_RE = /^(?:目前|当前|现在|如今|随后|此后|后来|最终|最后|起初|最初|原先|原本|此前|之前|昨日|今日|今天|昨天|刚才|同时|另外|此外|而且|并且|但是|然而|不过|因此|所以|如果|若|当|在|于|从|把|将|对|对于|关于|针对|其中|已知|规定|约定|要求|注意|说明)\s*/;
const PRONOUN_STOP_ENTITIES = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们',
  '这', '那', '这个', '那个', '这些', '那些', '该', '此', '其', '这里', '那里',
  '谁', '什么', '哪个', '是否', '原因', '结果', '情况', '问题', '方式',
]);

const META_LABEL_KEYS = new Set([
  '注意', '说明', '提示', '警告', '备注', '例如', '比如', '示例', '结论', '总结',
  '原因', '背景', '步骤', '结果', '输出', '输入', '参考', '详见', '其中',
  'note', 'todo', 'fixme', 'example', 'summary',
]);

export function cleanSlotEntity(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw
    .trim()
    .replace(/^[`"'“”‘’《》（）【】()[\]—\-·•*#\d.)、：:，,；;\s]+/, '')
    .replace(/[`"'“”‘’《》（）【】()[\]：:，,；;\s]+$/, '')
    .trim();

  for (let i = 0; i < 3; i++) {
    const next = s.replace(LEADING_DISCOURSE_RE, '').trim();
    if (next === s) break;
    s = next;
  }

  // Strip locative wrappers like '在 xxx 中/里/内/下/上' or trailing '中/里/内/下/上'
  const locWrap = s.match(/^(?:在|于)?\s*(.+?)\s*(?:中|里|内|下|上)$/);
  if (locWrap) {
    s = locWrap[1].trim();
  }

  // Strip generic prefix nouns like '模块 client.js' -> 'client.js', '文件 a.ts' -> 'a.ts'
  const prefixNoun = s.match(/^(?:模块|文件|服务|脚本|组件|接口|函数|方法|类|变量|常量|对象|配置项?|工程|项目|目录|路径|仓库)\s+([A-Za-z0-9_$./@-]+)$/);
  if (prefixNoun) {
    s = prefixNoun[1].trim();
  }

  s = s.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim();
  if (!s || s.length > 64) return '';
  if (PRONOUN_STOP_ENTITIES.has(s.toLowerCase())) return '';
  if (/^\d+$/.test(s)) return '';
  return s;
}

export function cleanSlotAttr(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw
    .trim()
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length > 32) return '';
  if (/^[的了着过吗呢吧啊呀]+$/.test(s)) return '';
  return s;
}

// Productive noun morphology, not a catalogue of application/domain attributes.
// Explicit entity heads take precedence; otherwise a two-character noun head is the boundary.
const ATTR_HEAD_RE = /(?:[\u4e00-\u9fff][度率数量额值期限码型]|大小|端口|版本|路由|路径|地址|目录|分支|状态|模式|格式|编码|协议|算法|引擎|模型|开关|策略|权限|预算|成本|费用|功率|延迟|耗时|超时|容量|占用)$/;
export function splitCompactEntityAttr(subject) {
  const cleaned = cleanSlotEntity(subject);
  if (!cleaned) return null;
  const de = cleaned.lastIndexOf('的');
  if (de > 0 && de < cleaned.length - 1) {
    return { entity: cleanSlotEntity(cleaned.slice(0, de)), attr: cleanSlotAttr(cleaned.slice(de + 1)) };
  }
  const spaceIdx = cleaned.lastIndexOf(' ');
  if (spaceIdx > 0) {
    const entity = cleanSlotEntity(cleaned.slice(0, spaceIdx));
    const attr = cleanSlotAttr(cleaned.slice(spaceIdx + 1));
    if (entity && attr && attr.length <= 16) return { entity, attr };
  }
  const typed = cleaned.match(/^(.+?(?:项目|服务|系统|网关|模块|组件|集群|节点|实例|对象|队列|缓存|线程池|连接池))([\u4e00-\u9fff]{2,16})$/)
    || cleaned.match(/^([A-Za-z_$][A-Za-z0-9_$./:-]*)([\u4e00-\u9fff]{2,16})$/);
  if (typed && ATTR_HEAD_RE.test(typed[2])) return { entity: typed[1], attr: typed[2] };
  const head = cleaned.match(ATTR_HEAD_RE);
  if (head && cleaned.length > head[0].length) {
    return { entity: cleanSlotEntity(cleaned.slice(0, -head[0].length)), attr: head[0] };
  }
  return null;
}

function maskUrls(text) {
  const urls = [];
  const masked = text.replace(URL_EXTRACT_RE, (raw) => {
    const trimmed = raw.replace(/[.,;:!?)]+$/, '');
    const suffix = raw.slice(trimmed.length);
    const idx = urls.length;
    urls.push(trimmed);
    return `\uE000MJURL${idx}\uE001${suffix}`;
  });
  return { masked, urls };
}

function unmaskUrls(str, urls) {
  if (!str || urls.length === 0) return str;
  return str.replace(/\uE000MJURL(\d+)\uE001/g, (_, idx) => urls[Number(idx)] ?? '');
}

function isClosedOrFalseValue(val) {
  return /^(?:false|off|disabled|disable|none|关闭|已关闭|禁用|已禁用|停用|已停用|否)$/i.test(val.trim());
}

function splitClausesWithOffsets(maskedText) {
  const clauses = [];
  // Split on newlines, Chinese sentence punctuation, semicolons, or English '; ' / '. ' outside numbers/identifiers
  const sepRe = /(?:\r?\n)+|[。！？；，]+|;\s+|(?<![0-9A-Za-z_./-])\.\s+/g;
  let last = 0;
  let m;
  while ((m = sepRe.exec(maskedText)) !== null) {
    if (m.index > last) {
      clauses.push({ text: maskedText.slice(last, m.index), start: last });
    }
    last = m.index + m[0].length;
  }
  if (last < maskedText.length) {
    clauses.push({ text: maskedText.slice(last), start: last });
  }
  return clauses;
}

function resolveGroundedQuote(fullText, candidateQuote) {
  if (!candidateQuote) return '';
  let q = candidateQuote.trim();
  if (!q) return '';
  if (fullText.includes(q)) return q;
  // Strip outer markdown bullets if any
  q = q.replace(/^[-*•>\s]+/, '').trim();
  if (q && fullText.includes(q)) return q;
  return '';
}

// Predicate regexes
const NEG_STOP_USING_RE = /^(.+?)\s*(不再使用|不再采用|不再依赖|不再支持|不再保留|不再调用|已弃用|弃用|废弃)\s*(.+)$/;
const NEG_FORBID_WITH_SUBJ_RE = /^(.+?)\s*(?:严禁|禁止|不得|切勿)\s*(使用|采用|依赖|修改|触碰|开启|启用|写入|调用|执行|访问|删除|传入|合并)?\s*(.+)$/;
const NEG_FORBID_IMPERATIVE_RE = /^(?:严禁|禁止|不得|切勿)\s*(使用|采用|依赖|修改|触碰|开启|启用|写入|调用|执行|访问|删除|传入|合并)?\s*(.+)$/;
const NEG_CLOSE_SUBJ_DE_RE = /^(.+?)\s*的\s*([^\s的，。；：:=]{1,24}(?:\s+[^\s的，。；：:=]{1,24})?)\s*(?:设为|改为|定为|置为|处于|保持|为|是)?\s*(已关闭|关闭|已禁用|禁用|已停用|停用)(?:状态)?$/;
const NEG_CLOSE_SUBJ_RE = /^(.+?)\s*(?:默认|已经|已|设为|改为|保持|处于)\s*(关闭|禁用|停用)(?:状态)?$/;
const NEG_CLOSE_IMPERATIVE_RE = /^(?:已)?(关闭|禁用|停用)\s*(.+)$/;

const DE_COPULA_NEG_RE = /^(.+?)\s*的\s*(.+?)\s*(不是|不为|不等于)\s*(.+)$/;
const DE_COPULA_POS_RE = /^(.+?)\s*的\s*(.+?)\s*(改为|定为|设为|设置为|配置为|调整为|更新为|升级为|降为|变为|变成|不超过|不高于|不大于|不低于|不少于|等于|达到|高达|约为|保持在|控制在|限制在|指向|位于|采用|使用|为|是)\s*(.+)$/;

const KEY_ASSIGN_RE = /^(?:[-*•]\s*)?([`"'“”‘’]?[A-Za-z_$][A-Za-z0-9_$.-]*[`"'“”‘’]?)\s*(?::=|=|:)\s*(.+)$/;
const CN_KEY_COLON_RE = /^(?:[-*•]\s*)?([\u4e00-\u9fffA-Za-z0-9_./-]{2,28})\s*[：:]\s*(.+)$/;
const IDENT_CN_SET_RE = /^([`"'“”‘’]?[A-Za-z_$@][A-Za-z0-9_$/.-]*[`"'“”‘’]?)\s*(设为|设置为|定为|改为|配置为|调整为|限制在|不超过|不低于|等于|默认为|默认是|取值为|为)\s*(.+)$/;
const POINTER_REL_RE = /^(.+?)\s*(指向|映射到|绑定到|监听)\s*(.+)$/;
const MODULE_ACTION_RE = /^([`"'“”‘’]?(?:[A-Za-z0-9_@.-]+[\\/][A-Za-z0-9_./-]+|[A-Za-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|rs|go|sql|json|yaml|yml|toml|md)|[A-Za-z_$][A-Za-z0-9_$-]{2,})[`"'“”‘’]?)\s*(负责|用于|实现|采用|使用|依赖|维护|管理|拦截|导出|暴露|提供)\s*(.+)$/;
const COMPACT_METRIC_RE = /^(.+?)\s*(改为|定为|设为|设置为|配置为|调整为|不超过|不高于|不大于|不低于|不少于|等于|达到|高达|约为|保持在|控制在|限制在|为|是)\s*(.+)$/;

function mapNegStopVerb(verb) {
  if (verb.includes('采用')) return '采用';
  if (verb.includes('依赖')) return '依赖';
  if (verb.includes('支持')) return '支持';
  if (verb.includes('保留')) return '保留';
  if (verb.includes('调用')) return '调用';
  return '使用';
}

/**
 * Extract structured Entity-Slot-Value records from text:
 *   [{ entity, attr, value, unit, polarity, confidence, quote }]
 */
export function extractSlots(text) {
  if (typeof text !== 'string' || !text.trim()) return [];

  const { masked, urls } = maskUrls(text);
  const clauses = splitClausesWithOffsets(masked);
  const results = [];
  const dedup = new Set();

  let lastEntityInSentence = '';

  const commitSlot = (rawSlot, rawClauseText) => {
    const entity = cleanSlotEntity(unmaskUrls(rawSlot.entity, urls));
    const attr = cleanSlotAttr(unmaskUrls(rawSlot.attr, urls));
    const unmaskedRawVal = unmaskUrls(rawSlot.rawValue, urls);
    const { value, unit } = normalizeValueAndUnit(unmaskedRawVal);
    const polarity = rawSlot.polarity === -1 ? -1 : 1;
    const confidence = Number(rawSlot.confidence ?? 0.85);

    if (!entity || !attr || !value) return false;
    if (value.length > 160) return false;

    const candidateQuote = unmaskUrls(rawSlot.quote || rawClauseText, urls);
    const quote = resolveGroundedQuote(text, candidateQuote);
    if (!quote || !text.includes(quote)) return false;

    const key = `${entity}\0${attr}\0${value}\0${unit}\0${polarity}`;
    if (dedup.has(key)) return true;
    dedup.add(key);

    results.push({
      entity,
      attr,
      value,
      unit,
      polarity,
      confidence,
      quote,
    });
    lastEntityInSentence = entity;
    return true;
  };

  for (const clauseObj of clauses) {
    const clause = clauseObj.text.trim().replace(/^[-*•>\s]+/, '').trim();
    if (!clause || clause.length < 3) continue;
    // Drop interrogative questions so questions aren't stored as declarative facts
    if (/[?？]$/.test(clause) || /^(?:请问|为什么|为何|怎么|如何|是否|能不能)\b/.test(clause)) {
      continue;
    }

    let m;

    // 1. Negative polarity: "<entity> 不再使用/弃用 <target>"
    if ((m = clause.match(NEG_STOP_USING_RE))) {
      if (commitSlot({
        entity: m[1],
        attr: mapNegStopVerb(m[2]),
        rawValue: m[3],
        polarity: -1,
        confidence: 0.92,
        quote: m[0],
      }, clause)) continue;
    }

    // 2. Negative polarity: "<entity> 的 <attr> 关闭/禁用"
    if ((m = clause.match(NEG_CLOSE_SUBJ_DE_RE))) {
      if (commitSlot({
        entity: m[1],
        attr: m[2],
        rawValue: m[3].replace(/^已/, ''),
        polarity: -1,
        confidence: 0.92,
        quote: m[0],
      }, clause)) continue;
    }

    // 3. Negative polarity: "<entity> 已关闭/默认关闭/设为关闭"
    if ((m = clause.match(NEG_CLOSE_SUBJ_RE))) {
      if (commitSlot({
        entity: m[1],
        attr: '状态',
        rawValue: m[2],
        polarity: -1,
        confidence: 0.9,
        quote: m[0],
      }, clause)) continue;
    }

    // 4. Negative polarity: imperative "关闭/禁用 <target>"
    if ((m = clause.match(NEG_CLOSE_IMPERATIVE_RE))) {
      if (commitSlot({
        entity: m[2],
        attr: '状态',
        rawValue: m[1],
        polarity: -1,
        confidence: 0.88,
        quote: m[0],
      }, clause)) continue;
    }

    // 5. Negative polarity: imperative "禁止/严禁 <verb?> <target>"
    if ((m = clause.match(NEG_FORBID_IMPERATIVE_RE))) {
      const verb = m[1] || '规则';
      const target = m[2];
      if (commitSlot({
        entity: target,
        attr: verb,
        rawValue: '禁止',
        polarity: -1,
        confidence: 0.9,
        quote: m[0],
      }, clause)) continue;
    }

    // 6. Negative polarity: "<entity> 禁止/严禁 <verb?> <target>"
    if ((m = clause.match(NEG_FORBID_WITH_SUBJ_RE))) {
      if (commitSlot({
        entity: m[1],
        attr: m[2] || '禁止',
        rawValue: m[3],
        polarity: -1,
        confidence: 0.9,
        quote: m[0],
      }, clause)) continue;
    }

    // 7. Explicit key-value assignment: "storageLimitBytes = 10485760", "port: 51007"
    if ((m = clause.match(KEY_ASSIGN_RE))) {
      const keyRaw = m[1].replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '');
      const valRaw = m[2];
      if (!META_LABEL_KEYS.has(keyRaw.toLowerCase()) && !/^\d+$/.test(keyRaw)) {
        const neg = isClosedOrFalseValue(unmaskUrls(valRaw, urls));
        if (commitSlot({
          entity: keyRaw,
          attr: 'value',
          rawValue: valRaw,
          polarity: neg ? -1 : 1,
          confidence: 0.95,
          quote: m[0],
        }, clause)) continue;
      }
    }

    // 8. Code identifier Chinese assignment: "timeoutMs 设为 60000"
    if ((m = clause.match(IDENT_CN_SET_RE))) {
      const keyRaw = m[1].replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '');
      const valRaw = m[3];
      const neg = isClosedOrFalseValue(unmaskUrls(valRaw, urls));
      if (commitSlot({
        entity: keyRaw,
        attr: 'value',
        rawValue: valRaw,
        polarity: neg ? -1 : 1,
        confidence: 0.94,
        quote: m[0],
      }, clause)) continue;
    }

    // 9. Pointer / binding facts: "HEAD 指向 d23c0c0e"
    if ((m = clause.match(POINTER_REL_RE)) && !/(?:是|为|等于|设为|定为)/.test(m[3])) {
      if (commitSlot({
        entity: m[1],
        attr: m[2],
        rawValue: m[3],
        polarity: 1,
        confidence: 0.92,
        quote: m[0],
      }, clause)) continue;
    }

    // 10. Negative "<entity> 的 <attr> 不是/不为 <value>"
    if ((m = clause.match(DE_COPULA_NEG_RE))) {
      const lhs = m[1];
      const rhsAttr = m[2];
      if (!rhsAttr.includes('的') || rhsAttr.length <= 16) {
        if (commitSlot({
          entity: lhs,
          attr: rhsAttr,
          rawValue: m[4],
          polarity: -1,
          confidence: 0.9,
          quote: m[0],
        }, clause)) continue;
      }
    }

    // 11. General Chinese "<entity> 的 <attr> 为/是/改为/定为/不超过/等于 <value>"
    if ((m = clause.match(DE_COPULA_POS_RE))) {
      // Split at the LAST '的' when LHS contains nested modifiers
      const prefixAndAttr = `${m[1]}的${m[2]}`;
      const lastDe = prefixAndAttr.lastIndexOf('的');
      const entPart = prefixAndAttr.slice(0, lastDe).trim();
      const attrPart = prefixAndAttr.slice(lastDe + 1).trim();
      const valPart = m[4];
      const neg = isClosedOrFalseValue(unmaskUrls(valPart, urls));
      if (commitSlot({
        entity: entPart,
        attr: attrPart,
        rawValue: valPart,
        polarity: neg ? -1 : 1,
        confidence: 0.92,
        quote: m[0],
      }, clause)) continue;
    }

    // 12. File / module action facts: "src/inject.mjs 负责两段式注入"
    if ((m = clause.match(MODULE_ACTION_RE))) {
      if (commitSlot({
        entity: m[1],
        attr: m[2],
        rawValue: m[3],
        polarity: 1,
        confidence: 0.88,
        quote: m[0],
      }, clause)) continue;
    }

    // 13. Chinese colon key-value: "超时阈值：60秒" or "RPC 路由：/api/memjudge.status"
    if ((m = clause.match(CN_KEY_COLON_RE))) {
      const rawK = m[1].trim();
      const rawV = m[2].trim();
      // Exclude pure clock times like '10:46'
      if (!META_LABEL_KEYS.has(rawK.toLowerCase()) && !(/^\d+$/.test(rawK) && /^\d+/.test(rawV))) {
        const splitPair = splitCompactEntityAttr(rawK);
        const neg = isClosedOrFalseValue(unmaskUrls(rawV, urls));
        if (splitPair) {
          if (commitSlot({
            entity: splitPair.entity,
            attr: splitPair.attr,
            rawValue: rawV,
            polarity: neg ? -1 : 1,
            confidence: 0.88,
            quote: m[0],
          }, clause)) continue;
        } else if (commitSlot({
          entity: rawK,
          attr: 'value',
          rawValue: rawV,
          polarity: neg ? -1 : 1,
          confidence: 0.86,
          quote: m[0],
        }, clause)) {
          continue;
        }
      }
    }

    // 14. Compact metric / copula without '的': "Tier-S 预算不超过 600 chars", "凹槽深度为九厘米"
    if ((m = clause.match(COMPACT_METRIC_RE))) {
      const subj = m[1].trim();
      const valRaw = m[3].trim();
      const splitPair = splitCompactEntityAttr(subj);
      const neg = isClosedOrFalseValue(unmaskUrls(valRaw, urls));

      if (splitPair) {
        if (commitSlot({
          entity: splitPair.entity,
          attr: splitPair.attr,
          rawValue: valRaw,
          polarity: neg ? -1 : 1,
          confidence: 0.86,
          quote: m[0],
        }, clause)) continue;
      } else if (lastEntityInSentence && ATTR_HEAD_RE.test(cleanSlotAttr(subj))) {
        // Ellipsis carry-over within same text when subject is omitted before a bare attribute noun
        if (commitSlot({
          entity: lastEntityInSentence,
          attr: subj,
          rawValue: valRaw,
          polarity: neg ? -1 : 1,
          confidence: 0.82,
          quote: m[0],
        }, clause)) continue;
      } else if (m[2] !== '是' && m[2] !== '为') {
        // Explicit mutation/threshold verb ('设为', '改为', '定为', '不超过', '等于', ...) on standalone subject
        if (commitSlot({
          entity: subj,
          attr: 'value',
          rawValue: valRaw,
          polarity: neg ? -1 : 1,
          confidence: 0.84,
          quote: m[0],
        }, clause)) continue;
      }
    }
  }

  return results;
}

export default {
  SLOT_UNITS,
  parseChineseNumber,
  normalizeValueAndUnit,
  cleanSlotEntity,
  cleanSlotAttr,
  extractSlots,
};
