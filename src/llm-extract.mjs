// LLM 提取层（OpenAI 兼容端点，端点/模型由 llm-client 统一解析）。
//
// 分工：规则层（extract.mjs）保证「不依赖网络也能跑、43ms 启动重建」；
// 这一层在 key 可用时补语义三元组，失败一律静默降级，调用方不需要 try/catch。
//
// 三条硬约束：
//   1. key 只从 llmKey() 读，绝不落盘、不进日志、不进 commit。
//   2. grounding：LLM 给的 sent 必须在原文里逐字 indexOf 得到，否则整条丢弃并计数。
//   3. 缓存按 text 的 sha256 去重，同一段文本永不重复调用（文本改了 hash 就变）。

import { llmKey } from './config.mjs';
import { chat, resolveModel } from './llm-client.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VTYPE_ALLOWED = new Set(['number', 'date', 'time', 'percent', 'id', 'coord', 'enum', 'text']);
const TIMEOUT_MS = 150_000;
const BATCH_SIZE = 2;     // 一次 2 条：批越大单次生成越久，实测 4 条会在 45s 超时被 abort
const MAX_TEXT_CHARS = 900; // 单条 memory 截断，避免长段落把批次的 token 打爆

export const llmStats = {
  enabled: false,
  calls: 0,
  retries: 0,
  cacheHits: 0,
  triples: 0,
  dropped: 0,
  ms: 0,
  lastError: null,
};

export function llmEnabled() {
  return Boolean(llmKey());
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

/** 按文本 hash 的缓存：内存 Map + 落盘 JSON（路径由调用方给，默认 dbPath 同级）。 */
export function createCache(cachePath) {
  const file = cachePath ? String(cachePath) : null;
  const map = new Map();
  if (file && fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) if (Array.isArray(v)) map.set(k, v);
    } catch {
      // 缓存坏了就当没有，绝不因缓存影响抽取
    }
  }
  let dirty = 0;
  return {
    get(text) {
      const k = sha(text);
      return map.has(k) ? map.get(k) : undefined;
    },
    set(text, facts) {
      map.set(sha(text), facts);
      dirty += 1;
    },
    get size() { return map.size; },
    flush() {
      if (!file || dirty === 0) return;
      const obj = {};
      for (const [k, v] of map) obj[k] = v;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(obj));
        dirty = 0;
      } catch {
        // 写缓存失败不影响主流程
      }
    },
  };
}

const SYSTEM_PROMPT = `你是记忆结构化抽取器。输入若干条中文原文片段，输出事实型三元组。

三类记忆要区分：
- 事实(fact)：稳定的属性-值，如「白鲸号总长一百八十九点九米」→ (白鲸号, 总长, 一百八十九点九米)
- 事件(event)：发生过的动作与时间地点，如「三月二十六日三时零八分触损」→ (白鲸号, 触损时间, 三月二十六日三时零八分)
- 指令(instruction)：要求/规定，如「抵港后一并检验」→ (OTS-9, 要求, 抵港后一并检验)
本轮只输出事实型三元组，事件与指令只在能被表达为「实体-属性-值」时才输出。

硬性要求：
1. 每条三元组必须是 {entity, attr, value, vtype, sent} 五个字段。
2. sent 必须是原文里连续出现的句子（逐字复制，禁止改写、禁止补全、禁止翻译）。
3. vtype 只能是 number|date|time|percent|id|coord|enum|text 之一。
4. entity 是原文里出现的具体对象（船名、机构名、人名）；attr 是名词性短语（如「总长」「触损时间」「硫含量」），不要整句、不要动词短语。
5. 抽不出就返回空数组 []，禁止编造原文没有的值。

只输出 JSON 数组，不要解释，不要 markdown 代码块。`;

function buildUserPrompt(texts) {
  const blocks = texts.map((t, i) => `【片段 ${i + 1}】\n${String(t).slice(0, MAX_TEXT_CHARS)}`).join('\n\n');
  return `${blocks}\n\n请对每个片段分别输出三元组，返回一个 JSON 对象：{"results":[{"index":1,"triples":[{entity,attr,value,vtype,sent}, ...]}, ...]}。没有三元组的片段返回 "triples": []。`;
}

