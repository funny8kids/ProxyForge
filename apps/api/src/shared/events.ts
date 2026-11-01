import type { TxLike } from '../db/client.js';
import { uuidv7 } from './id.js';

/**
 * Transactional Outbox（ADR-0001）
 *
 * 业务写与事件写必须在同一事务里，否则会出现"数据改了但事件丢了"
 * 或"事件发了但数据回滚了"。Worker 侧用 FOR UPDATE SKIP LOCKED 批量拉取，
 * 天然支持多 worker 并行而不重复消费。
 */

export const EVENT_TYPES = {
  ENDPOINT_IMPORTED: 'endpoint.imported',
  ENDPOINT_VERIFIED: 'endpoint.verified',
  ENDPOINT_QUARANTINED: 'endpoint.quarantined',
  ENDPOINT_TIER_CHANGED: 'endpoint.tier.changed',
  POOL_MEMBERSHIP_CHANGED: 'pool.membership.changed',
  POLICY_COMPILED: 'policy.compiled',
  GATEWAY_CONFIG_APPLIED: 'gateway.config.applied',
  SUBSCRIPTION_REVOKED: 'subscription.revoked',
  PROMOTION_REQUESTED: 'promotion.requested',
  PROMOTION_REVIEWED: 'promotion.reviewed',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface DomainEvent {
  type: EventType | string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  schemaVersion?: number;
}

/** 必须在业务事务内调用 */
export async function emit(tx: TxLike, evt: DomainEvent): Promise<string> {
  const eventId = uuidv7();
  await tx.exec(
    `INSERT INTO event_outbox (event_id, event_type, aggregate_type, aggregate_id, schema_version, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      eventId,
      evt.type,
      evt.aggregateType,
      evt.aggregateId,
      evt.schemaVersion ?? 1,
      JSON.stringify(evt.payload),
    ],
  );
  return eventId;
}

// ─────────────────────────────────────────────────────────────
// 审计：append-only，与业务同事务
// ─────────────────────────────────────────────────────────────

export interface AuditInput {
  actorType?: 'USER' | 'API_KEY' | 'SYSTEM' | 'SCHEDULER';
  actorId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  sourceIp?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
}

export async function audit(tx: TxLike, input: AuditInput): Promise<void> {
  await tx.exec(
    `INSERT INTO audit_events
       (actor_type, actor_id, action, resource_type, resource_id, request_id, source_ip, before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      input.actorType ?? 'SYSTEM',
      input.actorId ?? null,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.requestId ?? null,
      input.sourceIp ?? null,
      input.beforeState === undefined ? null : JSON.stringify(input.beforeState),
      input.afterState === undefined ? null : JSON.stringify(input.afterState),
    ],
  );
}
