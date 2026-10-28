// grounding 校验（双口径）：
//   1) 编译层：raw → compileWiki → groundingViolations 必须为空（t14 的 wiki 投影）
//   2) 存储层：facts 只存句子指针，value 必须能在 memories.text 的 sent_off/sent_len
//      切片里逐字找到（t13 的 L1 指针）
// 退出码 0 = 两条都通过；1 = 有违规。
import { open } from '../src/store.mjs';
import { compileWiki, groundingViolations } from '../src/layer.mjs';
import { chapters } from '../../mem-eval/corpus/quiz.mjs';

let failed = 0;

// ── 1) 编译层 grounding ──
const raws = [];
for (const c of chapters) {
  const parts = String(c.text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    raws.push({ id: `c${String(c.n).padStart(2, '0')}p${String(i + 1).padStart(3, '0')}`, text: parts[i], createdAt: 1000 + i, ch: c.n });
  }
}
const wiki = compileWiki(raws);
const violations = groundingViolations(wiki);
console.log(`编译层 grounding: ${violations.length === 0 ? 'PASS' : 'FAIL'}（${raws.length} 条 raw / ${wiki.blocks?.length ?? 0} 个 block / 违规 ${violations.length}）`);
for (const v of violations.slice(0, 10)) console.log('  BAD', JSON.stringify(v));
if (violations.length) failed += 1;

// ── 2) 存储层 grounding（facts 句子指针）──
const store = open(':memory:');
for (const c of chapters) {
  const parts = String(c.text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) store.put({ text: parts[i], chapter: c.n, para: i + 1 });
}
let total = 0;
let ok = 0;
const bad = [];
for (const m of store.dump()) {
  for (const f of m.facts) {
    total += 1;
    const sent = m.text.slice(f.sent_off, f.sent_off + f.sent_len);
    if (f.sent_len > 0 && m.text.includes(sent) && sent.includes(f.value)) ok += 1;
    else bad.push({ mem: m.id, attr: f.attr, value: f.value, sent_off: f.sent_off, sent_len: f.sent_len });
  }
}
store.close();
console.log(`存储层 grounding: ${ok}/${total} 条 fact 的 value 可在 sent_off/sent_len 切出的原句里逐字找到`);
for (const b of bad.slice(0, 10)) console.log('  BAD', JSON.stringify(b));
if (!(total > 0 && ok === total)) failed += 1;

process.exitCode = failed ? 1 : 0;
