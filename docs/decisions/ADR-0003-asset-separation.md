# ADR-0003：IP 资产 / 代理端点 / 代理节点 三实体分离

- 状态：Accepted
- 日期：2026-11-01
- 相关：[DATA-001 §1](../database/01-data-model.md)

## 背景

最常见的建模错误是一张 `proxies` 表塞进 `ip`、`port`、`protocol`、`country`、`asn`、`password`。它无法回答这些问题：

- 一台 VPS 上跑 3 个协议端口，是 3 条资源还是 1 条？
- 动态 IP 变化后，历史记录放哪？
- 同一个 IP 被两个来源同时收录，去重后归属谁？
- 供应商账户欠费，应该影响哪些资源？

## 决策

拆为四个独立生命周期实体：

| 实体 | 语义 | 生命周期 |
| --- | --- | --- |
| `ip_assets` | 一个 IP 地址资产 | 长期，随地址变化新增记录 |
| `proxy_endpoints` | 一个协议接入点（host:port+protocol） | 主体，有完整状态机 |
| `proxy_nodes` | 一台代理服务实例（VPS/路由器/容器） | 长期，与端点一对多 |
| `provider_accounts` | 供应商账户（额度、凭据） | 长期，与节点一对多 |

关联通过可空外键表达（端点可无节点、可无 IP 资产），**不用继承、不用单表多态**。

属性维度也拆开：`ip_type`（STATIC/DYNAMIC/UNKNOWN）、`network_type`（RESIDENTIAL/DATACENTER/MOBILE/UNKNOWN）、`protocol`、`origin_type`、`authorization_status` 五列独立，各自带置信度。

## 后果

**正面**

- 动态 IP 有地方存历史（`endpoint_ip_observations`），"动态"判定有证据链。
- 一台 VPS 多协议天然支持。
- 去重粒度精确到"协议+主机+端口+凭据指纹"，不会把同一 IP 的不同服务误合并。
- 供应商额度可精确关联到受影响节点。

**负面**

- 查询需要 JOIN（用 `v_schedulable_endpoints` 视图收敛）。
- 导入流程需要三步（建 IP → 建节点 → 建端点），代码更复杂。
- 前端需要三个列表页而不是一个。

## 替代方案

| 方案 | 否决理由 |
| --- | --- |
| 单表 `proxies` | 无法表达多协议、动态 IP、历史；蓝图明确反对 |
| 单表 + JSONB 扩展字段 | 查询与约束能力退化，索引难建 |
| IP 作为端点的一个字段 | 动态 IP 场景语义混乱（端点地址 vs 出口地址） |
