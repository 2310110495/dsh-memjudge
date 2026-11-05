# 非向量原文证据纵切：独立审查阶段

日期：2026-11-05。状态：审查，未实现修复，未完成纵切验收。

## 基线与既有工作

本地 HEAD 为 `b7794ae947b8d6b094424302f2499ce6e9dba65b`。审查时工作树原有修改：`README.md`、`src/conflict-scan-v2.mjs`、`src/index.mjs`、`src/search.mjs`、`src/service.mjs`、`test/read-by-id.test.mjs`、`test/recall-truncation.test.mjs`；原有未跟踪文件：`reports/stage-2026-11-04-t292.md`、`src/attribute-evidence.mjs`、`test/attribute-evidence.test.mjs`、`test/conflict-read-version.test.mjs`、`test/long-recall-position.test.mjs`。已修改文件统计为 191 行新增、32 行删除；未跟踪文件不计入。上述既有工作均非本次交付。

## 核实结果

- 源码观察：`src/index.mjs:961-965` 对交付片段的属性证据不足设置 `reason=attribute-evidence-missing`，`detail` 表达片段缺证；`src/index.mjs:1092-1095` 将所有 denied 结果渲染为“没有记载”。`src/service.mjs:127-130` 保留 reason 和 detail。源码路径支持语义不一致的结论；本轮未运行宿主或双入口集成验证。
- 纯函数复现：Node `v24.22.1` 直接导入 `src/attribute-evidence.mjs` 并调用 `attributeValues('bm25的颜色是什么', [{text}])`，`BM25的颜色是红色或者蓝色。` 返回 `["红色或者蓝色"]`，`BM25的颜色是红色待确认。` 返回 `["红色待确认"]`。`src/index.mjs:961-968` 在非空值集合时跳过常规门，`src/index.mjs:1025` 仅在集合长度大于一时生成冲突提示；端到端影响尚未执行验证。
- 测试安全审计尚未完成。`src/config.mjs:26` 根据 `DSH_HOME` 选择配置目录，`src/config.mjs:329` 仅在 `MEMJUDGE_NO_SECRETS=1` 时跳过密钥文件读取；完整依赖调用链未核验前，现有集成测试不运行。`test/service.test.mjs` 的既有递归清理风险保留，未执行该文件。

## 修复阻碍与后续验证

用户限定代码和测试仅可用 `apply_patch` 手工修改。`command -v apply_patch`、`type -a apply_patch`、`where.exe apply_patch` 均未找到命令；宿主工具发现仅返回 `ops_edit_file`，并非该命令。故未写代码或回归测试，也未将其他编辑方式冒充补丁工具。未修改版本日志、未提交、未部署、未推送；向量与重排未触及。

补丁工具可用后，先增加可区分的隔离回归：内存库写入完整属性句，小预算分别断言工具结构化结果、工具渲染和服务结果均表达交付证据不足；再覆盖单句多值、待确认、条件、否定、疑问、时间变化与不同来源，核对值集合、冲突提示及两入口行为。完成依赖链和隔离环境审计后，再修复并运行定向测试。原文版本、UTF-16 半开偏移、代理对、组合字符、跨页更新与删除、真实宿主及跨连接一致性仍待验证；该审查不代表首纵切通过。
