import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const root=process.env.RAW_RUN,mode=process.argv[2],host=process.env.RAW_HOST;
if(mode==='verify-scan-killed'){
 const db=new DatabaseSync(path.join(root,'raw/raw.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM raw_versions').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM raw_watermarks').get().n,0);db.close();console.log('cold-scan-kill-no-publication');process.exit(0);
}
if(mode==='conflict'){
 const {openNamespace}=await import('../src/raw-namespace.mjs');const {RawRepository}=await import('../src/raw-repository.mjs');
 const lease=openNamespace({directory:path.join(root,'raw'),registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'persist'),instanceId:'fixture-instance',writable:true});
 const repo=new RawRepository(path.join(root,'raw/raw.sqlite'),lease);const expected=JSON.parse(fs.readFileSync(path.join(root,'expected.json'),'utf8'));
 repo.ingest({fullSessionId:'raw-host-real',event:{...expected[0],lateConflict:'different'}});repo.close();lease.close();process.exit(0);
}
if(mode==='verify-conflict'){
 const db=new DatabaseSync(path.join(root,'raw/raw.sqlite'),{readOnly:true});const mark=db.prepare('SELECT * FROM raw_watermarks').get();assert.equal(mark.verified_next,0);assert.equal(mark.raw_next,0);assert.equal(mark.integrity_cap,0);assert.ok(db.prepare('SELECT count(*) n FROM raw_conflicts').get().n>0);console.log(JSON.stringify({mode,mark}));db.close();process.exit(0);
}
if(mode==='verify'||mode==='verify-killed'||mode==='verify-unverified'){
 const expected=JSON.parse(fs.readFileSync(path.join(root,'expected.json'),'utf8'));
 const db=new DatabaseSync(path.join(root,'raw/raw.sqlite'),{readOnly:true});
 const rows=db.prepare('SELECT e.seq,e.event_key,e.namespace,v.identity,v.snapshot FROM raw_events e JOIN raw_versions v ON e.event_key=v.event_key ORDER BY e.seq').all();
 const {encodeIdentity,eventKey}=await import('../src/raw-codec.mjs');
 for(const row of rows){assert.equal(row.event_key,eventKey(row.namespace,'raw-host-real',row.seq));assert.deepEqual(Buffer.from(row.identity),encodeIdentity(expected[row.seq]));}
 assert.deepEqual(rows.map(r=>JSON.parse(Buffer.from(r.snapshot).toString('utf16le'))),expected);
 assert.equal(rows.length,expected.length);
 const mark=db.prepare('SELECT * FROM raw_watermarks').get();assert.equal(mark.verified_next,mode==='verify'?expected.length:0);assert.equal(mark.derived_next,0);
 if(mode==='verify')assert.ok(db.prepare('SELECT count(*) n FROM raw_replay_checkpoints WHERE level=\'replayed\'').get().n>0);
 else if(mode==='verify-killed') assert.ok(fs.readdirSync(path.join(root,'registry')).some(name=>name.endsWith('.lock')),'killed writer lock must remain');
 if(mode==='verify'){
  const proofs=db.prepare('SELECT p.seq,p.version_id,p.provenance,v.identity,c.process replay_process,p.process source_process FROM raw_checkpoint_events ce JOIN raw_host_event_proofs p ON p.id=ce.proof_id JOIN raw_versions v ON v.id=p.version_id JOIN raw_replay_checkpoints c ON c.id=ce.checkpoint ORDER BY p.seq').all();
  assert.equal(proofs.length,expected.length);
  for(const p of proofs){assert.notEqual(p.source_process,p.replay_process);assert.deepEqual(Buffer.from(p.identity),encodeIdentity(expected[p.seq]));assert.ok(p.provenance.length>0);}
 }
 console.log(JSON.stringify({mode,events:rows.length,checkpoint:mark}));db.close();process.exit(0);
}
const pkg=n=>import(pathToFileURL(path.join(host,'@deepseek-ai',n,'lib/index.js')).href);
const {Context}=await pkg('cordis');const ctx=new Context();
const S=await pkg('dsh-session');new S.SessionStore(ctx);
new (await pkg('dsh-agent')).AgentRegistry(ctx);
new (await pkg('dsh-session-projection')).default(ctx);
new (await pkg('dsh-token-meter')).default(ctx);
new (await pkg('dsh-system-prompt')).SystemPrompt(ctx,{});
new (await pkg('dsh-tools')).ToolRuntime(ctx);
const backendFile=path.join(host,'@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js');
const backend=new (await pkg('dsh-session-persistence-jsonl')).default(ctx,{root:path.join(root,'persist'),compression:'none'});
const source='\uFEFFa\r\ne\u0301\ud800'+ 'x'.repeat(900);
let owned;
if(mode.startsWith('produce')){
 ctx.provide('llm',{imageRequestPricing(){},prepareCall:async config=>({config,async *stream(){yield {type:'text-delta',index:0,text:'one'};yield {type:'text-delta',index:1,text:'two'};yield {type:'finish',reason:{kind:'stop'}};}})});
 const loop=new (await pkg('dsh-agent-loop')).AgentLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>10}});
 owned=await loop.createAgent(ctx,{sessionId:'raw-host-real',agentOptions:{provider:'fixture',model:'offline'},meta:{cwd:root}});
 const L=await pkg('dsh-llm');owned.agent.followup(L.createUserMessage({content:[{type:'text',text:source},{type:'text',text:'second block \udc00'}],source:{kind:'user'}}));await owned.agent.whenIdle();
 fs.writeFileSync(path.join(root,'expected.json'),JSON.stringify(owned.agent.session.snapshotEvents()),{flag:'wx'});
 const flushReturned=await backend.flush();console.log(JSON.stringify({axis:'flush-returned',value:flushReturned??null,verifiedNext:0}));
 await owned.dispose();
}
const legacyFile=path.join(root,'legacy.sqlite');
if(mode.startsWith('produce')){
 const {open:openStore}=await import('../src/store.mjs');const s=openStore(legacyFile);
 s.put({text:'legacy fixture original',kind:'person',source:'fixture',createdAt:123});s.close();
}
const legacyRows=()=>{const d=new DatabaseSync(legacyFile,{readOnly:true});try{return d.prepare('SELECT * FROM memories ORDER BY id').all();}finally{d.close();}};
const legacyBefore=legacyRows();
if(mode==='produce-kill'){
 const {RawRepository}=await import('../src/raw-repository.mjs');
 RawRepository.prototype.recordHostPrefix=function(){console.log('fixture-kill-before-host-checkpoint');process.kill(process.pid,'SIGKILL');};
}
if(mode==='produce-scan-kill'){
 const open=backend.open.bind(backend);
 backend.open=async(...args)=>{const h=await open(...args);const read=h.read.bind(h);h.read=async(...values)=>{await read(...values);console.log('fixture-kill-during-source-read');process.kill(process.pid,'SIGKILL');};return h;};
}
if(mode==='checkpoint-fault'){
 const prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('INSERT INTO raw_replay_checkpoints'))throw Error('fixture-checkpoint-transaction-fault');return prepare.call(this,sql);};
}
const {apply}=await import(process.env.RAW_PLUGIN?pathToFileURL(process.env.RAW_PLUGIN).href:'../src/index.mjs');
const handle=apply(ctx,{dbPath:path.join(root,'legacy.sqlite'),autoCapture:{enabled:false},autoInject:false,rawArchive:{enabled:true,mode:'archive-only',directory:path.join(root,'raw'),registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'persist'),instanceId:'fixture-instance',principalId:'fixture',principals:['fixture'],projects:[{id:'p',cwd:root}],allowedProjectIds:['p'],intervalMs:50,backend:{name:'session-persistence-jsonl',compression:'none',moduleFile:backendFile,sha256:createHash('sha256').update(fs.readFileSync(backendFile)).digest('hex')}}});
const expected=JSON.parse(fs.readFileSync(path.join(root,'expected.json'),'utf8'));
const raw=path.join(root,'raw/raw.sqlite');
let ok=false;
for(let i=0;i<100;i++){
 await new Promise(r=>setTimeout(r,50));
 if(!fs.existsSync(raw))continue;
 const db=new DatabaseSync(raw,{readOnly:true});
 try{const mark=db.prepare('SELECT * FROM raw_watermarks').get();ok=mark?.raw_next===expected.length&&(mode==='produce'||mark.verified_next===expected.length);}finally{db.close();}
 if(ok)break;
}
handle.dispose();await new Promise(r=>setTimeout(r,100));
if(ok){
 const oldMode=apply(ctx,{dbPath:legacyFile,autoCapture:{enabled:false},autoInject:false});oldMode.dispose();await new Promise(r=>setTimeout(r,25));
 assert.ok(fs.existsSync(raw),'switching off preserves raw archive');
}
assert.deepEqual(legacyRows(),legacyBefore,'legacy memories all rows unchanged');
assert.ok(ok,'real apply archive checkpoint not reached');
const db=new DatabaseSync(raw,{readOnly:true});
const versions=db.prepare('SELECT snapshot FROM raw_versions v JOIN raw_events e ON e.event_key=v.event_key ORDER BY e.seq').all();
assert.deepEqual(versions.map(v=>JSON.parse(Buffer.from(v.snapshot).toString('utf16le'))),expected);
assert.equal(db.prepare('SELECT derived_next FROM raw_watermarks').get().derived_next,0);
console.log(JSON.stringify({mode,events:expected.length,watermark:db.prepare('SELECT * FROM raw_watermarks').get()}));db.close();
