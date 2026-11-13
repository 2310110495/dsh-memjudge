// memjudge 宿主 RPC（v2）：通过 ctx.connection.fetch.register 注册 /api/memjudge.* exact POST 路由。
//
// 完全兼容既有前端与单测信封契约（{ ok: true, value } / { ok: false, error: { code, message, details } }），
// 同时支持 v2 扩展路由与字段：
//   - status: 扩展 schemaVersion: 8, spaces, categories, kinds, layers (L0-L3), wikiCount, inject 预算状态
//   - memories: 支持按 spaceId / category / kind / layer / q 过滤，返回 slotKey / revisionCount 等
//   - wiki: 返回持久化的 wiki_pages 演进页列表及单活 state 看板数据，支持触发增量重编
//   - conflicts: 融合 entity_slots + classifyConflict 三分冲突（supersession/conditional/disputed）
//   - forget / demote / config / secret / reindex + saveKey / clearKey / saveConfig / saveSettings / testKey

import { open as openStore } from './store.mjs';
import {
  CRED_GROUPS,
  configReport,
  envLockedFlags,
  moduleFlags,
  rawConfig,
  saveConfig,
  saveKey,
  chatBaseUrl,
  embedBaseUrl,
  rerankBaseUrl,
  chatKey,
  embedKey,
  rerankKey,
  chatModel,
  embedModel,
  rerankModel,
  embedDims,
  groupReport,
  maxChars as configuredMaxChars,
  storageLimitBytes as configuredStorageLimitBytes,
} from './config.mjs';
import { classifyConflict, resolveConflict } from './judge.mjs';
import { TIER_S_MAX_CHARS, TIER_D_MAX_CHARS, TOTAL_INJECT_MAX_CHARS } from './inject.mjs';
import { deriveClusterSlug, buildWikiPage, compileDirtyWikiPages, runMetabolism } from './lifecycle.mjs';
import { SearchIndex } from './search.mjs';
import { resolveScope } from './scope.mjs';
import { buildObservabilitySnapshot, collectObservationCounts, resolveObservationScope } from './observability.mjs';

function normalizeRpcSpace(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s === 'all') return '';
  if (s.toLowerCase() === 'global') return 'global';
  if (/^workspace:/i.test(s) && !/^workspace:[0-9a-f]{12}$/i.test(s)) return s.toLowerCase();
  if (/^session:/i.test(s)) return s;
  return resolveScope({ space: s }).spaceId;
}

/** 面板允许写的开关白名单，其它键一律静默丢弃。 */
const WRITABLE_FLAGS = ['vector', 'rerank', 'expand', 'llmSelect', 'llmExtract', 'autoCapture'];

const MODEL_TEXT_CAP = 120;
const BASE_URL_CAP = 200;
const LIMIT_BYTES_MIN = 64 * 1024;
const LIMIT_BYTES_MAX = 1024 * 1024 * 1024;
const MAX_CHARS_MAX = 1e8;

const BASE_URL_KEYS = ['chatBaseUrl', 'embedBaseUrl', 'rerankBaseUrl'];
const MODEL_KEYS = ['chatModel', 'embedModel', 'rerankModel'];
const MODE_KEYS = CRED_GROUPS.map((g) => `${g}Mode`);
const SETTING_KEYS = [...BASE_URL_KEYS, ...MODEL_KEYS, ...MODE_KEYS, 'dims', 'storageLimitBytes', 'maxChars'];

const SETTING_ALIAS = { baseUrl: 'chatBaseUrl' };

export function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { error: 'settings 必须是对象' };
  }
  const src = { ...settings };
  for (const [alias, target] of Object.entries(SETTING_ALIAS)) {
    if (
      Object.prototype.hasOwnProperty.call(src, alias)
      && !Object.prototype.hasOwnProperty.call(src, target)
    ) {
      src[target] = src[alias];
    }
    delete src[alias];
  }
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);

  for (const key of BASE_URL_KEYS) {
    if (!has(key)) continue;
    const raw = src[key];
    if (typeof raw !== 'string') return { error: `${key}：必须是字符串` };
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (trimmed) {
      try {
        const url = new URL(trimmed);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
      } catch {
        return { error: `${key}：需要无凭据、查询和片段的 HTTP(S) 地址` };
      }
    }
    if (trimmed.length > BASE_URL_CAP) return { error: `${key}：长度不能超过 ${BASE_URL_CAP} 字符` };
    out[key] = trimmed;
  }

  for (const key of MODEL_KEYS) {
    if (!has(key)) continue;
    const raw = src[key];
    if (typeof raw !== 'string') return { error: `${key}：必须是字符串` };
    const trimmed = raw.trim();
    if (trimmed.length > MODEL_TEXT_CAP) return { error: `${key}：长度不能超过 ${MODEL_TEXT_CAP} 字符` };
    out[key] = trimmed;
  }

  for (const g of CRED_GROUPS) {
    const k = `${g}Mode`;
    if (!has(k)) continue;
    if (!['independent', 'disabled', ...(g === 'chat' ? [] : ['inherit'])].includes(src[k])) {
      return { error: `${k}：模式无效` };
    }
    out[k] = src[k];
  }

  if (has('dims')) {
    const n = src.dims;
    if (!Number.isInteger(n)) return { error: 'dims：必须是整数' };
    if (n < 1 || n > 8192) return { error: 'dims：必须在 1..8192 之间' };
    out.dims = n;
  }

  if (has('storageLimitBytes')) {
    const n = src.storageLimitBytes;
    if (!Number.isInteger(n)) return { error: 'storageLimitBytes：必须是整数' };
    if (n < LIMIT_BYTES_MIN || n > LIMIT_BYTES_MAX) {
      return { error: `storageLimitBytes：必须在 ${LIMIT_BYTES_MIN}..${LIMIT_BYTES_MAX} 字节之间` };
    }
    out.storageLimitBytes = n;
  }

  if (has('maxChars')) {
    const n = src.maxChars;
    if (!Number.isInteger(n)) return { error: 'maxChars：必须是整数' };
    if (n < 0 || n > MAX_CHARS_MAX) return { error: `maxChars：必须在 0..${MAX_CHARS_MAX} 之间（0 = 不设限）` };
    out.maxChars = n;
  }

  return { patch: out };
}

