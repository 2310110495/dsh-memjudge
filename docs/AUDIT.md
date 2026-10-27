# memjudge 独立审查报告

审查对象：`src/{schema,store,search,judge,index}.mjs`、`test/*.test.mjs`、`results/*.json`、`COMPARE.md`、`docs/SPEC.md`(spec-1.1)
审查日期：2026-10-27｜审查员：observer（未参与实现，未参与 t14 实测）
原则：每条裁决附可复现命令或行号；不可复核的分数标「未验证」，不按「通过」计。

## 0. 前提：复核链断了两处

裁决 12 项之前必须说清一件事：**本仓库现有产物不足以支持逐字复核**。

1. `SPEC.md:414` 规定 `raw/<QID>.txt` 保存每次查询的完整返回，作为「能力 2/5/6/9/10 的逐字复核底本」。实际不存在：`ls memjudge-plugin/raw` → No such file。
2. `mem-eval/harness/run-one.mjs:41-44` 的 `cap()` 把返回截断后才落盘：recall/synthesis/hallucination 存 `slice(0,400)`（:130/:146/:163），fidelity/conflict/selfmod 存 `slice(0,600)`（:181/:198/:216）。125 题里 121 题的 `got` 短于 `gotLen`。
3. sqlite 文件已删除，`storage.bytes=217088` 无实物可验。

后果：我能复算「分数是否由现有 got 得出」，不能复算「插件真实返回了什么」。下面每一项「pass」都区分**判定成立**与**可复核**两件事。

## 1. 能力 1 — 存得准：pass 不成立，应为「未验证」

COMPARE 写「dump 去空白 29648 字 == 原文 29648，`equal=true`」。

- `results/memjudge.json` 顶层 `dumpChars = 30356`，**不是 29648**。
- 全库不存在 `equal` 字段（`grep -c equal results/memjudge.json` → 0）。
- dump 文件不存在（`find . -name "*dump*"` → 空）。

29648 是我从 `mem-eval/corpus/novel.mjs` 的 20 个 text 块去空白算出来的，与 `write.chars=30318`、`dumpChars=30356` 三个数互不相同，`COMPARE.md` 与产物对不上。裁决：**pass 无证据支撑**，须补 `dump` 落盘 + 逐字 diff 产物。

## 2. 能力 3 — 找得回：3a 成立，3b 是判据取整问题

- 3a：`recallFull=91 / recallMiss=1`，91/92=0.989 ≥ 0.989 ✅。唯一 miss 是 R20。
- 3b：`decay-memjudge.json` day0 retention 存 `0.87`，实为 **80/92 = 0.869565**。`SPEC.md:114` 阈值写 `>= 0.870`，`SPEC.md:116` 自己又写「decayFloor=0 时 3b=0.870（12 miss）」。
- 80/92 < 0.870。若按原始比值比，**3b 不过**；若先 `toFixed(3)` 再比，**3b 过**。

裁决：3b **不足以判 pass**。这是 SPEC 判据缺陷（阈值与被测值同为字符串 `0.870`），不是实现缺陷。已写入 §11-缺陷 1。要求 SPEC 改为 `>= 80/92` 或显式规定取整方向。

## 3. 能力 4 — 综合 0.583：fail 成立

`synthFull=5/12`，0.583 < 0.7（SPEC:2.4）。诊断 `diag-memjudge-topc4.json`：`synthScore=0.625`、`recallScore=0.989`，选章数 2→4 只涨 0.042。

瓶颈归因成立：`fitBudget` 把返回钳在 2000 字符，S 题需 3 章以上材料。裁决：**fail 成立**，且「调参解决不了」的判断有 diag 支撑，不是推测。

## 4. 能力 5 — 不编：pass 成立，但只到返回层

- `halluFab=0`、`contaminate=0` ✅。
- 我独立复算：6 个 absent 探针（`IMO 编号`/`出生年份`/`中心气压`/`海关关长`/`上一航次`/`成立年份`）在 125 题 `got` 汇总 51684 字里命中 **0 次**。
- 边界：返回被截断，库层是否 0 泄漏不可验（无 dump）。

裁决：**pass 成立**（材料侧），范围限「返回给下游的文本」。

## 5. 能力 6 — deny 0/6：fail 成立，但判据本身有三处硬伤

`SPEC.md:168` 要 `deny ≥ 5/6`。实测 0/6。**fail 这个结论我认可**，但 `COMPARE.md` 的归因写错了方向：

