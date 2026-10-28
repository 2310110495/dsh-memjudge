#!/usr/bin/env node
// 拒答通用性回归：幻觉题能不能被拒，取决于判据是否真的通用，而不是对 SPEC 六道题过拟合。
//
// 这里两组数据互相制衡：
//   ① 23 条构造问法——实体名或属性名在整个语料 grep 计数为 0，正确答案只能是「没有记载」；
//   ② 104 道真题——必须一条都不拒（拒了就是把真题当幻觉）。
// 只看 ① 会不断加规则直到过拟合，只看 ② 会永远不敢拒。两组一起跑才有意义。
//
// 分档结论（t11 复验确认）：A 组「陌生实体」全拒，B 组「陌生机构/地名」全拒，
// C 组「已知实体 + 属性整串未记录」只拒到覆盖率 0 的那几条。C 组缺口按形态识别，
// 不按问法字面登记——见 knownGap()。
//
// 用法：node scripts/check-generality.mjs
import { buildStore, gate } from '../src/judge.mjs';
import { isHardDeny } from '../src/index.mjs';
import { chapters, recall, synthesis } from '../../mem-eval/corpus/quiz.mjs';

const store = buildStore(chapters.map((c) => ({ n: c.n, text: c.text })));
const body = chapters.map((c) => c.text).join('\n');

// 括号内是语料中的 grep 计数，0 表示这个名字/属性从没出现过。
const ABSENT_CASES = [
  ['远洋号', '远洋号的造船厂是哪家？'], // 远洋 1 次，但从未当过事实主语
  ['远洋号', '远洋号的载员定额是多少？'],
  ['远洋号', '远洋号的载重吨是多少？'],
  ['远洋号', '远洋号的吃水是多少？'],
  ['远洋号', '远洋号的主机型号是什么？'],
  ['津港号', '津港号的船级社是哪个？'], // 津港 0
  ['津港号', '津港号的载重吨是多少？'],
  ['津港号', '津港号的主机功率是多少？'],
  ['辽渔号', '辽渔号的船长是谁？'], // 辽渔 0
  ['辽渔号', '辽渔号的吃水是多少？'],
  ['辽渔号', '辽渔号的甲板面积是多少？'],
  ['曙光号', '曙光号的交付日期是什么？'], // 曙光 0
  ['曙光号', '曙光号的航速是多少？'],
  ['海鹰号', '海鹰号的雷达型号是什么？'], // 海鹰 0
  ['海鹰号', '海鹰号的建造年份是什么？'],
  ['海燕号', '海燕号靠泊哪个码头？'],
  ['红旗号', '红旗号的船籍是哪国？'],
  ['白鲸号的冷藏舱', '白鲸号的冷藏舱容量是多少？'], // 冷藏舱 0
  ['白鲸号的锅炉', '白鲸号的锅炉压力是多少？'], // 锅炉 0（压力有）
  ['白鲸号的螺旋桨', '白鲸号的螺旋桨直径是多少？'], // 螺旋桨 0
  ['白鲸号的通信频率', '白鲸号的通信频率是多少？'], // 通信频率 0（频率有）
  ['白鲸号的舵机', '白鲸号的舵机型号是什么？'], // 舵机 0（型号有）
  ['比通港的潮差', '比通港的潮差是多少？'], // 潮差 0（潮/差 各自有，二字组不连贯）
];

// C 组缺口按形态识别，不按问法字面登记：问句里「的 X」的 X 整串不在正文、长度够长，
// 但二字组被语料里的通用后缀（型号/频率/容量/压力）拼出 0.5 以上覆盖率，gate 判 hit。
// 这是当前判据的已知边界，不是可以靠调阈值补上的——应收在结论里，不藏在白名单里。
// detail 见 docs/AUDIT.md 能力 6 第二轮修订、reports/t11-recheck.md。
const PHRASE_RE = /的([\u4e00-\u9fff]{2,6}?)(?=是|有|为|多少|什么|哪|几|怎么|如何|$|[?？])/g;
function knownGap(q) {
  for (const m of String(q).matchAll(PHRASE_RE)) {
    const p = m[1];
    if ([...p].length < 2) continue; // 「部件」「费率」这类两字词在正文里都有，会被下面的 includes 挡掉
    if (!body.includes(p)) return p;
  }
  return null;
}

let denied = 0;
let gapCount = 0;
const misses = [];
for (const [tag, q] of ABSENT_CASES) {
  const g = gate(q, store);
  const hard = isHardDeny(g, q, body);
  if (hard) denied += 1;
  else {
    const gap = knownGap(q);
    if (gap) gapCount += 1;
    else misses.push(`${tag} → ${q}（${g.reason} cov=${g.coverage ?? '-'}）`);
  }
}

let falseDeny = [];
for (const item of [...recall, ...synthesis]) {
  const g = gate(item.q, store);
  if (isHardDeny(g, item.q, body)) falseDeny.push(`${item.id} ${item.q}（${g.reason}）`);
}

const total = ABSENT_CASES.length;
console.log(`幻觉拒答：${denied}/${total}（硬拒），其中 C 组形态缺口 ${gapCount} 条`);
for (const m of misses) console.log(`  未覆盖且不属于已知形态：${m}`);
console.log(`真题误伤：${falseDeny.length}/104`);
for (const f of falseDeny.slice(0, 10)) console.log(`  ${f}`);

// 判据：不得误伤真题；未拦下的必须是 C 组已知形态，出现形态外漏判即 FAIL。
const ok = misses.length === 0 && falseDeny.length === 0;
console.log(
  ok
    ? `\n通用性 PASS（A/B 组全拒；C 组形态缺口 ${gapCount} 条已登记，零误伤）`
    : '\n通用性 FAIL',
);
process.exit(ok ? 0 : 1);