const TEST_KEY_TIMEOUT_MS = 8000;

export const RPC_ENDPOINTS = Object.freeze([
  'status',
  'memories',
  'conflicts',
  'saveKey',
  'clearKey',
  'saveConfig',
  'saveSettings',
  'testKey',
]);

const FETCH_ROUTE_PREFIX = '/api/memjudge.';
const REGISTERED_PATHS = new WeakMap();

function jsonResponse(value) {
  return Response.json(value);
}

function ok(value) {
  return { ok: true, value };
}

function previewText(value, cap = 200) {
  const text = String(value ?? '');
  if (text.length <= cap) return text;
  let end = cap;
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end -= 1;
  return text.slice(0, end);
}

function fail(message, code = 'bad-request') {
  return { ok: false, error: { code, message, details: {} } };
}

function groupParam(raw) {
  if (raw == null || String(raw).trim() === '') return { group: 'chat' };
  const g = String(raw).trim().toLowerCase();
  if (!CRED_GROUPS.includes(g)) return { error: `group：只能是 ${CRED_GROUPS.join(' / ')} 之一` };
  return { group: g };
}

const GROUP_KEY = { chat: chatKey, embed: embedKey, rerank: rerankKey };

function openConfiguredStore(dbPath) {
  return openStore(dbPath, {
    maxChars: configuredMaxChars(),
    storageLimitBytes: configuredStorageLimitBytes(),
  });
}

function runWithStore(opts, query) {
  if (opts?.store && typeof opts.store.stats === 'function') {
    return query(opts.store);
  }
  const store = openConfiguredStore(opts?.dbPath);
  let failed = false;
  try {
    return query(store);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) {
      try { store.close(); } catch { /* Preserve original error */ }
    } else {
      store.close();
    }
  }
}

function chapterOf(row) {
  if (row?.chapter !== undefined && row?.chapter !== null) return String(row.chapter);
  const m = /^mem-c(\d+)-p\d+-/.exec(String(row?.id ?? ''));
  if (m) return String(Number(m[1]));
  const src = row?.source;
  return src ? String(src).slice(0, 12) : '';
}

function parseLayerFilter(rawLayer) {
  if (rawLayer === undefined || rawLayer === null || rawLayer === '' || rawLayer === 'all') return null;
  if (typeof rawLayer === 'number' && Number.isInteger(rawLayer) && rawLayer >= 0 && rawLayer <= 3) {
    return rawLayer;
  }
  const s = String(rawLayer).trim().toUpperCase();
  if (/^L[0-3]$/.test(s)) return Number(s.slice(1));
  if (/^[0-3]$/.test(s)) return Number(s);
  return null;
}

function getRawDb(store) {
  if (!store?.raw) return null;
  return typeof store.raw === 'function' ? store.raw() : store.raw;
}

function readRevisionCounts(store) {
  const map = new Map();
  const db = getRawDb(store);
  if (!db) return map;
  try {
    const rows = db
      .prepare('SELECT memory_id, COUNT(*) AS cnt FROM main.memory_revisions GROUP BY memory_id')
      .all();
    for (const r of rows) map.set(String(r.memory_id), Number(r.cnt ?? 0));
  } catch {
    // 忽略无表最小桩
  }
  return map;
}

function readSpaceMemoryCounts(store) {
  const map = new Map();
  const db = getRawDb(store);
  if (!db) return map;
  try {
    const rows = db
      .prepare("SELECT space_id, COUNT(*) AS cnt FROM main.memories WHERE status = 'active' GROUP BY space_id")
      .all();
    for (const r of rows) map.set(String(r.space_id), Number(r.cnt ?? 0));
  } catch {
    // 忽略
  }
  return map;
}

function collectAllFactsSafe(store) {
  if (typeof store.allFacts === 'function') {
    return store.allFacts();
  }
  const db = getRawDb(store);
  if (db) {
    try {
      return db
        .prepare("SELECT s.entity, s.attr, s.value, s.unit, s.polarity, s.quote, s.memory_id, s.space_id, m.text, m.created_at, m.superseded_by, m.supersedes_json FROM main.entity_slots s JOIN main.memories m ON m.id = s.memory_id WHERE m.status = 'active'")
        .all();
    } catch {
      // 回退 dump
    }
  }
  return store.dump().flatMap((m) => (Array.isArray(m.facts) ? m.facts : []));
}

function normalizeRpcConflictPolarity(p) {
  if (p === -1 || p === '-1' || p === 'negate' || p === 'negative') return 'negate';
  if (p === 0 || p === '0' || p === 'neutral') return 'neutral';
  return 'affirm';
}

function extractRpcConflictType(cls) {
  const t = typeof cls === 'string' ? cls : (cls?.type ?? 'disputed');
  return t === 'supersession' || t === 'conditional' || t === 'disputed' ? t : 'disputed';
}

function normalizeMetabolismReceipt(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const act = meta.actions && typeof meta.actions === 'object' ? meta.actions : {};
  const l1DemotedToL2 = Number(act.l1DemotedToL2 ?? act.l1Demoted ?? act.l2Demoted ?? 0);
  const wikiPagesUpdated = Number(act.wikiPagesUpdated ?? act.l2WikiBuilt ?? act.wikiCompiled ?? 0);
  const l3Archived = Number(act.l3Archived ?? 0);
  const compacted = Number(act.compacted ?? (l1DemotedToL2 + l3Archived));
  const vacuumed = Boolean(act.vacuumed);
  return {
    ...meta,
    actions: {
      ...act,
      l1DemotedToL2,
      wikiPagesUpdated,
      l3Archived,
      compacted,
      vacuumed,
    },
  };
}

