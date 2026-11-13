// Three-tier memory scope isolation (global / workspace / session) & subagent hard guard.
// Aligns with DSH real session.header v4 contract:
//   { id, version: 4, createdAt, cwd?, parentSession?, isSeeded, origin?: "subagent", delegationDepth?, agentPreset? }

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GLOBAL_SPACE_ID = 'global';
export const GLOBAL_SPACE_WEIGHT = 0.85;
export const CURRENT_SPACE_WEIGHT = 1.0;

const PROJECT_ROOT_MARKERS = [
  '.git',
  '.hg',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'pyproject.toml',
  'package.json',
];

const SUBAGENT_RECEIPT_LINE_RE = /^(?:Background\s+subagent|Subagent)\s+[0-9a-f-]{6,}\s+finished\b/i;
const SUBAGENT_TAG_RE = /^<subagent[-_](?:result|notification)\b/i;
const WORKSPACE_ID_RE = /^workspace:([0-9a-f]{6,64})$/i;
const SESSION_ID_RE = /^session:([^\s]+)$/;
const WIN_DRIVE_RE = /^[A-Za-z]:(?:[\\/]|$)/;

/**
 * Normalize Windows/POSIX filesystem paths into canonical slash-separated form:
 * - Backslashes -> '/'
 * - Collapse redundant slashes
 * - Strip trailing '/' (except POSIX root '/')
 * - Lowercase Windows drive & path (e.g. 'F:\\记忆库\\' -> 'f:/记忆库')
 */
export function normalizeWorkspacePath(cwd) {
  if (typeof cwd !== 'string') return '';
  let raw = cwd.trim();
  if (!raw) return '';

  const isWindowsStyle = WIN_DRIVE_RE.test(raw) || raw.includes('\\');
  let norm = raw.replace(/\\/g, '/');

  // Preserve leading UNC '//' only when originally a UNC share without drive letter
  if (norm.startsWith('//') && !WIN_DRIVE_RE.test(raw)) {
    norm = '//' + norm.slice(2).replace(/\/+/g, '/');
  } else {
    norm = norm.replace(/\/+/g, '/');
  }

  if (norm.length > 1) {
    norm = norm.replace(/\/+$/, '');
    if (!norm) norm = '/';
  }

  if (isWindowsStyle) {
    norm = norm.toLowerCase();
  }

  return norm;
}

function toFsLookupPath(normPath) {
  if (!normPath) return '';
  if (/^[a-z]:$/i.test(normPath)) return normPath + '/';
  return normPath;
}

function isFilesystemRoot(normPath) {
  if (!normPath) return true;
  if (normPath === '/') return true;
  if (/^[a-z]:$/i.test(normPath)) return true;
  if (/^\/\/[^/]+\/[^/]+$/i.test(normPath)) return true;
  return false;
}

function getNormalizedHomeDirs() {
  const homes = new Set();
  for (const candidate of [
    process.env.HOME,
    process.env.USERPROFILE,
    (() => {
      try {
        return os.homedir();
      } catch {
        return '';
      }
    })(),
  ]) {
    const n = normalizeWorkspacePath(candidate);
    if (n) homes.add(n);
  }
  return homes;
}

function hasProjectMarker(normDir) {
  const fsDir = toFsLookupPath(normDir);
  if (!fsDir) return false;
  for (const marker of PROJECT_ROOT_MARKERS) {
    try {
      if (fs.existsSync(path.join(fsDir, marker))) return true;
    } catch {
      // Ignore permission errors during upward probing
    }
  }
  return false;
}

function parentNormalizedDir(normDir) {
  if (isFilesystemRoot(normDir)) return null;
  const idx = normDir.lastIndexOf('/');
  if (idx < 0) return null;
  if (idx === 0) return '/';
  const parent = normDir.slice(0, idx);
  if (!parent) return '/';
  return parent;
}

/**
 * Detect enclosing project root by walking upward for VCS/manifest markers,
 * refusing to merge across $HOME / %USERPROFILE% or filesystem drive roots.
 * Falls back to normalizeWorkspacePath(cwd) if no marker is found or path does not exist.
 */
