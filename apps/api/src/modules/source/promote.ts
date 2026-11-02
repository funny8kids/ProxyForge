import type { ProxyProtocol } from '@proxyforge/contracts';
import type { TxLike } from '../../db/client.js';
import { uuidv7 } from '../../shared/id.js';

/**
 * 候选晋级。
 *
 * 抽出来是因为有两条调用路径：手工接口（`POST /candidates/bulk-promote`）
 * 和自动采集流水线（`ingest.ts`）。这两处如果各写一份 SQL，迟早会分叉成
 * "手工晋级会写 endpoint_sources、自动晋级忘了写"这种只有一边正确的状态 ——
 * 而那种偏差不会报错，只会让质量评分和溯源对一部分节点失效。
 *
 * 晋级是写入 `proxy_endpoints` 的**唯一**入口（见 source/index.ts 顶部注释）。
 * 免费代理体量大，人工逐条点不现实，所以这里必须支持批量且幂等。
 */

export type PromoteAuthorization = 'AUTHORIZED' | 'RESTRICTED';

export interface PromoteResult {
  promoted: number;
  duplicate: number;
  remaining: number;
}

export async function promoteCandidates(
  t: TxLike,
  sourceId: string,
  authorization: PromoteAuthorization,
  limit: number,
): Promise<PromoteResult> {
  const pending = await t.q<{
    id: string; protocol: ProxyProtocol; host: string; port: number; dedupe_key: string | null;
  }>(
    `SELECT id, protocol, host, port, dedupe_key
     FROM candidate_endpoints
     WHERE source_id = $1 AND review_status = 'PENDING'
       AND host IS NOT NULL AND port IS NOT NULL AND protocol IS NOT NULL
     ORDER BY created_at ASC
     LIMIT $2`,
    [sourceId, limit],
  );

  if (!pending.length) {
    const rest = await t.q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM candidate_endpoints
       WHERE source_id = $1 AND review_status = 'PENDING'`,
      [sourceId],
    );
    return { promoted: 0, duplicate: 0, remaining: rest?.n ?? 0 };
  }

  // 已存在的端点先查一遍，避免逐条 SELECT
  const keys = pending.map((c) => c.dedupe_key).filter((k): k is string => !!k);
  const existing = keys.length
    ? await t.q<{ dedupe_key: string }>(
        'SELECT dedupe_key FROM proxy_endpoints WHERE dedupe_key = ANY($1::text[])',
        [keys],
      )
    : [];
  const existingSet = new Set(existing.map((e) => e.dedupe_key));

  let promoted = 0;
  let duplicate = 0;

  for (const c of pending) {
    if (c.dedupe_key && existingSet.has(c.dedupe_key)) {
      await t.exec(
        `UPDATE candidate_endpoints SET review_status = 'DUPLICATE', reviewed_at = now() WHERE id = $1`,
        [c.id],
      );
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
      [endpointId, sourceId, c.protocol, c.host, c.port, authorization, c.dedupe_key,
        `${c.host}:${c.port}`],
    );
    await t.exec(
      'INSERT INTO endpoint_health_state (endpoint_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [endpointId],
    );
    // provenance 必须同时写：质量评分按 endpoint_sources 聚合，
    // 少了它那个源的样本数永远是 0，自动降权就静默失效了。
    await t.exec(
      'INSERT INTO endpoint_sources (endpoint_id, source_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [endpointId, sourceId],
    );
    await t.exec(
      `UPDATE candidate_endpoints SET review_status = 'PROMOTED', promoted_endpoint_id = $2,
         reviewed_at = now() WHERE id = $1`,
      [c.id, endpointId],
    );
    // 同批次里跨源重复的同一条代理，也要拦住 —— 否则两个源各推一次
    // 就会在端点表里建出两行 dedupe_key 相同的记录（没有唯一约束兜底）。
    if (c.dedupe_key) existingSet.add(c.dedupe_key);
    promoted += 1;
  }

  const rest = await t.q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM candidate_endpoints
     WHERE source_id = $1 AND review_status = 'PENDING'`,
    [sourceId],
  );

  return { promoted, duplicate, remaining: rest?.n ?? 0 };
}
