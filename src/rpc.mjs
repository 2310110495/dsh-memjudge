// memjudge 宿主 RPC：给 browser 半侧（client）提供库体/记忆/冲突的只读数据。
//
// 为什么走 RPC 而不是 HTTP 服务：DSH 的 host↔browser 通信有现成契约——
// host 端 ctx.connection.rpc.handle(channel, handler, {authority:'loopback'})，
// browser 端 ctx.connection.rpc.call(channel, endpoint, payload)。照抄 dsh-pocket
// 的通道（频道名惯例 `/dsh-<包名>`），不另起端口、不暴露 200KB 库。
//
// 本文件只读：删除记忆必须走对话里的 memjudge_forget 工具，面板只展示。
// 展示层与写路径分离，避免 RPC 在宿主进程里改了库却不同步插件内存索引。

import { open as openStore } from './store.mjs';
import { configReport } from './config.mjs';

function ok(value) {
  return { ok: true, value };
}

function fail(message, code = 'bad-request') {
  return { ok: false, error: { code, message, details: {} } };
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
          const store = openStore(dbPath);
          const stats = store.stats();
          const totalFacts = stats.facts;
          const attrCount = new Set(store.allFacts().map((f) => f.attr)).size;
          store.close();
          return ok({ stats: { ...stats, attrCount }, config: configReport() });
        }
        case 'memories': {
          const limit = Number.isFinite(payload?.limit) ? payload.limit : 120;
          const store = openStore(dbPath);
          const rows = store.list({ limit, includeText: true });
          store.close();
          return ok({ rows: rows.map((r) => ({
            id: r.id,
            chapter: r.source ? String(r.source).slice(0, 12) : '',
            created: r.created_at,
            accessed: r.last_accessed,
            importance: r.importance,
            text: String(r.text ?? '').slice(0, 200),
          })) });
        }
        case 'conflicts': {
          const store = openStore(dbPath);
          const conflicts = collectConflicts(store.allFacts(), payload?.cap ?? 40);
          store.close();
          return ok({ conflicts });
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
