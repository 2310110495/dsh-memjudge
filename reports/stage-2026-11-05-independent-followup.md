# 属性证据独立复核补充

日期：2026-11-05。状态：缺陷仍未修复，首纵切未验收。

## 复核

- 已加载代码审查与插件开发技能，阅读交接、实施计划、阅读引导及前两份阶段报告。当前 HEAD 为 `b7794ae`，既有已跟踪差异为 7 文件、191 行新增、32 行删除；原有未跟踪文件保留。
- 纯函数直接调用 `attributeValues`，中文 `BM25的颜色是红色或者蓝色。` 返回 `["红色或者蓝色"]`，`BM25的颜色是红色待确认。` 返回 `["红色待确认"]`；肯定对照 `BM25的颜色是红色。` 返回 `["红色"]`。
- 新增英文反例：查询 `what is bm25's color?`，`BM25's color is red or blue.` 返回 `["red or blue"]`，`BM25's color is red pending confirmation.` 返回 `["red pending confirmation"]`。以上均为纯函数实测，未访问数据库或网络。
- 源码复核：`src/index.mjs` 在属性证据不足时返回 `attribute-evidence-missing` 和片段缺证 detail，但工具渲染统一前缀为“没有记载”；`src/service.mjs` 透传 reason 与 detail。双入口运行验证未完成。

## 工具与隔离

- `command -v apply_patch` 和 `where.exe apply_patch` 均退出 1，未找到命令。工具发现返回 `ops_edit_file` 和 `ops_replace`，均非用户指定的 `apply_patch`；未以它们替代代码补丁。
- 误将 PowerShell 命令直接交给 Bash，`Get-Command` 和 `Select-Object` 均报 `command not found`、退出 127；随后以 Bash 和 `where.exe` 检查，未改变文件。
- 当前进程为受委派子代理，`create_goal` 返回 `this goal operation requires a direct human turn on a top-level agent`；独立再委派返回 `subagent depth 2 exceeds maxDepth 1`。本次复核由当前代理执行，不冒充独立第二位审查者。
- 已检查配置和内存测试部分调用路径：配置模块在导入时根据 `DSH_HOME` 固定路径，`MEMJUDGE_NO_SECRETS=1` 才跳过密钥文件读取。完整副作用审计未完成，未运行集成测试或 `test/service.test.mjs`，未读取真实库或密钥，未安装或变更配置。

## 后续

取得可调用的 `apply_patch` 后，先审计测试全部调用链，使用隔离内存库与唯一临时目录构造中英文反例、肯定对照、截断缺证以及工具渲染和服务双入口回归，验证测试先失败，再实施最小修复并重测。属性语义仍是有限启发式，避免将关键词过滤当成完整语义证明。向量、重排、真实宿主、跨连接及首纵切完整验收均未开展；不提交、不推送、不清理既有工作。
