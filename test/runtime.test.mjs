import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assertRuntime, assertSQLiteCapabilities, NODE_RANGE } from '../src/runtime.mjs';
test('runtime range rejects API-incomplete Node versions and malformed versions', () => {
  for (const v of ['20.19.0','22.5.0','22.15.0','23.9.0','24','garbage','24.0.0-rc.1']) assert.throws(() => assertRuntime(v), /requires Node/);
});
test('runtime range accepts supported LTS floor and current runtime', () => {
  for (const v of ['22.16.0','22.99.0','24.0.0','26.1.0',process.versions.node]) assert.doesNotThrow(() => assertRuntime(v));
});
test('SQLite API guard verifies memory-only transaction state before disk access', () => {
  assert.doesNotThrow(() => assertSQLiteCapabilities(DatabaseSync));
  for (const p of [null,{}, {prepare(){},exec(){},close(){},isTransaction:false}]) assert.throws(() => assertSQLiteCapabilities(p), /DatabaseSync.isTransaction/);
});
test('host and package Node promises share the runtime contract', () => {
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.engines.node,NODE_RANGE);
  assert.equal(pkg.dsh.compatibility.node,NODE_RANGE);
});
