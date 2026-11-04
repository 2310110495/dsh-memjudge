import { types } from 'node:util';

// The property ceiling also bounds the expanded record graph accepted by storage.
export const OBSERVATION_LIMITS = Object.freeze({ nodes: 4096, properties: 1024, codeUnits: 262144, depth: 128 });

const appendOwn = (array, value) => Object.defineProperty(array, array.length, { value, writable: true, enumerable: true, configurable: true });

// Read only own data properties: configuration must not execute user code.
export function ownLimit(limits, key, fallback, error) {
  if (limits === null || typeof limits !== 'object' || types.isProxy(limits)) throw new TypeError(error);
  const descriptor = Object.getOwnPropertyDescriptor(limits, key);
  if (!descriptor) return fallback;
  if (!Object.hasOwn(descriptor, 'value')) throw new TypeError(error);
  return descriptor.value ?? fallback;
}

// Node locations use parent references; observations are neither identities nor complete graphs.
export function observeRaw(value, limits = {}) {
  const budget = Object.create(null);
  for (const key of Object.keys(OBSERVATION_LIMITS)) {
    budget[key] = ownLimit(limits, key, OBSERVATION_LIMITS[key], `invalid-${key}-limit`);
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 0 || budget[key] > OBSERVATION_LIMITS[key]) throw new RangeError(`invalid-${key}-limit`);
  }
  const records = [], locations = [{ parent: null }], seen = new WeakMap();
  let nodes = 0, properties = 0, codeUnits = 0, observedPartial = false, hiddenSlotsUnverified = false, stopped = false, limitHit = false;
  const issue = (location, reason, extra = {}) => {
    observedPartial = true;
    if (['depth-limit', 'node-limit', 'property-limit', 'code-unit-limit', 'key-code-unit-limit'].includes(reason)) limitHit = true;
    appendOwn(records, { kind: 'unknown', location, reason, ...extra });
  };
  function visit(item, location, depth) {
    if (stopped) return;
    if (depth > budget.depth || nodes >= budget.nodes) {
      issue(location, depth > budget.depth ? 'depth-limit' : 'node-limit'); stopped = true; return;
    }
    nodes++;
    if (typeof item === 'string') {
      if (item.length > budget.codeUnits - codeUnits) {
        const available = budget.codeUnits - codeUnits;
        issue(location, 'code-unit-limit', { length: item.length, value: item.slice(0, available), preserved: false });
        codeUnits += available;
      } else {
        codeUnits += item.length;
        appendOwn(records, { kind: 'string', location, value: item });
      }
      return;
    }
    if (typeof item === 'symbol') { issue(location, 'symbol-value'); return; }
    if (item === null || (typeof item !== 'object' && typeof item !== 'function')) {
      appendOwn(records, { kind: 'primitive', location, type: item === null ? 'null' : typeof item }); return;
    }
    if (types.isProxy(item)) { issue(location, 'proxy'); return; }
    if (typeof item === 'function') { issue(location, 'function'); return; }
    if (seen.has(item)) { appendOwn(records, { kind: 'reference', location, target: seen.get(item) }); return; }
    seen.set(item, location);
    hiddenSlotsUnverified = true;
    appendOwn(records, { kind: 'unknown', location, reason: 'internal-slots-unverified' });
    try {
      const prototype = Object.getPrototypeOf(item);
      const internalSlots = types.isMap(item) || types.isSet(item) || types.isDate(item) || types.isRegExp(item)
        || types.isAnyArrayBuffer(item) || ArrayBuffer.isView(item) || types.isWeakMap(item) || types.isWeakSet(item)
        || types.isPromise(item) || types.isBoxedPrimitive(item);
      if (internalSlots || (prototype !== Object.prototype && prototype !== null && !(Array.isArray(item) && prototype === Array.prototype))) {
        issue(location, 'unobserved-prototype-or-internal-slots');
      }
    } catch { issue(location, 'prototype-failed'); }
    let keys;
    try { keys = Reflect.ownKeys(item); } catch { issue(location, 'own-keys-failed'); return; }
    appendOwn(records, { kind: 'object', location });
    for (let i = 0; i < keys.length; i++) {
      if (stopped) break;
      if (properties >= budget.properties) { issue(location, 'property-limit'); stopped = true; break; }
      properties++;
      const key = keys[i];
      if (typeof key !== 'string') { issue(location, 'symbol-key', { order: i }); continue; }
      if (key.length > budget.codeUnits - codeUnits) {
        const available = budget.codeUnits - codeUnits;
        issue(location, 'key-code-unit-limit', { order: i, length: key.length, value: key.slice(0, available), preserved: false, subtreeObserved: false });
        codeUnits += available;
        continue;
      }
      codeUnits += key.length;
      const child = locations.length;
      appendOwn(locations, { parent: location, key });
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(item, key); } catch { issue(child, 'descriptor-failed'); continue; }
      if (!descriptor) { issue(child, 'descriptor-missing'); continue; }
      const own = key => Object.hasOwn(descriptor, key) ? descriptor[key] : undefined;
      const flags = { enumerable: own('enumerable'), configurable: own('configurable') };
      if (Object.hasOwn(descriptor, 'value')) {
        appendOwn(records, { kind: 'property', location: child, order: i, flags: { ...flags, writable: own('writable') }, descriptor: 'data' });
        visit(own('value'), child, depth + 1);
      } else {
        appendOwn(records, { kind: 'property', location: child, order: i, flags, descriptor: 'accessor' });
        issue(child, 'accessor');
      }
    }
  }
  visit(value, 0, 0);
  return { format: 'raw-observation-v2', identity: false, completeGraph: false, partial: observedPartial || hiddenSlotsUnverified, observedPartial, hiddenSlotsUnverified, locations, records, usage: { nodes, properties, codeUnits }, limitHit };
}
