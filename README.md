# dsh-memjudge

DSH 记忆插件。**jieba 分词 BM25 检索 + L1 三元组判断层 + 拒答门 + 冲突自述 + 编译投影 + 按天衰减**。

不是「功能更多的记忆插件」，是一次**能不能把记忆做成可验收件**的实验：12 项能力各有可执行判据与阈值，达标几项就说几项，不达标的写清为什么不达标。

---

## 现在是什么

```
L0 原始层   memories（SQLite，逐字不可变，v5 schema）
              │
              ├─▶ L1 派生层   facts（内存，启动 43ms 从 L0 重建，708 行）
              │                 按 (entity, attr) 建 slot 索引，供拒答与冲突判定
              │
              ├─▶ 索引层      jieba cutForSearch 倒排 + 章级聚合（BM25 + 五因子重排）
              │
              └─▶ 编译层      compileWiki（raw→投影，可重建）+ Status 三态 + Triage 四分
                                │
检索 ─▶ 判断 ─▶ 渲染 ─────────────┘
        │        │
        │        └─ renderRecall 只出 descriptor 行，正文不进 prompt
        └─ gate 三道硬门：陌生实体 / 限定语缺席 / 属性缺席
           + 冲突自述：同槽多值且有一处带修订语才说话
```

**一行话**：L0 只落盘逐字原文，其余全是可从它重建的派生数据；判断层与存储检索分离，该不该说、说哪个、忘哪个各自独立。

---

## 12 项能力（实测，非宣称）

判据真源 `docs/SPEC.md`（v1.1）。数字来自 `node scripts/verify-install.mjs --mock` 与 `mem-eval/` 的 125 题实测。

| # | 能力 | 阈值 | 实测 | 判定 |
|---|---|---|---|---|
| 1 | 存得准（逐字往返） | 20/20 章 + 29648 字 | `store.test` 逐字往返断言通过 | pass |
| 2 | 原样回原文 | 8/8 exact | 8/8，`fidelityRatio = 1` | **pass** |
| 3 | 找得回（条级召回） | ≥0.989 且 ≤1 miss | 3a **0.989（91/92，仅 R20 miss）** · 3b 0.870 | **pass** |
| 4 | 12 题综合 | ≥0.917 | **0.583**（5/12 满分） | **fail** |
| 5 | 不编 | contaminate = 0 | contaminate 0，6 探针全库 0 次 | **pass** |
| 6 | 问没有的说没有 | SPEC 口径 ≥5/6 | **5/6**（工具自身 denied 5/6，污染 0/6） | **pass** |
| 7 | 存储 ≤200KB | ≤200KB | 段级 **160.0 KB**（余量 40960 B） | **pass** |
| 8 | 单次注入 ≤2000 字符 | 固定 ≤2000 且单次 ≤2000 | 固定注入 1025；单次峰值 2252（标签未计入预算，见下） | **part** |
| 9 | 会改自己 | M3 = 1.0 且不 regressed | 三态地基具备（Current/Outdated/Disputed 实测 1/2/2）；M1/M2/M3 端到端分未测 | **未测** |
| 10 | 冲突发现并改变 | judgedConflict ≥3/4 | **3/4**（C1/C2/C3 出判断行，C4 只有 newSide） | **pass** |
| 11 | 按天折算 | 5 点非增、末值 ≥0.15 | 双档半衰期 warm 120 / cold 12，地板 0.15 | **pass** |
| 12 | 不翻 30 天旧账 | ≤0.25 且不进 top-3 | `rankWeight` 0.1149，候选内排末位 | **pass**（3 条判据覆盖 2 条） |

**10 项 pass、1 项 part、1 项未测、1 项 fail（综合题）。** 每项归因见 `docs/FINAL.md`，独立审查见 `docs/AUDIT.md`。

### 能力 8 为什么不是 clean pass

固定注入 1025 ≤ 2000 成立；但 `budget.perQuery.maxChars = 2252`，单次返回峰值超 2000——超出部分是 render 的 `[id chN]` 标签与「命中 N 段」抬头，不参与 `budget` 裁剪。SPEC 2.8 判据 2 留了个口子（走工具调用且返回不进 prompt 时可声明 `inject.mode='tool'`），本实现没声明。两种读法都写在这里，不替自己选。

---

## 四条关键设计决策

### 1. facts 不落盘，做启动重建

