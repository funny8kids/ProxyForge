import { q, tx } from '../../db/client.js';
import { syncSource, type SourceRow } from './index.js';
import {
  expireStaleCandidates,
  promoteCandidates,
  reviveStaleCandidates,
  type PromoteAuthorization,
} from './promote.js';
import { wilsonLower } from './quality.js';

/**
 * 自动采集流水线。
 *
 * 存在的理由：这套系统原来把「抓取」和「晋级」都做成了手工动作。
 * 对自有资源没问题（一个月加几个），但免费公开代理源的形态完全不同 ——
 * 一次同步就是几万条候选，存活率 20% 上下，每小时都在变。
 * 让用户手工点几万次「晋级」等于这条链路没通。
 *
 * 流水线分两个**互相独立**的步骤，这点很关键：
 *
 *   1. 同步到期的源（网络操作，20 秒级，每轮最多几个）
 *   2. 按需晋级候选（纯数据库操作，预算驱动）
 *
 * 为什么必须解耦：最初把晋级写在"同步成功之后"，结果源一小时才同步一次，
 * 首轮抓下来的几万条候选在接下来的 55 分钟里一条都不会被晋级 ——
 * 表面上有流水线，实际卡在"下次同步才动"。
 *
 * 为什么是"按需"而不是"全量"：公开列表一次能抓出 2.7 万个去重端点，
 * 但实验池上限只有 120 个成员，探测 2.7 万个里有 80% 是死的 ——
 * 那是对别人服务器的一次无意义扫描。所以只晋级到"健康节点够用"为止。
 */

/** 每轮同步几个源。抓取是 20 秒级操作，宁可多跑几轮也不要阻塞调度。 */
const SOURCES_PER_CYCLE = 3;

/**
 * 目标健康节点数。
 *
 * 与实验池上限联动：池上限 300，健康节点会随时间掉线（免费代理日掉线率
 * 两位数），需要替补余量。400 大约留出 30% 的缓冲 —— 低于这个数说明
 * 池子开始缺人，该继续挖了。
 *
 * 这个数字也是"什么时候该停止扫描别人服务器"的开关：达到之后闸门关闭，
 * 不再晋级新候选，探测预算只用于复探已有节点。
 */
const TARGET_HEALTHY = Number(process.env.PF_INGEST_TARGET_HEALTHY ?? 400);

/** 单轮晋级总预算。PGlite 单写者，一轮塞太多会让 API 失去响应。 */
const PROMOTE_BUDGET = Number(process.env.PF_INGEST_PROMOTE_BUDGET ?? 1500);

/**
 * 在途待探测端点上限 —— 晋级必须被探测吞吐量约束住。
 *
 * 不加这个闸门时实测：晋级 1500/轮（15 秒一轮，即 6000/分），
 * 而探测只有 60/轮（240/分），比例 25:1。结果是库里几分钟堆出几万个
 * 从没探过的端点行，探测队列永远追不上，而"健康数是否达标"的判断
 * 依据的是 HEALTHY 数量 —— 新晋级的全是 PENDING_VERIFICATION，
 * 一个都不计入，于是闸门永远不会关上。
 *
 * 400 是按探测吞吐定的：一轮 60 个、15 秒一轮 ≈ 240/分，
 * 400 相当于不到 2 分钟的缓冲，既不会让探测饿着，也不会让库无谓膨胀。
 */
const PROBE_BACKLOG_MAX = Number(process.env.PF_INGEST_PROBE_BACKLOG ?? 400);

/** 过期标记的扫描间隔。清理语义，早一小时晚一小时没有影响。 */
const STALE_SWEEP_MS = 60 * 60 * 1000;
let lastStaleSweep = 0;

export interface IngestSourceResult {
  key: string;
  ok: boolean;
  candidates: number;
  promoted: number;
  duplicate: number;
  error?: string;
}

export interface IngestResult {
  /** 本轮实际同步的源数量 */
  synced: number;
  /** 本轮晋级出的端点数 */
  promoted: number;
  /** 当前健康 + 降级的公开代理数（决定是否继续晋级） */
  healthyPublic: number;
  /** 当前还在等第一次探测结论的端点数 */
  awaitingProbe: number;
  /** 因为健康节点已够而跳过晋级 */
  promotionPaused: boolean;
  /** 暂停原因，null 表示本轮没有暂停 */
  pauseReason: 'target-met' | 'probe-backlog' | null;
  items: IngestSourceResult[];
}

interface DueSourceRow extends SourceRow {
  auto_promote: boolean;
  auto_promote_authorization: string | null;
  auto_promote_limit: number;
}

