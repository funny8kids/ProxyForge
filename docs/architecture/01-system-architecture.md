# ProxyForge 系统架构设计

> 文档编号：ARCH-001
> 版本：v1.0（对应蓝图 V1.0 架构基线）
> 状态：Accepted
> 最后更新：2026-11-01
> 关联文档：[模块设计](./02-module-design.md) · [运行时流程](./03-runtime-flows.md) · [数据模型](../database/01-data-model.md) · [API 设计](../api/01-api-design.md) · [安全设计](../security/01-security-design.md)

---

## 1. 本文档的定位

蓝图（`ProxyForge 总体设计蓝图 V1.0`）回答"产品是什么、要解决什么问题"；本文档回答"代码怎么组织、进程怎么部署、边界怎么划、失败怎么处理"，是所有实现工作的技术基线。

本文档不重复蓝图的商业与路线图内容，只做工程化落地。凡与蓝图冲突处，以本文档为准，并在 `docs/decisions/` 记录变更理由。

### 1.1 范围（V1 / Phase 0–1）

| 在范围内 | 明确不在 V1 范围 |
| --- | --- |
| 资源导入（CSV/JSON/文本）、去重、IP/Endpoint/Node 分离建模 | 自动爬取全网代理、AI 主动发现（Phase 2） |
| L1–L6 分层验证、健康历史、质量评分 | L7 长周期稳定性测试的自动化编排（先手工触发） |
| 静态/动态/未知属性识别（基于证据，不猜测） | 住宅/机房属性的主动探测（V1 仅采信来源声明 + ASN 标注为"推断"） |
| 资源池（自动规则 + 手动成员） | 多租户隔离（Phase 5） |
| 统一网关（HTTP/SOCKS5），策略编译与故障切换 | 自研代理协议栈 |
| Mihomo YAML 订阅、Token、版本 | 计费、配额结算 |
| AI Provider Registry（Phase 2 前置，接口先留好） | 多节点 Agent 编排（Phase 4） |

### 1.2 架构目标

1. **端到端可用优先**：一条真实链路（导入 → 验证 → 入池 → 网关 → 应用使用 → 观测）必须完整跑通，再谈广度。
2. **失败可隔离**：AI 挂、引擎挂、单个 Worker 挂，都不能让资产库和网关同时失效。
3. **可替换**：代理引擎、AI Provider、来源解析器都是 SPI，换实现不改业务代码。
4. **默认安全**：网关只监听回环地址，未知资源进隔离区，授权状态是硬门槛。
5. **可演进**：模块化单体，模块边界即未来的服务边界，拆分不需要重写。

### 1.3 架构非目标

- 不做"每请求回源控制平面"的实时调度（延迟不可接受，见 §6.3 策略编译）。
- 不做跨地域分布式一致性（单集群主库，Phase 4 再考虑读写分离）。
- 不追求协议解析的完全覆盖（未知协议进 `UNKNOWN` 而不是猜）。

---

## 2. 系统上下文（C4 Level 1）

```
                        ┌──────────────────────────────┐
                        │   运维 / 开发者（浏览器）      │
                        └───────────────┬──────────────┘
                                        │ HTTPS
                        ┌───────────────▼──────────────┐
                        │  ProxyForge 管理控制台 (SPA)  │
                        └───────────────┬──────────────┘
                                        │ REST /api/v1
┌───────────────┐        ┌──────────────▼──────────────┐        ┌─────────────────┐
│ 资源来源       │◄──────►│                             │◄──────►│ AI Provider     │
│ GitHub / API  │  拉取   │      ProxyForge 平台         │ 调用   │ OpenAI/DeepSeek │
│ 供应商 / 手工  │        │                             │        │ Ollama/自定义    │
└───────────────┘        └───┬──────────────────┬──────┘        └─────────────────┘
                             │ 生成配置/下发      │ 代理流量
                    ┌────────▼───────┐   ┌──────▼──────────────────┐
                    │ 代理引擎 GOST   │◄──│ 消费方：Python/Java/CLI  │
                    │ (Data Plane)   │   │ Mihomo / FlClash         │
                    └────────┬───────┘   └─────────────────────────┘
                             │ 转发
                    ┌────────▼───────────────────────────────────┐
                    │ 上游代理端点（自有 VPS / 授权免费 / 付费）    │
                    └────────────────────────────────────────────┘
```

