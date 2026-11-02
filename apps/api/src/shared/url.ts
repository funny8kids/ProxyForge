/**
 * URL 安全校验（SSRF 防护的最小实现）。
 *
 * 用途有两处，规则相同但用途不同：
 *   · 配置 AI Provider 的 baseUrl —— 防止"填个地址"变成打内网元数据接口的跳板
 *   · 采纳 LLM 建议的代理列表 URL —— 模型幻觉出来的地址可能是 `127.0.0.1`
 *     或者 `169.254.169.254`，直接去 fetch 等于把服务器交出去
 *
 * 只做字面判断，不做 DNS 解析。解析后的重绑定（DNS rebinding）需要
 * 连接时二次校验，那是另一层防护，不在这里假装解决了。
 */

const PRIVATE_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // 链路本地 + 云元数据
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    PRIVATE_PATTERNS.some((p) => p.test(host)) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

export interface UrlCheck {
  ok: boolean;
  url: URL | null;
  reason: string;
}

/**
 * 校验一个外部 URL 是否可以安全访问。
 *
 * 返回结构化结果而不是抛异常：调用方（发现任务）需要把"这个候选被拒绝的原因"
 * 记进结果里，让用户看到模型提了什么、为什么没采纳。
 */
export function checkPublicUrl(raw: string, opts: { allowPrivate?: boolean } = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, url: null, reason: '不是合法 URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, url: null, reason: `协议不支持：${url.protocol}` };
  }
  if (isPrivateHost(url.hostname) && opts.allowPrivate !== true) {
    return { ok: false, url: null, reason: '指向内网地址，已被 SSRF 防护拦截' };
  }
  return { ok: true, url, reason: '' };
}

/** 用于去重的规范化形式：忽略协议差异、大小写、末尾斜杠和 fragment */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ''}${path}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}
