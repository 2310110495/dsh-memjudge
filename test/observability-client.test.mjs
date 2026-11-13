// Isolated React contract tests: no live DB, config, service or browser access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// Same deterministic hook/slot model as the existing panel suite; no runtime exports added.
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

function observation(overrides = {}) {
  return { version: 1, capturedAt: '2026-11-13T00:00:00.000Z',
    storage: { logicalBytes: 565328, textChars: 58107, limitBytes: 10485760,
      semantics: 'SQLite main + WAL + journal; database-wide, not injected bytes.' },
    injection: { mode: 'tiered', enabled: true, totalBudgetChars: 1500,
      tierSBudgetChars: 600, tierDBudgetChars: 900, measurement: 'configured', current: null },
    spaces: [{ id: 'global', kind: 'global', label: 'Global', memoryCount: 1 }],
    categories: { rule: 1 }, layers: { L0: 1 }, indexes: { vectors: 0, searchIndex: null, modules: { vector: false } },
    events: [], capabilities: { scopedCounts: true, hostContextTokens: false }, limitations: [], ...overrides };
}
function status(obs = observation()) {
  return { stats: { schemaVersion: 8, memories: 1, bytes: 565328, textChars: 58107, limitBytes: 10485760 },
    schemaVersion: 8, categories: { rule: 1 }, layers: { L0: 1 },
    spaces: [{ id: 'global', kind: 'global', label: 'Global', memoryCount: 1 }],
    config: { flags: {}, configPath: 'fixture-config', secretsPath: 'fixture-secrets' },
    inject: { mode: 'tiered', enabled: true, totalBudget: 1500, tierSBudget: 600, tierDBudget: 900 },
    tierS: { budget: 600, usedChars: 600 }, tierD: { budget: 900, usedChars: 880 },
    ...(obs ? { observability: obs } : {}) };
}
function responder(data = status(), items = []) {
  return (endpoint) => ({ ok: true, value: endpoint === 'status' ? data : endpoint === 'conflicts' ? { items: [] } : { items, total: items.length } });
}
const by = (key, value) => n => n.props?.[key] === value;
const tab = async (h, id) => h.click(h.one(by('data-ob-tab', id)));
const obRoot = h => h.one(by('data-section', 'observability'));

for (const mountSlot of ['settings', 'sidebar']) {
  test('observation browser mounts in real ' + mountSlot + ' slot and preserves settings', async () => {
    const h = createPanelHarness({ fetchResponder: responder(), mountSlot }); await h.flush();
    assert.equal(h.all(n => n.props?.['data-ob-tab']).length, 5);
    assert.match(h.text(obRoot(h)), /库内存储（非每轮注入）/);
    assert.match(h.text(obRoot(h)), /565,328 B/);
    assert.match(h.text(obRoot(h)), /宿主未提供/);
    assert.ok(h.all(by('data-group', 'chat')).length, 'credential controls retained');
    assert.ok(h.calls.every(c => ['status','memories','conflicts'].includes(c.endpoint)));
    assert.ok(h.calls.filter(c => c.endpoint === 'status').every(c => c.payload.includeInjectionText === false && !c.payload.sessionId));
    await tab(h, 'injection');
    assert.match(h.text(obRoot(h)), /已验证的当前会话身份/);
    assert.match(h.text(obRoot(h)), /600 字符/); assert.match(h.text(obRoot(h)), /UTF-8/);
    assert.equal(h.all(n => n.type === 'pre', obRoot(h)).length, 0);
    await tab(h, 'events'); assert.match(h.text(obRoot(h)), /已验证的当前会话身份/);
    await tab(h, 'indexes'); assert.match(h.text(obRoot(h)), /vectors/);
    await tab(h, 'spaces'); assert.ok(h.one(by('data-ob-space', 'global')));
  });
}

test('old host fallback has budgets but no fabricated frame', async () => {
  const h = createPanelHarness({ fetchResponder: responder(status(null)) }); await h.flush();
  assert.match(h.text(obRoot(h)), /兼容模式/);
  await tab(h, 'injection'); assert.match(h.text(obRoot(h)), /旧版宿主未提供 observability/);
  assert.equal(h.all(n => n.type === 'pre', obRoot(h)).length, 0);
  const legacyBudget = h.one(by('data-section', 'dual-budget'));
  assert.doesNotMatch(h.text(legacyBudget), /已用 600|已用 880/);
});

test('missing measurements remain unavailable, known zero is rendered as zero', async () => {
  const h = createPanelHarness({ fetchResponder: responder(status(observation({ storage: { logicalBytes: null, textChars: null, limitBytes: null }, injection: { measurement: 'configured' } }))) });
  await h.flush(); assert.match(h.text(obRoot(h)), /未提供/); assert.doesNotMatch(h.text(obRoot(h)), /565,328/);
  await tab(h, 'indexes'); assert.match(h.text(obRoot(h)), /vectors0/);
});

