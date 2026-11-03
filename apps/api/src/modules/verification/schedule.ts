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
  // 已经在坏，随时会掉 —— 这是最需要盯的一档。
  //
  // 从 30 分钟降到 10 分钟。原因不是"它掉得快"，而是**恢复路径太长**：
  // 一个节点从 DEGRADED 回到 HEALTHY 要连续两次成功（`cs >= 2`），
  // 30 分钟一轮意味着最坏要等一小时。而实测发现单次失败里有一半是
  // 误判（并发丢 SYN 导致的假 TCP_TIMEOUT），等于让一堆本来能用的节点
  // 在订阅尾部待一小时。
  //
  // 负载上 DEGRADED 约 600 个 / 10 分钟 = 每分钟 60 个，探测吞吐有
  // 800–900 个/分钟的余量，占得起。
  DEGRADED: 10,
  // 过了第一次探测、还差一次连续成功才算 HEALTHY。
  // 这一档的**唯一**用途就是尽快凑出第二次确认，所以必须短：
  // 给 120 分钟的话，节点导入后两小时内一个都不会变成 HEALTHY，
  // 而订阅只收 HEALTHY/DEGRADED —— 等于导入当天完全不可用。
  VERIFIED: 15,
  UNAVAILABLE: 120,
  // 已经能用，但必须持续确认它**现在**还能用。
  //
  // 这里从 360 分钟降到 30 分钟。360 分钟对公开代理池是完全错的量级：
  // 免费节点存活期是几十分钟，而订阅只收 HEALTHY/DEGRADED —— 节点一旦
  // 晋级就 6 小时无人过问，订阅里发的全是几小时前的快照。
  //
  // 实测后果：池里 300 个成员没有一个在 30 分钟内成功过，位置 50 之后
  // 可用率 0%。那不是排序问题，是这份状态早就不代表现实了。
  //
  // 30 分钟是与 DEGRADED 对齐的值，语义也顺：健康节点半小时确认一次。
  // 负载上 820 个 HEALTHY / 30 分钟 ≈ 每分钟 27 个，而 HEALTHY 的保底
  // 份额是每分钟约 56 个，到期即可探，不会积压。
  HEALTHY: 30,
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

/**
 * 批次真正的上限：**单线程库能吸收多少**，而不是「有多少供给」。
 *
 * 这个约束是被实测逼出来的。PGlite 是单线程 WASM，每次 `t.query()` 都同步
 * 阻塞事件循环，所以落库耗时直接等于事件循环被占用的时长。而探测的响应读取
 * 也跑在同一个事件循环上 —— 落库占得越久，探测读到半截响应就超时，被判成
 * `PROTOCOL_ERROR`（`readUntil` 超时后只是把已读到的部分返回，上层看到响应
 * 不完整就归为协议错误，本质是**伪装成协议错误的超时**）。
 *
 * 实测（2026-11）：
 *   · 批次 122 → 落库 1.7s / 墙钟 7s  ≈ 24% 占用，HEALTHY 稳定
 *   · 批次 1063 → 落库 14.7s / 墙钟 55s ≈ 27% 占用，HEALTHY 12 分钟掉 100 个
 *
 * 停机复核那批"刚被降级"的端点，**73%（29/40）在空闲条件下仍然存活** ——
 * 判决站不住脚。把批次压回 400（占用 16%）后 HEALTHY 立刻转为上升
 * （920 → 949 / 6 分钟）。因果链确认。
 *
 * 所以这里不再把 `PF_PROBE_BATCH` 当成硬额度，而是当成**上限**，
 * 实际额度由「每批实测的 ms/条」反推：预算 ÷ 单条成本。
 * 这样表变大、单条成本上升时，批次会自动收缩，而不是等到 HEALTHY 开始掉
 * 才有人去查。
 */
const DB_BUDGET_MS = Number(process.env.PF_PROBE_DB_BUDGET_MS ?? 5000);

/** 再紧也不能低于这个数：批次太小会让每轮的固定开销（回收、查询规划）摊不薄 */
const MIN_BATCH = 120;

/**
 * 每条落库耗时的指数移动平均。
 *
 * 用 EMA 而不是"取上一批"：单批会因为分区路由、WAL checkpoint 之类的偶发
 * 因素抖动，直接反馈会把批次搞得忽大忽小。
 */
