import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { exec, q, q1 } from '../db/client.js';
import { recomputePool } from '../modules/pool/index.js';
import { applyPolicies, defaultInstanceId } from '../modules/policy/index.js';
import { runVerificationJob } from '../modules/verification/index.js';

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
const stats = { outbox: 0, jobs: 0, errors: 0 };
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

async function relayOutbox(): Promise<void> {
  // PGlite 单连接，SKIP LOCKED 语义退化为普通加锁；生产 PG 下才真正并行
  const events = await q<{ id: string; event_id: string; event_type: string; aggregate_type: string; aggregate_id: string; payload: unknown }>(
    `SELECT id, event_id, event_type, aggregate_type, aggregate_id, payload
     FROM event_outbox
     WHERE published_at IS NULL AND attempts < 5
     ORDER BY id
     LIMIT 100`,
  );

  for (const evt of events) {
    try {
      // 事件消费者在这里挂载。当前阶段只做"已发布"标记，
      // 消费方（缓存失效、通知、指标）在 Phase 2 接入。
      await exec('UPDATE event_outbox SET published_at = now(), attempts = attempts + 1 WHERE id = $1', [evt.id]);
      stats.outbox += 1;
    } catch (err) {
      stats.errors += 1;
      await exec(
        'UPDATE event_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
        [evt.id, err instanceof Error ? err.message : String(err)],
      );
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
}

async function tick(): Promise<void> {
  if (!running.value) return;
  try {
    await relayOutbox();
    await claimJobs();
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
    // 成员变化后重新编译下发
    await applyPolicies(await defaultInstanceId(), null);
    const hb = await q1<{ c: string }>('SELECT count(*)::text AS c FROM gateway_instances');
    if (Number(hb?.c ?? 0) > 0) {
      await exec('UPDATE proxy_nodes SET last_heartbeat_at = now()');
    }
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
