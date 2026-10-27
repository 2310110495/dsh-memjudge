# memjudge 验收规范（SPEC）

版本 `spec-1.1`（1.1：能力 3 拆 3a/3b 两场景，消除与能力 12 的数学冲突）｜ 真源文件：`memjudge-plugin/docs/SPEC.md`（本文）+ `memjudge-plugin/src/schema.mjs`
适用对象：自研记忆插件 `dsh-memjudge`（材料层取 mem-eval 实测最强件口径，判断层为新增）
语料：`mem-eval/corpus/novel.mjs`（20 章，去空白 29648 字）｜题库：`mem-eval/corpus/quiz.mjs`

---

## 0. 总则

**0.1 一条能力一测。** 12 项能力各自独立给出 pass / fail，禁止加权、禁止总分、禁止「综合评分」。`results/acceptance.json` 里只有 12 个布尔值加证据指针。

**0.2 分数一律调 `mem-eval/harness/score.mjs` 的原函数。** 除能力 6（deny 判定，原函数未导出，见 P4-R）外，任何重新实现评分的做法都非法。

**0.3 `mem-eval/` 只读。** 语料、题库、harness、results 全部不得修改。memjudge 的适配器与产物一律放在 `memjudge-plugin/` 下，评测时以绝对路径传给 `run-one.mjs`（它接受任意路径，见 `harness/run-one.mjs:25`）。

**0.4 通过条件写死在此文档。** 后续 7 个任务按本文验收；判据不许在执行时软化。若某条判据被证明不可测，走「修订 SPEC」流程：改本文 + 提高版本号 + 在 `results/acceptance.json` 里注明 revision，不得只在口头放宽。

**0.5 三个角色。**

| 角色 | 谁 | 能签的字 |
| --- | --- | --- |
| `author` | memjudge 实现者 | 自测结果，**不构成验收** |
| `verifier` | 独立验收员（非实现者） | 跑 `test/acceptance.mjs`，签 `results/acceptance.json` |
| `auditor` | 复核员（非实现者） | 抽 `results/raw/` 逐字复核，签 `reports/audit-*.md` |

每一节末尾的「测」写的是**该条的签字角色**。任何一条由 `author` 自签即视为未测。

---

## 1. 公共测量协议

**P1 假时钟。** 能力 11/12 用 `mem-eval/harness/fake-clock.mjs`：进程内替换 `Date.now()` / `new Date()`，起始 `2026-10-27T00:00:00.000Z`，`dayMs = 86400000`。它**不模拟文件 mtime**——任何靠文件系统时间判新旧的实现不计入这两项成绩。写入时间线固定为「第 ch 章写入于 `-(20-ch)` 天」，与 `results/decay-*.json` 的 `clock.writeTimeline` 一致。

**P2 token 折算。** `estTokens()`：CJK 0.75 / ASCII 0.3。只用于跨插件横向比较，**不是真实 tokenizer**，不得当绝对预算用（中文标点按 ASCII 计，系统性低估）。

**P3 归一化。** 文本比较一律先过 `score.mjs` 的 `norm()`（去空白与中英文标点、转小写）或 `canon()`（引号归一、去空白、去标点，用于保真）。两份实现都在 `score.mjs`，不得另写。

**P4 四个允许的判定扩展。** 只有这四处允许在 memjudge 侧写判定逻辑，其余一律调原函数：

| 编号 | 判定 | 依据 |
| --- | --- | --- |
| P4-A | 存储体积 | `run-one.mjs:258` 的 `dirSize(workdir)` 口径（字节/1024，向下整除到 0.1KB） |
| P4-B | 注入字符 | `injectionBudget(report).fixed.chars` 与 `.perQuery.maxChars`（`score.mjs:414`） |
| P4-C | top-k 排序 | memjudge 自己返回的数组前 k 项；k=3 |
| P4-D | deny 判定 | `score.mjs` 的 `DENY` 正则与 `NEAR_WINDOW = 80` 常量（`:20-33`）；`denyNearEntity` 是**私有函数**，未导出，须等价实现并通过 §2.6 的 parity 检查 |

**P5 证据留存。** 每次评测必须把完整返回写到 `memjudge-plugin/results/raw/<QID>.txt`（不切片）。`results/*.json` 里的 `got` 允许截断到 4000 字符，但 `gotLen` 必须是全长——`injectionBudget` 用 `gotLen` 统计，截断只影响人读。

