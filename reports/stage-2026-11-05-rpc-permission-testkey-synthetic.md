# 阶段报告：RPC 权限与 testKey 合成验证

日期：2026-11-05。

## 范围与方法

新增 `test/rpc-permission-testkey-synthetic.test.mjs`。读取 `src/rpc.mjs` 源文本，使用 `vm.SourceTextModule` 执行该模块，导入的配置、存储均替换为内存 `vm.SyntheticModule`。存储替身一旦打开即报错；`fetch` 在 VM 上下文完全替换为记录参数的内存函数，仅用 `.invalid` 端点和假密钥，绝不发起网络请求。未启动插件真实入口、运行旧测试或访问真实配置、数据库与密钥。

## 观察与验证

- 注册替身记录到三个参数：`/memjudge`、处理函数、`{ authority: 'loopback' }`，且 disposer 原样返回。当前 Cordis Inspect 的 `HostConnectionRpc.handle(channel, handler)` 声明仅有两个参数；该差异不证明宿主是否采纳第三参数或如何实施权限控制。
- 直接调用捕获的处理函数，分别传入两个不同的合成 peer 和 undefined，`saveSettings`、`saveKey`、`testKey` 的选中分支、结果及替身调用一致。该观察仅针对所测分支及直接调用，不能代表宿主传输或授权行为。
- 内存配置替身模拟设置写入生效：`https://chosen.invalid/v1`、`chosen-model` 和 `supplied-fixture` 最终分别进入被拦截 fetch 的 URL、JSON 请求体和 `Authorization`。三组分别核对端点后缀、方法、模型、请求体及各自假密钥；显式密钥覆盖组内密钥并去除首尾空格，缺省组为 chat。
- 覆盖无效组、禁用组、密钥类型错误、空密钥、端点或模型缺失时不触发 fetch；覆盖 HTTP 错误、响应无效、模拟网络异常及模拟 AbortError。测试中仅模拟 AbortError，并未等待真实 8 秒超时；诊断返回不包含所测假密钥。
- 合成测试不证明宿主授权、第三参数生效、网络连通性或外网可利用性。`saveConfig`、凭据读取与持久化均是替身，未验证真实配置实现。

## 命令与结果

在 `D:/cursor项目组/4/memjudge-plugin` 执行：`node --experimental-vm-modules --test test/rpc-permission-testkey-synthetic.test.mjs`，退出码 0，17 项通过，0 失败。Node 输出 VM Modules 实验特性警告。

指定的 `node F:/记忆库/apply_patch` 只支持更新已有文件，尝试 Add File 返回 `Error: only update supported`，退出码 1；随后通过文件工具创建新增文件，并以该补丁程序更新新增测试，退出码 0。既有生产文件和旧测试均未修改，原有工作区改动保留。

## 诊断脱敏重叠修复

**历史记录：**本节至“百分号编码与截断复审”的扫描、URL 诊断和测试数均为当时结果，已由文末固定诊断修订取代，不代表现行实现。

- 修复前新增回归得到 18 通过、2 失败：短密钥先替换使模型名和端点中的长密钥残留 `LONG`，错位重叠也残留字符。测试数据均为合成值。
- `src/rpc.mjs` 在原始诊断文本上查找所有非空密钥出现的位置，合并相互重叠的区间后一次性替换，再按既有 200 字符上限截断。重复密钥去重；新插入的标记不会再次被替换。请求密钥裁剪、RPC 信封及请求本身保持原有契约。
- 覆盖长短包含、错位与自重叠、重复命中、重复密钥、空密钥、显式输入裁剪、端点与模型及截断行为。保留原有工作区改动。
- 最终仅运行 `node --experimental-vm-modules --test test/rpc-permission-testkey-synthetic.test.mjs`：21 通过，0 失败，退出码 0；出现 VM Modules 实验特性警告。
- 配置和存储均为 VM 替身，fetch 为内存替身；未运行真实入口或旧测试，未读取真实配置、数据库、密钥，也未发起网络请求。结果仅覆盖本测试所构造的诊断输入和分支，未验证真实宿主或网络。

