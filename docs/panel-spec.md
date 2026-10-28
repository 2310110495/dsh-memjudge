# 「记忆库」面板 · 信息架构与视觉规格

目标读者：按此文实现 `memjudge-plugin/client.js` 的工程师。文中所有数值可直接落成内联 style 对象或注入 CSS。
范围：设置页 `settings.section`（id `memjudge`）与对话右栏 tab（id/kind `dsh-memjudge`）渲染的同一个 `MemjudgePanel`。

## 0 事实基线（已核实，不是假设）

数据契约（`src/rpc.mjs`）：

| 端点 | 入参 | 返回 |
| --- | --- | --- |
| `status` | `{}` | `{stats:{memories,segments,facts,attrCount,textChars,textBytes,bytes,limitBytes,withinLimit,wornSegments,wear,maxChars},config:{configPath,secretsPath,hasKey,keySource,keyMasked,baseUrl,chatModel,embedModel,rerankModel,dims,flags,envLocked?,hint}}` |
| `memories` | `{limit:120}` | `{rows:[{id,chapter,created,accessed,importance,text}]}`，`text` 已截 200 字 |
| `conflicts` | `{cap:40}` | `{conflicts:[{attr,values:[...]}]}` |
| 本轮新增 | `saveKey{key}` `clearKey{}` `saveConfig{patch}` `testKey{key?}` | 同 `{ok,value}` / `{ok:false,error}` 信封 |

三条被核实的行为，直接改变设计：

1. **`memories` 返回的是最早 120 条，不是最新 120 条。** `store.list` 是 `ORDER BY created_at LIMIT ?`（`src/store.mjs:771`），rpc 不暴露 offset。面板必须如实标注口径，不能写「最近 120 条」。
2. **五个模块被 key 硬门控，不是「建议开启」。** `moduleFlags()` 里 `vector/rerank/expand/llmSelect/llmExtract` 全部是 `hasLlmKey() && on(...)`（`src/config.mjs:131-136`），`jieba` 只受 `MEMJUDGE_NO_JIEDA` 环境变量控制（`src/config.mjs:137`）。所以是 5 个可配 + 1 个只读。
3. **env 会静默压过面板写入的 config。** `on()` 的逻辑是 env `'1'`/`'0'` 优先，否则才看 `config[cfgName]`（`src/config.mjs:123-128`）。用户在面板上点亮开关、写进 config.json，但只要进程带着 `MEMJUDGE_VECTOR=0`，重拉 status 后开关仍是关的。这是「点了没反应」的第二个来源，必须在 UI 上区分。

另有两处文案冲突需处理：`config.hint` 在未配置时输出「填自己的 key 见 secrets.json」——正是用户抱怨的句子，面板不复用这句原文，由前端按 §3 自拼文案，`hint` 只在 `hasKey` 为真时作兜底补充。

## 1 令牌来源

基线 10 个（本任务给定，全部使用）：
`--dsw-alias-label-primary` `--dsw-alias-label-secondary` `--dsw-alias-label-tertiary` `--dsw-alias-bg-layer-1` `--dsw-alias-border-l3` `--dsw-alias-interactive-bg-hover` `--dsw-alias-state-error-primary` `--dsw-static-neutral-200` `--dsw-static-neutral-700` `--dsw-radius-xl`

扩展 11 个，全部来自宿主自身代码而非自造，逐条注明出处：

