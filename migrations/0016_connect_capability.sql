-- 隧道能力（能否 CONNECT 到 443），也就是"能不能上 HTTPS"。
--
-- 主探测用的是绝对 URI 的明文 GET，验证的是"能不能正向转发 HTTP"。
-- 这两件事在免费代理里差得很远：实测 40 个 HEALTHY 节点，
--   20% 能上 HTTPS、40% 只能上明文 HTTP、40% 已经死了。
-- 也就是说 success=true 只说明"活着"，而 Clash 里绝大多数站点是 HTTPS。
--
-- 用独立的布尔列而不是塞进 quality_score：
--   · 语义不同 —— 一个是"活着"，一个是"能用"，混在一个数里就再也分不开
--   · 排序要能用 —— 池子与订阅都按 connect_ok 优先排，需要一个可索引的列
--   · NULL 有意义 —— 表示"还没测过"，与"测过但不支持"必须区分
ALTER TABLE endpoint_health_state
  ADD COLUMN IF NOT EXISTS connect_ok boolean;

COMMENT ON COLUMN endpoint_health_state.connect_ok IS
  '能否建立 CONNECT 隧道（访问 HTTPS）。NULL = 尚未检测；false = 只能转发明文 HTTP';

-- 池重算与订阅导出都按「先 connect_ok 后 quality_score」取人，
-- 部分索引让这个排序不必扫全表。
CREATE INDEX IF NOT EXISTS idx_health_connect_ok
  ON endpoint_health_state (connect_ok, quality_score DESC)
  WHERE connect_ok IS NOT NULL;

-- 视图的改造在 0017。
--
-- 原本写在这里，结果被 `tsx watch` 抢跑：开发模式下保存 .sql 会触发热重启，
-- 而重启会跑 migrate()，于是文件在"只写了 ALTER + INDEX、还没写视图"的
-- 中间状态被应用并记进 schema_migrations。之后文件被补齐，但 checksum
-- 记的是 sql.length（800），没有任何东西能发现这个分叉 —— 表现就是
-- 列存在、视图却是旧的，订阅接口报 `column v.connect_ok does not exist`。
--
-- 迁移是只进不退的，已经应用过的文件不该再改语义。视图那段单独放进 0017。