## 独立复审：截断边界和资源

- 面板 `saveSettings` 拒绝带用户信息、查询、片段的 URL；但 `config.mjs` 的环境变量和已有配置解析不经过该校验，故跨 `?`/`#` 的合成密钥可到达诊断路径。本次检查为源码分析及 VM 替身回归，未加载真实配置模块。
- 诊断以原文匹配所有密钥、合并重叠区间，再按原始 URL 边界裁剪；普通 URL 用户信息仍独立遮盖。扫描不再收集和排序全部命中区间，输出限制仍为 200 字符。密集重叠仍需随输入长度执行扫描，未作严格性能上限证明。
- `testKey` 分支中配置读取或诊断异常由外层返回固定 `internal-error`，不回传原始异常消息；其他 RPC 的异常契约未改。正常探测结果信封及请求路径不变。
- 新增五项独立合成回归：跨查询及片段边界、重叠和截断、普通 URL 用户信息、密钥 getter 异常、25 万字符密集重叠，以及面板设置校验。命令 `node --experimental-vm-modules --test --test-name-pattern='new regression:' 'D:/cursor项目组/4/memjudge-plugin/test/rpc-permission-testkey-synthetic.test.mjs'`，5 通过、0 失败，退出码 0，VM 实验特性警告。
- 仅运行上述新增用例，存储和配置为内存替身，fetch 完全替换；未运行入口或旧测试，未访问真实配置、数据库、密钥或网络。未验证真实宿主、真实网络与长时间压力。指定补丁程序不支持新增文件，故扩展既有合成测试文件。

## 独立复审：多 @ 与缺席密钥重复扫描

- 先新增两项 `review regression:`，修复前均失败：`https://user@password@host.invalid/v1` 的诊断暴露 `password`；1000 个 `a` 与密钥 `aa` 密集重叠时，缺席密钥被搜索 1002 次，而两段诊断各搜索一次应为 2 次。
- authority 的用户信息区间延伸至路径、查询或片段前最后一个 `@`，覆盖多个及连续 `@`；每个密钥缓存下一个命中位置和未命中状态，仅在扫描越过缓存命中时重新查找。保留重叠区间合并、跨查询/片段边界匹配及 200 字符输出截断。
- 历史旧版本测试：合成 VM 拦截 `String.prototype.indexOf` 对缺席密钥调用，1000、10000 字符密集输入均为 2 次；这是旧扫描实现的操作计数，不是当前版本性能测试或耗时证明。
- 仅执行 `node --experimental-vm-modules --test --test-name-pattern='review regression:|new regression:' test/rpc-permission-testkey-synthetic.test.mjs`，7 通过、0 失败，退出码 0；Node 提示 VM Modules 实验特性。测试配置、存储、fetch 均为内存替身，未运行入口旧测试，未访问真实配置、数据库、密钥或网络。
- 复杂度局限：设密钥数为 k、被处理的重叠命中起点数为 M，循环仍有 O(kM) 比较和至多每密钥每个自身命中一次的查找；`indexOf` 的字符比较复杂度受引擎、密钥长度与输入影响，未证明总运行时间严格线性。计数只证明该缺席密钥不会被重复查询，未验证真实宿主及实际工作负载。

## WHATWG 用户信息复审修复

