# ADR-0010：资源信任三级分类，PUBLIC_PROXY 默认隔离

- 状态：Accepted
- 日期：2026-11-01
- 相关：[SEC-001 §6.2](../security/01-security-design.md)、[DATA-001 §5.2](../database/01-data-model.md)、[ADR-0006](./ADR-0006-authorization-gate.md)

## 背景

`authorization_status` 只回答"有没有授权"，回答不了"这份资源允许用在什么场景"。实践中出现三类混淆：

1. 自有 VPS 被默认当成"可用于任何应用"，但用户可能只想给特定任务用。
2. 公开代理因为"验证通过、延迟低"，被规则引擎自动提升到生产池——**可用性被当成合法性**。
3. "授权"与"可信"被合并成一个字段，导致要么过度保守（全都不用），要么过度激进（全都能用）。

## 决策

引入与 `authorization_status` **正交**的 `trust_tier`：

| 分级 | 默认网关接入 | 订阅实验 | 正式网关 |
| --- | --- | --- | --- |
| `PRIVATE_PROXY` | 禁止 | 禁止 | 需显式授权（`explicit_gateway_grant`） |
| `PUBLIC_PROXY` | 禁止 | 仅 `PUBLIC_EXPERIMENTAL` | **永久禁止** |
| `VERIFIED_PROXY` | 允许 | 允许 | 允许 |

配套规则：

1. **默认值即最严**：`trust_tier` 默认 `PUBLIC_PROXY`，新导入资源不会因"忘记分级"而进入网关。
2. **分级不可被规则引擎写入**：`PoolRuleEngine` 只读；写入路径仅"人工 API"与"确定性晋升流程"。
3. **PUBLIC_PROXY 六条约束**：默认入实验池、不允许自动晋升、必须过连通性/匿名性/安全性检查、可用性≠合法性、全生命周期留痕、可立即隔离撤销。
4. **AI 只能建议**：写 `promotion_suggestions`，批准必须人工（DB `CHECK` 强制 `APPROVED` 必有 `reviewed_by`）。
5. **数据库层兜底**：`CHECK (NOT (trust_tier='PUBLIC_PROXY' AND explicit_gateway_grant))`，即使应用层有 bug 也无法授予。
6. **池声明可接纳分级**：`resource_pools.allowed_tiers`，实验池必须包含 `PUBLIC_PROXY` 且置 `experimental=true`（用于强制警告）。

## 后果

**正面**

- 权限边界可被审计、可被测试、可被数据库保证。
- "公开代理被误用于生产"从"需要小心"变成"物理上不可能"。
- 分级与授权解耦后，两种判断可以独立演进（例如授权体系接入供应商合同，分级体系接入风控）。

**负面**

- 多一个需要维护的字段与一套晋升流程，运营成本上升。
- 新导入资源默认不可用于网关，用户需要显式分级（这是有意为之）。
- 三级分类对"小规模个人用户"略显繁琐，UI 必须提供"批量分级"降低摩擦。

## 替代方案

| 方案 | 否决理由 |
| --- | --- |
| 只用 `authorization_status` | 无法表达"有授权但仅限实验"的场景 |
| 用 `origin_type` 直接决定权限 | 来源类型是事实描述，权限是策略决定，混在一起无法调整 |
| 用布尔 `is_production` | 无法表达"私有但未授权网关"这一中间态 |
| 分级交给 AI 判断 | 权限决定不可外包给概率模型（见 SEC-001 §6.6） |
