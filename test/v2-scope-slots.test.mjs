// Test suite for MemJudge v2 Phase 1: scope.mjs, tokenizer.mjs, slots.mjs & extract.mjs.
// Runs under Node.js built-in test runner (node --test).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  GLOBAL_SPACE_ID,
  GLOBAL_SPACE_WEIGHT,
  CURRENT_SPACE_WEIGHT,
  normalizeWorkspacePath,
  detectWorkspaceRoot,
  workspaceSpaceId,
  workspaceSpaceInfo,
  isSubagentSession,
  isSubagentReceiptText,
  resolveScope,
  spaceWeight,
  visibleSpaces,
  visibleSpaceWeights,
} from '../src/scope.mjs';

import {
  hasJieba,
  splitIdentifierParts,
  extractCodeIdentifiers,
  tokenize,
  charNgrams,
} from '../src/tokenizer.mjs';

import {
  extractSlots,
  parseChineseNumber,
  normalizeValueAndUnit,
  cleanSlotEntity,
  cleanSlotAttr,
} from '../src/slots.mjs';

import {
  extractL1,
  extractFacts,
  extractL1Hybrid,
  rebuildFacts,
  cleanEntity,
  attrIsNoun,
} from '../src/extract.mjs';

// ==========================================
// 1. scope.mjs tests
// ==========================================

test('scope: normalizeWorkspacePath handles Windows & POSIX paths canonically', () => {
  assert.equal(normalizeWorkspacePath('F:\\记忆库\\60-源码\\'), 'f:/记忆库/60-源码');
  assert.equal(normalizeWorkspacePath('C:\\Users\\admin//project\\\\'), 'c:/users/admin/project');
  assert.equal(normalizeWorkspacePath('/home/user/repo/'), '/home/user/repo');
  assert.equal(normalizeWorkspacePath('/'), '/');
  assert.equal(normalizeWorkspacePath(''), '');
  assert.equal(normalizeWorkspacePath(null), '');
});

test('scope: workspaceSpaceId is deterministic and prefixed with workspace:12hex', () => {
  const id1 = workspaceSpaceId('F:\\记忆库');
  const id2 = workspaceSpaceId('f:/记忆库/');
  assert.equal(id1, id2);
  assert.match(id1, /^workspace:[0-9a-f]{12}$/);
});

test('scope: isSubagentSession correctly distinguishes subagents from GUI forks', () => {
  // Case A: Real subagent session header (origin = 'subagent')
  assert.equal(isSubagentSession({ header: { origin: 'subagent', delegationDepth: 1 } }), true);
  assert.equal(isSubagentSession({ agent: { session: { header: { origin: 'subagent' } } } }), true);

  // Case B: Real subagent session header (delegationDepth > 0)
  assert.equal(isSubagentSession({ header: { delegationDepth: 2 } }), true);

  // Case C: GUI forked main session (has parentSession but NOT origin=subagent, depth=0/undefined)
  // MUST NOT BE BLOCKED!
  assert.equal(
    isSubagentSession({ header: { id: 'sess-forked-123', parentSession: 'sess-parent-001', delegationDepth: 0 } }),
    false
  );
  assert.equal(
    isSubagentSession({ header: { id: 'sess-forked-456', parentSession: 'sess-parent-001' } }),
    false
  );

  // Case D: Text-level completion receipts
  const receiptText = 'Background subagent 8e5f2a1b-3c4d-4e5f finished: task completed';
  assert.equal(isSubagentReceiptText(receiptText), true);
  assert.equal(isSubagentSession(receiptText), true);
  assert.equal(isSubagentSession({}, receiptText), true);

  const normalText = 'We should check the database connection now.';
  assert.equal(isSubagentReceiptText(normalText), false);
});

test('scope: resolveScope resolves explicit and derived scopes correctly', () => {
  // Global
  const g = resolveScope({ space: 'global' });
  assert.equal(g.spaceId, 'global');
  assert.equal(g.kind, 'global');

  // Explicit workspace hex
  const ws = resolveScope({ space: 'workspace:1a2b3c4d5e6f' });
  assert.equal(ws.spaceId, 'workspace:1a2b3c4d5e6f');
  assert.equal(ws.kind, 'workspace');

  // Explicit session id
  const sess = resolveScope({ space: 'session:user-sess-999' });
  assert.equal(sess.spaceId, 'session:user-sess-999');
  assert.equal(sess.kind, 'session');

  // Derived from session.header.cwd
  const derived = resolveScope({
    session: {
      id: 'sess-main-1',
      header: { id: 'sess-main-1', cwd: 'F:\\记忆库\\60-源码' },
    },
  });
  assert.match(derived.spaceId, /^workspace:[0-9a-f]{12}$/);
  assert.equal(derived.kind, 'workspace');
  assert.equal(derived.rootPath, 'f:/记忆库/60-源码');
  assert.equal(derived.blockedSubagent, false);
});

