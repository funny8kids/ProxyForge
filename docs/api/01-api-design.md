# ProxyForge API 设计规范

> 文档编号：API-001
> 版本：v1.0 · 状态：Accepted
> Base URL：`http://127.0.0.1:8081/api/v1`（默认仅本机监听）
> 关联：[模块设计](../architecture/02-module-design.md) · [数据模型](../database/01-data-model.md) · [安全设计](../security/01-security-design.md)

---

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| 协议 | HTTP/1.1 + JSON（`Content-Type: application/json; charset=utf-8`） |
| 版本 | 路径版本 `/api/v1`；破坏性变更升 `/api/v2`，v1 至少保留 6 个月 |
| 时间 | ISO-8601 UTC，`2026-11-01T10:00:00Z`；不接受本地时间 |
| ID | UUID 字符串；对外暴露的 `key` 用于稳定引用（如 `STATIC_STABLE`） |
| 字段命名 | `camelCase`（JSON），数据库 `snake_case`，由 DTO 层转换 |
| 空值 | 明确返回 `null`，不省略字段（客户端可依赖字段存在性） |
| 布尔 | `true` / `false`，不用 0/1 |
| 幂等 | 写操作支持 `Idempotency-Key`（UUID），24h 内相同 key 返回首次结果 |
| 并发 | 更新带 `If-Match: <version>`，冲突返回 `409 VERSION_CONFLICT` |
| 追踪 | 响应头 `X-Request-Id`；客户端可传 `X-Request-Id` 透传 |

### 1.1 分页

统一使用游标分页（大表稳定，避免深翻页）：

```
GET /resources?limit=50&cursor=eyJpZCI6Ii4uLiJ9
```

```json
{
  "items": [],
  "nextCursor": "eyJpZCI6Ii4uLiJ9",
  "hasMore": true,
  "total": 10240
}
```

- `limit` 默认 50，最大 200。
- `total` 是估算值（`pg_class.reltuples` 或缓存），仅用于展示"共约 N 条"，不作为一致性依据。
- 排序默认 `createdAt desc`；可用 `sort=qualityScore:desc`，白名单字段。

### 1.2 过滤

查询参数扁平化，多值用逗号分隔：

```
GET /resources?status=HEALTHY,DEGRADED&protocol=SOCKS5&originType=OWNED&minQuality=70
```

- 枚举值必须大写；非法值返回 `400 INVALID_ARGUMENT` 并指出字段。
- 全文搜索用 `q`（仅支持 host / displayName / tags 前缀匹配，不做模糊全文）。

---

## 2. 认证与授权

### 2.1 三种凭据

| 凭据 | 使用方 | 传递方式 | 作用域 |
| --- | --- | --- | --- |
| 会话 JWT | 管理控制台 | `Authorization: Bearer <jwt>` | 15 min 有效，配 refresh token |
| API Key | 脚本 / CI | `Authorization: Bearer pf_<prefix>_<secret>` | 长期，带 scopes |
| 订阅 Token | Mihomo / FlClash | 路径参数 `/subscriptions/{token}` | 单订阅，只读 |

网关消费**不走 REST**：应用直接用 `http://127.0.0.1:8080`（见 §7）。

### 2.2 RBAC 与 Scope

| 角色 | 权限 |
| --- | --- |
| `ADMIN` | 全部，含用户、密钥、AI Provider、网关配置回滚 |
| `OPERATOR` | 资源/来源/池/策略/订阅的读写，验证任务，不能改用户与密钥 |
| `VIEWER` | 只读 |

API Key 的 scopes 是角色的子集，粒度到资源：

```
resource:read  resource:write  source:read  source:write
verification:run  pool:read  pool:write  policy:read  policy:write
gateway:read  gateway:apply  subscription:read  subscription:write
trust:read  trust:write  trust:review  signing:manage
ai:read  ai:write  audit:read
```

校验顺序：`认证 → 角色 → scope → 资源归属`。**任何一步失败都返回 401/403，且不泄露资源是否存在。**

### 2.3 限流

| 类别 | 限制 |
| --- | --- |
| 管理 API | 60 req/min/user，突发 20 |
| 导入 | 5 次/min，单次 ≤ 10 MB |
| 验证任务创建 | 10 次/min |
| 订阅渲染 | 120 req/min/token |

