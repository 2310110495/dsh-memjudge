import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {openNamespace} from '../src/raw-namespace.mjs';
import {RawRepository} from '../src/raw-repository.mjs';
if(!process.env.RAW_CORE_ISOLATED)throw Error('isolated launcher required');
const [mode,root,stage]=process.argv.slice(2),file=path.join(root,'data/raw.sqlite');
const say=v=>fs.writeSync(1,JSON.stringify(v)+'\n');
if(mode==='cold'){
 const db=new DatabaseSync(file,{readOnly:true});
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
 const counts=Object.fromEntries(tables.map(({name})=>[name,db.prepare('SELECT count(*) n FROM '+name).get().n]));
 if(stage==='after-commit'){
  const blocks=db.prepare('SELECT node,part,bytes FROM raw_capture_blocks ORDER BY node,part').all(),texts=new Map();
  for(const b of blocks){if(!texts.has(b.node))texts.set(b.node,[]);texts.get(b.node).push(Buffer.from(b.bytes));}
  const actual=new Set([...texts.values()].map(parts=>Buffer.concat(parts).toString('hex')));
  for(let i=0;i<50010;i++)assert.ok(actual.has(Buffer.from('CHILD-'+i+'\ud800X\udfff','utf16le').toString('hex')),'missing child '+i);
  assert.equal(db.prepare('SELECT count(*) n FROM raw_capture_edges e LEFT JOIN raw_capture_nodes n ON n.capture_id=e.capture_id AND n.node=e.target WHERE e.target IS NOT NULL AND n.node IS NULL').get().n,0);
  assert.equal(db.prepare('SELECT raw_next FROM raw_watermarks').get().raw_next,0);
  assert.equal(db.prepare("SELECT count(*) n FROM raw_capture_batches WHERE state!='complete'").get().n,0);
 }else for(const n of Object.values(counts))assert.equal(n,0);
 say({counts,integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,verified:true});db.close();
}else{
 const lease=openNamespace({directory:path.join(root,'data'),registryRoot:path.join(root,'registry'),sourceRoot:root,instanceId:'fixture',writable:true});
 const repo=new RawRepository(file,lease),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
 function stop(){say({barrier:stage});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);throw Error('kill not delivered');}
 let batches=0,returned=false;
 DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql),run=stmt.run;stmt.run=function(...args){const r=run.apply(this,args);if(sql.startsWith('INSERT INTO raw_capture_batches')&&++batches===3){if(stage==='throw-batch')throw Error('fixture-batch-failure');if(stage==='mid-batch')stop();}return r;};return stmt;};
 DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&stage==='before-commit')stop();const r=exec.call(this,sql);if(sql==='COMMIT'&&stage==='after-commit')stop();return r;};
 try{repo.ingest({fullSessionId:'s\ud800',event:{seq:0,text:'HEAD',wide:Array.from({length:50010},(_,i)=>({text:'CHILD-'+i+'\ud800X\udfff'}))}});returned=true;throw Error('fault not reached');}
 catch(e){if(stage!=='throw-batch'||e.message!=='fixture-batch-failure')throw e;say({thrown:e.message,returned,batches});}
 finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;repo.close();lease.close();}
}
