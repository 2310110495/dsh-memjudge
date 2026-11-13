// 统一 chat 调用器：所有走 OpenAI / DeepSeek 兼容 /chat/completions 的模块共用。
// 零外部重依赖，基于 Node.js 内置 fetch 与 AbortController 实现。
//
// 契约保证：
//   1. chat(payload, opts)：完整透传响应或抛出 ChatHttpError / Timeout 错误（供底层重试或精细判断）。
//   2. chatSafe(payload, opts)：静默降级包装，带严格超时（默认 5000ms），失败/超时返回 null，不阻断主流程。
//   3. 支持从 config/secrets.json 或环境变量（DEEPSEEK_API_KEY / MEMJUDGE_CHAT_KEY 等）自适应解析端点与密钥。

import fs from 'node:fs';
import { chatBaseUrl, chatKey, chatModel, groupReport, secretsFilePath } from './config.mjs';

/** 长提取默认超时 */
export const CHAT_TIMEOUT_MS = 150_000;
/** 快速异步任务/蒸馏默认超时：5000ms */
export const DEFAULT_FAST_TIMEOUT_MS = 5000;

/** 非 2xx 响应错误，携带状态码与响应体切片 */
export class ChatHttpError extends Error {
  constructor(status, body) {
    super(`http ${status || 'error'}`);
    this.name = 'ChatHttpError';
    this.status = status || 0;
    this.body = String(body ?? '').slice(0, 400);
  }
}

/**
 * 尝试直接读取 secrets.json（当 config 未缓存或在独立测试场景下作为安全兜底）
 */
function readDirectSecrets() {
  if (process.env.MEMJUDGE_NO_SECRETS === '1') return {};
  const p = secretsFilePath();
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    }
  } catch {
    // 读失败静默忽略
  }
  return {};
}

/**
 * 解析 API Key：
 * 显式传参 > 环境变量 (DEEPSEEK_API_KEY / MEMJUDGE_CHAT_KEY / MEMJUDGE_LLM_KEY) > config.chatKey() > secrets.json
 */
export function resolveApiKey(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim();
  }
  const envKey = (
    process.env.DEEPSEEK_API_KEY ||
    process.env.MEMJUDGE_CHAT_KEY ||
    process.env.MEMJUDGE_LLM_KEY ||
    ''
  ).trim();
  if (envKey) return envKey;

  try {
    const k = chatKey();
    if (k && typeof k === 'string' && k.trim()) return k.trim();
  } catch {
    // 忽略
  }

  const direct = readDirectSecrets();
  const fileKey = direct.chatKey || direct.llmKey || direct.apiKey || '';
  return typeof fileKey === 'string' ? fileKey.trim() : '';
}

/**
 * 解析 API Base：
 * 显式传参 > 环境变量 (DEEPSEEK_BASE_URL / MEMJUDGE_CHAT_BASE_URL / MEMJUDGE_LLM_BASE_URL) > config.chatBaseUrl()
 */
export function resolveApiBase(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim().replace(/\/+$/, '');
  }
  const envBase = (
    process.env.DEEPSEEK_BASE_URL ||
    process.env.MEMJUDGE_CHAT_BASE_URL ||
    process.env.MEMJUDGE_LLM_BASE_URL ||
    ''
  ).trim();
  if (envBase) return envBase.replace(/\/+$/, '');

  try {
    const b = chatBaseUrl();
    if (b && typeof b === 'string' && b.trim()) return b.trim().replace(/\/+$/, '');
  } catch {
    // 忽略
  }
  return 'https://api.deepseek.com';
}

/**
 * 端点计算：默认追加 /chat/completions（若 base 已带 /chat/completions 则不重复拼）
 */
export function chatEndpoint(explicitBase) {
  const base = resolveApiBase(explicitBase);
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

/**
 * 解析模型名：显式优先，次之配置 chatModel()，默认 'deepseek-chat'
 */
export function resolveModel(explicit) {
  const m = typeof explicit === 'string' ? explicit.trim() : '';
  if (m) return m;
  try {
    const confModel = chatModel();
    if (confModel && typeof confModel === 'string' && confModel.trim()) {
      return confModel.trim();
    }
  } catch {
    // 忽略
  }
  return 'deepseek-chat';
}

/**
 * 发送一次 chat 请求，返回解析后的 JSON。
 *
 * @param {object} payload 请求体
 * @param {object} [opts] 参数选项
 * @returns {Promise<any>}
 */
export async function chat(payload, opts = {}) {
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const err = new Error('fetch unavailable');
    err.code = 'NO_FETCH';
    throw err;
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.trunc(opts.timeoutMs)
    : CHAT_TIMEOUT_MS;
  const apiKey = resolveApiKey(opts.apiKey);
  const outer = opts.signal ?? null;

  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const endpoint = chatEndpoint(opts.apiBase);
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...payload,
        model: resolveModel(payload?.model),
      }),
      signal: ctrl.signal,
    };

    try {
      const rep = groupReport('chat');
      if (rep && rep.enabled === false) {
        const err = new Error('chat disabled');
        err.code = 'DISABLED';
        throw err;
      }
    } catch (e) {
      if (e?.code === 'DISABLED') throw e;
    }

    // Race the complete fetch/body operation, not just fetch's cooperative signal.
    // A mock/provider ignoring abort may settle later, but cannot hold teardown open.
    ctrl.signal.throwIfAborted();
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(ctrl.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      ctrl.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([aborted, (async () => {
        const res = await fetchImpl(endpoint, init);
        ctrl.signal.throwIfAborted();
        if (!res || !res.ok) {
          let body = '';
          if (typeof res?.text === 'function') {
            try { body = await res.text(); } catch { body = ''; }
          }
          ctrl.signal.throwIfAborted();
          throw new ChatHttpError(Number(res?.status) || 0, body);
        }
        const json = await res.json();
        ctrl.signal.throwIfAborted();
        return json;
      })()]);
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
    }
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * 静默降级的 Chat 调用，超时或出错返回 null，绝不抛出未捕获异常。
 *
 * @param {object} payload 请求体
 * @param {object} [opts] 参数选项（默认 5000ms 超时）
 * @returns {Promise<any|null>} 成功返回响应 JSON，失败/超时返回 null
 */
export async function chatSafe(payload, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.trunc(opts.timeoutMs)
    : DEFAULT_FAST_TIMEOUT_MS;
  try {
    return await chat(payload, { ...opts, timeoutMs });
  } catch (err) {
    return null;
  }
}

export default {
  chat,
  chatSafe,
  chatEndpoint,
  resolveModel,
  resolveApiKey,
  resolveApiBase,
  ChatHttpError,
  CHAT_TIMEOUT_MS,
  DEFAULT_FAST_TIMEOUT_MS,
};
