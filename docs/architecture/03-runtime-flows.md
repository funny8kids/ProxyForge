# ProxyForge 运行时流程

> 文档编号：ARCH-003
> 版本：v1.0 · 状态：Accepted
> 关联：[系统架构](./01-system-architecture.md) · [模块设计](./02-module-design.md)

本文档描述八条核心链路的时序、事务边界、失败分支。实现时以本文档为准；如发现与代码不符，先改文档再改代码。

---

## F1 · 手工导入端点（Phase 1 主链路）

```
用户/脚本          API                source              resource          verification
   │  POST /resources/import │            │                   │                  │
   ├────────────────────────►│            │                   │                  │
   │                         ├─ 校验格式 ─►│                   │                  │
   │                         │            ├─ 解析器选择        │                  │
   │                         │            │  (Csv/Json/Text)  │                  │
   │                         │            ├─ 逐条解析 + 校验   │                  │
   │                         │            ├─ dedupe_key 计算   │                  │
   │                         │            ├─ 批量 UPSERT ─────►│ (DISCOVERED)     │
   │                         │            ├─ 生成 ImportJob    │                  │
   │                         │            └─ 发布 ImportCompleted                  │
   │◄── 202 {jobId} ─────────┤            │                   │                  │
   │                         │            │                   ├─ 发布 EndpointDiscovered ──► 入队
   │                         │            │                   │                  │ (PENDING_VERIFICATION)
```

**事务边界**：`解析 + 批量 UPSERT + ImportJob 落库` 在**一个事务**内（≤ 2000 条/批）。超过则分批提交，`ImportJob` 记录 `processed_offset` 以支持断点续传。

**失败分支**：

| 失败点 | 处理 |
| --- | --- |
| 解析器无法识别格式 | `ImportJob.status=FAILED`，返回前 5 行样本 + 建议格式，**不落半截数据** |
| 单条格式非法 | 跳过并计入 `skipped`，记录 `import_job_errors`（最多保留 100 条） |
| 去重命中 | 更新 `last_seen_at` + 来源关联，不新建端点，计入 `duplicated` |
| 数据库冲突 | 整批回滚，`status=FAILED`，可重试（幂等） |

**验收**：导入 500 条混合格式文本，`imported + duplicated + skipped == total`。

---

## F2 · 自动发现（Phase 2，接口先留）

```
Scheduler(15m) ──► SourceSyncJob
                     ├─ 条件请求（If-None-Match / If-Modified-Since）
                     ├─ 304 → 跳过（不产生快照）
                     ├─ 200 → source_snapshots(content_hash)
                     ├─ hash 未变 → 跳过解析
                     └─ hash 变化 → 解析器链
                            ├─ 已知格式 → 确定性解析
                            └─ 未知格式 → AiAnalyzer 推断结构（可选）
                                            └─ 输出 JSON Schema 假设
                                               └─ 确定性校验器验证假设
                                                  └─ 生成 candidate_endpoints（隔离区）
```

**AI 失败时的行为**：直接跳过该来源本次同步，记录 `ai_analysis_logs(status=SKIPPED_NO_AI)`，**不阻塞其他来源**，也不产生候选。

**安全**：抓取前校验 URL 不在 SSRF 黑名单（内网段、云元数据 `169.254.169.254`、`localhost`），响应体大小上限 10 MB，重定向最多 3 跳且每跳重新校验。

---

## F3 · 分层验证（核心链路）

```
verification-worker
   ├─ 抢占任务（SKIP LOCKED + 租约 2min）
   ├─ 加载端点（协议/凭据/期望出口）
   ├─ L1 DNS  ──fail──► 记录 DNS_FAILURE ──┐
   ├─ L2 TCP  ──fail──► TCP_TIMEOUT ───────┤
   ├─ L3 握手 ──fail──► PROTOCOL_ERROR ────┤
   ├─ L4 认证 ──fail──► AUTH_FAILED ───────┤
   ├─ L5 出口 ──fail──► EXIT_MISMATCH ─────┤
   ├─ L6 质量（3 采样）                    │
   └─ 成功 ────────────────────────────────┤
                                           ▼
                     ┌─────────────────────────────────────┐
                     │ 单事务：                             │
                     │ INSERT health_checks (分区表)        │
                     │ UPSERT endpoint_health_state         │
                     │ UPDATE proxy_endpoints.lifecycle_status │
                     │ INSERT event_outbox(EndpointVerified)│
                     └─────────────────────────────────────┘
                                           │
                     ┌─────────────────────┴──────────────────┐
                     ▼                                        ▼
              pool: 规则重算（去抖 2s）              gateway: 标记配置过期
```