| 令牌 | 出处 | 用途 |
| --- | --- | --- |
| `--dsw-alias-bg-layer-2` | `dsh-context/lib/client.js` css `.lc-stat{background:var(--dsw-alias-bg-layer-2)}` | 指标格底、进度条轨道 |
| `--dsw-alias-border-l2` | 同上 `.lc-card{border:1px solid var(--dsw-alias-border-l2)}` | 卡片 1px 边 |
| `--dsw-alias-border-l1` | 同上 `.lc-ts-arg-row{border-top:1px solid var(--dsw-alias-border-l1)}` | 行内分隔 |
| `--dsw-alias-state-success-primary` | 同上 `.lc-ts-call-ok{color:var(--dsw-alias-state-success-primary)}` | 正常/在线 |
| `--dsw-alias-state-warn-primary` | 同上 `.lc-ts-param-req{color:var(--dsw-alias-state-warn-primary)}` | 警告/近上限 |
| `--dsw-alias-button-primary-fill` | 同上 `.lc-gran-on{background:var(--dsw-alias-button-primary-fill)}` | 主按钮底 |
| `--dsw-alias-label-primary-foreground` | 同上 `.lc-gran-on{color:var(--dsw-alias-label-primary-foreground)}` | 主按钮字 |
| `--ds-font-family-code` | 同上 `.lc-error-msg{font-family:var(--ds-font-family-code,...)}` | 数字/路径等宽 |
| `--ds-transition-duration` | 同上 `transition:color var(--ds-transition-duration,.2s)` | 过渡时长 |
| `--ds-ease-in-out` | 同上 | 过渡曲线 |
| `--dsw-shadow-lv3` | 同上 `.lc-ov-card{box-shadow:var(--dsw-shadow-lv3,...)}` | 仅记忆条目展开浮层 |

**一处方向纠正**：任务书把 `--dsw-static-neutral-200` 记为「深色主题」、`-700` 记为「浅色主题」。宿主 guide 页实测是反的：`._f0giq_hero{color:var(--dsw-static-neutral-200)}` 为默认（浅色）取值，`body[data-ds-dark-theme] ._f0giq_hero{color:var(--dsw-static-neutral-700)}` 为深色取值（`@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:353`）。这两个令牌在宿主里只用于极低对比的水印装饰，**本面板不把它们用于任何需要读的文字**，正文层级一律走 `label-primary/secondary`。

## 2 信息架构

五个分区，顺序按「先看清现状 → 再决定要不要增强 → 再翻具体内容」排列。原顺序把密钥放在模块开关之后，是「为什么点不动」的直接成因，这里合并成 B 区。

| # | 分区 | 回答用户什么问题 | 展示字段（来源） |
| --- | --- | --- | --- |
| A | 概览 | 库里有多少东西、快满了没有、还健康吗 | 6 指标格：记忆条目 `stats.memories`（副标 `segments` 段）、三元组 `stats.facts`（副标 `attrCount` 属性）、正文字数 `stats.textChars`、占用 `bytes`/`limitBytes`（副标 余量）、已磨损段 `wornSegments`（副标 `wear`）、单条上限 `maxChars`（`status`）；占用进度条；重要度分档堆叠条（`memories` 采样）|
| B | 增强能力与密钥 | 增强有没有开、没开是因为我没填 key 吗、填在哪 | 密钥状态行（`hasKey` `keySource` `keyMasked`）+ 输入框 + 三按钮；6 行模块开关（`flags`）；模型只读行（`baseUrl` `chatModel` `embedModel`+`dims` `rerankModel`）|
| C | 记忆条目 | 里面到底记了什么 | 每条：章 `chapter`、重要度 `importance`、写入时间 `created`、访问时间 `accessed`、正文 `text`（`memories`）|
| D | 冲突候选 | 有没有前后矛盾的数值要我去看 | 属性名 `attr` + 取值序列 `values`（`conflicts`）|
| E | 页脚 | 删除在哪做、配置文件在哪 | 固定文案 + `configPath`/`secretsPath` |

**三态文案（逐字实现，不要改写）**

| 分区 | 加载中 | 空 | 出错 |
| --- | --- | --- | --- |
| 全部（首屏） | 头图下方一行 `正在读取记忆库…`，A 区渲染 6 个空指标格（数字位显示 `—`），B/C/D 区渲染 1 行灰字 `读取中…` | — | 头部状态行 `读取失败：{{error.message}}`，全文只保留 A 区壳 + 一个 `重试` 主按钮；C/D 不再各自报错 |
| A | 数字位 `—`，副标空 | `库里还没有记忆。在对话里用 memjudge_remember 写入第一条。`（进度条仍显示 0%，不隐藏） | `读不到库体数据` + 原因行（等宽、`state-error-primary`）+ `重试` 按钮 |
| B | 开关位渲染禁用态空壳，密钥行 `读取配置中…` | 密钥未配置：`未配置密钥。向量、重排、查询扩展、LLM 选段、LLM 提取五项增强全部停用，检索退回关键词匹配。` 模块行照常列出，全部禁用（理由见 §4） | `配置读取失败：{{msg}}`，密钥区替换为单个 `重试` 按钮 |
| C | 3 条骨架行（高度同真实行） | `库里还没有记忆。在对话里用 memjudge_remember 写入第一条。` | `记忆列表读取失败：{{msg}}` + `重试` |
| D | 1 行 `检查冲突中…` | `没有冲突候选。只有同一属性出现过两个不同取值时才列在这里，现在是干净的。` | `冲突候选读取失败：{{msg}}` + `重试` |