test('scope: visibleSpaces and weights follow two-tier hierarchy', () => {
  const wsId = 'workspace:d23c0c0e1234';
  const list = visibleSpaces(wsId);
  assert.deepStrictEqual(list, [wsId, 'global']);

  const weights = visibleSpaces(wsId, { withWeights: true });
  assert.deepStrictEqual(weights, [
    { spaceId: wsId, weight: 1.0 },
    { spaceId: 'global', weight: 0.85 },
  ]);

  const globalList = visibleSpaces('global');
  assert.deepStrictEqual(globalList, ['global']);

  const sessSpaces = visibleSpaces('session:abc', { workspace: wsId, withWeights: true });
  assert.deepStrictEqual(sessSpaces, [
    { spaceId: 'session:abc', weight: 1.0 },
    { spaceId: wsId, weight: 1.0 },
    { spaceId: 'global', weight: 0.85 },
  ]);
});

// ==========================================
// 2. tokenizer.mjs tests
// ==========================================

test('tokenizer: extracts engineering code identifiers and preserves intact URLs', () => {
  const text = '请通过 https://console.cloud.google.com/apis/credentials 查看，在 a/b/foo-bar.mjs 中捕获 ERR_MODULE_NOT_FOUND 与 HTTP 405，升级到 v0.2.2-rc.1。';
  const idents = extractCodeIdentifiers(text, { includeSubtokens: true });

  // URL must be intact and NOT truncated to s://...
  assert.ok(idents.includes('https://console.cloud.google.com/apis/credentials'));
  assert.ok(!idents.some((x) => x.startsWith('s://')));

  // Code paths, basenames & identifiers
  assert.ok(idents.includes('a/b/foo-bar.mjs'));
  assert.ok(idents.includes('foo-bar.mjs'));
  assert.ok(idents.includes('ERR_MODULE_NOT_FOUND'));
  assert.ok(idents.includes('HTTP 405'));
  assert.ok(idents.includes('v0.2.2-rc.1'));
});

test('tokenizer: splitIdentifierParts handles camelCase, PascalCase, snake_case, kebab-case', () => {
  const parts = splitIdentifierParts('parseChineseNumber_v2-beta');
  assert.ok(parts.includes('parse'));
  assert.ok(parts.includes('Chinese'));
  assert.ok(parts.includes('Number'));
  assert.ok(parts.includes('v2'));
  assert.ok(parts.includes('beta'));
});

test('tokenizer: tokenize produces lowercase tokens and retains CJK bigrams', () => {
  const text = 'MemJudge 架构中的向量检索模块';
  const tokens = tokenize(text);
  assert.ok(tokens.includes('memjudge'));
  assert.ok(tokens.includes('架构'));
  assert.ok(tokens.includes('构中'));
  assert.ok(tokens.includes('中的'));
  assert.ok(tokens.includes('向量'));
  assert.ok(tokens.includes('检索'));
  assert.ok(tokens.includes('模块'));
});

test('tokenizer: charNgrams produces deterministic n-grams', () => {
  const grams = charNgrams('MemJudge', 3);
  assert.deepStrictEqual(grams, ['mem', 'emj', 'mju', 'jud', 'udg', 'dge']);
});

// ==========================================
// 3. slots.mjs tests
// ==========================================

test('slots: parseChineseNumber converts numbers and mixed magnitudes', () => {
  assert.equal(parseChineseNumber('10485760'), '10485760');
  assert.equal(parseChineseNumber('九'), '9');
  assert.equal(parseChineseNumber('十一'), '11');
  assert.equal(parseChineseNumber('一百八十九点九'), '189.9');
  assert.equal(parseChineseNumber('1.5万'), '15000');
  assert.equal(parseChineseNumber('2亿'), '200000000');
  assert.equal(parseChineseNumber('负五点二'), '-5.2');
  assert.equal(parseChineseNumber('abc'), null);
});

test('slots: normalizeValueAndUnit separates number and unit properly', () => {
  const r1 = normalizeValueAndUnit('10485760 bytes');
  assert.equal(r1.value, '10485760');
  assert.equal(r1.unit, 'bytes');

  const r2 = normalizeValueAndUnit('60秒');
  assert.equal(r2.value, '60');
  assert.equal(r2.unit, '秒');

  const r3 = normalizeValueAndUnit('九厘米');
  assert.equal(r3.value, '9');
  assert.equal(r3.unit, '厘米');

  // Hex hashes and SemVer should never be split
  const r4 = normalizeValueAndUnit('d23c0c0e');
  assert.equal(r4.value, 'd23c0c0e');
  assert.equal(r4.unit, '');

  const r5 = normalizeValueAndUnit('v0.2.2-rc.1');
  assert.equal(r5.value, 'v0.2.2-rc.1');
  assert.equal(r5.unit, '');
});

