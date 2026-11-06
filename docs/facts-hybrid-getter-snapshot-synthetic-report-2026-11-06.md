# Hybrid getter 快照合成测试报告

- 范围：`rebuildFactsHybrid` 提取结果读取、校验及发布；保留原有事务清理和快照失效检查。
- 环境：`:memory:`；显式注入 `extractL1` 与 `extractHybrid`；未调用默认提取器、旧入口、向量、网络或真实配置及数据库。
- 执行：`node --test test/facts-hybrid-getter-snapshot-synthetic.test.mjs`。
- 结果：4 项通过，0 项失败。
- 覆盖：`source` 从 `rules` 变为 `llm` 的 getter 保留既有 facts；各字段及数组索引读取一次，`value` 第三次变为数字仍只发布首次合法值；getter 抛错保留原数据且后续可重试；数组 getter 同步 `put` 触发快照失效并保留新旧 facts。
- 机制：提取结果先按索引读取，fact 字段各取一次至普通对象；验证与发布共用该快照，发布前复查连接状态并沿用既有版本和事务门禁。
