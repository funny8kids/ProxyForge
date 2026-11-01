# ProxyForge 安全设计

> 文档编号：SEC-001
> 版本：v1.0 · 状态：Accepted
> 关联：[系统架构](../architecture/01-system-architecture.md) · [API 设计](../api/01-api-design.md)

安全在本项目中不是"上线前补的检查项"，而是架构约束。本文档给出威胁模型、控制措施与验证方法，每条控制都有对应的测试或代码位置。

---

## 1. 资产与信任边界

### 1.1 需要保护的资产

| 资产 | 泄露后果 | 存储位置 |
| --- | --- | --- |
| AI API Key | 直接经济损失、额度滥用 | `secrets`（AES-256-GCM） |
| **订阅签名私钥** | 可伪造任意订阅配置，绕过完整性校验 | `secrets`（`kind=SIGNING_KEY`）或只读文件挂载，永不入库明文 |
| 代理端点凭据 | 代理被他人占用、溯源到本人 | `secrets` + `proxy_endpoints.credential_ref` |
| 订阅 Token | 他人消耗资源、暴露出口 IP | 仅存 `sha256` |
| 用户口令 | 账号接管 | Argon2id 哈希 |
| 审计日志 | 合规证据丢失 | `audit_events`（append-only） |
| 资源来源授权信息 | 法律风险 | `resource_sources.authorization_status` |

### 1.2 信任边界

```
[不可信] 公网来源 / 公开代理 / 用户上传文件 / AI 返回内容
    │
    ├─ 边界 A：解析器（沙箱化解析、大小限制、超时）
    ▼
[半可信] candidate_endpoints（隔离区，不被网关读取）
    │
    ├─ 边界 B：晋级审查（授权 + 去重 + 人工确认）
    ▼
[可信] proxy_endpoints（授权通过）
    │
    ├─ 边界 C：编译期硬门槛（只有可调度端点进入引擎配置）
    ▼
[执行域] gost 进程（只读配置，无业务数据）
```

**核心原则：AI 输出与公网内容永远停留在"不可信/半可信"区，不可能直接进入执行域。**

---

## 2. 威胁模型（STRIDE）

| 类别 | 具体威胁 | 控制措施 | 验证方式 |
| --- | --- | --- | --- |
| **S**poofing | 伪造订阅 Token 拉取配置 | 32 字节 CSPRNG、只存哈希、恒定时间比较 | 单测：错误 token 返回 404 |
| Spoofing | 冒充管理员调用 API | JWT 短时 + refresh 轮换；API Key 前缀可识别与吊销 | 集成测试 |
| **T**ampering | 篡改网关配置 | 配置版本化 + `config_hash` + 审计；配置文件权限 0600 | 启动时校验 hash |
| Tampering | 恶意来源投递畸形数据污染资产库 | 解析器大小/深度限制、字段白名单、候选隔离区 | 模糊测试（解析器） |
| **R**epudiation | 否认执行过隔离/撤销操作 | `audit_events` append-only，含 actor/IP/requestId | DB 权限 REVOKE UPDATE/DELETE |
| **I**nformation disclosure | API 响应泄露 API Key | DTO 层强制脱敏（`@Sensitive` + Jackson Serializer） | 契约测试：任何响应不含 `sk-` 明文 |
| Info disclosure | 日志记录凭据 | Logback 脱敏 filter（`password`/`token`/`apiKey`/`Authorization`） | 单测：构造含密钥日志断言被替换 |
| Info disclosure | 订阅 URL 被 CDN 缓存 | `Cache-Control: private, no-store`（渲染端点） | 响应头断言 |
| **D**enial of service | 导入超大文件 | 10 MB 上限、行数上限 50k、流式解析 | 集成测试 |
| DoS | 验证任务打满连接 | 令牌桶 + 每目标限速 + 退避 | 压测 |
| DoS | 策略编译风暴 | Redis 单飞锁 + 2s 去抖 | 并发测试 |
| **E**levation of privilege | 普通用户改 AI Provider 读取密钥 | RBAC + scope 双层；密钥永不返回 | 权限矩阵测试 |
| EoP | SSRF 通过 `baseUrl` 访问云元数据 | URL 校验（协议/主机/IP/重定向） | 单测覆盖 169.254.169.254、10.0.0.0/8、`file://` |
| EoP | 池规则注入 SQL | 结构化 DSL → 白名单字段 → 参数绑定 | 注入测试用例集 |
| **T**ampering | 订阅配置在传输/落盘后被篡改 | Ed25519 签名 + `canonicalHash`（§6.4） | `SubscriptionSignatureIT` |
| **T**ampering | 重放旧的但仍有效的签名配置 | `revision` 单调 + `expiresAt` + Token 撤销（§6.4.6） | `ReplayRejectTest` |
| **E**oP | 公开代理被规则自动提升为可调度资源 | `trust_tier` 只读于规则引擎；DB `CHECK` 禁止 `PUBLIC_PROXY` 获得网关授权（§6.2.6） | `TrustTierGateIT` |
| EoP | AI 建议被当作晋升决定执行 | AI 只能写 `promotion_suggestions`；批准需人工 + DB 约束（§6.6） | `AiCannotPromoteTest` |

