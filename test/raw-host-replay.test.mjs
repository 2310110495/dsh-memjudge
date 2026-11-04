import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openNamespace} from '../src/raw-namespace.mjs';
import {RawRepository} from '../src/raw-repository.mjs';
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-replay-'));const directory=path.join(root,'raw');const lease=openNamespace({directory,registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'source'),instanceId:'i',writable:true});const file=path.join(directory,'raw.sqlite');const repo=new RawRepository(file,lease);return {repo,file,close(){repo.close();lease.close();}};}
test('uncertain sources resolve independently and failed release rolls back',()=>{
 const f=fixture(),events=[{seq:0,text:'a'},{seq:1,text:'b'}],a={binding:'a'},b={binding:'b'};
 try {
  for(const source of [a,b])for(const event of events)f.repo.ingestHostEvent({fullSessionId:'s',event,source});
  for(const [provenance,startSeq] of [[a,0],[b,1]])f.repo.markHostUncertain({fullSessionId:'s',provenance,startSeq,endSeq:2});
  const db=new DatabaseSync(f.file,{readOnly:true});
  try {
   f.repo.clearHostUncertain({fullSessionId:'s',provenance:a,events});
   assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next,1);
   const prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('UPDATE raw_watermarks SET raw_next='))throw Error('release-fault');return prepare.call(this,sql);};
   try{assert.throws(()=>f.repo.clearHostUncertain({fullSessionId:'s',provenance:b,events}),/release-fault/);}finally{DatabaseSync.prototype.prepare=prepare;}
   assert.equal(db.prepare('SELECT count(*) n FROM raw_host_uncertainty').get().n,1);assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next,1);
   f.repo.clearHostUncertain({fullSessionId:'s',provenance:b,events});assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next,2);
  }finally{db.close();}
 }finally{f.close();}
});
test('unresolved graph insertion failure rolls back evidence and permits retry',()=>{
 const f=fixture(),prepare=DatabaseSync.prototype.prepare,input={fullSessionId:'s',event:{seq:0,text:'keep',missing:undefined},source:{origin:'A'},untrustedIdentity:true};
 DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('INSERT INTO raw_host_unresolved_graphs'))throw Error('unresolved-graph-write-fault');return prepare.call(this,sql);};
 try{assert.throws(()=>f.repo.ingestHostEvent(input),/unresolved-graph-write-fault/);}finally{DatabaseSync.prototype.prepare=prepare;}
 const db=new DatabaseSync(f.file,{readOnly:true});try{for(const table of ['raw_unresolved','raw_captures','raw_capture_blocks','raw_watermarks'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);const result=f.repo.ingestHostEvent(input);assert.ok(result.unresolvedId);assert.equal(f.repo.ingestHostEvent(input).unresolvedId,result.unresolvedId);}finally{db.close();f.close();}
});
test('same process reopening is not cold replay',()=>{const f=fixture();const events=[{seq:0,text:'\ud800'}];f.repo.ingest({fullSessionId:'s',event:events[0]});const a=f.repo.recordHostPrefix({fullSessionId:'s',events,provenance:{binding:'one'}});const b=f.repo.recordHostPrefix({fullSessionId:'s',events,provenance:{binding:'one'}});assert.equal(a.replayedNext,0);assert.equal(b.replayedNext,0);f.close();});
test('late conflict caps host watermark and checkpoint admission',()=>{const f=fixture();const events=[{seq:0,text:'a'},{seq:1,text:'b'}];for(const event of events)f.repo.ingest({fullSessionId:'s',event});f.repo.recordHostPrefix({fullSessionId:'s',events,provenance:{}});f.repo.ingest({fullSessionId:'s',event:{seq:0,text:'changed'}});f.repo.recordHostPrefix({fullSessionId:'s',events,provenance:{}});const db=new DatabaseSync(f.file,{readOnly:true});const row=db.prepare('SELECT * FROM raw_watermarks').get();assert.equal(row.raw_next,0);assert.equal(row.verified_next,0);assert.equal(row.integrity_cap,0);db.close();f.close();});
test('proof persistence failure rolls back observation and recovers',()=>{const f=fixture(),events=[{seq:0,text:'original'}],args={fullSessionId:'s',events,provenance:{}};f.repo.ingest({fullSessionId:'s',event:events[0]});const prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('INSERT INTO raw_host_event_proofs'))throw Error('proof-write-fault');return prepare.call(this,sql);};try{assert.throws(()=>f.repo.recordHostPrefix(args),/proof-write-fault/);}finally{DatabaseSync.prototype.prepare=prepare;}f.repo.recordHostPrefix(args);const db=new DatabaseSync(f.file,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM raw_host_observations').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM raw_host_event_proofs').get().n,1);db.close();f.close();});
test('unchanged host events reuse persistent capture and evidence for 30 scans',()=>{const f=fixture(),events=Array.from({length:10},(_,seq)=>({seq,text:'x'.repeat(4096)})),provenance={binding:'s'};for(let round=0;round<30;round++){for(const event of events)f.repo.ingestHostEvent({fullSessionId:'s',event,source:provenance});f.repo.recordHostPrefix({fullSessionId:'s',events,provenance});}const db=new DatabaseSync(f.file,{readOnly:true});for(const table of ['raw_receipts','raw_captures','raw_evidence','raw_sources','raw_host_event_proofs'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,10);assert.equal(db.prepare('SELECT count(*) n FROM raw_host_observations').get().n,1);db.close();f.close();});
test('aggregate nodes do not limit per-event proof',()=>{const f=fixture(),events=Array.from({length:51},(_,seq)=>({seq,data:Array(1000).fill(null)}));for(const event of events)f.repo.ingestHostEvent({fullSessionId:'s',event,source:{}});assert.equal(f.repo.recordHostPrefix({fullSessionId:'s',events,provenance:{}}).observedNext,51);f.close();});
test('H1 graph dedup never merges changed primitive, alias or source evidence',()=>{
 const f=fixture(),event={seq:0,text:'keep',bad:undefined,n:1},source={binding:'a'};
 try{const a=f.repo.ingestHostEvent({fullSessionId:'s',event,source});
 assert.equal(f.repo.ingestHostEvent({fullSessionId:'s',event:structuredClone(event),source}).versionId,a.versionId);
 const b=f.repo.ingestHostEvent({fullSessionId:'s',event:{...event,n:2},source});assert.notEqual(b.versionId,a.versionId);
 const c=f.repo.ingestHostEvent({fullSessionId:'s',event,source:{binding:'b'}});assert.notEqual(c.versionId,a.versionId);
 const d=new DatabaseSync(f.file,{readOnly:true});assert.equal(d.prepare('SELECT count(*) n FROM raw_versions').get().n,3);assert.equal(d.prepare('SELECT integrity_cap FROM raw_watermarks').get().integrity_cap,0);d.close();
 }finally{f.close();}
});
for(const point of ['INSERT INTO raw_capture_blocks','INSERT INTO raw_receipts','INSERT INTO raw_host_preservations'])test(`H1 atomic failure ${point}`,()=>{
 const f=fixture(),prepare=DatabaseSync.prototype.prepare;let returned=false;
 DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith(point))throw Error('h1-write-fault');return prepare.call(this,sql);};
 try{assert.throws(()=>{f.repo.ingestHostEvent({fullSessionId:'s',event:{seq:0,text:'keep',bad:undefined},source:{}});returned=true;},/h1-write-fault/);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(returned,false);const d=new DatabaseSync(f.file,{readOnly:true});for(const table of ['raw_versions','raw_captures','raw_receipts','raw_watermarks','raw_capture_blocks'])assert.equal(d.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);d.close();
 const r=f.repo.ingestHostEvent({fullSessionId:'s',event:{seq:0,text:'keep',bad:undefined},source:{}});assert.equal(r.classification,'unsupported-identity');f.close();
});
test('H1 SQL codec-shaped error is not caught by identity fallback',()=>{
 const f=fixture(),prepare=DatabaseSync.prototype.prepare;let captures=0;
 DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('SELECT v.*'))throw new TypeError('unsupported-identity');if(sql.startsWith('INSERT INTO raw_capture_nodes'))captures++;return prepare.call(this,sql);};
 try{assert.throws(()=>f.repo.ingestHostEvent({fullSessionId:'s',event:{seq:0,text:'keep'},source:{}}),/unsupported-identity/);assert.equal(captures,0);}finally{DatabaseSync.prototype.prepare=prepare;f.close();}
});
test('H1 stale lease prevents unsupported capture and reuse',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'h1-lease-')),file=path.join(root,'raw.sqlite');let valid=true;
 const lease={namespace:'fixture',assertWritable(){if(!valid)throw Error('lease-invalid');}},repo=new RawRepository(file,lease),input={fullSessionId:'s',event:{seq:0,bad:undefined,text:'keep'},source:{}};
 repo.ingestHostEvent(input);valid=false;assert.throws(()=>repo.ingestHostEvent(input),/lease-invalid/);assert.throws(()=>repo.ingestHostEvent({...input,fullSessionId:'new'}),/lease-invalid/);repo.close();
 const d=new DatabaseSync(file,{readOnly:true});assert.equal(d.prepare('SELECT count(*) n FROM raw_receipts').get().n,1);d.close();
});
test('H1 opaque accessor preserves each acquisition without false dedup or getter calls',()=>{
 const f=fixture();let calls=0;const event={seq:0,text:'opaque-tail\ud800'};Object.defineProperty(event,'opaque',{enumerable:true,get(){calls++;return 'unread';}});
 try{const input={fullSessionId:'s',event,source:{}},a=f.repo.ingestHostEvent(input),b=f.repo.ingestHostEvent(input);assert.notEqual(a.versionId,b.versionId);assert.equal(calls,0);
 const d=new DatabaseSync(f.file,{readOnly:true});assert.equal(d.prepare('SELECT count(*) n FROM raw_captures').get().n,2);assert.equal(d.prepare('SELECT integrity_cap FROM raw_watermarks').get().integrity_cap,0);assert.equal(d.prepare('SELECT count(*) n FROM raw_receipts').get().n,2);d.close();}finally{f.close();}
});
for(const throws of [false,true])test(`H2 seq accessor ${throws?'throws':'returns'} without evaluation and preserves text`,()=>{
 const f=fixture();let calls=0;const event={text:'seq-accessor-tail'};Object.defineProperty(event,'seq',{enumerable:true,get(){calls++;if(throws)throw Error('getter-executed');return 0;}});
 try{const result=f.repo.ingestHostEvent({fullSessionId:'s',event,source:{}});assert.equal(result.classification,'unresolved');assert.equal(calls,0);}finally{f.close();}
 const db=new DatabaseSync(f.file,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM raw_unresolved').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM raw_events').get().n,0);assert.equal(db.prepare('SELECT verified_next FROM raw_watermarks').get().verified_next,0);assert.ok(db.prepare('SELECT bytes FROM raw_capture_blocks').all().some(r=>Buffer.from(r.bytes).toString('utf16le')==='seq-accessor-tail'));}finally{db.close();}
});
for(const location of ['event','source'])test(`H3 nonstandard array in ${location} is never reused across cold rescan`,()=>{
 const f=fixture(),normal=[undefined],opaque=[undefined];Object.setPrototypeOf(opaque,{opaque:true});
 const input=value=>({fullSessionId:'s',event:{seq:0,text:'keep',value:location==='event'?value:undefined},source:location==='source'?{value}: {}});
 const a=f.repo.ingestHostEvent(input(normal)),b=f.repo.ingestHostEvent(input(opaque));assert.notEqual(a.versionId,b.versionId);assert.notEqual(b.reused,true);f.close();
 const lease=openNamespace({directory:path.dirname(f.file),registryRoot:path.join(path.dirname(path.dirname(f.file)),'registry'),sourceRoot:path.join(path.dirname(path.dirname(f.file)),'source'),instanceId:'i',writable:true}),repo=new RawRepository(f.file,lease);
 try{const c=repo.ingestHostEvent(input(opaque));assert.notEqual(c.versionId,b.versionId);assert.notEqual(c.reused,true);}finally{repo.close();lease.close();}
 const db=new DatabaseSync(f.file,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM raw_versions').get().n,3);assert.equal(db.prepare('SELECT verified_next FROM raw_watermarks').get().verified_next,0);}finally{db.close();}
});
test('uncommitted prefix cannot create checkpoint',()=>{const f=fixture();assert.throws(()=>f.repo.recordHostPrefix({fullSessionId:'s',events:[{seq:0}],provenance:{}}),/not-committed/);f.close();});
