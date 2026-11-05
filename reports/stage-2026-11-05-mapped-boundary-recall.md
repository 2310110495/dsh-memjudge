# 独立证据 V1 映射句界召回修复阶段报告

日期：2026-11-05。仅修改独立纯函数和 V1 回归测试，未接入生产、未提交或部署。

有效 originalText 窗口映射证明窗口开头位于既有句界时，除非 startsAtBoundary 显式为 false，保留满足字面规则的首句候选。子窗口依旧标记 contextIncomplete；显式 false 与映射矛盾时，首句仍被排除并标记 semanticUncertain。后续完整句照常参与候选及冲突判断。

先行测试：仅执行 `node --test test/attribute-evidence-v1.test.mjs test/attribute-evidence-v1-regression.test.mjs`；修复前 20 通过、1 失败，修复后 21 通过、0 失败。两份测试仅导入 Node 内置测试模块及独立纯模块。新增测试覆盖全部九个既有句界分隔符、emoji UTF-16 原文偏移与跨度、非句界、显式 false 矛盾、后续句与候选冲突。

局限：仍使用既有分隔符及有限颜色语法，候选是字面证据而非事实或时效性保证；原文映射不证明来源真实性。未执行旧测试、插件入口，未访问真实数据库、配置、密钥或网络，也未验证生产集成与性能。保留原有工作区改动。