---

## 3. 密钥管理

### 3.1 存储模型（信封加密）

```
master_key (环境变量 / 文件 / 未来 KMS)
    │  AES-256-GCM
    ▼
secrets.ciphertext + nonce + key_version
```

- 主密钥来源优先级：`PROXYFORGE_MASTER_KEY_FILE`（推荐，权限 0600）> `PROXYFORGE_MASTER_KEY`（base64，仅开发）。
- 启动时若两者都缺失：**拒绝启动**（不允许"无密钥运行"降级）。
- `key_version` 支持轮换：新写入用最新版本，读取按行内版本解密；提供 `POST /admin/secrets/rotate` 批量重加密。

### 3.2 使用规则（代码级）

| 规则 | 落地 |
| --- | --- |
| 密钥只在"使用点"解密 | `SecretStore.use(ref, Function<byte[],T>)`，不返回 `String` 到上层 |
| 不进入 DTO | DTO 只有 `apiKeyMasked` 字段 |
| 不进入日志 | 日志 filter + 禁止 `toString()` 打印含密钥对象（`@ToString.Exclude`） |
| 不进入异常信息 | 解密失败统一抛 `SecretAccessException("secret unavailable")` |
| 不进入前端 | 编辑时留空表示"不修改"，只有显式传值才覆盖 |

### 3.3 轮换策略

| 密钥 | 周期 | 方式 |
| --- | --- | --- |
| 主密钥 | 12 个月或泄露时 | 双密钥并存解密 → 全量重加密 → 废弃旧密钥 |
| AI API Key | 90 天 | 界面轮换 + 连接测试 |
| 订阅 Token | 90 天（可配） | 重新签发 + 旧 token 撤销 |
| API Key | 180 天 | 新建 + 并行使用 + 撤销旧的 |

---

## 4. SSRF 防护

三个出站入口都需要防护：**AI Base URL**、**来源抓取 URL**、**出口验证目标**。

### 4.1 统一校验器

```java
public final class OutboundUrlGuard {
    // 拒绝：非 http/https、含 userinfo、主机为 IP 字面量且在禁止网段、
    //       解析后落在禁止网段、端口不在白名单（80/443/8080/8443/11434）
    // 每次重定向都重新校验（不信任 3xx 的 Location）
}
```

**禁止网段**（IPv4 + IPv6 都要覆盖）：

```
0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4,
::1/128, fc00::/7, fe80::/10, ::ffff:0:0/96（映射地址需还原后判断）
```

**DNS 重绑定防护**：解析一次拿到 IP 后，用该 IP 直连（设置 `Host` 头），避免"校验时解析 A、连接时解析 B"。

### 4.2 例外：本地模型

`http://localhost:11434`（Ollama）是合法需求。处理方式：

- 仅当 `ai_providers.allow_private_network = true`（需 `ADMIN` 角色显式勾选）时允许私有网段。
- 例外记录写入审计：`action=ai.provider.private_network_allowed`。
- 仍然禁止云元数据地址（`169.254.169.254`）与 `0.0.0.0`。

### 4.3 出口验证目标

验证时访问的"IP 回显服务"必须是白名单内的固定地址（配置项 `verification.exit-check-urls`），不接受来源提供的目标 URL，防止被用作"探测任意内网主机"的跳板。

---

## 5. 网关访问控制

### 5.1 默认安全基线

