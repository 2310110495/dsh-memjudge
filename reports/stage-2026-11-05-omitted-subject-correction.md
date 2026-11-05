# 省略主体更正与姓名边界阶段记录

日期：2026-11-05。基线 HEAD `b7794ae947b8d6b094424302f2499ce6e9dba65b`；保留既有未提交工作，未提交或部署。

## 复现与改动

新增回归先失败：`BM25's color is red. Later changed to blue.` 实际返回 `['red']`，预期 `[]`。新增测试同时覆盖 `It changed to blue`、`was corrected to`、跨片段 `BM25的颜色已改为蓝色`、省略主体 `颜色改为蓝色`、明确其他主体、名字“不二”“未央”和不确定性。放宽姓名中单字否定匹配后，再新增的 `不是张三` 反例先失败，随后补充明确否定短语判定。最终上述回归通过；部分案例通过工具和服务双入口验证。

识别到目标或主体不明的有限更正句式时返回空证据，不凭片段顺序推断指代，也不宣称蓝色就是现值；明确其他主体的相应更正维持原证据。姓名字段不再因为包含单字“不”“未”“没”直接否定，同时保留明确不确定或否定短语判断。

## 测试与隔离

参照已有 `reports/stage-2026-11-05-correction-conservative.md` 的调用链审计，并复核五个测试的导入、内存数据库配置：测试引入插件入口，数据使用 `:memory:`，未运行 `test/service.test.mjs`。以下命令清空继承环境，指定新构造的非现有 DSH_HOME，关闭密钥、向量、模型扩展和重排；未读取真实库或密钥。没有操作系统级网络封锁的证明，不把环境隔离等同于网络隔离。

```bash
env -i PATH="$PATH" SYSTEMROOT="$SYSTEMROOT" DSH_HOME="${TEMP:-/tmp}/memjudge-nonexistent-$(date +%s)-$$" MEMJUDGE_NO_SECRETS=1 MEMJUDGE_VECTOR=0 MEMJUDGE_EXPAND=0 MEMJUDGE_LLMSELECT=0 MEMJUDGE_LLMEXTRACT=0 MEMJUDGE_MAX_CHARS=0 MEMJUDGE_RERANK=0 MEMJUDGE_NO_JIEBA=1 node --test --test-concurrency=1 test/attribute-evidence.test.mjs test/read-by-id.test.mjs test/long-recall-position.test.mjs test/recall-truncation.test.mjs test/conflict-read-version.test.mjs
```

Node v24.22.1：25 通过、0 失败、0 跳过，退出 0，3641.5753 ms。假宿主提示 Connection RPC 不可用；这不是实际宿主验证。两处修改文件 `node --check` 均通过；`git diff --check` 通过但只检查已跟踪文件，伴随既有行尾警告。

## 能力边界

识别是有限规则而非完整中文、英文指代消解：未列出的更正形式仍可能遗漏；无主体更正可能指其他对象，因此保守缺证可能误拒；截断后未交付的更正不可见。姓名否定规则也有词面歧义，无法据此证明任意姓名与任意否定均正确。跨来源时序、真实宿主和网络层封锁均未验证。
