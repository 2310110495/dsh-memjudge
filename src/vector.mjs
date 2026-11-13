// 向量层：显式维度 + int8 量化 + 静默降级 + Schema v8 显式主键 (memory_id, space_id, content_hash) 绑定
//
// 核心约束：
//   1. dimensions 必须显式传（默认 128 维 int8 = 128 B/条）。
//   2. 任何网络/凭据/格式异常一律静默返回 null，绝不向召回路径抛错。
//   3. 缓存按有效端点/模型/实际维度/预处理版本严格隔离（schema2）。
//   4. 存储绑定彻底废除隐式 SQLite rowid，改按 (memory_id, space_id, content_hash) 显式绑定，
//      支持 LEFT JOIN 差集补洞与 CAS 防异步晚写（防删除/覆写后旧向量回写串味）。

import { embedKey, embedModel, embedDims, embedBaseUrl } from './config.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** 允许的维度（Qwen3 系列支持集合），按库体预算选。 */
export const DIMS_CHOICES = [64, 128, 256, 512, 1024];
export const DEFAULT_DIMS = 128;
export const DEFAULT_BATCH = 16;
export const DEFAULT_SCALE = 1 / 127;
const TIMEOUT_MS = 20_000;

const endpointUrl = () => `${embedBaseUrl().replace(/\/+$/, '')}/embeddings`;
const modelName = () => embedModel();

const hashText = (t) => createHash('sha256').update(String(t ?? ''), 'utf8').digest('hex');
const CACHE_SCHEMA = 2;
const PREPROCESSING_VERSION = 'string-v1';
const MAX_CACHE_IDENTITIES = 8;
const MAX_CACHE_ENTRIES = 4096;

function snapshot(dims) {
  const endpoint = endpointUrl();
  const model = modelName();
  const key = apiKey();
  let persistenceDisabled = null;
  try {
    const url = new URL(endpoint);
    // Query/fragment may carry opaque credentials; conservatively keep these URLs in memory.
    if (url.username || url.password || url.search || url.hash) persistenceDisabled = 'credential-url';
  } catch { persistenceDisabled = 'invalid-url'; }
  const identity = hashText(JSON.stringify([CACHE_SCHEMA, endpoint, model, dims, PREPROCESSING_VERSION]));
  return Object.freeze({ endpoint, model, dims, key, identity, persistenceDisabled });
}

/** float → int8（[-127,127]）。余弦用 int8 点积算，缩放系数在分子分母里约掉。 */
export function quantize(vec) {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    const v = Math.max(-1, Math.min(1, Number(vec[i]) || 0));
    out[i] = Math.round(v * 127);
  }
  return out;
}

/**
 * 动态对称量化：提取最大绝对值计算 scale = maxAbs / 127，将任意幅度浮点向量无损压入 [-127, 127]。
 * 若输入已是 Int8Array，则原样拷贝并返回默认 scale。
 */
