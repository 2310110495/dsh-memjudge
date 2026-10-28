// 用户配置层：让插件在别人机器上也能用，而不是把作者的环境变量一起打包。
//
// 三层优先级（高 → 低）：
//   1. process.env      进程环境（CI / 临时覆盖 / 容器注入）
//   2. secrets.json     密钥，单独文件，chmod 600，不进 git、不进 config
//   3. config.json      非敏感开关（模型名、端点、模块开关）
//
// 为什么密钥不写进 config.json：那个文件是给人看、给人复制、可能被贴进 issue 的。
// secrets.json 名字本身就是警告，且 tools/panel 只显示掩码。

import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

let cache = null;
function load() {
  if (cache) return cache;
  const cfg = readJson(CONFIG_PATH);
  const sec = readJson(SECRETS_PATH);
  cache = {
    config: cfg,
    secrets: sec,
    // 端点：env > config > SiliconFlow 默认
    baseUrl: String(process.env.MEMJUDGE_LLM_BASE_URL || cfg.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, ''),
    chatModel: String(process.env.MEMJUDGE_CHAT_MODEL || cfg.chatModel || 'deepseek-ai/DeepSeek-V4-Flash'),
    embedModel: String(process.env.MEMJUDGE_EMBED_MODEL || cfg.embedModel || 'Qwen/Qwen3-Embedding-8B'),
    rerankModel: String(process.env.MEMJUDGE_RERANK_MODEL || cfg.rerankModel || 'Qwen/Qwen3-Reranker-8B'),
    dims: Number(process.env.MEMJUDGE_EMBED_DIMS || cfg.dims || 64) || 64,
    // 存储上限两个字段与模型名同一条三来源优先级：env > config.json > 默认
    storageLimitBytes: posInt(process.env.MEMJUDGE_STORAGE_LIMIT_BYTES || cfg.storageLimitBytes, DEFAULT_STORAGE_LIMIT_BYTES),
    maxChars: nonNegInt(process.env.MEMJUDGE_MAX_CHARS || cfg.maxChars, DEFAULT_MAX_CHARS),
  };
  return cache;
}

/** 配置改过之后必须调它，否则进程内一直用旧值。 */
export function reloadConfig() {
  cache = null;
}

/** 测试钩子：不碰真实 secrets.json，overrides 优先级最高。传 null 清除。 */
let keyOverride = null;
export function _setKeyOverride(v) {
  keyOverride = v == null ? null : String(v);
}

/** 密钥：env 优先，其次 secrets.json。空串表示未配置。 */
export function llmKey() {
  if (keyOverride !== null) return keyOverride;
  const env = process.env.MEMJUDGE_LLM_KEY;
  if (env && env.trim()) return env.trim();
  // 测试隔离：测试进程不想读用户的 secrets.json 时置 1
  if (process.env.MEMJUDGE_NO_SECRETS === '1') return '';
  const { secrets } = load();
  const k = secrets.llmKey;
  return typeof k === 'string' && k.trim() ? k.trim() : '';
}

export function hasLlmKey() {
  return llmKey() !== '';
}

/** 掩码：只露前 4 后 4，长度也不透露真实位数。 */
export function maskKey(k = llmKey()) {
  if (!k) return '';
  if (k.length <= 10) return '*'.repeat(k.length);
  return `${k.slice(0, 4)}${'*'.repeat(8)}${k.slice(-4)}`;
}

/** 密钥来源，用于面板区分「自己的」和「环境里别人的」。 */
export function keySource() {
  if (process.env.MEMJUDGE_LLM_KEY && process.env.MEMJUDGE_LLM_KEY.trim()) return 'env';
  if (process.env.MEMJUDGE_NO_SECRETS === '1') return 'none';
  const { secrets } = load();
  if (typeof secrets.llmKey === 'string' && secrets.llmKey.trim()) return 'secrets.json';
  return 'none';
}

