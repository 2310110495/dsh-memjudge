import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { formatSource, formatAssistantSource, parseSource } from '../src/auto-capture.mjs';

// 端到端接线测试：验证 session/event → extractAssistantCandidates → store.put 这条真实
// 通路，而不只是判定内核。fixture 照抄 auto-source-identity.test.mjs 的 mock ctx 形态。

const CONCLUSION = [
  '结论：把 memjudge 的自动采集拆成两条通路，用户侧沿用既有六道闸门与全部阈值不变，助手侧另开一道独立闸门，',
  '只收带结论性质的正文，思考链块与工具调用块一律剔除，代码围栏内的内容也不进记忆。',
  '章号各自领取，避免同一轮里双方的发言被章级聚合拼成一份文档，凭空判出前后矛盾。',
  '这一版先把落库与查回打通，冲突检测与去重联动留到后续单独一轮处理，不在本次范围内扩张。',
  '采集到的条目一律标记为 event 类，绝不升格成 person 或 promise，那两类只能来自用户本人的明确表达。',
].join('\n');

const weight = t => String(t).replace(/\s+/g, '').length;
assert.ok(weight(CONCLUSION) >= 200 && weight(CONCLUSION) <= 1200,
  `夹具结论必须落在 assistant 长度闸内，实际 ${weight(CONCLUSION)}`);

const TINY = '好的';
const CODE_ONLY = ['```js', 'const a = 1;', 'const b = 2;', '```'].join('\n');
const TABLE = ['| 项 | 值 |', '|---|---|', '| 章号 | 941 |', '| 条数 | 1 |'].join('\n');

