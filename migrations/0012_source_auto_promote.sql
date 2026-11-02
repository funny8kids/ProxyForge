-- 自动采集流水线的开关。
--
-- 背景：免费公开代理源的体量是几千条，而晋级（candidate → endpoint）原本只有
-- 手工接口。要让"抓到的代理真的能进 Clash"这件事成立，必须自动晋级 ——
-- 但自动晋级意味着系统会自己往端点表里写数据，这是需要显式授权开关的动作。
--
-- 三条约束：
--   1. 默认关闭。不给"默认开启"这种省事但危险的默认值。
--   2. 开启时必须显式声明 authorization。公开代理列表我们不知道每个 IP 的归属，
--      系统不能替用户编一个 AUTHORIZED 出来 —— 这也是 v_subscription_eligible_endpoints
--      只放行 AUTHORIZED/RESTRICTED 的原因。
--   3. 每轮晋级有上限。一个源一次推几千条会让池重算和探测队列瞬间过载。
ALTER TABLE resource_sources
    ADD COLUMN IF NOT EXISTS auto_promote boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS auto_promote_authorization authorization_status,
    ADD COLUMN IF NOT EXISTS auto_promote_limit int NOT NULL DEFAULT 200;

-- 开了自动晋级却没声明授权 → 拒绝写入。把"忘记声明"变成建表期的错误，
-- 而不是运行时悄悄用 UNKNOWN 晋级出一批订阅里看不见的端点。
ALTER TABLE resource_sources
    DROP CONSTRAINT IF EXISTS ck_source_auto_promote_authorization;
ALTER TABLE resource_sources
    ADD CONSTRAINT ck_source_auto_promote_authorization
    CHECK (
        NOT auto_promote
        OR auto_promote_authorization IN ('AUTHORIZED', 'RESTRICTED')
    );

ALTER TABLE resource_sources
    DROP CONSTRAINT IF EXISTS ck_source_auto_promote_limit;
ALTER TABLE resource_sources
    ADD CONSTRAINT ck_source_auto_promote_limit
    CHECK (auto_promote_limit BETWEEN 1 AND 1000);

COMMENT ON COLUMN resource_sources.auto_promote IS
    '是否由采集流水线自动把候选晋级为端点。开启必须同时声明 auto_promote_authorization。';
COMMENT ON COLUMN resource_sources.auto_promote_authorization IS
    '自动晋级时写入端点的授权状态。系统不推断授权，只记录用户声明的结果。';
