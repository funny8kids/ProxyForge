-- =============================================================================
-- ProxyForge · PostgreSQL 16 · Schema v1.0
-- 配套文档：docs/database/01-data-model.md
-- 执行方式：psql -v ON_ERROR_STOP=1 -f schema-v1.sql
-- 约定：
--   1) 所有时间列使用 timestamptz，应用层统一 UTC
--   2) 业务主键 uuid（应用侧生成 v7），高写入日志表 bigserial
--   3) 枚举用原生 ENUM，只增不删；新增值请单独迁移文件
--   4) 破坏性变更必须走"扩展-双写-收缩"三步
-- =============================================================================

BEGIN;
-- 说明：gen_random_uuid() 自 PostgreSQL 13 起为内置函数，无需 pgcrypto 扩展。

-- =============================================================================
-- 0. 枚举类型
-- =============================================================================

CREATE TYPE ip_type AS ENUM ('STATIC', 'DYNAMIC', 'UNKNOWN');

CREATE TYPE network_type AS ENUM ('RESIDENTIAL', 'DATACENTER', 'MOBILE', 'UNKNOWN');

CREATE TYPE confidence AS ENUM ('DECLARED', 'OBSERVED', 'INFERRED', 'UNKNOWN');

CREATE TYPE proxy_protocol AS ENUM ('HTTP', 'HTTPS_CONNECT', 'SOCKS4', 'SOCKS5');

CREATE TYPE origin_type AS ENUM ('OWNED', 'FREE_PROVIDER', 'PUBLIC_PROXY', 'PAID_PROVIDER');

CREATE TYPE authorization_status AS ENUM ('AUTHORIZED', 'RESTRICTED', 'UNKNOWN', 'REVOKED');

-- 资源信任分级：决定"能用在什么场景"，与 authorization_status（有没有授权）正交
CREATE TYPE trust_tier AS ENUM ('PRIVATE_PROXY', 'PUBLIC_PROXY', 'VERIFIED_PROXY');

CREATE TYPE lifecycle_status AS ENUM (
    'DISCOVERED', 'PENDING_VERIFICATION', 'VERIFIED', 'HEALTHY',
    'DEGRADED', 'UNAVAILABLE', 'QUARANTINED', 'REJECTED', 'REVOKED'
);

CREATE TYPE node_kind AS ENUM ('VPS', 'ROUTER', 'CONTAINER', 'MANAGED_SERVICE', 'UNKNOWN');

CREATE TYPE node_status AS ENUM ('ACTIVE', 'INACTIVE', 'UNREACHABLE', 'DECOMMISSIONED');

CREATE TYPE source_type AS ENUM ('GITHUB_REPO', 'WEB_PAGE', 'API', 'CSV_FEED', 'MIHOMO_SUB', 'MANUAL');

CREATE TYPE job_status AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TYPE review_status AS ENUM ('PENDING', 'PROMOTED', 'REJECTED', 'DUPLICATE');

CREATE TYPE member_source AS ENUM ('AUTO', 'MANUAL');

CREATE TYPE policy_strategy AS ENUM ('DIRECT', 'FIXED', 'FASTEST', 'WEIGHTED', 'STICKY', 'FAILOVER', 'REGION');

CREATE TYPE gateway_config_status AS ENUM ('DRAFT', 'COMPILED', 'APPLIED', 'FAILED', 'SUPERSEDED', 'ROLLED_BACK');

CREATE TYPE check_failure_reason AS ENUM (
    'NONE', 'DNS_FAILURE', 'TCP_REFUSED', 'TCP_TIMEOUT', 'TLS_ERROR', 'PROTOCOL_ERROR',
    'AUTH_FAILED', 'EXIT_MISMATCH', 'TIMEOUT', 'UNSTABLE', 'FLAKY', 'INTERNAL'
);

CREATE TYPE ai_provider_type AS ENUM ('OPENAI_COMPATIBLE', 'ANTHROPIC', 'OLLAMA', 'CUSTOM');

CREATE TYPE ai_task_type AS ENUM ('DISCOVERY', 'ANALYZER', 'CLASSIFIER', 'EVALUATOR', 'ASSISTANT');

CREATE TYPE secret_kind AS ENUM ('AI_API_KEY', 'PROXY_CREDENTIAL', 'PROVIDER_TOKEN', 'GATEWAY_TOKEN', 'SIGNING_KEY');

CREATE TYPE user_role AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');

CREATE TYPE actor_type AS ENUM ('USER', 'API_KEY', 'SYSTEM', 'SCHEDULER');

-- =============================================================================
-- 1. 身份、密钥、审计、基础设施
-- =============================================================================

CREATE TABLE proxy_users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username        text        NOT NULL,
    display_name    text,
    password_hash   text        NOT NULL,           -- Argon2id
    role            user_role   NOT NULL DEFAULT 'VIEWER',
    enabled         boolean     NOT NULL DEFAULT true,
    last_login_at   timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    version         bigint      NOT NULL DEFAULT 1,
    CONSTRAINT ck_username_len CHECK (length(username) BETWEEN 3 AND 64)
);
CREATE UNIQUE INDEX uq_proxy_users_username ON proxy_users (lower(username));

CREATE TABLE api_keys (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES proxy_users (id) ON DELETE CASCADE,
    name         text        NOT NULL,
    key_prefix   text        NOT NULL,               -- 前 8 位，用于界面展示与检索
    key_hash     text        NOT NULL,               -- sha256(完整 key)
    scopes       text[]      NOT NULL DEFAULT '{}',  -- resource:read / pool:write / gateway:consume ...
    expires_at   timestamptz,
    last_used_at timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_api_keys_hash ON api_keys (key_hash);
CREATE INDEX idx_api_keys_user ON api_keys (user_id) WHERE revoked_at IS NULL;

CREATE TABLE secrets (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ref              text        NOT NULL,           -- secret://ai/deepseek-main
    kind             secret_kind NOT NULL,
    ciphertext       bytea       NOT NULL,           -- AES-256-GCM
    nonce            bytea       NOT NULL,
    key_version      int         NOT NULL DEFAULT 1, -- 支持主密钥轮换
    description      text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    rotated_at       timestamptz,
    last_accessed_at timestamptz
);
CREATE UNIQUE INDEX uq_secrets_ref ON secrets (ref);
COMMENT ON TABLE secrets IS '密钥库：只存密文。业务表通过 credential_ref / api_key_ref 引用，禁止明文落库。';

CREATE TABLE config_versions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    config_type text        NOT NULL,               -- POOL / POLICY / AI_PROVIDER / GATEWAY
    config_key  text        NOT NULL,
    version     int         NOT NULL,
    content     jsonb       NOT NULL,
    changed_by  uuid        REFERENCES proxy_users (id),
    change_note text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_config_versions UNIQUE (config_type, config_key, version)
);

