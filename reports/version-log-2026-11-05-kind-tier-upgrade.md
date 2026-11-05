# 版本日志：重复写入升级层级一致性

- 历史初次修复：更新 `src/store.mjs`，重复文本从 event 升为 person/promise 时，在原事务中将 tier 同步设为 1；该“仅升级”描述已由下述后续修复取代，显式降级语义保持原样。
- 新增 `test/store-kind-tier-upgrade-synthetic.test.mjs`：仅用内存 SQLite，6 项通过。
- 新增阶段报告 `reports/stage-2026-11-05-kind-tier-upgrade.md`。测试边界：未运行旧测试、插件入口、真实数据库或迁移验证。

- 独立复核修正：重复写入根据有效 kind 钉住 person/promise，修复同连接脏行并确保返回值与持久值一致；event 降级语义保持不变。
- 扩充指定 synthetic 测试至 11 项，清洁环境内存 SQLite 全部通过，覆盖非法分类与事务失败回滚。

- 重复 event 未提供有效 tier 时，返回值按既有 `normalizeTier` 与 list 对齐，持久层不改写；保留正常层级和现有 kind/tier 输入判定。
- 指定内存 synthetic 测试扩充至 25 项，清洁环境全部通过；覆盖越界、小数、文本脏值、正常值及 null、空串、空白输入。真实库和入口未验证。

- 物理类型复核：`Uint8Array([1])` 经 `Number` 转换为 1，旧逻辑使 person/promise 的 BLOB 留存；重复写入现以严格比较修复为 SQLite integer 1，event 原语义保持。指定内存测试扩充至 38 项，修复前 36 通过、2 失败，修复后全部通过；覆盖 BLOB、文本、实数、整数、INTEGER affinity 和 SQLite `typeof`。真实配置、数据库、密钥、网络、入口、旧测试及迁移均未触及。
