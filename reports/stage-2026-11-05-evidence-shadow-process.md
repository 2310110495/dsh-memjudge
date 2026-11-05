# 独立影子分析子进程阶段报告

日期：2026-11-05。本阶段仅新增独立原型和合成数据测试，默认关闭，未连接入口或生产，未部署。

`createEvidenceShadowProcess` 固定启动同目录 worker，worker 固定使用现有 V1 分析器；不接受分析器或路径注入。每次任务单独创建进程；同一实例最多一个任务、零排队，繁忙返回 overBudget。父进程复用现有影子适配器的输入白名单和字符预算，快照对象及数组均脱离共享原型后序列化，异常返回 failed，并对序列化请求限制 1 MiB；返回值仅接受固定数量的固定名称计数字段，每个值只能为 0 或 1。父进程不记录查询或片段，不保存或输出子进程标准输出、错误和异常信息；查询及快照仍会暂时经过父进程内存与 IPC。

超时默认 1000 毫秒，可设置 1–30000 毫秒；超时、关闭或错误将任务不可逆地结算为 failed，再尝试发送终止信号，迟到消息及关闭事件不会改变结果。非零退出、信号退出或无结果计为 failed；关闭后返回 disabled。任务结算和子进程生命周期分离，只有 child close 释放槽位并证明该子进程退出；kill 成功、失败或 exit 均不等同 close。关闭同步封闭入口，并发共享同一个 Promise；等待时限使用 timeoutMs，超时错误码为 ERR_SHADOW_CLOSE_TIMEOUT，迟到 close 仍释放槽位。超时后的重复 close 保留原失败结果。计时器受事件循环调度影响，并非硬实时。消息字段验证发生在 Node IPC 反序列化后，没有反序列化前接收大小硬限。

同权限子进程不是安全沙箱，仍有同账户文件及系统访问权限；清空传入环境及关闭标准流不构成安全边界。内存硬限、进程树硬限及生产接入均未实现；没有限制其他实例的总进程数。没有证明所有异常退出、启动失败和系统级资源耗尽情形均已覆盖。规则分析器仍局限于有限颜色断言，结果不证明事实、时效或完整性。

实测命令 `node --test test/evidence-shadow-process.test.mjs test/evidence-shadow.test.mjs test/attribute-evidence-v1.test.mjs test/attribute-evidence-v1-regression.test.mjs`：43 项通过、0 项失败；新增共享数组原型钩子、序列化异常、kill 抛错及返回 false、迟到消息和槽位保留的合成测试。真实固定 worker 仍有覆盖；未注入独立的异常退出或启动失败测试。仅执行上述纯模块测试；未执行插件入口、service.test.mjs，未读取真实配置、数据库或密钥，未进行网络测试。

指定补丁工具仅支持更新已有文件；首次 Add File 补丁失败且未落盘，使用文件工具创建占位后，以指定工具更新。保留原有工作树改动；本阶段不是全功能完成。

2026-11-05 快照构造补修：此前数组 push 在进程适配器移除原型之前可能触发 Array.prototype 索引 setter，泄漏合成快照项；原报告中脱离共享原型的说明不代表构造阶段已隔离。现以 Object.defineProperty 创建自有数组索引，保持普通数组及索引描述符兼容；进程适配器仍在序列化前移除数组原型。新增直接适配器双索引 getter/setter 污染和进程路径合成回归，后者通过序列化钩子截获快照并提前终止，未启动工作进程。四份纯模块测试 45 项通过、0 项失败。

局限：直接适配器交付普通数组，分析器执行时仍能访问共享数组原型；此修复只针对构造时继承索引访问器，不证明其他被篡改内建对象或分析器本身的安全性，也未证明生产链路。未执行入口或 service.test.mjs，未读取真实配置、数据库及密钥，未联网或连接生产。

2026-11-05 关闭契约修复：保留响应语义校验，修正既有 kill 抛错测试先等待 close 再发出 close 的矛盾；新增 kill 抛错、false、true、exit 与 close、并发幂等和超时后迟到 close 的合成覆盖。命令 `node --test test/evidence-shadow-process.test.mjs test/evidence-shadow-process-response-hardening.test.mjs test/evidence-shadow.test.mjs test/attribute-evidence-v1.test.mjs test/attribute-evidence-v1-regression.test.mjs`：56 项通过，0 失败，0 跳过。测试使用合成数据及固定 worker，未运行入口或 service.test.mjs，未使用真实配置、数据库、密钥或网络，未连接生产。close 超时不保证子进程被终止；同权限进程隔离、内存限制和进程树限制仍如前述局限。