/**
 * 到期的源。
 *
 * 用 `COALESCE(last_attempt_at, last_synced_at, created_at)` 而不是只看
 * `last_synced_at`：同步失败的源也应该按同样间隔退避重试，而不是每 15 秒
 * 撞一次同一堵墙（一个已经 404 的源会变成持续的网络噪音与告警风暴）。
 */
async function dueSources(limit: number): Promise<DueSourceRow[]> {
  return q<DueSourceRow>(
    `SELECT id, key, name, type, url, format_hint, authorization_status, config,
            auto_promote, auto_promote_authorization, auto_promote_limit
     FROM resource_sources
     WHERE enabled = true
       AND type <> 'MANUAL'
       AND url IS NOT NULL
       AND COALESCE(last_attempt_at, last_synced_at, created_at)
             + (sync_interval_seconds || ' seconds')::interval <= now()
     ORDER BY COALESCE(last_attempt_at, last_synced_at, created_at) ASC
     LIMIT $1`,
    [limit],
  );
}

/** 还活着的公开代理数。用它决定"还要不要继续晋级"。 */
async function countHealthyPublic(): Promise<number> {
  const row = await q<{ c: string }>(
    `SELECT count(*)::text AS c FROM proxy_endpoints
     WHERE deleted_at IS NULL
       AND trust_tier = 'PUBLIC_PROXY'
       AND lifecycle_status IN ('HEALTHY', 'DEGRADED')`,
  );
  return Number(row[0]?.c ?? 0);
}

/**
 * 还没做过**第一次**探测的端点数。
 *
 * 口径刻意只算 `last_check_at IS NULL`，不是"生命周期还在 PENDING_VERIFICATION"。
 * 后者包含已经探过 1–2 次失败、正在等 10 分钟后复探的端点 ——
 * 把它们算进来会让闸门在晋级之后一直关着：400 个端点探完第一轮后
 * 生命周期仍是 PENDING_VERIFICATION，要等 3 次失败（≈20 分钟）才会离开，
 * 于是下一批 400 个得干等 20 分钟才能晋级。
 *
 * 复探是调度器自己的节奏，不该阻塞新候选进场；
 * 这里要限的是"一次性丢给探针多少从没见过的东西"。
 */
async function countAwaitingProbe(): Promise<number> {
  const row = await q<{ c: string }>(
    `SELECT count(*)::text AS c
     FROM proxy_endpoints e
     LEFT JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
     WHERE e.deleted_at IS NULL
       AND e.trust_tier = 'PUBLIC_PROXY'
       AND e.lifecycle_status IN ('DISCOVERED', 'PENDING_VERIFICATION')
       AND hs.last_check_at IS NULL`,
  );
  return Number(row[0]?.c ?? 0);
}

/** 有积压候选、且开启了自动晋级的源。按**期望产出**排序，不是按积压量。 */
interface BacklogSource extends DueSourceRow {
  pending: number;
  tried: number;
  alive: number;
}

/**
 * 从各源挖候选时的排序依据。
 *
 * 原来按积压量降序，等于假设"候选多的源更值得挖"。这个假设在免费代理场景下
 * 是错的：一个 11,000 条候选的源如果存活率只有 2%，挖 200 条只得 4 个可用节点；
 * 一个 900 条候选、存活率 45% 的源挖 200 条能得 90 个。按积压量排会让探测预算
 * 长期压在低产出的源上 —— 实测就是这么发生的：最大的源贡献了 11,099 条候选，
 * 却只产出 200 个端点，而一个只有 4,924 条的源产出了 1,718 个。
 *
 * 期望产出 = 积压量 × 存活率下界。用下界而不是裸比例，是为了不让
 * "探了 3 个活了 2 个"的源拿到虚高的优先级（见 quality.ts 里的 Wilson 说明）。
 *
 * 没有探测历史的源给一个乐观先验 0.25：免费代理整体存活率在 10–20% 之间，
 * 但完全不给机会会让新源永远排不上队，而新源恰恰是最可能带来增量的。
 */
const OPTIMISTIC_PRIOR = 0.25;

