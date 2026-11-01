import type { ProxyProtocol } from '@proxyforge/contracts';
import { sha256Hex } from './crypto.js';

export interface ParsedProxy {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

const SCHEME_MAP: Record<string, ProxyProtocol> = {
  http: 'HTTP',
  https: 'HTTPS_CONNECT',
  socks4: 'SOCKS4',
  socks4a: 'SOCKS4',
  socks5: 'SOCKS5',
  socks5h: 'SOCKS5',
};

/**
 * 多格式代理行解析。支持四种常见形态：
 *   1) host:port
 *   2) host:port:user:pass
 *   3) scheme://host:port
 *   4) scheme://user:pass@host:port
 * 解析失败必须给出**行号与原文**，否则用户拿到"导入失败 37 条"无从下手。
 */
export function parseProxyLine(
  raw: string,
  fallbackProtocol: ProxyProtocol = 'HTTP',
): ParsedProxy | { error: string } {
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) {
    return { error: '空行或注释' };
  }

  // 带 scheme
  const schemeMatch = /^([a-z0-9]+):\/\/(.+)$/i.exec(line);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    const rest = schemeMatch[2]!;
    const protocol = SCHEME_MAP[scheme];
    if (!protocol) return { error: `不支持的协议 ${scheme}` };

    let auth: string | null = null;
    let hostPort = rest;
    const at = rest.lastIndexOf('@');
    if (at >= 0) {
      auth = rest.slice(0, at);
      hostPort = rest.slice(at + 1);
    }
    hostPort = hostPort.split('/')[0]!.split('?')[0]!;

    const hp = splitHostPort(hostPort);
    if ('error' in hp) return hp;

    let username: string | null = null;
    let password: string | null = null;
    if (auth) {
      const idx = auth.indexOf(':');
      if (idx < 0) {
        username = decodeURIComponent(auth);
      } else {
        username = decodeURIComponent(auth.slice(0, idx));
        password = decodeURIComponent(auth.slice(idx + 1));
      }
    }
    return { protocol, host: hp.host, port: hp.port, username, password };
  }

  // 冒号分隔的裸格式
  const parts = line.split(':');
  if (parts.length === 2) {
    const hp = splitHostPort(line);
    if ('error' in hp) return hp;
    return { protocol: fallbackProtocol, host: hp.host, port: hp.port, username: null, password: null };
  }
  /**
   * host:port:国家 —— hideip.me 这类源每行末尾挂一个国家名（`1.2.3.4:8080:Vietnam`）。
   * 以前这种三段行直接落到末尾的"无法识别"，等于把整份列表全丢掉。
   * 判据是第三段不是纯数字：`host:port:8080` 这种写法不存在，
   * 而 `host:port:user:pass` 走下面的四段分支。
   */
  if (parts.length === 3 && !/^\d+$/.test(parts[2]!.trim())) {
    const hp = splitHostPort(`${parts[0]}:${parts[1]}`);
    if ('error' in hp) return hp;
    return { protocol: fallbackProtocol, host: hp.host, port: hp.port, username: null, password: null };
  }
  if (parts.length === 4) {
    const hp = splitHostPort(`${parts[0]}:${parts[1]}`);
    if ('error' in hp) return hp;
    return {
      protocol: fallbackProtocol,
      host: hp.host,
      port: hp.port,
      username: parts[2]!,
      password: parts[3]!,
    };
  }

  return { error: '无法识别的格式（支持 host:port / host:port:user:pass / scheme://…）' };
}

function splitHostPort(input: string): { host: string; port: number } | { error: string } {
  const trimmed = input.trim();

  // IPv6 字面量 [::1]:8080
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return { error: 'IPv6 地址缺少右括号' };
    const host = trimmed.slice(1, end);
    const portStr = trimmed.slice(end + 1).replace(/^:/, '');
    const port = Number(portStr);
    if (!isValidPort(port)) return { error: `端口非法: ${portStr || '(空)'}` };
    return { host, port };
  }

  const idx = trimmed.lastIndexOf(':');
  if (idx < 0) return { error: '缺少端口' };
  const host = trimmed.slice(0, idx).trim();
  const portStr = trimmed.slice(idx + 1).trim();
  const port = Number(portStr);

  if (!host) return { error: '缺少主机名' };
  if (!isValidPort(port)) return { error: `端口非法: ${portStr || '(空)'}` };
  if (host.length > 253) return { error: '主机名过长' };

  return { host, port };
}

const isValidPort = (p: number): boolean => Number.isInteger(p) && p >= 1 && p <= 65535;

/**
 * 幂等键：sha256(protocol|host|port|credential_fingerprint)
 * 凭据指纹用 user 的哈希，避免明文进索引；同一 IP:port 不同凭据视为不同资源。
 */
export function dedupeKey(p: ParsedProxy): string {
  const cred = p.username ? sha256Hex(`${p.username}:${p.password ?? ''}`).slice(0, 16) : 'none';
  return sha256Hex(`${p.protocol}|${p.host.toLowerCase()}|${p.port}|${cred}`);
}
