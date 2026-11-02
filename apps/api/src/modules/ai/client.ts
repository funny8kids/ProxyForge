import type { AiTaskType } from '@proxyforge/contracts';
import { exec, q, q1 } from '../../db/client.js';
import { open } from '../../shared/crypto.js';

/**
 * LLM 调用层（ADR-0005）
 *
 * 设计取舍：
 *
 * 1. **降级链是串行的，不是并发竞速。** 竞速要多付 N 倍的钱，而这里的调用
 *    都是后台任务（发现、分类、评估），延迟不重要，成本重要。
 *
 * 2. **JSON 模式必须做空响应重试。** DeepSeek 文档明确写了：当输出无法被
 *    识别为 JSON 时，API 会把非 JSON 内容替换成空格，`content` 可能只剩空格，
 *    而 `finish_reason` 仍然是 `stop`。不重试就会把"模型跑偏"误判成"模型返回空"。
 *
 * 3. **成本按缓存命中/未命中分别计价。** DeepSeek 缓存命中价是未命中的 1/20，
 *    统一按未命中价算会把成本高估一个量级，预算拦截就形同虚设。
 *
 * 4. **失败也记账。** `ai_usage_records.success = false` 保留错误码，
 *    否则"为什么这个月花了钱但没产出"无从排查。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  taskType: AiTaskType;
  messages: ChatMessage[];
  /** 要求返回 JSON 对象。调用方仍需自行校验结构 */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** 思考模式。结构化抽取默认关掉：省 token、快，且不需要推理过程 */
  thinking?: 'enabled' | 'disabled';
  /** 只试这一个 provider（连接测试、手动触发） */
  onlyProviderId?: string;
}

export interface ChatAttempt {
  providerKey: string;
  modelName: string;
  ok: boolean;
  detail: string;
  latencyMs: number;
}

export interface ChatResult {
  ok: boolean;
  /** 模型返回的原始文本（失败时为空串） */
  content: string;
  /** json:true 且解析成功时给出 */
  data: unknown;
  providerKey: string | null;
  modelName: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  latencyMs: number;
  attempts: ChatAttempt[];
  error: string | null;
}

interface BindingRow {
  provider_id: string;
  model_id: string;
  provider_key: string;
  provider_name: string;
  type: string;
  base_url: string;
  timeout_ms: number;
  api_key_ref: string | null;
  extra_headers: Record<string, string> | null;
  budget_monthly_usd: string | null;
  spent_current_month: string;
  model_name: string;
  supports_json: boolean;
  input_cost_per_1k: string;
  output_cost_per_1k: string;
  cached_input_cost_per_1k: string;
  max_tokens: number | null;
  temperature: string | null;
}

/** 默认输出上限。JSON 模式被截断是常见失败，留足空间 */
const DEFAULT_MAX_TOKENS = 2000;

/**
 * 各任务类型的默认思考模式。
 *
 * 这是实测出来的，不是拍脑袋：`deepseek-flash` 在关闭思考时，
 * 「列出你确信存在的公开代理列表 URL」这类**知识回忆型**任务会直接返回
 * `{"sources":[]}` —— 它知道答案，但不愿意在无推理的情况下承诺。
 * 打开思考后同一句 prompt 能给出 TheSpeedX / monosport / clarketm 这类真实地址。
 *
 * 反过来，分类（CLASSIFIER）是单点判断，思考只会白烧 3-5 倍 completion token。
 */
const DEFAULT_THINKING: Record<AiTaskType, 'enabled' | 'disabled'> = {
  DISCOVERY: 'enabled',
  ANALYZER: 'enabled',
  EVALUATOR: 'enabled',
  CLASSIFIER: 'disabled',
  ASSISTANT: 'disabled',
};

/**
 * 拼接端点。
 *
 * 不能简单 `${base}/v1/chat/completions`：DeepSeek 的 base 是
 * `https://api.deepseek.com`（没有 /v1），而 OpenAI 的 base 通常自带 `/v1`。
 * 两种都要能用，所以只补路径、不补版本段。
 */
export function endpointOf(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith(path)) return base;
  return `${base}${path}`;
}

