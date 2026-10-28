// memjudge 面板：把库体、模块开关、密钥状态、记忆与冲突生成一张自包含 HTML。
//
// 为什么是静态文件而不是服务：DSH 宿主没有对外暴露「插件注册 web 页面」的稳定契约，
// 起一个常驻端口要用户自己记得开、要处理端口冲突、还要把 200KB 库暴露在 localhost。
// 生成一个文件，双击就能看，关掉就没有，风险最小。
//
// 用法：node scripts/panel.mjs [--open]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { open } from '../src/store.mjs';
import { configReport, STATE_DIR, rawConfig } from '../src/config.mjs';

const argOpen = process.argv.includes('--open');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const cfg = configReport();
const userCfg = rawConfig();
const dbPath = userCfg.dbPath || join(STATE_DIR, 'memjudge.db');
const store = open(dbPath);
const st = store.stats();
const rows = store.list({ limit: 500 });
const facts = store.allFacts();

// 冲突：同 attr 多值（与 layer.conflictJudgments 同一判据，这里只做展示用的粗筛）
const byAttr = new Map();
for (const f of facts) {
  if (!f.attr || f.value == null) continue;
  if (!byAttr.has(f.attr)) byAttr.set(f.attr, new Set());
  byAttr.get(f.attr).add(String(f.value));
}
const conflicts = [...byAttr.entries()].filter(([, v]) => v.size > 1).sort((a, b) => b[1].size - a[1].size);

const pct = Math.min(100, (st.bytes / st.limitBytes) * 100);
const fmt = (n) => n.toLocaleString('zh-CN');
const kb = (n) => (n / 1024).toFixed(1);

const flagRows = [
  ['jieba 分词', cfg.flags.jieba, '搜索引擎模式切词，替代 CJK 二元组'],
  ['向量融合', cfg.flags.vector, 'Qwen3-Embedding-8B 64 维 int8，BM25 + RRF'],
  ['精排 rerank', cfg.flags.rerank, 'Qwen3-Reranker-8B，综合题零增量（实测）'],
  ['查询扩展', cfg.flags.expand, 'LLM 拆子查询，单轮召回 0.583 无增益'],
  ['LLM 选段', cfg.flags.llmSelect, '候选段交模型挑选，候选池无答案段时无效'],
  ['LLM 提取', cfg.flags.llmExtract, '离线重建 facts，161 条 grounding 100%'],
];