export function detectWorkspaceRoot(cwd) {
  const start = normalizeWorkspacePath(cwd);
  if (!start || isFilesystemRoot(start)) return start;

  const homes = getNormalizedHomeDirs();
  if (homes.has(start)) return start;

  try {
    if (!fs.existsSync(toFsLookupPath(start))) return start;
  } catch {
    return start;
  }

  let cur = start;
  while (cur && !isFilesystemRoot(cur) && !homes.has(cur)) {
    if (hasProjectMarker(cur)) return cur;
    const next = parentNormalizedDir(cur);
    if (!next || next === cur) break;
    cur = next;
  }

  return start;
}

export function extractWorkspaceLabel(normPath) {
  if (!normPath) return 'Global';
  if (normPath === '/') return '/';
  if (/^[a-z]:$/i.test(normPath)) return normPath.toUpperCase();
  const idx = normPath.lastIndexOf('/');
  return idx >= 0 ? normPath.slice(idx + 1) || normPath : normPath;
}

/**
 * Compute deterministic workspace spaceId: 'workspace:' + sha256(normalizeWorkspacePath(cwd)).slice(0, 12)
 */
export function workspaceSpaceId(cwd) {
  const norm = normalizeWorkspacePath(cwd);
  if (!norm) return GLOBAL_SPACE_ID;
  const hex = createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 12);
  return `workspace:${hex}`;
}

/**
 * Build full workspace descriptor { spaceId, kind: 'workspace', rootPath, label }.
 */
export function workspaceSpaceInfo(cwd, { detectRoot = false } = {}) {
  const norm = detectRoot ? detectWorkspaceRoot(cwd) : normalizeWorkspacePath(cwd);
  if (!norm) {
    return {
      spaceId: GLOBAL_SPACE_ID,
      kind: 'global',
      rootPath: null,
      label: 'Global',
    };
  }
  return {
    spaceId: workspaceSpaceId(norm),
    kind: 'workspace',
    rootPath: norm,
    label: extractWorkspaceLabel(norm),
  };
}

/**
 * Detect text-level subagent completion receipt (e.g. "Background subagent <uuid> finished ...").
 */
export function isSubagentReceiptText(text) {
  if (typeof text !== 'string' || !text) return false;
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed) return false;
  const nl = trimmed.indexOf('\n');
  const firstLine = (nl >= 0 ? trimmed.slice(0, nl) : trimmed).trim();
  return SUBAGENT_RECEIPT_LINE_RE.test(firstLine) || SUBAGENT_TAG_RE.test(firstLine);
}

function unwrapSessionHeader(sessionOrHeader) {
  if (!sessionOrHeader || typeof sessionOrHeader !== 'object') return null;
  if (sessionOrHeader.agent?.session?.header && typeof sessionOrHeader.agent.session.header === 'object') {
    return sessionOrHeader.agent.session.header;
  }
  if (sessionOrHeader.session?.header && typeof sessionOrHeader.session.header === 'object') {
    return sessionOrHeader.session.header;
  }
  if (sessionOrHeader.header && typeof sessionOrHeader.header === 'object') {
    return sessionOrHeader.header;
  }
  return sessionOrHeader;
}

/**
 * Hard subagent guard against DSH session.header v4 and text-level subagent receipts.
 * IMPORTANT: Never treat `parentSession` alone as a subagent — GUI forked main sessions
 * set `parentSession` while keeping `origin !== 'subagent'` and `delegationDepth` 0/undefined.
 */
export function isSubagentSession(sessionOrHeader, extraText = '') {
  if (typeof sessionOrHeader === 'string') {
    return isSubagentReceiptText(sessionOrHeader);
  }
  if (extraText && isSubagentReceiptText(extraText)) {
    return true;
  }
  if (!sessionOrHeader || typeof sessionOrHeader !== 'object') {
    return false;
  }

  const hdr = unwrapSessionHeader(sessionOrHeader);
  if (hdr) {
    if (hdr.origin === 'subagent') return true;
    if (Number.isInteger(hdr.delegationDepth) && hdr.delegationDepth > 0) return true;
  }

  const candidateText =
    typeof sessionOrHeader.text === 'string'
      ? sessionOrHeader.text
      : typeof sessionOrHeader.content === 'string'
        ? sessionOrHeader.content
        : '';
  if (candidateText && isSubagentReceiptText(candidateText)) {
    return true;
  }

  return false;
}

/**
 * Resolve execution scope from explicit `space` override or DSH session/header/cwd context.
 */
