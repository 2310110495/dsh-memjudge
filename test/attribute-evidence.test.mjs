import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, isHardDeny } from '../src/index.mjs';
import { attributeEvidence, attributeValues } from '../src/attribute-evidence.mjs';

for (const [text, expected] of [
  ['BM25的颜色是红色。已经改为蓝色。', []],
  ['BM25的颜色是红色。不再是红色。', []],
  ['BM25的名字是并非张三。', []],
  ['BM25的名字是并不是张三。', []],
  ['BM25的名字是张或。', ['张或']],
  ['BM25的名字是张三或李四。', []],
  ['BM25的颜色是红色。', ['红色']],
  ['BM25的名字是不二。', ['不二']],
  ['BM25的颜色是红色。其他物品已经改为蓝色。', ['红色']],
]) {
  test(`regression: ${text}`, () => {
    const field = text.includes('名字') ? '名字' : '颜色';
    assert.deepEqual(attributeValues(`bm25的${field}是什么`, [{ text }]), expected);
  });
}

test('omitted subjects and correction boundaries', () => {
  const en = "what is bm25's color?";
  const zh = 'bm25的颜色是什么';
  for (const text of ["BM25's color is red. Later changed to blue.", "BM25's color is red. It changed to blue.", "BM25's color is red. BM25's color was corrected to blue."]) {
    assert.deepEqual(attributeValues(en, [{ text }]), [], text);
  }
  assert.deepEqual(attributeValues(zh, [{ text: 'BM25的颜色是红色。' }, { text: 'BM25的颜色已改为蓝色。' }]), []);
  assert.deepEqual(attributeValues(zh, [{ text: 'BM25的颜色是红色。颜色改为蓝色。' }]), []);
  assert.deepEqual(attributeValues(zh, [{ text: 'BM25的颜色是红色。其他物品的颜色改为蓝色。' }]), ['红色']);
  assert.deepEqual(attributeValues(en, [{ text: "BM25's color is red. Other's color changed to blue." }]), ['red']);
  for (const name of ['不二', '未央']) assert.deepEqual(attributeValues('bm25的名字是什么', [{ text: `BM25的名字是${name}。` }]), [name]);
  for (const name of ['未知', '不详', '尚未确定', '待确认', '不是张三', '没有名字']) assert.deepEqual(attributeValues('bm25的名字是什么', [{ text: `BM25的名字是${name}。` }]), []);
});

test("correction scope distinguishes attributed and ambiguous changes", () => {
  const q = "bm25的颜色是什么";
  for (const text of [
    "BM25的颜色是红色。BM25的颜色后来改为蓝色。",
    "BM25的颜色是红色。后来变成蓝色。",
    "BM25的颜色是红色。BM25的颜色已经更正为蓝色。",
  ]) assert.deepEqual(attributeValues(q, [{ text }]), [], text);
  assert.deepEqual(attributeValues("what is bm25\x27s color?", [{ text: "BM25\x27s color is red. BM25\x27s color changed to blue." }]), []);
  assert.deepEqual(attributeValues(q, [{ text: "其他物品是红色。后来改为蓝色。BM25的颜色是红色。" }]), []);
  assert.deepEqual(attributeValues(q, [{ text: "BM25的颜色是红色。其他物品是绿色。后来改为蓝色。" }]), []);
  assert.deepEqual(attributeValues(q, [{ text: "BM25的颜色是红色。其他物品后来改为蓝色。" }]), ["红色"]);
  assert.deepEqual(attributeValues(q, [{ text: "其他物品是绿色。后来变成蓝色。", truncated: true, startsAtBoundary: false }, { text: "BM25的颜色是红色。" }]), []);
  assert.deepEqual(attributeValues(q, [{ text: "BM25的颜色是红色。" }, { text: "后来变成蓝色。" }]), []);
});

