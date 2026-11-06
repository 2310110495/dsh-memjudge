# Raw host 清理阶段报告

## 结果

- worker 首次清理同步撤销活动状态、触发 abort 和取消定时器，并缓存同一 Promise；等待在途操作后依次尝试关闭仓库、租约和释放交接，汇总失败。
- 外层 stop 缓存同一 Promise，同步撤销策略并启动所有 worker 与 injection 清理，等待全部结果并汇总失败；已先行启动的 worker 清理仍被收集。直接同步重入返回同一 stop Promise 时避免等待自身。
- 保留 worker 清理记录以便 stop 收集既有结果；长期反复重建 worker 会增加记录数量，属于后续需要评估的生命周期成本。

## 验证

- `node --test test/raw-host-cleanup-synthetic.test.mjs`：4 项通过，覆盖在途读取、重复调用、worker 关闭失败与 injection 同步抛错聚合、同步重入、异步 rejection 和同步 abort。
- `git diff --check -- src/raw-host-adapter.mjs test/raw-host-cleanup-synthetic.test.mjs`：通过，Git 提示现有行尾转换警告。
- 使用合成 backend、受控临时目录及合成模块文件，未访问真实配置、真实数据库、密钥或网络，未使用默认提取器。
- `index.mjs` 将适配器 stop 注册到资源作用域，作用域会等待清理返回值；宿主是否等待整个插件卸载尚未验证，因此本阶段不声称完整卸载。
- 未执行依赖宿主路径与旧入口的现有集成测试；未修改 store/index。
