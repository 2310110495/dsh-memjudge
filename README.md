# dsh-memjudge

> **开发检查点，非正式发布（2026-11-13）**：本次先保存并提交 v2 工作。尚有证据门集成、STRICT 表约束及存储生命周期最终验证未完成；当前提交未通过最终完整回归，也未投产。详见 [已知问题与后续验证](docs/V2-CHECKPOINT.md)。

面向 DeepSeek Harness (Cordis) 的可验证本地记忆插件（v2）：SQLite Schema v8 工作区隔离存储 + L0-L3 四级热冷代谢 + 增量 Wiki 知识页 + 保 Prefix KV Cache 两段式动态注入（Tier-S + Tier-D）+ O(log N) 结构化槽位拒答与三分冲突裁决 + Turn 级异步脱水采集 + Web 治理面板。

## 核心能力与工具面（8 Tools + 2 Prompt Channels + 1 Service）

插件挂载后向宿主注册 **8 个 `memjudge_*` 工具**、两段式提示词通道（静态 `memjudge:recall` + 动态 `memjudge:context`，order `700`）与只读服务 `ctx.memjudge`：

| 工具名 | 职责 |
|---|---|
| `memjudge_remember` | 写入一条记忆（支持 v2 五类 `category`: `rule` / `profile` / `decision` / `experience` / `state` 与 `slotKey` 单活覆写修订链，向下兼容 `kind`: `person` / `promise` / `event`） |
| `memjudge_recall` | 按查询混合检索相关记忆片段（前置空间过滤 + BM25 + Int8 向量 + `entity_slots` 三路 RRF + O(log N) 证据门与冲突提示） |
| `memjudge_read` | 按记忆 ID 分页读取未截断的完整原文与 UTF-16LE 版本摘要 |
| `memjudge_forget` | 按 ID、查询、`source` 或 `space` 物理删除记忆及其派生槽位/向量（支持 `dryRun` 预览，事务原子提交） |
| `memjudge_demote` | 将误判为 `rule` / `profile`（`person` / `promise`）的常驻记忆安全降级为普通 `experience` / `event` |
| `memjudge_conflicts` | 基于 `entity_slots` 与章节聚合扫描多值矛盾，输出 `supersession` / `conditional` / `disputed` 三分定性与原句证据 |
| `memjudge_stats` | 返回 Schema v8 全维统计：空间分布、五类/三分分布、L0-L3 层级、Wiki 页数、Tier-S/Tier-D 预算与存储体积 |
| `memjudge_wiki` | 列出、按 `slug` 读取或触发增量编译当前空间的 L2 演进知识页（`wiki_pages`）及单活状态看板（`state`） |

## 同源 Fetch RPC 与设置面板

`src/rpc.mjs` 与前端 `client.js` / `cordis.patch.yml` 配合，挂载 8 条同源 Fetch 路由供 DSH 设置与记忆治理面板调用：

- `GET/POST /api/memjudge.status` — 库统计、空间列表、L0-L3 层级、注入水位、索引重建与配置脱敏快照
- `GET/POST /api/memjudge.memories` — 空间/范畴/层级过滤记忆列表、修订历史、单活状态、Wiki 编译与代谢触发
- `GET /api/memjudge.conflicts` — 三分冲突定性与证据摘要
- `POST /api/memjudge.saveKey` — 保存对话 / 向量 / 重排分组密钥
- `POST /api/memjudge.clearKey` — 清除已保存分组密钥
- `POST /api/memjudge.saveConfig` — 保存模块开关或触发索引重建
- `POST /api/memjudge.saveSettings` — 保存分组接口、模型名、向量维度、存储上限等运行设置
- `POST /api/memjudge.testKey` — 在线连通性自检（带超时与脱敏诊断）

## Turn 级异步脱水采集

- **轮次收集器（`src/turn-collector.mjs`）**：挂载 `agent/pre-step` 与 `session/event`，过滤子代理回执、纯寒暄与代码块噪声，剥离 `<think>` 思考链并掩码敏感凭据后写入持久化队列 `ingest_queue`。
- **双模脱水器（`src/distiller.mjs`）**：后台异步消费 `ingest_queue`，支持云端 LLM 结构化提炼与纯离线确定性规则回退，自动归入五类记忆并触发 `state` 单活槽位覆写。

## 目录结构

