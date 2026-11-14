import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const src = process.env.MODELS_SOURCE || fileURLToPath(new URL('../src', import.meta.url));
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-models-disabled-'));
process.env.DSH_HOME = testHome;
process.env.MEMJUDGE_NO_SECRETS = '1';
process.on('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));
const c = await import(pathToFileURL(path.join(src, 'config.mjs')));
const { chat, ChatHttpError } = await import(pathToFileURL(path.join(src, 'llm-client.mjs')));
const { extractBatch, createCache, llmStats } = await import(pathToFileURL(path.join(src, 'llm-extract.mjs')));
const entries = ['alpha 1', 'beta 2', 'gamma 3'].map(text => ({ text }));
const reply = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ results: [{index:1,triples:[{entity:'alpha',attr:'count',value:'1',vtype:'number',sent:'alpha 1'}]},{index:2,triples:[]}] }) } }] }) });
const disable = () => c.saveConfig({ chatMode: 'disabled' });
const setup = () => {
  c.saveConfig({chatMode:'independent',chatBaseUrl:'https://fixture.invalid/v1',chatModel:'fake-model'});
  c._setKeyOverride('FAKE_DISABLED_KEY');
  Object.assign(llmStats,{enabled:false,calls:0,retries:0,cacheHits:0,triples:0,dropped:0,ms:0,lastError:null});
};
const originalFetch = globalThis.fetch;
for (const boundary of ['fetch','json']) test(`disable during first ${boundary}: preserve partial results, no second batch`, async () => {
  setup(); let calls=0; const cache=createCache();
  globalThis.fetch=async()=>{ calls++; const r=reply(); if(boundary==='fetch'){await Promise.resolve();disable();} else {const json=r.json;r.json=async()=>{await Promise.resolve();disable();return json();};} return r; };
  try {
    const result=await extractBatch(entries,{cache});
    assert.equal(calls,1); assert.equal(llmStats.calls,1); assert.equal(llmStats.retries,0);
    assert.equal(result[0][0].value,'1'); assert.deepEqual(result[1],[]); assert.equal(result[2],null);
    assert.equal(cache.get('alpha 1')[0].value,'1'); assert.equal(llmStats.lastError,null);
  } finally {globalThis.fetch=originalFetch;}
});
for (const kind of ['network','http','abort','parse']) test(`disable during ${kind} failure: no retry and preserve error`, async()=>{
  setup();let calls=0;
  globalThis.fetch=async()=>{calls++;await Promise.resolve();
    if(kind==='http')return {ok:false,status:503,text:async()=>{await Promise.resolve();disable();return 'fixture';}};
    disable();if(kind==='parse')return {ok:true,json:async()=>({choices:[{message:{content:'bad'}}]})};
    throw kind==='abort'?new DOMException('fixture abort','AbortError'):new Error('fixture network');
  };
  try { assert.equal(await extractBatch(entries),null);assert.equal(calls,1);assert.equal(llmStats.calls,1);assert.equal(llmStats.retries,0);assert.equal(llmStats.lastError,({http:'http 503',parse:'unparsable payload',abort:'fixture abort',network:'fixture network'})[kind]); }
  finally {globalThis.fetch=originalFetch;}
});
test('disabled explicit key: zero fetch; independent restored: request allowed',async()=>{
  setup();disable();let calls=0;const fetchImpl=async()=>{calls++;return reply();};
  await assert.rejects(chat({}, {apiKey:'EXPLICIT_FAKE_KEY',fetchImpl}),{code:'DISABLED'});assert.equal(calls,0);
  c.saveConfig({chatMode:'independent'});await chat({}, {apiKey:'EXPLICIT_FAKE_KEY',fetchImpl});assert.equal(calls,1);
});
test('disable during request serialization: final fetch boundary is guarded',async()=>{
  setup();let calls=0;
  await assert.rejects(chat({toJSON(){disable();return {}; }},{apiKey:'FAKE',fetchImpl:async()=>{calls++;return reply();}}),{code:'DISABLED'});assert.equal(calls,0);
});
test('disabled entry keeps existing null fallback without scheduling',async()=>{
  setup();disable();globalThis.fetch=()=>{throw Error('unexpected fetch');};
  try {assert.equal(await extractBatch(entries),null);assert.equal(llmStats.calls,0);assert.equal(llmStats.retries,0);}finally{globalThis.fetch=originalFetch;}
});
test('enabled failures retain one retry and null fallback',async()=>{
  setup();let calls=0;globalThis.fetch=async()=>{calls++;throw Error('normal failure');};
  try{assert.equal(await extractBatch(entries.slice(0,2)),null);assert.equal(calls,2);assert.equal(llmStats.calls,2);assert.equal(llmStats.retries,1);assert.equal(llmStats.lastError,'normal failure');}finally{globalThis.fetch=originalFetch;}
});
test('chat preserves network, JSON, HTTP and abort errors for in-flight requests',async()=>{
  for(const kind of ['network','json','http','abort']){
    setup();const error=kind==='abort'?new DOMException('original abort','AbortError'):new Error('original '+kind);
    const ctrl=new AbortController();
    const fetchImpl=async(_url,{signal})=>{await Promise.resolve();disable();
      if(kind==='http')return {ok:false,status:429,text:async()=>'fixture body'};
      if(kind==='json')return {ok:true,json:async()=>{throw error;}};
      if(kind==='abort'){ctrl.abort(error);assert.equal(signal.aborted,true);}throw error;
    };
    // Cancel inside fetch: a pre-aborted request must never invoke this provider.
    await assert.rejects(chat({}, {fetchImpl,signal:ctrl.signal}),e=>kind==='http'?(e instanceof ChatHttpError&&e.status===429&&e.body==='fixture body'):e===error);
  }
});
test('pre-aborted request preserves reason and never calls fetch',async()=>{
  setup();const ctrl=new AbortController();const reason=new DOMException('caller cancelled','AbortError');ctrl.abort(reason);let calls=0;
  await assert.rejects(chat({}, {signal:ctrl.signal,fetchImpl:async()=>{calls++;return reply();}}),e=>e===reason);assert.equal(calls,0);
});
test('disable after cached result collection preserves cached partial results',async()=>{
  setup();let calls=0;const cache={get(text){if(text==='alpha 1'){disable();return [];}},set(){},flush(){}};
  globalThis.fetch=async()=>{calls++;return reply();};
  try{assert.deepEqual(await extractBatch(entries,{cache}),[[],null,null]);assert.equal(calls,0);assert.equal(llmStats.calls,0);assert.equal(llmStats.retries,0);}finally{globalThis.fetch=originalFetch;}
});
