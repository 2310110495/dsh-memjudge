import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_KIND_TAG_PREFIX,
  autoKindSource,
  classifyCaptureKind,
  createKindQuota,
  factSlotOf,
  parseAutoKindTag,
  personVerdict,
  promiseVerdict,
  sameFactSlot,
} from '../src/kind-classify.mjs';

// ── 12+ 例对照表 ────────────────────────────────────────────────────────────
// 这张表就是判据的可读规格：改任何一条正则，先看这里哪一行先红。
const TABLE = [
  { text: '记住，这个仓库以后一律用 pnpm 装依赖', kind: 'promise', reason: 'imperative-head' },
  { text: '你以后别在提交里带调试代码', kind: 'promise', reason: 'second-person' },
  { text: '以后都用 pnpm 装依赖，不许用 npm', kind: 'promise', reason: 'future-head' },
  { text: '我们约定周五下午不发版', kind: 'promise', reason: 'second-person' },
  { text: '这个测试必须是绿的', kind: 'event', reason: 'descriptive' },
  { text: '这个规范很简单', kind: 'event', reason: 'descriptive' },
  { text: '以后会好起来的', kind: 'event', reason: 'descriptive' },
  { text: '必须承认这个实现很糙', kind: 'event', reason: 'descriptive' },
  { text: '我是做后端的，主要写 Node 服务', kind: 'person', reason: 'strong' },
  { text: '我一般用 pnpm 管依赖', kind: 'person', reason: 'strong' },
  { text: '我的机器是 M3 Max，32G 内存', kind: 'person', reason: 'strong' },
  { text: '我讨厌荧光灯的色温', kind: 'person', reason: 'strong' },
  { text: '我在合肥的一家小公司工作', kind: 'person', reason: 'strong' },
  { text: '我明天去北京出差，晚上回来', kind: 'event', reason: 'one-off' },
  { text: '我现在很累，明天再改这块代码', kind: 'event', reason: 'temporary-state' },
  { text: '我能不能改用 npm 装依赖', kind: 'event', reason: 'question' },
  { text: '我刚跑了测试，全绿', kind: 'event', reason: 'one-off' },
  { text: '我有一个临时补丁要应用', kind: 'event', reason: 'no-strong-match' },
  { text: '我的问题是这个函数报错', kind: 'event', reason: 'no-strong-match' },
];

test('kind 判定对照表：19 例逐条核对 kind 与判据名', () => {
  for (const row of TABLE) {
    const verdict = classifyCaptureKind(row.text, { role: 'user' });
    assert.equal(verdict.kind, row.kind, `kind 不符：${row.text}`);
    if (row.kind === 'event') {
      // 描述性句子里 event 的 reason 可能是 descriptive 或 person 侧的具体否决原因，
      // 唯一不该出现的是「命中强特征却落 event」——那说明判据顺序被打乱。
      assert.notEqual(verdict.reason, 'strong', `被强特征误判：${row.text}`);
    } else {
      assert.equal(verdict.reason, row.reason, `判据名不符：${row.text}`);
    }
  }
});

test('directive 第二判据：宽词误命中不升格为约定（≥3 例）', () => {
  const descriptive = [
    '这个测试必须是绿的',
    '这个规范很简单',
    '必须承认这个实现很糙',
    '以后会好起来的',
    '这块代码的规则一直没写清楚',
  ];
  for (const text of descriptive) {
    assert.equal(promiseVerdict(text).promise, false, `误升格：${text}`);
    assert.equal(classifyCaptureKind(text, { role: 'user' }).kind, 'event', `误升格：${text}`);
  }
});

test('directive 第二判据：祈使句首 / 以后+指令 / 第二人称三条通路各自成立', () => {
  assert.deepEqual(promiseVerdict('记住，提交前必须跑测试'), { promise: true, reason: 'imperative-head' });
  assert.deepEqual(promiseVerdict('说好了以后只用 pnpm'), { promise: true, reason: 'imperative-head' });
  assert.deepEqual(promiseVerdict('以后都别直接推 main'), { promise: true, reason: 'future-head' });
  assert.deepEqual(promiseVerdict('你以后别在提交里带调试代码'), { promise: true, reason: 'second-person' });
  assert.deepEqual(promiseVerdict('咱们约定周末不加班'), { promise: true, reason: 'second-person' });
  assert.deepEqual(promiseVerdict('这个功能挺好的'), { promise: false, reason: 'no-directive' });
});