test('scope/category/lifecycle drilldowns use bounded existing memory route', async () => {
  const h = createPanelHarness({ fetchResponder: responder() }); await h.flush();
  await h.click(h.one(by('data-ob-category', 'rule')));
  assert.ok(h.calls.some(c => c.endpoint === 'memories' && c.payload.category === 'rule' && c.payload.limit === 120));
  await tab(h, 'spaces'); await h.click(h.one(by('data-ob-space', 'global')));
  assert.ok(h.calls.some(c => c.endpoint === 'status' && c.payload.spaceId === 'global' && c.payload.includeInjectionText === false));
  await tab(h, 'indexes'); await h.click(h.one(by('data-ob-layer', 'L0')));
  assert.ok(h.calls.some(c => c.endpoint === 'memories' && c.payload.spaceId === 'global' && c.payload.layer === 'L0' && c.payload.limit === 120));
});

test('unverified host identity cannot leak raw text or cross-session events', async () => {
  const obs = observation({ injection: { measurement: 'observed', current: { spaceId: 'global', sessionId: 'foreign', tierS: { text: 'PRIVATE_FRAME' } } },
    events: [{ id: 'foreign', type: 'injection', summary: 'PRIVATE_EVENT', details: { spaceId: 'global', sessionId: 'foreign' } }] });
  const h = createPanelHarness({ fetchResponder: responder(status(obs)) }); await h.flush();
  await tab(h, 'injection'); assert.doesNotMatch(h.text(), /PRIVATE_FRAME/);
  await tab(h, 'events'); assert.doesNotMatch(h.text(), /PRIVATE_EVENT/);
});

// Pure adapter is exposed only inside this test VM to exercise an eventual verified host adapter.
function internals() {
  let result;
  vm.runInNewContext(clientSource.replace('    return module.exports;', '    exports.__test = { adaptObservability, diagnosticRows }; return module.exports;'), {
    window: { __ModuleLoader__: { load({ factory }) { result = factory(() => ({ createElement() {} })); } } },
  });
  return result.__test;
}
test('raw adapter requires exact space, exact session, observed frame and explicit text opt-in', () => {
  const { adaptObservability } = internals();
  const frame = { spaceId: 'global', sessionId: 'verified', tierS: { text: '<script>safe text</script>', chars: 26, bytes: 26 }, tierD: { text: '', chars: 0, bytes: 0 }, totalChars: 26, totalBytes: 26 };
  const data = status(observation({ injection: { measurement: 'observed', current: frame } }));
  for (const args of [['all','verified',true], ['global','other',true], ['global','verified',false], ['global','',true], ['workspace:a','verified',true]]) {
    assert.equal(adaptObservability(data, ...args).injection.current, null);
  }
  assert.equal(adaptObservability(data, 'global', 'verified', true).injection.current, frame);
  data.observability.injection.measurement = 'configured';
  assert.equal(adaptObservability(data, 'global', 'verified', true).injection.current, null);
});

test('incomplete v1 snapshot never inherits unscoped legacy counts', () => {
  const { adaptObservability } = internals();
  const model = adaptObservability(status({ version: 1 }), 'global', '', false);
  assert.equal(model.storage.logicalBytes, null); assert.equal(model.storage.textChars, null);
  assert.equal(model.injection.totalBudgetChars, null);
  assert.equal(Object.keys(model.categories).length, 0); assert.equal(model.spaces.length, 0);
});

test('event metadata is exact-scope/session filtered and bounded to latest32', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ id: String(i), details: { sessionId: 'verified', spaceId: 'global' } }));
  events.push({ id: 'foreign', details: { sessionId: 'other', spaceId: 'global' } });
  const model = internals().adaptObservability(status(observation({ events })), 'global', 'verified', false);
  assert.equal(model.events.length, 32); assert.equal(model.events[0].id, '39');
  assert.equal(model.events.at(-1).id, '8'); assert.ok(model.events.every(e => e.id !== 'foreign'));
});

test('diagnostics exclude credential and arbitrary text fields', () => {
  const rows = internals().diagnosticRows({ count: 2, apiKey: 123, tokenCount: 10, secret: { count: 5 }, body: 'private', modules: { vector: false } });
  const text = JSON.stringify(rows);
  assert.match(text, /count/); assert.match(text, /vector/); assert.doesNotMatch(text, /apiKey|tokenCount|secret|private/);
});

