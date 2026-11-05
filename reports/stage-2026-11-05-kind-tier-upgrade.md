# 重复写入升级一致性阶段报告

## 历史：初次仅升级修复

- `src/store.mjs` 的层级契约规定 person/promise 恒为 1；重复写入将 event 改成这两类且未显式提供 tier 时，原实现只更新 kind，数据库中仍保留 event 的 tier，而返回值经归一化显示为 1。
- `src/index.mjs` 的记忆写入调用以是否提供 kind 区分分类变更与保持原分类；显式 event 降级保留原有行为。
- 修复仅对已有 event 显式升级 person/promise 时，在同一事务中设置 tier 1。其他重复写入的 tier 规则不变。

## 验证

- Node v24.22.1，清洁环境仅传 PATH、SYSTEMROOT、TEMP、TMP；使用 SQLite `:memory:`。
- 仅运行 `env -i PATH="$PATH" SYSTEMROOT="$SYSTEMROOT" TEMP="$TEMP" TMP="$TMP" node --test test/store-kind-tier-upgrade-synthetic.test.mjs`：6 项通过、0 项失败。
- 覆盖两种升级、缺省及显式 tier、原始数据库行与返回值、重复写入及 occurrence 去重、显式降级、触发器注入失败后的 kind/tier/occurrence 回滚和重试。
- 未运行插件入口、旧测试、全量测试或真实库迁移，也未读取真实配置、数据库、密钥或联网。历史上已处于不一致状态的非 event 行及其他路径不在本次修复范围。

## 独立复核后续修复

- 重复写入以最终有效 kind 决定层级：省略 kind 时沿用已有分类；有效分类为 person/promise 时，即使显式 tier 为 5 或当前连接中已有脏 tier，也在事务内钉为 1，返回层级与数据库一致。
- 显式非法非空 kind 仍归一化为 event；event 显式有效 tier 按现有规则钳制，未显式有效 tier 时保留已有层级，包括显式降级路径。
- 在原有独立 synthetic 测试增加两类省略 kind、同连接脏行、失败回滚和非法 kind/tier 覆盖。清洁环境内存 SQLite 运行指定测试，11 项通过、0 项失败；未运行旧测试或入口，未访问真实配置、数据库、密钥或网络。

## 重复 event 返回值复核

- 重复 event 未提供有效 tier 时，持久值保持原样，返回值使用既有 `normalizeTier`，与 `list` 一致；此修复不修复 event 的持久脏行。正常 tier 4 仍保持 4；脏值 9、0、2.9、非数字文本、空串、空白分别返回 5、1、2、3、1、1。空串和空白按 JavaScript 数值转换为 0 后钳到 1，并非回落默认 3。
- 重复写入的 kind 为 null 或空串时视为未提供，保留原分类；空白字符串视为显式输入，归一化为 event。tier 为 null、空串或非数字文本时视为未提供；空白字符串视为显式 0，归一化为 1。以上是现有行为，并非本次新增规则。
- 清洁环境仅运行 `env -i PATH="$PATH" SYSTEMROOT="$SYSTEMROOT" TEMP="$TEMP" TMP="$TMP" node --test test/store-kind-tier-upgrade-synthetic.test.mjs`，Node v24.22.1，SQLite `:memory:`，25 项通过、0 失败、0 跳过。未运行入口或旧测试，未读取真实配置、数据库、密钥或访问网络。
- 残余风险：数据库 `tier` 为 NOT NULL，合成回归未构造持久 NULL；`normalizeTier(null, 'event')` 依 JavaScript 数值转换返回 1。event 脏值仍留在存储中，其他直接读取原始行的路径可能观察到不同值；未执行真实数据库迁移或全量回归。

## 人／约物理类型复核

- 既有契约要求 person/promise 恒钉 1。SQLite `x'01'` 读取为 `Uint8Array([1])`，`Number` 转换为 1，旧比较跳过更新，返回 1 但 SQLite `typeof(tier)` 仍为 `blob`。修复前指定测试 38 项中两个 BLOB 用例失败，其余 36 项通过。
- 重复写入的有效 kind 为 person/promise 时，用严格比较检查原始读取值，必要时同一事务写入整数 1；event 分支保留原有数值比较与省略 tier 不写入的语义。SQLite INTEGER affinity 会将数值文本 `'1'` 存为整数；测试还覆盖其他 BLOB、文本、实数与整数，并直接检查 SQLite `typeof`。
- 修复后 Node v24.22.1，清洁环境仅传 PATH、SYSTEMROOT、TEMP、TMP，指定 `node --test test/store-kind-tier-upgrade-synthetic.test.mjs` 在 SQLite `:memory:` 下 38 项通过、0 失败、0 跳过。仅验证重复写入路径；未读取真实配置、数据库、密钥，未联网，未运行入口、旧测试、真实库迁移或全量回归。NOT NULL 列未构造持久 NULL；启动迁移与其他写入路径的动态类型行为未在本轮验证。
