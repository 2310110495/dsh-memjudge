# Hybrid 快照长度与预算回归

## 策略

`llm` 提取结果的 `perEntry` 长度仅读取一次，必须是非负安全整数、等于记忆条数且不超过 100000。每个事实数组的长度仅读取一次，必须是非负安全整数且不超过 10000；所有事实数组长度之和最多 100000。这些固定上限约束同步快照遍历及候选索引规模，并非内存字节上限。超限或无效时整体抛错，旧快照保持原状，不截断、不发布部分结果。普通数组在限制以内按原顺序完整处理；缺省 `valueType` 保持原有默认，非空类型须是允许的原始字符串，避免对象属性键转换。

## 验证

`node --test test/facts-hybrid-length-budget-synthetic.test.mjs test/facts-hybrid-getter-snapshot-synthetic.test.mjs`：7 项通过。纯 `:memory:`、显式合成 `extractL1` 与 `extractHybrid`；覆盖负数、无穷、NaN、小数、不安全整数、单条上限、总量预算、异常前索引访问计数、对象转换、旧快照保留以及成功恢复。

曾扩大运行六个既有 hybrid 测试文件：32 项中 31 项通过，`facts-hybrid-stale-synthetic.test.mjs` 的 put 测试预期 `synthetic commit failure`，实际并行重入防护先抛 `put operation in progress`。该既有测试还创建临时磁盘 SQLite 并涉及默认提取路径，超出本任务的纯内存约束，此次运行属于范围偏差；最终受控验证仅运行上面两个合成文件。未使用真实配置、密钥、网络或向量。
