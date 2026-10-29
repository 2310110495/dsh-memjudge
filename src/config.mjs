// 用户配置层：让插件在别人机器上也能用，而不是把作者的环境变量一起打包。
//
// 三层优先级（高 → 低）：
//   1. process.env      进程环境（CI / 临时覆盖 / 容器注入）
//   2. secrets.json     密钥，单独文件，chmod 600，不进 git、不进 config
//   3. config.json      非敏感开关（模型名、端点、模块开关）
//
// 为什么密钥不写进 config.json：那个文件是给人看、给人复制、可能被贴进 issue 的。
// secrets.json 名字本身就是警告，且 tools/panel 只显示掩码。
//
// 三组独立凭据（chat / embed / rerank）：对话模型、向量模型、重排模型可以来自三家不同
// 供应商——「A 家的对话模型 + B 家的向量模型 + C 家的重排模型」是真实需求。每组各有
// 自己的 baseUrl / key / model，互不串用。
//
// 向后兼容（硬要求，老安装不许炸）：
//   - secrets.json 旧形状 {llmKey} 读时视为 chatKey；新写入用 {chatKey, embedKey, rerankKey}。
//   - 旧 env MEMJUDGE_LLM_KEY / MEMJUDGE_LLM_BASE_URL 视为 chat 组的值。
//   - config.json 旧键 baseUrl 视为 chatBaseUrl。
//   - embed / rerank 未单独配置时**继承 chat 组**的 baseUrl 与 key：老用户一个 key、
//     一个端点，升级后行为不变。继承是显式的（inherited: true），不会被当成用户显式设置。

import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
export const STATE_DIR = join(HOME, 'memjudge');
export const CONFIG_PATH = join(STATE_DIR, 'config.json');
export const SECRETS_PATH = join(STATE_DIR, 'secrets.json');