CREATE TABLE audit_events (
    id            bigserial,
    occurred_at   timestamptz  NOT NULL DEFAULT now(),
    actor_type    actor_type   NOT NULL DEFAULT 'SYSTEM',
    actor_id      text,
    action        text         NOT NULL,             -- endpoint.quarantine / policy.update ...
    resource_type text,
    resource_id   text,
    source_ip     inet,
    request_id    text,
    before_state  jsonb,
    after_state   jsonb,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
COMMENT ON TABLE audit_events IS '审计事件：append-only。生产环境需 REVOKE UPDATE/DELETE 给应用角色。';

CREATE INDEX idx_audit_resource ON audit_events (resource_type, resource_id, occurred_at DESC);

CREATE TABLE idempotency_keys (
    scope        text        NOT NULL,
    key          text        NOT NULL,
    request_hash text        NOT NULL,
    status_code  int,
    response     jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    PRIMARY KEY (scope, key)
);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys (expires_at);

-- =============================================================================
-- 2. 供应商与来源（端点依赖来源，故先建）
-- =============================================================================

CREATE TABLE providers (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key        text        NOT NULL,
    name       text        NOT NULL,
    type       text        NOT NULL DEFAULT 'SERVICE',  -- SERVICE / API / MARKETPLACE
    website    text,
    notes      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_providers_key UNIQUE (key)
);

CREATE TABLE provider_accounts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id    uuid        NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
    label          text        NOT NULL,
    credential_ref text        REFERENCES secrets (ref),
    quota_limit    numeric(14, 2),
    quota_used     numeric(14, 2) NOT NULL DEFAULT 0,
    quota_unit     text        NOT NULL DEFAULT 'REQUESTS',
    quota_reset_at timestamptz,
    status         text        NOT NULL DEFAULT 'ACTIVE',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    version        bigint      NOT NULL DEFAULT 1,
    CONSTRAINT uq_provider_account UNIQUE (provider_id, label)
);

CREATE TABLE resource_sources (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key                   text                  NOT NULL,
    name                  text                  NOT NULL,
    type                  source_type           NOT NULL,
    url                   text,
    format_hint           text,                   -- csv / json / text / mihomo
    parser                text,                   -- 指定解析器，空则自动探测
    authorization_status  authorization_status  NOT NULL DEFAULT 'UNKNOWN',
    trust_level           smallint              NOT NULL DEFAULT 50,
    enabled               boolean               NOT NULL DEFAULT true,
    sync_interval_seconds int                   NOT NULL DEFAULT 3600,
    last_synced_at        timestamptz,
    last_snapshot_id      uuid,                   -- 循环引用，FK 在下方 ALTER 添加
    config                jsonb                 NOT NULL DEFAULT '{}'::jsonb,
    notes                 text,
    created_at            timestamptz           NOT NULL DEFAULT now(),
    updated_at            timestamptz           NOT NULL DEFAULT now(),
    version               bigint                NOT NULL DEFAULT 1,
    CONSTRAINT uq_sources_key UNIQUE (key),
    CONSTRAINT ck_source_trust CHECK (trust_level BETWEEN 0 AND 100),
    CONSTRAINT ck_source_url CHECK (type = 'MANUAL' OR url IS NOT NULL),
    CONSTRAINT ck_source_interval CHECK (sync_interval_seconds >= 60)
);

CREATE TABLE source_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       uuid        NOT NULL REFERENCES resource_sources (id) ON DELETE CASCADE,
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    http_status     int,
    content_hash    text        NOT NULL,
    size_bytes      bigint,
    storage_ref     text,                          -- 正文存放位置（卷/对象存储）
    parse_status    job_status  NOT NULL DEFAULT 'PENDING',
    parser          text,
    candidate_count int         NOT NULL DEFAULT 0,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_snapshot_hash UNIQUE (source_id, content_hash)
);
CREATE INDEX idx_snapshots_source_time ON source_snapshots (source_id, fetched_at DESC);

ALTER TABLE resource_sources
    ADD CONSTRAINT fk_sources_last_snapshot
    FOREIGN KEY (last_snapshot_id) REFERENCES source_snapshots (id) ON DELETE SET NULL;

CREATE TABLE import_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       uuid        REFERENCES resource_sources (id) ON DELETE SET NULL,
    mode            text        NOT NULL,
    status          job_status  NOT NULL DEFAULT 'PENDING',
    total           int         NOT NULL DEFAULT 0,
    imported        int         NOT NULL DEFAULT 0,
    duplicated      int         NOT NULL DEFAULT 0,
    skipped         int         NOT NULL DEFAULT 0,
    failed          int         NOT NULL DEFAULT 0,
    error_summary   text,
    input_ref       text,
    created_by      uuid        REFERENCES proxy_users (id),
    priority        int         NOT NULL DEFAULT 0,
    run_after       timestamptz NOT NULL DEFAULT now(),
    lease_owner     text,
    lease_expires_at timestamptz,
    attempts        int         NOT NULL DEFAULT 0,
    max_attempts    int         NOT NULL DEFAULT 3,
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_import_mode CHECK (mode IN ('FILE', 'URL', 'TEXT', 'API', 'SUBSCRIPTION')),
    CONSTRAINT ck_import_counts CHECK (
        imported >= 0 AND duplicated >= 0 AND skipped >= 0 AND failed >= 0
    )
);
CREATE INDEX idx_import_jobs_pending ON import_jobs (priority DESC, run_after)
    WHERE status = 'PENDING';
CREATE INDEX idx_import_jobs_source ON import_jobs (source_id, created_at DESC);

