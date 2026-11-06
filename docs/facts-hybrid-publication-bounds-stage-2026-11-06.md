# 混合事实重建：发布与边界阶段报告

## 范围与契约

只调整 `rebuildFactsHybrid` 的派生事实发布与边界检查，未改向量、重排或既有其他工作。真实提取器源码显示，偏移是 JavaScript 字符串的 UTF-16 代码单元；规则提取器将单位并入 value，sent 必须来自原文；混合结果可能混合规则及 LLM 事实。仅包含 attr/value 的合成提取器结果仍受支持，偏移按现有默认值处理。

## 修复

在 BEGIN IMMEDIATE 获取锁并复核版本和行快照后、ROLLBACK 释放锁前替换 memFacts 引用，事务窗口内对公开存储方法启用重入闸门。回滚抛错或仍处于事务时，恢复旧引用并沿用故障隔离和聚合错误处理。检查 at、sentOff、sentLen 的非负安全整数及原文边界，显式 sent 必须匹配指定区间；长度按 UTF-16 计算。

边界：同连接公开接口的同步重入被闸门阻断；raw() 是诊断连接，不承诺阻止调用方直接执行 SQL。跨连接写入在锁持有期间由 SQLite 控制，锁释放后的外部写入并不会自动刷新本连接内存事实，这是既有同步边界，不声称解决。

## 验证

执行 `node --test test/facts-hybrid-publication-bounds-synthetic.test.mjs test/facts-hybrid-cleanup-contract-synthetic.test.mjs test/facts-hybrid-stale-synthetic.test.mjs`，16 项通过。测试全部注入合成提取器；数据库为内存或临时合成库。新增用 db.exec 包装重现回滚后同步 put，并覆盖 UTF-16、边界、缺省及句子区间。既有合成测试覆盖回滚失败、未结束事务、提取期间改写和跨连接改写。

独立审查先前在 env -i 下调用默认提取器返回 llm，可能间接触及本机配置或网络；该次运行不计入隔离验收。本次验收未调用默认提取器或旧入口测试。
