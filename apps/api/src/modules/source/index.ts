import type { FastifyInstance } from 'fastify';
import type { CandidateRow, ProxyProtocol, SourceSummary, TrustTier } from '@proxyforge/contracts';
import { exec, q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit, emit, EVENT_TYPES } from '../../shared/events.js';
import { invalid, notFound } from '../../shared/errors.js';
import { slugify, uuidv7 } from '../../shared/id.js';
import { dedupeKey, parseProxyLine } from '../../shared/parser.js';
import { extractEntries } from '../../shared/extract.js';
import { CATALOG } from '../../shared/sources-catalog.js';
import { sha256Hex } from '../../shared/crypto.js';
import { runDiscoveryTask } from '../ai/discovery.js';
import { promoteCandidates } from './promote.js';

/** 一批插入的候选行数。9 个参数 × 250 行 = 2250 个占位符，远低于 PG 的 65535 上限，
 *  同时把往返次数从「一行一次」压到「两百多行一次」—— PGlite 是单写者，
 *  逐条 INSERT 四万行会让整个 API 在同步期间完全失去响应。 */
const INSERT_CHUNK = 250;

export interface SourceRow {
  id: string;
  key: string;
  name: string;
  type: string;
  url: string | null;
  format_hint: string | null;
  authorization_status: string;
  config: Record<string, unknown> | null;
}

export interface SyncOutcome {
  sourceId: string;
  key: string;
  name: string;
  ok: boolean;
  snapshotId: string | null;
  /** 抽取器拿到的条目数（含重复） */
  entries: number;
  /** 实际写进候选区的行数 */
  candidates: number;
  duplicateSnapshot: boolean;
  format: string;
  warnings: string[];
  error?: string;
  durationMs: number;
}


/**
 * 来源与候选隔离区。
 *
 * 关键不变量：解析器与 AI **只能写 candidate_endpoints**，
 * 绝不能直接写 proxy_endpoints。晋级（promote）是唯一入口，
 * 且必须经过授权判断 —— 这是"候选区"存在的全部意义。
 */
