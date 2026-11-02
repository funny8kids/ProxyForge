-- =============================================================================
-- 0006 — 网关运行时
--
-- 0001 的 gateway_instances 只描述"实例应该是什么样"，没有任何字段记录
-- "进程现在是什么样"。于是界面上 status 永远显示编译结果（APPLIED），
-- 看起来一切正常，实际端口一个都没在监听。
--
-- 这里把"编译产物"和"运行时状态"分开：
--   · gateway_configs.runtime_spec   —— 给引擎消费的结构化规格（不含凭据）
--   · gateway_instances.runtime_*    —— 进程实际状态，由 supervisor 写入
-- =============================================================================

ALTER TABLE gateway_configs
    -- 渲染出来给人看的是 rendered_config（YAML），给引擎看的是这份结构化规格。
    -- 两者同源：都由同一次编译产生，避免"配置展示的"和"实际运行的"不一致。
    ADD COLUMN IF NOT EXISTS runtime_spec jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE gateway_instances
    -- 引擎类型：builtin 进程内转发 / gost 外部二进制
    ADD COLUMN IF NOT EXISTS engine_kind      text NOT NULL DEFAULT 'builtin',
    ADD COLUMN IF NOT EXISTS runtime_pid      int,
    ADD COLUMN IF NOT EXISTS runtime_state    text NOT NULL DEFAULT 'STOPPED',
    ADD COLUMN IF NOT EXISTS runtime_error    text,
    ADD COLUMN IF NOT EXISTS runtime_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS runtime_reload_at  timestamptz,
    -- 实际在监听的端口：[{ policyKey, port, members }]
    ADD COLUMN IF NOT EXISTS listeners jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE gateway_instances
    ADD CONSTRAINT ck_gateway_runtime_state
    CHECK (runtime_state IN ('STOPPED', 'STARTING', 'RUNNING', 'DEGRADED', 'FAILED'));

ALTER TABLE gateway_instances
    ADD CONSTRAINT ck_gateway_engine_kind
    CHECK (engine_kind IN ('builtin', 'gost'));
