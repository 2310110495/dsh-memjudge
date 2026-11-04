import { createHash } from 'node:crypto';

export function utf16le(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const bytes = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) bytes.writeUInt16LE(text.charCodeAt(i), i * 2);
  return bytes;
}
export function fromUtf16le(bytes) {
  if (bytes.length % 2) throw new RangeError('odd UTF16LE length');
  return Buffer.from(bytes).toString('utf16le');
}
function size(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
export function domainHash(tag, bytes) {
  if (!/^[a-z0-9-]+$/.test(tag)) throw new TypeError('invalid hash domain');
  return createHash('sha256').update(Buffer.from(tag, 'ascii')).update(Buffer.from([0])).update(size(bytes.length)).update(bytes).digest('hex');
}
export function equalBytes(a, b) { return a.length === b.length && Buffer.from(a).equals(Buffer.from(b)); }

const appendOwn = (array, value) => Object.defineProperty(array, array.length, { value, writable: true, enumerable: true, configurable: true });
const reflectionErrors = new WeakSet();
function reflectIdentity(fn) {
  try { return fn(); }
  catch (cause) {
    const error = new Error('identity-reflection-failed', { cause });
    reflectionErrors.add(error);
    throw error;
  }
}
export function isIdentityReflectionError(error) {
  return typeof error === 'object' && error !== null && reflectionErrors.has(error);
}
export const IDENTITY_LIMITS = Object.freeze({ depth: 256, nodes: 50000, bytes: 8 * 1024 * 1024 });
export function encodeIdentity(value) {
  const stack = new Set();
  let nodes = 0, bytes = 0;
  function encode(v, depth = 0) {
    if (depth > IDENTITY_LIMITS.depth) throw new RangeError('identity-depth-limit');
    if (++nodes > IDENTITY_LIMITS.nodes) throw new RangeError('identity-node-limit');
    bytes += typeof v === 'string' ? 9 + v.length * 2 : 9;
    if (bytes > IDENTITY_LIMITS.bytes) throw new RangeError('identity-byte-limit');
    if (v === null) return Buffer.from([0]);
    if (v === false) return Buffer.from([1]);
    if (v === true) return Buffer.from([2]);
    if (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0)) {
      const b = Buffer.alloc(9); b[0] = 3; b.writeDoubleLE(v, 1); return b;
    }
    if (typeof v === 'string') { const b = utf16le(v); return Buffer.concat([Buffer.from([4]), size(b.length), b]); }
    if (typeof v !== 'object' || stack.has(v)) throw new TypeError('unsupported-identity');
    const array = reflectIdentity(() => Array.isArray(v));
    const prototype = reflectIdentity(() => Object.getPrototypeOf(v));
    if (array && prototype !== Array.prototype) throw new TypeError('unsupported-identity');
    if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError('unsupported-identity');
    const keys = reflectIdentity(() => Reflect.ownKeys(v));
    if (keys.some(k => typeof k !== 'string')) throw new TypeError('unsupported-identity');
    const lengthDescriptor = array ? reflectIdentity(() => Object.getOwnPropertyDescriptor(v, 'length')) : null;
    const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value') ? lengthDescriptor.value : undefined;
    if (array && (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1 || keys.some(k => k !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= length)))) throw new TypeError('unsupported-identity');
    stack.add(v);
    try {
      const chunks = [Buffer.from([array ? 5 : 6]), size(array ? length : keys.length)];
      for (const k of array ? Array.from({ length }, (_, i) => String(i)) : keys.sort()) {
        const d = reflectIdentity(() => Object.getOwnPropertyDescriptor(v, k));
        if (!d || !Object.hasOwn(d, 'value') || !Object.hasOwn(d, 'enumerable') || !d.enumerable) throw new TypeError('unsupported-identity');
        if (!array) appendOwn(chunks, encode(k, depth + 1));
        appendOwn(chunks, encode(d.value, depth + 1));
      }
      return Buffer.concat(chunks);
    } finally { stack.delete(v); }
  }
  return encode(value);
}
export function eventKey(namespace, fullSessionId, seq) {
  if (typeof namespace !== 'string' || !namespace || typeof fullSessionId !== 'string' || !fullSessionId || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)) throw new TypeError('invalid-event-key');
  return JSON.stringify([namespace, fullSessionId, seq]);
}
export function snapshotBytes(value) {
  encodeIdentity(value);
  // Serialize validated own data descriptors; inherited toJSON/getters never run.
  function stringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const array = Array.isArray(v);
    const lengthDescriptor = array ? Object.getOwnPropertyDescriptor(v, 'length') : null;
    if (array && (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0)) throw new TypeError('unsupported-snapshot');
    const keys = array ? Array.from({length:lengthDescriptor.value},(_,i)=>String(i)) : Object.keys(v);
    const values = keys.map(k => {
      const d = Object.getOwnPropertyDescriptor(v,k);
      if (!d || !Object.hasOwn(d, 'value')) throw new TypeError('unsupported-snapshot');
      return (array ? '' : JSON.stringify(k)+':') + stringify(d.value);
    });
    return (array ? '[' : '{') + values.join(',') + (array ? ']' : '}');
  }
  return utf16le(stringify(value));
}
