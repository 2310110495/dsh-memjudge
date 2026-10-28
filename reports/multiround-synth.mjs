// 多轮召回验证（t28）——只读验证，不改 src/，不改 mem-eval/
//
// 要回答的问题：SPEC §2.4 没限制「每题调几次 recall」，而 harness 的 run-one.mjs 每题只调一次。
// 真实 agent 可以追问。那么允许 3 轮、每轮 ≤2000 字符时，12 道综合题能到多少分？
//
// 硬约束（防作弊）：判「够不够」只看本轮材料 + 原问题，**不读 item.kw**。
// kw 只在最后评分时用（与 scoreRecall 同口径：全中 1 / 部分 0.5 / 全不中 0）。
//
// 用法：
//   set -a && . ./.env.local && set +a
//   node reports/multiround-synth.mjs --rounds 3     # 多轮
//   node reports/multiround-synth.mjs --rounds 1     # 单轮基线（复现 0.583）

import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { apply } from '../src/index.mjs';
import { chapters } from '../../mem-eval/corpus/novel.mjs';
import { synthesis } from '../../mem-eval/corpus/quiz.mjs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const MAX_ROUNDS = Math.max(1, Number(argOf('rounds', '3')));
// --force：忽略 LLM 的「够了」，把上限跑满（用来区分「LLM 早停」与「真的检索不到」）
const FORCE = argv.includes('--force');
const KEY = process.env.MEMJUDGE_LLM_KEY;
const MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const CHAT_TIMEOUT_MS = 150_000; // chat 带 reasoning，45s 会频繁 abort（t20 实测）
const T0 = Date.UTC(2026, 9, 27);

// ── 宿主桩：只复刻 apply 需要的 tools / systemPrompt / effect 三个面 ──────────
class Named {
  constructor() { this.map = new Map(); }
  insert(k, v) { this.map.set(k, v); return () => this.map.delete(k); }
}
const ctx = {
  tools: new Named(),
  systemPrompt: new Named(),
  _effects: [],
  effect(fn) { const c = fn(); const e = { c, active: true }; this._effects.push(e); return () => { if (!e.active) return; e.active = false; if (typeof e.c === 'function') e.c(); }; },
  dispose() { for (const e of this._effects.splice(0).reverse()) { if (!e.active) continue; e.active = false; if (typeof e.c === 'function') e.c(); } },
};
ctx.tools.register = (d) => ctx.tools.insert(d.name, d);
ctx.systemPrompt.section = (s) => ctx.systemPrompt.insert(s.name, s);

// ── LLM 判断：只吃「问题 + 材料」，不给题库 ─────────────────────────────────
const cost = { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, failures: 0 };

async function judge(question, materials) {
  if (!KEY) return { degraded: 'no-key', enough: false, nextQuery: null };
  const prompt = [
    '你是检索助手。下面是用户的问题，以及已经检索到的材料。',
    `问题：${question}`,
    '材料：',
    materials.slice(0, 6000),
    '',
    '判断这些材料是否足以回答问题。',
    '若能回答，输出 {"enough":true,"missing":"","nextQuery":null}',
    '若不能，输出 {"enough":false,"missing":"还缺什么（一句话）","nextQuery":"一条更可能检索到缺失信息的检索式，不超过 20 字，保留原问题里的专名与数值"}',
    '只输出 JSON，不要任何解释、不要 markdown 代码块。',
  ].join('\n');
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 400,
      }),
      signal: ac.signal,
    });
    cost.calls += 1;
    cost.ms += Date.now() - t0;
    if (!res.ok) { cost.failures += 1; return { degraded: 'http', enough: false, nextQuery: null }; }
    const j = await res.json();
    cost.promptTokens += Number(j?.usage?.prompt_tokens) || 0;
    cost.completionTokens += Number(j?.usage?.completion_tokens) || 0;
    const text = String(j?.choices?.[0]?.message?.content ?? '');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { cost.failures += 1; return { degraded: 'parse', enough: false, nextQuery: null }; }
    const obj = JSON.parse(m[0]);
    return { degraded: 'none', enough: obj.enough === true, missing: String(obj.missing ?? ''), nextQuery: obj.nextQuery ? String(obj.nextQuery).slice(0, 40) : null };
  } catch {
    cost.failures += 1;
    return { degraded: 'timeout', enough: false, nextQuery: null };
  } finally {
    clearTimeout(timer);
  }
}