超限返回 `429` + `Retry-After`。Redis 不可用时降级为进程内计数（宁可放宽也不阻断）。

---

## 3. 错误模型

采用 RFC 9457 Problem Details：

```json
{
  "type": "https://proxyforge.dev/errors/version-conflict",
  "title": "Version conflict",
  "status": 409,
  "detail": "Endpoint was modified by another request",
  "instance": "/api/v1/resources/8f1c...",
  "code": "VERSION_CONFLICT",
  "requestId": "01JB...",
  "errors": [
    { "field": "expectedVersion", "message": "expected 12, actual 13" }
  ]
}
```

### 3.1 错误码表

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `INVALID_ARGUMENT` | 参数非法、枚举越界 |
| 400 | `PARSE_FAILED` | 导入内容无法解析 |
| 401 | `UNAUTHENTICATED` | 无/过期凭据 |
| 403 | `FORBIDDEN` | 角色或 scope 不足 |
| 403 | `AUTHORIZATION_REQUIRED` | 资源授权状态为 `UNKNOWN`，需人工确认 |
| 403 | `TIER_UPGRADE_FORBIDDEN` | 尝试把 `PUBLIC_PROXY` 提升为可调度分级 |
| 403 | `SELF_REVIEW_FORBIDDEN` | 批准自己提交的晋升建议 |
| 422 | `PUBLIC_PROXY_GATEWAY_FORBIDDEN` | 给公开代理授予网关权限（DB 同样会拒绝） |
| 400 | `SIGNATURE_VERSION_UNSUPPORTED` | 请求了客户端不支持的签名版本 |
| 503 | `SIGNING_KEY_UNAVAILABLE` | 签名已启用但无可用 `ACTIVE` 密钥 |
| 404 | `NOT_FOUND` | 资源不存在或订阅已撤销（两者不区分，防枚举） |
| 409 | `VERSION_CONFLICT` | 乐观锁冲突 |
| 409 | `DUPLICATE_KEY` | 唯一键冲突（`key`/`listenPort`/`dedupeKey`） |
| 422 | `POLICY_UNSATISFIABLE` | 策略编译后无可用成员（警告级，允许保存但返回 422 提示） |
| 429 | `RATE_LIMITED` | 限流 |
| 500 | `INTERNAL` | 未预期异常（日志有 stack，响应无） |
| 503 | `AI_UNAVAILABLE` | AI 全部不可用且该操作必需 AI |
| 503 | `ENGINE_UNAVAILABLE` | 代理引擎不可达（配置下发失败） |

**原则**：错误响应绝不包含 SQL、堆栈、内部路径、凭据片段。

---

## 4. 端点清单

### 4.1 资源（Resources）

| 方法 | 路径 | 说明 | Scope |
| --- | --- | --- | --- |
| GET | `/resources` | 列表（过滤/分页） | `resource:read` |
| GET | `/resources/{id}` | 详情（含健康态、所属池） | `resource:read` |
| POST | `/resources/import` | 批量导入（multipart 或 JSON body） | `resource:write` |
| PATCH | `/resources/{id}` | 更新属性（授权状态、标签、节点绑定） | `resource:write` |
| POST | `/resources/{id}/quarantine` | 隔离 | `resource:write` |
| POST | `/resources/{id}/verify` | 立即验证 | `verification:run` |
| DELETE | `/resources/{id}` | 软删除 | `resource:write` |

```http
POST /api/v1/resources/import
Content-Type: multipart/form-data

file=@nodes.yaml
originType=OWNED
authorizationStatus=AUTHORIZED
nodeId=8f1c...
```

```json
201 Created
{
  "jobId": "0b6f...",
  "status": "PENDING",
  "total": 42
}
```

导入是**异步**的：返回 `jobId`，客户端轮询 `GET /imports/{jobId}` 或订阅 `ImportCompleted` 事件（Webhook 见 §6.4）。

### 4.2 来源与情报（Sources / Intelligence）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sources` | 来源列表 |
| POST | `/sources` | 创建来源 |
| PATCH | `/sources/{id}` | 更新（含启用/停用） |
| POST | `/sources/{id}/sync` | 立即同步（异步） |
| GET | `/sources/{id}/snapshots` | 快照历史 |
| GET | `/candidates` | 候选列表（`reviewStatus=PENDING`） |
| POST | `/candidates/{id}/promote` | 晋级为端点（唯一入口） |
| POST | `/candidates/{id}/reject` | 拒绝 |
| POST | `/intelligence/discover` | 启动发现任务 |
| GET | `/intelligence/tasks` | 任务列表 |