**P6 字段名沿用 run-one。** 报告结构、`summary` 键名、`meta/workdir/clock/write/recall/synthesis/hallucination/fidelity/conflict/selfmod/inject/budget/storage/errors/queryMs/dumpChars` 全部与 `mem-eval/results/baseline-bm25.json` 同构。下游脚本按这些键取值，自创结构视为不合规。

**P7 语料字数常量。** `29648`（20 章去空白字符数）、`estTokens ≈ 20750`。语料重新生成后这两个数必须同步更新到本文与 `test/acceptance.mjs`。

**P8 反作弊总闸。** 任何「把材料全倒出来」拿分的路径一律封死：能力 3/4 的成绩只有在能力 8 同时 pass 时才作数。历史对照——`save-token` 用 30k 字符全量倾倒拿到 recall 1.000，`retcon-form` 用 30548 字符拿到 1.000，这类路径在本项目里不算找得回。

---

## 2. 12 项能力

每项给：目标 ｜ 判据（可执行） ｜ 数据与字段 ｜ 复现 ｜ 已知反例 ｜ 测。

### 2.1 能力 1 — 存得准（写入后 dump 与原文逐字一致）

**目标**：`fidelity exact = 8/8`，且 20 章逐字往返无损。

**判据**

1. 章级往返：对 `ch = 1..20`，取存储中 `source.chapter === ch` 的全部条目，按 `source.para` 升序以 `\n\n` 连接成 `rebuilt_ch`，要求 `canon(rebuilt_ch) === canon(chapters[ch-1].text)`。**20/20 通过**。
2. 全量字数：`rebuilt_all` 去空白字符数 `=== 29648`。
3. 保真句：8 条 `fidelity[i]`（原文串）在 `rebuilt_all` 中 `canon` 逐字出现，**8/8**。
4. 无改写痕迹：`rebuilt_all` 中不得出现「摘要」「总结为」「改写」「压缩后」这类二次加工标记（正则 `/(摘要|总结为|改写|压缩后|简化为)/` 命中即 fail）。

**数据**：`mem-eval/corpus/novel.mjs` → `chapters[i].text`；memjudge 的 `adapter.dump()`（`run-one.mjs:263`）或 `.work/store/` 直接读盘重建。

**复现**：`node memjudge-plugin/test/acceptance.mjs --only store`（内部调 `runOne(adapterPath, {workdir})` 后取 `dumpChars` 并重建）

**已知反例**：`save-token` 不落盘（`storage.applicable=false`）；`retcon-form` 按标点切段会重排语序，段落级重建对不上。

**测**：`verifier` 全量跑；`auditor` 抽 ch1、ch10、ch19 三章人工比对首尾各 200 字。

---

### 2.2 能力 2 — 原样回原文

**目标**：8 条保真题的返回里，原句 `exact = 8/8`。

**判据**：对每条 `fidelity[i]`，`fidelityScore(fidelity[i], returnedText).exact === true`。计数 `>= 8`。

**数据**：`mem-eval/corpus/quiz.mjs` → `fidelity`（`string[]`，顺序即 F1–F8，与 `harness/run.mjs:5` 的 `FIDELITY_Q` 严格对齐，**不得重排**）；返回文本取 `results/memjudge.json → fidelity[i].got`。

**复现**：`node mem-eval/harness/run-one.mjs <abs>/memjudge-plugin/src/adapter.mjs --out <abs>/memjudge-plugin/results/memjudge.json`

**已知反例**：`Aik358` 2/8（中文不分词导致整句变成一个 term）；`knowledge` 4/8（自动召回只取 3 条）。

**测**：`verifier`。

---

### 2.3 能力 3 — 找得回（条级召回）

**目标**：`recall ≥ 0.989`（不低于 baseline-bm25 的 91/92）。

**判据**

1. `summary.recallScore >= 0.989`。
2. 且 `summary.recallMiss <= 1`（92 题里最多错 1 题）。
3. 且能力 8 pass（P8 反作弊闸）。

**时序场景（spec-1.1 新增，消除与能力 12 的数学冲突）**

| 场景 | 写入时序 | 查询时访问 | 达标线 | 说明 |
| --- | --- | --- | --- | --- |
| 3a 同期写入 | 20 章同一时刻写入 | 查询即访问 | `recall >= 0.989` | 主成绩，与能力 12 无冲突 |
| 3b 按天错开 | 第 ch 章写入于 `-(20-ch)` 天（同 P1） | 写完从未访问 | `recall >= 0.870` | 衰减必然压低旧章，与能力 12 数学上不可同时取 0.989 |

