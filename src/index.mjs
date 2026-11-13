// dsh-memjudge 宿主插件入口（v2 终态架构）
//
// 核心接线：
//   1. 8 个 Agent 工具（memjudge_remember / recall / read / forget / demote / conflicts / stats / wiki）
//   2. 双边闭合轮采集（ctx.inject(['sessions']) 优先 + ctx.on('session/event') 回退，拦截子代理，TurnCollector -> Distiller）
//   3. 保 Prefix KV Cache 两段式动态注入（Tier-S <= 600 chars 单会话冻结热底座 + Tier-D <= 900 chars 按问动态召回，总计 <= 1500 chars）
//   4. L0-L3 四级热冷代谢与增量 Wiki 编译调度（lifecycle.mjs + 卸载时 100% 优雅排空释放）
//   5. 同进程只读服务（service.mjs）与可视化面板 RPC（rpc.mjs）

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import storeMod from './store.mjs';
import {
  SearchIndex,
  hybridSearch,
  matchEntitySlots,
  rrfFuse,
} from './search.mjs';
import {
  gate,
  gateSlots,
  classifyConflict,
  resolveConflict,
} from './judge.mjs';
import {
  MEMORY_KINDS,
  MEMORY_CATEGORIES,
  STORE_SCHEMA_VERSION,
  kindToCategory,
  categoryToKind,
  normalizeCategory,
} from './schema.mjs';
import { sleepPhase } from './layer.mjs';
import {
  compileDirtyWikiPages,
  buildWikiPage,
  deriveClusterSlug,
  runMetabolism,
} from './lifecycle.mjs';
import {
  GLOBAL_SPACE_ID,
  isSubagentSession,
  resolveScope,
  visibleSpaces,
} from './scope.mjs';
import {
  TIER_S_MAX_CHARS,
  TIER_D_MAX_CHARS,
  TOTAL_INJECT_MAX_CHARS,
  createInjector,
} from './inject.mjs';
export {
  TIER_S_MAX_CHARS,
  TIER_D_MAX_CHARS,
  TOTAL_INJECT_MAX_CHARS,
};
import { createTurnCollector } from './turn-collector.mjs';
import { processIngestQueue } from './distiller.mjs';
import { expand as defaultExpand } from './query-expand.mjs';
import { rerank as defaultRerank } from './rerank.mjs';
import { embed as defaultEmbed, quantize, dequantize } from './vector.mjs';
import { select as defaultSelect } from './llm-select.mjs';
import {
  STATE_DIR,
  moduleFlags as defaultModuleFlags,
  embedDims as defaultEmbedDims,
  configReport as defaultConfigReport,
  maxChars as configuredMaxChars,
  storageLimitBytes as configuredStorageLimitBytes,
  autoCaptureConfig,
} from './config.mjs';
import { installMemjudgeRpc as defaultInstallRpc } from './rpc.mjs';
import { createService, SERVICE_NAME } from './service.mjs';

export const name = 'memjudge';
export const inject = ['tools', 'systemPrompt', 'connection'];

export const SECTION_NAME = 'memjudge:recall';
export const CONTEXT_NAME = 'memjudge:context';
export const SECTION_ORDER = 700;

export const INJECT_HARD_LIMIT = 2000;
export const INJECT_SEGMENTS = Object.freeze([
  Object.freeze({ kind: 'person', header: '人：', share: 0.25, cap: 500 }),
  Object.freeze({ kind: 'promise', header: '约：', share: 0.25, cap: 500 }),
  Object.freeze({ kind: 'event', header: '事：', share: 0.50, cap: 1000 }),
]);
export const INJECT_SEG_MAX_ROWS = 40;

export const TOOL_NAMES = Object.freeze([
  'memjudge_remember',
  'memjudge_recall',
  'memjudge_read',
  'memjudge_forget',
  'memjudge_demote',
  'memjudge_conflicts',
  'memjudge_stats',
  'memjudge_wiki',
]);

export const DEFAULTS = Object.freeze({
  dbPath: null,
  autoInject: false,
  injectMode: 'auto', // 'auto' | 'tiered' | 'legacy'
  tierSBudget: TIER_S_MAX_CHARS,
  tierDBudget: TIER_D_MAX_CHARS,
  injectBudget: INJECT_HARD_LIMIT,
  injectLimit: 12,
  autoCapture: true,
  metabolismIntervalMs: 0,
  experimentalInjectMode: 'legacy',
  experimentalInjectHalfLifeDays: 30,
  experimentalInjectFloor: 0.1,
  decayMode: 'dual',
  halfLifeDays: 30,
  decayFloor: 0,
  touchOnRecall: true,
  vector: undefined,
  rerank: undefined,
  expand: undefined,
  llmSelect: undefined,
});

export function defaultDbPath() {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(base, 'memjudge', 'memjudge.db');
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function resolveConfig(raw = {}, { defaultDbPathFn = defaultDbPath } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const dbPath = typeof src.dbPath === 'string' && src.dbPath.trim()
    ? src.dbPath.trim()
    : defaultDbPathFn();

  const autoInject = src.autoInject === true;
  const rawInjectMode = src.injectMode ?? DEFAULTS.injectMode;
  if (rawInjectMode !== 'auto' && rawInjectMode !== 'tiered' && rawInjectMode !== 'legacy') {
    throw new TypeError(`memjudge: injectMode 必须是 auto / tiered / legacy，收到 ${String(rawInjectMode)}`);
  }

  const tierSBudget = clampInt(src.tierSBudget, 100, TIER_S_MAX_CHARS, DEFAULTS.tierSBudget);
  const tierDBudget = clampInt(src.tierDBudget, 100, TIER_D_MAX_CHARS, DEFAULTS.tierDBudget);
  const injectBudget = clampInt(src.injectBudget, 1, INJECT_HARD_LIMIT, DEFAULTS.injectBudget);
  const injectLimit = clampInt(src.injectLimit, 1, 100, DEFAULTS.injectLimit);

  const expMode = src.experimentalInjectMode ?? DEFAULTS.experimentalInjectMode;
  if (expMode !== 'legacy' && expMode !== 'daily') {
    throw new TypeError(
      `memjudge: experimentalInjectMode 必须是 "legacy" 或 "daily"，收到 ${JSON.stringify(expMode)}`,
    );
  }
  const rawExpHalfLife = src.experimentalInjectHalfLifeDays ?? DEFAULTS.experimentalInjectHalfLifeDays;
  if (typeof rawExpHalfLife !== 'number' || !Number.isFinite(rawExpHalfLife) || rawExpHalfLife < 0.5 || rawExpHalfLife > 3650) {
    throw new TypeError(
      `memjudge: experimentalInjectHalfLifeDays 必须是 [0.5, 3650] 内的有限数，收到 ${JSON.stringify(rawExpHalfLife)}`,
    );
  }
  const rawExpFloor = src.experimentalInjectFloor ?? DEFAULTS.experimentalInjectFloor;
  if (typeof rawExpFloor !== 'number' || !Number.isFinite(rawExpFloor) || rawExpFloor < 0 || rawExpFloor > 1) {
    throw new TypeError(
      `memjudge: experimentalInjectFloor 必须是 [0, 1] 内的有限数，收到 ${JSON.stringify(rawExpFloor)}`,
    );
  }

  const decayMode = Object.prototype.hasOwnProperty.call(src, 'decayMode')
    ? src.decayMode
    : DEFAULTS.decayMode;
  if (decayMode !== 'dual' && decayMode !== 'uniform') {
    throw new TypeError(
      `memjudge: decayMode 必须是 "dual" 或 "uniform"，收到 ${JSON.stringify(decayMode)}`,
    );
  }
  let halfLifeDays;
  if (decayMode === 'uniform') {
    const rawHalfLife = Object.prototype.hasOwnProperty.call(src, 'halfLifeDays')
      ? src.halfLifeDays
      : DEFAULTS.halfLifeDays;
    if (typeof rawHalfLife !== 'number' || !Number.isFinite(rawHalfLife) || rawHalfLife < 0.5 || rawHalfLife > 3650) {
      throw new TypeError(
        `memjudge: halfLifeDays 在 decayMode="uniform" 下必须是 [0.5, 3650] 内的有限数，收到 ${JSON.stringify(rawHalfLife)}`,
      );
    }
    halfLifeDays = rawHalfLife;
  } else {
    halfLifeDays = clampNum(src.halfLifeDays, 0.5, 3650, DEFAULTS.halfLifeDays);
  }

  const autoCapDefault = autoCaptureConfig();
  const autoCapture = typeof src.autoCapture === 'boolean'
    ? src.autoCapture
    : Boolean(autoCapDefault.enabled ?? autoCapDefault.autoCapture);

  const metabolismIntervalMs = src.metabolismIntervalMs === undefined
    ? DEFAULTS.metabolismIntervalMs
    : clampInt(src.metabolismIntervalMs, 0, 24 * 3600 * 1000, DEFAULTS.metabolismIntervalMs);

  return {
    dbPath,
    autoInject,
    injectMode: rawInjectMode,
    tierSBudget,
    tierDBudget,
    injectBudget,
    injectLimit,
    autoCapture,
    metabolismIntervalMs,
    experimentalInjectMode: expMode,
    experimentalInjectHalfLifeDays: rawExpHalfLife,
    experimentalInjectFloor: rawExpFloor,
    decayMode,
    halfLifeDays,
    decayFloor: clampNum(src.decayFloor, 0, 1, DEFAULTS.decayFloor),
    touchOnRecall: Boolean(src.touchOnRecall ?? DEFAULTS.touchOnRecall),
    vector: src.vector,
    rerank: src.rerank,
    expand: src.expand,
    llmSelect: src.llmSelect,
    storageLimitBytes: src.storageLimitBytes,
    now: typeof src.now === 'function' ? src.now : null,
  };
}

function getRawDb(store) {
  if (!store?.raw) return null;
  return typeof store.raw === 'function' ? store.raw() : store.raw;
}

function chapterOf(m) {
  if (Number.isInteger(m?.chapter) && m.chapter > 0) {
    const out = {
      chapter: m.chapter,
      para: Number.isInteger(m?.para) ? m.para : 0,
    };
    if (typeof m?.documentId === 'string' && m.documentId) out.documentId = m.documentId;
    return out;
  }
  if (typeof m?.source === 'string' && m.source.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(m.source);
      if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.chapter) && parsed.chapter > 0) {
        const out = {
          chapter: parsed.chapter,
          para: Number.isInteger(parsed.para) ? parsed.para : 0,
        };
        if (typeof parsed.documentId === 'string' && parsed.documentId) out.documentId = parsed.documentId;
        return out;
      }
    } catch {
      // 非章段 JSON，走 id 兜底
    }
  }
  const hit = /^mem-c(\d+)-p(\d+)-/.exec(String(m?.id ?? ''));
  if (hit) {
    const ch = Number(hit[1]);
    const p = Number(hit[2]);
    if (ch > 0 || p > 0) return { chapter: ch, para: p };
  }
  return { chapter: 0, para: 0 };
}

export function toDoc(m) {
  const src = chapterOf(m);
  const category = m.category ?? kindToCategory(m.kind);
  const kind = m.kind ?? categoryToKind(category);
  const tier = Number.isInteger(m.tier) ? m.tier : (kind === 'event' ? 3 : 1);
  return {
    id: m.id,
    spaceId: m.spaceId ?? GLOBAL_SPACE_ID,
    category,
    kind,
    tier,
    lTier: Number.isInteger(m.lTier) ? m.lTier : 1,
    slotKey: m.slotKey ?? null,
    text: m.text,
    source: src,
    rawSource: m.source ?? null,
    chapter: src.chapter || (Number.isFinite(m.chapter) ? m.chapter : 0),
    para: src.para || (Number.isFinite(m.para) ? m.para : 0),
    importance: m.importance ?? 0,
    accessCount: m.accessCount ?? m.access_count ?? 0,
    lastAccessed: m.lastAccessed ?? m.last_accessed ?? m.createdAt ?? m.created_at ?? 0,
    createdAt: m.createdAt ?? m.created_at ?? 0,
  };
}

/**
 * 证据门硬拒判定：gate()/gateSlots() 一旦给出 deny=true，除确认可放行的理由外一律硬拒。
 * 白名单只保留「已验证可放行」的两个理由，其余理由由证据门自行扩充即可生效——
 * 不再逐一枚举拒绝理由，避免产出集合与判定集合漂移导致判定恒 false。
 */
export function isHardDeny(v) {
  if (!v?.deny) return false;
  if (v.reason === 'hit' || v.reason === 'explain-question') return false;
  return true;
}

/**
 * recall 证据门的最终裁决：bodyVerdict（片段窗口核验）与 slotGate（槽位索引核验）谁说了算。
 * - 片段核验放行即放行：槽位图只是结构化投影，抽不出槽位不等于事实不存在，
 *   让槽位门单方面否决会把「文本里明明写着、只是没抽成槽位」的整类召回拒死；
 * - 片段核验要拒时，只有槽位门给出「肯定命中」才豁免，用来抵住文本窗口截断造成的误拒。
 */
