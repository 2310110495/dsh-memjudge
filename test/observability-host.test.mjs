import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Config paths are import-time constants: isolate BEFORE importing plugin/RPC.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-observation-host-'));
process.env.DSH_HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
const { apply, SECTION_NAME, CONTEXT_NAME } = await import('../src/index.mjs');
const { open } = await import('../src/store.mjs');
const { resolveObservationScope } = await import('../src/observability.mjs');
const { stubConnection } = await import('./rpc-fetch-stub.mjs');
let sequence = 0;

function fixture({ context = true, injectMode = 'tiered', injectBudget = 1500 } = {}) {
  const stub = stubConnection();
  const sections = new Map(), contexts = new Map(), tools = new Map(), listeners = new Map();
  const host = {
    connection: stub.connection,
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name); } },
    systemPrompt: {
      section(def) { sections.set(def.name, def); return () => sections.delete(def.name); },
      ...(context ? { context(def) { contexts.set(def.name, def); return () => contexts.delete(def.name); } } : {}),
    },
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
    emit(session, event) { for (const fn of listeners.get('session/event') ?? []) fn(session, event); },
  };
  let store;
  const app = apply(host, { dbPath: path.join(home, 'db-' + sequence++), autoInject: true, autoCapture: false,
    injectMode, injectBudget, vector: false, rerank: false, expand: false, llmSelect: false, metabolismIntervalMs: 0,
  }, { storeFactory: (...args) => (store = open(...args)) });
  const cwd = 'F:/observation-host/project-a';
  const session = { id: 'main-session', header: { cwd, origin: 'user' } };
  const spaceId = resolveObservationScope({ cwd }).spaceId;
  store.put({ text: 'Project A immutable safety rule', category: 'rule', spaceId });
  store.put({ text: 'Gateway retry backoff is configured to 45 seconds; timeout follows gateway retry backoff.', category: 'experience', spaceId });
  const status = async (extra = {}) => {
    const result = await stub.call('status', { cwd, sessionId: session.id, ...extra });
    assert.equal(result.ok, true, result.error);
    return result.value;
  };
  return { ...stub, app, store, sections, contexts, tools, host, session, cwd, spaceId, status, listeners,
    section: sections.get(SECTION_NAME).text, dynamic: contexts.get(CONTEXT_NAME)?.text };
}

test('actual section/context callbacks provide same-frame measurements, not static status estimates; 8 routes preserved', async () => {
  const f = fixture();
  try {
    assert.equal(f.routes.size, 8);
    const start = await f.status();
    assert.equal(start.observability.injection.current, null);
    assert.deepEqual(start.observability.events, []);
    for (const legacy of ['stats', 'categories', 'spaces', 'layers', 'wiki_pages', 'states', 'inject', 'config']) assert.ok(legacy in start);
    const prompt = { session: f.session, query: 'Gateway retry backoff configured 45 seconds' };
    const s = f.section(prompt), d = f.dynamic(prompt);
    assert.ok(s.length > 0);
    assert.ok(d.length > 0, 'real dynamic retrieval exercised');
    const visible = await f.status({ spaceId: f.spaceId, includeInjectionText: true });
    const frame = visible.observability.injection.current;
    assert.equal(visible.observability.injection.measurement, 'observed');
    assert.equal(frame.tierS.text, s);
    assert.equal(frame.tierD.text, d);
    assert.equal(frame.totalChars, s.length + d.length);
    assert.equal(frame.totalBytes, Buffer.byteLength(s + d));
    const before = f.store.dataGeneration();
    const hidden = await f.status();
    assert.equal(f.store.dataGeneration(), before, 'plain status must not mutate persistent data');
    assert.equal(hidden.observability.injection.current, null);
    assert.doesNotMatch(JSON.stringify(hidden.observability), /immutable safety|backoff configured|Gateway retry/);
    assert.equal((await f.status({ spaceId: f.spaceId, sessionId: 'another-session', includeInjectionText: true })).observability.injection.current, null);
    assert.equal((await f.status({ spaceId: 'global', includeInjectionText: true })).observability.injection.current, null);
    const events = hidden.observability.events.length;
    await f.tools.get('memjudge_stats').execute({}, { agent: { session: f.session } });
    assert.equal((await f.status()).observability.events.length, events, 'stats rendering is not host injection generation');
    const next = { session: f.session, query: '' };
    f.section(next); f.dynamic(next);
    assert.equal((await f.status({ spaceId: f.spaceId, includeInjectionText: true })).observability.injection.current.tierD.text, '');
    f.host.emit(f.session, { type: 'compaction/end' });
    assert.equal((await f.status({ spaceId: f.spaceId, includeInjectionText: true })).observability.injection.current, null);
    f.section(next); f.dynamic(next);
    f.host.emit(f.session, { type: 'session/end' });
    assert.deepEqual((await f.status()).observability.events, []);
  } finally { f.app.dispose(); assert.equal(f.routes.size, 0); }
});

