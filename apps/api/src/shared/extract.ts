import type { ProxyProtocol } from '@proxyforge/contracts';

/**
 * 多格式抽取器。
 *
 * 同步链路原来只有一句 `content.split(/\r?\n/)`，所以只能吃纯文本列表。
 * 但公开源实际有三种形态，少了两种就等于丢掉一半资源：
 *   · text — `1.2.3.4:8080` / `socks5://1.2.3.4:1080` / `1.2.3.4:8080:Vietnam`
 *   · json — `{"data":[{"ip":"1.2.3.4","port":"8080","protocols":["http"]}]}`
 *   · csv  — `socks5://1.2.3.4:1080,US,Alexandria`（首列是代理，后面是国家/城市）
 *
 * 抽取器只负责"把内容变成一行行可解析的字符串 + 协议提示"，
 * 真正的合法性判断仍交给 parseProxyLine —— 单一真相层不在这里复制。
 */
export type SourceFormat = 'text' | 'json' | 'csv';

export interface ExtractedEntry {
  /** 归一成 parseProxyLine 能吃的形态 */
  raw: string;
  /** 这一条自带协议（JSON 的 protocols 数组、CSV 的 scheme 前缀） */
  protocolHint?: ProxyProtocol;
  /** 源自带的国家标注，仅用于展示，不入库 */
  countryCode?: string | null;
}

export interface ExtractResult {
  entries: ExtractedEntry[];
  /** 实际采用的格式（自动探测时可能与声明不同） */
  format: SourceFormat;
  /** 探测/解析过程中的告警，回传给界面，避免"0 条但不知道为什么" */
  warnings: string[];
}

const PROTOCOL_ALIASES: Record<string, ProxyProtocol> = {
  http: 'HTTP',
  https: 'HTTPS_CONNECT',
  https_connect: 'HTTPS_CONNECT',
  socks4: 'SOCKS4',
  socks4a: 'SOCKS4',
  socks5: 'SOCKS5',
  socks5h: 'SOCKS5',
};

const normalizeProtocol = (value: unknown): ProxyProtocol | undefined => {
  if (typeof value !== 'string') return undefined;
  return PROTOCOL_ALIASES[value.trim().toLowerCase()];
};

/**
 * 格式探测。声明值优先，但 `text` 是"没填"的默认值，
 * 所以当声明为 text 而内容明显是 JSON 时以内容为准 —— 否则
 * 一个忘了填 formatHint 的 JSON 源会被整段当成一行，产出 1 个坏候选。
 */
export function detectFormat(content: string, declared?: string | null): SourceFormat {
  const head = content.slice(0, 4096).trimStart();
  const looksJson = head.startsWith('{') || head.startsWith('[');
  const d = (declared ?? '').trim().toLowerCase();

  if (d === 'json' || d === 'csv') return d as SourceFormat;
  if (looksJson) return 'json';
  if (d === 'text' && looksJson) return 'json';
  return 'text';
}

export function extractEntries(
  content: string,
  declaredFormat?: string | null,
  fallbackProtocol: ProxyProtocol = 'HTTP',
): ExtractResult {
  const clean = content.replace(/^\uFEFF/, '');
  const format = detectFormat(clean, declaredFormat);
  const warnings: string[] = [];

  if (!clean.trim()) {
    return { entries: [], format, warnings: ['响应体为空'] };
  }

  if (format === 'json') {
    const r = extractJson(clean, fallbackProtocol);
    return { entries: r.entries, format, warnings: [...warnings, ...r.warnings] };
  }
  if (format === 'csv') {
    const r = extractCsv(clean, fallbackProtocol);
    return { entries: r.entries, format, warnings: [...warnings, ...r.warnings] };
  }
  return { entries: extractText(clean), format, warnings };
}

/** 纯文本：逐行，去掉 BOM / 注释 / 行内空白 */
function extractText(content: string): ExtractedEntry[] {
  const out: ExtractedEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    out.push({ raw: t });
  }
  return out;
}

/**
 * JSON：不假设固定 schema，递归找"带 ip/host 和 port 的对象"。
 * 公开源的字段名五花八门（ip / host / proxy / ip_address），
 * 写死一种就会在换源时静默返回 0 条。
 */
function extractJson(content: string, fallback: ProxyProtocol): { entries: ExtractedEntry[]; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 有些"JSON"接口实际返回 JSONL，逐行再试一次
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1) {
      const entries: ExtractedEntry[] = [];
      for (const l of lines) {
        try {
          entries.push(...extractJson(l, fallback).entries);
        } catch {
          /* 跳过坏行 */
        }
      }
      if (entries.length) return { entries, warnings: ['按 JSONL 逐行解析'] };
    }
    return { entries: [], warnings: ['JSON 解析失败，内容不是合法 JSON'] };
  }

  const entries: ExtractedEntry[] = [];
  const seen = new Set<unknown>();

  const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    return null;
  };

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const o = node as Record<string, unknown>;
    const ip = pick(o, ['ip', 'host', 'ip_address', 'address', 'proxy']);
    const port = pick(o, ['port', 'proxy_port']);

    if (ip && port) {
      // 有的源直接给 "1.2.3.4:8080"，有的 ip 与 port 分开
      const raw = ip.includes(':') && !ip.startsWith('[') ? ip : `${ip}:${port}`;

      // 协议可能来自 protocols 数组、protocol 字符串或 scheme 前缀
      let hint: ProxyProtocol | undefined;
      const protos = o['protocols'] ?? o['protocol'] ?? o['type'];
      if (Array.isArray(protos)) {
        for (const p of protos) {
          const n = normalizeProtocol(p);
          if (n) {
            hint = n;
            break;
          }
        }
      } else {
        hint = normalizeProtocol(protos);
      }

      const cc = pick(o, ['country_code', 'countryCode', 'country']);
      entries.push({ raw, protocolHint: hint, countryCode: cc ? cc.slice(0, 8) : null });
      return; // 命中就不再往子节点钻，避免同一对象被重复计入
    }

    for (const v of Object.values(o)) walk(v);
  };

  walk(parsed);

  const warnings: string[] = [];
  if (!entries.length) warnings.push('JSON 结构里没有找到含 ip/port 的对象');
  return { entries, warnings };
}

/**
 * CSV：首列是代理，其后常见是国家代码 / 城市。
 * 不引 CSV 库 —— 公开源没有引号内换行这种复杂情况，
 * 遇到带引号的字段手工去一层壳即可。
 */
function extractCsv(content: string, fallback: ProxyProtocol): { entries: ExtractedEntry[]; warnings: string[] } {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const entries: ExtractedEntry[] = [];
  const warnings: string[] = [];

  if (!lines.length) return { entries, warnings: ['CSV 为空'] };

  const splitLine = (line: string): string[] => line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));

  let start = 0;
  const firstCol = splitLine(lines[0]!)[0] ?? '';
  // 表头判定：首列不是 host:port 也不是 scheme://
  if (!/^[a-z0-9]+:\/\//i.test(firstCol) && !/^[^\s,:]+:\d+/.test(firstCol)) {
    start = 1;
    warnings.push(`跳过表头：${lines[0]!.slice(0, 60)}`);
  }

  for (let i = start; i < lines.length; i += 1) {
    const cols = splitLine(lines[i]!);
    const proxy = cols[0];
    if (!proxy) continue;

    // 第二列常见是国家二字码（US / JP），只在长度合理时采用
    const cc = cols[1] && /^[A-Za-z]{2,3}$/.test(cols[1]) ? cols[1].toUpperCase() : null;
    entries.push({ raw: proxy, countryCode: cc });
  }

  return { entries, warnings };
}