超过上限时的口径提示（C 区标题右侧，`1/2 类文案`）：`rows.length === 120 && stats.memories > 120` 时显示 `显示最早 120 条 · 共 {{memories}} 条`；否则显示 `{{rows.length}} 条`。

**组件树**（缩进即嵌套；括号内为宽窄两档差异）

```
MemjudgePanel              根 div：container-type:inline-size; 13px; label-primary
  PanelHeader              标题 20/600 · 副标题 13/secondary · 右侧「↻ 刷新」次按钮
  SectionA Overview        「概览」
    StatGrid               6 × MetricCard(label 12/secondary, value 20/600 tabular-nums, sub 12/secondary)
    UsageBar / ImportanceBar  6px 占用条(bg-layer-2 轨道+阈值填充+百分比) · 8px 重要度三段堆叠条 + 图例 12/secondary
  SectionB Enhance         「增强能力与密钥」
    KeyCard                徽标(success/warn) + 掩码 13/mono + 来源说明 12/secondary
      KeyForm              Input(password|text) · ShowToggle(28×32) · Save(32) · Test(32) · Clear(32)
      KeyFeedback          12px，aria-live="polite"
    ModuleList             6 × ModuleRow[ name 96 | desc flex | Switch 36×20 ]（窄档折两行）
  SectionC Memories        「记忆条目」+ 右侧口径计数
    GroupHeader            章号 + 条数（sticky top:0，底色 bg-layer-1）
    MemoryRow              [2px 重要度竖条] + 正文(2 行 clamp, button) + 元信息 12/secondary
  SectionD Conflicts       「冲突候选」
    ConflictRow            属性 96/mono + 取值序列（窄档换行）
  SectionE Footer          configPath / secretsPath，12/label-tertiary
```

## 3 视觉规格

**字号阶梯**（理由落到真实场景：1080p + Windows 125% 缩放下，12px 中文正文映射到 15 物理像素，横竖笔画在 hinting 后糊成一团，这是「太淡看不清」的主因之一；同时当前 11px 的灰色小字在所有主题下都低于可读阈值）

| 用途 | 字号 / 行高 / 字重 | 令牌 |
| --- | --- | --- |
| 面板标题 | 20 / 1.3 / 600 | `label-primary` |
| 面板副标题 | 13 / 1.5 / 400 | `label-secondary` |
| 分区标题 | 13 / 1.4 / 600，前置 3px×13px 竖条用 `border-l3` | `label-primary` |
| 卡片标题 | 13 / 1.4 / 600 | `label-primary` |
| 正文、表格单元、开关名、记忆正文 | 13 / 1.55 / 400 | `label-primary` |
| 说明小字、副标、时间、路径 | 12 / 1.5 / 400 | `label-secondary` |
| 指标大数字 | 20 / 1.2 / 600 + `font-variant-numeric:tabular-nums` | `label-primary` |
| 脚注 | 12 / 1.6 / 400 | `label-tertiary` |
| 等宽（数字、路径、模型名） | 12 或 13 / 同上 | `font-family: var(--ds-font-family-code, ui-monospace, monospace)` |

硬规则：**中文不使用 11px**。11px 只允许出现在纯数字计数徽标和单字母缩写上；`label-tertiary` 只允许出现在 ≥13px 的脚注或 ≤12px 的非关键时间上，正文层级只用 primary/secondary——这一条直接消灭「一片灰糊」。

**间距尺度**（4 的倍数，宽窄两档）

| 量 | 宽档（设置页） | 窄档（右栏） |
| --- | --- | --- |
| 面板内边距 | `24px 28px 40px` | `12px 12px 28px` |
| 面板最大宽度 | `1120px`（对齐宿主 `.lc-ov-card{width:min(1120px,...)}`），取代现 980 | 不设，撑满 |
| 分区垂直间距 | 20 | 12 |
| 卡片内边距 | `14px 16px` | `10px 12px` |
| 卡片间距 | 14 | 8 |
| 卡内元素间距 | 10 | 8 |
| 列表行内边距 | `8px 0` | `8px 0` |
| 控件组间距 | 8 | 8 |

