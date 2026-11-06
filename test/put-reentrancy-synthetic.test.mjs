import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

const fact = text => [{ attr: 'synthetic', value: text }];
const entry = { id: 'old', text: 'old text' };
const next = { id: 'new', text: 'new text' };

for (const stage of ['extract-fail', 'extract-success', 'begin-before', 'begin-after', 'commit-before', 'commit-after', 'rollback-before', 'rollback-after']) {
  test(`put blocks synchronous reentry: ${stage}`, async () => {
    let store, armed = false, probes = 0;
    const rejections = [];
    let hybridCalls = 0;
    const probe = () => {
      probes++;
      for (const [name, fn] of Object.entries(store)) {
        if (typeof fn !== 'function' || /vector/i.test(name) || name === 'rebuildFactsHybrid') continue;
        assert.throws(() => fn(), /put operation in progress/, name);
      }
      const result = store.rebuildFactsHybrid({ extractHybrid: async () => {
        hybridCalls++;
        return { source: 'rules' };
      } });
      assert.ok(result instanceof Promise);
      rejections.push(result.catch(error => error));
      assert.throws(() => store.dropFactsOf('old'), /put operation in progress/);
      assert.throws(() => store.rebuildFacts(), /put operation in progress/);
    };
    store = open(':memory:', { extractL1: text => {
      if (armed && text === next.text) {
        if (stage.startsWith('extract-')) probe();
        if (stage === 'extract-fail' || stage.startsWith('rollback-')) throw new Error('extract failure');
      }
      return fact(text);
    } });
    const db = store.raw();
    const original = db.exec;
    try {
      store.put(entry);
      armed = true;
      db.exec = function(sql) {
        const phase = sql === 'BEGIN IMMEDIATE' ? 'begin' : sql === 'COMMIT' ? 'commit' : sql === 'ROLLBACK' ? 'rollback' : '';
        if (stage === `${phase}-before`) probe();
        const result = original.call(this, sql);
        if (stage === `${phase}-after`) probe();
        return result;
      };
      if (stage === 'extract-fail' || stage.startsWith('rollback-')) {
        assert.throws(() => store.put(next), /extract failure/);
        assert.equal(store.get('new'), null);
      } else {
        assert.equal(store.put(next).inserted, true);
        assert.equal(store.get('new').facts.length, 1);
      }
      assert.equal(probes, 1);
      const errors = await Promise.all(rejections);
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /put operation in progress/);
      assert.equal(hybridCalls, 0);
      assert.equal(db.isTransaction, false);
      assert.equal(store.get('old').facts.length, 1);
      assert.equal(store.allFacts().length, stage === 'extract-fail' || stage.startsWith('rollback-') ? 1 : 2);
    } finally {
      db.exec = original;
      if (db.isTransaction) db.exec('ROLLBACK');
      store.close();
    }
  });
}
