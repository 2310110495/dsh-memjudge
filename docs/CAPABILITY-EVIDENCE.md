# 十二维开发证据采集（不是正式十二项验收）

## 为什么新增

现有源码回归通过，不能推出 docs/SPEC.md 的十二项能力全部达标。此入口把现有本地回归按十二个用户关心的维度整理成可重复、可回看的开发证据，同时保留每项正式验收缺口。它不生成 acceptance.json，不冒签 verifier/auditor，不把回归维度通过数换算成完成百分比。

检查发现，外部 mem-eval/harness/run-one.mjs 的 runOne() 与 run-decay.mjs 的 runDecay() 当前明确抛出 `Evaluation execution disabled: isolated runner is not implemented`。本实现没有修改外部仓库、没有复制私有执行核心绕过禁用，也没有用另一套评分冒充原评分。正式 runOne/runDecay、逐题 raw/QID、原题库保真重建、90天实测留存曲线及独立签字仍待完成。

## 审计确认的正式协议缺口

- 本地 test/fixtures-corpus.mjs 中 R21–R92 循环前20道核心题；历史“92/92”仅是92行本地夹具输出，不能解释成92道独立问题或SPEC正式题库成绩。此工具保留原测试，不改题以凑分，也不把重复题当新增覆盖。
- SPEC关于 denyNearEntity 未导出/未接线的描述与当前外部 score.mjs 已导出且已接线的行为不同；norm/canon依然未导出。正式能力6需先固定协议与评分器版本并澄清漂移，本工具不修改评分函数或阈值。
- 能力7的正式门槛是原语料目录204800字节，而本地千轮夹具262144字节门槛是另一口径；两者不可替换。
- 正式验收还需要原题库逐题完整返回、原评分函数、存储重建、独立短路反证及分库假时钟实验，不是把此工具重命名就能完成。

## 运行

使用与源码相同的受支持 Node，在源码根目录执行：

```text
node scripts/capability-evidence.mjs
node scripts/capability-evidence.mjs --out-parent F:/记忆库/临时验证
node scripts/capability-evidence.mjs --verify <上一步输出的绝对运行目录>
```

不传输出父目录时保存在系统临时目录。传入父目录必须是已存在的绝对真实目录，拒绝符号链接祖先。每次独占创建新的随机运行目录，不覆盖历史结果。目录由运行者保留；不要上传其中任何额外放入的私人材料。

## 产物与判读

- `development-evidence.json`：源码快照SHA-256、Node/平台、按唯一测试文件统计的退出码和实测test/pass/fail/skip、十二维证据映射与尚缺协议。
- `raw/*.tap`：每个固定本地测试文件的完整stdout+stderr，直接写文件描述符，无输出截断。不是正式题库的逐题回答。
- 每维 `regression` 仅表示对应回归的 pass/partial/fail；有skip则partial。每维 `formalAcceptance:null`，总标记 `formalAcceptance:false`，角色author，signedBy:null。
- 唯一测试文件只运行一次，多个维度引用同一产物；不能把维度引用相加当测试总数。
- CLI退出0及总字段 `regressionPassed:true` 仅表示所有指定回归未失败、源码运行前后未变化。允许已记录skip，因此总布尔值不是“全绿无跳过”；应同时读取每维/每文件的partial和skipped。不表示十二项正式验收通过。源码清单只持久化运行前一份；sourceStable记录现场前后比较，不能宣称保留了两份独立快照。
- `--verify` 校验所有完整日志的字节数、SHA-256、固定测试清单、摘要与裁决的一致性、十二维映射，以及当前源码是否仍与快照一致；损坏、缺失、伪造摘要、误自签、旧源码不匹配均非零退出。
- 哈希仅供完整性复核，不是数字签名；能够同时重写日志和清单的人可伪造开发报告，独立人员仍需重新运行与审核。

## 独立复核边界

本次只读回退审查（专家召唤超时后由独立子代理执行）未发现P0/P1；17/17采集器单测通过，24日志与86源码摘要共110项重算一致。两条非阻断P2仍保留：未持久化第二份sourceAfter清单；TAP解析器核对唯一摘要、计数平衡与plan存在，但不是完整TAP语法解析器，未逐一验证test point/重复plan/矛盾not-ok。当前实际固定Node reporter产物经完整独立读取未见上述异常。不要把完整性校验器宣传成可认证任意恶意TAP的证明系统。

## 安全与资源边界

只执行内置固定本地测试，不接受任意适配器/模块/命令。子进程环境只传递必要Windows系统变量及临时HOME/DSH_HOME/TEMP，禁用真实私库夹具，不继承API密钥、代理、NODE_OPTIONS或MEMJUDGE配置。每文件300秒超时；失败继续留存其他文件结果，不把超时/无摘要/空测试/TODO判为通过。临时测试home测后清理，输出证据保留。

这不是操作系统安全沙箱：可信源码测试本身有本机进程权限；请只在审核过的源码与受控环境运行。未测真实客户端加载、会话身份、生产数据库、宿主tokens、远程模型质量或网络服务。
