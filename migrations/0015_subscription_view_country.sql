-- 0015 · 订阅视图补出口国家
--
-- 订阅渲染需要一个节点属于哪个国家，才能：
--   · 在节点名里写 `{country}` 占位符（用户按地区分组时唯一可用的标识）
--   · 支持「只要日本/新加坡节点」这类过滤
--
-- 国家信息存在 `ip_assets.country_code`，通过 `proxy_endpoints.ip_asset_id` 关联。
-- 视图原来没有这两个字段，于是渲染层只能在取完数据后再回表 JOIN 一次 ——
-- 那意味着视图的"唯一取数入口"承诺被打破，两个调用方迟早各写一份 JOIN。
--
-- 改成视图直接带出来。用 LEFT JOIN 而不是 INNER：没有出口 IP 的端点
-- （从未探测成功过）仍然是合法成员，只是国家为 null，不该被视图过滤掉。

DROP VIEW IF EXISTS v_subscription_eligible_endpoints;

CREATE VIEW v_subscription_eligible_endpoints AS
SELECT
    e.id,
    e.protocol,
    e.host,
    e.port,
    e.credential_ref,
    e.origin_type,
    e.trust_tier,
    e.authorization_status,
    e.lifecycle_status,
    e.quality_score,
    e.ip_asset_id,
    i.country_code,
    i.region,
    s.p50_ms,
    s.last_success_at
FROM proxy_endpoints e
JOIN endpoint_health_state s ON s.endpoint_id = e.id
LEFT JOIN ip_assets i ON i.id = e.ip_asset_id
WHERE e.deleted_at IS NULL
  AND e.authorization_status IN ('AUTHORIZED', 'RESTRICTED')
  AND e.lifecycle_status IN ('HEALTHY', 'DEGRADED')
  AND e.trust_tier IN ('PRIVATE_PROXY', 'PUBLIC_PROXY', 'VERIFIED_PROXY');

COMMENT ON VIEW v_subscription_eligible_endpoints IS
    '订阅渲染取数视图；PUBLIC_PROXY 只能通过 allowed_tiers 含 PUBLIC_PROXY 的实验池发布。country_code 来自 ip_assets，未探测出出口 IP 时为 null。';
