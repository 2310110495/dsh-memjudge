// MemJudge v2 Phase 2-A: 双边三元组收集器、队列持久化与五类高密度原子记忆脱水器专项测试
// 验证：
//   1. 门禁拦截：纯催促短句、过渡废话播报、子代理交差报告（入库=0）
//   2. 数据清洗：凭据自动脱敏为 [REDACTED_SECRET]、完整 https:// URL 零截断、重复标题前缀根除
//   3. 本地脱水：五类法定范畴分类 (rule/profile/decision/experience/state)、40–160 字高密度约束、剔除代码块
//   4. 单活状态：state 槽位原地覆写、相同内容幂等、修订版本链 (memory_revisions) 完整沉淀
//   5. 优雅降级：LLM 超时与网络异常时 100% 回退本地脱水、全流程零未捕获异常、ingest_queue 队列端到端流转

import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/store.mjs';
import {
  createTurnCollector,
  isUrgeText,
  isFillerText,
  isSubagentReport,
  redactSecrets,
  cleanTitlePrefix,
  sanitizeTurnText,
  shouldFilterTurn,
} from '../src/turn-collector.mjs';
import {
  distillLocally,
  distillWithLlm,
  distillTurn,
  processIngestQueue,
  inferSlotKey,
  classifyCategoryByRules,
  stripCodeFences,
  normalizeAtomLength,
} from '../src/distiller.mjs';
import { chatSafe } from '../src/llm-client.mjs';

test('门禁清洗：纯催促短句拦截（长度 < 6 字符或催促正则）', () => {
  const urgeSamples = [
    '继续',
    '在吗',
    '好的',
    '快点',
    '收到',
    '继续吧',
    'ok',
    'OK!',
    'go on',
    'continue',
    '嗯',
    '继续执行',
  ];
  for (const s of urgeSamples) {
    assert.equal(isUrgeText(s), true, `应识别为催促短句: ${s}`);
  }

  const normalSamples = [
    '请帮我实现 turn-collector.mjs 模块',
    '继续重构第三个方法并修复测试中的路径截断问题',
    '好的，请按照 Schema v8 表结构建立 memory_revisions 表',
  ];
  for (const s of normalSamples) {
    assert.equal(isUrgeText(s), false, `不应误判为催促: ${s}`);
  }

  // 综合门禁：当用户只发催促短句且无工具动作时，整轮拦截
  const gate = shouldFilterTurn({
    userText: '继续',
    assistantConclusion: '好的，我马上继续。',
    toolSummary: [],
  });
  assert.equal(gate.filter, true);
  assert.equal(gate.reason, 'urge_text_without_tools');
});

test('门禁清洗：过渡废话播报拦截与前缀剥离', () => {
  const fillerSamples = [
    '我将先检索相关文件。',
    '让我来查看一下代码目录。',
    '正在为您处理请求...',
    '我先看一下代码结构。',
    '接下来我将运行测试确认结果。',
  ];
  for (const s of fillerSamples) {
    assert.equal(isFillerText(s), true, `应识别为过渡废话: ${s}`);
  }

  // 纯过渡宣告且无工具执行时被整轮拦截
  const gate = shouldFilterTurn({
    userText: '帮我看一下 store.mjs',
    assistantConclusion: '让我来查看一下代码目录。',
    toolSummary: [],
  });
  assert.equal(gate.filter, true);
  assert.equal(gate.reason, 'filler_without_tools');

  // 若后面有实质结论，前缀过渡废话被剥离，保留核心结论
  const mixedAssistant = '我将先检索相关模块。最终确认 Schema v8 采用八表正交架构，成功根除 rowid 错配历史缺陷。';
  const cleaned = sanitizeTurnText(mixedAssistant, true);
  assert.ok(!cleaned.startsWith('我将先检索'), '应剥除开头过渡宣告');
  assert.ok(cleaned.includes('最终确认 Schema v8'), '应保留实质结论');
});

test('门禁清洗：子代理交差报告与 origin===subagent 硬拦截', () => {
  const subagentReports = [
    'Background subagent "worker-1" finished. Its closing message: Task complete.',
    '子代理执行完成，已退出并汇报结果。',
    'Its closing message: all edits committed successfully.',
  ];
  for (const s of subagentReports) {
    assert.equal(isSubagentReport(s), true, `应拦截子代理报告: ${s}`);
  }

  // 1. 文本命中子代理报告特征时拦截
  const gate1 = shouldFilterTurn({
    userText: '等待子代理',
    assistantConclusion: 'Background subagent "worker-t1" finished. Its closing message: done.',
    toolSummary: ['subagent (ok)'],
  });
  assert.equal(gate1.filter, true);
  assert.equal(gate1.reason, 'subagent_closing_report');

  // 2. origin 为 subagent 时硬拦截
  const gate2 = shouldFilterTurn({
    userText: '子任务执行中',
    assistantConclusion: '已读取配置文件',
    toolSummary: ['read (ok)'],
    origin: 'subagent',
  });
  assert.equal(gate2.filter, true);
  assert.equal(gate2.reason, 'subagent_origin');
});

