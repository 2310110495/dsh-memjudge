// memjudge 宿主 RPC：给 browser 半侧（client）提供库体/记忆/冲突的只读数据。
//
// 为什么走 RPC 而不是 HTTP 服务：DSH 的 host↔browser 通信有现成契约——
// host 端 ctx.connection.rpc.handle(channel, handler, {authority:'loopback'})，
// browser 端 ctx.connection.rpc.call(channel, endpoint, payload)。照抄 dsh-pocket
// 的通道（频道名惯例 `/dsh-<包名>`），不另起端口、不暴露 200KB 库。
//
// 本文件不删记忆：删除入口只有对话里的 memjudge_forget 工具，RPC 侧永不提供。
// 允许写的只有三样：密钥（saveKey/clearKey，按组）、五个模块开关（saveConfig）、
// 九项值型设置（saveSettings：三组端点 / 三组模型名 / 维度 / 存储上限 / 写入闸门）。
// 为什么边界这么划：密钥与开关是「配置」，读回后无需同步内存索引；删条目会改库体，
// 得走工具才能让插件的索引与注入缓存一起失效，否则宿主进程读到的库与内存索引不一致。
//
// 三组凭据（chat / embed / rerank）各自独立：saveKey / clearKey / testKey 都带 group 参数，
// 缺省 'chat' 让旧面板（只发 {key}）照常工作；testKey 用**该组**自己的 baseUrl + key + model。

import { open as openStore } from './store.mjs';
import {
  CRED_GROUPS,
  configReport,
  envLockedFlags,
  moduleFlags,
  rawConfig,
  saveConfig,
  saveKey,
  chatBaseUrl,
  embedBaseUrl,
  rerankBaseUrl,
  chatKey,
  embedKey,
  rerankKey,
  chatModel,
  embedModel,
  rerankModel,
  embedDims,
  groupReport,
  maxChars as configuredMaxChars,
  storageLimitBytes as configuredStorageLimitBytes,
} from './config.mjs';

/** 面板允许写的五个开关，其它键一律静默丢弃。 */
const WRITABLE_FLAGS = ['vector', 'rerank', 'expand', 'llmSelect', 'llmExtract'];

/** 模型名/地址的字符上限：再长就不是配置错误，是拿配置当注入了。 */
const MODEL_TEXT_CAP = 120;
const BASE_URL_CAP = 200;
/** 存储上限的合法区间：64KB（比一个章节还小的上限没有意义）到 1GB。 */
const LIMIT_BYTES_MIN = 64 * 1024;
const LIMIT_BYTES_MAX = 1024 * 1024 * 1024;
/** 写入闸门上限：1e8 字符，够大且不会把乘法打溢出。 */
const MAX_CHARS_MAX = 1e8;

/** 三组的端点键与模型键：两组的校验规则完全同构，循环一遍就够。 */
const BASE_URL_KEYS = ['chatBaseUrl', 'embedBaseUrl', 'rerankBaseUrl'];
const MODEL_KEYS = ['chatModel', 'embedModel', 'rerankModel'];
/** 九项值型设置白名单：与 config.mjs 的 SETTING_ENV 一一对应。 */
const SETTING_KEYS = [...BASE_URL_KEYS, ...MODEL_KEYS, 'dims', 'storageLimitBytes', 'maxChars'];

/**
 * 旧面板兼容别名：client.js 未同步改造前只发 baseUrl 与 chatModel 这类旧键。
 * baseUrl 归一成 chatBaseUrl——它本来就是 chat 组的端点，别名只在这一层存在，
 * config.json 里永远只写九项新键，不产生第二套配置体系。
 */
const SETTING_ALIAS = { baseUrl: 'chatBaseUrl' };

/**
 * 面板写设置的校验。**整批校验、整批写入**：任一字段不合法就整批拒绝，
 * 绝不写一半——半个 baseUrl 配上新模型名，比两个都没改更难排查。
 * 返回 { patch } 或 { error }，error 文本直接给面板显示。
 */
