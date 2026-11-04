import { openConflictSnapshot, createFixedReader } from './conflict-snapshot.mjs';
import { norm } from './judge.mjs';

const DEFAULTS = { sentences: 10000, sentenceBytes: 16384, quantities: 10000,
  comparisons: 100000, entries: 20000, conflicts: 1000, resultBytes: 65536 };
const QUANTITY = /([零一二三四五六七八九十百千万两0-9]+(?:点[零一二三四五六七八九十0-9]+)?)\s*(厘米|毫米|公里|海里|米|吨|美元|节|度|天|小时|分钟|秒|人)/g;
// Count the JSON representation without materializing it; stop once the cap is exceeded.
export function jsonBytes(value, cap) {
  let size = 0;
  function add(n) { size += n; return size <= cap; }
  function string(s) {
    if (!add(2)) return false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) {
        if (!add(2)) return false;
      } else if (c < 32 || (c >= 0xd800 && c <= 0xdfff &&
          !(c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff))) {
        if (!add(6)) return false;
      } else if (c >= 0xd800 && c <= 0xdbff) {
        if (!add(4)) return false;
        i++;
      } else if (!add(c < 128 ? 1 : c < 2048 ? 2 : 3)) return false;
    }
    return true;
  }
  function visit(v) {
    if (v === null) return add(4);
    if (typeof v === 'string') return string(v);
    if (typeof v === 'number') return add(Number.isFinite(v) ? String(v).length : 4);
    if (typeof v === 'boolean') return add(v ? 4 : 5);
    if (Array.isArray(v)) {
      if (!add(2)) return false;
      for (let i = 0; i < v.length; i++) if ((i && !add(1)) || !visit(v[i])) return false;
      return true;
    }
    if (typeof v === 'object') {
      if (!add(2)) return false;
      let first = true;
      for (const key of Object.keys(v)) {
        if (v[key] === undefined) continue;
        if ((!first && !add(1)) || !string(key) || !add(1) || !visit(v[key])) return false;
        first = false;
      }
      return true;
    }
    throw new TypeError('unsupported JSON value');
  }
  return visit(value) ? size : cap + 1;
}
const SNAPSHOT_MAX = { records: 1000, occurrences: 5000, textBytes: 1048576,
  recordTextBytes: 65536, occurrenceBytes: 1048576, identifierBytes: 4096 };

function noun(a, b) {
  const grams = text => {
    const chars = [...norm(text)], out = new Set();
    for (let i = 0; i + 1 < chars.length; i++) {
      const gram = chars[i] + chars[i + 1];
      if (!/[0-9零一二三四五六七八九十百千万两]/.test(gram)
          && !/厘米|毫米|公里|海里|吨|美元|节|度|天|小时|分钟|秒/.test(gram)) out.add(gram);
    }
    return out;
  };
  const other = grams(b);
  for (const gram of grams(a)) if (other.has(gram)) return gram;
  return '';
}

const result = (conflicts, reason, comparisons, outputTruncated) => ({ conflicts,
  total: conflicts.length, scanIncomplete: reason !== null,
  totalExact: reason === null && !outputTruncated, reason, comparisons, outputTruncated });

// The file wrapper owns the reader; the scanner never exposes it to callers.
export function normalizeConflictScanOptions({ snapshot = {}, limits = {} } = {}) {
  const budget = { ...DEFAULTS, ...limits };
  const snapshotBudget = { ...SNAPSHOT_MAX, ...snapshot };
  for (const key of Object.keys(budget)) {
    if (!Object.hasOwn(DEFAULTS, key) || !Number.isSafeInteger(budget[key]) || budget[key] < 0 || budget[key] > DEFAULTS[key]) {
      throw new RangeError(`invalid limit: ${key}`);
    }
  }
  if (jsonBytes(result([], null, 0, false), budget.resultBytes) > budget.resultBytes) {
    throw new RangeError('resultBytes below minimum envelope');
  }
  for (const [key, value] of Object.entries(snapshotBudget)) {
    if (!Object.hasOwn(SNAPSHOT_MAX, key) || !Number.isSafeInteger(value) || value < 0 || value > SNAPSHOT_MAX[key]) {
      throw new RangeError(`invalid snapshot limit: ${key}`);
  } }
  return { snapshot: snapshotBudget, budget };
}

