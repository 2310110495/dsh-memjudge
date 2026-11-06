# 快照与冲突扫描异常值修复

## 发现与修复

`contentSnapshot` 与 `scanConflictsV2` 以 `failure !== undefined` 判断是否出现异常，而 JavaScript 允许 `throw undefined`。快照会将该异常误当成功；两者在原异常为 `undefined` 且清理抛错时均会丢失原异常。两个函数现用独立布尔状态记录异常是否发生，异常原值保持不变，双重失败时按原有顺序进入 `AggregateError.errors`，并保留 `cause`。

## 验证

Node.js v24.22.1：`node --test test/snapshot-scan-undefined-synthetic.test.mjs`，16 项通过。使用空内存数据库和合成提取器，包装连接方法注入 `throw undefined`、普通原错误、回滚前抛错、回滚后抛错、快照静默回滚失败，以及成功操作后的单独清理错误。验证异常身份、聚合顺序、事务状态、快照故障状态及扫描重入锁释放。空库快照不调用默认提取器；未使用真实配置、数据库、密钥、网络、向量或旧入口测试。

## 边界

扫描函数原有行为未扩大：`BEGIN DEFERRED` 包装器在实际开启事务后抛错时，`started` 仍为假；回滚静默失败也无事务状态复核。两种事务清理场景与本次 `undefined` 判定修复独立，尚未修复或测试。快照读取前的选项和版本检查发生在事务异常处理之外，异常直接向上传播。本测试不覆盖磁盘并发或真实提取数据。
