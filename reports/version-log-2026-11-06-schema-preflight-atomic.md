# 版本日志：数据库版本预检与原子迁移

- `src/store.mjs`：同连接写事务内前置验证版本及基本结构，迁移与版本更新整体提交或回滚；保留原日志模式。保留此前未提交的 put kind/tier 修改。
- `test/schema-preflight-atomic-synthetic.test.mjs`：新增 16 项独立合成测试，覆盖未来与非法版本、识别范围、故障回滚、WAL、锁和重开。
- `reports/stage-2026-11-06-schema-preflight-atomic.md`：记录测试命令、实测范围、日志模式变化及兼容限制。
- 白名单环境运行新增测试和既有独立 kind/tier 合成测试，共 54 项通过；未运行旧入口测试。
