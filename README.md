# dsh-memjudge

DSH 记忆插件：SQLite 逐字存储 + CJK 二元组 BM25 段级检索 + 三元组拒答门 + 冲突消解 + 按天衰减 + 2000 字符注入预算。

不是「更强的记忆插件」，是一次**能不能把记忆做成可验收件**的实验：12 项能力各有可执行判据与阈值，达标几项就说几项，不达标的写清为什么不达标。

## 来源

本插件是对 24 个 DSH 记忆插件（含 2 个基线）做完整实测后的产物。实测工程在 `mem-eval/`（3 万字长篇语料、92 题召回、12 题综合、6 题幻觉、8 题保真、4 题冲突、3 题自我修改、假时钟衰减），实测报告在 `mem-eval/REPORT.md`。

实测结论：**没有任何插件在检索上打得过 BM25 基线，且全部插件的幻觉拒答、冲突发现、衰减生效三项结构性为零。** memjudge 是在这个基线上，把「判断」做成独立层的尝试——该不该说、说哪个、忘哪个，与存储和检索分开。

22 个有分插件的召回与返回体量对比（数据来自 `mem-eval/results/*.json`）：

| 插件 | recall | 返回字符/题 | 注入字符 |
|---|---|---|---|
| baseline-bm25 | 0.989 | 4610 | 0 |
| baseline-full-context | 1.000 | 30661 | 30661 |
| meow-memory | 1.000 | 8385 | 0 |
| 灵枢 (FuRongJun) | 0.989 | 7769 | 0 |
| retcon-form | 1.000 | 30548 | 0 |
| soul-md | 0.989 | 5347 | 243 |
| **memjudge** | **0.989** | **1548** | **0（默认）** |

同为 0.989 召回，memjudge 的返回体量是 bm25 的 1/3、灵枢的 1/5、meow 的 1/5.4。

## 12 项能力（实测，非宣称）

真源 `results/memjudge.json`（125 题，err=0）、`results/decay-memjudge.json`（假时钟 5 轮）。对照值取自 `mem-eval/results/*.json` 的 24 份实测结果。判据真源 `docs/SPEC.md`。

| # | 能力 | 阈值 | memjudge | 最强对照 | 判定 |
|---|---|---|---|---|---|
| 1 | 存得准（逐字往返） | 20/20 章 + 29648 字 | 归档产物只记 30356 字、无 `equal` 字段，dump 文件已删 | 无插件公开此项 | **无证据** |
| 2 | 原样回原文 | 8/8 exact | 8/8（1.000） | bm25 / meow / 灵枢 / retcon / RestRegular / MisakaNet / AskTheWay / tiddlywiki / soul-md / mnemon 均 8/8 | **pass** |
| 3 | 找得回（条级召回） | ≥0.989 且 ≤1 miss | 3a 0.989（91/92，仅 R20 miss）· 3b 0.870 | meow 1.000 / retcon 1.000 / bm25 0.989 | **pass**（3b 压线） |
| 4 | 12 题综合 | ≥0.917 | 0.583（5/12 满分） | retcon 1.000 / 灵枢 0.917 / meow 0.917 | **fail** |
| 5 | 不编 | contaminate=0 | contaminate 0、6 探针全库 0 次、halluScore 0.667 | 其余插件 0.25–0.333（memento 0.500、Aik358 0.625 来自空返回） | **pass** |
| 6 | 问没有的说没有 | deny ≥5/6 | SPEC 口径 0/6；工具自身 `denied=true` **4/6** | 24 个插件 halluDeny 结构性恒 0（该维度从未被测） | **fail** |
| 7 | 存储 ≤200KB | ≤200KB | 段级 212KB（超 12KB）· 章级 172KB | 灵枢 106.9 / soul-md 88.6 / MisakaNet 88.4 | **fail**（段级） |
| 8 | 单次注入 ≤2000 字符 | 固定 ≤2000 且单次 ≤2000 | 固定注入默认 0、开启 1025 字符；单次返回峰值 **2252** | meow 8385 / memento 30672 / retcon 30548 | **part** |
| 9 | 会改自己 | M3 = 1.0 且不 regressed | 0.500（M1 1.0 / M2 0.5 / M3 0） | retcon 1.0 / baseline-full 1.0 / MisakaNet 1.0 | **fail** |
| 10 | 冲突发现并改变 | judgedConflict ≥3/4 | 0/4（`conflicts` 工具 current 取到**九厘米**，不是十一厘米） | 全部插件 judgedConflict 0/4 | **fail** |
| 11 | 按天折算 | 5 点非增、末值 ≥0.15 | 五轮全 0.870 平线（时钟读 2262 次，衰减是乘性的不改排序） | 11 个实测插件全 flat；prime 反向升 0.457→0.543 | **fail** |
| 12 | 不翻 30 天旧账 | ≤0.25 且不进 top-3 | rankWeight 0.1149 ≤ 0.25，候选内排末位 | 无插件公开此项 | **pass**（3 条判据只覆盖了 2 条） |

