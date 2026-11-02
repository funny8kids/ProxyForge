import type { ProxyProtocol, SubscriptionNodeFilter } from '@proxyforge/contracts';
import type { ExportProxy } from './render.js';

/**
 * 订阅节点过滤与命名。
 *
 * 解决的问题很具体：一个池子里的节点质量差异极大 —— 同一批公开代理里既有
 * 20ms 的 SOCKS5，也有 3s 才握手成功的 HTTP。用户拿到一份 200 节点的配置，
 * 客户端 url-test 要跑几分钟，还不一定能选到能用的那个。
 *
 * 过滤发生在**取数之后、渲染之前**，是纯函数。这样：
 *   · 四种导出格式看到的节点集合必然一致（同一份 ExportProxy[]）
 *   · 内容指纹能覆盖过滤条件 —— 改了过滤条件，revision 会正常递增
 */

export type NodeFilter = SubscriptionNodeFilter;

const PROTOCOLS: ProxyProtocol[] = ['HTTP', 'HTTPS_CONNECT', 'SOCKS4', 'SOCKS5'];

/**
 * 单份订阅的节点数上限。
 *
 * 定在 500 而不是 200：实验池容量已经提到 300，上限若还是 200，
 * 池里有 100 个成员永远发不出去，而界面上"池 300 个成员 / 订阅 200 个节点"
 * 两个数字都"没错"，只是对不上 —— 这种不一致最难排查。
 *
 * 500 仍然远小于"整池全发"的量级：mihomo 加载几百个节点是常态，
 * 但上千个会让客户端启动时的 url-test 拖到几十秒。
 */
export const DEFAULT_MAX_NODES = 500;

function asProtocolList(v: unknown): ProxyProtocol[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<ProxyProtocol>();
  for (const item of v) {
    const p = String(item).trim().toUpperCase() as ProxyProtocol;
    if (PROTOCOLS.includes(p)) seen.add(p);
  }
  return [...seen];
}

function asNumber(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * 国家码归一化。
 *
 * 只接受两位字母，统一大写。`country_code` 在库里是 `char(2)`，
 * 而用户手写配置时经常是 `jp`、`JP`、`Jp` 混着来 —— 大小写不一致会让
 * 白名单静默匹配不上（订阅发出去 0 个节点，却不报任何错）。
 *
 * 三字母（`JPN`）直接丢弃而不是猜：猜错会把用户送到另一个国家，
 * 而订阅里节点名写着国家码，他不会想到是过滤条件写错了。
 */
function asCountryList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const item of v) {
    const code = String(item).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) seen.add(code);
  }
  return [...seen].slice(0, 60);
}

/**
 * 归一化过滤条件。
 *
 * 未知字段一律丢弃而不是报错：前端版本可能比后端新，多传一个字段就 400
 * 是很糟的体验。但**已知字段的非法值**必须被夹到合法范围，
 * 否则 `maxNodes: 100000` 会让一份订阅把整池节点全吐出去。
 */
export function normalizeNodeFilter(raw: unknown): NodeFilter {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: NodeFilter = {};

  const protocols = asProtocolList(r['protocols']);
  if (protocols.length) out.protocols = protocols;

  const exclude = asProtocolList(r['excludeProtocols']);
  if (exclude.length) out.excludeProtocols = exclude;

  const minQuality = asNumber(r['minQuality'], 0, 100);
  if (minQuality !== undefined && minQuality > 0) out.minQuality = minQuality;

  const maxLatency = asNumber(r['maxLatencyMs'], 0, 120_000);
  if (maxLatency !== undefined && maxLatency > 0) out.maxLatencyMs = maxLatency;

  if (Array.isArray(r['excludeHosts'])) {
    const hosts = r['excludeHosts']
      .map((h) => String(h).trim().toLowerCase())
      .filter((h) => h.length >= 2 && h.length <= 128);
    if (hosts.length) out.excludeHosts = [...new Set(hosts)].slice(0, 20);
  }

  const maxNodes = asNumber(r['maxNodes'], 1, DEFAULT_MAX_NODES);
  if (maxNodes !== undefined) out.maxNodes = Math.floor(maxNodes);

  const countries = asCountryList(r['countries']);
  if (countries.length) out.countries = countries;

  const excludeCountries = asCountryList(r['excludeCountries']);
  if (excludeCountries.length) out.excludeCountries = excludeCountries;

  return out;
}

export interface FilterableEndpoint {
  protocol: ProxyProtocol;
  host: string;
  quality_score: string | number;
  p50_ms: number | null;
  /** 出口国家，ISO 3166-1 alpha-2；未探测出出口 IP 时为 null */
  country_code?: string | null;
}

