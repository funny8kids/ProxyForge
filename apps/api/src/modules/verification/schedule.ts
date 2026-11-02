import { exec, q } from '../../db/client.js';

/**
 * 分级探测调度。
 *
 * 存在的理由：`runVerificationJob` 早就能跑，`recordCheck` 早就会算 24h
 * 滚动质量分、早就会按连续失败推进生命周期 —— 但**没有任何东西去创建
 * 探测任务**。`verification_jobs` 只能由手工接口 `POST /verification/jobs`
 * 写入，于是真实运行时 `lifecycle_status` 永不变化：节点一次导入就定终身，
 * 池成员是导入那天的快照，质量分是死数据。
 *
 * 这条链路的缺口不在"探得准不准"，而在"没人去探"。
 *
 * 三个设计决定：
 *
 * 1. **按生命周期分级，不是一视同仁。** HEALTHY 已经能用，探它只是确认还活着；
 *    DEGRADED 才是真正要盯的 —— 它已经在坏，随时会掉。新候选（DISCOVERED）
 *    要高频：快速淘汰掉大批死节点，比让它们占着候选表更有价值。
 *    2.5 万个端点如果同频探测，单机永远探不完，而且探完一轮时最早的结论已经过期。
 *
 * 2. **预算驱动，不是全量。** 每个 tick 只取一小批（默认 60）。上限的意义是
 *    "永远有事可做，但绝不因为探测把 outbox 中继和告警评估饿死"。
 *
 * 3. **按"超期倍数"排序，不是按时间。** 直接按 `last_check_at ASC` 排序会让
 *    一堆 6 小时周期的 HEALTHY 节点长期霸占预算，10 分钟周期的新候选永远轮不上。
 *    用「已等待时长 / 该档周期」作优先级，谁超期得更狠谁先探，天然不饿死。
 */

/** 各生命周期的探测周期（分钟）。null = 永不探测。 */
export const TIER_INTERVAL_MIN: Record<string, number | null> = {
  // 新候选：快速失败淘汰。一个死节点留在候选区会一直占着池重算的算力
  DISCOVERED: 10,
  PENDING_VERIFICATION: 10,
  // 已经在坏，随时会掉 —— 这是最需要盯的一档
  DEGRADED: 30,
  VERIFIED: 120,
  UNAVAILABLE: 120,
  // 已经能用，探它只是确认还活着
  HEALTHY: 360,
  // 隔离是人工决定的，低频复查只为了给人一个"它其实好了"的提示
  QUARANTINED: 720,
  // 人工否决与撤销：不再消耗探测预算
  REJECTED: null,
  REVOKED: null,
};

/**
 * 每 tick 的探测预算。
 *
 * 60 个 × 并发 8 × 4 秒超时 ≈ 最坏 30 秒，比 15 秒的调度周期长 ——
 * 所以下面用"已有在跑的调度任务就不再入队"来防止堆积，
 * 而不是靠调小预算。探测是慢操作，让 tick 等它才是错的做法。
 */
const DEFAULT_BATCH = 60;

export interface EnqueueResult {
  jobId: string | null;
  picked: number;
  reason?: string;
}

/** 调度器创建的任务用 filter 打标记，便于"是否有任务在跑"的判断与审计 */
const SCHEDULER_MARK = `'{"source":"scheduler"}'::jsonb`;

/**
 * 回收僵死任务。
 *
 * 认领时会写 `lease_expires_at`，但进程被强杀之后没有任何东西会去清它 ——
 * 那个任务就永远停在 RUNNING，既不会被重试，也会让调度器认为
 * "已有任务在跑"从而再也不入队。表现出来就是分级探测静默停摆：
 * 没有报错、没有日志，只是什么都不再发生。
 *
 * 回收和"是否在跑"必须是**同一套判断**。这两处一旦各写一份条件，
 * 迟早会分叉成"回收了但仍在跑"或者"没回收却认为在跑"。
 */
export async function reclaimStaleJobs(): Promise<number> {
  return exec(
    `UPDATE verification_jobs
     SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL
     WHERE status = 'RUNNING'
       AND (
         (lease_expires_at IS NOT NULL AND lease_expires_at < now())
         -- 升级前认领的老行没有租约时间，只能按开始时间兜底
         OR (lease_expires_at IS NULL AND started_at < now() - interval '10 minutes')
       )`,
  );
}