function readJson(path) {
  try {
    if (!existsSync(path)) return {};
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** 库体展示上限的默认值。200KB 只够 SPEC 的验收语料，真实库要大得多。 */
export const DEFAULT_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024;
/** 写入闸门默认值：0 = 不设硬限（要「写满即拒」得用户显式填）。 */
export const DEFAULT_MAX_CHARS = 0;

// ── 自动记忆（auto-capture）的配置键 ────────────────────────────────────────
// 真源 docs/auto-capture-spec.md §6.1（采集默认开、注入可见性跟随 autoInject）
// 与 §6.3（配置键）。走与本文件其它项同一条三级优先级：env > config.json > 默认。
// 五项全部只有「行为」含义，不锁定任何能力，所以不进 FLAG_ENV/SETTING_ENV 的
// 面板锁表——那两个表是给「面板输入框要不要置灰」用的。

export const AUTO_CAPTURE_DEFAULTS = Object.freeze({
  /** 采集总开关。默认开：默认关等于没做（spec §6.1）。 */
  autoCapture: true,
  /** G2 最小长度。 */
  autoCaptureMinChars: 12,
  /** G3 最大长度。超长整条丢弃，绝不截断。 */
  autoCaptureMaxChars: 600,
  /** G6 单会话累计上限。 */
  autoCaptureLimitPerSession: 40,
  /** G6 单轮上限。 */
  autoCapturePerTurn: 2,
  /** G5 近重复阈值。 */
  autoCaptureDupThreshold: 0.85,
});

/** 配置键 → 环境变量。一个键一个变量，别名问题不在这里造。 */
export const AUTO_CAPTURE_ENV = Object.freeze({
  autoCapture: 'MEMJUDGE_AUTO_CAPTURE',
  autoCaptureMinChars: 'MEMJUDGE_AUTO_CAPTURE_MIN_CHARS',
  autoCaptureMaxChars: 'MEMJUDGE_AUTO_CAPTURE_MAX_CHARS',
  autoCaptureLimitPerSession: 'MEMJUDGE_AUTO_CAPTURE_MAX_PER_SESSION',
  autoCapturePerTurn: 'MEMJUDGE_AUTO_CAPTURE_MAX_PER_TURN',
  autoCaptureDupThreshold: 'MEMJUDGE_AUTO_CAPTURE_DUP_THRESHOLD',
});

function clampRange(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 五项自动记忆配置的三级解析。非法值一律回落默认，不抛错（与 resolveConfig 同一条
 * 「插件装不上比参数被钳更糟」的规矩）。
 *
 * @param {object} [cfg] config.json 的内容
 * @param {object} [env] 环境变量表，缺省 process.env（测试注入点）
 */
export function resolveAutoCapture(cfg, env = process.env) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const read = env && typeof env === 'object' ? env : {};

  const enabledOf = () => {
    const e = read[AUTO_CAPTURE_ENV.autoCapture];
    if (e === '1' || e === 'true') return true;
    if (e === '0' || e === 'false') return false;
    if (src.autoCapture === false) return false;
    return AUTO_CAPTURE_DEFAULTS.autoCapture;
  };

  const numOf = (key, lo, hi, trunc) => {
    const e = read[AUTO_CAPTURE_ENV[key]];
    const raw = e !== undefined && e !== '' ? e : src[key];
    const value = clampRange(raw, lo, hi, AUTO_CAPTURE_DEFAULTS[key]);
    return trunc ? Math.trunc(value) : value;
  };

  return {
    autoCapture: enabledOf(),
    autoCaptureMinChars: numOf('autoCaptureMinChars', 4, 200, true),
    autoCaptureMaxChars: numOf('autoCaptureMaxChars', 12, 20000, true),
    autoCaptureLimitPerSession: numOf('autoCaptureLimitPerSession', 1, 200, true),
    autoCapturePerTurn: numOf('autoCapturePerTurn', 1, 20, true),
    autoCaptureDupThreshold: numOf('autoCaptureDupThreshold', 0.5, 1, false),
  };
}

/** 正整数清洗：非法/非正 → 默认值。用于上限这类「0 无意义」的字段。 */
function posInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

/** 非负整数清洗：非法/负数 → 默认值。0 是合法值（= 不设限）。 */
function nonNegInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

// ── 三组凭据的键名表 ───────────────────────────────────────────────────────

/** 组名：面板展示顺序即此顺序。 */
export const CRED_GROUPS = Object.freeze(['chat', 'embed', 'rerank']);

/** 出厂端点：只作最后一层兜底，不是权威来源。 */
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';

/**
 * 一组三项的键名映射。
 *   baseUrlKey/modelKey  config.json 里的非敏感键
 *   secretKey            secrets.json 里的键
 *   baseUrlEnv/modelEnv/keyEnv  环境变量名，数组顺序即优先级（chat 组末尾是升级兼容的旧名）
 */
const GROUP_SPEC = {
  chat: {
    baseUrlKey: 'chatBaseUrl',
    modelKey: 'chatModel',
    secretKey: 'chatKey',
    baseUrlEnv: ['MEMJUDGE_CHAT_BASE_URL', 'MEMJUDGE_LLM_BASE_URL'],
    modelEnv: ['MEMJUDGE_CHAT_MODEL'],
    keyEnv: ['MEMJUDGE_CHAT_KEY', 'MEMJUDGE_LLM_KEY'],
    modelDefault: 'deepseek-ai/DeepSeek-V4-Flash',
  },
  embed: {
    baseUrlKey: 'embedBaseUrl',
    modelKey: 'embedModel',
    secretKey: 'embedKey',
    baseUrlEnv: ['MEMJUDGE_EMBED_BASE_URL'],
    modelEnv: ['MEMJUDGE_EMBED_MODEL'],
    keyEnv: ['MEMJUDGE_EMBED_KEY'],
    modelDefault: 'Qwen/Qwen3-Embedding-8B',
  },
  rerank: {
    baseUrlKey: 'rerankBaseUrl',
    modelKey: 'rerankModel',
    secretKey: 'rerankKey',
    baseUrlEnv: ['MEMJUDGE_RERANK_BASE_URL'],
    modelEnv: ['MEMJUDGE_RERANK_MODEL'],
    keyEnv: ['MEMJUDGE_RERANK_KEY'],
    modelDefault: 'Qwen/Qwen3-Reranker-8B',
  },
};

/** config.json 的旧键：单 baseUrl 时代只有它，读时算 chat 组（写只用新键）。 */
const LEGACY_CONFIG_BASE_URL_KEY = 'baseUrl';
/** secrets.json 的旧键：单 key 时代只有它，读时算 chat 组（写只用新键）。 */
const LEGACY_SECRET_KEY = 'llmKey';

/** 组名归一：非法/缺省 → chat（旧调用不传组也照常工作）。 */
export function normalizeGroup(group) {
  const g = String(group ?? '').trim().toLowerCase();
  return CRED_GROUPS.includes(g) ? g : 'chat';
}

/** 环境变量按优先级取第一个非空值。 */
function envFirst(names) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== '') return { value: String(v).trim(), envName: name };
  }
  return null;
}

