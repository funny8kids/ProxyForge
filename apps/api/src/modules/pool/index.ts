import type { FastifyInstance } from 'fastify';
import type { PoolDetail, PoolMemberRow, PoolSummary, TrustTier } from '@proxyforge/contracts';
import { exec, q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit, emit, EVENT_TYPES } from '../../shared/events.js';
import { invalid, notFound } from '../../shared/errors.js';
import { slugify, uuidv7 } from '../../shared/id.js';
import { compilePredicate } from './rules.js';
import { toTextArray } from '../../shared/pg-array.js';

interface PoolRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  purpose: string | null;
  min_quality: string;
  max_members: number | null;
  member_count: number;
  allowed_tiers: TrustTier[];
  experimental: boolean;
  enabled: boolean;
  version: string;
  healthy: string | null;
  degraded: string | null;
  avg_quality: string | null;
}

function toSummary(r: PoolRow): PoolSummary {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    purpose: r.purpose,
    minQuality: Number(r.min_quality),
    maxMembers: r.max_members,
    memberCount: r.member_count,
    allowedTiers: r.allowed_tiers,
    experimental: r.experimental,
    enabled: r.enabled,
    version: Number(r.version),
    health: {
      healthy: Number(r.healthy ?? 0),
      degraded: Number(r.degraded ?? 0),
      avgQuality: r.avg_quality === null ? null : Number(r.avg_quality),
    },
  };
}

const POOL_SELECT = `
  SELECT p.*, 
         (SELECT count(*) FROM resource_pool_members m JOIN proxy_endpoints e ON e.id = m.endpoint_id
          WHERE m.pool_id = p.id AND m.suppressed = false AND e.lifecycle_status = 'HEALTHY')::text AS healthy,
         (SELECT count(*) FROM resource_pool_members m JOIN proxy_endpoints e ON e.id = m.endpoint_id
          WHERE m.pool_id = p.id AND m.suppressed = false AND e.lifecycle_status = 'DEGRADED')::text AS degraded,
         (SELECT round(avg(e.quality_score), 2) FROM resource_pool_members m
          JOIN proxy_endpoints e ON e.id = m.endpoint_id
          WHERE m.pool_id = p.id AND m.suppressed = false)::text AS avg_quality
  FROM resource_pools p
`;

/**
 * 重算池成员。
 *
 * 四道闸门按顺序收紧，任何一道都不能绕过：
 *   1. 规则谓词（结构化 DSL，字段白名单）
 *   2. allowed_tiers（分级准入）—— PUBLIC_PROXY 默认进不来
 *   3. 生命周期（只有 HEALTHY / DEGRADED 算成员）
 *   4. min_quality / max_members（容量与质量底线）
 *
 * 第 2 道是关键：即使规则里写了 trustTier in (PUBLIC_PROXY)，
 * 只要池的 allowed_tiers 不含 PUBLIC_PROXY，成员依然进不来。
 *
 * 第 3 道保证 member_count 与"能下发多少"是同一个数。
 * 少了它，池子看起来是满的、订阅却是空的，而两个数字都"没错"。
 */
