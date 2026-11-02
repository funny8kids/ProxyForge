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
  // 已经探过一次、还没出结论。
  //
  // 这里从 10 分钟放宽到 30 分钟，理由是 10 分钟只对**复探**有意义 ——
  // 首次探测本来就是立刻排的（见 DUE_PREDICATE）。而一个已经失败过一次的
  // 免费代理，十分钟后再试一次几乎不可能翻盘，却要占掉本可以给
  // VERIFIED（关键路径）的预算。实测：120/轮的晋级速度下，10 分钟复探
  // 让待验证队列涨到 3949 个，而其中九成是已经死掉的。
  PENDING_VERIFICATION: 30,
  // 已经在坏，随时会掉 —— 这是最需要盯的一档
  DEGRADED: 30,
  // 过了第一次探测、还差一次连续成功才算 HEALTHY。
  // 这一档的**唯一**用途就是尽快凑出第二次确认，所以必须短：
  // 给 120 分钟的话，节点导入后两小时内一个都不会变成 HEALTHY，
  // 而订阅只收 HEALTHY/DEGRADED —— 等于导入当天完全不可用。
  VERIFIED: 15,
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
 * 各档位的复探配额占比，以及探测价值优先级。
 *
 * 为什么需要配额：七个档位在抢同一份探测预算，而它们之间没有天然的"汇率"。
 * 按超期倍数排，欠得久但没价值的探测会插到关键路径前面 —— 实测后果是
 * VERIFIED 被 PENDING 永久饿死（PENDING 超期 20 分钟算 2.0 倍，
 * VERIFIED 超期 5 分钟算 0.33 倍），`VERIFIED total` 一直涨而 `HEALTHY`
 * 一个不增，看起来像"节点质量差"，实际是确认探测根本没发生。
 *
 * 按优先级排（VERIFIED 绝对优先）能救活关键路径，但会把 HEALTHY 饿死 ——
 * 那样订阅里会长期留着已经死掉的节点，比不产出更糟。
 *
 * 两边都要保，就只能显式分配：每档一个保底份额，用不完的余量再按优先级
 * 让给别的档。这样"任何一档都不会饿死"是构造出来的，不是靠排序碰巧。
 *
 * 份额依据是**这一档的探测有多重要**：
 *   VERIFIED 45% —— 通往 HEALTHY 的唯一关键路径，整条链路的产出速度由它决定
 *   DEGRADED 15% —— 已经在用而且正在坏，探它能决定要不要摘掉
 *   PENDING 15%  —— 可能是新的可用节点，但九成是死的
 *   HEALTHY 12%  —— 确认已知结论，但必须探：否则死节点会一直留在订阅里
 *   其余 13%     —— DISCOVERED / UNAVAILABLE / QUARANTINED 的低频复核
 */
const TIER_PLAN: Array<{ status: string; share: number; prio: number }> = [
  { status: 'VERIFIED', share: 0.45, prio: 100 },
  { status: 'DEGRADED', share: 0.15, prio: 85 },
  { status: 'PENDING_VERIFICATION', share: 0.15, prio: 70 },
  { status: 'DISCOVERED', share: 0.05, prio: 70 },
  { status: 'HEALTHY', share: 0.12, prio: 60 },
  { status: 'UNAVAILABLE', share: 0.05, prio: 40 },
  { status: 'QUARANTINED', share: 0.03, prio: 10 },
];

/**
 * 把档位表编译成 SQL VALUES (status, minutes, prio, share)。
 *
 * 之前这段 SQL 是手写的字面量，于是"改了 TIER_INTERVAL_MIN 但忘了改 SQL"
 * 会静默生效于一半代码路径：界面按新间隔算 due，调度器按旧间隔入队。
 * 两边都不报错，只是数字对不上。让它从同一份常量生成，这类分叉就不可能发生。
 */
const TIER_VALUES = TIER_PLAN.map((t) => {
  const minutes = TIER_INTERVAL_MIN[t.status];
  if (minutes === undefined) throw new Error(`档位 ${t.status} 缺少间隔定义`);
  return `('${t.status}',${minutes},${t.prio},${t.share})`;
}).join(', ');