const stripSlash = (s) => String(s).replace(/\/+$/, '');
const asText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/**
 * 一组的 baseUrl。顺序：本组 env > config.json 本组键 >（chat：旧键 baseUrl）
 * >（embed/rerank：继承 chat 生效值）> 出厂默认。
 */
function resolveBaseUrl(group, cfg, resolved) {
  const spec = GROUP_SPEC[group];
  const env = envFirst(spec.baseUrlEnv);
  if (env) return { value: stripSlash(env.value), source: 'env', envName: env.envName, inherited: false };
  const own = asText(cfg[spec.baseUrlKey]);
  if (own) return { value: stripSlash(own), source: 'config', configKey: spec.baseUrlKey, inherited: false };
  if (group === 'chat') {
    const legacy = asText(cfg[LEGACY_CONFIG_BASE_URL_KEY]);
    if (legacy) {
      return { value: stripSlash(legacy), source: 'config', configKey: LEGACY_CONFIG_BASE_URL_KEY, inherited: false };
    }
    return { value: DEFAULT_BASE_URL, source: 'default', inherited: false };
  }
  // 未独立配置 → 继承 chat 组：老用户只有一个 baseUrl 时，三项仍指向同一个网关
  const from = resolved.chat.baseUrl;
  return { value: from.value, source: 'inherit', inheritedFrom: 'chat', inherited: true };
}

/**
 * 一组的 key。顺序：本组 env > secrets.json 本组键 >（chat：旧键 llmKey）
 * >（embed/rerank：继承 chat 生效值）> 空串（= 未配置）。
 * MEMJUDGE_NO_SECRETS=1 时整份 secrets.json 视为空（测试隔离用），env 仍然生效。
 */
function resolveKey(group, secrets, resolved) {
  const spec = GROUP_SPEC[group];
  const env = envFirst(spec.keyEnv);
  if (env) return { value: env.value, source: 'env', envName: env.envName, inherited: false };
  const own = asText(secrets[spec.secretKey]);
  if (own) return { value: own, source: 'secrets.json', secretKey: spec.secretKey, inherited: false };
  if (group === 'chat') {
    const legacy = asText(secrets[LEGACY_SECRET_KEY]);
    if (legacy) return { value: legacy, source: 'secrets.json', secretKey: LEGACY_SECRET_KEY, inherited: false };
    return { value: '', source: 'none', inherited: false };
  }
  const from = resolved.chat.key;
  if (!from.value) return { value: '', source: 'none', inherited: false };
  return { value: from.value, source: 'inherit', inheritedFrom: 'chat', inherited: true };
}

/** 一组的模型名。不继承 chat：三组的模型名语义不同，套用 chatModel 必炸远端。 */
function resolveModelName(group, cfg) {
  const spec = GROUP_SPEC[group];
  const env = envFirst(spec.modelEnv);
  if (env) return { value: env.value, source: 'env', envName: env.envName, inherited: false };
  const own = asText(cfg[spec.modelKey]);
  if (own) return { value: own, source: 'config', configKey: spec.modelKey, inherited: false };
  return { value: spec.modelDefault, source: 'default', inherited: false };
}

let cache = null;

/**
 * 影响解析结果的环境变量名（三组的端点/模型/密钥 + 测试隔离开关 + 三个数值项）。
 * 为什么要签名：调用方与单测会在进程运行中途改 process.env 并期待立刻生效——
 * 原实现里密钥就是每次实时读 env 的，这个语义不能因为进了缓存就变味。
 * 文件（config.json / secrets.json）不走签名：写入方自己清缓存，外部改动仍需 reloadConfig()。
 */
const ENV_SIG_NAMES = (() => {
  const names = new Set([
    'MEMJUDGE_NO_SECRETS',
    'MEMJUDGE_EMBED_DIMS',
    'MEMJUDGE_STORAGE_LIMIT_BYTES',
    'MEMJUDGE_MAX_CHARS',
  ]);
  for (const spec of Object.values(GROUP_SPEC)) {
    for (const n of spec.baseUrlEnv) names.add(n);
    for (const n of spec.modelEnv) names.add(n);
    for (const n of spec.keyEnv) names.add(n);
  }
  return [...names].sort();
})();

function envSignature() {
  let sig = '';
  for (const name of ENV_SIG_NAMES) {
    const v = process.env[name];
    sig += `${name}=${v == null ? '\u0001' : v}\u0000`;
  }
  return sig;
}

