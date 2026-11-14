// Source regression gate, not the twelve-capability or live-host acceptance.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertRuntime } from '../src/runtime.mjs';
assertRuntime();
const root = fileURLToPath(new URL('../', import.meta.url));
const syntaxOnly = process.argv.includes('--syntax-only');
const runtime = ['client.js', ...fs.readdirSync(path.join(root,'src')).filter(n=>n.endsWith('.mjs')).map(n=>'src/'+n)];
for (const rel of runtime) {
  const p=spawnSync(process.execPath,['--check',path.join(root,rel)],{stdio:'inherit'});
  if (p.status !== 0) process.exit(p.status || 1);
}
console.log('SYNTAX_FILES=' + runtime.length);
if (!syntaxOnly) {
  const tests=fs.readdirSync(path.join(root,'test')).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'test/'+n);
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'mj-verify-'));
  const env={...process.env};
  for(const key of Object.keys(env)) if(key.startsWith('MEMJUDGE_') || key==='NODE_OPTIONS') delete env[key];
  Object.assign(env,{DSH_HOME:home,DSH_WORKBENCH_HOME:home,MEMJUDGE_TEST_LIVE_DB:'0'});
  try {
    console.log('TEST_FILES=' + tests.length + '; private live fixture disabled; per-worker isolated home');
    const p=spawnSync(process.execPath,['--import','./test/observability-isolation.mjs','--test','--test-reporter=tap','--test-concurrency=1',...tests],{cwd:root,env,stdio:'inherit'});
    process.exitCode=p.status ?? 1;
  } finally {fs.rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}