export function shouldDenyRecall(bodyVerdict, slotGate) {
  if (!isHardDeny(bodyVerdict)) return false;
  const slotExplicitlyAffirmed = Boolean(
    slotGate
    && slotGate.deny === false
    && slotGate.reason === 'hit'
    && (slotGate.hits?.length ?? 0) > 0,
  );
  return !slotExplicitlyAffirmed;
}

function textBlock(text) {
  return [{ type: 'text', text }];
}

const SURROGATE_RE = /[\uD800-\uDFFF]/;
function sanitizeWellFormed(str) {
  const s = String(str ?? '');
  if (!SURROGATE_RE.test(s)) return s;
  return typeof s.toWellFormed === 'function'
    ? s.toWellFormed()
    : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

function inlineText(text, max = 80) {
  const clean = sanitizeWellFormed(String(text ?? '').replace(/\s+/g, ' ').trim());
  if (clean.length <= max) return clean;
  let cut = max - 1;
  const hi = clean.charCodeAt(cut - 1);
  if (hi >= 0xD800 && hi <= 0xDBFF) cut -= 1;
  return `${clean.slice(0, cut)}…`;
}

function sourceLabel(rawSource) {
  const s = typeof rawSource === 'string' ? rawSource.trim() : '';
  if (!s) return '';
  if (s.startsWith('auto:')) return '自动采集';
  if (s.startsWith('turn:')) return '双边脱水';
  return inlineText(s, 24);
}

function extractPlainTextFromBlocks(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

function isRuntimeSnapshotMessage(msg) {
  const src = msg?.source;
  return Boolean(src && typeof src === 'object' && src.kind === 'runtime-context');
}

function extractLatestUserQueryFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user' || isRuntimeSnapshotMessage(m)) continue;
    const txt = extractPlainTextFromBlocks(m.content);
    if (txt) return txt;
  }
  return '';
}

function extractQueryFromPromptContext(promptCtx, pendingQueries) {
  if (!promptCtx || typeof promptCtx !== 'object') return { query: '', isToolSubstep: false };
  if (typeof promptCtx.query === 'string' && promptCtx.query.trim()) {
    return { query: promptCtx.query.trim(), isToolSubstep: Boolean(promptCtx.isToolSubstep) };
  }
  const session = promptCtx.session ?? promptCtx.agent?.session ?? null;
  const sessionId = session?.id ?? promptCtx.sessionId ?? null;
  if (sessionId && pendingQueries.has(sessionId)) {
    const pq = pendingQueries.get(sessionId);
    return { query: pq.query, isToolSubstep: pq.isToolSubstep };
  }
  if (Array.isArray(promptCtx.messages) && promptCtx.messages.length > 0) {
    const last = promptCtx.messages[promptCtx.messages.length - 1];
    const isToolSubstep = Boolean(last && last.role === 'tool');
    return {
      query: isToolSubstep ? '' : extractLatestUserQueryFromMessages(promptCtx.messages),
      isToolSubstep,
    };
  }
  const log = session?.log;
  if (Array.isArray(log) && log.length > 0) {
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const ev = log[i];
      if (!ev) continue;
      if (ev.type === 'tool/result') {
        return { query: '', isToolSubstep: true };
      }
      if (ev.type === 'user/message') {
        if (isRuntimeSnapshotMessage(ev.message)) continue;
        return { query: extractPlainTextFromBlocks(ev.message?.content), isToolSubstep: false };
      }
      if (ev.type === 'turn/end') break;
    }
  }
  return { query: '', isToolSubstep: false };
}

