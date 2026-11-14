/**
 * 两段式动态注入引擎（Tier-S 静态热底座 + Tier-D 动态感知上下文）。
 *
 * 核心架构约束：
 * 1. 彻底根除历史版 `manualEvent >= 6` 饿死自动记忆（`auto:*`）的死锁 Bug：
 *    手工记忆与自动记忆不再争夺固定条数槽位，统一进入 Tier-D 经三路 RRF 按问公平召回。
 * 2. Tier-S（静态热底座，面向 System Prompt）：
 *    - 聚合 `rule`（铁律/约）+ `profile`（用户画像/人）+ 会话启动时冻结的 `state`（项目单活状态）；
 *    - 单次硬上限 `<= 600` 字符，不含动态条数统计与时间戳；
 *    - 在单个会话生命周期内逐字节严格恒定不变，100% 保护 Prefix KV Cache 击中率。
 * 3. Tier-D（动态感知上下文，面向当前步用户消息）：
 *    - 输入当前步最新用户提问，毫秒级执行三路 RRF 动态召回，装填硬上限 `<= 900` 字符；
 *    - `SessionSeen` 去重：同一会话多轮绝不重复灌入同一事实；会话 Compaction 时释放动态已见集，会话结束时彻底销毁；
 *    - 零开销准则：工具子步骤、寒暄确认、检索低置信度或提问与记忆库无关时，Tier-D 严格返回 `""`（0 字符注入）。
 * 4. 单步总注入硬上限：`tierS.length + tierD.length <= 1500` 字符。
 */

import {
  SearchIndex,
  tokenize,
  buildScopeGuard,
  cosineSimilarity,
  rrfFuse,
  matchEntitySlots,
} from './search.mjs';
import { classifyConflict } from './judge.mjs';
import { shouldDenyRecall, judgeSourceText } from './evidence-policy.mjs';
import {
  GLOBAL_SPACE_ID,
  isSubagentSession,
  isSubagentReceiptText,
  visibleSpaces,
  spaceWeight,
} from './scope.mjs';

export const TIER_S_MAX_CHARS = 600;
export const TIER_D_MAX_CHARS = 900;
export const TOTAL_INJECT_MAX_CHARS = 1500;

export const INJECT_LIMITS = Object.freeze({
  tierSMaxChars: TIER_S_MAX_CHARS,
  tierDMaxChars: TIER_D_MAX_CHARS,
  totalMaxChars: TOTAL_INJECT_MAX_CHARS,
});

// 纯寒暄、确认、单步继续口令：无实质记忆检索需求，直接走 0 字符快速通道
const TRIVIAL_UTTERANCE_RE = /^(?:你好|您好|嗨|哈喽|早上好|下午好|晚上好|谢谢|多谢|感谢|好的|好哒|好|行|可以|没问题|收到|明白|知道了|了解|嗯+|哦+|噢+|哈哈+|呵呵+|继续|接着写|往下|好的收到|收到好的|ok|okay|yes|yep|sure|thanks|thank\s+you|hi|hello|hey|ping|test|[0-9])$/i;

// 泛化高频虚词/疑问词：仅命中此类词不足以证明提问与记忆库存在实质关联
const GENERIC_QUERY_STOP = new Set([
  '什么', '怎么', '如何', '为什么', '多少', '哪个', '哪些', '哪里', '是否', '能不能', '可以', '帮我',
  '请问', '一下', '现在', '目前', '今天', '这个', '那个', '我们', '你们', '他们', '这里', '那里',
  '知道', '告诉', '说明', '介绍', '写一', '写个', '生成', '实现', '代码', '函数', '问题', '情况',
  'what', 'when', 'where', 'which', 'how', 'why', 'who', 'the', 'this', 'that', 'with', 'from', 'have',
]);

function clampBudget(val, fallback, ceiling) {
  const n = Number.isFinite(val) ? Math.max(0, Math.trunc(val)) : fallback;
  return Math.min(n, ceiling);
}

function normalizeCategoryTag(mem) {
  const cat = String(mem?.category ?? '').trim().toLowerCase();
  if (cat === 'rule' || cat === 'profile' || cat === 'state') return cat;
  const kind = String(mem?.kind ?? '').trim().toLowerCase();
  if (kind === 'promise') return 'rule';
  if (kind === 'person') return 'profile';
  return cat || 'fact';
}

function cleanOneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateSafe(text, maxLen) {
  const s = cleanOneLine(text);
  if (s.length <= maxLen) return s;
  if (maxLen <= 1) return s.slice(0, Math.max(0, maxLen));
  return `${s.slice(0, maxLen - 1)}…`;
}

