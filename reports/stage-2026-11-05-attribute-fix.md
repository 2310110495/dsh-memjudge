# 属性证据修复阶段记录

日期：2026-11-05。状态：局部修复及定向测试通过，首个证据闭环尚未验收。

## 改动与验证

- 保留 HEAD `b7794ae` 上的既有脏工作树；本轮在已有 `src/attribute-evidence.mjs`、`src/index.mjs`、`test/attribute-evidence.test.mjs` 工作上追加局部变更。
- 中文“或/或者/还是/待确认/待定/待核”和英文 `or/pending/unconfirmed` 等不确定值不再当作肯定证据。规则为有限启发式，可能误判含关键词的合法值，也存在未覆盖表达，不构成通用语义证明。
- `attribute-evidence-missing` 的工具渲染改为“交付片段证据不足”，与原有 `reason`/`detail` 一致；此结论不等于完整记忆库没有记载。其他拒答类型保持原有渲染。
- 分别先复现中文选项、单字“或”、截断缺证渲染的失败回归，再修复。英文选项和待确认、中英文双入口、肯定和否定对照包含在最终测试中。
- `DSH_HOME='F:/记忆库/__isolated_memjudge_nonexistent_20261105_a734' MEMJUDGE_NO_SECRETS=1 MEMJUDGE_VECTOR=0 MEMJUDGE_EXPAND=0 MEMJUDGE_LLMSELECT=0 node --test test/attribute-evidence.test.mjs`：7 个测试通过。测试夹具使用 `:memory:`，无连接服务，未启用原始归档；自动采集处理器未触发。配置读取指向单独不存在路径并关闭密钥文件读取。尚未证明操作系统级文件或网络隔离；未运行 `test/service.test.mjs`，未主动读取真实库或密钥。
- `git diff --check` 通过，Git 提示既有部分文件将来可能转换行尾。新建和未跟踪文件不包含在此命令的检查范围。

## 补丁方式

`F:/记忆库/apply_patch` 是本轮新建的可执行 Node 包装器，接受 `*** Begin Patch` / `*** Update File` 格式，要求每个旧文本上下文唯一并在写入前复核文件，保留 CRLF/LF；不支持新增、删除文件，不提供多文件原子提交。它不是系统自带工具，也不是 GNU patch 的包装器。修改前已读取目标上下文；审查阶段以文件工具创建本报告。系统另有 GNU patch 2.8。

## 未完成

时间与条件句、更多否定/疑问、多来源和其他不确定表达尚需区分性测试；保守关键词可能导致误拒。真实宿主、完整副作用隔离、跨连接及首纵切整体验收未完成。向量与重排专项暂停；未提交、部署或推送。下一项非向量功能尚未实施。
