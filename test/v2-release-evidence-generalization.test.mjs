import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { gate, parseSlotQuery } from '../src/judge.mjs';
import { extractSlots } from '../src/slots.mjs';
import { extractL1 } from '../src/extract.mjs';

const pairs = [
  ['核心网关监听端口为8080。', '核心网关监听端口是多少？', false],
  ['核心网关监听端口为8080。', '核心网关监听端口是8080吗？', false],
  ['核心网关监听端口为8080。', '核心网关监听端口是9090吗？', true],
  ['星河项目的重试次数是3。', '星河项目的重试次数是3吗？', false],
  ['星河项目的重试次数是3。', '星河项目的重试次数是4吗？', true],
  ['星河项目的重试次数是13。', '星河项目的重试次数是3吗？', true],
  ['星河项目的重试次数是30。', '星河项目的重试次数是3吗？', true],
  ['甲服务的颜色是蓝色。乙服务的最大连接数是64。', '甲服务的最大连接数是多少？', true],
  ['甲服务的颜色是蓝色。乙服务的最大连接数是64。', '乙服务的最大连接数是多少？', false],
  ['甲服务的颜色是蓝色，乙服务的最大连接数是64。', '甲服务的最大连接数是64吗？', true],
  ['星河项目的超时时间为3秒。', '星河项目的超时时间是3000ms吗？', false],
  ['星河项目的超时时间为3秒。', '星河项目的超时时间是3ms吗？', true],
  ['星河项目的重试次数不是3。', '星河项目的重试次数是3吗？', true],
  ['在开发环境下星河项目的重试次数是3。', '星河项目的重试次数是3吗？', true],
  ['在开发环境下星河项目的重试次数是3。', '在开发环境下星河项目的重试次数是3吗？', false],
  ['光谱组件的自旋密度为7。', '光谱组件的自旋密度是7吗？', false],
  ['光谱组件的自旋密度为7。', '光谱组件的自旋密度是8吗？', true],
  ['星河项目的超时时间为3。', '星河项目的超时时间是3秒吗？', true],
  ['星河项目的超时时间为3秒。', '星河项目的超时时间是3吗？', false],
  ['在开发环境下，星河项目的重试次数是3。', '星河项目的重试次数是3吗？', true],
  ['在开发环境下，星河项目的重试次数是3。', '在开发环境下星河项目的重试次数是3吗？', false],
  ['乙甲服务的最大连接数是64。', '甲服务的最大连接数是64吗？', true],
  ['星河项目的重试次数不超过3。', '星河项目的重试次数是3吗？', true],
  ['实测稳定受电输入功率四百千瓦。', '输入功率是多少？', false],
  ['在开发环境下，输入功率为400千瓦。', '输入功率是多少？', true],
  ['输入功率不是400千瓦。', '输入功率是多少？', true],
  ['综合演练机器人释放至水面耗时四分钟。', '综合演练机器人释放耗时几分钟？', false],
];

for (const [body, query, denied] of pairs) {
  test('bound body: ' + query + ' / ' + body, () => {
    assert.equal(gate(query, body).deny, denied, JSON.stringify(gate(query, body)));
  });
  test('remember→recall: ' + query + ' / ' + body, async () => {
    const tools = new Map(), effects = [];
    const ctx = {
      tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name); } },
      systemPrompt: { section() { return () => {}; } },
      effect(fn) { const clean = fn(); effects.push(clean); return clean; },
    };
    apply(ctx, { dbPath: ':memory:', vector: false, rerank: false, expand: false, llmSelect: false, autoCapture: false });
    try {
      await tools.get('memjudge_remember').execute({ text: body });
      const result = await tools.get('memjudge_recall').execute({ query });
      assert.equal(result.denied, denied, JSON.stringify(result));
      if (!denied) assert.ok(result.chars > 0 && result.hits.length > 0);
    } finally { for (const fn of effects.reverse()) if (typeof fn === 'function') fn(); }
  });
}

test('compact yes/no parser retains full attribute and normalized value', () => {
  assert.deepEqual(parseSlotQuery('核心网关监听端口是8080吗？'), {
    entity: '核心网关', attr: '监听端口', expectedValue: '8080', expectedUnit: '', expectedRaw: '8080', checkValue: true,
  });
  assert.ok(extractSlots('核心网关监听端口为8080。').some(s => s.entity === '核心网关' && s.attr === '监听端口' && s.value === '8080'));
});

test('slotless candidates still allow genuinely bound body evidence', () => {
  const text = '核心网关监听端口为8080。';
  const candidate = { text, facts: [], entities: [] };
  assert.equal(gate('核心网关监听端口是8080吗？', candidate).deny, false);
  assert.equal(gate('核心网关监听端口是9090吗？', candidate).deny, true);
});

test('productive unseen engineering nouns and grounded novel measurements', () => {
  for (const attr of ['自旋密度', '谱线偏移量', '熔断恢复阈值', '采样批次数']) {
    const body = '光谱组件的' + attr + '为7。';
    assert.ok(extractSlots(body).some(s => s.entity === '光谱组件' && s.attr === attr && s.value === '7'));
  }
  const novel = '白鲸号凹陷实测深度为十一厘米。';
  assert.ok(extractL1(novel).some(f => f.value.includes('十一厘米') && novel.includes(f.sent)));
});