function load() {
  const sig = envSignature();
  if (cache && cache.envSig === sig) return cache;
  const cfg = readJson(CONFIG_PATH);
  // 测试隔离：测试进程不想读用户的 secrets.json 时置 1
  const sec = process.env.MEMJUDGE_NO_SECRETS === '1' ? {} : readJson(SECRETS_PATH);
  const groups = {};
  // chat 必须最先解：embed / rerank 的继承源是它的**生效值**（可能来自 env / 旧键 / 默认）
  for (const group of CRED_GROUPS) {
    groups[group] = {
      baseUrl: resolveBaseUrl(group, cfg, groups),
      key: resolveKey(group, sec, groups),
      model: resolveModelName(group, cfg),
    };
  }
  cache = {
    envSig: sig,
    config: cfg,
    secrets: sec,
    groups,
    dims: Number(process.env.MEMJUDGE_EMBED_DIMS || cfg.dims || 64) || 64,
    // 存储上限两个字段与模型名同一条三来源优先级：env > config.json > 默认
    storageLimitBytes: posInt(process.env.MEMJUDGE_STORAGE_LIMIT_BYTES || cfg.storageLimitBytes, DEFAULT_STORAGE_LIMIT_BYTES),
    maxChars: nonNegInt(process.env.MEMJUDGE_MAX_CHARS || cfg.maxChars, DEFAULT_MAX_CHARS),
    // 自动记忆五项：同一条三级优先级（env > config.json > 默认），在 load 里算一次，
    // 面板与 pre-step 读的是同一份值，不各算一遍。
    autoCapture: resolveAutoCapture(cfg, process.env),
  };
  return cache;
}

/** 配置改过之后必须调它，否则进程内一直用旧值。 */
export function reloadConfig() {
  cache = null;
}

/**
 * 测试钩子：不碰真实 secrets.json，overrides 优先级最高。传 null 清除。
 * 第二参数指定组（缺省 chat），便于单测分别注入三家的 key。
 */
const keyOverrides = new Map();
export function _setKeyOverride(v, group = 'chat') {
  const g = normalizeGroup(group);
  if (v == null) keyOverrides.delete(g);
  else keyOverrides.set(g, String(v));
}
/** 测试钩子：清空全部组的内存覆盖。 */
export function _clearKeyOverrides() {
  keyOverrides.clear();
}

function groupOf(group) {
  return load().groups[normalizeGroup(group)];
}

function keyOf(group) {
  const g = normalizeGroup(group);
  if (keyOverrides.has(g)) return keyOverrides.get(g);
  return groupOf(g).key.value;
}

/** chat 组密钥（旧名 llmKey 的同义词）。 */
export function llmKey() { return keyOf('chat'); }
export function chatKey() { return keyOf('chat'); }
export function embedKey() { return keyOf('embed'); }
export function rerankKey() { return keyOf('rerank'); }

export function hasLlmKey() { return llmKey() !== ''; }
export function hasChatKey() { return chatKey() !== ''; }
export function hasEmbedKey() { return embedKey() !== ''; }
export function hasRerankKey() { return rerankKey() !== ''; }

/** 掩码：只露前 4 后 4，长度也不透露真实位数。 */
export function maskKey(k = llmKey()) {
  if (!k) return '';
  if (k.length <= 10) return '*'.repeat(k.length);
  return `${k.slice(0, 4)}${'*'.repeat(8)}${k.slice(-4)}`;
}

/** 密钥来源，用于面板区分「自己的」和「环境里别人的」。缺省组 = chat（旧调用语义）。 */
export function keySource(group = 'chat') {
  return groupOf(group).key.source;
}

/** chat 组端点（旧名 llmBaseUrl 的同义词）。 */
export function llmBaseUrl() { return groupOf('chat').baseUrl.value; }
export function chatBaseUrl() { return groupOf('chat').baseUrl.value; }
export function embedBaseUrl() { return groupOf('embed').baseUrl.value; }
export function rerankBaseUrl() { return groupOf('rerank').baseUrl.value; }
export function chatModel() { return groupOf('chat').model.value; }
export function embedModel() { return groupOf('embed').model.value; }
export function rerankModel() { return groupOf('rerank').model.value; }
export function embedDims() { return load().dims; }
/** 库体上限（字节）：只用于展示与验收判定，不是写入闸门。 */
export function storageLimitBytes() { return load().storageLimitBytes; }
/** 写入闸门（字符）：0 = 不设硬限；>0 时超限抛 BUDGET_EXCEEDED，不截断。 */
export function maxChars() { return load().maxChars; }
export function rawConfig() { return load().config; }