async function sourcesWithBacklog(): Promise<BacklogSource[]> {
  const rows = await q<BacklogSource>(
    `SELECT s.id, s.key, s.name, s.type, s.url, s.format_hint, s.authorization_status, s.config,
            s.auto_promote, s.auto_promote_authorization, s.auto_promote_limit,
            COALESCE(b.pending, 0)::int AS pending,
            COALESCE(p.tried, 0)::int AS tried,
            COALESCE(p.alive, 0)::int AS alive
     FROM resource_sources s
     LEFT JOIN (
       SELECT source_id, count(*)::int AS pending
       FROM candidate_endpoints
       WHERE review_status = 'PENDING' AND stale_at IS NULL
       GROUP BY source_id
     ) b ON b.source_id = s.id
     LEFT JOIN (
       SELECT es.source_id,
              count(*)::int AS tried,
              count(*) FILTER (
                WHERE e.lifecycle_status IN ('HEALTHY','DEGRADED','VERIFIED')
              )::int AS alive
       FROM endpoint_sources es
       JOIN proxy_endpoints e ON e.id = es.endpoint_id AND e.deleted_at IS NULL
       JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
       WHERE hs.last_check_at IS NOT NULL
       GROUP BY es.source_id
     ) p ON p.source_id = s.id
     WHERE s.enabled = true
       AND s.auto_promote = true
       AND s.auto_promote_authorization IN ('AUTHORIZED', 'RESTRICTED')
       AND COALESCE(b.pending, 0) > 0`,
  );

  const scored = rows.map((r) => {
    const rate = r.tried > 0 ? wilsonLower(r.alive, r.tried) : OPTIMISTIC_PRIOR;
    return { row: r, expectedYield: r.pending * rate };
  });
  scored.sort((a, b) => b.expectedYield - a.expectedYield);
  return scored.map((s) => s.row);
}

export async function runIngestCycle(limit = SOURCES_PER_CYCLE): Promise<IngestResult> {
  const items: IngestSourceResult[] = [];

  // ── 步骤 1：同步到期的源 ──
  const sources = await dueSources(limit);
  for (const source of sources) {
    const outcome = await syncSource(source, { kind: 'SCHEDULER', id: 'ingest' });
    items.push({
      key: source.key,
      ok: outcome.ok,
      candidates: outcome.candidates,
      promoted: 0,
      duplicate: 0,
      ...(outcome.ok ? {} : { error: outcome.error }),
    });
  }

  // ── 步骤 2：按需晋级 ──
  const healthyPublic = await countHealthyPublic();
  const awaitingProbe = await countAwaitingProbe();
  let promotedTotal = 0;
  let promotionPaused = false;
  let pauseReason: IngestResult['pauseReason'] = null;

  // 两道闸，任一关闭就停手：
  //   1. 健康数达标 —— 目的已经达到，继续抓只是浪费探测预算
  //   2. 在途太多 —— 探测还没消化完，再晋级只会让队列越来越长
  if (healthyPublic >= TARGET_HEALTHY) {
    promotionPaused = true;
    pauseReason = 'target-met';
  } else if (awaitingProbe >= PROBE_BACKLOG_MAX) {
    promotionPaused = true;
    pauseReason = 'probe-backlog';
  } else {
    const room = PROBE_BACKLOG_MAX - awaitingProbe;
    let backlog = await sourcesWithBacklog();

    // 活跃候选挖完了但健康数还没达标 —— 说明候选池被过期标记扫空了。
    // 不复活的话闸门是开着的，却永远挖不到东西，而日志上只会显示"晋级 0 个"。
    if (backlog.length === 0) {
      const revived = await reviveStaleCandidates();
      if (revived > 0) {
        console.log(`[worker] 复活 ${revived} 条过期候选（健康数未达标，需要补充）`);
        backlog = await sourcesWithBacklog();
      }
    }

    let remaining = Math.min(PROMOTE_BUDGET, room);

    for (const source of backlog) {
      if (remaining <= 0) break;
      const auth = source.auto_promote_authorization;
      if (auth !== 'AUTHORIZED' && auth !== 'RESTRICTED') continue;

      const take = Math.min(remaining, source.auto_promote_limit);
      const r = await tx((t) =>
        promoteCandidates(t, source.id, auth as PromoteAuthorization, take),
      );
      remaining -= r.promoted;
      promotedTotal += r.promoted;

      const existing = items.find((i) => i.key === source.key);
      if (existing) {
        existing.promoted = r.promoted;
        existing.duplicate = r.duplicate;
      } else if (r.promoted > 0) {
        items.push({
          key: source.key, ok: true, candidates: 0,
          promoted: r.promoted, duplicate: r.duplicate,
        });
      }
    }
  }

  // 过期标记是整表 UPDATE，没必要每 15 秒跑一次；而且它是"清理"语义，
  // 早一小时晚一小时对结果没有影响。
  if (Date.now() - lastStaleSweep > STALE_SWEEP_MS) {
    lastStaleSweep = Date.now();
    const expired = await expireStaleCandidates();
    if (expired > 0) {
      console.log(`[worker] 标记 ${expired} 条候选过期（超过保留期未被晋级）`);
    }
  }

  return {
    synced: sources.length,
    promoted: promotedTotal,
    healthyPublic,
    awaitingProbe,
    promotionPaused,
    pauseReason,
    items,
  };
}
