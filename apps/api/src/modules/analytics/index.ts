import type { FastifyInstance } from 'fastify';
import type { OverviewAnalytics } from '@proxyforge/contracts';
import { q, q1 } from '../../db/client.js';
import { guard } from '../auth/index.js';

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/analytics/overview', { preHandler: guard('resource:read') }, async (): Promise<OverviewAnalytics> => {
    const counters = await q1<Record<string, string>>(`
      SELECT
        (SELECT count(*) FROM proxy_endpoints WHERE deleted_at IS NULL)::text AS total,
        (SELECT count(*) FROM v_schedulable_endpoints)::text                   AS schedulable,
        (SELECT count(*) FROM proxy_endpoints WHERE deleted_at IS NULL AND lifecycle_status='HEALTHY')::text AS healthy,
        (SELECT count(*) FROM proxy_endpoints WHERE deleted_at IS NULL AND lifecycle_status='DEGRADED')::text AS degraded,
        (SELECT count(*) FROM proxy_endpoints WHERE deleted_at IS NULL AND lifecycle_status='QUARANTINED')::text AS quarantined,
        (SELECT count(*) FROM proxy_endpoints WHERE deleted_at IS NULL AND lifecycle_status IN ('PENDING_VERIFICATION','DISCOVERED'))::text AS pending
    `);

    const tiers = await q<{ trust_tier: string; c: string }>(
      `SELECT trust_tier::text, count(*)::text AS c FROM proxy_endpoints
       WHERE deleted_at IS NULL GROUP BY 1`,
    );

    const protocols = await q<{ protocol: string; c: string }>(
      `SELECT protocol::text, count(*)::text AS c FROM proxy_endpoints
       WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`,
    );

    const origins = await q<{ origin_type: string; c: string }>(
      `SELECT origin_type::text, count(*)::text AS c FROM proxy_endpoints
       WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`,
    );

    // 质量趋势：按天聚合真实探测记录。
    // 排除「今天」这个未完成的桶——它只有零点到此刻的少量样本（实测 73 条 vs 全天 340 条），
    // 画在末尾会被读成质量断崖，而事实只是当天还没过完。日粒度曲线只应包含完整日。
    const trend = await q<{ day: string; avg_quality: string | null; checks: string; succ: string }>(`
      SELECT to_char(date_trunc('day', h.checked_at), 'YYYY-MM-DD') AS day,
             round(avg(s.quality_score), 2)::text AS avg_quality,
             count(*)::text AS checks,
             count(*) FILTER (WHERE h.success)::text AS succ
      FROM health_checks h
      JOIN endpoint_health_state s ON s.endpoint_id = h.endpoint_id
      WHERE h.checked_at >= now() - interval '30 days'
        AND h.checked_at <  date_trunc('day', now())
      GROUP BY 1 ORDER BY 1
    `);

    const regions = await q<{ country_code: string; c: string; avg_latency: string | null }>(`
      SELECT COALESCE(i.country_code, e.expected_country)::text AS country_code,
             count(*)::text AS c,
             round(avg(s.p50_ms))::text AS avg_latency
      FROM proxy_endpoints e
      LEFT JOIN ip_assets i ON i.id = e.ip_asset_id
      LEFT JOIN endpoint_health_state s ON s.endpoint_id = e.id
      WHERE e.deleted_at IS NULL AND COALESCE(i.country_code, e.expected_country) IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12
    `);

    const top = await q<Record<string, unknown>>(`
      SELECT e.id, e.display_name, COALESCE(i.country_code, e.expected_country) AS country_code,
             s.p50_ms, s.success_rate_24h, s.quality_score
      FROM proxy_endpoints e
      LEFT JOIN ip_assets i ON i.id = e.ip_asset_id
      JOIN endpoint_health_state s ON s.endpoint_id = e.id
      WHERE e.deleted_at IS NULL
      ORDER BY s.quality_score DESC LIMIT 8
    `);

    const traffic = await q<Record<string, unknown>>(`
      SELECT to_char(date_trunc('hour', sampled_at), 'YYYY-MM-DD"T"HH24:00') AS bucket,
             sum(connections)::int AS connections,
             sum(bytes_in)::bigint AS bytes_in,
             sum(bytes_out)::bigint AS bytes_out
      FROM gateway_traffic_samples
      WHERE sampled_at >= now() - interval '24 hours'
      GROUP BY 1 ORDER BY 1
    `);

    return {
      counters: {
        totalEndpoints: Number(counters?.total ?? 0),
        schedulable: Number(counters?.schedulable ?? 0),
        healthy: Number(counters?.healthy ?? 0),
        degraded: Number(counters?.degraded ?? 0),
        quarantined: Number(counters?.quarantined ?? 0),
        pendingVerification: Number(counters?.pending ?? 0),
      },
      tiers: tiers.map((t) => ({ tier: t.trust_tier as never, count: Number(t.c) })),
      protocolMix: protocols.map((p) => ({ protocol: p.protocol as never, count: Number(p.c) })),
      originMix: origins.map((o) => ({ originType: o.origin_type as never, count: Number(o.c) })),
      qualityTrend: trend.map((t) => ({
        day: t.day,
        avgQuality: Number(t.avg_quality ?? 0),
        checks: Number(t.checks),
        successRate: Number(t.checks) > 0 ? Number(t.succ) / Number(t.checks) : 0,
      })),
      regionDistribution: regions.map((r) => ({
        countryCode: r.country_code,
        count: Number(r.c),
        avgLatency: r.avg_latency === null ? null : Number(r.avg_latency),
      })),
      topEndpoints: top.map((t) => ({
        id: t.id as string,
        displayName: (t.display_name as string) ?? null,
        countryCode: (t.country_code as string) ?? null,
        p50Ms: (t.p50_ms as number) ?? null,
        successRate24h: t.success_rate_24h === null ? null : Number(t.success_rate_24h),
        qualityScore: Number(t.quality_score),
      })),
      gatewayTraffic: traffic.map((t) => ({
        bucket: t.bucket as string,
        connections: Number(t.connections),
        bytesIn: Number(t.bytes_in),
        bytesOut: Number(t.bytes_out),
      })),
    };
  });

  app.get('/analytics/quality-trend', { preHandler: guard('resource:read') }, async (req) => {
    const { days } = req.query as { days?: string };
    const d = Math.min(Number(days ?? 30), 90);
    const rows = await q<Record<string, unknown>>(
      `SELECT to_char(date_trunc('day', checked_at), 'YYYY-MM-DD') AS day,
              count(*)::int AS checks,
              count(*) FILTER (WHERE success)::int AS successes,
              round(avg(total_ms) FILTER (WHERE success))::int AS avg_ms
       FROM health_checks WHERE checked_at >= now() - ($1 || ' days')::interval
       GROUP BY 1 ORDER BY 1`,
      [d],
    );
    return { items: rows };
  });

  app.get('/analytics/distribution', { preHandler: guard('resource:read') }, async (req) => {
    const { by } = req.query as { by?: string };
    const col =
      by === 'protocol' ? 'e.protocol::text'
      : by === 'originType' ? 'e.origin_type::text'
      : 'COALESCE(i.country_code, e.expected_country)::text';
    const rows = await q<Record<string, unknown>>(
      `SELECT ${col} AS key, count(*)::int AS count
       FROM proxy_endpoints e LEFT JOIN ip_assets i ON i.id = e.ip_asset_id
       WHERE e.deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`,
    );
    return { items: rows };
  });
}
