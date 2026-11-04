import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { utf16le, fromUtf16le, domainHash, encodeIdentity, eventKey, equalBytes, snapshotBytes } from '../src/raw-codec.mjs';
import { openNamespace } from '../src/raw-namespace.mjs';
import { RawRepository } from '../src/raw-repository.mjs';

if (!process.env.RAW_CORE_ISOLATED) throw Error('isolated launcher required');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'raw-core-'));
  const opts={directory:path.join(root,'data'),registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'source'),instanceId:'fixture',writable:true};
  const lease=openNamespace(opts); const file=path.join(opts.directory,'raw.sqlite'); const repo=new RawRepository(file,lease);
  t.after(()=>{repo.close();lease.close();fs.rmSync(root,{recursive:true,force:true});});
  const query=(sql,...args)=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}};
  return {root,opts,lease,file,repo,query};
}
for (const text of ['', '\ud800', '\udfff', '\ufeffA\r\nB', 'x'.repeat(100001), '\ud83d\ude00']) test('UTF16 exact '+text.length,()=>{
  const bytes=utf16le(text); assert.equal(bytes.length,text.length*2); assert.equal(fromUtf16le(bytes),text);
  for(let i=0;i<text.length;i++)assert.equal(bytes.readUInt16LE(i*2),text.charCodeAt(i));
});
test('domain framing and full bytes',()=>{
  const b=utf16le('\ud800'); const n=Buffer.alloc(8);n.writeBigUInt64LE(BigInt(b.length));
  assert.equal(domainHash('raw-text-utf16le-v1',b),createHash('sha256').update(Buffer.concat([Buffer.from('raw-text-utf16le-v1\0','ascii'),n,b])).digest('hex'));
  assert.notEqual(domainHash('raw-text-utf16le-v1',b),domainHash('event-identity-v1',b));
  assert.equal(equalBytes(Buffer.from([1]),Buffer.from([1,0])),false);
  assert.equal(equalBytes(Buffer.from([1,2]),Buffer.from([1,3])),false);
});
test('canonical order, types, hostile descriptors and unsupported identity',()=>{
  assert.deepEqual(encodeIdentity({b:1,a:'x'}),encodeIdentity({a:'x',b:1}));
  for(const v of [NaN,Infinity,-0,undefined,1n,Symbol(),new Date(),[,1],Object.assign([1],{extra:2}),{get x(){throw Error('must not execute');}}]) assert.throws(()=>encodeIdentity(v),/unsupported-identity/);
  const cyclic={};cyclic.x=cyclic;assert.throws(()=>encodeIdentity(cyclic),/unsupported-identity/);
  assert.notDeepEqual(encodeIdentity('1'),encodeIdentity(1));
  assert.notDeepEqual(encodeIdentity([1,2]),encodeIdentity([2,1]));
  assert.deepEqual([...encodeIdentity(null)],[0]); assert.deepEqual([...encodeIdentity(false)],[1]);assert.deepEqual([...encodeIdentity(true)],[2]);
  assert.equal(encodeIdentity('x').readBigUInt64LE(1),2n);
});
test('polluted descriptors cannot forge identity, sequence, capture or host prefix',t=>{
  const {repo,query}=fixture(t); let calls=0;
  const event={text:'real',get seq(){calls++;return 0;}};
  Object.prototype.value=0;
  try {
    assert.throws(()=>encodeIdentity(event),/unsupported-identity/);
    assert.throws(()=>snapshotBytes(event),/unsupported-identity/);
    const result=repo.ingest({fullSessionId:'s',event});
    assert.equal(result.classification,'unresolved');
    assert.equal(result.capture.classification,'capture-partial');
    assert.equal(query('SELECT count(*) n FROM raw_events')[0].n,0);
    assert.equal(query('SELECT raw_next FROM raw_watermarks')[0].raw_next,0);
    assert.ok(query('SELECT bytes FROM raw_capture_blocks').some(row=>fromUtf16le(row.bytes)==='real'));
    assert.throws(()=>repo.recordHostPrefix({fullSessionId:'s',events:[event],provenance:{}}),/raw-noncontiguous-host-prefix/);
    assert.equal(calls,0);
  } finally { delete Object.prototype.value; }
});
test('keys preserve full identity and forbid invalid seq',()=>{
  assert.equal(eventKey('ns','full/session',0),'["ns","full/session",0]');
  for(const seq of [-0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>eventKey('ns','s',seq));
});
test('same text distinct events/sources, evidence separate from identity',t=>{
  const {repo,query}=fixture(t);const event={seq:0,type:'message',message:{id:'same',content:'\ud800\r\n'}};
  repo.ingest({fullSessionId:'one',event,source:{file:'one'},evidence:{observedAt:1}});
  repo.ingest({fullSessionId:'one',event,source:{file:'two'},evidence:{observedAt:2}});
  repo.ingest({fullSessionId:'two',event}); repo.ingest({fullSessionId:'one',event:{...event,seq:1}});
  assert.equal(query('SELECT * FROM raw_versions').length,3);assert.equal(query('SELECT * FROM raw_sources').length,4);assert.equal(query('SELECT * FROM raw_evidence').length,4);assert.equal(query('SELECT * FROM raw_conflicts').length,0);
  const block=query('SELECT bytes FROM raw_blocks WHERE path=?','$["message"]["content"]')[0];assert.equal(fromUtf16le(block.bytes),'\ud800\r\n');
});
test('all seq, holes, late conflict invalidation and append history',t=>{
  const {repo,query}=fixture(t);const put=(seq,text='same')=>repo.ingest({fullSessionId:'s',event:{seq,type:seq===1?'inherited':'metadata',text}});
  assert.equal(put(2).rawCommittedNextSeq,0);assert.equal(put(0).rawCommittedNextSeq,1);assert.equal(put(1).rawCommittedNextSeq,3);
  const conflict=put(1,'changed');assert.equal(conflict.classification,'conflict');assert.equal(conflict.rawCommittedNextSeq,1);
  assert.equal(put(3).rawCommittedNextSeq,1);assert.equal(put(1).classification,'conflict');
  assert.equal(query('SELECT * FROM raw_versions').length,5); const c=query('SELECT * FROM raw_conflicts')[0];assert.notEqual(c.first_version,c.second_version);assert.ok(c.first_difference>=0);
  const i=query('SELECT * FROM raw_invalidations')[0];assert.equal(i.start_seq,1);assert.equal(i.end_seq,3);assert.equal(query('SELECT * FROM raw_watermarks')[0].integrity_cap,1);
  assert.ok(query('SELECT * FROM raw_watermark_history').some(x=>x.next_seq===3));
});
test('unsupported identity retains available long and empty raw strings, no watermark promotion',t=>{
  const {repo,query}=fixture(t);const r=repo.ingest({fullSessionId:'s',event:{seq:0,text:'x'.repeat(9000),empty:'',bad:undefined}});
  assert.equal(r.classification,'unsupported-identity');assert.equal(r.rawCommittedNextSeq,0);assert.equal(query('SELECT * FROM raw_blocks').length,2);assert.equal(query('SELECT length(bytes) AS n FROM raw_blocks WHERE path=?','$["text"]')[0].n,18000);
});
test('MAX_SAFE seq unresolved and no durability claim without writer',t=>{
  const {repo}=fixture(t); const r=repo.ingest({fullSessionId:'s',event:{seq:Number.MAX_SAFE_INTEGER,text:'last'}});
  assert.equal(r.classification,'unresolved-seq');assert.equal(r.durability,'observed');assert.equal(r.rawCommittedNextSeq,0);
});
test('transaction failure rolls back blocks, receipts and watermark',t=>{
  const {file,repo,query}=fixture(t);const db=new DatabaseSync(file);db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON raw_receipts BEGIN SELECT RAISE(ABORT,'fixture-failure'); END;");db.close();
  assert.throws(()=>repo.ingest({fullSessionId:'s',event:{seq:0,text:'raw'}}),/fixture-failure/);
  for(const table of ['raw_events','raw_versions','raw_blocks','raw_sources','raw_evidence','raw_watermarks'])assert.equal(query(`SELECT * FROM ${table}`).length,0);
});
test('namespace locks, clone binding, read-only recovery, loss halts ingest',t=>{
  const {root,opts,lease,repo,query}=fixture(t);
  assert.throws(()=>openNamespace(opts),/EEXIST/);
  assert.throws(()=>openNamespace({...opts,instanceId:'different'}),/deployment-binding-mismatch/);
  const recovery=openNamespace({...opts,writable:false});assert.equal(recovery.namespace,lease.namespace);assert.throws(()=>recovery.assertWritable(),/read-only/);recovery.close();
  const clone=path.join(root,'clone');fs.mkdirSync(clone);fs.copyFileSync(path.join(opts.directory,'namespace.json'),path.join(clone,'namespace.json'));
  assert.throws(()=>openNamespace({...opts,directory:clone,sourceRoot:clone}),/deployment-binding-mismatch/);
  const independent=openNamespace({...opts,directory:path.join(root,'independent'),sourceRoot:clone,cloneOf:lease.namespace});assert.notEqual(independent.namespace,lease.namespace);assert.equal(independent.cloneOf,lease.namespace);independent.close();
  fs.unlinkSync(path.join(opts.registryRoot,lease.namespace+'.lock'));
  assert.throws(()=>repo.ingest({fullSessionId:'s',event:{seq:0,text:'no'}}));assert.equal(query('SELECT * FROM raw_events').length,0);
});
test('unknown event identity has independent unresolved receipts and preserves strings',t=>{
  const {repo,query}=fixture(t);const a=repo.ingest({fullSessionId:'s',event:{text:'full',empty:''}});const b=repo.ingest({fullSessionId:'s',event:{text:'full',empty:''}});
  assert.notEqual(a.unresolvedId,b.unresolvedId);assert.equal(query('SELECT * FROM raw_unresolved').length,2);assert.equal(query('SELECT * FROM raw_events').length,0);
  assert.equal(repo.ingest({fullSessionId:'s',event:{seq:0,text:'known'}}).rawCommittedNextSeq,0);
});
test('eight processes cannot acquire held deployment lease',async t=>{
  const {opts}=fixture(t);const moduleUrl=new URL('../src/raw-namespace.mjs',import.meta.url).href;
  const results=await Promise.all(Array.from({length:8},()=>new Promise((resolve,reject)=>{
    const code=`import {openNamespace} from ${JSON.stringify(moduleUrl)};try{openNamespace(${JSON.stringify(opts)});process.exit(9);}catch(e){process.exit(e.code==='EEXIST'?0:8);}`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{env:process.env,stdio:'ignore'});child.on('error',reject);child.on('close',resolve);
  })));
  assert.deepEqual(results,Array(8).fill(0));
});
test('same hash is insufficient without complete identity bytes',t=>{
  const {repo,query,file}=fixture(t);const first={seq:0,text:'one'},second={seq:0,text:'two'};
  repo.ingest({fullSessionId:'s',event:first});const db=new DatabaseSync(file);
  db.prepare('UPDATE raw_versions SET identity_hash=?').run(domainHash('event-identity-v1',encodeIdentity(second)));db.close();
  assert.equal(repo.ingest({fullSessionId:'s',event:second}).classification,'conflict');assert.equal(query('SELECT * FROM raw_versions').length,2);
});
test('binding changes revoke existing lease before write',t=>{
  const {opts,lease,repo}=fixture(t);fs.writeFileSync(path.join(opts.registryRoot,lease.namespace+'.json'),'{}');
  assert.throws(()=>repo.ingest({fullSessionId:'s',event:{seq:0}}),/binding-changed/);
});
test('namespace corruption and missing namespace in nonempty store fail closed',t=>{
  const {root,opts}=fixture(t);const bad=path.join(root,'bad');fs.mkdirSync(bad);fs.writeFileSync(path.join(bad,'namespace.json'),'{}');
  assert.throws(()=>openNamespace({...opts,directory:bad}),/corrupt-namespace/);
  fs.unlinkSync(path.join(bad,'namespace.json'));fs.writeFileSync(path.join(bad,'raw.sqlite'),'fixture');assert.throws(()=>openNamespace({...opts,directory:bad}),/missing-namespace-nonempty/);
});
