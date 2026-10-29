// memjudge — DSH 记忆插件外壳：apply(ctx) + 5 个工具 + 1 个注入 section。
//
// 三条宿主实测约束决定了这里的形状（mem-eval/reports/host-verify.txt）：
//
//   1. 工具名与 prompt section 名共用 NamedEntries 语义，重名直接抛错，且抛错的
//      插件**整条不激活**（@deepseek-ai/dsh-scope/lib/index.js:29 的 insert）。
//      所以工具名一律 memjudge_ 前缀：memory_read / memory_search / memory_save /
//      memory_list 被 annkun 灵枢、soul-md、meow 三方争抢，memory 被
//      LittleBlackTong 与 sage-mem 争抢。memjudge_* 在 24 个候选插件里零占用。
//
//   2. 注入是相加的，宿主没有总预算也没有去重。所以默认关闭（0 字符），开启时
//      硬钳 2000 字符（SPEC 能力 8），且只注入索引不注入全文。
//
//   3. 卸载靠 disposer 幂等。所有 register()/section() 的返回值都收进 disposers，
//      由 ctx.effect 的清理函数逆序调用一次，最后关库。
//
// 零运行时依赖：只用 node:sqlite / node:fs / node:path，可直接
// `dsh plugin --profile <p> add file:<本目录>` 安装，不需要 peerDependencies。

import { homedir } from 'node:os';
import path from 'node:path';

import { open as openStore } from './store.mjs';
import { SearchIndex } from './search.mjs';
import { embed as embedVec, vecStats } from './vector.mjs';
import { gate, resolveConflict } from './judge.mjs';
import {
  renderRecall,
  sleepPhase,
  conflictJudgments,
  // wiki 编译层（T8-1）：投影只在内存，落盘只有 meta 两个键。
  compileWiki,
  diffWiki,
  groundingViolations,
  rawDigest,
  WIKI_VERSION,
} from './layer.mjs';
import {
  configReport,
  STATE_DIR,
  embedDims,
  maxChars as configuredMaxChars,
  storageLimitBytes as configuredStorageLimitBytes,
  // 自动记忆的五项配置走 config.mjs 的三级解析（env > config.json > 默认）。
  resolveAutoCapture,
} from './config.mjs';
import {
  // 采集判定内核（纯函数，fail-open）：本文件只做「读 decision → 写库」的旁路。
  createQuota,
  extractCandidates,
  formatSource,
  resolveAutoConfig,
} from './auto-capture.mjs';
import { installMemjudgeRpc } from './rpc.mjs';

/** Cordis 插件名（profile 里 `- id: memjudge` 的默认 name）。 */
export const name = 'memjudge';

/** 需要宿主注入的服务。缺 tools 或 systemPrompt 时 apply 不会被调用。 */
export const inject = ['tools', 'systemPrompt', 'connection'];

/** 注入 section 名。带冒号前缀，与 soul-md 的 `soul:*`、宿主的 `dsh:*` 同风格。 */
export const SECTION_NAME = 'memjudge:recall';

/** 排在宿主基础 section 之后、工具说明之前。 */
export const SECTION_ORDER = 700;

/** SPEC 能力 8 的硬上限。配置传更大也钳到这里。 */
export const INJECT_HARD_LIMIT = 2000;

/** 5 个工具名。测试与文档共用这一份真源。 */
export const TOOL_NAMES = Object.freeze([
  'memjudge_remember',
  'memjudge_recall',
  'memjudge_forget',
  'memjudge_conflicts',
  'memjudge_stats',
]);

/** 向量维度：跟随用户配置（config.mjs 的 dims，默认 64）。
 *  64 与 128 在 92 题召回、12 题综合上完全同分（91/92、0.792），但 64 维打包落盘
 *  只 +16KB（188416 B），128 维要 +31KB 顶穿 199680 的验收线——所以默认压在 64。
 *  必须是函数：面板改了 dims 之后同一个进程里要立刻按新维度读向量块，
 *  否则 allVectors 会拿旧维度的块当有效数据。 */
const vecDims = () => embedDims();

export const DEFAULTS = Object.freeze({
  /** 空串 = <DSH_HOME|~/.dsh>/memjudge/memjudge.db。绝不写用户主 profile 之外的位置。 */
  dbPath: '',
  /** 固定注入开关。默认关：能力 8 的 0 字符是优点，不是缺陷。 */
  autoInject: false,
  /** 单次注入字符上限，1..2000。 */
  injectBudget: INJECT_HARD_LIMIT,
  /** 衰减半衰期（天）。挂 lastAccessed，不是 createdAt。 */
  halfLifeDays: 30,
  /** 衰减地板。0 = 严格按 schema.decayFactor（能力 12 要求 30 天 ≤0.25）。 */
  decayFloor: 0,
  /** 检索命中即刷新 lastAccessed（「被用即刷新」）。 */
  touchOnRecall: true,
  /** 注入索引最多列几条。 */
  injectLimit: 8,
  /** 融合检索（BM25 + 向量 RRF）。默认关：开启需要 key 与 32s 首次 embed，
   *  测试与离线场景必须走纯 BM25。env MEMJUDGE_VECTOR=1 打开。 */
  vector: process.env.MEMJUDGE_VECTOR === '1',
  /** 查询扩展：LLM 把长问句拆成子查询分别检索。不落盘、不占库体；MEMJUDGE_EXPAND=1 打开。 */
  expand: process.env.MEMJUDGE_EXPAND === '1',
  /** LLM 在环选段：把候选段原文交给 chat 模型挑能回答的段。MEMJUDGE_LLMSELECT=1 打开。 */
  llmSelect: process.env.MEMJUDGE_LLMSELECT === '1',
  /** 向量缓存目录，null = <dbPath 同级>/.vec-cache。 */
  vectorCacheDir: '',
});

