import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(!process.env.RAW_CORE_ISOLATED)throw Error('isolated launcher required');
const script=fileURLToPath(new URL('./raw-batch.fixture.mjs',import.meta.url));
const args=(mode,root,stage)=>['--import',process.env.RAW_TEST_GUARD,script,mode,root,stage];
for(const stage of ['throw-batch','mid-batch','before-commit','after-commit'])test('R2 atomic multi-batch fault and cold recovery: '+stage,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'batch-fault-'));
 if(stage==='throw-batch'){
  const r=spawnSync(process.execPath,args('write',root,stage),{env:process.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout);assert.equal(v.returned,false);assert.equal(v.batches,3);
 }else{
  const p=spawn(process.execPath,args('write',root,stage),{env:process.env,stdio:['ignore','pipe','pipe']});
  let output='',stderr='';p.stderr.on('data',b=>stderr+=b);
  const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',(code,signal)=>resolve({code,signal}));});
  t.after(async()=>{p.kill('SIGKILL');await done;});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('barrier timeout '+stderr)),45000);p.stdout.on('data',b=>{output+=b;if(output.includes('\n')){clearTimeout(timer);resolve();}});p.on('close',()=>{clearTimeout(timer);if(!output.includes('\n'))reject(Error('early exit '+stderr));});});
  assert.equal(JSON.parse(output.trim()).barrier,stage);p.kill('SIGKILL');await done;
 }
 const cold=spawnSync(process.execPath,args('cold',root,stage),{env:process.env,encoding:'utf8',timeout:45000});
 assert.equal(cold.status,0,cold.stderr);const result=JSON.parse(cold.stdout);assert.equal(result.integrity,'ok');assert.equal(result.verified,true);
 console.log('batch recovery '+JSON.stringify({stage,...result}));
});
