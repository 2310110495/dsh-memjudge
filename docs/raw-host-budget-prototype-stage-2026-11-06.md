# Raw-host 采集预算闸门：原型阶段

## 交付

仅新增 `test/raw-host-budget-prototype.mjs` 与 `test/raw-host-budget-synthetic.test.mjs`，不接入 adapter、配置或既有入口。纯函数要求预算和元数据均为自身数据属性，数值均为非负安全整数；任一值缺失、异常、继承或访问器均拒绝。原型上限为 8 MiB 和 10000 条，调用者必须显式传入不高于该上限的两个预算；相等通过、超出拒绝。零值允许。数值仅为设计示例，并非依据生产分布测量的容量。

## 已核对事实

- 当前 `src/raw-host-adapter.mjs` 依次执行 list、open、首次近乎无界 read、后续分页 read，再调用 stat。stat 前置可用性、代价及来源一致性尚未证明；list 当前只检查 sizeBytes 是否缺失。现有合成 fixture 只提供 sizeBytes，故新闸门直接接入会保守地跳过这些来源。
- `src/raw-repository.mjs` 的 `markHostUncertain` 会事务性记录不确定区间，将三个水位压至 startSeq；`recordHostDirty` 只记脏，不做等价回退。`clearHostUncertain` 依据 provenance 的编码精确匹配来源，并要求完整事件证据覆盖记录的 endSeq。
- adapter 当前 provenance 包含从 open 后 handle 获得的 inheritedEventCount；拒绝前未取得该值，不能假装其值已知。mark 的区间要求 endSeq > startSeq，并扩展到当时 raw_next；未知末尾没有现成的无界区间表达。
- 本原型不证明 backend open 的资源使用有界、元数据真实或新鲜，也不证明 read 的返回字节上限或 EOF。即使数字通过，解压膨胀、并发变化、单条大事件及对象分配仍可能超过可用内存；要实现硬约束需要后端自身提供可验证的字节限制流、明确 EOF 和一致快照，或进程级资源隔离。

## 待验证的接入设计假设

- 授权 header 后，在任何可能读取正文的操作前，从可信且不读取正文的元数据源取得同一快照的大小和事件数；若缺值、过期、过大、验证失败或元数据读取本身可能加载正文，则跳过正文读取。需对真实后端逐项验证，不能依据方法名称推断。
- 无论通过或拒绝，须在可能的 ingest 之前持久标记从 0 开始的不确定状态；拒绝、读取异常、预算耗尽或未证明 EOF 的分支禁止调用 clearHostUncertain 和 recordHostPrefix，且不得仅依靠 dirty。标记失败则停止该会话处理；恢复要在完整、稳定、可验证的证据覆盖后进行。
- 接入前需要设计无需 open 即能确定、且与后续清除操作完全一致的稳定 provenance；也需要表达未知终点的持久屏障，并定义来源身份或继承计数变化时的迁移与清理。用虚构的 inheritedEventCount、任意 endSeq 或无证明的最大整数可能造成清理失败或错误清理；当前仓库接口尚未解决这些问题。
- 存在进程崩溃、并发扫描、来源修改及标记与数据发布之间的竞态，最终方案需验证事务边界和重启恢复；必要时为屏障和发布引入统一事务或序列化机制。

## 验证

执行 `node --test test/raw-host-budget-synthetic.test.mjs`：4 项通过、0 失败。仅使用合成数据，未访问真实配置、数据库、密钥、网络、默认提取或旧入口。