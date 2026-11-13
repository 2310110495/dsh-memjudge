# Windows 安装后面板读取失败：迁移备份 fsync

## 结论与影响范围

410c492 的磁盘旧库升级路径存在确定性 Windows 兼容性错误。迁移先用 VACUUM INTO 生成并校验快照，再用 fs.openSync(snapshotPath, 'r') 获得只读句柄并执行 fs.fsyncSync(fd)。Windows 的 FlushFileBuffers 要求句柄具备写权限；真实文件调用抛出：

	Error: EPERM: operation not permitted, fsync
	at Object.open (.../src/store.mjs:772:20)
	at Object.storeFactory (.../src/index.mjs:426:74)
	at new apply (.../src/index.mjs:472:16)

具体错误为 `EPERM: operation not permitted, fsync`。发生点位于备份原子发布、迁移 DDL 和 RPC 安装之前。因此后端插件启动中断，8 个面板端点均未注册；客户端资源仍可能加载，最终只显示泛化“读取失败”。这不是匿名请求 401 所能证明的鉴权问题。

影响不是此用户专有：Windows 上具有需要迁移的非空旧库、默认开启迁移备份的用户会走同一路径。全新空库跳过该分支；不能声称所有平台、所有新装均失败。

## 修复

src/store.mjs 将快照句柄模式改为 r+，获得 fsync 所需权限而不截断快照。仍保留快照完整性检查、fsync 错误即终止、原子无覆盖硬链接发布、迁移锁和并发提交检测。没有跳过 fsync，也没有关闭备份。

## 实证（2026-11-13）

- 从安装程序 ASAR 正常解包真实 Cordis 4.1.0、SystemPrompt、ToolsService、HostConnectionService 及依赖，构建隔离 DSH_HOME；不启动替代 GUI，不获取凭据、不绕过鉴权。
- 修复前：真实服务 + 空库启动成功、8 条 exact Fetch 路由存在；同一程序改为旧库安全副本，退出码 1，得到上方 fsync EPERM。这排除了“所有路径非法/所有真实 Cordis owner 接线必坏”的猜测。
- 旧库只用 CAS 文件复制获得，复制时 SHA-256 为 9182d48e300854db4eb4171d9335b78f7916331d5e982e93c57d926e4b299390。只迁移副本，未打开可写真库。
- 修复后同一副本启动退出码 0，8 条路由注册，直接调用注册的 status 返回 ok:true / schemaVersion:8，memories 返回 HTTP 200 / ok:true。调用的是进程内已注册处理器，**不是**真实 GUI 的 HTTP 鉴权验证。
- 副本迁移前备份与迁移后库均为 123 条记忆，按 id 排序的 id/text JSON SHA-256 同为 577502fd9f58f8529ae3e64bf81de5eff5a0447fbd6f785c805c09d8f60ae9be；两库 integrity_check 均 ok。无正文进入报告。
- 排障后真库仍为 225280 字节，SHA-256 仍为上述 9182…9390，修改时间毫秒值仍为 1794570012054。

## 回归

新增 test/v2-migration-backup-fsync.test.mjs 四项：真实磁盘旧库迁移/可读备份/幂等重开；非截断可写句柄与先 flush 后发布的顺序；注入 fsync 失败后旧库不迁移、无不安全备份且清理临时快照；既有备份不覆盖。

修复前四项中两项失败（真实 EPERM、句柄 r 不等于 r+），退出码 1。修复后四项全过。

使用随客户端提供的 Node 执行：

```text
node --test test/v2-migration-backup-fsync.test.mjs test/v2-store-schema-v8.test.mjs test/rpc-fetch-routes.test.mjs test/v2-client-panel.test.mjs
```

结果 26/26，退出码 0。

额外执行 test/v2-host-wiring-rpc.test.mjs 得到 3/4、退出码 1，首项在 :241 的“主会话闭合轮应自动经 turn-collector + distiller 异步落库”断言失败。同一文件在 git archive HEAD 得到的未修改 410c492 隔离基线也以完全相同断言失败（3/4，退出码 1），因此不是本次 r+ 修改引入；未将其悄悄跳过或宣称全套测试通过，本次不扩展修复自动采集行为。

## 补充：真实共享 Fetch 分发契约

执行隔离脚本 F:/记忆库/临时验证/host-contracts/shared-fetch-check.mjs，使用实际安装归档提取的 HostConnectionService.createSharedFetchHandler('/api')，而非直接调用 route.fetch。结果退出码 0：status/memories/conflicts 均 HTTP 200 / ok:true；status 的 schemaVersion 为 8；非 owner 主体返回 403；错误方法与未知路径返回 404；插件 dispose 后 8 个 exact 路由全部移除，原路径返回 404。

此测试使用独立临时 DSH_HOME 和已迁移副本的临时副本，结束即清理；只构造“已经鉴权的主体”测试夹具，没有 HTTP 监听器、没有访问真实客户端凭据，也不证明真实浏览器 Cookie 或 GUI 页面已验收。原数据库摘要、大小、修改时间再次核验未变。

## 未验证/未操作

没有读取真实宿主当前 fiber diagnostic，未重启/终止宿主；没有改活动安装包、profile 或真实记忆库。当前修复只在源仓，尚未部署到真实 GUI。上述实证确认的是实际旧库副本上的启动阻断及其修复，不应写成真实 GUI 已恢复。发布更新包并由用户正常重启后，仍需真实面板加载验收。
