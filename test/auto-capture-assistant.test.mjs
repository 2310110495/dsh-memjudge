// auto-capture assistant 侧（T87）验收测试。
//
// 真源：src/auto-capture-assistant.mjs 的文件头（五道闸 A1-A6）与
// src/auto-capture.mjs 的 formatAssistantSource / parseSource。
//
// 三条自我约束（与 test/auto-capture.test.mjs 同规格）：
//   1. 不读、不写真库；全部是纯函数判定，不碰 DSH_HOME。
//   2. 阈值用实测样本说话：构造样本后先断言它确实落在目标区间，再断言结论。
//   3. 这条路径挂在 session/event 的同步回调上，任何抛错都必须被入口吞掉。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_DEFAULTS,
  ASSISTANT_SOURCE_KINDS,
  assistantVerdict,
  assistantSimilarity,
  extractAssistantCandidates,
  formatRatio,
  inspectAssistantMessage,
  isFormattedOnly,
  resolveAssistantConfig,
  stripCodeFences,
} from '../src/auto-capture-assistant.mjs';
import {
  CAPTURE_KINDS,
  createQuota,
  formatAssistantSource,
  formatSource,
  parseSource,
  pickCaptureText,
} from '../src/auto-capture.mjs';

// ---------------------------------------------------------------- 夹具

/** 造一条宿主 AssistantMessage。source.kind='model' 是宿主 createAssistantMessage 的默认值。 */
const asst = (content, { role = 'assistant', kind = 'model' } = {}) => ({
  id: 'a1',
  role,
  content,
  source: kind === null ? undefined : { kind, provider: 'p', model: 'm' },
});

const text = (t) => ({ type: 'text', text: t });
const NO_WS = /\s+/g;
const weight = (t) => String(t).replace(NO_WS, '').length;

/** 造一条恰好 n 个有效字符的中文正文（池子里没有空白，保证 weight() === n）。 */
const CHARS = '项目约定构建脚本统一走vite测试统一走node提交前必须跑全量用例再合入主干';
const at = (n) => CHARS.repeat(Math.ceil(n / CHARS.length)).slice(0, n);
assert.equal(weight(at(200)), 200, '夹具自检：at(n) 的有效长度必须恰好是 n');

/** 一段像真结论的正文（长度必须过 minChars 200）。 */
const CONCLUSION = [
  '结论先行：记忆插件的自动采集原来只挂在 agent/pre-step 上，而那一刻助手还没开始生成回复，',
  '所以库里只留下了用户输入。要采助手自己的结论，必须换成 session/event 的 assistant/message 事件，',
  '在消息落库之后同步读取其中的 text 块。reasoning 块是思考链，tool-call 块是函数调用参数，',
  '两者都不该进记忆。长度闸比用户侧更严：短于两百字的多半是过渡句，长于一千二百字的整篇回答会把检索带偏。',
].join('\n');
assert.ok(weight(CONCLUSION) >= ASSISTANT_DEFAULTS.minChars,
  `夹具正文必须过 minChars，实测 ${weight(CONCLUSION)}`);

// ---------------------------------------------------------------- A1 身份闸

test('A1：assistant + source.kind=model 才采，其余角色与来源一律排除', () => {
  assert.deepEqual([...ASSISTANT_SOURCE_KINDS], ['model'], '白名单必须只有 model 一种');
  assert.deepEqual([...CAPTURE_KINDS], ['user'], 'user 侧白名单不得被本次改动污染');

  assert.equal(assistantVerdict(asst([text(CONCLUSION)])).ok, true, '正常的助手结论应通过');

  for (const role of ['user', 'system', 'tool', 'developer']) {
    assert.equal(assistantVerdict(asst([text(CONCLUSION)], { role })).reason, 'role', `role=${role} 必须排除`);
  }
  for (const kind of ['user', 'system', 'plugin', 'hook', 'wiki', 'auto', 'runtime-context', 'system-prompt']) {
    assert.equal(assistantVerdict(asst([text(CONCLUSION)], { kind })).reason, 'source', `source.kind=${kind} 必须排除`);
  }
  assert.equal(assistantVerdict(asst([text(CONCLUSION)], { kind: null })).reason, 'source', '缺 source 必须排除');
  assert.equal(assistantVerdict(asst([text(CONCLUSION)], { kind: 7 })).reason, 'source', '非字符串 kind 必须排除');
});

