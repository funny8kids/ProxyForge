import type { FastifyInstance } from 'fastify';
import type {
  CheckFailureReason,
  ProxyProtocol,
  VerificationJobRow,
  VerificationRunRequest,
} from '@proxyforge/contracts';
import { exec, q, q1, tx, type TxLike } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit, emit, EVENT_TYPES } from '../../shared/events.js';
import { invalid, notFound } from '../../shared/errors.js';
import { uuidv7 } from '../../shared/id.js';
// 只依赖 db/client，不会和 schedule.ts 形成循环
import { noteProbeDbCost, probeBatchCap } from './schedule.js';
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

  const t0 = performance.now();

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
   * 家用带宽上不会打满，但把吞吐提到每秒 6 个。
   *
   * ## 上限 128 → 256，默认并发 24 → 96
   *
   * 用 `scripts/bench-probe.mts` 隔离测过（只跑 probe()，不含写库）：
   *
   *     180 个 @  96 并发 →  766 个/分钟
   *     600 个 @ 128 并发 → 1870 个/分钟
   *     800 个 @ 192 并发 → 3197 个/分钟
   *     800 个 @ 256 并发 → 3899 个/分钟
   *
   * **但吞吐上限不是配置依据。** 并发越高，本地 NAT 丢 SYN 越多，而 TCP
   * 首包重传的定时器正好是 1 秒 —— 一个只需 20ms 就能连上的节点会被判成
   * 不可达。实测 192 并发下抓 30 个记为 `TCP_TIMEOUT` 的节点重测，
   * **28 个当场成功**，其中 8 个还能建隧道。这些假失败会把健康节点成批
   * 打成 DEGRADED：50 分钟内 HEALTHY 从 630 掉到 370，一半是误杀。
   *
   * 稳态需求只有约 200 个/分钟（在途 6000 ÷ 30 分钟复探周期），96 并发
   * 给出的 800–900 个/分钟已经有 4 倍余量。**探测结论的可信度比吞吐重要。**
   *
   * 上限放到 256 只是给"手工全量探测"留个口子，日常不该用。
   */
  const concurrency = Math.min(Math.max(Number(process.env.PF_PROBE_CONCURRENCY ?? 96), 1), 256);

  /**
   * 落库缓冲。
   *
   * 探测本身是并发的，但落库不能并发 —— PGlite 单写者，事务串行。
   * 每条结果开一个事务时，400 个一批的墙钟从 7 秒涨到 34 秒，
   * 多出来的全是事务排队（见 `recordCheckIn` 的注释）。
   *
   * 25 条一提交：事务数降一个数量级，而单事务仍只有 175 条语句左右，
   * 远没到 PGlite 的单事务上限。
   *
   * 刷盘必须串行（`flushChain`），否则并发的 192 个 worker 会各自触发
   * 一次 `tx()`，又变回排队。
   */
  const FLUSH_SIZE = 25;
  const buffer: Array<{ id: string; r: ProbeResult }> = [];
  let flushChain: Promise<void> = Promise.resolve();
  let flushError: unknown = null;
  // 分段计时：探测与落库各占多少。不加这个就只能看到"一批 105 秒"，
  // 分不清该优化探测链还是该优化写库。
  let probeMsSum = 0;
  let dbMsSum = 0;

  const flush = (): Promise<void> => {
    if (buffer.length === 0) return flushChain;
    const batch = buffer.splice(0, buffer.length);
    flushChain = flushChain.then(async () => {
      if (flushError) return;
      const dbStart = performance.now();
      try {
        await tx((t) => recordChecksBatch(t, jobId, batch));
      } catch (err) {
        // 整批回滚。逐条重试，让一条坏记录不至于吃掉同批其余 24 条结论。
        // 走的是同一条批量函数、只是每次只放一条进去。
        for (const item of batch) {
          try {
            await tx((t) => recordChecksBatch(t, jobId, [item]));
          } catch (e) {
            flushError ??= e;
            console.error('[worker] 探测结果落库失败', item.id, e);
          }
        }
      } finally {
        dbMsSum += performance.now() - dbStart;
      }
    });
    return flushChain;
  };

  await runPool(targets, concurrency, async (t) => {
    const probeStart = performance.now();
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
    probeMsSum += performance.now() - probeStart;

    buffer.push({ id: t.id, r: result });
    completed += 1;
    if (!result.success) failedCount += 1;

    // 缓冲满就刷；await 让 worker 等这一批落完再继续，避免缓冲区无限涨。
    if (buffer.length >= FLUSH_SIZE) await flush();

    if (completed % 100 === 0) {
      await exec('UPDATE verification_jobs SET completed = $2, failed_count = $3 WHERE id = $1', [
        jobId,
        completed,
        failedCount,
      ]);
    }
  });

  // 收尾：把不足一批的尾巴刷掉，再等所有在途批次结束。
  await flush();
  await flushChain;

  await exec(
    `UPDATE verification_jobs SET status = 'SUCCEEDED', completed = $2, failed_count = $3, finished_at = now()
     WHERE id = $1`,
    [jobId, completed, failedCount],
  );

  // 小批次（测试、手工单点探测）不打分段日志，否则把测试输出淹掉
  if (completed >= 100) {
    const wall = performance.now() - t0;
    const msPerItem = dbMsSum / Math.max(completed, 1);
    // 回报给调度器：下一批的额度由「每条落库成本」反推（见 schedule.ts 的
    // DB_BUDGET_MS）。不回填的话批次会一路涨到把事件循环占满，
    // 表现就是探测大面积假失败、HEALTHY 单调下滑。
    noteProbeDbCost(msPerItem);
    console.log(
      `[worker] 探测分段 ${jobId.slice(0, 8)}：${completed} 个 / 墙钟 ${Math.round(wall)}ms` +
        ` · 探测累计 ${Math.round(probeMsSum / 1000)}s（÷${concurrency} 并发 ≈ ${Math.round(probeMsSum / concurrency)}ms）` +
        ` · 落库累计 ${Math.round(dbMsSum)}ms（${Math.round(msPerItem * 10) / 10}ms/条）` +
        ` · 下一批额度 ${Number.isFinite(probeBatchCap()) ? probeBatchCap() : '不限'}`,
    );
  }
}