关键点：**平台本身不是流量的必经中间件**。消费方可以走网关（推荐），也可以拿订阅直连上游。平台的价值在"决策与观测"，不在"转发"。

---

## 3. 三层平面（C4 Level 2）

### 3.1 平面划分

| 平面 | 组成 | 是否处理用户流量 | 部署形态 |
| --- | --- | --- | --- |
| **Intelligence Plane** | Source Discovery、Content Analyzer、Candidate Extractor、AI Router | 否 | 与 API 同进程的后台任务（V1），Phase 2 可独立 Worker |
| **Control Plane** | Registry、Verification、Pool、Policy、Subscription、Gateway 编排、Audit | 否（只产生配置与决策） | `proxyforge-api` + `proxyforge-worker` 两个进程，同一代码库 |
| **Data Plane** | GOST v3 进程（HTTP/SOCKS5 监听器） | 是 | 独立进程，独立生命周期 |

### 3.2 边界硬规则（违反即架构缺陷）

1. **Intelligence 不写业务表**。它只能写 `candidate_endpoints` / `source_snapshots` / `ai_analysis_logs`，禁止直接写 `proxy_endpoints`。晋级必须走 Control Plane 的 `CandidatePromotionService`。
2. **Data Plane 不理解业务**。GOST 只接受已编译的配置，配置里没有"授权状态""质量分"这类概念——不合格资源根本不会出现在配置里。
3. **Data Plane 不回调控制平面**。控制平面轮询引擎状态（拉模式），避免数据面依赖控制面可用性。
4. **AI 只在 Intelligence 与"解释性"场景出现**。验证、去重、授权判定、调度全部是确定性代码。
5. **跨模块不访问对方的表**。模块间只能通过应用服务接口或领域事件（见 §5）。

### 3.3 为什么 Data Plane 用独立进程

| 方案 | 问题 |
| --- | --- |
| Java 内嵌转发 | 需要重写协议栈；GC 停顿直接影响转发；与业务部署耦合 |
| Java 进程内启动 GOST 子进程 | 生命周期耦合，引擎崩溃会拖垮控制面 |
| **独立进程 + 配置下发**（选中） | 引擎可单独重启/升级；控制面挂掉时已有转发继续工作（配置是静态的） |

这个选择带来一个重要特性：**控制平面不可用时，网关继续按最后一份配置转发**。这是可用性上的关键收益。

---

## 4. 部署拓扑（C4 Level 3 · Container）