function collectConflicts(store, payload = {}) {
  const cap = Math.max(1, Math.min(200, Math.trunc(Number(payload?.cap ?? payload?.limit) || 40)));
  const spaceFilter = normalizeRpcSpace(payload?.spaceId ?? payload?.space);

  const facts = collectAllFactsSafe(store).filter(
    (f) => !spaceFilter || !f.space_id || f.space_id === spaceFilter,
  );

  const byAttr = new Map();
  for (const f of facts) {
    const attrKey = f.attr || f.entity;
    if (!attrKey || f.value == null) continue;
    const gKey = f.entity && f.attr ? `${f.entity}::${f.attr}` : String(attrKey);
    if (!byAttr.has(gKey)) byAttr.set(gKey, { attr: String(f.attr || attrKey), entity: String(f.entity || ''), unit: String(f.unit || ''), items: [], vals: new Set() });
    const grp = byAttr.get(gKey);
    const pol = normalizeRpcConflictPolarity(f.polarity);
    const valStr = pol === 'negate' ? `非${f.value}` : String(f.value);
    grp.vals.add(valStr);
    grp.items.push({ ...f, polarityLabel: pol });
  }

  const out = [];
  for (const [key, grp] of byAttr.entries()) {
    if (grp.vals.size < 2) continue;
    const values = [...grp.vals];
    const first = grp.items[0];
    const latest = grp.items[grp.items.length - 1];
    let supersedes = [];
    try { supersedes = JSON.parse(latest.supersedes_json || '[]'); } catch { supersedes = []; }
    const cls = classifyConflict(
      {
        id: first.memory_id,
        entity: first.entity,
        attr: first.attr,
        value: first.value,
        unit: first.unit,
        polarity: first.polarityLabel,
        text: first.text || first.quote || '',
        createdAt: first.created_at,
        supersededBy: first.superseded_by,
      },
      {
        id: latest.memory_id,
        entity: latest.entity,
        attr: latest.attr,
        value: latest.value,
        unit: latest.unit,
        polarity: latest.polarityLabel,
        text: latest.text || latest.quote || '',
        createdAt: latest.created_at,
        supersedes,
      },
    );
    const conflictType = extractRpcConflictType(cls);
    const presentation = typeof cls === 'object' && cls?.presentation ? String(cls.presentation) : '';
    out.push({
      key,
      entity: grp.entity,
      attr: grp.attr,
      unit: grp.unit,
      conflictType,
      ...(presentation ? { presentation } : {}),
      values,
      current: values[values.length - 1],
      currentMemId: String(latest.memory_id ?? ''),
      evidence: grp.items.slice(0, 6).map((it) => ({
        memId: String(it.memory_id ?? ''),
        value: String(it.value ?? ''),
        polarity: it.polarityLabel,
        quote: previewText(it.quote || it.text || '', 160),
      })),
    });
  }

  if (out.length < cap && typeof store.list === 'function') {
    const activeRows = store.list({
      status: 'active',
      includeText: true,
      ...(spaceFilter ? { spaceId: spaceFilter } : {}),
      limit: 2000,
    });
    const byChap = new Map();
    const pushSeg = (docKey, ch, pa, mem) => {
      const k = `${docKey}\0${ch}`;
      if (!byChap.has(k)) byChap.set(k, []);
      byChap.get(k).push({ mem, para: pa });
    };
    for (const m of activeRows) {
      const occs = typeof store.occurrencesV1 === 'function' ? store.occurrencesV1(m.id) : [];
      const validOccs = occs.filter((o) => o && (o.documentId != null || o.chapter != null));
      if (validOccs.length > 0) {
        for (const o of validOccs) {
          const ch = o.chapter ?? 0;
          const pa = o.para ?? 0;
          const docId = o.documentId ?? (ch > 0 ? `ch:${ch}` : `mem:${m.id}`);
          pushSeg(docId, ch, pa, m);
        }
      } else {
        const ch = chapterOf(m) ?? 0;
        pushSeg(ch > 0 ? `ch:${ch}` : `mem:${m.id}`, ch, 0, m);
      }
    }
    const chapterRows = [];
    for (const [k, items] of byChap.entries()) {
      items.sort((a, b) => a.para - b.para);
      chapterRows.push({
        id: items[items.length - 1].mem.id,
        chapter: Number(k.split('\0')[1]) || 0,
        text: items.map((x) => x.mem.text).join('\n'),
        createdAt: Math.max(...items.map((x) => x.mem.createdAt ?? 0)),
      });
    }
    const chapConflicts = resolveConflict(chapterRows).conflicts ?? [];
    const seen = new Set(out.map((c) => `${c.attr}|${c.unit}`));
    for (const c of chapConflicts) {
      const attrName = String(c.attr ?? c.noun ?? '');
      const sig = `${attrName}|${c.unit ?? ''}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const vals = Array.isArray(c.values) ? c.values.map((v) => String(v ?? '')) : [];
      const evList = Array.isArray(c.evidence) ? c.evidence : [];
      const lastEv = evList[evList.length - 1] ?? {};
      out.push({
        key: String(c.key ?? sig),
        entity: String(c.entity ?? c.noun ?? ''),
        attr: attrName,
        unit: String(c.unit ?? ''),
        conflictType: extractRpcConflictType(c.conflictType),
        ...(c.presentation ? { presentation: String(c.presentation) } : {}),
        values: vals,
        current: String(c.current ?? vals[vals.length - 1] ?? ''),
        currentMemId: String(c.currentMemId ?? lastEv.memId ?? ''),
        evidence: evList.map((ev) => ({
          memId: String(ev.memId ?? ''),
          value: String(ev.value ?? ''),
          polarity: normalizeRpcConflictPolarity(ev.polarity),
          quote: previewText(ev.text ?? ev.sentence ?? '', 160),
        })),
      });
    }
  }

  return out
    .sort((a, b) => b.values.length - a.values.length)
    .slice(0, cap);
}

function compileSpaceWikiPages(store, spaceId, nowMs = Date.now()) {
  const dirtyRes = compileDirtyWikiPages(store, {
    ...(spaceId && spaceId !== 'all' ? { spaceId } : {}),
    now: nowMs,
  });
  const listOpts = { status: 'active', includeText: true, limit: 2000 };
  if (spaceId && spaceId !== 'all') listOpts.spaceId = spaceId;
  const activeMems = store.list(listOpts);
  const groups = new Map();
  for (const m of activeMems) {
    if (m.category === 'rule' || m.category === 'profile') continue;
    const sp = m.spaceId ?? 'global';
    const slug = deriveClusterSlug(m);
    const gKey = `${sp}::${slug}`;
    if (!groups.has(gKey)) groups.set(gKey, { spaceId: sp, slug, mems: [] });
    groups.get(gKey).mems.push(m);
  }
  const existing = new Set(
    (typeof store.listWikiPages === 'function' ? store.listWikiPages({ limit: 10000 }) : [])
      .map((p) => `${p.spaceId}::${p.slug}`),
  );
  let seeded = 0;
  for (const [gKey, grp] of groups.entries()) {
    if (existing.has(gKey) || grp.mems.length === 0) continue;
    buildWikiPage(store, {
      spaceId: grp.spaceId,
      slug: grp.slug,
      memories: grp.mems,
      now: nowMs,
    });
    seeded += 1;
  }
  const dirtyCount = Array.isArray(dirtyRes) ? dirtyRes.length : Number(dirtyRes?.compiled ?? 0);
  return {
    compiled: dirtyCount + seeded,
    dirtyCompiled: dirtyCount,
    seeded,
  };
}

export function keyState() {
  const groups = {};
  for (const g of CRED_GROUPS) groups[g] = groupReport(g);
  return {
    hasKey: groups.chat.keyConfigured,
    keyMasked: groups.chat.keyMasked,
    keySource: groups.chat.keySource,
    groups,
    flags: moduleFlags(),
  };
}

export function probeSpec(group) {
  if (group === 'embed') {
    return {
      endpoint: `${embedBaseUrl()}/embeddings`,
      model: embedModel(),
      body: (model) => ({ model, input: 'ping', dimensions: embedDims() }),
    };
  }
  if (group === 'rerank') {
    return {
      endpoint: `${rerankBaseUrl()}/rerank`,
      model: rerankModel(),
      body: (model) => ({ model, query: 'ping', documents: ['ping'] }),
    };
  }
  return {
    endpoint: `${chatBaseUrl()}/chat/completions`,
    model: chatModel(),
    body: (model) => ({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }),
  };
}

export async function testKey(group, key, fetchImpl = fetch) {
  const spec = probeSpec(group);
  const requestBody = spec.body(spec.model);
  const diagnostics = { model: '[REDACTED]', endpoint: '[REDACTED]' };
  const controller = new AbortController();
  let timer;
  const started = Date.now();
  const monotonicStarted = performance.now();
  let expire;
  const timeoutError = new Error('testKey timeout');
  timeoutError.name = 'AbortError';
  try {
    const timeout = new Promise((_, reject) => {
      expire = () => {
        if (controller.signal.aborted) return;
        reject(timeoutError);
        controller.abort();
      };
      timer = setTimeout(expire, TEST_KEY_TIMEOUT_MS);
    });
    const expired = () => performance.now() - monotonicStarted >= TEST_KEY_TIMEOUT_MS;
    const checkDeadline = () => {
      if (expired()) { expire(); throw timeoutError; }
    };
    const cancel = (target) => {
      try { Promise.resolve(target?.cancel()).catch(() => {}); } catch { /* Best effort */ }
    };
    const request = (async () => {
      const res = await fetchImpl(spec.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (controller.signal.aborted || expired()) {
        cancel(res.body);
        if (!controller.signal.aborted) checkDeadline();
        return;
      }
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        cancel(res.body);
        return { res, body: '', latencyMs };
      }
      let body = '';
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        let complete = false;
        let chunks = 0;
        const onAbort = () => cancel(reader);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        try {
          while (true) {
            checkDeadline();
            const { value, done } = await reader.read();
            if (controller.signal.aborted) return;
            checkDeadline();
            if (done) { complete = true; body += decoder.decode(); break; }
            if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]' || (size += value.byteLength) > 1024 * 1024) break;
            body += decoder.decode(value, { stream: true });
            if (++chunks % 256 === 0) await new Promise((resolve) => setImmediate(resolve));
          }
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          checkDeadline();
          body = '';
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
          if (!complete) { body = ''; cancel(reader); }
          try { reader.releaseLock(); } catch { /* Pending reads can retain lock */ }
        }
      } else if (!res.body && typeof res.text === 'function') {
        const text = await res.text();
        if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= 1024 * 1024) body = text;
      }
      checkDeadline();
      return { res, body, latencyMs };
    })();
    const { res, body, latencyMs } = await Promise.race([request, timeout]);
    checkDeadline();
    let valid = false;
    if (res.ok) {
      try {
        const data = JSON.parse(body);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          if (group === 'chat') valid = Array.isArray(data.choices) && data.choices.some((c) => typeof c?.message?.content === 'string' && c.message.content.trim());
          if (group === 'embed') valid = Array.isArray(data.data) && data.data.length === 1 && data.data.every((row) => Array.isArray(row?.embedding) && row.embedding.length === requestBody.dimensions && row.embedding.every((v) => typeof v === 'number' && Number.isFinite(v)));
          if (group === 'rerank') {
            const rows = data.results;
            valid = Array.isArray(rows) && rows.length === 1 && new Set(rows.map((r) => r?.index)).size === rows.length && rows.every((r) => Number.isInteger(r?.index) && r.index >= 0 && r.index < 1 && typeof r.relevance_score === 'number' && Number.isFinite(r.relevance_score));
          }
        }
      } catch { /* Malformed payload */ }
    }
    checkDeadline();
    if (valid) return { ok: true, group, status: res.status, latencyMs, ...diagnostics };
    return {
      ok: false,
      group,
      status: res.status,
      latencyMs,
      ...diagnostics,
      code: res.ok ? 'invalid-response' : 'http-error',
      message: res.ok ? '响应结构或内容无效' : `HTTP ${res.status}`,
    };
  } catch (err) {
    if (performance.now() - monotonicStarted >= TEST_KEY_TIMEOUT_MS) {
      expire();
      err = timeoutError;
    }
    return {
      ok: false,
      group,
      status: null,
      latencyMs: Date.now() - started,
      ...diagnostics,
      code: err?.name === 'AbortError' ? 'timeout' : 'network-error',
      message: err?.name === 'AbortError' ? `请求超时（${TEST_KEY_TIMEOUT_MS}ms）` : '网络请求失败',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function installMemjudgeRpc(ctx, opts = {}) {
  const execSaveKey = (payload) => {
    const { group, error: groupError } = groupParam(payload?.group);
    if (groupError) return fail(groupError);
    if (!Object.prototype.hasOwnProperty.call(payload ?? {}, 'key')) return ok(keyState());
    if (typeof payload.key !== 'string') return fail('key必须是字符串');
    const key = payload.key.trim();
    saveKey(group, key);
    return ok(keyState());
  };

  const execClearKey = (payload) => {
    const { group, error: groupError } = groupParam(payload?.group);
    if (groupError) return fail(groupError);
    saveKey(group, '');
    return ok(keyState());
  };

  const execSaveConfig = (payload) => {
    const patch = payload?.patch;
    const filtered = {};
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      for (const flag of WRITABLE_FLAGS) {
        if (typeof patch[flag] === 'boolean') filtered[flag] = patch[flag];
      }
    }
    if (Object.keys(filtered).length === 0) return fail('没有可写入的开关');
    saveConfig(filtered);
    return ok({ flags: moduleFlags(), envLocked: envLockedFlags(), config: rawConfig() });
  };

  const execSaveSettings = (payload) => {
    const { patch, error } = validateSettings(payload?.settings);
    if (error) return fail(error);
    const writable = Object.keys(patch).filter((k) => SETTING_KEYS.includes(k));
    if (writable.length === 0) return fail('没有可写入的设置');
    const beforeEmbed = embedModel();
    const beforeDims = embedDims();
    saveConfig(patch);
    const vecCacheReset = embedModel() !== beforeEmbed || embedDims() !== beforeDims;
    return ok({ config: configReport(), vecCacheReset });
  };

  const buildWikiSnapshot = (store, payload = {}) => {
    const rawSpace = typeof payload?.spaceId === 'string'
      ? payload.spaceId.trim()
      : (typeof payload?.space === 'string' ? payload.space.trim() : '');
    const spaceFilter = rawSpace && rawSpace !== 'all' ? rawSpace : undefined;
    const limit = Number.isFinite(payload?.limit)
      ? Math.max(1, Math.min(200, Math.trunc(payload.limit)))
      : 100;
    const slug = typeof payload?.slug === 'string' ? payload.slug.trim() : '';

    const allPages = (typeof store.listWikiPages === 'function'
      ? store.listWikiPages({
          ...(spaceFilter ? { spaceId: spaceFilter } : {}),
          dirtyOnly: payload?.dirtyOnly === true,
          limit,
        })
      : []
    ).map((p) => ({
      ...p,
      id: p.pageId ?? p.id,
      pageId: p.pageId ?? p.id,
      summary: p.summary ?? p.markdown ?? '',
      markdown: p.summary ?? p.markdown ?? '',
    }));
    const pages = slug ? allPages.filter((p) => p.slug === slug || p.id === slug || p.pageId === slug) : allPages;
    const revCounts = readRevisionCounts(store);
    const stateRows = typeof store.byCategory === 'function'
      ? store.byCategory('state', { ...(spaceFilter ? { spaceId: spaceFilter } : {}), limit: 100 })
      : [];
    const states = stateRows.map((s) => {
      const revisionCount = revCounts.get(s.id) ?? 0;
      return {
        id: s.id,
        spaceId: s.spaceId ?? 'global',
        slotKey: s.slotKey ?? '',
        text: s.text,
        preview: previewText(s.text),
        source: s.source ? String(s.source) : '',
        updatedAt: s.updatedAt ?? s.createdAt,
        createdAt: s.createdAt,
        revisionCount,
        revisions: revisionCount > 0 && typeof store.listRevisions === 'function'
          ? store.listRevisions(s.id, { limit: 10 })
          : [],
      };
    });
    return {
      pages,
      wiki_pages: pages,
      page: slug ? (pages[0] ?? null) : null,
      total: pages.length,
      states,
      stateCount: states.length,
    };
  };

  const execForgetAction = (payload = {}) => {
    const dryRun = payload?.dryRun === true;
    const spaceId = typeof payload?.spaceId === 'string' && payload.spaceId.trim() && payload.spaceId !== 'all'
      ? payload.spaceId.trim()
      : (typeof payload?.space === 'string' && payload.space.trim() && payload.space !== 'all' ? payload.space.trim() : undefined);

    const res = runWithStore(opts, (store) => {
      if (payload?.source !== undefined && String(payload.source).trim() !== '') {
        return store.forget({ source: String(payload.source), spaceId, dryRun });
      }
      const ids = [];
      if (Array.isArray(payload?.ids)) {
        for (const id of payload.ids) if (typeof id === 'string' && id.trim()) ids.push(id.trim());
      }
      if (typeof payload?.id === 'string' && payload.id.trim()) ids.push(payload.id.trim());
      if (!ids.length && typeof payload?.query === 'string' && payload.query.trim()) {
        const lim = Math.max(1, Math.min(100, Math.trunc(Number(payload?.limit) || 10)));
        const idx = opts.getIndex
          ? opts.getIndex()
          : new SearchIndex({ store }).addAll(store.list({ status: 'active', includeText: true, ...(spaceId ? { spaceId } : {}) }));
        const found = idx.search(payload.query.trim(), {
          maxChars: 1e9,
          limit: 1e6,
          ...(spaceId ? { spaces: [spaceId] } : {}),
        });
        for (const hit of found.hits.slice(0, lim)) ids.push(hit.id);
      }
      if (!ids.length && spaceId) {
        return store.forget({ spaceId, dryRun });
      }
      if (!ids.length) return { forgotten: [], count: 0 };
      return store.forget({ ids, spaceId, dryRun });
    });

    if (!dryRun && res.count > 0) {
      opts.invalidate?.();
      opts.touchWiki?.();
    }
    return ok({ forgotten: res.forgotten, count: res.count, dryRun });
  };

  const execDemoteAction = (payload = {}) => {
    const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
    if (!id) return fail('id 必须是非空字符串');
    const res = runWithStore(opts, (store) => store.setKind(id, 'event'));
    if (!res) return ok({ found: false, id, changed: false });
    if (res.changed) {
      opts.invalidate?.();
      opts.touchWiki?.();
    }
    return ok({ found: true, ...res });
  };

  const handler = async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'status': {
          const action = typeof payload?.action === 'string' ? payload.action.trim() : '';
          const rawSpaceInput = typeof payload?.spaceId === 'string'
            ? payload.spaceId.trim()
            : (typeof payload?.space === 'string' ? payload.space.trim() : '');
          const rawSpace = normalizeRpcSpace(rawSpaceInput);
          const spaceFilter = rawSpace && rawSpace !== 'all' ? rawSpace : undefined;

          const observationScope = resolveObservationScope(payload, opts.cwd ?? process.cwd());
          const data = runWithStore(opts, (store) => {
            let compileResult = null;
            let metabolism = null;
            let reindex = null;

            if (action === 'compile' || payload?.recompile === true) {
              compileResult = typeof opts.compileWikiNow === 'function'
                ? opts.compileWikiNow({ spaceId: spaceFilter })
                : compileSpaceWikiPages(store, spaceFilter);
            } else if (action === 'metabolism') {
              const rawMeta = typeof opts.runMetabolismNow === 'function'
                ? opts.runMetabolismNow()
                : runMetabolism(store);
              metabolism = normalizeMetabolismReceipt(rawMeta);
            } else if (action === 'reindex') {
              let slotsRebuilt = 0;
              if (payload?.rebuildFacts === true && typeof store.rebuildFacts === 'function') {
                const rebuilt = store.rebuildFacts();
                slotsRebuilt = Array.isArray(rebuilt) ? rebuilt.length : 0;
              }
              opts.invalidate?.();
              opts.touchWiki?.();
              const ix = opts.getIndex
                ? opts.getIndex().stats()
                : new SearchIndex({ store }).addAll(store.list({ status: 'active', includeText: true })).stats();
              reindex = {
                reindexed: true,
                docs: ix.docs,
                terms: ix.terms,
                postings: ix.postings,
                chapters: ix.chapters,
                slotsRebuilt,
              };
            }

            const stats = store.stats();
            const facts = collectAllFactsSafe(store);
            const attrCount = new Set(facts.map((f) => f.attr).filter(Boolean)).size;
            const spaceCounts = readSpaceMemoryCounts(store);
            const spaces = typeof store.listSpaces === 'function'
              ? store.listSpaces().map((sp) => {
                  const sid = sp.spaceId ?? sp.id;
                  return {
                    ...sp,
                    id: sid,
                    spaceId: sid,
                    memoryCount: spaceCounts.get(sid) ?? 0,
                  };
                })
              : [];
            const wikiSnap = buildWikiSnapshot(store, payload);
            return {
              stats,
              observationCounts: collectObservationCounts(store, observationScope),
              attrCount,
              spaces,
              wikiSnap,
              compileResult,
              metabolism,
              reindex,
            };
          });

          const cfg = opts.config ?? {};
          const extraInject = typeof opts.getInjectStatus === 'function' ? opts.getInjectStatus() : {};
          const tierSBudget = cfg.tierSBudget ?? TIER_S_MAX_CHARS;
          const tierDBudget = cfg.tierDBudget ?? TIER_D_MAX_CHARS;

          const lt = data.stats.lTiers ?? {};
          const layers = {
            L0: Number(lt[0] ?? lt.L0 ?? 0),
            L1: Number(lt[1] ?? lt.L1 ?? 0),
            L2: Number(lt[2] ?? lt.L2 ?? 0),
            L3: Number(lt[3] ?? lt.L3 ?? 0),
          };

          // Diagnostic failures must degrade to unavailable, never fail an otherwise valid status.
          let observation = null;
          try { observation = opts.injectionObserver?.read(observationScope) ?? null; } catch { /* unavailable */ }
          const observability = buildObservabilitySnapshot({
            capturedAt: new Date().toISOString(), stats: data.stats, counts: data.observationCounts,
            config: cfg, dbPath: opts.dbPath, modules: { ...moduleFlags(),
              ...Object.fromEntries(Object.entries(cfg).filter(([, value]) => typeof value === 'boolean')),
            },
            observation, scope: observationScope,
          });

          return ok({
            observability,
            schemaVersion: data.stats.schemaVersion ?? 8,
            stats: { ...data.stats, attrCount: data.attrCount, wikiCount: data.wikiSnap.total },
            config: configReport(),
            spaces: data.spaces,
            categories: data.stats.categories ?? { rule: 0, profile: 0, decision: 0, experience: 0, state: 0 },
            kinds: data.stats.kinds ?? { person: 0, promise: 0, event: 0 },
            layers,
            wikiCount: data.wikiSnap.total,
            wiki_pages: data.wikiSnap.wiki_pages,
            pages: data.wikiSnap.pages,
            ...(data.wikiSnap.page ? { page: data.wikiSnap.page } : {}),
            states: data.wikiSnap.states,
            pendingIngestJobs: data.stats.pendingIngestJobs ?? 0,
            tierS: { budget: tierSBudget, maxChars: TIER_S_MAX_CHARS },
            tierD: { budget: tierDBudget, maxChars: TIER_D_MAX_CHARS },
            inject: {
              enabled: Boolean(cfg.autoInject),
              mode: cfg.injectMode ?? 'auto',
              tierSBudget,
              tierDBudget,
              totalBudget: TOTAL_INJECT_MAX_CHARS,
              injectBudget: cfg.injectBudget ?? TOTAL_INJECT_MAX_CHARS,
              ...extraInject,
            },
            ...(data.compileResult ? { compileResult: data.compileResult } : {}),
            ...(data.metabolism ? { metabolism: data.metabolism } : {}),
            ...(data.reindex ? { reindex: data.reindex } : {}),
          });
        }

        case 'memories': {
          const action = typeof payload?.action === 'string' ? payload.action.trim() : '';
          if (action === 'forget') return execForgetAction(payload);
          if (action === 'demote') return execDemoteAction(payload);
          if (action === 'wiki' || action === 'compile' || action === 'metabolism') {
            const rawSpace = typeof payload?.spaceId === 'string'
              ? payload.spaceId.trim()
              : (typeof payload?.space === 'string' ? payload.space.trim() : '');
            const spaceFilter = rawSpace && rawSpace !== 'all' ? rawSpace : undefined;
            const wikiRes = runWithStore(opts, (store) => {
              let compileResult = null;
              let metabolism = null;
              if (action === 'compile' || payload?.recompile === true) {
                compileResult = typeof opts.compileWikiNow === 'function'
                  ? opts.compileWikiNow({ spaceId: spaceFilter })
                  : compileSpaceWikiPages(store, spaceFilter);
              } else if (action === 'metabolism') {
                const rawMeta = typeof opts.runMetabolismNow === 'function'
                  ? opts.runMetabolismNow()
                  : runMetabolism(store);
                metabolism = normalizeMetabolismReceipt(rawMeta);
              }
              const snap = buildWikiSnapshot(store, payload);
              return {
                ...snap,
                ...(compileResult ? { compileResult } : {}),
                ...(metabolism ? { metabolism } : {}),
              };
            });
            return ok(wikiRes);
          }

          const limit = Number.isFinite(payload?.limit)
            ? Math.max(1, Math.min(500, Math.trunc(payload.limit)))
            : 120;
          const offset = Number.isFinite(payload?.offset)
            ? Math.max(0, Math.trunc(payload.offset))
            : 0;
          const order = payload?.order === 'asc' ? 'asc' : 'desc';
          const rawSpaceInput = typeof payload?.spaceId === 'string'
            ? payload.spaceId.trim()
            : (typeof payload?.space === 'string' ? payload.space.trim() : '');
          const rawSpace = normalizeRpcSpace(rawSpaceInput);
          const category = typeof payload?.category === 'string' && payload.category.trim() && payload.category !== 'all'
            ? payload.category.trim()
            : '';
          const kindFilter = typeof payload?.kind === 'string' && payload.kind.trim() && payload.kind !== 'all'
            ? payload.kind.trim()
            : '';
          const layerFilter = parseLayerFilter(payload?.layer ?? payload?.lTier);
          const statusFilter = typeof payload?.status === 'string' && payload.status.trim()
            ? payload.status.trim()
            : 'active';
          const q = typeof (payload?.q ?? payload?.query) === 'string'
            ? String(payload.q ?? payload.query).trim().toLowerCase()
            : '';
          const withRevisions = payload?.withRevisions === true;
          const wantV2RowFields = Boolean(
            payload?.v2 === true
            || payload?.detail === true
            || withRevisions
            || rawSpace
            || category
            || kindFilter
            || layerFilter !== null
            || q,
          );

          const res = runWithStore(opts, (store) => {
            // 单条按 id 精确查询详情与修订链
            if (typeof payload?.id === 'string' && payload.id.trim()) {
              const m = store.get(payload.id.trim(), true);
              if (!m) return { order, total: 0, found: false, item: null, rows: [], items: [] };
              const revisions = typeof store.listRevisions === 'function' ? store.listRevisions(m.id) : [];
              const lTier = Number.isInteger(m.lTier) ? m.lTier : (Number.isInteger(m.tier) ? m.tier : 1);
              const item = {
                id: m.id,
                spaceId: m.spaceId ?? 'global',
                category: m.category ?? 'experience',
                kind: m.kind ?? 'event',
                layer: `L${lTier}`,
                lTier,
                slotKey: m.slotKey ?? null,
                status: m.status ?? 'active',
                chapter: chapterOf(m),
                created: m.created_at ?? m.createdAt,
                accessed: m.last_accessed ?? m.lastAccessed,
                updated: m.updated_at ?? m.updatedAt ?? m.createdAt,
                importance: m.importance,
                text: previewText(m.text),
                fullText: m.text,
                source: m.source ? String(m.source) : '',
                revisionCount: revisions.length,
                revisions,
              };
              return { order, total: 1, found: true, item, rows: [item], items: [item] };
            }

            const listOpts = {
              limit: 5000,
              includeText: true,
              order,
              status: statusFilter,
              includeDeleted: statusFilter === 'all' || payload?.includeDeleted === true,
            };
            if (rawSpace && rawSpace !== 'all') {
              if (payload?.includeGlobal === true && rawSpace !== 'global') {
                listOpts.spaces = [rawSpace, 'global'];
              } else {
                listOpts.spaceId = rawSpace;
              }
            }
            if (category) listOpts.category = category;

            let matched = store.list(listOpts);
            if (kindFilter) matched = matched.filter((r) => r.kind === kindFilter);
            if (layerFilter !== null) {
              matched = matched.filter((r) => {
                const lt = Number.isInteger(r.lTier) ? r.lTier : (Number.isInteger(r.tier) ? r.tier : 1);
                return lt === layerFilter;
              });
            }
            if (q) {
              matched = matched.filter((r) => (
                String(r.text ?? '').toLowerCase().includes(q)
                || String(r.slotKey ?? '').toLowerCase().includes(q)
                || String(r.source ?? '').toLowerCase().includes(q)
                || String(r.id ?? '').toLowerCase().includes(q)
              ));
            }

            const total = matched.length;
            const sliced = matched.slice(offset, offset + limit);
            const revCounts = readRevisionCounts(store);

            const items = sliced.map((r) => {
              const lTier = Number.isInteger(r.lTier) ? r.lTier : (Number.isInteger(r.tier) ? r.tier : 1);
              const revCount = revCounts.get(r.id) ?? 0;
              const v2Item = {
                id: r.id,
                spaceId: r.spaceId ?? 'global',
                category: r.category ?? 'experience',
                kind: r.kind ?? 'event',
                layer: `L${lTier}`,
                lTier,
                slotKey: r.slotKey ?? null,
                revisionCount: revCount,
                chapter: chapterOf(r),
                created: r.created_at ?? r.createdAt,
                accessed: r.last_accessed ?? r.lastAccessed,
                importance: r.importance,
                text: previewText(r.text),
                source: r.source ? String(r.source) : '',
              };
              if ((withRevisions || revCount > 0) && typeof store.listRevisions === 'function') {
                v2Item.revisions = revCount > 0 ? store.listRevisions(r.id) : [];
              }
              return v2Item;
            });

            const rows = wantV2RowFields
              ? items
              : sliced.map((r) => ({
                  id: r.id,
                  chapter: chapterOf(r),
                  created: r.created_at ?? r.createdAt,
                  accessed: r.last_accessed ?? r.lastAccessed,
                  importance: r.importance,
                  text: previewText(r.text),
                  source: r.source ? String(r.source) : '',
                }));

            return {
              order,
              total,
              rows,
              items,
            };
          });
          return ok(res);
        }

        case 'conflicts': {
          const conflicts = runWithStore(opts, (store) => collectConflicts(store, payload));
          const byType = { supersession: 0, conditional: 0, disputed: 0 };
          for (const c of conflicts) {
            if (c.conflictType in byType) byType[c.conflictType] += 1;
          }
          return ok({ conflicts, total: conflicts.length, byType });
        }

        case 'saveKey':
          return execSaveKey(payload);

        case 'clearKey':
          return execClearKey(payload);

        case 'saveConfig': {
          if (payload?.action === 'reindex') {
            const reindexed = runWithStore(opts, (store) => {
              let slotsRebuilt = 0;
              if (payload?.rebuildFacts === true && typeof store.rebuildFacts === 'function') {
                const rebuilt = store.rebuildFacts();
                slotsRebuilt = Array.isArray(rebuilt) ? rebuilt.length : 0;
              }
              opts.invalidate?.();
              opts.touchWiki?.();
              const ix = opts.getIndex
                ? opts.getIndex().stats()
                : new SearchIndex({ store }).addAll(store.list({ status: 'active', includeText: true })).stats();
              return { reindexed: true, ...ix, slotsRebuilt };
            });
            return ok({ flags: moduleFlags(), envLocked: envLockedFlags(), config: rawConfig(), reindex: reindexed });
          }
          return execSaveConfig(payload);
        }

        case 'saveSettings':
          return execSaveSettings(payload);

        case 'testKey': {
          const { group, error: groupError } = groupParam(payload?.group);
          if (groupError) return fail(groupError);
          if (!groupReport(group).enabled) return fail('该组已禁用', 'disabled');
          const supplied = Object.prototype.hasOwnProperty.call(payload ?? {}, 'key');
          if (supplied && typeof payload.key !== 'string') return fail('key必须是字符串');
          const key = supplied ? payload.key.trim() : GROUP_KEY[group]();
          if (!key) return fail(`未配置密钥（${group} 组）`, 'missing-key');
          const report = groupReport(group);
          if (!report.baseUrl || !report.model) return fail('端点或模型为空', 'incomplete-config');
          return ok(await testKey(group, key, opts.fetchImpl || fetch));
        }

        default:
          return fail(`未知端点 ${endpoint}`);
      }
    } catch (err) {
      if (endpoint === 'testKey') return fail('密钥测试失败', 'internal-error');
      return fail(err?.message ?? String(err));
    }
  };

  const conn = (ctx?.get && ctx.get('connection'))
    || (() => { try { return ctx?.connection; } catch { return null; } })();
  if (typeof conn?.fetch?.register !== 'function') {
    console.log('[memjudge] connection.fetch.register 不可用，面板不可用');
    return () => {};
  }

  const ownerKey = ctx && typeof ctx === 'object' ? ctx : null;
  const seen = ownerKey ? (REGISTERED_PATHS.get(ownerKey) ?? new Set()) : new Set();
  if (ownerKey) REGISTERED_PATHS.set(ownerKey, seen);

  const disposers = [];
  for (const endpoint of RPC_ENDPOINTS) {
    const routePath = `${FETCH_ROUTE_PREFIX}${endpoint}`;
    if (seen.has(routePath)) continue;
    try {
      const dispose = conn.fetch.register({
        path: routePath,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const payload = await request.json().catch(() => ({}));
          return jsonResponse(await handler(endpoint, payload ?? {}));
        },
      });
      seen.add(routePath);
      disposers.push(() => {
        seen.delete(routePath);
        if (typeof dispose === 'function') dispose();
      });
    } catch {
      // 单条失败不阻断其余端点
    }
  }

  if (disposers.length === 0) return () => {};
  return () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      try {
        disposers[i]();
      } catch { /* 卸载幂等 */ }
    }
  };
}

export default { installMemjudgeRpc, RPC_ENDPOINTS, validateSettings, testKey, probeSpec, keyState };
