// T6 专项集成验收测试：宿主完整接线 (apply) + 双边闭合轮自动蒸馏 + 两段式注入 + 8 工具 + 8 RPC 路由 + dispose 全释放
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  apply,
  shouldDenyRecall,
  TOOL_NAMES,
  SECTION_NAME,
  CONTEXT_NAME,
  TIER_S_MAX_CHARS,
  TIER_D_MAX_CHARS,
  TOTAL_INJECT_MAX_CHARS,
} from '../src/index.mjs';
import { RPC_ENDPOINTS } from '../src/rpc.mjs';
import { STORE_SCHEMA_VERSION, open } from '../src/store.mjs';

const FETCH_ROUTE_PREFIX = '/api/memjudge.';

// B-1「不编造」证据门的合法拒答理由：只允许这四种真实缺证据结论，任何其它字符串都说明判定逻辑漂移。
const RECALL_DENY_REASONS = ['attribute-not-recorded', 'value-not-recorded', 'no-facts', 'entity-not-recorded'];

function createMockHost() {
  const tools = new Map();
  const sections = new Map();
  const contexts = new Map();
  const services = new Map();
  const fetchRoutes = new Map();
  const listeners = new Map();
  const effects = [];

  const addListener = (eventName, fn) => {
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    const set = listeners.get(eventName);
    set.add(fn);
    return () => set.delete(fn);
  };

  const sessionBus = {
    on(eventName, fn) {
      return addListener(`sessions:${eventName}`, fn);
    },
  };

  const ctx = {
    tools: {
      register(def) {
        if (tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    systemPrompt: {
      section(def) {
        if (sections.has(def.name)) throw new Error(`duplicate section: ${def.name}`);
        sections.set(def.name, def);
        return () => sections.delete(def.name);
      },
      context(def) {
        if (contexts.has(def.name)) throw new Error(`duplicate context: ${def.name}`);
        contexts.set(def.name, def);
        return () => contexts.delete(def.name);
      },
    },
    provide(name, api) {
      services.set(name, api);
      return () => services.delete(name);
    },
    inject(deps, factory) {
      if (Array.isArray(deps) && deps.includes('sessions')) {
        factory(sessionBus);
      }
      return () => {};
    },
    on(eventName, fn) {
      return addListener(eventName, fn);
    },
    effect(fn) {
      const cleanup = fn();
      effects.push(cleanup);
      return () => {
        const idx = effects.indexOf(cleanup);
        if (idx >= 0) effects.splice(idx, 1);
        if (typeof cleanup === 'function') cleanup();
      };
    },
    connection: {
      fetch: {
        register(route) {
          if (fetchRoutes.has(route.path)) throw new Error(`duplicate route: ${route.path}`);
          fetchRoutes.set(route.path, route.fetch ?? route.handle);
          return () => fetchRoutes.delete(route.path);
        },
      },
    },
    emitSessionEvent(session, event) {
      const sHandlers = listeners.get('sessions:session/event');
      if (sHandlers) {
        for (const fn of [...sHandlers]) fn(session, event);
      }
      const rootHandlers = listeners.get('session/event');
      if (rootHandlers) {
        for (const fn of [...rootHandlers]) fn(session, event);
      }
    },
    async callRpc(endpoint, body = {}) {
      const routePath = `${FETCH_ROUTE_PREFIX}${endpoint}`;
      const handle = fetchRoutes.get(routePath);
      assert.equal(typeof handle, 'function', `RPC 路由 ${routePath} 未注册`);
      const req = new Request(`http://127.0.0.1${routePath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const res = await handle(req);
      const json = await res.json();
      return { status: res.status, json, value: json.value };
    },
    state: {
      tools,
      sections,
      contexts,
      services,
      fetchRoutes,
      listeners,
      effects,
    },
  };

  return ctx;
}

async function waitForCondition(predicate, timeoutMs = 3000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return Boolean(await predicate());
}

test('v2 宿主全量接线验收：session/event 闭合蒸馏 + subagent 零写入 + 两段注入 + 8 工具 + 8 RPC 路由 + dispose 释放', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-v2-wiring-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpDir;
  const dbPath = path.join(tmpDir, 'memjudge-v2.db');

  let clock = Date.UTC(2026, 10, 13, 0, 0, 0);
  const host = createMockHost();
  let underlyingStore = null;

  const app = apply(
    host,
    {
      dbPath,
      autoInject: true,
      injectMode: 'tiered',
      tierSBudget: 600,
      tierDBudget: 900,
      injectBudget: 1500,
      autoCapture: true,
      vector: false,
      rerank: false,
      expand: false,
      llmSelect: false,
      metabolismIntervalMs: 60_000,
      now: () => clock,
    },
    {
      storeFactory: (...args) => {
        underlyingStore = open(...args);
        return underlyingStore;
      },
    },
  );

  try {
    // =========================================================================
    // (a) session/event 投递闭合轮自动经 turn-collector + distiller 写入原子记忆，subagent 会话 0 写入
    // =========================================================================
    const subSession = {
      id: 'sess-subagent-01',
      header: { origin: 'subagent', cwd: 'F:/Repo/SubTask' },
    };
    host.emitSessionEvent(subSession, { type: 'turn/start', turn: 1 });
    host.emitSessionEvent(subSession, {
      type: 'user/message',
      turn: 1,
      message: { role: 'user', content: [{ type: 'text', text: '请修改网关超时配置为 45 秒并验证通过。' }] },
    });
    host.emitSessionEvent(subSession, {
      type: 'tool/result',
      turn: 1,
      toolName: 'edit',
      output: 'Updated gateway.yml timeout to 45s',
    });
    host.emitSessionEvent(subSession, {
      type: 'assistant/message',
      turn: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '已将网关超时配置调整为 45 秒并通过压测验证。' }] },
    });
    host.emitSessionEvent(subSession, { type: 'turn/end', turn: 1 });

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(underlyingStore.list({ includeText: true }).length, 0, 'origin===subagent 会话必须严格 0 写入');

    const mainSession = {
      id: 'sess-main-01',
      header: { origin: 'user', cwd: 'F:/Repo/AlphaService' },
    };
    clock += 1000;
    host.emitSessionEvent(mainSession, { type: 'turn/start', turn: 1 });
    host.emitSessionEvent(mainSession, {
      type: 'user/message',
      turn: 1,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '排查 PgBouncer 连接池耗尽故障，将 default_pool_size 固定为 64 并登记线上手册 https://ops.example.internal/runbook/pgbouncer' }],
      },
    });
    host.emitSessionEvent(mainSession, {
      type: 'tool/result',
      turn: 1,
      toolName: 'edit',
      output: 'Updated pgbouncer.ini default_pool_size = 64',
    });
    host.emitSessionEvent(mainSession, {
      type: 'assistant/message',
      turn: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '我将先检查配置文件。已定位 PgBouncer 连接池耗尽根因：事务模式下并发峰值击穿默认阈值，现已将 default_pool_size 调整为 64，压测恢复正常，手册见 https://ops.example.internal/runbook/pgbouncer 。' }],
      },
    });
    host.emitSessionEvent(mainSession, { type: 'turn/end', turn: 1 });

    const drained = await waitForCondition(() => underlyingStore.list({ includeText: true }).length > 0);
    assert.equal(drained, true, '主会话闭合轮应自动经 turn-collector + distiller 异步落库');

    const captured = underlyingStore.list({ includeText: true });
    assert.ok(captured.length >= 1);
    assert.ok(
      captured.some((m) => m.text.includes('PgBouncer') || m.text.includes('default_pool_size')),
      `蒸馏落库内容未包含核心技术事实: ${JSON.stringify(captured.map((m) => m.text))}`,
    );
    assert.ok(
      captured.every((m) => !/(?<![pP])s:\/\/ops\.example/.test(m.text)),
      '严禁截断 https:// 协议头产生畸形 s:// URL',
    );

    // =========================================================================
    // (c) 全套 8 个 memjudge_* 工具（含新增 memjudge_wiki）正常执行
    // =========================================================================
    assert.equal(TOOL_NAMES.length, 8);
    assert.deepEqual([...host.state.tools.keys()].sort(), [...TOOL_NAMES].sort());
    assert.ok(host.state.tools.has('memjudge_wiki'));

    const rememberTool = host.state.tools.get('memjudge_remember');
    const recallTool = host.state.tools.get('memjudge_recall');
    const readTool = host.state.tools.get('memjudge_read');
    const demoteTool = host.state.tools.get('memjudge_demote');
    const conflictsTool = host.state.tools.get('memjudge_conflicts');
    const statsTool = host.state.tools.get('memjudge_stats');
    const wikiTool = host.state.tools.get('memjudge_wiki');
    const forgetTool = host.state.tools.get('memjudge_forget');

    clock += 1000;
    const ruleMem = await rememberTool.execute({
      text: '铁律：所有数据库迁移脚本必须具备幂等防重入保护且严禁触碰生产库。',
      category: 'rule',
      space: 'global',
      importance: 0.95,
    });
    assert.equal(ruleMem.category, 'rule');
    assert.equal(ruleMem.kind, 'promise');

    const profileMem = await rememberTool.execute({
      text: '用户 YG 是资深系统架构师，偏好直接严谨的中文技术结论。',
      category: 'profile',
      space: 'global',
      importance: 0.9,
    });
    assert.equal(profileMem.category, 'profile');
    assert.equal(profileMem.kind, 'person');

    // 单活 state 槽位两次覆写 -> 生成 memory_revisions 历史修订链
    clock += 1000;
    const stateV1 = await rememberTool.execute({
      text: 'AlphaService 当前部署分支为 release/2026.10，副本数为 2。',
      category: 'state',
      slotKey: 'deploy:alpha-branch',
      space: mainSession.header.cwd,
    });
    clock += 1000;
    const stateV2 = await rememberTool.execute({
      text: 'AlphaService 当前部署分支已切换为 release/2026.11，副本数为 4。',
      category: 'state',
      slotKey: 'deploy:alpha-branch',
      space: mainSession.header.cwd,
    });
    assert.equal(stateV1.id, stateV2.id, '同 spaceId + slotKey 单活状态必须原地更新同一条记忆');

    // 同文档数值矛盾对（供 memjudge_conflicts 与 RPC conflicts 验证）
    await rememberTool.execute({
      text: '网关的响应时限为15秒。',
      documentId: 'arch-spec-v2',
      chapter: 1,
      para: 1,
      space: mainSession.header.cwd,
    });
    await rememberTool.execute({
      text: '网关的响应时限为45秒。',
      documentId: 'arch-spec-v2',
      chapter: 1,
      para: 2,
      space: mainSession.header.cwd,
    });

    const recallRes = await recallTool.execute({
      query: 'PgBouncer default_pool_size 连接池',
    }, { agent: { session: mainSession } });
    assert.equal(recallRes.denied, false);
    assert.ok(recallRes.hits.length >= 1);

    const readRes = readTool.execute({ id: stateV2.id });
    assert.equal(readRes.found, true);
    assert.match(readRes.text, /release\/2026\.11/);

    const conflictRes = await conflictsTool.execute({ limit: 10, space: mainSession.header.cwd });
    assert.ok(conflictRes.total >= 1);

    // memjudge_wiki 编译与读取
    const wikiCompiled = await wikiTool.execute({ action: 'compile' });
    assert.ok(wikiCompiled.compiled >= 1);
    const wikiListed = await wikiTool.execute({ action: 'list' });
    assert.ok(wikiListed.totalPages >= 1);
    const firstPage = wikiListed.pages[0];
    const wikiRead = await wikiTool.execute({
      action: 'read',
      space: firstPage.spaceId,
      slug: firstPage.slug,
    });
    assert.ok(wikiRead.page);
    assert.ok(wikiRead.page.markdown.length > 0);

    // 写入一条临时 rule 再降级 + 删除验证 demote & forget
    const tempRule = await rememberTool.execute({
      text: '临时测试规则：将在验证 demote 与 forget 后物理清除。',
      kind: 'promise',
    });
    const demoted = await demoteTool.execute({ id: tempRule.id });
    assert.equal(demoted.changed, true);
    assert.equal(demoted.kind, 'event');
    const forgotten = await forgetTool.execute({ id: tempRule.id });
    assert.equal(forgotten.count, 1);

    const statsRes = await statsTool.execute({ verbose: true });
    assert.equal(statsRes.schemaVersion, 8);
    assert.ok(statsRes.categories.rule >= 1);
    assert.ok(statsRes.categories.profile >= 1);

    // =========================================================================
    // (b) Tier-S 静态热底座 (<=600 chars, 单会话字节恒定) 与 Tier-D 按问动态召回 (<=900 chars, 无关提问 0 字符)
    // =========================================================================
    const sectionDef = host.state.sections.get(SECTION_NAME);
    const contextDef = host.state.contexts.get(CONTEXT_NAME);
    assert.ok(sectionDef && contextDef, 'section 与 context 两段注入通道均须完成注册');

    const promptSession = {
      id: 'sess-kv-stable',
      header: { origin: 'user', cwd: mainSession.header.cwd },
    };

    const tierSFirst = sectionDef.text({ session: promptSession });
    assert.ok(tierSFirst.length > 0 && tierSFirst.length <= TIER_S_MAX_CHARS, `Tier-S 长度越界: ${tierSFirst.length}`);
    assert.match(tierSFirst, /铁律|YG|release\/2026\.11/);

    // 会话中途新增一条高优 rule，单会话已冻结的 Tier-S 必须保持字节 100% 恒定以保护 Prefix KV Cache
    await rememberTool.execute({
      text: '中途新增铁律：不得破坏已冻结会话的 Tier-S 前缀字节稳定性。',
      category: 'rule',
      space: 'global',
      importance: 1.0,
    });
    const tierSSecond = sectionDef.text({ session: promptSession });
    assert.equal(tierSSecond, tierSFirst, '单会话生命周期内多次调用 Tier-S 必须字节级恒定');

    // Tier-D：相关技术提问命中动态召回且 <= 900 chars，总和 <= 1500 chars
    const tierDRelevant = contextDef.text({
      session: promptSession,
      messages: [{ role: 'user', content: 'PgBouncer 连接池耗尽时 default_pool_size 调成了多少？' }],
    });
    assert.ok(tierDRelevant.length > 0 && tierDRelevant.length <= TIER_D_MAX_CHARS, `Tier-D 长度越界: ${tierDRelevant.length}`);
    assert.ok(tierSFirst.length + tierDRelevant.length <= TOTAL_INJECT_MAX_CHARS);
    assert.match(tierDRelevant, /PgBouncer|64/);

    // Tier-D：完全无关的提问必须返回 0 字符
    const tierDIrrelevant = contextDef.text({
      session: promptSession,
      messages: [{ role: 'user', content: '1998 年法国世界杯决赛进球球员有谁？' }],
    });
    assert.equal(tierDIrrelevant, '', '无关提问必须严格返回 0 字符');

    // Tier-D：subagent 会话两段注入均为 0 字符
    assert.equal(sectionDef.text({ session: subSession }), '');
    assert.equal(
      contextDef.text({
        session: subSession,
        messages: [{ role: 'user', content: 'PgBouncer default_pool_size' }],
      }),
      '',
    );

    // =========================================================================
    // (d) 严格 8 条 /api/memjudge.* RPC 路由完整返回 v2 扩展字段
    // =========================================================================
    assert.equal(RPC_ENDPOINTS.length, 8, 'RPC_ENDPOINTS 必须严格收敛为 8 条标准路由');
    assert.equal(host.state.fetchRoutes.size, 8, '注册到宿主的 Fetch 路由数量必须严格等于 8');

    const statusRpc = await host.callRpc('status', {});
    assert.equal(statusRpc.status, 200);
    assert.equal(statusRpc.json.ok, true);
    assert.equal(statusRpc.value.schemaVersion, STORE_SCHEMA_VERSION);
    assert.ok(Array.isArray(statusRpc.value.spaces) && statusRpc.value.spaces.length >= 2);
    assert.equal(typeof statusRpc.value.categories, 'object');
    assert.equal(typeof statusRpc.value.layers, 'object');
    assert.equal(typeof statusRpc.value.tierS, 'object');
    assert.equal(typeof statusRpc.value.tierD, 'object');
    assert.ok(Array.isArray(statusRpc.value.wiki_pages) && statusRpc.value.wiki_pages.length >= 1);
    assert.ok(Array.isArray(statusRpc.value.states) && statusRpc.value.states.length >= 1);

    // memories 路由：默认返回严格 7 字段兼容预览契约，items 携带完整 v2 字段
    const previewMemRpc = await host.callRpc('memories', { limit: 50 });
    assert.equal(previewMemRpc.json.ok, true);
    assert.deepEqual(
      Object.keys(previewMemRpc.value.rows[0]).sort(),
      ['accessed', 'chapter', 'created', 'id', 'importance', 'source', 'text'],
    );
    assert.ok(Array.isArray(previewMemRpc.value.items) && previewMemRpc.value.items.length >= 1);

    // memories 路由：支持按 spaceId / category / layer / q / withRevisions 查询并返回 slotKey 与 revisions
    const memRpc = await host.callRpc('memories', {
      category: 'state',
      withRevisions: true,
      v2: true,
    });
    assert.equal(memRpc.status, 200);
    assert.equal(memRpc.json.ok, true);
    assert.ok(memRpc.value.rows.length >= 1);
    const stateRow = memRpc.value.rows.find((r) => r.id === stateV2.id);
    assert.ok(stateRow, 'memories 路由应能按 category=state 查出单活状态记忆');
    assert.equal(stateRow.slotKey, 'deploy:alpha-branch');
    assert.ok(Array.isArray(stateRow.revisions) && stateRow.revisions.length >= 1, '应返回 memory_revisions 修订历史');

    // memories 路由内部收敛的 wiki / metabolism 动作
    const wikiViaRpc = await host.callRpc('memories', { action: 'wiki' });
    assert.equal(wikiViaRpc.json.ok, true);
    assert.ok(Array.isArray(wikiViaRpc.value.wiki_pages) && wikiViaRpc.value.wiki_pages.length >= 1);
    assert.ok(Array.isArray(wikiViaRpc.value.states) && wikiViaRpc.value.states.length >= 1);

    const metabViaRpc = await host.callRpc('status', { action: 'metabolism' });
    assert.equal(metabViaRpc.json.ok, true);
    assert.ok(metabViaRpc.value.metabolism);

    const conflictsRpc = await host.callRpc('conflicts', { limit: 10 });
    assert.equal(conflictsRpc.status, 200);
    assert.equal(conflictsRpc.json.ok, true);
    assert.ok(conflictsRpc.value.total >= 1);

    // 配置与密钥路由（隔离在临时 DSH_HOME 内）
    const saveSettingsRpc = await host.callRpc('saveSettings', {
      settings: { maxChars: 1200, chatBaseUrl: 'https://api.deepseek.com/v1', chatModel: 'deepseek-chat' },
    });
    assert.equal(saveSettingsRpc.json.ok, true);
    const saveCfgRpc = await host.callRpc('saveConfig', {
      patch: { expand: false, autoCapture: true },
    });
    assert.equal(saveCfgRpc.json.ok, true);
    const saveKeyRpc = await host.callRpc('saveKey', { group: 'chat', key: 'sk-isolated-test-key-123456' });
    assert.equal(saveKeyRpc.json.ok, true);
    assert.equal(saveKeyRpc.value.hasKey, true);
    const clearKeyRpc = await host.callRpc('clearKey', { group: 'chat' });
    assert.equal(clearKeyRpc.json.ok, true);
    assert.equal(clearKeyRpc.value.hasKey, false);
    const testKeyRpc = await host.callRpc('testKey', { group: 'chat' });
    assert.equal(testKeyRpc.json.ok, false);
    assert.equal(testKeyRpc.json.error.code, 'missing-key');

    // =========================================================================
    // (e) dispose() 后路由、工具、提示词通道、服务、事件监听器、定时器与 DB 连接全部释放
    // =========================================================================
    app.dispose();

    assert.equal(host.state.fetchRoutes.size, 0, 'dispose 后 8 条 RPC 路由必须全部注销');
    assert.equal(host.state.tools.size, 0, 'dispose 后 8 个工具必须全部注销');
    assert.equal(host.state.sections.size, 0, 'dispose 后 systemPrompt.section 必须注销');
    assert.equal(host.state.contexts.size, 0, 'dispose 后 systemPrompt.context 必须注销');
    assert.equal(host.state.services.size, 0, 'dispose 后 memjudge service 必须注销');
    for (const [ev, set] of host.state.listeners.entries()) {
      assert.equal(set.size, 0, `dispose 后事件监听器 ${ev} 必须清空`);
    }
    assert.throws(() => underlyingStore.stats(), /已关闭/, 'dispose 后底层 SQLite 连接必须已关闭');
  } finally {
    app.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function assertMatchesJsonSchema(val, schema, pathLabel = '$') {
  assert.ok(schema && typeof schema === 'object', `${pathLabel}: schema 必须存在`);
  const allowedTypes = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);

  const matchesSingleType = (v, t) => {
    if (t === 'null') return v === null;
    if (t === 'array') return Array.isArray(v);
    if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
    if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
    if (t === 'boolean') return typeof v === 'boolean';
    if (t === 'string') return typeof v === 'string';
    if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
    return false;
  };

  if (allowedTypes.length > 0) {
    const okType = allowedTypes.some((t) => matchesSingleType(val, t));
    assert.equal(
      okType,
      true,
      `${pathLabel}: 类型不匹配，期望 ${JSON.stringify(allowedTypes)}，实际值=${JSON.stringify(val)}`,
    );
  }

  if (Array.isArray(schema.enum) && val !== null) {
    assert.equal(
      schema.enum.includes(val),
      true,
      `${pathLabel}: 枚举值非法，期望 ${JSON.stringify(schema.enum)}，实际=${JSON.stringify(val)}`,
    );
  }

  if (val === null || val === undefined) return;

  if (Array.isArray(val) && schema.items) {
    for (let i = 0; i < val.length; i += 1) {
      assertMatchesJsonSchema(val[i], schema.items, `${pathLabel}[${i}]`);
    }
    return;
  }

  if (typeof val === 'object' && !Array.isArray(val)) {
    const props = schema.properties ?? {};
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(val, reqKey) && val[reqKey] !== undefined,
          true,
          `${pathLabel}: 缺少必填属性 "${reqKey}"`,
        );
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(val)) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(props, k),
          true,
          `${pathLabel}: 存在 output.schema 未声明的多余属性 "${k}"`,
        );
      }
    }
    for (const [k, propSchema] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(val, k) && val[k] !== undefined) {
        assertMatchesJsonSchema(val[k], propSchema, `${pathLabel}.${k}`);
      }
    }
  }
}

test('T11 审查门禁回归（S2-①/④ + B4/B5/B6/B7/M3/M4/M5）：8 工具递归 Schema 严格校验 + 跨工作区 state 隔离 + 纯 section 宿主预算合成', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-t11-schema-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpDir;
  const dbPath = path.join(tmpDir, 't11-schema.db');

  const wsA = path.join(tmpDir, 'repo-alpha');
  const wsB = path.join(tmpDir, 'repo-beta');
  fs.mkdirSync(path.join(wsA, '.git'), { recursive: true });
  fs.mkdirSync(path.join(wsB, '.git'), { recursive: true });

  const host = createMockHost();
  const app = apply(host, {
    dbPath,
    autoCapture: false,
    llmDistill: false,
    metabolismIntervalMs: 0,
  });

  try {
    const sessionA = { id: 'sess-alpha-1', header: { origin: 'user', cwd: wsA } };
    const sessionB = { id: 'sess-beta-1', header: { origin: 'user', cwd: wsB } };
    const invoke = async (name, input, session = sessionA) => {
      const def = host.state.tools.get(name);
      assert.ok(def, `缺少工具 ${name}`);
      assert.ok(def.output?.schema, `工具 ${name} 缺少 output.schema`);
      const res = await def.execute(input, { agent: { session }, session, cwd: session?.header?.cwd });
      assertMatchesJsonSchema(res, def.output.schema, name);
      return res;
    };

    // 1) memjudge_remember：写入多类型记忆（含冲突槽位、否定极性、跨空间单活 state、待降级/删除条目）
    const rRule = await invoke('memjudge_remember', {
      text: '网关超时阈值统一设定为 15 秒。',
      category: 'rule',
      importance: 0.9,
      chapter: 1,
      para: 1,
    }, sessionA);
    assert.equal(rRule.created, true);

    const rConflict2 = await invoke('memjudge_remember', {
      text: '压测环境网关超时阈值现调整为 30 秒。',
      category: 'decision',
      supersedes: [rRule.id],
      chapter: 1,
      para: 2,
    }, sessionA);
    assert.equal(rConflict2.created, true);

    await invoke('memjudge_remember', {
      text: '只读副本连接池不是 64 个连接，而是 32 个连接。',
      category: 'experience',
      chapter: 2,
      para: 1,
    }, sessionA);

    const rStateA = await invoke('memjudge_remember', {
      text: 'Alpha 工作区当前监听端口为 8080。',
      category: 'state',
      slotKey: 'service:port',
    }, sessionA);
    const rStateB = await invoke('memjudge_remember', {
      text: 'Beta 工作区当前监听端口为 9090。',
      category: 'state',
      slotKey: 'service:port',
    }, sessionB);
    await invoke('memjudge_remember', {
      text: '私有会话临时调试令牌状态已就绪。',
      category: 'state',
      space: 'session:private-only',
      slotKey: 'debug:token',
    }, sessionA);
    assert.notEqual(rStateA.id, rStateB.id);

    const rDemoteTarget = await invoke('memjudge_remember', {
      text: '构建产物目录临时放置在 dist-temp。',
      kind: 'promise',
    }, sessionA);
    const rForgetTarget = await invoke('memjudge_remember', {
      text: '待清理的临时沙箱日志记录。',
      category: 'experience',
    }, sessionA);

    // M3：验证工作区自动注册真实落库 rootPath
    const statsOut = await invoke('memjudge_stats', { verbose: true }, sessionA);
    assert.equal(typeof statsOut.layers.L0, 'number');
    assert.equal(typeof statsOut.layers.L1, 'number');
    const alphaSpaceRow = statsOut.spaces.find((s) => s.id === rStateA.spaceId);
    assert.ok(alphaSpaceRow, 'stats.spaces 必须包含已自动注册的 Alpha 工作区空间');

    // 2) memjudge_recall：验证 gateSlots 命中放行（M5）与拒答路径均满足 Schema
    const recallHit = await invoke('memjudge_recall', {
      query: '网关超时阈值是多少？',
      budget: 800,
    }, sessionA);
    assert.equal(recallHit.denied, false);
    assert.ok(recallHit.hits.length >= 1);

    const recallDeny = await invoke('memjudge_recall', {
      query: 'K8s 集群 Pod 副本上限是多少？',
      budget: 600,
    }, sessionA);
    assert.equal(recallDeny.denied, true, 'B-1：库里没有的槽位必须拒答，不能只在返回值类型上做文章');
    assert.ok(
      RECALL_DENY_REASONS.includes(recallDeny.reason),
      `拒答 reason 必须落在声明白名单内，实际 ${recallDeny.reason}`,
    );
    assert.equal(recallDeny.chars, 0, '拒答不得返回正文');

    // 3) memjudge_read：读取完整原文
    const readOut = await invoke('memjudge_read', { id: rRule.id, offset: 0, limit: 200 }, sessionA);
    assert.equal(readOut.found, true);

    // 4) memjudge_conflicts：验证 conflictType 为枚举字符串且 polarity 为字符串（B4）
    const confOut = await invoke('memjudge_conflicts', { limit: 20 }, sessionA);
    assert.ok(confOut.total >= 1, '应至少检出 1 组冲突');
    for (const c of confOut.conflicts) {
      assert.equal(typeof c.conflictType, 'string');
      assert.ok(['supersession', 'conditional', 'disputed'].includes(c.conflictType));
      for (const ev of c.evidence) {
        assert.ok(['affirm', 'negate', 'neutral'].includes(ev.polarity));
      }
    }

    // 5) memjudge_wiki：compile / list / get 全满足 Schema（无多余 pageId），且严格按空间隔离 states（B6 + S2-④）
    const wikiCompile = await invoke('memjudge_wiki', { action: 'compile' }, sessionA);
    assert.equal(wikiCompile.action, 'compile');

    const wikiListA = await invoke('memjudge_wiki', { action: 'list' }, sessionA);
    const stateTextsA = wikiListA.states.map((s) => s.text).join('\n');
    assert.match(stateTextsA, /Alpha 工作区当前监听端口为 8080/);
    assert.doesNotMatch(stateTextsA, /Beta 工作区当前监听端口为 9090/, '严禁跨工作区泄漏 Beta 的 state 记忆');
    assert.doesNotMatch(stateTextsA, /私有会话临时调试令牌状态/, '严禁泄漏非当前私有会话的 state 记忆');

    if (wikiListA.pages.length > 0) {
      const firstPage = wikiListA.pages[0];
      assert.equal(Object.prototype.hasOwnProperty.call(firstPage, 'pageId'), false, 'memjudge_wiki 页面不得含未声明的 pageId');
      const wikiGet = await invoke('memjudge_wiki', { action: 'get', slug: firstPage.slug }, sessionA);
      assert.equal(wikiGet.pages.length, 1);
      assert.equal(wikiGet.pages[0].slug, firstPage.slug);
    }

    // 6) memjudge_demote & memjudge_forget：全部通过递归 Schema 校验
    const demoteOut = await invoke('memjudge_demote', { id: rDemoteTarget.id }, sessionA);
    assert.equal(demoteOut.changed, true);

    const forgetDry = await invoke('memjudge_forget', { id: rForgetTarget.id, dryRun: true }, sessionA);
    assert.equal(forgetDry.dryRun, true);
    const forgetReal = await invoke('memjudge_forget', { id: rForgetTarget.id }, sessionA);
    assert.equal(forgetReal.count, 1);

    // 7) B7：验证仅支持 systemPrompt.section（无 context 通道）的宿主统一走两段式预算合成
    const sectionOnlySections = new Map();
    const sectionOnlyTools = new Map();
    const sectionOnlyCtx = {
      tools: {
        register(def) {
          sectionOnlyTools.set(def.name, def);
          return () => sectionOnlyTools.delete(def.name);
        },
      },
      systemPrompt: {
        section(def) {
          sectionOnlySections.set(def.name, def);
          return () => sectionOnlySections.delete(def.name);
        },
      },
      provide: () => () => {},
    };
    const dbPathSectionOnly = path.join(tmpDir, 't11-section-only.db');
    const appSectionOnly = apply(sectionOnlyCtx, {
      dbPath: dbPathSectionOnly,
      autoInject: true,
      autoCapture: false,
      metabolismIntervalMs: 0,
    });
    try {
      const remOnly = sectionOnlyTools.get('memjudge_remember');
      await remOnly.execute(
        { text: '铁律：网关超时阈值固定为 15 秒。', category: 'rule' },
        { agent: { session: sessionA }, session: sessionA, cwd: wsA },
      );
      await remOnly.execute(
        { text: '排查经验：SQLite 锁等待 busy_timeout 设为 5000 毫秒可消除并发写冲突。', category: 'experience' },
        { agent: { session: sessionA }, session: sessionA, cwd: wsA },
      );
      const sec = sectionOnlySections.get(SECTION_NAME);
      const rendered = sec.text({
        session: sessionA,
        messages: [{ role: 'user', content: 'SQLite 锁等待 busy_timeout 设为多少？' }],
      });
      assert.ok(rendered.length > 0 && rendered.length <= TOTAL_INJECT_MAX_CHARS);
      assert.match(rendered, /网关超时阈值/);
      assert.match(rendered, /busy_timeout/);
    } finally {
      appSectionOnly.dispose();
    }
  } finally {
    app.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T11 审查门禁回归（S2-②/③ + B2/B3/M1）：缺省开启双边自动采集 + vector:true 向量写入/清空零异常', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-t11-vec-autocap-'));
  const prevHome = process.env.DSH_HOME;
  const prevEmbedUrl = process.env.MEMJUDGE_EMBED_BASE_URL;
  const prevEmbedKey = process.env.MEMJUDGE_EMBED_KEY;
  const prevEmbedModel = process.env.MEMJUDGE_EMBED_MODEL;
  process.env.DSH_HOME = tmpDir;
  process.env.MEMJUDGE_EMBED_BASE_URL = 'http://127.0.0.1:59999/v1';
  process.env.MEMJUDGE_EMBED_KEY = 'sk-mock-embed-key-isolated';
  process.env.MEMJUDGE_EMBED_MODEL = 'mock-embed-64d';

  const { secretsFilePath } = await import('../src/config.mjs');
  assert.equal(
    path.normalize(secretsFilePath({ DSH_HOME: tmpDir })),
    path.normalize(path.join(tmpDir, 'memjudge', 'secrets.json')),
    'M1: secretsFilePath 必须严格跟随 DSH_HOME 隔离目录',
  );

  const origFetch = globalThis.fetch;
  let embedCalls = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/embeddings')) {
      embedCalls += 1;
      const body = JSON.parse(init?.body || '{}');
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const d = Number(body.dimensions) || 64;
      return new Response(
        JSON.stringify({
          data: inputs.map((_, i) => ({
            index: i,
            embedding: Array.from({ length: d }, (__, k) => ((k + i) % 7 - 3) * 0.15),
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch url: ${u}`);
  };

  const dbPath = path.join(tmpDir, 't11-vec-autocap.db');
  const host = createMockHost();
  let underlyingStore = null;

  // 注意：故意不传 autoCapture 选项，验证缺省配置下自动采集默认开启（B3 / S2-②）
  const app = apply(
    host,
    {
      dbPath,
      vector: true,
      dims: 64,
      llmDistill: false,
      ingestIntervalMs: 30,
      metabolismIntervalMs: 0,
    },
    {
      fetch: globalThis.fetch,
      storeFactory: (...args) => {
        underlyingStore = open(...args);
        return underlyingStore;
      },
    },
  );

  try {
    const wsDir = path.join(tmpDir, 'workspace-vec');
    fs.mkdirSync(path.join(wsDir, '.git'), { recursive: true });
    const session = { id: 'sess-default-autocap', header: { origin: 'user', cwd: wsDir } };

    // 1) S2-②：未传 autoCapture 时发送闭合轮次，自动采集必须生效落库
    host.emitSessionEvent(session, { type: 'turn/start', turn: 1 });
    host.emitSessionEvent(session, {
      type: 'user/message',
      turn: 1,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '项目铁律：SQLite 忙等待超时 busy_timeout 必须固定配置为 5000 毫秒，禁止改成 0。' }],
      },
    });
    host.emitSessionEvent(session, {
      type: 'assistant/message',
      turn: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '已确认并将 SQLite busy_timeout 固定为 5000 毫秒，后续连接初始化均遵循该配置。' }],
      },
    });
    host.emitSessionEvent(session, { type: 'turn/end', turn: 1 });

    const autoSaved = await waitForCondition(() => (underlyingStore?.stats()?.memories ?? 0) >= 1, 3000);
    assert.equal(autoSaved, true, '未显式传 autoCapture 时，缺省配置必须自动采集并落库');

    // 2) S2-③ + B2：调用 memjudge_remember 触发异步 embedOne -> index.setVector，再调用 reindex 触发 index.clearVectors
    const rememberDef = host.state.tools.get('memjudge_remember');
    const remRes = await rememberDef.execute(
      { text: '数据库连接池最大容量调整为 128。', category: 'decision' },
      { agent: { session }, session, cwd: wsDir },
    );
    assert.equal(remRes.created, true);

    const vecReady = await waitForCondition(
      () => embedCalls >= 1 && (underlyingStore?.getVectors?.({ dims: 64 })?.length ?? 0) >= 1,
      3000,
    );
    assert.equal(vecReady, true, 'vector:true 时必须成功写入向量并调用 SearchIndex.setVector');

    const reindexRpc = await host.callRpc('status', { action: 'reindex' });
    assert.equal(reindexRpc.status, 200);
    assert.equal(reindexRpc.json.ok, true);
    assert.ok(reindexRpc.value.reindex.docs >= 2, 'reindex 调用 clearVectors + 重建索引不得抛错');
  } finally {
    globalThis.fetch = origFetch;
    app.dispose();
    if (prevEmbedUrl === undefined) delete process.env.MEMJUDGE_EMBED_BASE_URL;
    else process.env.MEMJUDGE_EMBED_BASE_URL = prevEmbedUrl;
    if (prevEmbedKey === undefined) delete process.env.MEMJUDGE_EMBED_KEY;
    else process.env.MEMJUDGE_EMBED_KEY = prevEmbedKey;
    if (prevEmbedModel === undefined) delete process.env.MEMJUDGE_EMBED_MODEL;
    else process.env.MEMJUDGE_EMBED_MODEL = prevEmbedModel;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T12 B-1 证据门回归：不编造必须真拒、正确召回必须放行、槽位命中可豁免片段误拒', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-t12-deny-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpDir;
  const host = createMockHost();
  const app = apply(host, {
    dbPath: path.join(tmpDir, 't12-deny.db'),
    autoCapture: false,
    llmDistill: false,
    metabolismIntervalMs: 0,
  });

  try {
    const session = { id: 'sess-t12-deny', header: { origin: 'user', cwd: tmpDir } };
    const invoke = async (name, input) => {
      const def = host.state.tools.get(name);
      assert.ok(def, `缺少工具 ${name}`);
      return def.execute(input, { agent: { session }, session, cwd: session.header.cwd });
    };
    const recall = (query) => invoke('memjudge_recall', { query, budget: 800 });

    // 隔离库只写这一条：正例与反例都围绕它展开
    const written = await invoke('memjudge_remember', {
      text: '核心网关监听端口为 8080。',
      category: 'state',
      space: 'global',
      slotKey: 'service:core-gateway-port',
    });
    assert.equal(written.created, true);
    // 实体未记录场景需要「检索能命中、但槽位图里没有该实体」：补一条同话题
    // 但不同实体的记忆，否则该问句在检索层就以 no-candidates 拒掉，进不到证据门。
    await invoke('memjudge_remember', {
      text: '火星探测任务的氧气源为电解水制氧。',
      category: 'state',
      space: 'global',
      slotKey: 'mission:mars-oxygen-source',
    });

    // ① 属性未记录：实体在库里、问的属性不在 → 必须拒答且不返回正文
    const rAttr = await recall('核心网关的鉴权密钥是多少？');
    assert.equal(rAttr.denied, true, '①属性未记录必须拒答');
    assert.ok(RECALL_DENY_REASONS.includes(rAttr.reason), `①拒答 reason 非法：${rAttr.reason}`);
    assert.equal(rAttr.chars, 0, '①拒答不得返回正文');

    // ② 属性未记录（另一种问法）：同样必须拒
    const rCity = await recall('核心网关的部署机房在哪个城市？');
    assert.equal(rCity.denied, true, '②属性未记录必须拒答');
    assert.ok(RECALL_DENY_REASONS.includes(rCity.reason), `②拒答 reason 非法：${rCity.reason}`);
    assert.equal(rCity.chars, 0, '②拒答不得返回正文');

    // ③ 实体未记录：库里没有这个实体 → 必须拒
    const rEnt = await recall('火星基地的氧气储量是多少？');
    assert.equal(rEnt.denied, true, '③实体未记录必须拒答');
    assert.ok(RECALL_DENY_REASONS.includes(rEnt.reason), `③拒答 reason 非法：${rEnt.reason}`);
    assert.equal(rEnt.chars, 0, '③拒答不得返回正文');

    // ④ 值未记录：实体与属性都在，问的值不是已记录值 → 必须拒
    const rVal = await recall('核心网关监听端口是 9090 吗？');
    assert.equal(rVal.denied, true, '④值未记录必须拒答');
    assert.ok(RECALL_DENY_REASONS.includes(rVal.reason), `④拒答 reason 非法：${rVal.reason}`);
    assert.equal(rVal.chars, 0, '④拒答不得返回正文');

    // ⑤ 正确命中必须放行：修 B-1 不能把同实体同属性的正常召回一起拒死
    const rHit = await recall('核心网关监听端口是多少？');
    assert.equal(rHit.denied, false, '⑤同实体同属性的正常召回不得被拒');
    assert.ok(rHit.hits.length >= 1, '⑤正常召回必须带回命中');
    assert.ok(JSON.stringify(rHit.hits).includes('8080'), '⑤命中必须带回真实正文');

    // ⑥ 解释型问句放行：问缘由不是问某个槽位的值
    const rWhy = await recall('为什么核心网关监听 8080？');
    assert.equal(rWhy.denied, false, '⑥解释型问句不得拒答');

    // ⑦ 槽位 affirm 豁免：片段核验要拒时，槽位门「肯定命中」必须能翻案（否则长文本截断必然误拒）
    const bodyDeny = { deny: true, reason: 'no-facts' };
    const slotHit = { deny: false, reason: 'hit', hits: [{ value: '8080' }] };
    assert.equal(shouldDenyRecall(bodyDeny, slotHit), false, '⑦槽位命中必须豁免片段误拒');
    assert.equal(shouldDenyRecall(bodyDeny, { deny: false, reason: 'hit', hits: [] }), true, '⑦槽位 hit 但无命中行不得豁免');
    assert.equal(shouldDenyRecall(bodyDeny, null), true, '⑦两门均无证据必须拒');
    assert.equal(
      shouldDenyRecall({ deny: false, reason: 'hit' }, { deny: true, reason: 'attribute-not-recorded' }),
      false,
      '⑦片段核验放行即放行：槽位图抽不出属性不等于事实不存在',
    );
    assert.equal(
      shouldDenyRecall({ deny: false, reason: 'hit' }, { deny: true, reason: 'explain-question' }),
      false,
      '⑦解释型问句不得被槽位门拒',
    );
  } finally {
    app.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