| 项 | 默认 | 强制 |
| --- | --- | --- |
| 监听地址 | `127.0.0.1` | 非回环时必须同时满足：`auth.enabled=true` + `acl.enabled=true`，否则**启动失败** |
| 认证 | 关闭（回环场景） | 开放时必须 Basic（用户名/密码来自 `secrets`） |
| ACL | 关闭 | 开放时必须配置允许网段 |
| 明文 HTTP | 允许（仅回环） | 开放时建议 TLS 或置于内网 |
| 最大连接数 | 2000 | 可配，防资源耗尽 |

启动校验伪代码：

```java
if (!isLoopback(bindHost) && !(authEnabled && aclEnabled)) {
    throw new IllegalStateException(
        "Refusing to bind gateway to non-loopback address without auth + acl");
}
```

### 5.2 Kill Switch

一个开关同时做到：停止所有监听器 + 拒绝新连接 + 保留管理面。

```
POST /api/v1/admin/kill-switch { "enabled": true, "reason": "..." }
```

实现：编译一份"空配置"（无 listener）下发 + 写入系统开关 `config_versions`（`config_type='SYSTEM'`, `config_key='gateway_lock'`，并缓存于 Redis），锁定期间拒绝任何配置下发直到解锁。**审计必记录**，且解锁需要 `ADMIN` + 二次确认参数 `confirm=true`。

### 5.3 滥用防护（合规红线）

系统**不得**提供以下能力（代码评审时检查）：

- 针对特定域名的自动"绕过 403/429"策略（例如检测到 429 后自动换 IP 重试）。
- 对未授权目标的批量探测。
- 将"被目标站点封禁"作为资源健康指标并自动轮换。

实现层面：验证任务只访问白名单回显服务；网关是被动转发，不含任何目标站点语义。

---

## 6. 授权合规

### 6.1 授权状态是硬门槛（三重实现）

1. **数据层**：`v_schedulable_endpoints` 视图过滤 `authorization_status IN ('AUTHORIZED','RESTRICTED')`。
2. **编译层**：`PolicyCompiler` 只从该视图取数；编译产物不含 `UNKNOWN`/`REVOKED`。
3. **订阅层**：`SubscriptionRenderer` 同样从该视图取数。

三重实现看似冗余，但任何一层被绕过都不会造成"未授权资源被使用"。集成测试 `AuthorizationGateIT` 覆盖：把端点改为 `UNKNOWN` → 触发重编译 → 断言配置与订阅中均无该端点。

### 6.2 资源信任分级与 PUBLIC_PROXY 隔离策略

`authorization_status` 回答"有没有授权"，`trust_tier` 回答"这份资源被允许用在什么场景"。两者独立，必须同时满足。

#### 6.2.1 三层权限矩阵（唯一权威定义）

| 资源分级 | 默认网关接入 | 订阅实验 | 正式网关 | 判定依据 |
| --- | --- | --- | --- | --- |
| `PRIVATE_PROXY` | 禁止 | 禁止 | **需显式授权** | 自有/私有来源，归属明确（`OWNED` / `PAID_PROVIDER` / 有书面授权的 `FREE_PROVIDER`） |
| `PUBLIC_PROXY` | 禁止 | **仅 `PUBLIC_EXPERIMENTAL`** | 禁止 | 公开来源，无法证明授权归属 |
| `VERIFIED_PROXY` | 允许 | 允许 | 允许 | 通过 L1–L6 全部验证 + 授权审查 + 人工确认 |

三条推论：

1. `PRIVATE_PROXY` 不是"更高级"，它需要 **`explicit_gateway_grant = true`** 才能进正式网关——自有资源不等于"允许被任意应用使用"。
2. `PUBLIC_PROXY` 永远不进正式网关，无论质量分多高、验证多成功。
3. 只有 `VERIFIED_PROXY` 是"默认可调度"的。

#### 6.2.2 与 `origin_type` 的映射

| `origin_type` | 允许申请的 tier | 说明 |
| --- | --- | --- |
| `OWNED` | `PRIVATE_PROXY` → `VERIFIED_PROXY` | 默认 `PRIVATE_PROXY` |
| `PAID_PROVIDER` | `PRIVATE_PROXY` → `VERIFIED_PROXY` | 受供应商条款与配额约束 |
| `FREE_PROVIDER` | `PRIVATE_PROXY`（需授权声明）或 `PUBLIC_PROXY` | 无明确授权声明一律 `PUBLIC_PROXY` |
| `PUBLIC_PROXY` | **仅 `PUBLIC_PROXY`** | 除非来源方提供书面授权，由 `ADMIN` 人工改判并留证 |
| `UNKNOWN` | 无（不可用） | 需人工审查 |

