#!/usr/bin/env node
// 只读服务契约的端到端检查：真开一个库、真写 4 条记忆、真调 createService。
//
// 跑法：node scripts/check-service.mjs
// 三件事必须成立，否则退出码非 0：
//   1. 服务面上没有任何写方法（装配期自检 + 这里的二次断言）。
//   2. bySourcePrefix('auto:chat#abcdef12') 恰好回 3 条，异前缀的不进结果。
//   3. 结果按 created_at 升序——所以下面刻意用 t2 / t0 / t1 的乱序写入，
//      按写入顺序或按 rowid 排序都会翻车。
//
// 库落在临时 DSH_HOME 下，真库（~/.dsh/memjudge/memjudge.db）全程不打开。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { open } from '../src/store.mjs';
import { defaultDbPath } from '../src/index.mjs';
import {
  createService, SERVICE_NAME, SERVICE_VERSION, FORBIDDEN_METHODS,
} from '../src/service.mjs';

const PREFIX = 'auto:chat#abcdef12';
const OTHER = 'auto:chat#99999999-t0';
const T0 = Date.UTC(2026, 9, 27);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memjudge-svc-'));
// 真把 DSH_HOME 指到临时目录：下面断言库路径就是 defaultDbPath() 的产物，
// 证明「库里落哪儿」这条约定没被这个脚本绕过。
process.env.DSH_HOME = home;
const dbPath = defaultDbPath();
const realDb = path.join(os.homedir(), '.dsh', 'memjudge', 'memjudge.db');

if (dbPath !== path.join(home, 'memjudge', 'memjudge.db') || path.resolve(dbPath) === path.resolve(realDb)) {
  console.error(`库路径不合约定：${dbPath}`);
  process.exit(1);
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log(`memjudge 只读服务契约 — service ${SERVICE_NAME} v${SERVICE_VERSION}`);
console.log(`[1/4] 临时库：${dbPath}`);
console.log(`      真库 ${realDb} 未被打开（DSH_HOME=${home}）`);

const store = open(dbPath);
const api = createService(null, { store });

// 乱序写入：created_at 升序与插入顺序故意相反。
store.put({ text: '自动采集第三条：钟修好了。', source: `${PREFIX}-t2`, kind: 'event', createdAt: T0 + 3000 });
store.put({ text: '别的前缀：另一个会话。', source: OTHER, kind: 'event', createdAt: T0 + 1500 });
store.put({ text: '自动采集第一条：钟摆停在七点。', source: `${PREFIX}-t0`, kind: 'event', createdAt: T0 + 1000 });
store.put({ text: '自动采集第二条：齿轮缺了一颗。', source: `${PREFIX}-t1`, kind: 'event', createdAt: T0 + 2000 });
console.log(`[2/4] 写入 4 条记忆（3 条 ${PREFIX}*，1 条 ${OTHER}），插入顺序 t2 → 异前缀 → t0 → t1`);

const rows = api.bySourcePrefix(PREFIX);
console.log(`[3/4] bySourcePrefix('${PREFIX}') → ${rows.length} 条`);
for (const [i, r] of rows.entries()) {
  console.log(`       ${i + 1}. ${r.source}  created_at=${r.createdAt}  ${r.text}`);
}

check('服务面不含任何写方法', () => {
  const re = new RegExp(FORBIDDEN_METHODS.join('|'), 'i');
  const keys = Object.keys(api);
  for (const key of keys) {
    if (re.test(key)) throw new Error(`服务面出现写方法「${key}」`);
  }
  if (!Object.isFrozen(api)) throw new Error('服务对象未冻结');
});

check('恰好 3 条（异前缀不进结果）', () => {
  if (rows.length !== 3) throw new Error(`期望 3 条，实际 ${rows.length} 条`);
  if (rows.some((r) => r.source === OTHER)) throw new Error('异前缀 ${OTHER} 混进了结果');
});

check('source 顺序为 t0 → t1 → t2（创建时间升序）', () => {
  const want = [`${PREFIX}-t0`, `${PREFIX}-t1`, `${PREFIX}-t2`];
  const got = rows.map((r) => r.source);
  if (got.join('|') !== want.join('|')) throw new Error(`实际顺序 ${got.join(' → ')}`);
});

check('created_at 单调升序', () => {
  for (let i = 1; i < rows.length; i += 1) {
    if (!(rows[i].createdAt > rows[i - 1].createdAt)) {
      throw new Error(`第 ${i} 条 created_at=${rows[i].createdAt} 未大于前一条 ${rows[i - 1].createdAt}`);
    }
  }
});

check('返回形状带原文，可直接给下游用', () => {
  for (const r of rows) {
    if (typeof r.text !== 'string' || !r.text) throw new Error(`${r.source} 缺 text`);
    if (r.kind !== 'event') throw new Error(`${r.source} kind 归一化失败：${r.kind}`);
  }
});

console.log(`[4/4] 服务面：${Object.keys(api).sort().join(', ')}；库体 ${api.stats().memories} 条`);
store.close();
fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });

if (failures > 0) {
  console.error(`\n检查未通过：${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过：3 条同前缀记忆按 created_at 升序返回，异前缀与写方法均未混入。');
