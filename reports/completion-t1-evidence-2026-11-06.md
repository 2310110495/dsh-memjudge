# T1 原文证据纵切

执行者 backend-engineer；任务 T1；attempt completion-t1-a1。
基线 1c325e141de5b7c33453e17c80ef4e6ab7754421，初始 git status --short 为空。审计先于首轮运行落盘；现完成受控纵切验收，未标记任务板 done。

## 运行前传递副作用审计
2026-11-06，已用只读 import/require 与文件、网络、环境、定时器、进程调用检索递归追踪入口。
白名单静态图：index → store/search/vector/judge/attribute-evidence/layer/config/auto-capture/rpc/service/content-snapshot-view/disposal/startup-dependencies/raw-host-adapter；store → schema/extract/conflict-scan-v2/text-wellformed；extract → judge；conflict-scan-v2 → conflict-snapshot/judge；search → schema/vector/query-expand/llm-select；vector → config；query-expand/llm-select → config/llm-client；llm-client → config；layer → judge/store；rpc → store/config；auto-capture → text-wellformed；content-snapshot-view → content-snapshot-adapter/search；content-snapshot-adapter → store；raw-host-adapter → raw-ingest-policy/raw-namespace/raw-repository/raw-codec/raw-observation；raw-repository → raw-codec。attribute-evidence-v1 单独纯函数验证。

模块顶层仅常量、正则、Map/WeakMap、函数/类定义、createRequire、config 路径计算、raw-repository randomUUID（进程内标识）。无顶层数据库打开、文件正文读取、网络、子进程、定时器。config ENV_SIG_NAMES 的立即函数只组装环境变量名。

危险分支与封锁：
- config.load 的 config.json/secrets.json 读取为懒调用；注入全部 startupDependencies，DSH_HOME 指向虚构禁止路径；权限模型仅允许源模块和独占测试读取，不授予文件写入。
- open 仅明确 ':memory:' 才跳过 mkdir，DatabaseSync 后初始化事务、派生 facts、prepared statements 均限内存；工厂拒绝其他路径。put/get/dump/updateAccess/forget/read 的 SQL 不含 ATTACH/扩展加载；不调用 compact、hybrid、文件快照。
- facts 持久表启动闸门保留。异常初始化 rollback/close；正常 dispose 异步逆序清理并关闭唯一 store，测试 finally await。
- vector cache 的 fs、embed 的 fetch/timer，query-expand/select/chat 的 key/fetch/timer 均由 false 开关及注入 throw 哨兵阻断；MEMJUDGE_NO_JIEBA=1 阻 native require。rerank 不在静态图，无调用。
- extractL1Hybrid 动态导入 llm-extract（含缓存 fs/LLM）不调用；同步规则提取仅字符串操作。
- RPC 安装替换无操作 disposer，不注册真实 connection；RPC 内 reopen store/save config/key/fetch 不可达。
- autoCapture 显式 false，autoInject false；测试不提交宿主事件或执行其它工具，effect/on/section/provide 仅内存注册。
- rawArchive 不启用，installRawHostAdapter 不调用；raw policy 的后端文件 hash、namespace 的 registry/read/write/unlink、repository preflight 的 mkdtemp/copy/open/rm、周期扫描均不可达。清理只限其自建临时根/lease，但本次不产生这些资源。
- Node 24.22.1 --help 确认权限模型没有网络开关。因此同步 registerHooks 封锁 net/http/https/http2/dns/dgram/tls/undici 模块导入，同时全局 fetch/WebSocket throw；测试先验证这些拒绝哨兵，再动态导入白名单源码。Node --permission 无 child/worker/addon/fs-write 授权；哨兵检验权限状态与合成不存在路径的 fs 拒绝。非 OS 网络沙箱，不将此说成敌对同进程代码隔离；审计后的链路无其他网络原语。

运行限定：不运行旧 service.test.mjs、旧评测、插件真实宿主入口；不读取真实库/配置/密钥；测试不新增依赖，不运行 npm test（package 没有脚本）。环境清除所有继承 MEMJUDGE_* 与 NODE_OPTIONS/NODE_PATH，仅重设 NO_JIEBA/NO_SECRETS。

