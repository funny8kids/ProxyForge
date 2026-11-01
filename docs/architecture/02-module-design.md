# ProxyForge 模块设计

> 文档编号：ARCH-002
> 版本：v1.0 · 状态：Accepted
> 关联：[系统架构](./01-system-architecture.md) · [运行时流程](./03-runtime-flows.md) · [数据模型](../database/01-data-model.md)

---

## 1. 模块划分总览

```
                    ┌────────────┐
                    │    auth    │  用户 / 会话 / API Key / RBAC
                    └─────┬──────┘
   ┌──────────┬───────────┼───────────┬──────────────┐
   ▼          ▼           ▼           ▼              ▼
┌───────┐ ┌────────┐ ┌─────────┐ ┌────────┐  ┌──────────────┐
│resource│ │ source │ │provider │ │   ai   │  │ intelligence │
└───┬───┘ └───┬────┘ └────┬────┘ └───┬────┘  └──────┬───────┘
    │         │           │          │              │
    │         └───────────┴──────────┘              │
    ▼                                              ▼
┌────────────┐      ┌──────┐      ┌────────┐   ┌────────────┐
│verification│─────►│ pool │─────►│ policy │──►│  gateway   │
└────────────┘      └──────┘      └────────┘   └─────┬──────┘
                                                     ▼
                                              ┌──────────────┐
                                              │ subscription │
                                              └──────────────┘

  analytics（只读聚合） · audit（只订阅事件） · common（工具）
```

依赖只允许自上而下。`analytics` / `audit` 是叶子，谁都不依赖它们。

---

## 2. 模块详细设计

### 2.1 `resource`：资源资产

**聚合根**：`ProxyEndpoint`（生命周期主体）、`IpAsset`、`ProxyNode`。

三者生命周期独立，这是蓝图反复强调的一点，工程上体现为**三张表、三个聚合、三套状态机**，只在 Endpoint 上做关联引用（`ip_asset_id`、`node_id` 可空）。

```java
public interface ResourceFacade {
    EndpointView getEndpoint(UUID id);
    Page<EndpointView> query(EndpointQuery query);        // 供 analytics / pool 使用
    List<EndpointView> findEligible(EligibilityQuery q);  // 硬门槛过滤：授权 + 状态 + 协议
    void recordVerificationOutcome(EndpointVerificationOutcome outcome);
    UUID importEndpoints(ImportCommand cmd);              // 供 source 调用
}
```

**Endpoint 状态机**（`lifecycle_status`）：

```
DISCOVERED ──► PENDING_VERIFICATION ──► VERIFIED ──► HEALTHY
                     │                     │            │
                     │                     │            ├──► DEGRADED ──► UNAVAILABLE
                     └──► REJECTED         └────────────┴──► QUARANTINED
                                                              │
                                                          REVOKED（终态，授权失效）
```

转移规则（在 `ProxyEndpoint.transitionTo()` 内强制）：

| 从 | 到 | 触发 | 附加约束 |
| --- | --- | --- | --- |
| DISCOVERED | PENDING_VERIFICATION | 导入完成 | 必须有来源与协议 |
| PENDING_VERIFICATION | VERIFIED | L1–L5 通过 | 授权状态 ≠ REVOKED |
| PENDING_VERIFICATION | REJECTED | L1–L5 失败 | 记录失败层级与原因 |
| VERIFIED | HEALTHY | 连续 2 次健康检查通过 | — |
| HEALTHY | DEGRADED | 成功率 < 0.8 或 P95 > 阈值 | — |
| DEGRADED | UNAVAILABLE | 连续 3 次失败 | 从所有池中逻辑剔除（不删成员关系） |
| 任意 | QUARANTINED | 手工隔离 / 异常检测 | 立即触发策略重编译 |
| 任意 | REVOKED | 授权撤销 | 终态，不可回到其他状态 |

