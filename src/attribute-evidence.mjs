// Compare folded copies only; returned evidence remains the original text.
const fold = s => s.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase();
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function attributeValues(query, hits) {
  const q = fold(query).trim();
  let match = q.match(/^([a-z][a-z0-9]*|[\u4e00-\u9fff]{1,12})的([\u4e00-\u9fff]{1,12})是(?:什么|多少)[?？]?$/);
  let entity, field, english = false;
  if (match) [, entity, field] = match;
  else {
    match = q.match(/^what is ([a-z][a-z0-9]*)'s ([a-z]+)\??$/);
    if (!match) return null;
    [, entity, field] = match;
    english = true;
  }
  const e = escape(entity), f = escape(field);
  const assertion = english
    ? new RegExp(`^${e}'s\\s+${f}\\s+is\\s+([a-z0-9]+(?:\\s+[a-z0-9]+)*)$`)
    : new RegExp(`^${e}的${f}是([\\u4e00-\\u9fffa-z0-9]+(?:\\.[0-9]+[\\u4e00-\\u9fffa-z0-9]*)?)$`);
  const values = new Set();
  // Ambiguous retractions are conservative across snippets, never ordered by hit rank.
  const retract = /^(?:(?:(?:后来|已经|已))?(?:改成|改为|更正为|变成)|不再是|这个说法是假的|this\s+is\s+false|(?:(?:later|it)\s+)?(?:has\s+)?changed\s+to\b|(?:it\s+)?was\s+corrected\s+to\b)/u;
  const targetChange = english
    ? new RegExp(`^${e}\x27s[ ]+${f}[ ]+(?:(?:has[ ]+)?changed|was[ ]+corrected)[ ]+to(?:[ ]|$)`, "u")
    : new RegExp(`^(?:${e}的)?${f}(?:(?:后来|已经|已))?(?:改成|改为|更正为|变成)`, "u");
  for (const hit of hits) {
    for (const part of fold(hit.text).split(/(?<=[。！？!?;；\n])|(?<=\.)(?!\d)/u)) {
      const s = part.trim();
      if (targetChange.test(s) || retract.test(s)) return [];
    }
  }
  for (const hit of hits) {
    const sentences = fold(hit.text).split(/(?<=[。！？!?;；\n])|(?<=\.)(?!\d)/u);
    if (hit.truncated && hit.startsAtBoundary !== true) sentences.shift();
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (!/[。！!.]$/u.test(s) || /[?？]/u.test(s)) continue;
      const m = s.slice(0, -1).trim().match(assertion);
      if (!m) continue;
      const value = m[1];
      if (value === '无' || value === 'no') continue;
      if (/(?:如果|假如|若是|昨天|昨日|去年|\b(?:if|unless|yesterday|formerly|previously)\b)/u.test(value)) continue;
      const isName = field === '名字' || field === 'name';
      const uncertainty = /(?:未知|不详|暂无|尚未|可能|也许|大概|或者|似乎|吗|么|嘛|还是|待确认|待定|待核|\b(?:not|unknown|none|maybe|possibly|or|pending|unconfirmed)\b)/u;
      if (uncertainty.test(value) || /^(?:不是|没有|并非|并不是)/u.test(value) || (isName ? /.+或.+/u.test(value) : /[不未没或]/u.test(value))) continue;
      if (!isName && ((value !== '无色' && value.includes('无')) || /\bno\b/u.test(value))) continue;
      values.add(value);
    }
  }
  return [...values];
}

export function attributeEvidence(query, hits) {
  const values = attributeValues(query, hits);
  return values === null ? null : values.length > 0;
}