function fixture(options = {}) {
  const tools = new Map(), hooks = new Map(), services = new Map();
  const ctx = {
    tools: { register: x => { tools.set(x.name, x); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    provide: (name, value) => { services.set(name, value); return () => {}; },
    effect: fn => fn(), on: (name, fn) => { hooks.set(name, fn); return () => {}; },
  };
  const app = apply(ctx, {
    dbPath: ':memory:', vector: false, autoCaptureCooldownMs: 0, ...options,
  });
  const api = services.get('memjudge');

  const userTurn = async (id, turn, text) => {
    const decision = {
      kind: 'enter',
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    };
    return hooks.get('agent/pre-step')({ agent: { session: { id } }, turn }, async () => decision);
  };

  const blocks = (...parts) => ({ role: 'assistant', source: { kind: 'model' }, content: parts });
  const text = t => ({ type: 'text', text: t });
  const reasoning = t => ({ type: 'reasoning', text: t });
  const toolCall = name => ({ type: 'tool-call', id: `call_${name}`, name, arguments: '{}' });

  // message 直接传 f.blocks(...) 的返回值（已含 role/source/content）。
  // T90 之后 assistant/message 只累积、不落库（单步正文太短，判闸必死），
  // 落库发生在 turn/end —— 真实宿主就是这个顺序，测试必须照抄。
  const emit = (id, turn, step, message) => {
    const handler = hooks.get('session/event');
    assert.equal(typeof handler, 'function', 'session/event 必须已挂载');
    handler({ id }, { type: 'assistant/message', data: { turn, step, message } });
  };

  const endTurn = (id, turn) => {
    const handler = hooks.get('session/event');
    assert.equal(typeof handler, 'function', 'session/event 必须已挂载');
    handler({ id }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  };

  /** 一次完整回合：投消息 + 收轮。T90 的标准调用形态。 */
  const round = (id, turn, step, message) => { emit(id, turn, step, message); endTurn(id, turn); };

  return { app, api, hooks, tools, userTurn, emit, endTurn, round, blocks, text, reasoning, toolCall };
}

const rows = (api, id, turn, step) => api.bySourcePrefixV1(formatAssistantSource(id, turn, step));

test('assistant 结论经 session/event 真正落库，source 可反解', () => {
  const f = fixture();
  try {
    f.round('s1', 3, 2, f.blocks(f.text(CONCLUSION)));
    const got = rows(f.api, 's1', 3, 2);
    assert.equal(got.length, 1);
    assert.equal(got[0].text, CONCLUSION);
    assert.equal(got[0].kind, 'event');
    assert.ok(got[0].chapter >= 900, `章号应落在自动采集区间，实际 ${got[0].chapter}`);
    assert.equal(got[0].para, 1);

    const parsed = parseSource(got[0].source);
    assert.equal(parsed.role, 'assistant');
    assert.equal(parsed.sessionId, 's1');
    assert.equal(parsed.turn, 3);
    assert.equal(parsed.step, 2);
  } finally { f.app.dispose(); }
});

test('思考链与工具调用块不进记忆，只留正文', () => {
  const f = fixture();
  try {
    f.emit('s2', 1, 1, f.blocks(
      f.reasoning('我先想想用户到底要的是什么，这段内心独白绝不能进库。'),
      f.toolCall('memjudge_recall'),
      f.text(CONCLUSION),
      f.toolCall('memjudge_remember'),
    ));
    f.endTurn('s2', 1);
    const got = rows(f.api, 's2', 1, 1);
    assert.equal(got.length, 1);
    assert.equal(got[0].text, CONCLUSION);
    assert.ok(!got[0].text.includes('内心独白'));
    assert.ok(!got[0].text.includes('memjudge_recall'));
  } finally { f.app.dispose(); }
});

test('短应答、纯代码块、纯表格一律不落库', () => {
  const f = fixture();
  try {
    const before = f.api.stats().memories;
    f.emit('s3', 1, 1, f.blocks(f.text(TINY)));
    f.emit('s3', 1, 2, f.blocks(f.text(CODE_ONLY)));
    f.emit('s3', 1, 3, f.blocks(f.text(TABLE)));
    assert.equal(f.api.stats().memories, before);
  } finally { f.app.dispose(); }
});

test('同一结论在另一 step 重复产出时被近似判重挡住', () => {
  const f = fixture();
  try {
    f.round('s4', 1, 1, f.blocks(f.text(CONCLUSION)));
    const first = rows(f.api, 's4', 1, 1);
    assert.ok(first.length >= 1);
    const before = f.api.stats().memories;
    f.round('s4', 1, 2, f.blocks(f.text(`${CONCLUSION}。`)));
    assert.equal(f.api.stats().memories, before, '同一结论换个 step 再来一次，不得新增条目');
    assert.deepEqual(rows(f.api, 's4', 1, 2), []);
  } finally { f.app.dispose(); }
});

test('autoCapture 总开关同时关住 assistant 通路', () => {
  const f = fixture({ autoCapture: false });
  try {
    f.emit('s5', 1, 1, f.blocks(f.text(CONCLUSION)));
    assert.equal(f.api.stats().memories, 0);
  } finally { f.app.dispose(); }
});

test('autoCaptureAssistant=false 只关 assistant，user 通路照旧', async () => {
  const f = fixture({ autoCaptureAssistant: false });
  try {
    const fact = '这个项目的包管理器用 pnpm，别用 npm';
    await f.userTurn('s6', 1, fact);
    assert.equal(f.api.bySourcePrefixV1(formatSource('s6', 1)).length, 1);
    f.emit('s6', 1, 1, f.blocks(f.text(CONCLUSION)));
    assert.equal(f.api.stats().memories, 1);
  } finally { f.app.dispose(); }
});

test('同轮 user 与 assistant 领到不同章号，互不覆盖', async () => {
  const f = fixture();
  try {
    const fact = '窗台上的蓝色台灯每天晚上八点亮起';
    await f.userTurn('s7', 1, fact);
    f.round('s7', 1, 1, f.blocks(f.text(CONCLUSION)));

    const userRow = f.api.bySourcePrefixV1(formatSource('s7', 1))[0];
    const asstRow = rows(f.api, 's7', 1, 1)[0];
    assert.ok(userRow && asstRow);
    assert.notEqual(userRow.chapter, asstRow.chapter);
    assert.equal(userRow.para, 1);
    assert.equal(asstRow.para, 1);
  } finally { f.app.dispose(); }
});

test('非 assistant/message 事件与畸形负载都不触发采集、不抛错', () => {
  const f = fixture();
  try {
    const handler = f.hooks.get('session/event');
    const before = f.api.stats().memories;
    const noisy = [
      undefined, null, {}, { type: 'user/message', data: {} },
      { type: 'tool/result', data: { message: { role: 'assistant', content: [] } } },
      { type: 'assistant/message', data: null },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: null } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'user', content: [] } } },
      { type: 'assistant/message', data: { turn: 'x', step: 1, message: { role: 'assistant', content: [] } } },
    ];
    for (const event of noisy) assert.doesNotThrow(() => handler({ id: 's8' }, event));
    assert.doesNotThrow(() => handler(null, { type: 'assistant/message', data: { turn: 1, step: 1 } }));
    assert.equal(f.api.stats().memories, before);
  } finally { f.app.dispose(); }
});

test('写入后 recall 能查回这条 assistant 结论', async () => {
  const f = fixture();
  try {
    f.round('s9', 2, 1, f.blocks(f.text(CONCLUSION)));
    const recall = f.tools.get('memjudge_recall');
    assert.equal(typeof recall?.execute, 'function');
    const result = await recall.execute({ query: '自动采集 章号 通路' });
    const payload = JSON.stringify(result);
    assert.ok(payload.includes('自动采集'),
      `recall 结果里应能看到刚落的结论：${payload.slice(0, 400)}`);
  } finally { f.app.dispose(); }
});
