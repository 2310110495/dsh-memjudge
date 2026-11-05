# 独立证据 V1 加固阶段报告

日期：2026-11-05。独立函数修改，未接入生产、未部署。

新增 `hasConflict`、`semanticUncertain`，与 `contextIncomplete` 分别表达字面不同候选、有限规则探测到的语义问题及上下文不完整。兼容旧状态优先级：不支持查询为 `unsupported`；语义不确定或上下文不完整为 `uncertain`；否则不同候选为 `ambiguous`，单值为 `candidates`，无候选为 `no-evidence`。因而旧状态可能掩盖冲突，新字段保留冲突事实。候选仍仅是字面匹配，既不证明真实性也不证明时效。

先于文本检查累计截断；验证原文窗口、识别子窗口、不完整映射和截断/边界声明矛盾；不可信句首不生成候选。新增有限更正提示“这句话是错的”“实际上是蓝色”“It is false”，缩小单独历史词的全局污染。为避免不可靠的实体绑定，仍保守处理部分跨句提示，可能被无关修正提示污染；有限规则绝不保证发现未知语义。

先新增回归测试并执行，6 项失败；实施后独立 V1 新旧测试共 16 项通过，模块与新测试语法检查通过。额外误运行旧 `test/attribute-evidence.test.mjs`，其导入并调用插件入口，违背本次不执行入口约束；该文件的入口测试使用 `dbPath: ':memory:'`，禁用向量、扩展及模型选择，全部 20 项通过。旧测试与 V1 合计 36 项通过。测试日志出现宿主无 Connection RPC 提示；不据此推断未发生其他配置或密钥读取，真实库及网络访问也未完整审计。没有安装或部署插件。

保留既有工作区修改；本阶段修改既有未跟踪的独立模块，新建回归测试和两份报告。`apply_patch` 仅支持从标准输入读取 Update File 补丁，新文件通过文件工具创建。

## 2026-11-05 索引遍历修复

将分析器的 `hits.entries()` 改为按数字索引遍历，保留候选顺序与原索引。合成回归临时替换 `Array.prototype.entries`，在 `finally` 恢复原方法，验证输入数组未被该钩子观察，且结果与正常调用一致。

单独运行 `node --test test/attribute-evidence-v1.test.mjs test/attribute-evidence-v1-regression.test.mjs test/evidence-shadow.test.mjs`，35 项通过。另一次测试命令误包含 `test/attribute-evidence.test.mjs`，该文件导入并调用插件入口，四个测试文件合计 55 项通过。测试代码显式使用 `dbPath: ':memory:'`，并关闭向量、扩展和模型选择；其他配置、密钥及网络访问未完整审计。未运行 `service.test.mjs`，未修改 `evidence-shadow-process.mjs`。

此修复只消除 `Array.prototype.entries` 这一观察钩子，并非对恶意全局代码的隔离。独立审查已复现替换 `String.prototype.matchAll` 仍可观察文本；其他全局原型钩子也不在本次修复范围。
