// v2 Web 右侧栏与设置面板端到端测试（T7）：
// 覆盖工作区切换、五类记忆徽标、L0-L3 代谢角标、Tier-S/Tier-D 双层预算、
// 单活 state 状态白板与修订历史展开、Wiki 知识页浏览与编译/代谢治理、
// demote 降级、二次确认 forget 物理遗忘、旧版 v1/v7 优雅降级与防注入安全契约。
//
// 铁律：DSH_HOME 在 import 任何业务模块前隔离到系统临时目录，严禁触碰线上真库。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-v2-panel-home-'));
process.env.DSH_HOME = HOME_DIR;
process.on('exit', () => fs.rmSync(HOME_DIR, { recursive: true, force: true }));

const { open } = await import('../src/store.mjs');
const { installMemjudgeRpc } = await import('../src/rpc.mjs');
const { stubConnection } = await import('./rpc-fetch-stub.mjs');

const CLIENT_PATH = new URL('../client.js', import.meta.url);
const clientSource = fs.readFileSync(CLIENT_PATH, 'utf8');

let dbSeq = 0;
function nextTempDbPath() {
  dbSeq += 1;
  return path.join(HOME_DIR, `panel-v2-${dbSeq}.sqlite`);
}

function createPanelHarness({ fetchResponder, mountSlot = 'sidebar' } = {}) {
  let states = [];
  let cursor = 0;
  let effects = [];
  let tree = null;
  let rootElement = null;
  let exported = null;
  let dirty = false;
  const calls = [];
  const registeredTabs = [];
  const disposers = [];

  const REACT_ELEMENT = Symbol('mj.react.element');
  const react = {
    createElement(type, props, ...children) {
      return { [REACT_ELEMENT]: true, type, props: { ...(props || {}), children } };
    },
    useState(init) {
      const idx = cursor++;
      if (!(idx in states)) {
        states[idx] = typeof init === 'function' ? init() : init;
      }
      return [
        states[idx],
        (next) => {
          states[idx] = typeof next === 'function' ? next(states[idx]) : next;
          dirty = true;
        },
      ];
    },
    useRef(init) {
      const idx = cursor++;
      if (!(idx in states)) states[idx] = { current: init };
      return states[idx];
    },
    useCallback(fn, deps) {
      const idx = cursor++;
      const prev = states[idx];
      if (!prev || !deps || deps.some((v, j) => v !== prev.deps[j])) {
        states[idx] = { fn, deps: deps || [] };
      }
      return states[idx].fn;
    },
    useEffect(fn, deps) {
      const idx = cursor++;
      const prev = states[idx];
      if (!prev || !deps || deps.some((v, j) => v !== prev.deps[j])) {
        states[idx] = { deps: deps || [] };
        effects.push(fn);
      }
    },
  };

  function expand(node) {
    if (Array.isArray(node)) return node.map(expand).flat();
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
      return node;
    }
    if (typeof node === 'object') {
      if (!node[REACT_ELEMENT]) {
        throw new TypeError(`Objects are not valid as a React child (found: ${JSON.stringify(node)})`);
      }
      if (typeof node.type === 'function') return expand(node.type(node.props || {}));
      return {
        ...node,
        props: {
          ...(node.props || {}),
          children: expand(node.props ? node.props.children : undefined),
        },
      };
    }
    return node;
  }

  const fetchImpl = async (url, opts) => {
    const endpoint = String(url).replace(/^.*\/api\/memjudge\./, '');
    const payload = opts && opts.body ? JSON.parse(opts.body) : {};
    calls.push({ endpoint, payload: structuredClone(payload) });
    const body = await fetchResponder(endpoint, payload);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };

  vm.runInNewContext(clientSource, {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          exported = factory(() => react);
        },
      },
    },
    document: {
      head: { appendChild() {} },
      getElementById() { return true; },
      createElement() { return { id: '', textContent: '' }; },
    },
    console: { log() {} },
    setTimeout() { return 1; },
    clearTimeout() {},
    fetch: fetchImpl,
  });

  let settingsElement = null;
  let sidebarElement = null;

  const slotsApi = {
    inject(_slotName, fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return () => { if (typeof d === 'function') d(); };
    },
    register(spec, renderFn) {
      if (spec && spec.name === 'settings.section') {
        settingsElement = renderFn();
      }
      if (spec && spec.name === 'sidebar.right.pane.tab') {
        sidebarElement = renderFn();
      }
      return () => {};
    },
  };

  const ctx = {
    slots: slotsApi,
    connection: {},
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    inject(_deps, cb) {
      const release = cb({
        slots: slotsApi,
        sidebarRightTabs: {
          register(tabSpec) {
            registeredTabs.push(tabSpec);
            return () => {
              const i = registeredTabs.indexOf(tabSpec);
              if (i >= 0) registeredTabs.splice(i, 1);
            };
          },
        },
      });
      return {
        dispose() {
          if (typeof release === 'function') release();
        },
      };
    },
  };

  exported.apply(ctx);
  rootElement = mountSlot === 'settings' ? settingsElement : sidebarElement;
  assert.ok(rootElement, `expected ${mountSlot} element to be registered`);

  async function flush() {
    for (let i = 0; i < 50; i += 1) {
      if (i === 0 || dirty) {
        dirty = false;
        cursor = 0;
        tree = expand(rootElement);
        const pending = effects;
        effects = [];
        for (const fn of pending) fn();
      }
      await Promise.resolve();
    }
  }

  function all(pred, node = tree) {
    if (Array.isArray(node)) return node.flatMap((x) => all(pred, x));
    if (!node || typeof node !== 'object') return [];
    const cur = pred(node) ? [node] : [];
    const ch = node.props ? all(pred, node.props.children) : [];
    return [...cur, ...ch];
  }

  function text(node = tree) {
    if (Array.isArray(node)) return node.map(text).join('');
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'object') return text(node.props ? node.props.children : '');
    return String(node);
  }

  function one(pred, rootOrMsg = tree, maybeMsg = 'expected exactly one matching element') {
    const isMsg = typeof rootOrMsg === 'string';
    const scope = isMsg ? tree : rootOrMsg;
    const msg = isMsg ? rootOrMsg : maybeMsg;
    const matched = all(pred, scope);
    assert.equal(matched.length, 1, `${msg} (got ${matched.length})`);
    return matched[0];
  }

  async function click(node) {
    assert.ok(node && typeof node === 'object', 'click target must exist');
    assert.ok(!node.props.disabled, 'cannot click disabled element');
    assert.equal(typeof node.props.onClick, 'function', 'element has no onClick');
    node.props.onClick({ stopPropagation() {}, preventDefault() {} });
    await flush();
  }

  async function change(node, value) {
    assert.ok(node && typeof node === 'object', 'input target must exist');
    assert.ok(!node.props.disabled, 'cannot change disabled input');
    node.props.onChange({ target: { value } });
    await flush();
  }

  return {
    get tree() { return tree; },
    calls,
    registeredTabs,
    disposers,
    settingsElement,
    sidebarElement,
    flush,
    all,
    text,
    one,
    click,
    change,
  };
}