test('A1 反向：user 通路的 pickCaptureText 仍然拒 assistant（既有语义零改动）', () => {
  assert.equal(pickCaptureText(asst([text('这个项目的包管理器用 pnpm，别用 npm')])), null,
    'assistant 消息不得从 user 通路漏进来');
});

// ---------------------------------------------------------------- A2 形态闸

test('A2：reasoning 与 tool-call 块整块剔除，只留 text', () => {
  const msg = asst([
    text('我先看一下路由注册的地方。'),
    { type: 'reasoning', text: '思考链：这里应该先看 session 表' },
    { type: 'tool-call', id: 'c1', name: 'grep', arguments: '{"pattern":"session/event"}' },
    text('结论：钩子挂在 session/event 上，事件名是 assistant/message。'),
  ]);
  const inspected = inspectAssistantMessage(msg);
  assert.equal(inspected.problem, null);
  assert.equal(inspected.dropped.reasoning, 1);
  assert.equal(inspected.dropped.tool, 1);
  assert.ok(!inspected.text.includes('思考链'), 'reasoning 内容绝不能进文本');
  assert.ok(!inspected.text.includes('grep'), 'tool-call 内容绝不能进文本');
  assert.equal(inspected.text, '我先看一下路由注册的地方。\n结论：钩子挂在 session/event 上，事件名是 assistant/message。');

  assert.equal(assistantVerdict(asst([{ type: 'reasoning', text: at(400) }])).reason, 'no-text',
    '纯思考链没有可采文本');
  assert.equal(assistantVerdict(asst([{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }])).reason, 'no-text',
    '纯工具调用没有可采文本');
  assert.equal(assistantVerdict(asst('not-an-array')).reason, 'no-text', 'content 非数组按无文本处理');
});

test('A2：畸形块（null / 非对象 / 未知 type）只计入 dropped.other，不影响 text 提取', () => {
  const msg = asst([null, 7, { type: 'image', url: 'x' }, text(CONCLUSION)]);
  const inspected = inspectAssistantMessage(msg);
  assert.equal(inspected.problem, null);
  assert.equal(inspected.dropped.other, 3);
  assert.equal(inspected.text, CONCLUSION);
  assert.equal(assistantVerdict(msg).ok, true, '未知块不该把整条消息判死');
});

// ---------------------------------------------------------------- A3 代码围栏

test('A3：围栏内容被剥掉，剩下的叙述照常判定', () => {
  const mixed = `${CONCLUSION}\n\`\`\`js\nconst a = 1;\nconsole.log(a);\n\`\`\`\n以上就是这次改动的结论。`;
  const stripped = stripCodeFences(mixed);
  assert.ok(!stripped.includes('console.log'), '围栏内代码必须被删掉');
  assert.ok(stripped.includes('结论先行'), '围栏外的叙述必须保留');
  assert.equal(assistantVerdict(asst([text(mixed)])).ok, true, '代码 + 叙述的混合消息应采叙述');

  // 纯代码：剥完什么都不剩
  const codeOnly = '```js\n' + 'const x = 1;\n'.repeat(60) + '```';
  assert.equal(stripCodeFences(codeOnly).trim(), '');
  assert.equal(assistantVerdict(asst([text(codeOnly)])).reason, 'code-fence', '纯代码块必须弃');

  // 未闭合围栏：删到结尾，绝不把半段代码当结论
  const unclosed = `${CONCLUSION}\n\`\`\`bash\nrm -rf build\nnpm run build`;
  assert.ok(!stripCodeFences(unclosed).includes('rm -rf'), '未闭合围栏也要删到结尾');

  // 代码把长度顶上去的场景：剥掉后不够长 → too-short
  const shortTextLongCode = '改完了。\n```\n' + 'x'.repeat(900) + '\n```';
  assert.equal(assistantVerdict(asst([text(shortTextLongCode)])).reason, 'too-short',
    '长度必须在剥离围栏之后量，否则一段代码就能把三句废话顶成"够长"');
});

// ---------------------------------------------------------------- A4 长度闸

test('A4：minChars=200 边界（199 拒 / 200 过）', () => {
  assert.equal(ASSISTANT_DEFAULTS.minChars, 200);
  assert.equal(assistantVerdict(asst([text(at(199))])).reason, 'too-short');
  assert.equal(assistantVerdict(asst([text(at(200))])).ok, true, '恰好 200 应通过');
  // 空白不计入长度：与 user 通路同一把尺
  const padded = at(200).split('').join(' ');
  assert.equal(weight(padded), 200, '夹具自检：空白字数必须被排除');
  assert.equal(assistantVerdict(asst([text(padded)])).ok, true, '空白不该被计入长度');
});

