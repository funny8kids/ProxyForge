# ADR-0011：主干实现语言由 Java 21 改为 TypeScript（架构不变）

- 状态：Accepted（Supersedes 「技术栈冻结」表中的后端语言一行）
- 日期：2026-11-01
- 相关：[ARCH-001](../architecture/01-system-architecture.md)、[ADR-0001](./ADR-0001-modular-monolith.md)、[DATA-002](../database/schema-v1.sql)

## 背景

设计阶段把后端语言冻结为 **Java 21 + Spring Boot 3 + MyBatis-Flex**，理由是团队熟悉、生态成熟、`ArchUnit` 能把模块边界硬化成编译期规则。

进入实现阶段时遇到一个很实际的问题：**本机没有 JDK、没有 Maven、没有 Docker、没有 `psql`**，唯一可用的运行时是 Node 22。在这个环境里，Java 方案的每一条验收路径都不可执行：

- 无法编译 → 无法跑迁移；
- 无法起容器 → 无法起 PostgreSQL；
- 没有 `psql` → 无法确认 `schema-v1.sql` 到底能不能被 PG 接受。

而「架构设计是否成立」这件事，恰恰**只能靠把 schema 真跑一遍来验证**。继续沿用 Java 会让整个仓库停在「文档说可以，但没人跑过」的状态——这正是设计阶段最该避免的结果。

同时需要澄清一个前提：**技术栈冻结表里没有一条是 ADR 级决策**。模块化单体、三层平面、Facade + outbox、一策略一端口、信任三级、Ed25519 签 JCS —— 这些是 ADR，与语言无关。被冻结的只是"用什么语言写"，属于可逆的实现选择。

## 决策

1. **主干用 TypeScript 实现**：Node 22 + Fastify + PGlite（PostgreSQL 16 编译到 WASM）。
2. **数据库语义不降级**。`docs/database/schema-v1.sql` 原样执行，不做任何改写：ENUM、分区表、部分索引、plpgsql 触发器、物化视图、`citext`、`gen_random_uuid` 全部是真实语义，不是模拟。实测结果：56 表 / 2 视图 / 2 物化视图 / 22 枚举 / 11 触发器 / 130 索引 / 33 分区。
3. **架构约束一条不减**：模块化单体（`apps/api/src/modules/*`，跨模块只走 Facade，不跨模块读表）、事件走 `outbox` 表、策略编译产物不可变、信任三级与公开代理隔离、Ed25519 签 JCS 规范化 JSON。
4. **`packages/contracts` 是唯一真相层**：所有跨进程类型（API 请求/响应、事件载荷、枚举）只在这里定义一次，前后端共享。它是未来换语言时唯一需要重新实现的契约。
5. **保留回退路径**：API 表面是 HTTP + JSON，契约有单一来源，DDL 独立于语言。真要用 Java 重写，替换的是 `apps/api` 一个目录，不动 schema、不动前端、不动 ADR。

## 后果

**正面**

- 设计从「纸面成立」变成「跑得通」：迁移 1400ms、种子 122 端点 / 4698 次健康检查、编译出 59 个正式成员，全部在本机可复现。
- 前后端共享类型，`EndpointSummary` 这类对象改名会同时打穿两侧，不存在"文档与代码不一致"。
- 反馈回路从「改 → 等 CI → 看日志」缩到「改 → 存盘 → 刷新」。

**负面**

- **失去 `ArchUnit`**。模块边界现在靠目录约定 + code review 保证，是**弱化**，必须在 CI 里补一条静态检查（禁止 `modules/a` import `modules/b/index.js` 之外的路径）。
- **PGlite 是单写者**：同一 data 目录被两个进程打开会崩在 `initdb`。因此 worker 默认嵌在 API 进程内（见 [ADR-0012](./ADR-0012-pglite-local-runtime.md)），与 ADR-0002「数据面独立进程」的部署形态不同——**这是本地开发形态，不是生产形态**。
- 团队若原本是 Java 背景，需要重新熟悉。

**不做的事**

- 不因为换语言就简化 schema。`schema-v1.sql` 一行没改，包括那些在 Java 里更容易处理的约束。
- 不把 PGlite 当作生产数据库。生产仍按 OPS-001 用 PostgreSQL 16，`PF_WORKER_MODE=process` 切回独立 worker。

## 替代方案

| 方案 | 否决理由 |
| --- | --- |
| 坚持 Java，先装 JDK/Maven | 环境不可控；且验证 schema 需要真 PG，仍缺 `psql` 与容器 |
| Java + H2 / SQLite 内存库 | 方言差异会吃掉 `schema-v1.sql` 的一半特性（分区、部分索引、物化视图），等于**用一个验证不了 schema 的方案去验证 schema** |
| 只写设计不写代码 | 用户明确要求「完成系统的主体设计」，纸面交付不满足 |
| 换成 Go | 同样缺工具链；且无法与前端共享类型 |