**信任分级（`trust_tier`）是第二套独立状态**，不在上面的生命周期里：`PRIVATE_PROXY` / `PUBLIC_PROXY` / `VERIFIED_PROXY`，默认 `PUBLIC_PROXY`（最严）。它只由两条路径写入——人工 API 与 `CandidatePromotionService` 的确定性晋升；规则引擎与 AI 均只读（详见 SEC-001 §6.2 / §6.6）。

**IP 属性识别（禁止猜测）**：`ip_type` 只有三个合法值 `STATIC / DYNAMIC / UNKNOWN`。判定只依据证据：

- 同一 endpoint 的出口 IP 在 ≥3 次观测中发生变化 → `DYNAMIC`，并写入 `endpoint_ip_observations`。
- 观测窗口内未变化且来源声明为静态 → `STATIC`，`confidence` 记录为 `DECLARED`。
- 其余一律 `UNKNOWN`，`confidence=UNKNOWN`。

`network_type` 同理：来源声明优先，ASN 推断只能标记 `inferred=true`，前端必须显示"推断"标签。

### 2.2 `source`：来源与导入

**职责**：来源目录 CRUD、快照抓取、解析、候选提取、去重、晋级。

```java
public interface SourceFacade {
    UUID createSource(SourceCommand cmd);
    ImportJobView startImport(UUID sourceId, ImportMode mode);      // 异步
    ImportJobView importRaw(ImportMode mode, InputStream in);       // 手工上传
    Page<CandidateView> listCandidates(CandidateQuery q);
    UUID promoteCandidate(UUID candidateId, PromoteCommand cmd);    // 唯一晋级入口
    void rejectCandidate(UUID candidateId, String reason);
}
```

**解析器注册表**：

```java
public interface SourceParser {
    boolean supports(SnapshotView snapshot);            // 依据 content-type + 首行特征
    ParseResult parse(SnapshotView snapshot);           // 返回候选 + 解析告警
    String name();
}
```

V1 内置：`CsvParser`、`JsonParser`（支持数组/嵌套 `proxies`）、`TextRegexParser`（`ip:port`、`scheme://user:pass@host:port`）、`MihomoYamlParser`。

**去重键（`dedupe_key`）**：`sha256(protocol|host|port|credential_fingerprint)`。不把明文密码放进哈希输入，用 `credential_fingerprint = sha256(username)` 或凭据引用 ID。

**晋级是唯一入口**：候选 → 端点必须经过 `CandidatePromotionService`，内部强制：

1. 来源授权审查（`authorization_status ∈ {AUTHORIZED, RESTRICTED}`，`UNKNOWN` 需人工确认）。
2. 去重（命中已存在端点则只更新 `last_seen_at` 与来源关联）。
3. 创建 `DISCOVERED` 状态的端点并排入验证队列。

### 2.3 `verification`：验证与评分

**职责**：分层探测、结果落库、健康状态推进、质量评分。

```java
public interface VerificationFacade {
    UUID enqueue(VerificationRequest req);              // 单条/批量/全量
    VerificationJobView getJob(UUID jobId);
    EndpointHealthView currentHealth(UUID endpointId);
    Page<HealthCheckView> history(UUID endpointId, TimeRange range);
    void recomputeScores(ScoreBatch batch);             // 定时批处理
}
```

**七层验证**（L7 在 V1 只做"连续 N 次采样"，不做 24h 长跑）：

| 层 | 探针 | 超时 | 失败归类 |
| --- | --- | --- | --- |
| L1 DNS | `DnsProbe` | 2s | `DNS_FAILURE` |
| L2 TCP | `TcpProbe` | 3s | `TCP_REFUSED / TCP_TIMEOUT` |
| L3 协议握手 | `HttpProbe` / `Socks5Probe` | 5s | `PROTOCOL_ERROR` |
| L4 认证 | 同上（带凭据） | 5s | `AUTH_FAILED` |
| L5 出口验证 | `HttpProbe` → `https://api.ipify.org?format=json` 等可配目标 | 10s | `EXIT_MISMATCH` |
| L6 质量 | 3 次采样 | 10s×3 | `UNSTABLE` |
| L7 稳定性 | 连续 N 次（默认 5） | — | `FLAKY` |

