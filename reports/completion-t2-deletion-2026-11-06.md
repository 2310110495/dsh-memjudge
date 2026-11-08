# T2 来源删除与跨连接一致性

执行者 data-engineer；attempt completion-t2-a1；基线 1c325e141de5b7c33453e17c80ef4e6ab7754421。
初始工作树仅 T1 index schema 两行及其独占测试/报告，保留。无提交、推送、部署。

## 运行前审计（首轮执行前落盘）
已读 persona、expert-orchestration、完整交接、完成合同、T1 报告及其测试全部正文；检查 store 的初始化预检、事务、派生、put、occurrences、raw、close 和 content snapshot，以及 index 的缓存、forget、召回、注入和服务接线。
静态完整传递图：index -> store/search/vector/judge/attribute-evidence/layer/config/auto-capture/rpc/service/content-snapshot-view/disposal/startup-dependencies/raw-host-adapter；store -> schema/extract/conflict-scan-v2/text-wellformed；extract -> judge；conflict-scan-v2 -> conflict-snapshot/judge；search -> schema/vector/query-expand/llm-select；vector -> config；query-expand/llm-select -> config/llm-client；llm-client -> config；layer -> judge/store；rpc -> store/config；auto-capture -> text-wellformed；snapshot-view -> adapter/search；adapter -> store；raw-host-adapter -> raw-ingest-policy/raw-namespace/raw-repository/raw-codec/raw-observation；raw-repository -> raw-codec。动态 llm-extract 不调用；无 rerank。
T1 已审计分支及当前 import 搜索交叉核对：配置加载/密钥读取均通过 startupDependencies 全注入封锁；vector/expand/llmSelect/autoCapture/rawArchive false；RPC 替身 disposer；autoInject 只内存 section 渲染，不读取宿主。MEMJUDGE_NO_JIEBA 阻 native require。网络模块 resolve hook、fetch、WebSocket 拦截。模块顶层常量/函数/createRequire/路径计算/randomUUID，无顶层数据库、配置正文或网络读取；open 仅钉定的合成库路径；不调用 compact/VACUUM/ATTACH/扩展加载。
磁盘夹具由 PowerShell 创建独占随机根，Node 权限只授予 src、独占测试和该根的读取及该根写入；node:sqlite 原生文件权限不等同 OS 隔离，所以路径由断言钉定，不使用真实配置/数据库。测试不递归清理，成功和失败均保留夹具。
受控多进程：父进程需要 --allow-child-process，因而不是强进程沙箱；唯一 child 命令固定 process.execPath、相同测试入口、显式 permission 只读 src/test 与独占根读写；env 只保留 Windows 启动必需及 NO_JIEBA/NO_SECRETS/虚构 DSH_HOME，stdio inherit，避免捕获管道；child 分支只做已钉定库 SQL，零 shell/网络/清理/定时器。无旧测试、旧 service.test、真实插件入口或旧评测。
发现：默认索引/注入缓存不观察外部提交，memFacts 不自动刷新，snapshot 方法未自带 guard，forget 缺来源粒度，raw delete 未清 segments。持久 facts 含空表仍保留启动拦截。
工具差异：固定 F:/记忆库/apply_patch 仅 Update；新测试/报告 glob 确认不存在后用宿主 write 创建；已有文件使用 apply_patch，未修改 shim。匹配 SQLite MCP 未发现可用能力，使用 node:sqlite。

补强运行前审计：新增冲突 legacy/V1/V2 调用均为已读 index -> judge/documentConflicts/store.scanConflictsV2 -> conflict-scan-v2 -> conflict-snapshot；文件库 reader 使用既有 connection，不转向真实文件，BEGIN/ROLLBACK 同步释放。新增异步召回仅将 cfg.expand 设 true 并全注入 expandFn 返回手动释放 Promise；静态读取 SearchIndex.searchExpanded 802–854，明确不执行 defaultExpand、fetch、LLM、配置读取或定时器。测试不存在递归清理，所有库名固定正则校验，未触达真实入口。T1 全文已自读，其传递链未新增依赖，复跑仍采用无写/子进程权限。

最终补充审计：大正文测试只在当前独占目录写入重复的合成文字；调用已审计 put/get/dump/contentSnapshot/forget，无新 import、网络、配置、子进程或清理路径。通用派生刷新使用 BEGIN IMMEDIATE 下的内存事实重提取与段位图修复，不套用内容快照 API 的默认 1000 行/65536 字节字段预算；有界 snapshot API 仍保持原预算并在测试中显式断言。

