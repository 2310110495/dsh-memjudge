// LLM 提取层报告：规则 vs LLM 三元组数、grounding 通过率、质量抽查、调用与耗时。
// 无 key 时如实打印降级结果，不伪造数字。
import { chapters } from '../../mem-eval/corpus/quiz.mjs';
import { extractL1, extractL1Hybrid } from '../src/extract.mjs';
import { llmEnabled, llmStats, createCache } from '../src/llm-extract.mjs';

const entries = chapters.map((c) => ({ text: c.text, chapter: c.n }));
const ruleFacts = entries.flatMap((e) => extractL1(e.text, { ch: e.chapter }));
console.log(`语料：${entries.length} 条 memory / ${chapters.reduce((s, c) => s + c.text.length, 0)} 字`);
console.log(`规则层三元组：${ruleFacts.length}`);
console.log(`LLM：${llmEnabled() ? '启用' : '未启用（MEMJUDGE_LLM_KEY 未设置）→ 静默降级'}`);

const t0 = Date.now();
const r = await extractL1Hybrid(entries, { cache: createCache('.llm-cache.json') });
const ms = Date.now() - t0;

console.log(`抽取来源：${r.source}；三元组：${r.facts.length}；耗时：${ms}ms`);
console.log(`API 调用：${llmStats.calls} 次（重试 ${llmStats.retries}）；缓存命中 ${llmStats.cacheHits} 条；LLM 三元组 ${llmStats.triples}；grounding 丢弃 ${llmStats.dropped}`);
if (llmStats.lastError) console.log(`最后一次错误：${llmStats.lastError}`);

// 分层统计：LLM 实际覆盖了几条 memory，这些条目 LLM 抽多少、同批规则抽多少
const src = r.sources || [];
const llmIdx = src.map((s, i) => (s === 'llm' ? i : -1)).filter((i) => i >= 0);
const llmFacts = llmIdx.reduce((s, i) => s + r.perEntry[i].length, 0);
const ruleSame = llmIdx.reduce((s, i) => s + extractL1(entries[i].text, { ch: entries[i].chapter }).length, 0);
console.log(`LLM 覆盖 ${llmIdx.length}/${entries.length} 条 memory：这些条目 LLM 抽 ${llmFacts} 条，同批规则抽 ${ruleSame} 条（差 ${llmFacts - ruleSame}）`);
if (llmIdx.length && llmIdx.length < entries.length) {
  const rest = entries.length - llmIdx.length;
  console.log(`其余 ${rest} 条回退规则抽取（LLM 超时/失败，静默降级）`);
}

// grounding 复核：每条 sent 必须能在对应原文里逐字找到
let sentOk = 0;
let sentBad = 0;
r.perEntry.forEach((facts, i) => {
  const text = entries[i].text;
  for (const f of facts) {
    if (text.includes(f.sent)) sentOk += 1;
    else sentBad += 1;
  }
});
console.log(`grounding：${sentOk}/${sentOk + sentBad} 条 sent 可在原文逐字找到（丢弃 ${sentBad}）`);

// 质量抽查：前 30 条
console.log('\n前 30 条三元组：');
for (const f of r.facts.slice(0, 30)) {
  console.log(` ${f.entity ?? '-'} | ${f.attr} | ${f.value} | ${f.valueType} | ${String(f.sent).slice(0, 40)}`);
}

const batches = Math.ceil(entries.length / 4);
console.log(`\n全量重建成本估算：${entries.length} 条 memory，批量 4 条/次 → 无缓存时 ${batches} 次 API 调用；段级 294 条 → ${Math.ceil(294 / 4)} 次。`);