分级**不可由规则引擎自动提升**：`PoolRuleEngine` 只能读取 `trust_tier`，不能写入；`trust_tier` 的写入路径只有两条——人工 API 与 `CandidatePromotionService` 的确定性规则。

#### 6.2.3 PUBLIC_PROXY 的六条硬约束

1. **默认入池**：导入即落 `PUBLIC_EXPERIMENTAL`，不进入任何其他池。
2. **不允许自动晋升**：不存在"质量达标 → 自动升级"的路径；`trust_tier` 变更需 `OPERATOR` 以上角色 + 审计。
3. **必须通过三类检查**：连通性（L1–L6）、匿名性、安全性（见 6.2.4）。
4. **可用性 ≠ 合法性**：UI 与 API 中"健康"与"已授权"是两个独立字段，禁止合并展示为"可用"。
5. **全生命周期留痕**：来源、采集时间、检测结果、入池/出池、隔离/撤销，全部进 `audit_events` + `promotion_suggestions`。
6. **可立即隔离与撤销**：`POST /resources/{id}/quarantine` 与 `PATCH {trustTier}` 立即触发重编译，1 分钟内从配置与订阅中消失。

#### 6.2.4 匿名性与安全性检查（PUBLIC_PROXY 专属）

| 检查 | 方法 | 不通过判定 |
| --- | --- | --- |
| 透明代理检测 | 对比"直连出口 IP"与"经代理出口 IP" | 相同 → 透明代理，不转发流量 |
| 头部注入 | 检查响应头是否含 `X-Forwarded-For` / `Via` / `Proxy-Connection` / `X-Real-IP` | 含真实内网地址 → 泄露风险 |
| DNS 泄露 | 通过代理解析随机域名，观察解析器归属 | 解析走本地 → 标注 `DNS_LEAK` |
| 证书替换 | 访问固定 HTTPS 目标，比对证书链指纹 | 被替换 → 立即 `QUARANTINED` |
| 响应篡改 | 下载固定测试文件比对 SHA-256 | 不匹配 → 立即 `QUARANTINED` |

检查结果写入 `health_checks` 的扩展字段与 `security_checks` 表；任一项 `CRITICAL` 失败直接隔离，不进入任何池。

#### 6.2.5 中间人风险提示（产品层强制）

- `PUBLIC_EXPERIMENTAL` 池页面固定展示警告条，不可关闭。
- 该池生成的订阅 YAML 顶部插入注释：`# WARNING: public proxies — traffic may be logged or modified`。
- 该池禁止承载凭据、支付、企业内部系统等敏感流量（文档与 UI 双重声明）。
- 订阅签名**不改变**这一判断：签名证明"配置来自 ProxyForge"，不证明"上游代理可信"。

#### 6.2.6 数据库层保证

```sql
-- 公开代理永不被授予网关权限
CHECK (NOT (trust_tier = 'PUBLIC_PROXY' AND explicit_gateway_grant))

-- 池只能接纳声明的分级
resource_pools.allowed_tiers trust_tier[] NOT NULL
    DEFAULT '{PRIVATE_PROXY,VERIFIED_PROXY}'
```

`v_schedulable_endpoints` 与 `v_subscription_eligible_endpoints` 两个视图把上述规则固化为 SQL，编译层与渲染层只允许从视图取数（见 §6.1 三重实现）。

### 6.3 订阅身份认证与 Token 生命周期

**先区分两个概念**——它们在实现、密钥、失效方式上完全不同，不能互相替代：

| | 身份认证（Authentication） | 内容完整性（Integrity） |
| --- | --- | --- |
| 回答的问题 | 请求者是否持有有效凭证？ | 内容是否被篡改？是否由可信发布者生成？ |
| 手段 | 32 字节 CSPRNG Token + SHA-256 哈希比对 | Ed25519 数字签名 |
| 密钥类型 | 对称（服务端持有明文一次，只存哈希） | 非对称（私钥签名，公钥验签） |
| 失效方式 | 撤销 / 过期 | 密钥轮换 / 版本升级 |
| 谁需要保密 | 客户端持有 Token（等同密码） | 客户端只持公钥，**无需保密** |

