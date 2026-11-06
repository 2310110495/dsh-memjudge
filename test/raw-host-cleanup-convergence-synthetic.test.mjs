import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installRawHostAdapter } from '../src/raw-host-adapter.mjs';
import { RawRepository } from '../src/raw-repository.mjs';
import { openNamespace } from '../src/raw-namespace.mjs';

function fixture(options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-cleanup-convergence-'));options.onRoot?.(root);
  const moduleFile=path.join(root,'module');fs.writeFileSync(moduleFile,'synthetic');
  const config={enabled:true,mode:'archive-only',directory:path.join(root,'raw'),registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'source'),instanceId:'i',principalId:'u',principals:['u'],projects:[{id:'p',cwd:root}],allowedProjectIds:['p'],intervalMs:10000,backend:{name:'session-persistence-jsonl',compression:'none',moduleFile,sha256:createHash('sha256').update('synthetic').digest('hex')}};
  let inject,reads=0;
  const backend={identity:Symbol(),name:'session-persistence-jsonl',root:config.sourceRoot,compression:'none',async list(){reads++;return options.list?.()??[];},...options.backend};
  const ctx={inject(names,fn){inject=fn;if(options.inject)return options.inject(fn,backend);return options.dispose??(()=>{});}};
  const stop=installRawHostAdapter(ctx,config);
  return {root,config,backend,stop,reads:()=>reads,create(effect){let cleanup;inject({sessionPersistence:backend,effect:effect??(fn=>{cleanup=fn();})});return cleanup;}};
}

const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('repeated worker rebuilds finish before the final stop',async()=>{
  const f=fixture();
  try {
    for(let i=0;i<150;i++){
      const cleanup=f.create();await turn();await cleanup();
    }
    assert.equal(f.reads(),150);
    await f.stop();
  } finally {await f.stop().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});

test('historical close failure blocks successors and remains observable',async()=>{
  const f=fixture(),original=RawRepository.prototype.close,failure=Error('synthetic close failure');
  try {
    const first=f.create();await turn();assert.equal(f.reads(),1);
    RawRepository.prototype.close=function(){original.call(this);throw failure;};
    await assert.rejects(first(),error=>error.errors.includes(failure));
    RawRepository.prototype.close=original;
    for(let i=0;i<30;i++){
      const cleanup=f.create();await turn();
      await assert.rejects(cleanup(),error=>error.errors.includes(failure));
    }
    assert.equal(f.reads(),1);
    await assert.rejects(f.stop(),error=>error.errors.some(e=>e.errors?.includes(failure)));
  } finally {RawRepository.prototype.close=original;await f.stop().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});

test('close failure before resource closure retains cross-instance lock',async()=>{
  const f=fixture(),original=RawRepository.prototype.close,failure=Error('close before release');
  let repository;
  try {
    const cleanup=f.create();await turn();
    RawRepository.prototype.close=function(){repository=this;throw failure;};
    await assert.rejects(cleanup(),error=>error.errors.includes(failure));
    assert.throws(()=>openNamespace({...f.config,writable:true}),error=>error.code==='EEXIST');
    await assert.rejects(f.stop());
  } finally {
    RawRepository.prototype.close=original;
    if(repository)original.call(repository);
    await f.stop().catch(()=>{});
    fs.rmSync(f.root,{recursive:true,force:true});
  }
});

test('injection callback then synchronous throw cleans up spawned worker',async()=>{
  const failure=Error('synthetic inject failure');let cleanup,root;
  try {
    assert.throws(()=>fixture({onRoot(value){root=value;},inject(fn,backend){fn({sessionPersistence:backend,effect(register){cleanup=register();}});throw failure;}}),error=>error===failure);
    assert.ok(cleanup);await cleanup();
  } finally {if(root)fs.rmSync(root,{recursive:true,force:true});}
});

test('repeated handle close failure is retained and blocks scheduling',async()=>{
  const f=fixture(),failure=Error('synthetic handle close failure');let closes=0;
  const header={id:'s',cwd:f.root};
  f.backend.list=async()=>[{header,revision:'1',sizeBytes:1}];
  f.backend.stat=async()=>({header,revision:'1'});
  f.backend.open=async()=>({header,inheritedEventCount:0,read:async()=>({events:[{seq:0,text:'a'}]}),close:async()=>{closes++;throw failure;}});
  try {
    const cleanup=f.create();for(let i=0;i<12&&closes<2;i++)await turn();
    assert.equal(closes,2);
    await assert.rejects(cleanup(),error=>error.errors.includes(failure));
    assert.throws(()=>openNamespace({...f.config,writable:true}),error=>error.code==='EEXIST');
    await assert.rejects(f.stop(),error=>error.errors.some(e=>e.errors?.includes(failure)));
    await turn();assert.equal(closes,2);
  } finally {await f.stop().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});

test('asynchronous injection disposer waiting for stop forms a dependency cycle',async()=>{
  let stop,release;const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture({dispose:async()=>{await Promise.race([stop(),gate]);}});stop=f.stop;
  try {
    let settled=false;const stopping=stop().then(()=>{settled=true;});
    await turn();await turn();assert.equal(settled,false);
    release();await stopping;assert.equal(settled,true);
  } finally {release();await stop().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});

test('effect registration failure cleans up and allows the next worker',async()=>{
  const f=fixture(),failure=Error('synthetic effect failure');
  try {
    assert.throws(()=>f.create(()=>{throw failure;}),error=>error===failure);
    const next=f.create();await turn();assert.equal(f.reads(),1);
    await next();await f.stop();
  } finally {await f.stop().catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});
