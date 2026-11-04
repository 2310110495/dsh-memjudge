import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openNamespace} from '../src/raw-namespace.mjs';
import {RawRepository,RAW_SCHEMA_VERSION} from '../src/raw-repository.mjs';
import {DatabaseSync} from 'node:sqlite';
import {utf16le,encodeIdentity,domainHash} from '../src/raw-codec.mjs';
if(!process.env.RAW_CORE_ISOLATED)throw Error('isolated launcher required');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const options=root=>({directory:path.join(root,'data'),registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'source'),instanceId:'fixture',writable:true});
function child(t,mode,root,stage='',id='0'){
  const p=spawn(process.execPath,['--import',process.env.RAW_TEST_GUARD,fileURLToPath(new URL('./raw-process.fixture.mjs',import.meta.url)),mode,root,stage,id],{env:process.env,stdio:['ignore','pipe','pipe']});
  let text='',stderr='',ended=false;const rows=[],waiters=[];
  const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',(code,signal)=>{ended=true;resolve({code,signal,stderr,rows});for(const w of waiters)w();});});
  p.stdout.on('data',b=>{text+=b;let i;while((i=text.indexOf('\n'))>=0){rows.push(JSON.parse(text.slice(0,i)));text=text.slice(i+1);}for(const w of [...waiters])w();});p.stderr.on('data',b=>stderr+=b);
  t.after(async()=>{if(!ended)p.kill('SIGKILL');await done;});
  const wait=pred=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{reject(Error('barrier timeout '+JSON.stringify(rows)+' '+stderr));},10000);const check=()=>{const r=rows.find(pred);if(r||ended||rows.some(r=>r.error)){clearTimeout(timer);const i=waiters.indexOf(check);if(i>=0)waiters.splice(i,1);r?resolve(r):reject(Error('worker failed '+JSON.stringify(rows)+' '+stderr));}};waiters.push(check);check();});
  return {p,done,wait,rows};
}
const release=(root,name,id='0')=>fs.writeFileSync(path.join(root,'release-'+name+'-'+id),'go',{flag:'wx'});

