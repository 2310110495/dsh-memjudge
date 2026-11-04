import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {installRawHostAdapter,captureRawRead,validateCapturedSnapshot,exportRawReadState} from '../src/raw-host-adapter.mjs';
import {createRawIngestPolicy} from '../src/raw-ingest-policy.mjs';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {RawRepository} from '../src/raw-repository.mjs';
import {openNamespace} from '../src/raw-namespace.mjs';
import {fromUtf16le,encodeIdentity} from '../src/raw-codec.mjs';
const wait=()=>new Promise(r=>setTimeout(r,40));
const settle=async predicate=>{for(let i=0;i<150;i++){try{if(predicate())return;}catch{}await wait();}assert.fail('fixture progress timeout');};
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-adapter-')),moduleFile=path.join(root,'module');fs.writeFileSync(moduleFile,'fixture');
 const config={enabled:true,mode:'archive-only',directory:path.join(root,'raw'),registryRoot:path.join(root,'reg'),sourceRoot:path.join(root,'source'),instanceId:'i',principalId:'u',principals:['u'],projects:[{id:'p',cwd:root}],allowedProjectIds:['p'],intervalMs:10,pageSize:2,backend:{name:'session-persistence-jsonl',compression:'none',moduleFile,sha256:createHash('sha256').update('fixture').digest('hex')}};
 const header={id:'s',cwd:root},events=[{seq:0,uuid:'same',text:'\ufeff\r\ne\u0301\ud800'},{seq:1,uuid:'same',text:'b'},{seq:2,text:'c'}];let opened=0,closed=0,read=0;
 const backend={identity:Symbol(),name:'session-persistence-jsonl',root:config.sourceRoot,compression:'none',list:async()=>[{header,revision:'1',sizeBytes:10}],stat:async()=>({header,revision:'1'}),open:async()=>{opened++;return {header,inheritedEventCount:0,read:async(o,n)=>{read++;return {events:events.slice(o,o+n)};},close:async()=>{closed++;}};}};
 let cleanup;const ctx={sessionPersistence:backend,effect(fn){cleanup=fn();},inject(names,fn){assert.deepEqual(names,['sessions','sessionPersistence']);fn(this);return ()=>cleanup?.();}};
 const marks=()=>{const db=new DatabaseSync(path.join(config.directory,'raw.sqlite'),{readOnly:true});try{return {mark:db.prepare('SELECT * FROM raw_watermarks').get(),count:db.prepare('SELECT count(*) AS n FROM raw_versions').get().n};}finally{db.close();}};
 return {root,config,backend,ctx,header,events,marks,counts:()=>({opened,closed,read})};
}
test('read capture fixes each unknown observation without invoking getters',()=>{
 let calls=0;
 const first={seq:0,text:'first',missing:undefined};
 const second={seq:1,text:'second'};
 Object.defineProperty(second,'trap',{enumerable:true,get(){calls++;throw Error('getter');}});
 const third={seq:2,text:'ordinary'};
 const captured=captureRawRead([first,second,third]);
 first.text='changed-first';second.text='changed-second';third.text='changed-third';
 const text=item=>item.observation.records.filter(r=>r.kind==='string').map(r=>r.value);
 assert.ok(text(captured.items[0]).includes('first'));
 assert.ok(text(captured.items[1]).includes('second'));
 assert.equal(captured.items[2].snapshot.text,'ordinary');
 assert.equal(captured.items[0].observation.identity,false);
 assert.equal(captured.items[1].observation.completeGraph,false);
 assert.equal(calls,0);
});
test('read capture treats clone-lossy prototypes and aliases as observations',()=>{
 const nullObject=Object.assign(Object.create(null),{text:'null-tail'});
 const shared={text:'shared-tail'};
 const fixed={};Object.defineProperty(fixed,'text',{value:'fixed-tail',enumerable:true});
 const result=captureRawRead([{nested:nullObject},nullObject,{left:shared,right:shared},fixed,{nested:{text:'normal'}}]);
 for(const item of result.items.slice(0,4)) assert.ok(item.observation);
 assert.ok(result.items[0].observation.records.some(r=>r.value==='null-tail'));
 assert.equal(validateCapturedSnapshot(result.items[4]).nested.text,'normal');
});

test('snapshot JSON serialization is explicitly forbidden and validation rejects altered items',()=>{
 const result=captureRawRead([{text:'normal'}]);
 const item=result.items[0];
 assert.ok(Buffer.isBuffer(item.identity));
 assert.throws(()=>JSON.stringify(result),/raw-batch-not-json-serializable/);
 const impostor=JSON.parse(JSON.stringify({snapshot:item.snapshot,identity:item.identity}));
 assert.throws(()=>validateCapturedSnapshot(impostor),/raw-invalid-captured-snapshot/);
 item.snapshot.text='changed';
 assert.throws(()=>validateCapturedSnapshot(item),/raw-invalid-captured-snapshot/);
 let calls=0;const bad={get identity(){calls++;return Buffer.alloc(0);},snapshot:{}};
 assert.throws(()=>validateCapturedSnapshot(bad),/raw-invalid-captured-snapshot/);
 assert.equal(calls,0);
});

test('read capture handles holes and array accessors without invoking them',()=>{
 let calls=0;
 const events=new Array(3);
 Object.defineProperty(events,'0',{get(){calls++;throw Error('array getter');}});
 events[2]={seq:2,text:'kept'};
 const captured=captureRawRead(events);
 assert.equal(calls,0);
 assert.equal(captured.items.length,3);
 assert.ok(captured.items[0].observation.records.some(r=>r.reason==='accessor'));
 assert.ok(captured.items[1].observation.records.some(r=>r.reason==='array-hole'));
 assert.equal(captured.items[2].snapshot.text,'kept');
});

