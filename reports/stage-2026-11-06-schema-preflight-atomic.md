# 数据库版本预检与原子迁移：合成验证

## 实现

`open()` 在同一 SQLite 连接执行 `BEGIN IMMEDIATE` 后读取 `sqlite_master` 和 `meta.schema_version`，随后在同一事务中执行 DDL、occurrence 回填、kind/tier 修复、段迁移、旧派生表清理及版本写入，成功后提交；异常路径回滚并关闭连接。未来版本和非规范正整数字符串版本在迁移前报错。支持数字版本 1–7；有版本库还要求 memories 具备九个基础列名，此检查并非来源证明或完整结构验证。

无版本只接受空库或与 `test/occurrences.test.mjs` 已读历史夹具一致的单 memories 表列签名；其余形态报错。签名匹配也可能是陌生数据库，额外索引、触发器、其他历史结构即使有效也会被拦截，存在明确兼容代价。已知旧失败注入夹具含额外对象，因而也不再走原来的迁移分支；旧测试未运行。未来需要产品决策与历史样本证据才能扩大范围。

不再强制 `journal_mode=DELETE`，保留连接所见现有模式；新库在本机测试默认为 DELETE，既有 WAL 保持 WAL。这是行为变化，WAL 辅助文件及体积统计可能受影响。打开路径仍可能创建父目录及空文件；WAL 关闭时的检查点和文件层面变化不在逻辑回滚保证之内。迁移提交之后的内存 facts 重建和后续语句准备不属于迁移事务，启动后续步骤失败时已提交迁移不会回滚。

## 实测

Node v24.22.1，以下命令 54 项通过：新迁移合成测试 16 项、原有独立 kind/tier 合成测试 38 项。每个磁盘夹具使用独立临时目录，关闭后清理；只导入 store 模块，未运行旧入口测试，未主动读取真实配置、数据库、密钥，未主动联网。环境采用系统变量白名单，不等于系统级网络封锁或完整系统调用审计。

```sh
env -i PATH="$PATH" SYSTEMROOT="$SYSTEMROOT" WINDIR="$WINDIR" SYSTEMDRIVE="$SYSTEMDRIVE" TEMP="$TEMP" TMP="$TMP" COMSPEC="$COMSPEC" node --test test/schema-preflight-atomic-synthetic.test.mjs test/store-kind-tier-upgrade-synthetic.test.mjs
```

覆盖 DELETE/WAL 的未来版本、六种非法版本、未知有版本和无版本结构、已知无版本单表、空库、重复打开、同进程双连接写锁竞争、WAL 成功迁移，以及 kind 更新触发器故障时 occurrence 和新建 vector_blob DDL 回滚。故障恢复后可获取写锁。

未覆盖每个迁移步骤的故障、提交期间崩溃、真实磁盘故障、多进程与不同 SQLite/Node 版本、外部不遵守锁协议的替换、字节级不变或所有历史库。版本结构检查仅检查基础列名，不能排除伪装为兼容结构的陌生库；已有版本库的派生表清理行为仍存在。原旧迁移合成测试记录的是修复前缺陷，仍保留而未执行，断言与新行为相反。
