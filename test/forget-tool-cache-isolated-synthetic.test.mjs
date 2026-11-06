import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('real registered forget invalidates warmed BM25 cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memjudge-forget-isolated-'));
  try {
    const env = { SystemRoot: process.env.SystemRoot, TEMP: dir, TMP: dir, HOME: dir,
      USERPROFILE: dir, DSH_HOME: dir, MEMJUDGE_NO_SECRETS: '1', MEMJUDGE_NO_JIEBA: '1',
      MEMJUDGE_VECTOR: '0', MEMJUDGE_RERANK: '0', MEMJUDGE_EXPAND: '0', MEMJUDGE_LLMSELECT: '0' };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import net from 'node:net';
      import tls from 'node:tls';
      import dgram from 'node:dgram';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const blocked = () => { throw new Error('network blocked by synthetic test'); };
      net.connect = net.createConnection = tls.connect = dgram.createSocket = blocked;
      net.Socket.prototype.connect = blocked;
      globalThis.fetch = blocked;
      syncBuiltinESMExports();
      const { apply } = await import('./src/index.mjs');
      const { open } = await import('./src/store.mjs');
      const dbPath = join(process.env.DSH_HOME, 'synthetic.sqlite');
      let dumps = 0;
      let currentStore;
      const mount = () => {
        const tools = new Map();
        const ctx = { tools: { register: x => { tools.set(x.name, x); return () => {}; } },
          systemPrompt: { section: () => () => {} }, effect: () => {} };
        const plugin = apply(ctx, { dbPath, vector: false, expand: false, llmSelect: false,
          experimentalSnapshotRecall: false, autoCapture: false, touchOnRecall: false },
          { storeFactory: (path, opts) => {
            assert.equal(path, dbPath);
            const store = open(path, opts);
            currentStore = store;
            return new Proxy(store, { get(target, key, receiver) {
              if (key === 'dump') return (...args) => { dumps++; return target.dump(...args); };
              return Reflect.get(target, key, receiver);
            } });
          } });
        return { plugin, call: (name, args) => tools.get(name).execute(args) };
      };
      let { plugin, call } = mount();
      try {
        const first = await call('memjudge_remember', { text: '紫砂桥梁长度10米。', chapter: 1, documentId: 'synthetic-doc' });
        const second = await call('memjudge_remember', { text: '紫砂桥梁长度20米。', chapter: 1, documentId: 'synthetic-doc' });
        assert.ok(first.factCount > 0 && second.factCount > 0);
        const factValues = () => new Set(currentStore.allFacts().map(f => f.value));
        assert.ok(factValues().has('10米') && factValues().has('20米'));
        const hits = async () => (await call('memjudge_recall', { query: '紫砂桥梁', topChapters: 4 })).hits.map(x => x.id);
        const conflicts = async () => call('memjudge_conflicts_v2', {});
        const expectNoConflicts = async () => {
          const result = await conflicts();
          assert.equal(result.scanIncomplete, false);
          assert.equal(result.totalExact, true);
          assert.equal(result.outputTruncated, false);
          assert.equal(result.reason, null);
          assert.equal(result.total, 0);
          assert.deepEqual(result.conflicts, []);
        };
        const expectConflict = async () => {
          const result = await conflicts();
          assert.equal(result.scanIncomplete, false);
          assert.equal(result.total, 1);
          assert.equal(result.conflicts[0].documentId, 'synthetic-doc');
          assert.equal(result.conflicts[0].unit, '米');
          assert.deepEqual(new Set(result.conflicts[0].values), new Set(['10米', '20米']));
          assert.deepEqual(new Set(result.conflicts[0].evidence.map(x => x.memoryId)), new Set([first.id, second.id]));
        };
        await expectConflict();
        const beforeWarm = dumps;
        assert.deepEqual(new Set(await hits()), new Set([first.id, second.id]));
        assert.equal(dumps, beforeWarm + 1);
        assert.deepEqual(new Set(await hits()), new Set([first.id, second.id]));
        assert.equal(dumps, beforeWarm + 1);
        assert.deepEqual(await call('memjudge_forget', { id: first.id, dryRun: true }),
          { forgotten: [first.id], count: 1, dryRun: true });
        assert.deepEqual(new Set(await hits()), new Set([first.id, second.id]));
        assert.equal(dumps, beforeWarm + 1);
        await expectConflict();
        assert.ok(factValues().has('10米') && factValues().has('20米'));
        assert.deepEqual(await call('memjudge_forget', { id: first.id }),
          { forgotten: [first.id], count: 1, dryRun: false });
        const afterDelete = dumps;
        assert.deepEqual(await hits(), [second.id]);
        assert.equal(dumps, afterDelete + 1);
        await expectNoConflicts();
        assert.equal(factValues().has('10米'), false);
        assert.equal(factValues().has('20米'), true);
        await plugin.dispose();
        ({ plugin, call } = mount());
        assert.deepEqual(await hits(), [second.id]);
        await expectNoConflicts();
        assert.equal(factValues().has('10米'), false);
        assert.equal(factValues().has('20米'), true);
        assert.deepEqual(await call('memjudge_forget', { query: '紫砂桥梁', dryRun: true }),
          { forgotten: [second.id], count: 1, dryRun: true });
        assert.equal(factValues().has('20米'), true);
        assert.deepEqual(await call('memjudge_forget', { query: '紫砂桥梁' }),
          { forgotten: [second.id], count: 1, dryRun: false });
        assert.deepEqual(await hits(), []);
        assert.equal(factValues().has('20米'), false);
        await expectNoConflicts();
        await plugin.dispose();
        ({ plugin, call } = mount());
        assert.deepEqual(await hits(), []);
        assert.equal(factValues().has('20米'), false);
        await expectNoConflicts();
      } finally { await plugin.dispose(); }
    `], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