function seedV2Database(dbPath) {
  const store = open(dbPath);
  const baseTs = 1_760_000_000_000;
  try {
    store.upsertSpace({
      spaceId: 'global',
      kind: 'global',
      rootPath: '',
      label: '全局记忆空间',
      now: baseTs,
    });
    store.upsertSpace({
      spaceId: 'workspace:alpha',
      kind: 'workspace',
      rootPath: 'F:/projects/alpha-engine',
      label: '',
      now: baseTs + 1000,
    });
    store.upsertSpace({
      spaceId: 'workspace:beta',
      kind: 'workspace',
      rootPath: '/srv/apps/beta-web',
      label: '',
      now: baseTs + 2000,
    });

    // global: rule (L0) + profile (L0)
    const ruleMem = store.put({
      spaceId: 'global',
      category: 'rule',
      tier: 0,
      text: '严禁触碰线上生产数据库与用户装机目录。',
      source: 'user-rule',
      importance: 0.95,
      chapter: 1,
      createdAt: baseTs + 3000,
    });
    const profileMem = store.put({
      spaceId: 'global',
      category: 'profile',
      tier: 0,
      text: '开发者偏好紧凑高信噪比界面与原生 SQLite 存储。',
      source: 'user-profile',
      importance: 0.85,
      chapter: 1,
      createdAt: baseTs + 4000,
    });

    // workspace:alpha: decision (L1), experience (L1), L2 cluster (>=2 条同源/同章以触发编译), L3 archived-tier
    const decisionMem = store.put({
      spaceId: 'workspace:alpha',
      category: 'decision',
      tier: 1,
      text: '右栏面板统一通过同源 /api/memjudge.<ep> Fetch 路由通信。',
      source: 'arch-adr-04',
      importance: 0.8,
      chapter: 2,
      createdAt: baseTs + 5000,
    });
    const expMem = store.put({
      spaceId: 'workspace:alpha',
      category: 'experience',
      tier: 1,
      text: 'Windows 沙箱只读模式下 Node 子进程 pipe 会返回 EPERM。',
      source: 'debug-session',
      importance: 0.65,
      chapter: 2,
      createdAt: baseTs + 6000,
    });
    store.put({
      spaceId: 'workspace:alpha',
      category: 'experience',
      tier: 2,
      text: '检索管线第一阶段采用 CJK 二元组 BM25 粗召回控制延迟。',
      source: 'retrieval-notes',
      importance: 0.6,
      chapter: 3,
      createdAt: baseTs + 7000,
    });
    store.put({
      spaceId: 'workspace:alpha',
      category: 'decision',
      tier: 2,
      text: '检索管线第二阶段结合向量余弦相似度与 RRF 融合排序。',
      source: 'retrieval-notes',
      importance: 0.7,
      chapter: 3,
      createdAt: baseTs + 8000,
    });
    store.put({
      spaceId: 'workspace:alpha',
      category: 'experience',
      tier: 3,
      text: '早期原型测试日志已归入 L3 冷层封存。',
      source: 'cold-log',
      importance: 0.2,
      chapter: 4,
      createdAt: baseTs + 9000,
    });

    // 单活状态 state（连续三次写入同一 slotKey 形成 2 条历史修订链）
    store.putState({
      spaceId: 'workspace:alpha',
      slotKey: 'release.stage',
      text: '阶段 alpha-0.1：完成基础存储建表',
      source: 'ci-bot',
      now: baseTs + 10_000,
    });
    store.putState({
      spaceId: 'workspace:alpha',
      slotKey: 'release.stage',
      text: '阶段 rc-1.0：完成混合检索联调',
      source: 'ci-bot',
      now: baseTs + 20_000,
    });
    const finalState = store.putState({
      spaceId: 'workspace:alpha',
      slotKey: 'release.stage',
      text: '阶段 ga-2.0：右栏面板 v2 已就绪',
      source: 'ci-bot',
      now: baseTs + 30_000,
    });

    // workspace:beta: 独立工作区数据，用于验证空间隔离
    store.put({
      spaceId: 'workspace:beta',
      category: 'experience',
      tier: 1,
      text: 'Beta Web 前端采用容器查询自适应窄边栏。',
      source: 'beta-doc',
      importance: 0.5,
      chapter: 1,
      createdAt: baseTs + 35_000,
    });
    store.putState({
      spaceId: 'workspace:beta',
      slotKey: 'deploy.region',
      text: 'ap-east-1 灰度集群在线',
      source: 'ops',
      now: baseTs + 36_000,
    });

    // 预置一页带结构化 Markdown 的知识页，测试浏览与脏页编译前后变化
    store.upsertWikiPage({
      spaceId: 'workspace:alpha',
      slug: 'retrieval-architecture',
      title: '混合检索架构专题',
      summary: '## 核心结论\n- 采用 `BM25` 与向量双路召回\n- 注入预算拆分为 `Tier-S` 与 `Tier-D`',
      sourceIds: [decisionMem.id, expMem.id],
      dirty: true,
      now: baseTs + 40_000,
    });

    return {
      ruleId: ruleMem.id,
      profileId: profileMem.id,
      decisionId: decisionMem.id,
      expId: expMem.id,
      alphaStateId: finalState.id,
    };
  } finally {
    store.close();
  }
}