## 结果
最终 T2 11/0、T1 8/0，所有测试命令退出码 0；git diff --check 退出码 0（仅工作树 LF/CRLF 提示）。只改四个合同内源文件，加独占测试和本报告；service 本身已有前后 guard，复用 index 接入的跨连接观察，不需要更改 service 源码。无新模块、新依赖、持久 facts 迁移或闸门解除。

|矩阵|实跑证据|结果|
|---|---|---|
|同文三位置/两来源、一来源多段|A 的两段精确删除；B 来源正文/位置/事实保留；独占 A 正文删除；dryRun 不改变观察版本|通过|
|未知身份与不过删|未知 source/chapter/para 保持 null；legacy/snapshot 不再从 id 伪造章号；缺失来源删零条，未知正文保留|通过|
|raw SQL 更新/删除|双连接更新红色为蓝色，事实自动刷新；段正文可读；raw 删除后 memories/segments/occurrences/facts 归零|通过|
|旧快照|外部更新及同连接删除后 search/fullText/allFacts/factsSlot 均抛 stale，而非交付旧内容|通过|
|异步提取|读后暂停 extractHybrid，另连接删除，释放后 stale；下一次读取自动得到空事实，无手动 rebuildFacts|通过|
|默认与 snapshot 消费者|工具/服务召回、来源查询、固定上下文、索引均先有正控，外部删除后零命中/零位置/无旧正文；工具 source 删除也验证|通过|
|冲突消费者|legacy/V1/V2 三路径删除前都有正控冲突，删除后 total=0 且无旧证据|通过|
|异步召回发布|工具与服务各在 expandFn 暂停后外部删除，释放时均抛 stale，旧搜索结果未发布|通过|
|受控多进程与重启|钉定子进程仅 SQL 删除父读库的合成来源，子退出 0；父自动失效；关库重开仍为空|通过|
|回滚失败|精确注入 COMMIT/ROLLBACK 失败，写者后续读抛 store fault；恢复合成连接并回滚后另连接原已提交来源保留|通过|
|普通大正文|75000 字合成正文普通 get/dump 可读；有界 snapshot 按字段预算抛错；来源删除后归零|通过|
|历史持久 facts 闸门|新建两套合成旧结构，空/非空 facts 均启动抛 persisted facts require forget-safe migration；打开前后整库字节相同|通过|
|T1 兼容|版本哈希、逐字分页、UTF16边界、属性缺证/多值、工具服务双路等 8 项|通过|

## 复放命令
工作目录固定 D:/cursor项目组/4/memjudge-plugin；Node v24.22.1；唯一夹具所有者 data-engineer。以下 C1 最终运行创建根为 F:/记忆库/.t2-fixtures/completion-t2-91e3f9b7-fb34-41cc-b88a-4b0ea48cf480，日志 t2-output.log 与全部合成库保留。复跑须生成新 GUID 根，避免复用现有状态。

```powershell
# C1，最终退出码 0，11 passed / 0 failed。
$root='F:/记忆库/.t2-fixtures/completion-t2-'+[guid]::NewGuid().ToString()
New-Item -ItemType Directory -Path $root | Out-Null
$env:MEMJUDGE_NO_JIEBA='1'
$env:MEMJUDGE_NO_SECRETS='1'
$env:DSH_HOME=$root+'/no-config'
& 'C:/Program Files/nodejs/node.exe' --permission '--allow-fs-read=D:/cursor项目组/4/memjudge-plugin/src' '--allow-fs-read=D:/cursor项目组/4/memjudge-plugin/test/completion-t2-deletion-2026-11-06.mjs' "--allow-fs-read=$root" "--allow-fs-write=$root" --allow-child-process test/completion-t2-deletion-2026-11-06.mjs $root 2>&1 | Tee-Object -FilePath "$root/t2-output.log"
exit $LASTEXITCODE
```

```powershell
# C2，最终退出码 0，8 passed / 0 failed。
$env:MEMJUDGE_NO_JIEBA='1'
$env:MEMJUDGE_NO_SECRETS='1'
$env:DSH_HOME='F:/T1_FORBIDDEN_SYNTHETIC'
& 'C:/Program Files/nodejs/node.exe' --permission '--allow-fs-read=D:/cursor项目组/4/memjudge-plugin/src' '--allow-fs-read=D:/cursor项目组/4/memjudge-plugin/test/completion-t1-evidence-2026-11-06.mjs' test/completion-t1-evidence-2026-11-06.mjs
# C3，退出码 0。
git diff --check
```

