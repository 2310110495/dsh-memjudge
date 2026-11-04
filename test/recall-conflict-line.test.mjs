import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';

for (const sameDocument of [false, true]) {
  test(`recall avoids unsupported current assertions, sameDocument=${sameDocument}`, async () => {
    const tools = new Map();
    const services = new Map();
    const ctx = {
      tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
      systemPrompt: { section: () => () => {} },
      provide: (name, service) => { services.set(name, service); return () => {}; },
      effect: fn => fn(), on: () => () => {},
    };
    const app = apply(ctx, { dbPath: ':memory:', vector: false, autoInject: false, touchOnRecall: false });
    try {
      const put = args => tools.get('memjudge_remember').execute(args);
      await put({ text: '白鲸号焊缝凹陷九厘米。', documentId: 'A', chapter: 1 });
      await put({ text: '白鲸号焊缝凹陷十一厘米，原报九厘米系估值，现予更正。', documentId: sameDocument ? 'A' : 'B', chapter: 1 });
      const tool = tools.get('memjudge_recall');
      assert.equal(tool.output.schema.properties.conflictLine.type, 'string');
      for (const budget of [2000, 5]) {
        const result = await tool.execute({ query: '白鲸号焊缝凹陷', budget });
        assert.equal(result.denied, false);
        assert.equal(result.conflictLine, '');
        assert.ok(result.hits.length > 0);
        assert.ok(result.chars <= budget);
        if (budget === 5) assert.equal(result.hits[0].truncated, true);
        const rendered = JSON.stringify(tool.output.render({}, result));
        assert.ok(!rendered.includes('当前应以'));
        const service = await services.get('memjudge').recallByQuery('白鲸号焊缝凹陷', { budget });
        assert.equal(service.denied, result.denied);
        assert.equal(service.chars, result.chars);
        assert.deepEqual(service.hits, result.hits);
        assert.equal('conflictLine' in service, false);
      }
      const missing = await tool.execute({ query: 'zzzzunmatched' });
      assert.equal(missing.denied, true);
      assert.deepEqual(missing.hits, []);
    } finally { app.dispose(); }
  });
}