test('右栏 sidebarRightTabs 与设置页插槽双挂载及安全释放', async () => {
  const dbPath = nextTempDbPath();
  seedV2Database(dbPath);
  const stub = stubConnection();
  installMemjudgeRpc(
    { get: (name) => (name === 'connection' ? stub.connection : undefined) },
    { dbPath, config: { autoInject: true, injectMode: 'auto', tierSBudget: 1200, tierDBudget: 2000 } },
  );

  const ui = createPanelHarness({
    fetchResponder: (ep, payload) => stub.call(ep, payload),
    mountSlot: 'sidebar',
  });
  await ui.flush();

  assert.ok(ui.settingsElement, 'settings.section 应已注册');
  assert.ok(ui.sidebarElement, 'sidebar.right.pane.tab 应已注册');
  assert.equal(ui.registeredTabs.length, 1);
  assert.equal(ui.registeredTabs[0].id, 'dsh-memjudge');
  assert.equal(ui.registeredTabs[0].title(), '记忆库');

  for (const dispose of ui.disposers) dispose();
  assert.equal(ui.registeredTabs.length, 0, '释放后右栏 tab 注册项应干净移除');
});

test('v2 工作区切换、五类范畴徽标、L0-L3 角标与双层注入预算展示与筛选', async () => {
  const dbPath = nextTempDbPath();
  seedV2Database(dbPath);
  const stub = stubConnection();
  installMemjudgeRpc(
    { get: (name) => (name === 'connection' ? stub.connection : undefined) },
    { dbPath, config: { autoInject: true, injectMode: 'auto', tierSBudget: 1200, tierDBudget: 2000 } },
  );

  const ui = createPanelHarness({
    fetchResponder: (ep, payload) => stub.call(ep, payload),
  });
  await ui.flush();

  // 1. 空间切换器：全部空间 / 全局 / alpha-engine / beta-web，含友好路径名与条目计数
  const spaceButtons = ui.all((n) => n.type === 'button' && Boolean(n.props['data-space']));
  const spaceIds = spaceButtons.map((b) => b.props['data-space']);
  assert.ok(spaceIds.includes('all'));
  assert.ok(spaceIds.includes('global'));
  assert.ok(spaceIds.includes('workspace:alpha'));
  assert.ok(spaceIds.includes('workspace:beta'));

  const alphaBtn = ui.one((n) => n.type === 'button' && n.props['data-space'] === 'workspace:alpha');
  assert.match(ui.text(alphaBtn), /alpha-engine/);
  assert.match(ui.text(alphaBtn), /\(6\)/, 'workspace:alpha 应显示 6 条活跃记忆');

  // 2. 双层注入预算进度（Tier-S 静态底座 / Tier-D 动态召回）
  const tierSNode = ui.one((n) => n.props['data-budget-tier'] === 'tierS');
  const tierDNode = ui.one((n) => n.props['data-budget-tier'] === 'tierD');
  assert.match(ui.text(tierSNode), /Tier-S 静态底座/);
  // Observability reports the effective backend caps, not the oversized raw config.
  assert.match(ui.text(tierSNode), /600/);
  assert.match(ui.text(tierDNode), /Tier-D 动态召回/);
  assert.match(ui.text(tierDNode), /900/);

  // 3. 五类范畴徽标与四级代谢角标齐全
  for (const cat of ['rule', 'profile', 'decision', 'experience', 'state']) {
    const badges = ui.all((n) => n.props['data-category-badge'] === cat);
    assert.ok(badges.length >= 1, `应渲染 ${cat} 范畴徽标`);
  }
  for (const layer of ['L0', 'L1', 'L2', 'L3']) {
    const badges = ui.all((n) => n.props['data-layer-badge'] === layer);
    assert.ok(badges.length >= 1, `应渲染 ${layer} 层级角标`);
  }

  // 4. 切换到 workspace:alpha：带 spaceId 请求后端，隔离掉 global 和 workspace:beta
  await ui.click(alphaBtn);
  const fullTextAfterAlpha = ui.text();
  assert.match(fullTextAfterAlpha, /当前工作区：F:\/projects\/alpha-engine \(workspace:alpha\)/);
  assert.doesNotMatch(fullTextAfterAlpha, /Beta Web 前端采用容器查询/);
  assert.doesNotMatch(fullTextAfterAlpha, /ap-east-1 灰度集群在线/);
  assert.ok(
    ui.calls.some((c) => c.endpoint === 'memories' && c.payload.spaceId === 'workspace:alpha'),
    '切换工作区后 memories 端点应携带 spaceId=workspace:alpha',
  );

  // 5. 按范畴筛选 decision：列表只保留 alpha 下的 2 条决策记忆
  const decisionFilterBtn = ui.one(
    (n) => n.type === 'button' && n.props['data-filter-category'] === 'decision',
  );
  await ui.click(decisionFilterBtn);
  const decisionCards = ui.all((n) => Boolean(n.props['data-memory-card']));
  assert.equal(decisionCards.length, 2, 'workspace:alpha 下应筛选出 2 条 decision 记忆');
  assert.ok(decisionCards.every((c) => c.props['data-memory-category'] === 'decision'));

  // 6. 叠加代谢层级筛选 L2：精准收敛到 1 条 L2 决策记忆
  const l2FilterBtn = ui.one(
    (n) => n.type === 'button' && n.props['data-filter-layer'] === 'L2',
  );
  await ui.click(l2FilterBtn);
  const l2Cards = ui.all((n) => Boolean(n.props['data-memory-card']));
  assert.equal(l2Cards.length, 1);
  assert.match(ui.text(l2Cards[0]), /RRF 融合排序/);

  // 7. 重置筛选恢复当前空间的 6 条记忆，并测试关键词搜索
  const resetBtn = ui.one((n) => n.type === 'button' && ui.text(n) === '重置筛选');
  await ui.click(resetBtn);
  assert.equal(ui.all((n) => Boolean(n.props['data-memory-card'])).length, 6);

  const searchInput = ui.one((n) => n.type === 'input' && n.props['aria-label'] === '搜索记忆正文或槽位');
  await ui.change(searchInput, 'EPERM');
  const searchedCards = ui.all((n) => Boolean(n.props['data-memory-card']));
  assert.equal(searchedCards.length, 1);
  assert.match(ui.text(searchedCards[0]), /Windows 沙箱只读模式/);
});