实现侧必须同时报告两个场景分数；只报 3a 视为隐瞒衰减代价。实测：decayFloor=0 时 3b=0.870（12 miss），floor=0.6→0.957、0.75→0.978、1→0.989（等价于关掉衰减，能力 12 必 fail）。这是「找得回」与「不翻旧账」的真实张力，不是实现缺陷。

**数据**：`quiz.recall`（92 条，`id/ch/q/a/kw`）；评分 `scoreRecall(returned, item)`（`score.mjs:11`，kw 全中 1 / 部分 0.5 / 全不中 0）。注意 90/92 题只有 1 个 kw，本项实际是「目标章有没有进返回」，不是检索精度——这点在报告里必须照实写。另：R20「航速减到多少」与答案段「减速至八节」零 bigram 交集，baseline-bm25 同样 miss，属纯词法地板，不为它对题库过拟合。

**复现**：同 2.2 的 `run-one` 命令，读 `summary.recallScore`。

**已知反例**：`Aik358` 0.033；`mnemon` 0.098（search-only）；`knowledge` 0.739（`minScore 0.2` + 只取 3 条）。

**测**：`verifier`。

---

### 2.4 能力 4 — 12 题综合

**目标**：`synth ≥ 0.917`（≥ 11/12，不低于 FuRongJun 灵枢）。

**判据**

1. `summary.synthScore >= 0.917`。
2. S11（陷阱题）单独判：返回必须同时含「左臂骨折」与「伤情未记载」，且**不得**给出第二名伤员的任何具体伤情（正则 `/(另一人|第二人|另一名)[^。]{0,20}(骨折|擦伤|挫伤|烫伤|裂伤|住院)/` 命中即 fail）。
3. 且能力 8 pass。

**数据**：`quiz.synthesis`（12 条，`kw` 为跨章合并所需的 2 个关键项）；`quiz.synthesis` 中 `trap:true` 的仅 S11。

**复现**：`summary.synthScore` + `results/memjudge.json → synthesis[10]`。

**已知反例**：`knowledge` 0.333（默认只取 3 条，7/12 题需要 4 条以上材料）；`OpenViking` 0.375（分层预算压掉多章材料）。

**测**：`verifier`；`auditor` 抽 S01/S07/S11 三道回看原文。

---

### 2.5 能力 5 — 不编（contaminate = 0）

**目标**：问到原文不存在的信息，返回里不得出现原文没有的具体值。

**判据**

1. 6 条 `hallucination` 题，`scoreHallucination(returned, item).verdict !== 'contaminate'` 全部成立（`contaminate` 判据：`absent` 后紧跟 `[0-9]{2,}`，`score.mjs:48-53`）。
2. 全库污染检查：6 个 `absent` 探针词（`IMO 编号`、`出生年份`、`中心气压`、`海关关长`、`上一航次`、`成立年份`）在 `rebuilt_all`（能力 1 的产物）中的出现次数 `=== 0`（`norm` 后）。
3. 6 次 H 题返回中，探针词若出现，其后 40 字符内不得有数字（防止「IMO 编号 9876543」这种局部污染）。

**数据**：`quiz.hallucination[i].absent`；`score.mjs` 的 `FABRICATE`。语料侧已由 `validateCorpus` 保证探针词不在正文。

**复现**：`node -e "import('./harness/score.mjs').then(...)"` 对 `results/raw/H*.txt` 逐条重算。

**已知反例**：`memento` 0.500（两题 9 字符空返回）；`Aik358` 0.625（39 字符空返回造成的假象）。

**测**：`verifier`。

---

### 2.6 能力 6 — 问没有的说没有（deny ≥ 5/6）

**目标**：6 题里至少 5 题给出「否认 + 邻近被问实体」的正面拒答。

**背景（必须写进报告）**：`run.mjs:191` 的 `halluDeny` 统计 `verdict === 'deny'`，而 `scoreHallucination` **从不产出 `deny`**——`denyNearEntity`（`score.mjs:26`）定义了却没有任何调用点。所以历史 24 份结果的 `halluDeny` 结构性恒为 0，不是 24 个插件都不会拒答，而是**这个维度从来没被测过**。本项是本项目的核心突破点，必须自带判定。

**判据**