function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { error: 'settings 必须是对象' };
  }
  // 别名归一：显式给了新键就以新键为准（别名不覆盖显式值）
  const src = { ...settings };
  for (const [alias, target] of Object.entries(SETTING_ALIAS)) {
    if (
      Object.prototype.hasOwnProperty.call(src, alias)
      && !Object.prototype.hasOwnProperty.call(src, target)
    ) {
      src[target] = src[alias];
    }
    delete src[alias];
  }
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);

  for (const key of BASE_URL_KEYS) {
    if (!has(key)) continue;
    const raw = src[key];
    if (typeof raw !== 'string') return { error: `${key}：必须是字符串` };
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(trimmed)) return { error: `${key}：必须以 http:// 或 https:// 开头` };
    if (trimmed.length > BASE_URL_CAP) return { error: `${key}：长度不能超过 ${BASE_URL_CAP} 字符` };
    out[key] = trimmed;
  }

  for (const key of MODEL_KEYS) {
    if (!has(key)) continue;
    const raw = src[key];
    if (typeof raw !== 'string') return { error: `${key}：必须是字符串` };
    const trimmed = raw.trim();
    if (!trimmed) return { error: `${key}：不能为空` };
    if (trimmed.length > MODEL_TEXT_CAP) return { error: `${key}：长度不能超过 ${MODEL_TEXT_CAP} 字符` };
    out[key] = trimmed;
  }

  if (has('dims')) {
    const n = src.dims;
    if (!Number.isInteger(n)) return { error: 'dims：必须是整数' };
    if (n < 1 || n > 8192) return { error: 'dims：必须在 1..8192 之间' };
    out.dims = n;
  }

  if (has('storageLimitBytes')) {
    const n = src.storageLimitBytes;
    if (!Number.isInteger(n)) return { error: 'storageLimitBytes：必须是整数' };
    if (n < LIMIT_BYTES_MIN || n > LIMIT_BYTES_MAX) {
      return { error: `storageLimitBytes：必须在 ${LIMIT_BYTES_MIN}..${LIMIT_BYTES_MAX} 字节之间` };
    }
    out.storageLimitBytes = n;
  }

  if (has('maxChars')) {
    const n = src.maxChars;
    if (!Number.isInteger(n)) return { error: 'maxChars：必须是整数' };
    if (n < 0 || n > MAX_CHARS_MAX) return { error: `maxChars：必须在 0..${MAX_CHARS_MAX} 之间（0 = 不设限）` };
    out.maxChars = n;
  }

  return { patch: out };
}

/** testKey 的超时：面板上点一下不该把宿主进程挂住。 */
const TEST_KEY_TIMEOUT_MS = 8000;
/** 错误文本回传上限，别把整段 JSON 塞进面板。 */
const ERROR_TEXT_CAP = 200;

function ok(value) {
  return { ok: true, value };
}

