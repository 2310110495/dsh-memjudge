import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';
import { CORE_TABLES } from '../src/strict-schema.mjs';
const q=s=>'"'+s.replaceAll('"','""')+'"';
function snapshot(db) {
  return Object.fromEntries(CORE_TABLES.map(name=>[name,db.prepare('SELECT * FROM main.'+q(name)+' ORDER BY rowid').all()]));
}
function legacy(t,{mixed=false,bad=false,orphan=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mj-strict-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const file=path.join(dir,'old.db'), seed=open(':memory:');
  const raw=seed.raw();
  seed.put({text:'原文「不改字」🧪\n第二行',category:'experience'});
  const id=raw.prepare('SELECT id FROM main.memories LIMIT 1').get().id;
  raw.prepare('INSERT INTO main.memory_revisions(memory_id,space_id,prev_text,prev_hash,reason,changed_at) VALUES(?,?,?,?,?,?)').run(id,'global','旧原文🧪','hash','test',100);
  raw.prepare('INSERT INTO main.entity_slots(memory_id,space_id,entity,attr,value,created_at) VALUES(?,?,?,?,?,?)').run(id,'global','星河项目','重试次数','3',100);
  raw.prepare('INSERT INTO main.vectors VALUES(?,?,?,?,?,?,?,?)').run(id,'global','fake',3,1,new Uint8Array([0,128,255]),'hash',100);
  raw.prepare('INSERT INTO main.wiki_pages VALUES(?,?,?,?,?,?,?,?,?)').run('wiki','global','slug','title','summary🧪','[]',1,2,100);
  raw.prepare('INSERT INTO main.ingest_queue(space_id,session_id,turn_no,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('global','s',1,'{"sentinel":true}',100,100);
  raw.exec("UPDATE main.sqlite_sequence SET seq=1000 WHERE name='memory_revisions'");
  const db=new DatabaseSync(file);
  const objects=raw.prepare("SELECT type,name,sql FROM main.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC").all();
  for(const name of CORE_TABLES) {
    const sql=objects.find(o=>o.type==='table'&&o.name===name).sql;
    db.exec(mixed&&name==='memories'?sql:sql.replace(/ STRICT$/,''));
    const rows=raw.prepare('SELECT * FROM main.'+q(name)).all();
    if(rows.length){const cols=Object.keys(rows[0]);const st=db.prepare('INSERT INTO '+q(name)+'('+cols.map(q).join(',')+') VALUES('+cols.map(()=>'?').join(',')+')');for(const row of rows)st.run(...cols.map(c=>row[c]));}
  }
  for(const obj of objects.filter(o=>o.type==='index'))db.exec(obj.sql);
  db.exec("UPDATE sqlite_sequence SET seq=1000 WHERE name='memory_revisions'; CREATE INDEX custom_text_index ON memories(source); CREATE TRIGGER custom_touch AFTER UPDATE OF source ON memories BEGIN INSERT OR REPLACE INTO meta VALUES('custom_touch','yes'); END;");
  if(bad)db.exec("UPDATE memories SET access_count='not-an-integer'");
  if(orphan)db.exec("PRAGMA foreign_keys=OFF; UPDATE vectors SET memory_id='missing'");
  const before=snapshot(db);db.close();seed.close();
  return {file,before,id};
}
test('fresh schema has eight STRICT tables and rejects wrong storage class',()=>{
 const s=open(':memory:');try{assert.equal(s.raw().prepare('PRAGMA main.table_list').all().filter(t=>CORE_TABLES.includes(t.name)&&t.strict===1).length,8);assert.throws(()=>s.raw().exec("INSERT INTO main.meta VALUES('bad',x'ff')"));}finally{s.close();}
});
for(const mixed of [false,true])test('non-STRICT v8 migration preserves all eight tables, custom schema and high water; mixed='+mixed,t=>{
 const {file,before,id}=legacy(t,{mixed});
 for(let i=0;i<3;i++){const s=open(file);try{assert.deepEqual(snapshot(s.raw()),before);assert.equal(s.raw().prepare('PRAGMA main.table_list').all().filter(t=>CORE_TABLES.includes(t.name)&&t.strict===1).length,8);assert.equal(s.raw().prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(s.raw().prepare("SELECT seq FROM main.sqlite_sequence WHERE name='memory_revisions'").get().seq,1000);assert.ok(s.raw().prepare("SELECT 1 FROM main.sqlite_master WHERE name='custom_touch'").get());}finally{s.close();}}
 const bak=new DatabaseSync(file+'.v8.bak',{readOnly:true});try{assert.deepEqual(snapshot(bak),before);assert.ok(bak.prepare('PRAGMA main.table_list').all().some(t=>CORE_TABLES.includes(t.name)&&t.strict===0));}finally{bak.close();}
 const s=open(file);try{s.raw().prepare('DELETE FROM main.memories WHERE id=?').run(id);assert.equal(s.raw().prepare('SELECT count(*) n FROM main.vectors').get().n,0);}finally{s.close();}
});
for(const kind of ['bad','orphan'])test('invalid legacy '+kind+' fails closed with logical rollback and complete backup',t=>{
 const {file,before}=legacy(t,{[kind]:true});assert.throws(()=>open(file),/cannot store|foreign key|storage classes|constraint/i);
 const db=new DatabaseSync(file,{readOnly:true});try{assert.deepEqual(snapshot(db),before);assert.ok(db.prepare('PRAGMA main.table_list').all().some(r=>CORE_TABLES.includes(r.name)&&r.strict===0));}finally{db.close();}
 assert.ok(fs.existsSync(file+'.v8.bak'));assert.throws(()=>open(file),/backup already exists/);
});
test('preexisting v8 backup refuses migration without overwriting bytes',t=>{const {file,before}=legacy(t);fs.writeFileSync(file+'.v8.bak','do-not-overwrite');assert.throws(()=>open(file),/backup already exists/);assert.equal(fs.readFileSync(file+'.v8.bak','utf8'),'do-not-overwrite');const d=new DatabaseSync(file);try{assert.deepEqual(snapshot(d),before);}finally{d.close();}});
