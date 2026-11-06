import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';

const entry = { id: 'one', text: '甲😀乙' };
const result = fact => ({ extractHybrid: async () => ({ source: 'llm', perEntry: [[fact]] }) });

test('rollback wrapper cannot reenter store after lock release', async () => {
  const s = open(':memory:');
  s.put(entry);
  const db = s.raw(), exec = db.exec;
  let blocked = false;
  db.exec = function(sql) {
    if (sql === 'ROLLBACK') assert.throws(() => s.close(), /publication in progress/);
    const out = exec.call(this, sql);
    if (sql === 'ROLLBACK') {
      assert.throws(() => s.close(), /publication in progress/);
      assert.throws(() => s.put({ id: 'two', text: '二号是测试。' }), /publication in progress/);
      blocked = true;
    }
    return out;
  };
  try {
    await s.rebuildFactsHybrid(result({ attr: '标记', value: '甲' }));
    assert.equal(blocked, true);
    s.put({ id: 'two', text: '二号是测试。' });
    assert.ok(s.get('two'));
  } finally { db.exec = exec; s.close(); }
});

test('UTF-16 bounds, exact sentence spans and omitted fields', async () => {
  const s = open(':memory:');
  try {
    s.put(entry);
    await s.rebuildFactsHybrid(result({ attr: '标记', value: '甲' }));
    const before = s.get('one').facts;
    for (const fields of [{ at: 5 }, { sentOff: 5 }, { sentLen: 5 }, { sentOff: 3, sentLen: 2 }, { sentOff: 1, sentLen: 2, sent: '乙' }]) {
      await assert.rejects(s.rebuildFactsHybrid(result({ attr: '标记', value: '甲', ...fields })), /invalid extraction/);
      assert.deepEqual(s.get('one').facts, before);
    }
    await s.rebuildFactsHybrid(result({ attr: '标记', value: '😀', at: 1, sentOff: 1, sentLen: 2, sent: '😀' }));
    assert.equal(s.get('one').facts[0].sent_len, 2);
    await s.rebuildFactsHybrid(result({ attr: '标记', value: '甲', at: 4, sentOff: 4, sentLen: 0 }));
  } finally { s.close(); }
});