test('qualified and retracted claims are not current evidence', () => {
  const cases = [
    ['bm25的颜色是什么', 'BM25的颜色是红色如果灯亮。'],
    ["what is bm25\x27s color?", "BM25\x27s color is red if illuminated."],
    ["what is bm25\x27s color?", "BM25\x27s color is red yesterday."],
    ['bm25的颜色是什么', 'BM25的颜色是红色。后来改成蓝色。'],
    ['bm25的颜色是什么', 'BM25的颜色是红色。后来更正为蓝色。'],
    ['bm25的名字是什么', 'BM25的名字是无。'],
    ['bm25的颜色是什么', 'BM25的颜色是红色。这个说法是假的。'],
    ["what is bm25\x27s color?", "BM25\x27s color is red. This is false."],
  ];
  for (const [query, text] of cases) assert.deepEqual(attributeValues(query, [{ text }]), [], text);
});

test('negation words inside names do not negate the assertion', () => {
  assert.deepEqual(attributeValues('bm25的颜色是什么', [{ text: 'BM25的颜色是红色。后来改为蓝色。' }]), []);
  assert.deepEqual(attributeValues('bm25的颜色是什么', [{ text: 'BM25的颜色是红色。其他物品后来改成蓝色。' }]), ['红色']);
  assert.deepEqual(attributeValues('bm25的颜色是什么', [{ text: 'BM25的颜色是红色。' }, { text: '后来改成蓝色。' }]), []);
  assert.deepEqual(attributeValues('bm25的名字是什么', [{ text: 'BM25的名字是无忌。' }]), ['无忌']);
  assert.deepEqual(attributeValues("what is bm25\x27s name?", [{ text: "BM25\x27s name is No Doubt." }]), ['no doubt']);
});

test('ambiguous alternatives and pending values are not affirmative evidence', () => {
  for (const [query, text] of [
    ['bm25的颜色是什么', 'BM25的颜色是红色或者蓝色。'],
    ['bm25的颜色是什么', 'BM25的颜色是红色或蓝色。'],
    ['bm25的颜色是什么', 'BM25的颜色是红色待确认。'],
    ["what is bm25's color?", "BM25's color is red or blue."],
    ["what is bm25's color?", "BM25's color is red pending confirmation."],
  ]) assert.deepEqual(attributeValues(query, [{ text }]), [], text);
});

test('strict evidence', () => {
  const q = 'bm25的颜色是什么';
  const hit = (text, truncated = false) => [{ text, truncated }];
  assert.equal(attributeEvidence(q, hit('ＢＭ２５的颜色是红色。')), true);
  for (const text of ['BM250的颜色是红色。', 'BM25的颜色是什么？', 'BM25的颜色不是红色。', 'BM25的颜色是。', 'BM25的价格是100元。', '其他的颜色是红色。']) assert.equal(attributeEvidence(q, hit(text)), false, text);
  assert.equal(attributeEvidence(q, hit('BM25的颜色是红色。', true)), false);
  assert.equal(attributeEvidence(q, hit('BM25的颜色是红色')), false);
  assert.equal(attributeEvidence(q, hit('BM25的颜色是未知。')), false);
  const apostrophe = String.fromCharCode(39);
  const eq = `what is BM25${apostrophe}s color?`;
  assert.equal(attributeEvidence(eq, hit(`BM25${apostrophe}s color is red.`)), true);
  assert.equal(attributeEvidence(eq, hit(`BM250${apostrophe}s color is red.`)), false);
  assert.equal(attributeEvidence(eq, hit(`BM25${apostrophe}s color is not red.`)), false);
  assert.equal(attributeEvidence('bm25', hit('ＢＭ２５是100元。')), null);
  assert.equal(isHardDeny({ reason: 'no-facts' }, 'bm25', 'ＢＭ２５是100元。'), false);
  assert.equal(isHardDeny({ reason: 'no-facts' }, 'bm25', 'BM250是100元。'), true);
});

