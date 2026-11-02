import type { ProxyProtocol } from '@proxyforge/contracts';
import { exec, type TxLike } from '../../db/client.js';
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
       AND stale_at IS NULL
       AND host IS NOT NULL AND port IS NOT NULL AND protocol IS NOT NULL
     ORDER BY created_at ASC
     LIMIT $2`,
    [sourceId, limit],
  );

  if (!pending.length) {
    const rest = await t.q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM candidate_endpoints
       WHERE source_id = $1 AND review_status = 'PENDING' AND stale_at IS NULL`,
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
     WHERE source_id = $1 AND review_status = 'PENDING' AND stale_at IS NULL`,
    [sourceId],
  );

  return { promoted, duplicate, remaining: rest?.n ?? 0 };
}

/**
 * 候选过期标记。
 *
 * 解决的问题：候选池会累积到五万条量级，而每轮晋级受探测吞吐约束只能吃下
 * 几百条。达到"健康节点够用"的目标后闸门关闭，剩下的候选就一直停在 PENDING，
 * 界面上的「待晋级 51,000」看起来像系统卡住了 —— 实际上那是目标达成后的正常状态。
 *
 * 更实际的影响是它污染排序：`pendingCandidates` 被用作晋级权重，
 * 一个早就被挖空的源靠这个虚高数字能永远排在待挖列表最前面。
 *
 * 保留期 7 天是宽松的：按 400 条/轮、15 秒一轮算，一天能消化两百万条，
 * 五万条积压不到半小时就该轮完一遍。超过 7 天还没被碰过的候选，
 * 只可能是闸门一直关着 —— 那正是该标过期的情形。
 */
export async function expireStaleCandidates(days = 7): Promise<number> {
  return exec(
    `UPDATE candidate_endpoints
        SET stale_at = now()
      WHERE review_status = 'PENDING'
        AND stale_at IS NULL
        AND created_at < now() - ($1 || ' days')::interval`,
    [String(days)],
  );
}

/**
 * 删除长期过期的候选。
 *
 * 标 stale 只是让它不再计入积压，行本身还在。19 个源累计五万多行，
 * 单表几万行不算大，但它是**永久增长**的：每个源每小时同步一次、
 * 每次新增几百条，一年后就是百万级 —— 而其中 99% 永远不会被晋级。
 *
 * 保留 30 天：免费代理的 IP 生命周期常常不到一周，一个月前的候选
 * 复活过来也基本是死的。真要复活就重新同步一次，比留着历史行可靠。
 *
 * 只删 `review_status = 'PENDING'` 的：PROMOTED 的行是指向端点的溯源链，
 * DUPLICATE / REJECTED 是审核结论，都不该被清理。
 */
export async function pruneStaleCandidates(days = 30): Promise<number> {
  return exec(
    `DELETE FROM candidate_endpoints
      WHERE review_status = 'PENDING'
        AND stale_at IS NOT NULL
        AND stale_at < now() - ($1 || ' days')::interval`,
    [String(days)],
  );
}

/**
 * 复活一批过期候选。
 *
 * 只在「健康数掉回目标以下、闸门重新打开」时调用 —— 那时需要新候选补充，
 * 而全量复活五万条会让闸门立刻又被积压顶住，等于没做。
 *
 * 取最近的若干条而不是最老的：免费代理时效性极强，一周前的 IP 复活过来
 * 大概率已经换了主人，探测它纯属浪费预算。
 */
export async function reviveStaleCandidates(limit = 2000): Promise<number> {
  return exec(
    `UPDATE candidate_endpoints
        SET stale_at = NULL
      WHERE id IN (
        SELECT id FROM candidate_endpoints
        WHERE review_status = 'PENDING' AND stale_at IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $1
      )`,
    [limit],
  );
}
