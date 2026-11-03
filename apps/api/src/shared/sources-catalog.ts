import type { ProxyProtocol } from '@proxyforge/contracts';

/**
 * 内置公开源目录。
 *
 * 收录原则：
 *   1. **只收实测可达的源**。这张表不是"听说过的清单"，每个 URL 都跑过
 *      一次真实抓取确认返回 2xx 且首行能被 parseProxyLine 解析。
 *      写一个 404 进去，用户点同步只会得到"拉取来源失败"，比没有更糟。
 *   2. **不声明授权**。这些是别人爬来的公开代理，我们不知道每个 IP 的归属，
 *      所以 authorization_status 一律 UNKNOWN —— 由用户在同步时显式声明，
 *      或在候选区逐个判定。给个默认 AUTHORIZED 等于凭空伪造授权依据。
 *   3. **信任级压在 50 以下**。公开列表的节点存活率普遍低于 30%，且随时可能
 *      变成别人的蜜罐。trust_level 高会让它们在晋升排序里排到前面，与事实相反。
 *
 * 加源只需往 CATALOG 里追加一项，`POST /sources/catalog` 是幂等的
 * （按 key upsert），不会重复插入，也不会覆盖用户改过的信任级与开关。
 *
 * ## 同步周期为什么统一压到 15 分钟
 *
 * 原来是 30–120 分钟。压到 15 分钟的理由**当时写错了**，这里改正：
 *
 * 原注释说"统计历史快照的 content_hash，重复率是 0%，说明列表一直在换血、
 * 我们是欠采样的"。这个结论是循环论证 —— `syncSource` 在 content_hash
 * 命中时**不写快照行**，所以 `source_snapshots` 里按定义只有互不相同的
 * hash，`distinct / snaps` 恒等于 1。那个 0% 不是测出来的，是这个指标在
 * 这套数据模型下不可能不为 0。现网日志里 `同步 3 个源（成功 3）新增候选 0`
 * 反复出现，直接反证了它。
 *
 * 正确的理由只剩一条，但它足够成立：**收益在"更早看到"，不在"看到更多"**。
 * 免费代理 IP 存活期是几十分钟量级，同步周期直接决定了我们看到的列表
 * 有多旧 —— 15 分钟周期意味着平均滞后 7.5 分钟，而对一个活了 30 分钟的
 * IP，晚 15 分钟发现它，探测完基本已经死了。提频买的是**新鲜度**，
 * 代价是重复拉取，而重复拉取在 content_hash 命中时接近零成本。
 *
 * 重复率现在可测了（`sync_attempts` / `duplicate_syncs`，见 migrations/0019），
 * 周期该定多少以后按它算，不再靠断言。
 *
 * 下限由 `PATCH /sources/:id` 校验（≥300 秒），避免把周期写成 1 秒
 * 变成对源站的压测。
 *
 * ## 为什么后来不再统一，而是按隧道率分档（2026-11）
 *
 * "统一压到 15 分钟"只解决了"欠采样"，没解决"采样到哪里"。
 *
 * 订阅能用的节点被 `connect_ok IS TRUE` 卡死：全库 1,125 个 HEALTHY 里只有
 * 227 个能建 CONNECT 隧道。这批"被判不可用"的节点在**空闲条件下以并发 8
 * 复核**仍然只有 3/76（4%）能建隧道（`scripts/diag-tunnel.mts`）——
 * 所以 20% 是真值，不是并发压出来的假失败。
 *
 * 隧道率既然是硬约束，源的价值就该按**能产出多少可下发节点**衡量。
 * 实测同一时刻各源的 HEALTHY / 隧道可用，差距是 250 倍：
 *
 *   hideipme-http    18 / 18   100.0%      thespeedx-socks4  148 /  1    0.7%
 *   monosans-socks5   9 /  9   100.0%      iplocate-socks5   174 /  7    4.0%
 *   monosans-socks4   5 /  4    80.0%      hookzof-socks5    167 / 12    7.2%
 *   hideipme-socks5  27 / 20    74.1%      thespeedx-http    152 / 32   21.1%
 *
 * 于是分三档：高隧道率压到 300 秒（下限），低隧道率放宽到 1800 秒。
 * 免费代理存活期是几十分钟量级，同步越慢，抓到的 IP 到探测时活着的越少 ——
 * 对 74–100% 的源缩短周期是**直接**增加可用节点；对 4% 的源，缩短周期
 * 只是更快地灌进来一批注定失败的候选。
 */
const SYNC_HOT = 300;
const SYNC_FAST = 900;
const SYNC_SLOW = 1800;

