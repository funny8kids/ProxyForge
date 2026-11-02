-- =============================================================================
-- 0005 — AI 调用链落地（DeepSeek / OpenAI 兼容）
--
-- 0001 里 ai_models / ai_usage_records 只够"登记"，不够"记账"：
--   · DeepSeek 的缓存命中价只有未命中的 1/20，不分列记账会把成本高估一个量级
--   · 思考模型（deepseek-flash 默认开思考）的 completion_tokens 里含 reasoning，
--     不拆出来就看不出"贵在思考还是贵在输出"
--   · 发现任务需要把 LLM 给出的候选源落库待审，而不是只留一句 result_summary
-- =============================================================================

ALTER TABLE ai_models
    ADD COLUMN IF NOT EXISTS cached_input_cost_per_1k numeric(10, 6) NOT NULL DEFAULT 0;

ALTER TABLE ai_usage_records
    ADD COLUMN IF NOT EXISTS cached_prompt_tokens int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reasoning_tokens     int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ai_usage_occurred ON ai_usage_records (occurred_at DESC);

ALTER TABLE ai_discovery_tasks
    -- LLM 给出的候选源列表：[{ url, name, formatHint, reason, confidence }]
    ADD COLUMN IF NOT EXISTS proposed_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS error_message    text,
    ADD COLUMN IF NOT EXISTS model_name       text;

-- 同一轮发现里 LLM 可能重复推荐同一个 URL，用 key 去重时靠这张表判断"是否已存在"
CREATE INDEX IF NOT EXISTS idx_sources_url ON resource_sources (url) WHERE url IS NOT NULL;
