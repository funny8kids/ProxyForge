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
 */
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
    syncIntervalSeconds: 3600,
    notes: '纯 host:port，体量大、更新勤，存活率中等',
  },
  {
    key: 'thespeedx-socks4',
    name: 'TheSpeedX · SOCKS4',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS4',
    trustLevel: 45,
    syncIntervalSeconds: 3600,
    notes: '纯 host:port',
  },
  {
    key: 'thespeedx-socks5',
    name: 'TheSpeedX · SOCKS5',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 48,
    syncIntervalSeconds: 3600,
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
    syncIntervalSeconds: 1800,
    notes: '上游会先做存活检查，条目少但命中率高',
  },
  {
    key: 'monosans-socks4',
    name: 'monosans · SOCKS4',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS4',
    trustLevel: 50,
    syncIntervalSeconds: 1800,
    notes: '同上',
  },
  {
    key: 'monosans-socks5',
    name: 'monosans · SOCKS5',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 52,
    syncIntervalSeconds: 1800,
    notes: '同上',
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
    syncIntervalSeconds: 7200,
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
    syncIntervalSeconds: 7200,
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
    syncIntervalSeconds: 7200,
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
    syncIntervalSeconds: 7200,
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
    syncIntervalSeconds: 3600,
    notes: '专做 SOCKS5，体量可观',
  },
  {
    key: 'hideipme-http',
    name: 'hideip.me · HTTP',
    url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'HTTP',
    trustLevel: 38,
    syncIntervalSeconds: 3600,
    notes: 'host:port:国家 三段格式，抽取时会丢掉国家标注',
  },
  {
    key: 'hideipme-socks5',
    name: 'hideip.me · SOCKS5',
    url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt',
    type: 'GITHUB_REPO',
    formatHint: 'text',
    protocolHint: 'SOCKS5',
    trustLevel: 38,
    syncIntervalSeconds: 3600,
    notes: 'host:port:国家 三段格式',
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
    syncIntervalSeconds: 3600,
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
    syncIntervalSeconds: 3600,
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
    syncIntervalSeconds: 3600,
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
    syncIntervalSeconds: 1800,
    notes: 'socks5://ip:port,US,City 形式，单文件含全部协议，体量最大',
  },
];

export const catalogByKey = (key: string): CatalogEntry | undefined =>
  CATALOG.find((c) => c.key === key);