**关键约束**：

1. **每次验证都写历史**，`endpoint_health_state` 只保存最新态（1:1），`health_checks` 保留原始记录（按月分区）。
2. 验证**不修改**端点的 IP 属性，只上报观测值；属性判定由 `resource` 模块基于历史序列完成（关注点分离）。
3. 出口 IP 变化 → 写 `endpoint_ip_observations`，并触发 `IpChangeDetected` → `resource` 重新评估 `ip_type`。
4. 并发上限由 Redis 令牌桶控制；Redis 不可用时降级为进程内 `Semaphore(concurrency)`。

**退避策略**：连续失败 n 次后 `run_after = now() + min(2^n × 5min, 6h)`，避免对失效端点持续打点。

---

## F4 · 资源池自动入池

```
EndpointVerified / EndpointHealthChanged
        │
        ▼ (去抖 2s, Redis 单飞锁 pool:{id})
PoolRuleEngine
   ├─ 取候选：SELECT ... WHERE 硬门槛 AND 规则谓词（SQL 生成，非内存过滤）
   ├─ 计算目标集合 target[]
   ├─ diff(现有 AUTO 成员, target)
   ├─ INSERT 新增 / DELETE 移除（MANUAL 成员不动，只置 suppressed）
   ├─ pool.version++
   └─ 发布 PoolMembershipChanged
        │
        ▼
gateway: 触发策略重编译（若池被策略引用）
```

**为什么用 SQL 生成而不是内存过滤**：10k 端点全量加载到内存做规则匹配，每次健康事件都触发一次，成本过高。规则谓词编译成 `WHERE` 片段（字段白名单 + 参数绑定，杜绝 SQL 注入）。

**抖动抑制**：只有 `diff` 非空才 `version++` 并发事件；同一池 5s 内多次变更合并。

---

## F5 · 网关请求（数据面，无控制面参与）

```
Python/CLI ──HTTP CONNECT──► gost:8080 (listener: policy=default)
                                │
                                ├─ 认证（若开启）：basic / IP ACL
                                ├─ 选择上游：selector(strategy=round|hash|fifo)
                                │     └─ 成员 = 编译期写入的合格端点
                                ├─ 转发（失败 → 组内下一个 priority）
                                └─ 计数（bytes/conns → stats）
```

**延迟预算**：引擎内选择 < 1ms，无数据库访问，无 HTTP 回源。整个链路的额外延迟只来自多一跳 TCP。

**故障切换**：由引擎的 selector 完成（同 priority 组内轮询，跨组降级）。控制面只在**下次编译**时才感知，因此健康状态到配置生效存在 ≤ 15min 的窗口——这是可接受的取舍，通过"编译期只放健康端点 + 引擎层重试"双重兜底。

---

## F6 · 订阅生成与消费

```
用户: POST /api/v1/subscriptions {poolId, format: mihomo, ttl: 30d}
   │
   ├─ 生成 token（32B 随机）→ 仅存 sha256
   ├─ 返回 { id, url: /api/v1/subscriptions/{token}, token(仅此一次) }
   ▼
FlClash: GET /api/v1/subscriptions/{token}
   │
   ├─ 查 token 哈希 → 校验未过期未撤销
   ├─ 取 PoolSnapshot(poolId, latest version)
   ├─ MihomoRenderer.render(snapshot) → YAML
   │     ├─ proxies: [{name, type, server, port, username, password}]
   │     ├─ proxy-groups: [{name: pool-<name>, type: url-test|select, proxies}]
   │     └─ rules: [MATCH, pool-<name>]
   ├─ INSERT subscription_versions（保留 20 版）
   └─ 200 text/yaml + ETag(pool.version)
```

**要点**：

