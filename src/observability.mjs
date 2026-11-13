// Read-only diagnostics. No store.dump(), prompt rendering, network calls or persistent telemetry.
import { resolveScope, visibleSpaces } from './scope.mjs';
import { TIER_S_MAX_CHARS, TIER_D_MAX_CHARS, TOTAL_INJECT_MAX_CHARS } from './inject.mjs';

export const EVENT_LIMIT = 32;
const CATEGORIES = ['rule', 'profile', 'decision', 'experience', 'state'];
const MODULES = ['vector', 'rerank', 'expand', 'llmSelect', 'llmExtract', 'autoCapture'];
const numberOrNull = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const budget = (n, fallback, max) => Math.max(0, Math.min(max, Number.isFinite(n) ? Math.trunc(n) : fallback));
const identity = (s) => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[\s\x00-\x1f]/u.test(s) ? s : null;
const measured = (text) => ({ text, chars: text.length, bytes: Buffer.byteLength(text, 'utf8') });

/** Body scope is a selection on the existing local RPC, not a new authentication mechanism. */
export function resolveObservationScope(payload = {}, cwd = process.cwd()) {
  const base = resolveScope({ cwd: typeof payload?.cwd === 'string' ? payload.cwd : cwd });
  const allowed = visibleSpaces(base);
  const explicit = payload?.spaceId ?? payload?.space;
  const selected = explicit == null || explicit === '' ? base.spaceId : explicit;
  const valid = allowed.includes(selected);
  return {
    spaceId: valid ? selected : null,
    spaces: valid ? visibleSpaces(selected) : [],
    sessionId: identity(payload?.sessionId),
    explicit: valid && typeof explicit === 'string' && explicit.length > 0,
    includeText: payload?.includeInjectionText === true,
  };
}

/** Bounded metadata ring + ONE raw candidate, never a map of session prompt contents.
 * Separate host channels pair only on identical prompt-context object identity; without
 * a host frame id, pairing by session/time would fabricate a complete frame.
 */