CREATE TABLE import_job_errors (
    id         bigserial PRIMARY KEY,
    job_id     uuid        NOT NULL REFERENCES import_jobs (id) ON DELETE CASCADE,
    line_no    int,
    raw_value  text,
    reason     text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 3. 资源资产
-- =============================================================================

CREATE TABLE ip_assets (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ip                  inet            NOT NULL,
    ip_version          smallint        NOT NULL,
    ip_type             ip_type         NOT NULL DEFAULT 'UNKNOWN',
    ip_type_confidence  confidence      NOT NULL DEFAULT 'UNKNOWN',
    network_type        network_type    NOT NULL DEFAULT 'UNKNOWN',
    network_type_inferred boolean       NOT NULL DEFAULT false,
    asn                 integer,
    as_org              text,
    country_code        char(2),
    region              text,
    city                text,
    isp                 text,
    first_seen_at       timestamptz     NOT NULL DEFAULT now(),
    last_seen_at        timestamptz     NOT NULL DEFAULT now(),
    last_verified_at    timestamptz,
    tags                text[]          NOT NULL DEFAULT '{}',
    notes               text,
    created_at          timestamptz     NOT NULL DEFAULT now(),
    updated_at          timestamptz     NOT NULL DEFAULT now(),
    version             bigint          NOT NULL DEFAULT 1,
    CONSTRAINT uq_ip_assets_ip UNIQUE (ip),
    CONSTRAINT ck_ip_version CHECK (ip_version IN (4, 6))
);
CREATE INDEX idx_ip_assets_type ON ip_assets (ip_type, network_type);

CREATE TABLE proxy_nodes (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name               text        NOT NULL,
    kind               node_kind   NOT NULL DEFAULT 'UNKNOWN',
    status             node_status NOT NULL DEFAULT 'ACTIVE',
    provider_account_id uuid       REFERENCES provider_accounts (id) ON DELETE SET NULL,
    ip_asset_id        uuid        REFERENCES ip_assets (id) ON DELETE SET NULL,
    hostname           text,
    agent_id           text,
    control_channel    text,                        -- ssh / agent / api
    region             text,
    last_heartbeat_at  timestamptz,
    metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    version            bigint      NOT NULL DEFAULT 1,
    CONSTRAINT uq_nodes_name UNIQUE (name)
);
CREATE INDEX idx_nodes_status ON proxy_nodes (status);

CREATE TABLE proxy_endpoints (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id              uuid                  REFERENCES proxy_nodes (id) ON DELETE SET NULL,
    ip_asset_id          uuid                  REFERENCES ip_assets (id) ON DELETE SET NULL,
    source_id            uuid                  REFERENCES resource_sources (id) ON DELETE SET NULL,
    protocol             proxy_protocol        NOT NULL,
    host                 text                  NOT NULL,
    port                 int                   NOT NULL,
    credential_ref       text                  REFERENCES secrets (ref) ON DELETE SET NULL,
    origin_type          origin_type           NOT NULL,
    authorization_status authorization_status  NOT NULL DEFAULT 'UNKNOWN',
    trust_tier           trust_tier            NOT NULL DEFAULT 'PUBLIC_PROXY',
    explicit_gateway_grant boolean             NOT NULL DEFAULT false,
    lifecycle_status     lifecycle_status      NOT NULL DEFAULT 'DISCOVERED',
    quality_score        numeric(5, 2)         NOT NULL DEFAULT 0,
    display_name         text,
    expected_exit_ip     inet,
    expected_country     char(2),
    dedupe_key           text                  NOT NULL,
    tags                 text[]                NOT NULL DEFAULT '{}',
    labels               jsonb                 NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at        timestamptz           NOT NULL DEFAULT now(),
    last_seen_at         timestamptz           NOT NULL DEFAULT now(),
    last_verified_at     timestamptz,
    deleted_at           timestamptz,
    created_at           timestamptz           NOT NULL DEFAULT now(),
    updated_at           timestamptz           NOT NULL DEFAULT now(),
    version              bigint                NOT NULL DEFAULT 1,
    CONSTRAINT uq_endpoints_dedupe UNIQUE (dedupe_key),
    CONSTRAINT ck_endpoint_port CHECK (port BETWEEN 1 AND 65535),
    CONSTRAINT ck_endpoint_host CHECK (length(host) BETWEEN 1 AND 253),
    CONSTRAINT ck_endpoint_quality CHECK (quality_score >= 0 AND quality_score <= 100),
    CONSTRAINT ck_endpoint_revoked CHECK (
        authorization_status <> 'REVOKED' OR lifecycle_status = 'REVOKED'
    ),
    -- 公开代理永远不能获得网关授权（与 SEC-001 §6.2.6 一致）
    CONSTRAINT ck_endpoint_public_never_granted CHECK (
        NOT (trust_tier = 'PUBLIC_PROXY' AND explicit_gateway_grant)
    )
);
COMMENT ON TABLE proxy_endpoints IS '协议接入点，生命周期主体。authorization_status 是合规门槛，lifecycle_status 是技术状态，两者独立。';
COMMENT ON COLUMN proxy_endpoints.dedupe_key IS 'sha256(protocol|host|port|credential_fingerprint)，导入幂等键';

CREATE INDEX idx_endpoints_lifecycle_score ON proxy_endpoints (lifecycle_status, quality_score DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_endpoints_gate ON proxy_endpoints (authorization_status, lifecycle_status, protocol)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_endpoints_tier ON proxy_endpoints (trust_tier, lifecycle_status)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_endpoints_node ON proxy_endpoints (node_id) WHERE node_id IS NOT NULL;
CREATE INDEX idx_endpoints_source ON proxy_endpoints (source_id) WHERE source_id IS NOT NULL;

CREATE TABLE endpoint_sources (
    endpoint_id   uuid        NOT NULL REFERENCES proxy_endpoints (id) ON DELETE CASCADE,
    source_id     uuid        NOT NULL REFERENCES resource_sources (id) ON DELETE CASCADE,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (endpoint_id, source_id)
);
CREATE INDEX idx_endpoint_sources_source ON endpoint_sources (source_id);

CREATE TABLE endpoint_ip_observations (
    id               bigserial PRIMARY KEY,
    endpoint_id      uuid        NOT NULL REFERENCES proxy_endpoints (id) ON DELETE CASCADE,
    observed_ip      inet        NOT NULL,
    observed_country char(2),
    observed_at      timestamptz NOT NULL DEFAULT now(),
    source           text        NOT NULL DEFAULT 'HEALTH_CHECK',
    check_id         bigint
);
COMMENT ON TABLE endpoint_ip_observations IS '出口 IP 观测证据：仅在变化时或每日采样时写入，动态 IP 判定唯一依据';
CREATE INDEX idx_ip_obs_endpoint_time ON endpoint_ip_observations (endpoint_id, observed_at DESC);

-- =============================================================================
-- 4. AI 配置与用量
-- =============================================================================

CREATE TABLE ai_providers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key                 text              NOT NULL,
    name                text              NOT NULL,
    type                ai_provider_type  NOT NULL,
    base_url            text              NOT NULL,
    api_key_ref         text              REFERENCES secrets (ref) ON DELETE SET NULL,
    enabled             boolean           NOT NULL DEFAULT true,
    timeout_ms          int               NOT NULL DEFAULT 30000,
    max_retries         int               NOT NULL DEFAULT 1,
    extra_headers       jsonb             NOT NULL DEFAULT '{}'::jsonb,
    allow_private_network boolean         NOT NULL DEFAULT false,
    budget_monthly_usd  numeric(10, 2),
    spent_current_month numeric(10, 4)    NOT NULL DEFAULT 0,
    notes               text,
    last_tested_at      timestamptz,
    last_test_ok        boolean,
    created_at          timestamptz       NOT NULL DEFAULT now(),
    updated_at          timestamptz       NOT NULL DEFAULT now(),
    version             bigint            NOT NULL DEFAULT 1,
    CONSTRAINT uq_ai_providers_key UNIQUE (key),
    CONSTRAINT ck_ai_timeout CHECK (timeout_ms BETWEEN 1000 AND 300000)
);
COMMENT ON TABLE ai_providers IS 'AI Provider Registry：可插拔、多 Base URL、密钥只存引用';

CREATE TABLE ai_models (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id         uuid          NOT NULL REFERENCES ai_providers (id) ON DELETE CASCADE,
    model_name          text          NOT NULL,
    display_name        text,
    context_window      int,
    supports_json       boolean       NOT NULL DEFAULT false,
    input_cost_per_1k   numeric(10, 6) NOT NULL DEFAULT 0,
    output_cost_per_1k  numeric(10, 6) NOT NULL DEFAULT 0,
    enabled             boolean       NOT NULL DEFAULT true,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_ai_models UNIQUE (provider_id, model_name)
);

CREATE TABLE ai_task_bindings (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type   ai_task_type NOT NULL,
    provider_id uuid         NOT NULL REFERENCES ai_providers (id) ON DELETE CASCADE,
    model_id    uuid         NOT NULL REFERENCES ai_models (id) ON DELETE CASCADE,
    priority    int          NOT NULL DEFAULT 100,   -- 数字小的先试，构成降级链
    enabled     boolean      NOT NULL DEFAULT true,
    max_tokens  int,
    temperature numeric(3, 2),
    created_at  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_ai_binding_priority UNIQUE (task_type, priority)
);
CREATE INDEX idx_ai_binding_task ON ai_task_bindings (task_type) WHERE enabled;

CREATE TABLE ai_usage_records (
    id                bigserial PRIMARY KEY,
    provider_id       uuid          NOT NULL REFERENCES ai_providers (id) ON DELETE CASCADE,
    model_id          uuid          REFERENCES ai_models (id) ON DELETE SET NULL,
    task_type         ai_task_type  NOT NULL,
    request_id        text,
    prompt_tokens     int           NOT NULL DEFAULT 0,
    completion_tokens int           NOT NULL DEFAULT 0,
    cost_usd          numeric(10, 6) NOT NULL DEFAULT 0,
    latency_ms        int,
    success           boolean       NOT NULL DEFAULT true,
    error_code        text,
    occurred_at       timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_usage_time ON ai_usage_records (occurred_at DESC);
CREATE INDEX idx_ai_usage_provider ON ai_usage_records (provider_id, occurred_at DESC);

CREATE TABLE ai_analysis_logs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type        ai_task_type NOT NULL,
    subject_type     text,
    subject_id       uuid,
    provider_id      uuid         REFERENCES ai_providers (id) ON DELETE SET NULL,
    model_id         uuid         REFERENCES ai_models (id) ON DELETE SET NULL,
    prompt_hash      text,
    response_summary text,
    status           text         NOT NULL DEFAULT 'SUCCEEDED',
    error            text,
    tokens           int          NOT NULL DEFAULT 0,
    created_at       timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_logs_subject ON ai_analysis_logs (subject_type, subject_id, created_at DESC);

CREATE TABLE ai_discovery_tasks (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id      uuid        REFERENCES resource_sources (id) ON DELETE SET NULL,
    query          text,
    status         job_status  NOT NULL DEFAULT 'PENDING',
    result_summary jsonb,
    priority       int         NOT NULL DEFAULT 0,
    run_after      timestamptz NOT NULL DEFAULT now(),
    lease_owner    text,
    lease_expires_at timestamptz,
    attempts       int         NOT NULL DEFAULT 0,
    max_attempts   int         NOT NULL DEFAULT 2,
    created_by     uuid        REFERENCES proxy_users (id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    started_at     timestamptz,
    finished_at    timestamptz
);
CREATE INDEX idx_ai_discovery_pending ON ai_discovery_tasks (priority DESC, run_after)
    WHERE status = 'PENDING';

-- =============================================================================
-- 5. 候选（隔离区）与验证
-- =============================================================================

CREATE TABLE candidate_endpoints (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id            uuid                  NOT NULL REFERENCES resource_sources (id) ON DELETE CASCADE,
    snapshot_id          uuid                  REFERENCES source_snapshots (id) ON DELETE SET NULL,
    raw_value            text                  NOT NULL,
    protocol             proxy_protocol,
    host                 text,
    port                 int,
    credential_ref       text                  REFERENCES secrets (ref) ON DELETE SET NULL,
    dedupe_key           text,
    review_status        review_status         NOT NULL DEFAULT 'PENDING',
    authorization_guess  authorization_status  NOT NULL DEFAULT 'UNKNOWN',
    ai_analysis_id       uuid                  REFERENCES ai_analysis_logs (id) ON DELETE SET NULL,
    promoted_endpoint_id uuid                  REFERENCES proxy_endpoints (id) ON DELETE SET NULL,
    reject_reason        text,
    created_at           timestamptz           NOT NULL DEFAULT now(),
    reviewed_at          timestamptz,
    reviewed_by          uuid                  REFERENCES proxy_users (id),
    CONSTRAINT ck_candidate_port CHECK (port IS NULL OR port BETWEEN 1 AND 65535)
);
COMMENT ON TABLE candidate_endpoints IS '候选隔离区：AI 与解析器只写这里，绝不直接写 proxy_endpoints';
CREATE UNIQUE INDEX uq_candidate_source_dedupe ON candidate_endpoints (source_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_candidates_review ON candidate_endpoints (review_status, created_at DESC);

-- AI / 规则只能"建议"分级，不能直接改 proxy_endpoints.trust_tier（SEC-001 §6.6）
CREATE TABLE promotion_suggestions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id    uuid        REFERENCES proxy_endpoints (id) ON DELETE CASCADE,
    candidate_id   uuid        REFERENCES candidate_endpoints (id) ON DELETE CASCADE,
    suggested_tier trust_tier  NOT NULL,
    current_tier   trust_tier,
    confidence     numeric(4, 3) NOT NULL DEFAULT 0,
    rationale      text,
    source         text        NOT NULL DEFAULT 'AI',   -- AI / RULE / HUMAN
    ai_analysis_id uuid        REFERENCES ai_analysis_logs (id) ON DELETE SET NULL,
    status         text        NOT NULL DEFAULT 'PENDING',
    reviewed_by    uuid        REFERENCES proxy_users (id),
    reviewed_at    timestamptz,
    review_note    text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_promo_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT ck_promo_source CHECK (source IN ('AI', 'RULE', 'HUMAN')),
    CONSTRAINT ck_promo_confidence CHECK (confidence BETWEEN 0 AND 1),
    CONSTRAINT ck_promo_target CHECK (endpoint_id IS NOT NULL OR candidate_id IS NOT NULL),
    -- 关键约束：没有人工复核就不可能是 APPROVED
    CONSTRAINT ck_promo_approved_needs_reviewer CHECK (
        status <> 'APPROVED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);
CREATE INDEX idx_promo_pending ON promotion_suggestions (status, created_at)
    WHERE status = 'PENDING';
CREATE UNIQUE INDEX uq_promo_pending_endpoint
    ON promotion_suggestions (endpoint_id, suggested_tier)
    WHERE status = 'PENDING' AND endpoint_id IS NOT NULL;
COMMENT ON TABLE promotion_suggestions IS '分级晋升建议：AI 只能写这里，批准必须人工；DB 约束保证 APPROVED 必有 reviewer';

CREATE TABLE verification_jobs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope          text        NOT NULL,
    endpoint_ids   uuid[],
    pool_id        uuid,
    filter         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    status         job_status  NOT NULL DEFAULT 'PENDING',
    total          int         NOT NULL DEFAULT 0,
    completed      int         NOT NULL DEFAULT 0,
    failed_count   int         NOT NULL DEFAULT 0,
    priority       int         NOT NULL DEFAULT 0,
    run_after      timestamptz NOT NULL DEFAULT now(),
    lease_owner    text,
    lease_expires_at timestamptz,
    attempts       int         NOT NULL DEFAULT 0,
    max_attempts   int         NOT NULL DEFAULT 3,
    created_by     uuid        REFERENCES proxy_users (id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    started_at     timestamptz,
    finished_at    timestamptz,
    CONSTRAINT ck_verif_scope CHECK (scope IN ('ENDPOINT', 'ENDPOINTS', 'POOL', 'ALL_PENDING', 'ALL'))
);
CREATE INDEX idx_verif_pending ON verification_jobs (priority DESC, run_after)
    WHERE status = 'PENDING';
CREATE INDEX idx_verif_created ON verification_jobs (created_at DESC);

CREATE TABLE health_checks (
    id             bigserial,
    endpoint_id    uuid                 NOT NULL REFERENCES proxy_endpoints (id) ON DELETE CASCADE,
    job_id         uuid,
    checked_at     timestamptz          NOT NULL DEFAULT now(),
    success        boolean              NOT NULL,
    failed_layer   smallint,
    failure_reason check_failure_reason NOT NULL DEFAULT 'NONE',
    dns_ms         int,
    tcp_ms         int,
    handshake_ms   int,
    total_ms       int,
    samples        smallint             NOT NULL DEFAULT 1,
    success_count  smallint             NOT NULL DEFAULT 0,
    exit_ip        inet,
    exit_country   char(2),
    error_detail   text,
    PRIMARY KEY (id, checked_at),
    CONSTRAINT ck_health_layer CHECK (failed_layer IS NULL OR failed_layer BETWEEN 1 AND 7)
) PARTITION BY RANGE (checked_at);
COMMENT ON TABLE health_checks IS '每次探测的原始结果，只增不改，按月分区，保留 90 天';

CREATE INDEX idx_health_endpoint_time ON health_checks (endpoint_id, checked_at DESC);
CREATE INDEX idx_health_failures ON health_checks (failure_reason, checked_at DESC)
    WHERE success = false;

CREATE TABLE endpoint_health_state (
    endpoint_id           uuid PRIMARY KEY REFERENCES proxy_endpoints (id) ON DELETE CASCADE,
    last_check_at         timestamptz,
    last_success_at       timestamptz,
    success               boolean     NOT NULL DEFAULT false,
    consecutive_failures  int         NOT NULL DEFAULT 0,
    consecutive_successes int         NOT NULL DEFAULT 0,
    p50_ms                int,
    p95_ms                int,
    jitter_ms             int,
    success_rate_24h      numeric(5, 4),
    quality_score         numeric(5, 2) NOT NULL DEFAULT 0,
    scored_at             timestamptz,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_health_state_score CHECK (quality_score >= 0 AND quality_score <= 100),
    CONSTRAINT ck_success_rate CHECK (success_rate_24h IS NULL OR success_rate_24h BETWEEN 0 AND 1)
);

CREATE TABLE endpoint_metrics_hourly (
    endpoint_id uuid        NOT NULL REFERENCES proxy_endpoints (id) ON DELETE CASCADE,
    bucket      timestamptz NOT NULL,
    checks      int         NOT NULL DEFAULT 0,
    successes   int         NOT NULL DEFAULT 0,
    p50_ms      int,
    p95_ms      int,
    avg_ms      int,
    PRIMARY KEY (endpoint_id, bucket)
) PARTITION BY RANGE (bucket);

-- 公开代理专属的匿名性/安全性检查（SEC-001 §6.2.4）
CREATE TABLE security_checks (
    id          bigserial PRIMARY KEY,
    endpoint_id uuid        NOT NULL REFERENCES proxy_endpoints (id) ON DELETE CASCADE,
    check_type  text        NOT NULL,
    result      text        NOT NULL,
    severity    text        NOT NULL DEFAULT 'INFO',
    detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    checked_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_security_type CHECK (check_type IN (
        'TRANSPARENCY', 'HEADER_INJECTION', 'DNS_LEAK', 'CERT_SUBSTITUTION', 'CONTENT_TAMPER'
    )),
    CONSTRAINT ck_security_result CHECK (result IN ('PASS', 'WARN', 'FAIL')),
    CONSTRAINT ck_security_severity CHECK (severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
);
CREATE INDEX idx_security_checks_endpoint ON security_checks (endpoint_id, checked_at DESC);
CREATE INDEX idx_security_checks_critical ON security_checks (checked_at DESC)
    WHERE severity = 'CRITICAL' AND result = 'FAIL';

-- =============================================================================
-- 6. 资源池 / 策略 / 网关 / 订阅
-- =============================================================================

CREATE TABLE resource_pools (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key         text          NOT NULL,
    name        text          NOT NULL,
    description text,
    purpose     text,
    min_quality numeric(5, 2) NOT NULL DEFAULT 0,
    max_members int,
    member_count int          NOT NULL DEFAULT 0,
    allowed_tiers trust_tier[] NOT NULL DEFAULT '{PRIVATE_PROXY,VERIFIED_PROXY}',
    experimental  boolean     NOT NULL DEFAULT false,
    enabled     boolean       NOT NULL DEFAULT true,
    version     bigint        NOT NULL DEFAULT 1,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_pools_key UNIQUE (key),
    CONSTRAINT ck_pool_quality CHECK (min_quality BETWEEN 0 AND 100),
    CONSTRAINT ck_pool_max CHECK (max_members IS NULL OR max_members > 0),
    -- 实验池必须显式声明实验属性（用于强制警告条与 YAML 注释）
    CONSTRAINT ck_pool_experimental CHECK (NOT experimental OR allowed_tiers @> '{PUBLIC_PROXY}')
);
COMMENT ON TABLE resource_pools IS '逻辑资源池：面向场景的集合，一个端点可属多个池；version 单调递增用于快照一致性';

CREATE TABLE resource_pool_rules (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id    uuid        NOT NULL REFERENCES resource_pools (id) ON DELETE CASCADE,
    rule_order int         NOT NULL DEFAULT 0,
    name       text        NOT NULL,
    predicate  jsonb       NOT NULL,               -- 结构化 DSL，编译为 SQL WHERE（字段白名单）
    enabled    boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_pool_rule_order UNIQUE (pool_id, rule_order)
);

CREATE TABLE resource_pool_members (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id        uuid          NOT NULL REFERENCES resource_pools (id) ON DELETE CASCADE,
    endpoint_id    uuid          NOT NULL REFERENCES proxy_endpoints (id) ON DELETE CASCADE,
    source         member_source NOT NULL DEFAULT 'AUTO',
    weight         int           NOT NULL DEFAULT 100,
    suppressed     boolean       NOT NULL DEFAULT false,
    suppress_reason text,
    added_by       uuid          REFERENCES proxy_users (id),
    added_at       timestamptz   NOT NULL DEFAULT now(),
    expires_at     timestamptz,
    CONSTRAINT uq_pool_member UNIQUE (pool_id, endpoint_id),
    CONSTRAINT ck_member_weight CHECK (weight BETWEEN 1 AND 1000)
);
CREATE INDEX idx_pool_members_endpoint ON resource_pool_members (endpoint_id);

CREATE TABLE routing_policies (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key               text             NOT NULL,
    name              text             NOT NULL,
    strategy          policy_strategy  NOT NULL,
    pool_id           uuid             NOT NULL REFERENCES resource_pools (id) ON DELETE RESTRICT,
    listen_port       int              NOT NULL,
    enabled           boolean          NOT NULL DEFAULT true,
    priority          int              NOT NULL DEFAULT 100,
    region_filter     text[]           NOT NULL DEFAULT '{}',
    protocol_filter   proxy_protocol[] NOT NULL DEFAULT '{}',
    max_members       int,
    sticky_ttl_seconds int             NOT NULL DEFAULT 1800,
    config            jsonb            NOT NULL DEFAULT '{}'::jsonb,
    version           bigint           NOT NULL DEFAULT 1,
    created_at        timestamptz      NOT NULL DEFAULT now(),
    updated_at        timestamptz      NOT NULL DEFAULT now(),
    CONSTRAINT uq_policies_key UNIQUE (key),
    CONSTRAINT uq_policies_port UNIQUE (listen_port),
    CONSTRAINT ck_policy_port CHECK (listen_port BETWEEN 1024 AND 65535)
);
COMMENT ON TABLE routing_policies IS '一个策略 = 一个监听端口，编译期固化资源选择，请求期不回源控制平面';

CREATE TABLE routing_sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id    uuid        NOT NULL REFERENCES routing_policies (id) ON DELETE CASCADE,
    session_key  text        NOT NULL,
    endpoint_id  uuid        NOT NULL REFERENCES proxy_endpoints (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    CONSTRAINT uq_routing_session UNIQUE (policy_id, session_key)
);
CREATE INDEX idx_routing_sessions_expiry ON routing_sessions (expires_at);

CREATE TABLE gateway_instances (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  text        NOT NULL,
    engine                text        NOT NULL DEFAULT 'gost',
    api_base_url          text,
    admin_base_url        text,
    bind_host             text        NOT NULL DEFAULT '127.0.0.1',
    http_port             int         NOT NULL DEFAULT 8080,
    socks_port            int         NOT NULL DEFAULT 1080,
    status                text        NOT NULL DEFAULT 'UNKNOWN',
    last_seen_at          timestamptz,
    active_config_version bigint,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    version               bigint      NOT NULL DEFAULT 1,
    CONSTRAINT uq_gateway_name UNIQUE (name),
    CONSTRAINT ck_gateway_bind CHECK (length(bind_host) > 0)
);

CREATE TABLE gateway_configs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id     uuid                  NOT NULL REFERENCES gateway_instances (id) ON DELETE CASCADE,
    version         bigint                NOT NULL,
    status          gateway_config_status NOT NULL DEFAULT 'COMPILED',
    config_hash     text                  NOT NULL,
    rendered_config text                  NOT NULL,
    policy_ids      uuid[]                NOT NULL DEFAULT '{}',
    warnings        jsonb                 NOT NULL DEFAULT '[]'::jsonb,
    error           text,
    applied_at      timestamptz,
    created_by      uuid                  REFERENCES proxy_users (id),
    created_at      timestamptz           NOT NULL DEFAULT now(),
    CONSTRAINT uq_gateway_config_version UNIQUE (instance_id, version)
);
CREATE INDEX idx_gateway_configs_status ON gateway_configs (instance_id, status, version DESC);

CREATE TABLE gateway_traffic_samples (
    id          bigserial,
    instance_id uuid        NOT NULL REFERENCES gateway_instances (id) ON DELETE CASCADE,
    policy_key  text,
    sampled_at  timestamptz NOT NULL DEFAULT now(),
    connections int         NOT NULL DEFAULT 0,
    bytes_in    bigint      NOT NULL DEFAULT 0,
    bytes_out   bigint      NOT NULL DEFAULT 0,
    errors      int         NOT NULL DEFAULT 0,
    PRIMARY KEY (id, sampled_at)
) PARTITION BY RANGE (sampled_at);

CREATE TABLE subscriptions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text        NOT NULL,
    pool_id          uuid        NOT NULL REFERENCES resource_pools (id) ON DELETE RESTRICT,
    format           text        NOT NULL DEFAULT 'mihomo',
    token_hash       text        NOT NULL,          -- sha256(明文 token)
    token_prefix     text        NOT NULL,
    signing_enabled  boolean     NOT NULL DEFAULT false,
    revision         bigint      NOT NULL DEFAULT 0, -- 单调递增，用于防重放
    expires_at       timestamptz,
    revoked_at       timestamptz,
    created_by       uuid        REFERENCES proxy_users (id),
    last_accessed_at timestamptz,
    access_count     bigint      NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_subscription_token UNIQUE (token_hash),
    CONSTRAINT ck_subscription_format CHECK (format IN ('mihomo', 'clash', 'singbox'))
);
CREATE INDEX idx_subscriptions_pool ON subscriptions (pool_id) WHERE revoked_at IS NULL;

CREATE TABLE subscription_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id uuid        NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
    version         int         NOT NULL,
    revision        bigint      NOT NULL,
    pool_version    bigint      NOT NULL,
    content_hash    text        NOT NULL,
    content         text        NOT NULL,
    canonical_hash  text,                            -- sha256(JCS(payload))
    signature       text,                            -- base64url(64B) Ed25519
    key_id          text,
    signature_version int,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_subscription_version UNIQUE (subscription_id, version),
    CONSTRAINT uq_subscription_revision UNIQUE (subscription_id, revision),
    CONSTRAINT ck_signed_fields CHECK (
        signature IS NULL OR (canonical_hash IS NOT NULL AND key_id IS NOT NULL AND signature_version IS NOT NULL)
    )
);

-- 订阅签名密钥（SEC-001 §6.5）：私钥只在 secrets 中，本表只存公钥与状态
CREATE TABLE signing_keys (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key_id            text        NOT NULL,
    algorithm         text        NOT NULL DEFAULT 'Ed25519',
    public_key        text        NOT NULL,          -- base64url(raw 32 bytes)
    private_key_ref   text        REFERENCES secrets (ref) ON DELETE RESTRICT,
    status            text        NOT NULL DEFAULT 'STANDBY',
    signature_version int         NOT NULL DEFAULT 1,
    not_before        timestamptz NOT NULL DEFAULT now(),
    not_after         timestamptz,
    activated_at      timestamptz,
    retired_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_signing_keys_key_id UNIQUE (key_id),
    CONSTRAINT ck_signing_algorithm CHECK (algorithm IN ('Ed25519')),
    CONSTRAINT ck_signing_status CHECK (status IN ('ACTIVE', 'STANDBY', 'RETIRED', 'COMPROMISED'))
);
-- 同一时刻只能有一个 ACTIVE 签名密钥
CREATE UNIQUE INDEX uq_signing_keys_single_active ON signing_keys (status) WHERE status = 'ACTIVE';
COMMENT ON TABLE signing_keys IS '订阅内容签名密钥：只存公钥；私钥在 secrets(kind=SIGNING_KEY)，永不返回 API';

-- =============================================================================
-- 7. 事件基础设施
-- =============================================================================

CREATE TABLE event_outbox (
    id             bigserial PRIMARY KEY,
    event_id       uuid        NOT NULL,
    event_type     text        NOT NULL,
    aggregate_type text        NOT NULL,
    aggregate_id   text        NOT NULL,
    schema_version int         NOT NULL DEFAULT 1,
    payload        jsonb       NOT NULL,
    occurred_at    timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz,
    attempts       int         NOT NULL DEFAULT 0,
    last_error     text,
    CONSTRAINT uq_outbox_event UNIQUE (event_id)
);
CREATE INDEX idx_outbox_unpublished ON event_outbox (id) WHERE published_at IS NULL;

CREATE TABLE event_consumers (
    event_id     uuid        NOT NULL,
    consumer     text        NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, consumer)
);

-- =============================================================================
-- 8. 视图：唯一可信的"可调度"定义
-- =============================================================================

CREATE VIEW v_schedulable_endpoints AS
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
    e.node_id,
    e.ip_asset_id,
    s.p50_ms,
    s.p95_ms,
    s.jitter_ms,
    s.success_rate_24h,
    s.last_success_at
FROM proxy_endpoints e
JOIN endpoint_health_state s ON s.endpoint_id = e.id
WHERE e.deleted_at IS NULL
  AND e.authorization_status IN ('AUTHORIZED', 'RESTRICTED')
  AND e.lifecycle_status IN ('HEALTHY', 'DEGRADED')
  -- 信任分级门槛（SEC-001 §6.2）：PUBLIC_PROXY 永不出现在这里
  AND (
        e.trust_tier = 'VERIFIED_PROXY'
     OR (e.trust_tier = 'PRIVATE_PROXY' AND e.explicit_gateway_grant)
  );

COMMENT ON VIEW v_schedulable_endpoints IS '正式网关硬门槛：授权有效 + 健康 + 分级允许。任何编译/统计都必须从此视图取数';

-- 订阅可用集合：三种分级都可订阅，PUBLIC_PROXY 的"仅实验池"限制由 pool.allowed_tiers 保证
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
    s.p50_ms,
    s.last_success_at
FROM proxy_endpoints e
JOIN endpoint_health_state s ON s.endpoint_id = e.id
WHERE e.deleted_at IS NULL
  AND e.authorization_status IN ('AUTHORIZED', 'RESTRICTED')
  AND e.lifecycle_status IN ('HEALTHY', 'DEGRADED')
  AND e.trust_tier IN ('PRIVATE_PROXY', 'PUBLIC_PROXY', 'VERIFIED_PROXY');

COMMENT ON VIEW v_subscription_eligible_endpoints IS '订阅渲染取数视图；PUBLIC_PROXY 只能通过 allowed_tiers 含 PUBLIC_PROXY 的实验池发布';

CREATE MATERIALIZED VIEW mv_endpoint_daily AS
SELECT date_trunc('day', h.checked_at) AS day,
       e.protocol,
       e.origin_type,
       count(*)                        AS checks,
       count(*) FILTER (WHERE h.success) AS successes,
       round(avg(h.total_ms))::int      AS avg_ms
FROM health_checks h
JOIN proxy_endpoints e ON e.id = h.endpoint_id
WHERE h.checked_at >= now() - interval '90 days'
GROUP BY 1, 2, 3;
CREATE UNIQUE INDEX uq_mv_endpoint_daily ON mv_endpoint_daily (day, protocol, origin_type);

CREATE MATERIALIZED VIEW mv_pool_health AS
SELECT p.id                       AS pool_id,
       p.key                      AS pool_key,
       count(m.endpoint_id)       AS members,
       count(*) FILTER (WHERE e.lifecycle_status = 'HEALTHY')    AS healthy,
       count(*) FILTER (WHERE e.lifecycle_status = 'DEGRADED')   AS degraded,
       round(avg(e.quality_score), 2)                            AS avg_quality
FROM resource_pools p
LEFT JOIN resource_pool_members m ON m.pool_id = p.id AND m.suppressed = false
LEFT JOIN proxy_endpoints e ON e.id = m.endpoint_id AND e.deleted_at IS NULL
GROUP BY p.id, p.key;
CREATE UNIQUE INDEX uq_mv_pool_health ON mv_pool_health (pool_id);

-- =============================================================================
-- 9. 函数与触发器
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    NEW.version := COALESCE(NEW.version, 1) + 1;
    RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'proxy_users', 'providers', 'provider_accounts', 'resource_sources',
        'ip_assets', 'proxy_nodes', 'proxy_endpoints', 'ai_providers',
        'resource_pools', 'routing_policies', 'gateway_instances'
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END LOOP;
END $$;

-- 分区维护：为当前月及未来 N 个月创建分区（Worker 每日调用）
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(p_months_ahead int DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_parent text;
    v_start  timestamptz;
    v_end    timestamptz;
    v_name   text;
    i        int;
BEGIN
    FOREACH v_parent IN ARRAY ARRAY[
        'health_checks', 'endpoint_metrics_hourly', 'gateway_traffic_samples', 'audit_events'
    ] LOOP
        FOR i IN 0..p_months_ahead LOOP
            v_start := date_trunc('month', now()) + (i || ' month')::interval;
            v_end   := v_start + interval '1 month';
            v_name  := v_parent || '_' || to_char(v_start, 'YYYYMM');
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                v_name, v_parent, v_start, v_end);
        END LOOP;
    END LOOP;
END $$;

-- 保留策略：删除早于 p_retain_months 的分区（audit_events 不调用）
CREATE OR REPLACE FUNCTION drop_expired_partitions(p_table text, p_retain_months int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
    v_child  text;
    v_suffix text;
    v_month  date;
    v_cutoff date;
    v_count  int := 0;
BEGIN
    v_cutoff := (date_trunc('month', now()) - (p_retain_months || ' month')::interval)::date;
    FOR v_child IN
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = p_table
    LOOP
        v_suffix := substring(v_child from '(\d{6})$');
        CONTINUE WHEN v_suffix IS NULL;
        v_month := to_date(v_suffix, 'YYYYMM');
        IF v_month < v_cutoff THEN
            EXECUTE format('DROP TABLE IF EXISTS %I', v_child);
            v_count := v_count + 1;
        END IF;
    END LOOP;
    RETURN v_count;
END $$;

SELECT ensure_monthly_partitions(2);

COMMIT;

-- =============================================================================
-- 10. 生产环境额外授权（由 DBA 执行，不在迁移中固化）
-- -----------------------------------------------------------------------------
-- CREATE ROLE proxyforge_app LOGIN PASSWORD '...';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO proxyforge_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO proxyforge_app;
-- REVOKE UPDATE, DELETE ON audit_events FROM proxyforge_app;      -- 审计不可改
-- REVOKE DELETE ON secrets FROM proxyforge_app;                   -- 密钥只轮换不删
-- =============================================================================
