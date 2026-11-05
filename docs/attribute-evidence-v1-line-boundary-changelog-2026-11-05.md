# 属性证据 V1 版本日志：换行句界

## 2026-11-05｜阶段记录，未指定正式版本号

- 修复主题：统一 CR、LF、CRLF、U+2028、U+2029 在文本分句和原文窗口边界判断中的处理；CRLF 由相邻 CR 与 LF 分别参与分隔。
- 当前实现保留换行前的映射边界；候选断言仍要求句号或感叹号类终止标点，换行自身不作为有效断言终止符。
- 回归覆盖：五种换行形式、红蓝候选冲突、修正线索、不完整上下文及 UTF-16 窗口/原文切片。
- 测试结果：实施者自报两份纯测试修复前 **24/25**、修复后 **25/25**；尚未独立复跑，未核验原始输出。
- 涉及依据：`src/attribute-evidence-v1.mjs`、`test/attribute-evidence-v1.test.mjs`、`test/attribute-evidence-v1-regression.test.mjs`。范围、依据及局限详见同目录阶段报告 `attribute-evidence-v1-line-boundary-stage-report-2026-11-05.md`。