export function quantizeWithScale(vec, explicitScale) {
  if (vec instanceof Int8Array) {
    return {
      vec: new Int8Array(vec),
      scale: Number.isFinite(explicitScale) && explicitScale > 0 ? explicitScale : DEFAULT_SCALE,
    };
  }
  const len = vec?.length ?? 0;
  const out = new Int8Array(len);
  if (!len) return { vec: out, scale: DEFAULT_SCALE };
  let maxAbs = 0;
  for (let i = 0; i < len; i += 1) {
    const a = Math.abs(Number(vec[i]) || 0);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = Number.isFinite(explicitScale) && explicitScale > 0
    ? explicitScale
    : (maxAbs > 0 ? maxAbs / 127 : DEFAULT_SCALE);
  for (let i = 0; i < len; i += 1) {
    const v = (Number(vec[i]) || 0) / scale;
    out[i] = Math.max(-127, Math.min(127, Math.round(v)));
  }
  return { vec: out, scale };
}

/** 反量化 int8 向量回 Float32Array。 */
export function dequantize(vec, scale = DEFAULT_SCALE) {
  const s = asSignedVec(vec);
  if (!s) return new Float32Array(0);
  const k = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SCALE;
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s[i] * k;
  return out;
}

/**
 * 将 SQLite BLOB 读出的 Uint8Array / Buffer 安全重解释为有符号 Int8Array，
 * 同时兼容 Int8Array、Float32Array 与普通数值数组。
 */
export function asSignedVec(v) {
  if (!v) return null;
  if (v instanceof Int8Array) return v;
  if (v instanceof Uint8Array) return new Int8Array(v.buffer, v.byteOffset, v.byteLength);
  if (ArrayBuffer.isView(v) || Array.isArray(v)) return v;
  return null;
}

/** int8 BLOB → 余弦相似度（不需要反量化，直接有符号整数点积）。 */
export function cosineInt8(a, b) {
  const va = asSignedVec(a);
  const vb = asSignedVec(b);
  if (!va || !vb || va.length === 0 || va.length !== vb.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i += 1) {
    dot += va[i] * vb[i];
    na += va[i] * va[i];
    nb += vb[i] * vb[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

// ── 缓存 ───────────────────────────────────────────────────────────────────

class VecCache {
  constructor(file, config) {
    this.file = file;
    this.identity = config.identity;
    this.dims = config.dims;
    this.persistenceDisabled = config.persistenceDisabled;
    this.map = new Map();
    this.dirty = false;
    this.inFlight = 0;
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw?.schema !== CACHE_SCHEMA || raw.identity !== this.identity ||
          !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw new Error('cache-header');
      for (const [k, v] of Object.entries(raw.entries)) {
        if (!/^[a-f0-9]{64}$/.test(k) || typeof v !== 'string') throw new Error('cache-entry');
        const buf = Buffer.from(v, 'base64');
        if (buf.length !== this.dims || buf.toString('base64') !== v) throw new Error('cache-vector');
        this.map.set(k, buf);
        if (this.map.size > MAX_CACHE_ENTRIES) this.map.delete(this.map.keys().next().value);
      }
    } catch (error) {
      this.map.clear();
      if (error.code !== 'ENOENT') _stats.cacheLoadFailures += 1;
    }
  }

  get(text) {
    const key = hashText(text);
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); }
    return hit ?? null;
  }

  set(text, buf) {
    const key = hashText(text);
    this.map.delete(key);
    this.map.set(key, Buffer.from(buf));
    if (this.map.size > MAX_CACHE_ENTRIES) this.map.delete(this.map.keys().next().value);
    this.dirty = true;
  }

  save() {
    if (!this.file || !this.dirty) return false;
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let created = false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const entries = Object.create(null);
      for (const [k, v] of this.map) entries[k] = v.toString('base64');
      writeFileSync(temp, JSON.stringify({ schema: CACHE_SCHEMA, identity: this.identity, entries }), { flag: 'wx', mode: 0o600 });
      created = true;
      renameSync(temp, this.file);
      this.dirty = false;
      return true;
    } catch {
      _stats.cacheSaveFailures += 1;
      return false;
    } finally {
      if (created || this.dirty) { try { unlinkSync(temp); } catch { /* best effort */ } }
    }
  }

  get size() { return this.map.size; }
}

let _cache = null;
let _cacheDir = null;
const _caches = new Map();
const emptyStats = () => ({ calls: 0, batches: 0, tokens: 0, hits: 0, failures: 0, ms: 0,
  cacheLoadFailures: 0, cacheSaveFailures: 0 });
let _stats = emptyStats();

export function vecStats() {
  return { ..._stats, cacheSize: _cache?.size ?? 0, cacheFile: _cache?.file ?? null,
    cacheIdentities: _caches.size,
    cacheActiveIdentities: [..._caches.values()].filter(store => store.inFlight > 0).length,
    cacheInFlight: [..._caches.values()].reduce((total, store) => total + store.inFlight, 0),
    persistenceDisabled: _cache?.persistenceDisabled ?? null };
}

export function resetVecStats() { _stats = emptyStats(); }

/** Explicit test reset; embed's directory option selects a namespace without resetting it. */
export function _setCacheDir(dir, dims) {
  for (const [namespace, store] of _caches) {
    store.save();
    if (!store.inFlight) _caches.delete(namespace);
  }
  _cacheDir = dir ? path.resolve(String(dir)) : null;
  const requested = dims ?? embedDims();
  return cache(snapshot(DIMS_CHOICES.includes(requested) ? requested : DEFAULT_DIMS));
}

function trimCaches() {
  for (const [namespace, store] of _caches) {
    if (_caches.size <= MAX_CACHE_IDENTITIES) break;
    if (store.inFlight) continue;
    store.save();
    _caches.delete(namespace);
  }
}

function cache(config, acquire = false) {
  const directory = config.persistenceDisabled ? null : _cacheDir;
  const namespace = JSON.stringify([directory, config.identity]);
  let store = _caches.get(namespace);
  if (!store) store = new VecCache(directory ? path.join(directory, `vec-cache-v2-${config.identity}.json`) : null, config);
  _caches.delete(namespace);
  _caches.set(namespace, store);
  if (acquire) store.inFlight += 1;
  trimCaches();
  _cache = store;
  return store;
}