test('header-only session lifecycle clears observations, preserves S on compaction and releases engine on end/dispose', async () => {
  for (const type of ['session/end', 'session/dispose']) {
    const f = fixture();
    try {
      const sessionId = 'header-only-session';
      const session = { header: { id: sessionId, cwd: f.cwd, origin: 'user' } };
      const payload = { sessionId, spaceId: f.spaceId, includeInjectionText: true };
      const key = JSON.stringify([sessionId, f.spaceId]);
      const prompt = { session, query: '' };
      const frozen = f.section(prompt); f.dynamic(prompt);
      assert.ok((await f.status(payload)).observability.injection.current);
      assert.equal(f.app.injector.sessionStats(key).exists, true);
      f.host.emit(session, { type: 'compaction/end' });
      const compacted = (await f.status(payload)).observability;
      assert.equal(compacted.injection.current, null);
      assert.deepEqual(compacted.events, []);
      assert.equal(f.app.injector.sessionStats(key).compactions, 1);
      assert.equal(f.app.injector.sessionStats(key).tierSFrozen, true);
      f.store.put({ text: 'New rule must not alter a frozen prefix', category: 'rule', spaceId: f.spaceId });
      assert.equal(f.section(prompt), frozen);
      f.dynamic(prompt);
      assert.ok((await f.status(payload)).observability.injection.current);
      f.host.emit(session, { type });
      const ended = (await f.status(payload)).observability;
      assert.equal(ended.injection.current, null);
      assert.deepEqual(ended.events, []);
      assert.equal(f.app.injector.sessionStats(key).exists, false, type);
    } finally { f.app.dispose(); }
  }
});

test('same session cwd switch never replays frozen project prefix; unrelated frames cannot pair', async () => {
  const f = fixture();
  try {
    const prompt = { session: f.session, query: '' };
    const old = f.section(prompt);
    f.dynamic({ ...prompt });
    assert.equal((await f.status({ spaceId: f.spaceId, includeInjectionText: true })).observability.injection.current, null);
    assert.match(old, /Project A/);
    const cwd = 'F:/observation-host/project-b';
    const spaceId = resolveObservationScope({ cwd }).spaceId;
    f.store.put({ text: 'Project B separate rule', category: 'rule', spaceId });
    const session = { id: f.session.id, header: { cwd, origin: 'user' } };
    const other = { session, query: '' };
    const s = f.section(other); f.dynamic(other);
    assert.match(s, /Project B/);
    assert.doesNotMatch(s, /Project A/);
    const b = await f.status({ cwd, spaceId, includeInjectionText: true });
    assert.equal(b.observability.injection.current.tierS.text, s);
    assert.equal(b.observability.spaces.find(s => s.id === spaceId).memoryCount, 1);
    assert.equal((await f.status({ spaceId: f.spaceId, includeInjectionText: true })).observability.injection.current, null);
  } finally { f.app.dispose(); }
});

test('combined compatibility callback accounts exact returned separator and truncation bytes', async () => {
  const f = fixture({ context: false, injectBudget: 150 });
  try {
    const text = f.section({ session: f.session, query: 'Gateway retry backoff configured 45 seconds' });
    const result = await f.status({ spaceId: f.spaceId, includeInjectionText: true });
    const frame = result.observability.injection.current;
    assert.ok(frame);
    assert.equal(frame.totalChars, text.length);
    assert.equal(frame.totalBytes, Buffer.byteLength(text));
    assert.equal(frame.tierS.text + '\n'.repeat(frame.separatorChars) + frame.tierD.text, text);
    assert.ok(frame.totalChars <= 150);
  } finally { f.app.dispose(); }
});

test('asynchronous pre-step fallback records actual inserted channel but cannot fabricate a complete frame', async () => {
  const f = fixture({ context: false });
  try {
    const step = [...f.listeners.get('agent/pre-step')][0];
    const input = { agent: { session: f.session }, messages: [{ role: 'user', content: 'Gateway retry backoff configured 45 seconds' }] };
    await step(input, () => input);
    assert.equal(input.messages[0].source.kind, 'runtime-context');
    const obs = (await f.status({ spaceId: f.spaceId, includeInjectionText: true })).observability;
    assert.equal(obs.injection.current, null);
    assert.equal(obs.injection.unavailableReason, 'complete-frame-not-observed');
    assert.equal(obs.events.length, 1);
    assert.equal(obs.events[0].details.channel, 'tierD');
    assert.equal(obs.events[0].details.tierDChars, input.messages[0].content[0].text.length);
    assert.doesNotMatch(JSON.stringify(obs.events), /Gateway|backoff/);
  } finally { f.app.dispose(); }
});

test('anonymous and subagent callback generation never creates an observable session frame', async () => {
  const f = fixture();
  try {
    const anonymous = { cwd: f.cwd, query: '' };
    f.section(anonymous); f.dynamic(anonymous);
    assert.deepEqual((await f.status()).observability.events, []);
    const child = { session: { id: 'child', header: { cwd: f.cwd, origin: 'subagent' } }, query: 'Gateway retry backoff' };
    assert.equal(f.section(child), '');
    assert.equal(f.dynamic(child), '');
    assert.deepEqual((await f.status({ sessionId: 'child' })).observability.events, []);
  } finally { f.app.dispose(); }
});

test('legacy mode remains explicitly unavailable rather than a fabricated tiered frame', async () => {
  const f = fixture({ injectMode: 'legacy' });
  try {
    f.section({ session: f.session });
    const result = await f.status({ spaceId: f.spaceId, includeInjectionText: true });
    assert.equal(result.observability.injection.current, null);
    assert.equal(result.observability.injection.unavailableReason, 'legacy-frame-not-observed');
  } finally { f.app.dispose(); }
});
