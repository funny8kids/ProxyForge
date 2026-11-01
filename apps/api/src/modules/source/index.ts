import type { FastifyInstance } from 'fastify';
import type { CandidateRow, ProxyProtocol, SourceSummary, TrustTier } from '@proxyforge/contracts';
import { q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit, emit, EVENT_TYPES } from '../../shared/events.js';
import { invalid, notFound } from '../../shared/errors.js';
import { slugify, uuidv7 } from '../../shared/id.js';
import { dedupeKey, parseProxyLine } from '../../shared/parser.js';
import { extractEntries } from '../../shared/extract.js';
import { CATALOG } from '../../shared/sources-catalog.js';
import { sha256Hex } from '../../shared/crypto.js';

/** 一批插入的候选行数。9 个参数 × 250 行 = 2250 个占位符，远低于 PG 的 65535 上限，
 *  同时把往返次数从「一行一次」压到「两百多行一次」—— PGlite 是单写者，
 *  逐条 INSERT 四万行会让整个 API 在同步期间完全失去响应。 */
const INSERT_CHUNK = 250;

interface SourceRow {
  id: string;
  key: string;
  name: string;
  type: string;
  url: string | null;
  format_hint: string | null;
  authorization_status: string;
  config: Record<string, unknown> | null;
}

interface SyncOutcome {
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
              COALESCE(c.pending, 0)  AS pending,
              COALESCE(c.total, 0)    AS total,
              COALESCE(c.promoted, 0) AS promoted
       FROM resource_sources s
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE review_status = 'PENDING')::int  AS pending,
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
        };
      }),
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
    await tx(async (t) => {
      await t.exec(
        `UPDATE resource_sources SET
           name = COALESCE($2, name),
           enabled = COALESCE($3, enabled),
           authorization_status = COALESCE($4::authorization_status, authorization_status),
           trust_level = COALESCE($5, trust_level),
           sync_interval_seconds = COALESCE($6, sync_interval_seconds)
         WHERE id = $1`,
        [
          id, (body.name as string) ?? null, (body.enabled as boolean) ?? null,
          (body.authorizationStatus as string) ?? null, (body.trustLevel as number) ?? null,
          (body.syncIntervalSeconds as number) ?? null,
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
    const body = (req.body ?? {}) as { keys?: string[] };
    const actor = actorOf(req);
    const wanted = body.keys?.length ? CATALOG.filter((c) => body.keys!.includes(c.key)) : CATALOG;
    if (!wanted.length) throw invalid('目录里没有匹配的 key');

    let created = 0;
    let updated = 0;

    await tx(async (t) => {
      for (const c of wanted) {
        const existing = await t.q1<{ id: string }>('SELECT id FROM resource_sources WHERE key = $1', [c.key]);
        if (existing) {
          // 只刷新描述性字段；enabled / trust_level 是用户的决定，不覆盖
          await t.exec(
            `UPDATE resource_sources SET name = $2, url = $3, type = $4::source_type,
               format_hint = $5, config = $6::jsonb, notes = $7, updated_at = now()
             WHERE id = $1`,
            [existing.id, c.name, c.url, c.type, c.formatHint,
              JSON.stringify({ protocolHint: c.protocolHint }), c.notes],
          );
          updated += 1;
        } else {
          await t.exec(
            `INSERT INTO resource_sources
               (id, key, name, type, url, format_hint, authorization_status, trust_level,
                sync_interval_seconds, config, notes)
             VALUES ($1,$2,$3,$4::source_type,$5,$6,'UNKNOWN',$7,$8,$9::jsonb,$10)`,
            [uuidv7(), c.key, c.name, c.type, c.url, c.formatHint, c.trustLevel,
              c.syncIntervalSeconds, JSON.stringify({ protocolHint: c.protocolHint }), c.notes],
          );
          created += 1;
        }
      }
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'source.catalog',
        resourceType: 'source', resourceId: null, afterState: { created, updated },
      });
    });

    return { created, updated, total: wanted.length };
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

    return tx(async (t) => {
      const pending = await t.q<{
        id: string; protocol: ProxyProtocol; host: string; port: number; dedupe_key: string | null;
      }>(
        `SELECT id, protocol, host, port, dedupe_key
         FROM candidate_endpoints
         WHERE source_id = $1 AND review_status = 'PENDING'
           AND host IS NOT NULL AND port IS NOT NULL AND protocol IS NOT NULL
         ORDER BY created_at ASC
         LIMIT $2`,
        [body.sourceId, limit],
      );

      if (!pending.length) return { promoted: 0, duplicate: 0, remaining: 0 };

      // 已存在的端点先查一遍，避免逐条 SELECT
      const keys = pending.map((c) => c.dedupe_key).filter((k): k is string => !!k);
      const existing = keys.length
        ? await t.q<{ dedupe_key: string }>('SELECT dedupe_key FROM proxy_endpoints WHERE dedupe_key = ANY($1::text[])', [keys])
        : [];
      const existingSet = new Set(existing.map((e) => e.dedupe_key));

      let promoted = 0;
      let duplicate = 0;

      for (const c of pending) {
        if (c.dedupe_key && existingSet.has(c.dedupe_key)) {
          await t.exec(`UPDATE candidate_endpoints SET review_status = 'DUPLICATE', reviewed_at = now() WHERE id = $1`, [c.id]);
          duplicate += 1;
          continue;
        }

        const endpointId = uuidv7();
        await t.exec(
          `INSERT INTO proxy_endpoints
             (id, source_id, protocol, host, port, origin_type, authorization_status, trust_tier,
              lifecycle_status, dedupe_key, display_name)
           VALUES ($1,$2,$3,$4,$5,'PUBLIC_PROXY',$6::authorization_status,'PUBLIC_PROXY',
                   'PENDING_VERIFICATION',$7,$8)`,
          [endpointId, body.sourceId, c.protocol, c.host, c.port, body.authorization, c.dedupe_key,
            `${c.host}:${c.port}`],
        );
        await t.exec('INSERT INTO endpoint_health_state (endpoint_id) VALUES ($1) ON CONFLICT DO NOTHING', [endpointId]);
        await t.exec(
          `UPDATE candidate_endpoints SET review_status = 'PROMOTED', promoted_endpoint_id = $2,
             reviewed_at = now(), reviewed_by = $3 WHERE id = $1`,
          [c.id, endpointId, actor.id],
        );
        // 同批次里跨源重复的同一条代理，也要拦住 —— 否则两个源各推一次
        // 就会在端点表里建出两行 dedupe_key 相同的记录（没有唯一约束兜底）。
        if (c.dedupe_key) existingSet.add(c.dedupe_key);
        promoted += 1;
      }

      const rest = await t.q1<{ n: number }>(
        `SELECT count(*)::int AS n FROM candidate_endpoints
         WHERE source_id = $1 AND review_status = 'PENDING'`,
        [body.sourceId],
      );

      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'candidate.bulk_promote',
        resourceType: 'source', resourceId: body.sourceId,
        afterState: { promoted, duplicate, remaining: rest?.n ?? 0, authorization: body.authorization },
      });

      return { promoted, duplicate, remaining: rest?.n ?? 0 };
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
      'SELECT * FROM ai_discovery_tasks ORDER BY created_at DESC LIMIT 50',
    );
    return { items: rows };
  });
}

/**
 * 单个来源的完整同步流程：抓取 → 抽取 → 解析去重 → 批量写候选 → 落快照。
 *
 * 任何一步失败都返回结构化结果而不是抛异常 —— 批量同步时
 * 一个源挂了不能让其余 16 个源的结果全部丢失。
 */
async function syncSource(
  source: SourceRow,
  actor: { kind: 'USER' | 'API_KEY' | 'SYSTEM' | 'SCHEDULER'; id: string },
  opts: { content?: string; authorization?: string } = {},
): Promise<SyncOutcome> {
  const t0 = Date.now();
  const base = { sourceId: source.id, key: source.key, name: source.name };
  const fail = (error: string): SyncOutcome => ({
    ...base, ok: false, snapshotId: null, entries: 0, candidates: 0,
    duplicateSnapshot: false, format: '-', warnings: [], error, durationMs: Date.now() - t0,
  });

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
      return fail(`拉取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!content) {
    return fail('没有内容：MANUAL 来源需要在请求体里提供 content');
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
      await t.exec('UPDATE resource_sources SET last_synced_at = now() WHERE id = $1', [source.id]);
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
      'UPDATE resource_sources SET last_synced_at = now(), last_snapshot_id = $2 WHERE id = $1',
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