test('A4：maxChars=1200 边界（1200 过 / 1201 拒，且绝不截断）', () => {
  assert.equal(ASSISTANT_DEFAULTS.maxChars, 1200);
  assert.equal(assistantVerdict(asst([text(at(1200))])).ok, true, '恰好 1200 应通过');

  const verdict = assistantVerdict(asst([text(at(1201))]));
  assert.equal(verdict.reason, 'too-long');
  assert.equal(verdict.text, '', '超长时 verdict.text 必须为空，不能返回截断文本');
  assert.equal(extractAssistantCandidates([asst([text(at(1201))])]).length, 0, '超长条目不得进入候选');
});

// ---------------------------------------------------------------- A5 纯格式化

test('A5：表格 / 目录树 / 命令清单被识别为排版产物', () => {
  // 每个单元格都灌够字，保证长度闸先放行，测的才是格式化闸本身。
  const cell = (s) => `${s}${at(40)}`;
  const table = [
    `| ${cell('模块')} | ${cell('状态')} |`, '| --- | --- |',
    `| ${cell('store')} | ${cell('ok')} |`, `| ${cell('index')} | ${cell('ok')} |`,
    `| ${cell('layer')} | ${cell('ok')} |`,
  ].join('\n');
  assert.ok(weight(table) >= ASSISTANT_DEFAULTS.minChars, `夹具自检：表格要过长度闸，实测 ${weight(table)}`);
  assert.ok(formatRatio(table) >= 0.9, `表格行占比应接近 1，实测 ${formatRatio(table)}`);
  assert.equal(isFormattedOnly(table), true);
  assert.equal(assistantVerdict(asst([text(table)])).reason, 'formatted-only');

  const tree = [`${at(60)}/`, `├── ${cell('index.mjs')}`, `├── ${cell('store.mjs')}`,
    `├── ${cell('layer.mjs')}`, `└── ${cell('rpc.mjs')}`].join('\n');
  assert.ok(weight(tree) >= ASSISTANT_DEFAULTS.minChars, `夹具自检：目录树要过长度闸，实测 ${weight(tree)}`);
  assert.equal(isFormattedOnly(tree), true, '目录树必须被判死');

  const cmds = [`$ ${cell('npm install')}`, `$ ${cell('node --test')}`,
    `$ ${cell('git status')}`, `$ ${cell('git diff')}`].join('\n');
  assert.ok(weight(cmds) >= ASSISTANT_DEFAULTS.minChars, `夹具自检：命令清单要过长度闸，实测 ${weight(cmds)}`);
  assert.equal(isFormattedOnly(cmds), true, '命令清单必须被判死');

  // 结论后跟三行小列表（占比 < 60%）仍是结论，不该被误杀
  const conclusionWithList = `${CONCLUSION}\n- 第一点\n- 第二点\n- 第三点`;
  assert.ok(formatRatio(conclusionWithList) < 0.6, `占比应低于阈值，实测 ${formatRatio(conclusionWithList)}`);
  assert.equal(assistantVerdict(asst([text(conclusionWithList)])).ok, true, '带小列表的结论应通过');
});

// ---------------------------------------------------------------- A6 近重复

test('A6：与库内相似度 0.9 的自我重复必须被跳过', () => {
  // 长文本里替换一个字，3-gram 多集 Jaccard 必然在 0.9 以上。
  const chars = [...CONCLUSION];
  chars[40] = '甲';
  const near = chars.join('');
  const score = assistantSimilarity(CONCLUSION, near);
  assert.ok(score >= 0.85 && score <= 1, `夹具自检：相似度应 ≥0.85，实测 ${score}`);

  assert.equal(assistantVerdict(asst([text(near)])).ok, true, '无语料时不判重');
  assert.equal(assistantVerdict(asst([text(near)]), { existing: [CONCLUSION] }).reason, 'near-dup',
    '与库内高度相似必须判重');

  // 语义确实变了就放行
  const different = '这次改成完全另一套方案：把采集点移到会话结束的回调里，' + at(260);
  assert.equal(assistantVerdict(asst([text(different)]), { existing: [CONCLUSION] }).ok, true,
    '真正的新结论不能被误判成重复');
});

