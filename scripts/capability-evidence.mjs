// Development evidence collector: NOT docs/SPEC.md formal twelve-capability acceptance.
// Executes only checked-in local tests; never imports an arbitrary adapter or disabled mem-eval runner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertRuntime } from '../src/runtime.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const DIMENSIONS = Object.freeze([
  [1, '存得准', ['store', 'text-wellformed', 'strict-migration'], '缺正式20章重建、8句保真及独立签字'],
  [2, '原样回原文', ['read-by-id', 'recall-truncation', 'long-recall-position'], '缺正式F1-F8完整返回与原评分'],
  [3, '找得回', ['search', 'recall-scope-boundary'], '本地夹具不是SPEC原始题库与3a/3b协议'],
  [4, '标准答案命中', ['search', 'v2-search-inject'], '缺SPEC原评分的单轮/多轮与逐题raw输出'],
  [5, '不会编', ['evidence-quote', 'injection-evidence'], '有限反例不是任意自然语言或真实模型准确率认证'],
  [6, '没有就说没有', ['judge', 'v2-release-evidence-generalization'], '缺正式H1-H6与deny parity及人工复核'],
  [7, '占多大地方', ['v2-e2e-1000turns'], '千轮256KiB夹具不是SPEC20章200KiB存储协议'],
  [8, '单次上下文开销', ['budget-utf16', 'inject-surrogate', 'v2-search-inject'], '插件字符上限不等于宿主最终tokens或正式逐题协议'],
  [9, '会改自己', ['v2-store-schema-v8', 'v2-turn-distiller'], '缺正式M1-M3及保留历史交叉检查'],
  [10, '矛盾发现并改变', ['document-conflicts', 'v2-scope-slots'], '缺正式C1-C4与仅ch15/ch19短路反证'],
  [11, '按天折算', ['decay-mode', 'retrieval-port'], '公式/受控时钟回归不是SPEC92题90天实测留存曲线'],
  [12, '逐渐遗忘', ['layer', 'v2-lifecycle-wiki'], '缺正式冷条目30天top3降权与逐项decline产物'],
].map(([id, name, tests, gap]) => Object.freeze({ id, name, tests: Object.freeze(tests.map(t => 'test/' + t + '.test.mjs')), gap })));
export const TEST_FILES = Object.freeze([...new Set(DIMENSIONS.flatMap(d => d.tests))].sort());

export function parseTapSummary(text) {
  const fields = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const rows = [...text.matchAll(new RegExp('^# ' + key + ' (\\d+)\\r?$', 'gm'))];
    if (rows.length !== 1) return null;
    fields[key] = Number(rows[0][1]);
    if (!Number.isSafeInteger(fields[key])) return null;
  }
  if (!/^1\.\.[0-9]+\r?$/m.test(text) || /^Bail out!/m.test(text)) return null;
  if (fields.tests !== fields.pass + fields.fail + fields.cancelled + fields.skipped + fields.todo) return null;
  return fields;
}

export function assessSuite(exitCode, signal, error, summary) {
  if (exitCode !== 0 || signal || error || !summary || summary.tests === 0 || summary.fail || summary.cancelled || summary.todo) return 'fail';
  return summary.skipped ? 'partial' : 'pass';
}

export function buildCapabilityReport(suites) {
  const byFile = new Map(suites.map(s => [s.file, s]));
  return DIMENSIONS.map(d => {
    const found = d.tests.map(f => byFile.get(f));
    const regression = found.some(s => !s || s.status === 'fail') ? 'fail' : found.some(s => s.status === 'partial') ? 'partial' : 'pass';
    return { id: d.id, name: d.name, regression, formalAcceptance: null, status: 'pending-independent-spec-acceptance',
      measured: { suites: found.filter(Boolean).length, requiredSuites: d.tests.length },
      evidence: found.filter(Boolean).map(s => ({ file: s.file, log: s.log, summary: s.summary })), limitation: d.gap };
  });
}

