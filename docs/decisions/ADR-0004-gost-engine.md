# ADR-0004：以 GOST v3 起步，通过 Engine Adapter 屏蔽引擎差异

- 状态：Accepted
- 日期：2026-11-01
- 相关：[ARCH-001 §6.3](../architecture/01-system-architecture.md)、[ARCH-002 §2.6](../architecture/02-module-design.md)

## 背景

需要 HTTP / HTTPS CONNECT / SOCKS5 接入，并把请求分发到多个上游代理。自研协议栈的成本极高（TLS、CONNECT 隧道、SOCKS5 握手、连接池、超时、半关闭语义），且不是本产品的差异化价值。

候选引擎：GOST v3、sing-box、Mihomo、3proxy、Squid。

| 引擎 | 多上游选择 | 配置热重载 | 部署复杂度 | 备注 |
| --- | --- | --- | --- | --- |
| **GOST v3** | ✅ selector（round/hash/fifo/priority） | ✅ API/信号 | 单二进制 | Go 编写，协议覆盖广 |
| sing-box | ✅ 但偏客户端场景 | 部分 | 中 | 配置模型偏"客户端订阅" |
| Mihomo | ✅ proxy-groups | 需重启 | 中 | 本身是客户端，做服务端非主流 |
| 3proxy | 有限 | 需重启 | 低 | 功能偏老 |
| Squid | 仅 HTTP | 需重启 | 中 | 不支持 SOCKS5 上游链 |

## 决策

1. V1 使用 **GOST v3** 作为唯一数据面引擎，独立进程部署。
2. 定义 SPI `GatewayEngine`（`render / apply / stats / health`），业务层只依赖 SPI。
3. 控制面把策略编译成**引擎无关的 IR**（`CompiledGateway`），再由 `GostAdapter` 渲染为具体配置。
4. 引擎差异（能力缺失）在 Adapter 层降级表达，并向用户返回 `warnings`，不静默改变语义。

## 后果

**正面**

- 零协议开发成本，Phase 0 两天内可验证端到端。
- 换引擎只需新增一个 Adapter，业务代码不动。
- GOST 的 `selector` 天然支持 FAILOVER（优先级）与 STICKY（hash）。

**负面**

- 受 GOST 能力限制：例如"按 API Key 粘性"需在认证层做，或等引擎支持。
- 配置模型需要"IR → 渲染"的映射层，增加一层间接。
- 引擎崩溃是单点（用容器自动重启 + 配置持久化兜底）。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| GOST 热重载不可靠 | Phase 0 验证；不可靠则双实例滚动切换（先起新实例 → 切流量 → 停旧实例） |
| 配置语法版本漂移 | 锁定镜像 tag，升级前跑配置回归测试 |
| 单实例连接数上限 | Phase 3 按策略拆分多实例（一策略组一进程） |