test('A6：existing 回调形态抛错时 fail-open 放行', () => {
  const out = extractAssistantCandidates([asst([text(CONCLUSION)])], {
    existing: () => { throw new Error('boom'); },
  });
  assert.equal(out.length, 1, '判重抛错必须放行，不能把结论弄丢');
});

// ---------------------------------------------------------------- 配额

test('配额：assistant 独立计数，单轮上限 6', () => {
  // T90：2 → 5。一轮的落库构型是「3 段 + 1 动作清单 + 1 工作状态」，2 会砍掉结论段。
  assert.equal(ASSISTANT_DEFAULTS.perTurnLimit, 6);
  assert.equal(ASSISTANT_DEFAULTS.sessionLimit, 120);

  // 上限语义单独验证：显式压到 2，第三条必须被配额挡下（与默认值解耦，避免改默认值时
  // 这条测试靠「夹具刚好三条」蒙对）。
  const quota = createQuota({ ...ASSISTANT_DEFAULTS, perTurnLimit: 2, cooldownMs: 0 });
  const messages = [
    asst([text(CONCLUSION)]),
    asst([text(`${CONCLUSION}补充第二段。`)]),
    asst([text(`${CONCLUSION}补充第三段。`)]),
  ];
  const out = extractAssistantCandidates(messages, {
    ...ASSISTANT_DEFAULTS, perTurnLimit: 2, quota, sessionId: 's1', turn: 1,
  });
  assert.equal(out.length, 2, `单轮上限 2 时必须只出 2 条，实测 ${out.length}`);
  assert.equal(quota.stats('s1').total, 2);

  // 同一夹具在默认上限 6 下三条全过：证明截断是配额造成的，不是判定造成的。
  const quota5 = createQuota({ ...ASSISTANT_DEFAULTS, cooldownMs: 0 });
  const out5 = extractAssistantCandidates(messages, { ...ASSISTANT_DEFAULTS, quota: quota5, sessionId: 's1', turn: 1 });
  assert.equal(out5.length, 3, `默认上限 6 时三条都该过，实测 ${out5.length}`);
});

// ---------------------------------------------------------------- source 标记

test('source：assistant 前缀往返逐字一致，且与 user 前缀互不串味', () => {
  const sessionId = '62856429-ec40-46bd-9cdd-3440650bb343';
  const b64 = Buffer.from(sessionId, 'utf8').toString('base64url');
  const source = formatAssistantSource(sessionId, 7, 3);
  assert.equal(source, `auto:chat:asst#${b64}:t7:s3`);
  assert.deepEqual(parseSource(source), { auto: true, version: 3, role: 'assistant', sessionId, turn: 7, step: 3, source });
  assert.equal(formatAssistantSource(sessionId, 7, 3), source, '同一输入必须稳定');

  // user 的 v2 标记行为一个字节都没变
  const userV2 = formatSource(sessionId, 7);
  assert.deepEqual(parseSource(userV2), { auto: true, version: 2, sessionId, turn: 7, source: userV2 });

  for (const [sid, turn, step] of [['s1', 0, 0], ['含中文-9f8e', 12, 4], [' 😀e\u0301 ', 3, 1]]) {
    const s = formatAssistantSource(sid, turn, step);
    const parsed = parseSource(s);
    assert.ok(parsed, `${s} 必须可解析`);
    assert.equal(parsed.sessionId, sid);
    assert.equal(parsed.turn, turn);
    assert.equal(parsed.step, step);
  }
});

test('source：旧两种格式仍能解析（向后兼容）', () => {
  assert.deepEqual(parseSource('auto:chat#ab-t1'),
    { auto: true, version: 1, legacy: true, ambiguous: true, sessTok: 'ab', turn: 1, source: 'auto:chat#ab-t1' },
    'legacy v1 必须原样可解析');

  const v2 = parseSource(`auto:chat:v2#${Buffer.from('s1a2b3c').toString('base64url')}:t2`);
  assert.ok(v2, 'v2 必须可解析');
  assert.equal(v2.version, 2);
  assert.equal(v2.sessionId, 's1a2b3c');
  assert.equal(v2.turn, 2);
  assert.equal(v2.source, `auto:chat:v2#${Buffer.from('s1a2b3c').toString('base64url')}:t2`, '往返必须逐字一致');

  assert.equal(parseSource('auto:wiki#x-t1'), null, '只认 chat 通道');
  assert.equal(parseSource('{"chapter":1,"para":2}'), null);
});