export function createInjectionObserver({ now = Date.now, limit = EVENT_LIMIT } = {}) {
  const cap = budget(limit, EVENT_LIMIT, EVENT_LIMIT);
  const events = [];
  let candidate = null;
  let serial = 0;
  const timestamp = () => new Date(now()).toISOString();
  function record({ token, sessionId, spaceId, tier, text, tierS, tierD, separator = '' }) {
    const sid = identity(sessionId);
    const sp = identity(spaceId);
    // Missing identity must not reuse the engine's shared 'default' session.
    if (!sid || !sp || typeof separator !== 'string' || (tier && typeof text !== 'string')) {
      candidate = null;
      return;
    }
    const at = timestamp();
    if (!tier) {
      if (typeof tierS !== 'string' || typeof tierD !== 'string') { candidate = null; return; }
      candidate = { token: null, sessionId: sid, spaceId: sp, tierS, tierD, separator, at };
    } else {
      if (!['tierS', 'tierD'].includes(tier)) return;
      const validToken = token !== null && (typeof token === 'object' || typeof token === 'function');
      if (tier === 'tierS' || !candidate || !validToken || candidate.token?.deref() !== token
        || candidate.sessionId !== sid || candidate.spaceId !== sp) {
        candidate = { token: validToken ? new WeakRef(token) : null, sessionId: sid, spaceId: sp, tierS: null, tierD: null, separator: '', at };
      }
      candidate[tier] = text;
      candidate.at = at;
    }
    // Never retain an unbounded or truncated-as-actual raw frame.
    if ((candidate.tierS?.length ?? 0) > TIER_S_MAX_CHARS
      || (candidate.tierD?.length ?? 0) > TIER_D_MAX_CHARS
      || (candidate.tierS?.length ?? 0) + (candidate.tierD?.length ?? 0) + separator.length > TOTAL_INJECT_MAX_CHARS) {
      candidate = null;
      return;
    }
    const s = candidate.tierS;
    const d = candidate.tierD;
    const complete = typeof s === 'string' && typeof d === 'string';
    // A completed pair consumes its token. A later D-only callback, even if a
    // host reuses the context object, must not reuse an older S measurement.
    if (complete) candidate.token = null;
    else if (candidate.token) {
      // Packaged SystemPrompt.assemble calls S/D synchronously, then awaits its
      // waterfall. refreshContext can later reuse the same object without S.
      // Never let an abandoned S pair with D across that async boundary.
      const pending = candidate;
      queueMicrotask(() => { if (candidate === pending) pending.token = null; });
    }
    events.push({
      id: `injection-${++serial}`, at, type: 'injection-generated',
      summary: complete ? 'Complete plugin injection generated' : 'Plugin injection channel generated',
      details: {
        sessionId: sid, spaceId: sp, channel: tier ?? 'combined', complete,
        tierSChars: s === null ? null : s.length,
        tierSBytes: s === null ? null : Buffer.byteLength(s, 'utf8'),
        tierDChars: d === null ? null : d.length,
        tierDBytes: d === null ? null : Buffer.byteLength(d, 'utf8'),
      },
    });
    if (events.length > cap) events.splice(0, events.length - cap);
  }
  function read(scope) {
    const selected = Boolean(scope.sessionId && scope.spaceId);
    const filtered = selected ? events.filter((e) => e.details.sessionId === scope.sessionId
      && e.details.spaceId === scope.spaceId).map((e) => ({ ...e, details: { ...e.details } })) : [];
    let reason = null;
    if (!selected) reason = 'session-and-scope-required';
    else if (!candidate || candidate.sessionId !== scope.sessionId || candidate.spaceId !== scope.spaceId) reason = 'no-current-frame-for-session-and-scope';
    else if (candidate.tierS === null || candidate.tierD === null) reason = 'complete-frame-not-observed';
    else if (!scope.includeText || !scope.explicit) reason = 'explicit-scoped-text-request-required';
    const current = reason ? null : {
      tierS: measured(candidate.tierS), tierD: measured(candidate.tierD),
      totalChars: candidate.tierS.length + candidate.tierD.length + candidate.separator.length,
      totalBytes: Buffer.byteLength(candidate.tierS + candidate.separator + candidate.tierD, 'utf8'),
      separatorChars: candidate.separator.length,
      separatorBytes: Buffer.byteLength(candidate.separator, 'utf8'),
      spaceId: candidate.spaceId, sessionId: candidate.sessionId, at: candidate.at,
    };
    return { current, events: filtered, unavailableReason: reason };
  }
  return {
    record, read,
    clear(sessionId) {
      if (!sessionId || candidate?.sessionId === sessionId) candidate = null;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (!sessionId || events[i].details.sessionId === sessionId) events.splice(i, 1);
      }
    },
  };
}

/** SQL aggregates only: never reads memory text, wiki summaries, queue payloads or secrets.
 * Missing raw SQL support is unavailable, not a fabricated zero count or an all-space fallback.
 */
export function collectObservationCounts(store, scope) {
  const empty = { spaces: [], categories: {}, layers: {}, textChars: null, indexes: {}, unavailable: true };
  if (!scope.spaces.length) return empty;
  try {
    const db = typeof store?.raw === 'function' ? store.raw() : store?.raw;
    if (!db?.prepare) return empty;
    const where = `space_id IN (${scope.spaces.map(() => '?').join(',')})`;
    const rows = db.prepare(`SELECT space_id, category, tier, status, COUNT(*) AS n,
      SUM(LENGTH(text)) AS chars FROM main.memories WHERE ${where} AND status != 'deleted'
      GROUP BY space_id, category, tier, status`).all(...scope.spaces);
    const spaces = scope.spaces.map((id) => ({
      id, kind: id === 'global' ? 'global' : 'workspace',
      label: id === 'global' ? 'Global' : 'Current workspace', memoryCount: 0,
    }));
    const categories = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    const layers = { L0: 0, L1: 0, L2: 0, L3: 0 };
    let textChars = 0;
    for (const r of rows) {
      if (r.status === 'active') spaces.find((s) => s.id === r.space_id).memoryCount += Number(r.n);
      if (CATEGORIES.includes(r.category)) categories[r.category] += Number(r.n);
      const layer = `L${Math.max(0, Math.min(3, Math.trunc(Number(r.tier) || 0)))}`;
      layers[layer] += Number(r.n);
      textChars += Number(r.chars);
    }
    const count = (table, tail = '') => {
      try { return Number(db.prepare(`SELECT COUNT(*) AS n FROM main.${table} WHERE ${where}${tail}`).get(...scope.spaces).n); }
      catch { return null; }
    };
    return {
      spaces, categories, layers, textChars, unavailable: false,
      indexes: {
        entitySlots: count('entity_slots'), vectors: count('vectors'), wikiPages: count('wiki_pages'),
        pendingIngestJobs: count('ingest_queue', " AND status IN ('pending', 'processing')"),
        searchIndex: null,
      },
    };
  } catch { return empty; }
}

