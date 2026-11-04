// 向量层：Qwen3-Embedding-8B + 显式维度 + int8 量化 + 静默降级
//
// 三条硬约束（都是实测踩出来的，不是设计洁癖）：
//   1. dimensions 必须显式传。默认 4096 维 float32 = 16KB/条，294 段就 4.7MB，
//      直接炸穿 SPEC §2.7 的 200KB。128 维 int8 是 128 B/条。
//   2. 只用 node 的 fetch。bash 的 `curl -d '{"input":"中文"}'` 会被 shell 吃掉编码，
//      服务端回 20015 参数非法。
//   3. 任何一种失败（无 key / 超时 / 429 / 5xx / 结构不对）都 return null，
//      绝不让异常冒到召回路径上——降级必须是静默的。
//
// schema2 缓存按有效端点/模型/实际维度/预处理版本隔离，旧文件原样保留且不复用。
// 文件只存身份摘要和完整文本哈希；凭据 URL 仅使用内存，状态不暴露 URL 或 key。

import { embedKey, embedModel, embedDims, embedBaseUrl } from './config.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
/** 允许的维度（Qwen3 系列支持集合），按库体预算选。 */
export const DIMS_CHOICES = [64, 128, 256, 512, 1024];
export const DEFAULT_DIMS = 128;
export const DEFAULT_BATCH = 16; // 实测：batch=16 约 1.3s/次；32 反而 6.4s（服务端排队）
const TIMEOUT_MS = 20_000;
/** 端点与模型跟随用户配置（原本硬编码，改配置等于不生效）。
 *  只读 embed 组：向量模型可以与对话模型不同供应商。 */
const endpointUrl = () => `${embedBaseUrl().replace(/\/+$/, '')}/embeddings`;
const modelName = () => embedModel();

const hashText = (t) => createHash('sha256').update(String(t)).digest('hex');
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

/** int8 BLOB → 余弦相似度（不需要反量化，直接整数点积）。 */
export function cosineInt8(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
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
      // A write can fail after creating the file; the random name belongs only to this save.
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
    // A reset must not detach an object still owned by an embed call.
    if (!store.inFlight) _caches.delete(namespace);
  }
  _cacheDir = dir ? path.resolve(String(dir)) : null;
  const requested = dims ?? embedDims();
  return cache(snapshot(DIMS_CHOICES.includes(requested) ? requested : DEFAULT_DIMS));
}

// Retain at most eight stores unless live requests pin more identities. Every
// release immediately converges to max(8, active identities); no idle overflow.
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
  // Pin before trimming, including the first request for a new namespace.
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
 * 批量取向量。返回与 texts 等长的数组，元素是 Int8Array；**整批失败返回 null**。
 * 命中缓存的条目不进 API；只有 miss 的才批量发。失败重试一次后放弃（不无限重试）。
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

  if (!config.key) { _stats.failures += 1; return null; } // 无 key：静默降级

  const batch = Math.max(1, Number(opts.batch) || DEFAULT_BATCH);
  for (let s = 0; s < missIdx.length; s += batch) {
    const slice = missIdx.slice(s, s + batch);
    const inputs = slice.map((i) => list[i]);
    let r = await callEmbed(inputs, config);
    if (!r.ok) r = await callEmbed(inputs, config); // 重试一次
    _stats.calls += 1;
    if (!r.ok) { _stats.failures += 1; return null; } // 这一批失败就整次降级
    _stats.batches += 1;
    _stats.tokens += r.tokens;
    _stats.ms += r.ms;
    for (let k = 0; k < slice.length; k += 1) {
      out[slice[k]] = r.vecs[k];
      store.set(list[slice[k]], Buffer.from(r.vecs[k].buffer));
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

export default { embed, embedOne, quantize, cosineInt8, vecStats, resetVecStats, DIMS_CHOICES, DEFAULT_DIMS };
