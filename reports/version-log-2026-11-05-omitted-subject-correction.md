# 版本记录：省略主体更正与姓名边界

日期：2026-11-05。基线 HEAD `b7794ae947b8d6b094424302f2499ce6e9dba65b`，未提交，包版本未变。增量修改现有未跟踪的 `src/attribute-evidence.mjs` 和 `test/attribute-evidence.test.mjs`，保留其他工作。

目标或歧义更正按有限规则保守缺证，明确其他主体保留原证据；修复姓名否定字子串误判并覆盖明确否定短语。五个审计过的测试文件 25 项通过，测试命令、失败证据、隔离事实和语义局限见 `reports/stage-2026-11-05-omitted-subject-correction.md`。未证明操作系统级网络隔离，未运行 `test/service.test.mjs`。