硬伤 1：`harness/score.mjs:26` 定义了 `denyNearEntity`，**全文件零调用**。`absentNear` 恒 undefined，实体邻近判据是死代码。H1「只到 IMO 没到 IMO 编号」的失败被 COMPARE 描述成「判据形状问题」——实际是那条判据根本没跑。

硬伤 2：`score.mjs:54` 是 `<40 字符 → score 1.0 (empty)`，`score.mjs:56` 是 `40–600 → 0.5`。**返回 39 字得满分 1.0，返回 43 字得 0.5。越短分越高。** COMPARE 写「H2/H5/H6 返回 39 字符，被 ≥40 硬门槛挡在 empty」——方向反了：它们正是**因为** 39<40 才拿到 1.0。`halluScore=0.667` 本身就是这笔账的证明（4×1.0 + 2×0.25）/6。

硬伤 3：H3 被计入 deny 成功，理由是返回里出现「材料提到「百帕」」。但「中心气压」未记载，「百帕」出现在别处。这是**关键词巧合导致的假阳性**，不是拒答。

裁决：**fail 成立**；`COMPARE.md` 的能力 6 段必须重写，并把「行为 4/6、判据 0/6」改为「行为 5/6 中 1 次为巧合、真拒答 4/6」。

## 6. 能力 7 — 存储 212KB：fail 成立

`storage={bytes:217088, files:1, kb:212}`，> 200KB（SPEC:195）。裁决 **fail 成立**。
边界：DB 已删，字节数不可复核。章级 `memjudge-chapter.json` 172KB 达标但 recall 0.935（<0.989）失败，粒度对冲的描述成立。

## 7. 能力 8 — 注入 1025 字符：pass 成立

`inject={declared:true, implemented:true, chars:1025}`，≤2000 ✅。
但 `COMPARE.md` 写「默认注入 0 字符；打开后 1025」——产物里**没有开关状态字段**，`inject.chars` 只有一个值。「默认 0」是运行时观察，不是产物事实。另 `inject.preview` 显示索引只列 `8/294` 条，注入内容极稀（3 条 ch11 片段）。裁决：**pass 成立**，「默认 0」须补 `inject.enabled` 字段。

## 8. 能力 9 — selfmod 0.5：fail 成立

`selfmodScore=0.5`，M1 latest 1.0 / M2 partial 0.5 / M3 miss 0。SPEC 要求最新结论压过旧结论，M3 返回整段 ch7 旧备忘且无撤销标记。裁决 **fail 成立**。

## 9. 能力 10 — judgedConflict 0/4：fail 成立，且解析逻辑本身是反的

- `conflictScore=1`、`conflictResolved=4`、`conflictRevisionMarkOnly=4`、`conflictDiscovered=0` ✅ 与 COMPARE 一致。
- `SPEC.md:253` 要 `≥3/4`。**captain 消息与 COMPARE 写的「SPEC 要 ≥2/4」是错的**，原文是 3/4。0/4 两种阈值都 fail，但引用错误说明未核原文。
- 我单独跑 `judge.resolveConflict` 在真实两段（ch5「约九厘米」/ ch15「实测十一厘米…九厘米系目测估值，现予更正」）上：返回 `current = 九厘米`、`superseded = 十一厘米` —— **被作废的值被判为现行值，修正值被判为作废**。
- 短路反证（只灌 ch15+ch19）仍报 conflict 成立。

裁决：**fail 成立**。这不只是「靠语料自带更正语拿分」，是冲突消解函数在真实样本上**方向判反**。`conflictScore=1.000` 这个数字不能当「会处理冲突」的证据。

## 10. 能力 11 — 五轮 0.870 flat：fail 成立，理由比 COMPARE 更硬

`decay-memjudge.json` 五轮全 0.870。COMPARE 归因「乘性衰减等比缩放不改排序」，`timeBlind=false`。

我补两条更硬的：

1. `schema.mjs:25` 的 `retainThreshold: 0.15` **除定义处外全库零引用**（`grep -rn retainThreshold src/` 只命中 :25）。它是死配置。90 天时 cold 档 `value = 0.5^(90/12) = 0.0055`，本应低于留存阈值被丢弃，实际一条都没丢。
2. `judge.mjs:540` 的 `finalScore = score × decayWeight` 是纯乘性，对同一查询内所有候选同比缩放，**排序不变**。

合起来：读时钟 → 算权重 → 权重对输出零影响。`timeBlind=false` 在字面意义上成立（时钟确实读了 2262 次），在语义上误导——对结果而言与不读时钟完全等价。裁决：**fail 成立**，且应把 `timeBlind` 拆成 `readsClock` / `affectsOutput` 两个字段。

