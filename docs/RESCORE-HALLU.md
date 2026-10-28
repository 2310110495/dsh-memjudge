# 能力 6 重算对照：评分器接线 deny 前后

**产物**：`node mem-eval/harness/rescore-hallu.mjs --dry-run`（默认 dry-run，不写盘）。
**判据**：SPEC §2.6——`score.mjs` 的 `DENY` + `NEAR_WINDOW=80` + 返回 ≥40 字；评分器优先级 `contaminate > deny > empty > flood > partial`，命中 deny 给 1 分。
**长度档**：按 `gotLen`（全长）判。存盘 `got` 是截断副本（400 / 4000 字符），只看副本会把 flood 误判成 partial。
**拒答判定**：只看可见原文；`partial` 档 + 截断 + 可见区没命中实体的条目记「条目级不可判」（与第 6 条说的能力级不可判是两件事），本表 0 条。

| 适配器 | n | 旧 halluDeny | 新 halluDeny | Δ | 旧 halluScore | 新 halluScore | Δ | 新 verdict 分布（deny/empty/partial/flood/cont） |
|---|---|---|---|---|---|---|---|---|
| Aik358/dsh-auto-memory | 6 | 0 | 0 | 0 | 0.625 | 0.625 | 0 | 0/2/3/1/0 |
| AskTheWay/dsh-auto-memory | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| EternalNight996/memory-eternal | 6 | 0 | 0 | 0 | 0.292 | 0.292 | 0 | 0/0/1/5/0 |
| FuRongJun-1999/dsh-memory（灵枢） | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| Ikalus1988/MisakaNet | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| LittleBlackTong/dsh-plugin-memory | 6 | 0 | 0 | 0 | 0.333 | 0.333 | 0 | 0/0/2/4/0 |
| PerryLink/dsh-memento | 6 | 0 | 0 | 0 | 0.5 | 0.5 | 0 | 0/2/0/4/0 |
| Phant0Meow/dsh-meow-memory | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| QiDouZu/retcon-form | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| RestRegular/dsh-memory | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| Scorp1o117/dsh-soul-md | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| annkun/dsh-memory（灵枢） | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| baseline-bm25 | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| baseline-full-context | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| bbqisbbq/dsh-tiddlywiki | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| drscrewdriver/dsh-prime-memory | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| gezi-wen/sage-mem | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| knowledge | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| memjudge | 6 | 0 | 0 | 0 | 0.667 | 0.667 | 0 | 0/3/1/2/0 |
| mneme | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| omdsh-dev/dsh-mnemon | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| vectorize-io/hindsight | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| veyra | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| vibe-any/dsh-plugin-save-token | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| volcengine/OpenViking | 6 | 0 | 0 | 0 | 0.25 | 0.25 | 0 | 0/0/0/6/0 |
| **汇总** | **150** | **0** | **0** | **0** | — | — | **0** | deny 0 |

## 怎么读这张表

1. **分数逐份 Δ=0**。重算与历史评分同源：旧 `halluScore` 是运行期用全文算的，新评分器用截断 `got` + `gotLen` 复原出同一个数（memjudge 的 0.667 依赖 H3/H4 的 `gotLen` 610/1783 才能落回 flood 档）。说明这次改动没有偷换口径。
2. **deny 仍然 0，成因不是词表，是实体缺位**。改之前 `denyNearEntity` 是死代码，`halluDeny` 结构性恒 0——这个维度从未被测。改之后评分器能产 `deny`，但历史返回里判不出来，原因不在 `DENY` 词表：`results-hallu/` 24 份 144 行里，`DENY` 词命中 **126 行**，被问实体（`norm(absent)`）出现在返回文本里的只有 **10 行**。`denyNearEntity` 先 `a.indexOf(norm(absent))` 定位实体、再取 ±80 字窗口；实体索引 -1 就没有窗口，返回 false 是必然，与词表一个字符都不相干。逐条抽查：`AskTheWay` H1（absent「IMO 编号」）返回 6249 字、`norm` 后 5527 字，`indexOf('IMO编号') = -1`，`DENY` 命中 26 次、首个在 85 位，全在第一屏的无关段落里（值班记录、安全管理体系）。
   22 份（排除两份 baseline）口径对照：132 行，flood 122 / empty 4 / partial 6 / deny 0，实体在 10 行、`DENY` 词命中 114 行。
3. **接线时抓出两个假阳性**，都已收紧：
   - 问题回显：返回把问题抄一遍（`…有没有到现场？`），其中的「有没有」被 `DENY` 的「没有」命中。Aik358 的 H4（43 字，`未找到相关记忆`）就是靠这个误判成 deny。
   - 正命中声明：`命中 3 条` 与拒答互斥。bbqisbbq 的 H4 一边回「命中 3 条」一边被判 deny。
4. **未写盘**。Δ=0，覆盖历史结果只会产生无意义 diff。需要落盘时跑 `node harness/rescore-hallu.mjs --write`（会同步 `halluScore` / `halluDeny` / `halluFab`，兼容已有的 `noHit*` 字段）。
5. **实体缺位是主因（记录，不修）**：`DENY` 词表不缺（144 行里 126 行命中），缺的是「实体在返回里」这个前置条件。24 份里只有 Aik358 一个适配器会用「未找到相关记忆」（`results-hallu/Aik358_dsh-auto-memory.json` 4 次；`results/Aik358_dsh-auto-memory.json` 113 次），其余 23 份 0 次——「标准拒答措辞认不出」不是全局现象，不能拿来当解释。真正的原因是这批机械 adapter 只把检索材料整段倒出来、不产答案（`score.mjs:63` 原注释：「机械 adapter 只返回检索材料、不产生『答案』」），被问实体压根不在返回文本里，拒答行为在这些样本里不存在。
6. **结论：能力 6 在机械 adapter 上不可判**。0/6 不是「插件拒答能力垫底」，是「这个维度没有可判样本」。`Δ=0` 同样不证明口径已经能测拒答：144 行里 134 行本来就落在 flood 档，deny 档接不接线都碰不到。要测拒答必须让 LLM 在环产答案（adapter 走模型生成而不是材料倾倒），否则任何 0/6 只能记「未测」，不得进排名。

## 复现

```
cd mem-eval
node harness/self-test.mjs            # 28/28 passed
node harness/rescore-hallu.mjs --dry-run
```