```
┌─────────────────────────── docker compose network: proxyforge ──────────────────────────┐
│                                                                                          │
│  ┌────────────────────┐        ┌─────────────────────────┐        ┌──────────────────┐  │
│  │ proxyforge-web     │        │ proxyforge-api          │        │ proxyforge-worker│  │
│  │ nginx + SPA        │──REST─►│ Spring Boot :8081       │◄──DB──►│ 同镜像           │  │
│  │ :3000              │        │ - 管理 API              │        │ --profile=worker │  │
│  └────────────────────┘        │ - 订阅渲染              │        │ - 发现/验证/同步 │  │
│                                │ - 策略编译              │        │ - Outbox 中继    │  │
│                                └───────┬─────────┬───────┘        └────────┬─────────┘  │
│                                        │         │                        │            │
│  ┌────────────────────┐                │         │ 写配置卷                │            │
│  │ postgres:16        │◄───────────────┘         │                        │            │
│  │ :5432              │◄─────────────────────────┼────────────────────────┘            │
│  └────────────────────┘                          │                                     │
│  ┌────────────────────┐                          ▼                                     │
│  │ redis:7            │        ┌──────────────────────────────┐                        │
│  │ :6379 锁/限流/缓存  │◄───────│ gost v3  :8080 HTTP          │                        │
│  └────────────────────┘        │          :1080 SOCKS5        │                        │
│                                │          :9000 引擎管理 API   │                        │
│                                └──────────────┬───────────────┘                        │
│  ┌────────────────────┐                       │                                        │
│  │ prometheus/grafana │◄── 抓取 /metrics ─────┘                                        │
│  └────────────────────┘                                                                │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 端口规划

| 端口 | 进程 | 绑定 | 用途 | 对外暴露 |
| --- | --- | --- | --- | --- |
| 3000 | web | 0.0.0.0（可配） | 管理控制台 | 视部署而定 |
| 8081 | api | **127.0.0.1** | REST API + 订阅 | 否（反代后暴露） |
| 8080 | gost | **127.0.0.1** | HTTP / HTTPS CONNECT | 否 |
| 1080 | gost | **127.0.0.1** | SOCKS5 | 否 |
| 9000 | gost | 127.0.0.1 | 引擎管理（stats/config） | 否 |
| 5432 / 6379 | pg / redis | 内部网络 | 数据与缓存 | 否 |

**硬要求**：8080/1080/9000 默认只绑定 `127.0.0.1`。对外开放必须显式配置 `GATEWAY_BIND=0.0.0.0` + 开启网关认证 + 配置 IP 白名单，三项同时满足才允许启动（启动时校验，否则拒绝）。

### 4.2 api 与 worker 为什么拆两个进程

同一份代码、同一个镜像，通过 `SPRING_PROFILES_ACTIVE=api|worker` 决定加载哪些 Bean：

- 隔离：验证任务大量占用连接与线程，不能挤占管理 API 的响应时间。
- 独立扩缩：worker 可以横向扩到 3 个副本，靠 DB 任务租约协调。
- 故障域：worker OOM 不影响 API 与网关。

代价：需要一套任务租约机制（见 §7.2），但比引入消息队列轻。

---

## 5. 模块结构与依赖规则

### 5.1 模块清单（`com.proxyforge.*`）

| 模块 | 职责 | 拥有的表 | 对外暴露 |
| --- | --- | --- | --- |
| `auth` | 登录、会话、API Key、RBAC | `proxy_users` `api_keys` | `AuthFacade` |
| `resource` | IP/Endpoint/Node 资产、生命周期、信任分级 | `ip_assets` `proxy_endpoints` `proxy_nodes` `endpoint_sources` `endpoint_ip_observations` `promotion_suggestions` `security_checks` | `ResourceFacade` |
| `source` | 来源目录、快照、导入任务、解析器注册 | `resource_sources` `source_snapshots` `import_jobs` `candidate_endpoints` | `SourceFacade` |
| `intelligence` | 发现任务编排、AI 分析流水线 | `ai_discovery_tasks` `ai_analysis_logs` | `IntelligenceFacade` |
| `verification` | 分层验证、健康检查、评分 | `verification_jobs` `health_checks` `endpoint_health_state` `endpoint_metrics_hourly` | `VerificationFacade` |
| `pool` | 资源池、规则、成员 | `resource_pools` `resource_pool_rules` `resource_pool_members` | `PoolFacade` |
| `policy` | 路由策略、会话、故障链 | `routing_policies` `routing_sessions` | `PolicyFacade` |
| `gateway` | 策略编译、引擎适配、实例管理、流量 | `gateway_instances` `gateway_configs` `gateway_traffic_samples` | `GatewayFacade` |
| `subscription` | 订阅、Token、版本、渲染、内容签名 | `subscriptions` `subscription_versions` `signing_keys` | `SubscriptionFacade` |
| `provider` | 供应商与账户额度 | `providers` `provider_accounts` | `ProviderFacade` |
| `ai` | Provider Registry、任务路由、用量 | `ai_providers` `ai_models` `ai_task_bindings` `ai_usage_records` | `AiRouter` |
| `analytics` | 只读聚合、报表 | 无（读视图/物化视图） | `AnalyticsQueryService` |
| `audit` | 审计事件、变更日志 | `audit_events` `config_versions` | 事件订阅 |
| `common` | 结果类型、错误码、加密、时钟、ID | `event_outbox` `secrets` | 工具 |

### 5.2 允许的依赖方向

```
common ◄── auth ◄── {resource, source, provider, ai}
                        │
        resource ◄── verification ◄── pool ◄── policy ◄── gateway ◄── subscription
                        ▲
                     source ◄── intelligence
