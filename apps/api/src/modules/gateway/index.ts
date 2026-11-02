import type { FastifyInstance } from 'fastify';
import type { GatewayConfigRow, GatewayInstanceRow } from '@proxyforge/contracts';
import { exec, q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit } from '../../shared/events.js';
import { notFound } from '../../shared/errors.js';
import { applyPolicies, defaultInstanceId } from '../policy/index.js';
import { applyRuntime, runtimeSnapshot, stopRuntime } from './runtime.js';

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
        // 运行时状态与编译状态分开返回：前者是"端口在不在听"，
        // 后者是"配置编到第几版"。合并成一个字段会让两者互相覆盖。
        engineKind: (r.engine_kind as string) ?? 'builtin',
        runtimeState: (r.runtime_state as string) ?? 'STOPPED',
        runtimeError: (r.runtime_error as string) ?? null,
        runtimeStartedAt: (r.runtime_started_at as string) ?? null,
        runtimeReloadAt: (r.runtime_reload_at as string) ?? null,
        listeners: (r.listeners as unknown[]) ?? [],
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
      // 编译完立刻下发给引擎 —— 只编译不下发是之前那个"配置看起来生效了
      // 但端口没人听"的根源。这里失败不回滚编译结果，但把错误带回去。
      const runtime = await applyRuntime(inst.id);
      applied.push({ ...res, name: inst.name, runtime });
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
        runtimeState: a.runtime.state,
        runtimeError: a.runtime.error,
        listeners: a.runtime.listeners,
      })),
    };
  });

  /**
   * 启动 / 停止 / 热更新单个实例的运行时。
   *
   * 和 /gateway/reload 的区别：reload 会重新编译配置（可能产生新版本），
   * 这三个只动进程，不动配置版本。排障时更需要后者 —— 改配置是"改了什么"，
   * 重启是"让它重新听"。
   */
  app.post('/gateway/instances/:id/start', { preHandler: guard('gateway:apply') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);
    const exists = await q1<{ id: string }>('SELECT id FROM gateway_instances WHERE id = $1', [id]);
    if (!exists) throw notFound('网关实例');

    const res = await applyRuntime(id);
    await tx(async (t) => {
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'gateway.runtime.start',
        resourceType: 'gateway_instance', resourceId: id,
        afterState: { state: res.state, listeners: res.listeners },
      });
    });
    return res;
  });

  app.post('/gateway/instances/:id/stop', { preHandler: guard('gateway:apply') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);
    const exists = await q1<{ id: string }>('SELECT id FROM gateway_instances WHERE id = $1', [id]);
    if (!exists) throw notFound('网关实例');

    await stopRuntime(id);
    await tx(async (t) => {
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'gateway.runtime.stop',
        resourceType: 'gateway_instance', resourceId: id,
      });
    });
    return { ok: true, state: 'STOPPED' };
  });

  /** 实时快照：来自引擎内存，比库里的落盘值新 */
  app.get('/gateway/instances/:id/runtime', { preHandler: guard('gateway:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await q1<Record<string, unknown>>(
      `SELECT id, name, engine_kind, runtime_state, runtime_error, runtime_pid,
              runtime_started_at, runtime_reload_at, listeners, bind_host
       FROM gateway_instances WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('网关实例');
    return {
      id: row.id,
      name: row.name,
      engineKind: row.engine_kind,
      state: row.runtime_state,
      error: row.runtime_error,
      pid: row.runtime_pid,
      startedAt: row.runtime_started_at,
      reloadedAt: row.runtime_reload_at,
      listeners: row.listeners,
      live: runtimeSnapshot(id),
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
