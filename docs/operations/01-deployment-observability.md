# ProxyForge 部署与运维

> 文档编号：OPS-001
> 版本：v1.0 · 状态：Accepted
> 关联：[系统架构](../architecture/01-system-architecture.md)

---

## 1. 部署单元

| 服务 | 镜像 | 必需 | 说明 |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | ✅ | 主数据存储 |
| `redis` | `redis:7-alpine` | ⚠️ 可选 | 锁/限流/缓存；缺失时自动降级 |
| `api` | `proxyforge/api:<tag>` | ✅ | 管理 API + 订阅渲染 |
| `worker` | 同 api 镜像，`SPRING_PROFILES_ACTIVE=worker` | ✅ | 验证/发现/中继/分区维护 |
| `gateway` | `ginuerzh/gost:v3` | ✅ | 数据面转发 |
| `web` | `proxyforge/web:<tag>` | ⚠️ 可选 | 管理控制台静态资源 |
| `prometheus` / `grafana` | 官方镜像 | ⚠️ 可选 | 监控 |

### 1.1 目录约定

```
deploy/
├── compose/
│   ├── docker-compose.yml
│   ├── docker-compose.monitoring.yml
│   └── .env.example
├── docker/
│   ├── api.Dockerfile
│   └── web.Dockerfile
├── gateway/
│   └── config/            # 引擎配置输出目录（api 可写，gateway 只读）
└── monitoring/
    ├── prometheus.yml
    └── alerts.yml
```

### 1.2 最小 compose 骨架

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: proxyforge
      POSTGRES_USER: proxyforge
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U proxyforge -d proxyforge"]
      interval: 10s
      retries: 5

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "no", "--maxmemory", "256mb",
              "--maxmemory-policy", "allkeys-lru"]

  api:
    image: proxyforge/api:${TAG:-dev}
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      SPRING_PROFILES_ACTIVE: api
      DB_URL: jdbc:postgresql://postgres:5432/proxyforge
      DB_USER: proxyforge
      DB_PASSWORD: ${POSTGRES_PASSWORD}
      REDIS_URL: redis://redis:6379
      PROXYFORGE_MASTER_KEY_FILE: /run/secrets/master_key
      PROXYFORGE_GATEWAY_BIND: 127.0.0.1
    ports: ["127.0.0.1:8081:8081"]
    volumes:
      - ./gateway/config:/var/lib/proxyforge/gateway
    secrets: [master_key]

  worker:
    image: proxyforge/api:${TAG:-dev}
    depends_on: [api]
    environment:
      SPRING_PROFILES_ACTIVE: worker
      # 其余同上
    volumes:
      - ./gateway/config:/var/lib/proxyforge/gateway

  gateway:
    image: ginuerzh/gost:v3
    command: ["-C", "/etc/gost/config.yaml"]
    network_mode: host          # 需要访问 127.0.0.1:8080；也可用固定 IP + 端口映射
    volumes:
      - ./gateway/config:/etc/gost:ro
    restart: unless-stopped

secrets:
  master_key:
    file: ./secrets/master_key

volumes:
  pgdata:
