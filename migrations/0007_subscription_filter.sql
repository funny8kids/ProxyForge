-- =============================================================================
-- 0007 — 订阅内容筛选与分流
--
-- 之前一个订阅 = 整个池：池里 36 个节点就全给 36 个，用户没法只要 SOCKS5、
-- 没法排除某个地区、没法限制节点数。导出的配置也没法选"全局 / 规则 / 直连"。
--
-- 这里把"选哪些节点"和"怎么分流"变成订阅自身的属性，而不是每次导出临时传参 ——
-- 客户端是按 URL 拉取的，参数传不进客户端的订阅地址。
-- =============================================================================

ALTER TABLE subscriptions
    -- 节点筛选：{ protocols, countries, excludeCountries, minQuality, limit, excludeEndpointIds }
    ADD COLUMN IF NOT EXISTS node_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- 节点命名模板，如 {country}-{protocol}-{index}；空则用默认名
    ADD COLUMN IF NOT EXISTS name_template text,
    -- 分流模式：global 全量走代理 / rule 国内直连 / direct 全直连
    ADD COLUMN IF NOT EXISTS routing_mode text NOT NULL DEFAULT 'global',
    -- 追加的自定义规则（原样渲染到 rules 段，不校验语义）
    ADD COLUMN IF NOT EXISTS extra_rules jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE subscriptions
    ADD CONSTRAINT ck_subscription_routing_mode
    CHECK (routing_mode IN ('global', 'rule', 'direct'));

-- 名称模板长度上限：模板会被渲染进每个节点名，客户端对名字长度有隐性限制，
-- 200 字符足够表达，也挡住把整段 SQL/脚本塞进来的滥用
ALTER TABLE subscriptions
    ADD CONSTRAINT ck_subscription_name_template
    CHECK (name_template IS NULL OR length(name_template) <= 200);