- 新增四项 `url review:` 隔离合成测试；修复前 1 通过、3 失败，复现 `https:private-user:private-pass@host.invalid/v1` 的用户信息泄露、无效端点未整体隐藏，以及单斜杠用户信息泄露。最初测试源码传输转义错误导致一次 SyntaxError，修正后才取得上述修复前结果。
- 诊断端点先用 WHATWG `URL` 验证，仅对 HTTP(S) 解析成功的输入展示；解析失败、其他协议或原文定位与解析结果矛盾时返回固定 `[REDACTED]`。按 URL 的首尾 C0 控制字符与空格裁剪、制表符及换行剔除规则建立清洗字符到原文 UTF-16 代码单元下标的映射，识别零/单/多斜杠、反斜杠及最后一个 `@` 的用户信息范围，仍在原始字符串上合并密钥与用户信息区间。
- 密钥扫描不使用规范化后的 URL，避免空格百分号编码等规范化改变原文导致密钥漏匹配；跨原始 `?`、`#` 的匹配先于端点裁剪，输出仍上限 200 个 JavaScript 字符单位。原始文本呈现保留输入拼写，并非规范化后 URL；解析失败的端点诊断不展示主机。
- 执行 `node --experimental-vm-modules --test --test-name-pattern='url review:|review regression:|new regression:' test/rpc-permission-testkey-synthetic.test.mjs`：11 项通过、0 失败，退出码 0；Node 提示 VM Modules 实验特性。配置、存储及 fetch 全为内存替身；未运行真实入口或旧测试，未读取真实配置、数据库、密钥，未发起网络请求。
- 该验证覆盖所构造的 HTTP(S) 变体而非全部 URL 输入空间，未验证真实宿主、网络和性能上界；密钥匹配是原始字符串精确匹配，不涵盖人为编码或变形的密钥。修改使用指定补丁工具，保留已有改动。

## 百分号编码与截断复审

- 密钥 `a/b` 出现在路径 `a%2Fb` 时，原文精确匹配漏遮盖。为避免解码或重新编码改变已有匹配而产生新泄漏，端点原文只要含 `%` 就整体返回 `[REDACTED]`，包括无关转义、大小写转义、多重编码及畸形转义；该保守策略牺牲端点可见性，fetch 的原始 URL 和请求密钥不变。
- 模型及端点诊断仍先遮盖再限制至 200 个 UTF-16 单元；若截断位置切开代理对，去掉末尾高代理项。原文已有的孤立代理项不在本修复范围。模型仅做原文密钥精确匹配，非百分号和其他编码变形、分隔插入及未列入密钥集合的秘密均不保证遮盖；端点中不含 `%` 的其他变形亦不保证遮盖。
- 新增两项隔离合成测试，覆盖 `a%2Fb`、小写转义、双重编码、畸形百分号、无关百分号、请求原样传递，以及模型和端点边界代理对及恰好完整的代理对。完整执行 `node --experimental-vm-modules --test test/rpc-permission-testkey-synthetic.test.mjs`：34 通过、0 失败、退出码 0；Node 输出 VM Modules 实验特性警告。
- 配置、存储和 fetch 均为内存替身；未启动真实入口或运行真实入口旧测试，未访问真实配置、数据库、密钥或网络。结果不证明真实宿主、真实网络、全部编码形式或性能上界。所有编辑使用 `node F:/记忆库/apply_patch`，保留工作区现有变更。

## 超时与异步响应复审

**历史结论提示（后续实现已取代）：**本节记录当时仅依赖中止信号的实现；下文“当前不是强制 Promise 截止时间”不再描述现状。当前实现以 `Promise.race` 竞争异步请求和 8000ms 定时器，并通过 `performance.now()` 检查截止；事件循环或同步代码阻塞仍会延迟返回。详见 `stage-2026-11-05-rpc-testkey-hard-timeout.md` 的后续修订。

- 隔离先行核对：该测试仅读取 RPC 源文本；配置和存储均为 VM 合成模块，打开存储抛错，fetch 完全替换为内存函数；本轮仅用合成配置、密钥与响应。新增用例注入独立假定时器，不启动入口、不运行旧测试，不接触真实配置、数据库、密钥或网络。
- 复现响应头返回后 `res.text()` 因中止抛 `AbortError` 时被吞掉，误报 `invalid-response`。修复前新增用例 3 通过、1 失败；现在将该异常交给原超时分支，普通响应体错误仍保留原有空文本处理。
- 限定执行 `node --experimental-vm-modules --test --test-name-pattern='clock regression:' test/rpc-permission-testkey-synthetic.test.mjs`：6 通过、0 失败，退出码 0；VM Modules 实验特性警告。覆盖等待 fetch 中止、响应体中止、成功及网络失败清理定时器、普通响应体异常，以及宿主信号和忽略中止的替身。
- 假时钟只验证回调注册的 8000 毫秒参数、人工触发时的信号与所测异步分支，未模拟真实时间推进、真实 I/O、事件循环负载或原生 fetch 的实际取消行为。超时依赖 fetch 和响应体配合中止：忽略信号的合成 fetch 可以迟到成功或永远悬挂，当前不是强制 Promise 截止时间。`latencyMs` 在响应头到达时计算，不含后续响应体读取时间。
- handler 只接收 endpoint 和 payload，直接调用中额外传入的宿主取消信号未传给探测控制器；合成用例仅证明该直接调用现象，不证明真实宿主是否传递信号或宿主侧取消语义。异常名称 `AbortError` 被统一归类为 timeout，未区分其他中止来源。未调整宿主取消契约。