test('数据清洗：凭据自动脱敏、完整 URL 零截断与标题重复格式规整', () => {
  // 1. 敏感凭据脱敏
  const rawTextWithSecrets = `
    OpenAI 密钥: sk-1234567890abcdef1234567890
    GitHub 访问令牌: ghp_1234567890abcdef1234567890abcdef12
    私钥:
    -----BEGIN RSA PRIVATE KEY-----
    MIIEowIBAAKCAQEA0m...SECRET_KEY_DATA...
    -----END RSA PRIVATE KEY-----
    Bearer Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token
  `;
  const redacted = redactSecrets(rawTextWithSecrets);
  assert.ok(!redacted.includes('sk-1234567890'), 'sk- 开头 key 必须脱敏');
  assert.ok(!redacted.includes('ghp_1234567890'), 'ghp_ 必须脱敏');
  assert.ok(!redacted.includes('SECRET_KEY_DATA'), 'RSA 私钥必须脱敏');
  assert.ok(redacted.includes('[REDACTED_SECRET]'), '必须替换为 [REDACTED_SECRET]');

  // 2. 完整 URL 零截断（历史 bug：严防截断 https:// 出现 s://...）
  const textWithUrls = '参考项目地址：https://github.com/org/repo-name/releases/v2.0 与 http://127.0.0.1:8080/api/v1';
  const sanitizedUrlText = sanitizeTurnText(textWithUrls);
  assert.ok(sanitizedUrlText.includes('https://github.com/org/repo-name/releases/v2.0'), '完整 https URL 必须无损保留');
  assert.ok(sanitizedUrlText.includes('http://127.0.0.1:8080/api/v1'), '完整 http URL 必须无损保留');
  assert.ok(!/(?<!http)s:\/\//i.test(sanitizedUrlText), '严禁发生 https 被截断为孤立 s:// 的缺陷');

  // 3. 彻底根除“标题前置又在正文重复拼接”的缺陷
  const doubleTag = '[决策|v2] [决策|v2] 采用 Schema v8 八表正交架构。';
  assert.equal(cleanTitlePrefix(doubleTag), '[决策|v2] 采用 Schema v8 八表正交架构。');

  const repeatNameTag = '[架构决策] 架构决策：废弃单行 vector_blob。';
  assert.equal(cleanTitlePrefix(repeatNameTag), '[架构决策] 废弃单行 vector_blob。');
});

test('本地脱水引擎：五类法定范畴分类与 40–160 字高密度原子约束', () => {
  // 1. 验证分类启发式
  assert.equal(classifyCategoryByRules('提交前必须运行全量单元测试，严禁越过质量门禁。'), 'rule');
  assert.equal(classifyCategoryByRules('用户工作环境为 Windows 11，主力开发语言是 Node.js 22。'), 'profile');
  assert.equal(classifyCategoryByRules('架构方案确定采用 Schema v8 八表正交设计并废弃旧表。'), 'decision');
  assert.equal(classifyCategoryByRules('跨 provider 切换会导致 tool_use 历史断裂报错，修复方案为规整消息历史。'), 'experience');
  assert.equal(classifyCategoryByRules('当前任务进度：T3 闭合轮收集器已就绪，下一步执行集成测试。'), 'state');

  // 2. 验证代码块被剔除
  const textWithCode = `
    修复了数据库连接问题：
    \`\`\`javascript
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    console.log("running");
    \`\`\`
    最终确认在打开连接时必须启用外键约束。
  `;
  const stripped = stripCodeFences(textWithCode);
  assert.ok(!stripped.includes('const db = new Database'), '代码块内容必须被剔除');
  assert.ok(stripped.includes('最终确认在打开连接时必须启用外键约束'));

  // 3. 验证本地确定性脱水输出
  const payload = {
    userText: '请记录架构决策',
    assistantConclusion: '经过评估，决定采用 Schema v8 八表正交架构，彻底废除旧版按 rowid 对齐的 vector_blob，改用不可变 memory_id 显式主键绑定，根除删除后向量错配历史隐患。',
    toolSummary: ['edit src/schema.mjs (ok)', 'node --test (exit 0)'],
  };
  const atoms = distillLocally(payload);
  assert.equal(atoms.length, 1);
  const atom = atoms[0];
  assert.equal(atom.category, 'decision');
  assert.ok(atom.text.length >= 40 && atom.text.length <= 160, `原子记忆长度 (${atom.text.length}) 应在 40–160 字内`);
  assert.ok(atom.text.includes('Schema v8'), '必须包含核心决策内容');
});

test('单活状态维护：state 槽位原地覆写、相同内容幂等与 memory_revisions 修订链', () => {
  const store = open(':memory:');
  try {
    const spaceId = 'workspace:test123456';
    const slotKey = 'task:T3';

    // 1. 首次存入状态
    const textV1 = '[进度] 正在执行任务 T3：完成闭合轮收集器 src/turn-collector.mjs 核心编码。';
    const res1 = store.putState({
      spaceId,
      slotKey,
      text: textV1,
      source: 'turn:sess-1:1',
      reason: 'init-task',
    });
    assert.ok(res1.id, '应返回记录 id');
    assert.equal(res1.inserted, true);
    assert.equal(res1.updated, true);

    // 2. 相同内容再次存入：必须幂等跳过（updated: false, inserted: false）
    const res2 = store.putState({
      spaceId,
      slotKey,
      text: textV1,
      source: 'turn:sess-1:2',
      reason: 're-sync',
    });
    assert.equal(res2.id, res1.id, '单活状态 ID 应保持一致');
    assert.equal(res2.inserted, false, '相同内容不应重新插入');
    assert.equal(res2.updated, false, '相同内容不应触发更新');

    // 3. 状态转移（内容变化）：原地覆写旧 active 行并沉淀到 memory_revisions
    const textV2 = '[进度] 任务 T3 状态更新：完成 distiller.mjs 编码，全部单元测试验证通过，准备提交结单。';
    const res3 = store.putState({
      spaceId,
      slotKey,
      text: textV2,
      source: 'turn:sess-1:3',
      reason: 'task-finished',
    });
    assert.equal(res3.id, res1.id, '单活状态槽位 ID 保持不变（原地覆写）');
    assert.equal(res3.inserted, false, '状态更新不是新建行');
    assert.equal(res3.updated, true, '内容变更应标记 updated=true');

    // 4. 校验修订链 (memory_revisions)
    const revs = store.listRevisions(res1.id);
    assert.ok(revs.length >= 1, '旧状态必须记录在 revisions 中');
    assert.equal(revs[0].prevText, textV1, '修订历史应完整保留旧文本快照');
    assert.equal(revs[0].reason, 'task-finished', '修订历史应记录变更原因');

    // 5. 校验当前主表记录为最新值
    const current = store.get(res1.id);
    assert.equal(current.text, textV2);
    assert.equal(current.slotKey, slotKey);
  } finally {
    store.close();
  }
});

test('LLM 客户端与双模脱水器：超时与网络异常时 100% 优雅回退本地脱水', async () => {
  // 1. 验证 chatSafe 超时与网络报错时返回 null 而不抛错
  const failFetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:443');
  };
  const safeRes = await chatSafe({
    messages: [{ role: 'user', content: 'hello' }],
  }, {
    apiKey: 'test-key',
    timeoutMs: 50,
    fetchImpl: failFetch,
  });
  assert.equal(safeRes, null, 'chatSafe 遇到异常时必须静默降级返回 null');

  // 2. 验证 distillTurn 在 LLM 失败/超时时自动优雅回退本地脱水
  const payload = {
    userText: '请严格遵守规范',
    assistantConclusion: '在进行任何代码变更前必须执行只读事实核查，严禁擅自恢复非本任务修改。',
    toolSummary: ['read src/config.mjs (ok)'],
  };
  const atoms = await distillTurn(payload, {
    apiKey: 'test-key',
    timeoutMs: 50,
    fetchImpl: failFetch,
  });
  assert.ok(Array.isArray(atoms) && atoms.length > 0, '降级后必须产生本地规则提炼的原子记忆');
  assert.equal(atoms[0].category, 'rule');
  assert.ok(atoms[0].text.includes('只读事实核查'));
});

