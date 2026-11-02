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

/**
 * 大洲归属。
 *
 * 用途只有一个：给国家码配一个色点，让「这个池子的出口分布」在扫一眼时
 * 就能看出来 —— 300 个节点全在北美，和"北美 80 / 欧洲 150 / 亚洲 70"
 * 是完全不同的两件事，而纯文字列表读不出这个差别。
 *
 * 不追求 ISO 全量覆盖：只列免费代理池里实际会出现的地区，其余落到 OTHER。
 * 大洲归属本身有争议（土耳其、俄罗斯算欧还是亚），这里按"网络出口的地理
 * 习惯"归类，只影响颜色，不影响任何判定。
 */
const REGION_GROUPS: Array<{ key: string; codes: string[] }> = [
  {
    key: 'asia',
    codes: [
      'CN', 'HK', 'MO', 'TW', 'JP', 'KR', 'SG', 'MY', 'TH', 'VN', 'ID', 'PH',
      'IN', 'PK', 'BD', 'LK', 'NP', 'KH', 'LA', 'MM', 'BN', 'MN', 'KZ', 'UZ',
      'KG', 'TJ', 'TM', 'AF', 'IR', 'IQ', 'IL', 'JO', 'LB', 'SA', 'AE', 'QA',
      'KW', 'BH', 'OM', 'YE', 'SY', 'TR', 'GE', 'AM', 'AZ',
    ],
  },
  {
    key: 'europe',
    codes: [
      'GB', 'DE', 'FR', 'NL', 'BE', 'LU', 'CH', 'AT', 'IT', 'ES', 'PT', 'IE',
      'DK', 'SE', 'NO', 'FI', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR',
      'HR', 'SI', 'RS', 'BA', 'ME', 'MK', 'AL', 'LT', 'LV', 'EE', 'UA', 'BY',
      'MD', 'RU', 'CY', 'MT',
    ],
  },
  {
    key: 'americas',
    codes: [
      'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'VE', 'EC', 'BO', 'PY',
      'UY', 'CR', 'PA', 'GT', 'HN', 'SV', 'NI', 'DO', 'CU', 'JM', 'TT', 'PR',
    ],
  },
  { key: 'oceania', codes: ['AU', 'NZ', 'FJ', 'PG', 'GU', 'NC'] },
  {
    key: 'africa',
    codes: [
      'ZA', 'EG', 'NG', 'KE', 'MA', 'TN', 'DZ', 'GH', 'ET', 'TZ', 'UG', 'CM',
      'CI', 'SN', 'ZW', 'ZM', 'MZ', 'AO', 'LY', 'SD',
    ],
  },
];

const REGION_OF = new Map<string, string>();
for (const g of REGION_GROUPS) for (const c of g.codes) REGION_OF.set(c, g.key);

/** 返回 asia / europe / americas / oceania / africa / other */
export function regionOf(code: string | null | undefined): string {
  if (!code) return 'other';
  return REGION_OF.get(code.toUpperCase()) ?? 'other';
}

/**
 * 大洲名。
 *
 * 值用英文而不是中文：这张表会被 `t()` 再翻一次，而 `t()` 以英文为键。
 * 直接写中文的后果是英文界面里冒出一串「欧洲 / 美洲」——
 * 因为 `t('欧洲')` 查不到英文键，只能原样返回。
 */
export const REGION_LABEL: Record<string, string> = {
  asia: 'Asia',
  europe: 'Europe',
  americas: 'Americas',
  oceania: 'Oceania',
  africa: 'Africa',
  other: 'Other',
};

/**
 * 常见出口地区的中文名。
 *
 * 只覆盖分布里实际会出现的那批。查不到就退回 ISO 代码 —— 显示 `XX`
 * 比显示"未知地区"更有用：前者能拿去搜，后者只是一句废话。
 */
const COUNTRY_NAMES: Record<string, string> = {
  CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾',
  JP: '日本', KR: '韩国', SG: '新加坡', MY: '马来西亚', TH: '泰国',
  VN: '越南', ID: '印度尼西亚', PH: '菲律宾', IN: '印度', PK: '巴基斯坦',
  BD: '孟加拉国', LK: '斯里兰卡', NP: '尼泊尔', KH: '柬埔寨', MM: '缅甸',
  MN: '蒙古', KZ: '哈萨克斯坦', IR: '伊朗', IL: '以色列', SA: '沙特阿拉伯',
  AE: '阿联酋', QA: '卡塔尔', TR: '土耳其', GE: '格鲁吉亚', AZ: '阿塞拜疆',
  GB: '英国', DE: '德国', FR: '法国', NL: '荷兰', BE: '比利时', CH: '瑞士',
  AT: '奥地利', IT: '意大利', ES: '西班牙', PT: '葡萄牙', IE: '爱尔兰',
  DK: '丹麦', SE: '瑞典', NO: '挪威', FI: '芬兰', IS: '冰岛', PL: '波兰',
  CZ: '捷克', SK: '斯洛伐克', HU: '匈牙利', RO: '罗马尼亚', BG: '保加利亚',
  GR: '希腊', HR: '克罗地亚', RS: '塞尔维亚', LT: '立陶宛', LV: '拉脱维亚',
  EE: '爱沙尼亚', UA: '乌克兰', BY: '白俄罗斯', MD: '摩尔多瓦', RU: '俄罗斯',
  CY: '塞浦路斯', MT: '马耳他',
  US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷',
  CL: '智利', CO: '哥伦比亚', PE: '秘鲁', VE: '委内瑞拉', EC: '厄瓜多尔',
  UY: '乌拉圭', CR: '哥斯达黎加', PA: '巴拿马', DO: '多米尼加', CU: '古巴',
  JM: '牙买加', PR: '波多黎各',
  AU: '澳大利亚', NZ: '新西兰', FJ: '斐济', PG: '巴布亚新几内亚',
  ZA: '南非', EG: '埃及', NG: '尼日利亚', KE: '肯尼亚', MA: '摩洛哥',
  TN: '突尼斯', DZ: '阿尔及利亚', GH: '加纳', ET: '埃塞俄比亚',
  TZ: '坦桑尼亚', UG: '乌干达', CM: '喀麦隆', CI: '科特迪瓦', SN: '塞内加尔',
  ZW: '津巴布韦', ZM: '赞比亚', MZ: '莫桑比克', AO: '安哥拉', LY: '利比亚',
  SD: '苏丹',
};

export function countryName(code: string | null | undefined): string {
  if (!code) return '未知地区';
  const up = code.toUpperCase();
  return COUNTRY_NAMES[up] ?? countryLabel(up);
}
