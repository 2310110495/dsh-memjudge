# 合并后数据库预检与 v2 覆盖位迁移：独立合成阶段报告

## 结论

2026-11-06 对当前工作树运行四份指定合成测试：74 项通过，0 项失败、跳过或取消。运行的是测试时的现存文件，并非提交版本；本阶段未修改生产代码或已有工作树。测试前后 `src/store.mjs` 和四份测试文件的 SHA-256 均一致，但这仅证明这五份文件在两次采样时相同，不能排除中途短暂变化，也不证明其他依赖未被并发修改。

## 范围与结果

- `schema-preflight-atomic-synthetic`：26 项，涵盖未知结构、未来及非法版本、伪造触发器、旧 facts 和三种字典、回滚、锁竞争和 DELETE/WAL 模式。
- `schema-migration-isolated-synthetic`：2 项，验证未来版本及未知触发器遭拦截后的数据保留。
- `segments-v2-migration-synthetic`：8 项，验证覆盖位与磨损值重复打开后保留，畸形行、布局及写入故障回滚。该组通过内存 SQLite 及模块加载钩子注入故障。
- `store-kind-tier-upgrade-synthetic`：38 项，验证去重升级、固定层级、物理类型修复及 occurrence 故障回滚。

测试在临时合成 SQLite 文件或内存数据库运行，仅调用存储模块，未运行旧入口测试；未主动读取真实配置、数据库或密钥，未主动联网。上述限制依赖测试代码和调用路径检查，并非系统级文件访问或网络审计，亦未采用系统级网络封锁。

当前预检对含旧 `facts`、`str_dict`、`entity_dict`、`attr_dict` 的库采取保守拒绝，而非清理或迁移；未知触发器、伪造规范触发器以及未知库也会拒绝。测试证明对应合成样本保留，不证明所有历史库均兼容；真实宿主、真实历史数据库、生产配置及旧入口均未验证。崩溃断电、磁盘故障、多进程竞争、所有历史形态和所有故障点也未覆盖。此报告取代本次合并状态的旧阶段结论，不改写历史报告。

## 验收阻断与审查发现

历史只读调查更正：`1554238` 是 v3，而非 v4；`30b0f7e` v2 与 `1554238` v3 的真实建库均含 `facts`，当前预检会拦截该形态。Git 可达历史中未发现 v4 定义，这一结果仅适用于已检查的可达历史，并非对所有历史来源的断言。v2 合成夹具缺少 `facts`，因此 74 项通过不证明真实历史库兼容。上述为审查发现，本阶段合成测试记录不变；历史兼容仍为待修验收阻断。

独立审查还指出陌生索引归属及生成列检查存在缺口，均为待修验收阻断；其影响范围和修复效果仍需针对性验证。另有协作代理报告 `COMMIT` 在后续语句 `prepare` 之前，若后者失败，迁移已经提交；本阶段未独立复现，应继续核验，现有结果不证明整个启动过程具有原子性。

## 环境与命令

Node `v24.22.1`；使用 `env -i`，显式设置 `SYSTEMROOT=C:\WINDOWS`、`TEMP`、`TMP`、限定 `PATH`。在实际 Node 进程中确认 `SYSTEMROOT=C:\WINDOWS`；Git Bash 启动 Windows 子进程另带入 `MSYSTEM=UCRT64` 和 `WINDIR=C:\WINDOWS`，因此实际环境不是严格仅含四个变量。没有继承应用配置或密钥变量。工作目录为 `D:/cursor项目组/4/memjudge-plugin`：

```sh
env -i SYSTEMROOT='C:\WINDOWS' TEMP="$TEMP" TMP="$TMP" PATH='/c/Program Files/nodejs:/usr/bin' node --test test/schema-preflight-atomic-synthetic.test.mjs test/schema-migration-isolated-synthetic.test.mjs test/segments-v2-migration-synthetic.test.mjs test/store-kind-tier-upgrade-synthetic.test.mjs
```

`src/store.mjs` 测试前后 SHA-256：`c83182065915bde7b47c4d1b2e429a03a4fe5ce74677f532b4a121eb64a21947`。四份测试文件前后摘要依次为 `2a9ad32a3603123a6bce23c3a03eda12142053f75f5290948cdc0117f8877d84`、`b2bcb2cdc167499614a0eaf80313cb4304b3a55f8c2256b3848b51f6ad917853`、`a6e3128b54dc1f5fcb00655663c3739c55e6ebe4af402fee79b425c19b4b3655`、`d9234aa6d793bb777c43a8c0eaca40d0441e4ffb2c64fdc28ff5842516bf8a4c`。