/**
 * 批量落库：一次事务处理一整组探测结果。
 *
 * ## 为什么必须是"批量"而不是"逐条包在一个事务里"
 *
 * PGlite 是单线程 WASM 构建，每条 `t.query()` 都是**同步阻塞**事件循环的，
 * 实测约 11ms 一条语句。而一条探测结果原本要发 8 条语句：
 *
 *   插 health_checks → 读上次状态 → 24h 聚合 → 读 24h 总数
 *   → 更新健康态 → 读生命周期 → 更新端点 → 写事件
 *
 * 1200 个一批就是约 9600 条语句 ≈ 105 秒的事件循环占用。后果有两个，
 * 第二个比第一个严重得多：
 *
 *   1. **吞吐锁死在 700 个/分钟**。落库 79ms/条、串行执行，
 *      加多少并发都没用 —— 实测并发从 96 提到 192，吞吐纹丝不动。
 *
 *   2. **探测结论变得不可信**。事件循环被占满时，`net.connect` 的
 *      回调要排在几百条 SQL 后面才能执行，而 1 秒的 TCP 超时定时器
 *      到点就触发 —— 于是一个 20ms 就能连上的节点被记成 `TCP_TIMEOUT`。
 *      实测抓了 25 个"TCP_TIMEOUT"的节点重测，**25 个全部在 1–10ms 内连上**。
 *      这些假失败会把健康节点打成 DEGRADED，直接减少可用节点数。
 *
 * 批量之后每条结果只摊到约 0.3 条语句（一组 25 条约 7 条语句），
 * 阻塞时间降两个数量级，上面两个问题一起消失。
 *
 * 语义与逐条写入完全一致：聚合仍然覆盖"本批已插入的行"（同一事务可见），
 * 生命周期推进规则原样保留，只是把判断搬到内存里、把写库合并成批量。
 */
