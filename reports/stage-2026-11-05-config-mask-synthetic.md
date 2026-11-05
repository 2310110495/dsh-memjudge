# 配置掩码隔离验证

`maskKey` 对非空密钥统一返回 `********`，空值返回空字符串；默认参数仍读取 `llmKey()`。`groupReport` 和 `configReport` 的字段及解析流程保持原状。

独立测试 `test/config-mask-isolated-synthetic.test.mjs` 在系统临时目录内创建专属目录，子进程仅接收 `DSH_HOME`、`MEMJUDGE_NO_SECRETS=1`、空 `PATH`、指向专属目录的 `TEMP`/`TMP`/`TMPDIR`，Windows 还接收 `SystemRoot` 和同值 `WINDIR`；子进程断言环境键集合及 `NODE_OPTIONS`、`NODE_PATH` 等加载变量缺席，再导入 `src/config.mjs`，使用合成凭据与临时配置，结束后仅递归清理本次 `mkdtempSync` 返回的目录。测试覆盖短长值、空值、三组、环境优先级和旧环境别名、禁用与继承、配置报告顶层别名。

父进程加载测试文件发生在上述子进程边界之前，普通启动会继承调用环境；本次在 Git Bash 使用 `env -i "SystemRoot=$SYSTEMROOT" "TEMP=$TEMP" "TMP=$TMP" '/c/Program Files/nodejs/node.exe' --test 'D:/cursor项目组/4/memjudge-plugin/test/config-mask-isolated-synthetic.test.mjs'` 启动父进程，结果 1 项通过、0 项失败。首次验证发现 Windows 启动链自动补入 `PATH` 和 `WINDIR`，严格断言失败；显式固定后重测通过。命令未运行入口或旧测试；测试路径以合成数据及专属临时配置为设计范围，未配置系统级网络隔离，也未通过系统级监控证明无网络或其他外部访问。

仓库消费处 `client.js` 与 `scripts/panel.mjs` 使用 `keyMasked` 展示；本次未运行界面。外部调用方若依赖旧掩码的长度或首尾格式，需要适配；固定掩码失去按展示值区分不同密钥的能力。掩码只涵盖密钥字段：配置端点、模型以及其他字段仍按原语义返回，不代表这些字段或其他接口不会泄漏敏感信息。继承模式中组值取已解析聊天组字段，聊天组禁用并不抹除供继承使用的字段，本次保留这一现有行为。

## 合成来源补充复验

子进程初始仍设置 `MEMJUDGE_NO_SECRETS=1`；已有环境测试完成后删除该变量，在专属临时 `DSH_HOME` 下写入合成 `secrets.json`，经 `reloadConfig()` 读取。新增验证旧 `llmKey` 文件及 embed/rerank 的 `legacy-inherit`，旧键与三组新文件键共存时新 chat 键优先，三组各自环境变量覆盖文件，三组内存 override 覆盖环境。各来源、各组使用不同合成哨兵，每个阶段扫描完整 `configReport()` 与各 `groupReport()` 序列化结果，确认不包含完整哨兵；这不证明任意输入或报告其他字段均无敏感数据。补充 `maskKey(undefined)` 默认参数、真假值非字符串和 override 数字字符串化、传 `undefined` 清除 override 的现有行为。

复验再次使用上述干净父环境命令，只运行指定新测试，结果 1 项通过、0 项失败。子进程启动环境键仍经白名单断言；上述进程级配置与临时目录并非系统隔离，未进行系统级网络或文件访问监控，因此不足以证明没有网络或其他外部访问。

代码审查另见：组模式为 `disabled` 且存在该组 override 时，`groupReport()` 根据 override 存在性标记 `keySource: 'override'`，但生效密钥为空，`enabled` 和 `keyConfigured` 为 `false`。这是当前代码行为，本次未修改，也未将其记作新增实测覆盖。
