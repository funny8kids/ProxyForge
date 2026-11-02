import type { FastifyInstance } from 'fastify';
import { exec, q } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit } from '../../shared/events.js';
import { notFound } from '../../shared/errors.js';
import { ackAlert, listAlerts, resolveAlert } from './alerts.js';
import { evaluateAlerts } from './evaluate.js';

/**
 * 告警与事件运维接口。
 *
 * 之前事件被消费之后就没有痕迹了：看不到"最近发生了什么"，
 * 也看不到"哪些事件消费失败了"。失败的事件超过重试上限后既不在队列里、
 * 也不在任何界面上 —— 只能翻数据库才查得到。
 */

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  // ── 告警 ──
  app.get('/alerts', { preHandler: guard('alert:read') }, async (req) => {
    const query = req.query as { status?: string; limit?: string };
    const items = await listAlerts({
      status: query.status ?? 'open',
      limit: query.limit ? Number(query.limit) : 50,
    });
    const counts = await q<{ severity: string; c: string }>(
      `SELECT severity, count(*)::text AS c FROM alerts WHERE status <> 'RESOLVED' GROUP BY severity`,
    );
    const bySeverity: Record<string, number> = { CRITICAL: 0, WARNING: 0, INFO: 0 };
    for (const r of counts) bySeverity[r.severity] = Number(r.c);
    return { items, bySeverity };
  });

  app.post('/alerts/:id/ack', { preHandler: guard('alert:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);
    const n = await ackAlert(id, actor.id);
    if (n === 0) throw notFound('告警（可能已确认或已解决）');
    await audit(
      { q: async () => [], q1: async () => null, exec: async (s, p) => exec(s, p) },
      {
        actorType: actor.kind, actorId: actor.id, action: 'alert.ack',
        resourceType: 'alert', resourceId: id,
      },
    );
    return { ok: true };
  });

  app.post('/alerts/:id/resolve', { preHandler: guard('alert:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);
    const n = await resolveAlert(id, actor.id);
    if (n === 0) throw notFound('告警');
    await audit(
      { q: async () => [], q1: async () => null, exec: async (s, p) => exec(s, p) },
      {
        actorType: actor.kind, actorId: actor.id, action: 'alert.resolve',
        resourceType: 'alert', resourceId: id,
      },
    );
    return { ok: true };
  });

  /**
   * 立即评估一次。
   *
   * 周期评估器 15 秒一轮，但"我刚修好，界面怎么还红着"是必然会被问的问题。
   * 手动触发让它当场变绿，而不是让人等下一轮。
   */
  app.post('/alerts/evaluate', { preHandler: guard('alert:write') }, async () => {
    const r = await evaluateAlerts();
    return { ok: true, ...r };
  });

  // ── 事件指标 ──
  app.get('/events/metrics', { preHandler: guard('audit:read') }, async (req) => {
    const query = req.query as { days?: string };
    const days = Math.min(90, Math.max(1, Number(query.days ?? 14) || 14));

    const rows = await q<{ day: string; event_type: string; count: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, event_type, count::text AS count
       FROM event_metrics_daily
       WHERE day >= current_date - ($1 || ' days')::interval
       ORDER BY day DESC, count DESC`,
      [String(days)],
    );

    // 按类型汇总：日曲线要看趋势，汇总要看"什么在主导"
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.event_type, (totals.get(r.event_type) ?? 0) + Number(r.count));

    return {
      days,
      items: rows.map((r) => ({ day: r.day, eventType: r.event_type, count: Number(r.count) })),
      byType: [...totals.entries()]
        .map(([eventType, count]) => ({ eventType, count }))
        .sort((a, b) => b.count - a.count),
    };
  });

  // ── 死信 ──
  app.get('/events/dead', { preHandler: guard('audit:read') }, async (req) => {
    const query = req.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
    const rows = await q<Record<string, unknown>>(
      `SELECT id, event_id, event_type, aggregate_type, aggregate_id, payload,
              attempts, last_error, dead_at, consumer_state
       FROM event_outbox
       WHERE status = 'DEAD'
       ORDER BY dead_at DESC
       LIMIT ${limit}`,
    );
    const counts = await q<{ status: string; c: string }>(
      `SELECT status, count(*)::text AS c FROM event_outbox GROUP BY status`,
    );
    const byStatus: Record<string, number> = { PENDING: 0, PUBLISHED: 0, DEAD: 0 };
    for (const r of counts) byStatus[r.status] = Number(r.c);

    return {
      items: rows.map((r) => ({
        id: r.id as string,
        eventId: r.event_id as string,
        eventType: r.event_type as string,
        aggregateType: r.aggregate_type as string,
        aggregateId: r.aggregate_id as string,
        payload: r.payload,
        attempts: Number(r.attempts),
        lastError: (r.last_error as string) ?? null,
        deadAt: (r.dead_at as string) ?? null,
        consumerState: r.consumer_state,
      })),
      byStatus,
    };
  });

  /**
   * 重放死信。
   *
   * 重置的是 status / attempts / next_attempt_at，**不清 consumer_state** ——
   * 已经成功的消费方不该再跑一遍（那会让指标重复累加）。
   * 只清掉失败消费方的记录，让它们重新执行。
   */
  app.post('/events/dead/:id/replay', { preHandler: guard('audit:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);

    const row = await q<{ consumer_state: Record<string, { ok: boolean }> | null }>(
      `SELECT consumer_state FROM event_outbox WHERE id = $1 AND status = 'DEAD'`,
      [id],
    );
    if (row.length === 0) throw notFound('死信事件');

    const kept: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(row[0]?.consumer_state ?? {})) {
      if (s.ok) kept[name] = s;
    }

    await exec(
      `UPDATE event_outbox
       SET status = 'PENDING', attempts = 0, dead_at = NULL,
           next_attempt_at = now(), consumer_state = $2::jsonb, last_error = NULL
       WHERE id = $1`,
      [id, JSON.stringify(kept)],
    );
    await audit(
      { q: async () => [], q1: async () => null, exec: async (s, p) => exec(s, p) },
      {
        actorType: actor.kind, actorId: actor.id, action: 'event.replay',
        resourceType: 'event_outbox', resourceId: id,
      },
    );
    return { ok: true, skippedConsumers: Object.keys(kept) };
  });
}