```http
POST /api/v1/candidates/{id}/promote
If-Match: 3

{ "authorizationStatus": "AUTHORIZED", "nodeId": null, "tags": ["imported"] }
```

```json
200 OK
{ "endpointId": "c8a1...", "deduplicated": false, "verificationJobId": "7d2e..." }
```

晋级时若命中 `dedupeKey`，返回 `deduplicated: true` 且 `endpointId` 指向既有端点（**幂等**，重复调用不报错）。

### 4.3 验证（Verification）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/verification/jobs` | 创建任务（`scope`: ENDPOINT / ENDPOINTS / POOL / ALL_PENDING / ALL） |
| GET | `/verification/jobs/{id}` | 任务进度 |
| GET | `/verification/jobs` | 任务列表 |
| GET | `/resources/{id}/health` | 最新健康态 |
| GET | `/resources/{id}/health/history?from=&to=` | 历史（分页，最多 30 天） |
| GET | `/verification/ranking?poolId=&limit=50` | 质量排行 |

```json
POST /api/v1/verification/jobs
{
  "scope": "POOL",
  "poolId": "3f9a...",
  "priority": 100
}
```

```json
202 Accepted
{ "id": "5c7b...", "status": "PENDING", "total": 128 }
```

### 4.4 资源池（Pools）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/pools` | 列表（含 `memberCount`、健康分布） |
| POST | `/pools` | 创建 |
| GET | `/pools/{id}` | 详情 + 规则 |
| PATCH | `/pools/{id}` | 更新（`minQuality`、`maxMembers`） |
| POST | `/pools/{id}/rules` | 新增自动规则 |
| POST | `/pools/{id}/members` | 手工加成员 |
| DELETE | `/pools/{id}/members/{endpointId}` | 移除手工成员 |
| POST | `/pools/{id}/recompute` | 立即重算（调试用） |
| GET | `/pools/{id}/members` | 成员列表（含 `source`、`suppressed`） |

```json
POST /api/v1/pools
{
  "key": "STATIC_STABLE",
  "name": "Static Stable",
  "purpose": "固定出口、长期会话",
  "minQuality": 70,
  "maxMembers": 200,
  "rules": [
    { "name": "static-only", "predicate": { "all": [
        { "field": "ipType", "op": "eq", "value": "STATIC" },
        { "field": "authorizationStatus", "op": "in", "value": ["AUTHORIZED"] }
    ]}}
  ]
}
```

`predicate` 是受限 DSL：`field` 必须在白名单内（`ipType` / `networkType` / `protocol` / `originType` / `authorizationStatus` / `countryCode` / `asn` / `qualityScore` / `tags`），`op` ∈ `eq|neq|in|gte|lte|contains`。服务端编译为参数化 SQL，**不接受原始 SQL 片段**。

### 4.5 策略与网关（Policies / Gateway）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/policies` | 列表 |
| POST | `/policies` | 创建（同步编译并下发） |
| PATCH | `/policies/{id}` | 更新（同步编译并下发） |
| DELETE | `/policies/{id}` | 删除（从配置中移除监听器） |
| GET | `/gateway/instances` | 实例状态 |
| GET | `/gateway/configs?instanceId=` | 配置版本历史 |
| GET | `/gateway/configs/{version}` | 渲染后配置（脱敏凭据） |
| POST | `/gateway/configs/{version}/rollback` | 回滚 |
| POST | `/gateway/reload` | 强制重新编译下发 |
| GET | `/gateway/traffic?from=&to=&policyKey=` | 流量时序 |

```json
POST /api/v1/policies
{
  "key": "default",
  "name": "Default Egress",
  "strategy": "FAILOVER",
  "poolId": "3f9a...",
  "listenPort": 8080,
  "maxMembers": 10
}
```

```json
201 Created
{
  "id": "9a1f...",
  "configVersion": 42,
  "applied": true,
  "warnings": [
    { "code": "POOL_TOO_SMALL", "message": "Only 1 member; failover has no backup" }
  ]
}
```