test('Chinese and English entry points require complete matching affirmative evidence', async () => {
  const cases = [
    ['BM25的颜色是红色。', 'bm25的颜色是什么', 100, false],
    ['BM25的颜色是红色。已经改为蓝色。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是红色。不再是红色。', 'bm25的颜色是什么', 100, true],
    ['BM25的名字是并非张三。', 'bm25的名字是什么', 100, true],
    ['BM25的名字是并不是张三。', 'bm25的名字是什么', 100, true],
    ['BM25的名字是张或。', 'bm25的名字是什么', 100, false],
    ['BM25的名字是张三或李四。', 'bm25的名字是什么', 100, true],
    ['BM25的颜色是红色如果灯亮。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是红色。这个说法是假的。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是红色。BM25的颜色已经更正为蓝色。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是红色。后来变成蓝色。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是红色。其他物品后来改为蓝色。', 'bm25的颜色是什么', 100, false],
    ['BM25的名字是无忌。', 'bm25的名字是什么', 100, false],
    ['BM25的名字是不二。', 'bm25的名字是什么', 100, false],
    ['BM25的名字是未央。', 'bm25的名字是什么', 100, false],
    ['BM25的名字是不是张三。', 'bm25的名字是什么', 100, true],
    ["BM25's color is red. It changed to blue.", "what is bm25's color?", 100, true],
    ['BM25的颜色是红色。颜色改为蓝色。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是无色。', 'bm25的颜色是什么', 100, false],
    ['BM25的颜色是可能红色。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是红色或者蓝色。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是红色待确认。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是红色吗。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色不是红色。', 'bm25的颜色是什么', 100, true],
    ['BM250的颜色是红色。', 'bm25的颜色是什么', 100, true],
    ['其他的颜色是红色。BM25的价格是100元。', 'bm25的颜色是什么', 100, true],
    ['BM25的颜色是红色。', 'bm25的颜色是什么', 8, true],
    [`BM25's color is red.`, `what is BM25's color?`, 100, false],
    [`BM25's color is not red.`, `what is BM25's color?`, 100, true],
    [`BM25's color is red or blue.`, `what is BM25's color?`, 100, true],
    [`BM25's color is red pending confirmation.`, `what is BM25's color?`, 100, true],
    [`BM250's color is red.`, `what is BM25's color?`, 100, true],
    [`other's color is red. BM25's price is 100.`, `what is BM25's color?`, 100, true],
    [`BM25's color is red.`, `what is BM25's color?`, 12, true],
  ];
  for (const [text, query, budget, denied] of cases) {
    const tools = new Map(), services = new Map();
    const ctx = { tools: { register: x => { tools.set(x.name, x); return () => {}; } }, systemPrompt: { section: () => () => {} }, provide: (name, value) => { services.set(name, value); return () => {}; }, effect: fn => fn(), on: () => () => {} };
    const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false, touchOnRecall: false });
    try {
      await tools.get('memjudge_remember').execute({ text });
      for (const call of [() => tools.get('memjudge_recall').execute({ query, budget }), () => services.get('memjudge').recallByQuery(query, { budget })]) {
        const result = await call();
        assert.equal(result.denied, denied, `${text} / ${query} / ${budget}`);
        if (!denied) assert.equal(result.hits[0].text, text);
      }
    } finally { app.dispose(); }
  }
});

test('tool and service use delivered evidence', async () => {
  const tools = new Map(), services = new Map();
  const ctx = { tools: { register: x => { tools.set(x.name, x); return () => {}; } }, systemPrompt: { section: () => () => {} }, provide: (name, value) => { services.set(name, value); return () => {}; }, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false, touchOnRecall: false });
  try {
    const original = 'ＢＭ２５的颜色是红色。';
    await tools.get('memjudge_remember').execute({ text: original });
    const missing = await tools.get('memjudge_recall').execute({ query: 'bm25的颜色是什么', budget: 8 });
    assert.equal(missing.reason, 'attribute-evidence-missing');
    assert.doesNotMatch(JSON.stringify(tools.get('memjudge_recall').output.render({}, missing)), /没有记载/);
    assert.match(JSON.stringify(tools.get('memjudge_recall').output.render({}, missing)), /交付片段/);
    for (const call of [(query, budget) => tools.get('memjudge_recall').execute({ query, budget }), (query, budget) => services.get('memjudge').recallByQuery(query, { budget })]) {
      const result = await call('bm25的颜色是什么', 100);
      assert.equal(result.denied, false);
      assert.equal(result.hits[0].text, original);
      assert.equal((await call('bm25的价格是多少', 100)).denied, true);
      assert.equal((await call('bm25的颜色是什么', 8)).denied, true);
    }
  } finally { app.dispose(); }
});

