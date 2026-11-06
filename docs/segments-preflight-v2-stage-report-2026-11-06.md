# segments 预检与 v2 覆盖迁移阶段报告

## 依据与决策

历史提交 `30b0f7e:src/store.mjs` 的 v2 表为 `ord INTEGER PRIMARY KEY, seg_count INTEGER NOT NULL, covered TEXT NOT NULL DEFAULT ''`，表尾为 `WITHOUT ROWID`。历史读取逐位置比较字符是否为 `1`，其他字符和缺位均视为未覆盖。当前生产代码将其编码为位图，因此原先对异常字符和超长后缀会静默丢失。

本阶段选择保守拒绝：仅接受长度不大于段数的 ASCII `0`/`1` 字符串；空串和短串沿用历史缺位未覆盖的读取语义，迁移成位图后并不保留原字符串形态。其他字符串拒绝迁移并回滚事务，让原始表及字节留在原数据库；这并非异常数据自动归档或修复。

对已存在的现行和 v2 segments 表，完整词法令牌匹配对应已知 DDL，保留字符串字面量内容，拒绝额外 CHECK 等未认识的语法。该策略有意拒绝部分语义等价但文本结构不同的 DDL，并非全历史兼容声明。

## 验证

Node v24.22.1 执行 `node --test test/segments-v2-migration-synthetic.test.mjs test/index-segment-preflight-synthetic.test.mjs test/schema-preflight-atomic-synthetic.test.mjs test/schema-migration-isolated-synthetic.test.mjs`：79 项通过，0 项失败。合成覆盖当前和 v2 CHECK 伪装、非二进制及超长等异常原字节回滚、空串和短串读取语义、故障回滚、正常迁移和重复打开。测试数据库为内存或测试创建的临时合成数据库。

## 局限

只核对指定历史源码和合成样本，未访问真实配置、真实数据库、密钥及网络，未运行旧入口测试。词法白名单不是通用 SQL 等价性分析；非标准或其他历史 DDL 会保守拒绝。合法短串的原始文本表示不会保留，只保留覆盖读取语义；异常串需由后续人工检查处理。
