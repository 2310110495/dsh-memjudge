# 独立证据影子适配器阶段报告

日期：2026-11-05。仅新增独立模块和合成测试，未连接生产、未提交或部署。

`createEvidenceShadow({enabled=false, analyze=analyzeAttributeEvidenceV1}={})` 返回同步 `observe(query,hits)`。默认关闭先返回固定数值计数，不访问输入且零分析调用。启用时拒绝代理、稀疏数组、访问器、继承的命中对象数据及不符合类型的白名单字段；只复制 text、originalText、windowStart、windowEnd、truncated、startsAtBoundary 到无原型快照。非白名单字段完全忽略，不枚举、不读取、不透传，包括 id、version 和其访问器，以兼容实际测试中的元数据。

查询、命中数量、text、originalText、总字符预算分别为 1024、64、8192、16384、131072；按 UTF-16 码元计数，含 query、text 和 originalText，超限整次跳过。状态及 conflict、semanticUncertain、contextIncomplete 独立投影为固定键非负整数；异常及异常分析结果只计数，结果不含内容、身份、位置、错误或哈希。无日志、持久化、网络或数据库访问。输出仅代表有限规则的观测计数，不证明事实真实性、时效或语义完整。

测试先运行 `node --test test/evidence-shadow.test.mjs`，因待实现模块缺失报 `ERR_MODULE_NOT_FOUND`，退出 1；实现后同一命令 6 项通过。测试覆盖关闭零访问/零调用、白名单快照与隐私、代理/访问器/继承/稀疏输入、预算及边界、异常、状态与独立标记、单次调用和输入不变。只运行该独立测试，未运行入口或旧测试。

同步输入预算不是硬性时间或内存限制；分析器依赖及运行时本身仍可能消耗额外资源。合成测试不代表真实宿主、生产数据或真实性能验证。保留其他已有改动。

## 异步拒绝与状态一致性修复

实施者自报：新增的两个回归先失败，修复后 V1 与 shadow 联合测试 35/35 通过；本次记录未运行测试或入口。状态一致性校验要求 unsupported 无任何标记；semanticUncertain 或 contextIncomplete 为真时状态为 uncertain，否则有冲突时为 ambiguous，无冲突时为 candidates 或 no-evidence。测试覆盖这些状态和三个布尔标记的组合。

分析器返回普通原生 Promise 时同步计为 failed，并在原型、构造器和 species 等检查通过后接入拒绝处理；严格未处理拒绝模式下的普通异步拒绝有子进程回归覆盖。异常构造、修改原型或带自有 constructor 等不符合检查的 Promise 刻意跳过拒绝处理，若其被拒绝仍有未处理拒绝风险；恶意 thenable 和代理不会为处理拒绝而访问其属性。同步分析器仍可能阻塞或产生副作用，输入预算不构成隔离。该影子模块尚未接入生产。

## 参数契约审查与迁移

2026-11-05：以上注入分析器描述为历史记录；当前模块固定使用内置分析器。`createEvidenceShadow` 沿原型链通过属性描述符检查旧 `analyze`，不论启用状态或属性值，构造时同步抛出 `TypeError`，不执行其 getter 或回调。参数对象或原型链为代理时同步抛错，避免触发代理陷阱；`enabled` 访问器同样报错而不执行。只有数据属性值严格等于 `true` 才启用；缺省或其他值均禁用。参数检查先于禁用分支，因此禁用时传旧参数同样报错；正常禁用的观察仍不检查输入。共享快照实现保持原样。

验证：`node --test test/evidence-shadow.test.mjs test/attribute-evidence-v1.test.mjs test/attribute-evidence-v1-regression.test.mjs`，34 项通过，0 失败。仅运行纯模块测试，未运行入口或 `service.test.mjs`；未接触真实配置、数据库、密钥或网络。测试涵盖继承与自有旧参数、禁用状态、getter、代理和严格未处理拒绝模式下的异步回调。

迁移风险：调用方须删除 `analyze`，包括值为 `undefined` 或处于禁用状态的情况；依赖注入的调用方须调整为内置分析器。代理选项、代理原型及 `enabled` getter 也须调整为普通数据属性。尚未进行宿主集成验证。
