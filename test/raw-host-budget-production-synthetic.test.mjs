import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installRawHostAdapter } from '../src/raw-host-adapter.mjs';
import { openNamespace } from '../src/raw-namespace.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createResourceScope } from '../src/resource-lifecycle.mjs';
import { createDisposal } from '../src/disposal.mjs';

const root=process.env.T3_FIXTURE_ROOT;
if(!root||!path.isAbsolute(root)||!root.includes('.t3-fixtures')) throw Error('T3_FIXTURE_ROOT must be a dedicated .t3-fixtures root');
if(fs.existsSync(root)&&fs.readdirSync(root).length) throw Error('T3_FIXTURE_ROOT must be empty');
fs.mkdirSync(root,{recursive:true});
const fixture=()=>{
  const id=path.join(root,`case-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(id,{recursive:false});
  const moduleFile=path.join(id,'module');fs.writeFileSync(moduleFile,'synthetic-backend');
  const config={enabled:true,mode:'archive-only',directory:path.join(id,'archive'),registryRoot:path.join(id,'registry'),sourceRoot:path.join(id,'source'),instanceId:'fixture',principalId:'fixture',principals:['fixture'],projects:[{id:'project',cwd:id}],allowedProjectIds:['project'],intervalMs:60000,pageSize:2,backend:{name:'session-persistence-jsonl',compression:'none',moduleFile,sha256:createHash('sha256').update('synthetic-backend').digest('hex'),contract:'bounded-jsonl-v1',implementationContract:'bounded-jsonl-v1'},budget:{maxSessionBytes:8192,maxEventBytes:1024,maxEvents:8,maxPageBytes:2048,maxGraphNodes:512,maxGraphProperties:256,maxCodeUnits:1024,maxHeaderBytes:4096}};
  const header={id:'synthetic-session',cwd:id};
  const backend={identity:Symbol('backend'),name:'session-persistence-jsonl',root:config.sourceRoot,compression:'none',rawReadContract:'bounded-jsonl-v1',maxRawReadBytes:2048,maxRawEventBytes:1024,maxRawReadEvents:2,events:Array.from({length:5},(_,seq)=>({seq,text:`event-${seq}`})),revision:'rev-1',openCalls:0,readCalls:[],closeCalls:0,statCalls:0,failClose:0,changeAt:null,async list(){return [{header,revision:this.revision,sizeBytes:512,decodedBytes:500,maxEventBytes:100,eventCount:5}];},async open(_id,mode,options){assert.equal(mode,'read');this.openCalls++;assert.equal(options.expectedRevision,this.revision);assert.equal(options.limits.maxSessionBytes,8192);return {header,revision:this.revision,inheritedEventCount:5,async read(start,count,opts){backend.readCalls.push([start,count,opts.maxBytes]);if(backend.changeAt===start)backend.revision='rev-2';return {events:backend.events.slice(start,start+count),revision:backend.revision,decodedBytes:count*100};},async close(){backend.closeCalls++;if(backend.failClose-->0)throw Error('synthetic-close-failure');}};},async stat(){this.statCalls++;return {header,revision:this.revision};}};
  let cleanup,closed=false;
  const stop=installRawHostAdapter({inject(_names,callback){callback({sessionPersistence:backend,effect(register){cleanup=register();}});return ()=>{closed=true;};}},config);
  const rawFile=path.join(config.directory,'raw.sqlite');
  const readState=()=>{const db=new DatabaseSync(rawFile,{readOnly:true});try{const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));const state={};for(const table of ['raw_events','raw_versions','raw_watermarks','raw_host_event_proofs','raw_host_observations'])state[table]=tables.has(table)?db.prepare(`SELECT count(*) n FROM ${table}`).get().n:0;return state;}finally{db.close();}};
  return {id,config,header,backend,stop,cleanup:()=>cleanup,readState,rawFile,get injectionClosed(){return closed;}};
};
const settle=()=>new Promise(resolve=>setTimeout(resolve,250));
const remove=async f=>{await f.stop().catch(()=>{});await new Promise(resolve=>setImmediate(resolve));fs.rmSync(f.id,{recursive:true,force:true});};

test('production adapter gates open and reads only bounded pages before publishing',async()=>{
 const f=fixture();try{await settle();assert.equal(f.backend.openCalls,1);assert.deepEqual(f.backend.readCalls.map(x=>x.slice(0,2)),[[0,2],[2,2],[4,1]]);assert.equal(f.backend.statCalls,1);assert.equal(f.backend.closeCalls,1);const state=f.readState();assert.equal(state.raw_events,5);assert.equal(state.raw_versions,5);assert.ok(state.raw_host_event_proofs>0);}finally{await remove(f);}
});

test('unknown, accessor, and inconsistent metadata fail closed before open',async()=>{
 for(const mode of ['oversize','getter','proxy']){const f=fixture();if(mode==='oversize')f.backend.list=async()=>[{header:f.header,revision:'r',sizeBytes:9000,decodedBytes:500,maxEventBytes:100,eventCount:5}];if(mode==='getter')f.backend.list=async()=>{const row={header:f.header,revision:'r',sizeBytes:512,decodedBytes:500,maxEventBytes:100,eventCount:5};Object.defineProperty(row,'sizeBytes',{get(){throw Error('metadata-getter-ran');}});return [row];};if(mode==='proxy')f.backend.list=async()=>[new Proxy({header:f.header,revision:'r',sizeBytes:512,decodedBytes:500,maxEventBytes:100,eventCount:5},{get(){throw Error('metadata-proxy-ran');}})];try{await settle();assert.equal(f.backend.openCalls,0);assert.equal(f.backend.statCalls,0);}finally{await remove(f);}}
});

test('revision, sequence, and oversized-event failures publish no event evidence',async()=>{
 const cases=[f=>{f.backend.changeAt=2;},f=>{f.backend.events[0]={seq:1,text:'wrong-sequence'};},f=>{f.backend.events[0]={seq:0,text:'x'.repeat(2048)};}];for(const mutate of cases){const f=fixture();mutate(f);try{await settle();assert.equal(f.backend.openCalls,1);assert.equal(f.backend.closeCalls,1);const state=f.readState();assert.equal(state.raw_events,0);assert.equal(state.raw_versions,0);assert.equal(state.raw_host_event_proofs??0,0);assert.equal(state.raw_host_observations??0,0);}finally{await remove(f);}}
});

test('failed handle close retains worker ownership until retry, then stop releases all resources',async()=>{
 const f=fixture();f.backend.failClose=1;try{await settle();assert.ok(f.backend.closeCalls>=2);await f.stop();assert.equal(f.injectionClosed,true);assert.equal(fs.existsSync(path.join(f.config.registryRoot,'fixture.lock')),false);const calls=f.backend.closeCalls;await new Promise(resolve=>setTimeout(resolve,80));assert.equal(f.backend.closeCalls,calls);}finally{await remove(f);}
});

test('resource scope retries rejected cleanup and detects reentry and wait cycles',async()=>{
 let count=0;const scope=createResourceScope();scope.defer(async()=>{if(count++===0)throw Error('retry-once');});await assert.rejects(scope.close(),AggregateError);await scope.close();assert.equal(count,2);
 let reentrant,reentrantScope;reentrantScope=createResourceScope();reentrantScope.defer(async()=>{try{await reentrantScope.close();}catch(error){reentrant=error.code;}});await reentrantScope.close();assert.equal(reentrant,'ERR_RESOURCE_SCOPE_REENTRANT_CLOSE');
 const a=createResourceScope(),b=createResourceScope();let releaseA;const gate=new Promise(resolve=>{releaseA=resolve;});a.defer(async()=>{await gate;await b.close();});b.defer(async()=>{await a.close();});const closingA=a.close();await new Promise(resolve=>setImmediate(resolve));releaseA();await assert.rejects(closingA,AggregateError);
});

test('disposal preserves close dependency after child failure and retries',async()=>{
 let child=0,clears=0,closes=0;const d=createDisposal({clear(){clears++;},close(){closes++;}});d.track(async()=>{if(child++===0)throw Error('child-failure');});await assert.rejects(d.dispose(),AggregateError);assert.equal(clears,0);assert.equal(closes,0);await d.dispose();assert.equal(clears,1);assert.equal(closes,1);
});

test('lease close preserves ownership when another lock replaces its path',async()=>{
 const f=fixture();fs.mkdirSync(f.config.registryRoot,{recursive:true});let lease;
 try{lease=openNamespace({...f.config,writable:true});const lock=path.join(f.config.registryRoot,lease.namespace+'.lock');fs.unlinkSync(lock);fs.writeFileSync(lock,'foreign-lock');assert.throws(()=>lease.close(),/namespace-lease-lost/);assert.equal(fs.readFileSync(lock,'utf8'),'foreign-lock');}
 finally{if(lease){try{lease.close();}catch{}}await f.stop().catch(()=>{});await new Promise(resolve=>setImmediate(resolve));fs.rmSync(f.id,{recursive:true,force:true});}
});