1. 对 `i = 1..6`，令 `a = norm(returned_i)`，`p = a.indexOf(norm(absent_i))`：
   - 命中 deny ⟺ `p >= 0` 且 `DENY.test(a.slice(max(0,p-80), p + absent_i.length + 80))`。
   - `DENY` = `score.mjs:20` 的正则，`NEAR_WINDOW = 80`。**逐字复制，不得放宽窗口、不得加词。**
2. `count(deny) >= 5`。
3. 附加硬条件：`returned_i.length >= 40`。空返回（`<40` 字符）在 `scoreHallucination` 里得 1 分但**不是拒答**，本项不认（历史 `empty` 档拿分的路径在此关闭）。
4. parity 检查（防自己放水）：把同一判定跑在 `mem-eval/results/raw/<24 个适配器>/H*.txt` 上，重建出的 `halluDeny` 必须与各 `results/*.json` 的 `summary.halluDeny` 完全一致（全为 0）。任一适配器重算出 >0，说明判定比历史口径宽，**必须收紧后重跑**，否则本项 fail。

**数据**：`quiz.hallucination[i]`（`q`/`absent`）；`mem-eval/results/raw/*/H*.txt`（parity 用，约 144 个文件）。

**复现**：`node memjudge-plugin/test/deny-parity.mjs`（parity，输出 24 行对照）+ `node memjudge-plugin/test/acceptance.mjs --only deny`。

**已知反例**：24 个适配器 `halluDeny = 0/6`，无一例外；`empty` 档（如 `Aik358` 39 字符返回）是假拒答。

**测**：`verifier` 跑判定；`auditor` 手工抽 H1、H4、H6 三条看原文再判一次。

---

### 2.7 能力 7 — 占多大地方（存储 ≤ 200KB）

**目标**：20 章 29648 字的持久化占用 ≤ 200KB。

**判据**

1. `dirSize(memjudge-plugin/.work/store)` 的 `bytes / 1024 <= 200`（P4-A 口径，保留 1 位小数）。
2. 计入范围**只含**落盘记忆库与索引；`results/`、`raw/`、`logs/`、`test/`、`docs/`、`node_modules/` 一律不计。
3. 若走「不落盘、纯内存」路线，本项 fail（历史 `baseline-bm25` 的 `storage.kb=0` 是「无落盘」而非「零开销」，不得引用为优势）。

**数据**：`results/memjudge.json → storage.bytes/.kb`；独立复核用 `du -sb` 等价统计。

**预算提示**：原文 UTF-8 约 89KB（中文 3 字节/字），索引只剩约 110KB 额度。bigram 倒排必须压（前缀压缩 / varint / 只存块号不存位置）。

**已知反例**：`veyra` 4980.7KB、`memento` 3769.8KB、`bm25` 3546.9KB。

**测**：`verifier`。

---

### 2.8 能力 8 — 一次塞多少（注入 ≤ 2000 字符/次）

**目标**：每轮固定注入与单次查询注入都不超过 2000 字符。

**判据**

1. 固定注入：`injectionBudget(report).fixed.chars <= 2000`。
2. 单次注入：`budget.perQuery.maxChars <= 2000`（含查询返回被注入 prompt 的那部分；若实现走工具调用、返回不进 prompt，则须在 `report.inject.mode = 'tool'` 显式声明，且 `fixed.chars <= 2000` 仍必须成立）。
3. `budget.charsMeasured === true`（字符是实测，不是折算）。

**数据**：`results/memjudge.json → inject / budget`；判定函数 `injectionBudget`（`score.mjs:414`）。

**参照**：`meow` 8385 字符、`memento` 30672 字符（配 32k 窗口＝吃掉 65%）、`retcon-form` 30548 字符。2000 字符 ≈ 1500 token（P2 折算），占 32k 窗口 4.6%。

**已知反例**：8 个插件注入为 0（`meow`/`retcon-form`/`save-token`/`bm25`/`灵枢`/`MisakaNet`/`OpenViking`/`sage-mem`）——注入 0 是优点，但它们的成本转移到了单次返回（最高 38419 字符），所以本项与能力 3/4 必须联合看（P8）。

**测**：`verifier`。

---

### 2.9 能力 9 — 会改自己（selfmod M3 = 1.0）

**目标**：被问「现在该用哪个版本」时，只给最新结论，且不把已撤销的旧结论当现结论。

**判据**

