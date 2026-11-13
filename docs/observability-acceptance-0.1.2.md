# 0.1.2 观测版本验收记录

## 独立审查与修复

- 首轮 code-reviewer 找到 P1：注入识别 session.header.id，但生命周期清理只认顶层 id。已统一生命周期、采集器和 pending query 的 header.id 回退。
- 新增 header-only 会话 compaction/end/dispose 回归：压缩清观测与动态去重但保留冻结 S；结束/释放清观测并删除引擎 session。
- 未完成 S/D 配对在微任务边界失效，避免放弃的静态测量与后续 context refresh 错配。实际打包宿主 SystemPrompt.assemble 同步调用 sections/contexts 后才 await waterfall；refreshContext 可以单独重跑动态上下文。不推断跨异步回调属于同一帧。
- 前端逐项审核：React 文本渲染，无 raw HTML；完整记忆/修订懒加载要求精确 ID+空间，切换空间丢弃过期响应；无已验证会话身份时不显示注入正文或活动。

## 自动化验收

Node 24.22.1，隔离 DSH_HOME（observability-isolation.mjs 预加载）：

```text
node --import ./test/observability-isolation.mjs --test test/observability.test.mjs test/observability-host.test.mjs test/observability-client.test.mjs test/v2-client-panel.test.mjs test/v2-migration-backup-fsync.test.mjs test/v2-store-schema-v8.test.mjs test/rpc-fetch-routes.test.mjs test/rpc-preview.test.mjs test/v2-search-inject.test.mjs test/inject-surrogate.test.mjs
69 tests / 69 pass / 0 fail / 0 skip
```

实际打包 Cordis、SystemPrompt、ToolsService、HostConnectionService 的 shared Fetch handler 隔离验证：status/memories/conflicts HTTP Response 200 + ok:true；8 条路由；非 owner 403；错方法/未知路由404；dispose 后0条路由。使用合成已准入 peer，没有启动HTTP监听，也没有验证真实GUI登录。

## 限制与待验

- 不等于全测试套件通过：旧 v2-host-wiring-rpc.test.mjs:241 自动落库异步断言仍为已披露基线失败。
- 当前安装仍0.1.1；没有覆盖活动数据库或配置。
- 尚无真实浏览器视觉/会话身份验收，暂不宣称已安装加载、注入正文/会话事件在实际UI可用。
- 二轮独立 code-reviewer 窄范围复核：P1 CLOSED，无新增阻塞；重新运行后端 14/14 通过。不是全套测试验收。
- 隔离升级演练结果单独保存在发行目录 rehearsal-result.json；本文件不预先宣称安装演练成功。