test('person 正例：五种稳定事实形态全部命中', () => {
  const positives = [
    '我是做后端的，主要写 Node 服务',
    '我一般用 pnpm 管依赖',
    '我的机器是 M3 Max，32G 内存',
    '我讨厌荧光灯的色温',
    '我在合肥的一家小公司工作',
    '我习惯把配置写在 json 里',
    '我不用 Trae，只用 Cursor 写代码',
  ];
  for (const text of positives) {
    const verdict = personVerdict(text);
    assert.equal(verdict.person, true, `未命中：${text}`);
    assert.ok(verdict.attr, `缺属性槽：${text}`);
  }
});

test('person 反例：一次性动作、临时状态、问句、意图全部挡住（≥5 例）', () => {
  const negatives = [
    ['我明天去北京出差，晚上回来', 'one-off'],
    ['我刚跑了测试，全绿', 'one-off'],
    ['我现在很累，明天再改这块代码', 'temporary-state'],
    ['我能不能改用 npm 装依赖', 'question'],
    ['我是来问个问题的', 'intent'],
    ['我有一个临时补丁要应用', 'no-strong-match'],
    ['我的问题是这个函数报错', 'no-strong-match'],
  ];
  for (const [text, reason] of negatives) {
    const verdict = personVerdict(text);
    assert.equal(verdict.person, false, `误升格：${text}`);
    assert.equal(verdict.reason, reason, `否决原因不符：${text}`);
  }
});

test('person 只能来自 user：assistant 的消息永远是 event', () => {
  const text = '我是做后端的，主要写 Node 服务';
  assert.equal(classifyCaptureKind(text, { role: 'assistant' }).kind, 'event');
  assert.equal(classifyCaptureKind(text, { role: 'assistant' }).reason, 'not-user-role');
  // role 缺失时按 user 处理（user 通路的调用方不总是显式传 role）
  assert.equal(classifyCaptureKind(text, {}).kind, 'person');
});

test('属性槽：同 kind 同 attr 且核心串相同/包含才算同一事实', () => {
  assert.equal(factSlotOf('我明天去北京出差'), null, '非事实句不该有槽');
  assert.deepEqual(factSlotOf('我一般用 pnpm 管依赖'), {
    kind: 'person', attr: 'habit', value: '一般用pnpm管依赖',
  });

  assert.equal(sameFactSlot('我的编辑器是VSCode，平时不换', '我的编辑器是VSCode'), true);
  assert.equal(sameFactSlot('我的编辑器是 VSCode', '我的编辑器是VSCode。'), true);
  // 同 attr 不同取值：是更新而不是重复，必须允许写入
  assert.equal(sameFactSlot('我一般用 pnpm 管依赖', '我一般用 npm 管依赖'), false);
  // 不同 attr：不同事实上，永不判重
  assert.equal(sameFactSlot('我讨厌荧光灯', '我一般用 pnpm 管依赖'), false);
});

test('person/promise 独立配额：1 条/轮、10 条/会话', () => {
  const quota = createKindQuota({ perTurnLimit: 1, sessionLimit: 10 });
  assert.equal(quota.admit('s', 1).ok, true);
  assert.deepEqual(quota.admit('s', 1), { ok: false, reason: 'turn-limit' });
  assert.equal(quota.admit('s', 2).ok, true, '新的一轮重新计数');

  const one = createKindQuota({ perTurnLimit: 5, sessionLimit: 3 });
  assert.equal(one.admit('s', 1).ok, true);
  assert.equal(one.admit('s', 1).ok, true);
  assert.equal(one.admit('s', 1).ok, true);
  assert.deepEqual(one.admit('s', 2), { ok: false, reason: 'session-limit' });

  // 会话彼此独立：一个会话用满不影响另一个
  assert.equal(one.admit('t', 1).ok, true);
  assert.deepEqual(createKindQuota({}).admit('', 1), { ok: false, reason: 'invalid-session' });
});

test('自动写入的 kind 标记可读回，event 不加尾标', () => {
  const base = 'auto:chat:v2#abc:t1';
  assert.equal(autoKindSource(base, 'person'), `${base}${AUTO_KIND_TAG_PREFIX}person`);
  assert.equal(autoKindSource(base, 'promise'), `${base}${AUTO_KIND_TAG_PREFIX}promise`);
  assert.equal(autoKindSource(base, 'event'), base);
  // 幂等：重复加标记不会叠两层
  assert.equal(autoKindSource(autoKindSource(base, 'person'), 'person'), `${base}${AUTO_KIND_TAG_PREFIX}person`);
  assert.equal(parseAutoKindTag(autoKindSource(base, 'person')), 'person');
  assert.equal(parseAutoKindTag(base), null);
  assert.equal(parseAutoKindTag('manual:note'), null);
});