let dbMsPerItemEma = 0;

/** 探测 worker 每批结束后回报实测的「每条落库耗时」。 */
export function noteProbeDbCost(msPerItem: number): void {
  if (!Number.isFinite(msPerItem) || msPerItem <= 0) return;
  dbMsPerItemEma = dbMsPerItemEma === 0
    ? msPerItem
    : dbMsPerItemEma * 0.7 + msPerItem * 0.3;
}

/** 当前生效的批次上限（未测到成本前不设限，让首批按配置跑）。 */
export function probeBatchCap(): number {
  if (dbMsPerItemEma <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(MIN_BATCH, Math.floor(DB_BUDGET_MS / dbMsPerItemEma));
}

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
 * 僵死任务的判定窗口。
 *
 * 一次调度任务的正常时长在 10–20 秒量级（120 个端点 / 48 并发 × 4 秒超时），
 * 10 分钟已是 30 倍余量。
 *
 * **这个窗口必须同时用于「回收」和「是否在跑」两处。** 见 reclaimStaleJobs。
 */
const STALE_JOB_MINUTES = 10;

/**
 * 「这个任务还活着」的唯一判定。
 *
 * 回收（reclaimStaleJobs）、入队闸门（enqueueDueProbes）、日志（worker/main）
 * 三处必须共用它。曾经回收只看 `status='RUNNING'`，而闸门看
 * `status IN ('PENDING','RUNNING')` —— 两套条件分叉的直接后果：
 * 一个被强杀在 PENDING 的调度任务（`started_at` 已写、`finished_at` 为空）
 * 永远不会被回收，也永远挡着入队，**分级探测静默停摆，日志里只有
 * 每 15 秒一行「探测暂停」**，而库里所有端点再也没被探过一次。
 *
 * 实测就是这么停的：任务 46506903 停在 PENDING、completed 25/120，
 * 之后 8 分钟里 healthy / pending / total 三个数字一个都没动。
 *
 * 第二次踩同一个坑，形态更隐蔽：任务是 `PENDING` 且 `started_at` **为 NULL**
 * （建了但一次都没被认领）。旧条件写的是 `started_at IS NULL OR ...` ——
 * 把"还没开始"当成"刚刚开始"，于是它永远算活跃、永远挡着入队；而回收
 * 那边要求 `started_at IS NOT NULL`，又永远碰不到它。两边合起来是一个
 * 永久死锁：探测停摆 96 分钟，日志每 15 秒一行「探测暂停」，没有任何报错。
 *
 * 所以时间基准必须是 `COALESCE(started_at, created_at)`：没被认领的任务
 * 用创建时间衡量年龄。回收与闸门都拿它跟同一个阈值比较，两处才真正同口径。
 */
export const ACTIVE_JOB_PREDICATE = `status IN ('PENDING','RUNNING')
       AND attempts < max_attempts
       AND COALESCE(started_at, created_at) > now() - interval '${STALE_JOB_MINUTES} minutes'`;

/**
 * 回收僵死任务。
 *
 * 认领时会写 `lease_expires_at`，但进程被强杀之后没有任何东西会去清它 ——
 * 那个任务就永远停在 RUNNING（或者停在 PENDING 但带着 started_at），
 * 既不会被重试，也会让调度器认为"已有任务在跑"从而再也不入队。
 * 表现出来就是分级探测静默停摆：没有报错、没有日志，只是什么都不再发生。
 *
 * 回收和"是否在跑"必须是**同一套判断**（共用 ACTIVE_JOB_PREDICATE）。
 * 这两处一旦各写一份条件，迟早会分叉成"回收了但仍在跑"或者
 * "没回收却认为在跑"。
 *
 * 超窗的任务直接标 FAILED 而不是退回 PENDING：它能挂这么久说明是
 * 进程被强杀留下的残骸，退回 PENDING 只会让它在下一个 tick 里
 * 再死一次，而 attempts 每次 +1，最后卡在 `attempts >= max_attempts`
 * 的 PENDING 上 —— 那是比 RUNNING 更难发现的死锁。
 */
export async function reclaimStaleJobs(): Promise<number> {
  return exec(
    `UPDATE verification_jobs
     SET status = 'FAILED',
         lease_owner = NULL,
         lease_expires_at = NULL,
         finished_at = now()
     WHERE (
             -- 超窗：进程被强杀留下的残骸
             status IN ('PENDING','RUNNING')
             AND COALESCE(started_at, created_at) < now() - interval '${STALE_JOB_MINUTES} minutes'
           )
        OR (
             -- 重试耗尽却还挂在 PENDING 上：认领查询要求 attempts < max_attempts，
             -- 所以它永远不会再跑一次。这种任务必须显式终结 ——
             -- ACTIVE_JOB_PREDICATE 已经把它排除在"活跃"之外，
             -- 但如果不标 FAILED，它会永远躺在列表里，界面上看是"排队中"。
             status = 'PENDING' AND attempts >= max_attempts
           )`,
  );
}

export async function enqueueDueProbes(batch = DEFAULT_BATCH): Promise<EnqueueResult> {
  // 把「配置额度」和「库能吸收的额度」取小 —— 见 DB_BUDGET_MS 的注释。
  batch = Math.min(batch, probeBatchCap());

  // 先回收僵死任务，再判断"是否已有任务在跑" —— 顺序反了，
  // 一个刚过期的任务会让这一轮直接放弃入队。
  await reclaimStaleJobs();

  // 上一个调度任务还没跑完：不再入队。否则慢探测期间每 15 秒堆一个任务，
  // 同一个端点被并发探多次，health_checks 里全是重复样本，24h 聚合被稀释。
  const busy = await q<{ id: string }>(
    `SELECT id FROM verification_jobs
     WHERE ${ACTIVE_JOB_PREDICATE} AND filter = ${SCHEDULER_MARK}
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
  //
  // 同档内**池成员优先**。理由很直接：池成员是真正会被下发到订阅里的
  // 那批节点，它们的状态陈旧度直接等于用户看到的故障率；而池外节点
  // 探得再勤也不产出。实测过一次：池里 181 个成员 / HEALTHY 配额
  // 每分钟约 56 个，池成员优先后 3 分钟就能轮一遍，订阅几乎始终新鲜。
  //
  // 注意这只改变档位**内部**的顺序，不改变档位之间的份额分配 ——
  // 跨档优先级仍由 t.prio 与 share 决定，池外节点不会被饿死。
  const recheck = recheckQuota > 0
    ? (
        await q<{ id: string }>(
          `WITH tier(status, minutes, prio, share) AS (
             VALUES ${TIER_VALUES}
           ), cand AS (
             SELECT e.id,
                    e.lifecycle_status::text AS status,
                    ${OVERDUE_RATIO} AS ratio,
                    EXISTS (
                      SELECT 1 FROM resource_pool_members m
                      WHERE m.endpoint_id = e.id AND m.suppressed = false
                    ) AS in_pool,
                    row_number() OVER (
                      PARTITION BY e.lifecycle_status
                      ORDER BY EXISTS (
                        SELECT 1 FROM resource_pool_members m2
                        WHERE m2.endpoint_id = e.id AND m2.suppressed = false
                      ) DESC, ${OVERDUE_RATIO} DESC
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
           ORDER BY t.prio DESC, c.in_pool DESC, c.ratio DESC`,
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

  /**
   * 还有余量 → 让给「已经到期、但被档位份额挤掉」的端点。
   *
   * 前两轮只处理「首次探测」和「份额内的复探」，两者都不足时余量就空着。
   * 实测这是常态而不是边缘情况：一次批次实际只取到 426 个，而 batch 是 1200 ——
   * 同时 PENDING_VERIFICATION 有 787 个**已经到期**，却被 15% 的份额卡在 180 个。
   * 也就是每轮有 65% 的探测预算在空转。
   *
   * 这不是"多探一些死节点"的浪费：份额的存在是为了防止某一档饿死别档，
   * 而这里只在**别的档位都没有需求**时才动用余量，饿死的前提不成立。
   * 反过来，PENDING 积压正是新候选进不来的原因 ——
   * 它在 `PF_INGEST_PROBE_BACKLOG` 里占着名额，消化不掉，晋级就停。
   */
  const spare2 = batch - fresh.length - recheck.length - extraFresh.length;
  const overflow = spare2 > 0
    ? await q<{ id: string }>(
        `WITH tier(status, minutes, prio, share) AS (
           VALUES ${TIER_VALUES}
         )
         SELECT e.id
         FROM proxy_endpoints e
         JOIN tier t ON t.status = e.lifecycle_status::text
         JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
         WHERE e.deleted_at IS NULL
           AND hs.last_check_at <= now() - (t.minutes || ' minutes')::interval
           AND NOT (e.id = ANY($2::uuid[]))
         ORDER BY t.prio DESC, ${OVERDUE_RATIO} DESC
         LIMIT $1`,
        [spare2, [...fresh, ...recheck, ...extraFresh].map((r) => r.id)],
      )
    : [];

  const due = [...fresh, ...recheck, ...extraFresh, ...overflow];

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
 *
 * `started_at` 也必须清空 —— 只改 status 会留下一个
 * "PENDING 但带着旧 started_at"的行，而 `ACTIVE_JOB_PREDICATE` 会把
 * 10 分钟内的这种行当成仍在运行，于是重启后照样要干等 10 分钟。
 * 清空之后 `claimJobs` 会在 500ms 内重新认领并把它跑完，这才是
 * "重启后立刻恢复"该有的行为。
 */
export async function reclaimAllRunning(): Promise<number> {
  /**
   * 孤儿任务直接判 **FAILED**，不是退回 PENDING。
   *
   * 退回 PENDING 看着更"温和"（任务还能被重跑），但它会踩上一个更糟的坑：
   * `ACTIVE_JOB_PREDICATE` 把「PENDING 且 created_at 在 10 分钟内」也算作
   * 正在跑（那是为了防止同一个端点被并发探多次）。于是被回收的孤儿任务
   * 一边挡着 busy 守卫、一边自己又因为 `attempts` 已经用满而永远不会被
   * 认领 —— 探测会静默停摆整整 10 分钟。实测每次重启都会撞上。
   *
   * 判 FAILED 之后：busy 守卫立刻放开，那些端点仍处于"到期"状态，
   * 下一个调度周期会重新入队。半途而废的那批探测结果本来就丢了，
   * 留着任务记录也只是噪音。
   */
  return exec(
    `UPDATE verification_jobs
     SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL, finished_at = now()
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
  /**
   * 两条查询，**不能合并成一条**。
   *
   * `TIER_VALUES` 来自 `TIER_PLAN`，而 `TIER_PLAN` 里没有 REJECTED / REVOKED
   * （它们的周期是 null，永不探测，不该参与份额分配）。所以拿 tier 表去 JOIN
   * 端点会把这两个档位整档过滤掉 —— 接口返回 `REJECTED total=0`，而库里实际
   * 有 27,583 个。界面上看就像"没有任何节点被判死"，与事实相反。
   *
   * 到期数只能靠 tier 表算（要用到 t.minutes），总数不需要，所以分开取。
   */
  const dueRows = await q<{ status: string; due: string }>(
    `WITH tier(status, minutes, prio) AS (
       VALUES ${TIER_VALUES}
     )
     SELECT e.lifecycle_status::text AS status,
            count(*) FILTER (WHERE ${DUE_PREDICATE})::text AS due
     FROM proxy_endpoints e
     JOIN tier t ON t.status = e.lifecycle_status::text
     LEFT JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
     WHERE e.deleted_at IS NULL
     GROUP BY e.lifecycle_status`,
  );

  const totalRows = await q<{ status: string; total: string }>(
    `SELECT lifecycle_status::text AS status, count(*)::text AS total
     FROM proxy_endpoints
     WHERE deleted_at IS NULL
     GROUP BY lifecycle_status`,
  );

  const dueByStatus = new Map(dueRows.map((r) => [r.status, r.due]));
  const totalByStatus = new Map(totalRows.map((r) => [r.status, r.total]));

  return Object.entries(TIER_INTERVAL_MIN).map(([status, intervalMin]) => ({
    status,
    intervalMin,
    // 周期为 null 的档位（REJECTED / REVOKED）永远不到期，到期数恒为 0
    due: intervalMin === null ? 0 : Number(dueByStatus.get(status) ?? 0),
    total: Number(totalByStatus.get(status) ?? 0),
  }));
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