/** key 只在内存里读，绝不落盘、不进日志。用 embed 组的 key。 */
function apiKey() {
  const k = embedKey();
  return k && k.length > 8 ? k : null;
}

async function callEmbed(texts, config) {
  const { endpoint, model, dims, key } = config;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts, dimensions: dims, encoding_format: 'float' }),
      signal: ac.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const j = await res.json();
    const data = j?.data;
    if (!Array.isArray(data) || data.length !== texts.length) return { ok: false, status: res.status };
    const vecs = data.map((d) => {
      const e = d?.embedding;
      if (!Array.isArray(e) || e.length !== dims) return null;
      return quantize(e);
    });
    if (vecs.some((v) => v === null)) return { ok: false, status: res.status };
    return { ok: true, vecs, tokens: Number(j?.usage?.prompt_tokens) || 0, ms: Date.now() - t0 };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量取向量。返回与 texts 等长的数组，元素是 Int8Array；整批失败返回 null。
 *
 * @param {string[]} texts
 * @param {{dims?:number, batch?:number, cacheDir?:string}} [opts]
 */
export async function embed(texts, opts = {}) {
  const list = (texts || []).map((t) => String(t ?? ''));
  if (!list.length) return [];
  const dims = DIMS_CHOICES.includes(opts.dims) ? opts.dims : DEFAULT_DIMS;
  const config = snapshot(dims);
  if (Object.hasOwn(opts, 'cacheDir')) _cacheDir = opts.cacheDir ? path.resolve(String(opts.cacheDir)) : null;
  const store = cache(config, true);
  try {
    return await embedWithStore(list, opts, config, store);
  } finally {
    store.inFlight -= 1;
    trimCaches();
  }
}

async function embedWithStore(list, opts, config, store) {
  const { dims } = config;
  const out = new Array(list.length).fill(null);
  const missIdx = [];
  for (let i = 0; i < list.length; i += 1) {
    const hit = store.get(list[i]);
    if (hit && hit.length === dims) { out[i] = new Int8Array(hit); _stats.hits += 1; } else missIdx.push(i);
  }
  if (!missIdx.length) { store.save(); return out; }

  if (!config.key) { _stats.failures += 1; return null; }

  const batch = Math.max(1, Number(opts.batch) || DEFAULT_BATCH);
  for (let s = 0; s < missIdx.length; s += batch) {
    const slice = missIdx.slice(s, s + batch);
    const inputs = slice.map((i) => list[i]);
    let r = await callEmbed(inputs, config);
    if (!r.ok) r = await callEmbed(inputs, config);
    _stats.calls += 1;
    if (!r.ok) { _stats.failures += 1; return null; }
    _stats.batches += 1;
    _stats.tokens += r.tokens;
    _stats.ms += r.ms;
    for (let k = 0; k < slice.length; k += 1) {
      out[slice[k]] = r.vecs[k];
      store.set(list[slice[k]], Buffer.from(r.vecs[k].buffer, r.vecs[k].byteOffset, r.vecs[k].byteLength));
    }
  }
  store.save();
  return out;
}

/** 单条便捷封装：失败返回 null（不是抛错）。 */
export async function embedOne(text, opts = {}) {
  const r = await embed([text], opts);
  return r && r[0] ? r[0] : null;
}

// ── Schema v8 显式主键存储协同（LEFT JOIN 差集补洞 + CAS 防异步晚写） ────────

/**
 * 基于 memories LEFT JOIN vectors 找出缺失、换维、换模型或 content_hash 漂移的活跃记忆差集。
 */
export function findMissingVectors(store, opts = {}) {
  const dims = DIMS_CHOICES.includes(opts.dims) ? opts.dims : (Number.isInteger(opts.dims) && opts.dims > 0 ? opts.dims : DEFAULT_DIMS);
  const model = typeof opts.model === 'string' && opts.model ? opts.model : modelName();
  const spaces = Array.isArray(opts.spaces) && opts.spaces.length ? opts.spaces.map(String) : null;

  if (typeof store?.missingVectors === 'function') {
    return store.missingVectors({ spaces, model, dims });
  }

  const db = store?.raw?.();
  if (!db) return [];
  const params = [dims, model];
  let spaceClause = '';
  if (spaces) {
    spaceClause = ` AND m.space_id IN (${spaces.map(() => '?').join(', ')})`;
    params.push(...spaces);
  }
  const sql = `
    SELECT m.id, m.space_id AS spaceId, m.text, m.content_hash AS contentHash
    FROM memories m
    LEFT JOIN vectors v ON v.memory_id = m.id
    WHERE m.status = 'active'
      AND (
        v.memory_id IS NULL
        OR v.content_hash != m.content_hash
        OR v.dims != ?
        OR (v.model != ? AND v.model != 'default')
      )${spaceClause}
    ORDER BY m.created_at ASC, m.id ASC
  `;
  return db.prepare(sql).all(...params);
}

