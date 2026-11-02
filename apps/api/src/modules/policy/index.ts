import type { FastifyInstance } from 'fastify';
import type { CompileWarning, PolicyRow, PolicyStrategy, ProxyProtocol, TrustTier } from '@proxyforge/contracts';
import { exec, q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit, emit, EVENT_TYPES } from '../../shared/events.js';
import { invalid, notFound } from '../../shared/errors.js';
import { slugify, uuidv7 } from '../../shared/id.js';
import { toTextArray } from '../../shared/pg-array.js';
import { compilePolicy, type CompileOutput } from './compiler.js';
import { configHash, renderGatewayConfig } from '../gateway/render.js';

/**
 * 策略变更 → 网关配置，是**同步强一致**的（模块设计 §3）。
 * 用户点保存后必须立刻看到编译结果或明确失败，
 * 而不是"稍后异步生效"——那样排障成本高一个数量级。
 */

export interface ApplyResult {
  instanceId: string;
  version: number;
  configHash: string;
  warnings: CompileWarning[];
  policyCount: number;
  memberCount: number;
  /** false = 内容与当前生效版本一致，未产生新版本 */
  changed: boolean;
}

/**
 * 把编译结果转成引擎消费的结构化规格。
 *
 * 只保留"要连谁、怎么连"—— 不含凭据、不含质量分、不含授权状态。
 * 那些是编译期的判断依据，运行期只需要结果。
 */
function buildRuntimeSpec(instanceName: string, compiled: CompileOutput[]): {
  instanceName: string;
  policies: Array<{
    policyKey: string; listenPort: number; strategy: string;
    members: Array<{ endpointId: string; host: string; port: number; protocol: string }>;
  }>;
} {
  return {
    instanceName,
    policies: compiled
      .filter((c) => c.policy.members.length > 0)
      .map((c) => ({
        policyKey: c.policy.policyKey,
        listenPort: c.policy.listenPort,
        strategy: c.policy.strategy,
        members: c.policy.members.map((m) => ({
          endpointId: m.endpointId,
          host: m.host,
          port: m.port,
          protocol: m.protocol,
        })),
      })),
  };
}

