import type { FastifyInstance } from 'fastify';
import type { AiProviderRow, AiTaskBindingRow, AiTaskType } from '@proxyforge/contracts';
import { q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit } from '../../shared/events.js';
import { invalid, notFound } from '../../shared/errors.js';
import { uuidv7 } from '../../shared/id.js';
import { maskSecret, seal } from '../../shared/crypto.js';

/**
 * AI Provider Registry（ADR-0005）
 *
 * 两条硬约束：
 *   1. API Key 明文只在请求中出现一次，落库即加密，读接口永远只返回脱敏值。
 *   2. baseUrl 必须过 SSRF 校验 —— 否则"配置一个 AI Provider"就成了
 *      让服务器访问内网元数据接口的跳板。
 */

const PRIVATE_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,   // 链路本地 + 云元数据
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

function assertSafeUrl(raw: string, allowPrivate: boolean): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('baseUrl 不是合法 URL', [{ field: 'baseUrl', message: raw }]);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid('baseUrl 仅支持 http/https');
  }
  const host = url.hostname;
  const isPrivate =
    PRIVATE_PATTERNS.some((p) => p.test(host)) ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal');

  if (isPrivate && !allowPrivate) {
    throw invalid('baseUrl 指向内网地址，已被 SSRF 防护拦截', [
      { field: 'baseUrl', message: '如需访问本地 Ollama，请显式开启 allowPrivateNetwork（需 ADMIN）' },
    ]);
  }
}

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ai/providers', { preHandler: guard('ai:read') }, async (): Promise<{ items: AiProviderRow[] }> => {
    const rows = await q<Record<string, unknown>>(
      `SELECT p.*, s.ciphertext IS NOT NULL AS has_key
       FROM ai_providers p LEFT JOIN secrets s ON s.ref = p.api_key_ref
       ORDER BY p.created_at ASC`,
    );
    const models = await q<Record<string, unknown>>(
      'SELECT provider_id, model_name, display_name, enabled FROM ai_models ORDER BY model_name',
    );

    return {
      items: rows.map((r) => ({
        id: r.id as string,
        key: r.key as string,
        name: r.name as string,
        type: r.type as AiProviderRow['type'],
        baseUrl: r.base_url as string,
        // 明文永不返回：只给一个固定占位，长度不泄露真实 key
        apiKeyMasked: r.has_key ? 'sk-****' : null,
        enabled: Boolean(r.enabled),
        timeoutMs: Number(r.timeout_ms),
        allowPrivateNetwork: Boolean(r.allow_private_network),
        budgetMonthlyUsd: r.budget_monthly_usd === null ? null : Number(r.budget_monthly_usd),
        spentCurrentMonth: Number(r.spent_current_month),
        lastTestedAt: (r.last_tested_at as string) ?? null,
        lastTestOk: (r.last_test_ok as boolean) ?? null,
        models: models
          .filter((m) => m.provider_id === r.id)
          .map((m) => ({
            modelName: m.model_name as string,
            displayName: (m.display_name as string) ?? null,
            enabled: Boolean(m.enabled),
          })),
      })),
    };
  });

  app.post('/ai/providers', { preHandler: guard('ai:write') }, async (req) => {
    const body = req.body as {
      key: string; name: string; type: string; baseUrl: string;
      apiKey?: string; models?: string[]; enabled?: boolean; timeoutMs?: number;
      allowPrivateNetwork?: boolean; budgetMonthlyUsd?: number;
    };
    if (!body?.key || !body?.name || !body?.baseUrl) {
      throw invalid('key / name / baseUrl 必填');
    }

    const actor = actorOf(req);
    if (body.allowPrivateNetwork && actor.role !== 'ADMIN') {
      throw invalid('allowPrivateNetwork 需要 ADMIN 权限');
    }
    assertSafeUrl(body.baseUrl, body.allowPrivateNetwork === true);

    const id = uuidv7();
    const ref = `secret://ai/${body.key}`;

    await tx(async (t) => {
      if (body.apiKey) {
        const env = seal(body.apiKey);
        await t.exec(
          `INSERT INTO secrets (ref, kind, ciphertext, nonce, key_version, description)
           VALUES ($1,'AI_API_KEY',$2,$3,$4,$5) ON CONFLICT (ref) DO NOTHING`,
          [ref, env.ciphertext, env.nonce, env.keyVersion, `AI Provider ${body.key}`],
        );
      }

      await t.exec(
        `INSERT INTO ai_providers
           (id, key, name, type, base_url, api_key_ref, enabled, timeout_ms,
            allow_private_network, budget_monthly_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id, body.key, body.name, body.type, body.baseUrl,
          body.apiKey ? ref : null, body.enabled ?? true, body.timeoutMs ?? 30000,
          body.allowPrivateNetwork ?? false, body.budgetMonthlyUsd ?? null,
        ],
      );

      for (const m of body.models ?? []) {
        await t.exec(
          `INSERT INTO ai_models (id, provider_id, model_name, display_name)
           VALUES ($1,$2,$3,$4) ON CONFLICT (provider_id, model_name) DO NOTHING`,
          [uuidv7(), id, m, m],
        );
      }

      // 审计里绝不写 apiKey，只写"是否设置了密钥"
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'ai.provider.create',
        resourceType: 'ai_provider', resourceId: id,
        afterState: { key: body.key, baseUrl: body.baseUrl, hasApiKey: Boolean(body.apiKey) },
      });
    });

    return { id, key: body.key, apiKeyMasked: body.apiKey ? maskSecret(body.apiKey) : null };
  });

  app.patch('/ai/providers/:id', { preHandler: guard('ai:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const actor = actorOf(req);

    if (typeof body.baseUrl === 'string') {
      assertSafeUrl(body.baseUrl, body.allowPrivateNetwork === true);
    }

    await tx(async (t) => {
      const n = await t.exec(
        `UPDATE ai_providers SET
           name = COALESCE($2, name),
           base_url = COALESCE($3, base_url),
           enabled = COALESCE($4, enabled),
           timeout_ms = COALESCE($5, timeout_ms),
           allow_private_network = COALESCE($6, allow_private_network),
           budget_monthly_usd = COALESCE($7, budget_monthly_usd)
         WHERE id = $1`,
        [
          id, (body.name as string) ?? null, (body.baseUrl as string) ?? null,
          (body.enabled as boolean) ?? null, (body.timeoutMs as number) ?? null,
          (body.allowPrivateNetwork as boolean) ?? null, (body.budgetMonthlyUsd as number) ?? null,
        ],
      );
      if (n === 0) throw notFound('AI Provider');
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'ai.provider.update',
        resourceType: 'ai_provider', resourceId: id,
        afterState: { ...body, apiKey: undefined },
      });
    });
    return { ok: true };
  });

  /** 连接测试：只打 /models，不发送任何业务 prompt */
  app.post('/ai/providers/:id/test', { preHandler: guard('ai:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const p = await q1<{ base_url: string; timeout_ms: number; api_key_ref: string | null; type: string }>(
      'SELECT base_url, timeout_ms, api_key_ref, type FROM ai_providers WHERE id = $1',
      [id],
    );
    if (!p) throw notFound('AI Provider');

    const t0 = performance.now();
    let ok = false;
    let detail = '';
    let models: string[] = [];

    try {
      const url = p.type === 'OLLAMA' ? `${p.base_url.replace(/\/$/, '')}/api/tags` : `${p.base_url.replace(/\/$/, '')}/v1/models`;
      const res = await fetch(url, { signal: AbortSignal.timeout(p.timeout_ms) });
      ok = res.ok;
      detail = `HTTP ${res.status}`;
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string }>; models?: Array<{ name: string }> };
        models = data.data?.map((m) => m.id) ?? data.models?.map((m) => m.name) ?? [];
      }
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }

    const latency = Math.round(performance.now() - t0);
    await q1('SELECT 1');
    await tx(async (t) => {
      await t.exec('UPDATE ai_providers SET last_tested_at = now(), last_test_ok = $2 WHERE id = $1', [id, ok]);
    });

    return { ok, latencyMs: latency, detail, models };
  });

  app.get('/ai/models', { preHandler: guard('ai:read') }, async (req) => {
    const { providerId } = req.query as { providerId?: string };
    const rows = await q<Record<string, unknown>>(
      `SELECT m.*, p.key AS provider_key FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
       WHERE ($1::uuid IS NULL OR m.provider_id = $1::uuid) ORDER BY p.key, m.model_name`,
      [providerId ?? null],
    );
    return { items: rows };
  });

  app.get('/ai/task-bindings', { preHandler: guard('ai:read') }, async (): Promise<{ items: AiTaskBindingRow[] }> => {
    const rows = await q<Record<string, unknown>>(
      `SELECT b.*, p.key AS provider_key, p.name AS provider_name, m.model_name
       FROM ai_task_bindings b
       JOIN ai_providers p ON p.id = b.provider_id
       JOIN ai_models m ON m.id = b.model_id
       ORDER BY b.task_type, b.priority`,
    );

    const byTask = new Map<string, AiTaskBindingRow>();
    for (const r of rows) {
      const task = r.task_type as AiTaskType;
      if (!byTask.has(task)) byTask.set(task, { taskType: task, chain: [] });
      byTask.get(task)!.chain.push({
        providerId: r.provider_id as string,
        providerKey: r.provider_key as string,
        providerName: r.provider_name as string,
        modelId: r.model_id as string,
        modelName: r.model_name as string,
        priority: Number(r.priority),
        enabled: Boolean(r.enabled),
      });
    }
    return { items: [...byTask.values()] };
  });

  app.put('/ai/task-bindings/:taskType', { preHandler: guard('ai:write') }, async (req) => {
    const { taskType } = req.params as { taskType: string };
    const body = req.body as { chain: Array<{ providerId: string; modelId: string; maxTokens?: number }> };
    if (!Array.isArray(body?.chain)) throw invalid('chain 必须是数组');

    const actor = actorOf(req);
    await tx(async (t) => {
      await t.exec('DELETE FROM ai_task_bindings WHERE task_type = $1::ai_task_type', [taskType]);
      let priority = 100;
      for (const item of body.chain) {
        await t.exec(
          `INSERT INTO ai_task_bindings (id, task_type, provider_id, model_id, priority, max_tokens)
           VALUES ($1,$2::ai_task_type,$3,$4,$5,$6)`,
          [uuidv7(), taskType, item.providerId, item.modelId, priority, item.maxTokens ?? null],
        );
        priority += 10;
      }
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'ai.task_binding.replace',
        resourceType: 'ai_task_binding', resourceId: taskType, afterState: body,
      });
    });
    return { ok: true };
  });

  app.get('/ai/usage', { preHandler: guard('ai:read') }, async (req) => {
    const { groupBy } = req.query as { groupBy?: string };
    const col = groupBy === 'model' ? 'm.model_name' : 'p.key';
    const rows = await q<Record<string, unknown>>(
      `SELECT ${col} AS key,
              count(*)::int AS calls,
              sum(u.prompt_tokens + u.completion_tokens)::int AS tokens,
              round(sum(u.cost_usd), 6)::text AS cost_usd,
              round(avg(u.latency_ms))::int AS avg_latency_ms,
              count(*) FILTER (WHERE NOT u.success)::int AS errors
       FROM ai_usage_records u
       JOIN ai_providers p ON p.id = u.provider_id
       LEFT JOIN ai_models m ON m.id = u.model_id
       WHERE u.occurred_at >= now() - interval '30 days'
       GROUP BY 1 ORDER BY 2 DESC`,
    );
    return { items: rows };
  });
}