// Internal only: callers own the connection and transaction; do not expose this seam to host APIs.
export function scanConflictConnectionV2(db, { snapshot, budget }) {
  return scanConflictReaderV2(createFixedReader(db, snapshot), budget);
}

export function scanConflictsV2(file, options = {}) {
  const { snapshot, budget } = normalizeConflictScanOptions(options);
  const reader = openConflictSnapshot(file, snapshot);
  let failure;
  try {
    return scanConflictReaderV2(reader, budget);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { reader.close(); } catch (cleanup) {
      if (failure instanceof AggregateError && failure.errors.includes(cleanup)) throw failure;
      if (failure !== undefined) throw new AggregateError([failure, cleanup], 'scan and snapshot cleanup failed', { cause: failure });
      throw cleanup;
    }
  }
}

// Internal module seam: the owner supplies and closes the trusted reader.
export function scanConflictReaderV2(reader, budget) {
  const documents = new Map(), conflicts = [];
  let sentences = 0, quantities = 0, entries = 0, comparisons = 0, reason = null;
  let outputTruncated = false;
  outer: for (;;) {
      const page = reader.next();
      if (page.done) { if (page.scanIncomplete) reason = `snapshot:${page.reason}`; break; }
      const mem = page.value;
      if (typeof mem.id !== 'string' || typeof mem.text !== 'string' || !Array.isArray(mem.occurrences)) {
        reason = 'invalidRecord'; break;
      }
      const groups = new Map(), unknown = [];
      for (const pos of mem.occurrences) {
        if (!pos || typeof pos !== 'object' || (pos.document_id != null && typeof pos.document_id !== 'string')) {
          reason = 'invalidPosition'; break outer;
        }
        if (!pos.document_id) unknown.push(pos);
        else {
          if (!groups.has(pos.document_id)) groups.set(pos.document_id, []);
          groups.get(pos.document_id).push(pos);
        }
      }
      if (unknown.length || !mem.occurrences.length) groups.set(Symbol(mem.id), unknown);
      let start = 0;
      for (let i = 0; i <= mem.text.length; i++) {
        if (i < mem.text.length && !'。！？；\n'.includes(mem.text[i])) continue;
        const sentenceStart = start, sentenceEnd = i < mem.text.length ? i + 1 : i;
        const sent = mem.text.slice(sentenceStart, sentenceEnd); start = i + 1;
        if (!sent.trim()) continue;
        if (++sentences > budget.sentences) { reason = 'sentences'; break outer; }
        if (Buffer.byteLength(sent, 'utf8') > budget.sentenceBytes) { reason = 'sentenceBytes'; break outer; }
        for (const match of sent.matchAll(QUANTITY)) {
          if (quantities >= budget.quantities) { reason = 'quantities'; break outer; }
          quantities++;
          const q = { value: `${match[1]}${match[2]}`, unit: match[2] };
          for (const [doc, positions] of groups) {
            if (++entries > budget.entries) { reason = 'entries'; break outer; }
            if (!documents.has(doc)) documents.set(doc, new Map());
            const byUnit = documents.get(doc);
            if (!byUnit.has(q.unit)) byUnit.set(q.unit, []);
            const prior = byUnit.get(q.unit);
            const entry = { value: q.value, memoryId: mem.id, text: sent,
              start: sentenceStart, end: sentenceEnd, positions };
            for (const old of prior) {
              if (comparisons >= budget.comparisons) { reason = 'comparisons'; break outer; }
              comparisons++;
              if (old.value === entry.value) continue;
              const attr = noun(old.text, entry.text);
              if (!attr) continue;
              if (conflicts.length >= budget.conflicts) { reason = 'conflicts'; break outer; }
              const conflict = { documentId: typeof doc === 'string' ? doc : null, attr, unit: q.unit,
                values: [old.value, entry.value], evidence: [old, entry] };
              conflicts.push(conflict);
              if (jsonBytes(result(conflicts, null, comparisons, false), budget.resultBytes) > budget.resultBytes) {
                conflicts.pop();
                outputTruncated = true; reason = 'resultBytes'; break outer;
              }
            }
            prior.push(entry);
          }
        }
      }
  }
  while (jsonBytes(result(conflicts, reason, comparisons, outputTruncated), budget.resultBytes) > budget.resultBytes) {
    if (!conflicts.length) throw new RangeError('resultBytes below terminal envelope');
    conflicts.pop();
    outputTruncated = true;
  }
  return result(conflicts, reason, comparisons, outputTruncated);
}
