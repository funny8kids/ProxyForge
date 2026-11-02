import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { exec, q, q1 } from '../db/client.js';
import { recomputePool } from '../modules/pool/index.js';
import { applyPolicies, defaultInstanceId } from '../modules/policy/index.js';
import { runVerificationJob } from '../modules/verification/index.js';
import { enqueueDueProbes, pruneSchedulerJobs, reclaimAllRunning, reclaimStaleJobs } from '../modules/verification/schedule.js';
import { runDiscoveryTask } from '../modules/ai/discovery.js';
import { applyRuntime } from '../modules/gateway/runtime.js';
import { CONSUMERS, type Consumer } from '../modules/events/consumers.js';
import { evaluateAlerts } from '../modules/events/evaluate.js';
import { recomputeSourceQuality } from '../modules/source/quality.js';
import { runIngestCycle } from '../modules/source/ingest.js';

/**
 * Worker（与 API 同镜像、不同入口 —— 模块化单体，ADR-0001）。
 *
 * 职责：
 *   1. Outbox 中继：批量拉取未发布事件，标记已发布
 *   2. 调度器：认领到期的验证任务并执行
 *   3. 分区维护：确保未来月份分区存在
 *
 * 用 FOR UPDATE SKIP LOCKED 认领，天然支持多 worker 并行不重复。
 *
 * 运行形态（PF_WORKER_MODE）：
 *   · process  —— 真 PostgreSQL 下的常规形态，独立进程
 *   · embedded —— PGlite 单写者，循环挂在 API 进程内（本地默认）
 * 两种形态走的是同一套函数，差别只在谁持有数据库连接。
 */

const running = { value: true };
const stats = { outbox: 0, dead: 0, jobs: 0, discovery: 0, alerts: 0, errors: 0 };
/**
 * 最后一次失败的摘要。
 *
 * 只打日志是不够的：周期任务失败会被 try/catch 吞成一行
 * `[worker] 周期任务失败`，然后池成员静默地一直是 0，
 * 而界面上一切"正常"。这个摘要经 /system/status 暴露出来，
 * 让"后台在报错"变成可见状态，而不是需要翻日志才知道。
 */
let lastError: { message: string; at: string } | null = null;

/**
 * 最后一轮周期任务**成功完成**的时间。
 *
 * 不能用 `proxy_nodes.last_heartbeat_at` 代表"worker 活着"：那张表可以合法地
 * 是空的（本部署就没有 proxy_nodes 行），于是那个字段永远是 null ——
 * 排查时会误判成"worker 从没跑过"，而实际上周期任务每一轮都在正常收尾。
 * 这个字段直接回答"worker 上一轮什么时候跑完的"。
 */
let lastCycleAt: string | null = null;

function noteError(scope: string, err: unknown): void {
  stats.errors += 1;
  const message = err instanceof Error ? `${scope}: ${err.message}` : `${scope}: ${String(err)}`;
  lastError = { message: message.slice(0, 300), at: new Date().toISOString() };
}

export function workerHealth(): {
  errors: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastCycleAt: string | null;
} {
  return {
    errors: stats.errors,
    lastError: lastError?.message ?? null,
    lastErrorAt: lastError?.at ?? null,
    lastCycleAt,
  };
}

/** 事件重试上限。超过就进死信，等人工重放而不是无限重试。 */
const MAX_OUTBOX_ATTEMPTS = 5;

/**
 * Outbox 中继。
 *
 * 三个必须做对的地方：
 *
 * 1. **按消费方记状态**。`consumer_state` 存每个消费方的成败，
 *    重试时跳过已成功的那些。否则指标聚合成功、告警评估失败时，
 *    整条事件重试会让指标重复累加 —— 数字悄悄偏大，没人会发现。
 *
 * 2. **指数退避**。失败后立刻重试只会连着撞同一堵墙（比如上游 5xx
 *    持续 30 秒）。退避 2/4/8/16 秒，把重试摊开。
 *
 * 3. **死信必须可见**。超过上限标成 DEAD，而不是留在
 *    `published_at IS NULL AND attempts >= 5` 这种"既不在队列里、
 *    也不在结果里"的状态。死信会触发告警，并能从接口重放。
 */
