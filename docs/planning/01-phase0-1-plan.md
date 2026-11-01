# Phase 0–1 实施计划

> 文档编号：PLAN-001
> 版本：v1.0 · 状态：Active
> 关联：[系统架构](../architecture/01-system-architecture.md) · [运行时流程](../architecture/03-runtime-flows.md)

蓝图建议："先冻结架构基线，然后只做 Phase 0 和 Phase 1"。本计划把这两阶段拆成可独立验收的任务，每个任务都有明确的完成标准（DoD）。

---

## 0. 阶段目标

| 阶段 | 目标 | 完成标志 |
| --- | --- | --- |
| Phase 0（2–4 天） | 证明"一条真实链路能跑通" | 本机 Python 通过网关访问目标，出口 IP 正确 |
| Phase 1（1–2 周） | 证明"资源能被持续管理" | 能导入、验证、分类、入池、订阅自己的代理资产 |

**不在本计划内**（明确推迟）：

- ❌ 自动发现 / GitHub 爬取 / AI 分析（Phase 2）
- ❌ 多节点 Agent、多网关（Phase 4）
- ❌ 多租户、计费（Phase 5）
- ❌ 前端完整 11 个菜单（Phase 1 只做 5 个页面）

---

## 1. Phase 0 · 技术验证（2–4 天）

目标不是写功能，而是**证伪**：验证 GOST 能否满足我们的配置模型、热重载是否可靠、Java 侧能否可靠地编译与下发配置。任何一项失败都要在此阶段暴露，而不是在 Phase 3。

| # | 任务 | 产出 | DoD |
| --- | --- | --- | --- |
| P0-1 | compose 骨架：pg + redis + gost | `deploy/compose/docker-compose.yml` | `docker compose up` 后三个服务 healthy |
| P0-2 | Flyway 初始化 + `schema-v1.sql` 落地 | 迁移文件 | `\dt` 能看到全部表；`ensure_monthly_partitions` 可执行 |
| P0-3 | Spring Boot 骨架 + 健康检查 | `apps/api` | `/actuator/health` 返回 UP，DB 连通 |
| P0-4 | **GOST 配置实验**：手写一份 2 上游 + selector + failover 配置 | `deploy/gateway/config/sample.yaml` | 通过代理访问 `api.ipify.org`，出口为上游 IP |
| P0-5 | **热重载实验**：修改配置后能否不重启生效 | 实验记录 | 结论写入 ADR-0004 的"风险与缓解" |
| P0-6 | 最小策略编译：DB 里 1 条端点 → 渲染 YAML → 写文件 → reload | `GatewayCompiler` 雏形 | 改 DB 后 5s 内生效 |
| P0-7 | Python 端到端验证脚本 | `scripts/phase0-check.py` | 打印出口 IP，与 DB 中 `expected_exit_ip` 一致 |

### Phase 0 验收

```bash
docker compose up -d
python scripts/phase0-check.py
# 输出：
# gateway exit ip = 203.0.113.10  (expected 203.0.113.10)  ✓
```

**Go / No-Go 判据**：

- 热重载可靠 → 继续 Phase 1。
- 热重载不可靠 → 在 Phase 1 前增加"双实例滚动切换"任务（+2 天），不改变架构。

---

## 2. Phase 1 · 资源管理（1–2 周）

### 2.1 后端（按依赖顺序）

| # | 任务 | 依赖 | DoD |
| --- | --- | --- | --- |
| P1-1 | `auth`：登录 + JWT + 一个 ADMIN 种子用户 | P0-2 | 能拿到 token 调通受保护接口 |
| P1-2 | `resource`：IP/Node/Endpoint CRUD + 状态机 | P1-1 | 非法状态转移被拒绝（单测） |
| P1-3 | `resource`：批量导入（CSV/JSON/Text + Mihomo 片段） | P1-2 | 500 条混合格式导入，计数自洽 |
| P1-4 | `resource`：去重（`dedupe_key` + ON CONFLICT） | P1-3 | 重复导入不产生新行，`last_seen_at` 更新 |
| P1-5 | `verification`：L1–L5 探针 + 任务租约 | P1-2 | 能验证 SOCKS5/HTTP，失败原因归类正确 |
| P1-6 | `verification`：L6 采样 + 评分 + `endpoint_health_state` | P1-5 | 评分落在 0–100，权重符合公式 |
| P1-7 | `verification`：定时调度（15m/3m/6h）与退避 | P1-6 | 连续失败后间隔指数增长（日志可验证） |
| P1-8 | `pool`：池 CRUD + 规则引擎（DSL→SQL） | P1-6 | 规则变更后成员 diff 正确，`version++` |
| P1-9 | `pool`：手工成员 + 抑制逻辑 | P1-8 | 授权撤销后手工成员 `suppressed=true` 而非删除 |
| P1-10 | `gateway`：策略编译 + 下发 + 版本记录 | P0-6, P1-8 | 池变更 3s 内反映到配置；失败保留旧配置 |
| P1-11 | `subscription`：Token + Mihomo 渲染 + 版本 | P1-8 | `mihomo -t -f sub.yaml` 校验通过 |
| P1-12 | `analytics`：Overview 聚合（对应"首页四问"） | P1-6, P1-10 | 四个问题都有数据回答 |
| P1-13 | `audit`：关键动作审计 + 只读约束 | P1-1 | 应用角色无法 UPDATE/DELETE 审计表 |
| P1-14 | 事件中继（outbox）+ 消费幂等 | P1-2 | 重启不丢事件；重复消费不产生副作用 |