```text
memjudge-plugin/
├── client.js                  # DSH Web 记忆治理与设置面板客户端入口
├── cordis.patch.yml           # 宿主默认配置补丁声明
├── package.json               # 包清单（零外部私仓路径依赖）
├── src/                       # 24 个核心运行时模块（v2 架构）
│   ├── index.mjs              # Cordis 插件入口（8 工具 + Tier-S/Tier-D 注入 + 轮次采集 + 周期代谢）
│   ├── store.mjs              # SQLite 存储引擎（Schema v8：spaces / entity_slots / vectors / revisions / wiki_pages / ingest_queue）
│   ├── search.mjs             # 前置空间过滤 + BM25 + Int8 向量 + 槽位图三路 RRF 混合检索引擎
│   ├── inject.mjs             # 保 Prefix KV Cache 两段式动态注入器（Tier-S 静态底座 + Tier-D 按问召回 + SessionSeen）
│   ├── judge.mjs              # O(log N) 槽位拒答门（gateSlots）、数值单位归一化与三分冲突裁决（classifyConflict）
│   ├── lifecycle.mjs          # L0-L3 四级热冷代谢引擎、增量 Wiki 聚类编译与超限冷归档压缩
│   ├── distiller.mjs          # 云端 LLM / 本地规则双模异步脱水器与 ingest_queue 消费器
│   ├── turn-collector.mjs     # 会话轮次收集器、噪声/子代理门禁与敏感凭据脱敏
│   ├── slots.mjs              # 结构化实体-属性-值-单位-极性槽位抽取与查询匹配
│   ├── scope.mjs              # 工作区根检测、空间 ID 派生、可见空间矩阵与子代理识别
│   ├── layer.mjs              # L2 Wiki 内存投影编译与兼容主题路由
│   ├── schema.mjs             # 五类/三分记忆模型、L0-L3 层级映射、衰减公式与 ID 生成
│   ├── extract.mjs            # 规则事实四元组抽取与通用实体/属性构词清洗
│   ├── service.mjs            # ctx.memjudge 只读宿主服务封装
│   ├── rpc.mjs                # /api/memjudge.* 同源 Fetch RPC 路由与治理动作编排
│   ├── config.mjs             # 对话/向量/重排三组独立凭据、自动采集参数与运行配置解析
│   ├── vector.mjs             # 向量嵌入客户端、Int8 标量量化与反量化
│   ├── rerank.mjs             # Cross-Encoder 重排客户端与降级观测
│   ├── query-expand.mjs       # LLM 查询扩展（只补尾不改原序）
│   ├── llm-client.mjs         # OpenAI / DeepSeek 兼容 Chat 接口统一调用器（含超时中断与安全降级）
│   ├── llm-extract.mjs        # 可选 LLM 事实三元组抽取与原文子串 Grounding 校验
│   ├── llm-select.mjs         # 可选 LLM 候选段推理筛选
│   ├── tokenizer.mjs          # 中英混合分词（jieba 可用则加载，否则纯 JS 退化，CJK 连续二元组保 OOV 召回）
│   └── text-wellformed.mjs    # UTF-16 孤立代理项校验与修复
├── scripts/                   # 独立运维与诊断脚本
│   ├── check-service.mjs      # 只读校验 ctx.memjudge 服务契约
│   ├── nightly.mjs            # 记忆时间衰减分层下沉批处理（支持 --dry-run）
│   ├── panel.mjs              # 本地独立可视化诊断面板
│   └── verify-install.mjs     # 装机副本与源码仓 SHA-256、服务面及库 tier 一致性体检
├── docs/                      # 核心架构与模块设计规格
│   ├── SPEC.md                # 核心能力与存储预算规格说明
│   ├── auto-capture-spec.md   # 自动采集设计规格
│   ├── panel-spec.md          # 设置面板与 RPC 协议规格
│   └── wiki-layer-spec.md     # L2 Wiki 编译投影规格
└── test/                      # 39 个测试文件：单元、集成、发布回归与 1000 轮端到端压测
```

## 验证与运维命令

```bash
# 语法静态检查
for file in src/*.mjs client.js; do
  node --check "$file" || exit 1
done

# 运行全套自包含单元测试
node --test

# 装机一致性体检
node scripts/verify-install.mjs

# 夜间分层下沉演练（只读不改库）
node scripts/nightly.mjs --dry-run
```
