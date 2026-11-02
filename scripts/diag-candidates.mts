/**
 * 候选源评估：给一批 URL，量「能不能拉」和「拉下来能不能用」。
 *
 * 为什么不直接往 CATALOG 里加：目录里的注释写了收录原则 —— 每个 URL 都
 * 必须实测过。而且**可达 ≠ 有用**：一个 11000 条的列表如果存活率 2%，
 * 挖 200 条只得 4 个可用节点，还不如一个 900 条、存活率 45% 的。
 *
 * 所以这里对每个候选做三件事：
 *   1. 抓取（状态码、字节数、条目数）
 *   2. 抽样 12 条，走**真实探测链**（和线上同一条代码路径）
 *   3. 报告存活率与能建隧道的比例 —— 后者才决定它在 Clash 里有没有用
 *
 * 只读，不写库，不需要 API 在跑。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/diag-candidates.mts
 */
import { probe } from '../apps/api/src/modules/verification/probe.js';
import type { ProxyProtocol } from '@proxyforge/contracts';

/** 待评估的候选源。加进 CATALOG 之前必须先跑一遍这个。 */
const CANDIDATES: Array<{ key: string; url: string; protocol: ProxyProtocol; format?: 'text' | 'json' | 'csv' }> = [
  // ── 经过验证的列表（只发布最近校验过的代理，产出率通常远高于裸抓）──
  { key: 'ercin-http', url: 'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt', protocol: 'HTTP' },
  { key: 'ercin-https', url: 'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/https.txt', protocol: 'HTTPS_CONNECT' },
  { key: 'ercin-socks5', url: 'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt', protocol: 'SOCKS5' },
  { key: 'vakhov-http', url: 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt', protocol: 'HTTP' },
  { key: 'vakhov-socks5', url: 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt', protocol: 'SOCKS5' },
  { key: 'mmpx12-http', url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt', protocol: 'HTTP' },
  { key: 'mmpx12-socks5', url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt', protocol: 'SOCKS5' },
  { key: 'muronpig-http', url: 'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt', protocol: 'HTTP' },
  { key: 'roosterkid-https', url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt', protocol: 'HTTPS_CONNECT' },
  { key: 'shiftytr-http', url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt', protocol: 'HTTP' },
  { key: 'proxylistto-http', url: 'https://raw.githubusercontent.com/proxylist-to/proxy-list/main/http.txt', protocol: 'HTTP' },
  { key: 'proxylistto-socks5', url: 'https://raw.githubusercontent.com/proxylist-to/proxy-list/main/socks5.txt', protocol: 'SOCKS5' },
  { key: 'iplocate-http', url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt', protocol: 'HTTP' },
  { key: 'iplocate-socks5', url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt', protocol: 'SOCKS5' },
  { key: 'zloi-http', url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt', protocol: 'HTTP' },
  { key: 'zloi-socks5', url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt', protocol: 'SOCKS5' },

  // ── 站点 API（有的带 timeout/ssl 过滤，产出率略高）──
  { key: 'proxylist.download-http', url: 'https://www.proxy-list.download/api/v1/get?type=http', protocol: 'HTTP' },
  { key: 'proxylist.download-socks5', url: 'https://www.proxy-list.download/api/v1/get?type=socks5', protocol: 'SOCKS5' },
  { key: 'proxyscrape-v4-http', url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text', protocol: 'HTTP' },
  { key: 'proxyscrape-v4-socks5', url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text', protocol: 'SOCKS5' },
  { key: 'openproxy.space-http', url: 'https://openproxy.space/list/http', protocol: 'HTTP' },
];

const PER_SOURCE = Number(process.argv[2] ?? 12);
const FETCH_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 24;

interface Entry { host: string; port: number }

function parseEntries(body: string): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let host: string | undefined;
    let port: number | undefined;
    const uri = /^(?:https?|socks4a?|socks5h?):\/\/(?:[^@/\s]*@)?([^\s:/]+):(\d+)/i.exec(line);
    if (uri) { host = uri[1]; port = Number(uri[2]); }
    else {
      const parts = line.split(/[:,]/).map((s) => s.trim());
      if (parts.length >= 2 && /^\d{1,3}(\.\d{1,3}){3}$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) {
        host = parts[0]; port = Number(parts[1]);
      }
    }
    if (!host || !port) continue;
    const k = `${host}:${port}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ host, port });
  }
  return out;
}

function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const copy = [...arr];
  const picked: T[] = [];
  for (let i = 0; i < n; i++) picked.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]!);
  return picked;
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

interface Row {
  key: string; protocol: string; status: number | string; entries: number;
  sampled: number; alive: number; tunnel: number; ms: number; note: string;
}

async function main(): Promise<void> {
  const rows: Row[] = [];

  for (const c of CANDIDATES) {
    const row: Row = { key: c.key, protocol: c.protocol, status: '-', entries: 0, sampled: 0, alive: 0, tunnel: 0, ms: 0, note: '' };
    let entries: Entry[] = [];
    const t0 = performance.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(c.url, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'ProxyForge/0.1 (+candidate eval)' },
      });
      const body = await res.text();
      clearTimeout(timer);
      row.status = res.status;
      entries = parseEntries(body);
      row.entries = entries.length;
    } catch (e) {
      row.note = e instanceof Error ? e.message.slice(0, 36) : String(e);
      rows.push(row);
      continue;
    }
    row.ms = Math.round(performance.now() - t0);

    const picked = sample(entries, PER_SOURCE);
    row.sampled = picked.length;
    await runPool(picked, PROBE_CONCURRENCY, async (e) => {
      try {
        const r = await probe({ host: e.host, port: e.port, protocol: c.protocol, username: null, password: null });
        if (r.success) { row.alive += 1; if (r.connectOk === true) row.tunnel += 1; }
      } catch { /* 计为失败 */ }
    });

    const pct = row.sampled ? ((row.alive / row.sampled) * 100).toFixed(0) : '-';
    process.stdout.write(`  ${row.key.padEnd(24)} ${String(row.status).padEnd(4)} 条目 ${String(row.entries).padStart(6)}  样本 ${String(row.sampled).padStart(2)}  活 ${String(row.alive).padStart(2)} (${pct}%)  隧道 ${row.tunnel}\n`);
    rows.push(row);
  }

  console.log('\n═══ 按「隧道可用率」排序（这才是 Clash 里能不能用的判据）═══');
  console.log('源'.padEnd(26) + '条目'.padStart(8) + '样本'.padStart(6) + '活'.padStart(5) + '隧道'.padStart(6) + '  隧道率  存活率');
  const sorted = [...rows].sort((a, b) => b.tunnel / Math.max(b.sampled, 1) - a.tunnel / Math.max(a.sampled, 1));
  for (const r of sorted) {
    const tr = r.sampled ? ((r.tunnel / r.sampled) * 100).toFixed(1) + '%' : 'n/a';
    const ar = r.sampled ? ((r.alive / r.sampled) * 100).toFixed(1) + '%' : 'n/a';
    console.log(
      r.key.padEnd(26) + String(r.entries).padStart(8) + String(r.sampled).padStart(6) +
      String(r.alive).padStart(5) + String(r.tunnel).padStart(6) + '  ' + tr.padStart(6) + '  ' + ar.padStart(6) +
      (r.note ? `  [${r.note}]` : ''),
    );
  }
}

main().catch((e) => {
  console.error('评估失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
