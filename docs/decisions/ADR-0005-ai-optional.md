# ADR-0005：AI 是可选增强模块，必须可降级

- 状态：Accepted
- 日期：2026-11-01
- 相关：[ARCH-002 §2.8](../architecture/02-module-design.md)、[SEC-001 §6](../security/01-security-design.md)

## 背景

蓝图要求"AI 不直接决定资源可用"，同时提出多 Provider、多 Base URL、多模型的配置中心。若把 AI 调用写成流水线的必经步骤，会出现三类问题：

1. 没有 API Key 的用户无法使用系统（违反"AI 是可选"）。
2. AI 服务抖动导致导入/验证失败（错误耦合）。
3. 成本不可控（无预算边界）。

## 决策

1. **AI 只出现在两个位置**：来源结构分析（Intelligence）与自然语言助手。验证、去重、授权判定、调度、订阅渲染**零 AI 依赖**。
2. `AiRouter.execute()` 在无可用 Provider 时抛 `AiUnavailableException`，调用方**必须**捕获并降级；ArchUnit 规则：仅 `intelligence` 与 `assistant` 包可依赖 `AiRouter`。
3. Provider Registry 与业务解耦：`ai_providers` / `ai_models` / `ai_task_bindings` 三张表，支持任意 OpenAI 兼容端点、Anthropic、Ollama、自定义 Base URL。
4. 降级链：`ai_task_bindings` 按 `priority` 升序尝试，全部失败则熔断 5 分钟。
5. 预算：`budget_monthly_usd` 超限后跳过 AI 任务（不影响其他模块），并发出告警。

## 后果

**正面**

- 零配置即可用：不填任何 AI Key，Phase 0/1 全部功能可用。
- AI 抖动不会造成数据链路故障。
- 换厂商/换模型不改代码。

**负面**

- 未知格式来源在无 AI 时只能人工处理（这是可接受的，且更安全）。
- 两套解析路径（确定性 vs AI 辅助）需要分别测试。
- 需要额外的降级测试（`AiDownIT`）。

## 验证

`AiDownIT`：关闭所有 Provider，跑"导入 → 验证 → 入池 → 网关 → 订阅"完整链路，必须全绿。这是 MVP 验收项。