test('window boundaries, open values and conflicts reach both entry points', async () => {
  const tools = new Map(), services = new Map();
  const ctx = { tools: { register: x => { tools.set(x.name, x); return () => {}; } }, systemPrompt: { section: () => () => {} }, provide: (name, value) => { services.set(name, value); return () => {}; }, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false, touchOnRecall: false });
  try {
    const text = '😀前言。BM25的颜色是紫色。' + '其他说明。'.repeat(30);
    await tools.get('memjudge_remember').execute({ text });
    await tools.get('memjudge_remember').execute({ text: 'BM25的颜色是蓝色。' });
    const tool = tools.get('memjudge_recall');
    const calls = [() => tool.execute({ query: 'bm25的颜色是什么', budget: 100 }), () => services.get('memjudge').recallByQuery('bm25的颜色是什么', { budget: 100 })];
    for (const call of calls) {
      const result = await call();
      assert.equal(result.denied, false);
      assert.match(result.conflictLine, /紫色/);
      assert.match(result.conflictLine, /蓝色/);
      const cut = result.hits.find(h => h.truncated);
      assert.ok(cut);
      assert.equal(text.slice(cut.windowStart, cut.windowEnd), cut.text);
      assert.equal(cut.text.isWellFormed(), true);
    }
    const rendered = await calls[0]();
    assert.match(JSON.stringify(tool.output.render({}, rendered)), /属性存在不同取值/);
  } finally { app.dispose(); }
});

test('partial sentence remains insufficient despite an affirmative suffix', () => {
  const q = 'bm25的颜色是什么';
  assert.equal(attributeEvidence(q, [{ text: 'BM25的颜色是紫色。', truncated: true, startsAtBoundary: false }]), false);
  assert.equal(attributeEvidence(q, [{ text: 'BM25的颜色是紫色。', truncated: true, startsAtBoundary: true }]), true);
  assert.equal(attributeEvidence(q, [{ text: 'BM25的颜色是紫色', truncated: true, startsAtBoundary: true }]), false);
});

test('decimal conflict is scoped to delivered snippets at both entry points', async () => {
  const tools = new Map(), services = new Map();
  const ctx = { tools: { register: x => { tools.set(x.name, x); return () => {}; } }, systemPrompt: { section: () => () => {} }, provide: (name, value) => { services.set(name, value); return () => {}; }, effect: fn => fn(), on: () => () => {} };
  const app = apply(ctx, { dbPath: ':memory:', vector: false, expand: false, llmSelect: false, autoInject: false, touchOnRecall: false });
  try {
    await tools.get('memjudge_remember').execute({ text: 'BM25的价格是3.14元。' });
    await tools.get('memjudge_remember').execute({ text: 'BM25的价格是3.15元。' });
    const tool = tools.get('memjudge_recall');
    for (const call of [() => tool.execute({ query: 'bm25的价格是多少', budget: 100 }), () => services.get('memjudge').recallByQuery('bm25的价格是多少', { budget: 100 })]) {
      const result = await call();
      assert.equal(result.denied, false);
      assert.match(result.conflictLine, /本次交付片段/);
      assert.match(result.conflictLine, /3\.14/);
      assert.match(result.conflictLine, /3\.15/);
    }
  } finally { app.dispose(); }
});