export async function applyPolicies(instanceId: string, actorId: string | null): Promise<ApplyResult> {
  const instance = await q1<{ id: string; name: string }>(
    'SELECT id, name FROM gateway_instances WHERE id = $1',
    [instanceId],
  );
  if (!instance) throw notFound('网关实例');

  const policies = await q<{
    id: string; key: string; strategy: PolicyStrategy; listen_port: number;
    pool_id: string; pool_key: string; pool_experimental: boolean;
    pool_allowed_tiers: TrustTier[]; min_quality: string;
    max_members: number | null; protocol_filter: ProxyProtocol[]; region_filter: string[];
  }>(
    // 只编译绑定到本实例的策略。
    // 未绑定（instance_id IS NULL）的策略一律跳过 —— 宁可少下发，不可错下发，
    // 否则实验策略的监听器会被写进正式实例，直接违反 SEC-001 §6.2。
    `SELECT p.id, p.key, p.strategy, p.listen_port, p.pool_id,
            pl.key AS pool_key, pl.experimental AS pool_experimental,
            pl.allowed_tiers AS pool_allowed_tiers, pl.min_quality,
            p.max_members, p.protocol_filter, p.region_filter
     FROM routing_policies p
     JOIN resource_pools pl ON pl.id = p.pool_id
     WHERE p.enabled = true AND p.instance_id = $1
     ORDER BY p.priority ASC, p.listen_port ASC`,
    [instanceId],
  );

  const unbound = await q1<{ c: string }>(
    'SELECT count(*)::text AS c FROM routing_policies WHERE instance_id IS NULL AND enabled = true',
  );

  const compiled: CompileOutput[] = [];
  const allWarnings: CompileWarning[] = [];

  for (const p of policies) {
    const out = await compilePolicy({
      poolId: p.pool_id,
      poolKey: p.pool_key,
      poolExperimental: p.pool_experimental,
      // ENUM 数组列可能被驱动返回成 PG 字面量字符串，必须归一化后再用。
      // 直接拿字符串做 `length > 0` 判断会静默加上空集合过滤，编译出 0 成员。
      poolAllowedTiers: toTextArray(p.pool_allowed_tiers) as TrustTier[],
      minQuality: Number(p.min_quality),
      maxMembers: p.max_members,
      strategy: p.strategy,
      protocolFilter: toTextArray(p.protocol_filter) as ProxyProtocol[],
      regionFilter: toTextArray(p.region_filter),
      listenPort: p.listen_port,
      policyKey: p.key,
    });
    compiled.push(out);
    allWarnings.push(...out.policy.warnings);
  }

  if (Number(unbound?.c ?? 0) > 0) {
    allWarnings.push({
      code: 'POLICY_UNBOUND',
      message: `${unbound?.c} 条启用中的策略未绑定网关实例，本次编译已跳过`,
      count: Number(unbound?.c ?? 0),
    });
  }

  const rendered = renderGatewayConfig({
    instanceName: instance.name,
    policies: compiled,
    warnings: allWarnings,
  });
  const hash = configHash(rendered);

  const memberCount = compiled.reduce((s, c) => s + c.policy.members.length, 0);

  // 内容没变就不产生新版本。
  //
  // worker 每 15s 重新编译一次（成员随健康态漂移）。如果每次都插一条新版本：
  //   · gateway_configs 无界增长，每条都存整份 YAML；
  //   · 版本号对用户失去意义（"v27"其实和 v3 一模一样）；
  //   · 每条都发 GATEWAY_CONFIG_APPLIED 事件，审计流被噪声填满。
  // configHash 已排除 generated-at，所以"同内容 ⇒ 同 hash"成立。
  const active = await q1<{ version: number; config_hash: string }>(
    `SELECT version, config_hash FROM gateway_configs
     WHERE instance_id = $1 AND status = 'APPLIED'
     ORDER BY version DESC LIMIT 1`,
    [instanceId],
  );
  if (active && active.config_hash === hash) {
    // 内容没变不产生新版本，但 runtime_spec 仍要刷新：
    // 它可能在旧版本里是空的（比如升级前编译的），而运行时靠它启动。
    // 不刷新就会出现"编译成功、hash 一致、但引擎拿到空规格起不来"。
    const runtimeSpec = buildRuntimeSpec(instance.name, compiled);
    await exec(
      `UPDATE gateway_configs SET runtime_spec = $3::jsonb
       WHERE instance_id = $1 AND version = $2`,
      [instanceId, Number(active.version), JSON.stringify(runtimeSpec)],
    );
    return {
      instanceId,
      version: Number(active.version),
      configHash: hash,
      warnings: allWarnings,
      policyCount: policies.length,
      memberCount,
      changed: false,
    };
  }

  const version = await tx(async (t) => {
    const cur = await t.q1<{ v: string }>(
      'SELECT COALESCE(max(version), 0)::text AS v FROM gateway_configs WHERE instance_id = $1',
      [instanceId],
    );
    const next = Number(cur?.v ?? 0) + 1;

    await t.exec(
      `UPDATE gateway_configs SET status = 'SUPERSEDED'
       WHERE instance_id = $1 AND status = 'APPLIED'`,
      [instanceId],
    );

    const configId = uuidv7();
    // 引擎消费的结构化规格。刻意**不含凭据** —— 这份 JSON 会和 YAML 一起
    // 进版本历史，把 credential_ref 写进来等于让"谁引用了哪个密钥"
    // 变成可查询的历史记录。运行时按 endpointId 单独查凭据。
    const runtimeSpec = buildRuntimeSpec(instance.name, compiled);

    await t.exec(
      `INSERT INTO gateway_configs
         (id, instance_id, version, status, config_hash, rendered_config, runtime_spec, policy_ids, warnings, applied_at, created_by)
       VALUES ($1,$2,$3,'APPLIED',$4,$5,$6::jsonb,$7::uuid[],$8::jsonb, now(), $9)`,
      [
        configId, instanceId, next, hash, rendered, JSON.stringify(runtimeSpec),
        policies.map((p) => p.id), JSON.stringify(allWarnings), actorId,
      ],
    );

    // 只更新"配置指向哪一版"。status 由 runtime supervisor 独占写入 ——
    // 编译成功不代表进程在跑，两件事混用一个字段就会互相覆盖，
    // 表现是界面上一会儿显示 APPLIED 一会儿显示 RUNNING。
    await t.exec(
      `UPDATE gateway_instances SET active_config_version = $2, last_seen_at = now()
       WHERE id = $1`,
      [instanceId, next],
    );

    await audit(t, {
      actorType: actorId ? 'USER' : 'SYSTEM',
      actorId,
      action: 'gateway.config.apply',
      resourceType: 'gateway_instance',
      resourceId: instanceId,
      afterState: { version: next, hash, policyCount: policies.length, memberCount },
    });

    await emit(t, {
      type: EVENT_TYPES.GATEWAY_CONFIG_APPLIED,
      aggregateType: 'gateway_instance',
      aggregateId: instanceId,
      payload: { version: next, hash, memberCount },
    });

    return next;
  });

  return {
    instanceId,
    version,
    configHash: hash,
    warnings: allWarnings,
    policyCount: policies.length,
    memberCount,
    changed: true,
  };
}

