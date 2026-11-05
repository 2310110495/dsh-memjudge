# 结构化属性证据 V1 阶段报告

日期：2026-11-05。状态：独立纯函数初版，未接生产、未部署、未提交。

## 范围与接口

新增 `src/attribute-evidence-v1.mjs`，直接导出 `analyzeAttributeEvidenceV1(query, hits)`，不依赖插件入口、库、网络或宿主服务。原 `attributeValues`、`attributeEvidence` 与既有生产调用保持原样。

仅支持 `实体的颜色是什么/多少` 和 `what is entity's color?` 两类受限查询、完整肯定句及源文件中明确列举的中英文颜色词。`supported` 表示查询符合此语法，不等于全面理解输入中的自然语言。目标句、否定、更正、候选值或片段存在无法确定的语义时返回 `uncertain`；不同候选值返回 `ambiguous`。其他状态为 `unsupported`、`no-evidence`、`candidates`。候选不代表当前事实，`scope.currentness` 明确为 `not-established`；不根据召回排序推断时间。

候选按 hit 和句子输入顺序保留，含原句、候选原值和归一值、`hit.id`/`hit.version`（缺失为 null），`sentenceSpan` 与 `valueSpan` 为 hit 文本上的 UTF-16 半开区间。只有同时提供整数 `windowStart`、`windowEnd`、`originalText`，且原文对应 `slice` 精确等于整个 hit 文本时，才返回原文上的两个 span；否则均为 null。截断片段首句仅在明确 `startsAtBoundary: true` 时可作为候选，未闭合句和跨片段拼接均不作为候选。

## 证据

先创建 `test/attribute-evidence-v1.test.mjs`；实现前运行 `node --test test/attribute-evidence-v1.test.mjs`，退出 1，错误 `ERR_MODULE_NOT_FOUND`，缺少待实现的独立模块。随后创建模块，同一命令退出 0：6 项通过、0 项失败。覆盖全角、emoji、UTF-16 切片恢复、原文映射不匹配、元数据缺失、多值和输入顺序、否定、更正、未知值、跨片段、截断首句、残句、英文及不支持查询。`node --check src/attribute-evidence-v1.mjs` 和 `node --check test/attribute-evidence-v1.test.mjs` 均退出 0。

已读取历史交接、既有独立复核报告、`src/attribute-evidence.mjs`、`test/attribute-evidence.test.mjs` 及 `src/search.mjs` 窗口实现；在 `docs/plans` 和插件文档中检索属性证据相关实施计划，未定位针对本接口的独立实施计划。本阶段以当前任务给出的约束为准，未声称该计划已读。工作开始时 git 工作树已有 7 个修改文件及多个未跟踪文件；本阶段只新增本模块、测试和两份报告。

## 局限

固定词表与有限标记不是通用语义理解；目标相关未知文本可能无法识别成目标相关，不保证识别所有否定、更正、时态、跨句指代或历史事实。片段的完整性和 `startsAtBoundary` 由调用方提供，窗口与原文切片匹配只证明位置对应，不证明库版本、来源身份或文本事实。验证仅为人工构造的纯函数测试和语法检查，未验证实际召回、宿主、生产服务、性能或真实数据；尚需独立审查与扩大对抗测试。未接入召回或服务，未访问真实库、密钥及网络。
