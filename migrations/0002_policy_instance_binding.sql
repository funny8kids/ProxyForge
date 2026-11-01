-- =============================================================================
-- 0002 · 策略绑定网关实例
-- -----------------------------------------------------------------------------
-- 问题：routing_policies 缺少 instance_id，编译时只能把「全部策略」塞进
--       每一个网关实例。这与 SEC-001 §6.2 的物理隔离要求冲突 ——
--       正式实例会被写入实验策略的监听器。
--
-- 变更性质：**扩展**（新增可空列 + 索引），不破坏既有行，不需要双写。
-- 兼容：instance_id 为 NULL 的策略视为「未绑定」，编译器会跳过并告警，
--       而不是默认落到所有实例（宁可少下发，不可错下发）。
-- =============================================================================

BEGIN;

ALTER TABLE routing_policies
    ADD COLUMN IF NOT EXISTS instance_id uuid
    REFERENCES gateway_instances (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_policies_instance
    ON routing_policies (instance_id) WHERE instance_id IS NOT NULL;

COMMENT ON COLUMN routing_policies.instance_id IS
    '绑定的网关实例。NULL = 未绑定，编译器跳过。正式与实验策略必须绑到不同实例。';

-- 已有数据回填到最早创建的实例（单实例部署下的安全默认）
UPDATE routing_policies
SET instance_id = (
    SELECT id FROM gateway_instances ORDER BY created_at ASC, id ASC LIMIT 1
)
WHERE instance_id IS NULL;

COMMIT;