四项 pass（2/3/5/12）、一项 part（8）、七项不成立（1 无证据、4、6、7、9、10、11）。12 项逐条归因见 `docs/FINAL.md`。

### 能力 8 为什么不是 clean pass

固定注入 1025 ≤ 2000 成立；但 `budget.perQuery.maxChars = 2252`，单次返回峰值超 2000——超出部分来自 render 的 `[id chN]` 标签与「命中 N 段」抬头，这些没算进预算。SPEC 2.8 判据 2 留了个口子（走工具调用且返回不进 prompt 时可声明 `inject.mode='tool'`），本实现没声明该字段。两种读法都写在这里，不替自己选。

## 架构

```
src/
  schema.mjs   记忆条目 schema + DECAY 参数（半衰期 120/12 天，留存阈值 0.15）
  store.mjs    SQLite 存储：put/get/list/updateAccess/dump/bytes + extractFacts 三元组
  search.mjs   CJK 二元组 BM25 + 倒排索引 + 章级聚合（章分=top3段分和，取 top2 章）
  judge.mjs    判断层：gate（拒答门）/ resolveConflict / decayWeight / fitBudget / render
  index.mjs    apply(ctx)：注册 5 个 memjudge_* 工具 + 注入 section（默认关闭）
```

关键设计决策：
- **判断依据是写入时抽出的三元组**，不是查询时拿问句去正文里找字。后者在长材料上必然失效——整章 1453 字里任意二元组都出现，判据恒真。
- **拒答门分软硬**：实体不存在/限定语不存在/拉丁标识不存在硬拒；`no-facts` 与「二字组覆盖不足」放行（否则「今天心情不好」这种纯文本记忆永远查不到）。
- **冲突消解看修正措辞**：「原报 X 系估值/现予更正」——X 是旧值，句子里的另一个值才是新值。不能按时间排序取最后一条。
- **衰减挂 lastAccessed**：被用即刷新，没用才放手。地板 0.15 保证不死透。

## 安装

```bash
# A 路：dsh 在 PATH
dsh plugin --profile web add /path/to/memjudge-plugin

# B 路：dsh 不在 PATH
cd /path/to/memjudge-plugin && pnpm install
```

验证：

```bash
node scripts/verify-install.mjs          # 真装、真写、真查
node scripts/verify-install.mjs --mock   # 不依赖 dsh CLI 的模拟验证
```

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `memjudge_remember` | `{text, importance?, source?}` | `{id, facts: n}` |
| `memjudge_recall` | `{query, topCh?, budget?}` | `{text, denied?, reason?}` |
| `memjudge_forget` | `{id}` | `{ok}` |
| `memjudge_conflicts` | `{}` | `{conflicts[], current{}, superseded[]}` |
| `memjudge_stats` | `{}` | `{memories, facts, bytes, chapters}` |

工具名全部 `memjudge_` 前缀，与 `memory_*` 系插件零冲突（宿主实测：`memory_read`/`memory_search` 被 annkun灵枢/soul-md/meow 三方争抢，`memjudge_*` 无人占用）。

## 测试

```bash
node test/store.test.mjs    # 34 断言：SQLite 读写、三元组抽取、dump 逐字相等
node test/search.test.mjs   # 14 断言：recall 0.989、衰减下限曲线、倒排 17.5%
node test/judge.test.mjs    # 11 断言：拒答 5/6、冲突 4/4、衰减 0.150 地板、预算 1945
node test/plugin.test.mjs   # 15 断言：5 工具注册、注入 section、dispose 幂等、cordis 冒烟
```

## 已知边界

- **H3「台风海燕中心气压」在全文上漏判**：真实实体配编造属性，在 3 万字全文上仍能蒙混，只在候选裁到 2000 字后被拦。预算裁剪本身是一层幻觉防线。
- **2000 字符返回钳是综合题的天花板**：跨 3 章的材料装不下，放开选章无用只能放开返回体量，而那会违反注入预算。检索精度与注入预算是结构性对冲。
- **冲突消解在「同一条记忆新旧共存」时会判反**：已修（REV_OLD 双正则降权），但 harness 的 `judgedConflict` 判据仍要求「自发发现矛盾」措辞，0/4 不是实现问题。
- **衰减是乘性的不改排序**：时钟读了 2262 次但五轮全平。`retainThreshold` 已接入 `fitBudget`（低于阈值直接进 dropped），但对单查询排序无影响。

## 文件说明

| 文件 | 说明 |
|---|---|
| `src/` | 插件本体（5 个模块，3889 行） |
| `test/` | 74 断言全绿 |
| `docs/SPEC.md` | 12 项能力验收标准（v1.1，463 行） |
| `docs/AUDIT.md` | 独立审查报告（14 条 findings，3 条已修） |
| `docs/FINAL.md` | 最终报告（12 项状态 + 26 行对比 + 已知局限） |
| `results/` | 125 题实测数据 + COMPARE.md |
| `scripts/verify-install.mjs` | 安装验证（6 幻觉 + 4 冲突双表） |
| `cordis.patch.yml` | DSH bundle patch（真装用） |

## License

MIT
