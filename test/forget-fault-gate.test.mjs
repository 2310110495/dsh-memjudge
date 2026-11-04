import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../src/index.mjs';

for (const mode of ['begin', 'begin-after', 'commit-before', 'commit-after', 'rollback-before', 'rollback-after', 'rebuild']) {
  test(`forget fault gate: ${mode}`, async () => {
    const tools = new Map(), sections = new Map();
    let service;
    const ctx = {
      tools: { register: t => (tools.set(t.name, t), () => {}) },
      systemPrompt: { section: s => (sections.set(s.name, s), () => {}) },
      provide: (_name, value) => { service = value; return () => {}; },
      effect: fn => fn(), on: () => () => {},
    };
    const app = apply(ctx, { dbPath: ':memory:', vector: false, autoInject: true });
    const originalExec = DatabaseSync.prototype.exec;
    const originalPrepare = DatabaseSync.prototype.prepare;
    let db;
    try {
      const item = await tools.get('memjudge_remember').execute({ text: '白鲸号焊缝凹陷九厘米。' });
      const initialFacts = service.stats().facts;
      assert.ok(initialFacts > 0);
      const inject = [...sections.values()][0].text;
      assert.match(inject(), /白鲸号/);
      await tools.get('memjudge_forget').execute({ query: '白鲸号', dryRun: true });
      DatabaseSync.prototype.prepare = function(sql, ...args) {
        const stmt = originalPrepare.call(this, sql, ...args);
        if (sql === 'DELETE FROM memories WHERE id = ?') {
          db = this;
          if (mode.startsWith('rollback')) return { run() { throw new Error('delete-primary'); } };
        }
        if (mode === 'rebuild' && sql === 'SELECT rowid AS ord, text FROM memories ORDER BY created_at, id') throw new Error('rebuild-primary');
        return stmt;
      };
      DatabaseSync.prototype.exec = function(sql) {
        if (sql === 'BEGIN' && mode === 'begin') throw new Error('begin-primary');
        if (sql === 'BEGIN' && mode === 'begin-after') { originalExec.call(this, sql); throw new Error('begin-primary'); }
        if (sql === 'COMMIT' && mode === 'commit-before') throw new Error('commit-primary');
        if (sql === 'COMMIT' && mode === 'commit-after') { originalExec.call(this, sql); throw new Error('commit-primary'); }
        if (sql === 'ROLLBACK' && mode === 'rollback-before') throw new Error('rollback-cleanup');
        if (sql === 'ROLLBACK' && mode === 'rollback-after') { originalExec.call(this, sql); throw new Error('rollback-cleanup'); }
        return originalExec.call(this, sql);
      };
      const id = item.id;
      let error;
      try { await tools.get('memjudge_forget').execute({ id }); } catch (e) { error = e; }
      assert.ok(error);
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.prepare = originalPrepare;
      if (mode === 'begin') {
        assert.equal(service.stats().facts, initialFacts);
        assert.match(error.message, /begin-primary/);
        assert.match(inject(), /白鲸号/);
        assert.equal(db.isTransaction, false);
        assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get().n, 1);
      } else {
        assert.throws(() => service.stats(), /instance fault/);
        for (const call of [() => service.bySourcePrefix(null), () => service.occurrencesV1(null),
          () => service.bySourcePrefixV1(null), () => service.byKind('event')]) {
          assert.throws(call, /instance fault/);
        }
        await assert.rejects(service.recallByQuery(''), /instance fault/);
        assert.equal(service.version, '1');
        assert.match(error.message, /instance fault/);
        const cause = error.cause;
        if (mode.startsWith('rollback')) {
          assert.match(cause.errors[0].message, /delete-primary/);
          assert.match(cause.errors[1].message, /rollback-cleanup/);
        } else assert.match(cause.message, /primary/);
        assert.throws(inject, /instance fault/);
        await assert.rejects(tools.get('memjudge_forget').execute({ query: '白鲸号', dryRun: true }), /instance fault/);
        assert.equal(db.isTransaction, mode === 'rollback-before' || mode === 'begin-after');
        assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get().n, mode === 'commit-after' || mode === 'rebuild' ? 0 : 1);
      }
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.prepare = originalPrepare;
      app.dispose();
    }
  });
}
