// 多轮召回 harness（t31）——SPEC spec-1.2 §2.4 的 4b 并列口径
//
// 与 run-one.mjs 的关系：
//   - **不改它**。本文件是新增脚本，走 SPEC §0.3.1「新增 ≠ 修改」例外。
//   - `--turns 1` 时行为等价于 run-one.mjs 的 synthesis 段（同一 adapter、同一写入顺序、
//     同一 scoreRecall），用来证明新脚本没引入偏差：实测 0.583，与历史基线一致。
//   - 结果写成 results/turns-<name>.json，**不覆盖** results/<name>.json。
//
// 多轮流程（每轮 ≤2000 字符，轮间可见上一轮材料）：
//   1. recall/query(q1) → R1
//   2. 把「原问题 + 已得材料」交给 LLM 判 enough；不够则要一条 nextQuery
//   3. enough 为真就停（不追加空查询）；否则 recall(q2) → R2，再判一次
//   4. 合并 R1..Rn 去重后按 scoreRecall 评分
//
// 防作弊硬约束：判「够不够」只看**本轮材料 + 原问题**，绝不读 item.kw。
// kw 只在最后评分时用。
//
// 用法：
//   set -a && . ../../memjudge-plugin/.env.local && set +a
//   node harness/run-turns.mjs ../memjudge-plugin/adapters/memjudge.mjs --turns 3
//   node harness/run-turns.mjs <adapter> --turns 1            # 回归基准（应 0.583）
//   node harness/run-turns.mjs <adapter> --turns 3 --dry-run   # 不调 LLM，等价单轮

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chapters, recall, synthesis } from '../corpus/quiz.mjs';
import { scoreRecall, estTokens } from './score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HR = () => Number(process.hrtime.bigint() / 1000n) / 1000;

const MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const CHAT_TIMEOUT_MS = 150_000; // chat 带 reasoning，45s 会频繁 abort
const TURN_BUDGET = 2000; // 每轮字符预算；SPEC §2.8 澄清：对每一轮都成立，不是总量

