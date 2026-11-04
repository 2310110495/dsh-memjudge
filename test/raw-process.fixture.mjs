import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openNamespace} from '../src/raw-namespace.mjs';
import {RawRepository} from '../src/raw-repository.mjs';
if (!process.env.RAW_CORE_ISOLATED) throw Error('isolated launcher required');
const [mode, root, stage, id='0'] = process.argv.slice(2);
const opts={directory:path.join(root,'data'),registryRoot:path.join(root,'registry'),sourceRoot:path.join(root,'source'),instanceId:'fixture',writable:true};
const say=x=>fs.writeSync(1,JSON.stringify(x)+'\n');
function barrier(name) {
  say({barrier:name,id});
  const wait=new Int32Array(new SharedArrayBuffer(4));
  const until=Date.now()+15000;
  while(!fs.existsSync(path.join(root,'release-'+name+'-'+id))){if(Date.now()>until)throw Error('fixture-barrier-timeout:'+name);Atomics.wait(wait,0,0,10);}
}
try {
  if(mode==='namespace'){
    const link=fs.linkSync;
    fs.linkSync=function(a,b){
      if(b===path.join(opts.directory,'namespace.json')){
        barrier('publish');
        const result=link.apply(this,arguments);
        if(stage==='after-link')barrier('linked');
        return result;
      }
      return link.apply(this,arguments);
    };
    try {const lease=openNamespace(opts);say({acquired:lease.namespace,directorySync:lease.directorySync});barrier('held');lease.close();say({closed:true});}
    catch(e){if(e.code!=='EEXIST')throw e;const lease=openNamespace({...opts,writable:false});say({contended:lease.namespace});}
  } else if(mode==='crash') {
    const lease=openNamespace(opts),repo=new RawRepository(path.join(root,'data','raw.sqlite'),lease);
    const exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT' && stage==='before-commit')barrier(stage);const r=exec.call(this,sql);if(sql==='COMMIT' && stage==='after-commit')barrier(stage);return r;};
    DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql),run=stmt.run;stmt.run=function(...args){const r=run.apply(this,args);if(sql.startsWith(stage))barrier('sql');return r;};return stmt;};
    repo.ingest({fullSessionId:'full/session',event:{seq:0,type:'message',message:{role:'user',content:'\ufeff raw\r\n\ud800X\udfff'}},source:{file:'fixture-source'},evidence:{capture:'fixture-evidence'}});
    throw Error('crash-target-not-reached');
  } else if(mode==='cold') {
    const db=new DatabaseSync(path.join(root,'data','raw.sqlite'),{readOnly:true});
    const tables=['raw_events','raw_versions','raw_blocks','raw_sources','raw_evidence','raw_receipts','raw_watermarks','raw_watermark_history'];
    const rows={};for(const table of tables)rows[table]=db.prepare('SELECT * FROM '+table).all().map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v instanceof Uint8Array?{hex:Buffer.from(v).toString('hex')}:v])));
    say({rows,integrity:db.prepare('PRAGMA integrity_check').get().integrity_check});db.close();
  } else if(mode==='acquire') {
    const lease=openNamespace(opts);say({acquired:lease.namespace});lease.assertWritable();lease.close();
  } else throw Error('bad-fixture-mode');
} catch(e){say({error:e.message,code:e.code});process.exitCode=1;}