test('read capture avoids proxy traps recursively and inherited array properties',()=>{
 let traps=0;
 const victim={seq:2,text:'original'};
 const proxy=new Proxy({seq:0},{ownKeys(){traps++;victim.text='changed';return ['seq'];}});
 const nested=new Proxy({secret:'x'},{ownKeys(){traps++;victim.text='changed';return ['secret'];}});
 const events=[proxy,{seq:1,nested,text:'visible'},victim];
 const captured=captureRawRead(events);
 victim.text='later';
 assert.equal(traps,0);
 assert.ok(captured.items[0].observation.records.some(r=>r.reason==='proxy'));
 assert.ok(captured.items[1].observation.records.some(r=>r.reason==='proxy'));
 assert.ok(captured.items[1].observation.records.some(r=>r.value==='visible'));
 assert.equal(captured.items[2].snapshot.text,'original');
 const sparse=new Array(1);
 const proto=Object.create(Array.prototype);
 Object.defineProperty(proto,'0',{get(){traps++;throw Error('inherited');}});
 Object.setPrototypeOf(sparse,proto);
 assert.ok(captureRawRead(sparse).items[0].observation.records.some(r=>r.reason==='array-hole'));
 assert.equal(traps,0);
});

test('read capture rejects proxy containers and observes nested accessors',()=>{
 let calls=0;
 const container=new Proxy([],{get(){calls++;throw Error('container trap');}});
 assert.throws(()=>captureRawRead(container),/raw-invalid-read/);
 const revoked=Proxy.revocable({},{});revoked.revoke();
 const nested={text:'visible'};
 Object.defineProperty(nested,'hidden',{get(){calls++;throw Error('nested getter');}});
 const captured=captureRawRead([{seq:0,nested},revoked.proxy]);
 assert.equal(calls,0);
 assert.ok(captured.items[0].observation.records.some(r=>r.value==='visible'));
 assert.ok(captured.items[0].observation.records.some(r=>r.reason==='accessor'));
 assert.ok(captured.items[1].observation.records.some(r=>r.reason==='proxy'));
});

test('read capture limits ignore inherited properties and reject hostile own descriptors',()=>{
 let calls=0, result, observation;
 try {
  Object.defineProperty(Object.prototype,'batch',{configurable:true,get(){calls++;return 0;}});
  Object.defineProperty(Object.prototype,'nodes',{configurable:true,set(){calls++;}});
  result=captureRawRead([{get trap(){throw Error('getter');},text:'kept'}]);
  observation=result.items[0].observation;
 } finally { delete Object.prototype.batch; delete Object.prototype.nodes; }
 assert.equal(calls,0);
 assert.ok(observation.records.some(r=>r.value==='kept'));
 const hostile={get nodes(){calls++;return 1;}};
 assert.throws(()=>captureRawRead([],hostile),/raw-invalid-read-limit/);
 assert.throws(()=>captureRawRead([],new Proxy({},{getOwnPropertyDescriptor(){calls++;throw Error('trap');}})),/raw-invalid-read-limit/);
 assert.equal(calls,0);
});

test('read capture enforces batch limit before iteration',()=>{
 const events=new Array(3);
 assert.throws(()=>captureRawRead(events,{batch:2}),/raw-batch-limit/);
 assert.throws(()=>captureRawRead(new Array(4294967295)),/raw-batch-limit/);
 const limited=captureRawRead([{text:'x'.repeat(40)}],{codeUnits:10});
 assert.equal(limited.traversalComplete,false);
 assert.equal(limited.partialIndex,0);
 assert.deepEqual(limited.unprocessed,{start:1,end:1});
});

test('batch result exposes partial event and untouched range explicitly',()=>{
 const make=text=>({get trap(){throw Error('getter');},text});
 const result=captureRawRead([make('abc'),make('def'),make('ghi')],{codeUnits:14});
 assert.throws(()=>JSON.stringify(result),/raw-batch-not-json-serializable/);
 assert.equal(result.traversalComplete,false);
 assert.equal(result.evidenceComplete,false);
 assert.ok(result.partialIndex>=0);
 assert.equal(result.unprocessed.start,result.partialIndex+1);
 assert.equal(result.unprocessed.end,3);
 assert.ok(result.items[0].observation.records.some(r=>r.value==='abc'));
});

test('batch blocks inherited toJSON getters and functions and distinguishes traversal',()=>{
 const sparse=new Array(1); let calls=0, error, batch;
 try {
  Object.defineProperty(Object.prototype,'toJSON',{configurable:true,get(){calls++;return ()=>{calls++;return 'suppressed';};},set(){calls++;}});
  batch=captureRawRead(sparse);
  try { JSON.stringify(batch); } catch(e) { error=e; }
 } finally { delete Object.prototype.toJSON; }
 assert.equal(calls,0);
 assert.match(error.message,/raw-batch-not-json-serializable/);
 assert.equal(batch.traversalComplete,true);
 assert.equal(batch.evidenceComplete,false);
 assert.ok(batch.items[0].observation.records.some(r=>r.reason==='array-hole'));
});

test('state export avoids inherited hooks and rejects copied or hostile batches',()=>{
 const batch=captureRawRead([{get trap(){throw Error('getter');},text:'secret'}, {text:'later'}],{codeUnits:4});
 const copy={...batch};
 let calls=0, json, error;
 try {
  Object.defineProperty(Object.prototype,'toJSON',{configurable:true,get(){calls++;throw Error('inherited toJSON');}});
  Object.defineProperty(batch,'traversalComplete',{configurable:true,get(){calls++;throw Error('batch getter');}});
  json=exportRawReadState(batch);
  try { exportRawReadState(copy); } catch(e) { error=e; }
 } finally { delete Object.prototype.toJSON; }
 assert.equal(calls,0);
 assert.match(error.message,/raw-invalid-read-batch/);
 const state=JSON.parse(json);
 assert.equal(state.format,'raw-read-state-v1');
 assert.equal(state.traversalComplete,false);
 assert.equal(state.evidenceComplete,false);
 assert.equal(state.partialIndex,0);
 assert.deepEqual(state.unprocessed,{start:1,end:2});
 assert.equal(state.limited.reason,'observation-limit');
 assert.equal(json.includes('secret'),false);
 let traps=0;
 const proxy=new Proxy(batch,{get(){traps++;throw Error('proxy');}});
 assert.throws(()=>exportRawReadState(proxy),/raw-invalid-read-batch/);
 assert.throws(()=>exportRawReadState({get format(){traps++;throw Error('getter');}}),/raw-invalid-read-batch/);
 assert.equal(traps,0);
});