**评分公式落地**：

```
Q = 0.30·S + 0.25·L + 0.20·R + 0.15·A + 0.10·F      （各分量归一到 0–100）

S 连接成功率   = 近 24h 成功次数 / 总次数
L 延迟表现     = clamp(100 - (p50_ms - 50) / 9.5, 0, 100)     // 50ms→100 分，1000ms→0 分
R 稳定性       = 100 - jitter_penalty - failure_streak_penalty
A 授权与来源   = AUTHORIZED 100 / RESTRICTED 60 / UNKNOWN 20 / REVOKED 0
F 新鲜度       = clamp(100 - hours_since_last_success × 2, 0, 100)
```

**硬门槛**（在 SQL 与代码双重实现，防止绕过）：

```sql
-- 只有满足条件的端点才允许进入策略编译
authorization_status IN ('AUTHORIZED','RESTRICTED')
AND lifecycle_status IN ('HEALTHY','DEGRADED')
AND quality_score >= :poolMinScore
```

`REVOKED` 与 `QUARANTINED` 的端点在编译阶段被直接排除，无论分数多高。

### 2.4 `pool`：资源池

**职责**：池定义、自动规则、成员维护、版本快照。

```java
public interface PoolFacade {
    PoolSnapshot snapshot(UUID poolId);              // 编译/订阅共用的只读快照
    List<PoolSnapshot> snapshotAll();
    void applyRules(UUID poolId);                    // 定时或事件触发
    void addManualMember(UUID poolId, UUID endpointId, String operator);
    void removeMember(UUID poolId, UUID endpointId, String reason);
}
```

**成员来源二元性**：`source ∈ {AUTO, MANUAL}`。

- `AUTO` 成员由规则引擎维护，规则变化时整体重算（先算后 diff，避免抖动）。
- `MANUAL` 成员永不被规则删除，但**会被硬门槛失效**（授权撤销/隔离时置 `suppressed=true`，保留记录以便恢复）。

**池快照（`PoolSnapshot`）**是重要抽象：`gateway` 编译与 `subscription` 渲染都消费它，保证两条消费路径看到**完全一致**的资源集合。快照含 `poolId + version + members[] + generatedAt`。

### 2.5 `policy`：策略与调度

**职责**：策略定义、硬约束、会话粘性、故障链。

```java
public interface PolicyFacade {
    CompiledPolicyView compile(UUID policyId);        // 返回给 gateway 的 IR
    List<CompiledPolicyView> compileAll();
    SessionResolution resolve(String policyKey, SessionContext ctx);   // 供网关认证层
}
```

**调度决策顺序（每次编译时执行，而非每次请求）**：

```
1. 候选集合 = 策略绑定池的快照成员
2. 硬约束过滤：授权有效 / 健康 / 协议匹配 / 目标网络允许 / 供应商额度未超
3. 排序：
   DIRECT      → 空集合（直连）
   FIXED       → 指定 endpoint
   FASTEST     → 按 p50 升序，取前 N
   WEIGHTED    → 按 weight 归一化
   STICKY      → 按 p50 排序 + hash 选择器
   FAILOVER    → 按 priority 分组，组内按 p50
   REGION      → 先按 country/region 过滤，再按 p50
4. 输出 CompiledPolicy：listener + members(ordered) + strategy + healthCheck
```