provider ◄── {resource, verification}
analytics ── 只读，依赖所有模块的 Query 接口（单向）
audit ── 只订阅事件，不被任何模块依赖
```

规则：

- **禁止环依赖**。`verification` 需要端点数据，只通过 `ResourceFacade` 读；`resource` 不知道验证的存在，只订阅 `EndpointVerified` 事件更新自己的只读字段。
- `pool` 依赖 `verification` 的质量快照，不直接读 `health_checks`。
- `gateway` 只依赖 `policy` 与 `pool` 的对外接口，不依赖 `resource`。
- `analytics` 与 `audit` 是叶子节点，任何模块都不能反向依赖它们。

用 ArchUnit 测试固化上述规则（`ModuleDependencyTest`），CI 阻断违规。

### 5.3 模块内部结构（统一模板）

```
com.proxyforge.verification
├── domain/            # 聚合根、值对象、领域服务、领域事件（不依赖 Spring）
├── application/       # 用例编排、事务边界、@Transactional 只出现在这一层
│   ├── VerificationJobService
│   └── dto/
├── infrastructure/    # Repository 实现、外部适配器、Mapper
└── interfaces/        # REST Controller、定时任务入口、事件监听
```

约束：`domain` 不 import `org.springframework.*`；`interfaces` 不写业务逻辑；Repository 接口定义在 `domain`，实现在 `infrastructure`。

---

## 6. 关键架构机制

### 6.1 事件驱动的模块解耦（Transactional Outbox）

模块间"通知"用领域事件，但**不用应用内 `@EventListener` 做跨模块写操作**（会在同一事务里隐式耦合、且重启丢事件）。

```
业务事务内：UPDATE proxy_endpoints + INSERT INTO event_outbox
                    ↓ 提交
Worker 的 OutboxRelay（每 500ms 批量拉 100 条，FOR UPDATE SKIP LOCKED）
                    ↓
按 event_type 分发到订阅方 Handler（幂等，按 event_id 去重）
                    ↓
