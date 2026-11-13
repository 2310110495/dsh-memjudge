# 工作台 × MemJudge × Tencent 记忆审计（2026-11-13）

## 0. 结论与证据边界

**当前是本地 SQLite 多空间记忆引擎，借鉴了 Tencent 的部分分词机制；不是已接入 Tencent 云服务，也不是工作台文件记忆已自动双向融合。存量库大小不等于每轮注入量。**

本次仅静态核对本仓源码、工作台文档/公开工具源码和公开 GitHub 内容；只写本报告，不改源码、真实安装、数据库、配置、外部工作台，不导出记忆原文。工作台根目录是资料/源码参考仓，不是可初始化的现用场景。本报告不把参考仓机制当成已安装运行状态。

可信度分级：**高/源码** = 实际代码可定位；**高/测试** = 本次执行通过的隔离测试；**中/文档** = README/任务给定事实或上游公开说明，未独立验证部署；**未证实** = 缺运行证据或未完成历史溯源。

本次基线及运行数字来自[任务书](<tasks/memory-observability-20261113.md#L6-L13>)：已保存推送 5571b80 与 rollback/windows-fsync-pre-observability-20261113；安装版 0.1.1；schema8，123 memories / 212 facts，textChars 58107，reported bytes 565328，limitBytes 10485760；123 条旧记忆均 global；workspace:9c433ec24e9f 为 0；wiki77；向量、rerank、扩词 OFF。这些是**任务给定快照，不是本次重新读取真实 DB 得到的实时值**。检出的[包清单](<../package.json#L1-L6>)仍写 0.1.0，不能拿源码版本号替代安装版本。

## 1. 库存储、检索、每轮注入必须分开理解

| 指标/阶段 | 实际语义 | 证据与可信度 |
|---|---|---|
| memory 原文 | 持久化 text；注入时形成的短摘要不应覆盖它 | [核心表结构](<../src/store.mjs#L417-L437>)，高/源码 |
| textChars / textBytes | 存储统计独立报告文本字符数与 UTF-8 文本字节数；不同于整库空间 | [统计返回](<../src/store.mjs#L3291-L3315>)，高/源码 |
| bytes()，文件库 | **数据库文件 + -wal + -journal 的文件长度之和，不含 -shm**；不是仅原文字节，不是每轮发送量 | [计数实现](<../src/store.mjs#L3234-L3246>)，高/源码 |
| bytes()，内存库 | PRAGMA page_size × page_count 的页容量 | [计数实现](<../src/store.mjs#L3234-L3239>)，高/源码 |
| Tier-S | 会话静态热底座：rule/profile/启动时 state；上限 600 字符 | [注入契约与常量](<../src/inject.mjs#L1-L37>)，高/源码 |
| Tier-D | 面向本步问题的按需召回，上限 900 字符；工具子步、寒暄、无关/低置信问题可为 0 | [注入契约](<../src/inject.mjs#L11-L15>)，高/源码 |
| 总注入 | S + D ≤ 1500 字符；字符不等于 UTF-8 字节，也不等于模型 tokens | [硬上限](<../src/inject.mjs#L35-L43>)，高/源码 |

若观测契约使用 logicalBytes 字段复用既有 bytes() 值，必须在 semantics 明示上述文件占用口径；不能因为字段名叫 logical 就改称纯逻辑文本量。文件模式这本身就是对 DB/WAL/journal 文件大小的测量，不应再笼统写“物理文件未测”。

565328 bytes ≈ 552.1 KiB 是既有 bytes() 口径的快照；它**不是“每轮灌进 552 KiB”**。58107 textChars 也不是每轮字符数。任务所述 injectChars=600 只代表已有静态测量，不足以证明最近一步 S+D 的实际注入量。未捕获当步生成文本时，面板应显示“配置上限/尚无观测”，不能伪造实际值。真实挂载是 [systemPrompt.section 的 S 与 systemPrompt.context 的 D](<../src/index.mjs#L2837-L2854>)，无 context API 时另走 [agent/pre-step 兼容路径](<../src/index.mjs#L2855-L2884>)；观测必须覆盖实际走到的生成路径，而不是仅在 stats 调用时重算一份。

**不执行 200KB 缩库，不提高注入到 200KB。** 用户的 200KB 偏好以“是否全库每轮注入”为条件；该前提不成立。另有一个应明示但本次不修改的独立风险：生命周期函数仍有默认软上限 200×1024、硬上限 256×1024，见[容量代谢参数](<../src/lifecycle.mjs#L298-L312>)；宿主默认 metabolismIntervalMs=0，只有启用定时器才周期执行，见[调度接线](<../src/index.mjs#L724-L728>)。不能仅据代码默认阈值断言现装已开启或已清理；后续若启用必须审视它与 10MiB 库限额的独立语义。

默认数据库位置由 DSH_HOME 或用户目录下 .dsh 决定，再拼 memjudge/memjudge.db，见[路径函数](<../src/index.mjs#L126-L128>)；本次没有读取实际环境配置来推断真实落盘位置，也没有打开真实 DB。

## 2. 多空间：有数据隔离机制，但旧 global 不会自动变项目私有

1. **空间标识**由规范化 cwd 的 SHA-256 前 12 位生成。Windows 路径大小写、分隔符会规范化；默认 resolveScope 的 detectRoot=false，按传入 cwd 而不是自动猜 Git 根。见[空间解析](<../src/scope.mjs#L255-L282>)。从项目根切到子目录可能产生另一个 workspace；需在 UI 明示根路径/空间 ID，而不是以相同目录名猜同一空间。
2. **默认写入**：显式 space/spaceId 优先；rule/profile 默认 global；decision/experience/state 随会话 cwd；工具执行上下文缺 session 时最终回退 global。见[写入路由](<../src/index.mjs#L1262-L1279>)。
3. **默认可见性**：workspace → 当前 workspace + global；global → global；session → session + 可解析的所属 workspace + global。当前空间权重 1.0，global 回退 0.85。见[可见空间实现](<../src/scope.mjs#L410-L454>)。这是本地逻辑过滤，不是多用户 ACL/租户认证。
4. **过滤不是“无条件总生效”**：未传空间的 search guard 是 allow-all 兼容模式，见[无参行为](<../src/search.mjs#L436-L453>)；工具 recall 在无 exec session 又无显式空间时返回 null（不限空间），显式 all 也是不限空间，见[召回路由](<../src/index.mjs#L1282-L1298>)。新增面板/RPC应从受信会话解析空间，不能把无参底层调用当成默认安全授权。
5. **迁移不会重判归属**：旧条目无 space_id 时归 global；promise→rule，person→profile，其余→experience，见[旧库迁移](<../src/store.mjs#L846-L858>)。所以当前 workspace 0 条不意味着“看不到记忆”，global 仍是默认共享回退；也不意味着这 123 条都该共享。

**迁移建议（待用户授权，未执行）**：先在备份/临时 DB 生成 dry-run 分类清单，只列 ID、来源、拟归属、理由/置信度；由人确认项目私有条目，再事务迁移并重建受影响 SQL 槽位/向量/wiki/检索索引，验证 ID/原文/修订链不丢，保留可回滚映射。不能按当前 cwd 把所有 global 一键搬走；不能从敏感正文自动“提炼”全局人格后直接常驻。

## 3. 本地 SQLite 与检索索引到底是什么

### 3.1 持久化层

使用 node:sqlite DatabaseSync。本地 schema v8 的八张核心表是 spaces、memories、memory_revisions、entity_slots、vectors、wiki_pages、ingest_queue、meta，见[完整 DDL](<../src/store.mjs#L405-L527>)。

- memories 的 (space,status,category,tier)、(space,updated_at)、(space,hash) 索引服务过滤/排序/查重；(space,slot_key) 的 active 唯一约束保证同一空间单活状态。不同空间同一 slot 不互相覆盖。
- entity_slots 有 (space,entity,attr) 与 memory_id 索引，用于结构化证据查找，而不是语言模型看到所有事实。
- vectors 用 memory_id 主键并记录 space/model/dims/content_hash；不是依赖 SQLite rowid 的外接云向量库。
- wiki_pages 的 (space,slug) 唯一约束与 source_ids/version/dirty 支持分区知识页和增量编译；memory_revisions 保留旧版证据；ingest_queue 是异步入库工作队列，**不是**已注入上下文。

### 3.2 搜索层

[索引构建](<../src/index.mjs#L564-L592>)从 active 记忆建立进程内 SearchIndex，按 dataGeneration 缓存；内容变化使索引/召回缓存失效。**这不是 SQLite FTS5，也不是工作台 Markdown 文件目录索引。** 宿主进程可能建立全库索引以便服务多空间，但输出检索结果必须先应用 scope；“全库建立索引”不等于“全库被发送给模型”。

主链是：问题 → 分词/标识符 → 有 scope 时先过滤 → BM25 / 可选向量 / entity_slots → RRF 融合 → 证据门、冲突及预算处理 → 按需召回或注入。分词使用可选 @node-rs/jieba；不可用时缓存失败并回退，不反复 require，见[分词机制](<../src/search.mjs#L98-L131>)。三路能力不等于三路都在现装启用；本任务快照向量、rerank、扩词 OFF，不能在 UI 画成正在运行的服务。

Wiki 编译是本地按空间/主题聚类，已有页面按 source/dirty 维护；[宿主编译逻辑](<../src/index.mjs#L614-L647>)可为尚无页的组播种。这不等于 Tencent 的完整文档知识图谱/CodeGraph。

## 4. 工作台机制核对：人格、交接、经验和索引的边界

依据是[工作台 README](<F:/工作台相关/工作台/README.md>)、[记忆机制正文](<F:/工作台相关/工作台/00-核心机制/二-记忆机制.md>)，并与实际[场景记忆工具源码](<F:/工作台相关/工作台/12-源码照搬/工具/场景记忆.mjs>)交叉核对，不把说明文字视为已安装自动行为。

| 工作台机制 | 实际证据 | 对 MemJudge 的价值/边界 |
|---|---|---|
| 短全局规矩自动读、场景交接开场读、知识库按需读 | [三层读取约定](<F:/工作台相关/工作台/00-核心机制/二-记忆机制.md#L23-L63>) | 与 S/D 分离方向一致；不能把整个工作台目录常驻注入 |
| 交接最新态 + 旧版归档指针 | [4KB/8KB与收口规范](<F:/工作台相关/工作台/00-核心机制/二-记忆机制.md#L69-L101>)；[先归档后改交接](<F:/工作台相关/工作台/12-源码照搬/工具/场景记忆.mjs#L402-L437>) | 可对应 state 单活槽 + revisions；不是把所有历史 state 拼入 S |
| 身份/权限范围可核对 | [指纹与会话绑定检查](<F:/工作台相关/工作台/12-源码照搬/工具/场景记忆.mjs#L527-L547>) | 场景身份可用于显示/映射，但不能仅凭模型声称身份跨空间读写 |
| 场景画像 | [writePortrait](<F:/工作台相关/工作台/12-源码照搬/工具/场景记忆.mjs#L239-L268>)由场景 JSON、渲染器、定位卡生成布局/面板/会话信息 | **它不是用户人格，也不是自动总结出的用户偏好**；不能直接写成 global profile |
| 可复用经验短结论、带来源、保留归档 | [写入/整理规范](<F:/工作台相关/工作台/00-核心机制/二-记忆机制.md#L120-L160>) | 可作为人工审阅导入规范；项目特例默认 experience/decision 留在项目空间 |
| 文件目录索引 | [归档登记](<F:/工作台相关/工作台/12-源码照搬/工具/场景记忆.mjs#L435-L437>)追加索引表 | 便于找文件，不等于正文全文/语义检索，也不等于 memjudge 已入库 |
| “写入即索引” | [可选导入调用](<F:/工作台相关/工作台/12-源码照搬/工具/场景记忆.mjs#L440-L447>)：缺记忆库模块的公开版明确跳过，失败不影响交接 | 不能宣称当前所有工作台交接都会进入 memjudge；该脚本目标也不是这里的插件 API |

### 已有桥梁和缺口

MemJudge 有[同进程只读服务契约](<../src/service.mjs#L1-L20>)，供 dsh-workbench 等插件观察；禁止写方法，还明确避免读取刷新访问次数。宿主确实[注册服务](<../src/index.mjs#L2820-L2834>)。这证明具备只读桥梁，**不证明已部署的工作台消费了它**，也不证明文件知识库自动同步、人格自动注入或双向更新。

本仓 src/清单的精确检索未找到 wb_persona / wb_recall / wb_index 或场景记忆工具适配。工具名存在于宿主工具清单也不能证明本插件集成了对应机制。外部现用工作台配置/真实场景/插件安装未纳入本次读取，消费方接线为**未证实**。

**人格缺口**：已有 rule/profile 数据类别及 S 注入，但没有看到“从身份卡/人格文件到 scoped profile 的可审阅映射/版本/来源链”的适配。应保留角色、语气、技能等人格设置与用户事实的边界；项目角色不默认晋升全局用户画像。

**手工经验晋升缺口**：注入引擎明确让手工与自动经验共同参与 D 检索，不再让固定手工槽饿死自动记忆，见[公平检索约束](<../src/inject.mjs#L4-L14>)。另有[访问热度升降提案](<../src/layer.mjs#L347-L397>)；因此不能说“完全没有提升逻辑”。但访问热度 promote ≠ 人工核验的“项目经验提炼为跨项目通用规则”，本次未发现对后者的候选审阅、适用条件、反例、跨空间发布审批闭环。不能用访问次数自动改为 global rule。

## 5. Tencent：机制借鉴 / 代码融合 / 服务接入分开记账

### 5.1 本地已证实

| 层次 | 状态 | 证据 |
|---|---|---|
| 机制借鉴 | **已证实**：jieba 懒加载单例、搜索模式切词、停用词；相关注释明确 Tencent 来源 | [来源说明](<../src/search.mjs#L38-L49>)、[具体实现](<../src/search.mjs#L98-L131>) |
| 局部代码借鉴 | **本地注释声称有照抄语义/停用词，可信度高于纯概念相似**；但本次没有逐行核验历史 Tencent sqlite 源文件/commit，也不下结论整段代码完全一致 | 同上；不扩大为整个 MemoryCore 移植 |
| 分层/Wiki/混合检索 | 本地有独立实现；与上游机制方向相似，不足以证明代码血缘/逐层等价 | [本地生命周期分层](<../src/lifecycle.mjs#L1-L13>)、[DDL](<../src/store.mjs#L405-L527>) |
| Tencent 包/SDK依赖 | **本地包清单未发现**；唯一 optionalDependency 是 @node-rs/jieba ^2.0.0 | [依赖](<../package.json#L24-L26>) |
| MemoryCore/Hub/Proxy/Knowledge 服务接入 | 本次 src/依赖定向检索无适配证据；**不能宣称已接入** | 检索范围与命令见下节；未读取真实配置/部署 |
| 上游自定义记忆策略 composer | 本地未命中 CUSTOM_MEMORY_STRATEGY / SYSTEM_CUSTOM_STRATEGY_GUARD，不是已融合能力 | 上游源码与本地检索对照 |

### 5.2 本次公开上游核验（不是部署验证）

公开仓库是 [TencentCloud/TencentDB-Agent-Memory](<https://github.com/TencentCloud/TencentDB-Agent-Memory>)；GitHub API 报默认分支 feat/server_team。本次通过 contents API 返回 200 读取以下两个文件，未 clone/部署/登录/上传：

- [上游 README（分支固定）](<https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/README.md#L260-L283>)，Git blob SHA 7ec506d69c0008cd97efe4ca125b0bdd25605fc7。它说明 L0 Conversation→L1 Atom→L2 Scenario→L3 Core/Persona、BM25+向量+RRF、Fixed Binding+ACL、Wiki/CodeGraph 按需工具；[部署节](<https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/README.md#L30-L44>)是 memory-core + memory-hub + proxy，不是单个本地 jieba 包。
- [上游策略 composer](<https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/src/core/memory-prompt/composer.ts#L3-L40>)，Git blob SHA 5c45d06e07de307147e723170d8f82d3a892d055：composeMemorySystemPrompt 无自定义命中就原样返回原系统提示；有命中时附加 CUSTOM_MEMORY_STRATEGY 和最高优先级 guard，转义闭合标签，限制自定义内容只能改关注/归纳策略，不能改 JSON、工具白名单、路径、协议/长度等系统约束。

注意：Git blob SHA 不是 commit SHA；分支链接可变化。原 raw README 请求曾超时，后续 contents API 成功；未因此把无法读取内容假装已核验。[本地历史 Wiki 设计稿](<wiki-layer-spec.md>)可作设计参考，不能替代本次源码/上游当前事实。

**命名不等价**：Tencent L0 是原始对话，本地生命周期 L0 是 rule/profile/state 恒温底座；Tencent L3 是 Persona，本地 L3 是冷归档。不可在 UI 中把两者按数字直接对齐，更不能承诺本地实现了 Tencent L3 人格提炼。

### 5.3 尚未融合清单

1. 完整 Tencent MemoryCore 异步多级提炼及 Agent/Team/Instance 策略解析。
2. 上述 composer 的策略来源/版本/guard 契约（本地不应为“借鉴”而盲目加云服务）。
3. Memory Hub 资产审阅、Team/User/Agent ACL、Fixed Binding、版本分发和使用分析。
4. MemoryKnowledge 文档 Wiki 链接图、CodeGraph 影响链、授权工具 API。
5. MemoryProxy 的 Agent 协议适配与服务端组装；本地现有注入 hook 不是该 Proxy。
6. 云服务凭证、部署、同步/备份、租户数据管理、数据出境/上传授权。
7. 工作台场景/人格/知识库到本地 SQL 的有来源、可回滚、人工确认同步适配。

这些是“当前未证实/没有适配证据”，不是对上游能力本身的否定，也不是建议立刻部署完整平台。

## 6. 可操作后续（均未执行）

| 优先级 | 建议 | 可验收标准 |
|---|---|---|
| P0 本轮面板 | 库存储与 S/D 配置/实测分离；缺宿主 tokens/上下文容量显示未提供；按空间钻取不无参扫库 | 原文只经显式 scoped 明细读取；当步真实 text/char/UTF8 bytes，未知为 null+原因 |
| P0 隔离 | 新读取通道无会话/无可验证空间时拒绝或仅全局安全汇总；不用兼容 allow-all 作 UI 默认 | A/B 项目互不泄露，session 不串帧；global 共享规则明确可见 |
| P1 存量整理 | 备份副本上 dry-run 123 条 global 归属，不动现库 | 人审映射、原文/ID/修订链保留、向量与 Wiki 同步、可回滚 |
| P1 经验晋升 | 候选经验 → 适用范围/证据/反例 → 人审 → 发布到 global experience 或明确 rule | 默认不跨空间，正文来源可钻取，拒绝一次事故自动上升永久铁律 |
| P1 人格 | 分离工作角色/场景配置与用户稳定画像；建立来源、版本、scope 和撤销入口 | 只有用户明确确认的跨项目偏好进入 global profile；项目身份留项目 |
| P1 文件索引 | 文件清单索引、内容检索索引、SQL 证据索引各自展示范围/更新时间/失败项 | 写入→内容hash→分段/槽位→索引失效重建；只记录成功覆盖，不把“文件有登记”当“已可检索” |
| P2 Tencent | 优先借鉴可本地实现的策略 guard、可审阅资产/血缘，再评估服务接入 | 单独架构决策与隐私授权；无自定义策略时提示逐字节不变；冲突策略不能突破系统协议 |
| P2 工作台桥 | 只读服务先做观测；写同步必须另走显式工具确认，不偷渡只读服务 | 无读取副作用、不刷新访问计数；导入幂等可回滚、删除/归档不双向意外扩散 |

## 7. 核验记录与限制

### 已做的静态核验

- 工作台 README 与核心记忆机制全文；相关身份、画像、交接、归档、索引工具实际实现。
- 本地 scope / store / inject / index / search / service / lifecycle / layer 的相关执行路径；源码定向搜索 Tencent/tencent、MemoryCore、MemoryKnowledge、CUSTOM_MEMORY_STRATEGY、SYSTEM_CUSTOM_STRATEGY_GUARD、wb_persona、wb_recall、wb_index、场景记忆。最终 src/**/*.mjs + 包清单/锁文件查询 scanComplete=true，命中仅两处 Tencent 分词注释；缺失锁文件不计为存在并已核验的依赖。
- GitHub contents API 两次成功读取（上游 README、composer）；只依据本次拿到的内容陈述。
- Node 运行时命令：node --version → v24.22.1，exit 0。

### 隔离测试

已执行：

```sh
node --test test/v2-scope-slots.test.mjs test/v2-search-inject.test.mjs
```

**exit 0；26 tests / 26 pass / 0 fail / 0 skipped，约 3.89 秒**。测试使用纯函数/内存库，不访问真实安装配置/DB。覆盖路径规范化/空间可见性、标识符与槽位、A/B 项目隔离、三路 RRF、证据门/冲突、手工与自动公平召回、S 会话冻结、D 去重/压缩后重召回、1500 字符上限和工具子步/无关问题零注入。这里验证的是模块行为，不是现装 GUI、云服务或外部工作台部署。

定向源码搜索可复现为 OPS grep 参数（非测试命令，无进程退出码）：

```json
{
  "pattern": "Tencent|tencent|MemoryKnowledge|MemoryCore|CUSTOM_MEMORY_STRATEGY|SYSTEM_CUSTOM_STRATEGY_GUARD|wb_persona|wb_recall|wb_index|场景记忆",
  "glob": ["src/**/*.mjs", "package.json", "package-lock.json", "pnpm-lock.yaml"],
  "limit": 50
}
```

返回 completed / scanComplete=true / matchedTotal=2（两处 Tencent 分词注释）。搜索不覆盖所有外部安装目录，故不以“未命中”证明用户机器上完全没有外部服务。

### 已知限制

- 未打开或重算真实 DB；所有运行数量是任务快照，不是本报告实时仪表。
- 未改/初始化参考工作台，未检查现用消费方部署，因此工作台真实服务接线未证实。
- 未做 Tencent 历史分词代码逐行溯源、完整平台/云服务/ACL/API 联通测试；只确认当前公开文档和 composer。
- 本组不改宿主、前后端或发布包，不声称完成本轮 UI 实装/浏览器视觉验收。
- 并行组可能修改宿主接线；本报告路径行号以本次读取时为准，内容锚点仍可按函数名定位。