/** 默认网关实例（单实例部署时用） */
export async function defaultInstanceId(): Promise<string> {
  // 注意：同一事务内 now() 相同，只按 created_at 排序是不确定的。
  // uuidv7 单调递增，作为次序键才能稳定反映插入顺序。
  // 优先选已有生效配置的实例，其次按插入顺序取第一个。
  const row = await q1<{ id: string }>(
    `SELECT id FROM gateway_instances
     ORDER BY (active_config_version IS NULL) ASC, created_at ASC, id ASC
     LIMIT 1`,
  );
  if (!row) throw notFound('网关实例');
  return row.id;
}

export async function registerPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/policies', { preHandler: guard('policy:read') }, async (): Promise<{ items: PolicyRow[] }> => {
    const rows = await q<Record<string, unknown>>(
      `SELECT p.*, pl.key AS pool_key FROM routing_policies p
       JOIN resource_pools pl ON pl.id = p.pool_id
       ORDER BY p.priority ASC, p.listen_port ASC`,
    );
    return {
      items: rows.map((r) => ({
        id: r.id as string,
        key: r.key as string,
        name: r.name as string,
        strategy: r.strategy as PolicyStrategy,
        poolId: r.pool_id as string,
        poolKey: r.pool_key as string,
        instanceId: (r.instance_id as string) ?? null,
        listenPort: Number(r.listen_port),
        enabled: Boolean(r.enabled),
        priority: Number(r.priority),
        regionFilter: (r.region_filter as string[]) ?? [],
        protocolFilter: (r.protocol_filter as ProxyProtocol[]) ?? [],
        maxMembers: (r.max_members as number) ?? null,
        stickyTtlSeconds: Number(r.sticky_ttl_seconds),
        version: Number(r.version),
      })),
    };
  });

  app.post('/policies', { preHandler: guard('policy:write') }, async (req) => {
    const body = req.body as {
      key?: string; name: string; strategy: PolicyStrategy; poolId: string;
      listenPort: number; priority?: number; maxMembers?: number | null;
      protocolFilter?: ProxyProtocol[]; regionFilter?: string[]; stickyTtlSeconds?: number;
    };
    if (!body?.name) throw invalid('name 必填');
    if (!body?.poolId) throw invalid('poolId 必填');
    if (!body?.listenPort) throw invalid('listenPort 必填');
    if (!body?.strategy) throw invalid('strategy 必填');

    const actor = actorOf(req);
    const id = uuidv7();
    const key = body.key ?? slugify(body.name, 'policy');

    const dup = await q1<{ id: string }>('SELECT id FROM routing_policies WHERE listen_port = $1', [
      body.listenPort,
    ]);
    if (dup) {
      throw invalid(`端口 ${body.listenPort} 已被其他策略占用`, [
        { field: 'listenPort', message: '一个策略独占一个监听端口' },
      ]);
    }

    await tx(async (t) => {
      await t.exec(
        `INSERT INTO routing_policies
           (id, key, name, strategy, pool_id, listen_port, priority, max_members,
            protocol_filter, region_filter, sticky_ttl_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::proxy_protocol[],$10::text[],$11)`,
        [
          id, key, body.name, body.strategy, body.poolId, body.listenPort,
          body.priority ?? 100, body.maxMembers ?? null,
          body.protocolFilter ?? [], body.regionFilter ?? [], body.stickyTtlSeconds ?? 1800,
        ],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'policy.create',
        resourceType: 'policy', resourceId: id, afterState: body,
      });
    });

    // 同步编译下发
    const instanceId = await defaultInstanceId();
    const applied = await applyPolicies(instanceId, actor.id);
    return { id, key, applied };
  });

  app.patch('/policies/:id', { preHandler: guard('policy:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const actor = actorOf(req);

    const before = await q1<Record<string, unknown>>('SELECT * FROM routing_policies WHERE id = $1', [id]);
    if (!before) throw notFound('策略');

    await tx(async (t) => {
      await t.exec(
        `UPDATE routing_policies SET
           name = COALESCE($2, name),
           strategy = COALESCE($3::policy_strategy, strategy),
           priority = COALESCE($4, priority),
           max_members = $5,
           enabled = COALESCE($6, enabled),
           protocol_filter = COALESCE($7::proxy_protocol[], protocol_filter),
           sticky_ttl_seconds = COALESCE($8, sticky_ttl_seconds)
         WHERE id = $1`,
        [
          id,
          (body.name as string) ?? null,
          (body.strategy as string) ?? null,
          (body.priority as number) ?? null,
          body.maxMembers === undefined ? before.max_members : body.maxMembers,
          (body.enabled as boolean) ?? null,
          (body.protocolFilter as string[]) ?? null,
          (body.stickyTtlSeconds as number) ?? null,
        ],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'policy.update',
        resourceType: 'policy', resourceId: id, beforeState: before, afterState: body,
      });
    });

    const instanceId = await defaultInstanceId();
    return { id, applied: await applyPolicies(instanceId, actor.id) };
  });

  app.delete('/policies/:id', { preHandler: guard('policy:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);
    const n = await exec('DELETE FROM routing_policies WHERE id = $1', [id]);
    if (n === 0) throw notFound('策略');
    const instanceId = await defaultInstanceId();
    return { ok: true, applied: await applyPolicies(instanceId, actor.id) };
  });

  // 编译预览：不落库、不下发，只看"如果现在编译会选中谁"
  app.post('/policies/preview', { preHandler: guard('policy:read') }, async (req) => {
    const body = req.body as { poolId: string; strategy?: PolicyStrategy; listenPort?: number; maxMembers?: number | null };
    if (!body?.poolId) throw invalid('poolId 必填');

    const pool = await q1<{
      key: string; experimental: boolean; allowed_tiers: TrustTier[]; min_quality: string;
    }>('SELECT key, experimental, allowed_tiers, min_quality FROM resource_pools WHERE id = $1', [body.poolId]);
    if (!pool) throw notFound('资源池');

    return compilePolicy({
      poolId: body.poolId,
      poolKey: pool.key,
      poolExperimental: pool.experimental,
      poolAllowedTiers: pool.allowed_tiers,
      minQuality: Number(pool.min_quality),
      maxMembers: body.maxMembers ?? null,
      strategy: body.strategy ?? 'FASTEST',
      protocolFilter: [],
      regionFilter: [],
      listenPort: body.listenPort ?? 18080,
      policyKey: 'preview',
    });
  });
}