/**
 * 每 tick 的探测预算。
 *
 * 120 个 × 并发 48 × 4 秒超时 ≈ 最坏 10 秒，仍在 15 秒的调度周期之内；
 * 但死代理多半是连接被拒（毫秒级返回），实际远快于最坏值。
 * 下面仍然用"已有在跑的调度任务就不再入队"来防止堆积 ——
 * 探测是慢操作，让 tick 等它才是错的做法。
 *
 * 预算要跟并发一起调：只加预算不加并发，批次跑不完就会被 busy 守卫跳过，
 * 实际吞吐反而不变。这两个数是一组。
 */
const DEFAULT_BATCH = Number(process.env.PF_PROBE_BATCH ?? 120);

export interface EnqueueResult {
  jobId: string | null;
  picked: number;
  reason?: string;
}

/** 调度器创建的任务用 filter 打标记，便于"是否有任务在跑"的判断与审计 */
const SCHEDULER_MARK = `'{"source":"scheduler"}'::jsonb`;

/**
 * 「这一档该探了」的判定。要求查询里有 `e`（端点）与 `hs`（健康态）两个别名，
 * 以及带 `minutes` 列的 `t`。
 *
 * 这是"到期"的**定义**，给界面统计用；入队查询按 FRESH_SHARE 拆成
 * "从没探过"和"该复探"两半，合起来正好是这里的并集。
 * 两边必须同口径：分别写的话很容易一边改了另一边没改，
 * 结果界面显示"0 个到期"而调度器实际入了 60 个。
 *
 * 关键点：从没探测过的端点立刻算到期。
 * tier 里的分钟数是**复探**间隔（探过之后隔多久再探），
 * 早期版本用 `COALESCE(last_check_at, created_at) <= now() - interval`
 * 把这个间隔也套在了首次探测上 —— 于是新晋级的端点要干等 10 分钟才轮到第一次体检，
 * 表现为"晋级了 400 个，探测队列 due=0，界面一动不动"。
 */
const DUE_PREDICATE = `(
  hs.last_check_at IS NULL
  OR hs.last_check_at <= now() - (t.minutes || ' minutes')::interval
)`;

/**
 * 首次探测与复探的配额比例。
 *
 * 为什么需要配额，而不是靠一条 ORDER BY 排完：
 *
 *   把"从没探过"排在绝对最前 → 复探被饿死。只要有 60 个新端点待探，
 *   任何复探都轮不上，于是 VERIFIED 永远等不到第二次确认、
 *   PENDING_VERIFICATION 永远凑不满 3 次失败、REJECTED 永远不会出现。
 *   现场表现是 `VERIFIED due` 恒为 0，健康节点数永远是 0。
 *
 *   反过来把"超期倍数"排在最前 → 新端点被饿死。复探积压一旦形成，
 *   新晋级的端点永远排在后面，晋级了但没人探。
 *
 * 两边都可能饿死，所以这里显式切预算：一半给新端点，一半给复探。
 * 某一侧不足时余量让给另一侧（见 enqueueDueProbes），保证批次用满。
 */
const FRESH_SHARE = 0.5;

/**
 * 超期倍数 = 已等待时长 / 该档周期。同档内按它排序。
 *
 * 用它而不是绝对时间：一个健康节点 6 小时该复核、一个降级节点 30 分钟该复核，
 * 后者超期 30 分钟比前者超期 1 小时更急。用绝对时间排序会让慢档位永远排不上。
 *
 * 档位**之间**不按它排 —— 那会让欠得久但没价值的探测插到关键路径前面，
 * 档位之间的分配由 TIER_PLAN 的 share 保证（见该常量注释）。
 */
