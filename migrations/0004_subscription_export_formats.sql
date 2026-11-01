-- 0004 · 订阅导出格式扩展
--
-- 0001 的 CHECK 只允许 mihomo / clash / singbox 三种。
-- 现在订阅可以按 base64（v2rayN / Shadowrocket 通用格式）或 plain（明文 URI 列表）
-- 建库，约束必须同步放宽，否则创建请求会撞 23514 而不是给出可读的错误。

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS ck_subscription_format;

ALTER TABLE subscriptions
    ADD CONSTRAINT ck_subscription_format
    CHECK (format IN ('mihomo', 'clash', 'singbox', 'base64', 'plain'));

COMMENT ON COLUMN subscriptions.format IS
    '默认导出格式。客户端拉取时可用 ?format= 临时覆盖，覆盖不影响 revision —— 格式只是序列化方式，不是内容变更。';