export interface CatalogEntry {
  key: string;
  name: string;
  url: string;
  type: 'GITHUB_REPO' | 'WEB_PAGE' | 'API' | 'CSV_FEED';
  /** 内容格式，决定走哪个抽取器 */
  formatHint: 'text' | 'json' | 'csv';
  /** 纯文本源不带 scheme 时用它兜底 */
  protocolHint: ProxyProtocol;
  trustLevel: number;
  syncIntervalSeconds: number;
  notes: string;
}

export const CATALOG: CatalogEntry[] = [
  // ── TheSpeedX：最大的公开列表之一，按协议分文件，纯 host:port ──
  {
    key: 'thespeedx-http',
    name: 'TheSpeedX · HTTP',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'HTTP',
    trustLevel: 48,
    syncIntervalSeconds: SYNC_HOT,
    notes: '纯 host:port，体量大、更新勤。存活 152 个里 32 个能建隧道（21.1%），绝对值全库第一 —— 隧道率不高但分母大，值得高频同步',
  },
  {
    key: 'thespeedx-socks4',
    name: 'TheSpeedX · SOCKS4',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS4',
    trustLevel: 45,
    syncIntervalSeconds: SYNC_SLOW,
    notes: '⚠ 148 个 HEALTHY 只产出 1 个可用（0.7%）。节点能建 SOCKS4 握手到 80 端口，443 全部失败 —— 占着探测预算和健康计数，产出接近于零，周期已放宽',
  },
  {
    key: 'thespeedx-socks5',
    name: 'TheSpeedX · SOCKS5',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 48,
    syncIntervalSeconds: SYNC_FAST,
    notes: '纯 host:port',
  },

  // ── monosans：带存活检查，体量小但质量相对高 ──
  {
    key: 'monosans-http',
    name: 'monosans · HTTP',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'HTTP',
    trustLevel: 52,
    syncIntervalSeconds: SYNC_HOT,
    notes: '上游会先做存活检查，条目少但命中率高。实测隧道率 84.6%（33/39），但 URL 现已失效（last_sync_status = FAILED），等上游恢复',
  },
  {
    key: 'monosans-socks4',
    name: 'monosans · SOCKS4',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS4',
    trustLevel: 50,
    syncIntervalSeconds: SYNC_HOT,
    notes: '同上。实测隧道率 80.0%（4/5）—— SOCKS4 这一档里唯一有产出的源',
  },
  {
    key: 'monosans-socks5',
    name: 'monosans · SOCKS5',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 52,
    syncIntervalSeconds: SYNC_HOT,
    notes: '同上。实测隧道率 100%（9/9），条目少但每一个都能下发',
  },

  // ── OpenProxyList：聚合站，单文件体量最大 ──
  {
    key: 'openproxylist-http',
    name: 'OpenProxyList · HTTP',
    url: 'https://openproxylist.xyz/http.txt',
    type: 'WEB_PAGE',
    formatHint: 'text',
    protocolHint: 'HTTP',
    trustLevel: 40,
    syncIntervalSeconds: SYNC_SLOW,
    notes: '聚合源，条数多、重复率高，去重后有效占比低',
  },
  {
    key: 'openproxylist-socks4',
    name: 'OpenProxyList · SOCKS4',
    url: 'https://openproxylist.xyz/socks4.txt',
    type: 'WEB_PAGE',
    formatHint: 'text',
    protocolHint: 'SOCKS4',
    trustLevel: 38,
    syncIntervalSeconds: SYNC_SLOW,
    notes: '聚合源',
  },
  {
    key: 'openproxylist-socks5',
    name: 'OpenProxyList · SOCKS5',
    url: 'https://openproxylist.xyz/socks5.txt',
    type: 'WEB_PAGE',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 40,
    syncIntervalSeconds: SYNC_SLOW,
    notes: '聚合源',
  },

  // ── 其余单协议列表 ──
  {
    key: 'clarketm-http',
    name: 'clarketm · HTTP',
    url: 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'HTTP',
    trustLevel: 42,
    syncIntervalSeconds: SYNC_SLOW,
    notes: '更新频率低，条目较少',
  },
  {
    key: 'hookzof-socks5',
    name: 'hookzof · SOCKS5',
    url: 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 45,
    syncIntervalSeconds: SYNC_SLOW,
    notes: '专做 SOCKS5，体量可观。实测 167 个 HEALTHY 只产出 12 个可用（7.2%），周期已放宽',
  },
  {
    key: 'hideipme-http',
    name: 'hideip.me · HTTP',
    url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'HTTP',
    trustLevel: 38,
    syncIntervalSeconds: SYNC_HOT,
    notes: 'host:port:国家 三段格式，抽取时会丢掉国家标注。实测隧道率 100%（18/18）—— 条目少但全部可下发，是全库性价比最高的源',
  },
  {
    key: 'hideipme-socks5',
    name: 'hideip.me · SOCKS5',
    url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 38,
    syncIntervalSeconds: SYNC_HOT,
    notes: 'host:port:国家 三段格式。实测隧道率 74.1%（20/27），全库第二高的绝对可用数',
  },

  // ── 2026-11 扩源评估新增 ──
  //
  // 对 21 个候选源各抽 24 条走真实探测链（scripts/diag-candidates.mts），
  // 只把**实测能建隧道**的加进来。判据是隧道率而不是存活率：`success=true`
  // 只说明端口活着，只有 `connect_ok=true` 才说明它能在 Clash 里转发。
  //
  // 结果只有两支达标，其余全部落选，落选原因值得记下来：
  //   · zloi-http / zloi-socks5 —— **已经是目录里的 hideipme-http / hideipme-socks5**
  //     （同一个 GitHub 仓库 zloi-user/hideip.me），重复收录只会造成两条源抢同一批 IP
  //   · mmpx12 / shiftytr / roosterkid —— 库里已有 AI 发现流程建的 `ai-gh-*` 源，同样重复
  //   · proxyscrape-v4-* —— 与内置 proxyscrape-http/socks5 是同一个 API，只是 format 参数不同
  //   · ercin-http(65536 条) / muronpig-http(101628 条) —— 条目极多但隧道率 0%。
  //     **条目数不等于价值**，这两支是反例：10 万条里 24 条抽样没有一个能转发
  //   · vakhov-socks5(4.8%) / mmpx12-http(4.2%) —— 有产出但太低，加进来只会摊薄探测预算
  //   · proxylist.download / openproxy.space —— 502/521，源站已挂
  //
  // 一条后话：proxylistto-socks5 加进来之后跑了全量探测，0/107 存活，
  // 与抽样的 5/24 完全相反。抽样 24 条时"有 1 个能建隧道"和"一个都没有"
  // 只差一次投硬币 —— 24 条样本对 4% 这种量级的比例没有任何分辨力。
  // 结论：小样本只够用来**排除明显无效的源**（0/24 就别要了），
  // 不足以确认一个源可用；确认必须靠全量。这个源已停用。
  {
    key: 'iplocate-socks5',
    name: 'iplocate · SOCKS5',
    url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 40,
    syncIntervalSeconds: SYNC_SLOW,
    notes:
      '⚠ 上一轮按 24 条抽样（存活 13、隧道 3）加进来，并写下"产出最高的一支"—— ' +
      '全量跑完是 7/174（4.0%），那句话是错的。它现在是全库最大的死重：' +
      '174 个 HEALTHY 占着探测预算，只换 7 个可用节点。周期已放宽到 30 分钟，' +
      '保留条目因为隧道率 4% 不算零，且它的条目数在变。',
  },
  {
    key: 'proxylistto-socks5',
    name: 'proxylist.to · SOCKS5',
    url: 'https://raw.githubusercontent.com/proxylist-to/proxy-list/main/socks5.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 38,
    syncIntervalSeconds: SYNC_FAST,
    notes:
      '⚠ 全量探测 0/107 存活，已停用。24 条抽样曾测到 5 活 1 隧道（4.2%），' +
      '是抽样运气 —— 这也是"小样本别下结论"的实例。保留条目以便日后复查',
  },

  // ── API 型 ──
  {
    key: 'proxyscrape-http',
    name: 'ProxyScrape · HTTP',
    url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text',
    type: 'API',
    formatHint: 'text',
    protocolHint: 'HTTP',
    trustLevel: 42,
    syncIntervalSeconds: SYNC_FAST,
    notes: '返回带 scheme 的行，免费额度有速率限制',
  },
  {
    key: 'proxyscrape-socks5',
    name: 'ProxyScrape · SOCKS5',
    url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=text',
    type: 'API',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 42,
    syncIntervalSeconds: SYNC_FAST,
    notes: '同上',
  },
  {
    key: 'geonode-json',
    name: 'Geonode · JSON',
    url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc',
    type: 'API',
    formatHint: 'json',
    protocolHint: 'HTTP',
    trustLevel: 40,
    syncIntervalSeconds: SYNC_FAST,
    notes: 'JSON，每条带协议数组与国家；单页 500 条',
  },

  // ── CSV：一份文件覆盖全部协议 ──
  {
    key: 'proxifly-csv',
    name: 'proxifly · 全协议 CSV',
    url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.csv',
    type: 'CSV_FEED',
    formatHint: 'csv',
    protocolHint: 'HTTP',
    trustLevel: 50,
    syncIntervalSeconds: SYNC_FAST,
    notes: 'socks5://ip:port,US,City 形式，单文件含全部协议，体量最大',
  },
];

export const catalogByKey = (key: string): CatalogEntry | undefined =>
  CATALOG.find((c) => c.key === key);
