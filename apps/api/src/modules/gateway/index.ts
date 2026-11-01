import type { FastifyInstance } from 'fastify';
import type { GatewayConfigRow, GatewayInstanceRow } from '@proxyforge/contracts';
import { exec, q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit } from '../../shared/events.js';
import { notFound } from '../../shared/errors.js';
import { applyPolicies, defaultInstanceId } from '../policy/index.js';

export async function registerGatewayRoutes(app: FastifyInstance): Promise<void> {
  app.get('/gateway/instances', { preHandler: guard('gateway:read') }, async (): Promise<{ items: GatewayInstanceRow[] }> => {
    const rows = await q<Record<string, unknown>>('SELECT * FROM gateway_instances ORDER BY created_at ASC');
    return {
      items: rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        engine: r.engine as string,
        status: r.status as string,
        bindHost: r.bind_host as string,
        httpPort: Number(r.http_port),
        socksPort: Number(r.socks_port),
        activeConfigVersion: (r.active_config_version as number) ?? null,
        lastSeenAt: (r.last_seen_at as string) ?? null,
      })),
    };
  });

  app.get('/gateway/configs', { preHandler: guard('gateway:read') }, async (req): Promise<{ items: GatewayConfigRow[] }> => {
    const { instanceId } = req.query as { instanceId?: string };
    const id = instanceId ?? (await defaultInstanceId());
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM gateway_configs WHERE instance_id = $1 ORDER BY version DESC LIMIT 50`,
      [id],
    );
    return {
      items: rows.map((r) => ({
        id: r.id as string,
        instanceId: r.instance_id as string,
        version: Number(r.version),
        status: r.status as GatewayConfigRow['status'],
        configHash: r.config_hash as string,
        renderedConfig: r.rendered_config as string,
        policyIds: (r.policy_ids as string[]) ?? [],
        warnings: (r.warnings as GatewayConfigRow['warnings']) ?? [],
        error: (r.error as string) ?? null,
        appliedAt: (r.applied_at as string) ?? null,
        createdAt: String(r.created_at),
      })),
    };
  });

  app.get('/gateway/configs/:version', { preHandler: guard('gateway:read') }, async (req) => {
    const { version } = req.params as { version: string };
    const instanceId = await defaultInstanceId();
    const row = await q1<Record<string, unknown>>(
      'SELECT * FROM gateway_configs WHERE instance_id = $1 AND version = $2',
      [instanceId, Number(version)],
    );
    if (!row) throw notFound('配置版本');
    return {
      id: row.id,
      version: Number(row.version),
      status: row.status,
      configHash: row.config_hash,
      renderedConfig: row.rendered_config,
      warnings: row.warnings,
      appliedAt: row.applied_at,
      createdAt: row.created_at,
    };
  });

  app.post('/gateway/reload', { preHandler: guard('gateway:apply') }, async (req) => {
    const actor = actorOf(req);
    // 强制重编译必须覆盖**所有**实例：
    // 只刷正式实例会让实验实例停留在旧配置上，形成"看得见但没生效"的假象。
    const instances = await q<{ id: string; name: string }>(
      'SELECT id, name FROM gateway_instances ORDER BY created_at ASC, id ASC',
    );
    if (instances.length === 0) throw notFound('网关实例');

    const applied = [];
    for (const inst of instances) {
      const res = await applyPolicies(inst.id, actor.id);
      applied.push({ ...res, name: inst.name });
    }

    const primaryId = await defaultInstanceId();
    const primary = applied.find((a) => a.instanceId === primaryId) ?? applied[0]!;
    return {
      version: primary.version,
      configHash: primary.configHash,
      warnings: primary.warnings,
      policyCount: primary.policyCount,
      memberCount: primary.memberCount,
      instances: applied.map((a) => ({
        instanceId: a.instanceId,
        name: a.name,
        version: a.version,
        memberCount: a.memberCount,
        policyCount: a.policyCount,
        warnings: a.warnings,
      })),
    };
  });

  app.post('/gateway/configs/:version/rollback', { preHandler: guard('gateway:apply') }, async (req) => {
    const { version } = req.params as { version: string };
    const actor = actorOf(req);
    const instanceId = await defaultInstanceId();

    const target = await q1<{ id: string; rendered_config: string; config_hash: string; policy_ids: string[] }>(
      'SELECT id, rendered_config, config_hash, policy_ids FROM gateway_configs WHERE instance_id = $1 AND version = $2',
      [instanceId, Number(version)],
    );
    if (!target) throw notFound('配置版本');

    await tx(async (t) => {
      const cur = await t.q1<{ v: string }>(
        'SELECT COALESCE(max(version),0)::text AS v FROM gateway_configs WHERE instance_id = $1',
        [instanceId],
      );
      const next = Number(cur?.v ?? 0) + 1;

      await t.exec(`UPDATE gateway_configs SET status = 'SUPERSEDED' WHERE instance_id = $1 AND status = 'APPLIED'`, [instanceId]);
      // 回滚不是"改写历史"，而是把旧配置作为新版本重新下发
      await t.exec(
        `INSERT INTO gateway_configs
           (id, instance_id, version, status, config_hash, rendered_config, policy_ids, warnings, applied_at, created_by)
         VALUES (gen_random_uuid(), $1, $2, 'ROLLED_BACK', $3, $4, $5::uuid[], '[]'::jsonb, now(), $6)`,
        [instanceId, next, target.config_hash, target.rendered_config, target.policy_ids, actor.id],
      );
      await t.exec(
        'UPDATE gateway_instances SET active_config_version = $2, status = $3, last_seen_at = now() WHERE id = $1',
        [instanceId, next, 'APPLIED'],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'gateway.config.rollback',
        resourceType: 'gateway_instance', resourceId: instanceId,
        afterState: { rolledBackTo: Number(version), newVersion: next },
      });
    });

    return { ok: true, rolledBackTo: Number(version) };
  });

  app.get('/gateway/traffic', { preHandler: guard('gateway:read') }, async (req) => {
    const { policyKey, hours } = req.query as { policyKey?: string; hours?: string };
    const h = Math.min(Number(hours ?? 24), 168);
    const rows = await q<Record<string, unknown>>(
      `SELECT date_trunc('hour', sampled_at) AS bucket,
              sum(connections)::int AS connections,
              sum(bytes_in)::bigint AS bytes_in,
              sum(bytes_out)::bigint AS bytes_out,
              sum(errors)::int AS errors
       FROM gateway_traffic_samples
       WHERE sampled_at >= now() - ($1 || ' hours')::interval
         AND ($2::text IS NULL OR policy_key = $2)
       GROUP BY 1 ORDER BY 1`,
      [h, policyKey ?? null],
    );
    return { items: rows };
  });
}

export { exec as _e };
