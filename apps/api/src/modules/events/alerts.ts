import { exec, q } from '../../db/client.js';
import { uuidv7 } from '../../shared/id.js';

/**
 * 告警。
 *
 * 设计上只做三件事，但每件都必须做对：
 *
 * 1. **去重靠数据库**。同一件事每 15 秒评估一次，如果每次都插一条新记录，
 *    界面上会瞬间堆出几百条一模一样的告警，然后没人再看它。
 *    所以 `uq_alert_open_key` 是"同 key 未解决时唯一"的部分唯一索引，
 *    写入用 ON CONFLICT 累加 count —— 并发下也不会重复。
 *
 * 2. **能自愈**。条件消失就自动关掉。做不到自愈的告警系统最后都会变成
 *    一片永远飘红的噪音，人会学会无视它 —— 那比没有告警更糟。
 *    所以评估器每次都会算出"当前应该存在的 key 集合"，不在集合里的自动解决。
 *
 * 3. **可确认**。ACKED 表示"人看到了，正在处理"，但不改变它仍然存在的事实；
 *    只有条件消失或人工解决才变 RESOLVED。否则一确认就从列表里消失，
 *    等于把问题藏起来。
 */

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface AlertInput {
  key: string;
  severity: AlertSeverity;
  title: string;
  detail?: string;
  subjectType?: string;
  subjectId?: string;
}

export interface AlertRow {
  id: string;
  key: string;
  severity: AlertSeverity;
  status: 'OPEN' | 'ACKED' | 'RESOLVED';
  title: string;
  detail: string | null;
  subjectType: string | null;
  subjectId: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  autoResolved: boolean;
}

/**
 * 提出（或刷新）一条告警。
 *
 * 已存在同 key 的未解决告警时：累加 count、更新 last_seen_at 与描述，
 * 但不降级 severity —— 一次误判成 INFO 不应该把 CRITICAL 覆盖掉。
 */
export async function raiseAlert(input: AlertInput): Promise<void> {
  await exec(
    `INSERT INTO alerts (id, key, severity, title, detail, subject_type, subject_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (key) WHERE status <> 'RESOLVED' DO UPDATE
       SET count = alerts.count + 1,
           last_seen_at = now(),
           title = EXCLUDED.title,
           detail = EXCLUDED.detail,
           -- 只允许升级，不允许降级：severity 的数值顺序是 INFO < WARNING < CRITICAL
           severity = CASE
             WHEN array_position(ARRAY['INFO','WARNING','CRITICAL'], EXCLUDED.severity)
                > array_position(ARRAY['INFO','WARNING','CRITICAL'], alerts.severity)
             THEN EXCLUDED.severity ELSE alerts.severity END`,
    [
      uuidv7(), input.key, input.severity, input.title,
      input.detail ?? null, input.subjectType ?? null, input.subjectId ?? null,
    ],
  );
}

/**
 * 按 key 精确解决一条告警。
 *
 * 用于"事件本身证明了问题已消失"的场合：配置下发成功就关掉下发失败的告警，
 * 池子重新有成员就关掉空池告警。这类自愈不能等周期评估器 ——
 * 它按前缀扫描，覆盖不到事件驱动的 key。
 */
export async function resolveAlertByKey(key: string): Promise<number> {
  return exec(
    `UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), auto_resolved = true, resolved_by = 'auto'
     WHERE key = $1 AND status <> 'RESOLVED'`,
    [key],
  );
}

/**
 * 自动解决：把前缀匹配、但不在 activeKeys 里的未解决告警关掉。
 *
 * 前缀用来划定"这次评估负责的范围"。不带前缀地全量清理很危险 ——
 * 两个评估器并行跑时，A 会把手伸到 B 的地盘上。
 */
export async function resolveStale(prefix: string, activeKeys: string[]): Promise<number> {
  if (activeKeys.length === 0) {
    return exec(
      `UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), auto_resolved = true, resolved_by = 'auto'
       WHERE key LIKE $1 AND status <> 'RESOLVED'`,
      [`${prefix}%`],
    );
  }
  return exec(
    `UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), auto_resolved = true, resolved_by = 'auto'
     WHERE key LIKE $1 AND status <> 'RESOLVED' AND NOT (key = ANY($2::text[]))`,
    [`${prefix}%`, activeKeys],
  );
}

export async function ackAlert(id: string, actorId: string): Promise<number> {
  return exec(
    `UPDATE alerts SET status = 'ACKED'
     WHERE id = $1 AND status = 'OPEN'`,
    [id],
  );
}

export async function resolveAlert(id: string, actorId: string): Promise<number> {
  return exec(
    `UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), resolved_by = $2, auto_resolved = false
     WHERE id = $1 AND status <> 'RESOLVED'`,
    [id, actorId],
  );
}

export async function listAlerts(opts: { status?: string; limit?: number }): Promise<AlertRow[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const where = opts.status === 'all' ? '' : `WHERE status <> 'RESOLVED'`;
  const rows = await q<Record<string, unknown>>(
    `SELECT id, key, severity, status, title, detail, subject_type, subject_id,
            count, first_seen_at, last_seen_at, resolved_at, auto_resolved
     FROM alerts ${where}
     ORDER BY array_position(ARRAY['CRITICAL','WARNING','INFO'], severity), last_seen_at DESC
     LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    key: r.key as string,
    severity: r.severity as AlertSeverity,
    status: r.status as AlertRow['status'],
    title: r.title as string,
    detail: (r.detail as string) ?? null,
    subjectType: (r.subject_type as string) ?? null,
    subjectId: (r.subject_id as string) ?? null,
    count: Number(r.count),
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
    resolvedAt: (r.resolved_at as string) ?? null,
    autoResolved: Boolean(r.auto_resolved),
  }));
}
