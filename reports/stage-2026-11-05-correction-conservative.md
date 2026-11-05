# 更正作用域保守处理阶段记录

日期：2026-11-05。HEAD：`b7794ae947b8d6b094424302f2499ce6e9dba65b`。状态：定向修复及隔离测试完成，独立审查仍在进行，首纵切尚未整体验收，未进入阶段 2。

## 改动与契约

在既有未提交的 `src/attribute-evidence.mjs` 和 `test/attribute-evidence.test.mjs` 上精准补丁。明确目标主体与属性的限定中文更正句式，以及英文 `changed to` / `has changed to` 返回缺证；句首无主体更正及撤回无论在哪个交付片段均保守返回缺证，不按召回排序或前一句推断指代。明确其他主体的更正句不自动阻断目标肯定值。缺证不是证实事实不存在；规则是有限句式，不证明已识别所有更正、时间、否定或跨来源关系。无主体句可能针对其他对象，存在保守误拒；被裁剪未交付的更正无法检测。

## 测试与失败记录

- 新增明确主体、无主体、其他主体、跨片段和截断反例。实现前目标句 `BM25的颜色是红色。BM25的颜色后来改为蓝色。` 实际返回 `["红色"]`，断言期望 `[]`，退出 1；“其他物品是绿色。后来改为蓝色”可能指目标的反例也先失败，避免按相邻句假定指代；“已经更正为”反例亦先失败。
- 曾尝试最近其他主体作为前句的推断，自查发现会错误支持旧值，已撤销。英文动态正则转义错误导致隔离组两次 23 通过、1 失败；修正后两次均 24 通过、0 失败。最终一次包含新增目标更正、无主体更正及其他主体更正三项工具和服务入口断言。
- 最终命令，插件目录执行：

```bash
env -i PATH="$PATH" SYSTEMROOT="$SYSTEMROOT" DSH_HOME="${TEMP:-/tmp}/memjudge-nonexistent-$(date +%s)-$$" MEMJUDGE_NO_SECRETS=1 MEMJUDGE_VECTOR=0 MEMJUDGE_EXPAND=0 MEMJUDGE_LLMSELECT=0 MEMJUDGE_LLMEXTRACT=0 MEMJUDGE_MAX_CHARS=0 MEMJUDGE_RERANK=0 MEMJUDGE_NO_JIEBA=1 node --test --test-concurrency=1 test/attribute-evidence.test.mjs test/read-by-id.test.mjs test/long-recall-position.test.mjs test/recall-truncation.test.mjs test/conflict-read-version.test.mjs
```

结果：Node v24.22.1，24 项通过、0 失败、0 跳过，退出 0；耗时 3596.9282 ms。测试输出反复提示宿主无 Connection RPC，设置页面板不可用，属于假宿主夹具，不是实际宿主验证。用例覆盖内存数据库双入口、原文内容版本及分页、UTF-16 窗口、冲突证据、部分归一化和代理对。`node --check` 对属性模块和测试文件通过；`git diff --check` 退出 0，但只覆盖跟踪文件并产生既有行尾警告，未覆盖未跟踪文件。

## 范围和限制

测试调用链由上层协调的只读审计确认：五个文件使用内存库；`rawArchive` 未启用，递归清理路径不在该测试调用链。进程显式禁用密钥、向量、查询扩展、模型选段、模型提取、重排和 jieba；环境清空后重新设置变量，`DSH_HOME` 指向新构造的非现有路径。没有操作系统级网络隔离证明，不能由此声称网络被系统封锁。未执行 `test/service.test.mjs`，未读取真实数据库、密钥，未部署、提交、推送或清理既有工作。真实宿主、完整指代语义、跨连接竞态、长篇公平评测和未列句式均未验证；保留原有脏工作树。
