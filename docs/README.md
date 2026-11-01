# ProxyForge 设计文档索引

本目录是 ProxyForge 的工程设计基线。产品蓝图回答"做什么"，这里回答"怎么建"。

## 阅读顺序

新加入项目的人按这个顺序读，大约 90 分钟：

1. [系统架构](./architecture/01-system-architecture.md) — 三层平面、部署拓扑、边界规则
2. [模块设计](./architecture/02-module-design.md) — 每个模块的职责、接口、状态机
3. [运行时流程](./architecture/03-runtime-flows.md) — 八条核心链路的时序与失败分支
4. [数据模型](./database/01-data-model.md) + [DDL](./database/schema-v1.sql) — 表、约束、索引、分区
5. [API 设计](./api/01-api-design.md) — 端点、错误模型、订阅规范
6. [安全设计](./security/01-security-design.md) — 威胁模型与防护措施
7. [设计系统](./ui/01-design-system.md) — 色彩分工、组件、可视化与禁止清单
8. [实施计划](./planning/01-phase0-1-plan.md) — 接下来两周做什么

## 文档清单

| 编号 | 文档 | 内容 | 状态 |
| --- | --- | --- | --- |
| ARCH-001 | [系统架构](./architecture/01-system-architecture.md) | 分层、部署、边界、SPI、非功能指标、降级矩阵 | ✅ |
| ARCH-002 | [模块设计](./architecture/02-module-design.md) | 模块职责、Java 接口、状态机、事件契约 | ✅ |
| ARCH-003 | [运行时流程](./architecture/03-runtime-flows.md) | F1–F9 时序、事务边界、失败分支 | ✅ |
| DATA-001 | [数据模型](./database/01-data-model.md) | 建模原则、ER、枚举、索引、分区、保留 | ✅ |
| DATA-002 | [schema-v1.sql](./database/schema-v1.sql) | 可执行 PostgreSQL 16 DDL | ✅ 已在 PGlite 原样执行：44 表 + 24 分区 / 2 视图 / 2 物化视图 / 22 枚举 / 11 触发器 / 152 索引 |
| API-001 | [API 设计](./api/01-api-design.md) | 约定、鉴权、错误码、端点、订阅、幂等 | ✅ |
| SEC-001 | [安全设计](./security/01-security-design.md) | STRIDE、密钥、SSRF、网关 ACL、审计 | ✅ |
| OPS-001 | [部署与运维](./operations/01-deployment-observability.md) | compose、环境变量、备份、监控、Runbook | ✅ |
| PLAN-001 | [Phase 0–1 计划](./planning/01-phase0-1-plan.md) | 任务拆解、关键路径、验收脚本 | ✅ |
| UI-001 | [设计系统](./ui/01-design-system.md) | 双主题令牌、图标系统、组件与可视化规范、双语机制、禁止清单、验收清单 | ✅ |

## 架构决策记录（ADR）

| 编号 | 决策 | 一句话结论 |
| --- | --- | --- |
| [0001](./decisions/ADR-0001-modular-monolith.md) | 模块化单体 | 单库单代码库，用 Facade + 事件 + ArchUnit 硬化边界，未来按边界拆 |
| [0002](./decisions/ADR-0002-three-planes.md) | 三层平面 | 控制面不在请求路径上；数据面独立进程；控制面挂掉网关仍转发 |
| [0003](./decisions/ADR-0003-asset-separation.md) | 资产分离 | IP / Endpoint / Node / ProviderAccount 四个独立生命周期 |
| [0004](./decisions/ADR-0004-gost-engine.md) | GOST v3 起步 | 不自研协议栈；`GatewayEngine` SPI 屏蔽引擎差异 |
| [0005](./decisions/ADR-0005-ai-optional.md) | AI 可选可降级 | 无 AI 时全链路可用；仅 intelligence 可依赖 AiRouter |
| [0006](./decisions/ADR-0006-authorization-gate.md) | 授权硬门槛 | 视图 + 编译 + 渲染三层过滤，`UNKNOWN` 默认拒绝 |
| [0007](./decisions/ADR-0007-one-policy-one-port.md) | 一策略一端口 | 策略在编译期固化，请求期不回源控制面 |
| [0008](./decisions/ADR-0008-subscription-token.md) | 订阅 Token | 只存哈希、一次性展示、撤销即失效、配置版本化 |
| [0009](./decisions/ADR-0009-ed25519-subscription-signing.md) | Ed25519 签名 | 签规范化 JSON（非 YAML 字节流）；Token 认证与内容完整性分离 |
| [0010](./decisions/ADR-0010-trust-tiers.md) | 信任三级 | PRIVATE / PUBLIC / VERIFIED 正交于授权状态；PUBLIC 永久禁止进网关 |
| [0011](./decisions/ADR-0011-typescript-primary.md) | 主干语言 | Java 21 → TypeScript（Node 22 + Fastify）；架构决策不变，保留回退路径 |
| [0012](./decisions/ADR-0012-pglite-local-runtime.md) | 本地运行时 | PGlite 单写者 → worker 内嵌；PG 数组列在模块边界归一化 |

## 实现

| 目录 | 内容 |
| --- | --- |
| [`packages/contracts`](../packages/contracts/src/index.ts) | 单一真相层：API 契约、事件载荷、全部枚举 |
| [`apps/api`](../apps/api/src) | 模块化单体：14 个模块 + worker + 迁移/种子 |
| [`apps/web`](../apps/web/src) | React 前端：9 屏 + 双主题 + 中英双语 |
| [`migrations`](../migrations) | 迁移（0001 = schema-v1 基线；0002 策略绑定实例；0003 晋升理由结构化） |
| [`scripts/verify.mjs`](../scripts/verify.mjs) | 38 项后端验收 |
| [`scripts/shots.mjs`](../scripts/shots.mjs) | 9 屏截图 + 内容渲染断言（面板数 / 可见高度 / 无 console error） |

运行方式见[根 README](../README.md#跑起来)。

## 原型

高保真界面原型：[`prototype/index.html`](../prototype/index.html)（深色基础设施控制台，覆盖 Overview / Topology / Resources / Pools / Gateway / Trust / Subscriptions / AI Providers / Audit 九屏，深浅双主题 + 中英双语）。

原型已移植为可运行的 React 应用：[`apps/web`](../apps/web/src)，与原型共用同一套 Design Tokens（`apps/web/src/styles/app.css`）。

## 三条必须记住的硬规则

1. **AI 与公网内容不得进入执行域**：候选先进隔离区，经授权审查与验证才能晋级；AI 只能提建议，不能改分级。
2. **授权与分级是双门槛**：`UNKNOWN`/`REVOKED` 永不进入网关与订阅；`PUBLIC_PROXY` 永久禁止进入正式网关，无论质量分多高。
3. **网关默认只监听回环**：绑定非回环地址必须同时开启认证 + ACL，否则拒绝启动。

## 维护规则

- 文档与代码不一致时，**先改文档再改代码**（或同 PR 一起改）。
- 架构级变更必须新增 ADR，不改写历史 ADR（用"Superseded by"标注）。
- DDL 变更走 Flyway，`schema-v1.sql` 只作为"v1 基线快照"，不再修改；后续变更进 `db/migration/`。
- 所有 Mermaid / ASCII 图必须能在纯文本下读懂（不依赖渲染）。