/**
 * 一组的完整状态快照：生效值 + 来源 + 是否继承。只给掩码，绝不给明文 key。
 * 面板据此把「你自己的配置」「继承 chat 的」「被 env 钉死的」三种情形分开显示。
 */
export function groupReport(group) {
  const g = normalizeGroup(group);
  const grp = groupOf(g);
  const keyValue = keyOf(g);
  const keySourceValue = keyOverrides.has(g) ? 'override' : grp.key.source;
  return {
    baseUrl: grp.baseUrl.value,
    baseUrlSource: grp.baseUrl.source,           // env | config | inherit | default
    baseUrlInherited: grp.baseUrl.inherited === true,
    baseUrlEnv: grp.baseUrl.envName ?? null,
    model: grp.model.value,
    modelSource: grp.model.source,               // env | config | default
    modelEnv: grp.model.envName ?? null,
    keyConfigured: keyValue !== '',
    keyMasked: maskKey(keyValue),
    keySource: keySourceValue,                   // env | secrets.json | inherit | override | none
    keyInherited: grp.key.inherited === true,
    keyEnvLocked: envFirst(GROUP_SPEC[g].keyEnv) !== null,
  };
}

/** 三组的键名表：面板渲染输入框时用，避免 UI 里再抄一份键名。 */
export function credSpec() {
  const out = {};
  for (const group of CRED_GROUPS) {
    const spec = GROUP_SPEC[group];
    out[group] = {
      baseUrlKey: spec.baseUrlKey,
      modelKey: spec.modelKey,
      secretKey: spec.secretKey,
      modelDefault: spec.modelDefault,
      baseUrlEnv: spec.baseUrlEnv.slice(),
      modelEnv: spec.modelEnv.slice(),
      keyEnv: spec.keyEnv.slice(),
    };
  }
  return out;
}

/** 写非敏感配置（合并）。 */
export function saveConfig(patch) {
  mkdirSync(STATE_DIR, { recursive: true });
  const cur = readJson(CONFIG_PATH);
  const next = { ...cur, ...(patch || {}) };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cache = null;
  return next;
}

/**
 * 写一组的密钥。单独文件 + 600，注释写明不要提交。
 * 新写入一律用 {chatKey, embedKey, rerankKey}；文件里若有旧键 llmKey，
 * 先迁移成 chatKey 再删旧键——否则「清空 chat key 后旧值复活」。
 */
export function saveKey(group, key) {
  const g = normalizeGroup(group);
  const spec = GROUP_SPEC[g];
  mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...readJson(SECRETS_PATH) };
  if (Object.prototype.hasOwnProperty.call(next, LEGACY_SECRET_KEY)) {
    const legacy = asText(next[LEGACY_SECRET_KEY]);
    if (legacy && !asText(next.chatKey)) next.chatKey = legacy;
    delete next[LEGACY_SECRET_KEY];
  }
  const k = String(key || '').trim();
  next[spec.secretKey] = k;
  writeFileSync(SECRETS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try { chmodSync(SECRETS_PATH, 0o600); } catch { /* Windows 上 chmod 是空操作 */ }
  keyOverrides.delete(g);
  cache = null;
  return k !== '';
}

/** 旧签名：写 chat 组密钥。保留给既有调用方与脚本。 */
export function saveLlmKey(key) {
  return saveKey('chat', key);
}

/** 五个可配模块 → 对应环境变量。开判定与锁判定共用这张表，避免两处各写一份而漂移。 */
export const FLAG_ENV = {
  vector: 'MEMJUDGE_VECTOR',
  rerank: 'MEMJUDGE_RERANK',
  expand: 'MEMJUDGE_EXPAND',
  llmSelect: 'MEMJUDGE_LLMSELECT',
  llmExtract: 'MEMJUDGE_LLMEXTRACT',
};

/**
 * 哪些开关被环境变量钉死：env 里是 '1' 或 '0' 时 `on()` 先取 env，写 config.json 不生效。
 * 面板必须能说出这句事实，否则用户只看到「点了开关、重拉还是关的」。
 */
export function envLockedFlags() {
  const out = {};
  for (const [flag, envName] of Object.entries(FLAG_ENV)) {
    const e = process.env[envName];
    out[flag] = e === '1' || e === '0';
  }
  return out;
}

