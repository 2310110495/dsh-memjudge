import { gate, parseSlotQuery } from './judge.mjs';
import { extractSlots, stripEvidenceMarkup } from './slots.mjs';

/**
 * 证据门硬拒判定：gate()/gateSlots() 一旦给出 deny=true，除确认可放行的理由外一律硬拒。
 * 白名单只保留「已验证可放行」的两个理由，其余理由由证据门自行扩充即可生效——
 * 不再逐一枚举拒绝理由，避免产出集合与判定集合漂移导致判定恒 false。
 */
export function isHardDeny(v) {
  if (!v?.deny) return false;
  if (v.reason === 'hit' || v.reason === 'explain-question') return false;
  return true;
}

/**
 * recall 证据门的最终裁决：bodyVerdict（片段窗口核验）与 slotGate（槽位索引核验）谁说了算。
 * - 片段核验放行即放行：槽位图只是结构化投影，抽不出槽位不等于事实不存在，
 *   让槽位门单方面否决会把「文本里明明写着、只是没抽成槽位」的整类召回拒死；
 * - 片段核验要拒时，只有槽位门给出「肯定命中」才豁免，用来抵住文本窗口截断造成的误拒。
 */
export function shouldDenyRecall(bodyVerdict, slotGate) {
  if (!isHardDeny(bodyVerdict)) return false;
  // A lossy slot projection cannot overrule a verified contradiction, condition,
  // or comparison in the source evidence. Only unbound window misses recover.
  if (bodyVerdict.evidenceBound === true) return true;
  const slotExplicitlyAffirmed = Boolean(
    slotGate
    && slotGate.deny === false
    && slotGate.reason === 'hit'
    && (slotGate.hits?.length ?? 0) > 0,
  );
  return !slotExplicitlyAffirmed;
}

