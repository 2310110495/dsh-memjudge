import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
const src = process.env.MODELS_SOURCE;
if (!src || !process.env.DSH_HOME || !process.env.MEMJUDGE_NO_SECRETS) throw Error('use isolated models/run.mjs');
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-models-contract-'));
process.env.DSH_HOME = testHome;
process.on('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));
const c = await import(pathToFileURL(path.join(src,'config.mjs')));
const { installMemjudgeRpc } = await import(pathToFileURL(path.join(src,'rpc.mjs')));
let call;
installMemjudgeRpc({ connection: { rpc: { handle(_channel, handler) { call = handler; } } } });
const groups = ['chat','embed','rerank'];
const keys = Object.fromEntries(groups.map(g => [g, `NO_SECRETS_${g}_FAKE_KEY`]));
const servers = [];
const seen = [];
let response;
let status = 200;
const valid = g => g === 'chat' ? { choices: [{ message: { content: 'pong' } }] } : g === 'embed' ? { data: [{ embedding: [1,2,3] }] } : { results: [{ index: 0, relevance_score: 0.5 }] };
const write = (file, value) => { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(value)); c.reloadConfig(); };
const reset = () => { for(const g of groups) for(const suffix of ['KEY','BASE_URL','MODEL']) delete process.env[`MEMJUDGE_${g.toUpperCase()}_${suffix}`]; delete process.env.MEMJUDGE_LLM_KEY; write(c.CONFIG_PATH,{}); write(c.SECRETS_PATH,{}); c._clearKeyOverrides(); };
await test('three model contract', async t => {
  try {
    const urls = {};
    for (const g of groups) {
      const server = http.createServer(async (req,res) => {
        let raw = ''; for await (const b of req) raw += b;
        seen.push({ group:g, url:req.url, key:req.headers.authorization, body:JSON.parse(raw) });
        res.writeHead(status,{'content-type':'application/json'});
        res.end(response === undefined ? JSON.stringify(valid(g)) : response);
      });
      await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); servers.push(server);
      urls[g] = `http://127.0.0.1:${server.address().port}/v1`;
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      assert.ok(Object.values(urls).some(base => String(url).startsWith(base + '/')), 'only fixture endpoints');
      return realFetch(url, { ...options, redirect: 'error' });
    };
    const setup = async () => {
      reset(); process.env.MEMJUDGE_NO_SECRETS = '1';
      const settings = {dims:3}; for(const g of groups) { settings[`${g}BaseUrl`] = urls[g]; settings[`${g}Model`] = `${g}-model`; settings[`${g}Mode`] = 'independent'; }
      assert.equal((await call('saveSettings',{settings})).ok,true);
      for(const g of groups) c._setKeyOverride(keys[g],g);
    };
    await t.test('new install independent', () => { reset(); assert.equal(c.groupReport('embed').mode,'independent'); assert.equal(c.embedBaseUrl(),''); });
    await t.test('three endpoints keys models matched', async () => {
      await setup(); seen.length = 0;
      for(const g of groups) assert.equal((await call('testKey',{group:g})).value.ok,true);
      assert.equal(seen.length,3);
      for(const r of seen) { assert.equal(r.key,`Bearer ${keys[r.group]}`); assert.equal(r.body.model,`${r.group}-model`); assert.equal(r.url,`/v1/${{chat:'chat/completions',embed:'embeddings',rerank:'rerank'}[r.group]}`); }
    });
    await t.test('save omit clear reload and restart', async () => {
      await setup(); delete process.env.MEMJUDGE_NO_SECRETS;
      for(const g of groups) await call('saveKey',{group:g,key:keys[g]});
      assert.equal((await call('saveKey',{group:'chat'})).ok,true);
      c.reloadConfig(); assert.equal(c.chatKey(),keys.chat);
      const child = spawnSync(process.execPath,['--input-type=module','-e',`const c=await import(${JSON.stringify(pathToFileURL(path.join(src,'config.mjs')).href)}); console.log(c.chatKey()===${JSON.stringify(keys.chat)} && c.embedKey()===${JSON.stringify(keys.embed)});`],{env:process.env,encoding:'utf8'});
      assert.equal(child.status,0); assert.equal(child.stdout.trim(),'true');
      await call('saveKey',{group:'embed',key:''}); c.reloadConfig(); assert.equal(c.embedKey(),'');
      assert.equal((await call('saveSettings',{settings:{embedBaseUrl:'',embedModel:''}})).ok,true); c.reloadConfig(); assert.equal(c.embedBaseUrl(),''); assert.equal(c.embedModel(),'');
      process.env.MEMJUDGE_NO_SECRETS='1';
    });
    await t.test('first save does not turn other fresh groups into legacy', async () => {
      reset(); await call('saveSettings',{settings:{chatBaseUrl:urls.chat}});
      assert.equal(c.groupReport('embed').mode,'independent'); assert.equal(c.embedBaseUrl(),'');
    });
    await t.test('clear inherited key becomes independent', async () => {
      await setup(); c._clearKeyOverrides(); process.env.MEMJUDGE_CHAT_KEY=keys.chat;
      await call('saveSettings',{settings:{embedMode:'inherit'}});
      await call('clearKey',{group:'embed'}); assert.equal(c.groupReport('embed').mode,'independent'); assert.equal(c.embedKey(),'');
    });
    await t.test('legacy env-only configuration remains visible', () => {
      reset(); process.env.MEMJUDGE_LLM_KEY=keys.chat;
      assert.equal(c.groupReport('embed').mode,'legacy'); assert.equal(c.embedKey(),keys.chat);
    });
    await t.test('partial legacy chat save retains omitted key and endpoint', async () => {
      reset(); delete process.env.MEMJUDGE_NO_SECRETS;
      write(c.CONFIG_PATH,{baseUrl:urls.chat}); write(c.SECRETS_PATH,{llmKey:keys.chat});
      await call('saveSettings',{settings:{chatModel:'new-model'}});
      assert.equal(c.chatBaseUrl(),urls.chat); assert.equal(c.chatKey(),keys.chat); assert.equal(c.groupReport('chat').mode,'independent');
      process.env.MEMJUDGE_NO_SECRETS='1';
    });
    await t.test('explicit empty probe key does not fall back', async () => { await setup(); const n=seen.length; assert.equal((await call('testKey',{group:'chat',key:''})).error.code,'missing-key'); assert.equal(seen.length,n); });
    await t.test('explicit inheritance and disable before env', async () => {
      await setup(); c._clearKeyOverrides(); process.env.MEMJUDGE_CHAT_KEY=keys.chat;
      await call('saveSettings',{settings:{embedMode:'inherit'}});
      assert.equal(c.embedKey(),keys.chat); assert.equal(c.embedBaseUrl(),urls.chat); assert.equal(c.embedModel(),'embed-model'); assert.equal(c.groupReport('embed').inheritedEnv.key,'MEMJUDGE_CHAT_KEY');
      process.env.MEMJUDGE_EMBED_KEY=keys.embed;
      await call('saveSettings',{settings:{embedMode:'disabled'}});
      const n=seen.length; assert.equal(c.embedKey(),''); assert.equal((await call('testKey',{group:'embed',key:keys.embed})).error.code,'disabled'); assert.equal(seen.length,n); assert.equal(process.env.MEMJUDGE_EMBED_KEY,keys.embed);
    });
    await t.test('env source lock and persisted local value', async () => {
      await setup(); process.env.MEMJUDGE_EMBED_BASE_URL=urls.chat; process.env.MEMJUDGE_EMBED_MODEL='env-model'; process.env.MEMJUDGE_EMBED_KEY=keys.embed; c._clearKeyOverrides();
      const r=c.groupReport('embed'); assert.equal(r.baseUrlSource,'env'); assert.equal(r.baseUrlEnvLocked,true); assert.equal(r.modelEnvLocked,true); assert.equal(r.keyEnvLocked,true);
      assert.equal(JSON.stringify(r).includes(keys.embed),false);
      delete process.env.MEMJUDGE_EMBED_BASE_URL; assert.equal(c.embedBaseUrl(),urls.embed);
    });
    await t.test('legacy visible then explicit clear never revives', async () => {
      reset(); delete process.env.MEMJUDGE_NO_SECRETS;
      write(c.CONFIG_PATH,{baseUrl:urls.chat}); write(c.SECRETS_PATH,{llmKey:keys.chat});
      assert.equal(c.groupReport('embed').mode,'legacy'); assert.equal(c.groupReport('embed').keySource,'legacy-inherit');
      await call('clearKey',{group:'chat'}); c.reloadConfig(); assert.equal(c.chatKey(),''); assert.equal(c.groupReport('chat').mode,'independent');
      await call('saveSettings',{settings:{chatBaseUrl:''}}); assert.equal(c.chatBaseUrl(),'');
      process.env.MEMJUDGE_NO_SECRETS='1';
    });
    for(const g of groups) await t.test(`${g} malformed success responses fail`, async () => {
      await setup(); status=200;
      const bad=['','<html>ok</html>','{','[]','{}'];
      if(g==='chat') bad.push(JSON.stringify({choices:[{message:{content:''}}]}));
      if(g==='embed') bad.push(JSON.stringify({data:[]}),JSON.stringify({data:[{embedding:[1]}]}),'{"data":[{"embedding":[1,2,1e999]}]}');
      if(g==='rerank') bad.push(JSON.stringify({results:[{index:1,relevance_score:1}]}),JSON.stringify({results:[{index:0,relevance_score:1},{index:0,relevance_score:1}]}),'{"results":[{"index":0,"relevance_score":1e999}]}');
      for(const value of bad) { response=value; const result=await call('testKey',{group:g}); assert.equal(result.ok,true); assert.equal(result.value.ok,false,`${g}: ${value}`); assert.equal(result.value.code,'invalid-response'); }
      response=undefined;
    });
    await t.test('invalid settings are atomic and secrets stay outside config', async () => {
      await setup(); const before=fs.readFileSync(c.CONFIG_PATH,'utf8');
      for(const settings of [{chatMode:'inherit'},{embedMode:'legacy'},{chatBaseUrl:'https://user:pass@example.test'},{chatModel:'next',dims:0}]) assert.equal((await call('saveSettings',{settings})).ok,false);
      assert.equal(fs.readFileSync(c.CONFIG_PATH,'utf8'),before);
      await call('saveKey',{group:'chat',key:keys.chat}); assert.equal(fs.readFileSync(c.CONFIG_PATH,'utf8').includes(keys.chat),false);
    });
    await t.test('in-flight embedding uses captured dimensions and timeout is classified', async () => {
      await setup(); const original=globalThis.fetch;
      try {
        globalThis.fetch=async()=>{ c.saveConfig({dims:4}); return {ok:true,status:200,text:async()=>JSON.stringify(valid('embed'))}; };
        assert.equal((await call('testKey',{group:'embed'})).value.ok,true);
        globalThis.fetch=async()=>{ const e=Error(keys.chat); e.name='AbortError'; throw e; };
        assert.equal((await call('testKey',{group:'chat'})).value.code,'timeout');
      } finally { globalThis.fetch=original; }
    });
    await t.test('provider error and thrown network error are redacted', async () => {
      await setup(); status=401; response=keys.chat; let r=await call('testKey',{group:'chat'}); assert.equal(JSON.stringify(r).includes(keys.chat),false); assert.equal(r.value.code,'http-error');
      status=200; response=undefined; const original=globalThis.fetch;
      try { globalThis.fetch=async()=>{throw Error(keys.chat);}; r=await call('testKey',{group:'chat'}); assert.equal(r.value.code,'network-error'); assert.equal(JSON.stringify(r).includes(keys.chat),false); } finally { globalThis.fetch=original; }
    });
  } finally { for(const s of servers) await new Promise(resolve=>s.close(resolve)); }
});