1. `scoreSelfMod(returned_M3, selfmod[2]).score === 1` 且 `.verdict === 'latest'`。
2. M1、M2 不得 `regressed`（`verdict === 'regressed'` 视为 fail）：自我修改不能靠忘掉历史来达成。
3. 交叉检查：`rebuilt_all` 中必须**同时**存在旧结论（`漏改`、`NB-2023-MEMO-07`）与更正（`SG-2303-17`、`撤销`、`链条断裂`），且旧条目已有 `supersededBy` 指向新条目（schema 层可查）。只留新值、删掉旧值的实现视为「篡改历史」，本项 fail。

**数据**：`quiz.selfmod`（3 条，`kw`）；`scoreSelfMod`（`score.mjs:197`，含 `STALE_CLAIM`/`SUPERSEDE_MARK`/`HISTORICAL_Q` 三组正则）。

**复现**：`results/memjudge.json → selfmod[2]`。

**已知反例**：`mneme` 把「二副漏改」当现结论（`regressed`）；`prime-memory` `DECAY_FLOOR=0.5` 让 30 天后的旧章节相对浮起。

**测**：`verifier`。

---

### 2.10 能力 10 — 冲突发现并改变（judgedConflict ≥ 3/4）

**目标**：被问「凹陷到底多深」时，插件自己指出前后不一致，并给出后文修正值。

**判据**

1. 对 4 条 `conflict` 题，同时满足 `judgedConflict === true` **且** `newSide === true` 的题数 `>= 3`。
2. `judgedConflict` 用 `score.mjs:142` 的 `JUDGED_CONFLICT` 正则（插件必须自述「前后矛盾 / 两处不一致 / 说法对不上」这类判断）。
3. 仅 `revisionMarkInText === true`（只把原文自带的「现予更正」带回来）**不计入**——那不是插件的判断，是语料自带的修订语。历史 24 份里 `conflictRevisionMarkOnly` 有 4 份，`judgedConflict` 96 次全 0。
4. 短路反证（必做）：只灌 ch15 + ch19（从未见过 ch5 的「九厘米」），重跑 C1/C2，要求 `judgedConflict === false`。若仍报「前后矛盾」，说明是正则碰巧命中或模型幻觉，判为假阳性，本项 fail。历史实验：`bm25`/`restregular`/`mnemon`/`meow` 在短路场景下照样拿 1.000（因为只问「修正值有没有进返回」），这正是本项要防的。

**数据**：`quiz.conflict`（4 条，`kw=["九厘米","十一厘米"]` 或 `["十一厘米","作废"]`）；`scoreConflict`（`score.mjs:155`，返回 `score/oldSide/newSide/judgedConflict/revisionMarkInText/verdict`）。

**复现**：`results/memjudge.json → conflict[]` + `node memjudge-plugin/test/shortcircuit.mjs`。

**已知反例**：`judgedConflict` 在 24 份 × 4 题 = 96 次中全 0；`retcon-form`/`mnemon` 只带回原文更正语。

**测**：`verifier` 跑判定；`auditor` 复核短路实验的两次输出。

---

### 2.11 能力 11 — 按天折算（衰减曲线单调下降，90 天 ≥ 0.15）

**目标**：假时钟 0/1/7/30/90 天下，留存分数单调下降且 90 天仍有 ≥0.15。

**判据**

1. 取 `results/decay-memjudge.json → measuredCurve`（5 个点，`simulated: false`；`simulatedCurve` 一律不得用于本项）。
2. 非增：`curve[i].retentionScore >= curve[i+1].retentionScore`，i = 0..3。
3. 首末严格下降：`curve[4].retentionScore < curve[0].retentionScore`。
4. 末值下限：`curve[4].retentionScore >= 0.15`。
5. 时钟参与度：`clockReads` 中查询期读数 `> 0`（`Date.now` 或 `new Date` 至少被调用一次）。全程 0 次读时钟＝时间根本不是信号，曲线是结构性的平线（历史 `baseline-bm25` 即 `timeBlind: true`），本项 fail。

**数据**：`mem-eval/harness/run-decay.mjs`（5 轮 × 92 题 × 每天 92 次查询）；`measuredCurve[].{day,retentionScore,retentionRate,full,half,miss,simulated}`；`clockReads.perDay[]`。

**复现**：`node mem-eval/harness/run-decay.mjs <abs>/memjudge-plugin/src/adapter.mjs --out <abs>/memjudge-plugin/results/decay-memjudge.json`