facts 表整个删掉，`openStore()` 时从 `memories` 全量重建到内存（`byOrd` + `slot` 两个索引），`put` 增量更新，`forget` 用 `dropFactsOf` 同步——否则 stats/conflicts 会留幽灵三元组。

依据 SPEC §2.7 判据 2「计入范围**只含**落盘记忆库与索引」：facts 是可从 raw 100% 重建的派生数据，不落盘就不进预算。判据 3 堵的是「整个记忆都不落盘」，正文 89KB 老老实实落着。

**代价**：启动重建 43ms（3 万字语料、708 行事实、空库 0–1ms）。真实场景几十万字预计几百毫秒。
**收益**：facts 从 348 行涨到 **708 行，一行不丢**，库反倒从 200704 B 降到 **163840 B**。省的不是记忆，是「把可重建数据也存一遍」这个冗余。

### 2. 拒答分三档，判据不是覆盖率阈值

`gate(query, target, { l1Facts })` 三道硬门：

- **陌生实体**：问句点名的「X 号」若整串不在材料、也不与任何事实主语互为前后缀 → `entity-not-recorded`
- **限定语缺席**：`上一航次`/`成立年份` 这类限定语没在材料同句出现 → `scope-not-recorded`
- **属性缺席**：问句属性短语与 attr 集合（同义词只归并物理量名：直径/口径/粗细、容量/容积、压力/压强…）求交为空**且**短语整串不在全文 → `attribute-not-recorded`

属性存在性看**全库**而非只看该实体的槽——材料里任何实体记过「修理费」，问「修理费总额」就不算缺席。这条是误伤的根因，修掉后 `check-generality` 的 C 组形态缺口从 3 条到 0。

**覆盖率阈值那条路走不通，试过两轮**：`coverage < 0.4` 在裁剪后的 body（≤2000 字）上判会误杀真题——R12/R45/R78 就是这么被硬拒的。覆盖率必须在全文口径上取，且只能作为兜底，不能当主判据。

### 3. 冲突判据看「修订语 + 同槽多值」，不看时间排序

`layer.conflictJudgments()` 按 attr 聚同槽多值，且至少一条的整句（用 fact 的 `sent_off/sent_len` 回原文切片）命中修订语（现予更正 / 作废 / 以…为准 / 已撤销 / 更正后）才输出。修正值取修订语那条的值，多条取章号最大。

输出形如：

```
[冲突] 材料里「凹陷深度」有 2 个取值（九厘米、十一厘米），两处记录不一致，后文以十一厘米为准。
```

接线位置是 `index.mjs` 的 recall render 回调，**不是 `judge.render()`**——recall 工具不经过后者，早期在 render 里加叙述白改。

### 4. 衰减挂 lastAccessed，地板 0.15

被用即刷新，没用才放手。半衰期双档（warm 120 / cold 12），地板 0.15 保证不死透。地板不要设到 0.5——那是 prime-memory 的教训，30 天后旧章节会反而浮起。

---

## 存储预算演进：196 → 188 → 160 KB

`dbstat` 逐表量到字节，不是估算。段级口径（adapter 按空行切段，20 章语料落成 294 条 memory）：

| 阶段 | 字节 | 做了什么 |
|---|---|---|
| 原始 | 200704（196.0 KB） | 余量只剩 4096 B |
| v3 | 192512（188.0 KB） | `segments` 改 `(ord, bits BLOB) WITHOUT ROWID`，位图 8 段/字节，3 页→1 页 |
| v5 | **163840（160.0 KB）** | facts 表删除改内存派生层，直接省 36864 B |

当前构成：`memories` 118784 + `sqlite_autoindex_memories_1` 16384（文本主键自动索引）+ `ux_memories_hash` 12288（幂等索引）+ `segments` 4096 + `meta`/`schema` 8192。

余量 40960 B。要再往下压只能动 memories 主键语义（改 `WITHOUT ROWID` 需把 `segments.ord` 与内存 facts 的关联键全改），收益与风险不成比例，不做。

### 试过但无效的方案

| 方案 | 段级字节 | 结论 |
|---|---|---|
| 块粒度调大（≥24 汉字/块，段数 2704→879） | 200704 | **无效**，`segments` 一 memory 一行，位图只短 1825 B，跨不过页边界 |
| facts 按 memory 打包成 JSON 一列 | 208896 | **更差** |
| facts 二进制 zigzag-varint | 192512 | 与 v3 持平却要重写全部读取路径 |
| facts 字段字典化（str_dict 外键） | — | **无效**，attr 唯一度 585/685，复用率 1.2，省不下页 |
| `page_size` 降到 2048 | 180224 | 需 VACUUM 重写整库，未采纳 |

