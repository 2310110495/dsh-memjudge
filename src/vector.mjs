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
// 缓存：按 sha256(text) 前 16 位索引，落 <cacheDir>/vec-cache-<model>-<dims>-<hash>.json，
// 值存 int8 base64。同一段文本永不重复调用；文本一变 hash 就变，缓存自然失效。
// **文件名带模型指纹**：键里只有文本哈希时，换 embedModel 或改 dims 会原样复用旧向量
// ——维度不同直接错，维度碰巧相同则静默算错相似度。指纹进文件名后，换模型只是「新起
// 一个文件」，旧文件留着可回滚，两者互不污染。

import { llmKey, embedModel, embedDims, llmBaseUrl } from './config.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
/** 允许的维度（Qwen3 系列支持集合），按库体预算选。 */
export const DIMS_CHOICES = [64, 128, 256, 512, 1024];
export const DEFAULT_DIMS = 128;
export const DEFAULT_BATCH = 16; // 实测：batch=16 约 1.3s/次；32 反而 6.4s（服务端排队）
const TIMEOUT_MS = 20_000;
/** 端点与模型跟随用户配置（原本硬编码，改配置等于不生效）。 */
const endpointUrl = () => `${llmBaseUrl().replace(/\/+$/, '')}/embeddings`;
const modelName = () => embedModel();

const hashText = (t) => createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

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
  constructor(file) {
    this.file = file || null;
    this.map = new Map();
    this.dirty = false;
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.map.set(k, Buffer.from(v, 'base64'));
    } catch {
      // 没有缓存 / 缓存坏了：当作空，不报错
    }
  }

  get(text) {
    return this.map.get(hashText(text)) ?? null;
  }

  set(text, buf) {
    this.map.set(hashText(text), Buffer.from(buf));
    this.dirty = true;
  }

  save() {
    if (!this.file || !this.dirty) return false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const obj = Object.create(null);
      for (const [k, v] of this.map) obj[k] = Buffer.from(v).toString('base64');
      writeFileSync(this.file, JSON.stringify(obj));
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  get size() {
    return this.map.size;
  }
}

/** 进程内单例：同一进程多次 embed 共享缓存。 */
let _cache = null;
/** 最近一次显式设置的缓存目录；null = 不落盘（纯内存缓存）。 */
let _cacheDir = null;
let _stats = { calls: 0, batches: 0, tokens: 0, hits: 0, failures: 0, ms: 0 };

/**
 * 模型名 → 文件名片段。为什么不是纯哈希：`ls` 一眼能看出这堆缓存属于哪个模型，
 * 排查「换了模型还在用旧向量」时不用先算 sha256。为什么还留哈希：slug 化会撞
 * （`a/b` 与 `a\b` 都变 `a-b`），且超长模型名要截断，哈希兜住这两种情况。
 */
function modelSlug() {
  const s = embedModel()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'model';
}

/** 缓存文件名：模型 slug + 实际生效维度 + 指纹前 8 位。 */
function cacheFileName(dims) {
  const fingerprint = createHash('sha256').update(`${embedModel()}|${dims}`).digest('hex').slice(0, 8);
  return `vec-cache-${modelSlug()}-${dims}-${fingerprint}.json`;
}

function cachePathFor(dims) {
  return _cacheDir ? path.join(_cacheDir, cacheFileName(dims)) : null;
}

export function vecStats() {
  return { ..._stats, cacheSize: _cache?.size ?? 0, cacheFile: _cache?.file ?? null };
}

export function resetVecStats() {
  _stats = { calls: 0, batches: 0, tokens: 0, hits: 0, failures: 0, ms: 0 };
}

/** 测试用：注入自定义缓存目录 / 清空单例。传 null 或空串清成纯内存。
 *  第二个参数是本次要用的维度，省略时按配置维度命名（embed() 会显式传实际维度）。 */
export function _setCacheDir(dir, dims) {
  _cacheDir = dir ? path.resolve(String(dir)) : null;
  // 旧实例若有未落盘的向量，先存一次再换文件，别把已经付过 API 费的向量丢掉
  if (_cache?.dirty) _cache.save();
  _cache = new VecCache(cachePathFor(Number.isFinite(dims) && dims > 0 ? Math.trunc(dims) : embedDims()));
  return _cache;
}

/**
 * 取缓存实例。目录相同但文件不同（换了模型/维度）就换一个新实例：
 * 否则进程内会一直拿旧模型的向量算相似度——这正是本轮要修的那个静默算错。
 */
function cache(dims = DEFAULT_DIMS) {
  const file = cachePathFor(dims);
  if (_cache && _cache.file === file) return _cache;
  if (_cache?.dirty) _cache.save();
  _cache = new VecCache(file);
  return _cache;
}

/** key 只在内存里读，绝不落盘、不进日志。 */
function apiKey() {
  const k = llmKey();
  return k && k.length > 8 ? k : null;
}

async function callEmbed(texts, dims, key) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(endpointUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: modelName(), input: texts, dimensions: dims, encoding_format: 'float' }),
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
  if (opts.cacheDir) _setCacheDir(opts.cacheDir, dims);
  // 传实际生效的 dims：文件名里的维度与写进文件的内容必须同源
  const store = cache(dims);

  const out = new Array(list.length).fill(null);
  const missIdx = [];
  for (let i = 0; i < list.length; i += 1) {
    const hit = store.get(list[i]);
    if (hit && hit.length === dims) { out[i] = new Int8Array(hit); _stats.hits += 1; } else missIdx.push(i);
  }
  if (!missIdx.length) return out;

  const key = apiKey();
  if (!key) { _stats.failures += 1; return null; } // 无 key：静默降级

  const batch = Math.max(1, Number(opts.batch) || DEFAULT_BATCH);
  for (let s = 0; s < missIdx.length; s += batch) {
    const slice = missIdx.slice(s, s + batch);
    const inputs = slice.map((i) => list[i]);
    let r = await callEmbed(inputs, dims, key);
    if (!r.ok) r = await callEmbed(inputs, dims, key); // 重试一次
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