#### 6.3.1 Token 规范

| 项 | 规定 |
| --- | --- |
| 生成 | `base64url(CSPRNG(32))`，前缀 `pf_sub_`，熵 ≥ 256 bit |
| 存储 | 仅 `sha256(token)` + `token_prefix`（前 8 位，供检索与展示） |
| 传输 | 仅 HTTPS；日志中路径一律脱敏为 `/subscriptions/***` |
| 展示 | 创建响应返回明文**一次**，此后任何接口不返回 |
| 有效期 | 默认 90 天（`ttlDays` 可配，上限 365） |
| 比较 | 恒定时间比较，避免时序侧信道 |
| 失败响应 | 不存在 / 过期 / 撤销 统一 `404`，响应体与耗时一致（防枚举） |
| 使用统计 | `access_count` + `last_accessed_at`；> 1000 次/小时触发审计告警 |
| 续期 | **不支持续期同一 Token**；续期 = 新 Token + 旧 Token 撤销（保证泄露窗口可关闭） |

#### 6.3.2 Token 状态机

```
ACTIVE ──(剩余 ≤ 7d)──► EXPIRING ──(到期)──► EXPIRED
   │                                            ▲
   └──(管理员/用户撤销)──► REVOKED ─────────────┘
```

- `EXPIRING` 仅用于 UI 提醒，行为上仍可用。
- `REVOKED` 与 `EXPIRED` 都立即 404，不做缓存宽限。
- 状态由 `expires_at` / `revoked_at` 派生，不新增状态列（避免状态与时间不一致）。

#### 6.3.3 必须审计的事件

`subscription.created`、`subscription.accessed`（聚合采样，不逐次写）、`subscription.revoked`、`subscription.render_failed`、`subscription.signing_key_changed`。

### 6.4 订阅内容完整性与数字签名（Ed25519）

#### 6.4.1 为什么是 Ed25519 而不是 HMAC-SHA256

| 对比 | HMAC-SHA256 | Ed25519 |
| --- | --- | --- |
| 密钥类型 | 共享密钥 | 公钥 / 私钥 |
| 客户端是否需要秘密 | 是 | **否** |
| 防篡改 | 是 | 是 |
| 独立验证（第三方可验） | 不适合 | **支持** |
| 私钥泄露影响面 | 所有持有共享密钥者 | 仅签名私钥持有者 |
| 推荐用途 | 内部 API 认证（webhook 回调） | **订阅内容签名** |

订阅要分发给任意客户端（FlClash / Mihomo / 脚本），共享密钥必然被复制到每台设备，一旦泄露等于全网可伪造。因此订阅签名用 Ed25519；HMAC 只保留给内部/回调场景（见 API-001 §6.4 Webhook）。

#### 6.4.2 签什么：规范化 JSON，而不是 YAML 字节流

**这是最容易做错的一点。** YAML 的序列化不唯一（键顺序、缩进、引号风格、锚点/别名、行宽折叠），同一个配置模型经不同库渲染会得到不同字节，签名必然对不上。

因此：

1. 渲染器先产出**规范化配置模型**（`CanonicalSubscription`，字段顺序固定、数值规范化）。
2. 用 **RFC 8785 JSON Canonicalization Scheme (JCS)** 序列化为字节串。
3. 对该字节串计算 `canonicalHash = sha256(bytes)`，并签名。
4. YAML 只是这份规范化模型的**展示形式**；客户端验签时：YAML → 解析 → 重新 JCS 序列化 → 验签。

签名输入（`sig_input`）= `signatureVersion || 0x00 || keyId || 0x00 || JCS(canonicalSubscription)`，避免跨版本/跨密钥的签名重用。

#### 6.4.3 信封结构

```json
{
  "payload": {
    "format": "mihomo",
    "revision": 128,
    "issuedAt": "2026-11-01T10:00:00Z",
    "expiresAt": "2026-11-08T10:00:00Z",
    "poolKey": "STATIC_STABLE",
    "poolVersion": 42,
    "proxies": [ { "name": "pf-01", "type": "socks5", "server": "203.0.113.10", "port": 1080 } ],
    "proxyGroups": [ { "name": "STATIC_STABLE", "type": "url-test", "proxies": ["pf-01"] } ]
  },
  "signature": {
    "alg": "Ed25519",
    "signatureVersion": 1,
    "keyId": "pf-sub-2026-11",
    "value": "base64url(64 bytes)",
    "canonicalHash": "sha256:9f2c..."
  }
}
```