export function llmBaseUrl() { return load().baseUrl; }
export function chatModel() { return load().chatModel; }
export function embedModel() { return load().embedModel; }
export function rerankModel() { return load().rerankModel; }
export function embedDims() { return load().dims; }
/** 库体上限（字节）：只用于展示与验收判定，不是写入闸门。 */
export function storageLimitBytes() { return load().storageLimitBytes; }
/** 写入闸门（字符）：0 = 不设硬限；>0 时超限抛 BUDGET_EXCEEDED，不截断。 */
export function maxChars() { return load().maxChars; }
export function rawConfig() { return load().config; }

/** 写非敏感配置（合并）。 */
export function saveConfig(patch) {
  mkdirSync(STATE_DIR, { recursive: true });
  const cur = readJson(CONFIG_PATH);
  const next = { ...cur, ...(patch || {}) };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cache = null;
  return next;
}

/** 写密钥。单独文件 + 600，注释写明不要提交。 */
export function saveLlmKey(key) {
  mkdirSync(STATE_DIR, { recursive: true });
  const cur = readJson(SECRETS_PATH);
  const k = String(key || '').trim();
  const next = { ...cur, llmKey: k };
  writeFileSync(SECRETS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try { chmodSync(SECRETS_PATH, 0o600); } catch { /* Windows 上 chmod 是空操作 */ }
  cache = null;
  return k !== '';
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
 * 哪些「值型」设置被环境变量钉死：env 非空时 load() 先取 env，写 config.json 不生效。
 * 七项与 RPC saveSettings 的白名单一一对应——同一张表，避免两处各写一份而漂移。
 */
export const SETTING_ENV = {
  baseUrl: 'MEMJUDGE_LLM_BASE_URL',
  chatModel: 'MEMJUDGE_CHAT_MODEL',
  embedModel: 'MEMJUDGE_EMBED_MODEL',
  rerankModel: 'MEMJUDGE_RERANK_MODEL',
  dims: 'MEMJUDGE_EMBED_DIMS',
  storageLimitBytes: 'MEMJUDGE_STORAGE_LIMIT_BYTES',
  maxChars: 'MEMJUDGE_MAX_CHARS',
};

/**
 * 哪些设置项被环境变量锁住。面板写了一圈发现「重拉还是旧值」时，靠它解释原因。
 * 与 envLockedFlags() 分开：那个是五键布尔开关的形状，这个是七项值型设置，
 * 混进同一对象会让前端对「开关」与「输入框」的渲染分支失配。
 */
export function envLockedSettings() {
  const out = {};
  for (const [key, envName] of Object.entries(SETTING_ENV)) {
    const e = process.env[envName];
    out[key] = e != null && String(e).trim() !== '';
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
    vector: hasLlmKey() && on('vector'),
    rerank: hasLlmKey() && on('rerank'),
    expand: hasLlmKey() && on('expand'),
    llmSelect: hasLlmKey() && on('llmSelect'),
    // LLM 提取层是离线重建，不挂在查询路径上，有无 key 都如实报告
    llmExtract: hasLlmKey() && on('llmExtract'),
    jieba: process.env.MEMJUDGE_NO_JIEBA !== '1',
  };
}

/** 面板要显示的一条诊断。 */
export function configReport() {
  const flags = moduleFlags();
  const src = keySource();
  return {
    configPath: CONFIG_PATH,
    secretsPath: SECRETS_PATH,
    hasKey: hasLlmKey(),
    keySource: src,
    keyMasked: maskKey(),
    baseUrl: llmBaseUrl(),
    chatModel: chatModel(),
    embedModel: embedModel(),
    rerankModel: rerankModel(),
    dims: embedDims(),
    storageLimitBytes: storageLimitBytes(),
    maxChars: maxChars(),
    flags,
    // 哪些 flag 由 MEMJUDGE_* 环境变量决定（写 config.json 无效）
    envLocked: envLockedFlags(),
    // 值型设置（模型名/端点/上限）同理：面板据此把被锁的输入框置灰并说清原因
    envLockedSettings: envLockedSettings(),
    // 别人拿到插件时最需要看到的一句
    hint: hasLlmKey()
      ? (src === 'env' ? '当前密钥来自环境变量（可能是别人注入的），换机器需自己配置' : '密钥来自 secrets.json，属于本机')
      : '未配置密钥：检索走纯 BM25，向量、重排、查询扩展、LLM 选段、LLM 提取五项增强全部停用。',
  };
}