**语义**：`applied=false` + HTTP 200 表示策略已保存但配置下发失败（旧配置仍在生效）。这是有意的设计——用户不应因为引擎临时不可用而丢失配置。客户端需展示 `warnings`。

### 4.6 订阅（Subscriptions）

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/subscriptions` | JWT | 列表（不含明文 token） |
| POST | `/subscriptions` | JWT | 创建，**仅此一次返回明文 token** |
| DELETE | `/subscriptions/{id}` | JWT | 撤销（立即生效） |
| GET | `/subscriptions/{id}/versions` | JWT | 版本历史 |
| **GET** | **`/subscriptions/{token}`** | **无** | **客户端拉取 YAML** |

```json
POST /api/v1/subscriptions
{ "name": "flclash-laptop", "poolId": "3f9a...", "format": "mihomo", "ttlDays": 90 }
```

```json
201 Created
{
  "id": "b2c3...",
  "url": "http://127.0.0.1:8081/api/v1/subscriptions/pf_sub_9xK...",
  "token": "pf_sub_9xK...",
  "expiresAt": "2027-01-30T00:00:00Z",
  "warning": "Token 仅显示一次，请立即保存"
}
```

#### 订阅渲染端点规范

```http
GET /api/v1/subscriptions/{token}
Accept: text/yaml

HTTP/1.1 200 OK
Content-Type: text/yaml; charset=utf-8
ETag: "pool-3f9a-v128"
Cache-Control: private, max-age=300

proxies:
  - name: pf-01
    type: socks5
    server: 203.0.113.10
    port: 1080
    username: u
    password: p
proxy-groups:
  - name: STATIC_STABLE
    type: url-test
    proxies: [pf-01]
rules:
  - MATCH,STATIC_STABLE
```

| 场景 | 响应 |
| --- | --- |
| Token 不存在 / 已撤销 / 过期 | `404`（三者统一，防枚举） |
| `If-None-Match` 命中 | `304`，无 body |
| 池为空 | `200` + 空 proxies + 注释 `# pool is empty`（客户端不报错） |
| 凭据解密失败 | `500` + 审计事件（不返回部分配置） |

**安全**：该端点不做 IP 限制（客户端可能在任意网络），仅靠 32 字节高熵 token；响应 `Cache-Control: private`，禁止 CDN 缓存；访问写 `subscriptions.access_count` 与审计（不记录 token 明文）。

#### 订阅签名（可选增强层，Ed25519）

签名默认关闭；`signingEnabled=true` 时在同一端点附带签名响应头，**不破坏不支持验签的客户端**（它们忽略未知头）。

```http
GET /api/v1/subscriptions/{token}
Accept: text/yaml

HTTP/1.1 200 OK
Content-Type: text/yaml; charset=utf-8
X-PF-Signature-Alg: Ed25519
X-PF-Key-Id: pf-sub-2026-11
X-PF-Signature-Version: 1
X-PF-Revision: 128
X-PF-Issued-At: 2026-11-01T10:00:00Z
X-PF-Expires-At: 2026-11-08T10:00:00Z
X-PF-Canonical-Hash: sha256:9f2c...
X-PF-Signature: <base64url 64 bytes>
```

| 变体 | 说明 |
| --- | --- |
| `?format=json` | 返回完整信封 `{ payload, signature }`，可离线验签 |
| `GET /subscriptions/{token}/signature` | 仅签名块（detached） |
| `GET /subscriptions/{token}/pubkey` | 当前签名公钥（PEM，便于脚本自举） |

**签名对象是规范化 JSON（RFC 8785 JCS），不是 YAML 字节流**——YAML 序列化不唯一，签字节流必然在不同客户端上验签失败。详见 SEC-001 §6.4.2。

**客户端必须校验**：`signatureVersion` 已知（未知则拒绝，不降级）→ `canonicalHash` 一致 → Ed25519 验签 → `revision > 本地缓存` → `now < expiresAt`。