#### 6.4.4 端点与响应头

| 请求 | 响应 |
| --- | --- |
| `GET /subscriptions/{token}` | YAML 正文 + 签名响应头（兼容现有客户端） |
| `GET /subscriptions/{token}?format=json` | 完整信封 JSON（可离线验签） |
| `GET /subscriptions/{token}/signature` | 仅签名块（detached signature） |
| `GET /subscriptions/{token}/pubkey` | 当前签名公钥（PEM，可选） |

响应头（YAML 模式）：

```
X-PF-Signature-Alg: Ed25519
X-PF-Key-Id: pf-sub-2026-11
X-PF-Signature-Version: 1
X-PF-Revision: 128
X-PF-Issued-At: 2026-11-01T10:00:00Z
X-PF-Expires-At: 2026-11-08T10:00:00Z
X-PF-Canonical-Hash: sha256:9f2c...
X-PF-Signature: <base64url>
```

签名是**可选增强层**：默认关闭（`subscriptions.signing_enabled=false`），开启后不影响不支持验签的客户端（它们忽略响应头）。

#### 6.4.5 客户端验签步骤

1. 读取 `X-PF-Key-Id`，在本地预置公钥表或 `/.well-known/proxyforge-signing-keys.json` 中查找公钥。
2. 校验 `X-PF-Signature-Version` 是否被本地验证器支持；**不支持则拒绝**（fail-closed，不降级为"忽略签名"）。
3. 解析 YAML/JSON 为规范化模型，按 JCS 重新序列化。
4. 校验 `sha256(JCS)` == `X-PF-Canonical-Hash`。
5. 用公钥验证 `X-PF-Signature`（Ed25519，输入见 6.4.2）。
6. 校验 `revision > 本地缓存的最大 revision`，且 `now < expiresAt`；否则拒绝（防重放）。

#### 6.4.6 签名能证明什么、不能证明什么

| 能证明 | 不能证明 |
| --- | --- |
| 配置内容完整、未被第三方篡改 | 上游代理可信（`PUBLIC_PROXY` 仍可能记录流量） |
| 配置由持有私钥的 ProxyForge 实例生成 | 配置是最新的（旧签名仍可能有效） |
| 内容与 `canonicalHash` 一致 | 请求者身份合法（那是 Token 的职责） |

**因此 `revision` + `issuedAt/expiresAt` + Token 撤销三者缺一不可**——签名本身不防重放。

### 6.5 签名密钥轮换、撤销与版本兼容

#### 6.5.1 密钥模型

| 项 | 规定 |
| --- | --- |
| 算法 | Ed25519（32 字节私钥种子 / 32 字节公钥） |
| `key_id` | `pf-sub-YYYY-MM`（含生成月份，便于人工识别） |
| 私钥存储 | `secrets`（`kind='SIGNING_KEY'`，AES-256-GCM）或只读文件挂载；**永不入库明文、永不进日志、永不返回 API** |
| 公钥存储 | `signing_keys.public_key`（明文，可公开） |
| 状态 | `ACTIVE`（签名用）/ `STANDBY`（已发布未启用）/ `RETIRED`（只验不签）/ `COMPROMISED` |
| 并发 | 同一时刻**仅一个** `ACTIVE` 签名密钥（DB 部分唯一索引保证） |

#### 6.5.2 轮换流程（不停机）

1. 生成新密钥对 → `signing_keys` 插入 `STANDBY`，公钥发布到 `/.well-known`。
2. 客户端预置窗口（≥ 30 天）：新公钥进入客户端信任列表。
3. 切换：旧 `ACTIVE` → `RETIRED`，新 `STANDBY` → `ACTIVE`。
4. 过渡期（默认 7 天）**双签**：响应头同时给 `X-PF-Signature` 与 `X-PF-Signature-Prev`，任一可验即通过。
5. 过渡期结束：停止双签；`RETIRED` 密钥保留验证能力 90 天后可删除。

#### 6.5.3 撤销与失陷处置

