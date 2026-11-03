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
  /** 被判死之后又被源站重新列出、因而重获探测机会的端点数 */
  revived: number;
  remaining: number;
}

/**
 * 被判死的端点，隔多久才允许因「源站重新列出」而复活一次。
 *
 * 这个间隔不是调优参数，是**防抖**：源站列表里常有一批早已失效的地址被
 * 反复列出（列表本身没更新）。没有它，一个真死的地址会被「重新列出 →
 * 复活 → 探测失败 → 判死」无限循环，每轮烧一次探测预算。
 *
 * 2 小时的依据：免费代理的存活期是几十分钟量级，两小时足够让「上一轮探测
 * 恰好在它掉线时命中」这种偶发误判翻篇；同时又比 UNAVAILABLE 的 120 分钟
 * 复探周期短，不至于比常规复探还慢。
 */
const REVIVE_AFTER_HOURS = Number(process.env.PF_REVIVE_REJECTED_HOURS ?? 2);

export async function promoteCandidates(
  t: TxLike,
  sourceId: string,
  authorization: PromoteAuthorization,
  limit: number,
): Promise<PromoteResult> {
  const pending = await t.q<{
    id: string; protocol: ProxyProtocol; host: string; port: number; dedupe_key: string | null;
  }>(
    /**
     * **最新优先，不是最早优先。**
     *
     * 原来是 `ORDER BY created_at ASC`（FIFO），没有任何注释说明为什么 ——
     * 它只是默认写法。但对免费代理这是反的：候选池的周转时间远长于 IP 的存活期。
     *
     * 实测（2026-11，9,442 条待晋级）：中位年龄 **152 分钟**，最老 520 分钟，
     * 而免费代理 IP 的存活期是几十分钟量级。FIFO 意味着**现在被送进探测器的
     * 候选，平均已经躺了 2.5 小时** —— 它多半早就不是代理了。
     *
     * 同一份数据里按候选年龄分档看「晋级后曾探测成功」的比例：
     *
     *   | 候选年龄    | 端点数 | 成功率 |
     *   |------------|-------|-------|
     *   | <30 分钟    | 2,098 |  9.3% |
     *   | 30–60 分钟  |   762 |  4.6% |
     *   | 1–2 小时    | 5,153 |  5.4% |
     *   | >2 小时     |18,159 |  3.7% |
     *
     * 新鲜候选的产出率是 2.5 倍，而近 3 小时晋级的端点里有 71% 来自最差的
     * 那一档（>2 小时）。也就是说探测预算的绝大部分花在了已知最不可能活的
     * 地址上 —— 这不是"源质量差"，是**取数顺序错**。
     *
     * 改成 DESC 之后，刚同步进来的候选在下一个周期（15 秒）就能被晋级并立刻
     * 首探（`hs.last_check_at IS NULL` 立即到期），从"抓到"到"探到"约 1 分钟。
     * 老候选自然不再被取到，由 `expireStaleCandidates` 按保留期清出队列。
     */
    `SELECT id, protocol, host, port, dedupe_key
     FROM candidate_endpoints
     WHERE source_id = $1 AND review_status = 'PENDING'
       AND stale_at IS NULL
       AND host IS NOT NULL AND port IS NOT NULL AND protocol IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $2`,
    [sourceId, limit],
  );

  if (!pending.length) {
    const rest = await t.q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM candidate_endpoints
       WHERE source_id = $1 AND review_status = 'PENDING' AND stale_at IS NULL`,
      [sourceId],
    );
    return { promoted: 0, duplicate: 0, revived: 0, remaining: rest?.n ?? 0 };
  }

  /**
   * 已存在的端点先查一遍，避免逐条 SELECT。
   *
   * 除了 dedupe_key，还要取**生命周期状态和上次探测时间** —— 因为「已存在」
   * 不等于「还该被忽略」。原来只查 dedupe_key 是否存在，于是被判死的端点
   * 会永久锁死自己 host:port 的重测资格：源站明明又重新把它列出来了
   * （这是「它现在是活的」的新证据），我们却拿几小时前的结论把它丢掉。
   *
   * 实测（2026-11）：87,897 条被判 DUPLICATE 的候选里，**77,037 条的对应端点
   * 是 REJECTED**，那些端点上一次被探测的中位时间是 **13 小时前**。
   * 而 REJECTED 在调度表里是 null 间隔，等于永不重测 —— 这条路径一封死，
   * 就算源站把同一个地址重新列一百次也不会有任何反应。
   */
  const keys = pending.map((c) => c.dedupe_key).filter((k): k is string => !!k);
  const existing = keys.length
    ? await t.q<{
        dedupe_key: string; id: string; lifecycle_status: string; stale: boolean;
      }>(
        `SELECT e.dedupe_key, e.id, e.lifecycle_status::text AS lifecycle_status,
                COALESCE(hs.last_check_at < now() - ($2 || ' hours')::interval, true) AS stale
         FROM proxy_endpoints e
         LEFT JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
         WHERE e.dedupe_key = ANY($1::text[]) AND e.deleted_at IS NULL`,
        [keys, String(REVIVE_AFTER_HOURS)],
      )
    : [];
  const existingSet = new Map(existing.map((e) => [e.dedupe_key, e]));

  let promoted = 0;
  let duplicate = 0;
  let revived = 0;

  for (const c of pending) {
    const dup = c.dedupe_key ? existingSet.get(c.dedupe_key) : undefined;
    if (dup) {
      /**
       * 判死的端点被源站重新列出 —— 复活一次，让它重新排队探测。
       *
       * 只复活 REJECTED：UNAVAILABLE 本来就在 120 分钟复探周期里，
       * 再插一次队只会打乱它自己的节奏，收益是零。
       */
      if (dup.lifecycle_status === 'REJECTED' && dup.stale) {
        await t.exec(
          `UPDATE proxy_endpoints SET lifecycle_status = 'PENDING_VERIFICATION'
           WHERE id = $1 AND lifecycle_status = 'REJECTED'`,
          [dup.id],
        );
        // 溯源要补：质量评分按 endpoint_sources 聚合，漏了这一步
        // 新列出的那个源就永远拿不到这份「产出」的credit。
        await t.exec(
          `INSERT INTO endpoint_sources (endpoint_id, source_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [dup.id, sourceId],
        );
        // 复活后它已不再是「已知死亡」，同批次里后续的同 key 候选不该再触发一次。
        dup.lifecycle_status = 'PENDING_VERIFICATION';
        revived += 1;
      }

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
    if (c.dedupe_key) {
      existingSet.set(c.dedupe_key, {
        dedupe_key: c.dedupe_key, id: endpointId,
        lifecycle_status: 'PENDING_VERIFICATION', stale: false,
      });
    }
    promoted += 1;
  }

  const rest = await t.q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM candidate_endpoints
     WHERE source_id = $1 AND review_status = 'PENDING' AND stale_at IS NULL`,
    [sourceId],
  );

  return { promoted, duplicate, revived, remaining: rest?.n ?? 0 };
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
 * ## 保留期从 7 天改成 6 小时
 *
 * 7 天这个值是按「一天能消化两百万条」的吞吐算的，算的是**排队时间**，
 * 没算**值不值得探**。实测按候选年龄看晋级后的探测成功率：
 * >2 小时的候选只有 3.7%，<30 分钟的有 9.3%。而待晋级队列的中位年龄是
 * 152 分钟 —— 也就是说队列里绝大多数行早就没有开采价值了，留着它们
 * 只会让 `pendingCandidates` 这个权重长期虚高。
 *
 * 6 小时仍然很宽松：它是同步周期（15 分钟）的 24 倍，足以容忍连续几次同步失败。
 * 真正的过期判定不该靠这个数字，而该靠晋级顺序（最新优先，见 promoteCandidates）——
 * 保留期只负责把永远不会被取到的行清出队列。
 */
const CANDIDATE_STALE_HOURS = Number(process.env.PF_CANDIDATE_STALE_HOURS ?? 6);

export async function expireStaleCandidates(hours = CANDIDATE_STALE_HOURS): Promise<number> {
  return exec(
    `UPDATE candidate_endpoints
        SET stale_at = now()
      WHERE review_status = 'PENDING'
        AND stale_at IS NULL
        AND created_at < now() - ($1 || ' hours')::interval`,
    [String(hours)],
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
