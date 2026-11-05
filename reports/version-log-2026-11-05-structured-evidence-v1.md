# 版本日志：结构化属性证据 V1

日期：2026-11-05。新增独立模块 `src/attribute-evidence-v1.mjs` 和独立测试 `test/attribute-evidence-v1.test.mjs`，输出有限颜色语法的候选、状态、UTF-16 span 与经原文切片校验的可选映射。原有属性证据逻辑和生产接线保持不变。

测试先行：实现前因模块缺失退出 1；实现后 `node --test test/attribute-evidence-v1.test.mjs` 为 6 通过、0 失败；模块及测试的 `node --check` 均退出 0。详细范围、证据与局限见 `reports/stage-2026-11-05-structured-evidence-v1.md`。未接生产、未访问真实库或密钥、未联网、未提交和部署。
