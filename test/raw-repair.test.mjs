import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {openNamespace} from '../src/raw-namespace.mjs';
import {RawRepository} from '../src/raw-repository.mjs';
import {utf16le, snapshotBytes, IDENTITY_LIMITS} from '../src/raw-codec.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
if(!process.env.RAW_CORE_ISOLATED)throw Error('isolated launcher required');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'repair-'));
 const lease=openNamespace({directory:path.join(root,'data'),registryRoot:path.join(root,'registry'),sourceRoot:root,instanceId:'fixture',writable:true});
 const file=path.join(root,'data/raw.sqlite');let repo=new RawRepository(file,lease);
 t.after(()=>{repo?.close();lease.close();});
 return {file,lease,put:v=>repo.ingest(v),cold(){repo.close();repo=null;const code=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(file)},{readOnly:true});const out={};for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())out[name]=db.prepare('SELECT * FROM '+name).all().map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v instanceof Uint8Array?Buffer.from(v).toString('hex'):v])));console.log(JSON.stringify(out));db.close();`;
 const r=spawnSync(process.execPath,['--import',process.env.RAW_TEST_GUARD,'--input-type=module','-e',code],{env:process.env,encoding:'utf8',maxBuffer:128*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);},reopen(){repo=new RawRepository(file,lease);}};
}
const hex=s=>utf16le(s).toString('hex');
test('R1 three UTF16 session identities isolate holes, late conflicts, unresolved and restart',t=>{
 const f=fixture(t),[a,b,c]=['s\ud800','s\ud801','s\ufffd'];
 const put=(s,seq,text='raw')=>f.put({fullSessionId:s,event:{seq,text}});
 assert.equal(put(a,0).rawCommittedNextSeq,1);
 assert.equal(put(b,1).rawCommittedNextSeq,0);
 assert.equal(put(c,0).rawCommittedNextSeq,1);
 put(a,1);assert.equal(put(a,0,'conflict').rawCommittedNextSeq,0);
 f.put({fullSessionId:b,event:{text:'unresolved\udfff'}});
 let cold=f.cold();assert.equal(cold.raw_watermarks.length,3);
 for(const table of ['raw_events','raw_watermarks','raw_watermark_history','raw_invalidations','raw_unresolved'])for(const row of cold[table])assert.ok([a,b,c].includes(JSON.parse(row.session_id)));
 assert.equal(cold.raw_invalidations.length,1);assert.equal(JSON.parse(cold.raw_invalidations[0].session_id),a);
 assert.equal(cold.raw_watermarks.find(r=>JSON.parse(r.session_id)===c).raw_next,1);
 f.reopen();assert.equal(put(c,1).rawCommittedNextSeq,2);assert.equal(put(b,0).rawCommittedNextSeq,0);
 cold=f.cold();assert.equal(cold.raw_watermarks.find(r=>JSON.parse(r.session_id)===c).raw_next,2);
});
test('R2 12000-deep TOP and TAIL code units survive new-process cold read',t=>{
 const f=fixture(t);let nested={text:'TAIL\ud800'};for(let i=0;i<12000;i++)nested={child:nested};
 const r=f.put({fullSessionId:'s',event:{seq:0,text:'TOP\udfff',nested}});
 assert.equal(r.rawCommittedNextSeq,0);const cold=f.cold();
 for(const s of ['TOP\udfff','TAIL\ud800'])assert.ok(cold.raw_blocks.some(b=>b.bytes===hex(s)),s);
 assert.equal(cold.raw_watermarks[0].raw_next,0);
});
test('R2 same-description Symbols, cycles, nonplain nodes preserve all own data without getters',t=>{
 const f=fixture(t);let calls=0;const event={seq:0,text:'known'},a=Symbol('raw'),b=Symbol('raw');
 event[a]='HIDDEN\ud800';event[b]='OTHER\udfff';event.self=event;
 event.date=new Date(0);event.date.text='DATE\ud800';Object.defineProperty(event,'getter',{get(){calls++;throw Error('called');}});
 const r=f.put({fullSessionId:'s',event});assert.equal(calls,0);assert.equal(r.rawCommittedNextSeq,0);
 const cold=f.cold();for(const s of ['known','HIDDEN\ud800','OTHER\udfff','DATE\ud800'])assert.ok(cold.raw_blocks.some(b=>b.bytes===hex(s)),s);
 assert.equal(new Set(cold.raw_blocks.map(b=>b.path)).size,cold.raw_blocks.length);
 assert.equal(cold.raw_watermarks[0].raw_next,0);
});
test('R2 unsupported evidence/source never rolls back acquired original',t=>{
 const f=fixture(t);const r=f.put({fullSessionId:'s',event:{seq:0,text:'KEEP\ud800'},evidence:{optional:undefined,text:'EVIDENCE\udfff'},source:{bad:Symbol('s'),text:'SOURCE\ud800'}});
 assert.equal(r.rawCommittedNextSeq,1);const cold=f.cold();assert.ok(cold.raw_blocks.some(b=>b.bytes===hex('KEEP\ud800')));
 for(const s of ['EVIDENCE\udfff','SOURCE\ud800'])assert.ok(cold.raw_capture_blocks.some(b=>b.bytes===hex(s)));
 assert.equal(cold.raw_captures.filter(r=>['evidence','source'].includes(r.kind)).length,2);
});
test('R2 unknown identity and long string segmentation are durable and do not promote',t=>{
 const f=fixture(t),text='\ud800X\udfff'.repeat(30000);const event={text};event[Symbol('raw')]='UNRESOLVED\udfff';
 const r=f.put({fullSessionId:'s\ud800',event});assert.equal(r.classification,'unresolved');
 const cold=f.cold();assert.equal(cold.raw_watermarks[0].raw_next,0);assert.equal(cold.raw_events.length,0);
 const blocks=cold.raw_capture_blocks;const node=blocks.find(b=>b.bytes.startsWith(hex('\ud800X\udfff'))).node;
 const joined=Buffer.concat(blocks.filter(b=>b.node===node).sort((a,b)=>a.part-b.part).map(b=>Buffer.from(b.bytes,'hex')));
 assert.deepEqual(joined,utf16le(text));assert.ok(blocks.some(b=>b.bytes===hex('UNRESOLVED\udfff')));
 assert.equal(cold.raw_captures[0].classification,'capture-complete');
});
test('R2 node batches preserve all 50010 child code units and graph edges after cold restart',t=>{
 const f=fixture(t),event={seq:0,text:'BOUNDARY\ud800',wide:Array.from({length:50010},(_,i)=>({text:'CHILD-'+i+'\ud800X\udfff'}))};
 const r=f.put({fullSessionId:'s',event});assert.equal(r.rawCommittedNextSeq,0);
 const cold=f.cold();assert.ok(cold.raw_blocks.some(b=>b.bytes===hex('BOUNDARY\ud800')));
 const actual=new Set(cold.raw_blocks.map(b=>b.bytes));
 for(let i=0;i<50010;i++)assert.ok(actual.has(hex(event.wide[i].text)),'missing child '+i);
 assert.equal(cold.raw_captures[0].classification,'capture-complete');
 const nodes=new Set(cold.raw_capture_nodes.map(n=>n.node));
 for(const e of cold.raw_capture_edges){assert.ok(nodes.has(e.parent));assert.ok(nodes.has(e.target));}
 assert.equal(cold.raw_capture_blocks.length,50011);
 assert.ok(r.capture.batches>2);assert.ok(r.capture.peakBatchRows<=1024);
 assert.equal(cold.raw_watermarks[0].raw_next,0);
 console.log('node batch metrics '+JSON.stringify(r.capture));
});
test('R2 oversized identity text and property label retain segmented bytes',t=>{
 const f=fixture(t),text='X'.repeat(IDENTITY_LIMITS.bytes/2)+'\ud800',key='K'.repeat(33000)+'\udfff';
 const r=f.put({fullSessionId:'s',event:{seq:0,text,[key]:'LABEL-VALUE\ud800'}});assert.equal(r.rawCommittedNextSeq,0);
 const cold=f.cold(),blocks=cold.raw_capture_blocks,node=blocks.find(b=>b.bytes.startsWith(hex('XXXXX'))).node;
 assert.deepEqual(Buffer.concat(blocks.filter(b=>b.node===node).sort((a,b)=>a.part-b.part).map(b=>Buffer.from(b.bytes,'hex'))),utf16le(text));
 assert.deepEqual(Buffer.concat(cold.raw_capture_labels.sort((a,b)=>a.part-b.part).map(b=>Buffer.from(b.bytes,'hex'))),utf16le(key));
 assert.ok(cold.raw_blocks.some(b=>b.bytes===hex('LABEL-VALUE\ud800')));assert.equal(cold.raw_watermarks[0].raw_next,0);
});
test('R2 inherited toJSON getter and throwing reflection never erase acquired text',t=>{
 let calls=0;Object.defineProperty(Object.prototype,'toJSON',{configurable:true,get(){calls++;throw Error('getter called');}});
 try {assert.deepEqual(snapshotBytes({text:'OWN\ud800'}),utf16le('{"text":"OWN\\ud800"}'));assert.equal(calls,0);}
 finally {delete Object.prototype.toJSON;}
 const f=fixture(t),event={seq:0,text:'KEEP-TRAP\udfff',trap:new Proxy({},{ownKeys(){throw Error('trap');}})};
 assert.equal(f.put({fullSessionId:'s',event}).rawCommittedNextSeq,0);
 const cold=f.cold();assert.ok(cold.raw_blocks.some(b=>b.bytes===hex('KEEP-TRAP\udfff')));assert.equal(cold.raw_captures[0].classification,'capture-partial');
});
test('R2 property batches preserve tail and every shared alias after cold restart',t=>{
 const f=fixture(t),shared={},event={seq:0,text:'PROPERTY-LIMIT\ud800'};
 for(let i=0;i<200000;i++)event['p'+i]=shared;
 event.tail='PROPERTY-TAIL\udfff';
 const r=f.put({fullSessionId:'s',event});assert.equal(r.rawCommittedNextSeq,0);
 const cold=f.cold();assert.ok(cold.raw_blocks.some(b=>b.bytes===hex(event.tail)),'missing finite tail');
 assert.equal(cold.raw_capture_edges.length,200003);assert.equal(cold.raw_captures[0].classification,'capture-complete');
 const aliases=cold.raw_capture_edges.slice(2,200002);assert.equal(aliases.length,200000);
 assert.equal(new Set(aliases.map(e=>e.target)).size,1);assert.notEqual(aliases[0].target,null);
 const nodes=new Set(cold.raw_capture_nodes.map(n=>n.node));for(const e of cold.raw_capture_edges){assert.ok(nodes.has(e.parent));assert.ok(nodes.has(e.target));}
 assert.ok(cold.raw_blocks.some(b=>b.bytes===hex('PROPERTY-LIMIT\ud800')));assert.equal(cold.raw_watermarks[0].raw_next,0);
 assert.ok(r.capture.batches>2);assert.ok(r.capture.peakBatchRows<=1024);
 console.log('property batch metrics '+JSON.stringify(r.capture));
});
test('R2 multi-batch long labels, segments, cycles and metadata preserve graph identities',t=>{
 const f=fixture(t),label='L'.repeat(33000)+'\udfff',text='X'.repeat(32767)+'\ud800\udfff'+'Y'.repeat(32767)+'\ud800';
 const shared={text},event={seq:0,shared};let calls=0;
 for(let i=0;i<2100;i++)event['alias'+i]=shared;
 event.self=event;event[Symbol(label)]='SYMBOL-A\ud800';event[Symbol(label)]='SYMBOL-B\udfff';
 Object.defineProperty(event,'getter',{get(){calls++;throw Error('getter');}});
 const r=f.put({fullSessionId:'s\ud800',event,evidence:{bad:undefined,text:'META-A'},source:{bad:undefined,text:'META-B'}});
 assert.equal(calls,0);assert.equal(r.rawCommittedNextSeq,0);assert.ok(r.capture.batches>=3);
 const cold=f.cold(),id=r.capture.id,edges=cold.raw_capture_edges.filter(e=>e.capture_id===id);
 const aliases=edges.filter(e=>e.parent===0&&e.target===edges.find(e=>e.parent===0&&e.property===1).target);
 assert.equal(aliases.length,2101);assert.ok(edges.some(e=>e.parent===0&&e.target===0));
 const blocks=cold.raw_capture_blocks.filter(b=>b.capture_id===id),node=blocks.find(b=>b.bytes.startsWith(hex('XXXXX'))).node;
 assert.deepEqual(Buffer.concat(blocks.filter(b=>b.node===node).sort((a,b)=>a.part-b.part).map(b=>Buffer.from(b.bytes,'hex'))),utf16le(text));
 const groups=new Map();for(const b of cold.raw_capture_labels){if(!groups.has(b.property))groups.set(b.property,[]);groups.get(b.property).push(b);}
 assert.equal(groups.size,2);for(const g of groups.values())assert.deepEqual(Buffer.concat(g.sort((a,b)=>a.part-b.part).map(b=>Buffer.from(b.bytes,'hex'))),utf16le(label));
 for(const s of ['SYMBOL-A\ud800','SYMBOL-B\udfff','META-A','META-B'])assert.ok(cold.raw_capture_blocks.some(b=>b.bytes===hex(s)));
 const nodes=new Set(cold.raw_capture_nodes.map(n=>n.capture_id+':'+n.node));for(const e of cold.raw_capture_edges)if(e.target!==null)assert.ok(nodes.has(e.capture_id+':'+e.target));
 const batches=cold.raw_capture_batches.filter(b=>b.capture_id===id);
 assert.equal(batches.length,r.capture.batches);assert.equal(Math.max(...batches.map(b=>b.rows)),r.capture.peakBatchRows);
 assert.equal(Math.max(...batches.map(b=>b.payload_bytes)),r.capture.peakBatchBytes);
 for(const b of batches){assert.ok(b.rows<=1024);assert.ok(b.payload_bytes<=262144);assert.equal(b.state,'complete');}
});
test('R1 schema1 fixture stops untouched; explicit copy conversion preserves recoverable session keys',t=>{
 const f=fixture(t);f.put({fullSessionId:'plain-session',event:{seq:0,text:'MIGRATE\ud800'}});f.cold();
 let db=new DatabaseSync(f.file);for(const table of ['raw_events','raw_watermarks','raw_watermark_history','raw_invalidations','raw_unresolved'])db.exec('UPDATE '+table+' SET session_id=json_extract(session_id,\'$\')');db.exec('PRAGMA user_version=1');db.close();
 const hash=()=>createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),before=hash();
 assert.throws(()=>new RawRepository(f.file,f.lease),/unsupported-raw-schema:1/);assert.equal(hash(),before);
 const copy=f.file+'.fixture-copy';fs.copyFileSync(f.file,copy);db=new DatabaseSync(copy);
 db.exec('BEGIN IMMEDIATE');for(const table of ['raw_events','raw_watermarks','raw_watermark_history','raw_invalidations','raw_unresolved'])for(const row of db.prepare('SELECT rowid AS migration_rowid,session_id FROM '+table).all())if(row.session_id!==null)db.prepare('UPDATE '+table+' SET session_id=? WHERE rowid=?').run(JSON.stringify(row.session_id),row.migration_rowid);
 db.exec('PRAGMA user_version=2; COMMIT');db.close();
 const migrated=new RawRepository(copy,f.lease);assert.equal(migrated.ingest({fullSessionId:'plain-session',event:{seq:1,text:'NEXT'}}).rawCommittedNextSeq,2);migrated.close();assert.equal(hash(),before);
});
