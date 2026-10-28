# t16 审计：腾讯云 tokenize / l1-extractor / l1-dedup 与 t12、t13 的逐条对照

审计时间：2026-10-28 19:2x–19:5x
审计对象：t12（jieba 分词，src/search.mjs）、t13（L1 三元组层，src/extract.mjs）
源码版本：`@tencentdb-agent-memory/memory-tencentdb@1.0.3`
可复跑脚本：`.audit-tencent/compare.mjs`、`.audit-tencent/tok.mjs`（审计结束后整个 `.audit-tencent/` 可删）

## 结论

**t12 pass。** jieba 三件（懒加载单例 / `cutForSearch(raw, true)` / `ZH_STOP_WORDS`）是逐字抄的，40 项停用词表连顺序都一致，运行时实测生效。四处偏离（fallback、NFKC、FTS5 拼装、子词 tf 折算）要么是 memjudge 没有对应设施（无 FTS5），要么是实测逼出来的必要改动，且都在注释里写明了。

**t13 pass，不构成假抄——但审计任务书的前提不成立。** 我拿 1.0.3 真源码逐行比过：腾讯的 L1 提取是**单次 LLM 调用 + JSON schema**（persona/episodic/instruction 三类 + priority 分档），我们的 `src/extract.mjs` 是**纯规则正则 + 词表 + grounding 子串断言**，两者字段零重合、范式相反。但仓库里（`src/`、`docs/`、commit message、t13 的任务交付说明）**没有任何一处声称参考过 l1-extractor.ts**；相反 `.baseline-before-v2.md:35` 明确记录「腾讯云 MemoryCore 官方 TS 源码拿不到」。所以不是「声称抄了却没抄」，而是「没声称，也确实没抄」——是两套独立实现。

真正的账要算在两条文档事实上（见 findings）：`.baseline-before-v2.md:35` 的「官方 TS 源码拿不到」已经过期（我在 npm 缓存里取到了 1.0.3 并校验了 sha512），而 t13 的定位长期被含糊成「参考腾讯 L1」，这次的结论是**零参考**。

## 源码怎么拿到的（可复现）

GitHub 在本机被 hosts 打到 127.0.0.1，走 npm 镜像。缓存在：

```
C:\Users\23101\AppData\Local\npm-cache\_cacache\index-v5\8b\c4\54cad9f1...（key = cdn.npmmirror.com/packages/%40tencentdb-agent-memory/memory-tencentdb/1.0.3/memory-tencentdb-1.0.3.tgz）
integrity: sha512-fGDDiq5ul4Rh2WaVgMPccGRTc2B07WWMDpo5i66jKFeo6BqT3YWb9V0Q9uk/ooxrQR6ldbm0XXInm2HFYNoGkA==
```

`.audit-tencent/fetch.mjs` 用这个 integrity 反算 content-v2 路径、复算 sha512、落 tgz（1001431 字节，校验通过），再 `tar -xzf` 得到 `package/`。

## 腾讯源码真实片段

### tokenize 全在 `src/core/store/sqlite.ts`，不存在 tokenize.ts

`sqlite.ts:160-181`：

```ts
interface JiebaInstance {
  cutForSearch(text: string, hmm: boolean): string[];
}

let _jieba: JiebaInstance | null | undefined; // undefined = not yet tried

function getJieba(): JiebaInstance | null {
  if (_jieba !== undefined) return _jieba;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Jieba } = require("@node-rs/jieba");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dict } = require("@node-rs/jieba/dict");
    _jieba = Jieba.withDict(dict) as JiebaInstance;
  } catch {
    _jieba = null; // mark as unavailable — won't retry
  }
  return _jieba;
}
```

`sqlite.ts:184-193`（停用词表，40 项）：

```ts
const ZH_STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那",
  "吗", "吧", "呢", "啊", "呀", "哦", "嗯",
]);
```

`sqlite.ts:212-235`（query 侧）：

```ts
export function buildFtsQuery(raw: string): string | null {
  const jieba = getJieba();
  let tokens: string[];
  if (jieba) {
    tokens = jieba
      .cutForSearch(raw, true)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
    tokens = [...new Set(tokens)];
  } else {
    tokens =
      raw
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? [];
  }
  ...
```

`sqlite.ts:267-281`（索引侧）：

```ts
export function tokenizeForFts(raw: string): string {
  const jieba = getJieba();
  if (!jieba) return raw;
  const tokens = jieba.cutForSearch(raw, true);
  // Join with spaces so `unicode61` tokenizer can split them.
  return tokens.join(" ");
}
```