// ── 建库 ────────────────────────────────────────────────────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'mj-multiround-'));
apply(ctx, { dbPath: path.join(TMP, 'f.db'), now: () => T0 });
const remember = ctx.tools.map.get('memjudge_remember');
const recallTool = ctx.tools.map.get('memjudge_recall');

console.log(`多轮召回验证 · 轮数上限 ${MAX_ROUNDS} · key ${KEY ? 'yes' : 'NO（会走 no-key 降级）'}`);
const tWrite = Date.now();
const SEG = /\n\s*\n/;
let nSeg = 0;
for (const c of chapters) {
  for (const [i, text] of c.text.split(SEG).map((s) => s.trim()).filter(Boolean).entries()) {
    await remember.execute({ text, chapter: c.n, para: i + 1 });
    nSeg += 1;
  }
}
console.log(`写入 ${nSeg} 段 / ${Date.now() - tWrite}ms\n`);

// ── 逐题多轮 ────────────────────────────────────────────────────────────────
const rows = [];
const tAll = Date.now();
for (const item of synthesis) {
  const t0 = Date.now();
  const seen = new Set();
  const parts = [];
  let q = item.q;
  let rounds = 0;
  let stop = 'max-rounds';
  const queries = [];
  for (let r = 1; r <= MAX_ROUNDS; r += 1) {
    if (!q) { stop = 'no-next-query'; break; }
    queries.push(q);
    const res = await recallTool.execute({ query: q, budget: 2000 });
    rounds += 1;
    for (const h of res.hits ?? []) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      parts.push(h.text);
    }
    if (r === MAX_ROUNDS) break;
    const v = await judge(item.q, parts.join('\n\n'));
    if (v.degraded !== 'none') { stop = `degraded:${v.degraded}`; break; }
    if (v.enough && !FORCE) { stop = 'enough'; break; }
    q = v.nextQuery;
    if (!q) { stop = 'no-next-query'; break; }
  }
  const text = parts.join('\n\n');
  const hit = item.kw.filter((k) => text.includes(k)).length;
  const score = hit === item.kw.length ? 1 : hit > 0 ? 0.5 : 0;
  rows.push({ id: item.id, score, hit, total: item.kw.length, rounds, stop, chars: text.length, ms: Date.now() - t0, queries });
  const mark = score === 1 ? 'OK ' : score === 0.5 ? '半 ' : '缺 ';
  console.log(`${mark}${item.id} score=${score} kw=${hit}/${item.kw.length} 轮=${rounds}(${stop}) ${text.length}字 ${Date.now() - t0}ms`);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const sum = rows.reduce((a, r) => a + r.score, 0);
const full = rows.filter((r) => r.score === 1).length;
const half = rows.filter((r) => r.score === 0.5).length;
const avgRounds = rows.reduce((a, r) => a + r.rounds, 0) / rows.length;
const dist = rows.reduce((m, r) => { m[r.rounds] = (m[r.rounds] ?? 0) + 1; return m; }, {});
console.log('\n=== 汇总 ===');
console.log(`synthScore = ${(sum / rows.length).toFixed(3)}  （${full} 满分 / ${half} 半分 / ${rows.length - full - half} 零分）`);
console.log(`目标 0.917（11/12）：${sum / rows.length >= 0.917 ? '达成' : `未达，差 ${(0.917 - sum / rows.length).toFixed(3)}`}`);
console.log(`轮数分布 ${JSON.stringify(dist)} · 平均 ${avgRounds.toFixed(2)} 轮/题`);
console.log(`LLM 成本：${cost.calls} 次调用 · prompt ${cost.promptTokens} tok · completion ${cost.completionTokens} tok · ${cost.ms}ms · 失败 ${cost.failures}`);
console.log(`总耗时 ${Date.now() - tAll}ms`);
console.log('\n逐题（对比单轮基线）：');
for (const r of rows) console.log(`  ${r.id} ${r.score}  轮=${r.rounds} ${r.stop}  queries=${JSON.stringify(r.queries)}`);
ctx.dispose();
