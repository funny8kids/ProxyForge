-- ─────────────────────────────────────────────────────────────
-- 0009 · 来源同步状态
--
-- 之前同步失败**什么都不写**：syncSource 在拉取失败时直接 return 一个
-- ok:false 的响应，库里 last_synced_at 不变、没有任何错误记录。
-- 后果是：一个 URL 已经 404 的来源，界面上永远显示"从未同步"，
-- 和"刚建好还没跑过"完全无法区分；而"它每 6 小时失败一次"这件事
-- 只存在于当时那个 HTTP 响应里，过后无迹可查。
--
-- 这里补三个字段，让"上次同步的结果"成为一等状态：
--   · last_attempt_at —— 尝试时间（无论成败），用来判断调度是否真的在跑
--   · last_sync_status —— OK / FAILED / NEVER
--   · last_sync_error  —— 失败原因，界面上直接显示
-- ─────────────────────────────────────────────────────────────

ALTER TABLE resource_sources
    ADD COLUMN IF NOT EXISTS last_attempt_at  timestamptz,
    ADD COLUMN IF NOT EXISTS last_sync_status text NOT NULL DEFAULT 'NEVER',
    ADD COLUMN IF NOT EXISTS last_sync_error  text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_source_sync_status') THEN
        ALTER TABLE resource_sources ADD CONSTRAINT ck_source_sync_status
            CHECK (last_sync_status IN ('NEVER', 'OK', 'FAILED'));
    END IF;
END $$;

-- 回填：已经有 last_synced_at 的说明至少成功同步过一次
UPDATE resource_sources
SET last_sync_status = 'OK', last_attempt_at = last_synced_at
WHERE last_synced_at IS NOT NULL AND last_sync_status = 'NEVER';

-- 找出"一直在失败"的来源要用它
CREATE INDEX IF NOT EXISTS idx_sources_sync_failed
    ON resource_sources (last_attempt_at DESC)
    WHERE last_sync_status = 'FAILED';

COMMENT ON COLUMN resource_sources.last_sync_status IS '上次同步结果；FAILED 会触发告警，恢复后自动关闭';
