import type { FastifyInstance } from 'fastify';
import type {
  CheckFailureReason,
  ProxyProtocol,
  VerificationJobRow,
  VerificationRunRequest,
} from '@proxyforge/contracts';
import { exec, q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit, emit, EVENT_TYPES } from '../../shared/events.js';
import { invalid, notFound } from '../../shared/errors.js';
import { uuidv7 } from '../../shared/id.js';
import { open } from '../../shared/crypto.js';
import { probe, qualityScore, type ProbeResult } from './probe.js';
import { linkExitGeography } from './geo.js';

/**
 * 探针模式。
 * - live：真实 DNS/TCP/握手/出口 IP（生产默认）
 * - fixture：确定性合成结果，仅供演示与回归。**每条都会打标签**，
 *   界面必须显示 "Fixture data"，绝不允许伪装成生产数据。
 */
export const PROBE_MODE: 'live' | 'fixture' =
  process.env.PF_PROBE_MODE === 'fixture' ? 'fixture' : 'live';

/** 确定性伪随机：同一 dedupeKey 每次得到同样结果，便于回归测试 */
function fixtureProbe(seed: string): ProbeResult {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rnd = (n: number) => Math.abs(h % n);
  const roll = rnd(100);

  if (roll < 6) {
    return {
      success: false, failedLayer: 1, failureReason: 'DNS_FAILURE',
      dnsMs: null, tcpMs: null, handshakeMs: null, totalMs: 12,
      exitIp: null, exitCountry: null, connectOk: null, errorDetail: 'fixture: dns failure',
    };
  }
  if (roll < 12) {
    return {
      success: false, failedLayer: 2, failureReason: 'TCP_TIMEOUT',
      dnsMs: 8 + rnd(20), tcpMs: null, handshakeMs: null, totalMs: 4000,
      exitIp: null, exitCountry: null, connectOk: null, errorDetail: 'fixture: tcp timeout',
    };
  }
  if (roll < 16) {
    return {
      success: false, failedLayer: 4, failureReason: 'AUTH_FAILED',
      dnsMs: 6 + rnd(15), tcpMs: 20 + rnd(60), handshakeMs: 30 + rnd(80), totalMs: 260,
      exitIp: null, exitCountry: null, connectOk: null, errorDetail: 'fixture: auth failed',
    };
  }

  const p50 = 18 + rnd(180);
  return {
    success: true,
    failedLayer: null,
    failureReason: 'NONE',
    dnsMs: 4 + rnd(18),
    tcpMs: 12 + rnd(70),
    handshakeMs: 20 + rnd(120),
    totalMs: p50 + 30,
    exitIp: `${10 + rnd(200)}.${rnd(255)}.${rnd(255)}.${1 + rnd(253)}`,
    exitCountry: ['SG', 'JP', 'US', 'DE', 'HK', 'GB', 'NL', 'BR'][rnd(8)]!,
    // 真实分布大约是存活节点里三分之一能开隧道（实测 40 个样本：20% 通 HTTPS、
    // 40% 只能上明文 HTTP）。合成数据按同一比例造，回归测试才有意义。
    connectOk: rnd(3) === 0,
    errorDetail: null,
  };
}

interface TargetRow {
  id: string;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  dedupe_key: string;
  credential_ref: string | null;
  username: string | null;
  password: string | null;
}

