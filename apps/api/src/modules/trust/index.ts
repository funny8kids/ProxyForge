import type { FastifyInstance } from 'fastify';
import type { PromotionSuggestionRow, TrustSummary, TrustTier } from '@proxyforge/contracts';
import { q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit, emit, EVENT_TYPES } from '../../shared/events.js';
import { AppError, forbidden, notFound, invalid } from '../../shared/errors.js';

/**
 * 信任分级（ADR-0010 / SEC-001 §6.2）
 *
 * 三条铁律，代码与 DB 双重保证：
 *   1. PUBLIC_PROXY 永远不能获得 explicit_gateway_grant（DB CHECK 拦截）
 *   2. AI 只能写 promotion_suggestions，不能改 trust_tier（无接口可调用）
 *   3. APPROVED 必须有 reviewed_by + reviewed_at（DB CHECK 拦截）
 */

export async function registerTrustRoutes(app: FastifyInstance): Promise<void> {
  app.get('/trust/summary', { preHandler: guard('trust:read') }, async (): Promise<TrustSummary> => {
    const rows = await q<{
      trust_tier: TrustTier;
      total: string;
      healthy: string;
      degraded: string;
      unavailable: string;
    }>(
      `SELECT trust_tier,
              count(*)::text AS total,
              count(*) FILTER (WHERE lifecycle_status = 'HEALTHY')::text AS healthy,
              count(*) FILTER (WHERE lifecycle_status = 'DEGRADED')::text AS degraded,
              count(*) FILTER (WHERE lifecycle_status = 'UNAVAILABLE')::text AS unavailable
       FROM proxy_endpoints WHERE deleted_at IS NULL
       GROUP BY trust_tier`,
    );

    const tiers: TrustSummary['tiers'] = ['PRIVATE_PROXY', 'VERIFIED_PROXY', 'PUBLIC_PROXY'].map((tier) => {
      const r = rows.find((x) => x.trust_tier === tier);
      return {
        tier: tier as TrustTier,
        total: Number(r?.total ?? 0),
        healthy: Number(r?.healthy ?? 0),
        degraded: Number(r?.degraded ?? 0),
        unavailable: Number(r?.unavailable ?? 0),
        // 只有这两个分级可以进正式网关
        gatewayEligible: tier === 'VERIFIED_PROXY' || tier === 'PRIVATE_PROXY',
      };
    });

    const pending = await q1<{ c: string }>(
      `SELECT count(*)::text AS c FROM promotion_suggestions WHERE status = 'PENDING'`,
    );

    const pub = await q1<{ total: string; ok: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE s.success_rate_24h >= 0.9)::text AS ok
       FROM proxy_endpoints e JOIN endpoint_health_state s ON s.endpoint_id = e.id
       WHERE e.deleted_at IS NULL AND e.trust_tier = 'PUBLIC_PROXY'`,
    );
    const pubTotal = Number(pub?.total ?? 0);

    return {
      tiers,
      pendingPromotions: Number(pending?.c ?? 0),
      publicProxyHealthRate: pubTotal > 0 ? Number(pub?.ok ?? 0) / pubTotal : null,
    };
  });

  app.patch('/resources/:id/tier', { preHandler: guard('trust:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { tier: TrustTier; reason?: string };
    if (!body?.tier) throw invalid('tier 必填');

    const actor = actorOf(req);

    return tx(async (t) => {
      const before = await t.q1<{ trust_tier: TrustTier; explicit_gateway_grant: boolean }>(
        'SELECT trust_tier, explicit_gateway_grant FROM proxy_endpoints WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!before) throw notFound('资源');

      // 铁律 1：不允许把 PUBLIC_PROXY 直接提升为可调度分级
      // 唯一路径是走 promotion_suggestions + 人工批准
      if (before.trust_tier === 'PUBLIC_PROXY' && body.tier !== 'PUBLIC_PROXY') {
        throw forbidden(
          'TIER_UPGRADE_FORBIDDEN',
          '公开代理不能直接提升分级；请提交晋升建议并由他人复核',
        );
      }

      await t.exec(
        `UPDATE proxy_endpoints SET trust_tier = $2,
           explicit_gateway_grant = CASE WHEN $2::trust_tier = 'PUBLIC_PROXY' THEN false ELSE explicit_gateway_grant END
         WHERE id = $1`,
        [id, body.tier],
      );

      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'endpoint.tier.change',
        resourceType: 'endpoint', resourceId: id,
        beforeState: { tier: before.trust_tier },
        afterState: { tier: body.tier, reason: body.reason ?? null },
      });
      await emit(t, {
        type: EVENT_TYPES.ENDPOINT_TIER_CHANGED,
        aggregateType: 'endpoint', aggregateId: id,
        payload: { from: before.trust_tier, to: body.tier },
      });

      return { id, tier: body.tier };
    });
  });

  app.post('/resources/:id/gateway-grant', { preHandler: guard('trust:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { grant: boolean };
    const actor = actorOf(req);

    return tx(async (t) => {
      const ep = await t.q1<{ trust_tier: TrustTier }>(
        'SELECT trust_tier FROM proxy_endpoints WHERE id = $1',
        [id],
      );
      if (!ep) throw notFound('资源');

      if (ep.trust_tier === 'PUBLIC_PROXY') {
        // DB CHECK 同样会拒绝，这里先给出可读错误
        throw new AppError(
          'PUBLIC_PROXY_GATEWAY_FORBIDDEN',
          '公开代理永远不能获得网关授权（SEC-001 §6.2.6）',
        );
      }

      await t.exec('UPDATE proxy_endpoints SET explicit_gateway_grant = $2 WHERE id = $1', [
        id,
        body.grant,
      ]);
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'endpoint.gateway_grant',
        resourceType: 'endpoint', resourceId: id, afterState: { grant: body.grant },
      });
      return { id, grant: body.grant };
    });
  });

  app.get('/trust/promotions', { preHandler: guard('trust:read') }, async (req) => {
    const { status } = req.query as { status?: string };
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM promotion_suggestions
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC LIMIT 100`,
      [status ?? null],
    );
    return {
      items: rows.map(
        (r): PromotionSuggestionRow => ({
          id: r.id as string,
          endpointId: (r.endpoint_id as string) ?? null,
          candidateId: (r.candidate_id as string) ?? null,
          suggestedTier: r.suggested_tier as TrustTier,
          currentTier: (r.current_tier as TrustTier) ?? null,
          confidence: Number(r.confidence),
          rationale: (r.rationale as string) ?? null,
          rationaleCode: (r.rationale_code as string) ?? null,
          rationaleParams: (r.rationale_params as Record<string, unknown>) ?? {},
          source: r.source as 'AI' | 'RULE' | 'HUMAN',
          status: r.status as 'PENDING' | 'APPROVED' | 'REJECTED',
          reviewedBy: (r.reviewed_by as string) ?? null,
          createdAt: String(r.created_at),
        }),
      ),
    };
  });

  app.post('/trust/promotions/:id/approve', { preHandler: guard('trust:review') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);

    return tx(async (t) => {
      const s = await t.q1<{
        id: string; endpoint_id: string | null; suggested_tier: TrustTier;
        status: string; created_by: string | null; source: string;
      }>(
        `SELECT id, endpoint_id, suggested_tier, status, reviewed_by AS created_by, source
         FROM promotion_suggestions WHERE id = $1`,
        [id],
      );
      if (!s) throw notFound('晋升建议');
      if (s.status !== 'PENDING') throw invalid('该建议已被处理');

      // 不能批准自己提交的建议 —— 这是"AI 不能自我晋升"在人工侧的对偶约束
      if (s.created_by === actor.id) {
        throw forbidden('SELF_REVIEW_FORBIDDEN', '不能批准自己提交的晋升建议');
      }

      await t.exec(
        `UPDATE promotion_suggestions
         SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now()
         WHERE id = $1`,
        [id, actor.id],
      );

      if (s.endpoint_id) {
        await t.exec('UPDATE proxy_endpoints SET trust_tier = $2 WHERE id = $1', [
          s.endpoint_id,
          s.suggested_tier,
        ]);
      }

      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'promotion.approve',
        resourceType: 'promotion_suggestion', resourceId: id,
        afterState: { tier: s.suggested_tier },
      });
      await emit(t, {
        type: EVENT_TYPES.PROMOTION_REVIEWED,
        aggregateType: 'promotion_suggestion', aggregateId: id,
        payload: { approved: true, tier: s.suggested_tier },
      });

      return { ok: true };
    });
  });

  app.post('/trust/promotions/:id/reject', { preHandler: guard('trust:review') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string };
    const actor = actorOf(req);

    await tx(async (t) => {
      const n = await t.exec(
        `UPDATE promotion_suggestions SET status = 'REJECTED', reviewed_by = $2, reviewed_at = now(),
           review_note = $3 WHERE id = $1 AND status = 'PENDING'`,
        [id, actor.id, body?.reason ?? null],
      );
      if (n === 0) throw notFound('待处理建议');
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'promotion.reject',
        resourceType: 'promotion_suggestion', resourceId: id,
        afterState: { reason: body?.reason ?? null },
      });
    });
    return { ok: true };
  });
}