test('单活 state 状态白板置顶展示与 Revisions 历史演化链展开（含内联与按需懒加载）', async () => {
  const dbPath = nextTempDbPath();
  const ids = seedV2Database(dbPath);
  const stub = stubConnection();
  installMemjudgeRpc(
    { get: (name) => (name === 'connection' ? stub.connection : undefined) },
    { dbPath, config: { autoInject: true } },
  );

  const ui = createPanelHarness({
    fetchResponder: (ep, payload) => stub.call(ep, payload),
  });
  await ui.flush();

  // 切换到 workspace:alpha 查看单活状态槽位 release.stage
  await ui.click(ui.one((n) => n.type === 'button' && n.props['data-space'] === 'workspace:alpha'));

  const whiteboard = ui.one((n) => n.props['data-section'] === 'state-whiteboard');
  const wbText = ui.text(whiteboard);
  assert.match(wbText, /项目状态白板/);
  assert.match(wbText, /release\.stage/);
  assert.match(wbText, /阶段 ga-2\.0：右栏面板 v2 已就绪/);
  // 未展开修订前不显示被覆写的历史旧值
  assert.doesNotMatch(wbText, /阶段 alpha-0\.1：完成基础存储建表/);

  // 点击展开修订历史按钮
  const stateCard = ui.one((n) => n.props['data-state-card'] === ids.alphaStateId);
  const revToggleBtn = ui.all(
    (n) => n.type === 'button' && n.props['data-action'] === 'toggle-revisions',
    stateCard,
  )[0];
  assert.ok(revToggleBtn, '存在历史覆写时应渲染查看修订历史按钮');
  assert.match(ui.text(revToggleBtn), /查看修订历史 \(2\)/);

  await ui.click(revToggleBtn);
  const stateCardAfter = ui.one((n) => n.props['data-state-card'] === ids.alphaStateId);
  const revPanel = ui.one((n) => n.props['data-revisions-panel'] === 'ready', stateCardAfter);
  const revText = ui.text(revPanel);
  assert.match(revText, /修订演化轨迹（共 2 次历史变更）/);
  assert.match(revText, /阶段 rc-1\.0：完成混合检索联调/);
  assert.match(revText, /阶段 alpha-0\.1：完成基础存储建表/);
  assert.match(revText, /覆写为当前：阶段 ga-2\.0：右栏面板 v2 已就绪/);

  // 验证按需懒加载分支：当某条记忆仅携带 revisionCount > 0 而未内联 revisions 数组时，点击自动拉取详情
  let lazyFetched = false;
  const lazyUi = createPanelHarness({
    fetchResponder: async (ep, payload) => {
      if (ep === 'status') {
        return {
          ok: true,
          value: {
            schemaVersion: 8,
            stats: { memories: 1, segments: 1, facts: 0, attrCount: 0, textChars: 10, textBytes: 20, bytes: 4096, limitBytes: 204800, withinLimit: true, wornSegments: 0, wear: 0, maxChars: 2000 },
            config: { flags: {}, envLockedSettings: {}, groups: { chat: { mode: 'independent', enabled: true }, embed: { mode: 'disabled', enabled: false }, rerank: { mode: 'disabled', enabled: false } } },
            spaces: [{ spaceId: 'global', kind: 'global', memoryCount: 1 }],
            categories: { rule: 0, profile: 0, decision: 0, experience: 0, state: 1 },
            layers: { L0: 1, L1: 0, L2: 0, L3: 0 },
            states: [{ id: 'mem-lazy-1', spaceId: 'global', category: 'state', layer: 'L0', slotKey: 'build.status', text: 'green', revisionCount: 1, created: Date.now() }],
            wiki_pages: [],
            tierS: { budget: 1200, maxChars: 1200 },
            tierD: { budget: 2000, maxChars: 2000 },
          },
        };
      }
      if (ep === 'memories' && payload.id === 'mem-lazy-1' && payload.withRevisions) {
        lazyFetched = true;
        return {
          ok: true,
          value: {
            found: true,
            item: {
              id: 'mem-lazy-1',
              spaceId: 'global',
              text: 'green',
              revisions: [{ revId: 9, memoryId: 'mem-lazy-1', prevText: 'failing-lint', reason: 'state-update', changedAt: Date.now() - 5000 }],
            },
          },
        };
      }
      if (ep === 'memories') return { ok: true, value: { total: 1, items: [], rows: [] } };
      return { ok: true, value: { conflicts: [] } };
    },
  });
  await lazyUi.flush();
  const lazyBtn = lazyUi.one((n) => n.type === 'button' && n.props['data-action'] === 'toggle-revisions');
  await lazyUi.click(lazyBtn);
  assert.equal(lazyFetched, true, '未内联 revisions 时应请求 memories { id, withRevisions: true }');
  assert.match(lazyUi.text(), /failing-lint/);
  assert.match(lazyUi.text(), /覆写为当前：green/);
});