async function loadChain(taskType: AiTaskType, onlyProviderId?: string): Promise<BindingRow[]> {
  return q<BindingRow>(
    `SELECT b.provider_id, b.model_id, b.max_tokens, b.temperature,
            p.key AS provider_key, p.name AS provider_name, p.type, p.base_url,
            p.timeout_ms, p.api_key_ref, p.extra_headers,
            p.budget_monthly_usd, p.spent_current_month,
            m.model_name, m.supports_json,
            m.input_cost_per_1k, m.output_cost_per_1k, m.cached_input_cost_per_1k
     FROM ai_task_bindings b
     JOIN ai_providers p ON p.id = b.provider_id
     JOIN ai_models    m ON m.id = b.model_id
     WHERE b.task_type = $1::ai_task_type
       AND b.enabled AND p.enabled AND m.enabled
       AND ($2::uuid IS NULL OR p.id = $2::uuid)
     ORDER BY b.priority ASC, p.created_at ASC`,
    [taskType, onlyProviderId ?? null],
  );
}

async function decryptKey(apiKeyRef: string | null): Promise<string | null> {
  if (!apiKeyRef) return null;
  const row = await q1<{ ciphertext: string; nonce: string; key_version: number }>(
    `SELECT encode(ciphertext,'base64') AS ciphertext, encode(nonce,'base64') AS nonce, key_version
     FROM secrets WHERE ref = $1`,
    [apiKeyRef],
  );
  if (!row) return null;
  return open({
    ciphertext: Buffer.from(row.ciphertext, 'base64'),
    nonce: Buffer.from(row.nonce, 'base64'),
    keyVersion: row.key_version,
  });
}

/**
 * 宽松 JSON 解析。
 *
 * 即使开了 JSON 模式，模型偶尔还是会套一层 ```json 围栏，
 * 或者前后多一句"好的，这是结果："。这里只做最小清理，不做修复式解析 ——
 * 修出来的 JSON 如果结构不对，后面照样校验不过，不如早点失败。
 */
export function parseJsonLoose(raw: string): { ok: true; value: unknown } | { ok: false } {
  const text = raw.trim();
  if (!text) return { ok: false };
  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      // 试下一个候选
    }
  }
  return { ok: false };
}

