// 高密度原子记忆双模脱水器 (Atomic Memory Distiller)
// 职责：
//   1. 从闭合轮三元组包 [User 意图 + Tool 关键产出信号 + Assistant 最终结论] 提取 40–160 字高信息密度原子记忆。
//   2. 记忆五类法定范畴分类：rule / profile / decision / experience / state。
//   3. 单活状态槽位维护：
//      - 对 state 提取确定性 slot_key（如 active_task、work_state、board_status）。
//      - 调用 store.putState({ spaceId, slotKey, text, source, importance, reason, now }) 原地覆写并归档修订链。
//      - 对非 state（rule/profile/decision/experience）调用 store.put({ spaceId, category, text, source, ... })。
//   4. 双模驱动架构：
//      - 纯本地确定性脱水（基于规则与关键词启发式）：无网络/超时/熔断时 100% 独立稳定工作，绝不阻塞。
//      - 云端异步脱水（基于 llm-client）：使用 DeepSeek 等模型精炼，失败/超时自动回退到本地脱水，绝不抛出未捕获异常。

import { chatSafe, resolveApiKey } from './llm-client.mjs';
import { cleanTitlePrefix, redactSecrets } from './turn-collector.mjs';

export const VALID_CATEGORIES = ['rule', 'profile', 'decision', 'experience', 'state'];

/**
 * 启发式关键词词表，用于本地规则分类打分
 */
const CATEGORY_KEYWORDS = {
  rule: [
    '铁律', '规范', '约定', '必须', '严禁', '禁止', '守则', '不可', '承诺',
    '不得', '务必', '切记', '勿', '绝对不能', '红线', '不可触碰', '强制要求',
  ],
  profile: [
    '用户画像', '开发者', '偏好', '习惯', '开发环境', '操作系统', 'windows',
    'linux', 'macos', '主力语言', 'node.js', '环境配置', '本机配置', '个人习惯',
  ],
  decision: [
    '决策', '架构', '方案', '重构为', '选用', '采用', '设计为', '八表正交',
    '统一采用', '技术选型', '废弃旧', '确定采用', '架构设计', '方案确定',
  ],
  experience: [
    '踩坑', '教训', '报错', '排障', '故障', '导致', '根因', '修复为',
    '现象', 'bug', '原因在于', '经验卡', '排查发现', '问题根因', '历史教训',
  ],
  state: [
    '进度', '当前正在', '下一步', '待办', '未完成', '推进中', '任务状态',
    '状态更新', '进行中', '当前任务', '挂起', '完成度', '当前状态', '任务板',
  ],
};

/**
 * 剥离代码块尸块（``` ... ```）并压平空白
 */
export function stripCodeFences(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text.replace(/```[\s\S]*?```/g, ' [代码块已省略] ');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/**
 * 归一化原子记忆字数到 40–160 字：
 * 若不足 40 字，补充上下文补足自包含事实；若超过 160 字，智能截断到完整语义边界。
 */
export function normalizeAtomLength(text, fallbackContext = '') {
  let s = cleanTitlePrefix(stripCodeFences(text));
  if (!s) return '';

  if (s.length > 160) {
    // 尽量截断到标点符号处
    const slice = s.slice(0, 160);
    const lastPunct = Math.max(
      slice.lastIndexOf('。'),
      slice.lastIndexOf('；'),
      slice.lastIndexOf('！'),
      slice.lastIndexOf('!'),
      slice.lastIndexOf(';')
    );
    if (lastPunct >= 40) {
      s = slice.slice(0, lastPunct + 1);
    } else {
      s = slice;
    }
  }

  // 若仍不足 40 字且有 fallbackContext，尝试拼接补充上下文
  if (s.length < 40 && fallbackContext) {
    const cleanCtx = cleanTitlePrefix(stripCodeFences(fallbackContext));
    if (cleanCtx) {
      const merged = `${s}（上下文：${cleanCtx}）`;
      if (merged.length <= 160) {
        s = merged;
      } else {
        s = merged.slice(0, 160);
      }
    }
  }

  return s.trim();
}

/**
 * 基于规则的本地分类判定
 */
export function classifyCategoryByRules(text) {
  if (!text || typeof text !== 'string') return 'experience';
  const lower = text.toLowerCase();

  const scores = {
    rule: 0,
    profile: 0,
    decision: 0,
    experience: 0,
    state: 0,
  };

  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      if (lower.includes(w.toLowerCase())) {
        scores[cat] += w.length >= 3 ? 2 : 1;
      }
    }
  }

  let bestCat = 'experience';
  let maxScore = 0;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bestCat = cat;
    }
  }

  return bestCat;
}

/**
 * 从文本中推导提取单活状态槽位键 slot_key
 */