test('source：畸形标记一律返回 null 或抛对应的错', () => {
  const b64 = Buffer.from('s1').toString('base64url');
  for (const bad of [
    `auto:chat:asst#${b64}:t1`,            // 缺 step
    `auto:chat:asst#${b64}:s1`,            // 缺 turn
    `auto:chat:asst#${b64}:t1:s`,          // step 非数字
    `auto:chat:asst#${b64}:t01:s1`,        // 前导零
    `auto:chat:asst#${b64}:t1:s1:x`,       // 多余段
    'auto:chat:asst#:t1:s1',               // 空 token
  ]) assert.equal(parseSource(bad), null, `${bad} 必须解析失败`);

  assert.throws(() => formatAssistantSource('', 0, 0), TypeError);
  assert.throws(() => formatAssistantSource(null, 0, 0), TypeError);
  assert.throws(() => formatAssistantSource('s', -1, 0), RangeError);
  assert.throws(() => formatAssistantSource('s', 0, -1), RangeError);
  assert.throws(() => formatAssistantSource('s', 1.5, 0), RangeError);
  assert.throws(() => formatAssistantSource('s', 0, 0.5), RangeError);
});

// ---------------------------------------------------------------- 配置

test('配置：默认值与钳位，autoCapture 硬开关同时管住两条通路', () => {
  assert.deepEqual(resolveAssistantConfig(), {
    enabled: true,
    minChars: 200,
    maxChars: 1200,
    perTurnLimit: 6,
    sessionLimit: 120,
    dupThreshold: 0.85,
    importance: 0.12,
    turnFlushChars: 2400,
  }, '默认值必须与 ASSISTANT_DEFAULTS 一致');

  assert.equal(resolveAssistantConfig({ autoCapture: false }).enabled, false, '总开关关掉时助手侧也不采');
  assert.equal(resolveAssistantConfig({ autoCaptureAssistant: false }).enabled, false);
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantMinChars: 1 }).minChars, 120, '下界 120');
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantMinChars: 9999 }).minChars, 400, '上界 400');
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantMaxChars: 1 }).maxChars, 400, '下界 400');
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantPerTurn: 0 }).perTurnLimit, 1);
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantPerTurn: 999 }).perTurnLimit, 8, '上界 8');
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantLimitPerSession: 9999 }).sessionLimit, 200);
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantDupThreshold: 7 }).dupThreshold, 1);
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantMinChars: 'abc' }).minChars, 200);
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantTurnFlushChars: 1 }).turnFlushChars, 600, '软冲阈值下界 600');
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantTurnFlushChars: 99999 }).turnFlushChars, 12000);
  // 上限不得低于下限
  assert.equal(resolveAssistantConfig({ autoCaptureAssistantMinChars: 400, autoCaptureAssistantMaxChars: 400 }).maxChars, 400);
});

test('importance：assistant 条目永远进不了 warm 档', () => {
  assert.ok(ASSISTANT_DEFAULTS.importance < 0.6, '0.6 是人工事实的门槛，自动条目不得越线');
  assert.equal(assistantVerdict(asst([text(CONCLUSION)])).importance, ASSISTANT_DEFAULTS.importance);
});

// ---------------------------------------------------------------- fail-open

test('畸形输入一律不抛错（fail-open）', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const poison = {
    role: 'assistant',
    source: { kind: 'model' },
    get content() { throw new Error('boom'); },
  };

  const weird = [undefined, null, 0, 1, '', 'string', [], [null], {}, cyclic, poison];
  for (const input of weird) {
    assert.doesNotThrow(() => inspectAssistantMessage(input));
    assert.doesNotThrow(() => assistantVerdict(input));
    assert.doesNotThrow(() => extractAssistantCandidates(input));
    assert.doesNotThrow(() => stripCodeFences(input));
    assert.doesNotThrow(() => formatRatio(input));
    assert.doesNotThrow(() => isFormattedOnly(input));
    assert.doesNotThrow(() => resolveAssistantConfig(input));
  }
  assert.equal(assistantVerdict(poison).reason, 'error', 'content getter 抛错要退回 error（不采）');
  assert.deepEqual(extractAssistantCandidates(null), []);
  assert.deepEqual(extractAssistantCandidates({ length: 3 }), [], '非数组一律空');
  assert.equal(extractAssistantCandidates([asst([text(CONCLUSION)])], 'not-an-object').length, 1,
    '配置非对象应回落默认并照常采集');
});