2026-11-05 独立生命周期补测：新增 `test/evidence-shadow-process-lifecycle-synthetic.test.mjs`，以 EventEmitter 合成子进程验证 kill 同步触发 close 时取消结果和并发 close 一致；重复消息触发 failed、终止并在 close 前保留槽位；非零退出在有或无有效响应时均为 failed；IPC send 同步回调报错及同步抛错均为 failed、终止且在 close 前保留槽位。未发现所测契约缺陷，未修改生产代码。命令 `node --test test/evidence-shadow-process.test.mjs test/evidence-shadow-process-response-hardening.test.mjs test/evidence-shadow.test.mjs test/attribute-evidence-v1.test.mjs test/attribute-evidence-v1-regression.test.mjs test/evidence-shadow-process-lifecycle-synthetic.test.mjs`：62 项通过、0 失败、0 取消、0 跳过、0 待办，Node v24.22.1。本次新增场景使用事件替身，未证明真实系统中对应故障的时序、进程树回收或资源硬限；既有测试另覆盖固定真实 worker。未运行入口或 service.test.mjs，未读取真实配置、数据库、密钥，未联网或接生产。

2026-11-05 拒绝态 Promise 修复：抽取共享 `safeEvidenceSnapshot`，进程包装器直接调用，直接适配器固定调用同步 `analyzeAttributeEvidenceV1`，不再读取或执行 `analyze` 选项，移除尝试消费外部 Promise 的逻辑。这是破坏性 API 变化：依赖注入分析器的调用方须迁移，传入的选项现被忽略；共享快照函数返回原始查询及白名单内容，仅供受控内部调用，不属于隐私计数输出。严格未处理拒绝子进程回归以未执行的工厂覆盖异步拒绝、自有 constructor 访问器及异常原型，确保测试本身不制造未消费 Promise；另测选项访问器未被读取。测试不证明所有内建对象被篡改时的行为，也不提供恶意分析器隔离；现有同权限、资源硬限和生产接入局限仍成立。未运行入口或 service.test.mjs，未读取真实配置、数据库、密钥，未联网或接生产。

验证：`node --test test/evidence-shadow-process.test.mjs test/evidence-shadow-process-response-hardening.test.mjs test/evidence-shadow.test.mjs test/attribute-evidence-v1.test.mjs test/attribute-evidence-v1-regression.test.mjs test/evidence-shadow-process-lifecycle-synthetic.test.mjs`，59 项通过、0 失败、0 跳过；测试中包含固定 worker 和严格拒绝子进程。

2026-11-05 配置契约修复：进程适配器不再解构读取配置；逐层检查描述符并先识别代理，拒绝自有或继承的 `enabled`、`timeoutMs` 访问器，以及任意自有或继承的 `analyze`，不执行访问器、代理陷阱或旧回调。仅选最近的有效数据属性；`undefined` 仍使用默认值，`timeoutMs` 仍限制 1–30000，`enabled` 仅严格等于 true 时启用；其他选项保持忽略。允许继承数据属性及既有 `child_process.fork` 模块替身，未增加分析器或工作进程路径注入。破坏性变化：此前可执行的配置访问器、代理及被静默忽略的 `analyze` 现在同步抛出 TypeError；旧报告所述忽略 `analyze` 为历史状态，直接适配器与进程适配器目前均拒绝。受遮蔽的祖先 `enabled`/`timeoutMs` 访问器不会执行，也不会单独拒绝；祖先 `analyze` 始终拒绝。

验证：`node --test test/evidence-shadow-process-lifecycle-synthetic.test.mjs test/evidence-shadow-process-response-hardening.test.mjs test/evidence-shadow.test.mjs`，25 项通过、0 失败、0 跳过，Node v24.22.1。进程相关测试使用合成事件替身，直接适配器严格拒绝测试另启动合成 Node 子进程；未运行固定 worker、插件入口或 service.test.mjs，未访问真实配置、数据库、密钥或网络，未接生产。未覆盖被篡改的 Node 内建对象或所有运行环境；进程隔离和资源限制仍有上述局限。