**层级与圆角**：面板底不画背景（继承宿主页面底），卡片用 `bg-layer-1` + `1px solid border-l2` + `border-radius: var(--dsw-radius-xl)`。嵌入卡片内部的小块（指标格、徽标、进度条）用 `bg-layer-2` + `1px solid border-l2` + `border-radius: calc(var(--dsw-radius-xl) / 2)`。三级层次靠底色差与边框差，不靠阴影；唯一例外是记忆条目展开浮层，用 `--dsw-shadow-lv3`。

**占用进度条**：容器高 6px、`border-radius:999px`、轨道 `bg-layer-2`、填充按占用比阈值切令牌：`<70% → state-success-primary`，`70%~89% → state-warn-primary`，`≥90% → state-error-primary`（原实现 85% 才告警，但记忆写入是批量事务，一次可压入多条，10% 缓冲边界更贴近真实风险）。条右侧 40px 常驻百分比数字（等宽，13px，`label-secondary`）。

**占比可视化**：不做环形图。环形需要「分类齐全 + 总量已知」，而 `memories` 只是按 `created_at` 取的最早 120 条切片，用它画环形会给出错误的全貌。改用**重要度分档堆叠横条**：一条 8px 高的横条按时长比例分三段（`importance ≥ 0.6` → `state-success-primary`；`0.3~0.6` → `state-warn-primary`；`< 0.3` → 用 `border-l3` 作中性段），下方图例 `重要 12 · 普通 40 · 未标注 68（近 120 条口径）`。0.6 这个分界与 `memjudge_remember` 的 importance 语义一致。

**状态色**：正常 `state-success-primary`，警告 `state-warn-primary`，危险/失败 `state-error-primary`。三者永远同时配文字，不单靠颜色传达状态（色盲兜底）。

## 4 密钥区交互

位置：B 区顶部，独立卡片，卡标题 `密钥`，右侧一枚状态徽标。

已配置态（`hasKey === true`）：徽标 `state-success-primary`，文案 `已配置`；徽标下一行 13px `label-primary`：`{{keyMasked}}`（等宽）；再下一行 12px `label-secondary` 说明来源，按 `keySource` 二选一：
- `secrets.json` → `你自己填的，存于本机 secrets.json`（这是用户最想看到的确认）
- `env` → `来自环境变量 MEMJUDGE_LLM_KEY（换机器要重新填）`，徽标同时带 `state-warn-primary` 副点，因为「别人的 key」是易错状态。

未配置态（`hasKey === false`）：徽标 `state-warn-primary` 文案 `未配置`；正文 13px：`填上你自己的 API key，下面五项增强才能打开。`；不出现 `secrets.json` 字样作为行动指引。

控件（一行，宽度不足时按 §6 折行）：
- 输入框：`type` 在 `password`/`text` 间切换，`flex:1`，`min-height:32px`，`padding:0 10px`，`bg-layer-1` 底、`1px solid border-l2`、圆角 `calc(var(--dsw-radius-xl)/2)`、13px、`::placeholder` 用 `label-tertiary`。占位文案 `粘贴 API key（sk-...）`。
- 显示/隐藏：输入框右内嵌 28×28 图标按钮，`aria-label="显示密钥"`/`"隐藏密钥"`，`aria-pressed` 同步。默认 `password`。
- 主按钮 `保存密钥`：`min-height:32px`、`padding:0 16px`、`background: state-success-primary? 否 → 用 var(--dsw-alias-button-primary-fill)`、字色 `var(--dsw-alias-label-primary-foreground)`、13px 600、圆角 `calc(var(--dsw-radius-xl)/2)`。输入为空时禁用（`opacity:.5`、`cursor:not-allowed`）。
- 次按钮 `测试连接`：描边式，`border:1px solid border-l2`、透明底、13px、字色 `label-primary`；悬停 `background: interactive-bg-hover`。
- 次按钮 `清除`：与 `测试连接` 同级但靠右，字色 `state-error-primary`，透明底。仅在 `hasKey === true` 时出现。