export function resolveScope(input = {}) {
  if (typeof input === 'string') {
    return resolveScope({ space: input });
  }
  const {
    space,
    session,
    agent,
    header,
    cwd,
    detectRoot = false,
  } = input ?? {};

  const resolvedSession = session ?? agent?.session ?? null;
  const hdr = resolvedSession?.header ?? header ?? null;
  const sessionId =
    (typeof resolvedSession?.id === 'string' && resolvedSession.id) ||
    (typeof hdr?.id === 'string' && hdr.id) ||
    null;
  const blockedSubagent = isSubagentSession(resolvedSession ?? agent ?? hdr);

  const fallbackRawCwd =
    (typeof cwd === 'string' && cwd.trim()) ||
    (typeof hdr?.cwd === 'string' && hdr.cwd.trim()) ||
    (typeof resolvedSession?.cwd === 'string' && resolvedSession.cwd.trim()) ||
    '';

  const fallbackNormCwd = fallbackRawCwd
    ? detectRoot
      ? detectWorkspaceRoot(fallbackRawCwd)
      : normalizeWorkspacePath(fallbackRawCwd)
    : '';

  if (typeof space === 'string' && space.trim()) {
    const sp = space.trim();
    if (sp.toLowerCase() === GLOBAL_SPACE_ID) {
      return {
        spaceId: GLOBAL_SPACE_ID,
        kind: 'global',
        rootPath: null,
        label: 'Global',
        sessionId,
        blockedSubagent,
      };
    }

    const wsMatch = sp.match(WORKSPACE_ID_RE);
    if (wsMatch) {
      const normalizedId = `workspace:${wsMatch[1].toLowerCase()}`;
      const matchesCwd = fallbackNormCwd && workspaceSpaceId(fallbackNormCwd) === normalizedId;
      return {
        spaceId: normalizedId,
        kind: 'workspace',
        rootPath: matchesCwd ? fallbackNormCwd : null,
        label: matchesCwd ? extractWorkspaceLabel(fallbackNormCwd) : normalizedId,
        sessionId,
        blockedSubagent,
      };
    }

    if (sp.toLowerCase() === 'session' && sessionId) {
      return {
        spaceId: `session:${sessionId}`,
        kind: 'session',
        rootPath: fallbackNormCwd || null,
        label: `session:${sessionId}`,
        sessionId,
        blockedSubagent,
        ...(fallbackNormCwd ? { workspaceSpaceId: workspaceSpaceId(fallbackNormCwd) } : {}),
      };
    }

    const sessMatch = sp.match(SESSION_ID_RE);
    if (sessMatch) {
      const sid = sessMatch[1];
      return {
        spaceId: `session:${sid}`,
        kind: 'session',
        rootPath: fallbackNormCwd || null,
        label: `session:${sid}`,
        sessionId: sessionId ?? sid,
        blockedSubagent,
        ...(fallbackNormCwd ? { workspaceSpaceId: workspaceSpaceId(fallbackNormCwd) } : {}),
      };
    }

    // Treat explicit filesystem path as workspace path
    const explicitNorm = detectRoot ? detectWorkspaceRoot(sp) : normalizeWorkspacePath(sp);
    if (explicitNorm) {
      return {
        spaceId: workspaceSpaceId(explicitNorm),
        kind: 'workspace',
        rootPath: explicitNorm,
        label: extractWorkspaceLabel(explicitNorm),
        sessionId,
        blockedSubagent,
      };
    }
  }

  if (fallbackNormCwd) {
    return {
      spaceId: workspaceSpaceId(fallbackNormCwd),
      kind: 'workspace',
      rootPath: fallbackNormCwd,
      label: extractWorkspaceLabel(fallbackNormCwd),
      sessionId,
      blockedSubagent,
    };
  }

  return {
    spaceId: GLOBAL_SPACE_ID,
    kind: 'global',
    rootPath: null,
    label: 'Global',
    sessionId,
    blockedSubagent,
  };
}

/**
 * Return weight multiplier for `targetSpaceId` when querying from `currentSpaceId`.
 * Current workspace/session carries weight 1.0; cross-space global fallback carries 0.85.
 */
export function spaceWeight(targetSpaceId, currentSpaceId = GLOBAL_SPACE_ID) {
  const cur = typeof currentSpaceId === 'object' && currentSpaceId !== null
    ? currentSpaceId.spaceId ?? GLOBAL_SPACE_ID
    : currentSpaceId || GLOBAL_SPACE_ID;
  if (!targetSpaceId || targetSpaceId === cur) return CURRENT_SPACE_WEIGHT;
  if (targetSpaceId === GLOBAL_SPACE_ID) {
    return cur === GLOBAL_SPACE_ID ? CURRENT_SPACE_WEIGHT : GLOBAL_SPACE_WEIGHT;
  }
  return CURRENT_SPACE_WEIGHT;
}