function fail(message, code = 'bad-request') {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * 组名归一：缺省 'chat'（旧调用只发 {key}，语义就是 chat 组）。
 * 非法组名显式报错，不静默落到 chat——写错组名却改到 chat 的密钥，很难排查。
 */
function groupParam(raw) {
  if (raw == null || String(raw).trim() === '') return { group: 'chat' };
  const g = String(raw).trim().toLowerCase();
  if (!CRED_GROUPS.includes(g)) return { error: `group：只能是 ${CRED_GROUPS.join(' / ')} 之一` };
  return { group: g };
}

/** 各组当前的密钥（不含明文回显，仅供内部选默认值）。 */
const GROUP_KEY = { chat: chatKey, embed: embedKey, rerank: rerankKey };

/**
 * 面板读库用的 store：上限与插件主路径（src/index.mjs）同源。
 * 分开传会让面板显示「上限 200KB 超预算」而工具里是 2MB 在预算内——同一个库两个答案。
 */
function openConfiguredStore(dbPath) {
  return openStore(dbPath, {
    maxChars: configuredMaxChars(),
    storageLimitBytes: configuredStorageLimitBytes(),
  });
}

/**
 * 记忆的章号。表里没有 chapter 列，章号只存在于 id 与 source：
 * makeId 把章号写进 `mem-c<章>-p<段>-<hash>`（store.mjs 的 makeId），
 * 所以优先从 id 解析（'00' → '0'），解析不出才退回 source 前 12 字符，都没有就是空串。
 */
function chapterOf(row) {
  const m = /^mem-c(\d+)-p\d+-/.exec(String(row?.id ?? ''));
  if (m) return String(Number(m[1]));
  const src = row?.source;
  return src ? String(src).slice(0, 12) : '';
}

/** 从库里取「同属性多值」候选，与面板脚本同判据（展示用粗筛）。 */
function collectConflicts(facts, cap = 40) {
  const byAttr = new Map();
  for (const f of facts) {
    if (!f.attr || f.value == null) continue;
    if (!byAttr.has(f.attr)) byAttr.set(f.attr, new Set());
    byAttr.get(f.attr).add(String(f.value));
  }
  return [...byAttr.entries()]
    .filter(([, v]) => v.size > 1)
    .map(([attr, vals]) => ({ attr, values: [...vals] }))
    .sort((a, b) => b.values.length - a.values.length)
    .slice(0, cap);
}

/**
 * 密钥状态快照。只给掩码，绝不给明文——即便调用方是本机面板。
 * groups 是三组各自的状态（掩码 / 是否已配置 / 来源 / 是否继承 chat）；
 * 顶层三个字段是 chat 组的旧别名，旧面板读法不变。
 * flags 一并回传，前端一次就能看到「密钥到位后五盏灯哪几盏亮了」。
 */
function keyState() {
  const groups = {};
  for (const g of CRED_GROUPS) groups[g] = groupReport(g);
  return {
    hasKey: groups.chat.keyConfigured,
    keyMasked: groups.chat.keyMasked,
    keySource: groups.chat.keySource,
    groups,
    flags: moduleFlags(),
  };
}

/**
 * 每组的探测请求：端点、请求体都用**该组**自己的 baseUrl / model。
 * 三组协议不同（chat/completions、embeddings、rerank），所以按组分派而不是只换 URL。
 * 返回的 endpoint 里不含 key——诊断需要看打到哪，但绝不能让 key 落到返回值里。
 */
function probeSpec(group) {
  if (group === 'embed') {
    return {
      endpoint: `${embedBaseUrl()}/embeddings`,
      model: embedModel(),
      body: (model) => ({ model, input: 'ping' }),
    };
  }
  if (group === 'rerank') {
    return {
      endpoint: `${rerankBaseUrl()}/rerank`,
      model: rerankModel(),
      body: (model) => ({ model, query: 'ping', documents: ['ping'] }),
    };
  }
  return {
    endpoint: `${chatBaseUrl()}/chat/completions`,
    model: chatModel(),
    body: (model) => ({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }),
  };
}

/**
 * 探一次密钥是否可用（用该组的端点、该组的模型）。
 * 注意外层信封仍返回成功：这是「测试结果」不是「RPC 失败」，
 * 只有入参问题才走 fail()，面板据此区分「连通性失败」与「调用方式错了」。
 */
async function testKey(group, key) {
  const spec = probeSpec(group);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_KEY_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(spec.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(spec.body(spec.model)),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const body = await res.text().catch(() => '');
    if (res.ok) return { ok: true, group, status: res.status, latencyMs, model: spec.model, endpoint: spec.endpoint };
    return {
      ok: false,
      group,
      status: res.status,
      latencyMs,
      model: spec.model,
      endpoint: spec.endpoint,
      message: String(body ?? '').slice(0, ERROR_TEXT_CAP),
    };
  } catch (err) {
    return {
      ok: false,
      group,
      status: null,
      latencyMs: Date.now() - started,
      model: spec.model,
      endpoint: spec.endpoint,
      message: (err?.name === 'AbortError'
        ? `请求超时（${TEST_KEY_TIMEOUT_MS}ms）`
        : String(err?.message ?? err)).slice(0, ERROR_TEXT_CAP),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注册 /memjudge RPC 通道。返回 disposer；无 Connection RPC 时静默返回空函数，
 * 面板会显示「宿主未提供 RPC」而不是把整个插件搞崩。
 * @param {object} ctx  DSH 宿主 apply 上下文
 * @param {object} opts { dbPath }
 */
export function installMemjudgeRpc(ctx, opts = {}) {
  const dbPath = opts.dbPath;
  const handler = async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'status': {
          const store = openConfiguredStore(dbPath);
          const stats = store.stats();
          const totalFacts = stats.facts;
          const attrCount = new Set(store.allFacts().map((f) => f.attr)).size;
          store.close();
          // config.groups 里三组各自的 baseUrl/model/key 掩码/继承标记齐全
          return ok({ stats: { ...stats, attrCount }, config: configReport() });
        }
        case 'memories': {
          const limit = Number.isFinite(payload?.limit) ? payload.limit : 120;
          // 规格 §11.2：默认 desc（用户直觉是「最新的」，不是「最早的」）。
          // 只有显式 asc 才回到旧行为，store 层默认值保持 asc 不动，内部导出不受影响。
          const order = payload?.order === 'asc' ? 'asc' : 'desc';
          const store = openConfiguredStore(dbPath);
          const rows = store.list({ limit, includeText: true, order });
          const total = store.stats().memories;
          store.close();
          return ok({
            order,
            total,
            rows: rows.map((r) => ({
              id: r.id,
              chapter: chapterOf(r),
              created: r.created_at,
              accessed: r.last_accessed,
              importance: r.importance,
              text: String(r.text ?? '').slice(0, 200),
              // source 一列两用：无显式来源时存章段编码（c0-p0），有来源时存用户给的串。
              // 原样回传，判据留给面板（面板才知道「这种值不该显示」）。
              source: r.source ? String(r.source) : '',
            })),
          });
        }
        case 'conflicts': {
          const store = openConfiguredStore(dbPath);
          const conflicts = collectConflicts(store.allFacts(), payload?.cap ?? 40);
          store.close();
          return ok({ conflicts });
        }
        case 'saveKey': {
          const { group, error: groupError } = groupParam(payload?.group);
          if (groupError) return fail(groupError);
          // 只收字符串：数字/对象被 String() 化后能落成 "12345" 这种假密钥，宁可拒。
          const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
          if (!key) return fail('密钥为空');
          saveKey(group, key);
          // saveKey 已置 cache = null，紧接着读就是新值，status 立即一致
          return ok(keyState());
        }
        case 'clearKey': {
          const { group, error: groupError } = groupParam(payload?.group);
          if (groupError) return fail(groupError);
          saveKey(group, '');
          return ok(keyState());
        }
        case 'saveConfig': {
          const patch = payload?.patch;
          const filtered = {};
          if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
            for (const flag of WRITABLE_FLAGS) {
              if (typeof patch[flag] === 'boolean') filtered[flag] = patch[flag];
            }
          }
          if (Object.keys(filtered).length === 0) return fail('没有可写入的开关');
          saveConfig(filtered);
          // config 回原始写入内容（不含 env 覆盖），flags/envLocked 才是生效结果
          return ok({ flags: moduleFlags(), envLocked: envLockedFlags(), config: rawConfig() });
        }
        case 'saveSettings': {
          // 九项值型设置。白名单外的键静默丢弃（与 saveConfig 同风格），
          // 白名单内的任何一个不合法 → 整批拒绝，绝不写一半。
          const { patch, error } = validateSettings(payload?.settings);
          if (error) return fail(error);
          const writable = Object.keys(patch).filter((k) => SETTING_KEYS.includes(k));
          if (writable.length === 0) return fail('没有可写入的设置');
          // 生效值取自配置层（env 覆盖 config.json）：被 env 钉住的项写进去也不会变，
          // 所以「变了才置 true」这个判定用生效值比用 patch 值更诚实。
          const beforeEmbed = embedModel();
          const beforeDims = embedDims();
          saveConfig(patch);
          const vecCacheReset = (patch.embedModel !== undefined && patch.embedModel !== beforeEmbed)
            || (patch.dims !== undefined && patch.dims !== beforeDims);
          return ok({ config: configReport(), vecCacheReset });
        }
        case 'testKey': {
          const { group, error: groupError } = groupParam(payload?.group);
          if (groupError) return fail(groupError);
          const supplied = typeof payload?.key === 'string' ? payload.key.trim() : '';
          const key = supplied || GROUP_KEY[group]();
          if (!key) return fail(`未配置密钥（${group} 组）`);
          return ok(await testKey(group, key));
        }
        default:
          return fail(`未知端点 ${endpoint}`);
      }
    } catch (err) {
      return fail(err?.message ?? String(err));
    }
  };

  const conn = (ctx?.get && ctx.get('connection'))
    || (() => { try { return ctx?.connection; } catch { return null; } })();
  if (!conn?.rpc?.handle) {
    console.log('[memjudge] 宿主无 Connection RPC，设置页面板不可用');
    return () => {};
  }
  return conn.rpc.handle('/memjudge', handler, { authority: 'loopback' });
}