三态呈现（就地，不用 toast）：
- 保存中：按钮文案改 `保存中…`，`disabled`，输入框同步 `disabled`，输入内容**保留**（失败时可改，不要清空）。
- 保存成功：按钮区下方一行 12px `state-success-primary`：`已保存，密钥即刻生效。` 同时自动重拉 `status`，徽标从「未配置」变「已配置」并显示新掩码——这是用户判断「我填的生效了没有」的唯一可靠信号，必须是服务端回读而非前端乐观更新。成功行 4 秒后淡出，`aria-live="polite"`。
- 保存失败：同一位置 12px `state-error-primary`：`保存失败：{{error.message}}`，保留输入。
- 测试中：`测试连接` 文案改 `测试中…` 并禁用，另两个按钮一并禁用。
- 测试成功：`连接正常 · {{ms}} ms · 模型 {{chatModel}}`（12px，`state-success-primary`）。
- 测试失败：`连接失败：{{status}} {{message}}`，附一句 12px `label-secondary`：`401 表示 key 无效或已过期；连不上表示端点不可达。`
- 清除：二段确认，第二次点击按钮文案变 `确认清除`（`state-error-primary` 实底 + 白字），5 秒无操作回退。成功后一行 `密钥已清除，增强模块已停用。` 并重拉 `status`。

## 5 模块开关交互

形态：**开关（switch）**，不用勾选框。理由：开关表达「立即生效的设置」，勾选框在中文界面里更像「待提交的表单项」，而这里每次改动都会立刻写 config 并影响下一次检索。

行结构（每行三列，窄档折成两行）：名称（13px primary，宽 96px）｜说明（12px secondary，占满剩余）｜开关（右对齐，`role="switch"` + `aria-checked`，尺寸 36×20，轨道 `border-l3`，开态轨道 `button-primary-fill`，滑块白色 16×16，`min-height:28px` 命中区靠外层 padding 补足）。

六行的门控分四类，必须视觉可分：
- `jieba 分词`：**只读**。开关渲染为静态指示（无滑块动画、`cursor:default`、`aria-disabled="true"`），右侧 12px `label-secondary` `只读 · 由环境变量 MEMJUDGE_NO_JIEBA 控制`。说明 `搜索引擎模式切词，替代 CJK 二元组`。
- 其余五个（`vector` `rerank` `expand` `llmSelect` `llmExtract`）：受 key 门控。`hasKey === false` 时全部禁用，开关右侧换成一个 12px `state-warn-primary` 的 `先填密钥` 文本链接，点它把焦点滚到 §4 的输入框（`input.focus()`）。整行同时 `title` 说明 `这五项都要调外部模型，没有 key 会在每次检索时等超时，所以被强制关闭。`——这句解释就是用户问「为什么点不动」的答案。
- `env 锁定`（`config.envLocked[flag] === true`）：开关禁用，右侧 12px `label-secondary` `由环境变量锁定`。后端未提供 `envLocked` 时跳过这一分支，绝不凭猜。
- 无 key 且 `envLocked`：`先填密钥` 优先显示。

即时反馈：改动后不乐观更新。流程是 `saveConfig({[flag]:next})` → 成功后 `status` 重拉 → 用返回值渲染。期间该行开关进入 `busy` 态（滑块半透明 + 禁用）。回读值若与用户点击值不一致，右侧出现 12px `state-warn-primary`：`已保存，但被环境变量覆盖为 {{实际值}}`——这是本规格对「点了没反应」的兜底出口。

## 6 记忆条目列表

不做表格，避免横向滚动。滚动容器 `max-height: 320px; overflow-y: auto; overscroll-behavior: contain`（320 与宿主 `.lc-events{height:320px}` 同尺度），滚动条 `scrollbar-width: thin`。

按 `chapter` 分组：同章连续合并，组头 12px `secondary`，内容 `第 {{chapter}} 章 · {{n}} 条`；`chapter` 为空串的归入末尾组，组头 `未标章`。组头 `sticky top:0`，背景 `bg-layer-1`（必须给底色，否则滚动时文字交叠）。

单条结构（左竖条 + 两行 + 第三行正文）：