// ---------------------------------------------------------------- 配置

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function clampNum(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 归一化配置。非法值一律回落到默认，不抛错——插件装不上比参数被钳更糟。
 * @param {object} [raw]
 */
export function resolveConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    dbPath: typeof src.dbPath === 'string' && src.dbPath.trim() ? src.dbPath.trim() : DEFAULTS.dbPath,
    autoInject: src.autoInject === true,
    injectBudget: clampInt(src.injectBudget, 1, INJECT_HARD_LIMIT, DEFAULTS.injectBudget),
    halfLifeDays: clampNum(src.halfLifeDays, 0.5, 3650, DEFAULTS.halfLifeDays),
    decayFloor: clampNum(src.decayFloor, 0, 1, DEFAULTS.decayFloor),
    touchOnRecall: src.touchOnRecall !== false,
    injectLimit: clampInt(src.injectLimit, 1, 50, DEFAULTS.injectLimit),
    vector: src.vector === undefined ? DEFAULTS.vector : src.vector === true,
    vectorCacheDir: typeof src.vectorCacheDir === 'string' ? src.vectorCacheDir : DEFAULTS.vectorCacheDir,
    // 假时钟注入点。不进 DEFAULTS（函数不可共享），只在这里透传。
    now: typeof src.now === 'function' ? src.now : null,
  };
}

/** 默认库路径。DSH_HOME 优先，保证隔离 profile 不会写进用户主目录。 */
export function defaultDbPath() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  return path.join(home, 'memjudge', 'memjudge.db');
}

// ---------------------------------------------------------------- 编解码

/** store.put 的 source 字段是字符串，这里把章/段号编成可逆 JSON。 */
function encodeSource(chapter, para) {
  if (chapter == null && para == null) return null;
  return JSON.stringify({ chapter: Number(chapter) || 0, para: Number(para) || 0 });
}

/** 反向解析。历史数据可能是别的格式，解析失败退回 {0,0} 而不是抛错。 */
function decodeSource(source) {
  if (source == null) return { chapter: 0, para: 0 };
  if (typeof source === 'object') {
    return { chapter: Number(source.chapter) || 0, para: Number(source.para) || 0 };
  }
  const text = String(source);
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        return { chapter: Number(parsed.chapter) || 0, para: Number(parsed.para) || 0 };
      }
    } catch {
      // 落到下面的兜底
    }
  }
  return { chapter: 0, para: 0 };
}

/**
 * 章/段号的权威读法：先看 source 列里的 JSON，其次看 id 前缀
 * （makeId 生成 `mem-c<章>-p<段>-<hash>`）。
 *
 * 为什么需要 id 兜底：source 列是**一列两用**——章级聚合检索（topChapters）要章号，
 * 面板分组要来源串。带显式 source 的记忆把这一列让给了来源串，章号只剩 id 里那份。
 * 不兜底则章级聚合会把每条显式来源记忆各算一章，冲突检测从「按文档」退化成「按句」。
 */
function chapterOf(memory) {
  const src = decodeSource(memory?.source);
  if (src.chapter || src.para) return src;
  const m = /^mem-c(\d+)-p(\d+)-/.exec(String(memory?.id ?? ''));
  return m ? { chapter: Number(m[1]) || 0, para: Number(m[2]) || 0 } : src;
}

/** 注入索引里的来源标签：章号优先，显式来源次之，两者都没有才算手动写入。 */
function sourceLabel(source) {
  const text = typeof source === 'string' ? source.trim() : '';
  if (!text || text.startsWith('{')) return '手动写入';
  return oneLine(text, 24);
}

/** store.dump() 的一条 → SearchIndex.add 期望的文档形状。 */
function toDoc(memory) {
  const src = chapterOf(memory);
  return {
    id: memory.id,
    text: memory.text,
    source: src,
    importance: memory.importance,
    accessCount: memory.accessCount,
    createdAt: memory.createdAt,
    lastAccessed: memory.lastAccessed,
    supersededBy: memory.supersededBy,
  };
}

/** 压成单行并截断，用于注入索引。 */
function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * 拒答门的软硬之分。
 *
 * gate 的 no-facts 与「二字组覆盖不足」在评测语料上等于「材料里没有」，但在通用
 * 记忆场景里，用户写一句「今天心情不好」同样抽不出三元组——把它当拒答会让纯文本
 * 记忆永远查不到。所以这两类在 recall 里放行，只保留三类硬门：实体不存在、
 * 限定语不存在、拉丁标识不存在。
 *
 * 硬门不依赖三元组，所以 no-facts 时单独补一次拉丁标识检查：
 * 「白鲸号的 IMO 编号是多少」在纯叙述候选上仍会被拒。
 */
export function isHardDeny(verdict, query, body) {
  const reason = verdict?.reason;
  if (reason === 'entity-not-recorded' || reason === 'scope-not-recorded') return true;
  if (reason === 'attribute-not-recorded') {
    // 带 coverage 的是「二字组覆盖不足」。实测 104 道真题的块覆盖率下限是 0.43，
    // 所以 cov<0.4 是「问的东西一个字组都对不上」，与 H4「海关关长」的 0% 同类，属硬门；
    // 不再只认恰为 0 这一种。
    return typeof verdict.coverage !== 'number' || verdict.coverage < 0.4;
  }
  if (reason === 'no-facts') {
    const latin = (String(query).match(/[A-Za-z][A-Za-z0-9]{1,}/g) || []).map((s) => s.toLowerCase());
    const hay = String(body).toLowerCase();
    return latin.some((s) => !hay.includes(s));
  }
  return false;
}

// ---------------------------------------------------------------- 插件