**当前计时与证据边界：**截止起点在 `probeSpec`、请求体及密钥配置读取和诊断脱敏之后，并非整个 RPC 调用的起点；`latencyMs` 使用 `Date.now()` 墙钟差，系统时钟回拨时可能为负。两份合成测试向 VM 显式注入 `performance`，尚未实证真实宿主中 `performance.now()` 的可用性。原生 `Response` 案例验证分片 UTF-8 解码；读取中取消及取消异常等行为由自造 reader/body 替身验证，并非原生传输取消的验证。

## 固定诊断修订

`testKey` 成功、HTTP 错误、无效响应、网络错误和超时的 `model`、`endpoint` 均固定 `[REDACTED]`；历史密钥、密钥片段和编码变体不再由这两个字段回显，代价是诊断端点和模型不再可见。入参校验失败及内部异常仍保留原 RPC 错误结构，不含上述诊断字段。真实请求继续使用原端点、模型和密钥；只删除诊断扫描，其他调用使用的组密钥映射保留。客户端依赖的 `ok`、`latencyMs` 与错误代码保持原结构。

仅联合运行两份 RPC 合成测试，共 46 项通过、0 失败；VM 配置、存储和 fetch 为内存替身，未执行入口及旧测试，未接触真实配置、数据库、密钥、网络。旧版 10000 字符计数与本次无关，本次未开展性能基准，真实宿主及真实传输仍未验证；同步准备工作和宿主超时限制仍存在。

## 失败分支与协议复核

新合成案例分别把秘密放入 URL、模型及错误正文或异常，验证 HTTP、无效响应、网络错误、模拟中止和内部异常的完整 JSON 序列化结果均无这些秘密；检查错误码、状态、消息、延时类型、信封及固定遮盖。硬超时另验证迟到异常及超时返回。参数错误和内部异常返回 `{ok:false,error:{code,message,details:{}}}`，顶层不存在 `value`，错误对象不存在 `model`、`endpoint`，并非值为 `undefined` 或遮盖文本；探测失败则为外层成功和内层失败。

现行行为存在明确兼容变化：2xx 响应体若没有 `getReader`，不回退 `text()`，返回 `invalid-response`；流读取最多 1 MiB（1048576 字节），超限返回 `invalid-response`；非 2xx 不读取正文并尽力取消。因此不能概括为所有调用方行为不变。请求仍使用原始端点、模型及密钥，诊断字段固定遮盖。

核验隔离后在项目目录运行 `env -i PATH="$PATH" SystemRoot="$WINDIR" WINDIR="$WINDIR" TEMP="$TEMP" TMP="$TMP" node --experimental-vm-modules --test test/rpc-permission-testkey-synthetic.test.mjs test/rpc-testkey-hard-timeout-synthetic.test.mjs`：48 通过，0 失败，退出码 0；VM Modules 实验警告，真实计时案例约 8003ms。首次缺少 `SystemRoot` 时 Node 启动阶段 CSPRNG 断言失败，补齐系统变量后通过。配置、存储、fetch 均为 VM 替身；仅运行两份合成测试，未加载真实插件入口、旧测试、真实配置、数据库、密钥或网络。未修改生产代码。