### 2.2 前端（5 个页面，够用即可）

| # | 页面 | 核心内容 | DoD |
| --- | --- | --- | --- |
| P1-15 | Overview | 总量/健康率/趋势/最近发现 | 数据来自真实 API，非 mock |
| P1-16 | Resources | 列表 + 过滤 + 导入 + 详情 | 支持按状态/协议/来源筛选 |
| P1-17 | Verification | 任务列表 + 健康历史 + 失败原因分布 | 能发起批量验证并看到进度 |
| P1-18 | Pools | 池列表 + 成员 + 规则编辑 | 规则保存后能看到成员变化 |
| P1-19 | Gateway/Subscriptions | 实例状态 + 配置版本 + 订阅创建 | 创建后能复制订阅 URL |

视觉方向：深色基础设施控制台（蓝图 §5），但**Phase 1 不追求精致**——用 shadcn/ui 默认组件 + 暗色主题即可，把时间留给后端正确性。

### 2.3 Phase 1 验收（可执行脚本）

```bash
scripts/acceptance-phase1.sh
```

| 检查项 | 通过标准 |
| --- | --- |
| 导入 | 500 条混合格式，`imported+duplicated+skipped=total` |
| 去重 | 重复导入两次，端点总数不变 |
| 属性 | `ipType` 只有 STATIC/DYNAMIC/UNKNOWN；无证据时为 UNKNOWN |
| 验证 | HTTP + SOCKS5 均能验证；失败原因分布可见 |
| 健康历史 | 每个端点 ≥ 3 条 `health_checks`，最新态与之一致 |
| 入池 | 规则变更后成员数变化，`version` 递增 |
| 授权门槛 | 把端点置 UNKNOWN → 配置与订阅中消失（`AuthorizationGateIT`） |
| 网关 | Python 通过 `127.0.0.1:8080` 访问成功 |
| 订阅 | YAML 通过 `mihomo -t`；FlClash 可导入 |
| AI 降级 | 关闭全部 AI，以上全部仍通过（`AiDownIT`） |
| 安全 | 无认证时网关拒绝绑定 0.0.0.0；响应无密钥明文 |
| 可观测 | Overview 四问有数据；审计有记录 |

---

## 3. 关键路径与排期

```
P0-1 ──► P0-2 ──► P0-4 ──► P0-5 ──► P0-6 ──► P0-7
                                  │
                                  ▼
        P1-1 ──► P1-2 ──► P1-3 ──► P1-4
                    │
                    └──► P1-5 ──► P1-6 ──► P1-7
                              │
                              └──► P1-8 ──► P1-9 ──► P1-10 ──► P1-11
                                                        │
                                                        └──► P1-12
```

**并行机会**：

- P1-1（auth）与 P0-4/P0-5（引擎实验）可并行。
- P1-15..P1-19（前端）在对应 API 完成后即可并行。
- P1-13（审计）、P1-14（outbox）可穿插进行，不阻塞主链路。

**最容易超时的三项**（预留缓冲）：

1. P1-5/P1-6 探针实现（SOCKS5 握手细节、TLS 到代理）。
2. P1-10 策略编译与热重载（依赖 P0-5 结论）。
3. P1-11 Mihomo YAML 兼容性（字段名、`proxy-groups` 语义）。

---

## 4. 风险登记

| # | 风险 | 概率 | 影响 | 应对 |
| --- | --- | --- | --- | --- |
| 1 | GOST 热重载不可靠 | 中 | 高 | Phase 0 先验证；备选双实例切换 |
| 2 | 无真实可用的自有代理做测试 | 中 | 高 | 本地起两个 gost 作为"上游"（自建自测，完全可控） |
| 3 | Mihomo YAML 字段不兼容 | 中 | 中 | 以 `mihomo -t` 为准，先支持最小子集 |
| 4 | 验证误判（网络抖动导致大量 DEGRADED） | 高 | 中 | 连续 N 次才降级；抖动阈值可配 |
| 5 | 前端耗时超预期 | 中 | 低 | 用组件库默认样式，先保证功能 |
| 6 | 导入格式千奇百怪 | 高 | 中 | 只承诺 3 种格式；其余进 `REJECTED` 并给样例 |

---

## 5. 完成定义（Definition of Done）

一个任务算完成，必须同时满足：

1. 单元测试覆盖核心分支（状态机、去重、评分、编译）。
2. 集成测试覆盖至少一条端到端路径。
3. 错误路径有明确错误码与日志（不是 `500 未知错误`）。
4. 涉及安全边界的（授权、密钥、SSRF、绑定）有专门测试。
5. 文档同步更新（本目录下对应文档）。
6. `scripts/acceptance-phase1.sh` 保持全绿。

---

## 6. Phase 2 预告（不在本计划内，但需预留接口）

- `SourceParser` SPI 已定义，Phase 2 只需新增实现。
- `ai_providers` / `ai_task_bindings` 表已就绪，Phase 2 接 UI 即可。
- `candidate_endpoints` 隔离区已存在，Phase 2 只需接发现流水线。
- 这意味着 Phase 2 的工作量主要是"编排 + UI"，不是"重新设计"。