标记 published_at
```

核心事件清单见 [模块设计 §5](./02-module-design.md#5-领域事件契约)。

### 6.2 任务租约（替代消息队列）

`verification_jobs` / `ai_discovery_tasks` / `import_jobs` 共用一个任务表模式：

```sql
-- 抢占
UPDATE verification_jobs
   SET status='RUNNING', lease_owner=$worker, lease_expires_at=now()+interval '2 min', attempts=attempts+1
 WHERE id = (SELECT id FROM verification_jobs
              WHERE status='PENDING' AND run_after <= now()
              ORDER BY priority DESC, created_at
              FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

租约过期由巡检任务回收（`status='RUNNING' AND lease_expires_at < now()` → 回 `PENDING`，`attempts >= max_attempts` → `FAILED`）。

这套机制在单机 MVP 完全够用；Phase 4 若需要多语言 Worker，再引入 Redis Stream / NATS，接口不变。

### 6.3 策略编译（Policy Compilation）——本项目最关键的架构设计

问题：调度策略（FASTEST/STICKY/FAILOVER…）如果每请求回源控制平面，会引入 10–50ms 额外延迟 + 控制面成为流量路径上的单点。

方案：**把策略在配置变更时编译成引擎配置**。

```
Routing Policy (DB, 业务语义)
        │  PolicyCompiler
        ▼
EngineConfig (引擎无关的 IR)
   listener(policy) → chain → selector(members, strategy, healthFilter)
        │  GostAdapter.render()
        ▼
gost config.yaml  ──写入配置卷 + 热重载──►  GOST 进程
```

规则：

1. **一个策略 = 一个监听端口**（`8080` 为 `default` 策略，`8090+` 为命名策略，端口在 `routing_policies.listen_port` 上唯一约束）。
2. 编译输入只包含**通过硬门槛**的端点：授权有效 + 健康 + 协议匹配。不合格端点不会出现在配置里，从物理上杜绝误用。
3. `STICKY` 映射为引擎的 `hash` 选择器（按客户端地址哈希）；需要"按 API Key 粘性"时，由网关认证层把用户映射到独立 listener（Phase 3）。
4. `FAILOVER` 映射为优先级分组（`priority` 字段），引擎按组降级。
5. 编译产物带 `config_version`（单调递增），写入 `gateway_configs` 并保留历史，支持一键回滚。
6. 编译是**幂等**的：相同输入产生相同配置哈希，哈希未变则不下发。

失败处理：编译或下发失败 → 保留上一份生效配置 → 记录 `gateway_configs.status=FAILED` + 告警。**永远不要下发一份不完整的配置。**

### 6.4 订阅渲染与网关解耦

订阅（Mihomo YAML）和网关是两条独立的消费路径，共享同一份"资源池快照"：

- 网关：控制面 → 引擎配置 → 实时转发。
- 订阅：`GET /api/v1/subscriptions/{token}` → 渲染 YAML（proxies + proxy-groups），客户端自己连上游。

因此订阅渲染不需要网关可用，网关挂掉也不影响已有订阅（只是上游节点质量可能已变化，由订阅刷新兜底）。

### 6.5 可观测性三件套

| 类型 | 内容 | 落地 |
| --- | --- | --- |
| Metrics | 端点健康率、验证成功率、网关连接数/字节数、任务队列深度、AI Token 与成本 | Micrometer → Prometheus |
| Logs | 结构化 JSON，含 `trace_id`/`job_id`/`endpoint_id`；凭据与 Token 强制脱敏 | stdout → Loki（可选） |
| Audit | 谁在什么时候改了什么（资源、策略、Provider、密钥） | `audit_events` 表，不可改不可删 |

---

## 7. 非功能性设计

### 7.1 容量假设（V1 单机）

| 维度 | 目标 |
| --- | --- |
| 托管端点 | 10,000（其中同时健康 ≤ 2,000） |
| 单次验证并发 | 50（可配），令牌桶限速 |
| 验证频率 | 健康端点 15 min，降级端点 3 min，隔离端点 6 h |
| 网关并发连接 | 2,000（GOST 单实例） |
| 管理 API P95 | < 300 ms（列表查询，10 万行内） |
| 网关额外延迟 | < 5 ms（不含上游 RTT） |
| 健康检查写入 | 10k 端点 × 96 次/天 ≈ 1M 行/天 → 按月分区 |

### 7.2 SLO

| SLI | 目标 |
| --- | --- |
| 网关可用性（进程存活 + 监听可用） | 99.5% / 月 |
| 订阅接口可用性 | 99.5% / 月 |
| 管理 API 可用性 | 99% / 月 |
| 资源池"标注健康但实际不可用"比例 | < 5% |

### 7.3 失败域与降级矩阵

| 故障 | 影响 | 降级行为 | 恢复 |
| --- | --- | --- | --- |
| AI Provider 全部不可用 | 无法自动分析新来源格式 | 手工导入、正则解析器、验证、网关、订阅**全部照常** | 自动重试，熔断 5 min |
| AI 预算超限 | 同上 | `ai_task_bindings.enabled=false` 临时跳过，不影响流水线 | 次日重置或手动提额 |
| Worker 全部停止 | 不再产生新验证结果 | 网关继续用最后配置转发；API 可读可改 | 重启即续跑（租约回收） |
| 控制平面（api）停止 | 管理不可用 | **网关继续转发**；订阅端点不可用（已下发客户端的配置仍有效） | 重启 |
| GOST 崩溃 | 网关流量中断 | 容器 `restart: unless-stopped` 拉起，加载最后配置 | 自动 |
| PostgreSQL 主库不可用 | 全站只读失败 | 网关仍转发（配置已在磁盘） | 备份恢复 |
| Redis 不可用 | 缓存/限流失效、分布式锁失效 | 降级为进程内缓存 + DB 直查；验证并发改为本地信号量 | 自动重连 |
| 单个端点失效 | 该端点请求失败 | 引擎层故障切换（FAILOVER 策略）或下次调度剔除 | 验证任务重新评估 |

**设计准则**：Redis 与 AI 都是"可失去"的依赖。任何"Redis 挂了系统就崩"的实现都属于设计缺陷。

---

## 8. 扩展点（SPI）

| SPI | 接口 | 内置实现 | 替换场景 |
| --- | --- | --- | --- |
| 代理引擎 | `GatewayEngine`：`render(config) / apply(config) / stats() / health()` | `GostEngineAdapter` | 换 sing-box / Mihomo |
| 来源解析器 | `SourceParser`：`supports(snapshot) / parse(snapshot) → List<Candidate>` | `CsvParser` `JsonParser` `TextRegexParser` `MihomoYamlParser` | 新增格式 |
| AI Provider | `AiClient`：`chat(request) / testConnection()` | `OpenAiCompatibleClient` `AnthropicClient` `OllamaClient` | 新厂商 |
| 验证探针 | `Probe`：`probe(target, endpoint) → ProbeResult` | `TcpProbe` `HttpProbe` `Socks5Probe` `HttpsConnectProbe` | 新协议 |
| 订阅渲染 | `SubscriptionRenderer`：`render(pool, format) → String` | `MihomoRenderer` | 其他客户端格式 |
| 密钥后端 | `SecretStore`：`put/get/rotate` | `LocalAesGcmStore`（V1）→ `VaultStore` | 企业部署 |

所有 SPI 通过 Spring 的 `@ConditionalOnProperty` 选择实现，配置项写在 `proxyforge.engines.*` / `proxyforge.ai.*`。

---

## 9. 演进路径

| 阶段 | 形态 | 触发拆分条件 |
| --- | --- | --- |
| V1（Phase 0–1） | 1 api + 1 worker + 1 gost + pg + redis | — |
| Phase 2 | + 独立 `intelligence-worker`（Python 可选） | AI 分析耗时 > 验证任务，互相挤占 |
| Phase 3 | gost 多实例（按策略分组） | 单实例连接数 > 2,000 或需要按策略隔离 |
| Phase 4 | + Go Node Agent、多节点、读写分离 | 需要管理远程节点/跨机房 |
| Phase 5 | 多租户、拆分 `gateway` 与 `subscription` 服务 | 商业化，租户隔离要求 |

拆分原则：**先按模块边界拆进程，再按进程拆服务**。因为模块之间已经只通过 Facade + 事件通信，拆分时改的是装配方式，不是业务代码。

---

## 10. 风险与开放问题

| 编号 | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 公开代理资源合法性/合规性 | 法律与声誉风险 | 授权状态硬门槛；`PUBLIC_PROXY` 只进 `PUBLIC_EXPERIMENTAL` 池，禁止承载敏感数据；来源审查流程 |
| R2 | 动态 IP 判定误判 | 调度选错资源 | 只依据"观测到的地址变化"判定，`UNKNOWN` 是合法结论，前端不得把推断展示为事实 |
| R3 | GOST 配置热重载能力不足 | 变更需重启，短暂中断 | Phase 0 先验证重载；不支持则用双实例滚动切换 |
| R4 | 健康检查放大攻击面（对第三方发起连接） | 被判为滥用 | 出站限速、只测自有/授权资源、失败退避 |
| R5 | 单机 PostgreSQL 成为瓶颈 | 查询变慢 | 分区 + 索引治理；Phase 4 读写分离 |
| R6 | AI 输出不稳定导致解析错误 | 脏数据入池 | AI 只输出"结构假设"，最终由确定性解析器校验；候选先进隔离区 |

**待定问题（需在 Phase 1 前确认）**：

1. 是否需要"每策略独立端口"之外的按用户分流（影响网关认证层设计）。
2. 订阅是否需要签名（防篡改）还是仅靠高熵 Token。
3. `PUBLIC_PROXY` 类资源是否允许进入网关，还是仅允许订阅（合规建议：仅订阅）。
