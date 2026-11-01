import type { FastifyInstance } from 'fastify';
import type { AuditEventRow } from '@proxyforge/contracts';
import { q } from '../../db/client.js';
import { guard } from '../auth/index.js';
import { parseLimit } from '../../shared/pagination.js';

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit/events', { preHandler: guard('audit:read') }, async (req) => {
    const query = req.query as Record<string, string | undefined>;
    const limit = parseLimit(query.limit, 50, 200);

    const where: string[] = [];
    const params: unknown[] = [];

    if (query.action) {
      params.push(`${query.action}%`);
      where.push(`action LIKE $${params.length}`);
    }
    if (query.actorId) {
      params.push(query.actorId);
      where.push(`actor_id = $${params.length}`);
    }
    if (query.resourceType) {
      params.push(query.resourceType);
      where.push(`resource_type = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      where.push(`occurred_at >= $${params.length}::timestamptz`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`occurred_at <= $${params.length}::timestamptz`);
    }

    params.push(limit);
    const rows = await q<Record<string, unknown>>(
      `SELECT id, occurred_at, actor_type, actor_id, action, resource_type, resource_id,
              source_ip, request_id, before_state, after_state
       FROM audit_events
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY occurred_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );

    return {
      items: rows.map(
        (r): AuditEventRow => ({
          id: Number(r.id),
          occurredAt: String(r.occurred_at),
          actorType: r.actor_type as AuditEventRow['actorType'],
          actorId: (r.actor_id as string) ?? null,
          action: r.action as string,
          resourceType: (r.resource_type as string) ?? null,
          resourceId: (r.resource_id as string) ?? null,
          sourceIp: (r.source_ip as string) ?? null,
          requestId: (r.request_id as string) ?? null,
          beforeState: r.before_state,
          afterState: r.after_state,
        }),
      ),
    };
  });
}