- 订阅**只读**，不触发验证、不写资源表，避免被轮询打爆。
- `ETag` + `If-None-Match` 支持 304，客户端定时刷新不产生重复版本。
- 凭据在渲染时从 `secrets` 解密，**明文只存在于响应体**，日志中必须脱敏。
- 撤销后立即 404，不等缓存过期。

---

## F7 · 策略变更 → 配置下发（同步链路）

```
用户: PUT /api/v1/policies/{id} {strategy: FAILOVER, poolId, ...}
   │
   ├─ 事务：更新 routing_policies（version++）+ outbox
   ├─ 同步调用 PolicyCompiler.compile(policyId)
   │      └─ 读 PoolSnapshot → 硬约束过滤 → 排序 → CompiledPolicy
   ├─ GostAdapter.render() → config.yaml + config_hash
   ├─ hash 相同 → 跳过（返回 200 no-op）
   ├─ hash 不同 → 写 gateway_configs(COMPILED)
   │                ├─ 写入配置卷
   │                ├─ 调引擎 reload（gost API 或 SIGHUP）
   │                ├─ 成功 → APPLIED，旧配置 SUPERSEDED
   │                └─ 失败 → 重试 1 次 → FAILED + 回滚文件
   └─ 返回 { configVersion, applied: true/false, warnings[] }
```

**回滚**：`POST /api/v1/gateway/configs/{version}/rollback` 把历史版本重新下发。因为配置文件全量保留，回滚是"再 apply 一次"，不需要反向 diff。

**警告而非失败**：池为空、成员数 < 2（无法 failover）、端口冲突等作为 `warnings` 返回，不阻断保存（用户可能在配置中间态）。

---

## F8 · AI 不可用时的降级（必须测试）

```
AiRouter.execute()
   ├─ 无可用 binding（enabled=false / 无 provider）
   ├─ 熔断打开（5min 内失败 ≥ 3 次）
   ├─ 预算超限
   └─ 全部 provider 超时
        │
        ▼
   throw AiUnavailableException
        │
        ├─ SourceSyncJob  → catch → 跳过 AI 步骤，用确定性解析器兜底
        ├─ Analyzer       → catch → candidate 标记 needs_review，人工处理
        └─ Assistant      → catch → 返回 503 + "AI 暂不可用，其他功能正常"
```

**集成测试要求**：`AiDownIT` 在关闭全部 AI Provider 的情况下跑完整链路（导入 → 验证 → 入池 → 网关 → 订阅），必须全绿。这是 MVP 验收项之一。

---

## F9 · 端到端场景（MVP 验收脚本）

目标：让 Python、FlClash、CLI 三种消费方同时工作。

```bash
# 1. 导入自有节点（mihomo 片段）
curl -X POST localhost:8081/api/v1/resources/import \
  -H "Authorization: Bearer $TOKEN" -F "file=@nodes.yaml" -F "originType=OWNED"

# 2. 触发验证并等待完成
JOB=$(curl -X POST localhost:8081/api/v1/verification/jobs -d '{"scope":"ALL_PENDING"}' | jq -r .id)
curl localhost:8081/api/v1/verification/jobs/$JOB

# 3. 建池 + 绑定策略
curl -X POST localhost:8081/api/v1/pools -d '{"key":"STATIC_STABLE","minQuality":70}'
curl -X POST localhost:8081/api/v1/policies -d '{"key":"default","poolId":"...","strategy":"FAILOVER","listenPort":8080}'

# 4. Python 走网关
python -c "import requests;print(requests.get('https://api.ipify.org',proxies={'https':'http://127.0.0.1:8080'}).text)"

# 5. 订阅
TOKEN=$(curl -X POST localhost:8081/api/v1/subscriptions -d '{"poolId":"...","format":"mihomo"}' | jq -r .token)
curl localhost:8081/api/v1/subscriptions/$TOKEN > sub.yaml && mihomo -t -f sub.yaml

# 6. 观测
curl localhost:8081/api/v1/analytics/overview
```

**通过标准**：出口 IP 与预期一致；`overview` 中该端点 `lifecycle=HEALTHY` 且有 `health_checks` 历史；订阅 YAML 通过 `mihomo -t` 语法校验；FlClash 可导入。