export function inferSlotKey(text, metadata = {}) {
  if (metadata.slotKey) return String(metadata.slotKey).trim();
  const raw = text || '';

  // 1. 匹配显式任务编号，如 T1..T99 或 Task T3
  const taskMatch = raw.match(/\b(?:Task\s*)?(T\d+)\b/i);
  if (taskMatch) {
    return `task:${taskMatch[1].toUpperCase()}`;
  }

  // 2. 匹配具体模块路径，如 src/store.mjs
  const fileMatch = raw.match(/\b([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\b/);
  if (fileMatch && (fileMatch[1].includes('/') || fileMatch[1].includes('\\'))) {
    return `mod:${fileMatch[1].replace(/\\/g, '/')}:state`;
  }

  // 3. 匹配常见工作区状态关键词
  if (raw.includes('任务板') || raw.includes('board')) return 'board_status';
  if (raw.includes('测试') || raw.includes('test')) return 'test_status';
  if (raw.includes('构建') || raw.includes('build')) return 'build_status';

  return 'work_state';
}

/**
 * 本地确定性规则脱水引擎（Local Deterministic Distiller）
 * 100% 离线、零网络、零外部 API，确保降级时不阻塞主流程。
 */
export function distillLocally(payload = {}) {
  const userText = stripCodeFences(payload.userText || '');
  const assistantConclusion = stripCodeFences(payload.assistantConclusion || '');
  const toolSummary = Array.isArray(payload.toolSummary) ? payload.toolSummary : [];

  const combined = [
    userText ? `用户诉求：${userText}` : '',
    toolSummary.length > 0 ? `工具执行：${toolSummary.slice(0, 3).join('; ')}` : '',
    assistantConclusion ? `结论：${assistantConclusion}` : '',
  ].filter(Boolean).join('；');

  if (!combined) return [];

  // 判断主要分类
  const candidateText = assistantConclusion || userText;
  const category = classifyCategoryByRules(candidateText);

  let prefixTag = `[${category.toUpperCase()}]`;
  if (category === 'rule') prefixTag = '[铁律]';
  else if (category === 'profile') prefixTag = '[画像]';
  else if (category === 'decision') prefixTag = '[决策]';
  else if (category === 'experience') prefixTag = '[经验]';
  else if (category === 'state') prefixTag = '[进度]';

  // 组装原子记忆文本
  let coreText = candidateText;
  // 若包含前缀标签，先清洗
  coreText = cleanTitlePrefix(coreText);
  if (!coreText.startsWith('[')) {
    coreText = `${prefixTag} ${coreText}`;
  }

  const finalAtomText = normalizeAtomLength(coreText, combined);
  if (!finalAtomText || finalAtomText.length < 15) return [];

  const item = {
    category,
    text: redactSecrets(finalAtomText),
    importance: category === 'rule' || category === 'profile' ? 0.9 : 0.7,
    reason: 'local-rule-distillation',
  };

  if (category === 'state') {
    item.slotKey = inferSlotKey(finalAtomText, payload.metadata || {});
  }

  return [item];
}

/**
 * 云端 LLM 异步精炼脱水（DeepSeek 兼容结构化提示词）
 */
const DISTILL_SYSTEM_PROMPT = `你是顶尖的 Agent 认知脱水专家。你的任务是从一轮对话的 [User 意图 + Tool 关键产出信号 + Assistant 最终结论] 中，提炼 0–3 条高密度自包含原子记忆。

五类法定分类（category 必须是以下之一）：
1. rule: 约定与规范、不可违背的铁律
2. profile: 用户环境、技术栈与长期稳定偏好
3. decision: 架构方案、代码设计与技术选型决策
4. experience: 踩坑排障教训、故障现象与根因修复
5. state: 当前未完成的任务进度与待办状态（必须提供 slot_key，如 active_task、work_state、task:T3）

硬性约束：
1. 每条记忆 text 必须控制在 40–160 个字符以内。
2. 绝对剔除代码块（禁止含有 \`\`\` 代码块尸块），保留核心结论。
3. 严格输出合法的 JSON 数组，格式形如：
[
  { "category": "decision", "text": "[决策] 采用 Schema v8 八表正交架构...", "importance": 0.8 },
  { "category": "state", "slotKey": "work_state", "text": "[进度] 完成 T3 模块编码...", "importance": 0.8 }
]
4. 若本轮无实质价值（仅是常规读取或过渡问答），返回空数组 []。不输出任何 markdown 或多余解释。`;

function buildDistillUserPrompt(payload) {
  return `请对以下闭合轮进行高密度认知脱水：
【用户意图】: ${payload.userText || '(无)'}
【工具摘要】: ${(payload.toolSummary || []).join('; ') || '(无)'}
【助手结论】: ${payload.assistantConclusion || '(无)'}

输出提炼出的原子记忆 JSON 数组：`;
}

/**
 * 解析 LLM 返回的 JSON 数组
 */
function parseLlmMemoryArray(content) {
  if (typeof content !== 'string') return null;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);

  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return null;
    const validated = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const cat = String(item.category || '').toLowerCase().trim();
      if (!VALID_CATEGORIES.includes(cat)) continue;
      const rawText = String(item.text || '').trim();
      if (!rawText) continue;

      const normText = normalizeAtomLength(rawText);
      if (!normText || normText.length < 15) continue;

      const mem = {
        category: cat,
        text: redactSecrets(normText),
        importance: Number.isFinite(item.importance) ? Math.min(1, Math.max(0, item.importance)) : 0.8,
        reason: 'llm-distillation',
      };
      if (cat === 'state') {
        mem.slotKey = String(item.slotKey || inferSlotKey(normText)).trim();
      }
      validated.push(mem);
    }
    return validated;
  } catch {
    return null;
  }
}