```

**注意**：`network_mode: host` 在 Linux 上最直接（网关绑定 `127.0.0.1` 时容器内回环与宿主回环不同）。若用 bridge 网络，需把 `GATEWAY_BIND` 设为容器内地址并把端口映射到 `127.0.0.1:8080`，同时接受"非回环绑定"的安全校验（此时必须开启认证 + ACL，见 SEC-001 §5.1）。

---

## 2. 环境变量

| 变量 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DB_URL` | ✅ | — | JDBC URL |
| `DB_USER` / `DB_PASSWORD` | ✅ | — | 数据库凭据 |
| `REDIS_URL` | ❌ | 空 | 为空则禁用 Redis 相关能力 |
| `PROXYFORGE_MASTER_KEY_FILE` | ✅ | — | 主密钥文件（32 字节 base64） |
| `PROXYFORGE_MASTER_KEY` | ❌ | — | 开发用，优先级低于文件 |
| `PROXYFORGE_GATEWAY_BIND` | ❌ | `127.0.0.1` | 非回环需 auth+acl |
| `PROXYFORGE_GATEWAY_HTTP_PORT` | ❌ | `8080` | — |
| `PROXYFORGE_GATEWAY_SOCKS_PORT` | ❌ | `1080` | — |
| `PROXYFORGE_GATEWAY_CONFIG_DIR` | ❌ | `/var/lib/proxyforge/gateway` | 配置输出目录 |
| `PROXYFORGE_VERIFICATION_CONCURRENCY` | ❌ | `50` | 并发验证数 |
| `PROXYFORGE_AI_ENABLED` | ❌ | `true` | 关闭后完全跳过 AI |
| `PROXYFORGE_LOG_LEVEL` | ❌ | `INFO` | — |
| `TZ` | ❌ | `UTC` | **必须 UTC**，本地化只在展示层 |

启动校验（缺任一即失败，不允许"半配置"运行）：

1. 主密钥可读且长度正确。
2. 数据库可连且 `flyway_schema_history` 版本匹配。
3. 网关绑定地址安全检查通过。

---

## 3. 数据库迁移

```bash
# 应用启动时自动执行（Flyway），也可手动：
docker compose run --rm api java -jar app.jar --migrate-only
```

规则：

- 迁移文件 `V{n}__{desc}.sql`，**只前向**。
- 大表加索引使用独立脚本（`CREATE INDEX CONCURRENTLY` 不能在事务中执行）。
- 迁移前自动备份（脚本 `scripts/pre-migrate-backup.sh`）。
- 生产变更窗口：迁移与应用发布分离，先迁移（向后兼容）再发布应用。

---

## 4. 备份与恢复

### 4.1 备份

```bash
# 每日 02:00
pg_dump -Fc -Z6 "$DB_URL" | age -r "$BACKUP_PUBKEY" > backup-$(date +%F).dump.age
# 保留 7 日 + 每月 1 份归档
```

- 备份包含 `secrets` 表密文，但**不含主密钥**。主密钥单独备份（离线），否则备份无法恢复。
- 恢复演练：每季度一次，恢复到临时库并跑 `smoke-test.sh`。

### 4.2 恢复

```bash
age -d -i backup.key backup-2026-11-01.dump.age | pg_restore -d "$DB_URL" --clean --if-exists
```

恢复后必须执行：

1. `SELECT ensure_monthly_partitions(3);`
2. `POST /api/v1/gateway/reload` 重新编译下发（配置文件中可能残留旧端点）。
3. 校验 `secrets` 可解密（`GET /api/v1/ai/providers/{id}/test`）。

---

## 5. 监控

### 5.1 关键指标

| 指标 | 类型 | 告警阈值 |
| --- | --- | --- |
| `proxyforge_endpoints_total{status}` | Gauge | 健康率 < 60% 持续 15min |
| `proxyforge_verification_success_rate` | Gauge | < 0.7 持续 30min |
| `proxyforge_verification_queue_depth` | Gauge | > 500 持续 10min |
| `proxyforge_job_lease_expired_total` | Counter | 5min 内 > 10 |
| `proxyforge_outbox_lag_seconds` | Gauge | > 60 |
| `proxyforge_gateway_up` | Gauge | == 0 持续 1min（P1） |
| `proxyforge_gateway_config_apply_failed_total` | Counter | > 0 |
| `proxyforge_subscription_render_errors_total` | Counter | > 0 |
| `proxyforge_ai_cost_usd_today` | Gauge | > 预算 80% |
| `proxyforge_ai_errors_total` | Counter | 5min 内 > 5（熔断中） |
| `proxyforge_partition_missing` | Gauge | == 1 |
| `pg_database_size_bytes` | Gauge | > 50 GB |
| `http_server_requests_seconds{quantile="0.95"}` | Histogram | P95 > 1s |

### 5.2 日志规范

结构化 JSON（logback + logstash encoder）：