/** 并发受限的批量探测：8 并发，避免把本机 socket 打爆 */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx;
      idx += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runVerificationJob(jobId: string): Promise<void> {
  const job = await q1<{ id: string; status: string; endpoint_ids: string[] | null; scope: string; pool_id: string | null }>(
    'SELECT id, status, endpoint_ids, scope, pool_id FROM verification_jobs WHERE id = $1',
    [jobId],
  );
  if (!job || job.status === 'SUCCEEDED') return;

  await exec(
    `UPDATE verification_jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1`,
    [jobId],
  );

  // 解析目标集合
  let targets: TargetRow[] = [];
  if (job.scope === 'ENDPOINT' || job.scope === 'ENDPOINTS') {
    targets = await q<TargetRow>(
      `SELECT id, host, port, protocol, dedupe_key, credential_ref,
              NULL::text AS username, NULL::text AS password
       FROM proxy_endpoints WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [job.endpoint_ids ?? []],
    );
  } else if (job.scope === 'POOL') {
    targets = await q<TargetRow>(
      `SELECT e.id, e.host, e.port, e.protocol, e.dedupe_key, e.credential_ref,
              NULL::text AS username, NULL::text AS password
       FROM proxy_endpoints e
       JOIN resource_pool_members m ON m.endpoint_id = e.id AND m.pool_id = $1
       WHERE e.deleted_at IS NULL AND m.suppressed = false`,
      [job.pool_id],
    );
  } else {
    // ALL_PENDING / ALL
    const cond = job.scope === 'ALL_PENDING' ? `AND e.lifecycle_status IN ('DISCOVERED','PENDING_VERIFICATION')` : '';
    targets = await q<TargetRow>(
      `SELECT e.id, e.host, e.port, e.protocol, e.dedupe_key, e.credential_ref,
              NULL::text AS username, NULL::text AS password
       FROM proxy_endpoints e WHERE e.deleted_at IS NULL ${cond}`,
    );
  }

  // 带认证的代理：探针必须拿到账号密码，否则一律 AUTH_FAILED。
  // 之前这里写死 NULL::text，等于所有需要认证的端点必然验证失败 ——
  // 导入"成功"、池里永远进不去，链路到此为止。
  const refs = [...new Set(targets.map((t) => t.credential_ref).filter((x): x is string => !!x))];
  if (refs.length > 0) {
    const rows = await q<{ ref: string; ciphertext: string; nonce: string; key_version: number }>(
      `SELECT ref, encode(ciphertext,'base64') AS ciphertext, encode(nonce,'base64') AS nonce, key_version
       FROM secrets WHERE ref = ANY($1::text[])`,
      [refs],
    );
    const creds = new Map<string, { username: string; password: string }>();
    for (const r of rows) {
      try {
        const plain = JSON.parse(
          open({
            ciphertext: Buffer.from(r.ciphertext, 'base64'),
            nonce: Buffer.from(r.nonce, 'base64'),
            keyVersion: r.key_version,
          }),
        ) as { username?: string; password?: string };
        if (plain.username) creds.set(r.ref, { username: plain.username, password: plain.password ?? '' });
      } catch {
        /* 解密失败：按无凭据处理，失败原因会落到 AUTH_FAILED */
      }
    }
    for (const t of targets) {
      const c = t.credential_ref ? creds.get(t.credential_ref) : undefined;
      if (c) {
        t.username = c.username;
        t.password = c.password;
      }
    }
  }

  await exec('UPDATE verification_jobs SET total = $2 WHERE id = $1', [jobId, targets.length]);

  let completed = 0;
  let failedCount = 0;

  /**
   * 探测并发。
   *
   * 原来是写死的 8 —— 对自有资源够用（几十个节点），但对免费公开代理
   * 完全不成立：一次同步进来几千个候选，20% 存活率，8 并发 × 4 秒超时
   * 等于每秒 2 个，探完一轮要几十分钟，而那一轮里最早的结论已经过期。
   *
   * 默认 24：免费代理大多是「要么秒连、要么直接超时」，24 路并发在
   * 家用带宽上不会打满，但把吞吐提到每秒 6 个。上限 64 —— 再高就变成
   * 对别人服务器的小型扫描，既不礼貌也不安全。
   */
  const concurrency = Math.min(Math.max(Number(process.env.PF_PROBE_CONCURRENCY ?? 24), 1), 64);

  await runPool(targets, concurrency, async (t) => {
    const result =
      PROBE_MODE === 'fixture'
        ? fixtureProbe(t.dedupe_key)
        : await probe({
            host: t.host,
            port: t.port,
            protocol: t.protocol,
            username: t.username,
            password: t.password,
          });

    await recordCheck(t.id, jobId, result);
    completed += 1;
    if (!result.success) failedCount += 1;

    if (completed % 25 === 0) {
      await exec('UPDATE verification_jobs SET completed = $2, failed_count = $3 WHERE id = $1', [
        jobId,
        completed,
        failedCount,
      ]);
    }
  });

  await exec(
    `UPDATE verification_jobs SET status = 'SUCCEEDED', completed = $2, failed_count = $3, finished_at = now()
     WHERE id = $1`,
    [jobId, completed, failedCount],
  );
}

/** 单条探测结果落库 + 重算聚合健康态 */
async function recordCheck(endpointId: string, jobId: string, r: ProbeResult): Promise<void> {
  await tx(async (t) => {
    await t.exec(
      `INSERT INTO health_checks
         (endpoint_id, job_id, success, failed_layer, failure_reason, dns_ms, tcp_ms,
          handshake_ms, total_ms, samples, success_count, exit_ip, exit_country, error_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13)`,
      [
        endpointId, jobId, r.success, r.failedLayer, r.failureReason,
        r.dnsMs, r.tcpMs, r.handshakeMs, r.totalMs,
        r.success ? 1 : 0, r.exitIp, r.exitCountry, r.errorDetail,
      ],
    );

    const prev = await t.q1<{ consecutive_failures: number; consecutive_successes: number; last_success_at: string | null }>(
      'SELECT consecutive_failures, consecutive_successes, last_success_at FROM endpoint_health_state WHERE endpoint_id = $1',
      [endpointId],
    );
    const cf = r.success ? 0 : (prev?.consecutive_failures ?? 0) + 1;
    const cs = r.success ? (prev?.consecutive_successes ?? 0) + 1 : 0;

    // 24h 聚合
    const agg = await t.q1<{
      total: string; succ: string; p50: string | null; p95: string | null; jitter: string | null;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE success)::text AS succ,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)::int AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms)::int AS p95,
              (stddev_samp(total_ms))::int AS jitter
       FROM health_checks
       WHERE endpoint_id = $1 AND checked_at >= now() - interval '24 hours' AND success`,
      [endpointId],
    );
    const allCount = await t.q1<{ c: string }>(
      `SELECT count(*)::text AS c FROM health_checks
       WHERE endpoint_id = $1 AND checked_at >= now() - interval '24 hours'`,
      [endpointId],
    );

    const totalChecks = Number(allCount?.c ?? 0);
    const successes = Number(agg?.succ ?? 0);
    const successRate = totalChecks > 0 ? successes / totalChecks : 0;
    const score = qualityScore({
      successes,
      total: totalChecks,
      p50Ms: agg?.p50 ? Number(agg.p50) : null,
      jitterMs: agg?.jitter ? Number(agg.jitter) : null,
    });

    await t.exec(
      `UPDATE endpoint_health_state SET
         last_check_at = now(),
         last_success_at = CASE WHEN $2 THEN now() ELSE last_success_at END,
         success = $2,
         consecutive_failures = $3,
         consecutive_successes = $4,
         p50_ms = $5, p95_ms = $6, jitter_ms = $7,
         success_rate_24h = $8,
         quality_score = $9,
         connect_ok = COALESCE($10, connect_ok),
         scored_at = now(),
         updated_at = now()
       WHERE endpoint_id = $1`,
      [
        endpointId, r.success, cf, cs,
        agg?.p50 ? Number(agg.p50) : null,
        agg?.p95 ? Number(agg.p95) : null,
        agg?.jitter ? Number(agg.jitter) : null,
        Math.round(successRate * 10000) / 10000,
        score,
        // null = 这次没测（探测失败或 fixture），保留上一次的结论。
        // 不能写成 `connect_ok = $10`：那样一次失败探测就会把已知的
        // "支持隧道"抹成 NULL，池子排序会因此抖动。
        r.connectOk,
      ],
    );

    // 出口地理回填：用本次探测已经拿到的 exitIp/exitCountry，不额外发请求。
    // 之前这两个字段只落进 health_checks 就再没人读，导致端点表的
    // ip_asset_id 永远为 null，国家列与地区分布整条链路都是空的。
    if (r.success) {
      await linkExitGeography(t, endpointId, r.exitIp, r.exitCountry);
    }

    // 生命周期推进
    const cur = await t.q1<{ lifecycle_status: string; trust_tier: string }>(
      'SELECT lifecycle_status, trust_tier FROM proxy_endpoints WHERE id = $1',
      [endpointId],
    );
    let next: string | null = null;
    if (r.success) {
      if (cur?.lifecycle_status === 'HEALTHY') {
        next = 'HEALTHY';
      } else if (cur?.lifecycle_status === 'DEGRADED') {
        // 降级后要连续两次成功才回到 HEALTHY：单次成功可能只是抖动，
        // 和 VERIFIED → HEALTHY 用同一个门槛。
        next = cs >= 2 ? 'HEALTHY' : 'DEGRADED';
      } else {
        next = cs >= 2 ? 'HEALTHY' : 'VERIFIED';
      }
    } else if (cf >= 3) {
      next = 'UNAVAILABLE';
    } else if (cur?.lifecycle_status === 'HEALTHY') {
      /**
       * 健康节点第一次失败就降到 DEGRADED。
       *
       * 这一步是**订阅新鲜度**的关键。如果失败后留在 HEALTHY，要攒满
       * 3 次连续失败才会变成 UNAVAILABLE —— 一个已经死掉的节点会在池子
       * 和订阅里多赖两个复探周期（HEALTHY 与 DEGRADED 现在都是 30 分钟，
       * 也就是多赖一小时）。改成首次失败即降级，DEGRADED 档复探更密集，
       * 池子能自己愈合。
       *
       * 实测后果（当时 HEALTHY 还是 6 小时周期）：对 300 个池成员做一次
       * 全量复探，其中 122 个当场就探测失败，但它们全部仍是 HEALTHY、
       * 仍占着订阅里的名额。均匀抽样 40 个去连 HTTPS，29 个完全不通（73%），
       * 而池子看起来"300 个健康节点"。
       *
       * 降到 DEGRADED 之后，30 分钟一轮复探，两次就能判死，一小时左右
       * 清干净，池子可以自己愈合。
       */
      next = 'DEGRADED';
    }

    // 免费公开代理要能被判死，否则探测预算会被死节点永久吃掉。
    //
    // 实测免费代理存活率约 20%，且掉线基本是永久的（列表里的 IP 换了人）。
    // 只降级到 UNAVAILABLE 的话，它按 120 分钟一轮被永远重探 ——
    // 攒到几千个死节点时，一半的探测容量都在给已经不存在的东西做体检。
    // REJECTED 在调度表里是 null 间隔，等于彻底退出探测。
    //
    // 判死条件刻意收得很窄：**连续 2 次失败 + 从未成功过一次**。
    // 也就是"从出生就是死的"那一类 —— 免费列表里占大多数。
    //
    // 不用固定次数阈值：一个活过的节点（last_success_at 非空）掉线后
    // 仍可能回来，那种留在 UNAVAILABLE 按 120 分钟复核就够了。
    //
    // 为什么是 2 次而不是 3 次：第三次探测能提供的额外信息极少
    // （同一个 4 秒超时，同一个不通的结果），代价却是让这个端点
    // 在待验证队列里多待一整个复探周期，把预算从关键路径上挤走。
    // 实测 120/轮的晋级速度下，3 次门槛让待验证队列涨到近 4000 个。
    //
    // 只对 PUBLIC_PROXY 生效：自有/私有资源的不可用可能是对方在维护，
    // 自动判死会让人在恢复后还得手工捞回来，那是帮倒忙。
    if (
      !r.success && cf >= 2 && !prev?.last_success_at && cur?.trust_tier === 'PUBLIC_PROXY'
    ) {
      next = 'REJECTED';
    }

    if (next && next !== cur?.lifecycle_status) {
      // 已隔离/已撤销的不允许被自动复活
      if (cur?.lifecycle_status !== 'QUARANTINED' && cur?.lifecycle_status !== 'REVOKED') {
        await t.exec(
          'UPDATE proxy_endpoints SET lifecycle_status = $2, last_verified_at = now(), quality_score = $3 WHERE id = $1',
          [endpointId, next, score],
        );
        await emit(t, {
          type: EVENT_TYPES.ENDPOINT_VERIFIED,
          aggregateType: 'endpoint',
          aggregateId: endpointId,
          payload: { from: cur?.lifecycle_status, to: next, score },
        });
      }
    } else {
      await t.exec(
        'UPDATE proxy_endpoints SET last_verified_at = now(), quality_score = $2 WHERE id = $1',
        [endpointId, score],
      );
    }
  });
}