工具差异：F:/记忆库/apply_patch 仅支持 Update；本报告及新测试先 glob 确认不存在后用宿主 write 创建。已有源码改动使用该 apply_patch，不修改 shim。

## 验证与最终结果
结论：权限哨兵与八组受控纵切全部通过；仅发现并修复一个输出 schema 缺口。合成链路通过不等价于真实宿主/公平评测完成。没有提交、推送、部署；另一 QA 专家文件未触碰。

### 修改与内容 SHA
源码仅 src/index.mjs 两行：命中 required 增加 version/truncated；version 定义缩进对齐。src/search.mjs、src/service.mjs、src/attribute-evidence.mjs、src/attribute-evidence-v1.mjs 均未改动。新增独占 test/completion-t1-evidence-2026-11-06.mjs 与本报告。

```diff
-                 version: { type: 'string' },
+                version: { type: 'string' },
-              required: ['id', 'chapter', 'para', 'chars', 'score', 'text'],
+              required: ['id', 'chapter', 'para', 'chars', 'score', 'text', 'version', 'truncated'],
```

文件 SHA256（磁盘文件原始字节，非内容版本算法）：
- src/index.mjs: 12DD98F2206AF2BF5CF255886C3C083159D68A8D50FD556A00918137062C5F5A
- test/completion-t1-evidence-2026-11-06.mjs: D4409F8B430DD6BF034CF3FD41B18CEDD77A0A75D0A9C99473A596A910D8C04A

### 可重放命令 C1
工作目录 D:/cursor项目组/4/memjudge-plugin，Node C:/Program Files/nodejs/node.exe v24.22.1。每次命令在独立 pwsh 内执行，不改变其它会话环境。

```powershell
Get-ChildItem Env:MEMJUDGE_* | ForEach-Object { Remove-Item ('Env:' + $_.Name) }
Remove-Item Env:NODE_OPTIONS,Env:NODE_PATH -ErrorAction SilentlyContinue
$env:MEMJUDGE_NO_JIEBA='1'
$env:MEMJUDGE_NO_SECRETS='1'
$env:DSH_HOME='F:/T1_FORBIDDEN_SYNTHETIC'
& 'C:/Program Files/nodejs/node.exe' --permission --allow-fs-read=./src --allow-fs-read=./test/completion-t1-evidence-2026-11-06.mjs ./test/completion-t1-evidence-2026-11-06.mjs
Write-Output "T1_TEST_EXIT=$LASTEXITCODE"
git diff --check
Write-Output "T1_DIFF_CHECK_EXIT=$LASTEXITCODE"
Get-FileHash -Algorithm SHA256 src/index.mjs,test/completion-t1-evidence-2026-11-06.mjs
```

测试本体只导入 node:assert/strict、node:module、node:fs、node:crypto 及审计白名单模块；fs 哨兵目标是明确不存在的合成禁止路径，不读取真实配置。权限允许读取 src 仅供 ESM 加载，未允许真实用户目录、配置目录、数据库文件与 test 下其它入口。系统权限无写入、子进程、worker、addon；断言 process.permission.has 均 false。SQLite 原生内置绑定仍可使用，所以另以只接受 :memory: 的工厂、逐调用 SQL 审计封闭其文件旁路。本方法不声称对任意恶意原生/同进程代码提供全面 OS 网络隔离。

### 验收矩阵
每行均由本次 C1（最终退出 0）实际运行，不使用 mock 替代 store/search；ctx 仅为工具和服务注册容器，不模拟检索结果。新测试每个 fixture finally await dispose，内存资源退出即消亡。