/**
 * 云端 LLM 异步脱水调用，失败或超时自动优雅回退本地规则脱水
 */
export async function distillWithLlm(payload = {}, opts = {}) {
  if (opts?.enabled === false) return null;
  const hasKey = Boolean(resolveApiKey(opts.apiKey));
  if (!hasKey) {
    return distillLocally(payload);
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 5000;
  try {
    const res = await chatSafe({
      model: opts.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: DISTILL_SYSTEM_PROMPT },
        { role: 'user', content: buildDistillUserPrompt(payload) },
      ],
    }, {
      timeoutMs,
      apiKey: opts.apiKey,
      apiBase: opts.apiBase,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
    });

    const content = res?.choices?.[0]?.message?.content;
    const parsed = parseLlmMemoryArray(content);
    if (parsed) return parsed;
  } catch {
    // 忽略并降级
  }

  // 优雅降级回退本地确定性脱水
  return distillLocally(payload);
}

/**
 * 统一脱水接口：根据可用密钥与选项进行脱水，永不抛出异常
 */
export async function distillTurn(payload = {}, opts = {}) {
  if (opts?.enabled === false) {
    return distillLocally(payload);
  }
  const atoms = await distillWithLlm(payload, opts);
  return Array.isArray(atoms) ? atoms : distillLocally(payload);
}

/**
 * 消费 ingest_queue 队列并持久化落地（支持纯本地确定性 / 云端异步双模）
 *
 * @param {object} params
 * @param {object} params.store 存储实例
 * @param {number} [params.limit=10] 单次消费任务上限
 * @param {object} [params.llmOpts] LLM 客户端配置
 * @param {number} [params.now] 时间戳
 * @returns {Promise<object>} 处理统计报告
 */
export async function processIngestQueue({ store, limit = 10, llmOpts = {}, now = Date.now(), signal = llmOpts.signal }) {
  if (!store || typeof store.claimIngestJobs !== 'function') {
    throw new TypeError('processIngestQueue: store 必须提供 claimIngestJobs 方法');
  }

  if (signal?.aborted) return { processed: 0, saved: 0, jobs: [] };
  const jobs = store.claimIngestJobs(limit, now);
  if (!jobs || jobs.length === 0) {
    return { processed: 0, saved: 0, jobs: [] };
  }

  const results = [];
  let savedCount = 0;

  for (const [jobIndex, job] of jobs.entries()) {
    if (signal?.aborted) {
      const remaining = jobs.slice(jobIndex);
      store.releaseIngestJobs(remaining, now);
      results.push(...remaining.map((item) => ({ jobId: item.jobId, status: 'pending', cancelled: true })));
      break;
    }
    const jobId = job.jobId;
    const spaceId = job.spaceId || 'global';
    const payload = job.payload || {};

    try {
      const atoms = await distillTurn(payload, { ...llmOpts, signal });
      // No await from this fence through the synchronous writes. Cancellation can
      // never interleave partial writes or allow a late response to touch a closed DB.
      if (signal?.aborted) {
        const remaining = jobs.slice(jobIndex);
        store.releaseIngestJobs(remaining, now);
        results.push(...remaining.map((item) => ({ jobId: item.jobId, status: 'pending', cancelled: true })));
        break;
      }
      const savedAtoms = [];

      for (const atom of atoms) {
        if (atom.category === 'state') {
          const res = store.putState({
            spaceId,
            slotKey: atom.slotKey || 'work_state',
            text: atom.text,
            source: `turn:${job.sessionId}:${job.turnNo}`,
            importance: atom.importance ?? 0.8,
            reason: atom.reason || 'distill-state-sync',
            now,
          });
          savedAtoms.push({ type: 'state', result: res, atom });
          savedCount += 1;
        } else {
          const res = store.put({
            spaceId,
            category: atom.category,
            text: atom.text,
            source: `turn:${job.sessionId}:${job.turnNo}`,
            importance: atom.importance ?? 0.7,
            now,
          });
          savedAtoms.push({ type: 'memory', result: res, atom });
          savedCount += 1;
        }
      }

      results.push({ jobId, status: 'done', savedAtoms });
    } catch (err) {
      results.push({ jobId, status: 'failed', error: err?.message || String(err) });
    }
    const outcome = results[results.length - 1];
    store.completeIngestJob(jobId, outcome.status, outcome.error ?? null, now);
  }

  return {
    processed: jobs.length,
    saved: savedCount,
    jobs: results,
  };
}

export default {
  VALID_CATEGORIES,
  stripCodeFences,
  normalizeAtomLength,
  classifyCategoryByRules,
  inferSlotKey,
  distillLocally,
  distillWithLlm,
  distillTurn,
  processIngestQueue,
};
