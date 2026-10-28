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
  WIKI_VERSION,
  TRIAGE,
  PAGE_STATUS,
  compileWiki,
  diffWiki,
  groundingViolations,
  planWrite,
  parseTriageMark,
  rawDigest,
  conflictJudgments,
} from '../src/layer.mjs';
import { scoreConflict } from '../../mem-eval/harness/score.mjs';

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

// ---------------------------------------------------------------- 编译层（t14）

section('llm-wiki 编译层：raw → wiki 投影');

const RAWS = [
  { id: 'r1', text: '白鲸号焊缝凹陷九厘米。', createdAt: 1000, ch: 5 },
  { id: 'r2', text: '白鲸号焊缝凹陷十一厘米，原报九厘米系估值，现予更正。', createdAt: 2000, ch: 15 },
  { id: 'r3', text: '白鲸号吃水十二米。', createdAt: 3000, ch: 2 },
  { id: 'r4', text: '白鲸号吃水十三米。', createdAt: 3000, ch: 3 },
  { id: 'r5', text: '今天心情不好。', createdAt: 4000 },
];

check('compileWiki 连跑两次 0 差异（doc/facts/status 全部逐字节相同）', () => {
  const a = compileWiki(RAWS);
  const b = compileWiki(RAWS);
  const d = diffWiki(a, b);
  assert.equal(d.same, true, `两次编译有差异：added=${d.added} removed=${d.removed} changed=${JSON.stringify(d.changed)}`);
  assert.equal(d.docSame, true);
  assert.equal(d.rawDigestSame, true);
  assert.equal(a.doc, b.doc);
});

check('编译不碰 raw：入参对象按值不变，rawDigest 只由 id+text 决定', () => {
  const snapshot = JSON.parse(JSON.stringify(RAWS));
  const before = rawDigest(RAWS);
  const wiki = compileWiki(RAWS);
  compileWiki(RAWS, { now: 1 });
  assert.deepEqual(RAWS, snapshot, 'compileWiki 改写了入参 raw');
  assert.equal(rawDigest(RAWS), before);
  assert.equal(wiki.rawDigest, before);
  // 只改 createdAt 不改正文时，raw 指纹不变（时间不是 raw 的内容）
  const touched = RAWS.map((m) => ({ ...m, createdAt: m.createdAt + 999 }));
  assert.equal(rawDigest(touched), before);
});

check('排序确定：输入顺序打乱后投影完全一致', () => {
  const shuffled = [RAWS[2], RAWS[0], RAWS[4], RAWS[1], RAWS[3]];
  assert.equal(diffWiki(compileWiki(RAWS), compileWiki(shuffled)).docSame, true);
});

check('Status 三态都能出现，被取代的旧值仍在投影里', () => {
  const wiki = compileWiki(RAWS);
  const c = wiki.statusCounts;
  assert.ok(c[PAGE_STATUS.CURRENT] >= 1, `缺 Current：${JSON.stringify(c)}`);
  assert.ok(c[PAGE_STATUS.OUTDATED] >= 1, `缺 Outdated：${JSON.stringify(c)}`);
  assert.ok(c[PAGE_STATUS.DISPUTED] >= 1, `缺 Disputed：${JSON.stringify(c)}`);
  // 旧值九厘米被判 Outdated，但它的块没被删除
  const oldBlock = wiki.blocks.find((b) => b.id === 'r1');
  assert.ok(oldBlock, 'r1 的块被删了——矛盾不该删');
  assert.equal(oldBlock.facts[0].value, '九厘米');
  assert.equal(oldBlock.facts[0].status, PAGE_STATUS.OUTDATED);
  assert.equal(oldBlock.facts[0].reason, 'revision-cue');
  // 「原报九厘米」在原文里就是旧值身份
  const restated = wiki.blocks.find((b) => b.id === 'r2').facts.find((f) => f.attr === '原报');
  assert.equal(restated.status, PAGE_STATUS.OUTDATED);
  assert.equal(restated.reason, 'restated-old');
  // 同槽多值且无法裁决：两边都留在 Disputed，没人被删
  const slot = wiki.slots.find((s) => s.slot === '白鲸号|白鲸号吃水');
  assert.ok(slot, `缺白鲸号吃水槽位：${wiki.slots.map((s) => s.slot).join(',')}`);
  assert.equal(slot.reason, 'same-time');
  assert.deepEqual(slot.disputed.sort(), ['十三米', '十二米'].sort());
  assert.deepEqual(slot.current, []);
});

