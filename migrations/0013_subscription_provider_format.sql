-- 0013 · 新增 proxy-provider 导出格式
--
-- 原来的 mihomo / clash 输出的是**整份配置**：mixed-port、dns、rules 全都在里面。
-- 作为"一键导入"很方便，但它有两个无法回避的问题：
--
--   1. 导入即覆盖。用户在 Clash Verge 里精心调过的 DNS、分流规则、TUN 设置，
--      被订阅里的那份默认值直接顶掉，而且下次更新还会再顶一次。
--   2. 无法组合。想把 ProxyForge 的节点和自己另外两份订阅放在同一个配置里
--      按地区分组，做不到 —— 一个配置文件只能有一份 proxies。
--
-- proxy-providers 是 mihomo 官方为此设计的东西：provider 文件里**只放 proxies**，
-- 用户的 config.yaml 通过 url + path 引用它，规则和 DNS 完全留在自己手里。
-- 所以这里加一个只出节点列表的格式，让订阅可以当 provider 用。

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS ck_subscription_format;

ALTER TABLE subscriptions
    ADD CONSTRAINT ck_subscription_format
    CHECK (format IN ('mihomo', 'clash', 'singbox', 'base64', 'plain', 'clash-provider'));

COMMENT ON COLUMN subscriptions.format IS
    '默认导出格式。clash-provider 只输出 proxies 列表（供 mihomo proxy-providers 引用），其余格式输出整份配置。客户端拉取时可用 ?format= 临时覆盖，覆盖不影响 revision —— 格式只是序列化方式，不是内容变更。';
