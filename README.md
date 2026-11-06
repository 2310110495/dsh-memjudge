# dsh-memjudge

面向 DeepSeek Harness 的记忆插件：以 SQLite 保存记忆文本，使用 BM25 检索、规则事实提取和判断层辅助召回。项目仍在演进，部分功能处于实验阶段，历史评测结果不代表当前版本的验收结论。

## 安装

包名 `dsh-memjudge`，版本 `0.1.0`。通过 DSH 插件管理器安装本包所在目录；包声明的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，其中挂载插件并提供非敏感配置。兼容范围是包声明而非实际宿主验收结果。升级已有安装前应备份数据库，并先阅读下方历史库限制。

## 能力

- `memjudge_remember` 保存记忆，支持类别、来源和重要度；相同正文按存储逻辑去重。
- `memjudge_recall` 按查询检索，返回命中标识和正文片段；预算截断的命中标记 `truncated`。默认命中会刷新访问状态。
- `memjudge_remember` 写入回执的 `version` 是完整原文的 UTF-16LE SHA-256；用返回的 `id` 和 `version` 可从首次回查起检查正文是否变化，重复写入同一正文返回相同版本。
- `memjudge_read` 按记忆 ID 分页读取原文，不刷新访问时间或计数；分页偏移按 UTF-16 码元计算，截断时避免拆开有效代理对。每页传入同一 `version` 可检测正文变更；跨页读取不提供快照保证。
- `memjudge_forget` 按 ID 或查询删除记忆，查询模式可用 `dryRun` 预览；删除是物理操作。`memjudge_stats` 返回统计信息。
- `memjudge_conflicts` 是按章聚合的旧版入口，可能跨文档误报，其 `current` 是结构规则结果。`memjudge_conflicts_v1` 按显式 `documentId` 检测候选，最多比较 10000 对；`memjudge_conflicts_v2` 提供有界扫描。未知文档身份时 v1、v2 仅比较同一正文。候选需结合原文判断，不等于自动确定真实的新旧结论。
- 同进程 `memjudge` 只读服务提供统计、来源、类别与召回等查询，版本为 `1`；其召回不刷新访问状态。Web 面板、自动采集、派生事实和 raw 适配器已有实现或接线，真实宿主集成与长期运行仍待验收。
- 本地事实索引从记忆正文派生；召回、事实和冲突判断各有边界，未命中或拒答结果不应视为对现实事实的证明。

v2 冲突候选的 `evidence` 含 `memoryId`、`version`、`start`、`end` 和 `positions`；旧版入口不提供同等证据结构。`positions` 标识来源，`start`、`end` 是正文中的 UTF-16 左闭右开偏移。回查时以 `memoryId`、`version` 和 `offset=start` 调用 `memjudge_read`，此后沿用相同版本及每页的 `nextOffset`，直至覆盖 `end`；末页只取到 `end` 为止，再拼接各页。若提示 `stale version`，应重新扫描冲突；内容变更后恢复为相同内容时，内容指纹不会体现中间变化。扫描和返回预算可能使长句或候选缺席，需检查 `scanIncomplete`、`reason` 和 `outputTruncated`。

v1 还应检查 `totalExact`、`scanIncomplete`、`limitTruncated` 和 `budgetTruncated`；空结果不证明全库没有冲突。

## 配置与实验

入口为 `src/index.mjs`，示例补丁见 `cordis.patch.yml`。包声明 Node.js `>=22.5`，DSH 兼容范围为 `>=0.2.0-rc.2 <0.3.0`；实际宿主环境仍需单独验证。`@node-rs/jieba` 是可选依赖。

| 配置 | 当前默认行为 |
| --- | --- |
| `dbPath` | 空值使用 `DSH_HOME` 下的 `memjudge/memjudge.db`，未设 `DSH_HOME` 时使用用户目录下 `.dsh`。 |
| `autoInject` | 默认 `false`；显式开启后可设置 `injectBudget`，范围 1–2000。 |
| `touchOnRecall` | 默认 `true`；召回命中刷新访问状态，`memjudge_read` 不刷新。 |
| `decayMode` | 默认 `dual`；`uniform` 可通过 `halfLifeDays` 指定统一半衰期。 |
| `experimentalInjectMode` | 默认 `legacy`；`daily` 是实验性逐日注入排序，按每条记录完整 24 小时计算。 |
| `experimentalSnapshotRecall` | 默认关闭；实验性跨连接快照召回要求 `vector`、`expand`、`llmSelect` 均关闭。 |
| `vector`、`rerank`、`expand`、`llmSelect` | 示例补丁显式关闭；入口中部分增强项默认受环境变量影响，涉及外部模型或网络时需单独配置。 |

