import type { FastifyInstance } from 'fastify';
import type {
  AuthorizationStatus,
  EndpointDetail,
  EndpointSummary,
  ImportResult,
  LifecycleStatus,
  OriginType,
  Page,
  ProxyProtocol,
  TrustTier,
} from '@proxyforge/contracts';
import { LIFECYCLE_STATUSES, ORIGIN_TYPES, PROXY_PROTOCOLS, TRUST_TIERS } from '@proxyforge/contracts';
import { exec, q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit, emit, EVENT_TYPES } from '../../shared/events.js';
import { invalid, notFound } from '../../shared/errors.js';
import { uuidv7 } from '../../shared/id.js';
import { seal } from '../../shared/crypto.js';
import { dedupeKey, parseProxyLine } from '../../shared/parser.js';
import { decodeCursor, encodeCursor, parseEnumList, parseLimit } from '../../shared/pagination.js';

interface Row {
  id: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  display_name: string | null;
  origin_type: OriginType;
  trust_tier: TrustTier;
  authorization_status: AuthorizationStatus;
  lifecycle_status: LifecycleStatus;
  explicit_gateway_grant: boolean;
  quality_score: string;
  tags: string[];
  expected_country: string | null;
  last_verified_at: string | null;
  country_code: string | null;
  region: string | null;
  p50_ms: number | null;
  p95_ms: number | null;
  jitter_ms: number | null;
  success_rate_24h: string | null;
  last_success_at: string | null;
  consecutive_failures: number | null;
  consecutive_successes: number | null;
  success: boolean | null;
  last_check_at: string | null;
  total_count?: string;
}

const num = (v: string | number | null): number => (v === null ? 0 : Number(v));
const numOrNull = (v: string | number | null): number | null => (v === null ? null : Number(v));

function toSummary(r: Row): EndpointSummary {
  return {
    id: r.id,
    protocol: r.protocol,
    host: r.host,
    port: r.port,
    displayName: r.display_name,
    originType: r.origin_type,
    trustTier: r.trust_tier,
    authorizationStatus: r.authorization_status,
    lifecycleStatus: r.lifecycle_status,
    explicitGatewayGrant: r.explicit_gateway_grant,
    qualityScore: num(r.quality_score),
    countryCode: r.country_code ?? r.expected_country ?? null,
    region: r.region,
    tags: r.tags ?? [],
    expectedCountry: r.expected_country,
    lastVerifiedAt: r.last_verified_at,
    health:
      r.last_check_at === null && r.success === null
        ? null
        : {
            success: r.success ?? false,
            lastCheckAt: r.last_check_at,
            lastSuccessAt: r.last_success_at,
            consecutiveFailures: r.consecutive_failures ?? 0,
            consecutiveSuccesses: r.consecutive_successes ?? 0,
            p50Ms: r.p50_ms,
            p95Ms: r.p95_ms,
            jitterMs: r.jitter_ms,
            successRate24h: numOrNull(r.success_rate_24h),
            qualityScore: num(r.quality_score),
          },
  };
}

const BASE_SELECT = `
  SELECT e.id, e.protocol, e.host, e.port, e.display_name, e.origin_type, e.trust_tier,
         e.authorization_status, e.lifecycle_status, e.explicit_gateway_grant,
         e.quality_score, e.tags, e.expected_country,
         e.last_verified_at, i.country_code, i.region,
         s.p50_ms, s.p95_ms, s.jitter_ms, s.success_rate_24h, s.last_success_at,
         s.consecutive_failures, s.consecutive_successes, s.success, s.last_check_at
  FROM proxy_endpoints e
  LEFT JOIN endpoint_health_state s ON s.endpoint_id = e.id
  LEFT JOIN ip_assets i ON i.id = e.ip_asset_id
`;