test('first publication converges across eight processes behind deterministic barriers',async t=>{
  const root=fixture(t),workers=[];
  // First candidate stays unpublished while all later contenders enter creation.
  for(let i=0;i<8;i++){const c=child(t,'namespace',root,'',String(i));workers.push(c);await c.wait(r=>r.barrier==='publish');}
  for(let i=0;i<8;i++)release(root,'publish',String(i));
  const results=await Promise.all(workers.map(c=>c.wait(r=>r.acquired||r.contended)));
  assert.equal(new Set(results.map(r=>r.acquired||r.contended)).size,1);
  assert.equal(results.filter(r=>r.acquired).length,1);
  const winner=results.findIndex(r=>r.acquired);release(root,'held',String(winner));
  for(const c of workers)assert.equal((await c.done).code,0);
  const reacquire=child(t,'acquire',root);assert.equal((await reacquire.wait(r=>r.acquired)).acquired,results[0].acquired||results[0].contended);assert.equal((await reacquire.done).code,0);
});
for(const point of ['publish','linked'])test('creation kill at '+point+' preserves candidates and recovers',async t=>{
  const root=fixture(t),c=child(t,'namespace',root,point==='linked'?'after-link':'');
  await c.wait(r=>r.barrier==='publish');if(point==='linked'){release(root,'publish');await c.wait(r=>r.barrier==='linked');}
  const before=new Map(fs.readdirSync(path.join(root,'data')).map(n=>[n,fs.readFileSync(path.join(root,'data',n))]));
  c.p.kill('SIGKILL');await c.done;
  const lease=openNamespace(options(root));lease.assertWritable();
  for(const [n,bytes] of before)assert.deepEqual(fs.readFileSync(path.join(root,'data',n)),bytes);
  if(point==='linked')assert.equal(lease.namespace,JSON.parse(before.get('namespace.json')).namespace);
  lease.close();
});
test('truncated candidate retained, unknown contents and corrupt published identity never replaced',t=>{
  const root=fixture(t),o=options(root);fs.mkdirSync(o.directory);
  const p=path.join(o.directory,'namespace.json.'+randomUUID()+'.tmp');fs.writeFileSync(p,'{"interrupted":');
  const lease=openNamespace(o);lease.close();assert.equal(fs.readFileSync(p,'utf8'),'{"interrupted":');
  const identity=path.join(o.directory,'namespace.json');fs.writeFileSync(identity,'{bad');assert.throws(()=>openNamespace(o));assert.equal(fs.readFileSync(identity,'utf8'),'{bad');
  fs.unlinkSync(identity);fs.writeFileSync(path.join(o.directory,'raw.sqlite'),'existing');assert.throws(()=>openNamespace(o),/missing-namespace-nonempty/);
});
test('invalid deployment configuration creates no identity',t=>{
  const root=fixture(t),o=options(root);assert.throws(()=>openNamespace({...o,instanceId:''}),/missing-deployment-binding/);assert.equal(fs.existsSync(o.directory),false);
});
test('missing identity for registered source never silently allocates another namespace',t=>{
  const root=fixture(t),o=options(root),a=openNamespace(o);a.close();fs.unlinkSync(path.join(o.directory,'namespace.json'));
  assert.throws(()=>openNamespace(o),/missing-namespace-bound-source/);assert.equal(fs.existsSync(path.join(o.directory,'namespace.json')),false);
});
test('publication sync failure cleans its own temp and exposes no partial identity',t=>{
  const root=fixture(t),o=options(root),sync=fs.fsyncSync;
  try {fs.fsyncSync=()=>{throw Error('fixture-sync-failure');};assert.throws(()=>openNamespace(o),/fixture-sync-failure/);}
  finally {fs.fsyncSync=sync;}
  assert.deepEqual(fs.readdirSync(o.directory),[]);const a=openNamespace(o);assert.ok(['synced','unavailable'].includes(a.directorySync));a.close();
});
test('replaced lock with copied token is not removed by old close',t=>{
  const root=fixture(t),o=options(root),a=openNamespace(o),lock=path.join(o.registryRoot,a.namespace+'.lock');
  const token=fs.readFileSync(lock);fs.renameSync(lock,lock+'.old');fs.writeFileSync(lock,token);
  assert.throws(()=>a.assertWritable(),/lease-lost/);a.close();assert.deepEqual(fs.readFileSync(lock),token);
});
function bytesIn(directory){return Object.fromEntries(fs.readdirSync(directory).sort().map(n=>[n,fs.readFileSync(path.join(directory,n)).toString('hex')]));}
for(const version of [0,99])test('schema '+version+' stops before touching original database/WAL/SHM',t=>{
  const root=fixture(t),o=options(root),lease=openNamespace(o),file=path.join(o.directory,'raw.sqlite');
  const repo=new RawRepository(file,lease);repo.ingest({fullSessionId:'s',event:{seq:0,text:'keep\ud800'}});repo.close();
  const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version='+version);
  const before=bytesIn(o.directory);
  try {
    assert.throws(()=>{const unexpected=new RawRepository(file,lease);unexpected.close();},version===0?/raw-schema-migration-required/:/unsupported-raw-schema:99/);
    assert.deepEqual(bytesIn(o.directory),before);
  } finally {db.close();lease.close();}
});
test('fixture-only v0 copy migration preserves original bytes, records and allows reopening',t=>{
  const root=fixture(t),o=options(root),lease=openNamespace(o),file=path.join(o.directory,'raw.sqlite');
  const repo=new RawRepository(file,lease);repo.ingest({fullSessionId:'s',event:{seq:0,text:'\ufeffold\udfff'}});repo.close();
  let db=new DatabaseSync(file);assert.equal(db.prepare('PRAGMA user_version').get().user_version,RAW_SCHEMA_VERSION);db.exec('PRAGMA user_version=0');
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();const snapshot=db.prepare('SELECT hex(identity) AS identity FROM raw_versions').all();db.close();
  const before=bytesIn(o.directory),copy=path.join(root,'fixture-copy.sqlite');fs.copyFileSync(file,copy);
  db=new DatabaseSync(copy);assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(),tables);db.exec('BEGIN IMMEDIATE; PRAGMA user_version='+RAW_SCHEMA_VERSION+'; COMMIT');db.close();
  const migrated=new RawRepository(copy,lease);migrated.ingest({fullSessionId:'s',event:{seq:1,text:'new'}});migrated.close();
  db=new DatabaseSync(copy,{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,RAW_SCHEMA_VERSION);assert.deepEqual(db.prepare('SELECT hex(identity) AS identity FROM raw_versions LIMIT 1').all(),snapshot);assert.equal(db.prepare('SELECT count(*) AS n FROM raw_versions').get().n,2);db.close();
  assert.deepEqual(bytesIn(o.directory),before);lease.close();
});
const points=['INSERT INTO raw_versions','INSERT INTO raw_blocks','INSERT INTO raw_evidence','INSERT INTO raw_sources','INSERT INTO raw_receipts','INSERT INTO raw_watermark_history','before-commit','after-commit'];
for(const point of points)test('SQLite kill and fresh-process cold read: '+point,async t=>{
  const root=fixture(t),c=child(t,'crash',root,point);await c.wait(r=>r.barrier===(point.includes('commit')?point:'sql'));c.p.kill('SIGKILL');await c.done;
  // Dead writer lock is deliberately not stolen, regardless of age.
  assert.throws(()=>openNamespace(options(root)),/EEXIST/);
  const cold=child(t,'cold',root),r=await cold.wait(r=>r.rows);assert.equal((await cold.done).code,0);assert.equal(r.integrity,'ok');
  const committed=point==='after-commit';for(const [table,rows]of Object.entries(r.rows))assert.equal(rows.length,committed?(table==='raw_blocks'?3:1):0,table);
  if(committed){const v=r.rows.raw_versions[0],event={seq:0,type:'message',message:{role:'user',content:'\ufeff raw\r\n\ud800X\udfff'}};
    assert.equal(v.identity.hex,encodeIdentity(event).toString('hex'));assert.equal(v.identity_hash,domainHash('event-identity-v1',encodeIdentity(event)));
    assert.equal(r.rows.raw_blocks.find(b=>b.path==='$["message"]["content"]').bytes.hex,utf16le(event.message.content).toString('hex'));
    assert.equal(r.rows.raw_sources[0].source.hex,encodeIdentity({file:'fixture-source'}).toString('hex'));assert.equal(r.rows.raw_evidence[0].bytes.hex,encodeIdentity({capture:'fixture-evidence'}).toString('hex'));
    assert.equal(r.rows.raw_watermarks[0].raw_next,1);assert.equal(r.rows.raw_watermarks[0].verified_next,0);assert.equal(r.rows.raw_watermarks[0].derived_next,0);assert.equal(r.rows.raw_receipts[0].classification,'committed');
  }
});