function canonicalDirectory(dir) {
  if (!path.isAbsolute(dir)) throw new Error('output parent must be absolute');
  const absolute = path.resolve(dir);
  const normalize = s => process.platform === 'win32' ? s.toLowerCase() : s;
  if (!fs.lstatSync(absolute).isDirectory() || normalize(fs.realpathSync(absolute)) !== normalize(absolute)) throw new Error('output parent must be a real directory without symlink ancestors');
  return absolute;
}
function sourceInventory() {
  const names = ['package.json', 'client.js', 'docs/SPEC.md', 'scripts/verify.mjs', 'scripts/capability-evidence.mjs'];
  for (const directory of ['src', 'test']) {
    for (const name of fs.readdirSync(path.join(ROOT, directory)).sort()) if (name.endsWith('.mjs')) names.push(directory + '/' + name);
  }
  return names.sort().map(file => ({ file, sha256: digest(fs.readFileSync(path.join(ROOT, file))) }));
}
function cleanChildEnv(home) {
  // Do not inherit API keys, proxy credentials, NODE_OPTIONS, live-DB opt-ins or host settings.
  const env = { HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_WORKBENCH_HOME: home,
    TEMP: home, TMP: home, TMPDIR: home, MEMJUDGE_TEST_LIVE_DB: '0' };
  for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

export function verifyEvidence(directory) {
  const root = canonicalDirectory(directory);
  const reportPath = path.join(root, 'development-evidence.json');
  if (fs.lstatSync(reportPath).isSymbolicLink()) throw new Error('linked report refused');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.version !== 1 || report.kind !== 'development-regression-evidence' || report.role !== 'author' || report.formalAcceptance !== false || report.signedBy !== null) throw new Error('not an unsigned development report');
  if (!Array.isArray(report.suites) || !Array.isArray(report.source)) throw new Error('missing suite/source inventory');
  if (!Array.isArray(report.artifacts) || !report.artifacts.length) throw new Error('missing artifacts');
  const seen = new Set();
  for (const item of report.artifacts) {
    if (!/^raw\/[a-z0-9-]+\.tap$/.test(item.path) || seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('invalid artifact entry');
    seen.add(item.path);
    const full = path.join(root, item.path);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== full) throw new Error('artifact link refused');
    const bytes = fs.readFileSync(full);
    if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error('artifact changed: ' + item.path);
  }
  if (report.artifacts.length !== TEST_FILES.length) throw new Error('artifact inventory incomplete');
  if (report.suites.length !== TEST_FILES.length || report.suites.some((s, i) => s.file !== TEST_FILES[i])) throw new Error('suite inventory incomplete');
  for (const suite of report.suites) {
    if (suite.log !== 'raw/' + path.basename(suite.file, '.test.mjs') + '.tap' || !seen.has(suite.log)) throw new Error('suite has no unique expected artifact');
    const text = fs.readFileSync(path.join(root, suite.log), 'utf8');
    if (JSON.stringify(parseTapSummary(text)) !== JSON.stringify(suite.summary) || assessSuite(suite.exitCode, suite.signal, suite.error, suite.summary) !== suite.status) throw new Error('suite summary disagrees with raw evidence');
  }
  if (JSON.stringify(buildCapabilityReport(report.suites)) !== JSON.stringify(report.capabilities)) throw new Error('capability mapping disagrees with suites');
  const passed = report.sourceStable === true && report.suites.every(s => s.status !== 'fail');
  if (report.regressionPassed !== passed) throw new Error('regression verdict disagrees');
  const sourceMatchesCurrent = JSON.stringify(report.source) === JSON.stringify(sourceInventory());
  return { artifacts: seen.size, dimensions: report.capabilities.length, regressionPassed: passed, sourceMatchesCurrent, formalAcceptance: false };
}

export function runEvidence(parent = os.tmpdir()) {
  assertRuntime();
  const output = fs.mkdtempSync(path.join(canonicalDirectory(parent), 'memjudge-development-evidence-'));
  const raw = path.join(output, 'raw');
  fs.mkdirSync(raw);
  const source = sourceInventory();
  const suites = [];
  for (const file of TEST_FILES) {
    const name = path.basename(file, '.test.mjs');
    const log = 'raw/' + name + '.tap';
    const fd = fs.openSync(path.join(output, log), 'wx');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-evidence-home-'));
    let child;
    const start = performance.now();
    try {
      child = spawnSync(process.execPath, ['--import', './test/observability-isolation.mjs', '--test', '--test-reporter=tap', file],
        { cwd: ROOT, env: cleanChildEnv(home), stdio: ['ignore', fd, fd], timeout: 300000 });
    } finally {
      fs.closeSync(fd);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    const summary = parseTapSummary(fs.readFileSync(path.join(output, log), 'utf8'));
    const error = child.error ? String(child.error.code || child.error.message) : null;
    const suite = { file, log, exitCode: child.status, signal: child.signal, error, summary, durationMs: Math.round(performance.now() - start) };
    suite.status = assessSuite(suite.exitCode, suite.signal, error, summary);
    suites.push(suite);
    console.log(JSON.stringify({ file, status: suite.status, summary }));
  }
  const artifacts = fs.readdirSync(raw).sort().map(name => {
    const bytes = fs.readFileSync(path.join(raw, name));
    return { path: 'raw/' + name, bytes: bytes.length, sha256: digest(bytes) };
  });
  const sourceStable = JSON.stringify(source) === JSON.stringify(sourceInventory());
  const report = { version: 1, kind: 'development-regression-evidence', specReference: 'spec-1.2', protocol: 'local-regression-not-SPEC-benchmark',
    role: 'author', signedBy: null, formalAcceptance: false, createdAt: new Date().toISOString(), runtime: process.version, platform: process.platform,
    source, sourceStable, regressionPassed: sourceStable && suites.every(s => s.status !== 'fail'),
    suites, artifacts, capabilities: buildCapabilityReport(suites),
    limitations: ['No formal acceptance.json or independent signature is generated.', 'No mem-eval execution API is called: its exported runners are disabled.',
      'Fixture regressions do not replace the original corpus, score functions, raw QID answers, decay curve or human audit.',
      'Artifact hashes detect accidental corruption, not authenticated signatures. No production DB, GUI or network measurement.'] };
  fs.writeFileSync(path.join(output, 'development-evidence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, ...verifyEvidence(output) }));
  return { output, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 2 && args[0] === '--verify') {
      const result = verifyEvidence(args[1]); console.log(JSON.stringify(result)); process.exitCode = result.regressionPassed && result.sourceMatchesCurrent ? 0 : 1;
    } else if (!args.length || (args.length === 2 && args[0] === '--out-parent')) {
      const result = runEvidence(args[1]); process.exitCode = result.report.regressionPassed ? 0 : 1;
    } else throw new Error('usage: node scripts/capability-evidence.mjs [--out-parent ABSOLUTE_EXISTING_DIRECTORY | --verify ABSOLUTE_RUN_DIRECTORY]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
