# 独立迁移专项合成测试阶段报告

日期：2026-11-06。范围：当前未提交工作树；仅执行七个点名测试文件，未运行旧入口或完整测试集。

## 执行与结果

Node v24.22.1；以下命令在插件目录执行，`d` 是新建的独立临时目录，`w` 是其 Windows 路径：

```bash
d=$(mktemp -d) && w=$(cygpath -w "$d") && env -i PATH="$PATH" SystemRoot="$SYSTEMROOT" SYSTEMROOT="$SYSTEMROOT" WINDIR="$WINDIR" TEMP="$w" TMP="$w" HOME="$w" USERPROFILE="$w" node --test test/segments-v2-migration-synthetic.test.mjs test/schema-preflight-atomic-synthetic.test.mjs test/schema-sql-normalization-synthetic.test.mjs test/index-segment-preflight-synthetic.test.mjs test/prepare-transaction-isolated-synthetic.test.mjs test/schema-migration-isolated-synthetic.test.mjs test/store-kind-tier-upgrade-synthetic.test.mjs
```

结果：103 通过，0 失败，0 跳过，0 取消，退出码 0，耗时 1285.8591 ms。按文件分别为 segments 17、schema preflight 26、SQL normalization 7、index preflight 12、prepare transaction 1、schema migration 2、kind tier 38。

首次尝试误用空的 `$SystemRoot`，Node 在执行测试前报告 `Assertion failed: ncrypto::CSPRNG(nullptr, 0)`，退出码 134；确认实际变量名为 `SYSTEMROOT`，修正后上述命令通过。首次失败后及测试结束后摘要均与测试前一致。

## 隔离边界

`env -i` 清空继承变量，仅设置 PATH、系统目录和指向新建临时目录的 TEMP、TMP、HOME、USERPROFILE；保留的 PATH 与系统目录仍来自宿主。测试使用 `:memory:` 或由 `mkdtempSync` 在独立临时目录下建立的合成 SQLite 文件，测试自身在 finally 中删除各自临时子目录；最外层临时目录未删除。测试直接导入 `src/store.mjs`，未调用旧入口；依赖源码和 Node 可执行文件仍来自当前工作树与宿主。未配置网络命名空间或防火墙，隔离结论来自所选测试及静态导入链的检查，而非系统级网络封锁或系统调用审计；未主动访问真实配置、数据库、密钥或网络。

## 结论与限制

- v2/v3 合成历史数据库中的磁盘 `facts` 表在迁移和重复打开后保持内容、DDL 和 rootpage；故障回滚时也保持。它与从 `memories.text` 重建的进程内 `memFacts` 是不同对象，日志中的 facts 重建不是重写或迁移历史磁盘表。
- 带历史 `facts` 的无版本合成库和未知无版本库按测试预期拒绝且保留数据；已知无版本 memories/occurrences 形状可迁移，不应笼统说所有无版本库都拒绝。
- 测试覆盖合成损坏、迁移原子性、触发器和索引预检、SQL 字面量、写锁、WAL、kind/tier 等所列案例；并未验证真实旧库、所有历史模式、异常断电、完整插件集成及真实配置环境。
- 测试前后分别执行 `sha256sum src/*.mjs test/*.mjs | sha256sum`，结果均为 `10e131218859894963407ac5e5afe0daa62f25a2cd8b4c5ad9c48253dbc8626b`。该摘要仅覆盖顶层 src/test 中的 `.mjs` 文件集合，不代表整个工作树。现存未提交变更保留，未修改生产代码或测试代码。
