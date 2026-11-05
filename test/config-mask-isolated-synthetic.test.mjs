import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const configUrl = pathToFileURL(join(import.meta.dirname, '../src/config.mjs')).href;

test('config masks synthetic credentials in an isolated child process', () => {
  const home = mkdtempSync(join(tmpdir(), 'memjudge-mask-synthetic-'));
  const env = { DSH_HOME: home, MEMJUDGE_NO_SECRETS: '1', PATH: '', TEMP: home, TMP: home, TMPDIR: home };
  if (process.platform === 'win32') {
    const systemRoot = Object.entries(process.env).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1];
    if (systemRoot) {
      env.SystemRoot = systemRoot;
      env.WINDIR = systemRoot;
    }
  }
  const script = `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync } from 'node:fs';
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_REPL_EXTERNAL_MODULE']) {
      assert.equal(process.env[name], undefined, name);
    }
    assert.deepEqual(Object.keys(process.env).map(name => name.toUpperCase()).sort(),
      ${JSON.stringify((process.platform === 'win32' && Object.keys(process.env).some(name => name.toUpperCase() === 'SYSTEMROOT')
        ? ['DSH_HOME', 'MEMJUDGE_NO_SECRETS', 'PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR']
        : ['DSH_HOME', 'MEMJUDGE_NO_SECRETS', 'PATH', 'TEMP', 'TMP', 'TMPDIR']).sort())});
    const c = await import(${JSON.stringify(configUrl)});
    const mask = '********';
    const short = 'x';
    const long = 'synthetic-long-secret-0123456789';
    assert.equal(c.maskKey(''), '');
    assert.equal(c.maskKey(null), '');
    assert.equal(c.maskKey(short), mask);
    assert.equal(c.maskKey(long), mask);
    assert.equal(c.maskKey(), '');
    for (const group of c.CRED_GROUPS) {
      assert.equal(c.groupReport(group).keyMasked, '');
      assert.equal(c.groupReport(group).keyConfigured, false);
    }
    process.env.MEMJUDGE_CHAT_KEY = short;
    process.env.MEMJUDGE_LLM_KEY = long;
    process.env.MEMJUDGE_EMBED_KEY = long;
    process.env.MEMJUDGE_RERANK_KEY = short;
    assert.equal(c.chatKey(), short);
    assert.equal(c.maskKey(), mask);
    for (const group of c.CRED_GROUPS) {
      const r = c.groupReport(group);
      assert.equal(r.keyMasked, mask);
      assert.equal(r.keySource, 'env');
      assert.equal(r.keyEnvLocked, true);
      assert.equal(r.keyConfigured, true);
    }
    let report = c.configReport();
    assert.equal(report.keyMasked, report.groups.chat.keyMasked);
    assert.equal(report.hasKey, report.groups.chat.keyConfigured);
    assert.equal(report.keySource, report.groups.chat.keySource);
    assert.equal(JSON.stringify(report).includes(long), false);
    c.saveConfig({ chatMode: 'disabled', embedMode: 'inherit', rerankMode: 'inherit' });
    assert.equal(c.groupReport('chat').keyMasked, '');
    assert.equal(c.groupReport('chat').enabled, false);
    assert.equal(c.groupReport('embed').keyMasked, mask);
    assert.equal(c.groupReport('embed').keySource, 'env');
    delete process.env.MEMJUDGE_EMBED_KEY;
    delete process.env.MEMJUDGE_RERANK_KEY;
    for (const group of ['embed', 'rerank']) {
      const r = c.groupReport(group);
      assert.equal(r.keyMasked, mask);
      assert.equal(r.keySource, 'inherit');
      assert.equal(r.keyInherited, true);
      assert.equal(r.inheritedEnv.key, 'MEMJUDGE_CHAT_KEY');
    }
    c.saveConfig({ chatMode: 'independent' });
    delete process.env.MEMJUDGE_CHAT_KEY;
    assert.equal(c.chatKey(), long);
    assert.equal(c.groupReport('chat').keyEnv, 'MEMJUDGE_LLM_KEY');
    delete process.env.MEMJUDGE_LLM_KEY;
    for (const group of c.CRED_GROUPS) assert.equal(c.groupReport(group).keyMasked, '');
    report = c.configReport();
    assert.equal(report.keyMasked, '');
    assert.equal(report.keyMasked, report.groups.chat.keyMasked);
    const sentinels = [
      'SYNTHETIC_LEGACY_KEY_482', 'SYNTHETIC_FILE_CHAT_593',
      'SYNTHETIC_FILE_EMBED_604', 'SYNTHETIC_FILE_RERANK_715',
      'SYNTHETIC_ENV_CHAT_826', 'SYNTHETIC_ENV_EMBED_937',
      'SYNTHETIC_ENV_RERANK_148', 'SYNTHETIC_OVERRIDE_CHAT_259',
      'SYNTHETIC_OVERRIDE_EMBED_360', 'SYNTHETIC_OVERRIDE_RERANK_471'
    ];
    const cleanReport = () => {
      const reports = [c.configReport(), ...c.CRED_GROUPS.map(g => c.groupReport(g))];
      for (const value of sentinels) {
        for (const item of reports) assert.equal(JSON.stringify(item).includes(value), false);
      }
    };
    const writeSecrets = value => {
      mkdirSync(c.STATE_DIR, { recursive: true });
      writeFileSync(c.SECRETS_PATH, JSON.stringify(value));
      c.reloadConfig();
    };
    delete process.env.MEMJUDGE_NO_SECRETS;
    writeFileSync(c.CONFIG_PATH, '{}');
    writeSecrets({ llmKey: sentinels[0] });
    assert.equal(c.chatKey(), sentinels[0]);
    for (const g of ['embed', 'rerank']) {
      assert.equal(c.groupReport(g).keySource, 'legacy-inherit');
      assert.equal(c.groupReport(g).keyInherited, true);
    }
    assert.equal(c.embedKey(), sentinels[0]);
    assert.equal(c.rerankKey(), sentinels[0]);
    cleanReport();
    writeSecrets({ chatKey: sentinels[1], embedKey: sentinels[2], rerankKey: sentinels[3], llmKey: sentinels[0] });
    const getters = [c.chatKey, c.embedKey, c.rerankKey];
    const envNames = ['MEMJUDGE_CHAT_KEY', 'MEMJUDGE_EMBED_KEY', 'MEMJUDGE_RERANK_KEY'];
    c.CRED_GROUPS.forEach((g, i) => {
      assert.equal(getters[i](), sentinels[i + 1]);
      assert.equal(c.groupReport(g).keySource, 'secrets.json');
    });
    cleanReport();
    c.CRED_GROUPS.forEach((g, i) => { process.env[envNames[i]] = sentinels[i + 4]; });
    c.CRED_GROUPS.forEach((g, i) => {
      assert.equal(getters[i](), sentinels[i + 4]);
      assert.equal(c.groupReport(g).keySource, 'env');
    });
    cleanReport();
    c.CRED_GROUPS.forEach((g, i) => c._setKeyOverride(sentinels[i + 7], g));
    c.CRED_GROUPS.forEach((g, i) => {
      assert.equal(getters[i](), sentinels[i + 7]);
      assert.equal(c.groupReport(g).keySource, 'override');
    });
    cleanReport();
    assert.equal(c.maskKey(undefined), mask);
    assert.equal(c.maskKey(0), '');
    assert.equal(c.maskKey(false), '');
    assert.equal(c.maskKey(42), mask);
    assert.equal(c.maskKey({}), mask);
    c._setKeyOverride(12345, 'chat');
    assert.equal(c.chatKey(), '12345');
    assert.equal(c.groupReport('chat').keyMasked, mask);
    c._setKeyOverride(undefined, 'chat');
    assert.equal(c.chatKey(), sentinels[4]);
    c._clearKeyOverrides();
    cleanReport();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
