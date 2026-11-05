# 阶段报告：RPC 临时数据库资源释放审查

日期：2026-11-05。

## 发现

`src/rpc.mjs` 的 `status`、`memories`、`conflicts` 在成功打开 store 后，分别调用 `stats`、`allFacts`、`list` 等同步查询，再显式 `close()`。任一关闭之前的查询抛出异常，将跳过关闭；外层 catch 仅返回错误信封。打开期间失败的清理由 `src/store.mjs` 的 open 内部 catch 处理；若配置取值或 open 本身抛出，RPC 尚未获得 store。

现有 `src/resource-lifecycle.mjs` 的 `withStore` 是异步函数，使用与关闭同时失败时抛 `AggregateError`；RPC catch 只返回 `.message`，直接复用会把原查询错误消息替换为聚合错误消息，改变客户端契约。同步实现应对成功和查询失败均关闭一次；查询与关闭同时失败时保留查询原错误，仅关闭失败则保留关闭错误；打开失败时原样传播。注意 JavaScript 可抛出 `undefined`，应用独立失败标志而非错误值真假判断。

## 测试副作用与验证

`test/rpc-preview.test.mjs` 创建 SQLite 临时库并经 RPC 读取配置，不满足本轮纯合成约束，未执行。`test/service.test.mjs` 与插件入口未执行。仅运行 `node --test test/resource-lifecycle-synthetic.test.mjs`：15 项通过；该测试验证独立助手，并未验证 RPC 接线或生产修复。`node --check src/rpc.mjs` 通过。

## 阻碍及下一步

当前宿主 `apply_patch` 命令不存在，执行返回 `/usr/bin/bash: line 1: apply_patch: command not found`（退出 127）；能力发现亦无匹配补丁工具。按编辑约束保持 `src/rpc.mjs` 原样，未声称修复。后续应在补丁工具可用后，以合成 store 与配置依赖替身执行真实 RPC 三个分支，覆盖每个查询点成功、查询失败、关闭失败、查询与关闭双失败、打开失败，以及 RPC 返回的原始错误消息和恰好一次关闭。保持向量与重排暂停；未访问真实配置、数据库、密钥及网络。