export async function relayOutbox(consumers: Consumer[] = CONSUMERS): Promise<void> {
  // PGlite 单连接，SKIP LOCKED 语义退化为普通加锁；生产 PG 下才真正并行
  const events = await q<{
    id: string; event_id: string; event_type: string; aggregate_type: string;
    aggregate_id: string; payload: unknown; occurred_at: string; attempts: number;
    consumer_state: Record<string, { ok: boolean; at: string; error?: string }> | null;
  }>(
    `SELECT id, event_id, event_type, aggregate_type, aggregate_id, payload,
            occurred_at, attempts, consumer_state
     FROM event_outbox
     WHERE status = 'PENDING' AND next_attempt_at <= now()
     ORDER BY id
     LIMIT 100`,
  );

  for (const evt of events) {
    const state: Record<string, { ok: boolean; at: string; error?: string }> = { ...(evt.consumer_state ?? {}) };
    const failed: string[] = [];

    const event = {
      id: evt.id,
      eventId: evt.event_id,
      eventType: evt.event_type,
      aggregateType: evt.aggregate_type,
      aggregateId: evt.aggregate_id,
      payload: (evt.payload ?? {}) as Record<string, unknown>,
      occurredAt: String(evt.occurred_at),
      attempts: evt.attempts,
    };

    for (const consumer of consumers) {
      // 已成功的消费方不再执行 —— 这是"重试不重复计数"的唯一保证
      if (state[consumer.name]?.ok) continue;
      try {
        await consumer.handle(event);
        state[consumer.name] = { ok: true, at: new Date().toISOString() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state[consumer.name] = { ok: false, at: new Date().toISOString(), error: message.slice(0, 300) };
        failed.push(`${consumer.name}: ${message}`);
      }
    }

    const attempts = evt.attempts + 1;
    try {
      if (failed.length === 0) {
        await exec(
          `UPDATE event_outbox
           SET status = 'PUBLISHED', published_at = now(), attempts = $2,
               consumer_state = $3::jsonb, last_error = NULL
           WHERE id = $1`,
          [evt.id, attempts, JSON.stringify(state)],
        );
        stats.outbox += 1;
      } else if (attempts >= MAX_OUTBOX_ATTEMPTS) {
        await exec(
          `UPDATE event_outbox
           SET status = 'DEAD', dead_at = now(), attempts = $2,
               consumer_state = $3::jsonb, last_error = $4
           WHERE id = $1`,
          [evt.id, attempts, JSON.stringify(state), failed.join(' | ').slice(0, 1000)],
        );
        stats.dead += 1;
        console.warn(`[worker] 事件进入死信 ${evt.event_id}（${evt.event_type}）：${failed.join(' | ')}`);
      } else {
        // 2^attempts 秒：2, 4, 8, 16
        const delaySec = Math.min(60, 2 ** attempts);
        await exec(
          `UPDATE event_outbox
           SET attempts = $2, consumer_state = $3::jsonb, last_error = $4,
               next_attempt_at = now() + ($5 || ' seconds')::interval
           WHERE id = $1`,
          [evt.id, attempts, JSON.stringify(state), failed.join(' | ').slice(0, 1000), String(delaySec)],
        );
      }
    } catch (err) {
      noteError('outbox-write', err);
    }
  }
}

/**
 * 任务租约时长（分钟）。
 *
 * 这个数字直接决定**崩溃后探测要停多久**。租约没到期，`reclaimStaleJobs`
 * 就不会回收那个 RUNNING 任务，而调度器的 busy 守卫看到"有任务在跑"
 * 就一直不入队 —— 于是进程重启后探测会静默停摆，直到租约自然过期。
 *
 * 原来是 10 分钟，而一个调度批次的真实耗时是：
 *   60 个端点 × 4 秒超时 / 并发 24 ≈ 10 秒
 * 也就是说 10 分钟的租约是实际需要的 60 倍，纯粹是在惩罚正常重启。
 *
 * 2 分钟仍然留了 12 倍余量，够覆盖 PGlite 写入抖动与手工大批次任务。
 */
const LEASE_MINUTES = 2;

/** 上一次因 busy 而暂停探测时看到的任务 id，用于日志去重 */
let busyProbeJob: string | null = null;

async function claimJobs(): Promise<void> {  // 回收过期租约：进程在探测途中被强杀，那个任务会永远停在 RUNNING，
  // 既不会被重试也不会被清理。判断条件与调度器的"是否在跑"共用一处。
  await reclaimStaleJobs();

  const jobs = await q<{ id: string; scope: string }>(
    `SELECT id, scope FROM verification_jobs
     WHERE status = 'PENDING' AND run_after <= now() AND attempts < max_attempts
     ORDER BY priority DESC, run_after
     LIMIT 3`,
  );

  for (const job of jobs) {
    const claimed = await exec(
      `UPDATE verification_jobs SET status = 'RUNNING', lease_owner = $2, attempts = attempts + 1,
              started_at = COALESCE(started_at, now()),
              lease_expires_at = now() + ${LEASE_MINUTES} * interval '1 minute'
       WHERE id = $1 AND status = 'PENDING'`,
      [job.id, `worker-${process.pid}`],
    );
    if (claimed === 0) continue;
    try {
      const started = Date.now();
      console.log(`[worker] 验证任务开始 ${job.id.slice(0, 8)}（${job.scope}）`);
      await runVerificationJob(job.id);
      stats.jobs += 1;
      console.log(`[worker] 验证任务完成 ${job.id.slice(0, 8)}，用时 ${Date.now() - started}ms`);
    } catch (err) {
      stats.errors += 1;
      console.error('[worker] 验证任务失败', job.id, err);
      await exec(
        `UPDATE verification_jobs SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'PENDING' END,
                finished_at = now() WHERE id = $1`,
        [job.id],
      );
    }
  }
}

async function maintainPartitions(): Promise<void> {
  await exec('SELECT ensure_monthly_partitions(2)');
  await exec(`SELECT drop_expired_partitions('health_checks', 3)`);
  await exec(`SELECT drop_expired_partitions('gateway_traffic_samples', 6)`);

  /**
   * 定期检查点。
   *
   * 不是性能优化，是**抗崩溃**：PGlite 把 WAL 写缓冲在 wasm 侧，
   * 进程被强杀（`taskkill /F`、容器 OOM）时最后一段 WAL 会丢，
   * 而 pg_control 已经指向它 —— 下次启动就是
   * `PANIC: could not locate a valid checkpoint record`，整个数据目录报废。
   * 这个错误在本地已经出现过四次，每次都得 db:reset。
   *
   * CHECKPOINT 会强制刷盘并写下一条可恢复的检查点记录，把"丢失窗口"
   * 从"上次检查点到现在"压到调度周期（默认 15 秒）。
   * 代价是一次全量刷脏页；对本地这种写入量完全无所谓。
   */
  await exec('CHECKPOINT');
}

/**
 * AI 发现任务泵。
 *
 * 不 await：一次 LLM 调用几秒到几十秒，阻塞 tick 会把 outbox 中继和验证任务
 * 一起拖停。用 busy 标记保证同一时刻只有一个发现任务在跑 —— PGlite 是单连接，
 * 并发跑多个只会互相等锁。
 */
let discoveryBusy = false;

async function pumpDiscovery(): Promise<void> {
  if (discoveryBusy) return;
  const task = await q1<{ id: string }>(
    `SELECT id FROM ai_discovery_tasks
     WHERE status = 'PENDING' AND run_after <= now() AND attempts < max_attempts
     ORDER BY priority DESC, run_after ASC
     LIMIT 1`,
  );
  if (!task) return;

  discoveryBusy = true;
  void runDiscoveryTask(task.id)
    .then((r) => {
      console.log(
        `[worker] AI 发现完成 ${r.taskId.slice(0, 8)}：提出 ${r.proposed} · 采纳 ${r.accepted}` +
          (r.error ? ` · ${r.error}` : ''),
      );
      if (r.accepted > 0) stats.discovery += 1;
    })
    .catch((err) => noteError('discovery', err))
    .finally(() => {
      discoveryBusy = false;
    });
}

/**
 * 自动采集流水线泵。
 *
 * 不 await：一次同步是 20 秒级的网络操作，阻塞 tick 会把 outbox 中继和
 * 探测任务一起拖停。用 busy 标记保证同一时刻只有一轮在跑 ——
 * PGlite 是单连接，并发跑两轮只会互相等锁。
 */
let ingestBusy = false;

async function pumpIngest(): Promise<void> {
  if (ingestBusy) return;
  ingestBusy = true;
  void runIngestCycle()
    .then((r) => {
      const parts: string[] = [];
      if (r.synced > 0) {
        const ok = r.items.filter((i) => i.ok).length;
        const candidates = r.items.reduce((n, i) => n + i.candidates, 0);
        parts.push(`同步 ${r.synced} 个源（成功 ${ok}）新增候选 ${candidates}`);
      }
      if (r.promoted > 0) parts.push(`晋级 ${r.promoted} 个端点`);
      if (r.pauseReason === 'target-met') {
        parts.push(`健康公开代理 ${r.healthyPublic} 个已达标，暂停晋级`);
      } else if (r.pauseReason === 'probe-backlog') {
        parts.push(`在途待探测 ${r.awaitingProbe} 个已满，等探测消化后再晋级`);
      }
      if (parts.length > 0) console.log(`[worker] 采集：${parts.join(' · ')}`);
    })
    .catch((err) => noteError('ingest', err))
    .finally(() => {
      ingestBusy = false;
    });
}

async function tick(): Promise<void> {
  if (!running.value) return;
  try {
    await relayOutbox();
    await claimJobs();
    await pumpDiscovery();
  } catch (err) {
    noteError('tick', err);
    console.error('[worker] tick 失败', err);
  }
  setTimeout(tick, config.outboxIntervalMs);
}

/**
 * 来源质量重算的节流。
 *
 * 质量分是按"已导入端点的存活率"算的，而端点健康态由验证任务更新 ——
 * 那是以分钟为单位的节奏。每 15 秒重算一次只是把同样的数字算 20 遍，
 * 还会让 quality_computed_at 失去意义（看不出上一次真正的变化）。
 */
const QUALITY_INTERVAL_MS = 5 * 60 * 1000;
let lastQualityRun = 0;

async function periodic(): Promise<void> {
  if (!running.value) return;
  // 分步计时：周期任务里任何一步卡住，界面上只会表现为"心跳不更新"，
  // 分不清是池重算慢、网关下发卡住，还是告警评估在等锁。
  const t0 = Date.now();
  let phase = 'partitions';
  try {
    await maintainPartitions();
    phase = 'enqueue';
    // 分级探测：把到期的端点排成任务。必须在池重算**之前** ——
    // 探测会改 lifecycle_status，而池成员是按它筛的；
    // 顺序反了，这一轮的池成员用的是上一轮的健康态。
    const enq = await enqueueDueProbes();
    if (enq.picked > 0) {
      // 真正执行在 claimJobs（500ms 一次），这里只是入队
      console.log(`[worker] 探测入队 ${enq.picked} 个端点`);
      busyProbeJob = null;
    } else if (enq.reason === 'busy') {
      // 被上一个任务挡住时必须留痕。这个分支原来是完全静默的，
      // 结果是"进程重启后探测停了 10 分钟，日志里一个字都没有" ——
      // 排查时只能靠数 /verification/schedule 里的 due 才发现不对。
      // 按任务 id 去重，只在换了一个任务时打一行，避免每 15 秒刷屏。
      const running = await q1<{ id: string; age: string }>(
        `SELECT id, EXTRACT(EPOCH FROM (now() - COALESCE(started_at, created_at)))::int::text AS age
         FROM verification_jobs
         WHERE status IN ('PENDING','RUNNING') AND filter = '{"source":"scheduler"}'::jsonb
         LIMIT 1`,
      );
      if (running && running.id !== busyProbeJob) {
        busyProbeJob = running.id;
        console.warn(
          `[worker] 探测暂停：上一个调度任务 ${running.id.slice(0, 8)} 仍在运行（已 ${running.age}s）` +
            '，到期端点会排在它后面',
        );
      }
    }
    // 抓取新候选并晋级。放在探测调度之后：这一轮刚晋级的端点会进入
    // 下一轮的探测队列，而不是插到已到期节点的前面。
    phase = 'ingest';
    await pumpIngest();
    // 池成员随健康态变化漂移，定期重算保证策略编译看到的是新鲜集合
    phase = 'pools';
    const pools = await q<{ id: string }>('SELECT id FROM resource_pools WHERE enabled = true');
    for (const p of pools) {
      await recomputePool(p.id);
    }
    // 成员变化后重新编译下发，并同步给运行时。
    // 只编译不下发会让"池成员已经换了"和"端口上转发用的还是旧成员"长期不一致。
    phase = 'policies';
    const primaryId = await defaultInstanceId();
    await applyPolicies(primaryId, null);
    phase = 'runtime';
    await applyRuntime(primaryId);
    phase = 'heartbeat';
    const hb = await q1<{ c: string }>('SELECT count(*)::text AS c FROM gateway_instances');
    if (Number(hb?.c ?? 0) > 0) {
      await exec('UPDATE proxy_nodes SET last_heartbeat_at = now()');
    }
    // 来源质量：低分来源降权/停用。放在池重算之前 —— 停用会改变池成员，
    // 顺序反了会让这一轮的池成员基于还没降权的来源算出来。
    phase = 'source-quality';
    if (Date.now() - lastQualityRun > QUALITY_INTERVAL_MS) {
      lastQualityRun = Date.now();
      const qr = await recomputeSourceQuality();
      const changed = qr.filter((r) => r.action !== 'none' && r.action !== 'skipped');
      if (changed.length > 0) {
        for (const r of changed) console.log(`[worker] 来源 ${r.key}：${r.action} — ${r.detail}`);
      }
      // 调度任务每 15 秒一条，一天就是 5760 行。不清理会让这张表
      // 变成第二个只增不减的日志表，而它的价值只在最近几轮。
      await pruneSchedulerJobs(7);
    }

    // 告警评估放在最后：它读的是上面几步刚写下的状态，
    // 先评估会拿上一轮的结果去判断，慢一个周期。
    phase = 'alerts';
    const ev = await evaluateAlerts();
    if (ev.raised > 0 || ev.resolved > 0) {
      console.log(`[worker] 告警：${ev.raised} 条活跃 · ${ev.resolved} 条自动关闭`);
    }
    stats.alerts = ev.raised;
    lastCycleAt = new Date().toISOString();
    if (Date.now() - t0 > 5000) {
      console.log(`[worker] 周期任务偏慢：${Date.now() - t0}ms`);
    }
  } catch (err) {
    noteError(phase, err);
    console.error(`[worker] 周期任务失败（阶段 ${phase}）`, err);
  }
  setTimeout(periodic, config.schedulerIntervalMs);
}

/**
 * 启动 worker 循环。返回停止函数。
 * 不在此处做 migrate —— 调用方（独立进程入口 / API 启动流程）已经保证了 schema 就绪。
 */
export function startWorker(): () => void {
  running.value = true;
  console.log(`[worker] 启动 (outbox=${config.outboxIntervalMs}ms, sched=${config.schedulerIntervalMs}ms)`);

  // embedded 模式下本进程就是唯一的 worker，所以启动时看到的 RUNNING 任务
  // 必然是上一个进程的残留。立刻回收，不要等租约自然过期 ——
  // 否则 busy 守卫会让探测在重启后静默停摆几分钟。
  // process 模式不能这么做：那时可能有别的 worker 正在合法执行任务。
  if (config.workerMode === 'embedded') {
    void reclaimAllRunning()
      .then((n) => {
        if (n > 0) console.log(`[worker] 回收上次退出遗留的 ${n} 个运行中任务`);
      })
      .catch((err) => noteError('reclaim-startup', err));
  }

  void periodic();
  void tick();

  return () => {
    running.value = false;
    console.log(`[worker] 停止。统计: ${JSON.stringify(stats)}`);
  };
}

/** 独立进程入口 */
async function main(): Promise<void> {
  await migrate(false);
  console.log(`ProxyForge Worker 启动 (pid=${process.pid}, outbox=${config.outboxIntervalMs}ms)`);

  const stop = startWorker();

  const shutdown = (): void => {
    stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 只有被当作入口直接执行时才起独立进程；被 import（embedded 模式）时什么都不做
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry && import.meta.url === entry) {
  await main();
}