/**
 * 增量补齐差集向量，并在写回时执行 CAS（expectedContentHash）：
 * 若异步 embed 期间记忆已被删除、归档或单活状态覆写了原文，绝不把过期旧向量写回数据库。
 */
export async function syncStoreVectors(store, opts = {}) {
  const dims = DIMS_CHOICES.includes(opts.dims) ? opts.dims : (Number.isInteger(opts.dims) && opts.dims > 0 ? opts.dims : DEFAULT_DIMS);
  const model = typeof opts.model === 'string' && opts.model ? opts.model : modelName();
  const missing = findMissingVectors(store, { spaces: opts.spaces, model, dims });
  if (!missing.length) {
    return { missing: 0, written: 0, skippedStale: 0, failed: false };
  }

  const runEmbed = typeof opts.embedFn === 'function' ? opts.embedFn : embed;
  const vecs = await runEmbed(missing.map((m) => m.text), {
    dims,
    batch: opts.batch,
    cacheDir: opts.cacheDir,
  });
  if (!vecs || vecs.length !== missing.length) {
    return { missing: missing.length, written: 0, skippedStale: 0, failed: true };
  }

  let written = 0;
  let skippedStale = 0;
  for (let i = 0; i < missing.length; i += 1) {
    const item = missing[i];
    const rawVec = vecs[i];
    if (!rawVec) continue;
    const { vec, scale } = quantizeWithScale(rawVec);
    const res = store.putVector({
      memoryId: item.id,
      spaceId: item.spaceId,
      model,
      dims: vec.length,
      scale,
      vec,
      contentHash: item.contentHash,
      expectedContentHash: item.contentHash,
      now: opts.now,
    });
    if (res?.written) written += 1;
    else skippedStale += 1;
  }
  return { missing: missing.length, written, skippedStale, failed: false };
}

/**
 * 显式主键向量检索：限定 spaces 与活跃记忆且强制校验 content_hash 一致性。
 */
export async function searchVectors(store, queryOrVec, opts = {}) {
  const topK = Math.max(1, Math.trunc(Number(opts.topK) || 40));
  const dims = DIMS_CHOICES.includes(opts.dims) ? opts.dims : (Number.isInteger(opts.dims) && opts.dims > 0 ? opts.dims : DEFAULT_DIMS);
  let qVec = null;
  if (typeof queryOrVec === 'string') {
    const runEmbed = typeof opts.embedFn === 'function'
      ? async (t, o) => {
        const r = await opts.embedFn([t], o);
        return r && r[0] ? r[0] : null;
      }
      : embedOne;
    qVec = await runEmbed(queryOrVec, { dims, cacheDir: opts.cacheDir });
  } else if (ArrayBuffer.isView(queryOrVec) || Array.isArray(queryOrVec)) {
    qVec = queryOrVec instanceof Int8Array ? queryOrVec : quantizeWithScale(queryOrVec).vec;
  }
  if (!qVec || !qVec.length) return [];

  if (typeof store?.vectorSearch === 'function') {
    return store.vectorSearch(qVec, {
      spaces: opts.spaces,
      spaceId: opts.spaceId,
      topK,
      dims: qVec.length,
      model: opts.model,
      minScore: opts.minScore,
    });
  }

  const rows = store.getVectors({
    spaces: opts.spaces,
    spaceId: opts.spaceId,
    dims: qVec.length,
    model: opts.model,
  });
  const scored = [];
  for (const row of rows) {
    const score = cosineInt8(qVec, row.vec);
    if (Number.isFinite(opts.minScore) && score < opts.minScore) continue;
    scored.push({
      id: row.memoryId,
      memoryId: row.memoryId,
      spaceId: row.spaceId,
      score,
      contentHash: row.contentHash,
    });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.slice(0, topK);
}

export default {
  embed,
  embedOne,
  quantize,
  quantizeWithScale,
  dequantize,
  asSignedVec,
  cosineInt8,
  vecStats,
  resetVecStats,
  findMissingVectors,
  syncStoreVectors,
  searchVectors,
  DIMS_CHOICES,
  DEFAULT_DIMS,
  DEFAULT_BATCH,
  DEFAULT_SCALE,
};