export async function recomputePool(poolId: string, actorId?: string): Promise<{ added: number; removed: number }> {
  return tx(async (t) => {
    const pool = await t.q1<{
      id: string; key: string; min_quality: string; max_members: number | null;
      allowed_tiers: TrustTier[]; enabled: boolean; experimental: boolean;
    }>(
      'SELECT id, key, min_quality, max_members, allowed_tiers, enabled, experimental FROM resource_pools WHERE id = $1',
      [poolId],
    );
    if (!pool) throw notFound('资源池');
    if (!pool.enabled) return { added: 0, removed: 0 };

    // 成员集合 = 规则命中的端点（MANUAL 成员另行保留，不参与本次计算）
    const rules = await t.q<{ predicate: unknown }>(
      'SELECT predicate FROM resource_pool_rules WHERE pool_id = $1 AND enabled = true ORDER BY rule_order',
      [poolId],
    );

    const selected = new Map<string, number>(); // endpointId -> weight

    for (const rule of rules) {
      const compiled = compilePredicate(rule.predicate, 2);
      const rows = await t.q<{ id: string; quality_score: string }>(
        `SELECT e.id, s.quality_score
         FROM proxy_endpoints e
         JOIN endpoint_health_state s ON s.endpoint_id = e.id
         LEFT JOIN ip_assets i ON i.id = e.ip_asset_id
         WHERE e.deleted_at IS NULL
           AND e.trust_tier::text = ANY($1::text[])
           -- 只有活着的端点算池成员，与订阅视图同口径。
           -- 不加这条时，池的 member_count 会包含大量已判定不可用的端点：
           -- 界面上写着"实验池 120 个成员"，实际能下发的只有几个，
           -- 而 max_members 的 120 个名额也会被死节点占着。
           AND e.lifecycle_status IN ('HEALTHY', 'DEGRADED')
           AND s.quality_score >= ${Number(pool.min_quality)}
           AND ${compiled.sql}`,
        [toTextArray(pool.allowed_tiers), ...compiled.params],
      );      for (const r of rows) {
        if (!selected.has(r.id)) selected.set(r.id, 100);
      }
    }

    // 容量上限：按质量分保留最优
    let entries = [...selected.entries()];
    if (pool.max_members !== null && entries.length > pool.max_members) {
      const scored = await t.q<{ id: string; quality_score: string }>(
        `SELECT endpoint_id AS id, quality_score FROM endpoint_health_state WHERE endpoint_id = ANY($1::uuid[])
         ORDER BY quality_score DESC`,
        [entries.map(([id]) => id)],
      );
      const keep = new Set(scored.slice(0, pool.max_members).map((r) => r.id));
      entries = entries.filter(([id]) => keep.has(id));
    }

    // 差量写：先算「应该是什么」，再和「现在是什么」比。
    //
    // 之前是「全删 AUTO 再全插」，两个问题：
    //   1. 每次重算都重写全部成员行（本例 137 行），而 worker 每 15s 跑一轮，
    //      在单写者的 PGlite 上会把连接占住，前端请求排队等它；
    //   2. 即使集合没变也照发 POOL_MEMBERSHIP_CHANGED 事件，事件流被无意义
    //      的"成员变了 0 个"填满，真正的变化反而被淹掉。
    // 现在：集合没变就直接返回，不发事件、不写库。
    const current = await t.q<{ endpoint_id: string; weight: number; source: string }>(
      'SELECT endpoint_id, weight, source FROM resource_pool_members WHERE pool_id = $1',
      [poolId],
    );
    const manual = new Set(current.filter((r) => r.source !== 'AUTO').map((r) => r.endpoint_id));
    const existing = new Set(current.map((r) => r.endpoint_id));

    const desired = new Map(entries);
    // 只按**集合**比较，不比 weight。
    // weight 是人工/种子设定的调度权重，规则引擎决定的是"谁在池里"，
    // 不该顺手把权重抹平成 100 —— 那会让 WEIGHTED 策略失去意义。
    const toAdd = [...desired.keys()].filter((id) => !manual.has(id) && !existing.has(id));
    const toRemove = current
      .filter((r) => r.source === 'AUTO' && !desired.has(r.endpoint_id))
      .map((r) => r.endpoint_id);

    if (toAdd.length === 0 && toRemove.length === 0) return { added: 0, removed: 0 };

    if (toRemove.length > 0) {
      await t.exec(
        `DELETE FROM resource_pool_members
         WHERE pool_id = $1 AND source = 'AUTO' AND endpoint_id = ANY($2::uuid[])`,
        [poolId, toRemove],
      );
    }

    for (const endpointId of toAdd) {
      await t.exec(
        `INSERT INTO resource_pool_members (id, pool_id, endpoint_id, source, weight)
         VALUES ($1,$2,$3,'AUTO',$4)
         ON CONFLICT (pool_id, endpoint_id) DO NOTHING`,
        [uuidv7(), poolId, endpointId, desired.get(endpointId) ?? 100],
      );
    }

    const after = await t.q1<{ c: string }>(
      'SELECT count(*)::text AS c FROM resource_pool_members WHERE pool_id = $1',
      [poolId],
    );
    await t.exec('UPDATE resource_pools SET member_count = $2 WHERE id = $1', [
      poolId,
      Number(after?.c ?? 0),
    ]);

    const added = toAdd.length;
    const removed = toRemove.length;
    await emit(t, {
      type: EVENT_TYPES.POOL_MEMBERSHIP_CHANGED,
      aggregateType: 'pool',
      aggregateId: poolId,
      payload: { poolKey: pool.key, added, removedAuto: removed, actorId: actorId ?? null },
    });

    return { added, removed };
  });
}

