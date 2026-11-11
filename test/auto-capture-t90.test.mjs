// T90 验收测试：把 assistant 的长回复真正切成可落库的段，并抽出动作型事实。
//
// 真源：src/auto-capture-assistant.mjs 的 planAssistantCapture、
//       src/auto-capture-segment.mjs 的 planSegments、
//       src/auto-capture-facts.mjs 的 extractActionFacts / buildWorkState、
//       src/auto-capture-turn.mjs 的 createTurnBuffer、
//       src/auto-capture.mjs 的 formatAssistantSource / parseSource 段号分支。
//
// 自我约束与另三个 assistant 测试同规格：不碰真库、不读 DSH_HOME、阈值用实测量说话。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_DEFAULTS,
  FACTS_REASON,
  SEGMENT_REASON,
  STATE_REASON,
  planAssistantCapture,
} from '../src/auto-capture-assistant.mjs';
import { planSegments, segmentWeight } from '../src/auto-capture-segment.mjs';
import { buildWorkState, extractActionFacts, scoreSegment } from '../src/auto-capture-facts.mjs';
import { createTurnBuffer } from '../src/auto-capture-turn.mjs';
import { createQuota, formatAssistantSource, parseSource } from '../src/auto-capture.mjs';

// ---------------------------------------------------------------- 夹具

const NO_WS = /\s+/g;
const weight = (t) => String(t).replace(NO_WS, '').length;

/**
 * 一段真实风格的长回复：四个 ## 小节，每节八到十句，句子里埋了可追溯的独有片段。
 * 用来验证「切段之后内容不丢」——每个 probe 都必须落在某段或状态摘要里。
 */
