import type { ProxyProtocol } from '@proxyforge/contracts';

/**
 * 订阅导出渲染器。
 *
 * 之前只有一个 `renderMihomo`，`subscriptions.format` 这一列存了却从不读取 ——
 * 建订阅时选 clash 还是 singbox，产出的都是同一份 YAML。这里把格式真正接通。
 *
 * 四种格式各自的用途：
 *   · mihomo / clash —— YAML 整份配置，Clash Verge / FlClash / Mihomo Party / OpenClash
 *   · singbox       —— JSON 整份配置，sing-box 内核；Clash Verge Rev 与 FlClash 也能读
 *   · base64        —— 多行 URI 的 base64，v2rayN / Shadowrocket / 通用订阅格式
 *   · plain         —— 明文 URI 列表，人工查看或粘到别处
 *
 * 一个刻意的取舍：**所有格式都由同一份 `ProxyPayload[]` 渲染**，不在渲染器里
 * 重新查库或过滤。这样四种导出的节点集合必然一致，不会出现「Clash 里有 48 个、
 * sing-box 里只有 46 个」这种没法解释的差异。
 */

export type ExportFormat = 'mihomo' | 'clash' | 'singbox' | 'base64' | 'plain' | 'clash-provider';

export const EXPORT_FORMATS: ExportFormat[] = [
  'mihomo', 'clash', 'singbox', 'base64', 'plain', 'clash-provider',
];

/** 带凭据的节点。protocol 保留原始枚举，各渲染器自己映射。 */
export interface ExportProxy {
  name: string;
  protocol: ProxyProtocol;
  server: string;
  port: number;
  username?: string;
  password?: string;
  /**
   * 出口国家（ISO 3166-1 alpha-2）。用于命名模板的 `{country}` 占位符。
   *
   * 刻意**不写进 YAML 的节点字段**：mihomo 没有 country 字段，写进去会被
   * 当成未知键。用户要按地区分组，只能靠节点名里带国家码 ——
   * 所以 `{country}` 的作用就是让名字里带上它。
   */
  country?: string | null;
}

export interface Rendered {
  body: string;
  contentType: string;
  /** 下载时的文件扩展名 */
  extension: string;
  format: ExportFormat;
}

/**
 * 分流模式。
 *
 *   global —— 所有流量走代理（默认，最省心）
 *   rule   —— 国内直连、其余走代理（日常最常用）
 *   direct —— 全部直连（排障用：用来判断"是不是代理本身坏了"）
 */
export type RoutingMode = 'global' | 'rule' | 'direct';

export interface RenderOptions {
  routingMode?: RoutingMode;
  /** 追加规则。统一用 mihomo 的 `TYPE,VALUE,ACTION` 行语法，两种格式都能转 */
  extraRules?: string[];
}

/**
 * rule 模式的内建规则。
 *
 * 顺序有意义：域名后缀优先于 GEOIP —— GEOIP 需要先解析出 IP，
 * 而 `DOMAIN-SUFFIX,cn` 在 DNS 阶段就能分流，少一次查询。
 * 内网段全部带 `no-resolve`，否则客户端会为了匹配 IP 规则去解析内网域名，
 * 在没有 DNS 的环境下每次请求都要等超时。
 */
const RULE_MODE_RULES = [
  'DOMAIN-SUFFIX,cn,DIRECT',
  'GEOIP,CN,DIRECT',
  'DOMAIN-SUFFIX,local,DIRECT',
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
];

// ─────────────────────────────────────────────────────────────
// 规则行解析
// ─────────────────────────────────────────────────────────────

/**
 * 规则动作。
 *
 * 只有三种。用户手写的 `PROXY` / `节点选择` / `自动选择` 之类一律归到 `PROXY`，
 * 因为一份订阅里只有一个组 —— 让用户随手写组名，写错就是客户端整份配置
 * 加载失败，而报错信息通常只说"proxy group not found"，定位不到是哪条规则。
 * 归一化之后，写错的规则最多是"没按预期分流"，不会让配置打不开。
 */
type RuleAction = 'DIRECT' | 'REJECT' | 'PROXY';

interface ParsedRule {
  type: string;
  value: string;
  action: RuleAction;
  noResolve: boolean;
}