test('L2 Wiki 知识页浏览、结构化正文渲染与 compile / metabolism / wiki / reindex 治理动作', async () => {
  const dbPath = nextTempDbPath();
  seedV2Database(dbPath);
  const stub = stubConnection();
  installMemjudgeRpc(
    { get: (name) => (name === 'connection' ? stub.connection : undefined) },
    { dbPath, config: { autoInject: true } },
  );

  const ui = createPanelHarness({
    fetchResponder: (ep, payload) => stub.call(ep, payload),
  });
  await ui.flush();

  await ui.click(ui.one((n) => n.type === 'button' && n.props['data-space'] === 'workspace:alpha'));

  // 初始预置知识页渲染：标题、待重编标记、结构化 Markdown 内容（h4 + ul/li + code）
  const wikiSec = ui.one((n) => n.props['data-section'] === 'wiki-pages');
  assert.match(ui.text(wikiSec), /混合检索架构专题/);
  assert.match(ui.text(wikiSec), /待重编/);
  assert.match(ui.text(wikiSec), /采用 BM25 与向量双路召回/);
  const codeNodes = ui.all((n) => n.type === 'code', wikiSec);
  assert.ok(codeNodes.length >= 2, 'Markdown 行内反引号应渲染为安全 <code> 元素');

  // 点击「编译知识页」触发 action: 'compile'，将 workspace:alpha 的 L2 聚类与脏页编译落盘
  const compileBtn = ui.one((n) => n.type === 'button' && n.props['data-action'] === 'compile-wiki');
  await ui.click(compileBtn);
  assert.ok(
    ui.calls.some((c) => c.endpoint === 'memories' && c.payload.action === 'compile' && c.payload.spaceId === 'workspace:alpha'),
    '编译按钮应触发 memories { action: "compile", spaceId: "workspace:alpha" }',
  );
  assert.match(ui.text(), /知识页编译完成/);

  // 切换到「知识页 (Wiki)」标签页触发 action: 'wiki'，并隐藏普通记忆列表聚焦知识页
  const wikiTabBtn = ui.one((n) => n.type === 'button' && n.props['data-view-tab'] === 'wiki');
  await ui.click(wikiTabBtn);
  assert.ok(
    ui.calls.some((c) => c.endpoint === 'memories' && c.payload.action === 'wiki' && c.payload.spaceId === 'workspace:alpha'),
    '切换 Wiki 视图应触发 memories { action: "wiki" }',
  );
  assert.equal(ui.all((n) => n.props['data-section'] === 'memories-list').length, 0, 'Wiki 专属视图下应收起记忆条目区');
  assert.equal(ui.all((n) => n.props['data-section'] === 'wiki-pages').length, 1);

  // 切回综合视图后执行代谢（action: 'metabolism'）与重建索引（action: 'reindex'）
  await ui.click(ui.one((n) => n.type === 'button' && n.props['data-view-tab'] === 'all'));
  const metabolismBtn = ui.one((n) => n.type === 'button' && n.props['data-action'] === 'run-metabolism');
  await ui.click(metabolismBtn);
  assert.ok(
    ui.calls.some((c) => c.endpoint === 'memories' && c.payload.action === 'metabolism'),
    '执行代谢按钮应触发 memories { action: "metabolism" }',
  );
  assert.match(ui.text(), /生命周期代谢完成/);

  const reindexBtn = ui.one((n) => n.type === 'button' && ui.text(n) === '重建索引');
  await ui.click(reindexBtn);
  assert.ok(
    ui.calls.some((c) => c.endpoint === 'status' && c.payload.action === 'reindex'),
    '重建索引按钮应触发 status { action: "reindex" }',
  );
  assert.match(ui.text(), /检索索引已重建/);
});

