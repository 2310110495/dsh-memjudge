import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/store.mjs';

test('unchanged getters avoid full memory scans but raw SQL still refreshes facts', () => {
  const s=open(':memory:');
  try {
    const m=s.put({text:'核心网关监听端口为8080。'});
    s.get(m.id);
    const db=s.raw(), prepare=db.prepare.bind(db);let scans=0;
    db.prepare=(sql,...rest)=>{if(String(sql).includes('quote(rowid) AS r'))scans++;return prepare(sql,...rest);};
    for(let i=0;i<20;i++){s.get(m.id);s.allFacts();}
    assert.equal(scans,0,'unchanged reads must not rescan every memory');
    db.prepare('UPDATE main.memories SET text=?,facts_json=? WHERE id=?').run('核心网关监听端口为9090。','[]',m.id);
    assert.ok(s.allFacts().some(f=>String(f.value)==='9090'));
    assert.ok(scans>0,'same-connection raw SQL invalidates derived state');
  } finally {s.close();}
});

test('peer commits refresh facts even without a data_generation bump', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mj-fresh-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const file=path.join(dir,'test.db'),s=open(file);let peer;
  try {
    const m=s.put({text:'核心网关监听端口为8080。'});s.allFacts();
    peer=new DatabaseSync(file);
    peer.prepare('UPDATE main.memories SET text=?,facts_json=? WHERE id=?').run('核心网关监听端口为7070。','[]',m.id);
    assert.ok(s.allFacts().some(f=>String(f.value)==='7070'));
  } finally {peer?.close();s.close();}
});

for (const duringWrite of [false,true]) test('peer commit at publication boundary is not swallowed; write='+duringWrite, t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mj-epoch-race-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const file=path.join(dir,'test.db'),s=open(file);let peer;
 try {
  const m=s.put({text:'核心网关监听端口为8080。'});s.allFacts();peer=new DatabaseSync(file);
  const update=value=>peer.prepare('UPDATE main.memories SET text=?,facts_json=? WHERE id=?').run('核心网关监听端口为'+value+'。','[]',m.id);
  if(!duringWrite)update(9090);
  const db=s.raw(),exec=db.exec.bind(db);let fired=false;
  db.exec=sql=>{const out=exec(sql);if(sql==='COMMIT'&&!fired){fired=true;update(7070);}return out;};
  if(duringWrite)s.put({text:'另一个服务的颜色是蓝色。'});else s.allFacts();
  assert.equal(fired,true);
  assert.ok(s.allFacts().some(f=>String(f.value)==='7070'),'next getter must observe commit after snapshot publication');
 }finally{peer?.close();s.close();}
});

test('same-connection schema DDL cannot bypass missing-table validation',()=>{
 const s=open(':memory:');try{
  s.put({text:'核心网关监听端口为8080。'});s.allFacts();
  s.raw().exec('ALTER TABLE main.meta RENAME TO obsolete_meta');
  assert.throws(()=>s.allFacts(),/meta/);
 }finally{s.close();}
});

test('facts-only SQL and rolled-back caller writes do not poison derived cache',()=>{
 const s=open(':memory:');try{
  const m=s.put({text:'核心网关监听端口为8080。'});s.allFacts();const db=s.raw();
  const fact={...s.allFacts()[0],value:'9191'};
  db.prepare('UPDATE main.memories SET facts_json=? WHERE id=?').run(JSON.stringify([fact]),m.id);
  assert.ok(s.allFacts().some(f=>f.value==='9191'));
  db.exec('BEGIN');db.prepare('UPDATE main.memories SET text=?,facts_json=? WHERE id=?').run('核心网关监听端口为6060。','[]',m.id);
  assert.throws(()=>s.allFacts(),/idle connection/);db.exec('ROLLBACK');
  assert.ok(s.allFacts().some(f=>f.value==='9191'));
 }finally{s.close();}
});

test('startup stamp cannot certify an earlier cache after a peer write',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mj-start-race-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const file=path.join(dir,'test.db');let s=open(file);const m=s.put({text:'核心网关监听端口为8080。'});s.close();
 const peer=new DatabaseSync(file),original=DatabaseSync.prototype.prepare;let fired=false,snapshotSeen=false;
 DatabaseSync.prototype.prepare=function(sql,...args){
  const stmt=original.call(this,sql,...args);
  if(this===peer)return stmt;
  if(String(sql).includes('quote(rowid) AS r'))snapshotSeen=true;
  if(!fired&&snapshotSeen&&sql==='PRAGMA data_version'){
   const get=stmt.get.bind(stmt);
   stmt.get=(...params)=>{const value=get(...params);if(!fired){
    fired=true;peer.prepare('UPDATE main.memories SET text=?,facts_json=? WHERE id=?').run('核心网关监听端口为5050。','[]',m.id);
   }return value;};
  }
  return stmt;
 };
 try{s=open(file);assert.equal(fired,true);assert.ok(s.allFacts().some(f=>f.value==='5050'));}
 finally{DatabaseSync.prototype.prepare=original;peer.close();s?.close();}
});