#### 签名密钥管理（ADMIN）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/signing-keys` | 密钥列表（公钥可见，私钥永不返回） |
| POST | `/signing-keys` | 生成新密钥对（返回 `keyId` + 公钥，私钥写入 `secrets`） |
| POST | `/signing-keys/{keyId}/activate` | 激活（同一时刻仅一个 ACTIVE） |
| POST | `/signing-keys/{keyId}/retire` | 退役（只验不签） |
| POST | `/signing-keys/{keyId}/compromise` | 标记失陷，触发全量重签 + 告警 |
| GET | `/.well-known/proxyforge-signing-keys.json` | 公钥分发（无认证，可缓存 1h） |

### 4.7 AI 配置（AI）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ai/providers` | 列表（`apiKey` 永远脱敏为 `sk-****abcd`） |
| POST | `/ai/providers` | 创建（`apiKey` 明文只在请求中出现一次，服务端加密后丢弃） |
| PATCH | `/ai/providers/{id}` | 更新 |
| POST | `/ai/providers/{id}/test` | 连接测试（返回延迟 + 模型列表） |
| GET | `/ai/models?providerId=` | 模型列表 |
| GET | `/ai/task-bindings` | 任务路由配置 |
| PUT | `/ai/task-bindings/{taskType}` | 整体替换降级链 |
| GET | `/ai/usage?from=&to=&groupBy=provider` | 用量与成本 |

```json
POST /api/v1/ai/providers
{
  "key": "deepseek-main",
  "name": "DeepSeek",
  "type": "OPENAI_COMPATIBLE",
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "sk-...",
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "enabled": true
}
```

`baseUrl` 会经过 SSRF 校验：拒绝内网段、链路本地、云元数据地址；`localhost` 仅在 `allowPrivateNetwork=true`（本地 Ollama 场景）时允许，且该开关需要 `ADMIN`。

### 4.8 分析与审计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/analytics/overview` | 首页四问（见下） |
| GET | `/analytics/quality-trend?days=30` | 质量趋势 |
| GET | `/analytics/distribution?by=country\|protocol\|originType` | 分布 |
| GET | `/analytics/usage` | 网关流量与请求统计 |
| GET | `/audit/events?from=&to=&actorId=&action=` | 审计查询 |

`/analytics/overview` 响应结构对应蓝图"首页四问"：

```json
{
  "totals": { "endpoints": 1284, "healthy": 973, "healthRate": 0.758, "activeGateways": 1 },
  "degrading": [ { "id": "...", "host": "...", "reason": "success_rate_drop", "since": "..." } ],
  "poolsReady": [ { "key": "STATIC_STABLE", "members": 42, "healthy": 40, "ready": true } ],
  "recentDiscoveries": [ { "sourceKey": "github-x", "candidates": 12, "at": "..." } ],
  "aiStatus": { "available": true, "providers": [ { "key": "deepseek-main", "healthy": true } ] }
}
```

### 4.9 信任分级与晋升（Trust）

分级是**权限决定**，不是元数据。因此它有独立的 API 面、独立 scope、独立审计。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | `/trust/summary` | `trust:read` | 各分级数量、待审建议、公开代理健康度 |
| GET | `/resources/{id}/tier` | `trust:read` | 当前分级 + 变更历史 |
| PATCH | `/resources/{id}/tier` | `trust:write` | 人工改分级（≥ `OPERATOR`） |
| POST | `/resources/{id}/gateway-grant` | `trust:write` | 授予/收回网关权限（仅 `PRIVATE_PROXY`） |
| GET | `/trust/promotions?status=PENDING` | `trust:read` | 晋升建议列表（AI / 规则 / 人工来源） |
| POST | `/trust/promotions/{id}/approve` | `trust:review` | 人工批准 |
| POST | `/trust/promotions/{id}/reject` | `trust:review` | 拒绝并记录原因 |

```json
PATCH /api/v1/resources/{id}/tier
If-Match: 7

{
  "trustTier": "VERIFIED_PROXY",
  "reason": "owned VPS, L1-L6 passed, authorization doc #A-2291",
  "evidenceRef": "https://internal.docs/authorization/A-2291"
}
```

```json
200 OK
{
  "endpointId": "c8a1...",
  "trustTier": "VERIFIED_PROXY",
  "previousTier": "PRIVATE_PROXY",
  "configVersion": 43,
  "applied": true
}
```

**拒绝规则（硬编码，不可配置）**：

