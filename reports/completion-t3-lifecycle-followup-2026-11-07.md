# T3 生命周期失败判定与最小修复

日期：2026-11-07
工作树：`D:/cursor项目组/4/memjudge-plugin`
运行时：Node.js v24.22.1

## 结论

资源生命周期四个基线失败均来自测试断言与当前实现语义不符，不构成 `src/resource-lifecycle.mjs` 回归证据。只修订了两份合成测试及其 fixture，生产源码未改。raw cleanup 的旧 fixture 缺少显式 `bounded-jsonl-v1` 合同和 budget，四项因此均在进入业务断言前抛 `raw-explicit-budget-contract-required`；补齐合同之后，四项现全部实际执行并通过。

## 资源生命周期四项判断

基线 `node --test test/resource-lifecycle-synthetic.test.mjs`：15 项，11 通过、4 失败。

1. `cleanup keeps all failures and continues including thrown undefined`：失败后断言旧 close Promise identity 持续不变属于过时断言。实现会恢复失败 disposer 以便再次清理，并在 rejected attempt 上清空 `closing`；重试应返回新 Promise。修订后验证新 Promise 与旧 Promise 不同，且 retry 继续以 `AggregateError` 拒绝，失败信息仍被保留。
2. `returning or awaiting reentrant close fails and remaining cleanup runs`：重入错误使当前 attempt 拒绝；重试应创建新 attempt，而非继续返回失败 Promise。修订后检查新 identity 与 retry 聚合拒绝。
3. `independently started two and three scope cycles settle and run remaining cleanup`：循环使相关 close attempt 失败并恢复失败 disposer；每个 scope 的后续 close 应产生新 Promise。修订仅替换 identity 断言，循环与失败收集断言保留。
4. `unawaited close is conservatively treated as a dependency until disposer ends`：等待目标 disposer 结束后，active frame 置为 inactive 且 dependencies 清空；旧断言要求之后仍由已过期依赖边永久拒绝，语义错误。修订为等待 `b.close()` 成功，验证依赖边随 disposer 生命周期结束。

资源测试最终命令：`node --test test/resource-lifecycle-synthetic.test.mjs`，退出码 0；15 项通过、0 失败。

## Raw fixture 与四项断言

最小 fixture 差异位于 `test/raw-host-cleanup-synthetic.test.mjs`：配置加入 `backend.contract` 和 `implementationContract`，均为 `bounded-jsonl-v1`；补齐与生产策略上限一致的 budget：session 8 MiB、event 256 KiB、events 10000、page 1 MiB、graph nodes 65536、graph properties 32768、code units 2 Mi、header 16 KiB。backend 明确声明 `rawReadContract`、`maxRawReadBytes`、`maxRawEventBytes` 和 `maxRawReadEvents`（4）；未放宽任何生产限制。fixture 的 `ctx.effect` 回调参数名修正为 register 函数，以保持生命周期注册语义。

四项业务断言均执行：

1. in-flight worker 与 stop 共享各自 Promise；stop 后推进事件循环才观测到 abort；关闭等待挂起 read 释放后完成。
2. 注入同步异常与 worker close 异常均在嵌套 `AggregateError` 中保留；失败 worker attempt 清除缓存后 retry identity 不同，retry 仍拒绝。
3. stop 对外重复调用共享 Promise；injection disposer 内重入 stop 命中 `ERR_RESOURCE_SCOPE_REENTRANT_CLOSE`，异常经聚合传播。原题称“synchronous reentry returns the shared promise”不准确：当前执行顺序先清 worker，再调用 injection dispose；stop scope 已处于 active disposer，生命周期层拒绝重入。测试名称改为 `injection reentry closes once and repeated stop shares the promise`，没有移除重入及共享断言。
4. asynchronous injection dispose 在 worker cleanup 后启动；先释放 read gate，再拒绝 injection gate，检查失败原因经 AggregateError 保留。failed stop attempt 被清除后再次 stop 返回不同 Promise。

Raw 测试最终命令：`node --test test/raw-host-cleanup-synthetic.test.mjs`，退出码 0；4 项通过、0 失败。

## RPC 启动模式

Node v24.22.1 下，原命令因 `vm.SyntheticModule` 未启用而无法执行。仅在该测试命令附加 `--experimental-vm-modules`，没有修改全局环境：

`node --test --experimental-vm-modules test/rpc-store-lifecycle-synthetic.test.mjs`

退出码 0；21 项通过、0 失败。输出包含 Node 的 `ExperimentalWarning`；在此启动模式下 RPC 业务断言均实际执行。

## 工作树与边界

最终 `git diff --check` 退出码 0；仅有现存文件 LF 将被 Git 转为 CRLF 的提示。`git status --short` 显示本任务修改只有上述两个目标测试；共享修改仍保留在 `src/content-snapshot-adapter.mjs`、`src/content-snapshot-view.mjs`、`src/disposal.mjs`、`src/index.mjs`、`src/raw-host-adapter.mjs`、`src/raw-ingest-policy.mjs`、`src/raw-namespace.mjs`、`src/raw-repository.mjs`、`src/resource-lifecycle.mjs`、`src/store.mjs`；既有未跟踪 T1/T2 报告与测试、T3 raw 报告及 raw budget 测试也保持原状。未运行真实宿主、旧 runner、数据库评测、真实配置/密钥访问或网络；Node 权限模型不作为 OS 隔离证明。

未测试内容：上述三个窄测试以外的插件测试、真实宿主生命周期及非合成运行路径均未执行。未发现需要生产源码修复的证据。
