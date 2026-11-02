-- 0014 · 候选过期标记
--
-- 背景：自动采集跑起来之后，候选池会累积到五万条量级，而每轮晋级受探测
-- 吞吐约束只能吃下几百条。达到"健康节点已够用"的目标后闸门关闭，剩下的
-- 候选就一直停在 PENDING —— 它们既不会被晋级，也不该被算作"待处理积压"。
--
-- 界面上一个恒定的「51,000 条待晋级」是有害的：它看起来像系统卡住了，
-- 而实际上系统处于正常的目标达成状态。更糟的是，`pendingCandidates`
-- 被用作晋级排序的权重，这个虚高的数字会让一个早就被挖空的源
-- 永远排在待挖列表的最前面。
--
-- 为什么用独立列而不是新增 review_status 枚举值：
--   · PG 的 ALTER TYPE ADD VALUE 在事务块里有额外限制，而迁移是包在事务里的
--   · STALE 和 PENDING 的区别只是"时间上还值不值得挖"，不是审核结论。
--     把它塞进审核状态会让"已拒绝 / 重复 / 已过期"混成一个维度，
--     统计时还得再拆开。
--   · 独立列可逆：清空 stale_at 就能让候选回到活跃队列，
--     而枚举值一旦写入就改不回去了。

ALTER TABLE candidate_endpoints
    ADD COLUMN IF NOT EXISTS stale_at timestamptz;

COMMENT ON COLUMN candidate_endpoints.stale_at IS
    '过期标记。非空表示该候选超过保留期未被晋级，不计入待处理积压、不参与晋级排序。清空即可重新激活。';

-- 部分索引：活跃候选的查询（晋级、积压统计）都带 stale_at IS NULL，
-- 而全表绝大多数行将来都是过期的，索引只覆盖活跃那部分才有意义。
CREATE INDEX IF NOT EXISTS idx_candidates_active
    ON candidate_endpoints (source_id, created_at)
    WHERE stale_at IS NULL AND review_status = 'PENDING';