async function recordChecksBatch(
  t: TxLike,
  jobId: string,
  items: Array<{ id: string; r: ProbeResult }>,
): Promise<void> {
  if (items.length === 0) return;
  const ids = items.map((i) => i.id);

  // ── ① 多行插入 health_checks ──
  {
    const params: unknown[] = [];
    const tuples = items.map((it, idx) => {
      const b = idx * 14;
      params.push(
        it.id, jobId, it.r.success, it.r.failedLayer, it.r.failureReason,
        it.r.dnsMs, it.r.tcpMs, it.r.handshakeMs, it.r.totalMs,
        1, it.r.success ? 1 : 0, it.r.exitIp, it.r.exitCountry, it.r.errorDetail,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::check_failure_reason,` +
        `$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},` +
        `$${b + 12}::inet,$${b + 13}::char(2),$${b + 14})`;
    });
    await t.exec(
      `INSERT INTO health_checks
         (endpoint_id, job_id, success, failed_layer, failure_reason, dns_ms, tcp_ms,
          handshake_ms, total_ms, samples, success_count, exit_ip, exit_country, error_detail)
       VALUES ${tuples.join(',')}`,
      params,
    );
  }

  // ── ② 一次读出整组的上次状态 ──
  const prevRows = await t.q<{
    endpoint_id: string; consecutive_failures: number; consecutive_successes: number;
    last_success_at: string | null;
  }>(
    `SELECT endpoint_id, consecutive_failures, consecutive_successes, last_success_at
     FROM endpoint_health_state WHERE endpoint_id = ANY($1::uuid[])`,
    [ids],
  );
  const prevMap = new Map(prevRows.map((r) => [r.endpoint_id, r]));

  // ── ③ 一次分组聚合出 24h 统计 ──
  //
  // 原来是两条查询（成功样本的百分位 + 全部样本的总数），现在合成一条
  // GROUP BY：`percentile_cont ... FILTER (WHERE success)` 等价于原来
  // 先 `WHERE success` 再算百分位，而 `count(*)` 拿到的是全部样本数。
  const aggRows = await t.q<{
    endpoint_id: string; total: string; succ: string;
    p50: number | null; p95: number | null; jitter: number | null;
  }>(
    `SELECT endpoint_id,
            count(*)::text AS total,
            count(*) FILTER (WHERE success)::text AS succ,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE success))::int AS p50,
            (percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE success))::int AS p95,
            (stddev_samp(total_ms) FILTER (WHERE success))::int AS jitter
     FROM health_checks
     WHERE endpoint_id = ANY($1::uuid[]) AND checked_at >= now() - interval '24 hours'
     GROUP BY endpoint_id`,
    [ids],
  );
  const aggMap = new Map(aggRows.map((r) => [r.endpoint_id, r]));

  // ── ④ 一次批量更新健康态 ──
  const stateRows: Array<{
    id: string; ok: boolean; cf: number; cs: number;
    p50: number | null; p95: number | null; jitter: number | null;
    rate: number; score: number; connectOk: boolean | null;
  }> = [];

  for (const it of items) {
    const prev = prevMap.get(it.id);
    const cf = it.r.success ? 0 : (prev?.consecutive_failures ?? 0) + 1;
    const cs = it.r.success ? (prev?.consecutive_successes ?? 0) + 1 : 0;
    const agg = aggMap.get(it.id);
    const totalChecks = Number(agg?.total ?? 0);
    const successes = Number(agg?.succ ?? 0);
    const successRate = totalChecks > 0 ? successes / totalChecks : 0;
    const score = qualityScore({
      successes,
      total: totalChecks,
      p50Ms: agg?.p50 ?? null,
      jitterMs: agg?.jitter ?? null,
    });
    stateRows.push({
      id: it.id, ok: it.r.success, cf, cs,
      p50: agg?.p50 ?? null, p95: agg?.p95 ?? null, jitter: agg?.jitter ?? null,
      rate: Math.round(successRate * 10000) / 10000,
      score,
      // null = 这次没测（探测失败或 fixture），保留上一次的结论。
      // 不能写成 `connect_ok = $10`：那样一次失败探测就会把已知的
      // "支持隧道"抹成 NULL，池子排序会因此抖动。
      connectOk: it.r.connectOk,
    });
  }

  {
    const params: unknown[] = [];
    const tuples = stateRows.map((s, idx) => {
      const b = idx * 10;
      params.push(
        s.id, s.ok, s.cf, s.cs, s.p50, s.p95, s.jitter, s.rate, s.score, s.connectOk,
      );
      return `($${b + 1}::uuid,$${b + 2}::boolean,$${b + 3}::int,$${b + 4}::int,` +
        `$${b + 5}::int,$${b + 6}::int,$${b + 7}::int,$${b + 8}::numeric,$${b + 9}::numeric,` +
        `$${b + 10}::boolean)`;
    });
    await t.exec(
      `UPDATE endpoint_health_state s SET
         last_check_at = now(),
         last_success_at = CASE WHEN v.ok THEN now() ELSE s.last_success_at END,
         success = v.ok,
         consecutive_failures = v.cf,
         consecutive_successes = v.cs,
         p50_ms = v.p50, p95_ms = v.p95, jitter_ms = v.jitter,
         success_rate_24h = v.rate,
         quality_score = v.score,
         connect_ok = COALESCE(v.connect_ok, s.connect_ok),
         scored_at = now(),
         updated_at = now()
       FROM (VALUES ${tuples.join(',')})
         AS v(id, ok, cf, cs, p50, p95, jitter, rate, score, connect_ok)
       WHERE s.endpoint_id = v.id`,
      params,
    );
  }

  // ── ⑤ 一次读出整组的生命周期 ──
  const curRows = await t.q<{ id: string; lifecycle_status: string; trust_tier: string }>(
    'SELECT id, lifecycle_status, trust_tier FROM proxy_endpoints WHERE id = ANY($1::uuid[])',
    [ids],
  );
  const curMap = new Map(curRows.map((r) => [r.id, r]));

  // ── ⑥ 逐条决定下一步（纯内存，不发 SQL）──
  const changed: Array<{ id: string; from: string; next: string; score: number }> = [];
  const unchanged: Array<{ id: string; score: number }> = [];

  for (const s of stateRows) {
    const it = items.find((x) => x.id === s.id)!;
    const r = it.r;
    const prev = prevMap.get(s.id);
    const cur = curMap.get(s.id);

    let next: string | null = null;
    if (r.success) {
      if (cur?.lifecycle_status === 'HEALTHY') {
        next = 'HEALTHY';
      } else if (cur?.lifecycle_status === 'DEGRADED') {
        // 降级后要连续两次成功才回到 HEALTHY：单次成功可能只是抖动，
        // 和 VERIFIED → HEALTHY 用同一个门槛。
        next = s.cs >= 2 ? 'HEALTHY' : 'DEGRADED';
      } else {
        next = s.cs >= 2 ? 'HEALTHY' : 'VERIFIED';
      }
    } else if (s.cf >= 3) {
      next = 'UNAVAILABLE';
    } else if (cur?.lifecycle_status === 'HEALTHY') {
      /**
       * 健康节点第一次失败就降到 DEGRADED。
       *
       * 这一步是**订阅新鲜度**的关键。如果失败后留在 HEALTHY，要攒满
       * 3 次连续失败才会变成 UNAVAILABLE —— 一个已经死掉的节点会在池子
       * 和订阅里多赖两个复探周期，也就是多赖一小时。
       *
       * 实测后果（当时 HEALTHY 还是 6 小时周期）：对 300 个池成员做一次
       * 全量复探，其中 122 个当场就探测失败，但它们全部仍是 HEALTHY、
       * 仍占着订阅里的名额。均匀抽样 40 个去连 HTTPS，29 个完全不通（73%），
       * 而池子看起来"300 个健康节点"。
       */
      next = 'DEGRADED';
    }

    /**
     * 免费公开代理要能被判死，否则探测预算会被死节点永久吃掉。
     *
     * 实测免费代理存活率约 20%，且掉线基本是永久的（列表里的 IP 换了人）。
     * 只降级到 UNAVAILABLE 的话，它按 120 分钟一轮被永远重探 ——
     * 攒到几千个死节点时，一半的探测容量都在给已经不存在的东西做体检。
     * REJECTED 在调度表里是 null 间隔，等于彻底退出探测。
     *
     * 判死条件刻意收得很窄：**连续 2 次失败 + 从未成功过一次**。
     * 也就是"从出生就是死的"那一类 —— 免费列表里占大多数。
     *
     * 只对 PUBLIC_PROXY 生效：自有/私有资源的不可用可能是对方在维护，
     * 自动判死会让人在恢复后还得手工捞回来，那是帮倒忙。
     */
    if (!r.success && s.cf >= 2 && !prev?.last_success_at && cur?.trust_tier === 'PUBLIC_PROXY') {
      next = 'REJECTED';
    }

    const from = cur?.lifecycle_status ?? 'UNKNOWN';
    // 已隔离/已撤销的不允许被自动复活，也不改它的 last_verified_at
    const blocked = from === 'QUARANTINED' || from === 'REVOKED';
    if (next && next !== from && !blocked) {
      changed.push({ id: s.id, from, next, score: s.score });
    } else {
      unchanged.push({ id: s.id, score: s.score });
    }
  }

  // ── ⑦ 两次批量更新端点（有状态变化 / 无变化）──
  if (changed.length > 0) {
    const params: unknown[] = [];
    const tuples = changed.map((c, idx) => {
      const b = idx * 3;
      params.push(c.id, c.next, c.score);
      return `($${b + 1}::uuid,$${b + 2}::lifecycle_status,$${b + 3}::numeric)`;
    });
    await t.exec(
      `UPDATE proxy_endpoints e SET
         lifecycle_status = v.next,
         last_verified_at = now(),
         quality_score = v.score
       FROM (VALUES ${tuples.join(',')}) AS v(id, next, score)
       WHERE e.id = v.id`,
      params,
    );
  }

  if (unchanged.length > 0) {
    const params: unknown[] = [];
    const tuples = unchanged.map((c, idx) => {
      const b = idx * 2;
      params.push(c.id, c.score);
      return `($${b + 1}::uuid,$${b + 2}::numeric)`;
    });
    await t.exec(
      `UPDATE proxy_endpoints e SET last_verified_at = now(), quality_score = v.score
       FROM (VALUES ${tuples.join(',')}) AS v(id, score)
       WHERE e.id = v.id`,
      params,
    );
  }

  // ── ⑧ 一次批量写状态变更事件 ──
  if (changed.length > 0) {
    const params: unknown[] = [];
    const tuples = changed.map((c, idx) => {
      const b = idx * 5;
      params.push(
        uuidv7(), EVENT_TYPES.ENDPOINT_VERIFIED, 'endpoint', c.id,
        JSON.stringify({ from: c.from, to: c.next, score: c.score }),
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4}::uuid,1,$${b + 5}::jsonb)`;
    });
    await t.exec(
      `INSERT INTO event_outbox
         (event_id, event_type, aggregate_type, aggregate_id, schema_version, payload)
       VALUES ${tuples.join(',')}`,
      params,
    );
  }

  // ── ⑨ 出口地理回填 ──
  //
  // 只对探测成功的端点做（约占 5%），而且它要写 ip_assets，需要逐条
  // 判断资产是否已存在。批量化的收益不大，保持原样。
  for (const it of items) {
    if (it.r.success) {
      await linkExitGeography(t, it.id, it.r.exitIp, it.r.exitCountry);
    }
  }
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
      `SELECT id, scope, status, total, completed, failed_count, created_at, started_at, finished_at,
              attempts, max_attempts, run_after
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
        attempts: Number(r.attempts ?? 0),
        maxAttempts: Number(r.max_attempts ?? 0),
        runAfter: r.run_after ? String(r.run_after) : null,
      })),
    };
  });

  app.get('/verification/jobs/:id', { preHandler: guard('resource:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await q1<Record<string, unknown>>(
      `SELECT id, scope, status, total, completed, failed_count, created_at, started_at, finished_at,
              attempts, max_attempts, run_after
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
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 0),
      runAfter: row.run_after ? String(row.run_after) : null,
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
