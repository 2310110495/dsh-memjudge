# dsh-memjudge

面向 DeepSeek Harness (Cordis) 的可验证本地记忆插件：L0 原文无损存储 + L1 结构化事实派生 + L2 Wiki 编译投影 + 拒答/冲突裁决 + 双边自动采集 + Web 设置面板。

## 核心能力与工具面（7 Tools + 1 Section + 1 Service）

插件挂载后向宿主注册 **7 个 `memjudge_*` 工具**、1 个系统提示词注入段 `memjudge:recall`（order `700`）与只读服务 `ctx.memjudge`：

| 工具名 | 职责 |
|---|---|
| `memjudge_remember` | 写入一条记忆（幂等哈希去重，支持 `kind`: `person` / `promise` / `event`、`tier`、`importance`、`source`、`supersedes`） |
| `memjudge_recall` | 按查询检索相关记忆片段（BM25 + jieba 分词 + 可选向量/重排/查询扩展/LLM 选段 + 证据判断门禁与冲突提示） |
| `memjudge_read` | 按记忆 ID 读取未截断的完整原文与 UTF-16LE 版本摘要 |
| `memjudge_forget` | 按 ID 列表或 `source` 删除记忆及其来源位置记录（支持 `dryRun` 预览，事务原子提交） |
| `memjudge_demote` | 将误判为 `person` / `promise` 的钉住记忆显式降级为普通 `event`（恢复时间衰减淘汰） |
| `memjudge_conflicts` | 扫描库中同一实体属性槽位上的多值冲突及修订线索 |
| `memjudge_stats` | 返回记忆条数、三分/五层分布、派生事实数、段磨损率与 SQLite 存储体积 |

## 同源 Fetch RPC 与设置面板

`src/rpc.mjs` 与前端 `client.js` / `cordis.patch.yml` 配合，挂载 8 条同源 Fetch 路由供 DSH 设置面板调用：

- `GET /api/memjudge.status` — 库统计、配置脱敏快照与三组模型就绪状态
- `GET /api/memjudge.memories` — 记忆列表预览与来源标签
- `GET /api/memjudge.conflicts` — 槽位冲突摘要
- `POST /api/memjudge.saveKey` — 保存对话 / 向量 / 重排分组密钥
- `POST /api/memjudge.clearKey` — 清除已保存分组密钥
- `POST /api/memjudge.saveConfig` — 保存基础配置项
- `POST /api/memjudge.saveSettings` — 保存分组接口、自动采集、注入预算、衰减模式等运行设置
- `POST /api/memjudge.testKey` — 在线连通性自检（带超时与脱敏诊断）

## 自动采集（双边通道）

- **用户侧（`agent/pre-step`）**：白名单过滤真实用户消息，经长度、形态、近重复、配额、冷却六道闸门与 `person` / `promise` / `event` 分类后幂等落库。
- **助手侧（`session/event`）**：剔除思考链、工具块与代码围栏，对长回复按段切分并提取高价值结论与动作型事实，统一以 `event` 类落库。

## 目录结构

```text
memjudge-plugin/
├── client.js                  # DSH Web 设置面板客户端入口
├── cordis.patch.yml           # 宿主默认配置补丁声明
├── package.json               # 包清单（零外部私仓路径依赖）
├── src/                       # 23 个核心运行时模块
│   ├── index.mjs              # Cordis 插件入口（7 工具 + 注入段 + 双边采集 + ctx.effect 生命周期）
│   ├── store.mjs              # SQLite 原文存储（node:sqlite）、v7 迁移、段位图、occurrences 与派生刷新
│   ├── search.mjs             # BM25 倒排索引、jieba 分词、时间衰减与 RRF 混合检索
│   ├── judge.mjs              # 存在性拒答门禁、数值单位归一化与文档级冲突检测
│   ├── layer.mjs              # L2 Wiki 内存编译层、主题路由与冲突裁决行生成
│   ├── schema.mjs             # 记忆模型、双档/单档衰减公式与 ID 生成
│   ├── extract.mjs            # L1 规则事实四元组抽取与实体/属性清洗
│   ├── service.mjs            # ctx.memjudge 只读宿主服务封装
│   ├── rpc.mjs                # /api/memjudge.* 同源 Fetch RPC 路由
│   ├── config.mjs             # 对话/向量/重排三组独立凭据与运行参数解析
│   ├── vector.mjs             # 向量嵌入客户端与按模型隔离的本地缓存
│   ├── rerank.mjs             # Cross-Encoder 重排客户端与降级观测
│   ├── query-expand.mjs       # LLM 查询扩展（只补尾不改原序）
│   ├── llm-client.mjs         # OpenAI 兼容 Chat 接口统一调用器
│   ├── llm-extract.mjs        # 可选 LLM L1 事实抽取与原文子串 Grounding 校验
│   ├── llm-select.mjs         # 可选 LLM 候选段重排筛选
│   ├── auto-capture.mjs       # 用户侧自动采集六道闸、配额状态机与 source 编解码
│   ├── auto-capture-assistant.mjs # 助手侧自动采集五道闸与分段规划入口
│   ├── auto-capture-segment.mjs   # 助手长回复机械切段与权重评估
│   ├── auto-capture-facts.mjs     # 动作型事实抽取与工作态摘要
│   ├── auto-capture-turn.mjs      # 会话轮次缓冲器
│   ├── kind-classify.mjs      # 人/约/事（person/promise/event）规则分类与配额
│   └── text-wellformed.mjs    # UTF-16 孤立代理项校验
├── scripts/                   # 独立运维与诊断脚本
│   ├── check-service.mjs      # 只读校验 ctx.memjudge 服务契约
│   ├── nightly.mjs            # Event 记忆时间衰减分层下沉批处理（支持 --dry-run）
│   ├── panel.mjs              # 本地独立可视化诊断面板
│   └── verify-install.mjs     # 装机副本与源码仓 SHA-256、服务面及库 tier 一致性体检
├── docs/                      # 核心架构与模块设计规格
│   ├── SPEC.md                # 核心能力与存储预算规格说明
│   ├── auto-capture-spec.md   # 自动采集设计规格
│   ├── panel-spec.md          # 设置面板与 RPC 协议规格
│   └── wiki-layer-spec.md     # L2 Wiki 编译投影规格
└── test/                      # 自包含核心单元测试套件（零外部语料仓耦合）
```

## 验证与运维命令

```bash
# 语法静态检查
node --check src/*.mjs client.js

# 运行全套自包含单元测试
node --test

# 装机一致性体检
node scripts/verify-install.mjs

# 夜间分层下沉演练（只读不改库）
node scripts/nightly.mjs --dry-run
```
