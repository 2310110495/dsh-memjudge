// memjudge 图层自检（t4 产物 src/layer.mjs 的集成冒烟）
// 运行：node memjudge-plugin/test/layer.test.mjs
//
// t4 交付的 layer.mjs 在集成时没有任何测试引用，属于「能被 import 但零验证」的
// 孤儿模块。四个来源（soul-md 索引 / prime-memory 字段加权 / mneme sleep）的
// 契约在这里各钉一条，保证接线后行为可核算。

import assert from 'node:assert/strict';
import {
  queryTerms,
  boundedInteger,
  searchTopics,
  renderRecall,
  GRAPH_FIELD_WEIGHTS,
  searchGraphNodes,
  sleepPhase,
} from '../src/layer.mjs';

const DAY = 86400000;
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message.split('\n')[0]}`);
  }
}

function section(title) {
  console.log(`\n[${title}]`);
}

// ---------------------------------------------------------------- 索引层

section('soul-md 索引：queryTerms / searchTopics / renderRecall');

check('queryTerms 出 CJK 二元组与拉丁词，长度 >1 且上限 64', () => {
  const terms = queryTerms('白鲸号 hull-9 焊缝凹陷');
  assert.ok(terms.includes('白鲸'), '缺二元组 白鲸');
  assert.ok(terms.includes('焊缝'), '缺二元组 焊缝');
  assert.ok(terms.includes('hull-9'), '缺拉丁词 hull-9');
  assert.ok(terms.every((t) => t.length > 1));
  assert.ok(queryTerms('甲'.repeat(500)).length <= 64);
  assert.deepEqual(queryTerms(''), []);
});

check('boundedInteger 钳位：NaN 回退、负数归零、超限取 max、小数取整', () => {
  assert.equal(boundedInteger(NaN, 7, 20), 7);
  assert.equal(boundedInteger(-5, 7, 20), 0);
  assert.equal(boundedInteger(1e9, 7, 20), 20);
  assert.equal(boundedInteger(3.9, 7, 20), 3);
});

const TOPICS = [
  { key: 'hull', title: '舱壁凹陷', summary: '左舷焊缝凹陷九厘米', source: 'log', file: 'hull.md' },
  { key: 'weather', title: '海况', summary: '风力六级', source: 'log', file: 'weather.md' },
  { key: 'gone', title: '缺正文', summary: '白鲸号', source: 'log', file: 'gone.md' },
];
const BODIES = { 'hull.md': '白鲸号 舱壁 九厘米 焊缝', 'weather.md': '海面 风力六级' };
const readText = (file) => BODIES[file] ?? null;

check('searchTopics 按 label×4/summary×2/content×1 排序，正文缺失的 topic 被剔除', () => {
  const hits = searchTopics(TOPICS, '白鲸号舱壁', readText);
  assert.equal(hits[0].key, 'hull', `首位应是 hull，实际 ${hits.map((h) => h.key).join(',')}`);
  assert.ok(!hits.some((h) => h.key === 'gone'), 'readText 返回 null 的 topic 不应出现');
  assert.ok(hits[0].score > 0);
});

check('searchTopics 空查询返回空数组（不做全量倾倒）', () => {
  assert.deepEqual(searchTopics(TOPICS, '   ', readText), []);
});

check('renderRecall 只渲染 descriptor 行，不注入正文', () => {
  const groups = [{ heading: '## 舰船', topics: [{ key: 'hull', title: '舱壁凹陷', summary: '左舷九厘米' }] }];
  const out = renderRecall(groups, 4000);
  assert.equal(out, '## 舰船\n- "hull" — 舱壁凹陷：左舷九厘米');
  assert.ok(!out.includes('焊缝'), '正文内容不应出现在索引渲染里');
});

check('renderRecall 受 cap 约束：容量不足时整行丢弃', () => {
  const groups = [{ heading: '## 舰船', topics: [{ key: 'hull', title: '舱壁凹陷', summary: '左舷九厘米' }] }];
  assert.equal(renderRecall(groups, 8), '');
});

// ---------------------------------------------------------------- 图层加权

section('prime-memory 图层：字段权重 + searchGraphNodes');

check('GRAPH_FIELD_WEIGHTS 阶梯：name 最高、relations 最低', () => {
  assert.equal(GRAPH_FIELD_WEIGHTS.name, 6);
  assert.equal(GRAPH_FIELD_WEIGHTS.relations, 3);
  assert.equal(GRAPH_FIELD_WEIGHTS.type, 2);
  const values = Object.values(GRAPH_FIELD_WEIGHTS);
  assert.equal(Math.max(...values), GRAPH_FIELD_WEIGHTS.name);
  assert.equal(Math.min(...values), GRAPH_FIELD_WEIGHTS.type);
});

const NODES = [
  { id: 'n1', name: '白鲸号', aliases: ['WB'], tags: [], currentState: '', facts: {}, relations: [], type: 'ship' },
  { id: 'n2', name: '破冰船', aliases: [], tags: [], currentState: '', facts: {}, relations: [], type: '白鲸号级' },
  { id: 'n3', name: '噪声节点', aliases: [], tags: [], currentState: '', facts: {}, relations: [{ type: '白鲸号' }], type: '' },
  { id: 'n4', name: '无关', aliases: [], tags: [], currentState: '', facts: {}, relations: [], type: 'buoy' },
];

check('searchGraphNodes：name 命中分高于 type 命中，仅关系命中的邻接噪声被丢弃', () => {
  const hits = searchGraphNodes(NODES, '白鲸号');
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes('n1') && ids.includes('n2'), `命中集异常：${ids.join(',')}`);
  assert.ok(!ids.includes('n3'), '只有 relations 命中的节点应被过滤');
  assert.ok(!ids.includes('n4'), '零命中节点不应返回');
  const n1 = hits.find((h) => h.id === 'n1');
  const n2 = hits.find((h) => h.id === 'n2');
  assert.ok(n1.score > n2.score, `name(${n1.score}) 应高于 type(${n2.score})`);
  assert.deepEqual(n1.matchedFields, ['name']);
  assert.equal(n1.matchReason, '名称');
});

check('searchGraphNodes limit 生效且为空查询返回空', () => {
  assert.equal(searchGraphNodes(NODES, '白鲸号', 1).length, 1);
  assert.deepEqual(searchGraphNodes(NODES, ''), []);
});

// ---------------------------------------------------------------- 后台整理

section('mneme 后台整理：sleepPhase 四阶段');

check('四阶段结果槽位齐全（conflicts/archived/patterns/relations/errors）', () => {
  const r = sleepPhase([{ id: 'a', text: '白鲸号吃水九米', createdAt: Date.now() }]);
  assert.deepEqual(Object.keys(r).sort(), ['archived', 'conflicts', 'errors', 'patterns', 'relations']);
  assert.deepEqual(r.errors, []);
});

check('归档降级按 archiveDays/compressDays 分 action', () => {
  const now = Date.now();
  const mems = [
    { id: 'fresh', text: '白鲸号吃水九米', createdAt: now - 1 * DAY },
    { id: 'old', text: '白鲸号吃水九米五', createdAt: now - 40 * DAY },
    { id: 'ancient', text: '白鲸号吃水十米', createdAt: now - 120 * DAY },
  ];
  const { archived } = sleepPhase(mems, { archiveDays: 30, compressDays: 90 });
  const byId = new Map(archived.map((a) => [a.id, a.action]));
  assert.equal(byId.has('fresh'), false);
  assert.equal(byId.get('old'), 'demote');
  assert.equal(byId.get('ancient'), 'archive');
});

check('fail-safe：模式发现阶段抛错只记 errors，其余阶段结果不受影响', () => {
  const now = Date.now();
  const r = sleepPhase(
    [{ id: 'old', text: '白鲸号吃水九米', createdAt: now - 40 * DAY }],
    { llm: () => { throw new Error('LLM 429'); } },
  );
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].phase, 'pattern');
  assert.match(r.errors[0].error, /429/);
  assert.ok(r.archived.some((a) => a.id === 'old'), '归档阶段不应被上游失败拖垮');
});

console.log(`\n${failures.length ? 'FAILURES' : 'ALL PASS'}  ${passed}/${passed + failures.length} 项断言通过`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.err.message.split('\n')[0]}`);
  process.exit(1);
}