async function recordUsage(input: {
  providerId: string;
  modelId: string;
  taskType: AiTaskType;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  latencyMs: number;
  success: boolean;
  errorCode: string | null;
}): Promise<void> {
  await exec(
    `INSERT INTO ai_usage_records
       (provider_id, model_id, task_type, prompt_tokens, completion_tokens,
        cached_prompt_tokens, reasoning_tokens, cost_usd, latency_ms, success, error_code)
     VALUES ($1,$2,$3::ai_task_type,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.providerId, input.modelId, input.taskType,
      input.promptTokens, input.completionTokens, input.cachedTokens,
      input.reasoningTokens, input.costUsd, input.latencyMs,
      input.success, input.errorCode,
    ],
  );
  // 预算计数：只在成功时累加，失败调用 DeepSeek 不计费（除网络中断外的 4xx/5xx）
  if (input.success) {
    await exec(
      'UPDATE ai_providers SET spent_current_month = spent_current_month + $2 WHERE id = $1',
      [input.providerId, input.costUsd],
    );
  }
}

interface ProviderResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string };
}

/** 单次 HTTP 调用。返回文本与用量，不负责重试 */
async function callOnce(
  b: BindingRow,
  apiKey: string | null,
  req: ChatRequest,
  messages: ChatMessage[],
  maxTokens: number,
  thinking: 'enabled' | 'disabled' | null,
): Promise<{
  content: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  finishReason: string;
}> {
  const body: Record<string, unknown> = {
    model: b.model_name,
    messages,
    stream: false,
    max_tokens: maxTokens,
  };
  if (req.json) body.response_format = { type: 'json_object' };
  const temperature = req.temperature ?? (b.temperature === null ? null : Number(b.temperature));
  if (temperature !== null && temperature !== undefined) body.temperature = temperature;
  // 思考模式：只有显式要求时才发这个字段，避免非 DeepSeek 供应商因未知参数 400
  if (thinking) body.thinking = { type: thinking };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(b.extra_headers ?? {}),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(endpointOf(b.base_url, '/chat/completions'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(b.timeout_ms),
  });

  const text = await res.text();
  let payload: ProviderResponse;
  try {
    payload = JSON.parse(text) as ProviderResponse;
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
  }

  if (!res.ok || payload.error) {
    const detail = payload.error?.message ?? text.slice(0, 160);
    throw new Error(`HTTP ${res.status}：${detail}`);
  }

  const content = payload.choices?.[0]?.message?.content ?? '';
  const usage = payload.usage ?? {};
  const cachedTokens = usage.prompt_cache_hit_tokens ?? 0;
  return {
    content,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    cachedTokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    finishReason: payload.choices?.[0]?.finish_reason ?? '',
  };
}

/**
 * 按任务类型的降级链调用 LLM。
 *
 * 永不抛异常 —— 全部失败时返回 `{ ok: false, error }`。
 * 调用方（worker / 路由）据此决定重试还是降级，而不是被一个 throw 打断整个批次。
 */
export async function chat(req: ChatRequest): Promise<ChatResult> {
  const t0 = Date.now();
  const attempts: ChatAttempt[] = [];
  const chain = await loadChain(req.taskType, req.onlyProviderId);

  const fail = (error: string): ChatResult => ({
    ok: false, content: '', data: null,
    providerKey: null, modelName: null,
    promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0,
    costUsd: 0, latencyMs: Date.now() - t0, attempts, error,
  });

  if (chain.length === 0) {
    return fail(`任务 ${req.taskType} 没有可用的模型绑定`);
  }

  const thinking = req.thinking ?? DEFAULT_THINKING[req.taskType] ?? null;

  for (const b of chain) {
    const budget = b.budget_monthly_usd === null ? null : Number(b.budget_monthly_usd);
    if (budget !== null && budget > 0 && Number(b.spent_current_month) >= budget) {
      attempts.push({
        providerKey: b.provider_key, modelName: b.model_name, ok: false,
        detail: `月度预算已用尽（$${Number(b.spent_current_month).toFixed(2)} / $${budget.toFixed(2)}）`,
        latencyMs: 0,
      });
      continue;
    }

    let apiKey: string | null = null;
    try {
      apiKey = await decryptKey(b.api_key_ref);
    } catch (err) {
      attempts.push({
        providerKey: b.provider_key, modelName: b.model_name, ok: false,
        detail: `密钥解密失败：${err instanceof Error ? err.message : String(err)}`,
        latencyMs: 0,
      });
      continue;
    }

    const maxTokens = req.maxTokens ?? b.max_tokens ?? DEFAULT_MAX_TOKENS;
    const messages: ChatMessage[] = [...req.messages];
    let lastError = '';
    const startedAt = Date.now();

    // 每个 provider 最多两次：第二次只在上一次 JSON 解析失败时发生
    for (let round = 0; round < 2; round += 1) {
      try {
        const r = await callOnce(b, apiKey, req, messages, maxTokens, thinking);
        const latencyMs = Date.now() - startedAt;

        const missTokens = Math.max(0, r.promptTokens - r.cachedTokens);
        const costUsd =
          (missTokens / 1000) * Number(b.input_cost_per_1k) +
          (r.cachedTokens / 1000) * Number(b.cached_input_cost_per_1k) +
          (r.completionTokens / 1000) * Number(b.output_cost_per_1k);

        if (!req.json) {
          await recordUsage({
            providerId: b.provider_id, modelId: b.model_id, taskType: req.taskType,
            promptTokens: r.promptTokens, completionTokens: r.completionTokens,
            cachedTokens: r.cachedTokens, reasoningTokens: r.reasoningTokens,
            costUsd, latencyMs, success: true, errorCode: null,
          });
          attempts.push({
            providerKey: b.provider_key, modelName: b.model_name, ok: true,
            detail: `HTTP 200 · ${r.finishReason}`, latencyMs,
          });
          return {
            ok: true, content: r.content, data: null,
            providerKey: b.provider_key, modelName: b.model_name,
            promptTokens: r.promptTokens, completionTokens: r.completionTokens,
            cachedTokens: r.cachedTokens, reasoningTokens: r.reasoningTokens,
            costUsd, latencyMs: Date.now() - t0, attempts, error: null,
          };
        }

        const parsed = parseJsonLoose(r.content);
        if (parsed.ok) {
          await recordUsage({
            providerId: b.provider_id, modelId: b.model_id, taskType: req.taskType,
            promptTokens: r.promptTokens, completionTokens: r.completionTokens,
            cachedTokens: r.cachedTokens, reasoningTokens: r.reasoningTokens,
            costUsd, latencyMs, success: true, errorCode: null,
          });
          attempts.push({
            providerKey: b.provider_key, modelName: b.model_name, ok: true,
            detail: `HTTP 200 · JSON 已解析 · ${r.finishReason}`, latencyMs,
          });
          return {
            ok: true, content: r.content, data: parsed.value,
            providerKey: b.provider_key, modelName: b.model_name,
            promptTokens: r.promptTokens, completionTokens: r.completionTokens,
            cachedTokens: r.cachedTokens, reasoningTokens: r.reasoningTokens,
            costUsd, latencyMs: Date.now() - t0, attempts, error: null,
          };
        }

        // JSON 模式空响应 / 非法 JSON —— 按 DeepSeek 文档的兜底建议重试一次
        lastError = r.content.trim()
          ? `输出不是合法 JSON（finish_reason=${r.finishReason}）`
          : `输出为空（finish_reason=${r.finishReason}），JSON 模式可能把非 JSON 内容替换成了空格`;
        await recordUsage({
          providerId: b.provider_id, modelId: b.model_id, taskType: req.taskType,
          promptTokens: r.promptTokens, completionTokens: r.completionTokens,
          cachedTokens: r.cachedTokens, reasoningTokens: r.reasoningTokens,
          costUsd, latencyMs, success: false, errorCode: 'JSON_PARSE_FAILED',
        });

        if (round === 0) {
          messages.push({ role: 'assistant', content: r.content || '(空)' });
          messages.push({
            role: 'user',
            content:
              '上一次输出不是合法的 JSON 对象。请只输出一个 JSON 对象，不要任何解释、不要 Markdown 围栏、不要前后缀文字。',
          });
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await recordUsage({
          providerId: b.provider_id, modelId: b.model_id, taskType: req.taskType,
          promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0,
          costUsd: 0, latencyMs: Date.now() - startedAt, success: false,
          errorCode: 'REQUEST_FAILED',
        });
        break; // 网络 / HTTP 错误重试无意义，直接换下一个 provider
      }
    }

    attempts.push({
      providerKey: b.provider_key, modelName: b.model_name, ok: false,
      detail: lastError, latencyMs: Date.now() - startedAt,
    });
  }

  const last = attempts[attempts.length - 1];
  return fail(last ? `所有模型均失败，最后一个错误：${last.detail}` : '没有可用模型');
}

/**
 * 探测单个 provider 是否可用。
 *
 * 走一次最小 chat 调用而不是 /models —— /models 只能证明"密钥能过鉴权"，
 * 证明不了"这个模型名真的能调"。两者经常不一致（模型下线但列表里还在）。
 */
export async function probeProvider(providerId: string): Promise<{
  ok: boolean;
  detail: string;
  latencyMs: number;
  models: string[];
}> {
  const t0 = Date.now();
  const row = await q1<{ base_url: string; api_key_ref: string | null; timeout_ms: number }>(
    'SELECT base_url, api_key_ref, timeout_ms FROM ai_providers WHERE id = $1',
    [providerId],
  );
  if (!row) return { ok: false, detail: 'Provider 不存在', latencyMs: 0, models: [] };

  let models: string[] = [];
  let listDetail = '';
  try {
    const apiKey = await decryptKey(row.api_key_ref);
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(endpointOf(row.base_url, '/models'), {
      headers,
      signal: AbortSignal.timeout(row.timeout_ms),
    });
    listDetail = `models HTTP ${res.status}`;
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      models = data.data?.map((m) => m.id) ?? [];
    }
  } catch (err) {
    listDetail = `models 请求失败：${err instanceof Error ? err.message : String(err)}`;
  }

  // 真正发一次 chat：这是唯一能证明"可用"的方式
  const r = await chat({
    taskType: 'ASSISTANT',
    onlyProviderId: providerId,
    maxTokens: 24,
    temperature: 0,
    thinking: 'disabled',
    messages: [{ role: 'user', content: '回复两个字：可用' }],
  });

  return {
    ok: r.ok,
    detail: r.ok ? `${listDetail} · chat 可用（${r.modelName}）` : `${listDetail} · ${r.error ?? 'chat 失败'}`,
    latencyMs: Date.now() - t0,
    models,
  };
}
