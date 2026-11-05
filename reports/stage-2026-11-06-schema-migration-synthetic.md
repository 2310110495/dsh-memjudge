# 数据库迁移独立合成实测

## 范围与隔离

只导入 `src/store.mjs`，未运行插件入口或旧测试。静态导入链为 `store.mjs` → `schema.mjs`、`extract.mjs`、`conflict-scan-v2.mjs`、`text-wellformed.mjs`，以及 `judge.mjs`、`conflict-snapshot.mjs`；检查显示数据库打开位于函数调用内，`schema.mjs` 为常量及函数定义。此检查不是系统级文件或网络访问审计。未读取真实配置、数据库或密钥；未主动联网。环境使用列出的系统变量白名单，未启用操作系统级网络封锁。

每项测试用 `mkdtempSync` 创建独有临时目录和 SQLite 文件，关闭连接后删除该目录。测试数据、表和触发器均为合成。测试不修改生产源码。

## 结果

- Node v24.22.1，2 项通过、0 失败。
- 基于当前 schema 的合成库设版本 `999`、非法 kind、tier `9` 和带数据的 `facts` 表。`open` 返回成功后版本变 `7`、kind 变 `event`、tier 变 `5`，`facts` 表消失。这是此特定形状未来版本库的观察，非对所有未来 schema 形状的推断。
- 在合成版本 `6` 库中，移除 occurrence 标记和行，设置非法 kind，再创建 `BEFORE UPDATE OF kind` 触发器以 `RAISE(ABORT, 'synthetic migration fault')` 注入故障。`open` 抛出预期错误；重新连接后版本仍为 `6`，但 occurrence 标记和一行 occurrence 已提交，kind 仍为非法值。后续连接的 `BEGIN IMMEDIATE; ROLLBACK;` 成功，表明此案例未遗留阻塞写锁。
- 失败注入发生在 kind 更新，并非每个迁移步骤；本试验未覆盖其他失败点、并发、WAL、不同 Node/SQLite 版本、意外终止或数据库字节级变化。触发器是在数据库内构造的真实 SQLite 故障，不代表磁盘故障。

## 命令

工作目录：`D:/cursor项目组/4/memjudge-plugin`。成功命令：

```sh
env -i PATH="$PATH" SYSTEMROOT="$SYSTEMROOT" WINDIR="$WINDIR" SYSTEMDRIVE="$SYSTEMDRIVE" TEMP="$TEMP" TMP="$TMP" COMSPEC="$COMSPEC" node --test test/schema-migration-isolated-synthetic.test.mjs
```

首次尝试使用 `SystemRoot="$SystemRoot"`（大小写与现有变量不符），Node 启动时 `Assertion failed: ncrypto::CSPRNG(nullptr, 0)`，退出 134，测试未执行；换为上述系统环境白名单后成功。未修改任何已有工作树差异。