test('端到端全链路：Collector 收集入队 -> Ingest Queue 消费 -> Distiller 提炼并持久化', async () => {
  const store = open(':memory:');
  try {
    const spaceId = 'workspace:e2e_test_123';
    const sessionId = 'session_e2e_turn';
    const collector = createTurnCollector({
      store,
      spaceId,
      sessionId,
      turnNo: 1,
    });

    // 1. 模拟一轮正常工作流对话
    collector.recordUser('请记录当前的开发环境与配置');
    collector.recordTool('pwsh', { command: 'node -v' }, { stdout: 'v22.5.0' }, true);
    collector.recordAssistant('确认当前用户主力运行环境为 Windows 11 操作系统，Node.js 版本为 v22.5.0，已完整配置 DSH 开发套件。');

    // 2. 闭合轮次：成功通过门禁并入队
    const closeRes = collector.closeTurn({ now: 1000 });
    assert.equal(closeRes.filtered, false);
    assert.equal(closeRes.enqueued, true);
    assert.ok(closeRes.jobId > 0);

    // 3. 消费队列并执行蒸馏落地
    const processReport = await processIngestQueue({
      store,
      limit: 5,
      now: 1050,
    });
    assert.equal(processReport.processed, 1);
    assert.equal(processReport.saved >= 1, true);
    assert.equal(processReport.jobs[0].status, 'done');

    // 4. 验证主表中已持久化对应的原子记忆
    const mems = store.byCategory('profile', 10);
    assert.ok(mems.length >= 1, '库内必须检索到 profile 记忆');
    assert.ok(mems[0].text.includes('Windows 11') || mems[0].text.includes('Node.js'));

    // 5. 验证队列中无挂起任务
    const stats = store.stats();
    assert.equal(stats.queue?.pending ?? 0, 0);
  } finally {
    store.close();
  }
});
