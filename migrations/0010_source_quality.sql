-- ─────────────────────────────────────────────────────────────
-- 0010 · 来源质量评分与自动降权
--
-- 问题：一个来源"好不好"此前完全靠人记。公开代理列表的失效率差异极大 ——
-- 同一批导入的 4000 个节点里，有的源能留下 60%，有的连 2% 都不到。
-- 没有量化，就只能等池子里出现大量坏节点之后再去猜是哪个源。
--
-- 这里给来源加上可计算的质量分，并允许在证据充分时自动降权/停用。
--
-- 两条刻意的克制：
--   1. **AUTHORIZED 的来源永不自动停用**。授权是人做的判断，
--      质量差是另一个维度；系统可以建议，但不能替人撤销授权决定。
--   2. **样本不足时不动**。8 个节点算不出质量，这时候调分只是噪音。
-- ─────────────────────────────────────────────────────────────

ALTER TABLE resource_sources
    -- 0–100，NULL 表示"还没算过"
    ADD COLUMN IF NOT EXISTS quality_score       numeric(5,2),
    -- 参与计算的端点数：分数必须和样本量一起看，否则一个 1/1 的源会和 300/500 的源同分
    ADD COLUMN IF NOT EXISTS quality_sample_size int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS quality_computed_at timestamptz,
    -- 连续低分次数。单次低分可能只是一批节点同时失效，连续两次才降权
    ADD COLUMN IF NOT EXISTS quality_low_streak  int NOT NULL DEFAULT 0,
    -- 自动降权的痕迹：停用了要说清是谁停的、为什么
    ADD COLUMN IF NOT EXISTS auto_disabled_at     timestamptz,
    ADD COLUMN IF NOT EXISTS auto_disable_reason  text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_source_quality_range') THEN
        ALTER TABLE resource_sources ADD CONSTRAINT ck_source_quality_range
            CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 100));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sources_quality
    ON resource_sources (quality_score NULLS LAST)
    WHERE enabled = true;

COMMENT ON COLUMN resource_sources.quality_score IS '按已导入端点的存活率与平均质量加权；样本不足时保持上一次的值';
COMMENT ON COLUMN resource_sources.auto_disabled_at IS '被系统自动停用的时间；AUTHORIZED 来源不会走到这里';
