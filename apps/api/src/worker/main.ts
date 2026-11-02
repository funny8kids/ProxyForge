import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { exec, q, q1 } from '../db/client.js';
import { recomputePool } from '../modules/pool/index.js';
import { applyPolicies, defaultInstanceId } from '../modules/policy/index.js';
import { runVerificationJob } from '../modules/verification/index.js';
import { runDiscoveryTask } from '../modules/ai/discovery.js';
import { applyRuntime } from '../modules/gateway/runtime.js';
import { CONSUMERS, type Consumer } from '../modules/events/consumers.js';
import { evaluateAlerts } from '../modules/events/evaluate.js';

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

function noteError(scope: string, err: unknown): void {
  stats.errors += 1;
  const message = err instanceof Error ? `${scope}: ${err.message}` : `${scope}: ${String(err)}`;
  lastError = { message: message.slice(0, 300), at: new Date().toISOString() };
}

export function workerHealth(): { errors: number; lastError: string | null; lastErrorAt: string | null } {
  return {
    errors: stats.errors,
    lastError: lastError?.message ?? null,
    lastErrorAt: lastError?.at ?? null,
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

async function claimJobs(): Promise<void> {
  const jobs = await q<{ id: string; scope: string }>(
    `SELECT id, scope FROM verification_jobs
     WHERE status = 'PENDING' AND run_after <= now() AND attempts < max_attempts
     ORDER BY priority DESC, run_after
     LIMIT 3`,
  );

  for (const job of jobs) {
    const claimed = await exec(
      `UPDATE verification_jobs SET status = 'RUNNING', lease_owner = $2, attempts = attempts + 1,
              started_at = COALESCE(started_at, now())
       WHERE id = $1 AND status = 'PENDING'`,
      [job.id, `worker-${process.pid}`],
    );
    if (claimed === 0) continue;
    try {
      await runVerificationJob(job.id);
      stats.jobs += 1;
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

async function periodic(): Promise<void> {
  if (!running.value) return;
  try {
    await maintainPartitions();
    // 池成员随健康态变化漂移，定期重算保证策略编译看到的是新鲜集合
    const pools = await q<{ id: string }>('SELECT id FROM resource_pools WHERE enabled = true');
    for (const p of pools) {
      await recomputePool(p.id);
    }
    // 成员变化后重新编译下发，并同步给运行时。
    // 只编译不下发会让"池成员已经换了"和"端口上转发用的还是旧成员"长期不一致。
    const primaryId = await defaultInstanceId();
    await applyPolicies(primaryId, null);
    await applyRuntime(primaryId);
    const hb = await q1<{ c: string }>('SELECT count(*)::text AS c FROM gateway_instances');
    if (Number(hb?.c ?? 0) > 0) {
      await exec('UPDATE proxy_nodes SET last_heartbeat_at = now()');
    }
    // 告警评估放在最后：它读的是上面几步刚写下的状态，
    // 先评估会拿上一轮的结果去判断，慢一个周期。
    const ev = await evaluateAlerts();
    if (ev.raised > 0 || ev.resolved > 0) {
      console.log(`[worker] 告警：${ev.raised} 条活跃 · ${ev.resolved} 条自动关闭`);
    }
    stats.alerts = ev.raised;
  } catch (err) {
    noteError('periodic', err);
    console.error('[worker] 周期任务失败', err);
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