test('记忆卡片治理：误判铁律 demote 降级为经验 + forget 二次确认防误触与物理删除', async () => {
  const dbPath = nextTempDbPath();
  const ids = seedV2Database(dbPath);
  const stub = stubConnection();
  installMemjudgeRpc(
    { get: (name) => (name === 'connection' ? stub.connection : undefined) },
    { dbPath, config: { autoInject: true } },
  );

  const ui = createPanelHarness({
    fetchResponder: (ep, payload) => stub.call(ep, payload),
  });
  await ui.flush();

  // 普通 L1 experience 记忆不应展示多余的「降级为经验」按钮
  const expCard = ui.one((n) => n.props['data-memory-card'] === ids.expId);
  assert.equal(
    ui.all((n) => n.type === 'button' && n.props['data-action'] === 'demote', expCard).length,
    0,
    '已是 L1 experience 的普通事件不显示降级按钮',
  );

  // L0 rule 铁律记忆支持「降级为经验」：点击后落库变为 experience / L1 并自动刷新徽标
  const ruleCardBefore = ui.one((n) => n.props['data-memory-card'] === ids.ruleId);
  assert.equal(ruleCardBefore.props['data-memory-category'], 'rule');
  assert.equal(ruleCardBefore.props['data-memory-layer'], 'L0');
  const demoteBtn = ui.one((n) => n.type === 'button' && n.props['data-action'] === 'demote', ruleCardBefore);
  await ui.click(demoteBtn);

  assert.ok(
    ui.calls.some((c) => c.endpoint === 'memories' && c.payload.action === 'demote' && c.payload.id === ids.ruleId),
    '点击降级应发送 { action: "demote", id }',
  );
  const ruleCardAfter = ui.one((n) => n.props['data-memory-card'] === ids.ruleId);
  assert.equal(ruleCardAfter.props['data-memory-category'], 'experience', '降级后范畴应更新为 experience');
  assert.notEqual(ruleCardAfter.props['data-memory-layer'], 'L0', '降级后应移出 L0 常驻层');
  assert.equal(
    ui.all((n) => n.type === 'button' && n.props['data-action'] === 'demote', ruleCardAfter).length,
    0,
    '降级为普通经验后不应再显示降级按钮',
  );

  // 物理遗忘（forget）防误触二次确认测试
  const forgetCallsBefore = ui.calls.filter((c) => c.endpoint === 'memories' && c.payload.action === 'forget').length;
  const profileCard1 = ui.one((n) => n.props['data-memory-card'] === ids.profileId);
  const armForgetBtn = ui.one((n) => n.type === 'button' && n.props['data-action'] === 'forget', profileCard1);

  // 第一次点击：仅进入确认态，不发送 forget 请求
  await ui.click(armForgetBtn);
  assert.equal(
    ui.calls.filter((c) => c.endpoint === 'memories' && c.payload.action === 'forget').length,
    forgetCallsBefore,
    '首次点击遗忘仅武装确认态，不得直接发请求',
  );

  // 点击「取消」撤回确认态
  const profileCardArmed = ui.one((n) => n.props['data-memory-card'] === ids.profileId);
  const cancelBtn = ui.one((n) => n.type === 'button' && n.props['data-action'] === 'cancel-forget', profileCardArmed);
  await ui.click(cancelBtn);
  const profileCardDisarmed = ui.one((n) => n.props['data-memory-card'] === ids.profileId);
  assert.equal(
    ui.all((n) => n.type === 'button' && n.props['data-action'] === 'confirm-forget', profileCardDisarmed).length,
    0,
  );

  // 再次点击「遗忘」->「确认遗忘」：真正物理删除并自动刷新移除卡片
  await ui.click(ui.one((n) => n.type === 'button' && n.props['data-action'] === 'forget', profileCardDisarmed));
  const confirmBtn = ui.one(
    (n) => n.type === 'button' && n.props['data-action'] === 'confirm-forget',
    ui.one((n) => n.props['data-memory-card'] === ids.profileId),
  );
  await ui.click(confirmBtn);

  assert.ok(
    ui.calls.some((c) => c.endpoint === 'memories' && c.payload.action === 'forget' && c.payload.id === ids.profileId),
    '二次确认后应发送 { action: "forget", id }',
  );
  assert.equal(
    ui.all((n) => n.props['data-memory-card'] === ids.profileId).length,
    0,
    '物理遗忘后记忆卡片应从列表中彻底移除',
  );
});

