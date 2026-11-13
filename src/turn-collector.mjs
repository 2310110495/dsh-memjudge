// 双边闭合轮三元组收集器与清洗门禁 (Turn Collector & Ingestion Gate)
// 职责：
//   1. 收集单轮三元组：[User 意图 + Tool 关键产出信号 + Assistant 最终结论]。
//   2. 过滤与清洗门禁（无价值内容硬拦截）：
//      - 拦截纯催促短句（如“继续”、“在吗”、“好的”、“快点”等）。
//      - 拦截过渡废话播报（如“我将先检索...”、“让我来查看一下...”等过程性宣告）。
//      - 拦截子代理交差报告（如 Background subagent ... finished、Its closing message: 等）。
//      - 自动脱敏清洗：敏感凭证（API Key、Token、PAT、私钥等）脱敏为 [REDACTED_SECRET]。
//      - 修复历史 Bug：严禁截断 https?:// 完整 URL（防生成 s://...）；彻底根除“标题前置又在正文重复拼接”的格式缺陷。
//   3. 轮次闭合：在轮次结束时将清洗后的三元包压入 store.enqueueIngest({ spaceId, sessionId, turnNo, payload, now })。

// 纯催促短句正则
import { hasUnpairedSurrogate } from './text-wellformed.mjs';

/**
 * 在不破坏 UTF-16 代理对的前提下安全截断字符串
 */
export function sliceWellFormed(text, maxChars) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (!(maxChars >= 0) || s.length <= maxChars) return s;
  if (maxChars === 0) return '';
  const prev = s.charCodeAt(maxChars - 1);
  const next = s.charCodeAt(maxChars);
  const end = prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? maxChars - 1
    : maxChars;
  return s.slice(0, end);
}

const URGE_ATOM = '(?:继续执行|继续吧|继续|接着弄|搞快点|快点|快弄|快些|在吗|好的|好吧|收到|可以|行吧|行|嗯嗯|嗯|好|ok|okay|go\\s*on|continue|yes|yep|sure|proceed|next|go)';
export const URGE_REGEX = new RegExp(`^${URGE_ATOM}(?:[,，、\\s]*${URGE_ATOM})?[!！.。~～\\s]*$`, 'i');

// 过渡废话播报正则
export const FILLER_PREFIX_REGEX = /^(?:我将(?:先|开始)?|让我(?:先|来)?|正在(?:为您)?|我(?:先|先来)?|现在开始|接下来我将|马上为您)(?:检索|查看|检查|分析|运行|搜索|确认|处理|读取|执行|看一下|读一下|跑一下|梳理|浏览)[^。！？\n]*[。！？…\s]*/i;
export const FILLER_EXACT_REGEX = /^(?:我将(?:先|开始)?|让我(?:先|来)?|正在(?:为您)?|我(?:先|先来)?|现在开始|接下来我将|马上为您)(?:检索|查看|检查|分析|运行|搜索|确认|处理|读取|执行|看一下|读一下|跑一下|梳理|浏览)[^。！？\n]*[。！？…\s]*$/i;