test('snapshot validation establishes consistency rather than provenance',()=>{
 const item=captureRawRead([{text:'before'}]).items[0];
 item.snapshot.text='after';
 item.identity=encodeIdentity(item.snapshot);
 assert.equal(validateCapturedSnapshot(item).text,'after');
});

test('shared observation budget retains partial evidence and marks remaining range',()=>{
 let calls=0;
 const make=text=>{const v={get trap(){calls++;},text};return v;};
 const result=captureRawRead([make('abc'),make('def'),make('ghi')],{codeUnits:14});
 assert.equal(calls,0);
 assert.equal(result.traversalComplete,false);
 assert.equal(result.items[0].observation.records.some(r=>r.value==='abc'),true);
 assert.equal(result.unprocessed.end,3);
 assert.ok(result.unprocessed.start>0);
 assert.ok(result.usage.codeUnits<=14);
});

test('read capture and identity avoid inherited array setters',()=>{
 const events=[{seq:0,text:'kept'}, {seq:1,text:'observed',bad:undefined}];
 const expected=encodeIdentity(events[0]);
 let calls=0,captured,actual,error;
 try {
  Object.defineProperty(Array.prototype,'0',{configurable:true,set(){calls++;}});
  captured=captureRawRead(events);
  actual=encodeIdentity(events[0]);
 } catch(e) { error=e; }
 finally { delete Array.prototype[0]; }
 assert.ifError(error);
 assert.equal(calls,0);
 assert.equal(captured.items.length,2);
 assert.equal(captured.items[0].snapshot.text,'kept');
 assert.ok(captured.items[1].observation.records.some(r=>r.value==='observed'));
 assert.deepEqual(actual,expected);
});