test('防御性兼容：旧版 v1/v7 精简返回结构平滑降级 + 恶意 HTML/脚本输入零注入 + 零硬编码色值', async () => {
  // 静态色值与危险 DOM API 门禁
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(clientSource), false, 'client.js 严禁出现硬编码 hex 色值');
  assert.equal(/dangerouslySetInnerHTML/.test(clientSource), false, 'client.js 严禁使用 dangerouslySetInnerHTML');

  // 旧版 v1/v7 精简响应（无 spaces / categories / layers / wiki_pages / states / tierS / tierD / items）
  const legacyUi = createPanelHarness({
    fetchResponder: async (ep) => {
      if (ep === 'status') {
        return {
          ok: true,
          value: {
            stats: {
              memories: 1, segments: 1, facts: 1, attrCount: 1,
              textChars: 36, textBytes: 60, bytes: 8192, limitBytes: 204800,
              withinLimit: true, wornSegments: 0, wear: 0, maxChars: 2000,
            },
            config: {
              configPath: '/tmp/config.json',
              secretsPath: '/tmp/secrets.json',
              flags: {},
              envLockedSettings: {},
              groups: {
                chat: { mode: 'independent', enabled: true, baseUrl: 'https://chat.invalid/v1', model: 'm1', keyConfigured: false },
                embed: { mode: 'disabled', enabled: false, baseUrl: '', model: '', keyConfigured: false },
                rerank: { mode: 'disabled', enabled: false, baseUrl: '', model: '', keyConfigured: false },
              },
            },
          },
        };
      }
      if (ep === 'memories') {
        return {
          ok: true,
          value: {
            rows: [{
              id: 'legacy-1',
              chapter: 1,
              created: Date.now() - 10_000,
              accessed: Date.now() - 5_000,
              importance: 0.7,
              source: 'legacy-note',
              text: '<script>window.__pwned=1</script><img src=x onerror=alert(1)> 旧版记忆正文',
            }],
          },
        };
      }
      return { ok: true, value: { conflicts: [{ attr: '端口', values: ['8080', '9090'] }] } };
    },
  });

  await legacyUi.flush();
  const legacyText = legacyUi.text();
  assert.match(legacyText, /已连接宿主 RPC/);
  assert.match(legacyText, /旧版记忆正文/);
  assert.match(legacyText, /删除记忆请用对话里的 memjudge_forget；面板只读。/);

  // v1/v7 模式下不应渲染空的 v2 专属区块
  assert.equal(legacyUi.all((n) => n.props['data-section'] === 'scope-switcher').length, 0);
  assert.equal(legacyUi.all((n) => n.props['data-section'] === 'state-whiteboard').length, 0);
  assert.equal(legacyUi.all((n) => n.props['data-section'] === 'wiki-pages').length, 0);
  assert.equal(legacyUi.all((n) => n.props['data-section'] === 'dual-budget').length, 0);

  // 点击展开经典记忆行正常工作
  const legacyRowBtn = legacyUi.one((n) => n.type === 'button' && n.props.className === 'mj-memrow');
  assert.equal(legacyRowBtn.props['aria-expanded'], 'false');
  await legacyUi.click(legacyRowBtn);
  const legacyRowBtnAfter = legacyUi.one((n) => n.type === 'button' && n.props.className === 'mj-memrow');
  assert.equal(legacyRowBtnAfter.props['aria-expanded'], 'true');

  // 恶意脚本字符串仅作为文本存在，绝不生成真实 script / img 节点
  assert.equal(legacyUi.all((n) => n.type === 'script' || n.type === 'img').length, 0);
});

