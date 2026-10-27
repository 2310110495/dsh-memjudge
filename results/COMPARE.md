# memjudge × mem-eval：12 项能力对照

真源：`memjudge-plugin/results/memjudge.json`（主结果，段级写入）、`memjudge-chapter.json`（章级对照）、`memjudge-clock3b.json`（能力 3b）、`decay-memjudge.json`（能力 11）、`diag-memjudge-topc4.json`（诊断，非成绩）。
适配器：`memjudge-plugin/adapters/memjudge.mjs`（实现）+ `mem-eval/adapters/memjudge.mjs`（一行转发）。
复现：`cd mem-eval && node harness/run-one.mjs memjudge`（125 题，err=0）。

## 0. 一句话

材料层（存得准、回原文、找得回、不编、拒答高于全场、注入预算内）站住了；判断层（跨章综合、冲突发现、自我修改、衰减）没站住。**6/12 pass**。

| # | 能力 | memjudge | 最强对照 | 判定 |
|---|---|---|---|---|
| 1 | 存得准（逐字往返） | dump 去空白 29648 字 == 原文 29648，`equal=true` | 无插件公开此项；memjudge 自证 | **pass** |
| 2 | 原样回原文 | fidelity 8/8 exact（1.000） | 12 个插件 8/8 | **pass** |
| 3 | 找得回（条级召回） | 3a 0.989（91/92，仅 R20 miss）；3b 0.870 | baseline-bm25 0.989 / meow 1.000 | **pass**（3b 压线 0.870） |
| 4 | 12 题综合 | 0.583（5/12 满分） | 灵枢 0.917 / meow 0.917 / retcon 1.000 | **fail** |
| 5 | 不编 | contaminate 0；6 探针词全库 0 次；halluScore 0.667（全场最高） | 其余插件 0.25–0.333（全是整章倾倒） | **pass** |
| 6 | 拒答（SPEC 口径） | deny 0/6；文本层明确否认 4/6 | 全部插件 0/6 | **fail** |
| 7 | 占多大地方 | 段级 212KB；章级 172KB | 灵枢 106.9KB / meow 3546.9KB | **fail**（段级）/ pass（章级） |
| 8 | 一次塞多少 | 默认注入 0 字符；打开后 1025 字符 / 572 tok | meow 8385 / memento 30672 | **pass** |
| 9 | 会改自己 | 0.500（M1 latest 1.0、M2 partial 0.5、M3 miss 0） | baseline-full 1.0 / retcon 1.0 | **fail** |
| 10 | 冲突发现并改变 | conflictScore 1.000、resolved 4/4、newSide 4/4，但 **judgedConflict 0/4** | 全部插件 judgedConflict 0/4 | **fail** |
| 11 | 按天折算 | 0/1/7/30/90 天全 0.870，flat；时钟读 2262 次 | 11 个实测插件全 flat；drscrewdriver 唯一 decaying（0.457→0.543，方向反） | **fail** |
| 12 | 不翻 30 天旧账 | 30 天未访问 rankWeight 0.1149 ≤ 0.25，排名 #2（末位） | 无插件公开此项 | **pass** |

## 1. 主结果（`memjudge.json`，125 题，err=0）

recall 0.989（91 full / 0 half / 1 miss，唯一 miss 是 R20「航速减到多少」——纯词法地板，baseline-bm25 同样 miss）；synth 0.583；hallu 0.667；fidelity 8/8；conflict 1.000；selfmod 0.500。

成本：写入 1635ms / 30318 字；查询 5206ms / 125 题 = **41.6ms/题**；平均返回 1527 字 / 926 tok；单场会话 116343 tok；存储 212KB（217088 B，1 个 sqlite 文件）；注入 1025 字符（默认关 = 0）。

## 2. 逐条说不达标的原因

**能力 4（synth 0.583）**：不是检索失败，是**装填预算**失败。`memjudge_recall` 把返回硬钳在 2000 字符（`INJECT_HARD_LIMIT`），而 S 题平均需要 3 章以上、每章数段的材料。诊断跑 `MEMJUDGE_TOPC=4` 得 0.625（`diag-memjudge-topc4.json`）——把选章数从 2 提到 4 只涨 0.042，说明瓶颈在预算不在选章。**这是架构上限，不是调参能解决的**：要 0.917 必须放开单次返回体量，而那会直接违反能力 8。