/**
 * 挂载插件。
 *
 * @param {object} ctx cordis Context（需已注入 tools 与 systemPrompt）
 * @param {object} [config] 见 DEFAULTS
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const now = cfg.now ?? (() => Date.now());
  const dbPath = cfg.dbPath || defaultDbPath();
  // 两个上限都来自用户配置层（env > config.json > 默认 2MB / 0）：
  // storageLimitBytes 只决定 stats() 的「上限/是否超预算」，maxChars 才是写入闸门。
  const store = openStore(dbPath, {
    now,
    maxChars: configuredMaxChars(),
    storageLimitBytes: configuredStorageLimitBytes(),
  });

  /** @type {Array<() => void>} 所有注册的 disposer，逆序调用一次 */
  const disposers = [];
  const track = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  };

  // 宿主 RPC 通道：给 browser 半侧（client.js 的设置页「记忆库」面板）提供只读数据。
  // 无 Connection RPC 时静默空函数，不影响其它功能。
  track(installMemjudgeRpc(ctx, { dbPath }));

  let index = null;
  let indexDirty = true;
  let injectCache = null;
  /** 自动采集 G5（近重复）的候选语料缓存。null = 需要按库重取；写库走 invalidate() 清空。 */
  let autoCaptureCorpus = null;

  const invalidate = () => {
    indexDirty = true;
    injectCache = null;
    autoCaptureCorpus = null;
  };

  const getIndex = () => {
    if (!index || indexDirty) {
      const built = new SearchIndex({ decayFloor: cfg.decayFloor, maxChars: cfg.injectBudget });
      built.addAll(store.dump().map(toDoc));
      index = built;
      indexDirty = false;
      if (cfg.vector && store) {
        // 先吃落盘的向量块（同步、零网络）。没有就后台补，绝不阻塞启动：
        // 启动重建现在 43ms，接一次 32s 的 embed 会让插件装载卡死。
        const cached = store.allVectors(vecDims());
        if (cached.size) built.setVectors(cached);
        else warmVectors(built);
      }
    }
    return index;
  };

  /** 后台补向量：失败/无 key 时静默返回，索引保持纯 BM25。 */
  let vectorWarming = null;
  const warmVectors = (built) => {
    if (vectorWarming) return vectorWarming;
    vectorWarming = (async () => {
      try {
        const rows = store.dump();
        const vecs = await embedVec(rows.map((r) => r.text), { dims: vecDims(), cacheDir: cfg.vectorCacheDir });
        if (!vecs) return;
        const m = new Map();
        rows.forEach((r, i) => { if (vecs[i]) m.set(r.id, vecs[i]); });
        store.putVectors(m);
        built.setVectors(m);
        if (injectCache !== null) injectCache = null;
      } catch {
        // 静默：融合检索是增强项，失败就退回纯 BM25
      } finally {
        vectorWarming = null;
      }
    })();
    return vectorWarming;
  };

  /**
   * 固定注入块。只放索引（id + 首行 + 章号），不放全文。
   * 关闭时返回空串——dsh-system-prompt 会过滤空 section，最终 0 字符。
   *
   * 渲染走 layer.renderRecall（soul-md 同源）：只输出 descriptor 行
   * `- "id" — 首行：来源`，正文一个字不进 prompt。预算按整行扣：装不下的行整条丢弃，
   * 绝不截半行——半行 descriptor 对模型是噪声。layer 是被注入路径真正消费的模块，
   * 不是可 import 的孤儿。
   */
  const renderInject = () => {
    if (!cfg.autoInject) return '';
    if (injectCache !== null) return injectCache;

    const rows = store.dump()
      .sort((a, b) => (b.lastAccessed - a.lastAccessed) || (b.createdAt - a.createdAt))
      .slice(0, cfg.injectLimit);
    if (!rows.length) {
      injectCache = '';
      return injectCache;
    }

    const total = store.stats().memories;
    const head = `## memjudge 记忆索引（${rows.length}/${total} 条，按最近使用）`;
    const tail = '\n用 memjudge_recall 取全文，memjudge_conflicts 查前后矛盾。';
    const topics = rows.map((row) => {
      const src = chapterOf(row);
      return {
        key: row.id,
        title: oneLine(row.text, 90),
        summary: src.chapter ? `ch${src.chapter}` : sourceLabel(row.source),
      };
    });
    const body = renderRecall([{ heading: head, topics }], cfg.injectBudget - tail.length);
    injectCache = body ? `${body}${tail}`.slice(0, cfg.injectBudget) : '';
    return injectCache;
  };

  // ── wiki 编译层（T8-1）───────────────────────────────────────────────
  // docs/wiki-layer-spec.md §2 的硬决策：编译产物只活在内存，库里只留两个 meta
  // 键（wiki_version / raw_digest，合计 <200 字节）。不建表、不写 md、不建 FTS——
  // memories 是 raw 的唯一副本，投影一旦落盘就成了第二份真相，冲突再也说不清哪边
  // 是材料。投影随时可以按 raw 重算，所以「没有落盘投影」从来不是缺陷。
  const WIKI_META_VERSION = 'wiki_version';
  const WIKI_META_DIGEST = 'raw_digest';

  /** 内存投影。null = 本进程还没编过（≠「库里没有 wiki」）。 */
  let wiki = null;
  let stmtMetaGet = null;
  let stmtMetaPut = null;

  /** 运行时计数：让 stats 与测试能区分「真编了一次」与「digest 命中直接跳过」。 */
  const wikiRuntime = {
    compiles: 0,
    skipped: 0,
    unverified: 0,
    status: 'idle',
    digest: null,
  };

  const metaRead = (key) => {
    try {
      stmtMetaGet ??= store.raw().prepare('SELECT v FROM meta WHERE k = ?');
      const row = stmtMetaGet.get(key);
      return row ? String(row.v) : null;
    } catch {
      return null;
    }
  };

  // meta 只是「这张投影对应哪份 raw」的书签：写失败最多下次多编一次，不挡写入。
  const metaWrite = (key, value) => {
    try {
      stmtMetaPut ??= store.raw().prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
      stmtMetaPut.run(key, String(value));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 重编 wiki 投影。三条短路规则：
   *   1. 内存投影的 rawDigest 与当前 raw 相同 → 直接复用（compiles 不动）。
   *   2. meta.raw_digest 已存在且等于当前 raw → 这份 raw 之前编过，投影只是丢了
   *      （进程重启）。仍要编一次把内存投影建起来，但用 diffWiki 记下相对上次落盘
   *      投影的增删改判，而不是当成一个全新库。
   *   3. Grounding 有违规时不拒绝编译、不抛错：投影照建，状态降为 unverified
   *      （文档 §2.3），raw 与写入结果完全不受影响。
   */
  const refreshWiki = (persist = false) => {
    const rows = store.dump();
    const digest = rawDigest(rows);

    if (wiki && wiki.rawDigest === digest) {
      wikiRuntime.skipped += 1;
      return wiki;
    }

    const storedDigest = metaRead(WIKI_META_DIGEST);
    const storedVersion = metaRead(WIKI_META_VERSION);
    const sameAsStored = storedDigest === digest && storedVersion === String(WIKI_VERSION);

    const compiled = compileWiki(rows);
    wikiRuntime.compiles += 1;

    // 只跟内存里的旧投影比。投影不落盘，重启后拿不到上一版的块，宁可不给 diff
    // 也不伪造「全部新增」；storedDigest 相同意味着这份 raw 之前编过且内容没动，
    // 此时 diff 恒为空，直接置 null。
    const previous = wiki;
    compiled.diff = previous && !sameAsStored ? diffWiki(previous, compiled) : null;
    compiled.reusedStoredDigest = sameAsStored;

    const violations = groundingViolations(compiled);
    compiled.grounding = { violations, status: violations.length ? 'unverified' : 'verified' };
    wiki = compiled;

    wikiRuntime.unverified = violations.length;
    wikiRuntime.status = compiled.grounding.status;
    wikiRuntime.digest = digest;
    // 书签只在写库/删库路径落盘：读工具（stats/recall）懒编投影时不写库，保持
    // 「读不产生写入」这条契约。
    if (persist) {
      metaWrite(WIKI_META_VERSION, WIKI_VERSION);
      metaWrite(WIKI_META_DIGEST, digest);
    }
    return wiki;
  };

  /**
   * 写库/删库后的接线钩子。编译异常一律吞掉：记忆写入是主业务，wiki 只是投影，
   * 失败就退回「没有投影」，下次写库再试，raw 一个字节都不受影响。
   */
  const touchWiki = () => {
    try {
      refreshWiki(true);
    } catch {
      wiki = null;
      wikiRuntime.status = 'idle';
    }
  };

  /** 只读投影入口：没编过就按需编一次（不落盘）。T8-2/T8-4 从这里取投影。 */
  const getWiki = () => {
    if (wiki) return wiki;
    try {
      return refreshWiki(false);
    } catch {
      return null;
    }
  };

  // ── 自动记忆（T2 接线）：agent/pre-step 采集 ──────────────────────────
  // 设计真源 docs/auto-capture-spec.md §1.3（挂载点与 prepend 语义）/ §4.3（章号分配）/
  // §7.2（fail-open 纪律）。判定内核在 src/auto-capture.mjs，这里只做旁路：
  // 读最终 decision → 取候选 → store.put。永不往 decision.messages 里 push 任何东西。
  //
  // 守卫的必要性：test/plugin.test.mjs 的 MockContext 只有 tools / systemPrompt / effect，
  // 没有 on。不判就整条 apply 抛错，既有 5 条工具用例全崩。
  const autoCfg = resolveAutoConfig(resolveAutoCapture(config && typeof config === 'object' ? config : {}));
  // config.autoCapture === false 是硬开关：即使 env 把它翻回 true 也不采集。
  const autoEnabled = autoCfg.enabled !== false && !(config && config.autoCapture === false);
  // 配额状态机在 apply 里建一次、handler 复用。每次重建等于单会话/单轮上限从未生效。
  const autoQuota = createQuota(autoCfg);
  /** 自动章号起点：1-899 留给显式导入的语料，900+ 归自动条目（spec §4.3）。 */
  const AUTO_CHAPTER_START = 900;
  /** meta 里存「下一个可用自动章号」的键（与 wiki_version/raw_digest 同级，不建新表）。 */
  const AUTO_META_CHAPTER = 'auto_capture_chapter_next';
  /** 会话 → { chapter, para }：一会话一章，段号在章内递增。上限 256 个会话，超出淘汰最旧。 */
  const autoSeqs = new Map();

  /**
   * 领一个章号。号在事务里领，读-改-写之间不 await，避免并发同号。
   * meta 写失败时退回起点号：宁可多会话共章，也不让采集整条断掉。
   */
  const claimAutoChapter = () => {
    const db = store.raw();
    let began = false;
    try {
      db.exec('BEGIN');
      began = true;
      const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(AUTO_META_CHAPTER);
      const prev = Number.parseInt(row ? String(row.v) : '', 10);
      const chapter = Number.isFinite(prev) && prev >= AUTO_CHAPTER_START ? prev : AUTO_CHAPTER_START;
      db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(AUTO_META_CHAPTER, String(chapter + 1));
      db.exec('COMMIT');
      return chapter;
    } catch (err) {
      if (began) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // 事务可能已因写失败自行回滚
        }
      }
      console.warn('[memjudge] auto-capture 章号领取失败，退回起点号：', err && err.message);
      return AUTO_CHAPTER_START;
    }
  };

  /** 取（必要时分配）会话的章号与下一个段号。 */
  const autoSeqFor = (sessionId) => {
    const key = sessionId.trim();
    const hit = autoSeqs.get(key);
    if (hit) return hit;
    const entry = { chapter: claimAutoChapter(), para: 0 };
    if (autoSeqs.size >= 256) {
      const oldest = autoSeqs.keys().next();
      if (!oldest.done) autoSeqs.delete(oldest.value);
    }
    autoSeqs.set(key, entry);
    return entry;
  };

  /** G5 候选语料：懒取一次，写库路径已通过 invalidate() 清空。 */
  const autoCorpus = () => {
    if (autoCaptureCorpus === null) autoCaptureCorpus = store.dump().map((m) => m.text);
    return autoCaptureCorpus;
  };

  if (typeof ctx.on === 'function') {
    // { prepend: true }：位于瀑布最外层，await next() 之后拿到的是内层处理完的最终
    // decision（含 driver 追加的 runtime-context），spec §1.3 第 1 点。
    // 不包 track/ctx.effect：ctx.on 的 disposer 已挂在当前 fiber 上，再包一层会重复释放。
    ctx.on('agent/pre-step', async (input, next) => {
      // 采集关闭：一次判定都不做，但仍必须原样放行。
      if (!autoEnabled) return await next();

      // await next() 独立成首句、不进 try：next() 自身抛的错是别的插件的错，不替它吞。
      const decision = await next();
      try {
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;

        const sessionId = input?.agent?.session?.id;
        if (typeof sessionId !== 'string' || sessionId.trim() === '') return decision;
        const turn = Number.isFinite(Number(input?.turn)) ? Math.trunc(Number(input.turn)) : 0;

        const candidates = extractCandidates(decision.messages, {
          ...autoCfg,
          existing: autoCorpus(),
          quota: autoQuota,
          sessionId,
          turn,
        });
        if (candidates.length === 0) return decision;

        let wrote = 0;
        for (const candidate of candidates) {
          const seq = autoSeqFor(sessionId);
          seq.para += 1;
          try {
            const result = store.put({
              text: candidate.text,
              importance: candidate.importance,
              chapter: seq.chapter,
              para: seq.para,
              source: formatSource(sessionId, turn),
            });
            if (result && result.inserted) wrote += 1;
          } catch (err) {
            // 单条写失败（预算超限 / 库异常）不拖累其余候选，也不碰这一轮对话。
            console.warn('[memjudge] auto-capture 写入跳过：', err && err.message);
          }
        }

        if (wrote > 0) {
          invalidate();
          touchWiki();
        }
      } catch (e) {
        console.warn('[memjudge] auto-capture 跳过：', e && e.message);
      }
      // 任何情况下都返回 decision 本体：不修改、不替换、不返回 undefined。
      return decision;
    }, { prepend: true });
  }

  const textBlock = (text) => [{ type: 'text', text }];

  /**
   * 按章聚合：同章的段拼回一条再判冲突。
   * 冲突是「同一份文档里前后说法不一致」，段级切分把一句拆到两条记忆里会漏判；
   * 章级聚合复现 t12 的检测口径（章是一份文档）。
   */
  const chapterRows = () => {
    const byChapter = new Map();
    for (const memory of store.dump()) {
      const chapter = chapterOf(memory).chapter;
      const key = chapter > 0 ? `ch${chapter}` : memory.id;
      let entry = byChapter.get(key);
      if (!entry) {
        entry = { id: key, text: '', createdAt: memory.createdAt };
        byChapter.set(key, entry);
      }
      entry.text += (entry.text ? '\n' : '') + memory.text;
      entry.createdAt = Math.max(entry.createdAt, memory.createdAt);
    }
    return [...byChapter.values()];
  };

  // -------------------------------------------------------------- 工具

  track(ctx.tools.register({
    name: 'memjudge_remember',
    description:
      '把一条事实写进 memjudge 长期记忆。原文一字不改地落库（写入后 dump 与输入字符级相等），'
      + '同时抽出实体-属性-值三元组供冲突检测与拒答判断使用。同一条文本重复写入是幂等的，'
      + '不会产生重复行。需要覆盖旧结论时用 supersedes 指向旧 id，旧条目正文不会被改写。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要记住的原文。建议一条一个事实，别整章倾倒。' },
        importance: { type: 'number', description: '重要度 0..1，影响衰减地板（≥0.6 时给 0.6 地板）。默认 0。' },
        chapter: { type: 'integer', description: '来源章号，用于章级聚合检索。' },
        para: { type: 'integer', description: '来源段号，用于同章内排序。' },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: '被本条取代的旧记忆 id 列表。只建链，不改旧正文。',
        },
        source: {
          type: 'string',
          description: '这条记忆来自哪里（会话/文件/项目）。面板按它分组。',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          inserted: { type: 'boolean' },
          factCount: { type: 'integer' },
          chars: { type: 'integer' },
          total: { type: 'integer' },
        },
        required: ['id', 'inserted', 'factCount', 'chars', 'total'],
      },
      render: (_args, value) => textBlock(
        value.inserted
          ? `已写入 ${value.id}（${value.chars} 字，抽出 ${value.factCount} 条三元组，库内共 ${value.total} 条）`
          : `已存在 ${value.id}（幂等命中，未重复写入；库内共 ${value.total} 条）`,
      ),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = String(args?.text ?? '');
      if (!text.trim()) throw new Error('memjudge_remember: text 不能为空');
      // 来源：显式 source 优先（面板按它分组），没给才退回章/段号的 JSON 编码。
      // 两者写同一列，显式 source 时不并列存：decodeSource 对非 JSON 串已有兜底
      // （退回 {chapter:0,para:0}），章号仍可从 id 的 mem-c<章>-p<段>- 前缀恢复。
      const explicitSource = typeof args?.source === 'string' ? args.source.trim() : '';
      const result = store.put({
        text,
        importance: clampNum(args?.importance, 0, 1, 0),
        chapter: args?.chapter,
        para: args?.para,
        supersedes: args?.supersedes ?? null,
        source: explicitSource || encodeSource(args?.chapter, args?.para),
      });
      invalidate();
      // 写入后立刻重编 wiki 投影（幂等命中时 rawDigest 不变，直接跳过）。
      touchWiki();
      return {
        id: result.id,
        inserted: result.inserted,
        factCount: result.factCount,
        chars: text.length,
        total: store.stats().memories,
      };
    },
  }));

  track(ctx.tools.register({
    name: 'memjudge_recall',
    description:
      '在 memjudge 长期记忆里检索。两阶段：段级 BM25（CJK 二元组倒排）→ 章级聚合选章 → 章内按预算装填。'
      + '返回的是原文片段，不做摘要改写。命中即刷新访问时间（衰减挂 lastAccessed）。'
      + '材料里确实没有记载时返回 denied=true 并说明缺的是实体、属性还是值——不要据此编造。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '自然语言问题或关键词。' },
        budget: { type: 'integer', description: `本次返回字符预算，1..${INJECT_HARD_LIMIT}。默认取配置的 injectBudget。` },
        topChapters: { type: 'integer', description: '章级聚合取前几章，1..4。默认 2（实测 1→0.946、2→0.989、3→0.978）。' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          denied: { type: 'boolean' },
          reason: { type: 'string' },
          detail: { type: 'string' },
          chars: { type: 'integer' },
          elapsedMs: { type: 'number' },
          // 冲突自述行：只有「同槽多值 + 修订语」才非空。放在返回体最前面渲染，
          // 判据（score.mjs 的 JUDGED_CONFLICT）在全文上测，但太靠后会被预算裁剪掉。
          conflictLine: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                chapter: { type: 'integer' },
                para: { type: 'integer' },
                chars: { type: 'integer' },
                score: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['id', 'chapter', 'para', 'chars', 'score', 'text'],
            },
          },
        },
        required: ['denied', 'chars', 'elapsedMs', 'hits'],
      },
      render: (_args, value) => {
        if (value.denied) {
          return textBlock(`没有记载（${value.reason}${value.detail ? `：${value.detail}` : ''}）`);
        }
        const lines = value.hits.map((h) => `[${h.id} ch${h.chapter}] ${h.text}`);
        const head = value.conflictLine ? `${value.conflictLine}\n\n` : '';
        return textBlock(`${head}命中 ${value.hits.length} 段，共 ${value.chars} 字：\n\n${lines.join('\n\n')}`);
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const query = String(args?.query ?? '').trim();
      if (!query) throw new Error('memjudge_recall: query 不能为空');
      const budget = clampInt(args?.budget, 1, INJECT_HARD_LIMIT, cfg.injectBudget);
      const topChapters = clampInt(args?.topChapters, 1, 4, 2);

      // 融合检索开启且向量就绪时走异步双路；查询扩展开启时走多子查询；否则维持纯 BM25
      // 同步路径（行为一字不变）。三条路径共用同一个 fillFromScored，装填语义不变。
      const ix = getIndex();
      const found = cfg.expand
        ? await ix.searchExpanded(query, { maxChars: budget, topChapters, now: now() })
        : (cfg.llmSelect || (cfg.vector && ix.hasVectors))
          ? await ix.searchAsync(query, {
            maxChars: budget, topChapters, now: now(),
            dims: vecDims(), cacheDir: cfg.vectorCacheDir, llmSelect: cfg.llmSelect,
          })
          : ix.search(query, { maxChars: budget, topChapters, now: now() });
      if (!found.hits.length) {
        return { denied: true, reason: 'no-candidates', detail: '检索无候选段', chars: 0, elapsedMs: found.elapsedMs, hits: [] };
      }

      // 先裁剪再判断：在整章上跑 gate 判据恒真，裁到预算内才有区分力。
      const body = found.hits.map((h) => h.text).join('\n\n');
      // t15：属性缺席判据要 L1 的 (entity, attr) 集合；store 的 facts 就是 L1 产物。
      const l1Facts = store.allFacts();
      const verdict = gate(query, body, { l1Facts });
      // 硬拒必须在**全文口径**上复核：body 是裁剪后的检索结果，名词块覆盖率天然偏低，
      // 在它上面判「材料里没有这个说法」会把 R12「硫含量」、R45「待了多久」、
      // R78「邮件包编号」这类真问题误拒（body 口径 0.25–0.33，全文口径 0.33–0.56）。
      // body 只用于展示，不单独决定拒答。
      let finalVerdict = verdict;
      if (verdict.deny) {
        const full = store.raw().prepare('SELECT text FROM memories').all().map((r) => r.text).join('\n');
        const fullVerdict = gate(query, full, { l1Facts });
        if (!isHardDeny(fullVerdict, query, full)) {
          finalVerdict = { ...fullVerdict, deny: false };
        } else {
          finalVerdict = fullVerdict;
        }
      }
      if (finalVerdict.deny && isHardDeny(finalVerdict, query, body)) {
        return {
          denied: true,
          reason: String(finalVerdict.reason ?? 'denied'),
          detail: String(finalVerdict.detail ?? ''),
          chars: 0,
          elapsedMs: found.elapsedMs,
          hits: [],
        };
      }

      if (cfg.touchOnRecall) {
        const at = now();
        for (const hit of found.hits) store.updateAccess(hit.id, at);
      }

      // 判断层落在召回路径上（能力 10）：judge.render 的 conflictNarrate 覆盖不到这里，
      // recall 走的是本文件这个 render。只在「同槽多值 + 有修订语」时说话，见 layer 注释。
      const judgments = conflictJudgments(found.hits.map((hit) => {
        const row = store.get(hit.id);
        return { id: hit.id, chapter: hit.chapter, text: String(row?.text ?? hit.text ?? ''), facts: row?.facts ?? [] };
      }));

      return {
        denied: false,
        chars: found.chars,
        elapsedMs: found.elapsedMs,
        conflictLine: judgments.length ? judgments[0].line : '',
        hits: found.hits.map((h) => ({
          id: h.id,
          chapter: h.chapter,
          para: h.para,
          chars: h.chars,
          score: h.score,
          text: h.text,
        })),
      };
    },
  }));

  track(ctx.tools.register({
    name: 'memjudge_forget',
    description:
      '从 memjudge 长期记忆里物理删除条目（不可恢复）。按 id 精确删，或按 query 检索命中后删前 limit 条。'
      + '先用 dryRun=true 看会删哪些，确认后再真删。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '要删除的记忆 id。' },
        query: { type: 'string', description: '按检索命中批量删除。与 id 同时给时以 id 优先。' },
        limit: { type: 'integer', description: 'query 模式最多删几条，1..100。默认 10。' },
        dryRun: { type: 'boolean', description: '只列出将删除的 id，不落库。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forgotten: { type: 'array', items: { type: 'string' } },
          count: { type: 'integer' },
          dryRun: { type: 'boolean' },
        },
        required: ['forgotten', 'count', 'dryRun'],
      },
      render: (_args, value) => textBlock(
        value.count === 0
          ? '没有匹配到要遗忘的条目'
          : `${value.dryRun ? '将遗忘' : '已遗忘'} ${value.count} 条：${value.forgotten.join(', ')}`,
      ),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const dryRun = args?.dryRun === true;
      const ids = [];
      if (args?.id) {
        ids.push(String(args.id));
      } else if (args?.query) {
        const limit = clampInt(args?.limit, 1, 100, 10);
        const found = getIndex().search(String(args.query), { maxChars: 1e9, limit: 1e6, now: now() });
        for (const hit of found.hits.slice(0, limit)) ids.push(hit.id);
      }
      if (!ids.length) return { forgotten: [], count: 0, dryRun };
      if (dryRun) return { forgotten: ids, count: ids.length, dryRun: true };

      // store 没有 delete：用 raw() 在同一事务里删子表（segments）与 memories。
      // v5 起 facts 不落盘（内存派生层），改用 store.dropFactsOf 同步内存，
      // 否则 forget 之后 stats().facts 与 conflicts 会残留幽灵三元组。
      const db = store.raw();
      const delSeg = db.prepare('DELETE FROM segments WHERE ord = (SELECT rowid FROM memories WHERE id = ?)');
      const delMem = db.prepare('DELETE FROM memories WHERE id = ?');
      const removed = [];
      db.exec('BEGIN');
      try {
        for (const id of ids) {
          store.dropFactsOf(id);
          delSeg.run(id);
          if (delMem.run(id).changes > 0) removed.push(id);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      invalidate();
      // 删除同样改变 raw：投影必须跟着重建，否则 wiki 里会留着已经忘掉的块。
      touchWiki();
      return { forgotten: removed, count: removed.length, dryRun: false };
    },
  }));

  track(ctx.tools.register({
    name: 'memjudge_conflicts',
    description:
      '列出 memjudge 记忆里前后矛盾的数值：同一单位出现两个不同值，且两句共享同一个名词。'
      + '按章聚合后判断（同一份文档里前后说法不一致才算矛盾）。返回每组矛盾的取值序列与'
      + '按时间取的最新值。注意 current 是结构规则的结果：原文自带「已作废」「现予更正」这类'
      + '措辞时，最新值可能落在复述旧值的那一句上，此时以 evidence 里的原句为准。'
      + '判据不看措辞——「发现矛盾」靠的是同单位不同值 + 共享名词，不是「更正」二字。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '最多返回几组矛盾，1..50。默认 20。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string' },
                attr: { type: 'string' },
                unit: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
                current: { type: 'string' },
                currentMemId: { type: 'string' },
                supersededValues: { type: 'array', items: { type: 'string' } },
              },
              required: ['key', 'attr', 'unit', 'values', 'current', 'currentMemId', 'supersededValues'],
            },
          },
          total: { type: 'integer' },
          supersededCount: { type: 'integer' },
        },
        required: ['conflicts', 'total', 'supersededCount'],
      },
      render: (_args, value) => textBlock(
        value.total === 0
          ? '未发现前后矛盾'
          : `发现 ${value.total} 组矛盾：\n\n${value.conflicts
            .map((c) => `- ${c.attr}（${c.unit}）：${c.values.join(' → ')}，现取 ${c.current}（${c.currentMemId}）`)
            .join('\n')}`,
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = clampInt(args?.limit, 1, 50, 20);
      const result = resolveConflict(chapterRows());
      return {
        conflicts: result.conflicts.slice(0, limit).map((c) => ({
          key: c.key,
          attr: String(c.attr ?? ''),
          unit: String(c.unit ?? ''),
          values: c.values,
          current: c.current,
          currentMemId: String(c.currentMemId ?? ''),
          supersededValues: c.supersededValues,
        })),
        total: result.conflicts.length,
        supersededCount: result.superseded.length,
      };
    },
  }));

  track(ctx.tools.register({
    name: 'memjudge_stats',
    description:
      'memjudge 的库体与索引体检：条目数、三元组数、正文与文件字节、是否在 200KB 预算内、'
      + '倒排规模、当前注入开关与字符数。排查「为什么查不到」时先看这个。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verbose: { type: 'boolean', description: '附带库路径与配置快照。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: { type: 'integer' },
          facts: { type: 'integer' },
          textChars: { type: 'integer' },
          bytes: { type: 'integer' },
          limitBytes: { type: 'integer' },
          withinLimit: { type: 'boolean' },
          docs: { type: 'integer' },
          terms: { type: 'integer' },
          postings: { type: 'integer' },
          chapters: { type: 'integer' },
          injectEnabled: { type: 'boolean' },
          injectChars: { type: 'integer' },
          injectBudget: { type: 'integer' },
          dbPath: { type: 'string' },
          tidy: { type: 'string', description: 'layer 四阶段后台整理（mneme sleep 同构）的一句话结论。' },
          modules: { type: 'string', description: '各增强模块的开关状态（ON/OFF）与是否有密钥。' },
          keyConfigured: { type: 'boolean' },
          keySource: { type: 'string' },
          panelPath: { type: 'string', description: '可视化面板 HTML 的生成路径。' },
          wiki: { type: 'string', description: 'wiki 编译层投影状态：版本、块数、编译次数、Grounding 结论。' },
        },
        required: [
          'memories', 'facts', 'textChars', 'bytes', 'limitBytes', 'withinLimit',
          'docs', 'terms', 'postings', 'chapters',
          'injectEnabled', 'injectChars', 'injectBudget', 'dbPath',
          'modules', 'keyConfigured', 'keySource', 'panelPath',
        ],
      },
      render: (_args, value) => textBlock(
        `记忆 ${value.memories} 条 / 三元组 ${value.facts} 条 / 正文 ${value.textChars} 字\n`
        + `库体 ${(value.bytes / 1024).toFixed(1)}KB（上限 ${(value.limitBytes / 1024).toFixed(0)}KB，${value.withinLimit ? '在预算内' : '超预算'}）\n`
        + `倒排 ${value.terms} 词 / ${value.postings} 条 posting / ${value.chapters} 章\n`
        + `后台整理 ${value.tidy ?? '未运行'}\n`
        + `注入 ${value.injectEnabled ? `开启（${value.injectChars}/${value.injectBudget} 字符）` : '关闭（0 字符）'}\n`
        + `wiki ${value.wiki}\n`
        + `模块 ${value.modules}\n`
        + `密钥 ${value.keyConfigured ? `已配置（${value.keySource}）` : '未配置——向量/重排/LLM 提取全部停用，走纯 BM25'}\n`
        + `面板 ${value.panelPath}（node scripts/panel.mjs --open 刷新）`,
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const base = store.stats();
      const ix = getIndex().stats();
      const injectText = renderInject();
      // layer 的后台整理（mneme sleep 四阶段同构）在体检时报一次：每阶段独立 fail-safe，
      // 一个阶段抛错只记进 errors，不影响统计输出。冲突阶段与 memjudge_conflicts 同源。
      const tidy = sleepPhase(chapterRows());
      const out = {
        memories: base.memories,
        facts: base.facts,
        textChars: base.textChars,
        bytes: base.bytes,
        limitBytes: base.limitBytes,
        withinLimit: base.withinLimit,
        docs: ix.docs,
        terms: ix.terms,
        postings: ix.postings,
        chapters: ix.chapters,
        injectEnabled: cfg.autoInject,
        injectChars: injectText.length,
        injectBudget: cfg.injectBudget,
        dbPath: args?.verbose === true ? store.path : '',
        tidy: `${tidy.conflicts.length} 组待审矛盾 / ${tidy.archived.length} 条待降级`
          + ` / ${tidy.relations.length} 条共现关系`
          + (tidy.errors.length ? ` / ${tidy.errors.length} 阶段失败` : ''),
        modules: (() => {
          const r = configReport();
          const f = r.flags;
          return `jieba ${f.jieba ? 'ON' : 'OFF'} / 向量 ${f.vector ? 'ON' : 'OFF'}`
            + ` / rerank ${f.rerank ? 'ON' : 'OFF'} / 扩展 ${f.expand ? 'ON' : 'OFF'}`
            + ` / 选段 ${f.llmSelect ? 'ON' : 'OFF'} / LLM提取 ${f.llmExtract ? 'ON' : 'OFF'}`;
        })(),
        keyConfigured: configReport().hasKey,
        keySource: configReport().keySource,
        panelPath: path.join(STATE_DIR, 'panel.html'),
        // wiki 投影是懒编的：体检会顺手把它建起来（只花内存，不写库、不动注入面）。
        wiki: (() => {
          const projected = getWiki();
          if (!projected) return '未编译（编译异常已吞掉，raw 不受影响）';
          const rt = wikiRuntime;
          return `v${projected.version} 投影 ${projected.blocks.length} 块/${projected.grounding.status}`
            + (rt.unverified ? `（Grounding 违规 ${rt.unverified} 处）` : '')
            + ` / 编译 ${rt.compiles} 次，digest 命中跳过 ${rt.skipped} 次`;
        })(),
      };
      return out;
    },
  }));

  // -------------------------------------------------------------- 注入

  track(ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // 记忆正文里可能出现 {{...}}，关掉插值免得被当成 prompt 变量。
    interpolate: false,
    text: renderInject,
  }));

  // -------------------------------------------------------------- 卸载

  const dispose = () => {
    for (const disposer of disposers.splice(0).reverse()) {
      try {
        disposer();
      } catch {
        // 宿主销毁 ctx 时可能已经回收过同一个 effect，重复调用按幂等处理。
      }
    }
    index = null;
    injectCache = null;
    try {
      store.close();
    } catch {
      // 已关闭
    }
  };

  ctx.effect(() => dispose);

  return { dispose, dbPath, config: cfg };
}

export default {
  name,
  inject,
  apply,
  resolveConfig,
  defaultDbPath,
  DEFAULTS,
  TOOL_NAMES,
  SECTION_NAME,
  SECTION_ORDER,
  INJECT_HARD_LIMIT,
};