**已知反例**：`bm25` 五轮全 0.989（`verdict.kind = flat`，0 次读时钟）；`prime-memory` 方向反了（day30 起 0.457→0.543）。

**测**：`verifier`。

---

### 2.12 能力 12 — 不翻 30 天旧账（30 天未访问权重 ≤ 0.25 且不进 top-3）

**目标**：30 天没被访问过的低重要度记忆，权重必须掉到 0.25 以下，且不出现在 top-3。

**样本定义（防歧义，必须先锁死）**

`S = { m | (now - m.lastAccessed) >= 30 天 且 m.importance < 0.6 且 m.supersededBy === null }`

- 门槛用 `DECAY.warmImportance = 0.6`：重要度 ≥0.6 的是长期事实（日期、船名、报告编号），本就该一直可查，不属于「旧账」。
- `|S| >= 60`，否则样本不足，本项无效（记 `invalid`，等同 fail）。

**判据**

1. 权重上限：`∀ m ∈ S: rankWeight(m, now).weight <= 0.25`（`src/schema.mjs` 的 `rankWeight`）。冷档半衰期 12 天 → 30 天时 `decayFactor.value = 0.177`；再乘重要度因子 `0.5 + 0.5×importance`（样本 `importance < 0.6`，最坏 0.7995）后，`weight` 上界 **0.1413**（实测 `importance=0.599`）。判据用的是 `weight`，不是 `value`。
2. top-3 排除：取 20 道「新章探针题」（`quiz.recall` 中 `ch` 为 11–20 的各取 1 条，共 10 条 + `quiz.synthesis` 中 `ch` 跨 11–20 的 10 条），设假时钟到 day30、期间零访问，要求 20 次查询的 top-3 中 `S` 成员出现次数 `=== 0`。
3. 回溯不误伤：同一批查询里，`importance >= 0.6` 的条目仍可正常进入 top-3（否则等于把新旧一起掐死，能力 3 会崩）。要求 20 次查询中至少 14 次 top-3 含 warm 条目。

**数据**：`memjudge-plugin/results/acceptance-decline.json`（每条：`id/importance/ageDays/weight/rank/inTop3`）；权重函数 `src/schema.mjs → rankWeight`；探针题来源 `quiz.recall`、`quiz.synthesis`。

**复现**：`node memjudge-plugin/test/acceptance.mjs --only decline`。

**已知反例**：`prime-memory` 的 `DECAY_FLOOR = 0.5` 让 30 天后旧章节相对浮起（0.457→0.543）；`bm25` 完全不读时钟（新旧的排序与时间无关）。

**测**：`verifier`。

---

## 3. 记忆条目 schema

实现：`src/schema.mjs`（导出 `MEMORY_SCHEMA_VERSION`、`CHAPTER_COUNT`、`DECAY`、`TYPES`、`MemorySchemaError`、`makeId`、`createMemory`、`validateMemory`、`assertTextStable`、`decayFactor`、`rankWeight`）。

**S1 必填字段**

| 字段 | 类型 | 语义 | 约束 |
| --- | --- | --- | --- |
| `id` | string | 稳定主键 | 确定性生成 `mem-c{ch}-p{para}-{fnv8}`；`/^[A-Za-z0-9][A-Za-z0-9._:-]{2,120}$/` |
| `text` | string | **原文，永不改写** | 非空、≤20000 字符、无 NUL；创建时深冻结 |
| `createdAt` | epoch ms | 写入时刻 | 正数 |
| `lastAccessed` | epoch ms | 最后一次被命中/被返回的时刻 | `>= createdAt` |
| `accessCount` | int | 累计访问次数 | `>= 0` |
| `importance` | number | 重要度，决定 warm/cold 衰减档 | `0..1` |
| `supersedes` | string[] | 本条取代了哪些旧条目 | 不含自身、无重复 |
| `facts` | fact[] | 写入时抽取的三元组 | 见 S2 |
| `source` | object | 出处 | `{chapter: 1..20, para: >=1}` |

**S2 三元组 `facts[]`**

`{ entity: string, attribute: string, value: string|number, unit?: string, quote?: string, at?: epoch_ms }`

`quote` 若给出，**必须是 `text` 的逐字子串**（抽取层不得自造措辞）——这是幻觉防线的第一道闸，`validateMemory` 会抛错。