```json
{
  "ts": "2026-11-01T10:00:00.123Z",
  "level": "INFO",
  "logger": "com.proxyforge.verification.VerificationJobService",
  "msg": "verification completed",
  "traceId": "3f2a...",
  "jobId": "5c7b...",
  "endpointId": "c8a1...",
  "durationMs": 842,
  "result": "SUCCESS"
}
```

必须带 `traceId`；跨进程（api → gateway）用 `configVersion` 关联。

---

## 6. 运维 Runbook

### R1 · 网关不可用（P1）

```bash
docker compose ps gateway                 # 是否在运行
docker compose logs --tail=200 gateway    # 配置语法错误？
docker compose restart gateway
curl -s localhost:9000/config | head      # 引擎管理面
```

若配置损坏：`POST /api/v1/gateway/configs/{lastGoodVersion}/rollback`，或删除配置文件后重启（引擎会以空配置启动，随后重编译下发）。

### R2 · 验证任务堆积

1. 看 `proxyforge_verification_queue_depth` 与 worker 日志。
2. 常见原因：并发过低 / 端点大面积超时（上游故障）/ 租约未回收。
3. 临时处置：`PROXYFORGE_VERIFICATION_CONCURRENCY=100` 重启 worker；或将 `run_after` 批量推后：
   ```sql
   UPDATE verification_jobs SET run_after = now() + interval '30 min'
   WHERE status='PENDING' AND created_at < now() - interval '1 hour';
   ```

### R3 · 分区缺失（插入报错）

```sql
SELECT ensure_monthly_partitions(3);
```
并在 worker 日志确认 `partition maintenance` 任务在跑（每日 03:00）。

### R4 · Outbox 积压

```sql
SELECT count(*) FROM event_outbox WHERE published_at IS NULL;
SELECT event_type, count(*) FROM event_outbox WHERE published_at IS NULL GROUP BY 1;
```
积压说明消费者异常（通常是某 Handler 抛异常导致整批回滚）。修复后中继会自动追平；若单条毒消息卡住，`UPDATE ... SET published_at=now(), last_error='poison' WHERE event_id=...` 并人工处理。

### R5 · 资源"标注健康但不可用"

1. 手动触发 `POST /api/v1/resources/{id}/verify`。
2. 对比 `health_checks` 最近 5 条与 `endpoint_health_state`。
3. 若状态未更新 → 检查 worker 是否在跑、租约是否被回收。
4. 若验证通过但实际不可用 → 出口验证目标可能被 CDN 缓存，检查 `exit-check-urls` 配置。

### R6 · 磁盘告警

按顺序处理：`DROP` 过期分区 → 清理 `source_snapshots` 正文 → 清理 `import_job_errors` → 归档 `ai_usage_records`。

---

## 7. 容量与扩展

| 规模 | 配置建议 |
| --- | --- |
| < 1k 端点 | 2C4G 单机，compose 全量 |
| 1k–10k 端点 | 4C8G，worker × 2，PG 独立 4C8G |
| 10k–50k 端点 | PG 8C16G + 分区 + 读写分离；worker × 3；网关按策略拆实例 |
| > 50k | 引入 TimescaleDB/ClickHouse 存健康时序；网关多实例 + 前置 LB（TCP） |

**扩容顺序**：worker 副本 → 网关实例 → 数据库垂直扩容 → 数据库读写分离。不要先拆服务。

---

## 8. 升级流程

1. 备份（自动）。
2. 拉新镜像，**先迁移数据库**（向后兼容）。
3. 滚动重启 api（保持一个副本在线）。
4. 重启 worker（任务租约会在 2 分钟内被新实例接管）。
5. 重启 gateway（配置从磁盘加载，短暂中断 < 5s；或用双实例切换）。
6. 跑 `scripts/smoke-test.sh`（导入 1 条 → 验证 → 网关访问 → 订阅渲染）。

**回滚**：应用镜像回退到上一 tag；数据库不回滚（前向兼容设计保证旧版本可读新库）。
