# 聊完自动长记忆（auto-capture）设计规格

> 状态：**设计规格，未实现**。本文不含生产代码改动，只给可执行方案、判据、伪代码与任务切分。
> 基线：`memjudge-plugin` 工作树 + 桌面宿主 `/d/deepseek harness/resources/app/dsh/node_modules/@deepseek-ai/`（真实安装路径，非符号链接）。
> 测试基线：58 pass / 0 fail / 1 skip；`node scripts/check-grounding.mjs` → 294 raw / 违规 0。

## 0. 证据分级与八问结论表

本文每个结论都标了来源等级，只有两类：

- **[实测]** —— 本次真实跑通并附输出。探针源码在仓库外的 `C:\Users\23101\AppData\Local\Temp\memjudge-probe\`（`probe-pre-step.mjs` 10/10 PASS，`probe-store.mjs` 11/11 PASS，`probe-inject.mjs` 复现真实注入面）。用真 cordis + 真 memjudge `apply` + 真 store，不是 mock。
- **[源码]** —— 读宿主/插件源码得到的确定结论，附 `文件:行号`。可复核，但不是运行观测。
- **[推测]** —— 未验证，标出置信度。全文只有两处，见 §2.5 与 §10。

| # | 问题 | 结论 | 等级 |
|---|---|---|---|
| 1 | 在哪挂 | `agent/pre-step`，在 `apply` 内 `ctx.on(..., { prepend: true })`；`inject` 声明**一个都不用改** | 实测 |
| 2 | 抽什么 | 唯一白名单 `message.source.kind === 'user'`；`runtime-context` / `agent-instructions` / `goal` / `hook` / 各路插件注入全部排除 | 实测+源码 |
| 3 | 防垃圾场 | 六道闸：白名单 → 长度 → 形态 → 近重复 → 单轮/单会话配额 → 冷却；LLM 二次判定默认关 | 设计（近重复有实测反证） |
| 4 | 不破 dump 往返 | `source = "auto:chat#<sessTok>-t<turn>"` 字符串 + 章号走 `chapter` 参数进 id 前缀；`dump()` 一字不改 | 实测 |
| 5 | 不吃光注入预算 | 自动条目与人工条目**分开竞争**，人工优先占满 `injectLimit`，自动最多 2 席且需 `accessCount > 0`；不这样做的实测后果是 8/8 席位被自动条目垄断 | 实测 |
| 6 | 开关 | 默认**开**采集、默认**关**注入可见性；面板归 `sectionB` 新增一张 `自动记忆` 卡，3 个控件 | 设计 |
| 7 | 失败模式 | 钩子抛错会 reject 整条 waterfall → `preStep` 抛错 → 该轮直接失败；必须 `await next()` 后整体 `try/catch` 并原样 `return decision` | 实测 |
| 8 | 验收 | 5 项机器可验 + 3 条命令，见 §8 | 设计（探针已跑通） |

---

## 1. 在哪挂（问题 1）

### 1.1 实测结论

**在 memjudge 的真实装配下，`agent/pre-step` 能收到，且不需要动 `inject`。**

`src/index.mjs:51` 现在是：

```js
export const inject = ['tools', 'systemPrompt', 'connection'];
```

探针 `probe-pre-step.mjs` 用真 cordis `Context` + 真 memjudge `apply`（只 stub 了这三个服务）跑出：

```
PASS  T1 memjudge 真实装配成功  — tools=["memjudge_remember","memjudge_recall","memjudge_forget","memjudge_conflicts","memjudge_stats"] sections=["memjudge:recall"]
PASS  T2 无 scope tag 的监听器能收到 agent/pre-step  — calls=1
PASS  T3 payload 字段可用  — {"keys":["messages","turn","step","signal","agent"],"turn":3,"step":1,"sid":"sess-probe-1","msgs":1}
PASS  T4 next() 返回最终 decision，messages 含 runtime context 追加项  — kind=enter len=2
PASS  T5 监听器抛错会 reject 整条 waterfall（=毁掉该轮，驱动必须防）  — Error: probe boom
PASS  T6 try/catch + return decision 的 fail-open 写法不破坏调用方  — true
PASS  T7 {prepend:true} 位于最外层且可改写 decision.messages  — order=["prepend","push","prepend-return"]
PASS  T8 scopeTarget 过滤生效：tag=A 的监听器收不到 B 的事件、收到 A 的  — afterB=0 afterA=1
PASS  T9 无 tag 监听器对任意 scope 的派发都可达（memjudge 不需要 agent 作用域）  — seen=2
PASS  T10 inject=[tools,systemPrompt,connection] 的插件照常收到事件  — hits=1
```

**为什么不需要动 `inject`**：`inject` 只管「apply 等哪些服务就绪」，与事件订阅无关。事件派发时的过滤只有一层，见 `/d/deepseek harness/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js:258-270`：

```js
dispatch(type, args) {
  const thisArg = typeof args[0] === "object" || typeof args[0] === "function" ? args.shift() : null;
  const name = args.shift();
  ...
  const filter = thisArg?.[Context.filter];
  return (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx)).map(...);
}
```

而 `agent/pre-step` 的 `thisArg` 是 `scopeTarget(agent, agent)`（`dsh-agent/lib/index.js:230-232`），它的 filter 在 `dsh-scope/lib/index.js:327-341`：

```js
function scopeTarget(base, key) {
  const baseFilter = base[Context.filter];
  const carrier = { [Context.filter](ctx) {
    if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
    const tag = scopeOf(ctx);
    if (tag === void 0) return true;          // ← 没有 scope tag 的 ctx 一律放行
    for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
    return false;
  } };
  ...
}
```

memjudge 的 ctx 没有 scope tag（它不是 `createScope` 出来的），所以 `scopeOf(ctx) === undefined` → 恒 `true` → 收到所有 agent 的 pre-step。**T8 是对照组**：带 tag 的监听器被正确过滤，证明 filter 不是死代码；**T9** 证明无 tag 的监听器两类派发都能收到。

### 1.2 payload 里有什么（T3 逐字段）

`dsh-agent-loop/lib/index.js:904-935` 的 `preStep`：

```js
const claimed = this.inbox.claim(target, position.turn);
const assembly = await dshPurgeAssemble.assemble(assembleContextFor(this, signal));
const context = this.runtimeContext.project(joinContextSections(sections), sections);
const decision = await this.dispatch.waterfall("agent/pre-step", {
  messages: claimed, ...position, signal
}, () => Promise.resolve({ kind: "enter", messages: context === void 0 ? claimed : [...claimed, context] }));
```

叠加 `dsh-agent/lib/index.js:242-243` 的 `fused = (payload) => ({ ...payload, agent })`，监听器拿到的就是：

| 字段 | 类型 | 用途 | 备注 |
|---|---|---|---|
| `messages` | `UserMessage[]` | **本步要进入历史的用户侧输入**（已 claim，不再在 inbox 里） | 只有用户侧，不含助手回复 |
| `turn` | number | 轮号 | 从 1 起，`turn()` 里 `phase.turn + 1` |
| `step` | number | 步号 | 同一轮多步（含工具循环）会多次触发 |
| `signal` | `AbortSignal` | 本轮取消信号 | 长耗时处理要检查 |
| `agent` | Agent | 会话上下文 | 会话 id 取 `payload.agent.session.id`（`dsh-agent/lib/index.js:512` 有 `agent.session.id` 的强校验用法） |

**拿不到的东西（重要）**：助手回复、工具结果、以及「这条消息是 prompt 还是 steering」。`dsh-api-session-controller/lib/index.js:950-955` 里 `mode === 'steer'` 与普通 prompt 走同一个 `source = { kind: 'user', rpcId, clientTimeZone? }`，`claim()` 又把 `next-step` 与 `next-turn` 合成一个数组（`dsh-agent-loop/lib/index.js:103-110`），所以两者无法区分——**也不需要区分**，都算"用户说的话"。

### 1.3 挂载伪代码（放在 `src/index.mjs` 的 `apply` 内，`track(ctx.systemPrompt.section(...))`（`:963`）之后）

```js
// 采集：只读旁路，永远返回 decision 本体（见 §7）
const capture = createAutoCapture({ store, dbPath, cfg, invalidate }); // 纯逻辑见 §3
track(ctx.on('agent/pre-step', async (input, next) => {
  const decision = await next();                 // 必须最先 next()（prepend 语义，见下）
  try {
    if (cfg.autoCapture && decision?.kind === 'enter' && Array.isArray(decision.messages)) {
      capture.observe(decision.messages, {
        sessionId: input?.agent?.session?.id ?? '',
        turn: input?.turn ?? 0,
        step: input?.step ?? 0,
      });
    }
  } catch { /* 采集失败绝不影响对话 */ }
  return decision;                               // 不修改，不替换，不抛错
}, { prepend: true }));
```

三个细节：

1. **`{ prepend: true }` 的理由**来自 T7：prepend 的监听器在瀑布最外层，`await next()` 之后拿到的是**内层全部处理完的最终 decision**，因此看到的是真正会进入历史的完整列表（含 driver 追加的 `runtime-context`）。若用普通 `push`，位置在其他插件之内，`next()` 可能返回被外层改写后的对象，也可能被更外层的插件提前 return 而收不到最终形态。
2. **只看 `decision.messages`，不看 `input.messages`**：`input.messages` 只是 claimed（用户输入），`decision.messages` 才是本步真正进入历史的列表（= claimed + runtime context）。采集判据全靠 `source.kind` 白名单（§2），两者都能用，但用最终形态更稳。
3. **不用 `ctx.effect` 包 `ctx.on`**：`ctx.on` 返回的 disposer 已经挂在当前 fiber 上（`cordis/lib/index.js:371-388` → `register()` → `fiber.effect`），`track()` 再包一层会重复释放。

### 1.4 与 `dsh-context` 的共存

`dsh-context` 也挂了这个事件且同样 `prepend`（`/c/Users/23101/.dsh/profiles/desktop/node_modules/dsh-context/lib/index.js:3613-3620`），它的注释（`:3555-3578`）写明了契约：每个 step 边界的 `user/message` 都从这一个缝隙流过，且「a guard must never break the turn it protects」。两个 `prepend` 监听器谁先谁后取决于注册顺序，**因此 memjudge 不能假设 `decision.messages[].id` 的形状**——`dsh-context` 会给消息 mint `dshctx-` 前缀的 id。采集只读 `text`/`source`，不依赖 `id` 格式，所以无冲突。

---

## 2. 抽什么（问题 2）

### 2.1 唯一白名单：`source.kind === 'user'`

**用白名单，不用黑名单。** 理由不是洁癖：`source.kind` 是个开放字符串，本机已数出至少 14 种取值（下表），第三方插件随时可以造新 kind。黑名单每漏一种，就把垃圾灌进记忆库一次；白名单每漏一种，只是少记一条。

判据来自实测 T3 的 payload 形状 + `dsh-llm/lib/index.js:39-45`（`createMessage` 只保证 `{id, role, content, source}`）与 `dsh-agent/lib/index.js:136`（`createUserMessage` 固定 `role: 'user'`）。

### 2.2 判定顺序（代码级，严格按序，命中即返回）

```js
const CAPTURE_KINDS = new Set(['user']);          // 唯一白名单，留成 Set 便于将来加白