/** Judge one authoritative candidate, never a scope-wide derived projection. */
export function judgeSourceText(query, text) {
  const initial = gate(query, text);
  // The old narrative extractor does not recognize many parameter assignments.
  // Only its no-facts miss can be retried with freshly extracted, literal quotes;
  // bound denials and other failed judgments are never overwritten.
  if (!initial.deny || initial.evidenceBound || initial.reason !== 'no-facts') return initial;
  // Legacy coverage is not a proof of a requested exact value. Until the
  // source parser binds it, never recover explicit equality from a no-facts miss.
  if (parseSlotQuery(query).checkValue) return initial;
  const condition = /^(?:(?:仅在|在|如果|若|当|仅当)\s*.+?(?:情况下|的时候|环境下|模式下|条件下|之时|下|时))[,，]?\s*/;
  const conditionKey = value => stripEvidenceMarkup(value).match(condition)?.[0].replace(/[,，\s]/g, '') || '';
  const queryCondition = conditionKey(query);
  // Historical decision/root-cause/configuration recall asks for recorded material,
  // not confirmation of a proposed value. Keep source wording and require both
  // technical identifiers and a substantial topical phrase plus affirmative action.
  if (/(?:决策|选型|方案|根因|需要开启什么)/.test(query) && !/\d/.test(query)) {
    const ids = String(query).match(/[A-Za-z][A-Za-z0-9_.]*/g) || [];
    const phrases = String(query).match(/[\u4e00-\u9fff]{4,}/g) || [];
    for (const sentence of String(text).split(/[。！？；;\n]/)) {
      const s = stripEvidenceMarkup(sentence);
      const c = conditionKey(s);
      if (c && c !== queryCondition) continue;
      const unwrapped = s.replace(condition, '');
      if (/(?:仅在|只有|如果|若|仅当|在[^。；，,]{1,30}(?:环境下|条件下|情况下|模式下))/.test(unwrapped)) continue;
      const action = s.match(/(?:决定采用|已采用|需开启|已定位|修复方案为)/);
      if (!action) continue;
      // An affirmative token is not proof when the surrounding statement denies,
      // proposes or bounds it. Refuse the whole recovery sentence conservatively.
      if (/(?:未|不|建议|计划|拟|应该|应当|准备|可能|或许|打算|预计|至多|至少|上限|下限|超过|低于)/.test(s)) continue;
      const subjectIds = s.slice(0, action.index).match(/[A-Za-z][A-Za-z0-9_.]*/g) || [];
      if (subjectIds.some(id => !ids.includes(id))) continue;
      const sourceIds = s.match(/[A-Za-z][A-Za-z0-9_.]*/g) || [];
      const identityIds = /根因/.test(query) ? ids.filter((id, i) => i === 0 || !/^E[A-Z0-9_]+$/.test(id)) : ids;
      if (!identityIds.length || sourceIds[0] !== identityIds[0] || !identityIds.every(id => sourceIds.includes(id))) continue;
      const topic = phrases.some(p => {
        for (let i = 0; i <= p.length - 4; i++) if (s.includes(p.slice(i, i + 4))) return true;
        return false;
      });
      if (topic) return { deny: false, reason: 'source-narrative', missing: null, detail: '同源历史叙述的技术标识、主题与肯定动作绑定；不确认额外数值断言' };
    }
  }
  const facts = extractSlots(text).filter(s => s.polarity === 1 && typeof s.quote === 'string'
    && s.quote.length > 0 && text.includes(s.quote)
    && (!conditionKey(s.quote) || conditionKey(s.quote) === queryCondition))
    .map(s => ({ ...s, text: s.quote }));
  if (!facts.length) return initial;
  // Preserve the sentence's subject/context, not just a bare value quote.
  // But rejected conditional sentences cannot remain in the coverage document.
  const groundedText = text.split(/(?<=[。！？；;\n])/u).filter(sentence => {
    const key = conditionKey(sentence);
    const unwrapped = stripEvidenceMarkup(sentence).replace(condition, '');
    if (/(?:仅在|只有|如果|若|仅当|在[^。；，,]{1,30}(?:环境下|条件下|情况下|模式下))/.test(unwrapped)) return false;
    if (/(?:不|未|建议|计划|拟|应该|应当|准备|可能|或许|打算|预计)/.test(unwrapped)) return false;
    if (/(?<!已)将/.test(unwrapped)) return false;
    return (!key || key === queryCondition) && facts.some(f => sentence.includes(f.text));
  }).join('');
  // Recovery is deliberately narrower than legacy coverage: a technical owner
  // and parameter key must bind an affirmative literal assignment in one source
  // sentence. Unparsed equality and non-exact predicates never use this path.
  const ids = String(query).match(/[A-Za-z][A-Za-z0-9_.]*/g) || [];
  if (!ids.length) return initial;
  const owner = ids[0];
  const parsed = parseSlotQuery(query);
  // Open alias/name questions may omit an inserted modifier from the original
  // attribute. Require the exact technical owner and a substantial suffix, not
  // document-wide keyword coverage; never apply this to an explicit value.
  if (ids.length === 1) {
    const fact = facts.find(f => {
      if (f.entity !== owner || !/(?:别名|名称|名字)$/.test(f.attr)) return false;
      if (f.attr === parsed.attr) return true;
      for (let cut = 2; cut <= parsed.attr.length - 4; cut++) {
        if (f.attr.startsWith(parsed.attr.slice(0, cut)) && f.attr.endsWith(parsed.attr.slice(cut))) return true;
      }
      return false;
    });
    return fact ? { deny: false, reason: 'source-name', missing: null, entity: owner, attribute: fact.attr, detail: '同源肯定命名槽位与明确主体绑定' } : initial;
  }
  const key = ids.at(-1);
  const assignment = /^\s*(?:已)?(?:设为|调整为|调优为|固定为|设置为|是|为|=|：|:)\s*(?:[-+]?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_.-]*)/;
  for (const sentence of groundedText.split(/[。！？；;\n]/)) {
    const normalized = stripEvidenceMarkup(sentence);
    if (/(?:不超过|不少于|不低于|不高于|至少|至多|约为|不是|不为|不等于|并非|尚未|没有|未设置)/.test(normalized)) continue;
    const at = normalized.indexOf(key);
    if (at < 0 || !assignment.test(normalized.slice(at + key.length))) continue;
    let prefix = normalized.slice(0, at);
    for (const fact of facts) {
      if (normalized.includes(fact.text) && fact.value) prefix = prefix.replaceAll(fact.value, '');
    }
    const prefixIds = prefix.match(/[A-Za-z][A-Za-z0-9_.]*/g) || [];
    if (prefixIds[0] !== owner || !ids.slice(0, -1).every(id => prefixIds.includes(id))
        || prefixIds.some(id => !ids.slice(0, -1).includes(id))) continue;
    return { deny: false, reason: 'source-assignment', missing: null, entity: owner, attribute: key, detail: '同源句中技术主体、参数与肯定数值赋值绑定' };
  }
  return initial;
}
