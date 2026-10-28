// 统一 chat 调用器：所有走 OpenAI 兼容 /chat/completions 的模块共用这一条路径。
//
// 为什么必须有它：端点原本在 llm-extract / llm-select / query-expand 里各写死一份
// siliconflow 常量，只有 rpc 的 testKey 走 llmBaseUrl()。结果是面板「接口与模型」里
// 改了 baseUrl，密钥测试走新端点、五项增强却仍打硅基流动——换任何非硅基供应商的用户，
// 增强能力（向量、重排、查询扩展、LLM 选段、LLM 提取）全部静默失效。
//
// 三条约定：
//   1. 端点只由 llmBaseUrl() 拼，密钥只由 llmKey() 读，模型由 chatModel() 定；
//      不另立第二套配置读取路径（与 rpc.mjs 的 testKey 同源）。
//   2. 超时 / abort / HTTP 非 2xx 一律原样上抛，由调用方决定怎么降级——这里不吞错、
//      不把失败改写成成功；只负责把「失败」变成一个调用方认得出的错误。
//   3. 端点与模型在**每次调用时**求值，不在模块加载时固化：面板改完 config.json
//      调 reloadConfig() 后立即生效，不需要重启进程。

import { chatModel, llmBaseUrl, llmKey } from './config.mjs';

/** 默认超时：与三个模块此前的 TIMEOUT_MS 一致（长 prompt 批量提取实测需要这么久）。 */
export const CHAT_TIMEOUT_MS = 150_000;

/** 端点：单一来源，末尾斜杠已由 llmBaseUrl() 剥掉。 */
export function chatEndpoint() {
  return `${llmBaseUrl()}/chat/completions`;
}

/**
 * 模型解析：调用方显式传的优先（评测可指定具体模型），否则用配置里的 chatModel()。
 * 内置常量不再是权威来源——用户换供应商时模型名必须跟着面板走。
 */
export function resolveModel(explicit) {
  const m = typeof explicit === 'string' ? explicit.trim() : '';
  return m || chatModel();
}

/** 非 2xx：带 status 的错误，让调用方能区分「超时」与「服务端拒绝」。 */
export class ChatHttpError extends Error {
  constructor(status, body) {
    super(`http ${status || 'error'}`);
    this.name = 'ChatHttpError';
    this.status = status || 0;
    // 服务端原文只用作诊断，可能是很长的 HTML；截断到 400 字再挂上去
    this.body = String(body ?? '').slice(0, 400);
  }
}

/**
 * 发一次 chat 请求，返回解析后的 JSON。
 *
 * @param {object} payload  请求体（model / messages / temperature / max_tokens / stream …）
 * @param {{timeoutMs?:number, signal?:AbortSignal, fetchImpl?:Function, apiKey?:string}} [opts]
 *   timeoutMs  自定义超时；默认 CHAT_TIMEOUT_MS。rpc 的密钥测试这类场景需要更短的（8s）。
 *   signal     调用方自己的取消信号，与内部超时信号并联，任一触发即 abort。
 *   fetchImpl  注入点：单测用它做零网络验证，不传则用 globalThis.fetch。
 *   apiKey     默认 llmKey()；密钥测试要验「用户刚输入的 key」时才显式传。
 * @returns {Promise<any>} 响应 JSON
 * @throws {ChatHttpError} 非 2xx；其它错误（超时 abort / 网络 / JSON 解析）原样透传
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
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey : llmKey();
  const outer = opts.signal ?? null;

  const ctrl = new AbortController();
  // 外层信号并联而不是替换：调用方在工作流取消时要能立刻停掉在飞的请求
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(chatEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res || !res.ok) {
      // 读 error body 只作诊断；注入的假响应可能没有 text()，失败就当空串
      let body = '';
      if (typeof res?.text === 'function') {
        try { body = await res.text(); } catch { body = ''; }
      }
      throw new ChatHttpError(Number(res?.status) || 0, body);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  }
}

export default { chat, chatEndpoint, resolveModel, CHAT_TIMEOUT_MS };
