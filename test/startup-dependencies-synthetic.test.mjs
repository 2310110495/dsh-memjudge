import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupDependencies } from '../src/startup-dependencies.mjs';

const names = ['storeFactory', 'maxChars', 'storageLimitBytes', 'installRpc', 'autoCapture',
  'defaultDbPath', 'configReport', 'embedDims', 'expand', 'select'];

test('explicit providers replace defaults without invoking either during resolution', () => {
  const calls = [];
  const defaults = Object.fromEntries(names.map(name => [name, () => { throw Error(`default called: ${name}`); }]));
  const overrides = Object.fromEntries(names.map(name => [name, (...args) => { calls.push([name, ...args]); return name; }]));
  const deps = startupDependencies(defaults, overrides);
  assert.deepEqual(calls, []);
  for (const name of names) assert.equal(deps[name]('synthetic'), name);
  assert.deepEqual(calls, names.map(name => [name, 'synthetic']));
});

test('defaults remain available and invalid explicit dependencies fail immediately', () => {
  const defaults = Object.fromEntries(names.map(name => [name, () => name]));
  const deps = startupDependencies(defaults);
  for (const name of names) assert.equal(deps[name](), name);
  for (const name of names) {
    assert.throws(() => startupDependencies(defaults, { [name]: undefined }), new RegExp(`invalid startup dependency: ${name}`));
  }
});
