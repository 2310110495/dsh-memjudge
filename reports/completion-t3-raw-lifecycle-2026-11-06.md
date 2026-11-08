# T3 raw预算与生命周期

执行者：backend-engineer；attempt：completion-t3-a3；基线 HEAD：`1c325e141de5b7c33453e17c80ef4e6ab7754421`。共享工作树含其他未提交任务成果，均保留；未提交、未部署。

## 实现

- `src/raw-ingest-policy.mjs`：启用时要求显式 `bounded-jsonl-v1` 合同与显式预算；硬上限为 session 8 MiB、event 256 KiB、events 10,000、page 1 MiB、graph nodes 65,536、properties 32,768、code units 2 Mi、header 16 KiB。拒绝 proxy/accessor 和不完整/矛盾 metadata；仅在预算校验通过后允许 open。配置图限制 10,000 nodes / 20,000 properties/key 256 字符。
- `src/raw-host-adapter.mjs`：限制 session list 数量；授权和 metadata gate 在 open 前；open/read 携带 budget、expected revision 和最大页字节；固定分页逐页检查 count/revision/decoded bytes、sequence、identity 与对象图预算。全部页及最终 stat/header 校验成功且句柄关闭后才 ingest/preserve/prefix。失败只记 dirty，不发布事件 identity、版本、proof、observation；空 event list 不生成 prefix。
- 清理先停 timer/abort 并等待当前 scan/close，重试保留句柄，再按 repository、namespace lease 顺序关闭；只有都成功才释放 worker ownership。close 失败保留 handle 并阻断后续 tick；lease lock ownership 丢失时报 `namespace-lease-lost`，不关闭 descriptor、不标记 released。资源 scope/disposal 的失败保留、重入/等待环由合成测试覆盖。
- `src/raw-namespace.mjs`：lease close 核对 lock inode/device/token；只有确认本锁已 unlink 或路径已不存在后才关闭 descriptor、标记释放。foreign replacement 保持未释放。
- facts store/startup 预检、vectors/re-rank 未改。生产接线为 `src/index.mjs:20,420`，真实入口未运行。

## 回归证据

合成测试：`test/raw-host-budget-production-synthetic.test.mjs`。它导入真实 `installRawHostAdapter`、`RawRepository`、policy、namespace、resource lifecycle 与 disposal，以合成 backend 驱动生产链；SQLite 只在每个测试唯一 case directory 创建。每次测试通过 `T3_FIXTURE_ROOT` 指向新的空绝对 `.t3-fixtures` 根，同时 `TEMP`/`TMP` 固定到该根；schema preflight 只处理自己创建的 `raw-schema-*` 临时目录。未运行旧测试、真实 `index/apply`、真实宿主/数据库/配置或网络。

执行目录：`D:/cursor项目组/4/memjudge-plugin`。语法检查命令依次为 `node --check src/raw-host-adapter.mjs`、`node --check src/raw-ingest-policy.mjs`、`node --check src/raw-namespace.mjs`、`node --check test/raw-host-budget-production-synthetic.test.mjs`；均退出码 0。最后隔离回归使用新空根 `F:/记忆库/.t3-fixtures/run-20261107-09`，固定 `T3_FIXTURE_ROOT`、`TEMP`、`TMP` 后执行 `node --test --test-concurrency=1 test/raw-host-budget-production-synthetic.test.mjs`：7 tests，7 pass，0 fail，0 cancelled，无后台 ENOENT。

覆盖：生产 adapter 固定页 `[0,2],[2,2],[4,1]` 且落库事件/version/proof；超预算、不一致、accessor、proxy metadata 在 open 前失败；revision变化、sequence缺口、oversize event 后 events/versions/proofs/observations 均为0；handle close失败后重试并在 stop 后无后续 close/tick、释放 lock；scope失败重试/重入/等待环；Disposal 子清理失败阻止父级 clear/close并重试；lease lock被替换时保留 foreign lock与未释放状态。失败诊断日志来自预期负向夹具。

## 生产边界与限制

本仓库未包含实际 session-persistence JSONL backend 实现。`bounded-jsonl-v1` 的 metadata-before-parse、解压后字节限额、固定 revision 与最大页能力，当前由生产接入门禁与调用参数表达；合成 backend 证明 adapter 路径拒绝超限/变化，不证明真实宿主 decoder 在分配前履约。因此真实宿主解析峰值内存上界尚未实测。T6 负责真实宿主 unload/await、decoder 与取消/关闭语义验证。本轮未运行真实宿主；未提交或部署。

## T6 边界

T3 完成生产 adapter 门禁、生产路径合成回归和 worker/lease 清理逻辑；T6 仍需核验真实宿主适配器在解压/解析前执行预算、取消期间 unload/await 顺序、超大/部分/变化输入实际峰值与句柄关闭确认。合成测试不是宿主验证或公平评测。