**为什么不在请求期调度**：见 [ARCH-001 §6.3](./01-system-architecture.md#63-策略编译policy-compilation本项目最关键的架构设计)。请求期只做引擎内的选择（轮询/哈希/优先级），业务语义在编译期已固化。

**`routing_sessions`** 只在需要"显式会话绑定"时使用（例如某任务必须固定出口到完成）。普通 STICKY 由引擎哈希实现，不落库，避免每次请求写库。

### 2.6 `gateway`：网关编排

**职责**：实例注册、配置编译与下发、引擎健康、流量采集。

```java
public interface GatewayEngine {                       // SPI
    EngineConfig render(CompiledGateway model);        // 业务 IR → 引擎配置
    ApplyResult apply(EngineConfig config);            // 热重载或重启
    EngineStats stats();
    EngineHealth health();
}
```

**配置生命周期**：

```
DRAFT → COMPILED → APPLIED → (SUPERSEDED | FAILED | ROLLED_BACK)
```

每次编译产生一条 `gateway_configs` 记录（含 `config_hash`、`rendered_yaml`、`applied_at`）。**只有 `APPLIED` 的配置是生效配置**，编译失败绝不下发（保留上一版）。

**流量采集**：每 30s 轮询引擎 `stats()`，写入 `gateway_traffic_samples`（按小时分区）。失败只记日志，不阻塞。

### 2.7 `subscription`：订阅

```java
public interface SubscriptionFacade {
    SubscriptionView create(CreateSubscriptionCommand cmd);   // 返回明文 token（仅一次）
    String renderByToken(String rawToken);                    // 无认证，Token 即凭证
    void revoke(UUID subscriptionId);
    List<VersionView> versions(UUID subscriptionId);
}
```

**Token 策略**：`base64url(32 random bytes)`，仅存 `sha256(token)`，创建时返回明文一次。渲染时按哈希查找，命中后校验过期与撤销状态。

**内容签名（可选层）**：`signingEnabled=true` 时，渲染器先产出规范化模型 `CanonicalSubscription`，按 RFC 8785 JCS 序列化后计算 `canonicalHash`，用 `signing_keys` 中唯一 `ACTIVE` 的 Ed25519 私钥签名；签名与 `keyId`/`signatureVersion`/`revision` 一并写入 `subscription_versions`，并通过响应头下发。**签的是规范化 JSON，不是 YAML 字节流**（见 SEC-001 §6.4.2、ADR-0009）。签名失败时**不返回未签名内容**（fail-closed），返回 503。

**版本化**：每次渲染（或池快照变更）生成 `subscription_versions`，保留最近 20 版，支持"回滚到上一版"（客户端拿到旧配置时排障用）。

### 2.8 `ai`：Provider Registry 与任务路由

```java
public interface AiRouter {
    AiResponse execute(AiTaskType task, AiRequest request);   // 按绑定选 provider/model
    ProviderTestResult testProvider(UUID providerId);
    boolean isAvailable(AiTaskType task);                     // 供调用方降级判断
}
```

**路由算法**：`ai_task_bindings` 按 `task_type` 给出有序 `provider_id + model + priority` 列表；执行时按 priority 依次尝试，失败（超时/5xx/额度）切换下一个；全部失败抛 `AiUnavailableException`，调用方必须捕获并降级（**编译期用 ArchUnit 检查：`intelligence` 之外不得直接依赖 `AiRouter`**）。

**降级契约**（写入接口注释并由测试保证）：

> 任何 AI 调用失败都不得导致：导入失败、验证失败、池成员变更失败、网关配置下发失败、订阅渲染失败。

### 2.9 `auth` / `audit` / `analytics`

- `auth`：`proxy_users`（Argon2id）+ `api_keys`（前缀 + 哈希 + scopes + 过期）；会话用**无状态 JWT**（15 min）+ refresh token（存 Redis，缺失时降级为重新登录）。RBAC 三角色：`ADMIN` / `OPERATOR` / `VIEWER`。
- `audit`：订阅所有 `*Changed` / `*Revoked` 事件，写 `audit_events`（append-only，DB 权限禁止 UPDATE/DELETE）。同时记录 `actor`、`ip`、`before/after` 摘要。
- `analytics`：只读，基于物化视图（`mv_endpoint_daily`、`mv_pool_health`），刷新周期 5 min。禁止在 analytics 里写业务表。

---

## 3. 事务与一致性

| 场景 | 一致性要求 | 实现 |
| --- | --- | --- |
| 导入 1000 条端点 | 最终一致 | 单事务批量插入 + 去重冲突 `ON CONFLICT DO UPDATE` |
| 验证结果 → 端点状态 | 强一致（同库） | 同一事务：写 `health_checks` + 更新 `endpoint_health_state` + 更新 `proxy_endpoints.lifecycle_status` |
| 验证结果 → 池成员 | 最终一致 | 事件 `EndpointHealthChanged` → `pool` 消费（秒级延迟可接受） |
| 池变更 → 网关配置 | 最终一致（≤ 3s） | 事件 `PoolMembershipChanged` → 触发编译（带去抖 2s） |
| 策略变更 → 网关配置 | 强一致（用户点击后同步编译） | API 内同步调用 `GatewayFacade.apply()`，失败回滚策略变更 |
| 订阅渲染 | 快照隔离 | 读取 `PoolSnapshot`（version），不读实时表 |

**去抖**：编译触发使用 Redis `SET NX PX 2000` 的单飞锁，避免批量验证引发编译风暴。

---

## 4. 幂等与并发

| 操作 | 幂等手段 |
| --- | --- |
| 导入 | `dedupe_key` 唯一索引 + `ON CONFLICT` |
| 验证任务创建 | `Idempotency-Key` 请求头 + `idempotency_keys` 表（24h） |
| 策略编译下发 | `config_hash` 比对，相同则跳过 |
| 订阅创建 | `Idempotency-Key` |
| Outbox 消费 | `event_consumers(event_id, consumer)` 唯一约束 |
| 任务抢占 | `FOR UPDATE SKIP LOCKED` + 租约 |
| 端点状态推进 | 乐观锁 `version` 列，冲突重试 3 次 |

---

## 5. 领域事件契约

事件信封（`event_outbox` 行）：

```json
{
  "event_id": "uuid",
  "event_type": "EndpointVerified",
  "aggregate_type": "ProxyEndpoint",
  "aggregate_id": "uuid",
  "occurred_at": "2026-11-01T10:00:00Z",
  "schema_version": 1,
  "payload": { }
}
```

| 事件 | 生产者 | 消费者 | payload 关键字段 |
| --- | --- | --- | --- |
| `EndpointDiscovered` | source | verification | endpointId, protocol, authorizationStatus |
| `EndpointVerified` | verification | resource, pool, audit | endpointId, success, latencyMs, exitIp, qualityScore |
| `EndpointHealthChanged` | verification | resource, pool, gateway | endpointId, from, to |
| `EndpointQuarantined` | resource | pool, gateway, audit | endpointId, reason |
| `PoolMembershipChanged` | pool | gateway, subscription | poolId, added[], removed[], version |
| `RoutingPolicyChanged` | policy | gateway, audit | policyId, version |
| `GatewayConfigApplied` | gateway | audit, analytics | instanceId, configVersion, configHash, result |
| `SubscriptionIssued` | subscription | audit | subscriptionId, poolId |
| `ImportCompleted` | source | audit, analytics | jobId, imported, skipped, failed |
| `CandidatePromoted` | source | verification, audit | candidateId, endpointId |
| `AiUsageRecorded` | ai | analytics | providerId, taskType, tokens, costUsd |
| `SecretRotated` | common | audit | secretRef, rotatedAt |

**演进规则**：只加字段不删字段；`schema_version` 递增；消费者必须容忍未知字段。

---

## 6. 配置与开关

```yaml
proxyforge:
  gateway:
    engine: gost                     # gost | sing-box | mihomo
    bind: 127.0.0.1                  # 非回环需同时开启 auth + acl
    http-port: 8080
    socks-port: 1080
    reload-strategy: hot             # hot | restart
  verification:
    concurrency: 50
    timeouts: {dns: 2s, tcp: 3s, handshake: 5s, exit: 10s}
    schedule: {healthy: 15m, degraded: 3m, quarantined: 6h}
  ai:
    enabled: true
    degrade-on-budget-exceeded: true
    default-timeout: 30s
  security:
    require-loopback-bind: true
    ssrf-guard: true
```

所有开关支持环境变量覆盖（`PROXYFORGE_GATEWAY_ENGINE`），便于 compose 部署。