export async function registerResourceRoutes(app: FastifyInstance): Promise<void> {
  // ── 列表 ──
  app.get('/resources', { preHandler: guard('resource:read') }, async (req): Promise<Page<EndpointSummary>> => {
    const query = req.query as Record<string, string | undefined>;
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const lifecycle = parseEnumList(query.status, LIFECYCLE_STATUSES, 'status');
    const tiers = parseEnumList(query.tier, TRUST_TIERS, 'tier');
    const protocols = parseEnumList(query.protocol, PROXY_PROTOCOLS, 'protocol');
    const origins = parseEnumList(query.originType, ORIGIN_TYPES, 'originType');

    const where: string[] = ['e.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (lifecycle.length) {
      params.push(lifecycle);
      where.push(`e.lifecycle_status::text = ANY($${params.length}::text[])`);
    }
    if (tiers.length) {
      params.push(tiers);
      where.push(`e.trust_tier::text = ANY($${params.length}::text[])`);
    }
    if (protocols.length) {
      params.push(protocols);
      where.push(`e.protocol::text = ANY($${params.length}::text[])`);
    }
    if (origins.length) {
      params.push(origins);
      where.push(`e.origin_type::text = ANY($${params.length}::text[])`);
    }
    if (query.minQuality) {
      params.push(Number(query.minQuality));
      where.push(`e.quality_score >= $${params.length}`);
    }
    if (query.q) {
      params.push(`${String(query.q).toLowerCase()}%`);
      where.push(`(lower(e.host) LIKE $${params.length} OR lower(coalesce(e.display_name,'')) LIKE $${params.length})`);
    }
    /**
     * 分页游标不能进 count —— 带了游标数出来的是「剩余条数」，
     * 而 total 的语义是「当前筛选条件下的总数」。所以在这里把
     * 纯筛选条件先冻结一份，游标和 limit 只作用于取数那条 SQL。
     */
    const filterWhere = where.join(' AND ');
    const filterParams = [...params];

    if (cursor) {
      params.push(cursor.k, cursor.id);
      where.push(`(e.quality_score, e.id) < ($${params.length - 1}, $${params.length})`);
    }

    const sortDir = query.sort === 'qualityScore:asc' ? 'ASC' : 'DESC';
    params.push(limit + 1);

    const rows = await q<Row>(
      `${BASE_SELECT}
       WHERE ${where.join(' AND ')}
       ORDER BY e.quality_score ${sortDir}, e.id ${sortDir}
       LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toSummary);

    const countRow = await q1<{ c: string }>(
      `SELECT count(*)::text AS c FROM proxy_endpoints e WHERE ${filterWhere}`,
      filterParams,
    );

    const last = items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ k: last.qualityScore, id: last.id }) : null,
      total: Number(countRow?.c ?? 0),
    };
  });

  // ── 详情 ──
  app.get('/resources/:id', { preHandler: guard('resource:read') }, async (req): Promise<EndpointDetail> => {
    const { id } = req.params as { id: string };
    const row = await q1<Row & Record<string, unknown>>(`${BASE_SELECT} WHERE e.id = $1`, [id]);
    if (!row) throw notFound('资源');

    const detail = await q1<Record<string, unknown>>(
      `SELECT e.node_id, e.source_id, e.ip_asset_id, e.labels, e.credential_ref,
              e.created_at, e.updated_at, e.version,
              i.network_type, i.ip_type, i.asn, i.as_org, i.isp, i.city
       FROM proxy_endpoints e LEFT JOIN ip_assets i ON i.id = e.ip_asset_id
       WHERE e.id = $1`,
      [id],
    );

    const pools = await q<{ id: string; key: string; name: string }>(
      `SELECT p.id, p.key, p.name FROM resource_pool_members m
       JOIN resource_pools p ON p.id = m.pool_id WHERE m.endpoint_id = $1`,
      [id],
    );

    const checks = await q<Record<string, unknown>>(
      `SELECT checked_at, success, failure_reason, failed_layer, dns_ms, tcp_ms,
              handshake_ms, total_ms, exit_ip, exit_country
       FROM health_checks WHERE endpoint_id = $1 ORDER BY checked_at DESC LIMIT 20`,
      [id],
    );

    const d = detail ?? {};
    return {
      ...toSummary(row),
      nodeId: (d.node_id as string) ?? null,
      sourceId: (d.source_id as string) ?? null,
      ipAssetId: (d.ip_asset_id as string) ?? null,
      networkType: (d.network_type as EndpointDetail['networkType']) ?? 'UNKNOWN',
      ipType: (d.ip_type as EndpointDetail['ipType']) ?? 'UNKNOWN',
      asn: (d.asn as number) ?? null,
      asOrg: (d.as_org as string) ?? null,
      isp: (d.isp as string) ?? null,
      city: (d.city as string) ?? null,
      labels: (d.labels as Record<string, unknown>) ?? {},
      credentialRef: (d.credential_ref as string) ?? null,
      createdAt: String(d.created_at),
      updatedAt: String(d.updated_at),
      version: Number(d.version ?? 1),
      pools,
      recentChecks: checks.map((c) => ({
        checkedAt: String(c.checked_at),
        success: Boolean(c.success),
        failureReason: c.failure_reason as never,
        failedLayer: (c.failed_layer as number) ?? null,
        dnsMs: (c.dns_ms as number) ?? null,
        tcpMs: (c.tcp_ms as number) ?? null,
        handshakeMs: (c.handshake_ms as number) ?? null,
        totalMs: (c.total_ms as number) ?? null,
        exitIp: (c.exit_ip as string) ?? null,
        exitCountry: (c.exit_country as string) ?? null,
      })),
    };
  });

  // ── 批量导入 ──
  /**
   * 清理合成端点。
   *
   * 种子数据用的是 RFC 5737 / RFC 5735 文档保留地址（192.0.2.0/24、
   * 198.51.100.0/24、203.0.113.0/24、198.18.0.0/15）。这些段被标准明确
   * 规定为**不可路由**，任何使用它们的端点必然是演示数据，不可能是真实代理。
   *
   * 为什么必须清掉：切到真实探测之后，这些端点会陆续被判死，但在被判死之前
   * 它们仍然挂着 HEALTHY，会进入实验池、出现在 Clash 订阅里 ——
   * 用户导入后发现一半节点连不上，而原因是一堆 RFC 文档地址。
   * 按地址段清理是精确的：不需要靠名字或标签猜测哪个是假数据。
   *
   * 默认 dryRun，必须先看数量再决定。软删除（deleted_at），不物理删除 ——
   * 池重算会自动把它们移出成员，审计链也还在。
   */
  app.post('/resources/purge-synthetic', { preHandler: guard('resource:write') }, async (req) => {
    const body = (req.body ?? {}) as { dryRun?: boolean };
    const actor = actorOf(req);
    const filter = `
      e.host ~ '^[0-9]{1,3}(\\.[0-9]{1,3}){3}$'
      AND (
        e.host::inet <<= '192.0.2.0/24'::cidr
        OR e.host::inet <<= '198.51.100.0/24'::cidr
        OR e.host::inet <<= '203.0.113.0/24'::cidr
        OR e.host::inet <<= '198.18.0.0/15'::cidr
      )`;

    const counted = await q1<{ c: string }>(
      `SELECT count(*)::text AS c FROM proxy_endpoints e
       WHERE e.deleted_at IS NULL AND ${filter}`,
    );
    const candidates = Number(counted?.c ?? 0);

    if (body.dryRun !== false || candidates === 0) {
      return { candidates, deleted: 0, dryRun: true };
    }

    const deleted = await tx(async (t) => {
      const n = await t.exec(
        `UPDATE proxy_endpoints e SET deleted_at = now(), updated_at = now()
         WHERE e.deleted_at IS NULL AND ${filter}`,
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'resource.purge_synthetic',
        resourceType: 'endpoint', resourceId: null, afterState: { deleted: n },
      });
      return n;
    });

    return { candidates, deleted, dryRun: false };
  });

  app.post('/resources/import', { preHandler: guard('resource:write') }, async (req): Promise<ImportResult> => {
    const body = req.body as {
      mode?: string;
      content?: string;
      sourceKey?: string;
      defaultProtocol?: ProxyProtocol;
      defaultOriginType?: OriginType;
      trustTier?: TrustTier;
      /**
       * 显式授权声明。
       *
       * 导入的端点默认是 UNKNOWN，而订阅取数视图只放行 AUTHORIZED / RESTRICTED
       * —— 于是「导入成功、验证通过、池里也有」的节点在订阅里一个都不出现，
       * 整条链路看起来是坏的，实际卡在没有人能签这个字。
       *
       * 调用方（界面上的勾选框）代表用户做出「我有权使用这些代理」的声明，
       * 落库为 AUTHORIZED 并写审计。分级不放宽：仍然是 PUBLIC_PROXY，
       * 要进可调度分级还得走晋升建议 + 他人复核。
       */
      authorized?: boolean;
    };
    if (!body?.content || typeof body.content !== 'string') {
      throw invalid('content 必填', [{ field: 'content', message: '需要待导入的文本' }]);
    }
    if (body.content.length > 10 * 1024 * 1024) {
      throw invalid('单次导入不得超过 10 MB');
    }

    const actor = actorOf(req);
    const defaultProtocol = body.defaultProtocol ?? 'HTTP';
    // fail-safe：默认 PUBLIC_PROXY（最严）。要放宽必须显式声明，且留审计。
    const trustTier: TrustTier = body.trustTier ?? 'PUBLIC_PROXY';
    const originType: OriginType = body.defaultOriginType ?? 'PUBLIC_PROXY';

    const lines = body.content.split(/\r?\n/);
    const jobId = uuidv7();
    const errors: ImportResult['errors'] = [];
    let imported = 0;
    let duplicated = 0;
    let skipped = 0;

    await tx(async (t) => {
      const sourceId = body.sourceKey
        ? (await t.q1<{ id: string }>('SELECT id FROM resource_sources WHERE key = $1', [body.sourceKey]))?.id
        : (await t.q1<{ id: string }>("SELECT id FROM resource_sources WHERE key = 'manual-paste'"))?.id;
      if (!sourceId) throw notFound('来源 manual-paste');

      await t.exec(
        `INSERT INTO import_jobs (id, source_id, mode, status, total, created_by)
         VALUES ($1, $2, 'TEXT', 'RUNNING', $3, $4)`,
        [jobId, sourceId, lines.length, actor.id],
      );

      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i]!;
        const parsed = parseProxyLine(raw, defaultProtocol);
        if ('error' in parsed) {
          if (raw.trim()) {
            skipped += 1;
            errors.push({ lineNo: i + 1, rawValue: raw.slice(0, 200), reason: parsed.error });
          }
          continue;
        }

        const key = dedupeKey(parsed);
        const existing = await t.q1<{ id: string }>(
          'SELECT id FROM proxy_endpoints WHERE dedupe_key = $1',
          [key],
        );
        if (existing) {
          duplicated += 1;
          continue;
        }

        const endpointId = uuidv7();

        // 带认证的代理必须把账号密码存下来，否则导入"成功"但永远连不上 ——
        // 解析器把 user:pass 拆出来了，之前却直接丢掉，dedupe_key 里还带着
        // 凭据指纹，于是同一台主机换个账号会被当成新端点，而两者都不可用。
        // 凭据进 secrets 表（AES-256-GCM），proxy_endpoints 只存 ref。
        let credentialRef: string | null = null;
        if (parsed.username) {
          credentialRef = `secret://endpoint/${endpointId}`;
          const env = seal(JSON.stringify({ username: parsed.username, password: parsed.password ?? '' }));
          await t.exec(
            `INSERT INTO secrets (ref, kind, ciphertext, nonce, key_version, description)
             VALUES ($1,'PROXY_CREDENTIAL',$2,$3,$4,$5)`,
            [
              credentialRef,
              env.ciphertext,
              env.nonce,
              env.keyVersion,
              `导入端点凭据：${parsed.host}:${parsed.port}`,
            ],
          );
        }

        await t.exec(
          `INSERT INTO proxy_endpoints
             (id, source_id, protocol, host, port, credential_ref, origin_type, authorization_status,
              trust_tier, lifecycle_status, dedupe_key, display_name, expected_country)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$11,$8,'PENDING_VERIFICATION',$9,$10,NULL)`,
          [
            endpointId,
            sourceId,
            parsed.protocol,
            parsed.host,
            parsed.port,
            credentialRef,
            originType,
            trustTier,
            key,
            `${parsed.host}:${parsed.port}`,
            body.authorized ? 'AUTHORIZED' : 'UNKNOWN',
          ],
        );
        await t.exec(
          `INSERT INTO endpoint_health_state (endpoint_id) VALUES ($1) ON CONFLICT DO NOTHING`,
          [endpointId],
        );
        await t.exec(
          `INSERT INTO endpoint_sources (endpoint_id, source_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [endpointId, sourceId],
        );
        imported += 1;
      }

      await t.exec(
        `UPDATE import_jobs SET status = 'SUCCEEDED', imported = $2, duplicated = $3,
                skipped = $4, failed = 0, finished_at = now() WHERE id = $1`,
        [jobId, imported, duplicated, skipped],
      );

      for (const e of errors.slice(0, 50)) {
        await t.exec(
          `INSERT INTO import_job_errors (job_id, line_no, raw_value, reason) VALUES ($1,$2,$3,$4)`,
          [jobId, e.lineNo, e.rawValue, e.reason],
        );
      }

      await audit(t, {
        actorType: actor.kind,
        actorId: actor.id,
        action: 'resource.import',
        resourceType: 'import_job',
        resourceId: jobId,
        // 授权声明是「谁在什么时候声称自己有权使用」的唯一凭据，必须留痕。
        afterState: { imported, duplicated, skipped, trustTier, authorized: body.authorized === true },
      });
      await emit(t, {
        type: EVENT_TYPES.ENDPOINT_IMPORTED,
        aggregateType: 'import_job',
        aggregateId: jobId,
        payload: { imported, duplicated, skipped, trustTier, authorized: body.authorized === true },
      });
    });

    return { jobId, total: lines.length, imported, duplicated, skipped, failed: 0, errors };
  });

  // ── 更新属性 ──
  app.patch('/resources/:id', { preHandler: guard('resource:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      displayName?: string | null;
      authorizationStatus?: AuthorizationStatus;
      tags?: string[];
      nodeId?: string | null;
      expectedVersion?: number;
    };
    const actor = actorOf(req);

    return tx(async (t) => {
      const before = await t.q1<{ version: string; authorization_status: string; display_name: string | null }>(
        'SELECT version, authorization_status, display_name FROM proxy_endpoints WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!before) throw notFound('资源');

      if (body.expectedVersion !== undefined && Number(before.version) !== body.expectedVersion) {
        const err = new Error('version conflict');
        (err as Error & { code?: string }).code = 'VERSION_CONFLICT';
        throw err;
      }

      // 授权状态改为 REVOKED 时，生命周期必须同步 REVOKED（DB CHECK 也会拦）
      if (body.authorizationStatus === 'REVOKED') {
        await t.exec(
          `UPDATE proxy_endpoints SET lifecycle_status = 'REVOKED', authorization_status = 'REVOKED'
           WHERE id = $1`,
          [id],
        );
      }

      await t.exec(
        `UPDATE proxy_endpoints SET
           display_name = COALESCE($2, display_name),
           authorization_status = COALESCE($3::authorization_status, authorization_status),
           tags = COALESCE($4::text[], tags),
           node_id = COALESCE($5, node_id)
         WHERE id = $1`,
        [
          id,
          body.displayName ?? null,
          body.authorizationStatus ?? null,
          body.tags ?? null,
          body.nodeId ?? null,
        ],
      );

      await audit(t, {
        actorType: actor.kind,
        actorId: actor.id,
        action: 'resource.update',
        resourceType: 'endpoint',
        resourceId: id,
        beforeState: { authorizationStatus: before.authorization_status },
        afterState: body,
      });

      return t.q1('SELECT * FROM proxy_endpoints WHERE id = $1', [id]);
    });
  });

  // ── 隔离 ──
  app.post('/resources/:id/quarantine', { preHandler: guard('resource:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);

    return tx(async (t) => {
      const before = await t.q1<{ lifecycle_status: string }>(
        'SELECT lifecycle_status FROM proxy_endpoints WHERE id = $1',
        [id],
      );
      if (!before) throw notFound('资源');

      await t.exec(`UPDATE proxy_endpoints SET lifecycle_status = 'QUARANTINED' WHERE id = $1`, [id]);
      // 隔离立即生效：从所有池成员中抑制，阻止下一轮编译选中
      await t.exec(
        `UPDATE resource_pool_members SET suppressed = true, suppress_reason = 'endpoint quarantined'
         WHERE endpoint_id = $1 AND suppressed = false`,
        [id],
      );
      await audit(t, {
        actorType: actor.kind,
        actorId: actor.id,
        action: 'endpoint.quarantine',
        resourceType: 'endpoint',
        resourceId: id,
        beforeState: { lifecycleStatus: before.lifecycle_status },
        afterState: { lifecycleStatus: 'QUARANTINED' },
      });
      await emit(t, {
        type: EVENT_TYPES.ENDPOINT_QUARANTINED,
        aggregateType: 'endpoint',
        aggregateId: id,
        payload: { reason: 'manual' },
      });
      return { id, lifecycleStatus: 'QUARANTINED' };
    });
  });

  // ── 软删除 ──
  app.delete('/resources/:id', { preHandler: guard('resource:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);
    await tx(async (t) => {
      const n = await t.exec(
        `UPDATE proxy_endpoints SET deleted_at = now(), lifecycle_status = 'REVOKED' WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (n === 0) throw notFound('资源');
      await t.exec('DELETE FROM resource_pool_members WHERE endpoint_id = $1', [id]);
      await audit(t, {
        actorType: actor.kind,
        actorId: actor.id,
        action: 'endpoint.delete',
        resourceType: 'endpoint',
        resourceId: id,
      });
    });
    return { ok: true };
  });

  // ── 统计 ──
  app.get('/resources/:id/tier', { preHandler: guard('trust:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await q1<{ trust_tier: TrustTier; explicit_gateway_grant: boolean; authorization_status: string }>(
      'SELECT trust_tier, explicit_gateway_grant, authorization_status FROM proxy_endpoints WHERE id = $1',
      [id],
    );
    if (!row) throw notFound('资源');
    const history = await q(
      `SELECT occurred_at, action, before_state, after_state FROM audit_events
       WHERE resource_type = 'endpoint' AND resource_id = $1 AND action LIKE 'endpoint.tier%'
       ORDER BY occurred_at DESC LIMIT 20`,
      [id],
    );
    return { current: row.trust_tier, gatewayGrant: row.explicit_gateway_grant, history };
  });
}

/** 供其他模块复用的存在性检查 */
export async function endpointExists(id: string): Promise<boolean> {
  const r = await q1('SELECT 1 FROM proxy_endpoints WHERE id = $1 AND deleted_at IS NULL', [id]);
  return r !== null;
}

export { exec as _exec };