test('T11 审查门禁回归（S2-⑤ + B4 + B5 + M6 + S1）：真实 conflicts RPC 载荷渲染防白屏、对象型 conflictType 防护、10MB 默认值与代谢真实计数', async () => {
  const dbPath = nextTempDbPath();
  const store = open(dbPath);
  try {
    const staleTs = Date.now() - 45 * 86_400_000;
    store.upsertSpace({ spaceId: 'ws:t11', kind: 'workspace', label: 'repo-t11', rootPath: '/repo/t11' });
    const oldMem = store.put({
      text: '网关超时阈值原为 10 秒。',
      category: 'experience',
      spaceId: 'ws:t11',
      tier: 1,
      source: 'gateway-ops',
      chapter: 3,
      para: 1,
      createdAt: staleTs,
      lastAccessed: staleTs,
    });
    store.put({
      text: '网关超时阈值现调整为 25 秒。',
      category: 'decision',
      spaceId: 'ws:t11',
      tier: 1,
      source: 'gateway-ops',
      chapter: 3,
      para: 2,
      supersedes: [oldMem.id],
      createdAt: staleTs + 1000,
      lastAccessed: staleTs + 1000,
    });
    store.put({
      text: '连接池容量在主节点设定为 64 个连接；连接池容量在灾备节点设定为 16 个连接。',
      category: 'experience',
      spaceId: 'ws:t11',
      tier: 1,
      source: 'gateway-ops',
      chapter: 3,
      para: 3,
      createdAt: staleTs + 2000,
      lastAccessed: staleTs + 2000,
    });
  } finally {
    store.close();
  }

  const stub = stubConnection();
  installMemjudgeRpc(
    { get: (name) => (name === 'connection' ? stub.connection : undefined) },
    { dbPath, config: { autoInject: true, injectMode: 'tiered', tierSBudget: 600, tierDBudget: 900 } },
  );

  // 1) 真实后端 RPC 驱动前端侧边栏渲染（含真实 conflicts 路由与 status.layers 映射）
  const ui = createPanelHarness({
    mountSlot: 'sidebar',
    fetchResponder: (ep, payload) => stub.call(ep, payload),
  });
  await ui.flush();

  const fullText = ui.text();
  // B4 / S2-⑤：真实 conflicts 载荷渲染出定性标签且不触发 Objects are not valid as a React child
  assert.match(fullText, /supersession|disputed|conditional/);
  assert.match(fullText, /10|25|64|16/);

  // M6：点击执行代谢，验证通知横幅展示真实的 Wiki 编译非零计数（修复前因字段名错位恒为 0）
  const metabBtn = ui.one((n) => n.type === 'button' && n.props['data-action'] === 'run-metabolism');
  await ui.click(metabBtn);
  const afterMetabText = ui.text();
  assert.match(afterMetabText, /生命周期代谢完成 · L2 沉淀 \d+ · Wiki 编译 [1-9]\d*/);

  // 2) S1：设置面板默认回显 10240 (10MB KB 单位)，且修改后点击「恢复默认」精确还原为 '10240' 并按 10485760 字节提交
  const limitInputBefore = ui.one((n) => n.type === 'input' && n.props.value === '10240');
  await ui.change(limitInputBefore, '4096');
  assert.equal(ui.all((n) => n.type === 'input' && n.props.value === '4096').length, 1);
  const restoreBtn = ui.one((n) => n.type === 'button' && ui.text(n) === '恢复默认');
  await ui.click(restoreBtn);
  assert.ok(
    ui.all((n) => n.type === 'input' && n.props.value === '10240').length >= 1,
    '点击恢复默认后 SETTING_DEFAULTS.storageLimitBytes 必须恢复为 10240 (10MB)',
  );

  // 3) B4 前端防御兜底：即便外部或旧接口返回对象型 conflictType，也不得让 React 崩溃
  const objConflictUi = createPanelHarness({
    mountSlot: 'sidebar',
    fetchResponder: async (ep, payload) => {
      if (ep === 'conflicts') {
        return {
          ok: true,
          value: {
            total: 1,
            conflicts: [{
              key: '网关::超时',
              entity: '网关',
              attr: '超时',
              conflictType: { type: 'supersession', presentation: 'winner-only' },
              values: ['10秒', '25秒'],
            }],
          },
        };
      }
      return stub.call(ep, payload);
    },
  });
  await objConflictUi.flush();
  assert.match(objConflictUi.text(), /supersession/);
});