/**
 * 九项值型设置 → 环境变量名（数组 = 多个别名，顺序即优先级）。
 * 九项与 RPC saveSettings 的白名单一一对应——同一张表，避免两处各写一份而漂移。
 */
export const SETTING_ENV = {
  chatBaseUrl: ['MEMJUDGE_CHAT_BASE_URL', 'MEMJUDGE_LLM_BASE_URL'],
  chatModel: ['MEMJUDGE_CHAT_MODEL'],
  embedBaseUrl: ['MEMJUDGE_EMBED_BASE_URL'],
  embedModel: ['MEMJUDGE_EMBED_MODEL'],
  rerankBaseUrl: ['MEMJUDGE_RERANK_BASE_URL'],
  rerankModel: ['MEMJUDGE_RERANK_MODEL'],
  dims: ['MEMJUDGE_EMBED_DIMS'],
  storageLimitBytes: ['MEMJUDGE_STORAGE_LIMIT_BYTES'],
  maxChars: ['MEMJUDGE_MAX_CHARS'],
};

/**
 * 哪些设置项被环境变量锁住。面板写了一圈发现「重拉还是旧值」时，靠它解释原因。
 * 与 envLockedFlags() 分开：那个是五键布尔开关的形状，这个是九项值型设置，
 * 混进同一对象会让前端对「开关」与「输入框」的渲染分支失配。
 *
 * 注意「继承」不算锁：embedBaseUrl 继承 chat 的值时不标锁——用户写 embedBaseUrl
 * 立刻覆盖继承，写是有效的。只有本组自己的 env 才把这个输入框钉住。
 */
export function envLockedSettings() {
  const out = {};
  for (const [key, names] of Object.entries(SETTING_ENV)) {
    out[key] = envFirst(names) !== null;
  }
  return out;
}

/** 模块开关：env 覆盖 config，两者都没有就关。零收益的模块默认不进默认路径。 */
export function moduleFlags() {
  const { config } = load();
  const on = (flag) => {
    const e = process.env[FLAG_ENV[flag]];
    if (e === '1') return true;
    if (e === '0') return false;
    return config?.[flag] === true;
  };
  return {
    // 四个检索增强模块需要 key，没 key 时强制关（否则每次调用都在等超时）
    // 各模块看自己那组的 key：向量要 embed、重排要 rerank、其余走 chat
    vector: hasEmbedKey() && on('vector'),
    rerank: hasRerankKey() && on('rerank'),
    expand: hasChatKey() && on('expand'),
    llmSelect: hasChatKey() && on('llmSelect'),
    // LLM 提取层是离线重建，不挂在查询路径上，有无 key 都如实报告
    llmExtract: hasChatKey() && on('llmExtract'),
    jieba: process.env.MEMJUDGE_NO_JIEBA !== '1',
  };
}

/** 面板要显示的一条诊断。 */
export function configReport() {
  const flags = moduleFlags();
  const chat = groupReport('chat');
  const embed = groupReport('embed');
  const rerank = groupReport('rerank');
  const chatHasKey = chat.keyConfigured;
  return {
    configPath: CONFIG_PATH,
    secretsPath: SECRETS_PATH,
    // 三个旧字段就是 chat 组：面板脚本与 index.mjs 的旧读法仍然成立
    hasKey: chatHasKey,
    keySource: chat.keySource,
    keyMasked: chat.keyMasked,
    baseUrl: chat.baseUrl,
    chatModel: chat.model,
    embedModel: embed.model,
    rerankModel: rerank.model,
    dims: embedDims(),
    storageLimitBytes: storageLimitBytes(),
    maxChars: maxChars(),
    // 三组各自的完整状态（掩码 + 来源 + 是否继承）
    groups: { chat, embed, rerank },
    credSpec: credSpec(),
    flags,
    // 哪些 flag 由 MEMJUDGE_* 环境变量决定（写 config.json 无效）
    envLocked: envLockedFlags(),
    // 值型设置（模型名/端点/上限）同理：面板据此把被锁的输入框置灰并说清原因
    envLockedSettings: envLockedSettings(),
    // 别人拿到插件时最需要看到的一句
    hint: chatHasKey
      ? (chat.keySource === 'env'
        ? '当前密钥来自环境变量（可能是别人注入的），换机器需自己配置'
        : 'chat 组密钥来自 secrets.json，属于本机')
      : '未配置 chat 组密钥：检索走纯 BM25，查询扩展、LLM 选段、LLM 提取停用；向量与重排各自还需要 embed / rerank 组的密钥。',
  };
}