test('raw memory detail is lazy, scoped, safely rendered, and validates returned identity', async () => {
  const item = { id: 'm1', text: 'preview', category: 'rule', tier: 0, spaceId: 'global', source: 'fixture' };
  let mismatch = false;
  const h = createPanelHarness({ fetchResponder: (endpoint, payload) => payload.detail
    ? { ok: true, value: { item: { ...item, spaceId: mismatch ? 'workspace:foreign' : 'global', fullText: '<img src=x onerror=alert(1)>\n原文', source: 'exact-source' } } }
    : responder(status(), [item])(endpoint, payload) });
  await h.flush(); assert.equal(h.calls.filter(c => c.payload.detail).length, 0);
  await h.click(h.one(by('data-ob-category','rule')));
  await h.click(h.one(n => n.type === 'button' && n.props.className === 'mj-memrow'));
  assert.ok(h.calls.some(c => c.payload.detail && c.payload.id === 'm1' && c.payload.spaceId === 'global'));
  const detail = h.one(by('data-memory-detail','m1'));
  assert.ok(h.text(detail).includes('<img src=x onerror=alert(1)>\n原文'));
  assert.match(h.text(detail), /exact-source/);
  assert.equal(h.all(n => n.type === 'img' || n.type === 'script' || n.props?.dangerouslySetInnerHTML, detail).length, 0);
  mismatch = true; await tab(h, 'spaces'); await h.click(h.one(by('data-ob-space','global')));
  await h.click(h.one(n => n.type === 'button' && n.props.className === 'mj-memrow'));
  assert.match(h.text(h.one(by('data-memory-detail','m1'))), /未找到当前范围内/);
  assert.doesNotMatch(h.text(h.one(by('data-memory-detail','m1'))), /<img/);
});

test('loading, partial error and retry are explicit without stale observations', async () => {
  let resolveStatus; let failure = false;
  const h = createPanelHarness({ fetchResponder: (endpoint, payload) => endpoint === 'status'
    ? failure ? { ok: false, error: { message: 'fixture failure' } } : new Promise(resolve => { resolveStatus = resolve; })
    : responder()(endpoint,payload) });
  await h.flush(); assert.match(h.text(obRoot(h)), /正在读取观测快照/);
  resolveStatus({ ok:true, value:status() }); await h.flush();
  failure = true;
  const refresh = h.all(n => n.type === 'button' && h.text(n) === '↻ 刷新')[0];
  assert.ok(refresh); await h.click(refresh); assert.match(h.text(obRoot(h)), /观测快照读取失败/);
  assert.doesNotMatch(h.text(obRoot(h)), /565,328/);
});

test('late previous-scope status cannot replace the selected scope', async () => {
  let release;
  const h = createPanelHarness({ fetchResponder: (endpoint, payload) => {
    if (endpoint !== 'status') return responder()(endpoint, payload);
    if (payload.spaceId === 'global') return new Promise(resolve => { release = resolve; });
    return { ok: true, value: status() };
  } });
  await h.flush(); await tab(h, 'spaces'); await h.click(h.one(by('data-ob-space', 'global')));
  assert.match(h.text(obRoot(h)), /正在读取观测快照/);
  await h.click(h.one(by('data-space', 'all')));
  release({ ok: true, value: status(observation({ storage: { logicalBytes: 999999 } })) });
  await h.flush(); await tab(h, 'overview');
  assert.match(h.text(obRoot(h)), /565,328/); assert.doesNotMatch(h.text(obRoot(h)), /999,999/);
});

test('revision responses without matching explicit identity remain hidden', async () => {
  const item = { id: 'm1', text: 'preview', category: 'rule', tier: 0, spaceId: 'global', revisionCount: 1 };
  const h = createPanelHarness({ fetchResponder: (endpoint, payload) => payload.id && payload.withRevisions
    ? { ok: true, value: { item: { id: 'm1', revisions: [{ prevText: 'UNBOUND_REVISION' }] } } }
    : responder(status(), [item])(endpoint, payload) });
  await h.flush(); await h.click(h.one(by('data-ob-category','rule')));
  await h.click(h.one(by('data-action','toggle-revisions')));
  assert.ok(h.calls.some(c => c.payload.id === 'm1' && c.payload.withRevisions && c.payload.spaceId === 'global'));
  assert.doesNotMatch(h.text(), /UNBOUND_REVISION/);
});

test('late raw memory detail is discarded after scope change', async () => {
  const item = { id: 'm1', text: 'preview', category: 'rule', tier: 0, spaceId: 'global' };
  let release;
  const h = createPanelHarness({ fetchResponder: (endpoint, payload) => payload.detail
    ? new Promise(resolve => { release = resolve; })
    : responder(status(), [item])(endpoint, payload) });
  await h.flush(); await h.click(h.one(by('data-ob-category', 'rule')));
  await h.click(h.one(n => n.type === 'button' && n.props.className === 'mj-memrow'));
  await tab(h, 'spaces'); await h.click(h.one(by('data-ob-space', 'global')));
  release({ ok: true, value: { item: { ...item, fullText: 'STALE_DETAIL_MUST_NOT_RENDER' } } });
  await h.flush(); assert.doesNotMatch(h.text(), /STALE_DETAIL_MUST_NOT_RENDER/);
});