test('pending unknown snapshots are bounded and never claim preservation',()=>{
 const f=fixture(),lease=openNamespace({...f.config,writable:true}),repo=new RawRepository(path.join(f.config.directory,'raw.sqlite'),lease);
 const source={origin:'pending'},event={seq:0,text:'small',bad:undefined};
 try {
  repo.markHostUncertain({fullSessionId:'s',provenance:source,startSeq:0,endSeq:1});
  for(let i=0;i<3;i++)assert.deepEqual(repo.ingestHostEvent({fullSessionId:'s',event,source,untrustedIdentity:true}),{classification:'pending',reason:'untrusted-snapshot-retry',durability:'pending'});
  repo.clearHostUncertain({fullSessionId:'s',provenance:source,events:[{seq:0,text:'small'}]});
  const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});
  try{assert.equal(db.prepare('SELECT count(*) n FROM raw_host_pending').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM raw_unresolved').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM raw_host_uncertainty').get().n,1);assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next,0);}finally{db.close();}
 }finally{repo.close();lease.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('pending marker write failure rolls back without a receipt',()=>{
 const f=fixture(),lease=openNamespace({...f.config,writable:true}),repo=new RawRepository(path.join(f.config.directory,'raw.sqlite'),lease);
 const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'));
 try {
  db.exec("CREATE TABLE raw_host_pending(namespace TEXT NOT NULL,session_id TEXT NOT NULL,source BLOB NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(namespace,session_id,source)); CREATE TRIGGER fail_pending BEFORE INSERT ON raw_host_pending BEGIN SELECT RAISE(ABORT,'pending-write-fault'); END");
  assert.throws(()=>repo.ingestHostEvent({fullSessionId:'s',event:{seq:0,text:'x'},source:{id:'a'},untrustedIdentity:true}),/pending-write-fault/);
  assert.equal(db.prepare('SELECT count(*) n FROM raw_host_pending').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM raw_unresolved').get().n,0);
 }finally{db.close();repo.close();lease.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('untrusted complete graphs reuse evidence only within a source',()=>{
 const f=fixture(),lease=openNamespace({...f.config,writable:true}),repo=new RawRepository(path.join(f.config.directory,'raw.sqlite'),lease);
 const event={seq:0,text:'original',missing:undefined};event.self=event;
 try {
  const put=(event,source,evidence)=>repo.ingestHostEvent({fullSessionId:'s',event,source,untrustedIdentity:true,evidence});
  const first=put(event,{origin:'A'}),again=put(event,{origin:'A'});
  assert.equal(again.unresolvedId,first.unresolvedId);assert.equal(again.preservationOnly,true);
  assert.notEqual(put(event,{origin:'B'}).unresolvedId,first.unresolvedId);
  assert.notEqual(put({...event,text:'changed'},{origin:'A'}).unresolvedId,first.unresolvedId);
  assert.notEqual(put(event,{origin:'A'},{note:'extra'}).unresolvedId,first.unresolvedId);
  const proxy=new Proxy(event,{});assert.notEqual(put(proxy,{origin:'A'}).unresolvedId,put(proxy,{origin:'A'}).unresolvedId);
  const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});
  try {assert.equal(db.prepare('SELECT count(*) n FROM raw_unresolved').get().n,6);assert.equal(db.prepare('SELECT count(*) n FROM raw_versions').get().n,0);assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next,0);}finally{db.close();}
 }finally{repo.close();lease.close();}
});
test('large preservation graphs retain separate complete evidence and use exact indexed lookup',()=>{
 const f=fixture(),lease=openNamespace({...f.config,writable:true}),repo=new RawRepository(path.join(f.config.directory,'raw.sqlite'),lease);
 const put=event=>repo.ingestHostEvent({fullSessionId:'s',event,source:{origin:'A'},untrustedIdentity:true});
 try {
  const event={seq:0,text:'x'.repeat(150000),missing:undefined};
  const a=put(event),b=put(event);assert.notEqual(a.unresolvedId,b.unresolvedId);
  const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});
  try {
   assert.equal(db.prepare('SELECT count(*) n FROM raw_unresolved').get().n,2);
   assert.equal(db.prepare('SELECT count(*) n FROM raw_host_unresolved_graphs').get().n,0);
   const text=db.prepare('SELECT bytes FROM raw_capture_blocks').all().map(x=>fromUtf16le(x.bytes)).join('');
   assert.equal(text.split(event.text).length-1,2);
   const plan=db.prepare('EXPLAIN QUERY PLAN SELECT unresolved_id FROM raw_host_unresolved_graphs WHERE namespace=? AND session_id=? AND source=? AND graph=?').all('n','s',Buffer.from('a'),Buffer.from('b'));
   assert.ok(plan.some(row=>/USING.*INDEX/.test(row.detail)&&/graph=\?/.test(row.detail)));
  }finally{db.close();}
 }finally{repo.close();lease.close();}
});
test('legacy graph rows remain reusable after lookup index creation',()=>{
 const f=fixture(),lease=openNamespace({...f.config,writable:true}),repo=new RawRepository(path.join(f.config.directory,'raw.sqlite'),lease);
 const input={fullSessionId:'s',event:{seq:0,text:'legacy',missing:undefined},source:{origin:'A'},untrustedIdentity:true};
 try{
  const first=repo.ingestHostEvent(input),db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'));
  try{db.exec('DROP INDEX raw_host_unresolved_graph_lookup');}finally{db.close();}
  assert.equal(repo.ingestHostEvent(input).unresolvedId,first.unresolvedId);
 }finally{repo.close();lease.close();}
});
for(const first of ['json','graph','opaque'])for(const second of ['json','graph','opaque'])test(`dual-read identity matrix ${first}/${second}`,async()=>{
 const f=fixture(),open=f.backend.open;let calls=0;
 const make=kind=>{const e={seq:0,text:`${kind}-evidence`};if(kind==='graph')e.extra=undefined;if(kind==='opaque')Object.defineProperty(e,'extra',{enumerable:true,get(){calls++;throw Error('getter executed');}});return e;};
 f.backend.open=async()=>{const h=await open(),read=h.read;h.read=async(o,n)=>{const r=await read(o,n);if(o===0)r.events[0]=make(n===Number.MAX_SAFE_INTEGER?first:second);return r;};return h;};
 const stop=installRawHostAdapter(f.ctx,f.config);
 try{await settle(()=>{const d=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return first==='json'&&second==='json'?f.marks().count===3:d.prepare('SELECT count(*) n FROM raw_unresolved').get().n>0;}finally{d.close();}});}finally{stop();await wait();}
 const d=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{const m=d.prepare('SELECT * FROM raw_watermarks').get();assert.equal(calls,0);assert.equal(m.integrity_cap,null);assert.equal(d.prepare('SELECT count(*) n FROM raw_conflicts').get().n,0);if(first!=='json'||second!=='json'){assert.equal(m.raw_next,0);const texts=d.prepare('SELECT bytes FROM raw_capture_blocks').all().map(r=>fromUtf16le(r.bytes));assert.ok(texts.includes(`${first}-evidence`));assert.ok(texts.includes(`${second}-evidence`));}}finally{d.close();}
});
test('real Cordis service withdrawal discards pending old result then reinstalls',async()=>{
 const {Context}=await import(pathToFileURL(path.join(process.env.RAW_HOST,'@deepseek-ai/cordis/lib/index.js')).href);
 const f=fixture(),ctx=new Context();ctx.provide('sessions',{});let release;
 f.backend.open=()=>new Promise(r=>release=r);const remove=ctx.provide('sessionPersistence',f.backend);
 const stop=installRawHostAdapter(ctx,f.config);await wait();assert.equal(typeof release,'function');
 const removing=remove();release({header:f.header,inheritedEventCount:0,read:async()=>({events:f.events}),close:async()=>{}});await removing;await wait();
 assert.equal(f.marks().count,0);
 const next={...f.backend,identity:Symbol(),open:async()=>({header:f.header,inheritedEventCount:0,read:async(o,n)=>({events:f.events.slice(o,o+n)}),close:async()=>{}})};
 const removeNext=ctx.provide('sessionPersistence',next);await wait();await wait();assert.equal(f.marks().count,3);stop();await removeNext();await wait();
});
test('read exception closes handle and periodic recovery retries',async()=>{const f=fixture();let closes=0,fail=true;f.backend.open=async()=>({header:f.header,inheritedEventCount:0,read:async(o,n)=>{if(fail)throw Error('fixture-read-fault');return {events:f.events.slice(o,o+n)};},close:async()=>{closes++;}});const stop=installRawHostAdapter(f.ctx,f.config);await wait();assert.equal(f.marks().count,0);fail=false;await wait();stop();await wait();assert.ok(closes>1);assert.equal(f.marks().count,3);});
test('empty read closes without watermark',async()=>{const f=fixture();f.events.length=0;const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.marks().count,0);assert.equal(f.counts().opened,f.counts().closed);});
test('replacement waits for old read closure and discards old results',async()=>{const f=fixture();let callback,oldCleanup,newCleanup,release;
 f.ctx.inject=(names,fn)=>{callback=fn;fn(f.ctx);return ()=>{oldCleanup?.();newCleanup?.();};};f.ctx.effect=fn=>{oldCleanup=fn();};
 f.backend.open=()=>new Promise(r=>release=r);const stop=installRawHostAdapter(f.ctx,f.config);await wait();oldCleanup();
 const next={...f.backend,identity:Symbol(),open:async()=>({header:f.header,inheritedEventCount:0,read:async(o,n)=>({events:f.events.slice(o,o+n)}),close:async()=>{}})};
 f.ctx.sessionPersistence=next;const child={sessionPersistence:next,effect(fn){newCleanup=fn();}};callback(child);
 release({header:f.header,inheritedEventCount:0,read:async()=>({events:f.events}),close:async()=>{}});await wait();await wait();stop();await wait();assert.equal(f.marks().count,3);
});
test('disabled does not inject or create raw state',()=>{let calls=0;const stop=installRawHostAdapter({inject(){calls++;}},{enabled:false});stop();assert.equal(calls,0);});
test('unknown principal fails before inject',()=>{const f=fixture();f.config.principalId='other';assert.throws(()=>installRawHostAdapter(f.ctx,f.config),/principal/);assert.equal(f.counts().opened,0);assert.equal(fs.existsSync(f.config.directory),false);});
test('unknown project stops before content open',async()=>{const f=fixture();f.header.cwd=path.join(f.root,'unknown');const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.counts().opened,0);});
test('fixed H overlaps, supported rescan preserves versions, same process never verifies',async()=>{const f=fixture();const stop=installRawHostAdapter(f.ctx,f.config);await wait();const first=f.marks();await wait();stop();await wait();assert.equal(first.count,3);assert.equal(f.marks().count,3);assert.equal(first.mark.raw_next,3);assert.equal(first.mark.verified_next,0);assert.equal(f.counts().opened,f.counts().closed);assert.ok(f.counts().read>=3);});
test('pending list never opens content',async()=>{const f=fixture();f.backend.list=async()=>[{header:f.header}];const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.counts().opened,0);});
test('gap never crosses watermark and always closes',async()=>{const f=fixture();f.events[1].seq=9;const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.marks().count,0);assert.equal(f.counts().opened,f.counts().closed);});
test('revision change never publishes',async()=>{const f=fixture();f.backend.stat=async()=>({header:f.header,revision:'changed'});const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.marks().count,0);});
test('unload while open pending closes stale handle without publishing',async()=>{const f=fixture();let release;f.backend.open=()=>new Promise(r=>release=r);const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();let closed=false;release({header:f.header,inheritedEventCount:0,read:async()=>({events:f.events}),close:async()=>{closed=true;}});await wait();assert.equal(closed,true);assert.equal(f.marks().count,0);});
test('wrong source root stops before content read',()=>{const f=fixture();f.backend.root=path.join(f.root,'wrong');assert.throws(()=>installRawHostAdapter(f.ctx,f.config),/binding-mismatch/);assert.equal(f.counts().opened,0);});
test('request-shaped scope does not grant unknown project',async()=>{const f=fixture();f.header.cwd=path.join(f.root,'unknown');f.header.scope={principalId:'u',projectId:'p'};const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.counts().read,0);});
test('append is picked up on subsequent fixed-H scan',async()=>{const f=fixture();const stop=installRawHostAdapter(f.ctx,f.config);await wait();assert.equal(f.marks().count,3);f.events.push({seq:3,text:'later'});await wait();stop();await wait();assert.equal(f.marks().count,4);assert.equal(f.marks().mark.raw_next,4);});
test('changed overlap does not commit an unstable prefix',async()=>{const f=fixture();f.backend.open=async()=>({header:f.header,inheritedEventCount:0,read:async(o,n)=>({events:n===Number.MAX_SAFE_INTEGER?structuredClone(f.events):f.events.slice(o,o+n).map(e=>({...e,text:'changed'}))}),close:async()=>{}});const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.marks().count,0);});
test('expired startup creates nothing',()=>{const f=fixture();f.config.expiresAt=0;assert.throws(()=>createRawIngestPolicy(f.config),/expired/);assert.equal(fs.existsSync(f.config.directory),false);});
test('unmapped first entry isolates authorization before open',async()=>{const f=fixture();const list=f.backend.list;f.backend.list=async()=>[{header:{id:'bad',cwd:path.join(f.root,'outside')},sizeBytes:1,revision:'1'},...await list()];const open=f.backend.open;f.backend.open=async id=>{assert.equal(id,'s');return open(id);};const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.marks().count,3);});
test('read failure first session does not starve good session',async()=>{const f=fixture(),list=f.backend.list,open=f.backend.open;f.backend.list=async()=>[{header:{id:'bad',cwd:f.root},sizeBytes:1,revision:'1'},...await list()];f.backend.open=async id=>id==='bad'?{header:{id:'bad',cwd:f.root},inheritedEventCount:0,read:async()=>{throw Error('read-fault');},close:async()=>{}}:open(id);const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.marks().count,3);});
for(const pageSize of [2,128])test(`individually legal long events exceed aggregate byte budget page ${pageSize}`,async()=>{const f=fixture();f.config.pageSize=pageSize;f.events.splice(0,f.events.length,...Array.from({length:70},(_,seq)=>({seq,text:'x'.repeat(65536)})));const stop=installRawHostAdapter(f.ctx,f.config);await settle(()=>f.marks().count===70);stop();await wait();assert.equal(f.marks().mark.raw_next,70);const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM raw_host_event_proofs').get().n,70);db.close();});
test('global expiry while source read pending publishes nothing',async()=>{const f=fixture();f.config.expiresAt=Date.now()+120;const open=f.backend.open;f.backend.open=async()=>{const h=await open();const read=h.read;h.read=async(...args)=>{await new Promise(r=>setTimeout(r,150));return read(...args);};return h;};const stop=installRawHostAdapter(f.ctx,f.config);await new Promise(r=>setTimeout(r,230));stop();await wait();assert.equal(f.marks().count,0);});
test('incremental overlapping page fault preserves previous prefix then recovers',async()=>{const f=fixture();const stop=installRawHostAdapter(f.ctx,f.config);await wait();assert.equal(f.marks().count,3);const open=f.backend.open;f.backend.open=async()=>{const h=await open(),read=h.read;h.read=async(o,n)=>{if(o>0)throw Error('incremental-page-fault');return read(o,n);};return h;};f.events.push({seq:3,text:'new'});await wait();assert.equal(f.marks().count,3);f.backend.open=open;await wait();stop();await wait();assert.equal(f.marks().count,4);});
test('H1 unknown overlap preserves distinct read versions without proving equality',async()=>{
 const f=fixture();f.events[1]={seq:1,text:'FIRST',bad:undefined};const open=f.backend.open;
 f.backend.open=async()=>{const h=await open(),read=h.read;h.read=async(o,n)=>{const r=await read(o,n);if(n!==Number.MAX_SAFE_INTEGER)r.events=r.events.map(e=>e.seq===1?{...e,text:'SECOND'}:e);return r;};return h;};
 const stop=installRawHostAdapter(f.ctx,f.config);await settle(()=>{const d=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return d.prepare('SELECT count(*) n FROM raw_unresolved').get().n>=2;}finally{d.close();}});stop();await wait();
 const d=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});const texts=d.prepare('SELECT bytes FROM raw_capture_blocks').all().map(r=>fromUtf16le(r.bytes));assert.ok(texts.includes('FIRST'));assert.ok(texts.includes('SECOND'));assert.equal(f.marks().mark.integrity_cap,null);assert.ok(f.marks().mark.raw_next<=1);assert.equal(d.prepare('SELECT count(*) n FROM raw_conflicts').get().n,0);d.close();
});
test('H1 unsupported read does not bypass expired global authority',async()=>{
 const f=fixture();f.events[1]={seq:1,text:'keep',bad:undefined};const open=f.backend.open;f.backend.open=async()=>{const h=await open(),read=h.read;h.read=async(o,n)=>{const r=await read(o,n);if(n!==Number.MAX_SAFE_INTEGER)f.backend.compression='gzip';return r;};return h;};
 const stop=installRawHostAdapter(f.ctx,f.config);await wait();stop();await wait();assert.equal(f.marks().count,0);
});
for(const kind of ['depth','undefined','cycle','bytes','nodes'])test(`H1 preserves ${kind} without trusting identity and static duplication`,async()=>{
 const f=fixture();let value='TAIL\ud800X\udfff\ufeff\r\n';
 if(kind==='depth')for(let i=0;i<270;i++)value={child:value};
 if(kind==='undefined')value={tail:value,missing:undefined};
 if(kind==='cycle'){value={tail:value};value.self=value;}
 if(kind==='bytes')value='x'.repeat(4200000)+value;
 if(kind==='nodes')value={wide:Array(50001).fill(null),tail:value};
 f.events[1]={seq:1,value};const stop=installRawHostAdapter(f.ctx,f.config);
 try{await settle(()=>{const d=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return f.marks().count===2&&d.prepare('SELECT count(*) n FROM raw_unresolved').get().n===1;}finally{d.close();}});}finally{stop();await wait();}
 assert.ok(f.marks().mark.raw_next<=1);assert.equal(f.marks().mark.integrity_cap,null);assert.equal(f.marks().mark.verified_next,0);
 const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});
 assert.ok(db.prepare('SELECT bytes FROM raw_capture_blocks').all().some(r=>fromUtf16le(r.bytes).includes('TAIL\ud800X\udfff')));
 const count=db.prepare('SELECT count(*) n FROM raw_captures').get().n;db.close();
 const stop2=installRawHostAdapter(f.ctx,f.config);await wait();stop2();await wait();
 const cold=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});assert.equal(cold.prepare('SELECT count(*) n FROM raw_captures').get().n,count);cold.close();
});
for(const kind of ['undefined','cycle'])test(`H1 direct ${kind} matches core preservation and reuses only evidence`,()=>{
 const f=fixture(),lease=openNamespace({...f.config,writable:true}),repo=new RawRepository(path.join(f.config.directory,'raw.sqlite'),lease);
 const event={seq:0,text:'KEEP\ud800X\udfff',bad:undefined};if(kind==='cycle')event.bad=event;
 try{const core=repo.ingest({fullSessionId:'core',event,source:{fixture:true}});const host=repo.ingestHostEvent({fullSessionId:'host',event,source:{fixture:true}});
 assert.equal(host.classification,core.classification);assert.equal(host.rawCommittedNextSeq,0);
 const again=repo.ingestHostEvent({fullSessionId:'host',event,source:{fixture:true}});assert.equal(again.reused,true);assert.notEqual(again.classification,'committed');
 }finally{repo.close();lease.close();}
});
for(const throwing of [false,true])test(`H2 host preserves seq accessor ${throwing?'throwing':'returning'} without executing it`,async()=>{
 const f=fixture();let calls=0;const event={text:'host-getter-tail'};Object.defineProperty(event,'seq',{enumerable:true,get(){calls++;if(throwing)throw Error('getter-executed');return 0;}});f.events.splice(0,f.events.length,event);
 const stop=installRawHostAdapter(f.ctx,f.config);try{await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM raw_unresolved').get().n>0;}finally{db.close();}});}finally{stop();await wait();}
 assert.equal(calls,0);const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{assert.ok(db.prepare('SELECT bytes FROM raw_capture_blocks').all().some(r=>fromUtf16le(r.bytes)==='host-getter-tail'));assert.equal(db.prepare('SELECT verified_next FROM raw_watermarks').get().verified_next,0);}finally{db.close();}
});
test('H3 adapter preserves nonstandard array acquisitions before cloning',async()=>{
 const f=fixture(),value=['array-tail'];Object.setPrototypeOf(value,{opaque:true});
 f.events.splice(0,f.events.length,{seq:0,value});
 const stop=installRawHostAdapter(f.ctx,f.config);
 try{await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM raw_captures').get().n>=2;}finally{db.close();}});}finally{stop();await wait();}
 const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});
 try{assert.ok(db.prepare('SELECT bytes FROM raw_capture_blocks').all().some(r=>fromUtf16le(r.bytes)==='array-tail'));assert.equal(db.prepare('SELECT count(*) n FROM raw_host_event_proofs').get().n,0);const mark=db.prepare('SELECT raw_next,verified_next FROM raw_watermarks').get();assert.equal(mark.raw_next,0);assert.equal(mark.verified_next,0);}finally{db.close();}
});
test('array identity never invokes proxy length getter',()=>{
 let calls=0;const value=new Proxy(['tail'],{get(target,key,receiver){if(key==='length')calls++;return Reflect.get(target,key,receiver);}});
 assert.deepEqual(encodeIdentity(value),encodeIdentity(['tail']));assert.equal(calls,0);
});
test('direct prefix rejects accessor seq without invoking getter',()=>{
 const f=fixture(),lease=openNamespace({...f.config,writable:true}),repo=new RawRepository(path.join(f.config.directory,'raw.sqlite'),lease);let calls=0;
 const event={};Object.defineProperty(event,'seq',{get(){calls++;return 0;}});
 try{assert.throws(()=>repo.recordHostPrefix({fullSessionId:'s',events:[event],provenance:{}}),/raw-noncontiguous-host-prefix/);assert.equal(calls,0);}finally{repo.close();lease.close();}
});
test('reflection fault preserves readable event text through direct and host paths',async()=>{
 const f=fixture();const event=new Proxy({seq:0,text:'reflection-tail',bad:'hidden'},{getOwnPropertyDescriptor(target,key){if(key==='bad')throw Error('reflection-fault');return Reflect.getOwnPropertyDescriptor(target,key);}});
 const lease=openNamespace({...f.config,writable:true}),repo=new RawRepository(path.join(f.config.directory,'raw.sqlite'),lease);
 try{const result=repo.ingestHostEvent({fullSessionId:'direct',event,source:{fixture:true}});assert.equal(result.classification,'unsupported-identity');assert.equal(result.rawCommittedNextSeq,0);}finally{repo.close();lease.close();}
 f.events.splice(0,f.events.length,event);const stop=installRawHostAdapter(f.ctx,f.config);
 try{await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM raw_unresolved WHERE session_id=?').get(JSON.stringify('s')).n>0;}finally{db.close();}});}finally{stop();await wait();}
 const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{assert.ok(db.prepare('SELECT bytes FROM raw_capture_blocks').all().some(r=>fromUtf16le(r.bytes)==='reflection-tail'));assert.equal(db.prepare('SELECT max(raw_next) n FROM raw_watermarks').get().n,0);assert.equal(db.prepare('SELECT max(verified_next) n FROM raw_watermarks').get().n,0);}finally{db.close();}
});
test('transparent proxy clone failure preserves text without trusting identity',async()=>{
 const f=fixture(),event=new Proxy({seq:0,text:'transparent-proxy-tail'},{});
 assert.doesNotThrow(()=>encodeIdentity(event));assert.throws(()=>structuredClone(event),{name:'DataCloneError'});
 f.events.splice(0,f.events.length,event);const stop=installRawHostAdapter(f.ctx,f.config);
 try{await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM raw_captures').get().n>0;}finally{db.close();}});}finally{stop();await wait();}
 const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});
 try{assert.ok(db.prepare('SELECT bytes FROM raw_capture_blocks').all().some(r=>fromUtf16le(r.bytes)==='transparent-proxy-tail'));const mark=db.prepare('SELECT raw_next,verified_next,integrity_cap FROM raw_watermarks').get();assert.equal(mark.raw_next,0);assert.equal(mark.verified_next,0);assert.equal(mark.integrity_cap,null);assert.equal(db.prepare('SELECT count(*) n FROM raw_events').get().n,0);const proofs=db.prepare("SELECT name FROM sqlite_master WHERE name='raw_host_event_proofs'").get();if(proofs)assert.equal(db.prepare('SELECT count(*) n FROM raw_host_event_proofs').get().n,0);}finally{db.close();}
});
test('clone failure preserves trusted prefix and allows later recovery',async()=>{
 const f=fixture();f.events.length=2;
 const stop=installRawHostAdapter(f.ctx,f.config);
 try {
  await settle(()=>f.marks().mark.raw_next===2);
  f.events.push(new Proxy({seq:2,text:'proxy-recovery-tail'},{}),{seq:3,text:'ordinary-tail'});
  await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT bytes FROM raw_capture_blocks').all().some(r=>fromUtf16le(r.bytes)==='proxy-recovery-tail');}finally{db.close();}});
  let db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});
  try{const m=db.prepare('SELECT * FROM raw_watermarks').get();assert.equal(m.raw_next,2);assert.equal(m.integrity_cap,null);assert.equal(db.prepare("SELECT count(*) n FROM raw_events WHERE seq<2 AND state!='committed'").get().n,0);}finally{db.close();}
  f.events[2]={seq:2,text:'proxy-recovery-tail'};
  await settle(()=>f.marks().mark.raw_next===4);
  db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM raw_events WHERE state='conflict'").get().n,0);}finally{db.close();}
 }finally{stop();await wait();}
});
test('unknown replacement temporarily bounds an established prefix and recovers',async()=>{
 const f=fixture();f.events.length=2;const original=f.events[0];const stop=installRawHostAdapter(f.ctx,f.config);
 try{
  await settle(()=>f.marks().mark.raw_next===2);
  f.events[0]=new Proxy({...original,text:'unknown-change'},{});
  await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM raw_unresolved').get().n>0;}finally{db.close();}});
  const mark=f.marks().mark;assert.equal(mark.raw_next,0);assert.equal(mark.verified_next,0);assert.equal(mark.integrity_cap,null);
  f.events[0]=original;await settle(()=>f.marks().mark.raw_next===2);
 }finally{stop();await wait();}
});
for(const kind of ['reordered','gap','getter','reflection','field-reflection'])test(`unknown ${kind} bounds existing prefix before publication`,async()=>{
 const f=fixture();f.events.length=2;const original=[...f.events];let calls=0;const stop=installRawHostAdapter(f.ctx,f.config);
 try{
  await settle(()=>f.marks().mark.raw_next===2);
  if(kind==='reordered')f.events.splice(0,2,original[1],new Proxy({...original[0],text:'changed-zero'},{}));
  if(kind==='gap')f.events.splice(0,2,{seq:3,text:'gap'},new Proxy({...original[0],text:'changed-zero'},{}));
  if(kind==='getter'){const e={text:'getter-tail'};Object.defineProperty(e,'seq',{enumerable:true,get(){calls++;throw Error('getter');}});f.events.splice(0,2,e,original[1]);}
  if(kind==='reflection'){const e=new Proxy({seq:0,text:'reflection-tail'},{getOwnPropertyDescriptor(t,k){if(k==='seq')throw Error('reflection');return Reflect.getOwnPropertyDescriptor(t,k);}});f.events.splice(0,2,e,original[1]);}
   if(kind==='field-reflection'){const e=new Proxy({seq:0,text:'field-reflection-tail',bad:'x'},{getOwnPropertyDescriptor(t,k){if(k==='bad')throw new TypeError('unsupported-identity');return Reflect.getOwnPropertyDescriptor(t,k);}});f.events.splice(0,2,e,original[1]);}
  await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM raw_unresolved').get().n>0;}finally{db.close();}});
  const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{const mark=db.prepare('SELECT * FROM raw_watermarks').get();assert.equal(mark.raw_next,0);assert.equal(mark.verified_next,0);assert.equal(db.prepare('SELECT min(start_seq) n FROM raw_host_uncertainty').get().n,0);assert.equal(calls,0);if(kind==='getter'||kind==='reflection'||kind==='field-reflection'){assert.equal(mark.integrity_cap,null);assert.equal(db.prepare("SELECT count(*) n FROM raw_events WHERE state='conflict'").get().n,0);}}finally{db.close();}
   if(kind==='getter'||kind==='reflection'||kind==='field-reflection'){f.events.splice(0,2,...original);await settle(()=>f.marks().mark.raw_next===2);}
 }finally{stop();await wait();}
});
for(const kind of ['getter','prototype'])test(`new ${kind} on second read stays unresolved and recovers`,async()=>{
 const f=fixture();f.events.length=2;let bad=false,calls=0;const open=f.backend.open;
 f.backend.open=async()=>{const h=await open(),read=h.read;h.read=async(o,n)=>{const r=await read(o,n);if(bad&&n!==Number.MAX_SAFE_INTEGER&&o===0){const e={seq:0,text:'second-read-unknown'};if(kind==='getter')Object.defineProperty(e,'bad',{enumerable:true,get(){calls++;throw Error('getter');}});else Object.setPrototypeOf(e,{opaque:true});r.events[0]=e;}return r;};return h;};
 const stop=installRawHostAdapter(f.ctx,f.config);
 try{
  await settle(()=>f.marks().mark.raw_next===2);bad=true;
  await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM raw_unresolved').get().n>0||db.prepare('SELECT integrity_cap FROM raw_watermarks').get().integrity_cap!==null;}finally{db.close();}});
  let db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{const m=db.prepare('SELECT * FROM raw_watermarks').get();assert.equal(m.raw_next,0);assert.equal(m.integrity_cap,null);assert.equal(db.prepare('SELECT count(*) n FROM raw_unresolved').get().n>0,true);assert.equal(db.prepare('SELECT count(*) n FROM raw_conflicts').get().n,0);assert.ok(db.prepare('SELECT bytes FROM raw_capture_blocks').all().some(r=>fromUtf16le(r.bytes)==='second-read-unknown'));assert.equal(calls,0);}finally{db.close();}
  bad=false;await settle(()=>f.marks().mark.raw_next===2);
 }finally{stop();await wait();}
});
for(const kind of ['getter','prototype'])test(`both ${kind} reads stay unresolved and recover`,async()=>{
 const f=fixture();f.events.length=2;let bad=false,calls=0;const open=f.backend.open;
 f.backend.open=async()=>{const h=await open(),read=h.read;h.read=async(o,n)=>{const r=await read(o,n);if(bad&&o===0){const e={seq:0,text:n===Number.MAX_SAFE_INTEGER?'first-opaque':'second-opaque'};if(kind==='getter')Object.defineProperty(e,'bad',{enumerable:true,get(){calls++;throw Error('getter');}});else Object.setPrototypeOf(e,{opaque:true});r.events[0]=e;}return r;};return h;};
 const stop=installRawHostAdapter(f.ctx,f.config);
 try{
  await settle(()=>f.marks().mark.raw_next===2);bad=true;
  await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM raw_unresolved').get().n>0||db.prepare('SELECT integrity_cap FROM raw_watermarks').get().integrity_cap!==null;}finally{db.close();}});
  const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{const m=db.prepare('SELECT * FROM raw_watermarks').get();assert.equal(m.raw_next,0);assert.equal(m.integrity_cap,null);assert.equal(db.prepare('SELECT count(*) n FROM raw_conflicts').get().n,0);const texts=db.prepare('SELECT bytes FROM raw_capture_blocks').all().map(r=>fromUtf16le(r.bytes));assert.ok(texts.includes('first-opaque'));assert.ok(texts.includes('second-opaque'));assert.equal(calls,0);}finally{db.close();}
  bad=false;await settle(()=>f.marks().mark.raw_next===2);
 }finally{stop();await wait();}
});
test('polluted accessor sequence cannot prove host ordering',async()=>{
 const f=fixture();f.events.length=2;let calls=0;const stop=installRawHostAdapter(f.ctx,f.config);
 try{
  await settle(()=>f.marks().mark.raw_next===2);
  const bad={text:'host-tail',get seq(){calls++;return 1;}};
  f.events[1]=bad;Object.prototype.value=1;
  try{
   await settle(()=>{const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM raw_host_uncertainty').get().n>0;}finally{db.close();}});
   const db=new DatabaseSync(path.join(f.config.directory,'raw.sqlite'),{readOnly:true});
   try{assert.equal(db.prepare('SELECT min(start_seq) n FROM raw_host_uncertainty').get().n,0);assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next,0);assert.equal(calls,0);}finally{db.close();}
  }finally{delete Object.prototype.value;}
 }finally{stop();await wait();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('periodic scan discovers newly listed session',async()=>{const f=fixture();let visible=false;f.backend.list=async()=>visible?[{header:f.header,revision:'1',sizeBytes:10}]:[];const stop=installRawHostAdapter(f.ctx,f.config);await wait();assert.equal(f.counts().opened,0);visible=true;await wait();stop();await wait();assert.equal(f.marks().mark.raw_next,3);});
