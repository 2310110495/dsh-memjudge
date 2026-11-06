# Raw host 清理边界阶段报告

## 实施

- `src/raw-host-adapter.mjs`：首次正常路径 `handle.close()` 抛错后仍执行 finally 重试；若重试也失败，两个原始抛出值按先后直接放入 worker 清理 AggregateError。第二次成功时维持既有可恢复行为。
- 安全读取异常的 `message`，避免抛出值为 null、undefined 或具有抛错 getter 时中断本次会话的清理和诊断。
- 前驱失败用独立布尔量记录，避免拒绝原因为假值时误认成功；保留既有租约锁定和前驱传播策略。
- `ctx.inject` 回调后同步抛错的既有清理路径保持不变，新增 undefined 抛出值夹具验证 worker 清理及后续租约重获。

## 验证

- `node --test test/raw-host-cleanup-boundaries-new-synthetic.test.mjs test/raw-host-cleanup-synthetic.test.mjs test/raw-host-cleanup-convergence-synthetic.test.mjs`：13 项通过。
- 新增测试使用新建临时目录、合成模块、合成 backend 和合成数据库；验证两次关闭分别抛出 undefined 与带抛错 message getter 的对象，两个值均到达 stop，租约保持锁定。
- `git diff --check -- src/raw-host-adapter.mjs`：通过，Git 提示工作树行尾转换警告。
- 未访问真实配置、真实数据库、密钥、网络、默认提取器或旧入口测试。目标文件及其他已有改动均保留。

## 异步 disposer 循环

现有 stop 等待 disposer Promise；disposer 异步调用并等待同一个 stop Promise 时，两者形成循环。现有受控门闩夹具证明循环：门闩释放前 stop 保持未完成，释放后才完成；这不是超时完成证明。

可验证的修复方向是明确拆分 worker 清理阶段和完整 stop 阶段，并为 disposer 内发起的重入调用提供仅等待 worker 阶段的独立句柄；外部调用继续等待完整 stop 和 disposer 结果。调用上下文可通过 AsyncLocalStorage 标识，但会改变重入返回 Promise 的身份与语义，且继承上下文的异步子任务须明确契约；也可修改宿主接口显式传入 worker 阶段句柄。验证须覆盖 disposer 跨 await 后等待重入、外部 stop 等待 disposer 完成、disposer 抛错完整传播、并发外部调用和上下文泄漏；不能以超时或丢弃 disposer Promise 冒充完成。本阶段未实施该契约变化，也未验证真实宿主卸载是否等待异步清理。
