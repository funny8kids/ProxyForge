# ADR-0007：一个策略一个监听端口（编译期调度）

- 状态：Accepted
- 日期：2026-11-01
- 相关：[ARCH-001 §6.3](../architecture/01-system-architecture.md)、[API-001 §7](../api/01-api-design.md)

## 背景

需要支持 DIRECT / FIXED / FASTEST / WEIGHTED / STICKY / FAILOVER / REGION 七种策略，并让不同应用使用不同资源池。

有两种实现思路：

- **A. 请求期调度**：应用连同一端口，通过 Header / 认证信息 / 目标域名决定用哪个池。控制面在每个请求上做决策。
- **B. 编译期调度**：每个策略编译成一个独立监听端口，成员与选择策略在配置中固化。

## 决策

采用 **B**。

理由：

1. HTTP 代理协议中，自定义 Header 会被转发到目标站点（泄露内部信息），且 CONNECT 隧道建立后无法再读取 Header——A 方案在 HTTPS 场景根本不成立。
2. 请求期回源控制面会引入 10–50ms 延迟，并让控制面成为流量单点（违反 ADR-0002）。
3. 引擎的 `selector` 已能表达轮询/哈希/优先级，足以覆盖七种策略的运行时语义。

具体映射：

| 业务策略 | 编译产物 |
| --- | --- |
| DIRECT | 无 listener 或 bypass 规则 |
| FIXED | selector 单成员 |
| FASTEST | 按 p50 升序，取前 N |
| WEIGHTED | 成员带权重 |
| STICKY | selector `hash`（按客户端地址） |
| FAILOVER | 按 priority 分组 |
| REGION | 先按地区过滤再排序 |

端口分配：`8080` 为 `default` 策略，命名策略使用 `8090+`，`routing_policies.listen_port` 唯一约束保证不冲突。

## 后果

**正面**

- 请求期零控制面依赖，延迟只增加一跳 TCP。
- 策略语义可预测（配置即真相），便于排障。
- 控制面宕机不影响转发。

**负面**

- 端口数量随策略增长，需要端口规划（限制：最多 ~20 个命名策略）。
- "按用户 ID 粘性"无法在单端口内实现，需要每用户独立 listener（Phase 3）或引擎支持。
- 健康状态变化到配置生效有延迟（≤ 验证周期）。

## 替代方案

| 方案 | 否决理由 |
| --- | --- |
| 单端口 + Header 路由 | HTTPS CONNECT 下不可行；Header 泄露 |
| 单端口 + 认证用户名映射策略 | 可行但客户端配置复杂（每个应用要配不同账号），作为 Phase 3 备选 |
| 自研调度代理 | 违背 ADR-0004（不自研协议栈） |