C1 子进程精确命令由测试固定为 process.execPath + --permission + src/独占测试/本次root读权限 + 本次root写权限 + 同一测试入口 + root + --child-delete；不传 --allow-child-process；环境仅 SystemRoot、WINDIR、MEMJUDGE_NO_JIEBA=1、MEMJUDGE_NO_SECRETS=1、DSH_HOME=root/no-config；cwd 固定本插件，stdio inherit，timeout 20000，shell 缺省 false。子进程 permission child/worker/addon 均 false。父 permission 的 PERM0002 警告是已披露的子进程边界，不当作 OS 隔离证据；PowerShell Tee 将 stderr 格式化为 NativeCommandError，真实 Node 退出仍为 0。

## 失败保留与优化
首轮 C1（不带 Tee、其余权限相同）在 F:/记忆库/.t2-fixtures/completion-t2-2a14ab42-0a55-406b-9f62-fadfe075ccc5：5/3，退出码1。TypeError: b.factsOf is not a function 是测试误用未导出的内部方法，改成公开 allFacts；1 !== 0 揭示同连接 put 后 raw delete 回到初始空内容的 ABA 导致事实残留，加入 data_version/total_changes 的派生 epoch；回滚注入错误先命中快照 ROLLBACK，明确刷新稳定后再注入目标事务。均已复跑覆盖。第二轮 root completion-t2-055b4722-1678-44b2-be33-d9c26533f462 为8/0；补强轮 root completion-t2-34765cd2-8217-4873-97fc-0fd72961166e 为10/0；最终11/0。所有夹具保留，未执行删除。
一次 apply_patch 上下文不唯一报 hunk context must match exactly once，退出1，已先落任务板检查点，核查未写入后缩小唯一上下文成功。最终审计移除把 snapshot 默认字段/行预算传播到通用读取的兼容性回归，追加大正文实测。手工 rebuildFacts 从未作为自动失效测试的补救；rebuildFactsHybrid 只在专门的异步竞争测试里全注入调用。

## 边界与待后续验证
- 采用读取时自动观察失效，不是推送。末次 contentVersion/assertCurrent 校验后到同步返回、Promise 交付之间仍存在外部提交窗口，不声称严格线性一致。已交付的普通文本/对象历史副本没有撤回能力；受支持旧 view 在下一次访问时抛 stale。
- contentVersion 读取并序列化 memories 的内容身份列与 occurrences；全量成本随库增长。派生 epoch 另观察 data_version/total_changes；派生刷新短暂 BEGIN IMMEDIATE 重建内存 facts，并修复变更正文段位图/孤儿段，因此初次观察外部变更可能有写锁与派生表写入。服务不触摸访问计数，但这不等于数据库文件绝无维护写。未做性能/高并发压力基准。
- 外部 SQL 当前验证是正常结构上的 UPDATE memories.text / DELETE memories；未把任意破坏 schema、删除 occurrence 唯一位置而保留正文、替换文件 inode 等操作声明为支持的自动来源删除协议。来源删除使用 store.forget({source})，按已记录 source 逐字匹配；明确 id 删除仍为整条删除。未知位置保留 null，legacy 章号0仅未知占位。来源删的 count 是实际删除的正文条数，共享正文可 count=0 且位置已删；store 返回 retained，工具沿用既有正文 count 输出契约。
- 有界 contentSnapshot 与冲突扫描预算原样保留；普通派生读取不强加该预算。向量/重排/真实宿主自动捕获未启用，真实宿主矩阵归 T6。本报告不是这些分支的通过证明。
- 历史持久 facts（含空表）闸门明确保留，真实旧库从未打开、迁移或评测；真实宿主/密钥/网络均未访问。权限模型与临时路径不是 OS 隔离。无提交、推送、部署，任务保持 running 交协调者验收。

## 文件 SHA256
```text
src/store.mjs 27130CC219CB35986E060D58E5257E8FCBB4429B25C103B5B93B3836D0EBE784
src/index.mjs 442B01E51E28D166E218BD7D4D1C2353493C279F18708F7801405B949AF6E652
src/content-snapshot-view.mjs 5039AEC55E58B764D595B3C9FA1049C9552AFEA3413FE7FAC401996FFB48AA1B
src/content-snapshot-adapter.mjs D50FB326D655303418C3AF4A06C56B06AF4408FEB9DFE62B0C7DAA13ECD0F8CE
test/completion-t2-deletion-2026-11-06.mjs F37A4AFBDB4FF046981590C48950B2490834A26F3F25C6CBA7F3A11FA226397B
test/completion-t1-evidence-2026-11-06.mjs D4409F8B430DD6BF034CF3FD41B18CEDD77A0A75D0A9C99473A596A910D8C04A
```
以上是工作树字节哈希，index 含保留的 T1 两行。最终差异以 git diff 与上述哈希结合复验；无替换 T1 测试或清理其他会话文件。