| 合同项 | 用例及断言 | 结果 |
| --- | --- | --- |
| 写入至词法窗口、工具及服务分别交付 | write -> lexical window；real remember -> real BM25 -> hit id/version/window；tool render 实际块字符串含 version/text/start:end；服务与工具命中均复原全文 | 通过 |
| UTF16LE SHA256 与半开偏移 | createHash('sha256').update(original,'utf16le') 独立比对；每片等于 original.slice(windowStart,windowEnd)；携 hit version、limit7 从0拼页等于原文 | 通过 |
| 中文/英文/CRLF/emoji/组合字符/NUL/极小预算 | 两类语言文本、e+组合重音、CRLF、emoji、NUL；read limit2；recall budget1/2/3/8/2000，text.isWellFormed，chars<=budget，全文逐字相等 | 通过 |
| 空文 | remember 空文明确报错；SQL 内存更新为合法空正文后 read 返回空串、SHA256('' utf16le)、nextOffset0、truncated false | 通过 |
| 属性缺证、否定、疑问、无值、他实体 | 甲船不是红色/颜色是什么/尚无记录/乙船红色/无颜色断言；tool和service均denied；reason为 no-candidates 或 attribute-evidence-missing，hits为空 | 通过 |
| 多值与自由查询 | 红色+蓝色，保留值集合、conflictLine；服务同样输出冲突和原文；自由查询 attributeValues=null、服务可返回原文，不推断现值 | 通过 |
| 裁窗不补猜与原因渲染 | 甲船红色整文有证，budget4后tool及service attribute-evidence-missing；工具渲染含实际reason/detail | 通过 |
| 英文属性 | Beacon affirmative、not red、Other实体，在tool及service分别核实；肯定时原文完全一致 | 通过 |
| 更新/删除使旧版过期且不混页 | 取首片后SQL更新，携旧version续页抛 stale version；forget实际删除后旧version抛 stale，未传version found false | 通过 |
| UTF16代理对边界 | read limit2逐页不拆代理对；原文emoji内部offset5抛 invalid offset；limit1抛 invalid arguments | 通过 |
| tool touch / service不touch | 初始last_accessed1234/access_count7；服务查询两字段不变；工具后access_count增加，版本仍与写入版本相同 | 通过 |
| V1原文引用跨度 | analyzeAttributeEvidenceV1 输入含emoji前缀原文，valueSpan/originalValueSpan/originalSentenceSpan slice等于rawValue/sentence，自由查询unsupported | 通过（独立纯函数；非产品默认路径） |
| facts闸门、向量/重排停用 | facts相关源码无diff；vector/expand/llmSelect=false；native jieba跳过，embed/expand/select注入throw未触发；RPC/autoCapture/raw均封锁 | 静态审计加本次链路通过；持久表启动故障注入未执行 |

### 最终原始标准输出
```text
PASS isolation: fs/child/worker/addon denied; network module/fetch/WebSocket blocked
PASS write -> lexical window -> tool/service -> versioned exact pages and touch contract
PASS Chinese English CRLF emoji combining tiny budgets and full hashes
PASS update delete empty text and same-value hash boundary
PASS attribute missing negative question no-value other-entity and cropped evidence
PASS attribute multiple values and free query are not forced single-value
PASS English attribute affirmative and negative use both delivery paths
PASS empty write and no candidates have explicit reasons
PASS V1 delivered evidence UTF16 spans independently verify original slices
{
  "passed": 8,
  "failed": 0,
  "results": [
    {"name":"write -> lexical window -> tool/service -> versioned exact pages and touch contract","status":"passed"},
    {"name":"Chinese English CRLF emoji combining tiny budgets and full hashes","status":"passed"},
    {"name":"update delete empty text and same-value hash boundary","status":"passed"},
    {"name":"attribute missing negative question no-value other-entity and cropped evidence","status":"passed"},
    {"name":"attribute multiple values and free query are not forced single-value","status":"passed"},
    {"name":"English attribute affirmative and negative use both delivery paths","status":"passed"},
    {"name":"empty write and no candidates have explicit reasons","status":"passed"},
    {"name":"V1 delivered evidence UTF16 spans independently verify original slices","status":"passed"}
  ]
}
T1_TEST_EXIT=0
T1_DIFF_CHECK_EXIT=0
```
JSON results在此仅折叠对象换行，字段与实际stdout相同。stderr唯一为git提示 `warning: in the working copy of 'src/index.mjs', LF will be replaced by CRLF the next time Git touches it`。文件SHA见上。