function actionOf(raw: string | undefined): RuleAction {
  const k = (raw ?? '').trim().toUpperCase();
  if (k === 'DIRECT') return 'DIRECT';
  if (k === 'REJECT' || k === 'REJECT-DROP' || k === 'REJECT-TINYGIF') return 'REJECT';
  return 'PROXY';
}

/**
 * 解析一行 mihomo 语法规则。
 *
 * 刻意**不做白名单校验**：合法规则类型随内核版本增长，写死白名单会让新语法
 * 在订阅里静默消失。这里只拦掉不可能被解析的行（空行、注释、缺值），
 * 其余交给下游 —— mihomo 自己认识就生效，sing-box 不认识的会记进
 * `_proxyforge.ignoredRules` 而不是被无声丢弃。
 */
function parseRule(line: string): ParsedRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(',').map((s) => s.trim());
  const type = (parts[0] ?? '').toUpperCase();
  if (!type) return null;
  // MATCH 没有值段：`MATCH,PROXY`
  if (type === 'MATCH') return { type, value: '', action: actionOf(parts[1]), noResolve: false };
  const value = parts[1] ?? '';
  if (!value) return null;
  return {
    type,
    value,
    action: actionOf(parts[2]),
    noResolve: parts.slice(2).some((p) => p.toLowerCase() === 'no-resolve'),
  };
}

/**
 * 组装最终规则表。
 *
 * 用户规则在前、内建规则在后、`MATCH` 收尾 —— 这是唯一能保证
 * "用户想覆盖的能覆盖、没覆盖的走默认"的顺序。direct 模式下同样保留用户规则：
 * 用户既然写了规则，说明有明确意图，不该被模式开关吞掉。
 */
function buildRules(poolKey: string, routingMode: RoutingMode, extraRules: string[]): ParsedRule[] {
  const user = extraRules.map(parseRule).filter((r): r is ParsedRule => r !== null);
  const tail: ParsedRule[] =
    routingMode === 'direct'
      ? [{ type: 'MATCH', value: '', action: 'DIRECT', noResolve: false }]
      : routingMode === 'rule'
        ? [
            ...RULE_MODE_RULES.map(parseRule).filter((r): r is ParsedRule => r !== null),
            { type: 'MATCH', value: '', action: 'PROXY', noResolve: false },
          ]
        : [{ type: 'MATCH', value: '', action: 'PROXY', noResolve: false }];
  return [...user, ...tail];
}

function isRoutingMode(v: unknown): v is RoutingMode {
  return v === 'global' || v === 'rule' || v === 'direct';
}

export function normalizeRoutingMode(v: unknown, fallback: RoutingMode = 'global'): RoutingMode {
  return isRoutingMode(v) ? v : fallback;
}

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (EXPORT_FORMATS as string[]).includes(v);
}

/**
 * 归一化格式名。`clash` 和 `mihomo` 是同一种 YAML —— Clash 停更后
 * 社区内核叫 Mihomo，字段完全兼容。保留两个名字只是为了界面上不让人困惑。
 */
export function normalizeFormat(v: string | null | undefined, fallback: ExportFormat = 'mihomo'): ExportFormat {
  if (!v) return fallback;
  const s = v.trim().toLowerCase();
  if (s === 'clash' || s === 'mihomo' || s === 'yaml') return s === 'clash' ? 'clash' : 'mihomo';
  if (s === 'singbox' || s === 'sing-box' || s === 'json') return 'singbox';
  if (s === 'base64' || s === 'b64') return 'base64';
  if (s === 'plain' || s === 'txt' || s === 'text') return 'plain';
  // provider 只出节点列表，供 mihomo 的 proxy-providers 引用。
  // 接受几个常见叫法，避免前端传 `provider` 时静默退化成整份配置 ——
  // 那会让用户以为拿到了片段，实际又覆盖了一次他的 config.yaml。
  if (s === 'clash-provider' || s === 'provider' || s === 'mihomo-provider') return 'clash-provider';
  return fallback;
}

