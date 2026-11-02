import { q, tx } from '../../db/client.js';
import { qualityScore } from './probe.js';

/**
 * 按当前算法重算全库 `quality_score`。
 *
 * ## 为什么需要这个
 *
 * `quality_score` 是**写时计算**的：每次探测结束时用当时 24 小时窗口的
 * 统计算一次存进去。所以改了 `qualityScore` 的公式之后，库里的存量值
 * 仍然是旧公式的结果 —— 而 HEALTHY 的复探周期是 360 分钟，靠自然复探
 * 把全库刷一遍要一整天，这期间池子仍按被污染的旧分数选人。
 *
 * 实测过的具体后果：公式从裸成功率改成平滑成功率之前，池子里混进一批
 * 只探过一次、却因为"1/1 = 100%"拿到 79–87 分的新节点，把稳定的老节点
 * 挤出了前 300；导出订阅后独立抽查 12 个，只有 1 个能连 HTTPS。
 *
 * ## 为什么在 TS 里算而不是写成 SQL
 *
 * 公式只能有一份。如果这里再写一段等价的 SQL 表达式，两处迟早会分叉 ——
 * 那正是本项目在"探测到期判定"上踩过的坑（界面和调度器各写一份，数字
 * 对不上却不报错）。所以这里只让 SQL 负责聚合，打分仍然调 `qualityScore`。
 */
export async function rescoreQuality(limit = 20000): Promise<number> {
  const rows = await q<{
    endpoint_id: string;
    total: string;
    succ: string;
    p50: number | null;
    jitter: number | null;
  }>(
    `SELECT endpoint_id,
            count(*)::text AS total,
            count(*) FILTER (WHERE success)::text AS succ,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)
               FILTER (WHERE success))::int AS p50,
            (stddev_samp(total_ms) FILTER (WHERE success))::int AS jitter
       FROM health_checks
      WHERE checked_at >= now() - interval '24 hours'
      GROUP BY 1
      LIMIT $1`,
    [limit],
  );
  if (rows.length === 0) return 0;

  const scored = rows.map((r) => ({
    id: r.endpoint_id,
    score: qualityScore({
      successes: Number(r.succ),
      total: Number(r.total),
      p50Ms: r.p50 === null ? null : Number(r.p50),
      jitterMs: r.jitter === null ? null : Number(r.jitter),
    }),
  }));

  // 分批写：PGlite 是单写者，一次几千行 UPDATE 会把 API 拖到无响应。
  return tx(async (t) => {
    let n = 0;
    for (let i = 0; i < scored.length; i += 200) {
      const batch = scored.slice(i, i + 200);
      const ids = batch.map((b) => b.id);
      const scores = batch.map((b) => b.score);
      await t.exec(
        `UPDATE proxy_endpoints e
            SET quality_score = v.score
           FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::numeric[]) AS score) v
          WHERE e.id = v.id
            AND e.quality_score IS DISTINCT FROM v.score`,
        [ids, scores],
      );
      n += batch.length;
    }
    return n;
  });
}
