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

export const DEFAULT_MAX_NODES = 200;

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

  return out;
}

export interface FilterableEndpoint {
  protocol: ProxyProtocol;
  host: string;
  quality_score: string | number;
  p50_ms: number | null;
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
    return true;
  });

  const limit = filter.maxNodes ?? DEFAULT_MAX_NODES;
  return kept.slice(0, limit);
}

/**
 * 命名模板。
 *
 * 支持的占位符：`{index}` `{protocol}` `{host}` `{port}` `{pool}`。
 * 不支持的占位符原样保留 —— 与其悄悄吞掉用户写错的 `{region}`，
 * 不如让他在节点名里看见它。
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
      .replace(/\{pool\}/g, poolKey);

    // mihomo 遇到重名节点会直接拒绝加载整份配置。
    // 模板里只写 `{protocol}` 时重名是必然的，所以这里兜一层后缀。
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    if (n > 0) name = `${name} #${n + 1}`;

    return { ...p, name };
  });
}