export async function enqueueDueProbes(batch = DEFAULT_BATCH): Promise<EnqueueResult> {
  // 先回收僵死任务，再判断"是否已有任务在跑" —— 顺序反了，
  // 一个刚过期的任务会让这一轮直接放弃入队。
  await reclaimStaleJobs();

  // 上一个调度任务还没跑完：不再入队。否则慢探测期间每 15 秒堆一个任务，
  // 同一个端点被并发探多次，health_checks 里全是重复样本，24h 聚合被稀释。
  const busy = await q<{ id: string }>(
    `SELECT id FROM verification_jobs
     WHERE status IN ('PENDING','RUNNING') AND filter = ${SCHEDULER_MARK}
     LIMIT 1`,
  );
  if (busy.length > 0) return { jobId: null, picked: 0, reason: 'busy' };

  const due = await q<{ id: string }>(
    `WITH tier(status, minutes, prio) AS (
       VALUES ('DISCOVERED',10,90), ('PENDING_VERIFICATION',10,90),
              ('DEGRADED',30,70), ('VERIFIED',120,50), ('UNAVAILABLE',120,40),
              ('HEALTHY',360,20), ('QUARANTINED',720,10)
     )
     SELECT e.id
     FROM proxy_endpoints e
     JOIN tier t ON t.status = e.lifecycle_status::text
     LEFT JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
     WHERE e.deleted_at IS NULL
       AND COALESCE(hs.last_check_at, e.created_at) <= now() - (t.minutes || ' minutes')::interval
     ORDER BY EXTRACT(EPOCH FROM (now() - COALESCE(hs.last_check_at, e.created_at)))
                / (t.minutes * 60) DESC,
              t.prio DESC
     LIMIT $1`,
    [batch],
  );

  if (due.length === 0) return { jobId: null, picked: 0, reason: 'nothing-due' };

  const ids = due.map((r) => r.id);
  const row = await q<{ id: string }>(
    `INSERT INTO verification_jobs (scope, endpoint_ids, status, total, priority, filter)
     VALUES ('ENDPOINTS', $1::uuid[], 'PENDING', $2, 50, ${SCHEDULER_MARK})
     RETURNING id`,
    [ids, ids.length],
  );

  return { jobId: row[0]?.id ?? null, picked: ids.length };
}

/**
 * 各档位当前的到期数量。
 *
 * 只给 `GET /verification/schedule` 用：界面要能回答"为什么它还没被探到"。
 * 没有这个数字，用户只能看到一个静止的 lifecycle_status，
 * 分不清是"调度没开"还是"排在后面还没轮到"。
 */
export async function scheduleBacklog(): Promise<
  Array<{ status: string; intervalMin: number | null; due: number; total: number }>
> {
  const rows = await q<{ status: string; due: string; total: string }>(
    `WITH tier(status, minutes) AS (
       VALUES ('DISCOVERED',10), ('PENDING_VERIFICATION',10), ('DEGRADED',30),
              ('VERIFIED',120), ('UNAVAILABLE',120), ('HEALTHY',360), ('QUARANTINED',720)
     )
     SELECT e.lifecycle_status::text AS status,
            count(*) FILTER (
              WHERE COALESCE(hs.last_check_at, e.created_at)
                    <= now() - (t.minutes || ' minutes')::interval
            )::text AS due,
            count(*)::text AS total
     FROM proxy_endpoints e
     JOIN tier t ON t.status = e.lifecycle_status::text
     LEFT JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
     WHERE e.deleted_at IS NULL
     GROUP BY e.lifecycle_status, t.minutes
     ORDER BY t.minutes`,
  );

  const byStatus = new Map(rows.map((r) => [r.status, r]));
  return Object.entries(TIER_INTERVAL_MIN).map(([status, intervalMin]) => {
    const r = byStatus.get(status);
    return {
      status,
      intervalMin,
      due: Number(r?.due ?? 0),
      total: Number(r?.total ?? 0),
    };
  });
}

/** 清理遗留的调度任务记录，避免 verification_jobs 无限增长 */
export async function pruneSchedulerJobs(keepDays = 7): Promise<number> {
  return exec(
    `DELETE FROM verification_jobs
     WHERE filter = ${SCHEDULER_MARK}
       AND status IN ('SUCCEEDED','FAILED')
       AND created_at < now() - ($1 || ' days')::interval`,
    [String(keepDays)],
  );
}
