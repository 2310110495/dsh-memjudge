import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { createService } from '../src/service.mjs';

for (const kind of ['delete', 'write', 'idempotent', 'empty-delete', 'dry-run', 'touch']) {
  test(`service delivery generation: ${kind}`, { timeout: 5000 }, async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('network disabled'); };
    const tools = new Map(), services = new Map();
    const ctx = { tools: { register: x => (tools.set(x.name, x), () => {}) },
      systemPrompt: { section: () => () => {} }, provide: (n, s) => (services.set(n, s), () => {}),
      effect: fn => fn(), on: () => () => {} };
    let app;
    try {
      app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false });
      const remember = tools.get('memjudge_remember'), forget = tools.get('memjudge_forget');
      const item = await remember.execute({ text: '钟摆记录七点', kind: 'event' });
      const pending = services.get('memjudge').recallByQuery('钟摆');
      let action;
      if (kind === 'delete') action = forget.execute({ id: item.id });
      if (kind === 'write') action = remember.execute({ text: '钟摆记录八点', kind: 'event' });
      if (kind === 'idempotent') action = remember.execute({ text: '钟摆记录七点', kind: 'event' });
      if (kind === 'empty-delete') action = forget.execute({ id: 'missing-id' });
      if (kind === 'dry-run') action = forget.execute({ id: item.id, dryRun: true });
      if (kind === 'touch') action = tools.get('memjudge_recall').execute({ query: '钟摆' });
      if (['delete', 'write', 'idempotent'].includes(kind)) {
        await assert.rejects(pending, /memjudge recall stale: content changed/);
      } else {
        assert.equal((await pending).denied, false);
      }
      await action;
    } finally {
      app?.dispose();
      globalThis.fetch = oldFetch;
    }
  });
}

test('service guard takes priority over changed version and underlying rejection', { timeout: 5000 }, async () => {
  const store = { stats() {}, bySourcePrefix() {}, byKind() {} };
  let release, fault = false, version = 0;
  const service = createService(null, { store, contentVersion: () => version,
    guard: () => { if (fault) throw new Error('fixture fault'); },
    recall: () => new Promise((resolve, reject) => { release = reject; }) });
  try {
    const pending = service.recallByQuery('clock');
    version++; fault = true; release(new Error('underlying'));
    await assert.rejects(pending, /fixture fault/);
  } finally { release?.(new Error('released')); }
});

test('legacy service and original errors stay compatible', { timeout: 5000 }, async () => {
  const store = { stats() {}, bySourcePrefix() {}, byKind() {} };
  const cause = new Error('underlying');
  const service = createService(null, { store, recall: async () => { throw cause; } });
  await assert.rejects(service.recallByQuery('clock'), error => error === cause);
  assert.throws(() => createService(null, { store, contentVersion: 1 }), /contentVersion/);
});