**S3 可选字段**

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `kind` | enum | `fact`（默认）/ `event` / `conclusion` / `procedure` |
| `supersededBy` | string\|null | 本条被哪条取代（由 supersede 流程回填）；填了即视为作废版本 |
| `meta` | object | 扩展位（标签、置信度等），不参与评分 |

**S4 取代流程（自我修改的唯一合法路径）**

1. 新条目写入，`supersedes: [旧 id]`。
2. 旧条目只回填 `supersededBy: 新 id`，`text` 一个字都不动（`assertTextStable(旧, 旧)` 必须通过）。
3. 检索时旧条目权重乘 0.3（`rankWeight.supersededPenalty`），但**不删**——它仍是「历史结论」，M1 类历史题要能查到。

删掉旧条目 = 篡改历史，能力 9 的交叉检查会抓住。

**S5 校验行为（验收命令）**

```
node -e "import('./src/schema.mjs').then(m=>{try{m.validateMemory({})}catch(e){console.log('OK throws:',e.message)}})"
# 必须打印：OK throws: memory schema: id — 缺失（必填字段）
```

抛错类型 `MemorySchemaError`，`message` 里必须带字段名。`opts.strict === true` 时未知顶层键也抛错。

---

## 4. 能力 11 与能力 12 的自洽性（先算清，再实现）

**问题**：单条指数曲线数学上无法同时满足「30 天 ≤0.25」与「90 天 ≥0.15」——
`f(90) = 0.25^3 = 0.0156 < 0.15`。任何单一半衰期的实现都会在其中一条上失败。

**解法**：两个量分开定义，档位由 `importance` 在写入时固化（`src/schema.mjs → DECAY`）。

| 量 | 定义 | 判给谁 |
| --- | --- | --- |
| `decayFactor` | `0.5^(age/HL)`，`HL = warm?120:12` 天；`rankWeight` 再乘重要度/访问/被取代因子 | 能力 12（冷档 30 天 `weight` 上界 **0.141** ≤ 0.25） |
| `retentionScore` | 假时钟第 d 天的实测平均得分（92 题） | 能力 11（曲线形状与末值） |

参数取 `hlWarm = 120`、`hlCold = 12`、`warmImportance = 0.6`，据此算出的参考值（`decayFactor.value`，与 `importance` 无关，只看档位）：

| age(天) | 冷档 value | 热档 value | 冷档 weight(imp .3) | 热档 weight(imp .9) |
| --- | --- | --- | --- | --- |
| 0 | 1.000 | 1.000 | 0.650 | 0.950 |
| 1 | 0.944 | 0.994 | 0.614 | 0.945 |
| 7 | 0.667 | 0.960 | 0.434 | 0.912 |
| 30 | **0.177** | 0.841 | **0.115**（最坏 0.141） | 0.799 |
| 90 | 0.006 | **0.595** | 0.004 | 0.565 |
| 109 | 0.002 | 0.533 | 0.001 | 0.506 |

**可达成性**：90 天留存率下限 0.15 需要至少 `ceil(0.15 × 92) = 14` 条记忆在 day90 仍可被答出。warm 条目（`importance ≥ 0.6`）在 day90 的 `decayFactor.value` 仍为 0.595，只要 warm 条目数 ≥ 15 且分布在 ≥6 个章节（防「只保 1 章」作弊），day90 留存率 ≥ 15/92 = 0.163 > 0.15 可达。**warm 条目数 ≥ 15、覆盖章节 ≥ 6，是实现侧必须报告的硬数据**，写进 `results/acceptance.json → capability11.warmCount / warmChapters`。

**两个量不要混用**：能力 12 判 `rankWeight().weight`（含重要度、访问惯量、被取代惩罚），能力 11 判 `retentionScore`（假时钟实测得分）。冷档 day30 的 `value = 0.177` **高于** `retainThreshold = 0.15`——所以那时它仍在库里、仍可能被强匹配命中，只是权重被压到 0.141 以下、排不进 top-3。这正是设计意图（降权，不是删除）。不要为了「低于阈值」去调 `hlCold`，那会破坏能力 11 的 90 天下限。

---

## 5. 产物契约

评测结束后，`memjudge-plugin/results/` 必须存在下列文件，缺一即验收中止：

