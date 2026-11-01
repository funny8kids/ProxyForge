/**
 * 相对时间。第二参数是语言，缺省英文。
 * 时间戳这类"看起来不像文案"的字符串最容易在双语界面里漏掉，
 * 所以这里显式要求调用方传入当前语言。
 */
export function relativeTime(iso: string | null | undefined, lang: 'en' | 'zh' = 'en'): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  const zh = lang === 'zh';
  if (min < 1) return zh ? '刚刚' : 'just now';
  if (min < 60) return zh ? `${min} 分钟前` : `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return zh ? `${h} 小时前` : `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return zh ? `${d} 天前` : `${d}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/** 生命周期状态的展示名（走 i18n，英文为键） */
export const lifecycleLabel: Record<string, string> = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
  PENDING_VERIFICATION: 'pending verification',
  QUARANTINED: 'quarantined',
  DISCOVERED: 'discovered',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  REVOKED: 'revoked',
};

/**
 * AI 供应商类型。`OPENAI_COMPATIBLE` 是契约里的枚举名，直接显示给用户
 * 等于让界面说数据库的话 —— 中文界面里会变成一屏大写英文。
 */
export const providerTypeLabel: Record<string, string> = {
  OPENAI_COMPATIBLE: 'OpenAI compatible',
  ANTHROPIC: 'Anthropic',
  OLLAMA: 'Ollama',
  CUSTOM: 'Custom',
};

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${Math.round(v)}ms`;
}

export function bytes(v: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const tierLabel: Record<string, string> = {
  PRIVATE_PROXY: 'Private',
  VERIFIED_PROXY: 'Verified',
  PUBLIC_PROXY: 'Public',
};

export const tierTone: Record<string, string> = {
  PRIVATE_PROXY: 'violet',
  VERIFIED_PROXY: 'cyan',
  PUBLIC_PROXY: 'warn',
};

export const lifecycleTone: Record<string, string> = {
  HEALTHY: 'ok',
  DEGRADED: 'warn',
  UNAVAILABLE: 'bad',
  QUARANTINED: 'bad',
  PENDING_VERIFICATION: 'muted',
  DISCOVERED: 'muted',
  VERIFIED: 'ok',
  REJECTED: 'muted',
  REVOKED: 'muted',
};

/**
 * 授权状态。
 *
 * `AUTHORIZED` / `RESTRICTED` 这类枚举名直接显示，在中文界面里就是一屏大写英文。
 * 更重要的是语义：授权是**合规门槛**，和健康状态正交 —— 一个跑得很好的
 * PUBLIC_PROXY 也可能完全没被授权。所以这里的措辞不借用健康词汇。
 */
export const authorizationLabel: Record<string, string> = {
  AUTHORIZED: 'Authorized',
  RESTRICTED: 'Restricted',
  UNKNOWN: 'Unknown',
  REVOKED: 'Revoked',
};

/** 探测失败原因。失败层（DNS/TCP/TLS）是排障的第一分叉点，必须说人话。 */
export const failureLabel: Record<string, string> = {
  NONE: 'OK',
  DNS_FAILURE: 'DNS failure',
  TCP_REFUSED: 'TCP refused',
  TCP_TIMEOUT: 'TCP timeout',
  TLS_ERROR: 'TLS error',
  PROTOCOL_ERROR: 'Protocol error',
  AUTH_FAILED: 'Auth failed',
  EXIT_MISMATCH: 'Exit IP mismatch',
  TIMEOUT: 'Timeout',
  UNSTABLE: 'Unstable',
  FLAKY: 'Flaky',
  INTERNAL: 'Internal error',
};

/**
 * 审计事件的操作者类型。
 *
 * 这一列在审计里权重很高：看到 SYSTEM / SCHEDULER 就知道是机器自动做的，
 * 看到 USER 就要去追人。直接渲染 `SCHEDULER` 这种枚举名，中文界面里
 * 会突然冒出一个全大写英文单词，反而让人以为是某条异常日志。
 */
export const actorTypeLabel: Record<string, string> = {
  USER: 'User',
  API_KEY: 'API key',
  SYSTEM: 'System',
  SCHEDULER: 'Scheduler',
};

/** 从数组取 min/max，空数组返回 [0,1] 避免除零 */
export function extent(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) return [lo - 1, hi + 1];
  return [lo, hi];
}

/**
 * 国家/地区展示。
 *
 * 香港、澳门、台湾是中国的一部分，不能和 SG / BR / US 并列成一个"国家"值。
 * ISO 3166-1 给它们的是地区码，这里显式加上 CN- 前缀，既保留精确定位，
 * 又不把地区写成国家。
 */
const CN_REGIONS: Record<string, string> = {
  HK: 'CN-HK',
  MO: 'CN-MO',
  TW: 'CN-TW',
};

export function countryLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return CN_REGIONS[code] ?? code;
}