check('Triage 四分：New/Update/Disputed/No material 各出现，落盘标记可解析回 kind', () => {
  const wiki = compileWiki(RAWS);
  const t = wiki.triageCounts;
  for (const kind of [TRIAGE.NEW, TRIAGE.UPDATE, TRIAGE.DISPUTED, TRIAGE.NO_MATERIAL]) {
    assert.ok(t[kind] >= 1, `分诊缺 ${kind}：${JSON.stringify(t)}`);
  }
  const byId = new Map(wiki.blocks.map((b) => [b.id, b]));
  assert.equal(byId.get('r1').triage, TRIAGE.NEW);
  assert.equal(byId.get('r2').triage, TRIAGE.UPDATE);
  assert.equal(byId.get('r2').triageReason, 'revision-cue');
  assert.equal(byId.get('r4').triage, TRIAGE.DISPUTED);
  assert.equal(byId.get('r5').triage, TRIAGE.NO_MATERIAL);
  for (const b of wiki.blocks) {
    assert.match(b.triageMark, /^triage:v1:/);
    assert.equal(parseTriageMark(b.triageMark), b.triage, `标记与 kind 不一致：${b.triageMark}`);
  }
  assert.equal(parseTriageMark(byId.get('r2').triageMark), 'update');
  assert.equal(parseTriageMark('garbage'), null);
});

check('planWrite：Update 挂 supersedes，Disputed 与同值重写都不挂取代链', () => {
  // 十二厘米 + 更正措辞：新值明确取代旧值九厘米 → 挂 r1
  const update = planWrite({ id: 'n1', text: '白鲸号焊缝凹陷十二厘米，现予更正。', createdAt: 5000 }, RAWS);
  assert.equal(update.triage, TRIAGE.UPDATE);
  assert.equal(update.reason, 'revision-cue');
  assert.deepEqual(update.supersedes, ['r1']);
  assert.equal(parseTriageMark(update.mark), 'update');

  // 同值重写：没有新信息，也就没有谁被取代
  const dup = planWrite({ id: 'n5', text: '白鲸号吃水十二米。', createdAt: 6000 }, RAWS);
  assert.equal(dup.triage, TRIAGE.UPDATE);
  assert.equal(dup.reason, 'same-value');
  assert.deepEqual(dup.supersedes, [], '同值重写不应挂取代链');

  const disputed = planWrite({ id: 'n2', text: '白鲸号吃水十三米。', createdAt: 3000 }, [RAWS[2]]);
  assert.equal(disputed.triage, TRIAGE.DISPUTED);
  assert.deepEqual(disputed.supersedes, [], 'Disputed 不应挂取代链');

  const fresh = planWrite({ id: 'n3', text: '白鲸号主机缸套换过两次。', createdAt: 5000 }, RAWS);
  assert.deepEqual(fresh.supersedes, []);
  const blank = planWrite({ id: 'n4', text: '', createdAt: 5000 }, RAWS);
  assert.equal(blank.triage, TRIAGE.NO_MATERIAL);
});

section('Grounding Invariant：投影的每个串都要在 raw 里逐字找到');

check('正常投影 0 违规（值/日期/引号串全命中 raw）', () => {
  const dated = [{ id: 'd1', text: '白鲸号于 2023-03-14 离港，吃水七点二米。', createdAt: 1 }];
  const wiki = compileWiki(dated);
  assert.deepEqual(groundingViolations(wiki), []);
});

check('数字与单位之间带空格时，投影值对齐回 raw 的逐字片段', () => {
  const spaced = [{ id: 's1', text: '白鲸号装货单上写的是 147 卷。', createdAt: 1 }];
  const wiki = compileWiki(spaced);
  const values = wiki.blocks[0].facts.map((f) => f.value);
  assert.ok(values.includes('147 卷'), `值未对齐回原文：${values.join(',')}`);
  assert.deepEqual(groundingViolations(wiki), []);
});

check('篡改投影里的值 → 报 value 违规并指名到块', () => {
  const wiki = compileWiki(RAWS);
  const broken = structuredClone(wiki);
  broken.blocks.find((b) => b.id === 'r1').facts[0].value = '九点五厘米';
  const v = groundingViolations(broken);
  assert.equal(v.length, 1, `应恰好 1 条违规，实际 ${JSON.stringify(v)}`);
  assert.equal(v[0].id, 'r1');
  assert.equal(v[0].field, 'value');
  assert.equal(v[0].token, '九点五厘米');
});

check('篡改投影里的引号串与日期 → 分别报 quote / date 违规', () => {
  const wiki = compileWiki(RAWS);
  const broken = structuredClone(wiki);
  broken.blocks[0].lines.push('Quote: "原文里没有的这句话"');
  broken.blocks[0].lines.push('- Status 复核于 2026-10-28 完成');
  const v = groundingViolations(broken);
  assert.ok(v.some((x) => x.field === 'quote' && x.token === '原文里没有的这句话'), JSON.stringify(v));
  assert.ok(v.some((x) => x.field === 'date' && x.token === '2026-10-28'), JSON.stringify(v));
});

