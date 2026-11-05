// V1 deliberately recognizes only the finite color vocabulary below.
const fold = s => s.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase();
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const colorsZh = new Set(['红色', '蓝色', '绿色', '黄色', '黑色', '白色', '紫色', '橙色', '灰色', '无色']);
const colorsEn = new Set(['red', 'blue', 'green', 'yellow', 'black', 'white', 'purple', 'orange', 'gray', 'grey', 'colorless']);

/** Analyze delivered snippets only. Spans are UTF-16 half-open offsets. */
export function analyzeAttributeEvidenceV1(query, hits) {
  const scope = { version: 1, grammar: 'color-assertion-v1', currentness: 'not-established' };
  const empty = status => ({ scope, supported: status !== 'unsupported', status, hasConflict: false, semanticUncertain: false, contextIncomplete: false, candidates: [] });
  if (typeof query !== 'string' || !Array.isArray(hits)) return empty('unsupported');
  const q = fold(query).trim();
  let m = q.match(/^([a-z][a-z0-9]*|[\u4e00-\u9fff]{1,12})的颜色是(?:什么|多少)[?？]?$/u);
  let english = false;
  if (!m) { m = q.match(/^what is ([a-z][a-z0-9]*)'s color\??$/u); english = true; }
  if (!m) return empty('unsupported');
  const entity = escapeRegex(m[1]);
  const target = english ? `${entity}'s\\s+color` : `${entity}的颜色`;
  const assertion = new RegExp(english ? `^${target}\\s+is\\s+([a-z]+)$` : `^${target}是([\\u4e00-\\u9fff]+)$`, 'u');
  const targetMention = new RegExp(target, 'u');
  const correction = /(?:改为|改成|更正|变成|不再是|这个说法是假的|这句话是错的|实际上是|不是真的|并非事实|假设|假如|如果|这是过去的情况|changed\s+to|corrected\s+to|(?:this|it)\s+is\s+false|\bnot\s+true\b|\bsuppos(?:e|ing)\b|\bif\b|^\s*(?:previously|formerly)[.!]?\s*$|\bused\s+to\b)/u;
  const candidates = [];
  let uncertain = false;
  let contextIncomplete = false;
  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index];
    if (hit?.truncated === true || hit?.startsAtBoundary === false) contextIncomplete = true;
    if (!hit || typeof hit.text !== 'string') { uncertain = true; continue; }
    const text = hit.text;
    const mappingValid = typeof hit.originalText === 'string' && Number.isSafeInteger(hit.windowStart) && Number.isSafeInteger(hit.windowEnd) && hit.windowStart >= 0 && hit.windowEnd >= hit.windowStart && hit.windowEnd <= hit.originalText.length && hit.originalText.slice(hit.windowStart, hit.windowEnd) === text;
    const mappingSupplied = ['originalText', 'windowStart', 'windowEnd'].some(key => Object.hasOwn(hit, key));
    const subwindow = mappingValid && (hit.windowStart > 0 || hit.windowEnd < hit.originalText.length);
    let boundaryIndex = mappingValid ? hit.windowStart : 0;
    while (boundaryIndex > 0 && !/[\r\n\u2028\u2029]/u.test(hit.originalText[boundaryIndex - 1]) && /\s/u.test(hit.originalText[boundaryIndex - 1])) boundaryIndex--;
    const atMappedBoundary = mappingValid && (boundaryIndex === 0 || /[。．！？!?；;\r\n\u2028\u2029.]/u.test(hit.originalText[boundaryIndex - 1]));
    const boundaryContradiction = mappingValid && ((hit.startsAtBoundary === true && !atMappedBoundary) || (hit.startsAtBoundary === false && atMappedBoundary));
    if (mappingSupplied && !mappingValid) { contextIncomplete = true; uncertain = true; }
    if (subwindow) contextIncomplete = true;
    if (subwindow && hit.truncated === false) uncertain = true;
    if (mappingValid && !subwindow && hit.truncated === true) uncertain = true;
    if (boundaryContradiction) uncertain = true;
    const sentences = text.matchAll(/[^。．！？!?；;\r\n\u2028\u2029.]*[。．！？!?；;\r\n\u2028\u2029.]|[^。．！？!?；;\r\n\u2028\u2029.]+$/gu);
    let first = true;
    for (const part of sentences) {
      const start = part.index;
      const raw = part[0];
      const normalized = fold(raw);
      const partialStart = first && (hit.startsAtBoundary === false || boundaryContradiction || ((hit.truncated === true || subwindow || (mappingSupplied && !mappingValid)) && hit.startsAtBoundary !== true && !atMappedBoundary));
      first = false;
      if (correction.test(normalized)) uncertain = true;
      if (partialStart) { if (targetMention.test(normalized)) uncertain = true; continue; }
      const trimStart = raw.length - raw.trimStart().length;
      const trimEnd = raw.trimEnd().length;
      const sentence = raw.slice(trimStart, trimEnd);
      const sentenceStart = start + trimStart;
      const sentenceEnd = start + trimEnd;
      if (!/[。．.!！]$/u.test(sentence)) { if (targetMention.test(normalized)) uncertain = true; continue; }
      const body = fold(sentence.slice(0, -1)).trimEnd();
      const match = body.match(assertion);
      if (!match) { if (targetMention.test(normalized)) uncertain = true; continue; }
      const value = match[1];
      if (!(english ? colorsEn : colorsZh).has(value)) { uncertain = true; continue; }
      const valueStart = sentenceStart + match.index + match[0].length - value.length;
      const valueEnd = valueStart + value.length;
      const rawValue = text.slice(valueStart, valueEnd);
      const sentenceSpan = [sentenceStart, sentenceEnd];
      const valueSpan = [valueStart, valueEnd];
      candidates.push({ hit: { id: hit.id ?? null, version: hit.version ?? null, index }, sentence, rawValue, normalizedValue: value === 'grey' ? 'gray' : value, sentenceSpan, valueSpan,
        originalSentenceSpan: mappingValid ? [hit.windowStart + sentenceStart, hit.windowStart + sentenceEnd] : null,
        originalValueSpan: mappingValid ? [hit.windowStart + valueStart, hit.windowStart + valueEnd] : null });
    }
  }
  const distinct = new Set(candidates.map(c => c.normalizedValue));
  const hasConflict = distinct.size > 1;
  const status = uncertain || contextIncomplete ? 'uncertain' : hasConflict ? 'ambiguous' : distinct.size ? 'candidates' : 'no-evidence';
  return { scope, supported: true, status, hasConflict, semanticUncertain: uncertain, contextIncomplete, candidates };
}