const LONG_REPLY = [
  '## 根因定位',
  '事件形状取证才是这次问题的关键，翻回 asar 里的 dsh-session 实现才看清 assistant/message 是每个 step 一条，而不是一轮一条。',
  '会话 a4396ed9 里 43 条 assistant/message 的正文加起来只有 347 字，平均 8.5 字，最短的一条正文只有一个「好」字。',
  '也就是说 200 字下限闸拦掉的不是过长的整篇，而是过短的 step 碎片，方向从一开始就搞反了，难怪重启之后库里还是空的。',
  '轮级统计把这件事钉死了，最近 25 个会话里有 24 个能拿到 turn/end，每轮累积正文的中位数是 2535 字，量级差了两个数量级。',
  '最大那一轮 7912 字，25 轮里有 23 轮累积超过 200 字，说明按轮取文本才是有内容的粒度，按 step 取只会拿到半句话。',
  '单轮内部的 step 数中位是五十到一百，把每个 step 单独判断必然全灭，这不是阈值调不调的问题，是结构性的。',
  '顺带确认了 cordis 的 context.filter 裁剪逻辑，没有 scope 标签的插件 ctx 一律返回 true，事件派发链本来就是通的。',
  '所以注入声明缺 sessions 那条猜测不成立，照着改会引入新的时序风险，先把结论记下来免得下次再走一遍。',
  '轮缓冲的软冲阈值定在两千四百字是有依据的，最近二十五轮的中位数是两千五百三十五，取八成刚好能在宿主迟迟不给 turn/end 时兜住。',
  '硬顶两万四千字对应实测最大轮七千九百一十二的三倍余量，超过这个量说明宿主把整段会话当成一轮在灌，必须切断免得一次写爆。',
  '',
  '## 改动清单',
  '新增 src/auto-capture-facts.mjs，把路径、命令结果、结论句三件事从正文里抽成结构化条目，供检索时按片段命中。',
  '新增 src/auto-capture-turn.mjs，按会话与轮次累积正文，同一步重复投递时覆盖而不是追加，这是幂等的第一道保险。',
  '重写 src/auto-capture-assistant.mjs 的入口，planAssistantCapture 先把整篇的代码围栏剥掉再交给分段器，闸门一个不少只是作用域变小。',
  '改 src/auto-capture.mjs 的 formatAssistantSource，加一个可选的段号参数，不传时输出与旧格式逐字一致，保证老数据还能解析。',
  '改 src/index.mjs 的 assistant 接线，assistant/message 只往缓冲里累积，真正的落库动作挪到 turn/end。',
  '同步 C:/Users/23101/.dsh/plugins/dsh-memjudge 这一份运行时副本，只叠等价改动不整文件覆盖，两份的历史分叉要留住。',
  '测试目录新增 test/auto-capture-t90.test.mjs，专门覆盖长回复切段与动作事实这两件事，用例数量按闸门逐条对齐。',
  '旧的 test/auto-capture-assistant.test.mjs 里两条默认值断言同步到五条与六十条，并把上限语义用显式配额单独钉住。',
  '两个新模块都只导出纯函数，不碰文件句柄也不读环境变量，这样单元测试可以把它们当普通函数调用，不需要搭一整套宿主。',
  '段号后缀选的是点分隔的 p 加序号，而不是冒号，因为冒号已经被 turn 与 step 占了两层，再加定界符会让正则难以回溯。',
  '',
  '## 验证结果',
  '四文件回归跑完是 51 项全过，改动前是 49 过 2 败，那两败本来就是默认值漂移，不是真实缺陷。',
  '`node --test --test-concurrency=1 test/auto-capture-assistant-wiring.test.mjs` 单跑 9 项全过，接线路径是通的。',
  '冒烟脚本拿 1027 字四小节文本实测切成 3 段，评分分别是 1.193、0.972、1.328，排名与直觉一致。',
  '全量套件在改动前的基线是 750 过 381 败，失败多来自 Windows 临时目录权限，不是本次改动引入。',
  '真库 132 条前后抽样比对，id 与正文一字未动，只做了只读统计，没有出现任何写入副作用。',
  '端到端那条链路还没跑，需要宿主重启之后才能验证，先记成待办而不是当成已完成。',
  '库增长按一天五十轮、每轮六条估算是一天 300 条，按 800 字节一条约 200KB 一天，一年就是七十兆。',
  '所以配额最后落在六条一轮、一百二十条一会话，再往上就会把注入面的预算挤爆，检索收益也追不上体积增长。',
  '那两条默认值断言已经修好了，改成默认六条一轮一百二十条一会话，并且用显式配额单独验证截断语义，避免下次改默认值又漂移。',
  '抽样比对用的是 select count 加十个固定 id 的正文哈希，前后两次运行结果完全一致，可以认为只读核对这件事本身是安全的。',
  '',
  '## 还差什么',
  '端到端验证要等重启，这段只能先靠假 ctx 的接线测试顶住，说服力差一截，必须补上真实链路。',
  '动作事实里的命令识别只认白名单前缀，node 之外的构建工具会漏，需要按真实用法再扩一轮。',
  '工作状态摘要靠词表触发，如果一轮里没有明确的结论段落就不产条目，覆盖率还没测过。',
  '注入面的 2000 字符硬顶下，新增条目会和老条目抢位置，需要看排序权重是否还合理。',
  '下一步先把端到端跑通，再拿一周的真实数据看命中率，最后才动配额，顺序不能反。',
  '命令识别目前只覆盖 node、python、git、pnpm、npm 五种前缀，真实工作里还有 pwsh 与 cargo，漏掉的那部分要按日志再补一轮。',
  '注入面预算的排序权重还没跟着新条目调过，等端到端数据出来要重新算一遍，权重差不多的条目应该让位给结论段。',
  '数据库那边只做只读统计不做迁移，因为这个副本还挂着正在运行的宿主进程，动表结构等于在飞行中换引擎。',
  '两棵树的分叉历史保留了，安装副本的 index.mjs 比源码仓小两万字节，差异集中在 wiki 与 healthy 相关的段落上。',
  '所以同步的时候只按行叠加等价改动，不做整文件覆盖，覆盖会把这些差异全抹平，等于把别人的活白干一遍。',
  '这件事的教训是取证优先于猜测，凭直觉改注入声明只会浪费一轮验证时间，还可能顺带引入新问题。',
  '下一次开工的第一件事应该是把这一份交接条读一遍，而不是重新翻一遍 asar，省下来的时间够多跑两轮回归了。',
].join('\n');

