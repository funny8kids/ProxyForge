import { q, tx, type TxLike } from '../../db/client.js';

/**
 * 出口地理回填。
 *
 * 探针一直在拿 `exit_ip` / `exit_country`（`health_checks.exit_country` 里存着
 * 真实值，实测有 CN / US / JP / SG 这些），但这两个字段从来没有被写到端点或
 * IP 资产上。后果是一整条链路静默降级：
 *
 *   · `analytics/distribution` 永远返回 `[{ key: null, count: N }]`
 *   · 端点列表的 `countryCode` 全是 null，界面 COUNTRY 列整列是「—」
 *   · 订阅里 120 个节点全是裸 IP，用户在 Clash 里没法按地区写分流规则
 *
 * 而数据本来就在手里 —— 缺的只是这一步。所以它**不增加任何网络开销**：
 * 不需要 GeoIP 库，不需要额外查询，只把已经拿到的国家码落到该落的地方。
 *
 * 为什么按 `ip` 建资产而不是按端点：同一个出口 IP 会被成百上千个免费代理共用
 * （同一台机器开多个端口，或者整个网段属于同一家 IDC）。按 IP 去重能让国家、
 * ASN、ISP 这些「属于 IP 的属性」只存一份，也让 distribution 的口径从
 * 「端点分布」自然变成「出口分布」—— 后者才是用户真正关心的（我要几个日本节点）。
 *
 * 为什么国家码只增不减：`COALESCE(EXCLUDED, 现有值)`。免费代理的出口国家不会
 * 变，但探测偶尔会因为走了不同的上游链路而拿到 null（ip-api 限流时返回空）。
 * 让一次失败把已有结论抹掉，等于每轮探测都在丢信息。
 */
export async function linkExitGeography(
  t: TxLike,
  endpointId: string,
  exitIp: string | null,
  exitCountry: string | null,
): Promise<void> {
  if (!exitIp) return;

  // inet 类型必须显式带版本号，否则 PGlite 会按字符串推断失败
  const ipVersion = exitIp.includes(':') ? 6 : 4;

  const asset = await t.q1<{ id: string }>(
    `INSERT INTO ip_assets (ip, ip_version, country_code, first_seen_at, last_seen_at, last_verified_at)
     VALUES ($1::inet, $2, $3, now(), now(), now())
     ON CONFLICT (ip) DO UPDATE
        SET country_code     = COALESCE(EXCLUDED.country_code, ip_assets.country_code),
            last_seen_at     = now(),
            last_verified_at = CASE WHEN EXCLUDED.country_code IS NOT NULL THEN now()
                                    ELSE ip_assets.last_verified_at END,
            updated_at       = now(),
            version          = ip_assets.version + 1
     RETURNING id`,
    [exitIp, ipVersion, exitCountry],
  );
  if (!asset?.id) return;

  // `IS DISTINCT FROM` 避免每轮探测都对同一行做一次无意义写入 ——
  // 5000 个端点 × 每 15 分钟一轮，会白白产生大量死元组。
  await t.exec(
    `UPDATE proxy_endpoints SET ip_asset_id = $2
      WHERE id = $1 AND ip_asset_id IS DISTINCT FROM $2`,
    [endpointId, asset.id],
  );
}

/**
 * 存量回填。
 *
 * 新探测会自然补上地理信息，但库里已经有几千个端点探过、`health_checks` 里
 * 躺着真实的 exit_ip/exit_country，只是 `ip_asset_id` 还没接上。等它们按
 * 15–360 分钟一轮慢慢轮到，界面要空一整天。
 *
 * 所以启动时扫一次：**只处理 `ip_asset_id IS NULL` 的端点**，跑完之后
 * 这个集合就是空的，后续启动只是一条走索引的空查询，不会变成常态开销。
 *
 * 全部放在一个事务里而不是逐条 tx：5000 个端点逐条提交会产生 5000 次
 * WAL 刷盘，在 PGlite 上要几十秒；一个事务里循环只有一次提交。
 */
export async function backfillExitGeography(limit = 8000): Promise<number> {
  const rows = await q<{ endpoint_id: string; exit_ip: string; exit_country: string | null }>(
    `SELECT DISTINCT ON (hc.endpoint_id)
            hc.endpoint_id, hc.exit_ip, hc.exit_country
       FROM health_checks hc
       JOIN proxy_endpoints e ON e.id = hc.endpoint_id AND e.deleted_at IS NULL
      WHERE hc.success = true
        AND hc.exit_ip IS NOT NULL
        AND e.ip_asset_id IS NULL
      ORDER BY hc.endpoint_id, hc.checked_at DESC
      LIMIT $1`,
    [limit],
  );
  if (!rows.length) return 0;

  return tx(async (t) => {
    let n = 0;
    for (const r of rows) {
      await linkExitGeography(t, r.endpoint_id, r.exit_ip, r.exit_country);
      n += 1;
    }
    return n;
  });
}
