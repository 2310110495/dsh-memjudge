# 异步 facts 重建阶段报告

## 修复

- 异步提取开始前捕获请求序号、内存 facts 修订号、SQLite 同连接 `total_changes()`、跨连接 `PRAGMA data_version` 和有序 `(rowid,id,text)` 快照。
- 结果在独立容器构造；持 `BEGIN IMMEDIATE` 写锁再次校验版本与快照，通过后单次交换容器引用。过期抛出 `hybrid rebuild snapshot stale`，现有 facts 保持原样；最新请求取代先前请求，即使最新请求失败也不会允许旧请求随后发布。
- 关闭后异步调用明确失败；提取异常或结果形状错误不会清空原 facts。清理失败使 store 进入故障状态。同步重建及 `dropFactsOf` 推进修订号。
- `extractHybrid` 选项供合成测试注入异步提取器，生产默认仍使用原有提取函数。未改动 facts 迁移保护和 segments 补丁。

## 验证

运行 `node --test test/facts-hybrid-stale-synthetic.test.mjs test/facts-forget-guard-synthetic.test.mjs test/facts-forget-boundary-synthetic.test.mjs test/segments-v2-migration-synthetic.test.mjs`：47 项通过，0 项失败。新测试覆盖提取期间 put、并发请求乱序、删除与 rowid 重用、另一连接修改、关闭、无效结果及提取异常。只使用内存库和自动删除的临时合成库，未执行旧入口测试或访问网络、真实配置、数据库及密钥。

## 能力边界

- 版本检查是保守的：同连接任意 SQL 写入或其他连接任意提交都可能使结果过期，即使与 memories 正文无关。调用者需显式处理失败并决定是否重试，持续写入时可能持续过期。
- 写锁保护检查与发布期间的跨连接提交；锁释放后的外部写入不会自动更新本连接的内存 facts。现有 `raw()` 写操作也不会自动维护派生层；这属于 store 全局持续同步能力，非本次修复范围。
- `total_changes()` 依赖 SQLite 连接内写入计数，快照比较另行覆盖最终正文变化；直接篡改数据库文件或绕开 SQLite 锁协议未获保障。
- 构造阶段需要完整 facts 和有序快照的额外内存；没有新增容量上限。合成提取器只验证存储并发协议，未验证网络模型服务品质或输出语义。

## put 投影隔离阶段报告

- 新插入的规则 facts 先写入复制的投影，提交成功后整体替换；事务失败时回滚并保留原投影，避免无条件规则重建抹掉 LLM 独有事实。提交结果不确定、回滚失败或回滚后仍在事务内时将 store 标记为故障。
- put 在调用方已有事务时明确报错并保留该事务；此前 BEGIN IMMEDIATE 也不支持嵌套事务，但报错内容发生变化。复制投影增加每次新插入的时间和内存开销。
- 命令 `node --test test/facts-hybrid-stale-synthetic.test.mjs test/facts-hybrid-publication-bounds-synthetic.test.mjs test/facts-hybrid-cleanup-contract-synthetic.test.mjs`：18 项通过；使用合成提取器与内存库或新临时数据库。
- 本阶段未覆盖 raw 同连接写入、外连接提交后的持续同步、删除后 rowid 重用、各 facts 消费入口的失效检测；不应视为完成事实一致性。put 复制现有投影不证明它与数据库一致。混合事实安全对账需要保留未变行的 LLM 投影并识别变动行，不能直接规则全量重建宣称完整。
- 未修改历史 facts 启动保护、向量和重排；未运行旧入口测试，未主动读取真实配置、数据库、密钥或访问网络。

## 版本日志

- 2026-11-06，未指定正式版本号：隔离 put 事务内 facts 构造与提交后发布；保留回滚前混合投影；补充两项合成回归。完整的 raw 和跨连接一致性仍待后续阶段。
