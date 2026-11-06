# 历史 facts 遗忘闸门报告

## 结论

自动迁移暂不开放：当前遗忘事务不清理持久 `facts`，保留该表并允许打开会让已遗忘内容留存。本次变更对所有含持久 `facts` 表的库在启动预检中报错并回滚，包括空表、真实 v1 TEXT、后续 INTEGER 和伪装结构；不会改变表、索引、行或 SQLite 存储类型。这是有意的兼容性损失，不是历史兼容迁移完成。

## 历史与路径证据

- Git `e7e0abc:src/store.mjs` 第 222–250 行：v1 有 `meta`、`memories`、`ux_memories_hash`、`facts`、`ix_facts_key`；`facts.memory_id TEXT NOT NULL`，其余依次为 `entity TEXT, attr TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, unit TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL`，索引为 `CREATE INDEX IF NOT EXISTS ix_facts_key ON facts(key)`。该提交第 275–276 行写入 schema 版本。
- Git `30b0f7e:src/store.mjs` 第 330–339 行有后续 `memory_id INTEGER NOT NULL` 形态；其余 facts 列相同。两种关联键含义不同，不应只替换声明类型。
- 当前 `src/index.mjs` 的 `memjudge_forget` 在一个事务中删除 `segments` 和 `memories`，提交后重建内存 facts；源码范围搜索未发现其他 `DELETE FROM memories` 或 `DELETE FROM facts`。`src/store.mjs` 的 `dropFactsOf` 仅清理内存映射。
- 合成内存库直接执行现有内存删除 SQL，验证 memory 行消失后 facts 中的 `sensitive sentinel` 仍存在。该实验验证 SQL 层结果，未运行旧入口，也未调用真实配置、数据库或网络。

## 验证

- `node --test test/facts-forget-guard-synthetic.test.mjs test/schema-migration-isolated-synthetic.test.mjs test/schema-preflight-atomic-synthetic.test.mjs`：33/33 通过。包含 TEXT 与 INTEGER 事实、索引、BLOB 值、重复打开、数据与类型快照及锁释放。
- `node --test test/segments-v2-migration-synthetic.test.mjs test/index-segment-preflight-synthetic.test.mjs`：42/49 通过。7 项沿用既有未提交测试中允许持久 facts 迁移、要求到达后续迁移故障或要求旧报错的假设；新闸门在这些阶段之前终止。未更改现有段表补丁及其测试。

## 后续

在开放迁移前，设计并验证按真实 TEXT id 与历史 INTEGER rowid 分别关联、同一事务删除事实和记忆的方案；处理孤儿、类型异常、重复打开、回滚故障及所有删除入口，并对表、索引和约束进行精确验证。独立评估历史 facts 与当前 L1 重建语义差异，避免以派生事实冒充历史原值。