**能力 6（deny 0/6）**：按 SPEC 逐字口径（`score.mjs:20/26` 的 DENY + NEAR_WINDOW=80 + 返回 ≥40 字）判定为 0。逐一归因：H1 返回 `没有记载（attribute-not-recorded：材料里没有「IMO」这项标识）`——问了「IMO 编号」，返回只到「IMO」，`norm(absent)` 整串不出现 → `absentFound=false`，**这题是判据形状问题，不是行为问题**。H2/H5/H6 返回 39 字符，差 1 个字符被 SPEC 的 ≥40 硬门槛挡在 `empty`（这门槛正是为关闭「空返回假拒答」设的，memjudge 是**真拒答但太短**）。H3/H4 是 flood（610 / 1783 字），真没拒答。所以：**行为 4/6、判据 0/6、且 H3 在全文层面漏判**——三件事必须分开写，不得换算成「6/6」。

**能力 7（212KB）**：段级写入 294 条记忆，每条带 id / source / 时间戳，元数据开销把库顶到 212KB（超 12KB）。章级写入只有 20 条 → 172KB 达标，但章级写入把能力 3a 打到 0.935（fail）、能力 2 打到 7/8。**粒度是存储与召回的对冲**：244 字节/条的元数据是这笔账的源头。

**能力 9（selfmod 0.5）**：M1「早期结论」拿 1.0（返回 ch18 明确指出「推翻四月结论、改判为改正链条断裂」，带时间边界）；M2 partial 0.5（返回到「更正说明 NB-2023-CORR-01」但漏 `SG-2303-17` 邮件包）；M3 miss 0——问最新处理，返回整段 ch7 旧备忘原文，**没有任何「已撤销 / 已改判」的标记**。根因是检索层只按相关性排序，没有「同一事实的新旧版本互斥」这一层：旧段和新段同分竞争，旧段还因为措辞更硬而排前面。

**能力 10（judgedConflict 0/4）**：4 题全 `resolved` 且 `newSide` 4/4，但 `revisionMarkInText=true` 全部来自**语料自带的更正语**（ch15「现予更正」、ch19 脚注作废）。插件把带更正语的整段原文交出去，等于「把答案连解释一起端上来」，不是「自己发现前后矛盾」。`judgedConflict`（「前后矛盾 / 两处不一致」这类判断句）0/4——**这是全部 12 个插件共同的 0**，不是 memjudge 特有，但 SPEC 要求 ≥3/4，故 fail。

**能力 11（flat）**：五轮 retention 全 0.870。机理是数学的：衰减是**乘性**的，对所有候选等比缩放，**不改变单次查询内部排序**，所以「写完从未访问」场景下曲线必然平。时钟读了 2262 次（写入 294 次 `Date.now`，每轮查询 276 次），说明时间戳是真在算、真进分数（`decayWeight` 生效），**只是不改变留存**。`verdict.timeBlind=false` 是对的：不是不看时钟，是看了没用。

## 3. 与对照的成本对比

| 项 | memjudge | baseline-full | retcon | meow | 灵枢 |
|---|---|---|---|---|---|
| 平均返回 tok | 926 | 20921 | 20869 | 5573 | 5251 |
| 注入 tok | 0（开 572） | 20921 | 0 | 0（另计 8385 字符） | 0 |
| 存储 KB | 212 | 0 | 459.2 | 3546.9 | 106.9 |
| 查询 ms/题 | 41.6 | — | — | — | — |

memjudge 用 1/22 的返回体量拿到 0.989 recall，代价是 synth 0.583；retcon / baseline-full 用「把 20 章全倒出来」换到 synth 1.0。**这是同一根绳的两头：综合分高是因为把材料全给了，不是因为查得准。**

## 4. 诚实边界

- `simulated:false` 全程真跑；`decay-memjudge.json` 的 measuredCurve 是真假时钟实测，未用模型折算替代。
- 能力 12 的 0.1149 来自内核级双条对照（同文记忆，唯一差别是 `lastAccessed` 差 30 天），**不是 125 题产物**，已在文中标注。
- 段级为主成绩、章级为对照，两套数字都留在 `results/`，没有只报好看的那套。
- 诊断跑（`MEMJUDGE_TOPC=4`）只用于归因，不作为成绩。
