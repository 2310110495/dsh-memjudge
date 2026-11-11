import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from '../src/store.mjs';
import { installMemjudgeRpc } from '../src/rpc.mjs';
import { stubConnection } from './rpc-fetch-stub.mjs';

test('memories RPC preserves UTF-16 pairs at the preview boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-rpc-preview-'));
  const dbPath = path.join(dir, 'test.sqlite');
  try {
    const store = open(dbPath);
    const texts = [
      'a'.repeat(199) + '😀' + 'z',
      'b'.repeat(198) + '😀' + 'z',
      'c'.repeat(201),
      'short 😀 text',
      'd'.repeat(200),
    ];
    const ids = texts.map(text => store.put({ text }).id);
    store.close();
    let handler;
    const stub = stubConnection();
    installMemjudgeRpc({ connection: stub.connection }, { dbPath });
    handler = stub.call;
    const result = await handler('memories', { limit: 120 });
    assert.equal(result.ok, true);
    assert.equal(result.value.total, texts.length);
    const rows = new Map(result.value.rows.map(row => [row.id, row]));
    const expected = ['a'.repeat(199), 'b'.repeat(198) + '😀', 'c'.repeat(200), texts[3], texts[4]];
    for (let i = 0; i < texts.length; i++) {
      const row = rows.get(ids[i]);
      assert.ok(row);
      assert.deepEqual(Object.keys(row).sort(), ['accessed', 'chapter', 'created', 'id', 'importance', 'source', 'text']);
      assert.equal(row.text, expected[i]);
      assert.ok(row.text.length <= 200 && texts[i].startsWith(row.text));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
