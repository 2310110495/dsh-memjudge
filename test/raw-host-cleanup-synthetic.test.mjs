import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installRawHostAdapter } from '../src/raw-host-adapter.mjs';
import { RawRepository } from '../src/raw-repository.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(injectionFactory=()=>()=>{}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-cleanup-synthetic-'));
  const moduleFile=path.join(root,'module');fs.writeFileSync(moduleFile,'synthetic');
  const config={enabled:true,mode:'archive-only',directory:path.join(root,'raw'),registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'source'),instanceId:'i',principalId:'u',principals:['u'],projects:[{id:'p',cwd:root}],allowedProjectIds:['p'],intervalMs:10000,backend:{name:'session-persistence-jsonl',compression:'none',moduleFile,sha256:createHash('sha256').update('synthetic').digest('hex')}};
  const entered=deferred(), gate=deferred();let cleanup,signal;
  const backend={identity:Symbol(),name:'session-persistence-jsonl',root:config.sourceRoot,compression:'none',list({signal:s}){signal=s;entered.resolve();return gate.promise;}};
  const ctx={inject(names,fn){const child={sessionPersistence:backend,effect(fn){cleanup=fn();}};fn(child);return injectionFactory(()=>cleanup);}};
  const stop=installRawHostAdapter(ctx,config);
  return {root,entered:entered.promise,gate,stop,worker:()=>cleanup,signal:()=>signal};
}

test('in-flight worker and stop retain shared promise and wait for read',async()=>{
  const f=fixture();
  try {
    await f.entered;
    const worker=f.worker(),first=worker();
    assert.equal(worker(),first);
    assert.equal(f.signal().aborted,true);
    const stopping=f.stop();
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
    const first=f.worker()();
    first.catch(()=>{});
    const stopping=f.stop();
    assert.equal(f.stop(),stopping);
    let settled=false;stopping.catch(()=>{settled=true;});
    await Promise.resolve();assert.equal(settled,false);
    f.gate.resolve([]);
    await assert.rejects(stopping,error=>error instanceof AggregateError && error.errors.includes(injectionError) && error.errors.some(e=>e instanceof AggregateError&&e.errors.includes(workerError)));
    await assert.rejects(first,error=>error.errors.includes(workerError));
    assert.equal(f.worker()(),first);
  } finally {f.gate.resolve([]);await f.stop().catch(()=>{});RawRepository.prototype.close=original;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('synchronous stop reentry returns the shared promise without deadlock',async()=>{
  let f,reentered;
  f=fixture(()=>()=>{reentered=f.stop();return reentered;});
  try {
    await f.entered;
    const stopping=f.stop();assert.equal(reentered,stopping);
    f.gate.resolve([]);await stopping;
  } finally {f.gate.resolve([]);await f.stop();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('async injection rejection is observed and dispose starts synchronously',async()=>{
  const failure=Error('async injection'),injectionGate=deferred();let calls=0;
  const f=fixture(()=>({dispose(){calls++;return injectionGate.promise;}}));
  try {
    await f.entered;
    const stopping=f.stop();assert.equal(calls,1);assert.equal(f.signal().aborted,true);
    f.gate.resolve([]);injectionGate.reject(failure);
    await assert.rejects(stopping,error=>error instanceof AggregateError&&error.errors.includes(failure));
    assert.equal(f.stop(),stopping);assert.equal(calls,1);
  } finally {f.gate.resolve([]);await f.stop().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});