export function apply(ctx, config = {}, dependencies = {}) {
  const deps = {
    storeFactory: dependencies.storeFactory ?? ((file, opts) => storeMod.open(file, opts)),
    maxChars: dependencies.maxChars ?? configuredMaxChars,
    storageLimitBytes: dependencies.storageLimitBytes ?? configuredStorageLimitBytes,
    installRpc: dependencies.installRpc ?? defaultInstallRpc,
    defaultDbPath: dependencies.defaultDbPath ?? defaultDbPath,
    configReport: dependencies.configReport ?? defaultConfigReport,
    moduleFlags: dependencies.moduleFlags ?? defaultModuleFlags,
    embedDims: dependencies.embedDims ?? defaultEmbedDims,
    expand: dependencies.expand ?? defaultExpand,
    rerank: dependencies.rerank ?? defaultRerank,
    embed: dependencies.embed ?? defaultEmbed,
    select: dependencies.select ?? defaultSelect,
    extractHybrid: dependencies.extractHybrid ?? null,
  };

  const cfg = resolveConfig(config, { defaultDbPathFn: deps.defaultDbPath });
  const decayOptions = {
    halfLifeDays: cfg.decayMode === 'uniform' ? cfg.halfLifeDays : null,
    decayFloor: cfg.decayFloor,
  };
  const now = cfg.now ?? dependencies.now ?? (() => Date.now());
  const dbPath = cfg.dbPath;

  let fault = null;
  let store = null;
  let index = null;
  let indexBuiltForGen = -1;
  let contentGeneration = 0;

  const enterFault = (cause) => {
    if (!fault) {
      fault = new Error(`memjudge store unavailable: ${cause?.message ?? cause}`, { cause });
    }
    index = null;
    return fault;
  };

  const assertHealthy = () => {
    if (disposed) throw new Error('memjudge plugin disposed');
    if (fault) throw fault;
  };

  const limitBytes = cfg.storageLimitBytes === undefined
    ? deps.storageLimitBytes()
    : cfg.storageLimitBytes;

  store = deps.storeFactory(dbPath, {
    now,
    decayMode: cfg.decayMode,
    halfLifeDays: cfg.halfLifeDays,
    maxChars: deps.maxChars(),
    storageLimitBytes: limitBytes,
    ...(limitBytes === undefined ? {} : { limitBytes }),
    onFault: (cause) => enterFault(cause),
  });

  const disposers = [];
  const track = (d) => { if (typeof d === 'function') disposers.push(d); };
  let disposed = false;
  let disposeResult;
  let ingestTask = null;
  const lifetime = new AbortController();
  let metabolismTimer = null;
  let ingestTimer = null;
  const turnCollectors = new Map();
  const pendingQueries = new Map();
  const registeredSpaces = new Set([GLOBAL_SPACE_ID]);

  const ensureSpaceRegistered = (scopeInfo) => {
    if (!scopeInfo || !scopeInfo.spaceId || registeredSpaces.has(scopeInfo.spaceId)) return;
    if (scopeInfo.spaceId === GLOBAL_SPACE_ID) {
      registeredSpaces.add(GLOBAL_SPACE_ID);
      return;
    }
    if (typeof store.upsertSpace === 'function') {
      try {
        store.upsertSpace({
          spaceId: scopeInfo.spaceId,
          kind: scopeInfo.kind || 'workspace',
          rootPath: scopeInfo.rootPath ?? scopeInfo.workspaceRoot ?? scopeInfo.cwd ?? null,
          label: scopeInfo.label || scopeInfo.spaceId,
        });
        registeredSpaces.add(scopeInfo.spaceId);
      } catch (err) {
        // fail-open：只读库或最小测试桩等场景不阻断会话，但必须留痕以便定位空间登记失败
        console.warn(`[memjudge] 空间登记失败 spaceId=${scopeInfo.spaceId}: ${err?.message ?? err}`);
      }
    }
  };

  const flushUnclosedTurnsToQueue = () => {
    for (const [, entry] of turnCollectors.entries()) {
      try {
        if (entry.hasInput) {
          entry.collector.closeTurn({ now: now() });
        }
      } catch {
        // fail-open
      }
    }
    turnCollectors.clear();
  };

  const dispose = () => {
    if (disposed) return disposeResult;
    disposed = true;
    lifetime.abort();
    if (metabolismTimer) {
      clearInterval(metabolismTimer);
      metabolismTimer = null;
    }
    if (ingestTimer) {
      clearTimeout(ingestTimer);
      ingestTimer = null;
    }
    flushUnclosedTurnsToQueue();
    pendingQueries.clear();
    while (disposers.length) {
      const fn = disposers.pop();
      try { fn(); } catch { /* ignore */ }
    }
    const close = () => { try { store?.close?.(); } catch { /* ignore */ } };
    // Cordis may await this Promise; even a non-awaiting host cannot close early.
    // Preserve synchronous disposal for idle callers and the same Promise for retries.
    if (ingestTask) disposeResult = ingestTask.then(close, close);
    else close();
    return disposeResult;
  };

  try {
    const vecCache = new Map();
    const rerankCache = new Map();
    const expandCache = new Map();
    const selectCache = new Map();
    const recallCache = new Map();
    let vecCacheModelKey = '';

    const getStoreDataGen = () => (typeof store.dataGeneration === 'function' ? store.dataGeneration() : contentGeneration);

    const getIndex = () => {
      assertHealthy();
      const curGen = getStoreDataGen();
      if (index && indexBuiltForGen === curGen) return index;
      const rows = typeof store.list === 'function'
        ? store.list({ status: 'active', includeText: true, limit: 100000 })
        : store.dump();
      const built = new SearchIndex({
        now: () => now(),
        ...decayOptions,
        store,
      }).addAll(rows.map(toDoc));
      for (const [id, vec] of vecCache) built.setVector(id, vec);
      index = built;
      indexBuiltForGen = curGen;
      return index;
    };

    const bumpContentGeneration = () => {
      contentGeneration += 1;
      index = null;
      recallCache.clear();
    };

    const invalidate = () => {
      index = null;
      recallCache.clear();
    };

    const wikiRuntime = { compiles: 0, skipped: 0, lastSignature: '', pageCount: 0 };
    const touchWiki = () => { wikiRuntime.lastSignature = ''; };

    function getWikiStatusString() {
      const pages = typeof store.listWikiPages === 'function'
        ? store.listWikiPages({ limit: 10000 })
        : [];
      const dirtyCount = pages.filter((p) => p.dirty).length;
      const sig = `${getStoreDataGen()}:${pages.length}:${dirtyCount}`;
      if (sig === wikiRuntime.lastSignature && wikiRuntime.compiles > 0) {
        wikiRuntime.skipped += 1;
      } else {
        wikiRuntime.compiles += 1;
        wikiRuntime.lastSignature = sig;
      }
      wikiRuntime.pageCount = pages.length;
      return `v${STORE_SCHEMA_VERSION} 持久化 ${pages.length} 页（待重编 ${dirtyCount} 页）/ 检查 ${wikiRuntime.compiles} 次，命中跳过 ${wikiRuntime.skipped} 次`;
    }

    function compileWikiNow({ spaceId } = {}) {
      if (typeof store.listWikiPages !== 'function') {
        return { compiled: 0, dirtyCompiled: 0, seeded: 0 };
      }
      const ts = now();
      const dirtyRes = compileDirtyWikiPages(store, {
        ...(spaceId && spaceId !== 'all' ? { spaceId } : {}),
        now: ts,
      });
      const listOpts = { status: 'active', includeText: true, limit: 2000 };
      if (spaceId && spaceId !== 'all') listOpts.spaceId = spaceId;
      const activeMems = store.list(listOpts);
      const groups = new Map();
      for (const m of activeMems) {
        if (m.category === 'rule' || m.category === 'profile') continue;
        const sp = m.spaceId ?? GLOBAL_SPACE_ID;
        const slug = deriveClusterSlug(m);
        const gKey = `${sp}::${slug}`;
        if (!groups.has(gKey)) groups.set(gKey, { spaceId: sp, slug, mems: [] });
        groups.get(gKey).mems.push(m);
      }
      const existing = new Set(
        store.listWikiPages({ limit: 10000 }).map((p) => `${p.spaceId}::${p.slug}`),
      );
      let seeded = 0;
      for (const [gKey, grp] of groups.entries()) {
        if (existing.has(gKey) || grp.mems.length === 0) continue;
        buildWikiPage(store, {
          spaceId: grp.spaceId,
          slug: grp.slug,
          memories: grp.mems,
          now: ts,
        });
        seeded += 1;
      }
      touchWiki();
      const dirtyCount = Array.isArray(dirtyRes) ? dirtyRes.length : Number(dirtyRes?.compiled ?? 0);
      return {
        compiled: dirtyCount + seeded,
        dirtyCompiled: dirtyCount,
        seeded,
      };
    }

    function runMetabolismNow(opts = {}) {
      if (disposed || fault) return null;
      try {
        const res = runMetabolism(store, { now: now(), ...opts });
        const act = res?.actions ?? {};
        if (
          (act.l3Archived ?? 0) > 0
          || (act.wikiPagesUpdated ?? 0) > 0
          || (act.l1DemotedToL2 ?? 0) > 0
          || (act.compacted ?? 0) > 0
          || Boolean(act.vacuumed)
        ) {
          bumpContentGeneration();
          touchWiki();
        }
        return res;
      } catch {
        return null;
      }
    }

    // -------------------------------------------------------------- 异步脱水队列消费与周期代谢

    function drainIngestQueue(limit = 16) {
      if (disposed || fault || ingestTask || typeof store.claimIngestJobs !== 'function') {
        return { processed: 0, written: 0 };
      }
      ingestTask = (async () => {
      try {
        const flags = deps.moduleFlags();
        const report = deps.configReport();
        const llmEnabled = Boolean(flags.llmExtract && report.hasKey);
        const res = await processIngestQueue({
          store,
          limit,
          now: now(),
          signal: lifetime.signal,
          llmOpts: { enabled: llmEnabled, signal: lifetime.signal },
        });
        if (!disposed && (res.saved ?? res.written ?? 0) > 0) {
          bumpContentGeneration();
          touchWiki();
        }
        if (!disposed && res.processed >= limit) scheduleIngestDrain();
        return res;
      } catch {
        return { processed: 0, written: 0 };
      }
      })().finally(() => {
        ingestTask = null;
        // Continue full batches; also revisit expired crash leases without stealing
        // a possibly live worker's claim on activation. Timer never keeps host alive.
        if (!disposed) scheduleIngestDrain(300_000);
      });
      return ingestTask;
    }

    function scheduleIngestDrain(delayMs = 0) {
      if (disposed || ingestTimer) return;
      ingestTimer = setTimeout(() => {
        ingestTimer = null;
        void drainIngestQueue();
      }, delayMs);
      if (typeof ingestTimer.unref === 'function') ingestTimer.unref();
    }

    if (cfg.metabolismIntervalMs > 0) {
      metabolismTimer = setInterval(() => {
        runMetabolismNow();
      }, cfg.metabolismIntervalMs);
      if (typeof metabolismTimer.unref === 'function') metabolismTimer.unref();
    }

    // -------------------------------------------------------------- 保 Prefix KV Cache 两段式注入器

    const injector = createInjector({
      store,
      tierSMaxChars: cfg.tierSBudget,
      tierDMaxChars: cfg.tierDBudget,
      totalMaxChars: Math.min(TOTAL_INJECT_MAX_CHARS, cfg.injectBudget),
      now: () => now(),
      ...decayOptions,
    });
    track(() => injector.dispose());
    // Resume persisted pending work on every activation (stale processing leases
    // retain the existing 5-minute claim timeout to avoid stealing a live worker).
    scheduleIngestDrain();

    // -------------------------------------------------------------- 双边闭合轮采集与宿主会话总线接线

    function getOrCreateCollector(session, turnOverride) {
      const sessionId = session?.id ?? 'default';
      const header = session?.header ?? session ?? {};
      const scopeInfo = resolveScope({ session, header, cwd: header.cwd });
      ensureSpaceRegistered(scopeInfo);
      const cur = turnCollectors.get(sessionId);
      const turnNo = Number.isInteger(turnOverride) ? turnOverride : (cur ? cur.turnNo : 0);
      if (cur && cur.turnNo === turnNo) return cur;

      const entry = {
        sessionId,
        spaceId: scopeInfo.spaceId,
        turnNo,
        origin: header.origin ?? 'user',
        hasInput: false,
        collector: createTurnCollector({
          store,
          spaceId: scopeInfo.spaceId,
          sessionId,
          turnNo,
          origin: header.origin ?? 'user',
        }),
      };
      turnCollectors.set(sessionId, entry);
      return entry;
    }

    function handleSessionEvent(session, event) {
      if (disposed || fault || !event || typeof event !== 'object') return;
      const sessionId = session?.id ?? event.sessionId ?? 'default';
      const header = session?.header ?? session ?? {};

      if (event.type === 'compaction/end') {
        injector.onCompaction(sessionId);
        return;
      }
      if (event.type === 'session/end' || event.type === 'session/dispose') {
        injector.onSessionEnd(sessionId);
        pendingQueries.delete(sessionId);
        const pendingTurn = turnCollectors.get(sessionId);
        if (pendingTurn && pendingTurn.hasInput) {
          try { pendingTurn.collector.closeTurn({ now: now() }); } catch { /* ignore */ }
          scheduleIngestDrain(0);
        }
        turnCollectors.delete(sessionId);
        return;
      }

      if (!cfg.autoCapture) return;
      if (isSubagentSession(session) || isSubagentSession(header)) return;

      const evTurn = Number.isInteger(event.turn) ? event.turn : undefined;

      switch (event.type) {
        case 'turn/start': {
          const prev = turnCollectors.get(sessionId);
          if (prev && prev.hasInput && evTurn !== undefined && prev.turnNo !== evTurn) {
            try { prev.collector.closeTurn({ now: now() }); } catch { /* ignore */ }
            turnCollectors.delete(sessionId);
            scheduleIngestDrain(0);
          }
          getOrCreateCollector(session, evTurn ?? ((prev?.turnNo ?? -1) + 1));
          break;
        }

        case 'user/message': {
          if (isRuntimeSnapshotMessage(event.message)) return;
          const text = extractPlainTextFromBlocks(event.message?.content ?? event.text ?? '');
          if (!text) return;
          if (isSubagentSession(header, text)) return;
          pendingQueries.set(sessionId, { query: text, isToolSubstep: false });
          const entry = getOrCreateCollector(session, evTurn);
          entry.collector.recordUser(text);
          entry.hasInput = true;
          break;
        }

        case 'assistant/message': {
          const text = extractPlainTextFromBlocks(event.message?.content ?? event.text ?? '');
          if (!text) return;
          const entry = getOrCreateCollector(session, evTurn);
          entry.collector.recordAssistant(text);
          entry.hasInput = true;
          break;
        }

        case 'tool/result': {
          const toolName = event.toolName ?? event.name ?? event.call?.name ?? 'tool';
          if (typeof toolName === 'string' && toolName.startsWith('memjudge_')) return;
          pendingQueries.set(sessionId, { query: '', isToolSubstep: true });
          const isErr = Boolean(event.isError || event.status === 'error' || event.error);
          const outText = extractPlainTextFromBlocks(event.result?.content ?? event.output ?? event.error ?? '');
          const entry = getOrCreateCollector(session, evTurn);
          entry.collector.recordTool({
            tool: String(toolName),
            ok: !isErr,
            summary: outText || (isErr ? 'failed' : 'ok'),
          });
          entry.hasInput = true;
          break;
        }

        case 'command/done': {
          const exitCode = Number(event.exitCode ?? 0);
          const entry = getOrCreateCollector(session, evTurn);
          entry.collector.recordTool({
            tool: 'command',
            ok: exitCode === 0,
            exitCode,
            summary: String(event.command ?? event.summary ?? `exit ${exitCode}`),
          });
          entry.hasInput = true;
          break;
        }

        case 'turn/end': {
          const entry = turnCollectors.get(sessionId);
          turnCollectors.delete(sessionId);
          pendingQueries.delete(sessionId);
          if (entry && entry.hasInput) {
            try {
              const closed = entry.collector.closeTurn({ now: now() });
              if (closed?.enqueued || closed?.queued) {
                scheduleIngestDrain(0);
              }
            } catch {
              // fail-open
            }
          }
          break;
        }

        default:
          break;
      }
    }

    // 优先通过 ctx.inject(['sessions']) 挂载，并在无 sessions 服务时回退到直接 ctx.on('session/event')
    const seenEvents = new WeakSet();
    const dispatchSessionEvent = (session, event) => {
      if (event && typeof event === 'object') {
        if (seenEvents.has(event)) return;
        seenEvents.add(event);
      }
      try {
        handleSessionEvent(session, event);
      } catch {
        // fail-open：采集旁路绝不影响主会话
      }
    };

    let attachedViaInject = false;
    if (typeof ctx?.inject === 'function') {
      try {
        const subDisp = ctx.inject(['sessions'], (sctx) => {
          attachedViaInject = true;
          if (typeof sctx?.on === 'function') {
            track(sctx.on('session/event', dispatchSessionEvent));
          }
        });
        track(subDisp);
      } catch {
        // ignore
      }
    }
    if (typeof ctx?.on === 'function') {
      track(ctx.on('session/event', (session, event) => {
        if (attachedViaInject) return;
        dispatchSessionEvent(session, event);
      }));
    }

    // -------------------------------------------------------------- RPC 路由挂载

    track(deps.installRpc(ctx, {
      dbPath,
      store,
      getIndex,
      invalidate: () => { bumpContentGeneration(); },
      touchWiki,
      compileWikiNow,
      runMetabolismNow,
      getInjectStatus: () => ({
        hasContextChannel: typeof ctx?.systemPrompt?.context === 'function',
      }),
      config: cfg,
      fetchImpl: dependencies.fetch,
    }));

    // -------------------------------------------------------------- 注入：v1 Legacy 兼容与 v2 两段式动态注入

    function renderLegacyInject() {
      assertHealthy();
      if (!cfg.autoInject) return '';
      const budget = cfg.injectBudget;
      if (budget <= 0) return '';

      if (cfg.experimentalInjectMode === 'daily') {
        const snap = store.injectionSnapshot({
          mode: 'daily',
          now: now(),
          halfLifeDays: cfg.experimentalInjectHalfLifeDays,
          floor: cfg.experimentalInjectFloor,
          perKindCap: INJECT_SEG_MAX_ROWS,
        });
        const total = snap.total;
        if (total === 0) return '';
        const kCounts = snap.kinds;
        const head = `## memjudge 记忆索引（人 ${kCounts.person} / 约 ${kCounts.promise} / 事 ${kCounts.event} 条，库内 ${total} 条）\n`;
        const foot = '\n用 memjudge_recall 取全文，memjudge_conflicts 查前后矛盾。';
        const avail = budget - head.length - foot.length;
        if (avail <= 24) return '';

        const nonEmpty = INJECT_SEGMENTS
          .map((seg) => ({ seg, rows: snap.byKind[seg.kind] ?? [] }))
          .filter((g) => g.rows.length > 0);
        if (!nonEmpty.length) return '';

        const totalShare = nonEmpty.reduce((s, g) => s + g.seg.share, 0);
        const caps = nonEmpty.map((g) => Math.floor((avail * g.seg.share) / totalShare));
        const blocks = [];
        let carry = 0;

        for (let idx = 0; idx < nonEmpty.length; idx += 1) {
          const { seg, rows } = nonEmpty[idx];
          const cap = caps[idx] + carry;
          const headerLine = `${seg.header}\n`;
          if (cap <= headerLine.length + 12) {
            carry = cap;
            continue;
          }
          let block = headerLine;
          let added = 0;
          for (const r of rows) {
            const src = chapterOf(r);
            const summary = src.chapter ? `ch${src.chapter}` : sourceLabel(r.source);
            const line = `- ${JSON.stringify(r.id)} — ${inlineText(r.text, 90)}${summary ? `：${summary}` : ''}\n`;
            if (block.length + line.length > cap) break;
            block += line;
            added += 1;
          }
          if (added > 0) {
            blocks.push(block);
            carry = cap - block.length;
          } else {
            carry = cap;
          }
        }
        if (!blocks.length) return '';
        return sanitizeWellFormed(`${head}${blocks.join('')}${foot}`.slice(0, budget));
      }

      const base = store.stats();
      if (base.memories === 0) return '';
      const k = base.kinds;
      const head = `## memjudge 记忆索引（人 ${k.person} / 约 ${k.promise} / 事 ${k.event} 条，库内 ${base.memories} 条）\n`;
      const foot = '\n用 memjudge_recall 取全文，memjudge_conflicts 查前后矛盾。';
      const avail = budget - head.length - foot.length;
      if (avail <= 24) return '';

      const rawGroups = INJECT_SEGMENTS.map((seg) => {
        const fetched = store.byKind(seg.kind, INJECT_SEG_MAX_ROWS);
        const rows = seg.kind === 'event'
          ? fetched.filter((r) => !(
              typeof r.source === 'string'
              && r.source.startsWith('auto:chat#')
              && (r.accessCount ?? 0) <= 0
            ))
          : fetched;
        return { seg, rows };
      });

      const nonEmpty = rawGroups.filter((g) => g.rows.length > 0);
      if (!nonEmpty.length) return '';
      const totalShare = nonEmpty.reduce((s, g) => s + g.seg.share, 0);
      const caps = nonEmpty.map((g) => Math.floor((avail * g.seg.share) / totalShare));
      const blocks = [];
      let carry = 0;

      for (let idx = 0; idx < nonEmpty.length; idx += 1) {
        const { seg, rows } = nonEmpty[idx];
        const cap = caps[idx] + carry;
        const headerLine = `${seg.header}\n`;
        if (cap <= headerLine.length + 12) {
          carry = cap;
          continue;
        }
        let block = headerLine;
        let added = 0;
        const limit = seg.kind === 'event' ? cfg.injectLimit : INJECT_SEG_MAX_ROWS;
        for (const r of rows.slice(0, limit)) {
          const src = chapterOf(r);
          const summary = src.chapter ? `ch${src.chapter}` : sourceLabel(r.source);
          const line = `- ${JSON.stringify(r.id)} — ${inlineText(r.text, 90)}${summary ? `：${summary}` : ''}\n`;
          if (block.length + line.length > cap) break;
          block += line;
          added += 1;
        }
        if (added > 0) {
          blocks.push(block);
          carry = cap - block.length;
        } else {
          carry = cap;
        }
      }
      if (!blocks.length) return '';
      return sanitizeWellFormed(`${head}${blocks.join('')}${foot}`.slice(0, budget));
    }

    const hasContextChannel = typeof ctx?.systemPrompt?.context === 'function';

    function shouldUseTieredMode(promptCtx) {
      if (cfg.injectMode === 'legacy') return false;
      if (cfg.injectMode === 'tiered') return true;
      if (hasContextChannel) return true;
      if (
        promptCtx
        && typeof promptCtx === 'object'
        && (
          promptCtx.session
          || promptCtx.agent
          || promptCtx.sessionId
          || promptCtx.cwd
          || promptCtx.spaceId
          || Array.isArray(promptCtx.messages)
          || typeof promptCtx.query === 'string'
        )
      ) {
        return true;
      }
      return false;
    }

    function resolveInjectCtx(promptCtx) {
      const session = promptCtx?.session ?? promptCtx?.agent?.session ?? null;
      const header = session?.header ?? promptCtx?.header ?? {};
      const sessionId = promptCtx?.sessionId ?? session?.id ?? 'default';
      const scopeInfo = resolveScope({
        space: promptCtx?.spaceId ?? promptCtx?.space,
        session,
        agent: promptCtx?.agent,
        header,
        cwd: promptCtx?.cwd ?? header?.cwd,
      });
      ensureSpaceRegistered(scopeInfo);
      return {
        sessionId,
        spaceId: scopeInfo.spaceId,
        spaces: scopeInfo.spaces,
        session,
        header,
      };
    }

    function renderTierS(promptCtx) {
      assertHealthy();
      if (!cfg.autoInject) return '';
      const injectCtx = resolveInjectCtx(promptCtx);
      if (isSubagentSession(injectCtx.session) || isSubagentSession(injectCtx.header)) {
        return '';
      }
      const res = injector.getTierS({
        store,
        sessionId: injectCtx.sessionId,
        spaceId: injectCtx.spaceId,
        spaces: injectCtx.spaces,
        tierSMaxChars: Math.min(TIER_S_MAX_CHARS, cfg.tierSBudget, cfg.injectBudget),
      });
      return sanitizeWellFormed(res.text);
    }

    function renderTierDSync(promptCtx) {
      assertHealthy();
      if (!cfg.autoInject) return '';
      const injectCtx = resolveInjectCtx(promptCtx);
      if (isSubagentSession(injectCtx.session) || isSubagentSession(injectCtx.header)) {
        return '';
      }
      const { query, isToolSubstep } = extractQueryFromPromptContext(promptCtx, pendingQueries);
      if (!query || isToolSubstep) return '';
      const res = injector.getTierDSync(query, {
        store,
        searchIndex: getIndex(),
        sessionId: injectCtx.sessionId,
        spaceId: injectCtx.spaceId,
        spaces: injectCtx.spaces,
        isToolSubstep,
        tierSMaxChars: Math.min(TIER_S_MAX_CHARS, cfg.tierSBudget),
        tierDMaxChars: Math.min(TIER_D_MAX_CHARS, cfg.tierDBudget),
        totalMaxChars: Math.min(TOTAL_INJECT_MAX_CHARS, cfg.injectBudget),
      });
      return sanitizeWellFormed(res.text);
    }

    function renderSection(promptCtx) {
      if (shouldUseTieredMode(promptCtx)) {
        const tierS = renderTierS(promptCtx);
        if (hasContextChannel) return tierS;
        const tierD = renderTierDSync(promptCtx);
        if (!tierD) return tierS;
        if (!tierS) return tierD;
        const totalCap = Math.min(TOTAL_INJECT_MAX_CHARS, cfg.injectBudget);
        const combined = `${tierS}\n\n${tierD}`;
        return sanitizeWellFormed(combined.length <= totalCap ? combined : combined.slice(0, totalCap));
      }
      return renderLegacyInject();
    }

    // -------------------------------------------------------------- 增强模块配置与向量回填

    const vecConfig = () => {
      const f = deps.moduleFlags();
      return {
        wantVec: cfg.vector ?? f.vector,
        wantRerank: cfg.rerank ?? f.rerank,
        wantExpand: cfg.expand ?? f.expand,
        wantSelect: cfg.llmSelect ?? f.llmSelect,
        wantLlmExtract: f.llmExtract,
      };
    };

    const syncVecCacheKey = () => {
      const r = deps.configReport();
      const g = r.groups?.embed;
      const key = `${g?.baseUrl ?? ''}|${g?.model ?? ''}|${deps.embedDims()}`;
      if (vecCacheModelKey && vecCacheModelKey !== key) {
        vecCache.clear();
        if (index) index.clearVectors();
      }
      vecCacheModelKey = key;
    };

    let backfilling = false;
    const backfillVectors = async () => {
      if (backfilling || disposed || fault) return;
      backfilling = true;
      try {
        syncVecCacheKey();
        const rows = typeof store.list === 'function'
          ? store.list({ status: 'active', includeText: true, limit: 5000 })
          : store.dump();
        if (typeof store.getVectors === 'function') {
          const persisted = store.getVectors({ dims: deps.embedDims() });
          if (Array.isArray(persisted)) {
            for (const item of persisted) {
              if (!vecCache.has(item.memoryId) && item.vec) {
                const f32 = dequantize(item.vec, item.scale);
                vecCache.set(item.memoryId, f32);
                if (index) index.setVector(item.memoryId, f32);
              }
            }
          }
        }
        const missing = rows.filter((r) => !vecCache.has(r.id));
        const BATCH = 32;
        for (let i = 0; i < missing.length && !disposed && !fault; i += BATCH) {
          const slice = missing.slice(i, i + BATCH);
          const vecs = await deps.embed(slice.map((r) => r.text), { dims: deps.embedDims(), fetchImpl: dependencies.fetch });
          if (disposed || fault || !vecs) return;
          for (let j = 0; j < slice.length; j += 1) {
            if (!vecs[j]) continue;
            vecCache.set(slice[j].id, vecs[j]);
            if (index) index.setVector(slice[j].id, vecs[j]);
            if (typeof store.putVector === 'function') {
              try {
                const qVec = vecs[j] instanceof Int8Array ? vecs[j] : quantize(vecs[j]);
                store.putVector({ memoryId: slice[j].id, vec: qVec, dims: qVec.length });
              } catch { /* ignore */ }
            }
          }
        }
      } finally {
        backfilling = false;
      }
    };

    // -------------------------------------------------------------- 工具执行期空间解析辅助

    function normalizeExplicitSpaceId(rawSp, session) {
      const sp = String(rawSp || '').trim();
      if (!sp || sp.toLowerCase() === GLOBAL_SPACE_ID) return GLOBAL_SPACE_ID;
      if (/^workspace:/i.test(sp) && !/^workspace:[0-9a-f]{12}$/i.test(sp)) {
        const customId = sp.toLowerCase();
        if (typeof store.upsertSpace === 'function') {
          try { store.upsertSpace({ spaceId: customId, kind: 'workspace', rootPath: null, label: customId }); } catch { /* ignore */ }
        }
        return customId;
      }
      const sc = resolveScope({ space: sp, session });
      ensureSpaceRegistered(sc);
      return sc.spaceId;
    }

    function resolveToolSpace(args, exec, category) {
      const session = exec?.agent?.session ?? null;
      if (typeof args?.space === 'string' && args.space.trim()) {
        return normalizeExplicitSpaceId(args.space, session);
      }
      if (typeof args?.spaceId === 'string' && args.spaceId.trim()) {
        return normalizeExplicitSpaceId(args.spaceId, session);
      }
      if (category === 'rule' || category === 'profile') {
        return GLOBAL_SPACE_ID;
      }
      const header = session?.header ?? null;
      if (session || header?.cwd) {
        const sc = resolveScope({ session, agent: exec?.agent, header, cwd: header?.cwd });
        ensureSpaceRegistered(sc);
        return sc.spaceId;
      }
      return GLOBAL_SPACE_ID;
    }

    function resolveRecallSpaces(args, exec) {
      const session = exec?.agent?.session ?? null;
      const explicit = typeof args?.space === 'string' && args.space.trim()
        ? args.space.trim()
        : (typeof args?.spaceId === 'string' && args.spaceId.trim() ? args.spaceId.trim() : '');
      if (explicit === 'all') return null;
      if (explicit) {
        const normId = normalizeExplicitSpaceId(explicit, session);
        return visibleSpaces(normId);
      }
      const header = session?.header ?? null;
      if (session || header?.cwd) {
        const sc = resolveScope({ session, agent: exec?.agent, header, cwd: header?.cwd });
        ensureSpaceRegistered(sc);
        return visibleSpaces(sc);
      }
      return null;
    }

    // -------------------------------------------------------------- 1. memjudge_remember

    track(ctx.tools.register({
      name: 'memjudge_remember',
      description:
        '把一条事实写进 memjudge 长期记忆。原文一字不改地落库（写入后 dump 与输入字符级相等），'
        + '同时抽出结构化实体-属性-值槽位供 O(log N) 证据门与三分冲突检测使用。'
        + '支持五类 v2 记忆（category: rule/profile/decision/experience/state）与旧三类（kind: person/promise/event）双向兼容；'
        + 'state 类配合 slotKey 实现单活状态覆写并自动归档旧版本至 memory_revisions。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '要记住的原文。建议一条一个事实，别整章倾倒。' },
          category: {
            type: 'string',
            enum: [...MEMORY_CATEGORIES],
            description: 'v2 五类记忆：rule=跨项目铁律；profile=用户画像；decision=架构决策；experience=排障经验（默认）；state=单活演进状态。',
          },
          kind: {
            type: 'string',
            enum: [...MEMORY_KINDS],
            description: '兼容旧三分法：person=用户画像；promise=铁律约定；event=经验事件。',
          },
          slotKey: { type: 'string', description: '单活槽位键（如 deploy:prod:status）；配合 category="state" 原地覆写并记录修订链。' },
          space: { type: 'string', description: '目标空间 ID（如 workspace:<hash> 或 global）。省略时 rule/profile 归 global，其余归当前工作区。' },
          source: { type: 'string', description: '记忆来源（会话/文件/项目）。' },
          documentId: { type: 'string', description: '显式文档身份；不会从 source 推断。' },
          chapter: { type: 'integer', description: '来源章号，用于章级聚合检索。' },
          para: { type: 'integer', description: '来源段号，用于同章内排序。' },
          importance: { type: 'number', description: '重要度 0..1，影响衰减地板。默认 0。' },
          supersedes: {
            type: 'array',
            items: { type: 'string' },
            description: '被本条取代的旧记忆 id 列表。',
          },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            inserted: { type: 'boolean' },
            created: { type: 'boolean' },
            spaceId: { type: 'string' },
            category: { type: 'string' },
            kind: { type: 'string' },
            tier: { type: 'integer' },
            slotKey: { type: 'string' },
            supersededId: { type: 'string' },
            revisionNumber: { type: 'integer' },
            factCount: { type: 'integer' },
            facts: { type: 'array', items: { type: 'object' } },
            chars: { type: 'integer' },
            total: { type: 'integer' },
            version: { type: 'string' },
          },
          required: ['id', 'inserted', 'factCount', 'chars', 'total', 'kind', 'version'],
        },
        render: (_args, value) => textBlock(
          `${value.inserted ? '已记住' : '已存在（幂等/覆写跳过）'} ${value.id} [${value.spaceId ?? 'global'} | ${value.category ?? value.kind} | version=${value.version}]`
          + `（${value.chars} 字，抽得 ${value.factCount} 条槽位，库内共 ${value.total} 条）`,
        ),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        assertHealthy();
        const text = typeof args?.text === 'string' ? args.text : '';
        if (!text.trim()) throw new Error('memjudge_remember: text 不能为空');

        const category = args?.category !== undefined
          ? normalizeCategory(args.category, args?.kind)
          : (args?.slotKey ? 'state' : kindToCategory(args?.kind));
        const kind = categoryToKind(category);
        const spaceId = resolveToolSpace(args, exec, category);
        const slotKey = typeof args?.slotKey === 'string' && args.slotKey.trim()
          ? args.slotKey.trim()
          : undefined;
        const version = createHash('sha256').update(text, 'utf16le').digest('hex');

        let saved;
        if (category === 'state' && slotKey && typeof store.putState === 'function') {
          const stateRes = store.putState({
            spaceId,
            slotKey,
            text,
            source: args.source ?? null,
            importance: args.importance ?? 0.8,
            now: now(),
          });
          const row = store.get(stateRes.id, true);
          const revisions = typeof store.listRevisions === 'function' ? store.listRevisions(stateRes.id) : [];
          saved = {
            id: stateRes.id,
            inserted: Boolean(stateRes.inserted || stateRes.updated),
            created: Boolean(stateRes.inserted),
            spaceId,
            category: 'state',
            kind: 'event',
            tier: stateRes.tier ?? 0,
            slotKey,
            revisionNumber: revisions.length + 1,
            factCount: Array.isArray(row?.facts) ? row.facts.length : 0,
            facts: Array.isArray(row?.facts) ? row.facts : [],
          };
        } else {
          const putRes = store.put({
            spaceId,
            category,
            kind,
            slotKey: slotKey ?? null,
            text,
            source: args.source ?? null,
            documentId: args.documentId,
            chapter: args.chapter,
            para: args.para,
            importance: args.importance ?? 0,
            supersedes: args.supersedes ?? [],
            createdAt: now(),
          });
          const row = store.get(putRes.id, true);
          saved = {
            id: putRes.id,
            inserted: Boolean(putRes.inserted),
            created: Boolean(putRes.inserted),
            spaceId: putRes.spaceId ?? spaceId,
            category: putRes.category ?? category,
            kind: putRes.kind ?? kind,
            tier: putRes.tier ?? 1,
            slotKey,
            factCount: putRes.factCount ?? (Array.isArray(row?.facts) ? row.facts.length : 0),
            facts: Array.isArray(row?.facts) ? row.facts : [],
          };
        }
        assertHealthy();

        // 同步阶段立即递增 contentGeneration，确保并发只读快照在微任务边界精准感知内容变动
        bumpContentGeneration();
        touchWiki();

        let factCount = saved.factCount;
        let facts = saved.facts;
        const { wantVec, wantLlmExtract } = vecConfig();
        if (saved.inserted && wantLlmExtract && typeof store.rebuildFactsHybrid === 'function') {
          try {
            const rebuilt = await store.rebuildFactsHybrid({
              fetchImpl: dependencies.fetch,
              signal: lifetime.signal,
              ...(deps.extractHybrid ? { extractHybrid: deps.extractHybrid } : {}),
            });
            assertHealthy();
            if (rebuilt?.updated) {
              const refreshed = store.get(saved.id, true);
              if (Array.isArray(refreshed?.facts)) {
                facts = refreshed.facts;
                factCount = refreshed.facts.length;
              }
              bumpContentGeneration();
              touchWiki();
            }
          } catch {
            if (fault) throw fault;
          }
        }

        assertHealthy();
        if (saved.inserted && wantVec) {
          try {
            syncVecCacheKey();
            const vecs = await deps.embed([text], { dims: deps.embedDims(), fetchImpl: dependencies.fetch });
            assertHealthy();
            if (vecs?.[0]) {
              vecCache.set(saved.id, vecs[0]);
              if (index) index.setVector(saved.id, vecs[0]);
              if (typeof store.putVector === 'function') {
                const qVec = vecs[0] instanceof Int8Array ? vecs[0] : quantize(vecs[0]);
                store.putVector({ memoryId: saved.id, vec: qVec, dims: qVec.length });
              }
            }
          } catch {
            // 降级为 BM25
          }
        }

        assertHealthy();
        const total = store.stats().memories;
        return {
          id: saved.id,
          inserted: saved.inserted,
          created: saved.created,
          spaceId: saved.spaceId,
          category: saved.category,
          kind: saved.kind,
          tier: saved.tier,
          ...(saved.slotKey ? { slotKey: saved.slotKey } : {}),
          ...(saved.supersededId ? { supersededId: saved.supersededId } : {}),
          ...(saved.revisionNumber !== undefined ? { revisionNumber: saved.revisionNumber } : {}),
          factCount,
          facts,
          chars: text.length,
          total,
          version,
        };
      },
    }));

    // -------------------------------------------------------------- 2. memjudge_recall

    const runRecall = async (args, { touch = cfg.touchOnRecall, exec = null } = {}) => {
      assertHealthy();
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('memjudge_recall: query 不能为空');

      const budget = clampInt(args?.budget, 1, INJECT_HARD_LIMIT, Math.min(cfg.injectBudget, INJECT_HARD_LIMIT));
      const topChapters = clampInt(args?.topChapters, 1, 4, 2);
      const targetSpaces = resolveRecallSpaces(args, exec);
      const { wantVec, wantRerank, wantExpand, wantSelect } = vecConfig();

      const startGen = contentGeneration;
      const ix = getIndex();
      if (ix.docs.length === 0) {
        return {
          denied: true,
          reason: 'empty-store',
          detail: '记忆库为空',
          chars: 0,
          elapsedMs: 0,
          hits: [],
        };
      }

      if (wantVec) {
        syncVecCacheKey();
        if (vecCache.size < ix.docs.length) void backfillVectors();
      }

      const needsAsyncPipeline = Boolean(
        wantExpand
        || wantRerank
        || wantSelect
        || (wantVec && (ix.hasVectors || typeof store.vectorSearch === 'function')),
      );

      const callNow = now();
      const cacheKey = `${startGen}\0${callNow}\0${budget}\0${topChapters}\0${targetSpaces ? targetSpaces.join(',') : '*'}\0${wantVec ? 1 : 0}${wantRerank ? 1 : 0}${wantExpand ? 1 : 0}${wantSelect ? 1 : 0}\0${query}`;
      let cached = recallCache.get(cacheKey);
      let found;
      let t0;

      if (cached) {
        t0 = process.hrtime.bigint();
        found = cached;
      } else if (!needsAsyncPipeline) {
        // 离线同步快路径：单次事件循环栈帧内完成 BM25 + entity_slots O(log N) 融合，零额外微任务切换
        t0 = process.hrtime.bigint();
        const searchOpts = {
          maxChars: budget,
          topChapters,
          now: callNow,
          ...decayOptions,
          ...(targetSpaces ? { spaces: targetSpaces } : {}),
        };
        found = ix.search(query, searchOpts);

        // 若 BM25 未命中但结构化槽位精确命中（例如纯代码符号/属性键值查询），补入槽位路候选
        if (!found.hits.length && typeof store.querySlots === 'function') {
          const slotMatch = matchEntitySlots(query, {
            store,
            ...(targetSpaces ? { spaces: targetSpaces } : {}),
          });
          if (slotMatch.rankedIds.length > 0) {
            const rrfMap = rrfFuse([[], slotMatch.rankedIds], 60);
            const fallbackHits = [];
            let usedChars = 0;
            for (const id of slotMatch.rankedIds) {
              const doc = ix.docs.find((d) => d.id === id);
              if (!doc) continue;
              const sliceText = doc.text.length > budget ? doc.text.slice(0, budget) : doc.text;
              if (usedChars + sliceText.length > budget && fallbackHits.length > 0) break;
              usedChars += sliceText.length;
              fallbackHits.push({
                id: doc.id,
                spaceId: doc.spaceId,
                slotKey: doc.slotKey,
                category: doc.category,
                chapter: doc.chapter,
                para: doc.para,
                text: sliceText,
                version: createHash('sha256').update(doc.text, 'utf16le').digest('hex'),
                chars: sliceText.length,
                truncated: sliceText.length < doc.text.length,
                ...(sliceText.length < doc.text.length ? { windowStart: 0, windowEnd: sliceText.length, startsAtBoundary: true } : {}),
                score: rrfMap.get(id) ?? (1 / 61),
                bm25: 0,
                rrf: rrfMap.get(id) ?? (1 / 61),
                routes: ['slot'],
              });
            }
            if (fallbackHits.length > 0) {
              found = {
                hits: fallbackHits,
                text: fallbackHits.map((h) => h.text).join('\n\n'),
                chars: usedChars,
                scan: { ...found.scan, slots: { count: slotMatch.rankedIds.length } },
                elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
              };
            }
          }
        }
        assertHealthy();
        if (startGen === contentGeneration) {
          if (recallCache.size >= 128) recallCache.delete(recallCache.keys().next().value);
          recallCache.set(cacheKey, found);
        }
      } else {
        t0 = process.hrtime.bigint();
        let queryVector = null;
        if (wantVec && ix.hasVectors) {
          try {
            const qv = await deps.embed([query], { dims: deps.embedDims(), fetchImpl: dependencies.fetch });
            queryVector = qv?.[0] ?? null;
          } catch {
            queryVector = null;
          }
        }
        assertHealthy();
        found = await hybridSearch(ix, query, {
          store,
          maxChars: budget,
          topChapters,
          now: now(),
          ...decayOptions,
          ...(targetSpaces ? { spaces: targetSpaces } : {}),
          vector: wantVec,
          queryVector,
          embed: queryVector ? async () => [queryVector] : (wantVec ? (texts) => deps.embed(texts, { dims: deps.embedDims(), fetchImpl: dependencies.fetch }) : undefined),
          rerank: wantRerank,
          rerankFn: wantRerank ? (q, docs, o) => deps.rerank(q, docs, { ...o, fetchImpl: dependencies.fetch }) : undefined,
          rerankCache,
          expand: wantExpand,
          expandFn: wantExpand ? (q, o) => deps.expand(q, { ...o, fetchImpl: dependencies.fetch }) : undefined,
          expandCache,
          llmSelect: wantSelect,
          selectFn: wantSelect ? (q, cands, o) => deps.select(q, cands, { ...o, fetchImpl: dependencies.fetch }) : undefined,
          selectCache,
        });
        assertHealthy();
        if (contentGeneration !== startGen) {
          throw new Error('memjudge_recall aborted: store mutated during async recall');
        }
        if (recallCache.size >= 128) recallCache.delete(recallCache.keys().next().value);
        recallCache.set(cacheKey, found);
      }

      if (!found.hits.length) {
        return {
          denied: true,
          reason: 'no-candidates',
          detail: '检索无候选段',
          chars: 0,
          elapsedMs: found.elapsedMs,
          hits: [],
        };
      }

      // O(log N) 槽位证据门 + Top-K 命中正文双重核验（彻底消灭 O(N) 全表扫描 store.allFacts()）
      const slotGate = typeof store.querySlots === 'function'
        ? gateSlots(query, store, {
            ...(targetSpaces ? { spaces: targetSpaces } : {}),
          })
        : null;

      // 从命中的 Top-K 记忆行提取局部结构化槽位，零全表扫描
      const topKL1Facts = [];
      for (const h of found.hits) {
        const m = store.get(h.id, true);
        if (Array.isArray(m?.facts)) {
          for (const f of m.facts) topKL1Facts.push(f);
        }
      }

      const bodyVerdict = gate(query, found.text, topKL1Facts.length ? { l1Facts: topKL1Facts } : {});
      if (shouldDenyRecall(bodyVerdict, slotGate)) {
        const denial = isHardDeny(bodyVerdict) ? bodyVerdict : slotGate;
        return {
          denied: true,
          reason: denial.reason,
          detail: JSON.stringify(denial.detail ?? {}),
          chars: 0,
          elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
          hits: [],
        };
      }

      if (touch) {
        const at = now();
        for (const h of found.hits) {
          store.updateAccess(h.id, at);
          assertHealthy();
          if (index) {
            const doc = index.docs.find((d) => d.id === h.id);
            if (doc) {
              doc.accessCount = (doc.accessCount ?? 0) + 1;
              doc.lastAccessed = at;
            }
          }
        }
        if (found.hits.length > 0) {
          recallCache.clear();
        }
      }

      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const out = {
        denied: false,
        chars: found.chars,
        elapsedMs,
        chaptersPicked: found.scan?.chaptersPicked ?? [],
        hits: found.hits.map((h) => ({
          id: h.id,
          ...(h.spaceId ? { spaceId: h.spaceId } : {}),
          ...(h.category ? { category: h.category } : {}),
          ...(h.slotKey ? { slotKey: h.slotKey } : {}),
          chapter: h.chapter,
          para: h.para,
          chars: h.chars ?? h.text.length,
          score: h.score,
          text: h.text,
          version: h.version,
          truncated: h.truncated,
          ...(Array.isArray(h.routes) ? { routes: h.routes } : {}),
          ...(h.windowStart !== undefined ? {
            windowStart: h.windowStart,
            windowEnd: h.windowEnd,
            startsAtBoundary: h.startsAtBoundary,
          } : {}),
        })),
      };
      if (found.scan?.expansion) out.expansion = found.scan.expansion;
      if (found.scan?.rerank && found.scan.rerank.degraded !== 'disabled') out.rerank = found.scan.rerank;
      if (found.scan?.selection && found.scan.selection.pool > 0) out.selection = found.scan.selection;
      return out;
    };

    track(ctx.tools.register({
      name: 'memjudge_recall',
      description:
        '在 memjudge 长期记忆里检索。融合 BM25 + Int8 向量 + 结构化槽位三路 RRF，前置工作区隔离（当前 workspace + global），'
        + '并经 O(log N) 槽位证据门拦截编造。返回原文片段；命中即刷新访问时间。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '自然语言问题或关键词。' },
          space: { type: 'string', description: '指定检索空间（默认自动取当前工作区 + global；传 "all" 跨全空间检索）。' },
          budget: { type: 'integer', description: '本次返回字符预算，1..2000。' },
          topChapters: { type: 'integer', description: '章级聚合取前几章，1..4。默认 2。' },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            denied: { type: 'boolean' },
            reason: { type: 'string' },
            detail: { type: 'string' },
            chars: { type: 'integer' },
            elapsedMs: { type: 'number' },
            chaptersPicked: { type: 'array', items: { type: 'integer' } },
            expansion: { type: 'object' },
            rerank: { type: 'object' },
            selection: { type: 'object' },
            hits: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  spaceId: { type: 'string' },
                  category: { type: 'string' },
                  slotKey: { type: 'string' },
                  chapter: { type: 'integer' },
                  para: { type: 'integer' },
                  chars: { type: 'integer' },
                  score: { type: 'number' },
                  text: { type: 'string' },
                  version: { type: 'string' },
                  truncated: { type: 'boolean' },
                  routes: { type: 'array', items: { type: 'string' } },
                  windowStart: { type: 'integer' },
                  windowEnd: { type: 'integer' },
                  startsAtBoundary: { type: 'boolean' },
                },
                required: ['id', 'chapter', 'para', 'score', 'text', 'version', 'truncated'],
              },
            },
          },
          required: ['denied', 'chars', 'elapsedMs', 'hits'],
        },
        render: (_args, value) => {
          if (value.denied) {
            return textBlock(`拒答（${value.reason}）：材料未记载，禁止据此编造。${value.detail ? ` 详情：${value.detail}` : ''}`);
          }
          const lines = value.hits.map(
            (h) => `[${h.id} | ${h.spaceId ?? 'global'} | ch${h.chapter}:p${h.para} | score=${Math.round(h.score * 1000) / 1000} | v=${h.version}${h.truncated ? (Number.isInteger(h.windowStart) ? ` | 截断 ${h.windowStart}:${h.windowEnd}` : ' | 截断') : ''}]\n${h.text}`,
          );
          return textBlock(`召回 ${value.hits.length} 段（${value.chars} 字，${Number(value.elapsedMs ?? 0).toFixed(2)}ms）：\n\n${lines.join('\n\n')}`);
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return runRecall(args, { touch: cfg.touchOnRecall, exec });
      },
    }));

    // -------------------------------------------------------------- 3. memjudge_read

    track(ctx.tools.register({
      name: 'memjudge_read',
      description: '按记忆 id 分页读取原文。续页传入首页 version 校验内容；offset 和 nextOffset 是 UTF-16 码元偏移；读取不刷新访问时间。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '召回结果中的记忆 id。' },
          offset: { type: 'integer', minimum: 0, description: '起始偏移，默认 0。' },
          limit: { type: 'integer', minimum: 2, maximum: 2000, description: '每页 2..2000 个 UTF-16 码元，默认 2000。' },
          version: { type: 'string', description: '首页返回的原文版本，续页传入以检查内容变化。' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean' },
            id: { type: 'string' },
            text: { type: 'string' },
            offset: { type: 'integer' },
            nextOffset: { type: 'integer' },
            total: { type: 'integer' },
            truncated: { type: 'boolean' },
            version: { type: 'string' },
          },
          required: ['found', 'id', 'text', 'offset', 'nextOffset', 'total', 'truncated'],
        },
        render: (_args, value) => textBlock(JSON.stringify(value)),
      },
      isConcurrencySafe: () => false,
      execute({ id, offset = 0, limit = 2000, version }) {
        assertHealthy();
        if (
          typeof id !== 'string' || !id
          || !Number.isSafeInteger(offset) || offset < 0
          || !Number.isSafeInteger(limit) || limit < 2 || limit > 2000
          || (version !== undefined && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)))
        ) {
          throw new Error('memjudge_read: invalid arguments');
        }
        const row = store.get(id, false);
        if (!row) {
          if (version !== undefined) throw new Error('memjudge_read: stale version');
          return { found: false, id, text: '', offset: 0, nextOffset: 0, total: 0, truncated: false };
        }
        const text = row.text;
        const currentVersion = createHash('sha256').update(text, 'utf16le').digest('hex');
        if (version !== undefined && version !== currentVersion) throw new Error('memjudge_read: stale version');
        if (
          offset > text.length
          || (
            offset > 0 && offset < text.length
            && text.charCodeAt(offset - 1) >= 0xD800 && text.charCodeAt(offset - 1) <= 0xDBFF
            && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF
          )
        ) {
          throw new Error('memjudge_read: invalid offset');
        }
        let end = Math.min(text.length, offset + limit);
        if (
          end < text.length
          && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF
          && text.charCodeAt(end) >= 0xDC00 && text.charCodeAt(end) <= 0xDFFF
        ) {
          end -= 1;
        }
        return {
          found: true,
          id,
          text: text.slice(offset, end),
          offset,
          nextOffset: end,
          total: text.length,
          truncated: end < text.length,
          version: currentVersion,
        };
      },
    }));

    // -------------------------------------------------------------- 4. memjudge_forget

    track(ctx.tools.register({
      name: 'memjudge_forget',
      description:
        '从 memjudge 长期记忆里物理删除条目（不可恢复）。支持按 id、query、source 或 space 清理；'
        + '先用 dryRun=true 预览将删除的 id，确认后再执行物理删除。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '要删除的记忆 id。' },
          source: { type: 'string', description: '精确删除该已知来源的全部条目；优先于 id/query。' },
          space: { type: 'string', description: '按空间过滤或批量清理指定空间（如 workspace:<hash>）。' },
          query: { type: 'string', description: '按检索命中批量删除。与 id 同时给时以 id 优先。' },
          limit: { type: 'integer', description: 'query 模式最多删几条，1..100。默认 10。' },
          dryRun: { type: 'boolean', description: '只列出将删除的 id，不落库。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            forgotten: { type: 'array', items: { type: 'string' } },
            count: { type: 'integer' },
            dryRun: { type: 'boolean' },
          },
          required: ['forgotten', 'count', 'dryRun'],
        },
        render: (_args, value) => textBlock(
          value.count === 0
            ? '没有匹配到要遗忘的条目'
            : `${value.dryRun ? '将遗忘' : '已遗忘'} ${value.count} 条：${value.forgotten.join(', ')}`,
        ),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const dryRun = args?.dryRun === true;
        const spaceFilter = typeof args?.space === 'string' && args.space.trim() && args.space !== 'all'
          ? normalizeExplicitSpaceId(args.space, exec?.agent?.session ?? null)
          : undefined;
        assertHealthy();

        const runForget = (opts) => {
          try {
            return store.forget(opts);
          } catch (err) {
            if (fault) throw fault;
            throw err;
          }
        };

        if (args?.source !== undefined) {
          const result = runForget({ source: args.source, spaceId: spaceFilter, dryRun });
          assertHealthy();
          if (!dryRun && result.count > 0) {
            for (const rid of result.forgotten) vecCache.delete(rid);
            bumpContentGeneration();
            touchWiki();
          }
          return { forgotten: result.forgotten, count: result.count, dryRun };
        }

        if (!args?.id && !args?.query && spaceFilter) {
          const result = runForget({ spaceId: spaceFilter, dryRun });
          assertHealthy();
          if (!dryRun && result.count > 0) {
            for (const rid of result.forgotten) vecCache.delete(rid);
            bumpContentGeneration();
            touchWiki();
          }
          return { forgotten: result.forgotten, count: result.count, dryRun };
        }

        const ids = [];
        if (args?.id) {
          ids.push(String(args.id));
        } else if (args?.query) {
          const limit = clampInt(args?.limit, 1, 100, 10);
          const found = getIndex().search(String(args.query), {
            maxChars: 1e9,
            limit: 1e6,
            now: now(),
            ...(spaceFilter ? { spaceId: spaceFilter } : {}),
          });
          for (const hit of found.hits.slice(0, limit)) ids.push(hit.id);
        }
        if (!ids.length) return { forgotten: [], count: 0, dryRun };
        if (dryRun) return { forgotten: ids, count: ids.length, dryRun: true };

        const removed = runForget({ ids, spaceId: spaceFilter }).forgotten;
        assertHealthy();
        if (removed.length > 0) {
          for (const rid of removed) vecCache.delete(rid);
          bumpContentGeneration();
          touchWiki();
        }
        return { forgotten: removed, count: removed.length, dryRun: false };
      },
    }));

    // -------------------------------------------------------------- 5. memjudge_demote

    track(ctx.tools.register({
      name: 'memjudge_demote',
      description:
        '把误判为 rule/profile（person/promise）的记忆安全降级为 experience/event（L1）：'
        + '正文、来源、访问记录全部保留，不再常驻 Tier-S 静态热底座，随生命周期正常代谢。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '要降级的记忆 id。' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean' },
            id: { type: 'string' },
            changed: { type: 'boolean' },
            categoryBefore: { type: 'string' },
            kindBefore: { type: 'string' },
            tierBefore: { type: 'integer' },
            category: { type: 'string' },
            kind: { type: 'string' },
            tier: { type: 'integer' },
          },
          required: ['found', 'id', 'changed', 'kindBefore', 'tierBefore', 'kind', 'tier'],
        },
        render: (_args, value) => textBlock(
          !value.found
            ? `没有找到 id=${value.id} 的记忆`
            : value.changed
              ? `已把 ${value.id} 从 ${value.categoryBefore ?? value.kindBefore}（tier ${value.tierBefore}）降级为 ${value.category ?? value.kind}（tier ${value.tier}）`
              : `${value.id} 已经是 ${value.category ?? value.kind}（tier ${value.tier}），无需改动`,
        ),
      },
      isConcurrencySafe: () => false,
      execute(args) {
        assertHealthy();
        const id = typeof args?.id === 'string' ? args.id.trim() : '';
        if (!id) throw new Error('memjudge_demote: id 必须是非空字符串');
        const beforeRow = store.get(id, false);
        const result = store.setKind(id, 'event');
        assertHealthy();
        if (!result) {
          return {
            found: false,
            id,
            changed: false,
            categoryBefore: '',
            kindBefore: '',
            tierBefore: 0,
            category: '',
            kind: '',
            tier: 0,
          };
        }
        if (result.changed) {
          bumpContentGeneration();
          touchWiki();
        }
        return {
          found: true,
          id: result.id,
          changed: result.changed,
          categoryBefore: result.categoryBefore ?? beforeRow?.category ?? result.kindBefore,
          kindBefore: result.kindBefore,
          tierBefore: result.tierBefore,
          category: result.category ?? 'experience',
          kind: result.kind,
          tier: result.tier,
        };
      },
    }));

    // -------------------------------------------------------------- 6. memjudge_conflicts

    function buildChapterRows(spaceFilter) {
      const rows = typeof store.list === 'function'
        ? store.list({
            status: 'active',
            includeText: true,
            limit: 100000,
            ...(spaceFilter ? { spaces: visibleSpaces(spaceFilter) } : {}),
          })
        : store.dump();
      const byChapter = new Map();
      const pushSeg = (docKey, chapter, para, mem) => {
        const key = `${docKey}\0${chapter}`;
        if (!byChapter.has(key)) byChapter.set(key, []);
        byChapter.get(key).push({ mem, para });
      };
      for (const m of rows) {
        const occs = typeof store.occurrencesV1 === 'function' ? store.occurrencesV1(m.id) : [];
        const validOccs = occs.filter((o) => o && (o.documentId != null || o.chapter != null || o.source != null));
        if (validOccs.length > 0) {
          for (const o of validOccs) {
            const fallback = chapterOf({ id: m.id, source: o.source ?? m.source });
            const ch = o.chapter ?? fallback.chapter ?? 0;
            const pa = o.para ?? fallback.para ?? 0;
            const docId = o.documentId ?? fallback.documentId ?? (ch > 0 ? `ch:${ch}` : `mem:${m.id}`);
            pushSeg(docId, ch, pa, m);
          }
        } else {
          const src = chapterOf(m);
          const docKey = src.documentId ?? (src.chapter > 0 ? `ch:${src.chapter}` : `mem:${m.id}`);
          pushSeg(docKey, src.chapter, src.para, m);
        }
      }
      const out = [];
      for (const [key, group] of byChapter) {
        const chapter = Number(key.slice(key.indexOf('\0') + 1));
        group.sort((a, b) => a.para - b.para || String(a.mem.id).localeCompare(String(b.mem.id)));
        out.push({
          id: group[group.length - 1].mem.id,
          chapter,
          text: group.map((g) => g.mem.text).join('\n'),
          segments: group.map((g) => ({
            id: g.mem.id,
            para: g.para,
            text: g.mem.text,
            createdAt: g.mem.createdAt ?? g.mem.created_at,
          })),
        });
      }
      out.sort((a, b) => a.chapter - b.chapter);
      return out;
    }

    function normalizeConflictPolarity(p) {
      if (p === -1 || p === '-1' || p === 'negate' || p === 'negative') return 'negate';
      if (p === 0 || p === '0' || p === 'neutral') return 'neutral';
      return 'affirm';
    }

    function extractConflictType(cls) {
      const t = typeof cls === 'string' ? cls : (cls?.type ?? 'disputed');
      return t === 'supersession' || t === 'conditional' || t === 'disputed' ? t : 'disputed';
    }

    function collectSlotTriConflicts(spaceFilter) {
      const db = getRawDb(store);
      if (!db) return [];
      const spaces = spaceFilter ? visibleSpaces(spaceFilter) : null;
      let rows = [];
      try {
        if (spaces && spaces.length > 0) {
          const ph = spaces.map(() => '?').join(', ');
          rows = db.prepare(
            `SELECT s.entity, s.attr, s.value, s.unit, s.polarity, s.quote, s.memory_id, s.space_id,
                    m.text, m.created_at, m.superseded_by, m.supersedes_json
               FROM main.entity_slots s
               JOIN main.memories m ON m.id = s.memory_id
              WHERE m.status = 'active' AND s.space_id IN (${ph})
              ORDER BY m.created_at ASC`,
          ).all(...spaces);
        } else {
          rows = db.prepare(
            `SELECT s.entity, s.attr, s.value, s.unit, s.polarity, s.quote, s.memory_id, s.space_id,
                    m.text, m.created_at, m.superseded_by, m.supersedes_json
               FROM main.entity_slots s
               JOIN main.memories m ON m.id = s.memory_id
              WHERE m.status = 'active'
              ORDER BY m.created_at ASC`,
          ).all();
        }
      } catch {
        return [];
      }

      const groups = new Map();
      for (const r of rows) {
        if (!r.attr || r.value == null) continue;
        const gKey = `${r.entity || ''}::${r.attr}::${r.unit || ''}`;
        if (!groups.has(gKey)) {
          groups.set(gKey, {
            key: gKey,
            entity: String(r.entity || ''),
            attr: String(r.attr || ''),
            unit: String(r.unit || ''),
            items: [],
            distinctVals: new Set(),
          });
        }
        const g = groups.get(gKey);
        const pol = normalizeConflictPolarity(r.polarity);
        const vLabel = pol === 'negate' ? `非${r.value}` : String(r.value);
        g.distinctVals.add(vLabel);
        g.items.push({ ...r, polarityLabel: pol, vLabel });
      }

      const conflicts = [];
      for (const g of groups.values()) {
        if (g.distinctVals.size < 2) continue;
        const first = g.items[0];
        const latest = g.items[g.items.length - 1];
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
        const conflictType = extractConflictType(cls);

        const vals = [...g.distinctVals];
        conflicts.push({
          key: g.key,
          entity: g.entity,
          attr: g.attr,
          unit: g.unit,
          conflictType,
          values: vals,
          current: vals[vals.length - 1],
          currentMemId: String(latest.memory_id ?? ''),
          supersededValues: vals.slice(0, -1),
          evidence: g.items.slice(0, 6).map((it) => ({
            memId: String(it.memory_id ?? ''),
            value: String(it.value ?? ''),
            polarity: it.polarityLabel,
            quote: inlineText(it.quote || it.text || '', 140),
          })),
        });
      }
      return conflicts;
    }

    track(ctx.tools.register({
      name: 'memjudge_conflicts',
      description:
        '基于 entity_slots 与章节聚合检测记忆中的前后矛盾，并通过 classifyConflict 给出三分冲突定性：'
        + 'supersession（演进覆盖）、conditional（条件并存）、disputed（真冲突待裁决）及原句证据。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: '最多返回几组矛盾，1..50。默认 20。' },
          space: { type: 'string', description: '限定空间（如 workspace:<hash>；默认当前可见空间）。' },
          type: {
            type: 'string',
            enum: ['supersession', 'conditional', 'disputed'],
            description: '可选按冲突分类过滤。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            conflicts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string' },
                  entity: { type: 'string' },
                  attr: { type: 'string' },
                  unit: { type: 'string' },
                  conflictType: { type: 'string' },
                  values: { type: 'array', items: { type: 'string' } },
                  current: { type: 'string' },
                  currentMemId: { type: 'string' },
                  supersededValues: { type: 'array', items: { type: 'string' } },
                  evidence: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        memId: { type: 'string' },
                        value: { type: 'string' },
                        polarity: { type: 'string' },
                        quote: { type: 'string' },
                      },
                      required: ['memId', 'value', 'polarity', 'quote'],
                    },
                  },
                },
                required: ['key', 'attr', 'unit', 'conflictType', 'values', 'current', 'currentMemId', 'supersededValues'],
              },
            },
            total: { type: 'integer' },
            supersededCount: { type: 'integer' },
            byType: {
              type: 'object',
              additionalProperties: false,
              properties: {
                supersession: { type: 'integer' },
                conditional: { type: 'integer' },
                disputed: { type: 'integer' },
              },
              required: ['supersession', 'conditional', 'disputed'],
            },
          },
          required: ['conflicts', 'total', 'supersededCount', 'byType'],
        },
        render: (_args, value) => textBlock(
          value.total === 0
            ? '未发现前后矛盾'
            : `发现 ${value.total} 组矛盾（supersession=${value.byType.supersession}, conditional=${value.byType.conditional}, disputed=${value.byType.disputed}）：\n\n${value.conflicts
              .map((c) => `- [${c.conflictType}] ${c.entity ? `${c.entity}·` : ''}${c.attr}${c.unit ? `（${c.unit}）` : ''}：${c.values.join(' → ')}，现取 ${c.current}（${c.currentMemId}）`)
              .join('\n')}`,
        ),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertHealthy();
        const limit = clampInt(args?.limit, 1, 50, 20);
        const spaceFilter = typeof args?.space === 'string' && args.space.trim() && args.space !== 'all'
          ? normalizeExplicitSpaceId(args.space, exec?.agent?.session ?? null)
          : undefined;
        const typeFilter = typeof args?.type === 'string' && args.type.trim() ? args.type.trim() : '';

        const slotConflicts = collectSlotTriConflicts(spaceFilter);
        const chapResult = resolveConflict(buildChapterRows(spaceFilter));

        const merged = [...slotConflicts];
        const seenAttrUnit = new Set(slotConflicts.map((c) => `${c.attr}::${c.unit}`));
        for (const c of chapResult.conflicts) {
          const attrName = String(c.attr ?? c.noun ?? '');
          const sig = `${attrName}::${c.unit ?? ''}`;
          if (seenAttrUnit.has(sig)) continue;
          const evList = Array.isArray(c.evidence) ? c.evidence : [];
          const firstEv = evList[0] ?? {};
          const lastEv = evList[evList.length - 1] ?? {};
          const vals = Array.isArray(c.values) ? c.values.map((v) => String(v ?? '')) : [];
          const cls = c.conflictType ?? classifyConflict(
            {
              id: firstEv.memId ?? '',
              attr: attrName,
              value: vals[0] ?? '',
              unit: c.unit ?? '',
              text: firstEv.text ?? firstEv.sentence ?? '',
            },
            {
              id: c.currentMemId ?? lastEv.memId ?? '',
              attr: attrName,
              value: c.current ?? vals[vals.length - 1] ?? '',
              unit: c.unit ?? '',
              text: lastEv.text ?? lastEv.sentence ?? '',
            },
          );
          const conflictType = extractConflictType(cls);
          merged.push({
            key: String(c.key ?? sig),
            entity: String(c.entity ?? ''),
            attr: attrName,
            unit: String(c.unit ?? ''),
            conflictType,
            values: vals,
            current: String(c.current ?? vals[vals.length - 1] ?? ''),
            currentMemId: String(c.currentMemId ?? lastEv.memId ?? ''),
            supersededValues: Array.isArray(c.supersededValues) ? c.supersededValues.map((v) => String(v ?? '')) : [],
            evidence: evList.slice(0, 6).map((e) => ({
              memId: String(e.memId ?? ''),
              value: String(e.value ?? ''),
              polarity: normalizeConflictPolarity(e.polarity),
              quote: inlineText(e.text ?? e.sentence ?? '', 140),
            })),
          });
        }

        const filtered = typeFilter ? merged.filter((c) => c.conflictType === typeFilter) : merged;
        const byType = { supersession: 0, conditional: 0, disputed: 0 };
        for (const c of filtered) {
          if (c.conflictType in byType) byType[c.conflictType] += 1;
        }

        return {
          conflicts: filtered.slice(0, limit),
          total: filtered.length,
          supersededCount: chapResult.superseded.length + byType.supersession,
          byType,
        };
      },
    }));

    // -------------------------------------------------------------- 7. memjudge_stats

    track(ctx.tools.register({
      name: 'memjudge_stats',
      description:
        'memjudge v2 全维体检：总条数、空间分布（spaces）、五类 category 与三类 kind 分布、'
        + 'L0-L3 热冷层级分布、wiki_pages 页数、Tier-S/Tier-D 两段式注入预算状态与增强模块开关。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verbose: { type: 'boolean', description: '附带库路径与详细空间快照。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            schemaVersion: { type: 'integer' },
            memories: { type: 'integer' },
            facts: { type: 'integer' },
            categories: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rule: { type: 'integer' },
                profile: { type: 'integer' },
                decision: { type: 'integer' },
                experience: { type: 'integer' },
                state: { type: 'integer' },
              },
              required: ['rule', 'profile', 'decision', 'experience', 'state'],
            },
            kinds: {
              type: 'object',
              additionalProperties: false,
              properties: {
                person: { type: 'integer' },
                promise: { type: 'integer' },
                event: { type: 'integer' },
              },
              required: ['person', 'promise', 'event'],
            },
            layers: {
              type: 'object',
              additionalProperties: false,
              properties: {
                L0: { type: 'integer' },
                L1: { type: 'integer' },
                L2: { type: 'integer' },
                L3: { type: 'integer' },
              },
              required: ['L0', 'L1', 'L2', 'L3'],
            },
            spaces: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string' },
                  label: { type: 'string' },
                  memoryCount: { type: 'integer' },
                },
                required: ['id', 'kind', 'label', 'memoryCount'],
              },
            },
            wikiCount: { type: 'integer' },
            pendingIngestJobs: { type: 'integer' },
            textChars: { type: 'integer' },
            bytes: { type: 'integer' },
            limitBytes: { type: 'integer' },
            withinLimit: { type: 'boolean' },
            docs: { type: 'integer' },
            terms: { type: 'integer' },
            postings: { type: 'integer' },
            chapters: { type: 'integer' },
            injectEnabled: { type: 'boolean' },
            injectMode: { type: 'string' },
            injectChars: { type: 'integer' },
            injectBudget: { type: 'integer' },
            tierSBudget: { type: 'integer' },
            tierDBudget: { type: 'integer' },
            dbPath: { type: 'string' },
            tidy: { type: 'string' },
            modules: { type: 'string' },
            keyConfigured: { type: 'boolean' },
            keySource: { type: 'string' },
            panelPath: { type: 'string' },
            wiki: { type: 'string' },
          },
          required: [
            'schemaVersion', 'memories', 'facts', 'categories', 'kinds', 'layers', 'spaces', 'wikiCount',
            'textChars', 'bytes', 'limitBytes', 'withinLimit',
            'docs', 'terms', 'postings', 'chapters',
            'injectEnabled', 'injectChars', 'injectBudget', 'tierSBudget', 'tierDBudget', 'dbPath',
            'modules', 'keyConfigured', 'keySource', 'panelPath',
          ],
        },
        render: (_args, value) => textBlock(
          `Schema v${value.schemaVersion} | 记忆 ${value.memories} 条 / 槽位 ${value.facts} 条 / 正文 ${value.textChars} 字\n`
          + `五类 rule ${value.categories.rule} / profile ${value.categories.profile} / decision ${value.categories.decision} / experience ${value.categories.experience} / state ${value.categories.state}\n`
          + `三分 人 ${value.kinds.person} / 约 ${value.kinds.promise} / 事 ${value.kinds.event}\n`
          + `层级 L0=${value.layers.L0} / L1=${value.layers.L1} / L2=${value.layers.L2} / L3=${value.layers.L3} | Wiki 知识页 ${value.wikiCount} 页 | 空间 ${value.spaces.length} 个\n`
          + `库体 ${(value.bytes / 1024).toFixed(1)}KB（上限 ${(value.limitBytes / 1024).toFixed(0)}KB，${value.withinLimit ? '在预算内' : '超预算'}）\n`
          + `倒排 ${value.terms} 词 / ${value.postings} 条 posting / ${value.chapters} 章\n`
          + `后台整理 ${value.tidy ?? '未运行'}\n`
          + `注入 ${value.injectEnabled ? `开启 [${value.injectMode}]（当前 ${value.injectChars} 字，Tier-S<=${value.tierSBudget} + Tier-D<=${value.tierDBudget} <= ${value.injectBudget}）` : '关闭（0 字符）'}\n`
          + `wiki ${value.wiki}\n`
          + `模块 ${value.modules}\n`
          + `密钥 ${value.keyConfigured ? `已配置（${value.keySource}）` : '未配置——向量/重排/LLM 脱水停用，走纯离线引擎'}\n`
          + `面板 ${value.panelPath}`,
        ),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertHealthy();
        const base = store.stats();
        const ix = getIndex().stats();
        const sessionCtx = exec?.agent?.session ? { session: exec.agent.session } : undefined;
        const injectText = renderSection(sessionCtx);
        const tidy = sleepPhase(buildChapterRows(), { tierRows: store.dump() });
        const report = deps.configReport();

        const spaceCounts = new Map();
        const db = getRawDb(store);
        if (db) {
          try {
            const sRows = db
              .prepare("SELECT space_id, COUNT(*) AS cnt FROM main.memories WHERE status = 'active' GROUP BY space_id")
              .all();
            for (const r of sRows) spaceCounts.set(String(r.space_id), Number(r.cnt ?? 0));
          } catch { /* ignore */ }
        }
        const spaces = typeof store.listSpaces === 'function'
          ? store.listSpaces().map((sp) => {
              const sid = String(sp.spaceId ?? sp.id ?? GLOBAL_SPACE_ID);
              return {
                id: sid,
                kind: String(sp.kind ?? 'workspace'),
                label: String(sp.label || sid),
                memoryCount: spaceCounts.get(sid) ?? 0,
              };
            })
          : [{ id: GLOBAL_SPACE_ID, kind: 'global', label: 'Global', memoryCount: base.memories }];

        const wikiPages = typeof store.listWikiPages === 'function' ? store.listWikiPages({ limit: 10000 }) : [];
        const lt = base.lTiers ?? {};
        const layers = {
          L0: Number(lt[0] ?? lt.L0 ?? 0),
          L1: Number(lt[1] ?? lt.L1 ?? (base.lTiers ? 0 : base.memories)),
          L2: Number(lt[2] ?? lt.L2 ?? 0),
          L3: Number(lt[3] ?? lt.L3 ?? 0),
        };

        return {
          schemaVersion: base.schemaVersion ?? STORE_SCHEMA_VERSION,
          memories: base.memories,
          facts: base.facts,
          categories: base.categories ?? { rule: 0, profile: 0, decision: 0, experience: base.memories, state: 0 },
          kinds: base.kinds,
          layers,
          spaces,
          wikiCount: wikiPages.length,
          pendingIngestJobs: base.pendingIngestJobs ?? 0,
          textChars: base.textChars,
          bytes: base.bytes,
          limitBytes: base.limitBytes,
          withinLimit: base.withinLimit,
          docs: ix.docs,
          terms: ix.terms,
          postings: ix.postings,
          chapters: ix.chapters,
          injectEnabled: cfg.autoInject,
          injectMode: shouldUseTieredMode(sessionCtx) ? 'tiered' : 'legacy',
          injectChars: injectText.length,
          injectBudget: cfg.injectBudget,
          tierSBudget: cfg.tierSBudget,
          tierDBudget: cfg.tierDBudget,
          dbPath: args?.verbose === true ? (store.path ?? dbPath) : '',
          tidy: `${tidy.conflicts.length} 组待审矛盾 / ${tidy.archived.length} 条待降级`
            + ` / ${tidy.tierWrites.length} 条 tier 提案`
            + ` / ${tidy.relations.length} 条共现关系`
            + (tidy.errors.length ? ` / ${tidy.errors.length} 阶段失败` : ''),
          modules: (() => {
            const f = report.flags ?? deps.moduleFlags();
            return `jieba ${f.jieba ? 'ON' : 'OFF'} / 向量 ${f.vector ? 'ON' : 'OFF'}`
              + ` / rerank ${f.rerank ? 'ON' : 'OFF'} / 扩展 ${f.expand ? 'ON' : 'OFF'}`
              + ` / 选段 ${f.llmSelect ? 'ON' : 'OFF'} / LLM脱水 ${f.llmExtract ? 'ON' : 'OFF'}`
              + ` / 双边采集 ${cfg.autoCapture ? 'ON' : 'OFF'}`;
          })(),
          keyConfigured: Boolean(report.hasKey),
          keySource: String(report.keySource ?? 'none'),
          panelPath: path.join(STATE_DIR, 'panel.html'),
          wiki: getWikiStatusString(),
        };
      },
    }));

    // -------------------------------------------------------------- 8. memjudge_wiki（v2 新增）

    track(ctx.tools.register({
      name: 'memjudge_wiki',
      description:
        '管理与查阅当前空间的 L2 演进知识页（wiki_pages）及单活状态看板（state）：'
        + '支持 action="list" 列出知识页与单活状态、action="read" 按 slug 读取完整 Markdown 知识页、action="compile" 触发增量编译。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'compile'],
            description: '操作类型：list（默认）、read（需传 slug）、compile（增量编译脏簇与新主题）。',
          },
          slug: { type: 'string', description: 'action="read" 时指定知识页 slug 或 pageId。' },
          space: { type: 'string', description: '指定空间 ID（默认当前工作区 + global；传 "all" 查看全库）。' },
          limit: { type: 'integer', description: '返回页数上限，1..100，默认 50。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string' },
            spaceId: { type: 'string' },
            compiled: { type: 'integer' },
            totalPages: { type: 'integer' },
            page: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                spaceId: { type: 'string' },
                slug: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                markdown: { type: 'string' },
                sourceIds: { type: 'array', items: { type: 'string' } },
                dirty: { type: 'boolean' },
                version: { type: 'integer' },
                updatedAt: { type: 'number' },
              },
              required: ['id', 'spaceId', 'slug', 'title', 'markdown', 'version'],
            },
            pages: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  spaceId: { type: 'string' },
                  slug: { type: 'string' },
                  title: { type: 'string' },
                  summary: { type: 'string' },
                  markdown: { type: 'string' },
                  sourceIds: { type: 'array', items: { type: 'string' } },
                  dirty: { type: 'boolean' },
                  version: { type: 'integer' },
                  updatedAt: { type: 'number' },
                },
                required: ['id', 'spaceId', 'slug', 'title', 'markdown', 'version'],
              },
            },
            states: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  spaceId: { type: 'string' },
                  slotKey: { type: 'string' },
                  text: { type: 'string' },
                  updatedAt: { type: 'number' },
                  revisionCount: { type: 'integer' },
                },
                required: ['id', 'spaceId', 'slotKey', 'text', 'revisionCount'],
              },
            },
          },
          required: ['action', 'spaceId', 'totalPages', 'pages', 'states'],
        },
        render: (_args, value) => {
          if (value.action === 'read') {
            if (!value.page) return textBlock('未找到对应的 Wiki 知识页。');
            return textBlock(`# ${value.page.title} (${value.page.slug} v${value.page.version})\n\n${value.page.markdown}`);
          }
          const header = value.action === 'compile'
            ? `已完成增量编译（编译 ${value.compiled ?? 0} 页）：共 ${value.totalPages} 页 Wiki，${value.states.length} 项单活状态`
            : `当前可见 Wiki 知识页 ${value.totalPages} 页，单活状态 ${value.states.length} 项`;
          const pLines = value.pages.slice(0, 20).map(
            (p) => `- [${p.spaceId}] ${p.slug} (v${p.version}${p.dirty ? ', dirty' : ''}): ${p.title}（源记忆 ${p.sourceIds?.length ?? 0} 条）`,
          );
          const sLines = value.states.slice(0, 20).map(
            (s) => `- [${s.spaceId}] ${s.slotKey} = ${inlineText(s.text, 72)}（修订 ${s.revisionCount} 次）`,
          );
          return textBlock(
            [
              header,
              pLines.length ? `\n【Wiki 知识页】\n${pLines.join('\n')}` : '',
              sLines.length ? `\n【单活 State 快照】\n${sLines.join('\n')}` : '',
            ].filter(Boolean).join('\n'),
          );
        },
      },
      isConcurrencySafe: (args) => (args?.action ?? 'list') !== 'compile',
      async execute(args, exec) {
        assertHealthy();
        const rawAction = typeof args?.action === 'string' ? args.action : 'list';
        const action = rawAction === 'get' ? 'read' : rawAction;
        const limit = clampInt(args?.limit, 1, 100, 50);

        let targetSpace = typeof args?.space === 'string' && args.space.trim() ? args.space.trim() : '';
        if (targetSpace && targetSpace !== 'all') {
          targetSpace = normalizeExplicitSpaceId(targetSpace, exec?.agent?.session ?? null);
        } else if (!targetSpace) {
          const session = exec?.agent?.session ?? null;
          const header = session?.header ?? null;
          if (session || header?.cwd) {
            const sc = resolveScope({ session, agent: exec?.agent, header, cwd: header?.cwd });
            ensureSpaceRegistered(sc);
            targetSpace = sc.spaceId;
          } else {
            targetSpace = 'all';
          }
        }

        let compiled = 0;
        if (action === 'compile') {
          const comp = compileWikiNow({ spaceId: targetSpace === 'all' ? undefined : targetSpace });
          compiled = comp.compiled;
        }

        const spacesFilter = targetSpace === 'all' ? undefined : visibleSpaces(targetSpace);
        const rawPages = typeof store.listWikiPages === 'function'
          ? store.listWikiPages({
              ...(spacesFilter ? { spaces: spacesFilter } : {}),
              limit,
            })
          : [];

        const mapPage = (p) => {
          const pid = String(p.pageId ?? p.id ?? '');
          const md = String(p.summary ?? p.markdown ?? '');
          return {
            id: pid,
            spaceId: String(p.spaceId ?? GLOBAL_SPACE_ID),
            slug: String(p.slug ?? ''),
            title: String(p.title ?? p.slug ?? ''),
            summary: md,
            markdown: md,
            sourceIds: Array.isArray(p.sourceIds) ? p.sourceIds : [],
            dirty: Boolean(p.dirty),
            version: Number(p.version ?? 1),
            updatedAt: Number(p.updatedAt ?? 0),
          };
        };

        const pages = rawPages.map(mapPage);
        const stateRows = typeof store.byCategory === 'function'
          ? store.byCategory('state', {
              ...(spacesFilter ? { spaces: spacesFilter } : {}),
              limit,
            })
          : [];
        const states = stateRows.map((s) => {
          const revs = typeof store.listRevisions === 'function' ? store.listRevisions(s.id) : [];
          return {
            id: s.id,
            spaceId: s.spaceId ?? GLOBAL_SPACE_ID,
            slotKey: s.slotKey ?? '',
            text: s.text,
            updatedAt: Number(s.updatedAt ?? s.createdAt ?? 0),
            revisionCount: revs.length,
          };
        });

        if (action === 'read') {
          const slug = typeof args?.slug === 'string' ? args.slug.trim() : '';
          if (!slug) throw new Error('memjudge_wiki: action="read" 时必须提供非空 slug');
          const hit = pages.find((p) => p.slug === slug || p.id === slug) ?? null;
          return {
            action: 'read',
            spaceId: targetSpace,
            totalPages: pages.length,
            ...(hit ? { page: hit } : {}),
            pages: hit ? [hit] : [],
            states,
          };
        }

        return {
          action,
          spaceId: targetSpace,
          ...(action === 'compile' ? { compiled } : {}),
          totalPages: pages.length,
          pages,
          states,
        };
      },
    }));

    // -------------------------------------------------------------- 只读服务契约

    if (typeof ctx?.provide === 'function') {
      track(ctx.provide(SERVICE_NAME, createService(ctx, {
        store,
        guard: assertHealthy,
        contentVersion: () => contentGeneration,
        recall: (query, opts) => runRecall(
          {
            query,
            budget: opts?.budget,
            topChapters: opts?.topChapters,
            space: opts?.spaceId ?? opts?.space,
          },
          { touch: false },
        ),
      })));
    }

    // -------------------------------------------------------------- 注入挂载（Section Tier-S + Context Tier-D）

    if (ctx?.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
      track(ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        interpolate: false,
        text: renderSection,
      }));
    }

    if (hasContextChannel) {
      track(ctx.systemPrompt.context({
        name: CONTEXT_NAME,
        order: SECTION_ORDER,
        interpolate: false,
        text: renderTierDSync,
      }));
    } else if (typeof ctx?.on === 'function') {
      // 无 systemPrompt.context 时的 agent/pre-step 兼容协同路径
      track(ctx.on('agent/pre-step', async (input, next) => {
        try {
          if (!disposed && cfg.autoInject && shouldUseTieredMode({ agent: input?.agent, session: input?.agent?.session })) {
            const session = input?.agent?.session ?? null;
            const header = session?.header ?? {};
            if (!isSubagentSession(session) && !isSubagentSession(header)) {
              const msgs = Array.isArray(input?.messages) ? input.messages : [];
              const lastMsg = msgs[msgs.length - 1];
              const isToolSubstep = Boolean(lastMsg && lastMsg.role === 'tool');
              const query = isToolSubstep ? '' : extractLatestUserQueryFromMessages(msgs);
              if (query) {
                const injectCtx = resolveInjectCtx({ agent: input?.agent, session });
                const td = await injector.getTierD(query, {
                  store,
                  searchIndex: getIndex(),
                  sessionId: injectCtx.sessionId,
                  spaceId: injectCtx.spaceId,
                  spaces: injectCtx.spaces,
                  isToolSubstep,
                  tierSMaxChars: Math.min(TIER_S_MAX_CHARS, cfg.tierSBudget),
                  tierDMaxChars: Math.min(TIER_D_MAX_CHARS, cfg.tierDBudget),
                  totalMaxChars: Math.min(TOTAL_INJECT_MAX_CHARS, cfg.injectBudget),
                });
                if (!disposed && td.text && Array.isArray(input?.messages)) {
                  input.messages.unshift({
                    role: 'user',
                    content: [{ type: 'text', text: sanitizeWellFormed(td.text) }],
                    source: { kind: 'runtime-context', form: 'snapshot', sections: [CONTEXT_NAME] },
                  });
                }
              }
            }
          }
        } catch {
          // fail-open：动态召回异常绝不阻塞对话主循环
        }
        return typeof next === 'function' ? next() : input;
      }));
    }

    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => dispose);
    }
    return { dispose, dbPath, config: cfg, injector };
  } catch (err) {
    dispose();
    throw err;
  }
}

export default {
  name,
  inject,
  apply,
  resolveConfig,
  defaultDbPath,
  DEFAULTS,
  TOOL_NAMES,
  SECTION_NAME,
  CONTEXT_NAME,
  SECTION_ORDER,
  INJECT_HARD_LIMIT,
};
