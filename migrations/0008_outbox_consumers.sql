-- ─────────────────────────────────────────────────────────────
-- 0008 · Outbox 消费方、事件指标与告警
--
-- 背景：event_outbox 一直只有"标记已发布"这一个动作。事件被写进去、
-- 被标成 published，然后就没有然后了 —— 没有任何东西真的消费它。
-- 更要紧的是 attempts 达到 5 之后，那条事件会永久停在
-- `published_at IS NULL AND attempts >= 5` 这个状态里：
-- 既不会被重试，也不会出现在任何界面上。它变成了"黑洞"。
--
-- 这个迁移补三件事：
--   1. 事件有了明确的生命周期（PENDING / PUBLISHED / DEAD）与退避时间
--   2. 事件可以聚合成功耗指标（日粒度），让"最近发生了什么"可查询
--   3. 告警有独立表，能去重、能升级、能确认，而不是只存在于日志里
-- ─────────────────────────────────────────────────────────────

-- ── 1. 事件生命周期 ──
-- status 是派生列（published_at 非空即 PUBLISHED），但显式存下来
-- 让"死信"成为一个可以直接索引查询的状态，而不是一个 WHERE 组合条件。
ALTER TABLE event_outbox
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS dead_at timestamptz,
    -- 每个消费方的错误分开记：一个消费方坏了不该让整条事件重试，
    -- 也不该掩盖其它消费方是否成功
    ADD COLUMN IF NOT EXISTS consumer_state jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_outbox_status'
    ) THEN
        ALTER TABLE event_outbox ADD CONSTRAINT ck_outbox_status
            CHECK (status IN ('PENDING', 'PUBLISHED', 'DEAD'));
    END IF;
END $$;

-- 回填：已有的 published_at 记录一律是 PUBLISHED
UPDATE event_outbox SET status = 'PUBLISHED' WHERE published_at IS NOT NULL AND status = 'PENDING';

-- 拉取用的部分索引要跟着改：现在还要看退避时间
DROP INDEX IF EXISTS idx_outbox_unpublished;
CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON event_outbox (next_attempt_at, id)
    WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_outbox_dead
    ON event_outbox (dead_at DESC)
    WHERE status = 'DEAD';

COMMENT ON COLUMN event_outbox.status IS 'PENDING 待消费 / PUBLISHED 全部消费方成功 / DEAD 超过重试上限，需人工重放';
COMMENT ON COLUMN event_outbox.consumer_state IS '按消费方记录 {ok, at, error}，用于定位"是哪个消费方卡住了"';

-- ── 2. 事件指标（日粒度） ──
-- 为什么不直接对 event_outbox 做聚合：它是热表，而且分区维护会清老数据。
-- 指标需要长期保留，且要能被"今天 vs 上周"这种查询快速命中。
CREATE TABLE IF NOT EXISTS event_metrics_daily (
    day         date    NOT NULL,
    event_type  text    NOT NULL,
    count       bigint  NOT NULL DEFAULT 0,
    last_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, event_type)
);

COMMENT ON TABLE event_metrics_daily IS '由 outbox 消费方聚合；日粒度，永久保留';

-- ── 3. 告警 ──
-- key 是去重键：同一件事反复发生应该累加 count、更新 last_seen_at，
-- 而不是每 15 秒生成一条新告警把界面刷满。
CREATE TABLE IF NOT EXISTS alerts (
    id            uuid        PRIMARY KEY,
    key           text        NOT NULL,
    severity      text        NOT NULL,
    status        text        NOT NULL DEFAULT 'OPEN',
    title         text        NOT NULL,
    detail        text,
    -- 关联对象：便于从告警跳到出问题的资源
    subject_type  text,
    subject_id    text,
    count         int         NOT NULL DEFAULT 1,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz,
    resolved_by   text,
    -- 告警自愈：条件消失时由评估器自己关掉，而不是等人工点
    auto_resolved boolean     NOT NULL DEFAULT false,
    CONSTRAINT ck_alert_severity CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    CONSTRAINT ck_alert_status CHECK (status IN ('OPEN', 'ACKED', 'RESOLVED'))
);

-- 同一 key 同时只能有一条未解决的告警 —— 这是去重的核心约束，
-- 放在数据库里而不是靠应用层先查后写（并发下必然重复）
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_open_key
    ON alerts (key)
    WHERE status <> 'RESOLVED';

CREATE INDEX IF NOT EXISTS idx_alerts_open
    ON alerts (severity, last_seen_at DESC)
    WHERE status <> 'RESOLVED';

COMMENT ON TABLE alerts IS '由 outbox 消费方与周期评估器写入；同一 key 未解决时累加而不是新建';