test('夹具自身达标：四小节、有效字数过两千四', () => {
  assert.equal((LONG_REPLY.match(/^## /gm) || []).length, 4);
  const w = weight(LONG_REPLY);
  assert.ok(w >= 2400, `夹具必须够长，实测 ${w}`);
});

// ---------------------------------------------------------------- 1. 切段

test('长回复：按小节切段，每段 200–1200，段号唯一且可解析回原文位置', () => {
  const plan = planSegments(LONG_REPLY, { minChars: 200, maxChars: 1200 });

  assert.ok(plan.segments.length >= 3, `四个小节至少切出 3 段，实测 ${plan.segments.length}`);
  for (const seg of plan.segments) {
    const w = segmentWeight(seg.text);
    assert.ok(w >= 200 && w <= 1200, `第 ${seg.index} 段 ${w} 字，越界`);
  }

  // 段号连续从 1 开始，且每条都能生成互不相同的 source
  const sessionId = '62856429-ec40-46bd-9cdd-3440650bb343';
  const sources = plan.segments.map((seg) => formatAssistantSource(sessionId, 7, 1, `p${seg.index}`));
  assert.equal(new Set(sources).size, plan.segments.length, 'source 必须两两不同');

  const parsed = sources.map((s) => parseSource(s));
  parsed.forEach((p, i) => {
    assert.ok(p, `${sources[i]} 必须可解析`);
    assert.equal(p.role, 'assistant');
    assert.equal(p.turn, 7);
    assert.equal(p.step, 1);
    assert.equal(p.part, `p${plan.segments[i].index}`);
    assert.equal(p.segment, plan.segments[i].index, 'p 后缀必须还原成数字段号');
  });
});

test('长回复：除围栏与表格外无内容丢失，每个 probe 都落在段或状态摘要里', () => {
  const plan = planSegments(LONG_REPLY, { minChars: 200, maxChars: 1200 });
  const keptText = plan.segments.map((s) => s.text).join('\n');
  const state = buildWorkState(LONG_REPLY, extractActionFacts(LONG_REPLY), { minChars: 300, maxChars: 800 });
  const pool = `${keptText}\n${state ?? ''}`;

  const probes = ['a4396ed9', 'src/auto-capture-facts.mjs', 'src/auto-capture-turn.mjs',
    'C:/Users/23101/.dsh/plugins/dsh-memjudge', '51 项全过', '750 过 381 败', '2000 字符硬顶'];
  for (const probe of probes) {
    assert.ok(pool.includes(probe), `probe 丢失：${probe}`);
  }

  // 标题必须完整地落在某一段的首部（planSegments 会把它前置到段首）
  for (const title of ['## 根因定位', '## 改动清单', '## 验证结果']) {
    assert.ok(plan.segments.some((s) => s.text.startsWith(title)), `${title} 没被前置到任何段首`);
  }
});

test('短段合并：五个连续 80 字段落合成 1–2 条，不是 5 条', () => {
  const para = (n) => `第${n}段讲的是同一件小事，说了半天也没说完，补一句凑够长度的收尾，免得被当成碎片丢掉，毕竟单段不到两百字的话，判闸第一道就会把它扔进 dropped 里。`;
  const text = [1, 2, 3, 4, 5].map(para).join('\n\n');
  assert.ok(weight(text) >= 350, `夹具本身要够长，实测 ${weight(text)}`);
  // 每段都在 60–120 之间：单段过不了闸，合起来才够
  assert.ok(weight(para(1)) >= 60 && weight(para(1)) < 200, `单段长度 ${weight(para(1))}`);

  const plan = planSegments(text, { minChars: 200, maxChars: 1200 });
  assert.ok(plan.segments.length >= 1 && plan.segments.length <= 2,
    `五个 80 字段落应合并成 1–2 段，实测 ${plan.segments.length}`);
  const joined = plan.segments.map((s) => s.text).join('\n');
  for (const n of [1, 2, 3, 4, 5]) assert.ok(joined.includes(`第${n}段`), `第${n}段丢了`);
});

test('代码围栏：整块丢弃，不切碎成伪结论', () => {
  const body = '这一段的正文足够长，说的是验证结论，前面跑过回归全部通过，没有任何一项因为改动而退化成失败状态，可以继续往下走，'
    + '顺便把围栏里的东西排除掉，因为那些代码片段既没有语义也不是结论，留在库里只会污染检索结果，还白占注入面的预算额度。';
  const fence = '```js\n// 这里的 return 是伪结论\nif (len > 1200) return "too-long";\n```';
  const tail = '围栏之后的收尾段落也要留下来，它说明这条链路在真实宿主上还需要重启才能生效，暂时只能靠单元测试顶着，'
    + '而重启这件事本轮不能做，会杀掉正在跑的会话，所以只能记成待办等下一次开工再验，不能当成已完成来汇报。';
  const text = `${body}\n\n${fence}\n\n${tail}`;

  const plan = planSegments(text, { minChars: 200, maxChars: 1200 });
  const kept = plan.segments.map((s) => s.text).join('\n');
  assert.ok(!kept.includes('too-long'), '围栏内的代码不得进段');
  assert.ok(!kept.includes('```'), '不得留下残破的围栏标记');
  assert.ok(kept.includes('这一段的正文'), '围栏前的正文要留');
  assert.ok(kept.includes('围栏之后的收尾'), '围栏后的正文要留');
  assert.ok(plan.dropped.some((d) => d.reason === 'code-fence'), '围栏要出现在 dropped 里，可审计');
});

// ---------------------------------------------------------------- 2. 幂等

test('同一回复投两次：段号与文本都不变，不产生新条目', () => {
  const sessionId = 'sess-dup';
  const plan = planAssistantCapture(LONG_REPLY, { ...ASSISTANT_DEFAULTS, sessionId, turn: 3 });
  assert.ok(plan.candidates.length >= 2, `长回复必须出多条候选，实测 ${plan.candidates.length}`);

  const asRows = (p) => p.candidates.map((c) => ({
    source: formatAssistantSource(sessionId, 3, 1, c.part),
    text: c.text,
  }));
  const first = asRows(plan);
  assert.equal(new Set(first.map((r) => r.source)).size, first.length, '同一轮内 source 不得重复');

  // 第二次投递时，已落库的正文作为 existing 传进去：应全部被 nearDup 挡下。
  const again = planAssistantCapture(LONG_REPLY, {
    ...ASSISTANT_DEFAULTS, sessionId, turn: 3, existing: first.map((r) => r.text),
  });
  assert.equal(again.candidates.length, 0,
    `重复投递不得再出候选，实测多出：${again.candidates.map((c) => c.part).join(',')}`);
  assert.equal(again.reasons['near-dup'], first.length, '每条都该记一次 near-dup');

  // 同一轮缓冲里同一步重复投递：覆盖而非追加（幂等的第二道保险）
  const buf = createTurnBuffer({ flushAtChars: 99999 });
  buf.push(sessionId, 4, 1, '第一次正文');
  buf.push(sessionId, 4, 1, '第二次正文');
  const batch = buf.drain(sessionId, 4);
  assert.equal(batch.text, '第二次正文', '同一步只能保留最后一次');
});

// ---------------------------------------------------------------- 3. 动作型事实

test('动作型事实：3 个路径 + 2 条命令结果逐项一致', () => {
  const text = [
    '重写 src/auto-capture-assistant.mjs 的入口，把整篇先剥围栏再交给分段器。',
    '新增 test/auto-capture-t90.test.mjs，覆盖长回复切段与动作事实两条线。',
    '同步 C:/Users/23101/.dsh/plugins/dsh-memjudge 这份运行时副本，只叠等价改动。',
    '跑 `node --test --test-concurrency=1 test/auto-capture.test.mjs` 结果是 51 项全过。',
    '再跑 `node --test --test-concurrency=1` 全量，得到 750 过 381 败，失败都是临时目录权限。',
  ].join('\n');

  const facts = extractActionFacts(text);
  const paths = facts.paths.map((p) => p.path);
  assert.deepEqual(paths.sort(), [
    'C:/Users/23101/.dsh/plugins/dsh-memjudge',
    'src/auto-capture-assistant.mjs',
    'test/auto-capture-t90.test.mjs',
  ].sort(), '三个路径要逐字一致');

  const byPath = Object.fromEntries(facts.paths.map((p) => [p.path, p.action]));
  assert.equal(byPath['src/auto-capture-assistant.mjs'], '重写');
  assert.equal(byPath['test/auto-capture-t90.test.mjs'], '新增');
  assert.equal(byPath['C:/Users/23101/.dsh/plugins/dsh-memjudge'], '同步');

  const commands = facts.commands.map((c) => c.command);
  assert.equal(commands.length, 2, `两条命令都要抽到，实测 ${commands.length}`);
  assert.ok(commands[0].includes('node --test --test-concurrency=1'), commands[0]);
  assert.equal(facts.commands[0].result, '51 项全过');
  // 「750 过 381 败」被归一化成 750/381：归一化后更好按片段检索
  assert.equal(facts.commands[1].result, '750/381');

  // 落库的那条清单必须可读、可检索。两条合法结局：单独出一条 f 候选，
  // 或者工作状态摘要已把清单整段吸收（避免同一份清单占两个席位）。
  const plan = planAssistantCapture(text, { ...ASSISTANT_DEFAULTS, sessionId: 's-act', turn: 1 });
  const factsCand = plan.candidates.find((c) => c.reason === FACTS_REASON);
  const carrier = factsCand ?? plan.candidates.find((c) => c.reason === STATE_REASON);
  assert.ok(carrier, '路径与命令要么进 f 候选，要么进状态摘要，不能双双丢失');
  assert.ok(carrier.text.includes(paths[0]), `载体里要能看到 ${paths[0]}`);
  assert.ok(carrier.text.includes(paths[1]) && carrier.text.includes(paths[2]));
  assert.ok(carrier.text.includes('51 项全过'), '命令结果也要能看到');
  if (factsCand) assert.equal(factsCand.part, 'f');
  else assert.ok(plan.reasons['facts-covered-by-state'] >= 1, '没出 f 候选时必须记明原因是状态摘要已覆盖');
});

test('结论句与工作状态：明确写着完成/剩下/下一步的一轮才产摘要', () => {
  const facts = extractActionFacts(LONG_REPLY);
  assert.ok(facts.conclusions.length >= 4, `长回复里结论句不止一条，实测 ${facts.conclusions.length}`);
  const kinds = new Set(facts.conclusions.map((c) => c.kind));
  for (const k of ['fixed', 'verified', 'remaining', 'next']) {
    assert.ok(kinds.has(k), `缺少 ${k} 类结论句`);
  }

  const state = buildWorkState(LONG_REPLY, facts, { minChars: 300, maxChars: 800 });
  assert.ok(state, '长回复必须产出工作状态摘要');
  const w = weight(state);
  assert.ok(w >= 300 && w <= 900, `摘要 ${w} 字，越界`);
  // 摘要构型是「结论句若干 + 动作清单」，每行一条 '- ' 条目
  assert.ok(state.includes('- '), '摘要要按条目分行，不能糊成一坨');
  assert.ok(state.split('\n').length >= 3, '至少三条：结论 + 动作');
  assert.ok(!state.includes('```'), '摘要里不得夹代码');
  // 条目之间必须有换行：粘连会让「750/381」和下一句读成同一个命令的结果
  assert.ok(!/\/381跑/.test(state), `不得出现粘连：${state.slice(0, 120)}`);

  // 只有一句闲聊的输入不产摘要——避免把 noise 当状态
  assert.equal(buildWorkState('好的，我看一下。', extractActionFacts('好的，我看一下。')), null);
});

// ---------------------------------------------------------------- 4. 轮缓冲

test('轮缓冲：按 step 升序拼接，软冲清空，硬冲删轮', () => {
  const buf = createTurnBuffer({ flushAtChars: 40, maxCharsPerTurn: 200 });
  assert.deepEqual(buf.push('s', 1, 2, '第二步的正文，长度够触发软冲了吧，再补一点凑数。').flush, null);
  const flushed = buf.push('s', 1, 1, '第一步的正文，也要够长，不然软冲阈值到不了，就这样补一句。');
  assert.ok(flushed.flush, '累积到软冲阈值必须返回 flush');
  assert.equal(flushed.reason, 'threshold');
  assert.ok(flushed.flush.text.startsWith('第一步'), '拼接必须按 step 数值升序，不是按投递顺序');
  assert.equal(buf.drain('s', 1), null, '冲过之后这一轮应已清空');

  // 硬冲：一轮里逐步投喂到超过 maxCharsPerTurn
  const big = createTurnBuffer({ flushAtChars: 99999, maxCharsPerTurn: 80 });
  big.push('s', 2, 1, 'x'.repeat(50));
  const hard = big.push('s', 2, 2, 'y'.repeat(50));
  assert.ok(hard.flush, '超过单轮硬顶必须强制冲');
  assert.equal(hard.reason, 'turn-cap');
  assert.equal(big.peek('s', 2), null, '硬冲之后这一轮必须被删掉，不留残渣');
});

// ---------------------------------------------------------------- 5. 配额

test('配额：单轮超限后停，下一轮恢复', () => {
  const quota = createQuota({ ...ASSISTANT_DEFAULTS, perTurnLimit: 3, sessionLimit: 60, cooldownMs: 0 });
  const admit = (turn, n = 1) => {
    let ok = 0;
    for (let i = 0; i < n; i += 1) if (quota.admit('s-quota', turn, 1_000_000 * (turn + 1)).ok) ok += 1;
    return ok;
  };
  assert.equal(admit(1, 3), 3, '前三条要放进来');
  assert.equal(admit(1, 2), 0, '同一轮第 4、5 条必须被挡下');
  assert.deepEqual(quota.admit('s-quota', 1, 9_000_000), { ok: false, reason: 'turn-limit' });
  assert.equal(admit(2, 3), 3, '换轮之后计数重置，必须恢复');
});

// ---------------------------------------------------------------- 6. 向后兼容

test('三种旧 source 格式解析结果一字不变', () => {
  const sessionId = '62856429-ec40-46bd-9cdd-3440650bb343';
  const b64 = Buffer.from(sessionId, 'utf8').toString('base64url');

  // v1 legacy：只带 8 位会话令牌与轮次，解析器按设计给 legacy/ambiguous 标记，且**不**伪造 sessionId
  const v1 = 'auto:chat#62856429-t1';
  assert.deepEqual(parseSource(v1), {
    auto: true, version: 1, legacy: true, ambiguous: true, sessTok: '62856429', turn: 1, source: v1,
  });

  // v2 user
  const v2 = `auto:chat:v2#${b64}:t5`;
  assert.deepEqual(parseSource(v2), { auto: true, version: 2, sessionId, turn: 5, source: v2 });

  // v3 assistant 不带段号：对象里不得多出任何字段
  const v3 = `auto:chat:asst#${b64}:t7:s3`;
  assert.deepEqual(parseSource(v3), { auto: true, version: 3, role: 'assistant', sessionId, turn: 7, step: 3, source: v3 });

  // 段号只在显式传入时出现
  const v3r = formatAssistantSource(sessionId, 7, 3, 'r');
  assert.equal(v3r, `${v3}.r`);
  assert.deepEqual(parseSource(v3r), {
    auto: true, version: 3, role: 'assistant', sessionId, turn: 7, step: 3, source: v3r, part: 'r', segment: null,
  });
  const v3f = formatAssistantSource(sessionId, 7, 3, 'f');
  assert.equal(v3f, `${v3}.f`);

  // 空串等价于「不传段号」（调用方常常拿到 undefined/''，不该为此抛错）
  assert.equal(formatAssistantSource(sessionId, 7, 3, ''), v3);
  for (const bad of ['p', 'p0', 'p01', 'x', 'r1', 'p1.r']) {
    assert.throws(() => formatAssistantSource(sessionId, 7, 3, bad), /invalid-part/, `part=${bad} 必须抛`);
  }
  assert.equal(parseSource(`${v3}.p0`), null, 'p0 不是合法段号');
  assert.equal(parseSource(`${v3}.p1.2`), null, '不得接受两段后缀');
});

// ---------------------------------------------------------------- 7. 打分与排序

test('打分：结论段压过路径堆砌段，排序回到原文顺序输出', () => {
  const rootCause = '## 根因定位\n这段讲的是根因是每个 step 一条消息，正文太短，所以闸门全灭。';
  const fileList = '## 改动清单\n改了 src/a.mjs、src/b.mjs、src/c.mjs、test/d.test.mjs、src/e.mjs 五个文件。';
  const sr1 = scoreSegment(rootCause, extractActionFacts(rootCause));
  const sr2 = scoreSegment(fileList, extractActionFacts(fileList));
  assert.ok(sr1 > sr2, `含「根因」的标题必须加分更多：${sr1} vs ${sr2}`);

  const plan = planAssistantCapture(LONG_REPLY, { ...ASSISTANT_DEFAULTS, perTurnLimit: 6, sessionId: 's', turn: 1 });
  const parts = plan.candidates.map((c) => c.part);
  const segParts = parts.filter((p) => p.startsWith('p')).map((p) => Number(p.slice(1)));
  assert.deepEqual(segParts, [...segParts].sort((a, b) => a - b), '段必须按原文顺序输出');
  assert.equal(parts[0], 'r', '工作状态永远排第一');
  assert.ok(plan.candidates.length <= 5, `单轮不得超过 6 条，实测 ${plan.candidates.length}`);
  assert.equal(plan.candidates[0].reason, STATE_REASON);
  assert.ok(plan.candidates.some((c) => c.reason === SEGMENT_REASON));
});
