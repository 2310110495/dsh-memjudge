import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DIMENSIONS, TEST_FILES, parseTapSummary, assessSuite, buildCapabilityReport, verifyEvidence } from '../scripts/capability-evidence.mjs';
const NL = String.fromCharCode(10);
const tap = (skip = 0) => ['TAP version 13', '1..1', '# tests 1', '# pass ' + (1 - skip), '# fail 0', '# cancelled 0', '# skipped ' + skip, '# todo 0', ''].join(NL);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mj-evidence-unit-'));
  fs.mkdirSync(path.join(dir, 'raw'));
  const suites = TEST_FILES.map(file => ({ file, log: 'raw/' + path.basename(file, '.test.mjs') + '.tap', exitCode: 0, signal: null, error: null, summary: parseTapSummary(tap()), status: 'pass', durationMs: 1 }));
  const artifacts = suites.map(s => {
    fs.writeFileSync(path.join(dir, s.log), tap());
    return { path: s.log, bytes: Buffer.byteLength(tap()), sha256: hash(tap()) };
  });
  const report = { version: 1, kind: 'development-regression-evidence', role: 'author', formalAcceptance: false, signedBy: null,
    source: [], sourceStable: true, regressionPassed: true, suites, artifacts, capabilities: buildCapabilityReport(suites) };
  const save = () => fs.writeFileSync(path.join(dir, 'development-evidence.json'), JSON.stringify(report));
  save();
  return { dir, report, save, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('TAP parser requires complete unique summary, plan and balanced counts', () => {
  assert.deepEqual(parseTapSummary(tap()), { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.ok(parseTapSummary(tap().replaceAll(NL, String.fromCharCode(13) + NL)));
  for (const invalid of ['', tap().replace('# todo 0' + NL, ''), tap() + '# tests 1' + NL, tap().replace('# pass 1', '# pass 2'), tap() + 'Bail out! broken' + NL, tap().replace('1..1' + NL, '')]) assert.equal(parseTapSummary(invalid), null);
});
test('nonzero, terminated, missing, empty, failing and todo results cannot pass', () => {
  const good = parseTapSummary(tap());
  assert.equal(assessSuite(0, null, null, good), 'pass');
  assert.equal(assessSuite(0, null, null, parseTapSummary(tap(1))), 'partial');
  for (const args of [[1, null, null, good], [null, 'SIGTERM', null, good], [0, null, 'ETIMEDOUT', good], [0, null, null, null], [0, null, null, { ...good, tests: 0 }], [0, null, null, { ...good, fail: 1 }], [0, null, null, { ...good, todo: 1 }]]) assert.equal(assessSuite(...args), 'fail');
});
test('twelve dimensions never convert local green regressions into formal acceptance', () => {
  assert.deepEqual(DIMENSIONS.map(d => d.id), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(TEST_FILES.length, new Set(TEST_FILES).size);
  const all = TEST_FILES.map(file => ({ file, log: 'fixture', status: 'pass', summary: parseTapSummary(tap()) }));
  const rows = buildCapabilityReport(all);
  assert.equal(rows.length, 12);
  assert.ok(rows.every(r => r.regression === 'pass' && r.formalAcceptance === null && r.limitation.length));
  assert.ok(buildCapabilityReport([]).every(r => r.regression === 'fail'));
  all.find(s => s.file === 'test/search.test.mjs').status = 'partial';
  assert.equal(buildCapabilityReport(all).find(r => r.id === 3).regression, 'partial');
});
test('artifact checker verifies full inventory and marks mismatching current source', () => {
  const f = fixture(); try { assert.deepEqual(verifyEvidence(f.dir), { artifacts: TEST_FILES.length, dimensions: 12, regressionPassed: true, sourceMatchesCurrent: false, formalAcceptance: false }); } finally { f.close(); }
});
for (const [name, mutate] of [
  ['altered bytes', f => fs.appendFileSync(path.join(f.dir, f.report.suites[0].log), 'changed')],
  ['missing raw file', f => fs.unlinkSync(path.join(f.dir, f.report.suites[0].log))],
  ['traversal', f => { f.report.artifacts[0].path = '../escape.tap'; f.save(); }],
  ['duplicate artifact', f => { f.report.artifacts[1] = f.report.artifacts[0]; f.save(); }],
  ['missing suite', f => { f.report.suites.pop(); f.save(); }],
  ['wrong log reuse', f => { f.report.suites[0].log = f.report.suites[1].log; f.save(); }],
  ['forged summary', f => { f.report.suites[0].summary.pass = 100; f.save(); }],
  ['forged suite verdict', f => { f.report.suites[0].exitCode = 1; f.save(); }],
  ['forged overall verdict', f => { f.report.regressionPassed = false; f.save(); }],
  ['self signing', f => { f.report.signedBy = 'verifier'; f.save(); }],
  ['formal pass', f => { f.report.formalAcceptance = true; f.save(); }],
  ['dimension promotion', f => { f.report.capabilities[0].formalAcceptance = true; f.save(); }],
]) test('artifact checker rejects ' + name, () => { const f = fixture(); try { mutate(f); assert.throws(() => verifyEvidence(f.dir)); } finally { f.close(); } });

test('artifact checker rejects linked raw directory', () => {
  const f = fixture();
  const other = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mj-evidence-linked-'));
  try {
    fs.renameSync(path.join(f.dir, 'raw'), path.join(other, 'raw'));
    fs.symlinkSync(path.join(other, 'raw'), path.join(f.dir, 'raw'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => verifyEvidence(f.dir), /link/);
  } finally { f.close(); fs.rmSync(other, { recursive: true, force: true }); }
});