export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sources', { preHandler: guard('source:read') }, async (): Promise<{ items: SourceSummary[] }> => {
    const rows = await q<Record<string, unknown>>(
      `SELECT s.id, s.key, s.name, s.type, s.url, s.format_hint, s.authorization_status,
              s.trust_level, s.enabled, s.sync_interval_seconds, s.last_synced_at, s.notes, s.config,
              s.last_sync_status, s.last_sync_error, s.quality_score, s.quality_sample_size,
              s.auto_disabled_at, s.auto_disable_reason,
              COALESCE(c.pending, 0)  AS pending,
              COALESCE(c.total, 0)    AS total,
              COALESCE(c.promoted, 0) AS promoted
       FROM resource_sources s
       LEFT JOIN LATERAL (
         -- pending 只算**活跃**候选：被标过期的那些既不会被晋级，也不该
         -- 显示成"待处理积压"。一个恒定的「待晋级 51,000」会让界面看起来
         -- 像卡住了，而实际上那是目标达成后的正常状态。
         SELECT count(*) FILTER (
                  WHERE review_status = 'PENDING' AND stale_at IS NULL
                )::int                                                  AS pending,
                count(*)::int                                           AS total,
                count(*) FILTER (WHERE review_status = 'PROMOTED')::int AS promoted
         FROM candidate_endpoints ce WHERE ce.source_id = s.id
       ) c ON true
       ORDER BY s.enabled DESC, s.created_at ASC`,
    );

    return {
      items: rows.map((r): SourceSummary => {
        const cfg = (r.config ?? {}) as Record<string, unknown>;
        return {
          id: r.id as string,
          key: r.key as string,
          name: r.name as string,
          type: r.type as SourceSummary['type'],
          url: (r.url as string) ?? null,
          formatHint: (r.format_hint as string) ?? null,
          protocolHint: (cfg['protocolHint'] as ProxyProtocol) ?? null,
          authorizationStatus: r.authorization_status as SourceSummary['authorizationStatus'],
          trustLevel: Number(r.trust_level),
          enabled: Boolean(r.enabled),
          syncIntervalSeconds: Number(r.sync_interval_seconds),
          lastSyncedAt: r.last_synced_at ? String(r.last_synced_at) : null,
          notes: (r.notes as string) ?? null,
          pendingCandidates: Number(r.pending ?? 0),
          totalCandidates: Number(r.total ?? 0),
          promotedCandidates: Number(r.promoted ?? 0),
          lastSyncStatus: (r.last_sync_status as SourceSummary['lastSyncStatus']) ?? 'NEVER',
          lastSyncError: (r.last_sync_error as string) ?? null,
          // numeric 列在 PGlite 里是字符串；null 要保留成 null 而不是 0 ——
          // "没算过"和"算出来是 0 分"是两件事
          qualityScore: r.quality_score === null ? null : Number(r.quality_score),
          qualitySampleSize: Number(r.quality_sample_size ?? 0),
          autoDisabledAt: r.auto_disabled_at ? String(r.auto_disabled_at) : null,
          autoDisableReason: (r.auto_disable_reason as string) ?? null,
        };
      }),
    };
  });

  /**
   * 手动重算来源质量。
   *
   * worker 每 5 分钟自动跑一次；这里是为了"刚导入完想立刻看结果"。
   * 返回逐条动作而不是只返回计数 —— 自动降权会改变系统行为，
   * 触发者需要知道到底动了谁。
   */
  app.post('/sources/recompute-quality', { preHandler: guard('source:write') }, async () => {
    const { recomputeSourceQuality } = await import('./quality.js');
    const items = await recomputeSourceQuality();
    return {
      items,
      changed: items.filter((i) => i.action !== 'none' && i.action !== 'skipped').length,
    };
  });

  /**
   * 候选区总览。采集到几万条之后，「总共多少、去重后多少、什么协议」是
   * 判断下一步该不该晋级的唯一依据 —— 没有这个数字，界面只能显示一堆源名。
   *
   * `uniqueEndpoints` 才是真实资源量：同一条代理会被多个源同时收录，
   * 4 万条候选里真正独立的往往只有一半。
   */
  app.get('/sources/stats', { preHandler: guard('source:read') }, async () => {
    const overall = await q1<Record<string, unknown>>(
      `SELECT count(*)::int                                                AS total,
              count(DISTINCT dedupe_key)::int                               AS unique_endpoints,
              count(DISTINCT host)::int                                     AS unique_hosts,
              count(*) FILTER (WHERE review_status = 'PENDING')::int        AS pending,
              count(*) FILTER (WHERE review_status = 'PROMOTED')::int       AS promoted,
              count(*) FILTER (WHERE review_status = 'DUPLICATE')::int      AS duplicate
       FROM candidate_endpoints`,
    );

    const byProtocol = await q<{ protocol: string | null; n: number }>(
      `SELECT protocol::text AS protocol, count(DISTINCT dedupe_key)::int AS n
       FROM candidate_endpoints
       WHERE review_status = 'PENDING'
       GROUP BY 1 ORDER BY 2 DESC`,
    );

    return {
      total: Number(overall?.total ?? 0),
      uniqueEndpoints: Number(overall?.unique_endpoints ?? 0),
      uniqueHosts: Number(overall?.unique_hosts ?? 0),
      pending: Number(overall?.pending ?? 0),
      promoted: Number(overall?.promoted ?? 0),
      duplicate: Number(overall?.duplicate ?? 0),
      byProtocol: byProtocol.map((r) => ({ protocol: r.protocol, count: Number(r.n) })),
    };
  });

  app.post('/sources', { preHandler: guard('source:write') }, async (req) => {
    const body = req.body as {
      key?: string; name: string; type: string; url?: string;
      formatHint?: string; authorizationStatus?: string; trustLevel?: number;
      syncIntervalSeconds?: number;
    };
    if (!body?.name) throw invalid('name 必填');
    if (!body?.type) throw invalid('type 必填');
    if (body.type !== 'MANUAL' && !body.url) {
      throw invalid('非 MANUAL 来源必须提供 url', [{ field: 'url', message: '必填' }]);
    }

    const actor = actorOf(req);
    const id = uuidv7();
    const key = body.key ?? slugify(body.name, 'source');

    await tx(async (t) => {
      await t.exec(
        `INSERT INTO resource_sources
           (id, key, name, type, url, format_hint, authorization_status, trust_level, sync_interval_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id, key, body.name, body.type, body.url ?? null, body.formatHint ?? null,
          body.authorizationStatus ?? 'UNKNOWN', body.trustLevel ?? 50, body.syncIntervalSeconds ?? 3600,
        ],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'source.create',
        resourceType: 'source', resourceId: id, afterState: body,
      });
    });

    return { id, key };
  });

  app.patch('/sources/:id', { preHandler: guard('source:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const actor = actorOf(req);

    /**
     * 自动晋级开关。
     *
     * 之前只有 `/sources/catalog` 能设 `auto_promote`，于是 AI 发现的源
     * 落进了一个死胡同：`runDiscoveryTask` 把它们入库（停用 + UNKNOWN），
     * 用户手工启用之后发现还是不出节点 —— 因为没有任何接口能打开
     * `auto_promote`，而 `sourcesWithBacklog()` 只挑 auto_promote=true 的源。
     * 表现是"源启用成功、候选也在涨，但一个端点都不晋级"。
     *
     * 与 catalog 接口同一套约束：要开自动晋级就必须同时声明授权级别，
     * 系统不替用户编一个 AUTHORIZED 出来。
     */
    /**
     * 同步周期的下限。
     *
     * 提高同步频率是为了更早拿到新出现的 IP（见 sources-catalog 的说明），
     * 但这里必须有个地板：`sync_interval_seconds` 是直接拼进
     * `dueSources` 的时间间隔的，写个 1 会让这个源每 15 秒被拉一次 ——
     * 那不是"更勤快"，是把对方站点当压测目标，也把我们自己的解析流水线堵死。
     *
     * 5 分钟是个保守地板：免费代理列表的换血周期远长于它，
     * 再快也只能拉到同一份内容（`duplicateSnapshot` 会直接跳过，纯属白拉）。
     */
    if (body.syncIntervalSeconds !== undefined && body.syncIntervalSeconds !== null) {
      const sec = Number(body.syncIntervalSeconds);
      if (!Number.isInteger(sec) || sec < 300 || sec > 604_800) {
        throw invalid('syncIntervalSeconds 必须是 300–604800 之间的整数（5 分钟到 7 天）');
      }
    }

    const autoPromote = body.autoPromote === true;
    const autoAuth = (body.authorization as string | undefined) ?? null;
    if (autoPromote && autoAuth !== 'AUTHORIZED' && autoAuth !== 'RESTRICTED') {
      throw invalid('autoPromote 必须同时声明 authorization（AUTHORIZED 或 RESTRICTED）');
    }

    /**
     * 人工启用必须**同时**清掉自动停用的痕迹。
     *
     * 原来只改 `enabled`，`auto_disabled_at` 与 `quality_low_streak` 原样留着。
     * 后果是用户的启用动作在 5 分钟内被静默推翻：质量重算每 5 分钟一次，
     * 停用分支的条件是「连续 ≥2 次低分」，而 streak 在停用时已经是 43 ——
     * 下一轮只要分数仍低于阈值，就立刻再关一次。用户会看到源"自己又关了"，
     * 且没有任何提示。
     *
     * 实测就是这个形态：hideipme-socks5 的 streak 是 43，手工启用之后
     * 下一个重算周期就回到停用。而它恰好是当时**隧道可用率最高**的源
     * （现拉现测 12 条：8 条存活、6 条能建隧道），被关掉的直接原因是
     * 分数按"库存存活"算 —— 一个必然会衰减到 0 的口径（见 quality.ts）。
     *
     * 清 streak 不是"放宽标准"，而是**重置证据**：自动判定基于旧证据，
     * 人既然否定了这个判定，就必须让它从零开始重新累积，否则人和机器
     * 会陷入"你开我关"的死循环，而用户完全不知道发生了什么。
     */
    const enableNow = body.enabled === true;

    await tx(async (t) => {
      await t.exec(
        `UPDATE resource_sources SET
           name = COALESCE($2, name),
           enabled = COALESCE($3, enabled),
           authorization_status = COALESCE($4::authorization_status, authorization_status),
           trust_level = COALESCE($5, trust_level),
           sync_interval_seconds = COALESCE($6, sync_interval_seconds),
           notes = COALESCE($7, notes),
           auto_promote = CASE WHEN $8 THEN true ELSE auto_promote END,
           auto_promote_authorization = CASE WHEN $8 THEN $9::authorization_status
                                             ELSE auto_promote_authorization END,
           -- 人工启用：清掉自动停用的痕迹，让重算从零开始累积证据
           auto_disabled_at = CASE WHEN $10 THEN NULL ELSE auto_disabled_at END,
           auto_disable_reason = CASE WHEN $10 THEN NULL ELSE auto_disable_reason END,
           quality_low_streak = CASE WHEN $10 THEN 0 ELSE quality_low_streak END
         WHERE id = $1`,
        [
          id, (body.name as string) ?? null, (body.enabled as boolean) ?? null,
          (body.authorizationStatus as string) ?? null, (body.trustLevel as number) ?? null,
          (body.syncIntervalSeconds as number) ?? null, (body.notes as string) ?? null,
          autoPromote, autoAuth, enableNow,
        ],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'source.update',
        resourceType: 'source', resourceId: id, afterState: body,
      });
    });
    return { ok: true };
  });

  /**
   * 删除来源。
   *
   * 候选区随来源级联删除（ON DELETE CASCADE）—— 那些行没有独立价值。
   * 但**已晋级的端点不删**：它们的 `source_id` 会被置空，因为端点本身
   * 有健康历史与授权记录，删来源不应该连带销毁已验证的资产。
   *
   * 代价是溯源信息会丢。所以默认拒绝：来源下还有已晋级端点时要求显式
   * `?force=1`，让"我知道会丢掉这批端点的来源线索"成为一个明确动作。
   */
  app.delete('/sources/:id', { preHandler: guard('source:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const { force } = req.query as { force?: string };
    const actor = actorOf(req);

    const source = await q1<{ id: string; key: string; name: string }>(
      'SELECT id, key, name FROM resource_sources WHERE id = $1',
      [id],
    );
    if (!source) throw notFound('来源');

    const promoted = await q1<{ c: string }>(
      'SELECT count(*)::text AS c FROM proxy_endpoints WHERE source_id = $1',
      [id],
    );
    const promotedCount = Number(promoted?.c ?? 0);
    if (promotedCount > 0 && force !== '1') {
      throw invalid(
        `该来源下有 ${promotedCount} 个已晋级端点。删除会断开它们的溯源信息，` +
          '端点本身保留。确认请加 ?force=1',
        [{ field: 'force', message: '需要显式确认' }],
      );
    }

    const candidates = await q1<{ c: string }>(
      'SELECT count(*)::text AS c FROM candidate_endpoints WHERE source_id = $1',
      [id],
    );

    await tx(async (t) => {
      await t.exec('DELETE FROM resource_sources WHERE id = $1', [id]);
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'source.delete',
        resourceType: 'source', resourceId: id,
        beforeState: {
          key: source.key, name: source.name,
          candidatesRemoved: Number(candidates?.c ?? 0),
          endpointsDetached: promotedCount,
        },
      });
    });

    return {
      ok: true,
      candidatesRemoved: Number(candidates?.c ?? 0),
      endpointsDetached: promotedCount,
    };
  });

  /**
   * 同步：抓取/接收内容 → 快照 → 解析 → 写候选区（绝不直接建端点）
   *
   * 请求体可选：
   *   content         直接给内容，跳过网络抓取（MANUAL 源必须用这个）
   *   authorization   覆盖候选的授权猜测（UNKNOWN / AUTHORIZED / RESTRICTED）。
   *                   公开列表默认 UNKNOWN —— 我们不知道每个 IP 的归属，
   *                   凭空标 AUTHORIZED 等于伪造授权依据。
   */
  app.post('/sources/:id/sync', { preHandler: guard('source:write') }, async (req): Promise<SyncOutcome> => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { content?: string; authorization?: string };
    const actor = actorOf(req);

    const source = await q1<SourceRow>(
      `SELECT id, key, name, type, url, format_hint, authorization_status, config
       FROM resource_sources WHERE id = $1`,
      [id],
    );
    if (!source) throw notFound('来源');

    return syncSource(source, actor, {
      content: body.content,
      authorization: body.authorization,
    });
  });

  /**
   * 批量同步。串行执行而不是并发 —— PGlite 只有单写者，
   * 并发同步只会让所有事务排队，还可能撞上数据目录的写锁。
   * 单个源失败不影响其余源，结果逐条回传。
   */
  app.post('/sources/sync-all', { preHandler: guard('source:write') }, async (req) => {
    const body = (req.body ?? {}) as { keys?: string[]; authorization?: string; concurrency?: number };
    const actor = actorOf(req);

    const sources = await q<SourceRow>(
      `SELECT id, key, name, type, url, format_hint, authorization_status, config
       FROM resource_sources
       WHERE enabled = true AND type <> 'MANUAL'
         AND ($1::text[] IS NULL OR key = ANY($1::text[]))
       ORDER BY key`,
      [body.keys?.length ? body.keys : null],
    );
    if (!sources.length) throw invalid('没有可同步的来源（需要 enabled 且非 MANUAL）');

    const results: SyncOutcome[] = [];
    for (const s of sources) {
      results.push(await syncSource(s, actor, { authorization: body.authorization }));
    }

    return {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      candidates: results.reduce((a, r) => a + r.candidates, 0),
      results,
    };
  });

  /** 一键导入内置目录。幂等：按 key upsert，不覆盖用户改过的信任级与开关。 */
  app.post('/sources/catalog', { preHandler: guard('source:write') }, async (req) => {
    const body = (req.body ?? {}) as {
      keys?: string[];
      /** 导入后由采集流水线自动把候选晋级成端点 */
      autoPromote?: boolean;
      /** 自动晋级时写入端点的授权状态。autoPromote 为 true 时必填。 */
      authorization?: 'AUTHORIZED' | 'RESTRICTED';
    };
    const actor = actorOf(req);
    const wanted = body.keys?.length ? CATALOG.filter((c) => body.keys!.includes(c.key)) : CATALOG;
    if (!wanted.length) throw invalid('目录里没有匹配的 key');

    // 自动晋级必须配一个明确的授权声明。公开代理列表我们不知道每个 IP 的
    // 归属，系统不替用户编一个 AUTHORIZED 出来 —— 只执行用户声明的结果。
    const autoPromote = body.autoPromote === true;
    const auth = body.authorization ?? null;
    if (autoPromote && auth !== 'AUTHORIZED' && auth !== 'RESTRICTED') {
      throw invalid('autoPromote 必须同时声明 authorization（AUTHORIZED 或 RESTRICTED）');
    }

    let created = 0;
    let updated = 0;

    await tx(async (t) => {
      for (const c of wanted) {
        const existing = await t.q1<{ id: string }>('SELECT id FROM resource_sources WHERE key = $1', [c.key]);
        if (existing) {
          // 只刷新描述性字段；enabled / trust_level 是用户的决定，不覆盖。
          // auto_promote 例外：它是本次请求显式表达的意图。
          await t.exec(
            `UPDATE resource_sources SET name = $2, url = $3, type = $4::source_type,
               format_hint = $5, config = $6::jsonb, notes = $7,
               auto_promote = CASE WHEN $8 THEN true ELSE auto_promote END,
               auto_promote_authorization = CASE WHEN $8 THEN $9::authorization_status
                                                 ELSE auto_promote_authorization END,
               updated_at = now()
             WHERE id = $1`,
            [existing.id, c.name, c.url, c.type, c.formatHint,
              JSON.stringify({ protocolHint: c.protocolHint }), c.notes, autoPromote, auth],
          );
          updated += 1;
        } else {
          await t.exec(
            `INSERT INTO resource_sources
               (id, key, name, type, url, format_hint, authorization_status, trust_level,
                sync_interval_seconds, config, notes, auto_promote, auto_promote_authorization)
             VALUES ($1,$2,$3,$4::source_type,$5,$6,'UNKNOWN',$7,$8,$9::jsonb,$10,$11,$12::authorization_status)`,
            [uuidv7(), c.key, c.name, c.type, c.url, c.formatHint, c.trustLevel,
              c.syncIntervalSeconds, JSON.stringify({ protocolHint: c.protocolHint }), c.notes,
              autoPromote, auth],
          );
          created += 1;
        }
      }
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'source.catalog',
        resourceType: 'source', resourceId: null,
        afterState: { created, updated, autoPromote, authorization: auth },
      });
    });

    return { created, updated, total: wanted.length, autoPromote, authorization: auth };
  });


  app.get('/sources/:id/snapshots', { preHandler: guard('source:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await q<Record<string, unknown>>(
      `SELECT id, fetched_at, http_status, content_hash, size_bytes, parse_status, candidate_count, error
       FROM source_snapshots WHERE source_id = $1 ORDER BY fetched_at DESC LIMIT 50`,
      [id],
    );
    return { items: rows };
  });

  app.get('/candidates', { preHandler: guard('source:read') }, async (req) => {
    const { reviewStatus } = req.query as { reviewStatus?: string };
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM candidate_endpoints
       WHERE ($1::text IS NULL OR review_status = $1::review_status)
       ORDER BY created_at DESC LIMIT 200`,
      [reviewStatus ?? 'PENDING'],
    );
    return {
      items: rows.map(
        (r): CandidateRow => ({
          id: r.id as string,
          sourceId: r.source_id as string,
          rawValue: r.raw_value as string,
          protocol: (r.protocol as ProxyProtocol) ?? null,
          host: (r.host as string) ?? null,
          port: (r.port as number) ?? null,
          reviewStatus: r.review_status as CandidateRow['reviewStatus'],
          authorizationGuess: r.authorization_guess as CandidateRow['authorizationGuess'],
          rejectReason: (r.reject_reason as string) ?? null,
          createdAt: String(r.created_at),
        }),
      ),
    };
  });

  /** 晋级：候选 → 端点，唯一入口 */
  app.post('/candidates/:id/promote', { preHandler: guard('resource:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { trustTier?: TrustTier; originType?: string };
    const actor = actorOf(req);

    return tx(async (t) => {
      const c = await t.q1<{
        id: string; source_id: string; protocol: ProxyProtocol | null; host: string | null;
        port: number | null; dedupe_key: string | null; review_status: string;
      }>(
        'SELECT id, source_id, protocol, host, port, dedupe_key, review_status FROM candidate_endpoints WHERE id = $1',
        [id],
      );
      if (!c) throw notFound('候选');
      if (c.review_status !== 'PENDING') throw invalid('该候选已处理');
      if (!c.host || !c.port || !c.protocol) throw invalid('候选缺少可用的 host/port/protocol');

      const existing = c.dedupe_key
        ? await t.q1<{ id: string }>('SELECT id FROM proxy_endpoints WHERE dedupe_key = $1', [c.dedupe_key])
        : null;

      if (existing) {
        await t.exec(`UPDATE candidate_endpoints SET review_status = 'DUPLICATE' WHERE id = $1`, [id]);
        return { duplicate: true, endpointId: existing.id };
      }

      const endpointId = uuidv7();
      // 默认仍是最严分级：晋级 ≠ 放宽
      const tier: TrustTier = body.trustTier ?? 'PUBLIC_PROXY';

      await t.exec(
        `INSERT INTO proxy_endpoints
           (id, source_id, protocol, host, port, origin_type, authorization_status, trust_tier,
            lifecycle_status, dedupe_key, display_name)
         VALUES ($1,$2,$3,$4,$5,$6,'UNKNOWN',$7,'PENDING_VERIFICATION',$8,$9)`,
        [
          endpointId, c.source_id, c.protocol, c.host, c.port,
          body.originType ?? 'PUBLIC_PROXY', tier, c.dedupe_key,
          `${c.host}:${c.port}`,
        ],
      );
      await t.exec('INSERT INTO endpoint_health_state (endpoint_id) VALUES ($1) ON CONFLICT DO NOTHING', [endpointId]);
      await t.exec(
        `UPDATE candidate_endpoints SET review_status = 'PROMOTED', promoted_endpoint_id = $2,
           reviewed_at = now(), reviewed_by = $3 WHERE id = $1`,
        [id, endpointId, actor.id],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'candidate.promote',
        resourceType: 'candidate', resourceId: id,
        afterState: { endpointId, trustTier: tier },
      });
      await emit(t, {
        type: EVENT_TYPES.ENDPOINT_IMPORTED,
        aggregateType: 'endpoint', aggregateId: endpointId,
        payload: { fromCandidate: id, trustTier: tier },
      });

      return { duplicate: false, endpointId };
    });
  });

  /**
   * 批量晋级。单个晋级在 4 万条候选面前等于不可用，
   * 但「批量」不等于「自动」—— 仍然要求调用方显式声明授权，
   * 且分级上限钉死在 PUBLIC_PROXY。
   *
   * 明确不做的事：
   *   · 不跳过候选区直接建端点（隔离区的意义就是这一层）
   *   · 不接受 trustTier > PUBLIC_PROXY（晋升建议 + 他人复核才能提级）
   *   · 不碰已 REVIEWED 的候选
   */
  app.post('/candidates/bulk-promote', { preHandler: guard('resource:write') }, async (req) => {
    const body = (req.body ?? {}) as {
      sourceId?: string;
      limit?: number;
      authorization?: 'AUTHORIZED' | 'RESTRICTED';
    };
    const actor = actorOf(req);

    if (!body.sourceId) throw invalid('sourceId 必填');
    if (!body.authorization) {
      throw invalid('必须显式声明 authorization（AUTHORIZED 或 RESTRICTED），批量晋级不接受默认值');
    }
    const limit = Math.min(Math.max(body.limit ?? 200, 1), 500);
    // 收窄成局部常量：闭包里 TS 不会保留前面 throw 的收窄结果
    const authorization = body.authorization;

    return tx(async (t) => {
      // 晋级逻辑与自动采集流水线共用一份实现（source/promote.ts）——
      // 两处各写一份 SQL 迟早会分叉成「手工晋级写了 provenance、自动晋级没写」。
      const result = await promoteCandidates(t, body.sourceId!, authorization, limit);
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'candidate.bulk_promote',
        resourceType: 'source', resourceId: body.sourceId!,
        afterState: { ...result, authorization },
      });
      return result;
    });
  });

  app.post('/candidates/:id/reject', { preHandler: guard('resource:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    const actor = actorOf(req);
    await tx(async (t) => {
      const n = await t.exec(
        `UPDATE candidate_endpoints SET review_status = 'REJECTED', reject_reason = $2,
           reviewed_at = now(), reviewed_by = $3 WHERE id = $1 AND review_status = 'PENDING'`,
        [id, body.reason ?? null, actor.id],
      );
      if (n === 0) throw notFound('待处理候选');
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'candidate.reject',
        resourceType: 'candidate', resourceId: id, afterState: { reason: body.reason ?? null },
      });
    });
    return { ok: true };
  });

  app.post('/intelligence/discover', { preHandler: guard('source:write') }, async (req) => {
    const body = (req.body ?? {}) as { query?: string; sourceId?: string };
    const actor = actorOf(req);
    const id = uuidv7();
    await tx(async (t) => {
      await t.exec(
        `INSERT INTO ai_discovery_tasks (id, source_id, query, status, created_by)
         VALUES ($1,$2,$3,'PENDING',$4)`,
        [id, body.sourceId ?? null, body.query ?? null, actor.id],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'intelligence.discover',
        resourceType: 'ai_discovery_task', resourceId: id,
      });
    });
    return { id, status: 'PENDING' };
  });

  app.get('/intelligence/tasks', { preHandler: guard('source:read') }, async () => {
    const rows = await q<Record<string, unknown>>(
      `SELECT t.id, t.query, t.status, t.result_summary, t.proposed_sources, t.model_name,
              t.error_message, t.attempts, t.created_at, t.started_at, t.finished_at
       FROM ai_discovery_tasks t
       ORDER BY t.created_at DESC
       LIMIT 50`,
    );
    return { items: rows };
  });

  app.get('/intelligence/tasks/:id', { preHandler: guard('source:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await q1<Record<string, unknown>>(
      `SELECT id, query, status, result_summary, proposed_sources, model_name,
              error_message, attempts, created_at, started_at, finished_at
       FROM ai_discovery_tasks WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('发现任务');
    return row;
  });

  /**
   * 立即执行一条待处理的发现任务。
   *
   * worker 每 500ms 会自己认领，这个端点只是给界面一个"我不想等"的入口。
   * 内部仍走同一个 runDiscoveryTask —— 认领是原子的，不会和 worker 重复执行。
   */
  app.post('/intelligence/tasks/:id/run', { preHandler: guard('source:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const exists = await q1<{ id: string; status: string }>(
      'SELECT id, status FROM ai_discovery_tasks WHERE id = $1',
      [id],
    );
    if (!exists) throw notFound('发现任务');
    if (exists.status === 'SUCCEEDED' || exists.status === 'CANCELLED') {
      throw invalid(`任务已是 ${exists.status} 状态，不能重复执行`);
    }
    const outcome = await runDiscoveryTask(id);
    return outcome;
  });
}

/**
 * 单个来源的完整同步流程：抓取 → 抽取 → 解析去重 → 批量写候选 → 落快照。
 *
 * 任何一步失败都返回结构化结果而不是抛异常 —— 批量同步时
 * 一个源挂了不能让其余 16 个源的结果全部丢失。
 */
export async function syncSource(
  source: SourceRow,
  actor: { kind: 'USER' | 'API_KEY' | 'SYSTEM' | 'SCHEDULER'; id: string },
  opts: { content?: string; authorization?: string } = {},
): Promise<SyncOutcome> {
  const t0 = Date.now();
  const base = { sourceId: source.id, key: source.key, name: source.name };
  /**
   * 失败时必须落库。
   *
   * 之前这里只是 return 一个 ok:false 的响应，库里什么都没留下 ——
   * 一个 URL 已经 404 的来源，界面上永远显示"从未同步"，和"刚建好还没跑过"
   * 完全一样；而"它每 6 小时失败一次"这件事只存在于当时那个 HTTP 响应里。
   * 落库之后，来源列表能显示失败原因，告警评估器也能据此提出告警。
   */
  const fail = async (error: string): Promise<SyncOutcome> => {
    await exec(
      `UPDATE resource_sources
       SET last_attempt_at = now(), last_sync_status = 'FAILED', last_sync_error = $2
       WHERE id = $1`,
      [source.id, error.slice(0, 500)],
    ).catch(() => {
      /* 记状态失败不该掩盖真正的同步错误 */
    });
    return {
      ...base, ok: false, snapshotId: null, entries: 0, candidates: 0,
      duplicateSnapshot: false, format: '-', warnings: [], error, durationMs: Date.now() - t0,
    };
  };

  let content = opts.content ?? '';
  let httpStatus: number | null = null;

  if (!content && source.url && source.type !== 'MANUAL') {
    try {
      const res = await fetch(source.url, {
        signal: AbortSignal.timeout(20000),
        // 部分源对空 UA 直接返回 403；标一个可识别的 UA 是最低礼貌
        headers: { 'user-agent': 'ProxyForge/1.0 (resource-sync)' },
      });
      httpStatus = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      content = await res.text();
    } catch (err) {
      return await fail(`拉取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!content) {
    return await fail('没有内容：MANUAL 来源需要在请求体里提供 content');
  }

  const hint = ((source.config?.['protocolHint'] as ProxyProtocol | undefined) ?? 'HTTP');
  const { entries, format, warnings } = extractEntries(content, source.format_hint, hint);
  const authGuess = opts.authorization ?? source.authorization_status;

  // 解析 + 内存去重。同一份列表里经常出现完全重复的行，
  // 先在这里压掉，能少插很多次（ON CONFLICT 也要走一遍索引）。
  const rows = new Map<string, { raw: string; protocol: ProxyProtocol; host: string; port: number; key: string }>();
  let unparsable = 0;

  for (const e of entries) {
    const parsed = parseProxyLine(e.raw, e.protocolHint ?? hint);
    if ('error' in parsed) {
      unparsable += 1;
      continue;
    }
    const key = dedupeKey(parsed);
    if (rows.has(key)) continue;
    rows.set(key, {
      raw: e.raw.slice(0, 500),
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      key,
    });
  }

  if (unparsable > 0) {
    warnings.push(`${unparsable} 行无法解析（协议不支持或格式异常）`);
  }

  const hash = sha256Hex(content);
  const snapshotId = uuidv7();
  let inserted = 0;
  let duplicateSnapshot = false;

  await tx(async (t) => {
    const existing = await t.q1<{ id: string }>(
      'SELECT id FROM source_snapshots WHERE source_id = $1 AND content_hash = $2',
      [source.id, hash],
    );
    if (existing) {
      duplicateSnapshot = true;
      // 内容没变也要刷新 last_synced_at，否则界面会一直显示"从未同步"
      await t.exec(
        `UPDATE resource_sources SET last_synced_at = now(), last_attempt_at = now(),
                last_sync_status = 'OK', last_sync_error = NULL WHERE id = $1`,
        [source.id],
      );
      return;
    }

    await t.exec(
      `INSERT INTO source_snapshots
         (id, source_id, http_status, content_hash, size_bytes, parse_status, parser, candidate_count)
       VALUES ($1,$2,$3,$4,$5,'SUCCEEDED',$6,0)`,
      [snapshotId, source.id, httpStatus, hash, content.length, format],
    );

    const list = [...rows.values()];
    for (let i = 0; i < list.length; i += INSERT_CHUNK) {
      const slice = list.slice(i, i + INSERT_CHUNK);
      const params: unknown[] = [];
      const tuples = slice.map((r, j) => {
        const b = j * 9;
        params.push(uuidv7(), source.id, snapshotId, r.raw, r.protocol, r.host, r.port, r.key, authGuess);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::proxy_protocol,$${b + 6},$${b + 7},$${b + 8},$${b + 9}::authorization_status)`;
      });

      // 部分唯一索引必须显式带上 WHERE 谓词才能被推断，否则报
      // "there is no unique or exclusion constraint matching the ON CONFLICT specification"
      inserted += await t.exec(
        `INSERT INTO candidate_endpoints
           (id, source_id, snapshot_id, raw_value, protocol, host, port, dedupe_key, authorization_guess)
         VALUES ${tuples.join(',')}
         ON CONFLICT (source_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        params,
      );
    }

    await t.exec('UPDATE source_snapshots SET candidate_count = $2 WHERE id = $1', [snapshotId, inserted]);
    await t.exec(
      `UPDATE resource_sources SET last_synced_at = now(), last_attempt_at = now(),
              last_sync_status = 'OK', last_sync_error = NULL, last_snapshot_id = $2 WHERE id = $1`,
      [source.id, snapshotId],
    );
    await audit(t, {
      actorType: actor.kind, actorId: actor.id, action: 'source.sync',
      resourceType: 'source', resourceId: source.id,
      afterState: { snapshotId, entries: entries.length, candidates: inserted, format },
    });
  });

  return {
    ...base,
    ok: true,
    snapshotId: duplicateSnapshot ? null : snapshotId,
    entries: entries.length,
    candidates: inserted,
    duplicateSnapshot,
    format,
    warnings,
    durationMs: Date.now() - t0,
  };
}