/**
 * 剔除**已判定不能建 CONNECT 隧道**的节点。
 *
 * 这不是偏好问题，是能力问题：现代网站几乎全是 HTTPS，一个能转发明文
 * HTTP、却建不起隧道的节点，在客户端里只会表现为"已连接、延迟 80ms，
 * 但所有网站打不开"。实测 6 个这类节点：用 http 探测 4 个返回 204，
 * 用 https 探测 6 个全部失败。
 *
 * 为什么必须在服务端剔除而不是靠排序：订阅是一次性快照，客户端拿到
 * 几百个节点后 url-test 会挨个测。把它们排在最后只是让测速更慢，
 * 并不会让它们消失 —— 而它们一旦被选中，用户看到的就是故障。
 *
 * 两条边界：
 *   · `connect_ok IS NULL`（还没测过）**保留** —— 未知不等于不能用
 *   · 如果过滤后为空，退回原集合 —— 空订阅在客户端里表现为"加载失败"，
 *     比发一批坏节点更糟
 */
export function excludeTunnelIncapable<T extends { connect_ok: boolean | null }>(rows: T[]): T[] {
  const capable = rows.filter((r) => r.connect_ok !== false);
  return capable.length > 0 ? capable : rows;
}

/**
 * 应用过滤条件。
 *
 * 协议白名单与黑名单同时给出时，白名单先算 —— 黑名单只用来从白名单里剔。
 * 这个顺序让「只要 SOCKS5，但排除某个实验性来源」这类组合能表达，
 * 反过来则说不通。
 */
export function applyNodeFilter<T extends FilterableEndpoint>(rows: T[], filter: NodeFilter): T[] {
  const allow = filter.protocols && filter.protocols.length ? new Set(filter.protocols) : null;
  const deny = new Set(filter.excludeProtocols ?? []);
  const hosts = filter.excludeHosts ?? [];
  const allowCountry = filter.countries && filter.countries.length ? new Set(filter.countries) : null;
  const denyCountry = new Set(filter.excludeCountries ?? []);

  const kept = rows.filter((r) => {
    if (allow && !allow.has(r.protocol)) return false;
    if (deny.has(r.protocol)) return false;
    if (filter.minQuality !== undefined && Number(r.quality_score) < filter.minQuality) return false;
    if (filter.maxLatencyMs !== undefined) {
      // 从未探测成功过的节点 p50_ms 是 null。放进"限延迟"的订阅里没有意义 ——
      // 用户要的是快，不是"不知道快不快"。
      if (r.p50_ms === null) return false;
      if (r.p50_ms > filter.maxLatencyMs) return false;
    }
    if (hosts.length) {
      const h = r.host.toLowerCase();
      if (hosts.some((p) => h.includes(p))) return false;
    }
    // 国家过滤对「未知」的处理是排除而不是放行：用户写 `countries: [JP]`
    // 是明确要日本节点，一个还没探出出口 IP 的节点不能算作"可能是日本"。
    // 反过来，黑名单里的未知节点仍然放行 —— 用户说"不要中国节点"，
    // 不代表他要"只要已知非中国的节点"。
    if (allowCountry) {
      if (!r.country_code || !allowCountry.has(r.country_code)) return false;
    }
    if (denyCountry.size > 0 && r.country_code && denyCountry.has(r.country_code)) return false;
    return true;
  });

  const limit = filter.maxNodes ?? DEFAULT_MAX_NODES;
  return kept.slice(0, limit);
}

/**
 * 命名模板。
 *
 * 支持的占位符：`{index}` `{protocol}` `{host}` `{port}` `{pool}` `{country}`。
 * 不支持的占位符原样保留 —— 与其悄悄吞掉用户写错的 `{region}`，
 * 不如让他在节点名里看见它。
 *
 * `{country}` 在没有出口国家时退化成 `??` 而不是空串：空串会让
 * `pf-JP-01` 变成 `pf--01`，而 `??` 一眼就能看出这个节点还没探出地区。
 *
 * 模板可以是空串（沿用默认 `pf-01`）。空模板不会产出空名字：
 * 客户端里出现一个名字为空的节点，界面上就是个无法点选的空白行。
 */
export function applyNameTemplate(
  proxies: ExportProxy[],
  template: string | null | undefined,
  poolKey: string,
): ExportProxy[] {
  const tpl = (template ?? '').trim();
  if (!tpl) return proxies;

  const used = new Map<string, number>();
  return proxies.map((p, i) => {
    const index = String(i + 1).padStart(2, '0');
    let name = tpl
      .replace(/\{index\}/g, index)
      .replace(/\{protocol\}/g, p.protocol.toLowerCase())
      .replace(/\{host\}/g, p.server)
      .replace(/\{port\}/g, String(p.port))
      .replace(/\{country\}/g, p.country ?? '??')
      .replace(/\{pool\}/g, poolKey);

    // mihomo 遇到重名节点会直接拒绝加载整份配置。
    // 模板里只写 `{protocol}` 时重名是必然的，所以这里兜一层后缀。
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    if (n > 0) name = `${name} #${n + 1}`;

    return { ...p, name };
  });
}
