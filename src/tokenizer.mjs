// Code-aware hybrid CJK + English identifier tokenizer for MemJudge v2.
// Dynamically loads @node-rs/jieba when available, seamlessly degrading to pure JS
// while always preserving CJK contiguous bigrams for 100% OOV / proper-noun recall.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cachedJieba = undefined; // undefined = untried, null = unavailable, object = Jieba instance

function getJiebaInstance() {
  if (process.env.MEMJUDGE_NO_JIEBA === '1') return null;
  if (cachedJieba !== undefined) return cachedJieba;
  try {
    const { Jieba } = require('@node-rs/jieba');
    const { dict } = require('@node-rs/jieba/dict');
    cachedJieba = Jieba.withDict(dict);
  } catch {
    cachedJieba = null;
  }
  return cachedJieba;
}

export function hasJieba() {
  return getJiebaInstance() !== null;
}

const ZH_STOP_CHARS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
  '看', '好', '自己', '这', '那', '里', '为', '之', '与', '及', '或', '把',
  '被', '让', '给', '从', '向', '对', '于', '而', '但', '却', '又', '再',
  '更', '最', '只', '才', '已', '曾', '将', '可', '能', '得', '地', '吗',
  '呢', '吧', '啊', '呀', '哦', '嗯', '哪', '什么', '怎么', '多少', '如何',
]);

const EN_QUERY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'did',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'our', 'she', 'so', 'such', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your',
]);

const URL_RE = /https?:\/\/[^\s)>\]"'`，。；！？<>]+/gi;
const PROTO_STATUS_RE = /\b(HTTP(?:\/\d(?:\.\d)?)?|Status)\s+([1-5]\d{2})\b/gi;
const SEMVER_RE = /(?<![A-Za-z0-9_./-])v?\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![A-Za-z0-9_])/g;
const HEX_CODE_RE = /\b0x[0-9a-fA-F]{2,}\b/g;

// POSIX / Windows / scoped-package file paths (e.g. a/b/foo-bar.mjs, F:\dir\file.ts, @node-rs/jieba, /api/memjudge.status)
const FILE_PATH_RE = /(?:[A-Za-z]:[\\/][^\s)>\]"'`，。；！？:*?"<>|]+|@[a-z0-9_-]+\/[a-z0-9._/-]+|(?:\.{1,2}\/|\/)?[A-Za-z0-9_@-]+(?:[\\/][A-Za-z0-9_.@-]+)+)/g;

// Standalone filenames or dotted code identifiers (e.g. foo-bar.mjs, client.js, window.__DSH_BOOT__, memjudge.status)
const DOTTED_IDENT_RE = /\b[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)+\b/g;