function resolveAssociatedWorkspaceId(currentObjOrOpts) {
  if (!currentObjOrOpts) return null;
  if (typeof currentObjOrOpts === 'string') {
    const s = currentObjOrOpts.trim();
    if (!s) return null;
    if (WORKSPACE_ID_RE.test(s)) return s.toLowerCase();
    return workspaceSpaceId(s);
  }
  if (typeof currentObjOrOpts === 'object') {
    const direct = currentObjOrOpts.workspaceSpaceId ?? currentObjOrOpts.workspace ?? '';
    if (typeof direct === 'string' && direct.trim()) {
      return WORKSPACE_ID_RE.test(direct.trim())
        ? direct.trim().toLowerCase()
        : workspaceSpaceId(direct.trim());
    }
    const cwdCandidate = currentObjOrOpts.cwd ?? currentObjOrOpts.rootPath ?? '';
    if (typeof cwdCandidate === 'string' && cwdCandidate.trim()) {
      return workspaceSpaceId(cwdCandidate.trim());
    }
  }
  return null;
}

/**
 * Compute ordered visible space IDs from `currentSpaceId`:
 * - 'workspace:xxx' -> ['workspace:xxx', 'global'] (weights 1.0, 0.85)
 * - 'global'        -> ['global']
 * - 'session:xxx'   -> ['session:xxx', workspaceSpaceId?, 'global']
 *
 * Pass `{ withWeights: true }` as second argument to obtain `[{ spaceId, weight }, ...]`.
 */
export function visibleSpaces(currentSpaceId = GLOBAL_SPACE_ID, options = undefined) {
  let spaceId = GLOBAL_SPACE_ID;
  let inheritedWs = null;

  if (currentSpaceId && typeof currentSpaceId === 'object') {
    spaceId = currentSpaceId.spaceId || GLOBAL_SPACE_ID;
    inheritedWs = resolveAssociatedWorkspaceId(currentSpaceId);
  } else if (typeof currentSpaceId === 'string' && currentSpaceId.trim()) {
    spaceId = currentSpaceId.trim();
  }

  const explicitWs = resolveAssociatedWorkspaceId(options) ?? inheritedWs;
  const withWeights = Boolean(options && typeof options === 'object' && options.withWeights);

  let ids;
  if (!spaceId || spaceId.toLowerCase() === GLOBAL_SPACE_ID) {
    ids = [GLOBAL_SPACE_ID];
  } else if (WORKSPACE_ID_RE.test(spaceId)) {
    ids = [spaceId.toLowerCase(), GLOBAL_SPACE_ID];
  } else if (SESSION_ID_RE.test(spaceId)) {
    ids = explicitWs && explicitWs !== GLOBAL_SPACE_ID
      ? [spaceId, explicitWs, GLOBAL_SPACE_ID]
      : [spaceId, GLOBAL_SPACE_ID];
  } else if (/^workspace:/i.test(spaceId)) {
    ids = [spaceId.toLowerCase(), GLOBAL_SPACE_ID];
  } else {
    const wsId = workspaceSpaceId(spaceId);
    ids = wsId === GLOBAL_SPACE_ID ? [GLOBAL_SPACE_ID] : [wsId, GLOBAL_SPACE_ID];
  }

  if (withWeights) {
    return ids.map((id) => ({
      spaceId: id,
      weight: spaceWeight(id, ids[0]),
    }));
  }
  return ids;
}

export function visibleSpaceWeights(currentSpaceId = GLOBAL_SPACE_ID, options = undefined) {
  return visibleSpaces(currentSpaceId, {
    ...(typeof options === 'object' && options !== null ? options : { workspaceSpaceId: options }),
    withWeights: true,
  });
}

export default {
  GLOBAL_SPACE_ID,
  GLOBAL_SPACE_WEIGHT,
  CURRENT_SPACE_WEIGHT,
  normalizeWorkspacePath,
  detectWorkspaceRoot,
  workspaceSpaceId,
  workspaceSpaceInfo,
  isSubagentReceiptText,
  isSubagentSession,
  resolveScope,
  spaceWeight,
  visibleSpaces,
  visibleSpaceWeights,
};
