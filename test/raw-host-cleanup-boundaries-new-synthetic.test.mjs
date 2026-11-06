import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installRawHostAdapter } from '../src/raw-host-adapter.mjs';
import { openNamespace } from '../src/raw-namespace.mjs';

function setup() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-new-boundary-'));
  const moduleFile=path.join(root,'fixture-module');fs.writeFileSync(moduleFile,'synthetic only');
  const config={enabled:true,mode:'archive-only',directory:path.join(root,'archive'),registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'source'),instanceId:'i',principalId:'u',principals:['u'],projects:[{id:'p',cwd:root}],allowedProjectIds:['p'],intervalMs:10000,backend:{name:'session-persistence-jsonl',compression:'none',moduleFile,sha256:createHash('sha256').update('synthetic only').digest('hex')}};
  return {root,config,backend:{identity:Symbol(),name:'session-persistence-jsonl',root:config.sourceRoot,compression:'none'}};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const contains=(error,value)=>error===value || (error instanceof AggregateError && error.errors.some(item=>contains(item,value)));

test('two failed handle closes retain both thrown values and ownership',async()=>{
  const f=setup(),header={id:'synthetic-session',cwd:f.root};let cleanup,calls=0;
  const first=undefined,second={get message(){throw 'message getter';}};
  Object.assign(f.backend,{async list(){return [{header,sizeBytes:1,revision:'r'}];},async open(){return {header,inheritedEventCount:0,async read(){return {events:[{seq:0}]};},async close(){if(++calls===1)throw first;throw second;}};},async stat(){return {header,revision:'r'};}});
  const stop=installRawHostAdapter({inject(_names,callback){callback({sessionPersistence:f.backend,effect(register){cleanup=register();}});return ()=>{};}},f.config);
  try {
    await turn();assert.equal(calls,2);
    await assert.rejects(cleanup(),error=>contains(error,first)&&contains(error,second));
    await assert.rejects(stop(),error=>contains(error,first)&&contains(error,second));
    assert.throws(()=>openNamespace({...f.config,writable:true}),error=>error.code==='EEXIST');
  } finally {await stop().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});

test('inject callback then synchronous non-Error throw starts worker cleanup',async()=>{
  const f=setup(),failure=undefined;let cleanup;
  f.backend.list=async()=>[];
  try {
    let caught=false;
    try{installRawHostAdapter({inject(_names,callback){callback({sessionPersistence:f.backend,effect(register){cleanup=register();}});throw failure;}},f.config);}catch(error){caught=true;assert.equal(error,failure);}
    assert.equal(caught,true);assert.equal(typeof cleanup,'function');
    await cleanup();
    const lease=openNamespace({...f.config,writable:true});lease.close();
  } finally {if(cleanup)await cleanup().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});