`sqlite.ts:249-256` 注释里给出的示例，正好可以拿来验证我们是不是真的接了同一个模式：

```
 * For example, "人工智能" is indexed as "人工 智能 人工智能", so queries for
 * either the full term or sub-words will match.
```

### L1 提取是纯 LLM 调用（`src/core/record/l1-extractor.ts`）

`l1-extractor.ts:1-17`：

```ts
/**
 * L1 Memory Extractor: extracts structured memories from L0 conversation messages
 * using a single LLM call with JSON-mode structured output.
 * ...
 * Pipeline:
 * 1. Read recent messages from L0 (split into background + new)
 * 2. Call LLM to extract scene-segmented memories
 * 3. Batch conflict detection against existing records
 * 4. Write to L1 JSONL files
 */
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt } from "../prompts/l1-extraction.js";
import { batchDedup } from "./l1-dedup.js";
```

`l1-extractor.ts:443` 是该文件里唯一的正则——用途是从 LLM 的返回里抠 JSON 数组，不是提取事实：

```ts
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
```

`src/core/prompts/l1-extraction.ts` 的 system prompt 片段（三类 + 打分）：

```
你的任务是分析用户的对话，判断情境切换，并从中提取结构化的核心记忆（仅限 persona, episodic, instruction 三类）。
...
1. 个性化记忆 (type: "persona")
2. 客观事件记忆 (type: "episodic")
3. 全局指令记忆 (type: "instruction")
...
      {
        "content": "完整、独立的记忆陈述（按对应类型的句式要求）",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["消息ID_1", "消息ID_2"],
        "metadata": {}
      }
```

`src/core/record/l1-writer.ts:48-68` 的落库记录：

```ts
export interface MemoryRecord {
  id: string;
  content: string;
  /** Memory type: persona / episodic / instruction */
  type: MemoryType;
  /** Priority score: 0-100 (higher = more important), -1 = strict global instruction */
  priority: number;
  scene_name: string;
  source_message_ids: string[];
  metadata: EpisodicMetadata | Record<string, never>;
  timestamps: string[];
  createdAt: string;
  updatedAt: string;
```

### 去重是「候选召回 + 单次 LLM batch 判断」（`src/core/record/l1-dedup.ts`）

`l1-dedup.ts:1-16`：

```ts
/**
 * L1 Memory Conflict Detection (Batch Mode): decides how to handle multiple new
 * memories against existing records in a single LLM call.
 *
 * v4: Removed JSONL-based Jaccard fallback. Candidate recall now relies exclusively
 *     on vector search (primary) and FTS5 BM25 (degraded). If neither is available,
 *     conflict detection is skipped entirely — all memories go straight to store.
 *
 * Two-phase approach:
 * 1. Candidate search per new memory — vector recall or FTS5 keyword recall (fast, no LLM)
 * 2. Batch LLM judgment on all new memories + their candidate pools (single call)
 */
```

注意：**没有 RRF**（脚本检查 `RRF|reciprocal` = false），是「vector 优先、FTS5 降级、都不可用就整个跳过」的三档降级。

## 对照表 A：t12 分词

