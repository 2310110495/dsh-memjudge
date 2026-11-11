// host 侧通道迁移的契约测试：8 个端点各注册一条 exact Fetch 路由。
//
// 背景：DSH 0.2.2-rc.1 里旧式前缀通道对第三方插件不可用——注册时内部要取
// owner.webServer，而插件 ctx 没有 webServer 注入，注册抛错，前缀路由从未挂上，
// webserver 对 POST /memjudge/status 回 405。
// 新契约是 connection.fetch.register，path 必须 /api/ 开头、端点段匹配
// [A-Za-z0-9_$.-]+，请求体由 requestBodyMode 决定。
//
// DSH_HOME 必须在 import src/rpc.mjs（它去 import config.mjs）之前落到临时目录，
// 否则 saveConfig/saveKey 这类端点会写用户真实的 ~/.dsh/memjudge。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-rpc-routes-home-'));
process.env.DSH_HOME = HOME_DIR;
process.on('exit', () => fs.rmSync(HOME_DIR, { recursive: true, force: true }));

const { open } = await import('../src/store.mjs');
const { installMemjudgeRpc } = await import('../src/rpc.mjs');
const { stubConnection } = await import('./rpc-fetch-stub.mjs');

const ENDPOINTS = [
  'status',
  'memories',
  'conflicts',
  'saveKey',
  'clearKey',
  'saveConfig',
  'saveSettings',
  'testKey',
];

const srcDir = path.dirname(fileURLToPath(new URL('../src/rpc.mjs', import.meta.url)));

let seq = 0;
function tempDb() {
  return path.join(HOME_DIR, `db-${seq++}.sqlite`);
}

const ctxUsing = (connection) => ({ get: (name) => (name === 'connection' ? connection : undefined) });

test('注册恰好 8 条 exact Fetch 路由，path/methods/requestBody 符合连接层契约', () => {
  const stub = stubConnection();
  installMemjudgeRpc(ctxUsing(stub.connection), { dbPath: tempDb() });
  assert.equal(stub.routes.size, ENDPOINTS.length);
  assert.deepEqual([...stub.routes.keys()], ENDPOINTS.map((e) => `/api/memjudge.${e}`));
  for (const [routePath, route] of stub.routes) {
    assert.equal(route.path, routePath);
    assert.deepEqual(route.methods, ['POST']);
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
  }
});

test('status/memories/conflicts 三条路由经 Request 调用后返回 200 与 {ok:true,value}', async () => {
  const dbPath = tempDb();
  const store = open(dbPath);
  store.put({ text: 'hi' });
  store.close();
  const stub = stubConnection();
  installMemjudgeRpc(ctxUsing(stub.connection), { dbPath });

  for (const endpoint of ['status', 'memories', 'conflicts']) {
    const routePath = `/api/memjudge.${endpoint}`;
    const route = stub.routes.get(routePath);
    const response = await route.fetch(new Request(`http://dsh.internal${routePath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }));
    assert.ok(response instanceof Response, `${endpoint}: 必须返回 Response`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true, `${endpoint}: 返回包形状保持 {ok:true,value}`);
    assert.ok(body.value && typeof body.value === 'object');
  }
});

test('空请求体与非法 JSON 都退化成空对象，不把面板打成非 2xx', async () => {
  const stub = stubConnection();
  installMemjudgeRpc(ctxUsing(stub.connection), { dbPath: tempDb() });
  const route = stub.routes.get('/api/memjudge.saveConfig');
  const empty = await route.fetch(new Request('http://dsh.internal/api/memjudge.saveConfig', { method: 'POST' }));
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).ok, false);
  const broken = await route.fetch(new Request('http://dsh.internal/api/memjudge.saveConfig', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  }));
  assert.equal(broken.status, 200);
  assert.equal((await broken.json()).ok, false);
});

test('disposer 拆除全部路由，且拆除后同一 ctx 可再次注册', () => {
  const stub = stubConnection();
  const ctx = ctxUsing(stub.connection);
  const dispose = installMemjudgeRpc(ctx, { dbPath: tempDb() });
  assert.equal(stub.routes.size, ENDPOINTS.length);
  dispose();
  assert.equal(stub.routes.size, 0);
  // 幂等标记必须随 disposer 一起清掉，否则面板重载后再也注册不上。
  installMemjudgeRpc(ctx, { dbPath: tempDb() });
  assert.equal(stub.routes.size, ENDPOINTS.length);
});

test('同一 ctx 重复安装不会对同一 path 二次注册', () => {
  const stub = stubConnection();
  const ctx = ctxUsing(stub.connection);
  installMemjudgeRpc(ctx, { dbPath: tempDb() });
  // 第二次安装（模拟插件被重复 apply）不得抛 already registered。
  assert.doesNotThrow(() => installMemjudgeRpc(ctx, { dbPath: tempDb() }));
  assert.equal(stub.routes.size, ENDPOINTS.length);
});

test('宿主没有 fetch 注册能力时静默降级为空 disposer', () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const dispose = installMemjudgeRpc({ get: () => ({ rpc: { handle() { throw new Error('旧通道不该被调用'); } } }) }, {});
    assert.equal(typeof dispose, 'function');
    assert.doesNotThrow(() => dispose());
    assert.ok(lines.some((line) => line.includes('面板不可用')));
  } finally {
    console.log = original;
  }
});

test('client.js 用同源 fetch 调 /api/memjudge. 前缀，且不再出现旧通道调用', () => {
  const client = fs.readFileSync(path.join(srcDir, '..', 'client.js'), 'utf8');
  assert.equal(/rpc\s*\.\s*call\s*\(/.test(client), false, 'client.js 仍残留旧通道调用');
  assert.equal(/isLoopback/.test(client), false, 'client.js 仍残留 loopback 标记 hack');
  assert.equal(/rpc\s*\.\s*handle\s*\(/.test(client), false);
  assert.match(client, /RPC_PATH_PREFIX\s*=\s*'\/api\/memjudge\.'/);
  assert.match(client, /RPC_PATH_PREFIX\s*\+\s*endpoint/);
  assert.match(client, /method:\s*'POST'/);
  assert.match(client, /if\s*\(!response\.ok\)/);
});