| 场景 | 动作 |
| --- | --- |
| 私钥疑似泄露 | 立即置 `COMPROMISED` → 全量重签（新 `revision`）→ 通知所有订阅持有者重新拉取 |
| `COMPROMISED` 密钥 | 立即从 `/.well-known` 移除；客户端信任列表应带 `notBefore/notAfter`，超期密钥自动失效 |
| Token 泄露（非密钥） | 撤销该订阅即可，**不需要**轮换签名密钥 |
| 算法升级 | `signatureVersion` 递增，新旧并行至少 90 天 |

#### 6.5.4 版本兼容原则

- `signatureVersion` 表示"签名输入构造方式 + 规范化规则"的版本，**不是**算法版本（算法在 `alg` 字段）。
- 客户端遇到未知 `signatureVersion`：**拒绝并告警**，不得静默接受（否则等于没有签名）。
- 服务端保留旧版本签名能力至少 6 个月，给客户端升级窗口。

### 6.6 AI 的权限边界

AI 在本系统中只做三件事：**发现来源、分析结构、提出建议**。它不拥有任何权限变更能力。

| AI 可以做 | AI 不可以做 |
| --- | --- |
| 建议某候选资源的 `suggestedTier` | 直接写 `trust_tier` |
| 评估来源可信度并给出理由 | 修改 `authorization_status` |
| 标记可疑模式（如伪造的授权声明） | 设置 `explicit_gateway_grant` |
| 生成晋升建议工单 | 批准自己的建议 |

实现约束：

1. AI 只能写 `promotion_suggestions`（`suggested_tier`、`confidence`、`rationale`、`status=PENDING`）。
2. 批准必须由 `actor_type='USER'` 且角色 ≥ `OPERATOR` 执行；数据库约束：

```sql
CHECK (status <> 'APPROVED' OR reviewed_by IS NOT NULL)
CHECK (status <> 'APPROVED' OR reviewed_at IS NOT NULL)
```

3. `CandidatePromotionService.promote()` 内部断言：调用者不是 `SYSTEM`/`AI`，且 `suggestionId` 若存在则必须为 `APPROVED`。
4. 审计记录 `ai_suggestion_id`，可回溯"哪条建议导致了哪次晋升"。
5. ArchUnit 规则：`ai` 包不得依赖 `resource` / `pool` 的写接口。

---

## 7. 数据保护

### 7.1 日志脱敏规则

| 模式 | 替换 |
| --- | --- |
| `(?i)(password\|passwd\|pwd)=([^&\s]+)` | `$1=***` |
| `(?i)(api[_-]?key\|token\|secret)=([^&\s]+)` | `$1=***` |
| `Authorization: .*` | `Authorization: ***` |
| `sk-[A-Za-z0-9]{16,}` | `sk-***` |
| 代理 URL 中的 userinfo | `scheme://***:***@host` |
| 订阅路径 `/subscriptions/<token>` | `/subscriptions/***` |

实现为 Logback `PatternLayout` 的自定义 converter + 请求日志 filter，**默认开启，不可通过配置关闭**。

### 7.2 数据库

- 连接强制 TLS（生产）；本地 compose 允许明文但仅限容器内网。
- 应用角色最小权限（见 DDL 末尾注释）：`audit_events` 无 UPDATE/DELETE。
- 备份加密（`pg_dump | age -r <pubkey>`），备份文件不落地明文。
- 生产禁止 `log_statement=all`（会记录凭据相关 SQL 参数）。

### 7.3 前端

- JWT 存 `sessionStorage`（非 localStorage），刷新用 httpOnly refresh cookie。
- 所有渲染默认转义；`dangerouslySetInnerHTML` 禁用（ESLint 规则）。
- 订阅 Token 创建后只显示一次，页面离开即清除内存中的值。

---

## 8. 审计

### 8.1 必须审计的动作

| 类别 | 动作 |
| --- | --- |
| 身份 | 登录成功/失败、API Key 创建/撤销、角色变更 |
| 资源 | 授权状态变更、隔离、撤销、批量删除 |
| 配置 | 池规则变更、策略变更、网关配置下发/回滚、Kill Switch |
| 密钥 | 创建/轮换/使用失败 |
| AI | Provider 增删改、私有网段放行、预算超限 |
| 订阅 | 创建/撤销、异常高频访问（> 1000 次/小时） |

### 8.2 审计记录结构

