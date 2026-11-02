-- 0017 · 订阅视图带上隧道能力
--
-- 渲染层需要 connect_ok 来把"能上 HTTPS"的节点排在前面：订阅里的顺序
-- 就是用户在 Clash 里看到的顺序，也是 fallback / url-test 分组的初始优先序。
-- 不带出来的话渲染层只能取完数据再回表 JOIN —— 那会打破"视图是唯一
-- 取数入口"的约定，两个调用方迟早各写一份。
--
-- 为什么单独一个文件而不是并进 0016：0016 在开发期被 `tsx watch` 抢跑，
-- 以"只有 ALTER + INDEX"的中间状态应用并记进了 schema_migrations。
-- 迁移只进不退，已应用的文件不再改语义 —— 视图改造单独走一个版本号。
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
    s.last_success_at,
    s.connect_ok
FROM proxy_endpoints e
JOIN endpoint_health_state s ON s.endpoint_id = e.id
LEFT JOIN ip_assets i ON i.id = e.ip_asset_id
WHERE e.deleted_at IS NULL
  AND e.authorization_status IN ('AUTHORIZED', 'RESTRICTED')
  AND e.lifecycle_status IN ('HEALTHY', 'DEGRADED')
  AND e.trust_tier IN ('PRIVATE_PROXY', 'PUBLIC_PROXY', 'VERIFIED_PROXY');

COMMENT ON VIEW v_subscription_eligible_endpoints IS
    '订阅渲染取数视图；PUBLIC_PROXY 只能通过 allowed_tiers 含 PUBLIC_PROXY 的实验池发布。country_code 来自 ip_assets，未探测出出口 IP 时为 null。connect_ok 为 null 表示尚未检测隧道能力。';