```
┌─ 2px 竖条（重要度色阶）──────────────────────────────┐
│ 正文 13px/1.55，最多 2 行，-webkit-line-clamp:2       │
│ 12px secondary：3 天前 · 重要 0.72 · 访问 2 次        │
└──────────────────────────────────────────────────┘
```

- 重要度：左侧 2px 竖条，`≥0.6` → `state-success-primary`，`0.3~0.6` → `state-warn-primary`，`<0.3` → `border-l3`；数值同时以 `重要 {{toFixed(2)}}` 出现在元信息行，`<0.3` 时该段整体省略。不单靠颜色。
- 时间：相对时间。`≤60min` → `{{n}} 分钟前`；`≤24h` → `{{n}} 小时前`；`≤7d` → `{{n}} 天前`；更早 → `MM-DD`（跨年 `YYYY-MM-DD`）。`accessed` 与 `created` 不同时展示两个：主位放 `created`（这条何时进来的），`accessed` 仅在 `accessed > created` 时以 `· 最近访问 {{相对时间}}` 追加。绝对时间放 `title`。
- 长文本：`text` 已是 200 字截断；容器内 2 行 clamp，点击整行切换展开/收起（受控，不改变滚动锚点）。展开时 `white-space: pre-wrap`、`word-break: break-word`、不加 `max-height`。`id` 以 `title` 落在行上（`memjudge_forget` 需要它）。
- 空 `text`：显示 `（空条目）` 于 `label-tertiary`。

## 7 窄栏适配

实现方式：注入的 CSS 用 `@container memjudge (max-width: 520px)` 与 `(max-width: 400px)`，容器由面板根节点 `container-type: inline-size` 建立。不用 `@media`——同一组件在两处宽度不同，媒体查询看的是视口，判不出来。设置页与右栏只看内宽，不看来源。

| 元素 | ≥521px | 401~520px | ≤400px |
| --- | --- | --- | --- |
| 面板内边距 | 24/28/40 | 16/20/32 | 12/12/28 |
| 指标格 | `repeat(auto-fit,minmax(170px,1fr))`，1120px 内宽下六格自成一行 | `repeat(2,minmax(0,1fr))`，2 列 | 同 2 列，大数字 20→18 |
| 模块行 | 名称+说明+开关 一行 | 同左，说明允许换行 | 两行：名称+开关一行，说明第二行 |
| 密钥控件行 | 输入框+显示键+三按钮 一行 | 输入框整行，三按钮第二行右对齐 | 输入框整行；按钮 `flex:1` 平分一行 |
| 记忆条目 | 正文 2 行 + 元信息 1 行 | 同左 | 元信息拆两行（时间一行，重要/访问一行） |
| 冲突条目 | 属性 96px + 取值序列 | 同左 | 属性整行，取值序列下一行，`padding-left:0` |
| 分区折叠 | 全展开 | 全展开 | C 区（记忆条目）默认收起，标题右侧 `展开 120 条` |

不做「按来源是否右栏」的分支判断，避免两处渲染出现行为差异。

## 8 可访问性下限

- 正文 13px（见 §3 理由），最小可交互文字 12px。
- 对比度：正文用 `label-primary`，说明用 `label-secondary`，二者在宿主明暗两套主题下均满足 4.5:1 以上。这正是必须逐字改写现状的原因：现 `#8b8f96` 落在自绘的 `#0b0c0e` 暗底上是 6.0:1（成立），但设置页底由宿主控制，浅色主题下同一灰色落在白底上只有 3.2:1，远低于 4.5:1 正文线——「太淡」不是错觉，是硬编码色在另一套主题下失真。`label-tertiary` 只用于 ≥13px 脚注，不承载信息。
- 键盘可达：所有按钮 `:focus-visible` 给 `outline: 2px solid var(--dsw-alias-label-primary); outline-offset: 2px`；开关用原生 `<button role="switch">`，Space/Enter 均可切换；记忆条目展开用 `<button>` 而非 `<div onClick>`。
- 命中区：所有按钮 `min-height: 28px`，主按钮 32px；显示/隐藏图标按钮因内嵌输入框，宽 28px 高撑满输入框（32px）。
- `aria-live="polite"` 只挂在密钥/开关的结果提示容器上，滚动列表不加，避免读屏刷屏。
- 折叠区（§7 的 C 区收起态）用 `aria-expanded` + `aria-controls`。