const abilities = [
  ['装上', 'PASS', '五个工具注册成功，宿主可调用'],
  ['保真', 'PASS', '8/8，dump 与原文逐字相等'],
  ['召回', 'PASS', '0.989（91/92）'],
  ['幻觉拒答', 'PASS', 'SPEC 口径 5/6'],
  ['冲突消解', 'PASS', '3/4，冲突行逐条实测'],
  ['衰减', 'PASS', '半衰期 30 天，地板 0.15'],
  ['图谱', 'PASS', '七字段加权'],
  ['预算', 'PASS', '超限硬拒，不静默截断'],
  ['索引', 'PASS', 'descriptor 行'],
  ['存储', 'PASS', `${kb(st.bytes)}KB / 200KB`],
  ['自我修改', 'PART', '三态具备，端到端未测'],
  ['多轮综合题', 'FAIL', '单轮 0.625 / 多轮 0.667，目标 0.917'],
];

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>memjudge — 记忆库面板</title>
<style>
:root{--bg:#0b0c0e;--panel:#121418;--line:#23272e;--fg:#e8e6e1;--dim:#8b8f96;--ok:#5fb87a;--warn:#d9a441;--bad:#c9615a;--mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--mono);padding:32px 28px 64px}
h1{font:600 26px/1.2 Georgia,"Songti SC",serif;margin:0 0 4px;letter-spacing:.02em}
.sub{color:var(--dim);font-size:12px;margin-bottom:28px}
.sub code{color:#b9bdc4}
h2{font:600 13px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:34px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px}
.kv{background:var(--panel);border:1px solid var(--line);padding:14px 16px}
.kv .k{color:var(--dim);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.kv .v{font-size:19px;margin-top:5px;font-variant-numeric:tabular-nums}
.kv .n{color:var(--dim);font-size:11px;margin-top:3px}
.bar{height:5px;background:#1c2026;margin-top:10px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--ok)}
.bar.warn i{background:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:400;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:6px 10px 6px 0;border-bottom:1px solid var(--line)}
td{padding:7px 10px 7px 0;border-bottom:1px solid #191c21;vertical-align:top}
td.num{font-variant-numeric:tabular-nums;color:var(--dim);white-space:nowrap}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.dim{color:var(--dim)}
.tag{display:inline-block;font-size:10px;letter-spacing:.1em;padding:1px 6px;border:1px solid currentColor}
.note{background:#131519;border-left:2px solid var(--warn);padding:11px 14px;font-size:12px;color:#cfcbc3;margin-top:12px}
.note code{color:#e8e6e1;background:#1c2026;padding:1px 5px}
.mem{max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9ccd2}
.empty{color:var(--dim);font-size:12px;padding:10px 0}
footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);color:var(--dim);font-size:11px}
</style></head><body>

<h1>memjudge</h1>
<div class="sub">记忆库面板 · 生成于 ${esc(new Date().toLocaleString('zh-CN'))} · <code>${esc(dbPath)}</code></div>

<h2>库体</h2>
<div class="grid">
  <div class="kv"><div class="k">记忆条目</div><div class="v">${fmt(st.memories)}</div><div class="n">${fmt(st.segments)} 段 / ${fmt(st.chapters ?? '—')} 章</div></div>
  <div class="kv"><div class="k">三元组</div><div class="v">${fmt(st.facts)}</div><div class="n">${fmt(byAttr.size)} 个不同属性</div></div>
  <div class="kv"><div class="k">正文字数</div><div class="v">${fmt(st.textChars)}</div><div class="n">去重后 ${kb(st.textBytes)}KB</div></div>
  <div class="kv"><div class="k">占用</div><div class="v">${kb(st.bytes)}KB <span class="dim" style="font-size:12px">/ 200KB</span></div>
    <div class="bar ${pct > 85 ? 'warn' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="n">余量 ${kb(st.limitBytes - st.bytes)}KB</div></div>
</div>

<h2>模块开关</h2>
<table><thead><tr><th>模块</th><th>状态</th><th>说明</th></tr></thead><tbody>
${flagRows.map(([n, on, d]) => `<tr><td>${esc(n)}</td><td class="${on ? 'ok' : 'dim'}">${on ? 'ON' : 'OFF'}</td><td class="dim">${esc(d)}</td></tr>`).join('')}
</tbody></table>

<h2>模型与密钥</h2>
<table><tbody>
<tr><td style="width:150px">密钥</td><td class="${cfg.hasKey ? 'ok' : 'warn'}">${cfg.hasKey ? `已配置（${esc(cfg.keySource)}）<span class="dim"> ${esc(cfg.keyMasked)}</span>` : '未配置'}</td></tr>
<tr><td>端点</td><td class="dim">${esc(cfg.baseUrl)}</td></tr>
<tr><td>对话 / 提取</td><td class="dim">${esc(cfg.chatModel)}</td></tr>
<tr><td>向量</td><td class="dim">${esc(cfg.embedModel)} · ${cfg.dims} 维</td></tr>
<tr><td>精排</td><td class="dim">${esc(cfg.rerankModel)}</td></tr>
<tr><td>配置文件</td><td class="dim">${esc(cfg.configPath)}</td></tr>
<tr><td>密钥文件</td><td class="dim">${esc(cfg.secretsPath)}</td></tr>
</tbody></table>
<div class="note">${esc(cfg.hint)}${cfg.hasKey ? '' : '<br>填法：编辑上面那个 secrets.json，写 <code>{"llmKey":"你的key"}</code>；或在配置里把 <code>vector</code>/<code>rerank</code> 等开关设为 <code>true</code>。<b>密钥不要写进 config.json，也不要提交到 git。</b>'}</div>

<h2>能力</h2>
<table><thead><tr><th>能力</th><th>状态</th><th>证据</th></tr></thead><tbody>
${abilities.map(([n, s, d]) => `<tr><td>${esc(n)}</td><td class="${s === 'PASS' ? 'ok' : s === 'PART' ? 'warn' : 'bad'}">${s}</td><td class="dim">${esc(d)}</td></tr>`).join('')}
</tbody></table>

<h2>记忆 <span class="dim" style="font-size:11px;letter-spacing:0">${rows.length} 条（最多列 500）</span></h2>
${rows.length === 0 ? '<div class="empty">库里还没有记忆。用 memjudge_remember 写入，或让自动捕获跑一轮。</div>' : `<table><thead><tr><th>章</th><th class="num">字数</th><th>内容</th></tr></thead><tbody>
${rows.slice(0, 120).map((r) => `<tr><td class="num">${esc(r.chapter ?? '—')}</td><td class="num">${String(r.text ?? '').length}</td><td class="mem">${esc(String(r.text ?? '').slice(0, 120))}</td></tr>`).join('')}
</tbody></table>`}

<h2>冲突候选 <span class="dim" style="font-size:11px;letter-spacing:0">同属性多值 ${conflicts.length} 组</span></h2>
${conflicts.length === 0 ? '<div class="empty">没有同属性多值。数值类冲突会在这里出现。</div>' : `<table><thead><tr><th>属性</th><th>取值</th></tr></thead><tbody>
${conflicts.slice(0, 40).map(([a, v]) => `<tr><td>${esc(a)}</td><td class="dim">${esc([...v].join(' · '))}</td></tr>`).join('')}
</tbody></table>`}

<footer>重新生成：<code>node scripts/panel.mjs --open</code> · 这张页面不含密钥原文，可安全截图</footer>
</body></html>`;

mkdirSync(STATE_DIR, { recursive: true });
const out = join(STATE_DIR, 'panel.html');
writeFileSync(out, html, 'utf8');
store.close?.();
console.log(`面板已生成：${out}`);
console.log(`${st.memories} 条记忆 / ${st.facts} 三元组 / ${kb(st.bytes)}KB / 冲突候选 ${conflicts.length} 组`);

if (argOpen) {
  execFile(process.platform === 'win32' ? 'cmd' : 'open', process.platform === 'win32' ? ['/c', 'start', '', out] : [out], () => {});
}
