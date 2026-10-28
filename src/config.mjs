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
  };
  return cache;
}

/** 配置改过之后必须调它，否则进程内一直用旧值。 */
export function reloadConfig() {
  cache = null;
}

/** 密钥：env 优先，其次 secrets.json。空串表示未配置。 */
export function llmKey() {
  const env = process.env.MEMJUDGE_LLM_KEY;
  if (env && env.trim()) return env.trim();
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
  const { secrets } = load();
  if (typeof secrets.llmKey === 'string' && secrets.llmKey.trim()) return 'secrets.json';
  return 'none';
}

export function llmBaseUrl() { return load().baseUrl; }
export function chatModel() { return load().chatModel; }
export function embedModel() { return load().embedModel; }
export function rerankModel() { return load().rerankModel; }
export function embedDims() { return load().dims; }
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

/** 模块开关：env 覆盖 config，两者都没有就关。零收益的模块默认不进默认路径。 */
export function moduleFlags() {
  const { config } = load();
  const on = (envName, cfgName) => {
    const e = process.env[envName];
    if (e === '1') return true;
    if (e === '0') return false;
    return config?.[cfgName] === true;
  };
  return {
    // 四个检索增强模块需要 key，没 key 时强制关（否则每次调用都在等超时）
    vector: hasLlmKey() && on('MEMJUDGE_VECTOR', 'vector'),
    rerank: hasLlmKey() && on('MEMJUDGE_RERANK', 'rerank'),
    expand: hasLlmKey() && on('MEMJUDGE_EXPAND', 'expand'),
    llmSelect: hasLlmKey() && on('MEMJUDGE_LLMSELECT', 'llmSelect'),
    // LLM 提取层是离线重建，不挂在查询路径上，有无 key 都如实报告
    llmExtract: hasLlmKey() && on('MEMJUDGE_LLMEXTRACT', 'llmExtract'),
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
    flags,
    // 别人拿到插件时最需要看到的一句
    hint: hasLlmKey()
      ? (src === 'env' ? '当前密钥来自环境变量（可能是别人注入的），换机器需自己配置' : '密钥来自 secrets.json，属于本机')
      : '未配置密钥：检索走纯 BM25，向量/重排/LLM 提取全部停用。填自己的 key 见 secrets.json',
  };
}