export async function registerPoolRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pools', { preHandler: guard('pool:read') }, async (): Promise<{ items: PoolSummary[] }> => {
    const rows = await q<PoolRow>(`${POOL_SELECT} ORDER BY p.experimental ASC, p.created_at ASC`);
    return { items: rows.map(toSummary) };
  });

  app.get('/pools/:id', { preHandler: guard('pool:read') }, async (req): Promise<PoolDetail> => {
    const { id } = req.params as { id: string };
    const row = await q1<PoolRow>(`${POOL_SELECT} WHERE p.id = $1`, [id]);
    if (!row) throw notFound('资源池');

    const rules = await q<Record<string, unknown>>(
      `SELECT id, rule_order, name, predicate, enabled FROM resource_pool_rules
       WHERE pool_id = $1 ORDER BY rule_order`,
      [id],
    );

    const members = await q<Record<string, unknown>>(
      `SELECT m.endpoint_id, e.display_name, e.host, e.port, e.protocol, e.trust_tier,
              m.source, m.weight, m.suppressed, m.suppress_reason, s.quality_score, e.lifecycle_status
       FROM resource_pool_members m
       JOIN proxy_endpoints e ON e.id = m.endpoint_id
       LEFT JOIN endpoint_health_state s ON s.endpoint_id = e.id
       WHERE m.pool_id = $1
       ORDER BY s.quality_score DESC NULLS LAST
       LIMIT 200`,
      [id],
    );

    return {
      ...toSummary(row),
      rules: rules.map((r) => ({
        id: r.id as string,
        ruleOrder: Number(r.rule_order),
        name: r.name as string,
        predicate: r.predicate as Record<string, unknown>,
        enabled: Boolean(r.enabled),
      })),
      members: members.map(
        (m): PoolMemberRow => ({
          endpointId: m.endpoint_id as string,
          displayName: (m.display_name as string) ?? null,
          host: m.host as string,
          port: Number(m.port),
          protocol: m.protocol as PoolMemberRow['protocol'],
          trustTier: m.trust_tier as TrustTier,
          source: m.source as 'AUTO' | 'MANUAL',
          weight: Number(m.weight),
          suppressed: Boolean(m.suppressed),
          suppressReason: (m.suppress_reason as string) ?? null,
          qualityScore: Number(m.quality_score ?? 0),
          lifecycleStatus: m.lifecycle_status as PoolMemberRow['lifecycleStatus'],
        }),
      ),
    };
  });

  app.post('/pools', { preHandler: guard('pool:write') }, async (req) => {
    const body = req.body as {
      key?: string; name: string; description?: string; purpose?: string;
      minQuality?: number; maxMembers?: number | null;
      allowedTiers?: TrustTier[]; experimental?: boolean;
    };
    if (!body?.name) throw invalid('name 必填');

    const allowedTiers = body.allowedTiers ?? ['PRIVATE_PROXY', 'VERIFIED_PROXY'];
    // 含 PUBLIC_PROXY 的池必须是实验池 —— 与 DB CHECK 一致，这里提前给出可读错误
    if (allowedTiers.includes('PUBLIC_PROXY') && !body.experimental) {
      throw invalid('允许 PUBLIC_PROXY 的池必须标记 experimental=true', [
        { field: 'experimental', message: '公开代理只能进入显式声明的实验池' },
      ]);
    }

    const actor = actorOf(req);
    const id = uuidv7();
    const key = body.key ?? slugify(body.name, 'pool');

    await tx(async (t) => {
      await t.exec(
        `INSERT INTO resource_pools (id, key, name, description, purpose, min_quality, max_members, allowed_tiers, experimental)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::trust_tier[],$9)`,
        [id, key, body.name, body.description ?? null, body.purpose ?? null,
         body.minQuality ?? 0, body.maxMembers ?? null, allowedTiers, body.experimental ?? false],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'pool.create',
        resourceType: 'pool', resourceId: id, afterState: body,
      });
    });

    return { id, key };
  });

  app.patch('/pools/:id', { preHandler: guard('pool:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      name?: string; description?: string; minQuality?: number;
      maxMembers?: number | null; allowedTiers?: TrustTier[]; experimental?: boolean; enabled?: boolean;
    };
    const actor = actorOf(req);

    const result = await tx(async (t) => {
      const before = await t.q1<Record<string, unknown>>('SELECT * FROM resource_pools WHERE id = $1', [id]);
      if (!before) throw notFound('资源池');

      const tiers = body.allowedTiers ?? (before.allowed_tiers as TrustTier[]);
      const experimental = body.experimental ?? Boolean(before.experimental);
      if (tiers.includes('PUBLIC_PROXY') && !experimental) {
        throw invalid('允许 PUBLIC_PROXY 的池必须标记 experimental=true');
      }

      await t.exec(
        `UPDATE resource_pools SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           min_quality = COALESCE($4, min_quality),
           max_members = $5,
           allowed_tiers = $6::trust_tier[],
           experimental = $7,
           enabled = COALESCE($8, enabled)
         WHERE id = $1`,
        [id, body.name ?? null, body.description ?? null, body.minQuality ?? null,
         body.maxMembers === undefined ? before.max_members : body.maxMembers,
         tiers, experimental, body.enabled ?? null],
      );

      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'pool.update',
        resourceType: 'pool', resourceId: id,
        beforeState: before, afterState: body,
      });

      return t.q1<PoolRow>(`${POOL_SELECT} WHERE p.id = $1`, [id]);
    });

    return toSummary(result!);
  });

  app.post('/pools/:id/rules', { preHandler: guard('pool:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name: string; predicate: unknown; ruleOrder?: number };
    if (!body?.name) throw invalid('name 必填');

    // 先编译一次，把非法谓词挡在入库前
    compilePredicate(body.predicate);

    const ruleId = uuidv7();
    await tx(async (t) => {
      const order =
        body.ruleOrder ??
        ((await t.q1<{ m: string }>(
          'SELECT COALESCE(max(rule_order), 0)::text AS m FROM resource_pool_rules WHERE pool_id = $1',
          [id],
        ))?.m ?? '0');
      await t.exec(
        `INSERT INTO resource_pool_rules (id, pool_id, rule_order, name, predicate)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [ruleId, id, Number(order) + 1, body.name, JSON.stringify(body.predicate)],
      );
    });

    return { id: ruleId };
  });

  app.post('/pools/:id/members', { preHandler: guard('pool:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { endpointId: string; weight?: number };
    if (!body?.endpointId) throw invalid('endpointId 必填');

    const actor = actorOf(req);
    const pool = await q1<{ allowed_tiers: TrustTier[] }>(
      'SELECT allowed_tiers FROM resource_pools WHERE id = $1',
      [id],
    );
    if (!pool) throw notFound('资源池');

    const ep = await q1<{ trust_tier: TrustTier }>(
      'SELECT trust_tier FROM proxy_endpoints WHERE id = $1 AND deleted_at IS NULL',
      [body.endpointId],
    );
    if (!ep) throw notFound('资源');

    // 手工加成员同样受分级准入约束 —— 否则"人工"就成了绕过 SEC-001 的后门
    if (!pool.allowed_tiers.includes(ep.trust_tier)) {
      throw invalid(`该池不接受 ${ep.trust_tier} 分级的成员`, [
        { field: 'endpointId', message: `池允许的分级: ${pool.allowed_tiers.join(', ')}` },
      ]);
    }

    await tx(async (t) => {
      await t.exec(
        `INSERT INTO resource_pool_members (id, pool_id, endpoint_id, source, weight, added_by)
         VALUES ($1,$2,$3,'MANUAL',$4,$5)
         ON CONFLICT (pool_id, endpoint_id) DO UPDATE SET source = 'MANUAL', weight = EXCLUDED.weight, suppressed = false`,
        [uuidv7(), id, body.endpointId, body.weight ?? 100, actor.id],
      );
      await t.exec(
        `UPDATE resource_pools SET member_count =
           (SELECT count(*) FROM resource_pool_members WHERE pool_id = $1) WHERE id = $1`,
        [id],
      );
    });

    return { ok: true };
  });

  app.delete('/pools/:id/members/:endpointId', { preHandler: guard('pool:write') }, async (req) => {
    const { id, endpointId } = req.params as { id: string; endpointId: string };
    const n = await exec('DELETE FROM resource_pool_members WHERE pool_id = $1 AND endpoint_id = $2', [
      id,
      endpointId,
    ]);
    if (n === 0) throw notFound('成员');
    await exec(
      `UPDATE resource_pools SET member_count =
         (SELECT count(*) FROM resource_pool_members WHERE pool_id = $1) WHERE id = $1`,
      [id],
    );
    return { ok: true };
  });

  app.post('/pools/:id/recompute', { preHandler: guard('pool:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);
    return recomputePool(id, actor.id);
  });

  app.get('/pools/:id/members', { preHandler: guard('pool:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await q<Record<string, unknown>>(
      `SELECT m.endpoint_id, e.display_name, e.host, e.port, e.protocol, e.trust_tier,
              m.source, m.weight, m.suppressed, m.suppress_reason, s.quality_score, e.lifecycle_status
       FROM resource_pool_members m
       JOIN proxy_endpoints e ON e.id = m.endpoint_id
       LEFT JOIN endpoint_health_state s ON s.endpoint_id = e.id
       WHERE m.pool_id = $1 ORDER BY s.quality_score DESC NULLS LAST`,
      [id],
    );
    return { items: rows };
  });
}
