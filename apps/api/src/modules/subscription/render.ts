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

export type ExportFormat = 'mihomo' | 'clash' | 'singbox' | 'base64' | 'plain';

export const EXPORT_FORMATS: ExportFormat[] = ['mihomo', 'clash', 'singbox', 'base64', 'plain'];

/** 带凭据的节点。protocol 保留原始枚举，各渲染器自己映射。 */
export interface ExportProxy {
  name: string;
  protocol: ProxyProtocol;
  server: string;
  port: number;
  username?: string;
  password?: string;
}

export interface Rendered {
  body: string;
  contentType: string;
  /** 下载时的文件扩展名 */
  extension: string;
  format: ExportFormat;
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
  return fallback;
}

export function renderSubscription(
  format: ExportFormat,
  poolKey: string,
  proxies: ExportProxy[],
  generatedAt = new Date().toISOString(),
): Rendered {
  switch (format) {
    case 'singbox':
      return {
        body: renderSingBox(poolKey, proxies, generatedAt),
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
    case 'clash':
    case 'mihomo':
    default:
      return {
        body: renderMihomo(poolKey, proxies, generatedAt),
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
function yamlScalar(value: string): string {
  if (value === '') return '""';
  const quote = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  // 整数/浮点字面量：`8080` 会被解析成 int，`1.5` 成 float，
  // 而它们在这里的语义是字符串（主机名、密码）
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return quote(value);
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return quote(value);

  // 空白、引号、注释符、锚点、流式标点、转义符 —— 任一出现就加引号
  if (/[\s:#@&*!|>'"`{}\[\],\\%]/.test(value) || /^[-?]/.test(value)) return quote(value);

  return value;
}

export function renderMihomo(poolKey: string, proxies: ExportProxy[], generatedAt: string): string {
  const lines: string[] = [];
  lines.push('# ProxyForge subscription');
  lines.push(`# pool: ${poolKey}`);
  lines.push(`# generated: ${generatedAt}`);
  lines.push(`# nodes: ${proxies.length}`);
  // ── 客户端必须有的入站配置 ──
  // Clash / FlClash 把订阅当**整份配置**用，不是片段。只给 proxies +
  // proxy-groups + rules 的话，加载成功、界面显示"已连接"，但没有任何
  // 监听端口 —— 表现是"配置生效了但上不了网"，极难排查。
  // allow-lan 必须保持 false：这是公开代理池，别把监听器开到局域网上。
  lines.push('mixed-port: 7890');
  lines.push('allow-lan: false');
  lines.push('mode: rule');
  lines.push('log-level: warning');
  lines.push('ipv6: false');

  if (proxies.length === 0) {
    lines.push('# pool is empty');
    lines.push('proxies: []');
    lines.push('proxy-groups:');
    lines.push(`  - name: ${yamlScalar(poolKey)}`);
    lines.push('    type: select');
    lines.push('    proxies: []');
    lines.push('rules:');
    lines.push('  - MATCH,DIRECT');
    return `${lines.join('\n')}\n`;
  }

  lines.push('proxies:');
  for (const p of proxies) {
    lines.push(`  - name: ${yamlScalar(p.name)}`);
    lines.push(`    type: ${MIHOMO_TYPE[p.protocol]}`);
    lines.push(`    server: ${yamlScalar(p.server)}`);
    lines.push(`    port: ${p.port}`);
    // socks4 不支持用户名密码，写进去某些内核会直接报错
    if (p.username && p.protocol !== 'SOCKS4') lines.push(`    username: ${yamlScalar(p.username)}`);
    if (p.password && p.protocol !== 'SOCKS4') lines.push(`    password: ${yamlScalar(p.password)}`);
  }

  lines.push('proxy-groups:');
  lines.push(`  - name: ${yamlScalar(poolKey)}`);
  lines.push('    type: url-test');
  lines.push('    url: http://www.gstatic.com/generate_204');
  lines.push('    interval: 300');
  // lazy：只有真正被选中的成员才测。池里几十个节点时，
  // 全量 url-test 会让客户端启动阶段连发几十个请求。
  lines.push('    lazy: true');
  lines.push('    proxies:');
  for (const p of proxies) lines.push(`      - ${yamlScalar(p.name)}`);
  lines.push('rules:');
  lines.push(`  - MATCH,${yamlScalar(poolKey)}`);
  return `${lines.join('\n')}\n`;
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

export function renderSingBox(poolKey: string, proxies: ExportProxy[], generatedAt: string): string {
  const tags = proxies.map((p, i) => p.name || `pf-${String(i + 1).padStart(2, '0')}`);

  const outbounds: Record<string, unknown>[] = proxies.map((p, i) => singboxOutbound(p, tags[i]!));

  // selector 不能为空数组，否则 sing-box 启动直接报错。
  if (tags.length > 0) {
    outbounds.push({
      type: 'selector',
      tag: poolKey,
      outbounds: tags,
      default: tags[0],
    });
  }
  outbounds.push({ type: 'direct', tag: 'direct' });
  outbounds.push({ type: 'block', tag: 'block' });

  const config = {
    // 注释只能放在自定义字段里：JSON 不支持注释，
    // 而 sing-box 会忽略不认识的顶层键。
    _proxyforge: { pool: poolKey, generated: generatedAt, nodes: proxies.length },
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [{ tag: 'dns-remote', address: 'https://1.1.1.1/dns-query', detour: tags.length ? poolKey : 'direct' }],
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
      rules: [],
      // 池为空时不能指向一个不存在的 selector，否则配置加载即失败
      final: tags.length ? poolKey : 'direct',
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