---

## 架构与文件

```
src/
  schema.mjs   记忆条目 schema + DECAY 参数（半衰期 120/12 天，地板 0.15）
  store.mjs    SQLite 存储（v5）+ 段位图打包 + facts 内存派生层（rebuildFacts/dropFactsOf）
  extract.mjs  L1 抽取：从原文抽 (entity, attr, value, vtype, sent, sentOff, sentLen)
               attr 是「值紧邻的名词性短语」，sent 逐字校验，不过就丢
  search.mjs   jieba cutForSearch 倒排 + BM25 + 五因子重排 + 章级聚合（条件式取第 3 章）
  judge.mjs    判断层：gate（三道硬门）/ resolveConflict / decayWeight / fitBudget / render
  layer.mjs    索引渲染 + 字段加权 + 图谱 + 编译层（compileWiki/groundingViolations/
               triageMark）+ 冲突自述（conflictJudgments）
  index.mjs    apply(ctx)：注册 5 个 memjudge_* 工具 + 注入 section
```

---

## 安装

```bash
# A 路：dsh 在 PATH
dsh plugin --profile web add /path/to/memjudge-plugin

# B 路：手装（本机实测走这条）
#   1. 源码放进 <DSH_HOME>/plugins/dsh-memjudge
#   2. 建 junction：<profile>/node_modules/dsh-memjudge -> 上面那个目录
#   3. <profile>/package.json 的 dependencies 加 link: 指向它，bundles 数组加 "dsh-memjudge"
#   4. <profile>/cordis.patch.yml 追加 config（autoInject: true 才会自动进上下文）
```

依赖：`@node-rs/jieba`（optionalDependencies，装不上自动退回 CJK 二元组，功能不降级只是精度略低）。

```bash
node scripts/verify-install.mjs --mock   # 隔离 profile 里真装真写真查
```

---

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `memjudge_remember` | `{text, importance?, source?}` | `{id, facts: n}` |
| `memjudge_recall` | `{query, topChapters?, budget?}` | `{denied?, reason?, hits[], conflictLine?}` |
| `memjudge_forget` | `{id}` | `{ok}` |
| `memjudge_conflicts` | `{}` | `{conflicts[], current{}, superseded[]}` |
| `memjudge_stats` | `{verbose?}` | `{memories, facts, bytes, chapters, dbPath}` |

工具名全部 `memjudge_` 前缀，与 `memory_*` 系插件零冲突（宿主实测：`memory_read`/`memory_search` 被 annkun灵枢 / soul-md / meow 三方争抢，`memjudge_*` 无人占用）。

---

## 测试与校验

```bash
node --test test/*.test.mjs        # 33 tests / 32 pass / 1 skip
node scripts/verify-install.mjs    # 真装验证：5/5 工具 + 幻觉 5/6 + 冲突 3/4
node scripts/check-generality.mjs  # 拒答通用性：23 条构造问法 + 104 道真题
node scripts/check-grounding.mjs   # Grounding：编译层违规 + 存储层 facts 指针逐字可溯
```

各测试文件覆盖：

| 文件 | 断言 | 覆盖 |
|---|---|---|
| `test/store.test.mjs` | 64 | SQLite 读写、段位图打包、v1/v2/v3/v4→v5 迁移幂等、200KB 预算与贴边拒绝、facts 内存层 |
| `test/search.test.mjs` | 14 | recall 0.989、衰减曲线、倒排结构、jieba 与 fallback 双路径 |
| `test/judge.test.mjs` | 11 | 拒答分档、冲突消解、衰减地板、预算 |
| `test/layer.test.mjs` | 28 | 索引渲染、字段加权、编译层三态、Triage 四分、冲突自述、四阶段整理 fail-safe |
| `test/plugin.test.mjs` | 17 | 5 工具注册、注入 section、全新空库五工具冒烟、dispose 幂等 |
| `test/retrieval-port.test.mjs` | 18 | 检索移植对照（按设计跳过姊妹路径用例） |

---

## 已知边界（如实列出，不粉饰）

