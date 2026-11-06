# 数据库版本写入回滚验证（2026-11-06）

针对初始化事务中 schema_version 的 UPDATE 与 INSERT，分别在 SQL 实际执行成功且影响一行后注入故障。合成夹具比较 sqlite_master、meta、memories、segments 和 memory_occurrences 的所选快照，并以新连接获取 BEGIN IMMEDIATE 写事务锁。两个分支均带 memory_occurrences 哨兵行。

目标测试文件 28/28 通过；加入哨兵前的独立复核在精简环境下运行四份相关合成测试，63/63 通过。上述两次运行不是同一组测试结果；新增哨兵后的目标测试进程环境未作系统级隔离。

该验证覆盖当前 Windows、Node.js v24.22.1 和默认 DELETE 日志模式；写锁重新获取不证明旧连接对象已关闭，选定表快照不证明整库所有数据均回滚，WAL、多进程故障、物理故障和真实宿主未验证。未运行旧入口测试。