check('跨块洗白无效：别的块里有这个串，本块没有仍是违规', () => {
  const wiki = compileWiki(RAWS);
  const broken = structuredClone(wiki);
  const target = broken.blocks.find((b) => b.id === 'r1');
  target.facts[0].value = '十二米'; // r3 里有，r1 里没有
  const v = groundingViolations(broken);
  assert.ok(v.some((x) => x.id === 'r1' && x.token === '十二米'), '跨块命中不应放过');
});

// ---------------------------------------------------------------- 召回路径冲突自述（t18）

section('召回路径冲突自述：同槽多值 + 修订语才说话');

// 语料真实片段（ch5 目测九厘米 / ch15 实测十一厘米并更正），句子指针照 facts 的形状给
const CH5_TEXT = '当日十九时四十分，二号货舱钢卷发生移位，三卷滚落撞击左舷舱壁，造成舱壁一处凹陷，凹陷深度约九厘米。';
const CH15_TEXT = '公估人后来在报告里写：“凹陷深度以十一厘米为准，形成时间是四月十八日之前。”';

function entriesOf() {
  return [
    {
      id: 'c05-p003',
      chapter: 5,
      text: CH5_TEXT,
      facts: [{ attr: '凹陷深度', value: '九厘米', at: CH5_TEXT.indexOf('九厘米'), sent_off: 0, sent_len: CH5_TEXT.length }],
    },
    {
      id: 'c15-p009',
      chapter: 15,
      text: CH15_TEXT,
      facts: [{ attr: '凹陷深度', value: '十一厘米', at: CH15_TEXT.indexOf('十一厘米'), sent_off: 0, sent_len: CH15_TEXT.length }],
    },
  ];
}

check('同槽多值 + 修订语 → 输出一行判断，且过 JUDGED_CONFLICT / 带修正值 / 落在前 200 字', () => {
  const js = conflictJudgments(entriesOf());
  assert.equal(js.length, 1, `应恰好 1 条，实际 ${JSON.stringify(js)}`);
  const line = js[0].line;
  assert.match(line, /两处记录不一致/);
  assert.ok(line.includes('十一厘米'), '判断行必须写出后文修正值');
  assert.deepEqual(js[0].values, ['九厘米', '十一厘米']);
  assert.equal(js[0].revised, '十一厘米');
  assert.ok(line.length < 200, `判断行 ${line.length} 字，太靠后会掉出前 200`);
  const sc = scoreConflict(line, { kw: ['九厘米', '十一厘米'] });
  assert.equal(sc.judgedConflict, true, '未命中 JUDGED_CONFLICT');
  assert.equal(sc.newSide, true, '未命中 newSide');
});

// 上面那条断言用 await，check() 是同步的，单独跑一遍把结果并进计数
check('同槽多值但没有修订语 → 不输出（宁可漏报，不在无关问题里塞判断）', () => {
  const plain = [
    { id: 'a', chapter: 2, text: '白鲸号吃水十二米。', facts: [{ attr: '吃水', value: '十二米', at: 6, sent_off: 0, sent_len: 13 }] },
    { id: 'b', chapter: 3, text: '白鲸号吃水十三米。', facts: [{ attr: '吃水', value: '十三米', at: 6, sent_off: 0, sent_len: 13 }] },
  ];
  assert.deepEqual(conflictJudgments(plain), []);
});

check('单值不输出；空输入不输出', () => {
  assert.deepEqual(conflictJudgments([{ id: 'x', chapter: 9, text: '凹陷深度九厘米。', facts: [{ attr: '凹陷深度', value: '九厘米', at: 0, sent_off: 0, sent_len: 10 }] }]), []);
  assert.deepEqual(conflictJudgments([]), []);
});

check('修正值取后文（章节号更大的那条），取值按先旧后新排', () => {
  const [j] = conflictJudgments(entriesOf().reverse());
  assert.equal(j.revised, '十一厘米');
  assert.deepEqual(j.values, ['九厘米', '十一厘米']);
});

check('不同 attr 各自独立，不跨属性拼冲突', () => {
  const mixed = [
    { id: 'a', chapter: 5, text: '凹陷深度九厘米，现予更正。', facts: [{ attr: '凹陷深度', value: '九厘米', at: 0, sent_off: 0, sent_len: 14 }] },
    { id: 'b', chapter: 15, text: '吃水十二米。', facts: [{ attr: '吃水', value: '十二米', at: 3, sent_off: 0, sent_len: 6 }] },
  ];
  assert.deepEqual(conflictJudgments(mixed), []);
});

console.log(`\n${failures.length ? 'FAILURES' : 'ALL PASS'}  ${passed}/${passed + failures.length} 项断言通过`);if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.err.message.split('\n')[0]}`);
  process.exit(1);
}