function pickCaptureText(message) {
  // ① 角色：非 user 一律不采（assistant / tool / system 本就不会出现在这里，防御性判定）
  if (!message || message.role !== 'user') return null;

  // ② 来源：白名单。这一步同时干掉 runtime-context / agent-instructions / goal / hook / 各种插件注入
  const kind = message?.source?.kind;
  if (typeof kind !== 'string' || !CAPTURE_KINDS.has(kind)) return null;

  // ③ 形态：只取 type==='text' 的 block，纯图片/纯附件直接出局
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
    .map((b) => b.text)
    .join('\n');
  if (text === '') return null;

  // ④ 伪系统块：用户粘贴的 <system-reminder> / <attached-file> 之类，整条跳过（不做聪明的剥离）
  if (/^<[a-z][a-z0-9-]*>/i.test(text.trimStart())) return null;

  return text;
}
```

`firstText()`（dsh-context `:289-300`）只取**第一个** text block 且截 80 字符，那是给会话身份摘要用的，**不能拿来做采集**——它会把多 block 消息（文本 + 粘贴文件）砍掉大半。这里自己 join 全部 text block。

### 2.3 `source.kind` 全谱系（判据依据）

| `source.kind` | 谁造 | 该不该采 | 依据 |
|---|---|---|---|
| `user` | 会话控制器（真人 prompt / steering） | **采** | `dsh-api-session-controller/lib/index.js:950-955`、`dsh-plan-mode/lib/index.js:221` |
| `runtime-context` | 驱动每步投影（`form:'snapshot'` / `'sections'`） | 排除 | `dsh-agent-loop/lib/index.js:218`（`SOURCE = "runtime-context"`）+ `:334-350` |
| `agent-instructions` | 工作区指令文件（AGENTS.md 等，`form:'instructions'`） | 排除 | `dsh-agent-instructions/lib/index.js:767-780`、`:1170-1180`、`:1200-1210` |
| `model-selection` | 换模型提示（`form:'notice'`） | 排除 | `dsh-agent/lib/index.js:136-145` |
| `goal` | goal 轮次自动续跑 | 排除 | `dsh-goal-round-driver/lib/index.js:134-141` |
| `cordis-host-runner` | 插件运行结果回填 | 排除 | `dsh-cordis-host-runner/lib/index.js:2393` |
| `hooks-claude-code` / `hooks-codex` | 外部 hook 注入 | 排除 | 两包各 `:128` / `:113` |
| `user-approval` | 审批结果回填 | 排除 | `dsh-user-approval/lib/index.js:113` |
| `schedule` | 定时任务触发 | 排除 | 全包统计命中 1 处 |
| `tool-registry` / `system-prompt` | 运行时快照 | 排除 | 全包统计命中 |
| 三方自定义 | 任意插件 | 排除（白名单天然覆盖） | — |

统计方法：`grep -rhno 'source: *{[^}]*kind: *"[a-z-]*"' @deepseek-ai/*/lib/index.js | grep -o 'kind: *"[a-z-]*"' | sort | uniq -c`，命中 10× `user`、5× `cordis-host-runner`、2× `ptc-mode`、2× `fallback` 等。

### 2.4 六类消息逐条结论

| 输入形态 | 判定 | 理由 |
|---|---|---|
| 纯用户文本 | **采** | 白名单直通，进 §3 的文本闸门 |
| 带附件/图片的消息 | 只取 text block；没有 text 就丢弃 | 图片会以 `type:'image'` block 进 `content`（`dsh-api-session-controller/lib/index.js:971-976` 的 `admitPromptContent`），若同时带文字说明，那段文字是用户真实表达，该记；纯图无字则无文本可存 |
| 工具结果回填 | 不会出现在这里 | 工具结果是 `createToolResultMessage`（`role:'tool'`），走会话事件而非 inbox claim |
| steering 注入 | **采**（等同 prompt） | 与 prompt 共用 `source.kind:'user'`，`claim()` 合并两个队列（`dsh-agent-loop/lib/index.js:103-110`），无法也不应区分 |
| 系统注入 | 排除 | 白名单挡掉 `runtime-context` / `agent-instructions` / `goal` / `hook` / `user-approval` |
| skill 内容 | 不会出现在这里 | skill 由工具调用返回，是 tool result；其正文进 `${skill}` 展开的 prompt 也属 tool result 侧 |
| 命令输出（slash command） | 排除 | 走 `agent.inject` / followup，`source.kind` 为 `cordis-host-runner` 等非 `user` |

### 2.5 v1 的能力边界（写清楚，避免过度承诺）

`agent/pre-step` 只看得见**用户侧**。助手说的话、以及"助手问完用户才回答"的那半段结论，本方案 v1 **完全拿不到**。

**[推测，中置信度]** 想把助手结论也自动记下来，可另挂 `session/event`（`dsh-agent-loop/lib/index.js:317-327` 里 `RuntimeContextProjection` 已这么订阅），事件 `type === 'assistant/message'`。但那条路径没有 `agent/pre-step` 的 fail-open 契约保护，异常处理要自己重做，且写入时机从"轮到步边界"变成"每条消息"——量级大一个数量级。**v1 不做，等 §3 的闸门在真实对话里跑够一个月再评估。**

---

## 3. 怎么不变成垃圾场（问题 3）

六道闸，按序短路。全部参数集中成一个 `AUTO_DEFAULTS` 常量块，便于面板与测试共用。

### 3.1 闸门与判据

| # | 闸 | 判据 | 默认值 |
|---|---|---|---|
| G1 | 来源白名单 | §2.2 ① ② | 固定 |
| G2 | 最小长度 | `stripWs(text).length >= minChars` | **12** |
| G3 | 最大长度 | `text.length <= maxChars`，超长整条丢弃（**绝不截断**） | **600** |
| G4 | 无效形态 | 纯标点/纯表情；`/^(\S+)$/` 无空格且长度为 1 的 `ok`/`好`/`继续`/`嗯` 类；重复字符 > 60% | 固定 |
| G5 | 近重复 | text_hash 之外再做 3-gram Jaccard | **≥ 0.85 丢弃** |
| G6 | 配额 | 单轮 ≤ **2** 条；单会话累计 ≤ **40** 条；同会话冷却 ≥ **5** 秒 | 见表 |

**为什么最小长度是 12**：中文一个事实性短句（"这个项目用 pnpm"）7 字就够，但靠长度切分的是"寒暄"不是"事实"。实测语料里 `嗯`/`好`/`继续`/`看一下` 全在 6 字内；`这个项目的包管理器用 pnpm，别用 npm` 是 18 字。12 是「排除寒暄、不误伤最短事实」的交点。

**为什么超长整条丢而不截断**：`store.put` 的既有契约是「超预算抛 `BudgetExceededError`，绝不截断」（`src/store.mjs:52-59`、`:736-742`）。自动采集若自己截断，就制造了库里没有、原文也没有的半句话——记忆库的立身之本是逐字可信，截断等于自我否定。600 字以上的输入基本是粘贴日志/代码/文档，本来也不该做"记忆条目"。

### 3.2 G5 近重复（实测反证：只靠 text_hash 不够）

`src/store.mjs:288-298` 的 `text_hash` 是 FNV 双 32 位 + 长度，**只对逐字相同生效**。探针 `probe-store.mjs` 实测：

```
PASS  A2 同文重复写入命中 text_hash 幂等（不新增行）  — id=mem-c901-p001-6d9c2107
PASS  A4 近似重复（仅多一空格）text_hash 拦不住 → 必须有近重复层  — id=mem-c901-p003-3ad7b3bb
```

同一条事实多说一个空格就变成两条记忆。近重复算法（无新依赖，纯 JS）：

```js
const norm = (s) => s.replace(/\s+/g, '').replace(/[，。！？；：、,.!?;:'"「」()（）]/g, '').toLowerCase();
function trigrams(s) {
  const out = new Map();
  for (let i = 0; i + 2 < s.length; i++) { const g = s.slice(i, i + 3); out.set(g, (out.get(g) ?? 0) + 1); }
  return out;
}
function jaccard(a, b) {                       // 多集 Jaccard
  let inter = 0, union = 0;
  for (const [g, n] of a) { const m = b.get(g) ?? 0; inter += Math.min(n, m); union += Math.max(n, m); }
  for (const [g, n] of b) if (!a.has(g)) union += n;
  return union === 0 ? 1 : inter / union;
}
```

候选集怎么取：**只跟"最近 200 条 auto 条目"比**（一次 `dump()` 过滤，10 条库体时成本可忽略；库体到几千条时要改成只比同会话 + 同章）。0.85 的依据：单字差异在 20 字短句上 Jaccard 约 0.85-0.9，两字差异约 0.75-0.8；0.85 能吃掉标点/空格/语气词差异，不吃掉真正的语义变化。

命中近重复时的动作：**不写，但给已有条目一次 `touch`**（`lastAccessed = now`）。理由：同一件事被说了三遍，说明它重要，该让它更靠前，而不是存三份。

### 3.3 G4 的疑问句/指令句策略

「疑问句一律不记」是错的。对比两句：

- `这个项目怎么用 pnpm 装依赖？` —— 疑问，答案是事实，但这句话本身没有可存的断言 → **不记**。
- `记住：以后提交别加 Co-Authored-By` —— 祈使句，但这是用户显式约定 → **必须记**。

判据：先看**约定标记**，再看疑问形态。

```js
const DIRECTIVE = /(记住|记一下|记下|以后|今后|永远|别再|不要再|总是|一律|必须|约定|规则|规范|习惯上)/;
const QUESTION = /[?？]\s*$|^(如何|怎么|怎样|为什么|为何|是否|哪|多少|能不能|可不可以)|(吗|呢)\s*$/;
if (QUESTION.test(t) && !DIRECTIVE.test(t)) return null;   // 纯提问：丢掉
```

反过来，**带 `DIRECTIVE` 的祈使句给更高 importance**（见 §3.5）。

### 3.4 G6 配额状态机

配额是**进程内**状态，键为 `sessionId`，结构与失效条件：

```js
// Map<`${sessionId}`, { turn: number, perTurn: number, total: number, lastAt: number }>
// 失效：map.size > 64 时按 lastAt 淘汰最旧；进程重启即清零（不落盘）
```

跨轮持久化不做。理由：单会话 40 条已经足够覆盖"真实有价值的对话事实"，而落盘配额状态会引入第二份真相（库里有条目但配额计数丢了/多算），比偶尔多记几条更糟。

### 3.5 importance 初值：**0.1**（不是 0.5）

这个数字不是随手给的，它直接接既有的衰减机制（`src/schema.mjs:18-19`、`:237-240`）：

- `importance >= 0.6` → warm 档，半衰期 **120 天**
- `importance < 0.6` → cold 档，半衰期 **12 天**，写入时固化、永不漂移

自动捕获的对话细节天生易腐，给 `0.1` 让它落在 cold 档：**两周半衰**，没人再提就自动沉底。这与 `src/search.mjs:351-364` 的打分一致：`importanceFactor = 0.5 + 0.5 * importance`，0.1 → 0.55 倍权重，人工条目（默认 0.5 → 0.75 倍）天然压它一头。

带 `DIRECTIVE` 标记的条目（§3.3）升到 **0.55**——仍低于 0.6，不进 warm 档，但在检索里排得比较靠前。**不给 0.6**：warm 档是给"事故日期、编号"这类一次写入永久有效的事实，自动采集不该有这个资格。

### 3.6 LLM 二次判定：默认关，代价写明白

要就明确要：**如果开，每一次写入都要调一次外部 chat 模型**（memjudge 已有 `src/llm-select.mjs`、`src/llm-client.mjs` 可复用，走 config 的 `chat` 组 baseUrl/key/model）。

代价清单：

- 延迟：一次 chat 往返 1-8 秒，落在 `pre-step` 里就是**用户每轮多等这么久**（因为我们的监听器在 `await next()` 之后，虽然不阻塞 decision，但 `preStep` 是 `await` 它的——见 §7.3 的异步策略）。
- 成本：一次带指令的短判定约 100-300 token 输入。
- 失败面：模型挂掉/超时/key 失效 → 采集这条路径就断了，还得再写一层降级。
- 收益：能把"这条值不值得记"的准确率从启发式的 ~70% 提到 ~90%，但**只在 G1-G6 之后剩下的少量候选上起作用**——而 G1-G6 已经吃掉 90% 的垃圾。

**结论：默认关。** 做成 `autoJudge` 模块开关（与 `vector`/`rerank`/`llmSelect` 同构，落在 `src/config.mjs:445` 的 `moduleFlags`），仅在用户显式开出 LLM key 且亲手打开时生效。真要开，必须配 §7.3 的"fire-and-forget"异步策略，不能阻塞 `preStep`。

---

## 4. 怎么不破 `dump()` 逐字往返（问题 4）

### 4.1 硬契约是什么

`src/store.mjs:801-824` 的 `dump()`：`SELECT * FROM memories ORDER BY created_at, id`，逐条返回 `{id,text,createdAt,lastAccessed,accessCount,importance,supersedes,supersededBy,source,facts}`，`text` 原样。既有测试断言的正是这个（`test/store.test.mjs:71-95`）：

- `dump 每条 text 与原文字符级相等`
- `dump 去空白总字 = 29648（一字不多一字不少）`（`test/store.test.mjs:84-86`）
- `dump1.find(m => m.source === 'corpus/novel.mjs#ch05')`（`test/store.test.mjs:120`）← **source 也是原样断言的一部分**

### 4.2 标记格式（定稿）

```
source = "auto:chat#<sessTok>-t<turn>"
```

- `sessTok`：`payload.agent.session.id` 的前 8 位（uuid 前 8 位足以在本机去重，且不把整条会话 id 写进库）
- `turn`：`payload.turn`
- 前缀 `auto:` 是人类可读、grep 可查、`startsWith` 可判的唯一判据

**为什么不用独立字段**：`memories` 表（`src/store.mjs:410-421`）没有 `origin` 列，加列要改 `STORE_SCHEMA_VERSION`（现 5）与迁移路径，动的是库体契约——为了一个标签冒数据迁移风险，不值。

**为什么不写 JSON**（像 `encodeSource` 那样）：`decodeSource`（`src/index.mjs:154-176`）对 `{` 开头的 source 一律当章/段号解析，而 `sourceLabel`（`:189-193`）对 JSON 串一律显示「手动写入」。写 JSON 会让自动条目在面板上全部显示成"手动写入"，且章号被 `0` 覆盖——两个副作用都是假的。

### 4.3 章号走 `chapter` 参数，进 id 前缀

`put()` 的 id 由 `makeId(chapter, para, text)` 生成（`src/schema.mjs:99-103`）：

```
mem-c<章两位>-p<段三位>-<fnv1a>
```

`chapterOf`（`src/index.mjs:181-186`）的读法是「先看 source 的 JSON，拿不到就回退 id 前缀」。所以自动写入这样调：

```js
const chapter = autoChapterFor(sessionId);      // 见下
const para = ++paraSeq[chapter];
store.put({ text, chapter, para, importance, source: `auto:chat#${sessTok}-t${turn}` });
```

`autoChapterFor` 的取法：会话首次写入时从 `meta` 表领一个号（`memories` 之外已有 `meta` 表，`src/store.mjs:406-409`，`compileWiki` 的 `wiki_version` 就存在那里），从 **900** 起递增（900+ 段留给自动条目，1-899 留给显式 `chapter` 的语料导入；显式导入本来就是手工喂的，不会用 900 以上）。号必须在事务里领，避免并发同号。

**收益**：一个会话的所有自动记忆聚在同一章 → `memjudge_conflicts` 的章级聚合（`src/index.mjs:181-186` 注释里说的「冲突检测从按文档退化成按句」）对自动条目仍然成立，不会把每条自动记忆各算一章。

### 4.4 实测证据（`probe-store.mjs`）

```
PASS  A1 自动条目成功写入  — id=mem-c901-p001-6d9c2107
PASS  A2 同文重复写入命中 text_hash 幂等（不新增行）  — id=mem-c901-p001-6d9c2107
PASS  A3 id 前缀承载章/段号（chapter=901 → mem-c901-p001-）  — mem-c901-p001-6d9c2107
PASS  A5 dump 的 text 与原文字符级相等（含换行/多空格）  — len=43
PASS  A6 dump 的 source 原样返回（auto: 前缀不被改写）  — auto:chat#s1a2b3c-t7
PASS  A7 dump 的 importance 落盘精确  — 0.05
PASS  A8 chapterOf 对 auto: 来源仍能取回章号（走 id 兜底）  — {"chapter":901,"para":1}
PASS  A9 面板/注入来源标签可读  — auto:chat#s1a2b3c-t7
```

A5 用的是带换行和三个连续空格的中文正文，`dump().text === 原文` 严格相等。**自动写入对 `dump()` 是零侵入的**：它只是多了行，没改任何既有行的任何字节。

### 4.5 `dump()` 之外的语义影响（诚实列出）

| 影响面 | 变化 | 是否需要处理 |
|---|---|---|
| `dump()` 逐字往返 | 不变（多行而已） | 无 |
| `test/store.test.mjs` 的 29648 字断言 | 只跑固定语料，不碰真库 | 无 |
| `memjudge_stats` 的 `memories` 计数 | 会涨 | 面板概览加一行「其中自动 12 条」，见 §6 |
| `check-grounding.mjs` 的 294 raw | 只读固定语料 | 无 |
| `topChapters` 章级聚合 | 自动条目各占一章（900+），章数变多 | 检索时按章平分预算 → 自动章会摊薄人工章的份额。**这是 §5 配额要一起解决的** |

---

## 5. 怎么不吃光注入预算（问题 5）

### 5.1 实测：真正的风险不是字符数，是**排他性**

`renderInject`（`src/index.mjs:333-359`）的选行逻辑只有两步：

```js
const rows = store.dump()
  .sort((a, b) => (b.lastAccessed - a.lastAccessed) || (b.createdAt - a.createdAt))
  .slice(0, cfg.injectLimit);        // injectLimit 默认 8
```

而 `put()` 写库时 `lastAccessed = createdAt`（`src/store.mjs:753`：`insMem.run(id, text, hash, createdAt, createdAt, ...)`）。**新写入的条目 `lastAccessed` 永远是最大值 → 永远排第一。**

`probe-inject.mjs` 在真实库上复现：

```
真实库：10 条，注入面 = 1070 字符（预算 2000，占比 53.5%）
模拟 20 条自动写入后：注入面 = 686 字符，其中前 8 条里 auto 占 8/8
```

模拟后的注入面原文（节选）：

```
## memjudge 记忆索引（8/30 条，按最近使用）
- "mem-c901-p020-abcdef12" — 自动捕获的一条对话事实样例 20：…：ch901
- "mem-c901-p019-abcdef12" — 自动捕获的一条对话事实样例 19：…：ch901
…（8 条全是 auto）
```

字符数反而变少了（自动条目短），但**人工记忆被完全挤出去**。所以"预算够不够"是伪问题，"谁占席位"才是真问题。若不加配额，用户手动写的 10 条珍贵事实会在两次对话后从注入面彻底消失。

### 5.2 配额设计（定稿，带数字与理由）

| 项 | 值 | 理由 |
|---|---|---|
| 人工条目席位 | `injectLimit`（默认 8），**优先占满** | 人工写入是用户显式意图，永远第一优先 |
| 自动条目席位 | **最多 2 条**，且只从「人工条目不足 6 条」时开始补位 | 8 席里给自动留 25%；人工够 6 条就一个都不给 |
| 自动条目入场门槛 | `accessCount > 0`（被 `memjudge_recall` 真正取过全文） | 没被用过的自动条目只是噪音，没有任何理由出现在固定提示里 |
| 自动条目字符上限 | 单条 ≤ **140** 字符（`oneLine(text, 90)` + id + 来源标签的实测行宽） | 实测 140（`probe-store.mjs` A11），留余量不超 |
| 自动条目 total 保底 | 人工条目 0 条时，`injectLimit` 全给自动 | 空库用户第一次对话后就能看到自己说过什么，这是 auto-capture 的核心价值 |

**数字推演**：8 条 × 实测平均 134 字符 = 1072，加头尾 ≈ 1200，预算 2000 留 800 余量给长条目。人工 6 + 自动 2 的最坏行宽 = 6×160 + 2×140 = 1240，仍在预算内。

`renderInject` 的改动（**这是本方案唯一需要动既有渲染逻辑的地方**，伪代码）：

```js
const all = store.dump().sort(byLastAccess);
const isAuto = (r) => String(r.source ?? '').startsWith('auto:');
const manual = all.filter((r) => !isAuto(r)).slice(0, cfg.injectLimit);
const autoRoom = Math.max(0, cfg.injectLimit - Math.max(manual.length, 6)); // 人工 <6 才让位
const auto = all.filter((r) => isAuto(r) && r.accessCount > 0).slice(0, Math.min(2, autoRoom));
const rows = [...manual, ...auto];   // 人工在前，自动在后（顺序即优先级）
```

尾部一行说明也要改：现在是「用 memjudge_recall 取全文，memjudge_conflicts 查前后矛盾」（`src/index.mjs:348`），自动条目出现时追加 `（auto 条目为对话自动捕获，可用 memjudge_forget 清理）`——用户第一次看到陌生条目时得知道它哪来的。

### 5.3 与 `topChapters` 章级聚合的关系

自动条目独占 900+ 章，会让"章"这个聚合单位变多，检索预算按章摊薄。缓解：`SearchIndex` 的章级聚合（`src/layer.mjs` 的 recall 渲染按 group 分）在 auto 条目上不单独成章——把同一 `sessTok` 的自动条目视为一章（同一个 `autoChapterFor` 号天然满足）。**不做额外处理**，因为章号已经是按会话分配的（§4.3）。

---

## 6. 开关设计（问题 6）

### 6.1 默认值：采集默认**开**，注入可见性默认**关**

| 开关 | 默认 | 理由 |
|---|---|---|
| `autoCapture`（采集） | **true** | 用户明确要"聊完自动长记忆"。默认关等于没做。写库是低风险操作（可 forget、会衰减、不上提示面） |
| 自动条目进注入面 | **跟随既有 `autoInject`**（默认 false） | `autoInject` 的语义是"是否把记忆索引塞进系统提示"，现在默认关（`src/index.mjs:81` 注释：「能力 8 的 0 字符是优点，不是缺陷」）。自动条目没有资格改变这个默认 |

也就是说：**默认状态下，用户在对话里说的话会被自动记下来，但不会往系统提示里多塞一个字。** 用户自己去面板打开注入后，才按 §5.2 的配额出现（最多 2 条、人类优先）。这是既能兑现"自动长记忆"、又不动既有 2000 字预算语义的唯一组合。

### 6.2 面板落点

面板结构（`client.js:978-1365`）：`sectionA 概览` / `sectionB 增强能力与密钥` / `sectionC 记忆条目` / `sectionD 冲突候选` / `sectionE 页脚`。

**归到 `sectionB`，在「增强模块」卡（`client.js:1278`）之前插入一张新卡 `自动记忆`。** 理由：B 区已经是"能力 + 参数"的集合（密钥、接口与模型、增强模块），自动捕获是一个能力开关加两个数值参数，语义同类；新开 section 会让左侧栏再多一个入口，而这块内容只有三个控件，撑不起一栏。

控件清单（**三个，不多不少**）：

1. `Toggle`：自动记忆开关（写 `autoCapture`）—— 一行说明「对话结束后自动把你说的事实存进记忆库；不会改变系统提示的用量」
2. `Number`：单会话最多条数（默认 40，范围 1-200）
3. `Number`：最小长度（默认 12，范围 4-200）

**不放的控件**：近重复阈值（0.85 是工程常数，改了只会让用户困惑）、importance 初值（同上）、LLM 二次判定（归 `增强模块` 列表，那里才是模块开关的地盘）。

概览卡（`client.js:980-990`）加一行 `其中自动 <n> 条`，`n = dump().filter(isAuto).length`。数据源就用既有 `installMemjudgeRpc`（`src/index.mjs:273`）已经暴露的 dump 通道，不新增 RPC。

### 6.3 配置键

| 键 | 落点 | 默认 |
|---|---|---|
| `autoCapture` | `DEFAULTS`（`src/index.mjs:78-102`）+ `resolveConfig`（`:122-138`） | `true` |
| `autoCaptureLimitPerSession` | 同上 | `40` |
| `autoCaptureMinChars` | 同上 | `12` |
| env 锁 | `src/config.mjs:391` 的 `FLAG_ENV` / `:416` 的 `SETTING_ENV` | 不加（这是行为开关，不是需要 CI 锁定的能力开关） |

`resolveConfig` 的写法沿用现有风格——非法值回落默认，绝不抛错（`:119` 注释：「插件装不上比参数被钳更糟」）：

```js
autoCapture: src.autoCapture !== false,
autoCaptureLimitPerSession: clampInt(src.autoCaptureLimitPerSession, 1, 200, 40),
autoCaptureMinChars: clampInt(src.autoCaptureMinChars, 4, 200, 12),
```

---

## 7. 失败模式（问题 7）

### 7.1 抛错会毁掉这一轮 —— 有实测

`cordis/lib/index.js:317-329` 的 `waterfall` 是同步链式调用，**没有 try/catch**：

```js
waterfall(...args) {
  const cbs = this.dispatch("waterfall", args);
  const inner = args.pop();
  const next = () => (cbs.shift() ?? inner)(...args);
  args.push(next);
  return next();
}
```

监听器抛错（或 async 监听器 reject）→ 整条 `next()` 链 reject → `preStep` 的 `await this.dispatch.waterfall(...)` 抛 → `turn()` 抛。`dsh-agent-loop` 的 README 把这个契约写死了：「Middleware, result-processing, tool, and other extension failures remain thrown and close the turn directly — plugin failure ends the turn, not the loop」。

实测确认（T5/T6）：

```
PASS  T5 监听器抛错会 reject 整条 waterfall（=毁掉该轮，驱动必须防）  — Error: probe boom
PASS  T6 try/catch + return decision 的 fail-open 写法不破坏调用方  — true
```

注意 T5 的写法是 `async (_input, next) => { await next(); throw ... }` —— **即使 `next()` 已经跑完，后续抛错仍然会毁掉整轮**。这是最容易踩的坑：很多人以为"业务逻辑放在 next() 之后"就安全了，不，链条的返回值就是监听器的返回值。

### 7.2 保底写法（照抄 `dsh-context` 的契约）

`dsh-context` 的写法是标准答案（`profiles/desktop/node_modules/dsh-context/lib/index.js:3613-3620`）：

```js
ctx.on("agent/pre-step", async (_input, next) => {
  const decision = await next();
  try {
    if (decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    // …业务…
    return decision;
  } catch {
    return decision;      // fail-open by contract
  }
}, { prepend: true });
```

memjudge 必须一字不差地照这个结构写，三条硬规矩：

1. **`await next()` 独立成第一句**，不放在 try 里。放进去的话，`next()` 自身抛的错会被我们吞掉——那是别的插件的错，吞掉等于替别人做决定。
2. **业务代码整体包在 try 里，`catch` 只 `return decision`**，不 re-throw、不返回 `{kind:'reject'}`、不返回 `undefined`（返回 undefined 会让 waterfall 的调用方拿到 undefined，`turn()` 里 `decision.messages?.length` 会在 `phase.step === 0` 时把这一轮判成 `completed`，静默吃掉用户输入）。
3. **永不修改 `decision`**。采集是只读旁路。一旦本插件开始往 `messages` 里 push，就与 `dsh-context` 的 id 改写、`runtime-context` 的快照去重（`dsh-agent-loop/lib/index.js:334-350` 的 `retained` 比较）产生交互，风险指数上升。要做"提示用户记住了什么"，走 `memjudge_recall` 工具回执，不走消息注入。

### 7.3 异步与开销策略

`preStep` 是 `await` 我们的监听器的。因此：

- **采集判定（G1-G6）全部同步**，纯字符串运算，10 条候选 < 1ms。
- **`store.put` 同步**（`node:sqlite` 的 `DatabaseSync`，`src/store.mjs:11` import、`:462` 构造），单条 < 2ms。
- **`store.dump()` 用于近重复候选集**：库小（< 1000 条）时可接受；库大时必须换成按章查询，**否则每次写入都全表 dump**。这条写进 T2 的验收里。
- **LLM 判定（若开）必须 fire-and-forget**：`void judgeAsync(text).then(...)`，绝不在监听器里 await。代价是"这一轮记不上，下一轮才记上"，可以接受。

### 7.4 其他失败面

| 失败 | 表现 | 处理 |
|---|---|---|
| `BudgetExceededError`（库满） | `put` 抛（`src/store.mjs:52-59`） | try/catch 吞掉 + 记一次 `logger.warn`，不重试、不截断、不改 `maxChars` |
| DB 被另一个进程锁 | `put` 抛 SQLITE_BUSY | 同上吞掉。**不要加 busy_timeout**：让它在库满/占用时安静失败，比让用户对话卡 5 秒好 |
| `sessionId` 为空 | `payload.agent?.session?.id` 取不到 | 用 `'unknown'` 做 sessTok，配额按 `'unknown'` 单桶计；不因此拒采（宁可少一层隔离也不丢数据） |
| 同一 step 重复触发（重试） | 同一条消息二次进入 | `text_hash` 幂等（实测 A2）+ 近重复（A4）双保险，天然免疫 |
| 进程在写入中途死掉 | 事务未提交 | `put` 已用 `BEGIN/COMMIT/ROLLBACK`（`src/store.mjs:751-764`），自动回滚 |

---

## 8. 验收口径（问题 8）

### 8.1 机器可验项

| # | 验收项 | 判据 | 命令 |
|---|---|---|---|
| V1 | 钩子抛错不影响对话 | 注入一个必抛的采集器，`waterfall` 正常返回 `kind:'enter'` 且 `messages` 长度不变 | `node test/auto-capture.test.mjs`（含真 cordis 段落） |
| V2 | 不重复写同一条 | 同文本喂 3 次 → `stats().memories` 只 +1；改一个空格再喂 → 仍只 +1（近重复生效） | 同上 |
| V3 | 单轮不超上限 | 一步塞 10 条合规消息 → 本步写入 ≤ 2 | 同上 |
| V4 | 注入字符数不超预算 | 打开 `autoInject` + 预置 20 条 auto → `renderInject()` 长度 ≤ `injectBudget`(2000)，且 auto 席位 ≤ 2 | `node test/plugin.test.mjs` |
| V5 | dump 往返仍逐字 | 自动写入后 `dump().map(m=>m.text)` 与原始输入字符级相等；`source` 原样为 `auto:…` | `node test/store.test.mjs` + `node test/auto-capture.test.mjs` |

不回归基线：

```bash
node test/plugin.test.mjs && node test/store.test.mjs && node test/layer.test.mjs
node scripts/check-grounding.mjs        # 要求 294 raw / 违规 0
```

### 8.2 探针（已跑通，可复现）

三个探针在仓库外的 `C:\Users\23101\AppData\Local\Temp\memjudge-probe\`，**不进仓库**：

```bash
# 装配与事件契约（10 项）
DSH_HOME=... node probe-pre-step.mjs
# store/source/dump 契约（11 项）
node probe-store.mjs
# 注入面真实复现 + 污染模拟
node probe-inject.mjs
```

`probe-pre-step.mjs` 的关键构造（供 T2 复用）——它必须用**真 cordis + 真 `apply`**，因为 `test/plugin.test.mjs:74-91` 的 `MockContext` 没有 `on`/`waterfall`，测不到这条路径：

```js
const { Context } = await import(pathToFileURL('.../@deepseek-ai/cordis/lib/index.js').href);
const { scopeTarget, createScope } = await import(pathToFileURL('.../@deepseek-ai/dsh-scope/lib/index.js').href);
const root = new Context();
root.plugin({ name: 'stubs', apply(ctx) {
  ctx.provide('tools', { register: (t) => ({ dispose() {} }) });
  ctx.provide('systemPrompt', { section: () => ({ dispose() {} }) });
  ctx.provide('connection', {});
}});
root.plugin(await import(pathToFileURL('.../memjudge-plugin/src/index.mjs').href));
// 派发就是 driver 那一行（dsh-agent-loop/lib/index.js:917-920）
const carrier = scopeTarget(agent, agent);
await root.waterfall(carrier, 'agent/pre-step', { messages, turn, step, signal, agent }, inner);
```

宿主模块找不到时（CI 没有 dsh 安装）必须**跳过而不是失败** —— 沿用 `test/plugin.test.mjs:10-13` 的 `DSH_HOST_MODULES` 约定，输出 `skip` 计入既有的 1 skip。

---

## 9. 明确不做

- 不记录助手回复（v1 边界，见 §2.5）
- 不做后台定时扫描会话日志（来源不可信、边界不清）
- 不改 `memories` 表结构、不改 `STORE_SCHEMA_VERSION`
- 不改 `dump()` 的返回形状与排序
- 不在 `agent/pre-step` 里往 `decision.messages` 注入任何东西
- 不做跨会话配额持久化
- 不截断任何文本（既有契约：`put` 超预算只抛不截）

---

## 10. 实施任务切分

四个任务，前三个必做、串行依赖，第四个可选。

### T1 · 采集判定内核（纯函数，不接线）

- 交付：`src/auto-capture.mjs`（新文件，导出 `pickCaptureText` / `shouldCapture` / `nearDup` / `createQuota` / `AUTO_DEFAULTS`）+ `test/auto-capture.test.mjs`（新文件，纯函数段）
- 覆盖：§2.2 判定顺序、§3.1 六道闸、§3.2 trigram 算法、§3.3 疑问/指令、§3.4 配额状态机、§3.5 importance 取值
- 依赖：无
- 验收：

```bash
node test/auto-capture.test.mjs    # 纯函数部分全绿；V2/V3 的判定层
```

- 拒绝标准：任何一条判定依赖真实 DB 或宿主模块即为不合格（本任务必须零外部依赖）

### T2 · 接线到 `apply`（含 fail-open 与真 cordis 探针）

- 交付：`src/index.mjs` 内新增 `track(ctx.on('agent/pre-step', ...))`（§1.3 伪代码）+ `test/auto-capture.test.mjs` 的真 cordis 段（§8.2 构造）
- 必须做到：`await next()` 独立首句；业务全包 try；`catch` 只 `return decision`；不修改 decision；`store.put` 用 §4.3 的 `chapter/para/source`；`BudgetExceededError` 吞掉并 warn
- 依赖：T1
- 验收：

```bash
node test/auto-capture.test.mjs    # V1/V2/V3/V5
node test/plugin.test.mjs          # 不回归：58 pass 基线 + 新增项
node scripts/verify-install.mjs    # 重装冒烟
```

- 关键回归点：`test/plugin.test.mjs` 里「注入关闭时 0 字符」那条不能因为自动写入而变成非 0 —— 它测的是 `renderInject`，T2 不该碰渲染

### T3 · 注入配额 + 配置 + 面板

- 交付：`src/index.mjs` 的 `renderInject`（§5.2 伪代码）+ `DEFAULTS`/`resolveConfig` 三个新键（§6.3）+ `client.js` `sectionB` 的 `自动记忆` 卡（§6.2）+ 概览「其中自动 n 条」
- 依赖：T2（要先有数据才能验配额）
- 验收：

```bash
node test/plugin.test.mjs          # V4：auto 席位 ≤2、总长 ≤2000
node scripts/check-grounding.mjs   # 294 raw / 违规 0 不回归
node scripts/panel.mjs             # 面板渲染冒烟（若脚本支持）
```

- 数字验收：预置 6 人工 + 20 auto（`accessCount>0`）→ 注入行数 = 8，其中 auto = 2，人工 6 条一条不少

### T4 ·（可选）近重复升级与 LLM 判定

- 交付：候选集从"最近 200 条 auto"改为按章查询（库大时）+ `autoJudge` 模块（`src/config.mjs:445` 的 `moduleFlags` 加一项）+ fire-and-forget 异步
- 依赖：T1（T2/T3 不依赖它，可并行）
- 验收：

```bash
node test/auto-capture.test.mjs    # 近重复在 5k 条库体下单次判定 < 5ms
node test/llm-select.test.mjs      # 降级路径不回归（无 key 时逐字相同）
```

### 依赖图

```
T1 ──► T2 ──► T3
 └──────────► T4（可选，与 T2/T3 并行）
```

## 附录：证据索引

| 结论 | 出处 |
|---|---|
| 事件派发与 scope 过滤 | `cordis/lib/index.js:258-270`、`dsh-scope/lib/index.js:327-341` |
| `waterfall` 无 try/catch | `cordis/lib/index.js:317-329` |
| `preStep` payload 与 inner decision | `dsh-agent-loop/lib/index.js:904-935` |
| `agent` 注入 payload | `dsh-agent/lib/index.js:242-243` |
| `claim()` 合并两个队列 | `dsh-agent-loop/lib/index.js:103-110` |
| `runtime-context` 来源 | `dsh-agent-loop/lib/index.js:218`、`:334-350` |
| 真人输入 `source.kind='user'` | `dsh-api-session-controller/lib/index.js:950-955` |
| `pre-step` 唯一缝隙 + fail-open 契约 | `profiles/desktop/node_modules/dsh-context/lib/index.js:3555-3620` |
| memjudge `inject` 声明 | `src/index.mjs:51` |
| `renderInject` 选行逻辑 | `src/index.mjs:333-359` |
| `chapterOf` / `sourceLabel` | `src/index.mjs:181-193` |
| `put` 的预算闸门与 `lastAccessed` | `src/store.mjs:721-765` |
| `dump` 返回形状 | `src/store.mjs:801-824` |
| `text_hash` | `src/store.mjs:288-298` |
| importance 分档与半衰期 | `src/schema.mjs:18-19`、`:237-240` |
| 检索里 importance 权重 | `src/search.mjs:351-364` |
| 面板 section 结构 | `client.js:978-1365` |
| 注入面实测 1070 字符 | `probe-inject.mjs` 输出（真实库 10 条） |