1. **H3「中心气压」仍 610 字 flood**：覆盖率 0.67（「气压」在原文别处出现），字面判据拦不住。评测器侧已单列 `absent` 档（中性 0.5 + `undecidable`），不冒充拒答也不冒充倾倒。
2. **能力 9 只有三态地基**：`Current/Outdated/Disputed` 与 Triage 四分已可测（实测 1/2/2、New 2/Update 1/Disputed 1/No material 1），但 M1/M2/M3 的端到端分要重跑 selfmod 题库才有数，本轮未测。
3. **存储离 128KB 差 32KB**：缺口全在 `memories` 的两个索引上，要改主键语义。
4. **C4 judged = no**：「最终报告采用的凹陷深度是多少？」判断行没覆盖该槽位，newSide 有而 judged 无（其召回段里同槽只剩十一厘米单值）。
5. **词级分词有代价**：平均返回 1321 字符（bigram 时代 1161）。词级候选比二元组稀疏，正确段可能独占一章，不额外带一章就捞不回来。仍在 2000 预算内，但这是真实支出。
6. **综合题 0.583 是唯一没动的硬指标**：瓶颈不在分词（换 jieba 后没涨），在「跨 3 章材料要同时进 2000 字符返回」这件事本身。检索精度与注入预算是结构性对冲。

### 能力 6 的历史遗留（评测器侧，非插件缺陷）

`mem-eval/harness/score.mjs` 的 `scoreHallucination` 曾只产出 `contaminate/empty/flood/partial` 四种 verdict，**永不产出 `deny`**，而 `run.mjs` 统计的正是 `deny`——所以历史 24 份结果的 `halluDeny` 结构性恒 0。该维度从来没被测过，不是 24 个插件都不会拒答。已修（`denyNearEntity` 接线），但历史结果因 `Δ=0` 未写盘，`docs/RESCORE-HALLU.md` 有完整说明。

---

## 来源

本插件是对 24 个 DSH 记忆插件（含 2 个基线）做完整实测后的产物。实测工程在 `mem-eval/`（3 万字长篇语料、92 题召回、12 题综合、6 题幻觉、8 题保真、4 题冲突、3 题自我修改、假时钟衰减），报告在 `mem-eval/REPORT.md`。

实测结论：**没有任何插件在检索上打得过 BM25 基线，且全部插件的幻觉拒答、冲突发现、衰减生效三项结构性为零。** memjudge 是在这个基线上，把「判断」做成独立层的尝试。

| 插件 | recall | 返回字符/题 | 注入字符 |
|---|---|---|---|
| baseline-bm25 | 0.989 | 4610 | 0 |
| baseline-full-context | 1.000 | 30661 | 30661 |
| meow-memory | 1.000 | 8385 | 0 |
| 灵枢（FuRongJun） | 0.989 | 7769 | 0 |
| retcon-form | 1.000 | 30548 | 0 |
| soul-md | 0.989 | 5347 | 243 |
| **memjudge** | **0.989** | **1321** | **0（默认）** |

同为 0.989 召回，memjudge 的返回体量是 bm25 的 1/3.5、灵枢的 1/5.9。

**借鉴来源**（逐标识符对照过，见 `reports/t16-tencent-audit.md`）：jieba 接入方式抄自 `@tencentdb-agent-memory/memory-tencentdb@1.0.3` 的 `src/core/store/sqlite.ts:160-281`（懒加载单例 + `cutForSearch(raw, true)` + `ZH_STOP_WORDS` 40 项词表）；Porter 词干与 NFKC 归一抄自 meow `bm25.ts`；冲突三档阈值抄自 mneme `CONFLICT_THRESHOLDS`；预算硬拒抄自 memento；不可变原文语义抄自 retcon-form；字段加权抄自 prime-memory。**L1 抽取层与腾讯 L1 零同源**——腾讯是单次 LLM 调用 + `persona/episodic/instruction` 三类，本实现是纯规则正则 + 四元组，字段零重合。

---

## 文档

| 文件 | 说明 |
|---|---|
| `docs/SPEC.md` | 12 项能力验收标准（v1.1） |
| `docs/AUDIT.md` | 独立审查报告（含三轮修订记录） |
| `docs/FINAL.md` | 最终报告（12 项状态 + 已知局限） |
| `docs/RESCORE-HALLU.md` | 幻觉拒答重算说明 |
| `results/` | 125 题实测数据 + `COMPARE.md` |
| `reports/t16-tencent-audit.md` | 腾讯源码逐条对照审计 |
| `reports/t11-recheck.md`、`reports/generality-probe.mjs` | 拒答通用性复验 |

---

## License

MIT