function parsePayload(content) {
  if (typeof content !== 'string') return null;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    const obj = JSON.parse(s);
    if (Array.isArray(obj?.results)) return obj.results;
    if (Array.isArray(obj)) return obj;
    return null;
  } catch {
    return null;
  }
}

/** grounding 过滤：sent 必须能在原文逐字找到，且 value 出现在 sent 里。 */
export function groundFilter(triples, text) {
  const out = [];
  let dropped = 0;
  for (const t of triples || []) {
    const sent = String(t?.sent ?? '');
    const value = String(t?.value ?? '');
    const entity = t?.entity == null ? null : String(t.entity);
    const attr = String(t?.attr ?? '');
    const vtype = VTYPE_ALLOWED.has(String(t?.vtype)) ? String(t.vtype) : 'text';
    if (!sent || !attr || !value) { dropped += 1; continue; }
    if (!text.includes(sent)) { dropped += 1; continue; }
    if (!sent.includes(value)) { dropped += 1; continue; }
    out.push({ entity, attr, value, valueType: vtype, sent });
  }
  return { facts: out, dropped };
}

async function callOnce(texts, apiKey) {
  // 超时、abort、HTTP 非 2xx 都由 llm-client 抛成错误：外层 extractBatch 原有两次尝试
  // 的重试语义不变，错误也不会被吞成「成功但空结果」。
  const json = await chat({
    model: resolveModel(),
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(texts) },
    ],
  }, { timeoutMs: TIMEOUT_MS, apiKey });
  const content = json?.choices?.[0]?.message?.content;
  const parsed = parsePayload(content);
  if (!parsed) throw new Error('unparsable payload');
  return parsed;
}

/**
 * 批量抽取：entries = [{ text, ch? }]，返回与 entries 对齐的 facts 数组（每项是数组）。
 * 失败/无 key 时返回 null，调用方据此降级（静默）。
 */
export async function extractBatch(entries, opts = {}) {
  const apiKey = llmKey();
  llmStats.enabled = Boolean(apiKey);
  if (!apiKey || !entries.length) return null;

  const cache = opts.cache || createCache(opts.cachePath);
  const t0 = Date.now();
  const results = entries.map(() => null);
  const pending = [];

  entries.forEach((e, i) => {
    const hit = cache.get(e.text);
    if (hit) {
      llmStats.cacheHits += 1;
      results[i] = hit;
    } else {
      pending.push(i);
    }
  });

  for (let p = 0; p < pending.length; p += BATCH_SIZE) {
    const idxs = pending.slice(p, p + BATCH_SIZE);
    const texts = idxs.map((i) => entries[i].text);
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      try {
        if (attempt > 0) llmStats.retries += 1;
        llmStats.calls += 1;
        parsed = await callOnce(texts, apiKey);
      } catch (err) {
        llmStats.lastError = String(err?.message || err);
      }
    }
    if (!parsed) {
      // 这一批降级：results 留 null，调用方会用规则结果补位
      continue;
    }
    // 按 index 归位；index 是 1-based，容错按顺序回退
    parsed.forEach((item, j) => {
      const i = idxs[j] ?? idxs.find((x) => x === (Number(item?.index) || 0) - 1);
      if (i == null || i < 0) return;
      const raw = Array.isArray(item?.triples) ? item.triples : Array.isArray(item) ? item : [];
      const { facts, dropped } = groundFilter(raw, entries[i].text);
      llmStats.dropped += dropped;
      llmStats.triples += facts.length;
      results[i] = facts;
      cache.set(entries[i].text, facts);
    });
  }
  cache.flush();
  llmStats.ms += Date.now() - t0;
  // 全部失败 → 返回 null，让调用方一句 `if (!llm)` 就降级；
  // 部分失败保留数组（失败位是 null），由调用方逐条回退规则结果。
  return results.every((r) => r === null) ? null : results;
}
