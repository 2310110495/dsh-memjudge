import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installRawHostAdapter } from '../src/raw-host-adapter.mjs';
import { RawRepository } from '../src/raw-repository.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const budget={maxSessionBytes:8*1024*1024,maxEventBytes:256*1024,maxEvents:10000,maxPageBytes:1024*1024,maxGraphNodes:65536,maxGraphProperties:32768,maxCodeUnits:2*1024*1024,maxHeaderBytes:16*1024};
function fixture(injectionFactory=()=>()=>{}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-cleanup-synthetic-'));
  const moduleFile=path.join(root,'module');fs.writeFileSync(moduleFile,'synthetic');
  const config={enabled:true,mode:'archive-only',directory:path.join(root,'raw'),registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'source'),instanceId:'i',principalId:'u',principals:['u'],projects:[{id:'p',cwd:root}],allowedProjectIds:['p'],intervalMs:10000,backend:{name:'session-persistence-jsonl',compression:'none',moduleFile,sha256:createHash('sha256').update('synthetic').digest('hex'),contract:'bounded-jsonl-v1',implementationContract:'bounded-jsonl-v1'},budget};
  const entered=deferred(), gate=deferred();let cleanup,signal;
  const backend={identity:Symbol(),name:'session-persistence-jsonl',root:config.sourceRoot,compression:'none',rawReadContract:'bounded-jsonl-v1',maxRawReadBytes:budget.maxPageBytes,maxRawEventBytes:budget.maxEventBytes,maxRawReadEvents:Math.floor(budget.maxPageBytes/budget.maxEventBytes),list({signal:s}){signal=s;entered.resolve();return gate.promise;}};
  const ctx={inject(names,fn){const child={sessionPersistence:backend,effect(register){cleanup=register();}};fn(child);return injectionFactory(()=>cleanup);}};
  const stop=installRawHostAdapter(ctx,config);
  return {root,entered:entered.promise,gate,stop,worker:()=>cleanup,signal:()=>signal};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('in-flight worker and stop retain shared promise and wait for read',async()=>{
  const f=fixture();
  try {
    await f.entered;
    const worker=f.worker(),first=worker();
    assert.equal(worker(),first);
    const stopping=f.stop();
    await settle();
    assert.equal(f.signal().aborted,true);
    assert.equal(f.stop(),stopping);
    let settled=false;stopping.finally(()=>{settled=true;});
    await Promise.resolve();assert.equal(settled,false);
    f.gate.resolve([]);
    await stopping;await first;
    assert.equal(worker(),first);
  } finally {f.gate.resolve([]);await f.stop();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('injection synchronous throw and worker rejection are retained after all settle',async()=>{
  const injectionError=Error('injection failure'),workerError=Error('worker close failure');
  const original=RawRepository.prototype.close;
  RawRepository.prototype.close=function(){original.call(this);throw workerError;};
  const f=fixture(()=>()=>{throw injectionError;});
  try {
    await f.entered;
    const first=f.worker()();first.catch(()=>{});
    const stopping=f.stop();assert.equal(f.stop(),stopping);
    let settled=false;stopping.catch(()=>{settled=true;});
    await Promise.resolve();assert.equal(settled,false);
    f.gate.resolve([]);
    const hasCause=(root,target)=>{const pending=[root],seen=new Set();while(pending.length){const item=pending.pop();if(item===target)return true;if(item instanceof AggregateError&&!seen.has(item)){seen.add(item);pending.push(...item.errors);}}return false;};
    await assert.rejects(stopping,error=>hasCause(error,injectionError)&&hasCause(error,workerError));
    await assert.rejects(first,error=>hasCause(error,workerError));
    const retry=f.worker()();assert.notStrictEqual(retry,first);
    await assert.rejects(retry,AggregateError);
  } finally {f.gate.resolve([]);await f.stop().catch(()=>{});RawRepository.prototype.close=original;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('injection reentry closes once and repeated stop shares the promise',async()=>{
  let reentered;
  let calls=0;
  const f=fixture(()=>()=>{calls++;reentered=f.stop();});
  try {
    await f.entered;
    const stopping=f.stop();
    assert.equal(f.stop(),stopping);
    f.gate.resolve([]);
    await settle();
    assert.equal(calls,1);
    assert.equal(reentered,undefined);
    await assert.rejects(stopping,error=>error instanceof AggregateError&&error.errors.some(e=>e instanceof AggregateError&&e.errors.some(inner=>inner.code==='ERR_RESOURCE_SCOPE_REENTRANT_CLOSE')));
  } finally {f.gate.resolve([]);await f.stop().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});

test('async injection rejection is observed after worker cleanup',async()=>{
  const failure=Error('async injection'),injectionGate=deferred();let calls=0;
  const f=fixture(()=>({dispose(){calls++;return injectionGate.promise;}}));
  try {
    const stopping=f.stop();await Promise.resolve();
    assert.equal(calls,0);
    f.gate.resolve([]);
    await settle();
    assert.equal(calls,1);
    injectionGate.reject(failure);
    await assert.rejects(stopping,error=>{const pending=[error],seen=new Set();while(pending.length){const item=pending.pop();if(item===failure)return true;if(item instanceof AggregateError&&!seen.has(item)){seen.add(item);pending.push(...item.errors);}}return false;});
    assert.notStrictEqual(f.stop(),stopping);assert.equal(calls,1);
  } finally {f.gate.resolve([]);await f.stop().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});