export async function createVerificationJob(input: VerificationRunRequest, actorId: string): Promise<string> {
  const id = uuidv7();
  await exec(
    `INSERT INTO verification_jobs (id, scope, endpoint_ids, pool_id, status, created_by)
     VALUES ($1,$2,$3::uuid[],$4,'PENDING',$5)`,
    [id, input.scope, input.endpointIds ?? null, input.poolId ?? null, actorId],
  );
  return id;
}

export async function registerVerificationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/verification/jobs', { preHandler: guard('verification:run') }, async (req) => {
    const body = req.body as VerificationRunRequest;
    if (!body?.scope) throw invalid('scope 必填');
    const actor = actorOf(req);

    const jobId = await tx(async (t) => {
      const id = uuidv7();
      await t.exec(
        `INSERT INTO verification_jobs (id, scope, endpoint_ids, pool_id, status, created_by)
         VALUES ($1,$2,$3::uuid[],$4,'PENDING',$5)`,
        [id, body.scope, body.endpointIds ?? null, body.poolId ?? null, actor.id],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'verification.create',
        resourceType: 'verification_job', resourceId: id, afterState: body,
      });
      return id;
    });

    // 异步执行，立即返回 jobId（大池全量探测可能数十秒）
    void runVerificationJob(jobId).catch((err) => {
      console.error('[verification] job failed', jobId, err);
    });

    return { id: jobId, scope: body.scope, status: 'PENDING' };
  });

  /**
   * 分级探测的到期情况。
   *
   * 这个接口存在的理由：`lifecycle_status` 是静止的，用户看不出
   * "它没被探过"和"探过但是好的"有什么区别。把每一档的到期数摆出来，
   * 才能回答"为什么这个节点还停在上次的状态"。
   */
  app.get('/verification/schedule', { preHandler: guard('resource:read') }, async () => {
    const { scheduleBacklog } = await import('./schedule.js');
    const tiers = await scheduleBacklog();
    const pending = await q1<{ c: string }>(
      `SELECT count(*)::text AS c FROM verification_jobs WHERE status IN ('PENDING','RUNNING')`,
    );
    return { tiers, activeJobs: Number(pending?.c ?? 0), probeMode: PROBE_MODE };
  });

  app.get('/verification/jobs', { preHandler: guard('resource:read') }, async (): Promise<{ items: VerificationJobRow[] }> => {    const rows = await q<Record<string, unknown>>(
      `SELECT id, scope, status, total, completed, failed_count, created_at, started_at, finished_at
       FROM verification_jobs ORDER BY created_at DESC LIMIT 50`,
    );
    return {
      items: rows.map((r) => ({
        id: r.id as string,
        scope: r.scope as VerificationJobRow['scope'],
        status: r.status as VerificationJobRow['status'],
        total: Number(r.total),
        completed: Number(r.completed),
        failedCount: Number(r.failed_count),
        createdAt: String(r.created_at),
        startedAt: (r.started_at as string) ?? null,
        finishedAt: (r.finished_at as string) ?? null,
      })),
    };
  });

  app.get('/verification/jobs/:id', { preHandler: guard('resource:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await q1<Record<string, unknown>>(
      `SELECT id, scope, status, total, completed, failed_count, created_at, started_at, finished_at
       FROM verification_jobs WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('验证任务');
    return {
      id: row.id,
      scope: row.scope,
      status: row.status,
      total: Number(row.total),
      completed: Number(row.completed),
      failedCount: Number(row.failed_count),
      createdAt: String(row.created_at),
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
    };
  });

  app.get('/resources/:id/health', { preHandler: guard('resource:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const state = await q1<Record<string, unknown>>(
      'SELECT * FROM endpoint_health_state WHERE endpoint_id = $1',
      [id],
    );
    if (!state) throw notFound('健康态');
    return state;
  });

  app.get('/resources/:id/health/history', { preHandler: guard('resource:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await q<Record<string, unknown>>(
      `SELECT checked_at, success, failure_reason, failed_layer, dns_ms, tcp_ms,
              handshake_ms, total_ms, exit_ip, exit_country
       FROM health_checks WHERE endpoint_id = $1 ORDER BY checked_at DESC LIMIT 200`,
      [id],
    );
    return { items: rows };
  });

  app.get('/verification/ranking', { preHandler: guard('resource:read') }, async (req) => {
    const { poolId, limit } = req.query as { poolId?: string; limit?: string };
    const n = Math.min(Number(limit ?? 50), 200);
    const rows = await q<Record<string, unknown>>(
      poolId
        ? `SELECT e.id, e.display_name, e.host, e.port, e.protocol, e.trust_tier,
                  s.p50_ms, s.p95_ms, s.success_rate_24h, s.quality_score
           FROM v_schedulable_endpoints v
           JOIN proxy_endpoints e ON e.id = v.id
           JOIN endpoint_health_state s ON s.endpoint_id = e.id
           JOIN resource_pool_members m ON m.endpoint_id = e.id AND m.pool_id = $1
           ORDER BY s.quality_score DESC LIMIT $2`
        : `SELECT e.id, e.display_name, e.host, e.port, e.protocol, e.trust_tier,
                  s.p50_ms, s.p95_ms, s.success_rate_24h, s.quality_score
           FROM proxy_endpoints e JOIN endpoint_health_state s ON s.endpoint_id = e.id
           WHERE e.deleted_at IS NULL ORDER BY s.quality_score DESC LIMIT $1`,
      poolId ? [poolId, n] : [n],
    );
    return { items: rows };
  });
}

export type { CheckFailureReason };