/**
 * 零开销前置门禁：判断当前步是否属于工具子步骤、子代理回执或无检索价值的空/寒暄输入。
 */
export function isZeroOverheadStep(query, opts = {}) {
  if (opts.isToolSubstep === true) return { skip: true, reason: 'tool-substep' };
  if (opts.toolCallId != null && opts.toolCallId !== '') return { skip: true, reason: 'tool-substep' };
  const role = String(opts.role ?? '').trim().toLowerCase();
  if (role === 'tool' || role === 'system' || role === 'assistant') {
    return { skip: true, reason: 'non-user-role' };
  }
  const stepType = String(opts.stepType ?? '').trim().toLowerCase();
  if (stepType === 'tool' || stepType === 'tool_result' || stepType === 'tool_substep' || stepType === 'substep') {
    return { skip: true, reason: 'tool-substep' };
  }
  if (opts.skipSubagent !== false && isSubagentSession(opts)) {
    return { skip: true, reason: 'subagent-step' };
  }
  const q = String(query ?? '').trim();
  if (!q) return { skip: true, reason: 'empty-query' };
  if (isSubagentReceiptText(q)) return { skip: true, reason: 'subagent-receipt' };

  const stripped = q.replace(/[，。！？、；：,.!?;:'"“”‘’（）()\[\]【】\s]+/g, '');
  if (!stripped) return { skip: true, reason: 'empty-query' };
  if (TRIVIAL_UTTERANCE_RE.test(stripped)) return { skip: true, reason: 'trivial-utterance' };
  return { skip: false, reason: null };
}

/**
 * 单会话已见记忆集合（SessionSeen）：
 * - `staticIds`：Tier-S 静态底座已装载的记忆，Compaction 时保留（System Prompt 常驻）；
 * - `dynamicIds` & `dynamicHashes`：Tier-D 多轮动态注入过的记忆，Compaction 时清空以允许折叠后重召回。
 */
export class SessionSeen {
  #staticIds = new Set();
  #staticTexts = new Set();
  #dynamicIds = new Set();
  #dynamicTexts = new Set();

  seedStatic(items = []) {
    for (const item of items) {
      if (typeof item === 'string') {
        this.#staticIds.add(item);
      } else if (item && typeof item === 'object') {
        if (item.id) this.#staticIds.add(String(item.id));
        if (item.text) this.#staticTexts.add(cleanOneLine(item.text));
      }
    }
  }

  has(idOrMem) {
    if (typeof idOrMem === 'string') {
      return this.#staticIds.has(idOrMem) || this.#dynamicIds.has(idOrMem);
    }
    if (idOrMem && typeof idOrMem === 'object') {
      const id = String(idOrMem.id ?? '');
      if (id && (this.#staticIds.has(id) || this.#dynamicIds.has(id))) return true;
      const normText = cleanOneLine(idOrMem.text ?? '');
      if (normText && (this.#staticTexts.has(normText) || this.#dynamicTexts.has(normText))) return true;
    }
    return false;
  }

  addDynamic(idOrMem) {
    if (typeof idOrMem === 'string') {
      this.#dynamicIds.add(idOrMem);
      return;
    }
    if (idOrMem && typeof idOrMem === 'object') {
      if (idOrMem.id) this.#dynamicIds.add(String(idOrMem.id));
      const normText = cleanOneLine(idOrMem.text ?? '');
      if (normText) this.#dynamicTexts.add(normText);
    }
  }

  /** 会话发生上下文压缩（Compaction）时调用：释放动态已见集，保留 Tier-S 静态防重集。 */
  clearDynamic() {
    const cleared = this.#dynamicIds.size;
    this.#dynamicIds.clear();
    this.#dynamicTexts.clear();
    return cleared;
  }

  /** 会话结束时彻底释放。 */
  destroy() {
    this.#staticIds.clear();
    this.#staticTexts.clear();
    this.#dynamicIds.clear();
    this.#dynamicTexts.clear();
  }

  get dynamicSize() {
    return this.#dynamicIds.size;
  }

  get staticSize() {
    return this.#staticIds.size;
  }

  get size() {
    return this.#staticIds.size + this.#dynamicIds.size;
  }
}

/**
 * 构建 Tier-S（静态热底座）纯函数。
 * - 包含：`rule`（铁律/约）+ `profile`（用户画像/人）+ `state`（项目单活状态，按 slotKey 单活去重）；
 * - 绝不包含动态计数与时间戳，相同输入保证逐字节 100% 恒定；
 * - 硬上限 `<= 600` 字符。
 */
export function composeTierS(memories, opts = {}) {
  const maxChars = clampBudget(opts.maxChars, TIER_S_MAX_CHARS, TIER_S_MAX_CHARS);
  if (maxChars === 0) {
    return { text: '', chars: 0, bytes: 0, ids: [], items: [], counts: { rule: 0, profile: 0, state: 0 } };
  }

  const scopeGuard = buildScopeGuard(opts);
  const currentSpace = scopeGuard.primarySpace ?? scopeGuard.currentSpace;

  const active = (memories ?? []).filter((m) => {
    if (!m || !m.text) return false;
    if (m.status && m.status !== 'active') return false;
    const sp = String(m.spaceId ?? m.space_id ?? GLOBAL_SPACE_ID);
    if (scopeGuard.enabled && !scopeGuard.allow(sp)) return false;
    return true;
  });

  const rules = [];
  const profiles = [];
  const rawStates = [];

  for (const m of active) {
    const cat = normalizeCategoryTag(m);
    if (cat === 'rule') rules.push(m);
    else if (cat === 'profile') profiles.push(m);
    else if (cat === 'state') rawStates.push(m);
  }

  // state 按 (spaceId, slotKey) 单活收敛：取最新 updatedAt/createdAt 的唯一活跃状态
  const stateBySlot = new Map();
  for (const st of rawStates) {
    const sp = String(st.spaceId ?? st.space_id ?? GLOBAL_SPACE_ID);
    const sk = st.slotKey ?? st.slot_key ?? `anon:${st.id}`;
    const key = `${sp}::${sk}`;
    const prev = stateBySlot.get(key);
    const prevTs = Number(prev?.updatedAt ?? prev?.createdAt ?? 0);
    const curTs = Number(st.updatedAt ?? st.createdAt ?? 0);
    if (!prev || curTs >= prevTs) stateBySlot.set(key, st);
  }
  const states = [...stateBySlot.values()];

  const sortDeterministic = (arr) => arr.slice().sort((a, b) => {
    const spA = String(a.spaceId ?? a.space_id ?? GLOBAL_SPACE_ID);
    const spB = String(b.spaceId ?? b.space_id ?? GLOBAL_SPACE_ID);
    const wA = spaceWeight(spA, currentSpace);
    const wB = spaceWeight(spB, currentSpace);
    if (wB !== wA) return wB - wA;
    const impA = Number(a.importance ?? 0);
    const impB = Number(b.importance ?? 0);
    if (impB !== impA) return impB - impA;
    const cA = Number(a.createdAt ?? a.created_at ?? 0);
    const cB = Number(b.createdAt ?? b.created_at ?? 0);
    if (cA !== cB) return cA - cB;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });

  const orderedGroups = [
    { key: 'rule', label: '约', list: sortDeterministic(rules) },
    { key: 'profile', label: '人', list: sortDeterministic(profiles) },
    { key: 'state', label: '态', list: sortDeterministic(states) },
  ];

  const header = '[记忆底座]';
  if (maxChars <= header.length + 4) {
    return { text: '', chars: 0, bytes: 0, ids: [], items: [], counts: { rule: 0, profile: 0, state: 0 } };
  }

  const linesByGroup = { rule: [], profile: [], state: [] };
  const pickedItems = [];
  const counts = { rule: 0, profile: 0, state: 0 };

  const renderCandidate = () => {
    const sections = [];
    for (const g of orderedGroups) {
      const items = linesByGroup[g.key];
      if (!items.length) continue;
      sections.push(`${g.label}：${items.join('；')}`);
    }
    if (!sections.length) return '';
    return `${header}\n${sections.join('\n')}`;
  };

  // 第一轮：按轮转轮询（Round-robin）从每个非空分组选取首条最高优先级的骨干记忆，
  // 杜绝单一超长组将整个底座 600 字预算完全撑满而饿死其余重要分组（如长 rule 饿死 profile）
  const remainingListByGroup = {
    rule: orderedGroups[0].list.slice(),
    profile: orderedGroups[1].list.slice(),
    state: orderedGroups[2].list.slice(),
  };

  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const g of orderedGroups) {
      const list = remainingListByGroup[g.key];
      if (!list || !list.length) continue;
      const m = list.shift();
      const clean = cleanOneLine(m.text);
      if (!clean) continue;

      const currentRendered = renderCandidate();
      const currentLen = currentRendered ? currentRendered.length : header.length;
      const overhead = linesByGroup[g.key].length === 0 ? 4 : 1; // "\n约：" vs "；"
      const remaining = maxChars - currentLen - overhead;
      if (remaining < 6) continue;

      const piece = clean.length <= remaining ? clean : truncateSafe(clean, remaining);
      linesByGroup[g.key].push(piece);
      const trial = renderCandidate();
      if (trial.length > maxChars) {
        linesByGroup[g.key].pop();
        continue;
      }
      pickedItems.push({ id: String(m.id), text: m.text, category: g.key });
      counts[g.key] += 1;
      advanced = true;
    }
  }

  const text = renderCandidate();
  return {
    text,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    ids: pickedItems.map((x) => x.id),
    items: pickedItems,
    counts,
  };
}

/**
 * 校验单条三路 RRF 命中是否具备实质证据置信度（防止无关提问塞废话）。
 */
function isConfidentHit(hit, queryTokens, opts = {}) {
  if (!hit || !hit.text) return false;
  const routes = Array.isArray(hit.routes) ? hit.routes : ['bm25'];
  const minBm25 = opts.minBm25 ?? 1.05;
  const minPureVecScore = opts.minPureVecScore ?? 0.55;

  // 路 C（entity_slots SQL 索引/槽位图）精确命中：高置信度直接通过
  if (routes.includes('slot')) return true;

  // 路 A（BM25）命中：需达到最低 BM25 阈值，且不能仅靠泛化疑问词命中
  if (routes.includes('bm25') && Number(hit.bm25 ?? 0) >= minBm25) {
    const docToks = new Set(tokenize(hit.text).tokens);
    let substantiveOverlap = 0;
    for (const qt of queryTokens) {
      if (qt.length < 2) continue;
      if (GENERIC_QUERY_STOP.has(qt)) continue;
      if (docToks.has(qt)) substantiveOverlap += 1;
    }
    if (substantiveOverlap > 0) return true;
  }

  // 路 B（纯向量召回）：需满足较高余弦相似度以过滤全库最低噪声
  if (routes.includes('vector')) {
    const cos = Number(hit.cosScore ?? hit.vecScore ?? 0);
    if (cos >= minPureVecScore) return true;
  }

  if (Number.isFinite(opts.minRrfScore) && Number(hit.score ?? 0) >= opts.minRrfScore && routes.length >= 2) {
    return true;
  }

  return false;
}

/**
 * 两段式动态注入引擎。
 */
export class InjectionEngine {
  /** @type {Map<string, { tierS: object|null, seen: SessionSeen, createdAt: number, compactions: number }>} */
  #sessions = new Map();
  #disposed = false;
  #store = null;
  #externalIndex = null;
  #cachedIndex = null;
  #cachedKey = '';

  constructor(opts = {}) {
    this.opts = {
      tierSMaxChars: TIER_S_MAX_CHARS,
      tierDMaxChars: TIER_D_MAX_CHARS,
      totalMaxChars: TOTAL_INJECT_MAX_CHARS,
      minBm25: 1.05,
      minVecScore: 0.35,
      minPureVecScore: 0.55,
      ...opts,
    };
    if (opts.store) this.#store = opts.store;
    if (opts.searchIndex instanceof SearchIndex) this.#externalIndex = opts.searchIndex;
  }

  #ensureSession(sessionId = 'default') {
    if (this.#disposed) throw new Error('injection engine disposed');
    const sid = String(sessionId || 'default');
    let s = this.#sessions.get(sid);
    if (!s) {
      s = {
        tierS: null,
        seen: new SessionSeen(),
        createdAt: Date.now(),
        compactions: 0,
      };
      this.#sessions.set(sid, s);
    }
    return { sid, state: s };
  }

  #loadVisibleMemories(store, scopeOpts = {}) {
    if (Array.isArray(scopeOpts.memories)) return scopeOpts.memories;
    if (!store || typeof store.list !== 'function') return [];
    const scopeGuard = buildScopeGuard(scopeOpts);
    const listOpts = {
      status: 'active',
      includeText: true,
    };
    if (scopeGuard.enabled && scopeGuard.spaces && scopeGuard.spaces.length) {
      listOpts.spaces = scopeGuard.spaces;
    }
    return store.list(listOpts);
  }

  #resolveSearchIndex(store, mems, opts = {}) {
    if (opts.searchIndex instanceof SearchIndex) return opts.searchIndex;
    if (this.#externalIndex) return this.#externalIndex;
    const sig = `${mems.length}:${mems[0]?.id ?? ''}:${mems[mems.length - 1]?.id ?? ''}:${mems[mems.length - 1]?.updatedAt ?? ''}`;
    if (this.#cachedIndex && this.#cachedKey === sig) {
      return this.#cachedIndex;
    }
    const idx = new SearchIndex({
      store,
      topChapters: opts.topChapters ?? 4,
      dedupeSlotKey: false, // 交由 Tier-D 自身结合未决冲突 disputed 双侧策略精细控制
    }).addAll(mems);
    if (store && typeof store.allVectors === 'function') {
      try {
        const vecs = store.allVectors();
        if (vecs && vecs.size) idx.setVectors(vecs);
      } catch {
        // 向量未建表或为空时安全忽略
      }
    }
    this.#cachedIndex = idx;
    this.#cachedKey = sig;
    return idx;
  }

  /**
   * 获取或首次冻结指定会话的 Tier-S（静态热底座）。
   * 同一 `sessionId` 一旦生成即冻结字节，后续任意轮次调用（哪怕库已变更）均原样返回，
   * 确保 System Prompt 前缀 100% 字节恒定、KV Cache 零失效。
   */
  getTierS(ctx = {}) {
    const { state } = this.#ensureSession(ctx.sessionId);
    if (state.tierS !== null) {
      return { ...state.tierS, frozen: true };
    }

    const store = ctx.store ?? this.#store;
    const maxTierS = clampBudget(ctx.tierSMaxChars ?? this.opts.tierSMaxChars, TIER_S_MAX_CHARS, TIER_S_MAX_CHARS);
    const mems = this.#loadVisibleMemories(store, ctx);
    const built = composeTierS(mems, {
      ...ctx,
      maxChars: maxTierS,
    });

    const frozenSnap = Object.freeze({
      text: built.text,
      chars: built.chars,
      bytes: built.bytes,
      ids: Object.freeze([...built.ids]),
      counts: Object.freeze({ ...built.counts }),
    });
    state.tierS = frozenSnap;
    state.seen.seedStatic(built.items);
    return { ...frozenSnap, frozen: false };
  }

  #prepareTierD(query, ctx = {}, t0 = process.hrtime.bigint()) {
    if (this.#disposed) return { early: this.#disposedResult(t0) };
    const zeroCheck = isZeroOverheadStep(query, ctx);
    if (zeroCheck.skip) {
      return {
        early: {
          text: '',
          chars: 0,
          ids: [],
          skipped: true,
          reason: zeroCheck.reason,
          elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
        },
      };
    }

    const store = ctx.store ?? this.#store;
    const mems = this.#loadVisibleMemories(store, ctx);
    // 动态候选池：排除静态 rule / profile，但完全打通手工记忆与 auto:* 自动记忆（彻底根除 manualEvent >= 6 饿死 Bug）
    const dynamicMems = mems.filter((m) => {
      const cat = normalizeCategoryTag(m);
      return cat !== 'rule' && cat !== 'profile';
    });

    if (!dynamicMems.length && !mems.length && !(this.#externalIndex || ctx.searchIndex)) {
      return {
        early: {
          text: '',
          chars: 0,
          ids: [],
          skipped: false,
          reason: 'empty-store',
          elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
        },
      };
    }

    const { state } = this.#ensureSession(ctx.sessionId);
    const tierS = state.tierS ?? this.getTierS(ctx);

    const totalCeiling = clampBudget(
      ctx.totalMaxChars ?? this.opts.totalMaxChars,
      TOTAL_INJECT_MAX_CHARS,
      TOTAL_INJECT_MAX_CHARS,
    );
    const rawTierDBudget = clampBudget(
      ctx.tierDMaxChars ?? this.opts.tierDMaxChars,
      TIER_D_MAX_CHARS,
      TIER_D_MAX_CHARS,
    );
    const maxTierD = Math.max(0, Math.min(rawTierDBudget, totalCeiling - tierS.chars));
    if (maxTierD === 0) {
      return {
        early: {
          text: '',
          chars: 0,
          ids: [],
          skipped: true,
          reason: 'budget-exhausted',
          elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
        },
      };
    }

    const idx = this.#resolveSearchIndex(store, dynamicMems.length ? dynamicMems : mems, ctx);
    const queryTokens = tokenize(query).tokens;
    const minVecScore = ctx.minVecScore ?? this.opts.minVecScore ?? 0.35;
    return { store, mems, dynamicMems, state, maxTierD, idx, query, queryTokens, minVecScore };
  }

  #finalizeTierD(prep, hits, queryVec, ctx, t0) {
    if (this.#disposed || this.#sessions.get(String(ctx.sessionId || 'default')) !== prep.state) {
      return this.#disposedResult(t0);
    }
    const { store, dynamicMems, state, maxTierD, query, queryTokens, minVecScore } = prep;
    const scope = buildScopeGuard({ ...this.opts, ...ctx });
    // Search hits carry relevance, never authority. Read current source by id;
    // a store miss/error must not fall back to a stale external index snapshot.
    const sources = new Map((prep.mems.length || store || Array.isArray(ctx.memories)
      ? prep.mems : prep.idx.docs).map(m => [String(m.id), m]));
    const resolveSource = (id) => {
      try {
        const source = typeof store?.get === 'function' ? store.get(String(id)) : sources.get(String(id));
        if (!source || String(source.id) !== String(id) || typeof source.text !== 'string' || !source.text.trim()
          || (source.status && source.status !== 'active') || source.supersededBy
          || !scope.allow(source.spaceId ?? source.space_id ?? GLOBAL_SPACE_ID)) return null;
        return source;
      } catch { return null; }
    };
    const supports = (text) => {
      // No global slot projection: a lossy/foreign slot must not recover a
      // candidate-local denial. Narrative keyword/explanation gates still pass.
      try { return !shouldDenyRecall(judgeSourceText(query, text), null); }
      catch { return false; }
    };
    if (!hits.length) {
      return {
        text: '',
        chars: 0,
        ids: [],
        skipped: false,
        reason: 'no-hits',
        elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
      };
    }

    const cosById = new Map();
    if (queryVec && ctx.vectors instanceof Map) {
      for (const [vid, vec] of ctx.vectors.entries()) {
        cosById.set(String(vid), cosineSimilarity(queryVec, vec));
      }
    } else if (queryVec && store && typeof store.allVectors === 'function') {
      try {
        for (const [vid, vec] of store.allVectors().entries()) {
          cosById.set(String(vid), cosineSimilarity(queryVec, vec));
        }
      } catch {
        // ignore
      }
    }

    const activeBySlotKey = new Map();
    for (const m of dynamicMems) {
      const sk = m.slotKey ?? m.slot_key ?? null;
      if (!sk) continue;
      let arr = activeBySlotKey.get(sk);
      if (!arr) { arr = []; activeBySlotKey.set(sk, arr); }
      arr.push(m);
    }

    let filteredBySeen = 0;
    const confidentHits = [];
    for (const h of hits) {
      const cosScore = cosById.get(h.id) ?? (h.routes?.includes('vector') ? minVecScore : 0);
      const source = resolveSource(h.id);
      if (!source) continue;
      const enriched = { ...h, ...source, id: String(source.id), cosScore };
      if (!isConfidentHit(enriched, queryTokens, { ...this.opts, ...ctx })) continue;
      if (state.seen.has(enriched)) {
        filteredBySeen += 1;
        continue;
      }
      if (!supports(source.text)) continue;
      confidentHits.push(enriched);
    }

    if (!confidentHits.length) {
      return {
        text: '',
        chars: 0,
        ids: [],
        skipped: false,
        reason: filteredBySeen > 0 ? 'all-seen' : 'low-confidence',
        elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
      };
    }

    const header = '[相关记忆]';
    const lines = [];
    const chosenIds = [];
    const handledSlots = new Set();
    const buildText = (arr) => (arr.length ? `${header}\n${arr.join('\n')}` : '');

    for (const h of confidentHits) {
      const sk = h.slotKey ?? null;
      if (sk && handledSlots.has(sk)) continue;

      let line = `- ${cleanOneLine(h.text)}`;
      const idsToRecord = [{ id: h.id, text: h.text }];

      if (sk && activeBySlotKey.has(sk)) {
        const siblings = activeBySlotKey.get(sk).map(m => resolveSource(m.id)).filter(m => m
          && String(m.id) !== String(h.id) && !state.seen.has(m) && supports(m.text));
        if (siblings.length > 0) {
          const other = siblings[siblings.length - 1];
          const tri = classifyConflict(
            { id: other.id, text: other.text, value: other.text, at: other.createdAt, supersedes: other.supersedes },
            { id: h.id, text: h.text, value: h.text, at: h.createdAt, supersedes: h.supersedes },
            { slotKey: sk },
          );
          if (tri.type === 'disputed') {
            line = `- [冲突并存] 说法A：${cleanOneLine(other.text)} ｜ 说法B：${cleanOneLine(h.text)}`;
            idsToRecord.push({ id: String(other.id), text: other.text });
          }
        }
        handledSlots.add(sk);
      }

      const currentText = buildText(lines);
      const baseLen = currentText ? currentText.length + 1 : header.length + 1;
      const avail = maxTierD - baseLen;
      if (avail < 10) break;

      if (line.length > avail) {
        if (lines.length > 0) continue;
        // Never publish only half of a disputed pair, or mark an omitted side seen.
        if (idsToRecord.length > 1) continue;
        line = truncateSafe(line, avail);
      }

      // Formatting and truncation must not drop the only source evidence.
      if (!supports(line)) continue;
      const nextLines = [...lines, line];
      if (buildText(nextLines).length > maxTierD) continue;

      lines.push(line);
      for (const rec of idsToRecord) {
        chosenIds.push(rec.id);
        state.seen.addDynamic(rec);
      }
    }

    const finalText = buildText(lines);
    return {
      text: finalText,
      chars: finalText.length,
      ids: chosenIds,
      skipped: false,
      reason: finalText ? 'injected' : 'budget-tight',
      elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
    };
  }

  /**
   * 同步快速通道：供宿主同步 `systemPrompt.context.text(promptCtx)` 毫秒级计算 Tier-D
   * （融合 BM25 + entity_slots + 已缓存同步向量，不触发网络 I/O）。
   */
  getTierDSync(query, ctx = {}) {
    const t0 = process.hrtime.bigint();
    const prep = this.#prepareTierD(query, ctx, t0);
    if (prep.early) return prep.early;
    const { store, dynamicMems, mems, idx, minVecScore } = prep;
    const queryVec = ctx.queryVector ?? null;

    const bm25Res = idx.search(query, {
      ...this.opts,
      ...ctx,
      queryVector: queryVec,
      dedupeSlotKey: false,
      maxChars: Number.MAX_SAFE_INTEGER,
      limit: 24,
    });
    const bm25Hits = bm25Res.hits || [];
    const slotMatch = store ? matchEntitySlots(query, { ...this.opts, ...ctx, store, limit: 24 }) : { rankedIds: [] };
    const slotIds = slotMatch.rankedIds ?? [];

    if (!slotIds.length) {
      return this.#finalizeTierD(prep, bm25Hits, queryVec, ctx, t0);
    }

    const byId = new Map();
    for (const m of (dynamicMems.length ? dynamicMems : mems)) byId.set(String(m.id), m);
    const bm25ById = new Map(bm25Hits.map((h) => [String(h.id), h]));
    const rrfScores = rrfFuse([bm25Hits.map((h) => String(h.id)), slotIds.map(String)], 60);
    const slotSet = new Set(slotIds.map(String));

    const merged = [...rrfScores.entries()]
      .map(([id, rrf]) => {
        const hit = bm25ById.get(id);
        const rawMem = byId.get(id);
        const spaceId = hit?.spaceId ?? rawMem?.spaceId ?? rawMem?.space_id ?? GLOBAL_SPACE_ID;
        const w = spaceWeight(spaceId, ctx.spaceId ?? this.opts.spaceId);
        const routes = [];
        if (hit) routes.push(...(hit.routes ?? ['bm25']));
        if (slotSet.has(id) && !routes.includes('slot')) routes.push('slot');
        if (hit) {
          return { ...hit, rrf, score: rrf * w, routes };
        }
        if (!rawMem) return null;
        return {
          id,
          spaceId,
          slotKey: rawMem.slotKey ?? rawMem.slot_key ?? null,
          category: rawMem.category ?? null,
          text: rawMem.text,
          chars: rawMem.text.length,
          bm25: 0,
          rrf,
          score: rrf * w,
          routes,
          minVecScore,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || (b.bm25 ?? 0) - (a.bm25 ?? 0) || a.id.localeCompare(b.id));

    return this.#finalizeTierD(prep, merged, queryVec, ctx, t0);
  }

  /**
   * 按当前步最新用户提问计算 Tier-D（动态感知上下文）。
   * - 预算硬上限 `<= 900` 字符，且 `Tier-S + Tier-D <= 1500` 字符；
   * - 自动过滤 `SessionSeen` 已注入条目；
   * - 无关提问 / 低置信度 / 工具子步骤一律返回 `""`（0 字符）。
   */
  async getTierD(query, ctx = {}) {
    const t0 = process.hrtime.bigint();
    const prep = this.#prepareTierD(query, ctx, t0);
    if (prep.early) return prep.early;
    const { store, idx, minVecScore } = prep;

    let queryVec = ctx.queryVector ?? null;
    const embedFn = ctx.embed ?? this.opts.embed ?? null;
    if (!queryVec && typeof embedFn === 'function') {
      try {
        const rv = await embedFn([query], { dims: ctx.dims ?? this.opts.dims });
        queryVec = Array.isArray(rv) ? (rv[0] ?? null) : rv;
      } catch {
        queryVec = null;
      }
    }

    if (this.#disposed) return this.#disposedResult(t0);
    const searchRes = await idx.searchAsync(query, {
      ...this.opts,
      ...ctx,
      store,
      queryVector: queryVec,
      embed: queryVec ? async () => [queryVec] : (embedFn ?? undefined),
      vector: Boolean(queryVec || embedFn || (store && (store.vectorSearch || store.searchVectors)) || idx.hasVectors),
      minVecScore,
      dedupeSlotKey: false,
      maxChars: Number.MAX_SAFE_INTEGER,
      limit: 24,
    });

    return this.#finalizeTierD(prep, searchRes.hits, queryVec, ctx, t0);
  }

  /**
   * 统一两段式注入入口：返回冻结的 `tierS` 与按当前提问动态召回的 `tierD`。
   * 硬约束：`tierS.length <= 600`、`tierD.length <= 900`、`totalChars <= 1500`。
   */
  async inject(query, ctx = {}) {
    const tierSRes = this.getTierS(ctx);
    const tierDRes = await this.getTierD(query, ctx);
    const totalChars = tierSRes.chars + tierDRes.chars;
    return {
      sessionId: String(ctx.sessionId || 'default'),
      tierS: tierSRes.text,
      tierD: tierDRes.text,
      tierSChars: tierSRes.chars,
      tierDChars: tierDRes.chars,
      totalChars,
      withinBudget:
        tierSRes.chars <= TIER_S_MAX_CHARS &&
        tierDRes.chars <= TIER_D_MAX_CHARS &&
        totalChars <= TOTAL_INJECT_MAX_CHARS,
      frozenTierS: tierSRes.frozen,
      tierSIds: tierSRes.ids,
      tierDIds: tierDRes.ids,
      tierDReason: tierDRes.reason,
      elapsedMs: tierDRes.elapsedMs,
    };
  }

  /** 会话上下文压缩（Compaction）钩子：释放动态 SessionSeen，保持静态 Tier-S 字节恒定不变。 */
  onCompaction(sessionId = 'default') {
    const sid = String(sessionId || 'default');
    const s = this.#sessions.get(sid);
    if (!s) return { releasedDynamic: 0, tierSPreserved: false };
    const releasedDynamic = s.seen.clearDynamic();
    s.compactions += 1;
    return { releasedDynamic, tierSPreserved: s.tierS !== null, compactions: s.compactions };
  }

  compactSession(sessionId = 'default') {
    return this.onCompaction(sessionId);
  }

  /** 会话结束（End）钩子：彻底释放该会话的冻结底座与 SessionSeen 集合。 */
  onSessionEnd(sessionId = 'default') {
    const sid = String(sessionId || 'default');
    const s = this.#sessions.get(sid);
    if (!s) return false;
    s.seen.destroy();
    this.#sessions.delete(sid);
    return true;
  }

  releaseSession(sessionId = 'default') {
    return this.onSessionEnd(sessionId);
  }

  #disposedResult(t0) {
    return { text: '', chars: 0, ids: [], skipped: true, reason: 'disposed',
      elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6 };
  }

  /** Terminal teardown: release all frozen snapshots and seen sets. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const sid of this.#sessions.keys()) this.onSessionEnd(sid);
    this.#cachedIndex = null;
    this.#externalIndex = null;
    this.#store = null;
    this.#cachedKey = '';
    this.opts = {};
  }

  /** 读取会话诊断统计。 */
  sessionStats(sessionId = 'default') {
    const sid = String(sessionId || 'default');
    const s = this.#sessions.get(sid);
    if (!s) return { exists: false, tierSFrozen: false, staticSeen: 0, dynamicSeen: 0, compactions: 0 };
    return {
      exists: true,
      tierSFrozen: s.tierS !== null,
      tierSChars: s.tierS?.chars ?? 0,
      staticSeen: s.seen.staticSize,
      dynamicSeen: s.seen.dynamicSize,
      compactions: s.compactions,
    };
  }
}

export function createInjector(opts = {}) {
  return new InjectionEngine(opts);
}

export default {
  TIER_S_MAX_CHARS,
  TIER_D_MAX_CHARS,
  TOTAL_INJECT_MAX_CHARS,
  INJECT_LIMITS,
  SessionSeen,
  InjectionEngine,
  createInjector,
  composeTierS,
  isZeroOverheadStep,
};