```json
{
  "occurredAt": "2026-11-01T10:00:00Z",
  "actorType": "USER",
  "actorId": "u-8f1c",
  "action": "endpoint.quarantine",
  "resourceType": "ProxyEndpoint",
  "resourceId": "c8a1...",
  "sourceIp": "127.0.0.1",
  "requestId": "01JB...",
  "beforeState": { "lifecycleStatus": "HEALTHY" },
  "afterState": { "lifecycleStatus": "QUARANTINED", "reason": "manual" }
}
```

**禁止**在 `beforeState/afterState` 中放凭据或完整 Token。

---

## 9. 依赖与部署加固

| 项 | 措施 |
| --- | --- |
| 依赖漏洞 | CI 跑 `dependency-check` + `npm audit`，高危阻断 |
| 镜像 | distroless / alpine，非 root 运行，只读根文件系统 |
| 容器能力 | `cap_drop: ALL`，仅网关需要 `NET_BIND_SERVICE`（若用 80 端口） |
| 端口暴露 | compose 中仅 `3000`（可选）映射到宿主，其余仅容器内网 |
| 配置卷 | `gateway/config` 只读挂载给 gost，可写挂载给 api |
| 数据库 | 不映射到宿主端口；`POSTGRES_PASSWORD` 来自 `.env`（不入库不入镜像） |
| 备份 | 每日 `pg_dump` + 保留 7 份 + 每月全量归档 |

---

## 10. 安全测试清单（Phase 0–1 必过）

| # | 测试 | 期望 |
| --- | --- | --- |
| 1 | `AuthorizationGateIT` | `UNKNOWN`/`REVOKED` 端点不出现在配置与订阅 |
| 2 | `SsrfGuardTest` | 内网/元数据/`file://`/重定向到内网 全部拒绝 |
| 3 | `SecretLeakTest` | 扫描所有 API 响应，无 `sk-`/密码明文 |
| 4 | `LogRedactionTest` | 构造含密钥的日志，输出已脱敏 |
| 5 | `SubscriptionTokenTest` | 错误/过期/撤销 token 均 404；无时序侧信道 |
| 6 | `GatewayBindGuardTest` | `0.0.0.0` + 无认证 → 启动失败 |
| 7 | `RuleInjectionTest` | DSL 中的 SQL 元字符不生效 |
| 8 | `IdempotencyTest` | 重复 key 返回首次结果；不同 body 返回 409 |
| 9 | `AuditImmutabilityTest` | 应用角色无法 UPDATE/DELETE 审计表 |
| 10 | `AiDownIT` | 关闭全部 AI 后全链路可用 |
| 11 | `TrustTierGateIT` | `PUBLIC_PROXY` 永不进入网关配置；`PRIVATE_PROXY` 无显式授权时被排除 |
| 12 | `SubscriptionSignatureIT` | 篡改 YAML 一个字节 → 验签失败；未篡改 → 通过 |
| 13 | `ReplayRejectTest` | `revision` 回退或 `expiresAt` 过期 → 客户端拒绝 |
| 14 | `SigningKeyRotationTest` | 双签过渡期内新旧密钥均可验；`COMPROMISED` 后旧签名被拒 |
| 15 | `AiCannotPromoteTest` | AI 身份调用晋升接口 → 403；未批准的 suggestion 无法晋升 |

---

## 11. 事故响应（简版 Runbook）

| 事件 | 立即动作 | 后续 |
| --- | --- | --- |
| 订阅 Token 泄露 | `DELETE /subscriptions/{id}` → 重签 | 审计访问日志定位来源 IP；评估暴露范围 |
| API Key 泄露 | 撤销 Key → 轮换相关 AI Key | 检查 `ai_usage_records` 异常消费 |
| 网关被扫描/滥用 | 开 Kill Switch → 查 `gateway_traffic_samples` | 收紧 ACL，改为仅内网 |
| 主密钥疑似泄露 | 立即轮换主密钥 + 全量重加密 | 强制所有用户重新登录，撤销全部 API Key |
| 发现未授权资源被使用 | 置 `authorization_status=REVOKED` | 触发重编译，确认配置已剔除；审计回溯导入链路 |
| **签名私钥泄露** | 置 `signing_keys.status=COMPROMISED` → 立即轮换 → 全量重签（`revision++`） | 从 `/.well-known` 移除公钥；通知订阅持有者重新拉取；评估伪造配置影响面 |
| **PUBLIC_PROXY 异常入池** | 立即 `POST /resources/{id}/quarantine` | 审计 `trust_tier` 变更历史，确认规则引擎未越权写入 |