test('slots: extractSlots extracts key-value, config, module action, and negative polarity', () => {
  const sample = [
    'storageLimitBytes = 10485760',
    'port: 51007',
    'timeoutMs 设为 60000',
    'HEAD 指向 d23c0c0e',
    'src/inject.mjs 负责两段式注入',
    'client.js 的 RPC 路由改为 /api/memjudge.status',
    '数据库连接池的最大连接数设为 128',
    '凹槽深度为九厘米',
    '用户服务不再使用旧认证方案',
    '登录接口禁止使用明文密码传输',
    '遥测上报已关闭',
  ].join('\n');

  const slots = extractSlots(sample);
  assert.ok(slots.length >= 10, `Expected >= 10 slots, got ${slots.length}`);

  // Grounding check: EVERY quote must be a verbatim substring of sample!
  for (const s of slots) {
    assert.ok(
      sample.includes(s.quote),
      `Grounding failure: quote "${s.quote}" is not in sample`
    );
  }

  // Engineering assignment
  const sPort = slots.find((s) => s.entity === 'port');
  assert.ok(sPort);
  assert.equal(sPort.value, '51007');

  // Pointer
  const sHead = slots.find((s) => s.entity === 'HEAD');
  assert.ok(sHead);
  assert.equal(sHead.value, 'd23c0c0e');

  // Chinese metric with unit and Chinese numeral normalization
  const sDepth = slots.find((s) => s.attr === '深度');
  assert.ok(sDepth, 'Expected slot for 深度');
  assert.equal(sDepth.value, '9');
  assert.equal(sDepth.unit, '厘米');

  // Module action
  const sInject = slots.find((s) => s.entity === 'src/inject.mjs');
  assert.ok(sInject);
  assert.equal(sInject.attr, '负责');

  // Negative polarities
  const sNegAuth = slots.find((s) => s.entity === '用户服务');
  assert.ok(sNegAuth);
  assert.equal(sNegAuth.polarity, -1);

  const sNegTele = slots.find((s) => s.entity === '遥测上报');
  assert.ok(sNegTele);
  assert.equal(sNegTele.polarity, -1);
});

test('slots: URL protection prevents protocol slicing', () => {
  const text = '配置面板的访问地址设为 https://console.cloud.google.com/apis/dashboard。';
  const slots = extractSlots(text);
  assert.equal(slots.length, 1);
  const s = slots[0];
  assert.equal(s.value, 'https://console.cloud.google.com/apis/dashboard');
  assert.ok(text.includes(s.quote));
});

// ==========================================
// 4. extract.mjs backward compatibility tests
// ==========================================

test('extract: extractL1 / extractFacts backward compatible signatures and fields', async () => {
  const text = '系统缓存的最大容量为 256MB，当前状态设为正常。';
  const facts = extractL1(text);
  assert.ok(facts.length >= 1);

  const f = facts[0];
  assert.equal(typeof f.entity, 'string');
  assert.equal(typeof f.attr, 'string');
  assert.equal(f.attr, f.attribute);
  assert.equal(typeof f.at, 'number');
  assert.equal(typeof f.sentOff, 'number');
  assert.equal(typeof f.sentLen, 'number');
  assert.ok(text.includes(f.sent));
  assert.ok(text.includes(f.quote));

  // extractFacts alias
  const factsAlias = extractFacts(text);
  assert.equal(factsAlias.length, facts.length);

  // extractL1Hybrid wrapper
  const hybrid = await extractL1Hybrid([{ text }]);
  assert.equal(hybrid.source, 'rules');
  assert.equal(hybrid.perEntry.length, 1);
  assert.equal(hybrid.perEntry[0].length, facts.length);

  // rebuildFacts wrapper
  const rebuilt = rebuildFacts([{ id: 'm1', text }]);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].id, 'm1');
  assert.equal(rebuilt[0].count, facts.length);
});

test('extract: cleanEntity and attrIsNoun helper functions work properly', () => {
  assert.equal(cleanEntity('  “memjudge-plugin”  '), 'memjudge-plugin');
  assert.equal(cleanEntity('在模块 client.js 中'), 'client.js');
  assert.equal(attrIsNoun('深度'), true);
  assert.equal(attrIsNoun('最大容量'), true);
  assert.equal(attrIsNoun('采用'), false);
  assert.equal(attrIsNoun('进行'), false);
});
