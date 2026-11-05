# 属性证据修复阶段记录

日期：2026-11-05。状态：未实现，未验收。保持既有代码及未跟踪工作；向量和重排专项未启动。

## 基线与检查

- `git status --short`：原有 7 个已修改文件与 5 个未跟踪文件，加此前未跟踪审查报告；本阶段检查前后相同。
- `git log -5 --oneline`：HEAD 为 `b7794ae`。
- `git diff --stat`：7 文件、191 行新增、32 行删除，未跟踪文件不计入；Git 提示部分文件未来可能转换行尾。
- 已读交接、实施计划、阅读引导、证据审查报告、属性证据及其测试、召回和服务代码、配置及内存存储入口。已加载 `cordis-plugin-development` 技能并列举宿主检查提供者。
- `where.exe apply_patch`、`command -v apply_patch` 均退出 1；`ls -la /tmp/repo_support /usr/local/bin/apply_patch /usr/bin/apply_patch` 退出 2，所列位置不存在。宿主资源目录文件名扫描未找到匹配补丁程序；工具发现返回文件编辑工具而非 `apply_patch`。`rg` 缺失（退出 127）。误按 PowerShell 语法调用 `Get-Command`、`Get-ChildItem` 时 Bash 返回命令不存在（退出 127）；均未修改文件。

## 本轮实测

- `node --version`：`v24.22.1`。
- 在插件目录执行 `node --input-type=module -e "import {attributeValues} from './src/attribute-evidence.mjs'; for (const text of ['BM25的颜色是红色或者蓝色。','BM25的颜色是红色待确认。','BM25的颜色是红色。']) console.log(JSON.stringify({text,values:attributeValues('bm25的颜色是什么',[{text}])}))"`，退出 0：依次返回 `["红色或者蓝色"]`、`["红色待确认"]`、`["红色"]`。前两项重现错误，第三项为肯定句对照。该命令仅导入纯函数模块，未连接数据库。
- 源码显示 `attribute-evidence-missing` 的 detail 指向交付片段缺证，而工具渲染对所有 denied 使用“没有记载”；本轮未执行双入口复现。
- `:memory:` 走内存 SQLite；`apply` 初始化仍读取配置，须在导入前隔离 `DSH_HOME` 并设置 `MEMJUDGE_NO_SECRETS=1`，并审计完整依赖链、环境开关、RPC 及清理行为。当前审计未完成，未运行现有集成测试；尤其未运行 `test/service.test.mjs`。

## 后续

提供可调用的系统 `apply_patch` 后，先补中英文区分性测试，覆盖工具结构化结果、渲染、服务输出、单句多选、不确定句及肯定对照，再修复并在完整副作用审计后运行隔离回归；记录命令与结果。自由查询兼容、窗口及分页、真实宿主和跨连接一致性仍待验证。本报告不代表代码已修复。