### 失败记录与根因
- 首轮C1，exit1：4组通过/1组失败，`assert.ok(rendered.includes(toolResult.hits[0].text))`。测试错误把JSON转义字符串和原始CRLF/NUL片段比较；改取render返回块的text拼合，再次实际核对。
- 第二轮C1，exit1：4组通过/1组失败，`assert.ok(recall.output.schema.properties.hits.items.required.includes('version'))`。这是产品schema缺口：实际命中有version/truncated，schema却未要求；仅修此缺口。
- 两次手写apply_patch，exit1：`Error: hunk context must match exactly once: D:/cursor项目组/4/memjudge-plugin/src/index.mjs`。原因宿主read输出缩进与实际原始缩进有差异，shim执行前校验未落盘。
- 随后一轮由Get-Content数组行号生成的patch虽exit0，但误定位到forget两行；C1 exit1：`SyntaxError: Unexpected token ','`，index.mjs:1211。Get-Content把部分多行文本作为行数组的计数不等同host read；该方法弃用。基于git diff和唯一上下文，只撤回本任务误改；最终git diff已核实forget无变化。
- 一次撤回patch仍因重复上下文exit1且无落盘；后以execute/else上下文成功撤回。实际源码最终差异仅前述两行。
- 修复后C1 5/0 exit0；补原因/空文/V1后7/0 exit0；补英文及服务多值后最终8/0 exit0；git diff --check exit0。
- 运行前 `node --help | Select-String 'permission|allow-|network'` exit0、版本探测exit0；git状态/哈希检查exit0。早期Get-Command apply_patch找不到exit1，后读取并使用固定F:/记忆库/apply_patch，未修改shim。

### 边界、未知项与回退
分页没有跨页数据库快照：每次read读取当下正文，再比较请求version；更新后携旧version会报stale，调用方应丢弃已收集页并重新从offset0开始，禁止自行拼接不同version。测试重现旧version失效；没有把单进程合成fixture当作跨进程事务并发证明。

版本只识别当前UTF16LE正文，不含更新时间、generation或删除墓碑。A→B→A时原version重新有效（本次已实测），历史变化及SHA256理论碰撞不由此机制识别；同值恢复返回的字节与A相同。测试SQL更新只为确定性模拟read时正文变化，不替代产品写入/删除链；首次写入和forget实际执行工具。

UTF16偏移不是Unicode码点或字素簇计数。代理对不得截开已实测；组合字符允许落在分页边界两侧，拼回后与原文逐字相等，不声称保持每页字素完整。预算1可能交付空片段，属于原有契约，未为凑字符拆emoji。

属性问句的严格证据判断限 attributeValues 支持语法；本次覆盖明确属性问句的裁窗后证据。自由查询仍存在index.mjs全文gate复核回退（985–997附近）：可能根据窗外全文决定放行，但返回正文仍是预算窗口；没有输出推断答案。未将此描述为所有自然语言形式都具备严格逐窗答案证明；该兼容逻辑未在本任务扩大修改。

V1为独立有限颜色语法纯函数，不冒充默认入口运行。旧read-by-id、recall-truncation、attribute-evidence以及service-generation已读取用于审计；前两类旧apply未完整注入providers，存在配置回退风险，旧测试均未运行。旧service.test.mjs和旧评测未执行。真实宿主、其它插件联动、跨连接删除、raw生命周期、向量公平评测留待计划后续任务，不属于本次通过结论。

回退：协调者审阅后可用apply_patch精确还原本报告diff的两行并移走本次独占测试/报告；不得用git restore/checkout清理工作树，也不得覆盖其他会话新增内容。无数据库文件、配置文件、密钥、外部网络或宿主状态需要回滚。

质询点：schema完整性（已修复并实证）、网络无系统权限开关（解析封锁加审计并披露界限）、跨页无快照与同值恢复（已实测并明确合同）、自由查询全文放行回退（保留且准确收窄结论）。