| # | 腾讯（行号） | memjudge（行号） | 判定 |
| --- | --- | --- | --- |
| 1 | `getJieba()` 懒加载单例，`undefined` 未试 / `null` 不可用永不重试，`catch` 里置 null（sqlite.ts:164-181） | 同结构（search.mjs:97-119），另加 `MEMJUDGE_NO_JIEBA=1` 显式降级、`typeof cutForSearch === 'function'` 校验 | **逐字抄**（多两个防护分支） |
| 2 | `Jieba.withDict(dict)`（sqlite.ts:173） | `Jieba.withDict(dict)`（search.mjs:109） | **逐字抄** |
| 3 | `cutForSearch(raw, true)`，hmm=true（sqlite.ts:220、275） | `cutForSearch(runText, true)`（search.mjs） | **逐字抄**（参数一致） |
| 4 | `ZH_STOP_WORDS` 40 项（sqlite.ts:184-193） | 同 40 项，顺序一致（脚本 diff：仅腾讯有 0、仅我们有 0、顺序相等 true） | **逐字抄** |
| 5 | 过滤 `!/[\p{L}\p{N}]/u.test(t)` 剔标点 + 停用词（sqlite.ts:226-229） | `!WORD.test(w)` + `ZH_STOP_WORDS.has(w)`（search.mjs:264） | **改写**（等价，落点从 buildFtsQuery 挪进 tokenize） |
| 6 | `[...new Set(tokens)]` 去重（sqlite.ts:232） | `seen` Set 去重（search.mjs:262-267） | **逐字抄**（等价） |
| 7 | fallback：`raw.match(/[\p{L}\p{N}_]+/gu)` 切词（sqlite.ts:237-241） | fallback：CJK 相邻二元组，run<2 保留单字 | **偏离（自创，更强）**。理由：腾讯 fallback 不切中文（整串当一个词），memjudge 的兜底要能独立支撑中文召回。已在 search.mjs:44-46 注释声明 |
| 8 | `tokenizeForFts` 把 token 用空格拼回、交给 FTS5 的 unicode61（sqlite.ts:267-281） | 无 FTS5：token 直接进自带倒排与 BM25 | **不抄（已声明）**。search.mjs:43 写明「不抄它的 FTS5 引号 OR 拼装——memjudge 自带倒排与 BM25」 |
| 9 | 无 NFKC（整个 sqlite.ts 没有 `normalize("NFKC")`） | `s.normalize('NFKC')`（search.mjs，来自 meow 类别路由） | **不是腾讯的**。这点必须写清：任务书把 NFKC 列为「要核对的腾讯实现」，实际腾讯没有，NFKC 是 meow（`bm25.ts`）遗产，t12 也没把它算进「抄三件」 |
| 10 | 无 tf 权重层（FTS5 负责 bm25） | `subwordDiscount 0.35` + 按篇折算 tf + 查询侧不归并 + 章级取 3 章 | **自创**。理由在 search.mjs:58-61 与 t12 交付说明第 1–3 条，都是实测逼出来的（R10/R12/S06 的对照数字） |

运行时实测（`.audit-tencent/tok.mjs`，`jiebaActive: true`）：

```
凹陷深度            → ["凹陷","深度"]
轮机长更换了主机缸套 → ["轮机","机长","轮机长","更换","主机","缸","套"]
人工智能的分支       → ["人工","智能","人工智能","分支"]      ← 与腾讯注释示例逐字一致
タワー              → ["タワ","ワー"]                          ← 纯假名走二元组
MEMJUDGE_NO_JIEBA=1 → 凹陷深度 → ["凹陷","陷深","深度"]        ← fallback 生效
```

`@node-rs/jieba` 确实装了（`node_modules/@node-rs/jieba` + `jieba-win32-x64-msvc`，package.json:16-18 在 optionalDependencies），不是摆设。

## 对照表 B：t13 L1 提取

| # | 腾讯（行号） | memjudge（src/extract.mjs） | 判定 |
| --- | --- | --- | --- |
| 1 | 单次 LLM 调用 + JSON-mode 结构化输出（l1-extractor.ts:1-17、:164-177） | 无 LLM、无 prompt、无 JSON schema；68 处正则 + 词表（ROLES/SURNAME/ATTR_SUFFIX…） | **完全不同范式** |
| 2 | 输出三类 `persona / episodic / instruction` + `priority` 打分（prompts/l1-extraction.ts） | 输出 `(entity, attr, key, value, unit, valueType, sent, sentOff, sentLen, at, ch)` | **字段零重合** |
| 3 | 落库 `MemoryRecord{id, content, type, priority, scene_name, source_message_ids, metadata, timestamps, createdAt, updatedAt}`（l1-writer.ts:48-68） | 落库四元组（entity/attr/value/sent 指针） | **字段零重合** |
| 4 | 情境切分（scene_name + message_ids） | 无情境概念 | **无对应物** |
| 5 | 去重：vector 优先 / FTS5 降级 / 都不可用则跳过，然后单次 LLM batch 判断（l1-dedup.ts:1-16） | 冲突：judge.mjs 的 `conflictPairs`（CJK 二元组 Jaccard + `CONFLICT_THRESHOLDS` 分档，来自 mneme）→ `adjudicateConflicts`（跨 scope 停车 / 同 scope LLM 或确定性规则） | **结构相似但不同源**：腾讯无阈值分档、无 scope 概念；memjudge 无 vector、无 FTS5、无 RRF |
| 6 | 抽取正确性靠 LLM 自律（外加 `sanitizeJsonForParse` 修 JSON） | 靠 `text.includes(f.sent)` 逐字子串断言 + 单位合并后必须连续 | **自创（更严）** |
| 7 | `attr` 概念不存在（有 content 自由文本） | `attr` 是值左邻名词短语，`ATTR_SUFFIX` 白名单收边界 | **自创** |

