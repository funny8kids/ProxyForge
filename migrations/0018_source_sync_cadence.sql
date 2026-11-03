-- 0018 · 按实测隧道产出重排同步周期
--
-- 背景：订阅里能用的节点被 `connect_ok IS TRUE` 卡死。全库 1,125 个 HEALTHY
-- 里只有 227 个能建 CONNECT 隧道（20%），而「已判不可用」的那批在**空闲条件
-- 下以并发 8 复核**仍只有 3/76（4%）能建隧道 —— 说明这个 20% 是真值，
-- 不是并发压出来的假失败（`scripts/diag-tunnel.mts`，2026-11-03）。
--
-- 既然隧道率是硬约束，源的价值就不该按「条目数」或「存活数」衡量，而该按
-- **能产出多少可下发节点**衡量。实测同一时刻各源的 HEALTHY / 隧道可用：
--
--   key                HEALTHY  隧道可用   隧道率
--   hideipme-http           18       18    100.0%
--   monosans-socks5          9        9    100.0%
--   monosans-socks4          5        4     80.0%
--   hideipme-socks5         27       20     74.1%
--   thespeedx-http         152       32     21.1%
--   proxifly-csv           118       23     19.5%
--   hookzof-socks5         167       12      7.2%
--   iplocate-socks5        174        7      4.0%
--   thespeedx-socks4       148        1      0.7%
--
-- 两端各错一次，方向相反：
--
--   · `thespeedx-socks4` 是全库最大的 HEALTHY 产出方之一（148 个），
--     却只贡献 1 个可用节点。它的节点能建 SOCKS4 握手到 80 端口、
--     但 443 全部失败 —— 占着探测预算和 HEALTHY 计数，产出接近于零。
--   · `iplocate-socks5` 是上一轮按「24 条抽样测到 3 条隧道（12.5%）」
--     加进来的，并写下了"是候选里产出最高的一支"。全量跑完是 7/174（4%），
--     那句话是错的：小样本只够排除明显无效的源，确认可用必须靠全量。
--
-- 所以：高产出源压到 300 秒（PATCH 校验的下限），低产出源放宽到 1800 秒。
-- 免费代理存活期是几十分钟量级，同步越慢，抓到的那批 IP 到探测时活着的越少 ——
-- 对 74–100% 隧道率的源，缩短周期是**直接**增加可用节点；对 4% 的源，
-- 缩短周期只是更快地灌进来一批注定失败的候选。
--
-- 周期是可以通过 `PATCH /sources/:id` 改回来的调参项，不是不可逆的决定；
-- `enabled` 与 `trust_level` 不在这里动 —— 那是人的判断。
--
-- 注：`monosans-http`（隧道率 84.6%）与 `openproxylist-http`（33.3%）
-- 的隧道率同样很高，但两者 URL 已失效（last_sync_status = FAILED），
-- 调周期没有意义，等上游恢复后由采集流水线自己把状态改回 OK。

UPDATE resource_sources SET sync_interval_seconds = 300, updated_at = now()
 WHERE key IN (
   'hideipme-http',      -- 100.0% 隧道率，204 条/次
   'monosans-socks5',    -- 100.0% 隧道率，1,019 条/次
   'monosans-socks4',    --  80.0% 隧道率，338 条/次
   'hideipme-socks5',    --  74.1% 隧道率，888 条/次
   'thespeedx-http'      --  21.1% 隧道率，但绝对量最大（32 个可用/152 存活）
 );

UPDATE resource_sources SET sync_interval_seconds = 1800, updated_at = now()
 WHERE key IN (
   'iplocate-socks5',    --  4.0% 隧道率，全库最大死重
   'thespeedx-socks4',   --  0.7% 隧道率，148 个 HEALTHY 换 1 个可用
   'hookzof-socks5'      --  7.2% 隧道率，167 个 HEALTHY 换 12 个可用
 );
