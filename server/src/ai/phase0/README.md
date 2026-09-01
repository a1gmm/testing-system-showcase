# AI-0002 离线标准变化 Tracer

本目录实现 Phase 0 的内存纵向链：

`StandardChangeEvent → EvidencePacket → Proposal → AdvisoryCheck → deterministic machine gate → synthetic human decision → fake apply → audit/eval`

它是合同与安全边界的可执行验证件，不是生产 AI 服务，也不代表标准已自动更新、439 张模板已覆盖全行业或任何正式模板已经发布。

## 允许的数据和副作用

- 只读取 `server/test/ai/fixtures/standards/v1/` 下的 16 个 S0/S1 合成/公开元数据夹具；
- 只使用 Node 内置模块，运行时没有模型 SDK 或外部依赖；
- 不联网，不调用真实模型，不连接生产数据库；
- fake apply 只在内存中创建候选快照；
- 不写模板、检测证据、业务数据库、仓库工作树或正式报告；
- AI role 和 service principal 都不能批准，批准夹具必须是绑定精确 revision/hash 的 synthetic human decision。

## 直接运行

在仓库根目录执行聚焦测试：

```bash
cd server
node --test test/ai-phase0-tracer.test.ts
```

执行后端全部测试：

```bash
cd server
npm test
```

执行仓库完整发布门禁：

```bash
bash ops/verify-release.sh
```

聚焦测试应发现且只发现 T01–T16 共 16 个版本化场景夹具，并通过 24 个测试。完整门禁还会复验 439 个现有模板、前后端测试、十阶段端到端流程以及既有 AI 规划/状态合同；实际计数如未来增加，以命令当次输出为准。

## 输出怎么判断

- `completed`：合法 material fixture 经七项确定性门禁、synthetic human approve 和 fake apply 后完成；
- `no_change`：明确的无实质变化，且不创建 Proposal 或 candidate；
- `awaiting_human`：缺少或无效批准，绝不执行 fake apply；
- `rejected`：synthetic human 明确拒绝；
- `superseded`：批准后 target 漂移，旧批准不再适用；
- `apply_failed`：fake executor 失败且没有部分 candidate；
- `policy_stopped` / `failed`：能力、kill switch、schema、来源、引用、权限或审计失败后关闭。

稳定错误码和对象字段以 `docs/ai/contract-matrix.md` 为准，状态机和精确 projection 以 `docs/ai/tracer-bullet.md` 为准。不要把本 tracer 的 `official_public_fixture` 或 `fixture_pinned` 当成实时官方来源核验。

## 后续接真实系统前必须重新审批

任何持久队列/租约、模型网关、客户数据、网络采集、生产数据库、正式模板写入、UI、PR 合并或生产部署都不属于 AI-0002。它们必须按后续任务分别实现、测试、人工复核和授权；不能直接把本模块接到现有 LIMS 写路径。