## 11. 能力 12 — pass 只覆盖了 1/3 条判据

`rankWeight` 实测 0.1149 ≤ 0.25 ✅（第 1 条）。
未覆盖：
- `SPEC.md:311` 第 3 条要求「20 次查询中至少 14 次 top-3 含 warm 条目」。**从未测、从未报**。而 `adapters/memjudge.mjs` 写入时只传 `{text, chapter, para}`，不传 `importance` → `schema.mjs:126` 走默认 `0.5` → `importance 0.5 < warmImportance 0.6` → **warm 集合恒为空，这条验收结构性不可能满足**。
- `SPEC.md:397` 要求把 `warmCount / warmChapters` 写进 `results/acceptance.json`。**该文件不存在**（`ls results/acceptance.json` → No such file）。
- COMPARE 写「排名 #2（末位）」：只有 2 个候选，末位是 #2，#3 之外自动排除。这个实验逻辑上空洞。

裁决：**pass 不成立**，降为「第 1 条通过，第 3 条未测且当前实现不可能通过」。

## 12. 逐项裁决汇总

| # | SPEC 判据 | t14 结论 | 我的裁决 | 依据 |
|---|---|---|---|---|
| 1 | 逐字往返 | pass | **不成立**（无证据） | dumpChars=30356≠29648，无 equal 字段，dump 文件缺失 |
| 2 | fid 8/8 | pass | 成立（复核受限） | `fidelityExact=8, ratio=1`；got 存 600 字，答案在后则不复核 |
| 3a | ≥0.989 | pass | 成立 | 91/92 |
| 3b | ≥0.870 | pass（压线） | **不成立** | 80/92=0.8696<0.870，SPEC 阈值取整缺陷 |
| 4 | ≥0.7 | fail | 成立 | 0.583，diag 0.625 |
| 5 | contaminate 0 | pass | 成立（仅返回层） | 6 探针 0 命中 |
| 6 | deny ≥5/6 | fail | 成立，但判据不可信 | denyNearEntity 死代码；<40 得 1.0 方向反；H3 巧合假阳性 |
| 7 | ≤200KB | fail | 成立（不可复核） | 217088B，DB 已删 |
| 8 | ≤2000 字符 | pass | 成立 | 1025 字符；「默认 0」无字段 |
| 9 | 最新结论优先 | fail | 成立 | 0.5，M3 miss |
| 10 | judgedConflict ≥3/4 | fail | 成立，且解析方向反 | 0/4；resolveConflict 把作废值判为现行 |
| 11 | 单调下降且 90 天 ≥0.15 | fail | 成立 | retainThreshold 死配置 + 乘性缩放不改排序 |
| 12 | weight ≤0.25 + warm 回溯 | pass | **不成立** | 只测第 1 条；warm 集恒空；acceptance.json 缺失 |

净结果：原 6 项 pass 中，**1、3b、12 经复核不成立**，2 复核受限，**仅 3a、5、8 三项成立**。原 6 项 fail 全部成立，其中 10、11 的失败原因是逻辑方向错误而非参数不足。

## 13. 数据真实性 findings