const OVERDUE_RATIO = `EXTRACT(EPOCH FROM (now() - hs.last_check_at)) / (t.minutes * 60)`;

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

  // 首次探测与复探分开取，各自有配额 —— 详见 FRESH_SHARE 与 TIER_PLAN 的注释。
  const freshQuota = Math.max(1, Math.ceil(batch * FRESH_SHARE));

  const fresh = await q<{ id: string }>(
    `WITH tier(status, minutes, prio, share) AS (
       VALUES ${TIER_VALUES}
     )
     SELECT e.id
     FROM proxy_endpoints e
     JOIN tier t ON t.status = e.lifecycle_status::text
     LEFT JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
     WHERE e.deleted_at IS NULL
       AND hs.last_check_at IS NULL
     ORDER BY t.prio DESC, e.created_at ASC
     LIMIT $1`,
    [freshQuota],
  );

  // 复探配额 = 剩余额度。首次探测不足时，余量全部让给复探。
  const recheckQuota = batch - fresh.length;
  // 每档用 row_number 取"该档内欠得最多的前 share 比例个"，实现保底份额。
  // 用窗口函数而不是发 7 条查询：一次扫描就够，也不用担心七次扫描之间
  // 数据变了导致份额被打破。
  const recheck = recheckQuota > 0
    ? (
        await q<{ id: string }>(
          `WITH tier(status, minutes, prio, share) AS (
             VALUES ${TIER_VALUES}
           ), cand AS (
             SELECT e.id,
                    e.lifecycle_status::text AS status,
                    ${OVERDUE_RATIO} AS ratio,
                    row_number() OVER (
                      PARTITION BY e.lifecycle_status
                      ORDER BY ${OVERDUE_RATIO} DESC
                    ) AS rn
             FROM proxy_endpoints e
             JOIN tier t ON t.status = e.lifecycle_status::text
             JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
             WHERE e.deleted_at IS NULL
               AND hs.last_check_at <= now() - (t.minutes || ' minutes')::interval
           )
           SELECT c.id
           FROM cand c
           JOIN tier t ON t.status = c.status
           WHERE c.rn <= GREATEST(1, ceil($1::numeric * t.share))
           ORDER BY t.prio DESC, c.ratio DESC`,
          [recheckQuota],
        )
      ).slice(0, recheckQuota)
    : [];

  // 复探不足时，把余量还给首次探测 —— 否则新端点排队却白占着批次额度。
  const spare = batch - fresh.length - recheck.length;
  const extraFresh = spare > 0
    ? await q<{ id: string }>(
        `WITH tier(status, minutes, prio, share) AS (
           VALUES ${TIER_VALUES}
         )
         SELECT e.id
         FROM proxy_endpoints e
         JOIN tier t ON t.status = e.lifecycle_status::text
         LEFT JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
         WHERE e.deleted_at IS NULL
           AND hs.last_check_at IS NULL
           AND NOT (e.id = ANY($2::uuid[]))
         ORDER BY t.prio DESC, e.created_at ASC
         LIMIT $1`,
        [spare, fresh.map((r) => r.id)],
      )
    : [];

  const due = [...fresh, ...recheck, ...extraFresh];

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
 * 启动时回收**全部** RUNNING 任务。
 *
 * 只适用于单 worker 部署（PF_WORKER_MODE=embedded）。那种形态下
 * "此刻还有 RUNNING 任务"只能说明它是上一个进程留下的 —— 因为唯一的
 * worker 就是当前进程，而它才刚起来。
 *
 * 为什么不能只靠 `reclaimStaleJobs` 的租约到期：租约按分钟计，
 * 进程重启后到租约过期之间，调度器的 busy 守卫会认为"有任务在跑"
 * 从而一直不入队。表现出来就是**重启后探测静默停摆几分钟**，
 * 日志里只有一行 busy，没有任何错误。这个坑在开发中已经踩过两次。
 */
export async function reclaimAllRunning(): Promise<number> {
  return exec(
    `UPDATE verification_jobs
     SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL
     WHERE status = 'RUNNING'`,
  );
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
    `WITH tier(status, minutes, prio) AS (
       VALUES ${TIER_VALUES}
     )
     SELECT e.lifecycle_status::text AS status,
            count(*) FILTER (WHERE ${DUE_PREDICATE})::text AS due,
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

/**
 * 清理全部终态验证任务。
 *
 * 与 `pruneSchedulerJobs` 的区别是**不再按 filter 过滤**：那个函数只清
 * 调度器自动建的批次，手工发起和池级发起的任务永远留在表里。表本身不大，
 * 但 `/verification/jobs` 是分页查询，而 `health_checks.job_id` 也指向它 ——
 * 留着几万条已完成的旧任务，每次翻历史都要扫过它们。
 *
 * 保留期比调度任务长（30 天 vs 7 天）：手工任务的批次是人工操作的凭据，
 * 出问题时要能回溯"上周那次全量探测跑了什么"。调度任务每 15 秒一条，
 * 只对最近几轮有意义。
 */
export async function pruneFinishedJobs(keepDays = 30): Promise<number> {
  return exec(
    `DELETE FROM verification_jobs
      WHERE status IN ('SUCCEEDED','FAILED','CANCELLED')
        AND filter <> ${SCHEDULER_MARK}
        AND created_at < now() - ($1 || ' days')::interval`,
    [String(keepDays)],
  );
}