function parseArgs(argv) {
  const out = { turns: 1, dryRun: false, mode: 'query', out: null, adapter: null, withRecall: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--turns') { out.turns = Math.max(1, Number(argv[++i]) || 1); continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--mode') { out.mode = String(argv[++i] ?? 'query'); continue; }
    if (a === '--out') { out.out = String(argv[++i] ?? ''); continue; }
    if (a === '--recall') { out.withRecall = true; continue; }
    if (!a.startsWith('--') && !out.adapter) { out.adapter = a; continue; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.adapter) {
  console.error('用法: node harness/run-turns.mjs <adapter.mjs> [--turns N] [--dry-run] [--mode query|outline] [--out path]');
  process.exit(2);
}
if (args.mode === 'outline') {
  // t29 的 outline 模式尚未落地时，明确报错而不是静默退回 query——t25 的教训：
  // 静默降级会让「测了 B 方案」变成「其实一直在测 A 方案」。
  console.error('--mode outline 依赖 memjudge_recall 的 outline 模式（t29），当前适配器未提供，拒绝静默降级。');
  process.exit(2);
}

const KEY = process.env.MEMJUDGE_LLM_KEY;
const cost = { llmCalls: 0, promptTokens: 0, completionTokens: 0, ms: 0, failures: 0, degraded: 0 };

/** 判「够不够」——只吃问题与材料，不碰题库答案。 */
async function judgeEnough(question, materials) {
  if (args.dryRun) return { enough: true, nextQuery: null, missing: '', degraded: 'dry-run' };
  if (!KEY) { cost.degraded += 1; return { enough: true, nextQuery: null, missing: '', degraded: 'no-key' }; }
  const prompt = [
    '你是检索助手。下面是用户的问题，以及已经检索到的材料。',
    `问题：${question}`,
    '材料：',
    materials.slice(0, 6000),
    '',
    '判断这些材料是否足以回答问题。',
    '若能回答，输出 {"enough":true,"missing":"","nextQuery":null}',
    '若不能，输出 {"enough":false,"missing":"还缺什么（一句话）","nextQuery":"一条更可能检索到缺失信息的检索式，不超过 20 字，保留原问题里的专名与数值"}',
    '只输出 JSON，不要解释、不要 markdown 代码块。',
  ].join('\n');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CHAT_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 400 }),
      signal: ac.signal,
    });
    cost.llmCalls += 1;
    cost.ms += Date.now() - t0;
    if (!res.ok) { cost.failures += 1; return { enough: true, nextQuery: null, missing: '', degraded: 'http' }; }
    const j = await res.json();
    cost.promptTokens += Number(j?.usage?.prompt_tokens) || 0;
    cost.completionTokens += Number(j?.usage?.completion_tokens) || 0;
    const text = String(j?.choices?.[0]?.message?.content ?? '');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { cost.failures += 1; return { enough: true, nextQuery: null, missing: '', degraded: 'parse' }; }
    const obj = JSON.parse(m[0]);
    return {
      enough: obj.enough === true,
      missing: String(obj.missing ?? ''),
      nextQuery: obj.nextQuery ? String(obj.nextQuery).slice(0, 40) : null,
      degraded: 'none',
    };
  } catch {
    cost.failures += 1;
    return { enough: true, nextQuery: null, missing: '', degraded: 'timeout' };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const adapterPath = path.resolve(args.adapter);
  const mod = await import(pathToFileURL(adapterPath).href);
  const adapter = mod.default;
  const safeName = String(adapter.meta?.name ?? 'adapter').replace(/[^\w.-]/g, '_');
  const workdir = path.join(ROOT, 'runs', `${safeName}-turns${args.turns}`);
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.mkdirSync(workdir, { recursive: true });

  console.log('=== 多轮口径（SPEC spec-1.2 §2.4 4b）===');
  console.log(`adapter ${adapterPath}`);
  console.log(`turns=${args.turns} · dryRun=${args.dryRun} · key=${KEY ? 'yes' : 'NO'} · 每轮预算 ${TURN_BUDGET} 字`);

  const t0 = HR();
  await adapter.open(workdir);
  const tWrite = HR();
  for (const ch of chapters) await adapter.write([ch]);
  const writeMs = Math.round(HR() - tWrite);
  console.log(`写入 ${chapters.length} 章 / ${writeMs}ms`);

  // --recall：附带跑 92 条级召回（单轮，与 run-one 同口径），用来证明新脚本不动召回。
  let recallScore = null;
  if (args.withRecall) {
    let full = 0;
    const miss = [];
    for (const item of recall) {
      const ans = String((await adapter.query(item.q)) ?? '');
      const sc = scoreRecall(ans, item);
      if (sc.score === 1) full += 1; else miss.push(item.id);
    }
    recallScore = Number((full / recall.length).toFixed(3));
    console.log(`recall ${full}/${recall.length} = ${recallScore}${miss.length ? ` miss=${miss.join(',')}` : ''}`);
  }

  const rows = [];
  let overBudget = 0;
  const tQ = HR();
  for (const item of synthesis) {
    const seen = new Set();
    const parts = [];
    const queries = [];
    let q = item.q;
    let turns = 0;
    let stop = 'max-turns';
    const tItem = HR();
    for (let r = 1; r <= args.turns; r += 1) {
      if (!q) { stop = 'no-next-query'; break; }
      queries.push(q);
      // 不在这里二次截断：adapter.query 已按自己的预算返回（memjudge 是 2000）。
      // 再 slice 一次会把末尾的段（常含关键词）切掉，实测让 5 满分掉成 4 满分。
      // 不裁剪：run-one 也是 ans 原样拿去评分，裁剪会让 --turns 1 与单轮基线不可比
      //（实测 S03 的返回正好 2000 字，被切掉末尾那句就丢了关键词，0.625 → 0.583）。
      // 预算由 adapter 自己守，这里只记录越界次数。
      const ans = String((await adapter.query(q)) ?? '');
      if (ans.length > TURN_BUDGET) overBudget += 1;
      turns += 1;
      // 合并：整轮返回原文直接拼，不切段、不逐段去重——run-one 就是 ans 原样；
      // 切段去重会把重复出现的段（S06 的两处金额）删掉一处，与单轮基线不可比。
      // 轮与轮之间按整串去重，避免同一串被拼两遍。
      if (!seen.has(ans)) { seen.add(ans); parts.push(ans); }
      if (r === args.turns) break;
      const v = await judgeEnough(item.q, parts.join('\n\n'));
      if (v.enough) { stop = 'enough'; break; }
      q = v.nextQuery;
      if (!q) { stop = 'no-next-query'; break; }
    }
    const ans = parts.join('\n\n');
    const sc = scoreRecall(ans, item);
    rows.push({
      id: item.id, q: item.q, turns, stop, queries,
      got: ans.slice(0, 400), gotLen: ans.length, gotTokens: estTokens(ans),
      ...sc, ms: Math.round(HR() - tItem),
    });
    const mark = sc.score === 1 ? 'OK ' : sc.score === 0.5 ? '半 ' : '缺 ';
    console.log(`${mark}${item.id} score=${sc.score} kw=${sc.hit}/${sc.total} 轮=${turns}(${stop}) ${ans.length}字`);
  }
  const queryMs = Math.round(HR() - tQ);
  await adapter.close?.();

  const synthScore = Number((rows.reduce((a, r) => a + r.score, 0) / rows.length).toFixed(3));
  const turnDist = rows.reduce((m, r) => { m[r.turns] = (m[r.turns] ?? 0) + 1; return m; }, {});
  const totalMs = Math.round(HR() - t0);
  const report = {
    meta: {
      ...adapter.meta,
      harness: 'run-turns.mjs',
      spec: 'spec-1.2',
      rubric: `synthesis·多轮口径（≤${args.turns} 轮，每轮 ≤${TURN_BUDGET} 字符，轮间可见上一轮材料）`,
      turns: args.turns,
      dryRun: args.dryRun,
      mode: args.mode,
      note: '单轮口径请用 run-one.mjs；两者并列，报告必须标注口径',
    },
    workdir: path.relative(ROOT, workdir).split(path.sep).join('/'),
    timing: { writeMs, queryMs, totalMs },
    cost: {
      ...cost,
      avgLlmCallsPerItem: Number((cost.llmCalls / rows.length).toFixed(2)),
      avgPromptTokensPerItem: Math.round(cost.promptTokens / rows.length),
    },
    turnDist,
    overBudgetRounds: overBudget,
    recallScore,
    synthesis: rows,
    summary: {
      synthScore,
      synthFull: rows.filter((r) => r.score === 1).length,
      target: 0.917,
      pass: synthScore >= 0.917,
    },
  };

  const outPath = args.out || path.join(ROOT, 'results', `turns-${safeName}-t${args.turns}${args.dryRun ? '-dry' : ''}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

  console.log('\n=== 汇总（多轮口径）===');
  console.log(`synthScoreMultiTurn = ${synthScore}  （目标 0.917，${report.summary.pass ? '达成' : `未达，差 ${(0.917 - synthScore).toFixed(3)}`}）`);
  console.log(`满分 ${report.summary.synthFull}/${rows.length} · 轮数分布 ${JSON.stringify(turnDist)}`);
  console.log(`LLM：${cost.llmCalls} 次 · prompt ${cost.promptTokens} tok · completion ${cost.completionTokens} tok · ${cost.ms}ms · 失败 ${cost.failures} · 降级 ${cost.degraded}`);
  console.log(`平均 ${report.cost.avgLlmCallsPerItem} 次/题 · ${report.cost.avgPromptTokensPerItem} tok/题 · 查询 ${queryMs}ms`);
  if (recallScore !== null) console.log(`recall（单轮）= ${recallScore}（run-one 口径 0.989）`);
  console.log(`结果写入 ${path.relative(ROOT, outPath)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