export function renderSubscription(
  format: ExportFormat,
  poolKey: string,
  proxies: ExportProxy[],
  generatedAt = new Date().toISOString(),
  options: RenderOptions = {},
): Rendered {
  const routingMode = normalizeRoutingMode(options.routingMode);
  const extraRules = options.extraRules ?? [];
  switch (format) {
    case 'singbox':
      return {
        body: renderSingBox(poolKey, proxies, generatedAt, routingMode, extraRules),
        contentType: 'application/json; charset=utf-8',
        extension: 'json',
        format,
      };
    case 'base64':
      return {
        body: renderBase64(proxies),
        contentType: 'text/plain; charset=utf-8',
        extension: 'txt',
        format,
      };
    case 'plain':
      return {
        body: renderPlain(poolKey, proxies, generatedAt),
        contentType: 'text/plain; charset=utf-8',
        extension: 'txt',
        format,
      };
    case 'clash-provider':
      return {
        body: renderMihomoProvider(poolKey, proxies, generatedAt),
        contentType: 'text/yaml; charset=utf-8',
        extension: 'yaml',
        format,
      };
    case 'clash':
    case 'mihomo':
    default:
      return {
        body: renderMihomo(poolKey, proxies, generatedAt, routingMode, extraRules),
        contentType: 'text/yaml; charset=utf-8',
        extension: 'yaml',
        format,
      };
  }
}

// ─────────────────────────────────────────────────────────────
// Mihomo / Clash YAML
// ─────────────────────────────────────────────────────────────

const MIHOMO_TYPE: Record<ProxyProtocol, string> = {
  HTTP: 'http',
  HTTPS_CONNECT: 'http',
  SOCKS4: 'socks4',
  SOCKS5: 'socks5',
};

/**
 * YAML 标量安全输出。
 *
 * 节点名和密码来自外部数据，`pf-01` 这种当然没问题，但密码里出现 `:` `#` `@`
 * 或以 `-` 开头时，各解析器对 plain scalar 的处理并不一致 —— 保守起见一律加引号。
 * 客户端遇到这类问题的报错通常只有一句"配置格式错误"，根本定位不到哪一行。
 *
 * 反过来，`1.2.3.4` 这种 IP **不能**被数字规则误伤：
 * 数字字面量正则必须限制成最多一个小数点，否则每个 IPv4 都会变成 `server: "1.2.3.4"`。
 */
function yamlQuoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlScalar(value: string): string {
  if (value === '') return '""';
  const quote = yamlQuoted;

  // 整数/浮点字面量：`8080` 会被解析成 int，`1.5` 成 float，
  // 而它们在这里的语义是字符串（主机名、密码）
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return quote(value);
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return quote(value);

  // 空白、引号、注释符、锚点、流式标点、转义符 —— 任一出现就加引号
  if (/[\s:#@&*!|>'"`{}\[\],\\%]/.test(value) || /^[-?]/.test(value)) return quote(value);

  return value;
}

/**
 * 节点条目序列化。
 *
 * 抽出来是因为「整份配置」和「provider 片段」两种输出必须给出**完全一样**的
 * 节点块。各写一份的后果不是编译错误，而是两处慢慢分叉：某天给整份配置加了
 * `udp: true`，provider 里没有 —— 同一批节点在不同用法下行为不一致，
 * 而用户只会觉得"这个订阅有时候好使有时候不好使"。
 */
function proxyEntries(proxies: ExportProxy[]): string[] {
  const lines: string[] = [];
  for (const p of proxies) {
    lines.push(`  - name: ${yamlScalar(p.name)}`);
    lines.push(`    type: ${MIHOMO_TYPE[p.protocol]}`);
    lines.push(`    server: ${yamlScalar(p.server)}`);
    lines.push(`    port: ${p.port}`);
    // socks4 不支持用户名密码，写进去某些内核会直接报错
    if (p.username && p.protocol !== 'SOCKS4') lines.push(`    username: ${yamlScalar(p.username)}`);
    if (p.password && p.protocol !== 'SOCKS4') lines.push(`    password: ${yamlScalar(p.password)}`);
  }
  return lines;
}

/**
 * 健康检查目标。
 *
 * 必须是 https，不能是 http —— 这里踩过一次真实的坑：
 * 探针判定 `connect_ok = false` 的节点（能转发明文 HTTP、但建不起
 * CONNECT 隧道）用 `http://` 探测照样返回 204，于是被 url-test 判为
 * 健康并选中；用户打开任何 https 站点立刻失败，而客户端界面还显示
 * "已连接、延迟 80ms"。
 *
 * 判据必须和「能用」的定义一致：一个节点算健康，前提是它能把 TLS
 * 流量转发出去。代价是纯明文代理会全部测红 —— 但那类节点对现代网站
 * 本来就没有使用价值，测红是如实反映，不是误判。
 */
const HEALTH_CHECK_URL = 'https://www.gstatic.com/generate_204';

/**
 * 健康检查间隔（秒）。
 *
 * 公开代理池里的节点存活期常常只有几分钟，间隔太长会让「当前节点已死」
 * 这件事迟迟反映不到组状态上。压到 180s 是兜底：即使没有任何连接失败
 * 事件，组状态也至少 3 分钟刷新一次。
 *
 * 注意不要把它当成切换延迟 —— 配合下面的 lazy 时，当前节点一旦连接失败
 * 就会立刻触发重新选路，不必等满一个周期。这里的时间只决定
 * 「状态最迟多久变陈旧」。
 */
const HEALTH_CHECK_INTERVAL = 180;

export function renderMihomo(
  poolKey: string,
  proxies: ExportProxy[],
  generatedAt: string,
  routingMode: RoutingMode = 'global',
  extraRules: string[] = [],
): string {
  const lines: string[] = [];
  const rules = buildRules(poolKey, routingMode, extraRules);

  lines.push('# ProxyForge subscription');
  lines.push(`# pool: ${poolKey}`);
  lines.push(`# generated: ${generatedAt}`);
  lines.push(`# nodes: ${proxies.length}`);
  lines.push(`# routing: ${routingMode}`);
  // ── 客户端必须有的入站配置 ──
  // Clash / FlClash 把订阅当**整份配置**用，不是片段。只给 proxies +
  // proxy-groups + rules 的话，加载成功、界面显示"已连接"，但没有任何
  // 监听端口 —— 表现是"配置生效了但上不了网"，极难排查。
  // allow-lan 必须保持 false：这是公开代理池，别把监听器开到局域网上。
  lines.push('mixed-port: 7890');
  lines.push('allow-lan: false');
  // mode 恒为 rule：三种分流档位的差异全部落在规则表上，不靠 mode 开关。
  // 用 mode: direct 会让用户自写的规则一并失效，语义反而更含糊。
  lines.push('mode: rule');
  lines.push('log-level: warning');
  lines.push('ipv6: false');

  // DNS 只在 rule 模式下有意义：GEOIP 规则要先解析域名。
  // global 模式全量走代理，DNS 交给远端就行，多写一段只会多一处出错的地方。
  if (routingMode === 'rule') {
    lines.push('dns:');
    lines.push('  enable: true');
    lines.push('  ipv6: false');
    // fake-ip：域名不落真实 IP，避免国内 DNS 污染影响 GEOIP 判定
    lines.push('  enhanced-mode: fake-ip');
    lines.push('  fake-ip-range: 198.18.0.1/16');
    lines.push('  default-nameserver:');
    lines.push('    - 223.5.5.5');
    lines.push('    - 119.29.29.29');
    lines.push('  nameserver:');
    lines.push('    - https://dns.alidns.com/dns-query');
    lines.push('    - https://doh.pub/dns-query');
    lines.push('  fallback:');
    lines.push('    - https://1.1.1.1/dns-query');
    lines.push('    - https://dns.google/dns-query');
  }

  if (proxies.length === 0) {
    lines.push('# pool is empty');
    lines.push('proxies: []');
    lines.push('proxy-groups:');
    lines.push(`  - name: ${yamlScalar(poolKey)}`);
    lines.push('    type: select');
    lines.push('    proxies: []');
    lines.push('rules:');
    // 空池不能 MATCH 到组：组里没有成员，客户端会一直转圈。
    // 直连至少让人能用这份配置上网，同时一眼看出"池子是空的"。
    lines.push('  - MATCH,DIRECT');
    return `${lines.join('\n')}\n`;
  }

  lines.push('proxies:');
  lines.push(...proxyEntries(proxies));

  lines.push('proxy-groups:');
  lines.push(`  - name: ${yamlScalar(poolKey)}`);
  lines.push('    type: url-test');
  lines.push(`    url: ${HEALTH_CHECK_URL}`);
  lines.push(`    interval: ${HEALTH_CHECK_INTERVAL}`);
  // lazy：只有真正被选中的成员才测。池里几十个节点时，
  // 全量 url-test 会让客户端启动阶段连发几十个请求。
  lines.push('    lazy: true');
  lines.push('    proxies:');
  for (const p of proxies) lines.push(`      - ${yamlScalar(p.name)}`);

  lines.push('rules:');
  for (const r of rules) {
    // 整行加引号：规则值里可能出现逗号（用户手写），
    // 而 `MATCH,"a,b"` 这种半引用是坏 YAML —— 要么整行引用，要么不引用。
    lines.push(`  - ${yamlQuoted(mihomoRuleLine(r, poolKey))}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * mihomo proxy-provider 片段。
 *
 * 只输出 `proxies:` 一个顶层键 —— 这是 provider 文件的全部约定。
 * 刻意不带 mixed-port / dns / rules：那些属于用户自己的 config.yaml。
 * 在这里也写一遍的后果是，用户每次更新订阅都会把自己调好的 DNS 与分流
 * 覆盖回默认值，而且覆盖是静默的 —— 他不会看到任何提示，只会觉得
 * "怎么过一段时间规则就乱了"。
 *
 * 文件头的用法注释也是刻意留的：拿到一份只有 proxies 的 YAML，
 * 绝大多数人第一反应是"这配置不完整，导入报错"，然后来问为什么。
 * 把正确的引用方式直接写在文件里，比写在文档里有用得多。
 */
export function renderMihomoProvider(
  poolKey: string,
  proxies: ExportProxy[],
  generatedAt: string,
): string {
  const providerKey = poolKey.toLowerCase();
  const lines: string[] = [];
  lines.push('# ProxyForge proxy provider');
  lines.push(`# pool: ${poolKey}`);
  lines.push(`# generated: ${generatedAt}`);
  lines.push(`# nodes: ${proxies.length}`);
  lines.push('#');
  lines.push('# 这不是一份完整的 Clash 配置，只包含节点列表。');
  lines.push('# 在你自己 config.yaml 的 proxy-providers 下引用本订阅地址：');
  lines.push('#');
  lines.push('#   proxy-providers:');
  lines.push(`#     ${providerKey}:`);
  lines.push('#       type: http');
  lines.push('#       url: "<本订阅地址>"');
  lines.push('#       interval: 3600');
  lines.push(`#       path: ./providers/${providerKey}.yaml`);
  lines.push('#       health-check:');
  lines.push('#         enable: true');
  lines.push(`#         url: ${HEALTH_CHECK_URL}`);
  lines.push(`#         interval: ${HEALTH_CHECK_INTERVAL}`);
  lines.push('#');
  lines.push(`# 然后在 proxy-groups 里用 "use: [${providerKey}]" 引用它。`);
  lines.push('#');
  lines.push('# 公开代理：可用性不等于合法性，不要用它们承载生产流量或登录凭据。');

  if (proxies.length === 0) {
    lines.push('proxies: []');
    return `${lines.join('\n')}\n`;
  }

  lines.push('proxies:');
  lines.push(...proxyEntries(proxies));
  return `${lines.join('\n')}\n`;
}

function mihomoRuleLine(r: ParsedRule, poolKey: string): string {
  const action = r.action === 'PROXY' ? poolKey : r.action;
  if (r.type === 'MATCH') return `MATCH,${action}`;
  const suffix = r.noResolve ? ',no-resolve' : '';
  return `${r.type},${r.value},${action}${suffix}`;
}

// ─────────────────────────────────────────────────────────────
// sing-box JSON
// ─────────────────────────────────────────────────────────────

/**
 * sing-box 的 outbound 结构。
 *
 * 注意 `socks` 必须显式写 `version`：sing-box 默认按 5 处理，
 * 而 SOCKS4 节点若不带 version 会被当成 SOCKS5 去握手，必然失败。
 */
function singboxOutbound(p: ExportProxy, tag: string): Record<string, unknown> {
  if (p.protocol === 'SOCKS4' || p.protocol === 'SOCKS5') {
    const o: Record<string, unknown> = {
      type: 'socks',
      tag,
      server: p.server,
      server_port: p.port,
      version: p.protocol === 'SOCKS4' ? '4' : '5',
    };
    if (p.username && p.protocol === 'SOCKS5') o['username'] = p.username;
    if (p.password && p.protocol === 'SOCKS5') o['password'] = p.password;
    return o;
  }
  // HTTP 与 HTTPS_CONNECT 都映射到 http outbound。
  // HTTPS_CONNECT 表示「通过代理建 CONNECT 隧道」，不是「代理本身走 TLS」，
  // 所以这里不加 tls 字段 —— 加了反而会和真实能力不符。
  const o: Record<string, unknown> = {
    type: 'http',
    tag,
    server: p.server,
    server_port: p.port,
  };
  if (p.username) o['username'] = p.username;
  if (p.password) o['password'] = p.password;
  return o;
}

/**
 * mihomo 规则类型 → sing-box 匹配字段。
 *
 * 只覆盖有直接对应关系的。`RULE-SET` / `SRC-IP-SUFFIX` / `AND` 这类
 * 结构上不一样的不做强行映射 —— 映射错了比不映射更糟：配置能加载，
 * 但分流悄悄失效，用户只会觉得"代理偶尔不通"。
 */
const SINGBOX_MATCH: Record<string, string> = {
  DOMAIN: 'domain',
  'DOMAIN-SUFFIX': 'domain_suffix',
  'DOMAIN-KEYWORD': 'domain_keyword',
  'DOMAIN-REGEX': 'domain_regex',
  'IP-CIDR': 'ip_cidr',
  'IP-CIDR6': 'ip_cidr',
  'SRC-IP-CIDR': 'source_ip_cidr',
  'SRC-PORT': 'source_port',
  'DST-PORT': 'port',
  'PROCESS-NAME': 'process_name',
  'PROCESS-PATH': 'process_path',
};

/**
 * 规则表 → sing-box route.rules。
 *
 * `GEOIP` / `GEOSITE` 走 rule_set 而不是 `geoip` 字段：后者在 sing-box 1.12
 * 已被移除，写了等于让配置在新版本上直接起不来。rule_set 的 URL 用
 * SagerNet 官方发布的 .srs，客户端首次启动会下载一次，之后本地缓存。
 */
function singboxRoute(
  rules: ParsedRule[],
  poolKey: string,
  hasProxy: boolean,
): { rules: Record<string, unknown>[]; ruleSets: Record<string, unknown>[]; ignored: string[]; final: string } {
  const out: Record<string, unknown>[] = [];
  const ruleSets: Record<string, unknown>[] = [];
  const ignored: string[] = [];

  const outboundOf = (a: RuleAction): string =>
    a === 'DIRECT' ? 'direct' : a === 'REJECT' ? 'block' : hasProxy ? poolKey : 'direct';

  const ensureSet = (kind: 'geoip' | 'geosite', name: string): string => {
    const tag = `${kind}-${name.toLowerCase()}`;
    if (!ruleSets.some((s) => s['tag'] === tag)) {
      const repo = kind === 'geoip' ? 'sing-geoip' : 'sing-geosite';
      ruleSets.push({
        type: 'remote',
        tag,
        format: 'binary',
        url: `https://raw.githubusercontent.com/SagerNet/${repo}/rule-set/${tag}.srs`,
        // 下载走代理：这两个仓库在部分网络环境下直连不通，
        // 而 rule_set 拉不下来会导致整份配置加载失败。
        download_detour: hasProxy ? poolKey : 'direct',
      });
    }
    return tag;
  };

  let final = hasProxy ? poolKey : 'direct';
  for (const r of rules) {
    if (r.type === 'MATCH') {
      // MATCH 是兜底，落在 route.final 上，不是一条规则
      final = outboundOf(r.action);
      continue;
    }
    const outbound = outboundOf(r.action);
    if (r.type === 'GEOIP' || r.type === 'GEOSITE') {
      const kind = r.type === 'GEOIP' ? 'geoip' : 'geosite';
      out.push({ rule_set: ensureSet(kind, r.value), outbound });
      continue;
    }
    const field = SINGBOX_MATCH[r.type];
    if (!field) {
      ignored.push(`${r.type},${r.value}`);
      continue;
    }
    out.push({ [field]: [r.value], outbound });
  }
  return { rules: out, ruleSets, ignored, final };
}

export function renderSingBox(
  poolKey: string,
  proxies: ExportProxy[],
  generatedAt: string,
  routingMode: RoutingMode = 'global',
  extraRules: string[] = [],
): string {
  const tags = proxies.map((p, i) => p.name || `pf-${String(i + 1).padStart(2, '0')}`);
  const hasProxy = tags.length > 0;

  const outbounds: Record<string, unknown>[] = proxies.map((p, i) => singboxOutbound(p, tags[i]!));

  // 自动选择组 + 手动选择组，两层。
  //
  // 只给 selector 是不够的：几百个节点让用户逐个手点，等于没做选择功能。
  // 只给 urltest 也不行：节点全被自动接管，用户想固定某个出口时无处可设。
  // 两层套起来的语义是「默认自动选优，需要时可手动锁定」——
  // route.final 指向 selector，而 selector 默认指向 urltest。
  //
  // selector 的 outbounds 不能为空数组，否则 sing-box 启动直接报错，
  // 所以这一整块只在 hasProxy 时生成。
  if (hasProxy) {
    const autoTag = `${poolKey}-auto`;
    outbounds.push({
      type: 'urltest',
      tag: autoTag,
      outbounds: tags,
      // 与 mihomo 侧同一个判据：能转发 TLS 才算健康。
      url: HEALTH_CHECK_URL,
      interval: `${HEALTH_CHECK_INTERVAL}s`,
      tolerance: 50,
    });
    outbounds.push({
      type: 'selector',
      tag: poolKey,
      outbounds: [autoTag, ...tags],
      default: autoTag,
    });
  }
  outbounds.push({ type: 'direct', tag: 'direct' });
  outbounds.push({ type: 'block', tag: 'block' });

  const route = singboxRoute(buildRules(poolKey, routingMode, extraRules), poolKey, hasProxy);

  const config = {
    // 注释只能放在自定义字段里：JSON 不支持注释，
    // 而 sing-box 会忽略不认识的顶层键。
    _proxyforge: {
      pool: poolKey,
      generated: generatedAt,
      nodes: proxies.length,
      routing: routingMode,
      // 被丢掉的上游规则要显式列出来。静默丢弃会让"我明明写了规则"变成
      // 一个无从排查的悬案。
      ...(route.ignored.length ? { ignoredRules: route.ignored } : {}),
    },
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [
        {
          tag: 'dns-remote',
          address: 'https://1.1.1.1/dns-query',
          detour: hasProxy && route.final !== 'direct' ? poolKey : 'direct',
        },
      ],
    },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 7890,
      },
    ],
    outbounds,
    route: {
      ...(route.ruleSets.length ? { rule_set: route.ruleSets } : {}),
      rules: route.rules,
      // 池为空时不能指向一个不存在的 selector，否则配置加载即失败
      final: route.final,
      auto_detect_interface: true,
    },
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}

// ─────────────────────────────────────────────────────────────
// URI 列表（plain / base64）
// ─────────────────────────────────────────────────────────────

const URI_SCHEME: Record<ProxyProtocol, string> = {
  HTTP: 'http',
  HTTPS_CONNECT: 'https',
  SOCKS4: 'socks4',
  SOCKS5: 'socks5',
};

/**
 * 单节点 URI。
 *
 * 用户名密码必须做百分号编码：密码里出现 `@` `:` `/` 时，
 * 客户端会在错误的字符处切分，把主机名解析成半截密码。
 */
function proxyUri(p: ExportProxy, index: number): string {
  const scheme = URI_SCHEME[p.protocol];
  let auth = '';
  if (p.username && p.protocol !== 'SOCKS4') {
    auth = `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@`;
  }
  const host = p.server.includes(':') ? `[${p.server}]` : p.server;
  const name = p.name || `pf-${String(index + 1).padStart(2, '0')}`;
  return `${scheme}://${auth}${host}:${p.port}#${encodeURIComponent(name)}`;
}

export function renderPlain(poolKey: string, proxies: ExportProxy[], generatedAt: string): string {
  const lines = [
    `# ProxyForge · ${poolKey}`,
    `# generated: ${generatedAt}`,
    `# nodes: ${proxies.length}`,
    ...proxies.map(proxyUri),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * base64 订阅。
 *
 * 内容里**不带注释行**：v2rayN / Shadowrocket 按行解码，遇到 `#` 开头的行
 * 有的客户端会当成节点名解析失败，有的直接跳过 —— 表现不一致。
 * 只放纯 URI，是这类格式的通行做法。
 */
export function renderBase64(proxies: ExportProxy[]): string {
  const body = proxies.map(proxyUri).join('\n');
  return Buffer.from(body, 'utf8').toString('base64');
}