自动采集与固定注入独立：自动采集默认开启，入口配置 `autoCapture: false` 是硬关闭，环境变量 `MEMJUDGE_AUTO_CAPTURE=0` 也可关闭。默认候选长度为 12–600，单轮最多 2 条、单会话最多 40 条，近重复阈值 0.85；采集有来源、长度、重复和配额过滤，并非全文归档。其他配置及对应环境变量见 `src/config.mjs` 和 `docs/auto-capture-spec.md`。

模型配置分 `chat`、`embed`、`rerank` 三组，环境变量、状态目录下的非敏感 `config.json` 与单独的 `secrets.json` 参与解析。旧 `MEMJUDGE_LLM_KEY`、`MEMJUDGE_LLM_BASE_URL` 和 `llmKey` 有兼容读取路径，继承行为取决于组模式；密钥不要放入补丁或版本库。`MEMJUDGE_NO_SECRETS=1` 跳过密钥文件，但环境变量仍会生效，也不等于系统级隔离。

向量路径仍有删除后 rowid 重用导致错配的已知风险；异步向量写入和跨连接并发同样需要完整验证。按当前项目决策，向量和重排保持关闭，暂停深修。实验快照召回的最终检查后仍存在其他连接提交的窗口，且不覆盖所有独立进程和直接数据库操作。

历史库兼容性有明确边界：包含持久 `facts` 表的库，包括空表，在启动预检中被拦截；旧事实清理与关联归属尚未闭合，自动迁移未开放。特定历史 v2 `segments` 表仅支持受限迁移：覆盖字符串须为长度不超过段数的 ASCII `0`/`1`，空串和短串保留读取语义而非原始字符串形态；未知结构、异常内容及部分语义等价 DDL 会被保守拦截。这不是对全部历史库兼容或异常数据自动修复的承诺。

raw-host 采集预算闸门目前仅为测试原型，尚未接入适配器；元数据一致性和读取资源上界仍待验证。清理路径存在异步重入等待环的待审边界，真实宿主是否等待卸载清理尚未验证。事实索引是派生投影，raw 写入、跨连接更新及消费者失效的一致性仍需全链路验证。

## 验证与边界

当前工作树已有聚焦内存及独立临时 SQLite 回归，覆盖分页原文、截断、实验注入、快照及部分事务故障。各项测试只证明对应夹具和代码路径；它们不是对真实宿主、全部数据迁移或竞品表现的验收。

运行测试前应检查各测试及其完整依赖链的文件、数据库、环境变量与网络行为，并使用独立隔离环境。以下是历史单项测试命令，不代表本次执行或系统级隔离：

```bash
MEMJUDGE_NO_SECRETS=1 node --test test/read-by-id.test.mjs
```

Windows PowerShell 设置环境变量的写法为 `$env:MEMJUDGE_NO_SECRETS='1'`。真实适配器评测尚缺经验证的系统级文件、网络与资源隔离；旧评测入口和历史结果不应直接当作当前版本的可信分数。

以下均为报告记录的历史局部结果，并非本次重新执行，也不是完整验收：

- [segments 预检阶段报告](docs/segments-preflight-v2-stage-report-2026-11-06.md)：Node v24.22.1，四份内存或临时合成库测试 79 项通过，覆盖指定 v2 结构、异常回滚和重复打开。
- [历史 facts 闸门报告](docs/facts-forget-guard-report-2026-11-06.md)：三份合成测试 33/33；另一次旧假设组合 42/49，7 项因新闸门先行终止而与旧预期不符。不同阶段结果不可合并为全绿结论。
- [混合事实快照报告](docs/facts-hybrid-snapshot-stage-report-2026-11-06.md)：记录合成提取器及内存或临时数据库上的并发回归，同时指出 raw、跨连接与消费端一致性缺口。
- [raw-host 预算原型报告](docs/raw-host-budget-prototype-stage-2026-11-06.md)：4 项合成测试通过，原型未接入生产适配器。
- [阶段进展](reports/stage-2026-11-04-t366.md) 是当时的能力与验证范围快照。

真实宿主工具注册、界面、卸载、长期运行、并发、历史库迁移和完整评测仍待独立验收。历史设计、测试和报告仅对应特定版本与环境；涉及变化时以当前源码及重新验证结果为准。

## 许可证

MIT
