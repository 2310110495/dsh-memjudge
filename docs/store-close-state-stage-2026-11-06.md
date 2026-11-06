# Store 关闭状态机阶段报告

- 关闭状态为 OPEN、CLOSING、UNCERTAIN、CLOSED；只有底层关闭正常返回后才进入 CLOSED。
- 底层抛出任意值（包括 undefined）原样传播，进入 UNCERTAIN：普通 API 禁用，close 仍可重试。底层已关闭后抛错也保持未知，后续重试仍调用底层，不推断连接状态。
- 同步重入 close 明确报错；hybridPublishing 优先阻止 close；已有 store fault 不妨碍 close 清理。raw 仍是既有诊断出口。
- 独立测试使用内存库、合成提取器和连接方法注入，无网络或外部数据库。
- 验证：`node --test test/store-close-state-synthetic.test.mjs test/facts-hybrid-cleanup-contract-synthetic.test.mjs`，12 项通过。
- 并行代理正编辑同一文件的 put 区域，本阶段仅修改关闭状态、assertOpen 和 close；未暂存或提交共享工作树改动。
