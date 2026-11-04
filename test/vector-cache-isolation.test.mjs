import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

const source = process.env.B02_VECTOR_SOURCE || fileURLToPath(new URL('../src/vector.mjs', import.meta.url));
const childDir = process.env.B02_CHILD_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b02-vector-'));
for (const key of Object.keys(process.env)) if (key.startsWith('MEMJUDGE_') || ['DSH_HOME', 'DSH_WORKBENCH_HOME'].includes(key)) delete process.env[key];
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DSH_HOME', 'DSH_WORKBENCH_HOME']) process.env[key] = root;
process.env.MEMJUDGE_NO_SECRETS = '1';
const blocked = () => { throw new Error('network disabled by B02 fixture'); };
net.connect = net.createConnection = net.Socket.prototype.connect = blocked;
http.request = http.get = https.request = https.get = blocked;
syncBuiltinESMExports();
globalThis.fetch = blocked;
const V = await import(pathToFileURL(source));
const keyA = 'fake-embed-key-A-only';
const keyB = 'fake-embed-key-B-only';
function config(base = 'https://a.invalid/v1', model = 'fixture-model', key = keyA) {
  process.env.MEMJUDGE_EMBED_BASE_URL = base;
  process.env.MEMJUDGE_EMBED_MODEL = model;
  process.env.MEMJUDGE_EMBED_KEY = key;
  process.env.MEMJUDGE_CHAT_KEY = 'fake-chat-key-never-embed';
  process.env.MEMJUDGE_RERANK_KEY = 'fake-rerank-key-never-embed';
}
function mock(calls, value = url => url.includes('b.invalid') ? -0.5 : 0.5) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ data: body.input.map(() => ({ embedding: Array(body.dimensions).fill(value(url)) })) }) };
  };
}
function dir(name) { const d = path.join(root, name); fs.mkdirSync(d); return d; }
async function fresh() { return import(`${pathToFileURL(source)}?fresh=${crypto.randomUUID()}`); }
function child(cacheDir, mode = 'restart') {
  const env = { ...process.env, B02_VECTOR_SOURCE: source, B02_CHILD_DIR: cacheDir, B02_CHILD_MODE: mode };
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
if (childDir) {
  const calls = [];
  mock(calls);
  if (process.env.B02_CHILD_MODE === 'restart') {
    config('https://b.invalid/v1', 'fixture-model', keyB);
    assert.equal((await V.embed(['shared'], { dims: 64, cacheDir: childDir }))[0][0], -63);
    config();
    assert.equal((await V.embed(['shared'], { dims: 64, cacheDir: childDir }))[0][0], 64);
    assert.equal(calls.length, 0);
  } else if (process.env.B02_CHILD_MODE === 'inflight-hit') {
    config();
    await V.embed(['old-pending', 'new-completed'], { dims: 64, cacheDir: childDir });
    assert.equal(calls.length, 0);
  } else {
    config();
    assert.equal((await V.embed(['new'], { dims: 64, cacheDir: childDir }))[0][0], 64);
    assert.equal(calls.length, process.env.B02_CHILD_MODE === 'hit' ? 0 : 1);
  }
} else {
  for (const mode of ['memory', 'disk']) test(`A-B-A isolation and exact request identity: ${mode}`, async () => {
    const mod = await fresh(); const calls = []; mock(calls);
    const cacheDir = mode === 'disk' ? dir(mode) : null;
    config();
    assert.equal((await mod.embed(['shared'], { dims: 64, cacheDir }))[0][0], 64);
    config('https://b.invalid/v1', 'fixture-model', keyB);
    assert.equal((await mod.embed(['shared'], { dims: 64, cacheDir }))[0][0], -63);
    config();
    assert.equal((await mod.embed(['shared'], { dims: 64, cacheDir }))[0][0], 64);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.url), ['https://a.invalid/v1/embeddings', 'https://b.invalid/v1/embeddings']);
    assert.deepEqual(calls.map(c => c.auth), [`Bearer ${keyA}`, `Bearer ${keyB}`]);
    if (cacheDir) {
      child(cacheDir);
      for (const name of fs.readdirSync(cacheDir)) {
        const content = fs.readFileSync(path.join(cacheDir, name), 'utf8');
        for (const secret of [keyA, keyB, 'https://a.invalid', 'https://b.invalid', 'fake-chat-key-never-embed']) assert.ok(!content.includes(secret));
      }
    }
  });

  test('model, actual dimensions, protocol, path, trailing slash and string-v1', async () => {
    const mod = await fresh(); const calls = []; mock(calls); config();
    const options = { dims: 64, cacheDir: null };
    await mod.embed([123], options);
    await mod.embed(['123'], options); assert.equal(calls.length, 1);
    await mod.embed([' 123'], options); assert.equal(calls.length, 2);
    config('https://a.invalid/v1///'); await mod.embed(['123'], options); assert.equal(calls.length, 2);
    config('https://a.invalid/v1', 'other-model'); await mod.embed(['123'], options); assert.equal(calls.length, 3);
    await mod.embed(['123'], { ...options, dims: 128 }); assert.equal(calls.length, 4);
    await mod.embed(['123'], { ...options, dims: 7 }); assert.equal(calls.length, 4);
    config('http://a.invalid/v1', 'other-model'); await mod.embed(['123'], options);
    config('https://a.invalid/tenant', 'other-model'); await mod.embed(['123'], options);
    assert.equal(calls.length, 6);
    assert.deepEqual(calls.map(c => c.body.dimensions), [64, 64, 64, 128, 64, 64]);
    config(); await mod.embed([null, undefined, ''], options);
    assert.deepEqual(calls.at(-1).body.input, ['', '', '']);
  });

  test('explicit null and empty directory select memory; omitted directory retains setting', async () => {
    const mod = await fresh(); const calls = []; mock(calls); config();
    const cacheDir = dir('switch');
    await mod.embed(['x'], { dims: 64, cacheDir });
    await mod.embed(['x'], { dims: 64 }); assert.equal(calls.length, 1);
    await mod.embed(['x'], { dims: 64, cacheDir: null }); assert.equal(calls.length, 2);
    assert.equal(mod.vecStats().cacheFile, null);
    await mod.embed(['x'], { dims: 64, cacheDir: '' }); assert.equal(calls.length, 2);
    await mod.embed(['x'], { dims: 64, cacheDir }); assert.equal(calls.length, 2);
    assert.ok(mod.vecStats().cacheFile.startsWith(cacheDir));
  });

  test('pending first request freezes model endpoint key for retry and later batches', async () => {
    const mod = await fresh(); config(); const calls = [];
    let release; let started;
    const entered = new Promise(r => { started = r; });
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); calls.push({ url, body, auth: init.headers.Authorization });
      if (calls.length === 1) { started(); await new Promise(r => { release = r; }); return { ok: false, status: 429 }; }
      return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: Array(body.dimensions).fill(url.includes('b.invalid') ? -0.5 : 0.5) })) }) };
    };
    const pending = mod.embed(['one', 'two'], { dims: 64, batch: 1, cacheDir: null });
    await entered; config('https://b.invalid/v1', 'model-B', keyB); release();
    assert.deepEqual((await pending).map(v => v[0]), [64, 64]);
    assert.equal(calls.length, 3);
    for (const call of calls) { assert.equal(call.url, 'https://a.invalid/v1/embeddings'); assert.equal(call.body.model, 'fixture-model'); assert.equal(call.auth, `Bearer ${keyA}`); }
    assert.deepEqual((await mod.embed(['one', 'two'], { dims: 64 })).map(v => v[0]), [-63, -63]);
    assert.equal(calls.length, 4);
  });

  test('schema2 digest header, legacy preservation and corrupt cache misses', async () => {
    config(); const cacheDir = dir('corrupt'); const calls = []; mock(calls);
    const oldFingerprint = createHash('sha256').update('fixture-model|64').digest('hex').slice(0, 8);
    const legacy = path.join(cacheDir, `vec-cache-fixture-model-64-${oldFingerprint}.json`);
    const oldTextHash = createHash('sha256').update('shared').digest('hex').slice(0, 16);
    const bytes = JSON.stringify({ [oldTextHash]: Buffer.alloc(64, 99).toString('base64') }); fs.writeFileSync(legacy, bytes);
    let mod = await fresh(); await mod.embed(['shared'], { dims: 64, cacheDir });
    const file = mod.vecStats().cacheFile;
    assert.notEqual(file, legacy);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.schema, 2);
    assert.equal(raw.identity, createHash('sha256').update(JSON.stringify([2, 'https://a.invalid/v1/embeddings', 'fixture-model', 64, 'string-v1'])).digest('hex'));
    assert.match(path.basename(file), /^vec-cache-v2-[a-f0-9]{64}\.json$/);
    for (const bad of ['{', JSON.stringify({ ...raw, schema: 1 }), JSON.stringify({ ...raw, identity: 'wrong' }), JSON.stringify({ ...raw, entries: { [Object.keys(raw.entries)[0]]: 'AA==' } }), JSON.stringify({ ...raw, entries: { [Object.keys(raw.entries)[0]]: '!'.repeat(88) } })]) {
      fs.writeFileSync(file, bad); mod = await fresh(); const before = calls.length;
      assert.equal((await mod.embed(['shared'], { dims: 64, cacheDir }))[0][0], 64);
      assert.equal(calls.length, before + 1); assert.ok(mod.vecStats().cacheLoadFailures > 0);
    }
    assert.equal(fs.readFileSync(legacy, 'utf8'), bytes);
  });

  for (const operation of ['writeFileSync', 'renameSync']) test(`atomic persistence failure: ${operation}`, async () => {
    config(); const cacheDir = dir(operation); const calls = []; mock(calls);
    const mod = await fresh(); await mod.embed(['old'], { dims: 64, cacheDir });
    const file = mod.vecStats().cacheFile; const before = fs.readFileSync(file);
    const original = fs[operation];
    fs[operation] = (...args) => { if (String(args[0]).startsWith(cacheDir)) throw new Error(`fixture failure ${keyA}`); return original(...args); };
    syncBuiltinESMExports();
    try { assert.equal((await mod.embed(['new'], { dims: 64, cacheDir }))[0][0], 64); }
    finally { fs[operation] = original; syncBuiltinESMExports(); }
    assert.deepEqual(fs.readFileSync(file), before);
    assert.ok(mod.vecStats().cacheSaveFailures > 0);
    assert.equal(fs.readdirSync(cacheDir).filter(n => n.endsWith('.tmp')).length, 0);
    const restartCopy = path.join(root, `restart-${operation}`);
    fs.cpSync(cacheDir, restartCopy, { recursive: true });
    child(restartCopy, 'miss');
    assert.deepEqual(fs.readFileSync(file), before);
    const count = calls.length;
    await mod.embed(['new'], { dims: 64, cacheDir });
    assert.equal(calls.length, count, 'failed persistence keeps usable memory');
    assert.ok(Object.hasOwn(JSON.parse(fs.readFileSync(file)).entries, createHash('sha256').update('new').digest('hex')), 'parent hit-only recovery publishes new entry');
    const recovered = await fresh();
    await recovered.embed(['new'], { dims: 64, cacheDir });
    assert.equal(calls.length, count, 'recovery publishes a valid cache');
    child(cacheDir, 'hit');
    assert.ok(!JSON.stringify(mod.vecStats()).includes(keyA));
  });

  for (const mode of ['memory', 'disk']) test(`in-flight identity survives LRU churn and reentry: ${mode}`, async () => {
    const mod = await fresh(); config(); const calls = [];
    const cacheDir = mode === 'disk' ? dir('inflight-disk') : null;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body.input);
      if (body.input[0] === 'old-pending') await gate;
      return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: Array(64).fill(0.5) })) }) };
    };
    const pending = mod.embed(['old-pending'], { dims: 64, cacheDir });
    let file;
    try {
      for (let i = 0; i < 8; i++) {
        config(`https://churn${i}.invalid/v1`);
        await mod.embed(['other'], { dims: 64, cacheDir });
      }
      config(); await mod.embed(['new-completed'], { dims: 64, cacheDir });
      file = mod.vecStats().cacheFile;
      if (file) assert.ok(Object.hasOwn(JSON.parse(fs.readFileSync(file)).entries, createHash('sha256').update('new-completed').digest('hex')));
    } finally { release(); await pending; }
    if (file) {
      const entries = JSON.parse(fs.readFileSync(file)).entries;
      for (const text of ['old-pending', 'new-completed']) assert.ok(Object.hasOwn(entries, createHash('sha256').update(text).digest('hex')), `disk must retain ${text}`);
    }
    const count = calls.length;
    await mod.embed(['old-pending', 'new-completed'], { dims: 64, cacheDir });
    assert.equal(calls.length, count, 'both completions must remain in the same managed store');
    if (file) {
      const reopened = await fresh();
      await reopened.embed(['old-pending', 'new-completed'], { dims: 64, cacheDir });
      assert.equal(calls.length, count);
      child(cacheDir, 'inflight-hit');
    }
  });

  test('more than eight active identities retain leases and converge after success and failure', async () => {
    const mod = await fresh(); const releases = []; const calls = []; const pending = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); calls.push(url);
      if (body.input[0] === 'pending') await new Promise(resolve => { releases.push(resolve); });
      return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: Array(64).fill(0.5) })) }) };
    };
    try {
      for (let i = 0; i < 12; i++) {
        config(`https://active${i}.invalid/v1`);
        pending.push(mod.embed(['pending'], { dims: 64, cacheDir: null }));
      }
      assert.equal(releases.length, 12, 'real requests overlap before settling');
      assert.equal(mod.vecStats().cacheIdentities, 12, 'active stores are pinned beyond idle bound');
      assert.equal(mod.vecStats().cacheActiveIdentities, 12);
      config('https://active0.invalid/v1');
      await mod.embed(['reentrant'], { dims: 64, cacheDir: null });
      assert.equal(mod.vecStats().cacheInFlight, 12, 'reentrant release must not release original lease');
      releases[0](); await pending[0];
      assert.equal(mod.vecStats().cacheIdentities, 11, 'settled idle store is immediately evicted under pressure');
    } finally { releases.forEach(release => release()); await Promise.all(pending); }
    assert.equal(mod.vecStats().cacheIdentities, 8);
    assert.equal(mod.vecStats().cacheInFlight, 0);
    config('https://failed.invalid/v1');
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; throw new Error('fixture rejection'); };
    assert.equal(await mod.embed(['failure'], { dims: 64, cacheDir: null }), null);
    assert.equal(attempts, 2);
    assert.equal(mod.vecStats().cacheInFlight, 0);
    mock(calls); await mod.embed(['failure'], { dims: 64, cacheDir: null });
    assert.equal(mod.vecStats().cacheInFlight, 0);
    await assert.rejects(mod.embed(['throw'], { dims: 64, get batch() { throw new Error('fixture options'); } }), /fixture options/);
    assert.equal(mod.vecStats().cacheInFlight, 0, 'exception after acquire releases lease');
    delete process.env.MEMJUDGE_EMBED_KEY;
    delete process.env.MEMJUDGE_CHAT_KEY;
    assert.equal(await mod.embed(['no-key'], { dims: 64 }), null);
    assert.equal(mod.vecStats().cacheInFlight, 0);
    assert.equal(mod.vecStats().cacheIdentities, 8);
  });

  test('explicit reset preserves active namespace until its request settles', async () => {
    const mod = await fresh(); config(); const calls = []; let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body.input);
      if (body.input[0] === 'held') await gate;
      return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: Array(64).fill(0.5) })) }) };
    };
    const pending = mod.embed(['held'], { dims: 64, cacheDir: null });
    try { mod._setCacheDir(null, 64); await mod.embed(['other'], { dims: 64 }); }
    finally { release(); await pending; }
    const count = calls.length;
    await mod.embed(['held', 'other'], { dims: 64 });
    assert.equal(calls.length, count);
    assert.equal(mod.vecStats().cacheInFlight, 0);
  });

  test('identity and entry LRU bounds evict oldest without crossing namespaces', async () => {
    const mod = await fresh(); const calls = []; mock(calls);
    for (let i = 0; i < 9; i++) {
      config(`https://cache${i}.invalid/v1`);
      await mod.embed(['same'], { dims: 64, cacheDir: null });
    }
    assert.equal(mod.vecStats().cacheIdentities, 8);
    config('https://cache0.invalid/v1'); await mod.embed(['same'], { dims: 64, cacheDir: null });
    assert.equal(calls.length, 10);
    await mod.embed(Array.from({ length: 4097 }, (_, i) => `entry-${i}`), { dims: 64, batch: 128 });
    assert.equal(mod.vecStats().cacheSize, 4096);
    const count = calls.length;
    await mod.embed(['entry-4096'], { dims: 64 }); assert.equal(calls.length, count);
    await mod.embed(['entry-0'], { dims: 64 }); assert.equal(calls.length, count + 1);
  });

  for (const [index, url] of ['https://fixture-user:fixture-password@a.invalid/v1', 'https://a.invalid/v1?token=fixture-secret', 'https://a.invalid/v1#fixture-secret', 'not-a-url'].entries()) test(`credential or invalid URL disables persistence: ${index}`, async () => {
    const mod = await fresh(); const cacheDir = dir(`secret-${index}`); const calls = []; mock(calls);
    config(url);
    assert.equal((await mod.embed(['private'], { dims: 64, cacheDir }))[0][0], 64);
    assert.deepEqual(fs.readdirSync(cacheDir), []);
    assert.equal(mod.vecStats().cacheFile, null);
    assert.equal(mod.vecStats().persistenceDisabled, url === 'not-a-url' ? 'invalid-url' : 'credential-url');
    const status = JSON.stringify(mod.vecStats());
    for (const secret of [keyA, url, 'fixture-password', 'fixture-user']) assert.ok(!status.includes(secret));
  });
}