// Compound code identifiers: camelCase, PascalCase, snake_case, SCREAMING_SNAKE_CASE, kebab-case, ERR_*, ECONN*
const COMPOUND_IDENT_RE = /\b(?:[A-Za-z_$][A-Za-z0-9$]*(?:_[A-Za-z0-9$]+)+|[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z]{2,}[a-z0-9]+[A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|E[A-Z]{3,16})\b/g;

const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const ALNUM_WORD_RE = /[A-Za-z0-9]+/g;

function stripTrailingPunct(raw) {
  return raw.replace(/[.,;:!?)'"`\]}>，。；：！？）》】]+$/, '');
}

/**
 * Split camelCase / PascalCase / snake_case / kebab-case / dotted segment into atomic subtokens.
 */
export function splitIdentifierParts(ident) {
  if (typeof ident !== 'string' || !ident) return [];
  const parts = [];
  const roughSegments = ident.split(/[\\/:._@-]+/).filter(Boolean);
  for (const seg of roughSegments) {
    const camelSplit = seg
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/\s+/)
      .filter(Boolean);
    for (const sub of camelSplit) {
      parts.push(sub);
    }
  }
  return parts;
}

function isPureNumericSlash(str) {
  return /^\d+(?:[\\/]\d+)+$/.test(str);
}

/**
 * Extract structured code / engineering identifiers from free text:
 * - Full URLs (preserved intact without splitting protocol prefix)
 * - HTTP status codes (e.g. 'HTTP 405')
 * - Semantic versions (e.g. 'v0.2.2-rc.1')
 * - File paths + basenames (e.g. 'a/b/foo-bar.mjs', 'foo-bar.mjs')
 * - Dotted filenames/properties, camelCase, PascalCase, snake_case, kebab-case, error codes
 */
export function extractCodeIdentifiers(text, { includeSubtokens = false, lowercase = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const normText = text.normalize('NFKC');
  const seen = new Set();
  const out = [];

  const push = (tok) => {
    if (!tok) return;
    const val = lowercase ? tok.toLowerCase() : tok;
    if (!seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  };

  let working = normText;

  // 1. Protect URLs first so 'https://...' is never sliced as path 's://...'
  working = working.replace(URL_RE, (raw) => {
    const clean = stripTrailingPunct(raw);
    push(clean);
    if (includeSubtokens) {
      try {
        const u = new URL(clean);
        if (u.hostname) push(u.hostname);
        for (const seg of u.pathname.split('/').filter(Boolean)) {
          push(seg);
          for (const sub of splitIdentifierParts(seg)) push(sub);
        }
      } catch {
        // Ignore malformed URL details
      }
    }
    return ' '.repeat(raw.length);
  });

  // 2. Protocol status codes (e.g. HTTP 405)
  working = working.replace(PROTO_STATUS_RE, (raw, proto, code) => {
    push(`${proto.toUpperCase().startsWith('HTTP') ? 'HTTP' : proto} ${code}`);
    if (includeSubtokens) {
      push(proto);
      push(code);
    }
    return ' '.repeat(raw.length);
  });

  // 3. Semantic versions (e.g. v0.2.2-rc.1)
  working = working.replace(SEMVER_RE, (raw) => {
    const clean = stripTrailingPunct(raw);
    push(clean);
    if (includeSubtokens) {
      const noV = clean.replace(/^v/i, '');
      if (noV !== clean) push(noV);
      const coreVer = noV.split(/[-+]/)[0];
      if (coreVer) push(coreVer);
      for (const sub of splitIdentifierParts(noV)) {
        if (/[A-Za-z]/.test(sub)) push(sub);
      }
    }
    return ' '.repeat(raw.length);
  });

  // 4. Hex error codes (e.g. 0x80070005)
  working = working.replace(HEX_CODE_RE, (raw) => {
    push(raw);
    return ' '.repeat(raw.length);
  });

  // 5. File paths (POSIX & Windows)
  working = working.replace(FILE_PATH_RE, (raw) => {
    const clean = stripTrailingPunct(raw);
    if (!clean || isPureNumericSlash(clean) || !/[A-Za-z\u4e00-\u9fff]/.test(clean)) {
      return raw;
    }
    const slashNorm = clean.replace(/\\/g, '/').replace(/\/+/g, '/');
    const strippedRel = slashNorm.replace(/^\.\//, '');
    push(strippedRel);
    if (strippedRel !== slashNorm) push(slashNorm);

    const segments = strippedRel.split('/').filter(Boolean);
    const basename = segments[segments.length - 1];
    if (basename && basename !== strippedRel) {
      push(basename);
    }
    if (includeSubtokens) {
      for (const seg of segments) {
        if (/^[A-Za-z]:$/.test(seg)) continue;
        push(seg);
        for (const sub of splitIdentifierParts(seg)) {
          push(sub);
        }
      }
    }
    return ' '.repeat(raw.length);
  });

  // 6. Standalone filenames & dotted identifiers (e.g. foo-bar.mjs, client.js)
  working = working.replace(DOTTED_IDENT_RE, (raw) => {
    const clean = stripTrailingPunct(raw);
    if (clean) {
      push(clean);
      if (includeSubtokens) {
        for (const sub of splitIdentifierParts(clean)) push(sub);
      }
    }
    return ' '.repeat(raw.length);
  });

  // 7. Compound identifiers: camelCase, PascalCase, snake_case, kebab-case, ERR_*
  working.replace(COMPOUND_IDENT_RE, (raw) => {
    push(raw);
    if (includeSubtokens) {
      for (const sub of splitIdentifierParts(raw)) push(sub);
    }
    return raw;
  });

  return out;
}

function cjkBigrams(run) {
  const chars = Array.from(run);
  if (chars.length === 0) return [];
  if (chars.length === 1) return ZH_STOP_CHARS.has(chars[0]) ? [] : [chars[0]];
  const out = [];
  for (let i = 0; i < chars.length - 1; i++) {
    out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

function tokenizeCjkRun(run, mode, useJieba) {
  const localSeen = new Set();
  const tokens = [];
  const add = (t) => {
    if (!t || localSeen.has(t)) return;
    localSeen.add(t);
    tokens.push(t);
  };

  const jieba = useJieba ? getJiebaInstance() : null;
  if (jieba && run.length >= 2) {
    const words = mode === 'index'
      ? jieba.cutForSearch(run, true)
      : jieba.cut(run, true);
    for (const w of words) {
      const trimmed = w.trim();
      if (!trimmed) continue;
      if (mode === 'query' && ZH_STOP_CHARS.has(trimmed)) continue;
      if (trimmed.length === 1 && ZH_STOP_CHARS.has(trimmed)) continue;
      add(trimmed);
    }
  }

  // Always emit contiguous CJK bigrams to guarantee 100% OOV / proper-noun recall
  for (const bg of cjkBigrams(run)) {
    if (mode === 'query' && ZH_STOP_CHARS.has(bg)) continue;
    add(bg);
  }

  // Fallback if entire query run consisted of stop characters
  if (tokens.length === 0 && run.length > 0) {
    if (run.length === 1) add(run);
    else {
      const chars = Array.from(run);
      for (let i = 0; i < chars.length - 1; i++) add(chars[i] + chars[i + 1]);
    }
  }

  return tokens;
}

/**
 * Hybrid tokenizer supporting 'index' and 'query' modes.
 * Preserves full code paths, basenames, identifier roots, versions, status/error codes,
 * jieba lexical words (when installed), and CJK contiguous bigrams.
 */
export function tokenize(text, { mode = 'index', useJieba = true } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const effectiveMode = mode === 'query' ? 'query' : 'index';
  const norm = text.normalize('NFKC');

  const result = [];
  const querySeen = new Set();
  const emit = (tok) => {
    if (!tok) return;
    const lower = tok.toLowerCase();
    if (!lower) return;
    if (effectiveMode === 'query') {
      if (querySeen.has(lower)) return;
      querySeen.add(lower);
    }
    result.push(lower);
  };

  const emitSpanGroup = (groupTokens) => {
    const spanSeen = new Set();
    for (const t of groupTokens) {
      if (!t) continue;
      const lower = t.toLowerCase();
      if (!lower || spanSeen.has(lower)) continue;
      spanSeen.add(lower);
      emit(lower);
    }
  };

  let residual = norm;

  // 1. URLs
  residual = residual.replace(URL_RE, (raw) => {
    const clean = stripTrailingPunct(raw);
    const group = [clean];
    try {
      const u = new URL(clean);
      if (u.hostname) {
        group.push(u.hostname);
        for (const part of u.hostname.split('.').filter(Boolean)) group.push(part);
      }
      for (const seg of u.pathname.split('/').filter(Boolean)) {
        group.push(seg);
        for (const sub of splitIdentifierParts(seg)) group.push(sub);
      }
    } catch {
      // Keep raw URL token
    }
    emitSpanGroup(group);
    return ' '.repeat(raw.length);
  });

  // 2. Protocol status codes (e.g. HTTP 405)
  residual = residual.replace(PROTO_STATUS_RE, (raw, proto, code) => {
    const p = proto.toLowerCase().startsWith('http') ? 'http' : proto.toLowerCase();
    emitSpanGroup([`${p} ${code}`, p, code]);
    return ' '.repeat(raw.length);
  });

  // 3. Semantic versions (e.g. v0.2.2-rc.1)
  residual = residual.replace(SEMVER_RE, (raw) => {
    const clean = stripTrailingPunct(raw);
    const noV = clean.replace(/^v/i, '');
    const core = noV.split(/[-+]/)[0];
    const group = [clean, noV, core];
    for (const sub of splitIdentifierParts(noV)) {
      if (/[A-Za-z]/.test(sub)) group.push(sub);
    }
    emitSpanGroup(group);
    return ' '.repeat(raw.length);
  });

  // 4. Hex codes
  residual = residual.replace(HEX_CODE_RE, (raw) => {
    emitSpanGroup([raw]);
    return ' '.repeat(raw.length);
  });

  // 5. File paths (a/b/foo-bar.mjs -> 'a/b/foo-bar.mjs', 'foo-bar.mjs', 'a', 'b', 'foo', 'bar', 'mjs')
  residual = residual.replace(FILE_PATH_RE, (raw) => {
    const clean = stripTrailingPunct(raw);
    if (!clean || isPureNumericSlash(clean) || !/[A-Za-z\u4e00-\u9fff]/.test(clean)) {
      return raw;
    }
    const slashNorm = clean.replace(/\\/g, '/').replace(/\/+/g, '/');
    const strippedRel = slashNorm.replace(/^\.\//, '');
    const group = [strippedRel];
    if (strippedRel !== slashNorm) group.push(slashNorm);

    const segments = strippedRel.split('/').filter(Boolean);
    const basename = segments[segments.length - 1];
    if (basename) group.push(basename);

    for (const seg of segments) {
      if (/^[A-Za-z]:$/.test(seg)) continue;
      if (/[\u4e00-\u9fff]/.test(seg)) {
        for (const ct of tokenizeCjkRun(seg.replace(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ''), effectiveMode, useJieba)) {
          group.push(ct);
        }
      }
      group.push(seg);
      for (const sub of splitIdentifierParts(seg)) {
        if (/^[A-Za-z0-9]+$/.test(sub)) group.push(sub);
      }
    }
    emitSpanGroup(group);
    return ' '.repeat(raw.length);
  });

  // 6. Dotted identifiers & standalone filenames (foo-bar.mjs, client.js)
  residual = residual.replace(DOTTED_IDENT_RE, (raw) => {
    const clean = stripTrailingPunct(raw);
    const group = [clean, ...splitIdentifierParts(clean)];
    emitSpanGroup(group);
    return ' '.repeat(raw.length);
  });

  // 7. Compound identifiers (camelCase, PascalCase, snake_case, kebab-case, ERR_MODULE_NOT_FOUND)
  residual = residual.replace(COMPOUND_IDENT_RE, (raw) => {
    const parts = splitIdentifierParts(raw);
    const filteredParts = effectiveMode === 'query'
      ? parts.filter((p) => !EN_QUERY_STOPWORDS.has(p.toLowerCase()))
      : parts;
    emitSpanGroup([raw, ...filteredParts]);
    return ' '.repeat(raw.length);
  });

  // 8. Remaining natural CJK runs and plain ASCII words/numbers in textual order
  const combinedLexRe = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)|([A-Za-z0-9]+)/g;
  let match;
  while ((match = combinedLexRe.exec(residual)) !== null) {
    const [, cjkRun, asciiWord] = match;
    if (cjkRun) {
      const cjkToks = tokenizeCjkRun(cjkRun, effectiveMode, useJieba);
      emitSpanGroup(cjkToks);
    } else if (asciiWord) {
      const lower = asciiWord.toLowerCase();
      if (effectiveMode === 'query' && EN_QUERY_STOPWORDS.has(lower)) continue;
      // Split mixed alpha-digit tokens like '500ms' or '256kb' into full + number + unit
      const numAlpha = lower.match(/^(\d+)([a-z]+)$/);
      if (numAlpha) {
        emitSpanGroup([lower, numAlpha[1], numAlpha[2]]);
      } else {
        emitSpanGroup([lower]);
      }
    }
  }

  return result;
}

/**
 * Character n-grams (default 3-gram) over NFKC-normalized lowercase text
 * for near-duplicate Jaccard similarity & fuzzy matching.
 */
export function charNgrams(text, n = 3) {
  if (typeof text !== 'string') return [];
  const cleaned = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const width = Math.max(1, Math.trunc(Number(n)) || 3);
  const chars = Array.from(cleaned);
  if (chars.length <= width) return [cleaned];

  const seen = new Set();
  const grams = [];
  for (let i = 0; i <= chars.length - width; i++) {
    const gram = chars.slice(i, i + width).join('');
    if (!seen.has(gram)) {
      seen.add(gram);
      grams.push(gram);
    }
  }
  return grams;
}

export default {
  hasJieba,
  splitIdentifierParts,
  extractCodeIdentifiers,
  tokenize,
  charNgrams,
};