| 文件 | 来源 | 关键字段 |
| --- | --- | --- |
| `memjudge.json` | `runOne(adapterPath, {workdir})` 原样落盘 | `summary.*`、`recall[]`、`synthesis[]`、`hallucination[]`、`fidelity[]`、`conflict[]`、`selfmod[]`、`budget.*`、`storage.*`、`dumpChars` |
| `decay-memjudge.json` | `runDecay(adapterPath)` 原样落盘 | `measuredCurve[]`、`clockReads`、`verdict` |
| `dump/ch01.txt … ch20.txt` | `adapter.dump()` 按章切分 | 供能力 1/5 重建比对 |
| `acceptance.json` | `test/acceptance.mjs` 产出 | 12 个 `{capability, pass, evidence, measured}` |
| `acceptance-decline.json` | 能力 12 专门产物 | 每条 `{id, importance, ageDays, weight, rank, inTop3}` |
| `raw/<QID>.txt` | 每次查询的完整返回 | 能力 2/5/6/9/10 的逐字复核底本 |

`acceptance.json` 形状（禁止加权总分）：

```json
{ "specVersion": "spec-1.0", "adapter": "dsh-memjudge",
  "capabilities": [
    { "id": 1, "name": "store-exact", "pass": true, "measured": { "chaptersMatched": 20, "chars": 29648, "fidelityExact": 8 }, "evidence": "results/dump/, results/memjudge.json#dumpChars", "signedBy": "verifier" }
  ] }
```

---

## 6. 判定规则

**R1** 12 项全 pass 才算「12 项能力达标」。部分 pass 不是达标，报告中按项列出，不得折算百分比。
**R2** 每项的证据必须是可回看的文件指针（`results/raw/` 的行、`memjudge.json` 的键路径），不接受「实测通过」这种无指针的口头结论。
**R3** 任一项 fail 时必须给出最接近通过的那个数值（如 `recall = 0.978，差 1 题`），不许只写 fail。
**R4** 与历史 24 份结果对比时，只用同口径（同一 `score.mjs`、同一题库、同一 `norm`），跨口径比较视为无效。
**R5** `author` 自测数据只能进「开发日志」，不得进 `acceptance.json`。

---

## 7. 本 SPEC 测不到的（照实写，不许拿别的指标冒充）

1. **LLM 在环的幻觉率**：机械 adapter 只能测「问到没有的东西时，塞给下游多少看起来像依据的材料」。模型读到材料后编不编，需要 LLM 在环，本轮不在范围内。能力 5/6 测的是**材料侧与拒答侧**，不是模型幻觉率。
2. **fidelity 无指纹**：`fidelityScore` 只判逐字包含，同义改写只要保留全部数字也能过。能力 2 的 8/8 不代表「没有被润色」，只代表「原句在返回里」。
3. **recall 的分辨力**：90/92 题只有 1 个 kw，本项退化为「目标章是否进返回」。检索精度需要多 kw 题目，现题库没有。
4. **synth 不是综合能力**：没有 LLM 在环，只测「跨章材料是否都进了返回」，不测推理。
5. **存储字节 vs 索引质量**：能力 7 只看字节数，不看倒排的召回率；省字节但检索变差会体现在能力 3。
6. **假时钟不模拟文件系统时间**：靠 mtime 判新旧的实现会在能力 11/12 上得到「假通过或假失败」，实现侧必须改用 `createdAt/lastAccessed` 字段（schema 已强制提供）。

---

## 8. 验收命令总表

```bash
# S5 schema 自检（必须打印 OK throws）
node -e "import('./src/schema.mjs').then(m=>{try{m.validateMemory({})}catch(e){console.log('OK throws:',e.message)}})"

# 全量套件（92+12+6+8+4+3）
node mem-eval/harness/run-one.mjs <abs>/memjudge-plugin/src/adapter.mjs \
  --out <abs>/memjudge-plugin/results/memjudge.json --dump-raw

# 假时钟衰减 0/1/7/30/90
node mem-eval/harness/run-decay.mjs <abs>/memjudge-plugin/src/adapter.mjs \
  --out <abs>/memjudge-plugin/results/decay-memjudge.json

# 12 项判定（内部读上面两份 + dump + decline 探针）
node memjudge-plugin/test/acceptance.mjs

# 能力 6 的历史口径 parity（24 个适配器重算必须仍为 0）
node memjudge-plugin/test/deny-parity.mjs

# 能力 10 的短路反证（只灌 ch15+ch19）
node memjudge-plugin/test/shortcircuit.mjs
```

`run-one.mjs` 的 `--out` 与 `workdir` 必须指向 `memjudge-plugin/` 内，避免在 `mem-eval/` 下产生任何写入（总则 0.3）。
