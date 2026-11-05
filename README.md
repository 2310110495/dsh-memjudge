# dsh-memjudge

面向 DeepSeek Harness 的记忆插件：以 SQLite 保存记忆文本，使用 BM25 检索、规则事实提取和判断层辅助召回。项目仍在演进，部分功能处于实验阶段，历史评测结果不代表当前版本的验收结论。

## 能力

- `memjudge_remember` 保存记忆，支持类别、来源和重要度；相同正文按存储逻辑去重。
- `memjudge_recall` 按查询检索，返回命中标识和正文片段；预算截断的命中标记 `truncated`。默认命中会刷新访问状态。
- `memjudge_remember` 写入回执的 `version` 是完整原文的 UTF-16LE SHA-256；用返回的 `id` 和 `version` 可从首次回查起检查正文是否变化，重复写入同一正文返回相同版本。
- `memjudge_read` 按记忆 ID 分页读取原文，不刷新访问时间或计数；分页偏移按 UTF-16 码元计算，截断时避免拆开有效代理对。每页传入同一 `version` 可检测正文变更；跨页读取不提供快照保证。
- `memjudge_forget` 删除记忆；`memjudge_conflicts`、`memjudge_conflicts_v1`、`memjudge_conflicts_v2` 提供不同的冲突检查入口；`memjudge_stats` 返回统计信息。冲突候选需要结合原文判断，不等于自动确定真实的新旧结论。
- 本地事实索引从记忆正文派生；召回、事实和冲突判断各有边界，未命中或拒答结果不应视为对现实事实的证明。

冲突候选的每条 `evidence` 含 `memoryId`、`version`、`start`、`end` 和 `positions`；`positions` 标识来源，`start`、`end` 是正文中的 UTF-16 左闭右开偏移。回查时以 `memoryId`、`version` 和 `offset=start` 调用 `memjudge_read`，此后沿用相同版本及每页的 `nextOffset`，直至覆盖 `end`；末页只取到 `end` 为止，再拼接各页。若提示 `stale version`，应重新扫描冲突；内容变更后恢复为相同内容时，内容指纹不会体现中间变化。扫描和返回预算可能使长句或候选缺席，需检查 `scanIncomplete`、`reason` 和 `outputTruncated`。

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
| `vector`、`expand`、`llmSelect` | 默认受相应环境变量影响，示例补丁显式关闭；涉及外部模型或网络时需单独配置。 |

向量路径仍有删除后 rowid 重用导致错配的已知风险；异步向量写入和跨连接并发同样需要完整验证。实验快照召回的最终检查后仍存在其他连接提交的窗口，且不覆盖所有独立进程和直接数据库操作。

## 验证与边界

当前工作树已有聚焦内存及独立临时 SQLite 回归，覆盖分页原文、截断、实验注入、快照及部分事务故障。各项测试只证明对应夹具和代码路径；它们不是对真实宿主、全部数据迁移或竞品表现的验收。

运行测试前应检查各测试及其依赖的文件创建、清理行为。以下单项测试使用内存库，不依赖向量或网络：

```bash
MEMJUDGE_NO_SECRETS=1 node --test test/read-by-id.test.mjs
```

Windows PowerShell 设置环境变量的写法为 `$env:MEMJUDGE_NO_SECRETS='1'`。真实适配器评测尚缺经验证的系统级文件、网络与资源隔离；旧评测入口和历史结果不应直接当作当前版本的可信分数。

[阶段进展](reports/stage-2026-11-04-t366.md) 记录文档整理时的能力、验证范围和待办。历史设计与实验材料保留在源码仓库，历史报告属于特定时间的快照；涉及已变化的实现与评测结论时应以当前源码和独立验证为准。

## 许可证

MIT