| id | severity | 问题 | 证据行 | 要求 |
|---|---|---|---|---|
| F1 | blocker | `raw/<QID>.txt` 全缺，SPEC:414 规定的逐字复核底本不存在 | `SPEC.md:414`；`ls memjudge-plugin/raw` 空 | 补 125 份 raw 落盘并重跑 |
| F2 | blocker | 落盘 `got` 被 400/600 截断，125 题中 121 题短于 `gotLen` | `harness/run-one.mjs:41-44,130,146,163,181,198,216` | 存全长或存 raw 指针 |
| F3 | high | 能力 1 的 `equal=true` 无字段、无 dump 文件，`dumpChars=30356` 与声称的 29648 不符 | `results/memjudge.json` 顶层 `dumpChars`；`COMPARE.md:11` | 重做逐字 diff 并落产物 |
| F4 | high | `resolveConflict` 在真实样本上把作废值判为现行值 | `src/judge.mjs`（resolveConflict）；复现：输入 ch5/ch15 两段，看 `current` | 修正新旧判定并补真实语料单测 |
| F5 | high | `judge.test.mjs` 的冲突「4/4」是假测试：`pick()` 先按关键词过滤句子，`filter(() => …)` 忽略参数 | `test/judge.test.mjs:110-125` | 换成真实两段原文的无过滤用例 |
| F6 | high | `retainThreshold=0.15` 死配置，衰减不影响留存集合 | `src/schema.mjs:25`（全库零引用） | 要么接进过滤，要么删除并改注释 |
| F7 | high | `denyNearEntity` 定义但零调用 | `harness/score.mjs:26` | 接线或删除 |
| F8 | high | 能力 12 第 3 条（warm top-3 ≥14/20）从未测；adapter 不传 importance 致 warm 集恒空 | `SPEC.md:311`；`adapters/memjudge.mjs` write | 补测并把 importance 落成显式值 |
| F9 | medium | `results/acceptance.json` 缺失（SPEC:397 硬要求） | `SPEC.md:397` | 产出该文件 |
| F10 | medium | COMPARE 时间数字与产物不符：写 1635ms vs `writeMs=1732`；查 5206ms vs `queryMs=5391` | `COMPARE.md:3` 节 vs `memjudge.json` | 以产物为准重写 |
| F11 | medium | COMPARE 能力 6 归因方向反（39 字是得 1.0，不是被挡） | `harness/score.mjs:54,56` | 重写该段 |
| F12 | medium | COMPARE 能力 10 阈值引用错（写 ≥2/4，SPEC 是 ≥3/4） | `SPEC.md:253` | 改正 |
| F13 | medium | `summary.avgReturnChars=1527` 低于实数 1547.6；`budget.avgChars=1548` 才对 | `memjudge.json` summary vs budget | 统一口径 |
| F14 | low | 「244 字节/条元数据」无出处（212KB/294 条=738B/条；与章级差的 45KB/274 条=164B/条） | `COMPARE.md` 能力 7 段 | 给出算式或删除 |

## 14. 公平性与基线

- **章号不是 memjudge 特权**：`run-one.mjs:92` 对全部 adapter 传 `chapters[{n,title,text}]`；`adapters/baseline-bm25.mjs:69` 自己就把「第N章」拼进正文。memjudge 的 `chapter/para` 是同一份输入的另一种用法，**不构成不公平**。
- **真实优势成立**：memjudge 0.989 用 1548 字符/题，baseline-bm25 0.989 用 4610 字符/题。同等召回下材料量 1/3，这是可复核的真实差异。
- **P8 反作弊总闸已满足**：`SPEC.md:54` 要求能力 3/4 只有能力 8 pass 才作数；能力 8 = 1025 字符 pass → 3/4 计分有效，非倾倒路径。

## 15. SPEC 本身的缺陷（须改文档，不是改实现）

1. **`SPEC.md:114` 阈值 `>= 0.870` 与 `SPEC.md:116` 实测「3b=0.870」是同一个字符串**，而精确值 80/92=0.8696。判据与被测值重合，取整方向决定 pass/fail。改为 `>= 80/92` 或写明四舍五入。
2. **`SPEC.md:54` P8 只堵「能力 8」，没堵「返回截断」**。当前 `cap(400)` 让所有能力的复核底本失真，SPEC 应直写「落盘返回必须全长」。
3. **`SPEC.md:414` 要求 raw 落盘却无验收项**。应加一条产物存在性检查。
4. **能力 12 的三条判据里第 3 条依赖 warm 条目，而 SPEC 从未规定 importance 怎么赋值**。adapter 不传 → 默认 0.5 → warm 恒空。SPEC 须规定「写入时必须显式给 importance，且 warm 条目 ≥15 覆盖 ≥6 章」，否则第 3 条无法验收。
5. **能力 11 判「单调下降」，但没规定「平」算不算违反**。本实现因乘性缩放 + 死 retainThreshold 天然为平，SPEC 应写明「任一相邻两轮差 <0.005 视为 flat，判 fail」。

## 16. 结论

材料层（能力 2、3a、5、8）站得住，且成本优势可复核。判断层（4、9、10、11、12）不成立，其中 10 与 11 有**逻辑方向的错误**（冲突解析判反、衰减零后果），不是调参能救的。

原 6 项 pass 中 1、3b、12 经复核不成立；fidelity 与注入两项成立但复核受限；能力 6、7 的 fail 成立而判据不可信；能力 4、9、10、11 的 fail 成立且证据充分。

复核命令（全部可重跑）：
```
cd memjudge-plugin
node -e "const m=require('./results/memjudge.json');console.log(m.dumpChars,m.storage,m.inject.chars)"
grep -rn "retainThreshold" src/            # 只命中 schema.mjs:25
grep -rn "denyNearEntity" ../../mem-eval/harness/score.mjs   # 只命中定义行
ls raw results/acceptance.json             # 均不存在
node ../../mem-eval/harness/run-one.mjs memjudge   # 125 题，err=0
```
