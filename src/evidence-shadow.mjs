import { types } from 'node:util';
import { analyzeAttributeEvidenceV1 } from './attribute-evidence-v1.mjs';

const fields = ['text', 'originalText', 'windowStart', 'windowEnd', 'truncated', 'startsAtBoundary'];
const statuses = { unsupported: 'unsupported', 'no-evidence': 'noEvidence', candidates: 'candidates', ambiguous: 'ambiguous', uncertain: 'uncertain' };
const counts = () => ({ disabled: 0, invalid: 0, overBudget: 0, failed: 0, analyzed: 0, unsupported: 0, noEvidence: 0, candidates: 0, ambiguous: 0, uncertain: 0, conflict: 0, semanticUncertain: 0, contextIncomplete: 0 });
const object = value => value !== null && typeof value === 'object' && !types.isProxy(value);
const data = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor : null;
};
export function safeEvidenceSnapshot(query, hits) {
    const result = counts();
    try {
      if (typeof query !== 'string' || !object(hits) || !Array.isArray(hits)) { result.invalid = 1; return result; }
      const length = data(hits, 'length').value;
      if (query.length > 1024 || length > 64) { result.overBudget = 1; return result; }
      let total = query.length;
      const snapshot = [];
      for (let i = 0; i < length; i++) {
        const item = data(hits, String(i));
        if (!item || !object(item.value) || Array.isArray(item.value)) { result.invalid = 1; return result; }
        const source = item.value;
        const proto = Object.getPrototypeOf(source);
        if (proto !== Object.prototype && proto !== null) { result.invalid = 1; return result; }
        const copy = Object.create(null);
        for (const key of fields) {
          const descriptor = Object.getOwnPropertyDescriptor(source, key);
          if (!descriptor) { if (key === 'text') { result.invalid = 1; return result; } continue; }
          if (!Object.hasOwn(descriptor, 'value')) { result.invalid = 1; return result; }
          const value = descriptor.value;
          if (key === 'text' || key === 'originalText') {
            if (typeof value !== 'string') { result.invalid = 1; return result; }
            if (value.length > (key === 'text' ? 8192 : 16384)) { result.overBudget = 1; return result; }
            total += value.length;
            if (total > 131072) { result.overBudget = 1; return result; }
          } else if (key === 'truncated' || key === 'startsAtBoundary') {
            if (typeof value !== 'boolean') { result.invalid = 1; return result; }
          } else if (!Number.isSafeInteger(value) || value < 0) { result.invalid = 1; return result; }
          copy[key] = value;
        }
        Object.defineProperty(snapshot, String(i), { value: copy, writable: true, enumerable: true, configurable: true });
      }
      return { query, hits: snapshot };
    } catch { result.failed = 1; return result; }
}

export function createEvidenceShadow(options = {}) {
  if (options === null) throw new TypeError('options must not be null');
  let enabledDescriptor;
  for (let current = Object(options); current !== null; current = Object.getPrototypeOf(current)) {
    if (types.isProxy(current)) throw new TypeError('proxy options are not supported');
    if (Object.getOwnPropertyDescriptor(current, 'analyze')) throw new TypeError('analyze option is no longer supported');
    enabledDescriptor ??= Object.getOwnPropertyDescriptor(current, 'enabled');
  }
  if (enabledDescriptor && !Object.hasOwn(enabledDescriptor, 'value')) throw new TypeError('enabled must be a data property');
  const enabled = enabledDescriptor?.value ?? false;
  return { observe(query, hits) {
    if (enabled !== true) { const result = counts(); result.disabled = 1; return result; }
    const snapshot = safeEvidenceSnapshot(query, hits);
    if (!Object.hasOwn(snapshot, 'hits')) return snapshot;
    const result = counts();
    try {
      const output = analyzeAttributeEvidenceV1(snapshot.query, snapshot.hits);
      if (!object(output)) { result.failed = 1; return result; }
      const status = data(output, 'status');
      const conflict = data(output, 'hasConflict');
      const uncertain = data(output, 'semanticUncertain');
      const incomplete = data(output, 'contextIncomplete');
      if (!status || typeof status.value !== 'string' || !Object.hasOwn(statuses, status.value) || !conflict || typeof conflict.value !== 'boolean' || !uncertain || typeof uncertain.value !== 'boolean' || !incomplete || typeof incomplete.value !== 'boolean') { result.failed = 1; return result; }
      const expected = uncertain.value || incomplete.value ? 'uncertain' : conflict.value ? 'ambiguous' : null;
      if (status.value === 'unsupported' ? conflict.value || uncertain.value || incomplete.value :
        expected ? status.value !== expected : status.value !== 'candidates' && status.value !== 'no-evidence') { result.failed = 1; return result; }
      result.analyzed = 1;
      result[statuses[status.value]] = 1;
      result.conflict = Number(conflict.value);
      result.semanticUncertain = Number(uncertain.value);
      result.contextIncomplete = Number(incomplete.value);
      return result;
    } catch { result.failed = 1; return result; }
  } };
}