| 尝试 | 结果 |
| --- | --- |
| 把 `PUBLIC_PROXY` 改为 `VERIFIED_PROXY` / `PRIVATE_PROXY` | `403 TIER_UPGRADE_FORBIDDEN`（除非 `ADMIN` 且提供 `evidenceRef`，走"来源方书面授权"例外流程） |
| 给 `PUBLIC_PROXY` 设置 `explicitGatewayGrant=true` | `422 PUBLIC_PROXY_GATEWAY_FORBIDDEN`（DB 层同样会拒绝） |
| 由 `SYSTEM` / AI 身份调用 | `403 FORBIDDEN` |
| 批准自己提交的建议 | `403 SELF_REVIEW_FORBIDDEN` |

```json
POST /api/v1/trust/promotions/{id}/approve
{ "trustTier": "VERIFIED_PROXY", "note": "已核对授权文件" }
```

批准后立即触发策略重编译，响应返回 `configVersion`；`applied=false` 表示配置已生成但引擎未应用（旧配置仍在生效）。

---

## 5. 关键交互时序约定

| 场景 | 约定 |
| --- | --- |
| 长任务（导入/验证/发现） | 一律 `202` + 任务资源；不提供同步阻塞接口 |
| 策略/池变更 | 同步编译，返回 `configVersion` + `warnings`；下发失败不阻塞保存 |
| 批量操作 | 单次 ≤ 500 个 ID；超限 `400 BATCH_TOO_LARGE` |
| 删除 | 一律软删除；物理删除仅通过维护任务 |
| 枚举扩展 | 客户端必须容忍未知枚举值（渲染为 `UNKNOWN(值)`，不崩溃） |

---

## 6. 兼容性与演进

1. **只增不改**：新增字段默认值明确；不重命名已有字段（新增别名并行，旧字段标记 deprecated 至少 2 个版本）。
2. **枚举只增**：客户端按字符串处理，未知值降级展示。
3. **删除流程**：`deprecated` 标注 → 文档公告 → 观察 1 个版本 → 移除。
4. **OpenAPI**：`docs/api/openapi.yaml` 由代码注解生成（springdoc），CI 校验与实现一致；`openapi-diff` 检测破坏性变更并阻断合并。

### 6.4 Webhook（Phase 2 预留）

```
POST {userWebhookUrl}
X-ProxyForge-Signature: sha256=<hmac>

{ "eventType": "ImportCompleted", "occurredAt": "...", "payload": { } }
```

签名密钥存 `secrets`，重试 3 次指数退避，`5xx` 才重试。

---

## 7. 网关消费接口（非 REST）

数据面不是 HTTP API，而是**协议入口**：

| 入口 | 地址 | 认证 | 说明 |
| --- | --- | --- | --- |
| HTTP Proxy | `http://127.0.0.1:8080` | 可选 Basic / IP ACL | 默认策略（`listenPort=8080`） |
| HTTP Proxy（命名策略） | `http://127.0.0.1:8090+` | 同上 | 一个策略一个端口 |
| SOCKS5 | `socks5://127.0.0.1:1080` | 可选用户名密码 | — |

```python
import requests

proxies = {"http": "http://127.0.0.1:8080", "https": "http://127.0.0.1:8080"}
print(requests.get("https://api.ipify.org", proxies=proxies, timeout=15).text)
```

**明确不支持**：通过 HTTP Header（如 `X-Proxy-Pool`）在单端口内选择资源池。原因：HTTP 代理协议中 Header 会被转发到目标站点，既泄露内部信息，也无法在 CONNECT 隧道中可靠传递。多策略 = 多端口，这是刻意的约束。

---

## 8. 幂等键使用规范

```http
POST /api/v1/resources/import
Idempotency-Key: 3f2a9c1e-...
```

服务端行为：

| 情况 | 响应 |
| --- | --- |
| 首次 | 正常处理，记录 `(scope,key,requestHash,response)` |
| 相同 key + 相同 body | 返回缓存响应 + `Idempotent-Replay: true` |
| 相同 key + 不同 body | `409 IDEMPOTENCY_KEY_REUSED` |
| 处理中 | `409 REQUEST_IN_PROGRESS`（客户端稍后重试） |

适用于：导入、验证任务创建、订阅创建、策略创建。**不适用于** PATCH（用 `If-Match` 版本控制）。