/** Pure snapshot builder: supplied facts only, no I/O or injection generation. */
export function buildObservabilitySnapshot({ capturedAt, stats = {}, counts = {}, config = {}, dbPath = null, modules = {}, observation = null, scope = {} } = {}) {
  const tiered = config.injectMode !== 'legacy';
  const totalBudgetChars = budget(config.injectBudget, TOTAL_INJECT_MAX_CHARS, tiered ? TOTAL_INJECT_MAX_CHARS : 2000);
  const current = config.autoInject && tiered ? observation?.current ?? null : null;
  const flags = Object.fromEntries(MODULES.map((key) => [key, typeof modules[key] === 'boolean' ? modules[key] : null]));
  return {
    version: 1, capturedAt,
    storage: {
      logicalBytes: numberOrNull(stats.bytes), textChars: numberOrNull(counts.textChars),
      limitBytes: numberOrNull(stats.limitBytes), databasePath: typeof dbPath === 'string' ? dbPath : null,
      semantics: 'logicalBytes preserves store.bytes(): disk SQLite main + WAL + journal file sizes; :memory: page_size × page_count. Database-wide, not injected bytes. textChars is scoped non-deleted SQLite LENGTH(text), not a token count.',
    },
    injection: {
      mode: config.injectMode ?? 'auto', enabled: Boolean(config.autoInject), totalBudgetChars,
      tierSBudgetChars: budget(config.tierSBudget, TIER_S_MAX_CHARS, Math.min(TIER_S_MAX_CHARS, totalBudgetChars)),
      tierDBudgetChars: budget(config.tierDBudget, TIER_D_MAX_CHARS, Math.min(TIER_D_MAX_CHARS, totalBudgetChars)),
      measurement: current ? 'observed' : 'configured', current,
      unavailableReason: !config.autoInject ? 'injection-disabled' : !tiered ? 'legacy-frame-not-observed' : observation?.unavailableReason ?? 'runtime-observer-unavailable',
    },
    spaces: (counts.spaces ?? []).map((s) => ({ ...s })),
    categories: { ...counts.categories }, layers: { ...counts.layers },
    indexes: { ...counts.indexes, modules: flags },
    events: (observation?.events ?? []).slice(-EVENT_LIMIT).map((e) => ({ ...e, details: { ...e.details } })),
    capabilities: {
      scopedCounts: counts.unavailable === false, injectionObservation: Boolean(observation),
      injectionTextRequires: 'includeInjectionText:true + explicit spaceId + matching sessionId; selected scope must be current workspace/global',
      eventLimit: EVENT_LIMIT, persistedTelemetry: false, hostContextTokens: false,
    },
    limitations: [
      'Plugin-generated text only; host delivery, complete host context, token usage and cache hits are not provided.',
      'Only the latest raw candidate is retained in process; separate S/D channels require identical prompt-context object identity. Partial, evicted and ended sessions are unavailable.',
      'Events contain counts and scope/session identifiers, never queries, keys or memory text; filtered to the selected session and exact scope.',
      'Storage bytes cover the entire database; counts and textChars cover selected workspace/global only. Categories/layers include non-deleted rows; space memoryCount counts active rows.',
      'Existing local RPC trust boundary applies; caller-supplied cwd/session selection is not independent user authentication.',
      ...(counts.unavailable !== false ? ['Scoped SQL aggregate data unavailable; no all-space fallback.'] : []),
      ...(!scope.spaceId ? ['Requested scope is outside the current workspace/global selection.'] : []),
    ],
  };
}
