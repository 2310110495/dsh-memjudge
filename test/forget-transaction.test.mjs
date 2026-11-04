import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../src/index.mjs';

test('forget preserves facts after a mid-batch rollback and rebuilds after success', async () => {
  const tools = new Map();
  const sections = new Map();
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    systemPrompt: { section: section => { sections.set(section.name, section); return () => {}; } },
    effect: fn => fn(), on: () => () => {},
  };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, autoInject: true });
  const original = DatabaseSync.prototype.prepare;
  try {
    const remember = tools.get('memjudge_remember');
    await remember.execute({ text: '白鲸号焊缝凹陷九厘米。' });
    await remember.execute({ text: '白鲸号焊缝凹陷十一厘米。' });
    const stats = tools.get('memjudge_stats');
    const before = await stats.execute({});
    assert.ok(before.facts > 0);
    const inject = [...sections.values()][0].text;
    const cached = inject();
    let calls = 0;
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      const stmt = original.call(this, sql, ...args);
      if (sql !== 'DELETE FROM memories WHERE id = ?') return stmt;
      return { run: (...params) => { if (++calls === 2) throw new Error('mid-delete'); return stmt.run(...params); } };
    };
    const forget = tools.get('memjudge_forget');
    await assert.rejects(forget.execute({ query: '白鲸号焊缝', limit: 2 }), /mid-delete/);
    DatabaseSync.prototype.prepare = original;
    assert.equal((await stats.execute({})).facts, before.facts);
    assert.equal(inject(), cached);
    const result = await forget.execute({ query: '白鲸号焊缝', limit: 2 });
    assert.equal(result.count, 2);
    assert.equal((await stats.execute({})).facts, 0);
    assert.doesNotMatch(inject(), /白鲸号/);
    assert.equal((await forget.execute({ query: '白鲸号焊缝' })).count, 0);
  } finally {
    DatabaseSync.prototype.prepare = original;
    app.dispose();
  }
});