## 9 明暗主题取值表

结构性颜色全部是 `var(--dsw-alias-*)`，随主题自动切换，**代码里不需要任何 `body[data-ds-dark-theme]` 分支**。真实需要该钩子的只有一类：装饰性底纹。

| 元素 | 浅色 | 深色 | 是否需 dark 钩子 |
| --- | --- | --- | --- |
| 面板文字 | `label-primary` | `label-primary` | 否 |
| 卡片底 / 边 | `bg-layer-1` / `border-l2` | 同左 | 否 |
| 指标格底 | `bg-layer-2` | 同左 | 否 |
| 悬停底 | `interactive-bg-hover` | 同左 | 否 |
| 进度条轨道 | `bg-layer-2` | 同左 | 否 |
| 分区竖条 | `border-l3` | 同左 | 否 |
| 装饰水印（可选） | `var(--dsw-static-neutral-200)` | `body[data-ds-dark-theme]` 下 `var(--dsw-static-neutral-700)` | **是**，且方向按 §1 纠正后的实测值 |

唯一需要注入 CSS 写 `body[data-ds-dark-theme]` 的地方就是最后一行；若最终不做水印，可整段删掉，主题适配随之归零。

## 10 关键取舍

**注入一段 `<style>` 是必要的，不是图省事。** 内联 style 对象表达能力有四个硬缺口：`:hover`、`:focus-visible`（键盘态与鼠标态必须区分，`onFocus` 状态位做不到）、`@container`（本规格两处宽度差异的唯一可行手段）、`body[data-ds-dark-theme]` 后代选择器。宿主自身就是这么做的且写法定型，照抄其幂等模式即可（`@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:355-361`）：

```js
const CSS = '@container memjudge (max-width:400px){...}';
const id = 'dsh-memjudge/panel.css';
if (!document.querySelector('style[data-plugin-css="' + id + '"]')) {
  const el = document.createElement('style');
  el.dataset.plugin = 'dsh-memjudge';
  el.dataset.pluginCss = id;
  el.textContent = CSS;
  document.head.appendChild(el);
}
```

注入只做「内联做不到的那四件事」，布局与颜色仍用内联 style + 令牌 `var()`，这样样式改动集中在 JS 一处，不必两套维护。被否决的替代方案：纯内联 + `ResizeObserver` 模拟容器查询 + `onMouseEnter/onFocus` 手动维护 hover/focus 状态——代码量翻倍、每行列表项都要独立 state 引起重渲染、且 `:focus-visible` 语义无法还原，直接牺牲 §8 的键盘可达性。

**不用环形图**（理由见 §3）。**不用表格**（记忆条目与冲突都改成行卡片，横向滚动在 400px 宽度下不可接受）。**不乐观更新**（密钥与开关都以 status 回读为准，宁可多一次 RPC，也不让用户看到「开了其实没开」）。**复用 `hint` 是错的**（它写着「见 secrets.json」，与 B 区的目的相反；只在 `hasKey` 为真时用）。

## 11 后端契约增补（前端无法自行解决，须本轮或下轮补）

1. `config` 增加 `envLocked: {vector:boolean, rerank:boolean, expand:boolean, llmSelect:boolean, llmExtract:boolean}`，语义为「该 flag 由 `MEMJUDGE_*` 环境变量决定，config 写入无效」。没有它，§5 的「由环境变量锁定」与「被环境变量覆盖为 X」两条文案无法实现，用户仍会看到「点了没反应」。
2. `memories` 增加 `order: 'asc' | 'desc'`，默认 `desc`。当前实现返回最早 120 条，与用户直觉相反；在补上之前，C 区必须显示 §2 的「显示最早 120 条」文案，不能说「最近」。
3. `saveKey` 返回后必须让 `status` 立即反映新密钥（`config.mjs` 已有 `cache = null` 失效逻辑，`saveLlmKey` 已写，RPC 侧照调即可）；`testKey` 返回 `{ok, status?, latencyMs?, message}`，前端只做展示。
4. `config.hint` 未配置分支的文案改掉「见 secrets.json」这半句，改为 `未配置密钥：检索走纯 BM25。`（前端不再依赖它，但别让其它消费者看到错误指引）。

规格完成