机器检查（`.audit-tencent/compare.mjs`）：

```
腾讯 l1-extractor.ts：LLM 相关标识 17 处；引用 EXTRACT_MEMORIES_SYSTEM_PROMPT=true；引用 batchDedup=true
memjudge extract.mjs：LLM 相关标识 0 处；出现 prompt 字样 false；正则 68 处
l1-dedup 候选召回：vector=true / FTS5=true / RRF=false
```

`node scripts/check-grounding.mjs` 实测（t13 自己的验收线）：

```
编译层 grounding: PASS（294 条 raw / 294 个 block / 违规 0）
存储层 grounding: 732/732 条 fact 的 value 可在 sent_off/sent_len 切出的原句里逐字找到
```

## 「假抄」判定

按任务书的三分法逐条落地：

- **声称抄了且真抄了**：t12 的 jieba 三件。有源文件行号、有 40 项表逐项一致、有运行时输出与腾讯注释示例逐字吻合。
- **声称抄了但实际没抄**：**本次未发现**。仓库 `src/`、`docs/`、commit message、t13 交付说明里都搜不到「参考 l1-extractor」这类表述（`grep -rn "l1-extractor|腾讯|tencent|MemoryCore"` 只命中 search.mjs 的 t12 注释与 `.baseline-before-v2.md` 的环境记录）。
- **没声称、也确实没抄**：t13 的 L1 三元组层。它是自主规则实现，与腾讯 LLM prompt 提取是两条路。

同时纠正审计任务书的前提：任务书写「t13 声称『参考 l1-extractor.ts 的提取逻辑』」——这句在该项目里没有出处。`.baseline-before-v2.md:35` 反而写着「腾讯云 MemoryCore 官方 TS 源码拿不到；替代参考已落盘 …baodq97__tencentdb-agent-memory-claude（npm 包 tencentdb-agent-memory@0.7.0 解包，纯 JS）」，而那个仓库只有 `agents/ commands/ hooks/ skills/`，不含 `tokenize.ts`/`l1-extractor.ts`/`l1-dedup.ts` 任何一个。

## Findings

- **F1（medium，文档）** `.baseline-before-v2.md:35` 的「腾讯云 MemoryCore 官方 TS 源码拿不到」已失效：1.0.3 官方包在 npm 缓存里可取（sha512 校验通过），真源码路径是 `src/core/store/sqlite.ts`、`src/core/record/l1-{extractor,dedup,writer}.ts`、`src/core/prompts/l1-{extraction,dedup}.ts`。后续任务若继续按「拿不到」行事，会重复 t12 的弯路。**要求**：更新该行，写明取包方法与 integrity。
- **F2（medium，文档）** t13 的定位必须从「参考/借鉴腾讯 L1」改成「自主规则实现，与腾讯 LLM prompt 提取无同源关系」；`docs/` 目前对此完全沉默（`grep 腾讯 docs/*.md` 无命中），沉默容易被下游误读成「已对齐腾讯」。**要求**：在 `docs/SPEC.md` 或 `docs/AUDIT.md` 里加一段两行说明，附本报告的对照结论。
- **F3（low，口径）** 任务书把「NFKC 归一化」列为腾讯 tokenize 的核对项，实际腾讯没有 NFKC；memjudge 的 NFKC 来自 meow。**要求**：修正移植来源标注（search.mjs:39-46 已注明 jieba 三件的来源，但没写 NFKC 的出处，容易被读成腾讯也有）。
- **F4（low，可选）** 若后续要真正对齐腾讯 L1，最小缺口是「三类 + priority」这套分类学；当前 memjudge 的四元组不承担分类职责。这是设计选择不是缺陷，但应在文档里说明「不对齐是刻意的」。

## 可删声明

`.audit-tencent/` 全部是审计脚手架，可整目录删除：`fetch.mjs`（从 npm 缓存取包并校验 sha512）、`compare.mjs`（机器比对）、`tok.mjs`（分词实测）、`package/`（解包源码 1.0.3）、`memory-tencentdb-1.0.3.tgz`。本报告已把用到的源码原文与行号固化下来，删掉不影响复核；需要重跑时先 `node .audit-tencent/fetch.mjs` 再解包即可。
