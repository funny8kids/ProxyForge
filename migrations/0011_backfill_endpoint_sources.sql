-- 回填 endpoint_sources。
--
-- 背景：`endpoint_sources` 是节点 provenance 的唯一真相，
-- `proxy_endpoints.source_id` 只是"首次发现它的来源"这一个冗余字段。
-- 但早期种子只写了 source_id，没写这张关联表，于是：
--
--   来源质量评分按 endpoint_sources 聚合 → 每个来源样本数都是 0
--   → 全部落进"样本不足"分支 → 自动降权/停用在真实数据上从未生效过。
--
-- 这个 bug 不会报错、不会让界面空白，只会让一条安全护栏静默失效。
-- 所以用迁移补数据，而不是要求 db:reset —— 已经部署的库同样需要修复。
--
-- 回填的语义边界：
--   · 只知道"首次发现来源"，不知道同一节点还被哪些来源见过，
--     所以这里只能补一行。多来源归属靠后续同步自然补齐。
--   · 用端点自己的 first_seen_at / last_seen_at，不要写 now()：
--     写 now() 会让所有节点看起来是"刚刚被发现"，来源页的最近贡献时间全部失真。
INSERT INTO endpoint_sources (endpoint_id, source_id, first_seen_at, last_seen_at)
SELECT e.id, e.source_id, e.first_seen_at, e.last_seen_at
FROM proxy_endpoints e
WHERE e.source_id IS NOT NULL
  AND e.deleted_at IS NULL
ON CONFLICT (endpoint_id, source_id) DO NOTHING;