// 子代理汇报特征正则
export const SUBAGENT_REPORT_REGEX = /(?:Background\s+subagent\s+["']?[a-zA-Z0-9_\-]+["']?\s+finished|Its\s+closing\s+message:\s*|子代理(?:执行完成|汇报完毕|已退出)|subagent\s+finished)/i;

// 敏感凭据脱敏正则
export const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g,
  /\b(?:sk-[a-zA-Z0-9_\-]{20,})\b/g,
  /\b(?:ghp_[a-zA-Z0-9]{20,40})\b/g,
  /\b(?:github_pat_[a-zA-Z0-9_]{60,})\b/g,
  /\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b/gi,
  /(?:api[_-]?key|secret|token|password|passwd|auth)\s*[:=]\s*["']?([a-zA-Z0-9_\-\.]{16,})["']?/gi,
];

/**
 * 判断文本是否属于纯催促短句
 */
export function isUrgeText(text) {
  if (!text || typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 6 && URGE_REGEX.test(trimmed)) return true;
  return URGE_REGEX.test(trimmed);
}

/**
 * 判断是否纯过渡废话播报（单句无实质产出）
 */
export function isFillerText(text) {
  if (!text || typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return FILLER_EXACT_REGEX.test(trimmed);
}

/**
 * 判断是否子代理交差汇报
 */
export function isSubagentReport(text) {
  if (!text || typeof text !== 'string') return false;
  return SUBAGENT_REPORT_REGEX.test(text);
}

/**
 * 敏感凭证脱敏
 */
export function redactSecrets(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text;
  s = s.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g, '[REDACTED_SECRET]');
  s = s.replace(/\b(?:sk-[a-zA-Z0-9_\-]{20,})\b/g, '[REDACTED_SECRET]');
  s = s.replace(/\b(?:ghp_[a-zA-Z0-9]{20,})\b/g, '[REDACTED_SECRET]');
  s = s.replace(/\b(?:github_pat_[a-zA-Z0-9_]{60,})\b/g, '[REDACTED_SECRET]');
  s = s.replace(/\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b/gi, 'Bearer [REDACTED_SECRET]');
  s = s.replace(/((?:api[_-]?key|secret|token|password|passwd|auth)\s*[:=]\s*["']?)([a-zA-Z0-9_\-\.]{16,})(["']?)/gi, '$1[REDACTED_SECRET]$3');
  return s;
}

/**
 * 彻底根除“标题前置又在正文重复拼接”的格式缺陷
 * 例如："[决策|v2] [决策|v2] 采用v8架构" -> "[决策|v2] 采用v8架构"
 *      "[架构决策] 架构决策：采用v8" -> "[架构决策] 采用v8"
 */
export function cleanTitlePrefix(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text.trim();

  // 1. 合并连续完全相同的方括号/中文括号前缀标签
  // 例如 [tag] [tag] 或 【tag】 【tag】
  s = s.replace(/^(\[[^\]]+\])\s*\1+/g, '$1');
  s = s.replace(/^(【[^】]+】)\s*\1+/g, '$1');

  // 2. 根除标签前置后紧接着在正文重复拼接相同短语
  // 例如 "[决策] 决策：" 或 "【铁律】 铁律:"
  const bracketMatch = s.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (bracketMatch) {
    const tag = bracketMatch[1].trim();
    let rest = bracketMatch[2].trim();
    const tagPrefixPattern = new RegExp(`^(?:${escapeRegex(tag)}|${escapeRegex(tag.split(/[|/:-]/)[0])})\\s*[:：]\\s*`, 'i');
    if (tagPrefixPattern.test(rest)) {
      rest = rest.replace(tagPrefixPattern, '');
      s = `[${tag}] ${rest}`;
    }
  }

  return s;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 保护 URL 完整性清洗：
 * 绝不允许截断 https?://，避免出现 s://... 等畸形 URL。
 * 剥除无关 markdown 代码块、思考链 <think>...</think>，保留核心事实。
 */
export function sanitizeTurnText(text, isAssistant = false) {
  if (!text || typeof text !== 'string') return '';
  if (hasUnpairedSurrogate(text)) return '';
  let s = text;

  // 剥除思考链标签与内部思考过程
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // 助手结论如果以过渡废话开头且后面有实质内容，剥除开头过渡废话
  if (isAssistant) {
    s = s.replace(FILLER_PREFIX_REGEX, '');
  }

  // 脱敏凭证
  s = redactSecrets(s);

  // 消除重复标题前缀
  s = cleanTitlePrefix(s);

  return s.trim();
}

/**
 * 结构化压缩工具调用摘要（保留最多 8 条核心动作，绝不把上千行代码或日志原样塞入）
 */
export function sanitizeToolSummary(rawSummary, onInvalidText = null) {
  if (!rawSummary) return [];
  const list = Array.isArray(rawSummary) ? rawSummary : [rawSummary];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    let line = '';
    if (typeof item === 'string') {
      if (hasUnpairedSurrogate(item)) {
        if (typeof onInvalidText === 'function') onInvalidText('unpaired-surrogate');
        continue;
      }
      line = item.trim();
    } else if (typeof item === 'object') {
      const name = String(item.name || item.tool || 'tool');
      const status = item.ok === false || item.exitCode ? `exit ${item.exitCode || 1}` : 'ok';
      const desc = String(item.desc || item.action || item.input?.description || '');
      if (hasUnpairedSurrogate(name) || hasUnpairedSurrogate(desc)) {
        if (typeof onInvalidText === 'function') onInvalidText('unpaired-surrogate');
        continue;
      }
      line = desc ? `${name}: ${desc} (${status})` : `${name} (${status})`;
    }
    if (line) {
      line = redactSecrets(line);
      out.push(sliceWellFormed(line, 160));
    }
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 综合门禁判定：决定当前轮次是否应该被过滤拦截
 */
export function shouldFilterTurn({ userText, assistantConclusion, toolSummary = [], origin = '' }) {
  // 1. origin 为 subagent 时硬拦截
  if (origin === 'subagent') {
    return { filter: true, reason: 'subagent_origin' };
  }

  // 2. 命中子代理交差报告特征
  if (isSubagentReport(userText) || isSubagentReport(assistantConclusion)) {
    return { filter: true, reason: 'subagent_closing_report' };
  }

  // 3. 用户为纯催促短句且无实质工具产出信号
  const hasToolSignal = Array.isArray(toolSummary) && toolSummary.length > 0;
  if (isUrgeText(userText) && !hasToolSignal) {
    return { filter: true, reason: 'urge_text_without_tools' };
  }

  // 4. 助手为纯过渡废话宣告且无实质工具产出
  if (isFillerText(assistantConclusion) && !hasToolSignal) {
    return { filter: true, reason: 'filler_without_tools' };
  }

  // 5. 极短且空洞（用户与助手都几乎无内容）
  const cleanU = (userText || '').trim();
  const cleanA = (assistantConclusion || '').trim();
  if (cleanU.length < 3 && cleanA.length < 3 && !hasToolSignal) {
    return { filter: true, reason: 'empty_turn' };
  }

  return { filter: false, reason: null };
}

/**
 * 创建闭合轮三元组收集器
 */
export function createTurnCollector(opts = {}) {
  const store = opts.store ?? null;
  let currentSpaceId = opts.spaceId || 'global';
  let currentSessionId = opts.sessionId || 'default';
  let currentTurnNo = Number.isSafeInteger(opts.turnNo) ? opts.turnNo : 0;
  let currentOrigin = opts.origin || '';

  let userText = '';
  let toolEvents = [];
  let assistantConclusion = '';

  return {
    get spaceId() { return currentSpaceId; },
    set spaceId(val) { currentSpaceId = val || 'global'; },
    get sessionId() { return currentSessionId; },
    set sessionId(val) { currentSessionId = val || 'default'; },
    get turnNo() { return currentTurnNo; },
    set turnNo(val) { currentTurnNo = Number(val) || 0; },
    get origin() { return currentOrigin; },
    set origin(val) { currentOrigin = val || ''; },

    recordUser(text) {
      userText = typeof text === 'string' ? text : String(text ?? '');
      return userText;
    },

    recordTool(toolName, input = {}, output = {}, isOk = true) {
      let rawName = toolName;
      let desc = '';
      let okFlag = isOk;
      if (toolName && typeof toolName === 'object' && !Array.isArray(toolName)) {
        rawName = toolName.tool ?? toolName.name ?? 'tool';
        desc = toolName.summary ?? toolName.desc ?? toolName.description ?? '';
        if (toolName.ok !== undefined) okFlag = toolName.ok;
        else if (toolName.exitCode !== undefined) okFlag = Number(toolName.exitCode) === 0;
      } else {
        if (typeof input === 'string') desc = input;
        else if (input?.description) desc = input.description;
        else if (input?.file_path) desc = input.file_path;
        else if (input?.command) desc = input.command;
      }

      const nameStr = String(rawName || 'tool');
      const descStr = String(desc);
      if (hasUnpairedSurrogate(nameStr) || hasUnpairedSurrogate(descStr)) {
        if (typeof opts.onInvalidText === 'function') opts.onInvalidText('unpaired-surrogate');
        return toolEvents.length;
      }

      toolEvents.push({
        name: nameStr,
        desc: sliceWellFormed(descStr, 100),
        ok: Boolean(okFlag),
      });
      return toolEvents.length;
    },

    recordAssistant(text) {
      assistantConclusion = typeof text === 'string' ? text : String(text ?? '');
      return assistantConclusion;
    },

    /**
     * 闭合当前轮次：
     * 执行门禁过滤与脱敏清洗，若有效则压入 store.enqueueIngest。
     */
    closeTurn(closeOpts = {}) {
      const targetStore = closeOpts.store || store;
      const spaceId = closeOpts.spaceId || currentSpaceId;
      const sessionId = closeOpts.sessionId || currentSessionId;
      const turnNo = Number.isSafeInteger(closeOpts.turnNo) ? closeOpts.turnNo : currentTurnNo;
      const origin = closeOpts.origin || currentOrigin;
      const now = Number.isFinite(closeOpts.now) ? closeOpts.now : Date.now();
      const onInvalidText = closeOpts.onInvalidText || opts.onInvalidText || null;

      const rawUser = closeOpts.userText !== undefined ? closeOpts.userText : userText;
      const rawTools = closeOpts.toolSummary !== undefined ? closeOpts.toolSummary : toolEvents;
      const rawAssistant = closeOpts.assistantConclusion !== undefined ? closeOpts.assistantConclusion : assistantConclusion;

      const badUser = typeof rawUser === 'string' && hasUnpairedSurrogate(rawUser);
      const badAssistant = typeof rawAssistant === 'string' && hasUnpairedSurrogate(rawAssistant);
      if (badUser && typeof onInvalidText === 'function') onInvalidText('unpaired-surrogate');
      if (badAssistant && typeof onInvalidText === 'function') onInvalidText('unpaired-surrogate');

      const safeRawUser = badUser ? '' : rawUser;
      const safeRawAssistant = badAssistant ? '' : rawAssistant;
      const toolSummary = sanitizeToolSummary(rawTools, onInvalidText);

      if ((badUser || badAssistant) && !safeRawUser && !safeRawAssistant && toolSummary.length === 0) {
        userText = '';
        toolEvents = [];
        assistantConclusion = '';
        return {
          enqueued: false,
          filtered: true,
          reason: 'unpaired-surrogate',
          spaceId,
          sessionId,
          turnNo,
        };
      }

      const gate = shouldFilterTurn({
        userText: safeRawUser,
        assistantConclusion: safeRawAssistant,
        toolSummary,
        origin,
      });

      if (gate.filter) {
        return {
          enqueued: false,
          filtered: true,
          reason: gate.reason,
          spaceId,
          sessionId,
          turnNo,
        };
      }

      const cleanUser = sanitizeTurnText(safeRawUser, false);
      const cleanAssistant = sanitizeTurnText(safeRawAssistant, true);

      const payload = {
        userText: cleanUser,
        toolSummary,
        assistantConclusion: cleanAssistant,
        spaceId,
        sessionId,
        turnNo,
        timestamp: now,
      };

      let enqueueResult = null;
      if (targetStore && typeof targetStore.enqueueIngest === 'function') {
        enqueueResult = targetStore.enqueueIngest({
          spaceId,
          sessionId,
          turnNo,
          payload,
          now,
        });
      }

      // 递增轮次并清理本轮内存缓冲
      currentTurnNo = turnNo + 1;
      userText = '';
      toolEvents = [];
      assistantConclusion = '';

      const enqueued = Boolean(enqueueResult?.enqueued ?? true);
      return {
        enqueued,
        queued: enqueued,
        filtered: false,
        jobId: enqueueResult?.jobId ?? null,
        payload,
      };
    },

    reset() {
      userText = '';
      toolEvents = [];
      assistantConclusion = '';
    },
  };
}

export default {
  URGE_REGEX,
  FILLER_PREFIX_REGEX,
  FILLER_EXACT_REGEX,
  SUBAGENT_REPORT_REGEX,
  SECRET_PATTERNS,
  isUrgeText,
  isFillerText,
  isSubagentReport,
  redactSecrets,
  cleanTitlePrefix,
  sanitizeTurnText,
  sanitizeToolSummary,
  shouldFilterTurn,
  createTurnCollector,
};
