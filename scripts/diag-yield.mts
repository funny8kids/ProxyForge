/**
 * 诊断：每个源「现拉现探」的真实产出率。
 *
 * 回答的问题：晋级进来 16264 个候选，只有 3.8% 活下来 —— 是源本身就是
 * 垃圾，还是我们的挑选顺序挑错了（`ORDER BY created_at ASC` 永远先探最老的）？
 *
 * 判据是**刚抓取的条目**实测通过率。如果新鲜条目通过率有 15%，而队列里
 * 探的却是 0%，问题就在挑选顺序；如果新鲜条目也是 0%，那这个源不该留着。
 *
 * 顺带产出每个源的产出率，可以直接拿去调晋级优先级 —— 免费代理列表的
 * 质量差两个数量级，按源排序比按候选排序有效得多。
 *
 * 只读，不写库。用真实探测链（和线上同一条代码路径）。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/diag-yield.mts [每源样本数]
 */
import { CATALOG } from '../apps/api/src/shared/sources-catalog.js';
import { probe } from '../apps/api/src/modules/verification/probe.js';
import type { ProxyProtocol } from '@proxyforge/contracts';

const PER_SOURCE = Number(process.argv[2] ?? 15);
const FETCH_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 40;

interface Entry {
  protocol: ProxyProtocol;
  host: string;
  port: number;
}

/**
 * 极简解析：覆盖 catalog 里出现的几种格式。
 * 认不出的协议直接跳过 —— 这个脚本只用来估产出率，不需要完整。
 */
function parseEntries(body: string): Entry[] {
  const out: Entry[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // protocol://host:port 或 protocol://user:pass@host:port
    const uri = /^(https?|socks4a?|socks5h?):\/\/(?:[^@/\s]*@)?([^\s:/]+):(\d+)/i.exec(line);
    if (uri) {
      const p = uri[1]!.toLowerCase();
      const protocol: ProxyProtocol =
        p.startsWith('socks5') ? 'SOCKS5'
        : p.startsWith('socks4') ? 'SOCKS4'
        : p === 'https' ? 'HTTPS_CONNECT'
        : 'HTTP';
      out.push({ protocol, host: uri[2]!, port: Number(uri[3]) });
      continue;
    }

    // host:port 或 host,port 或 host:port:country
    const parts = line.split(/[:,]/).map((s) => s.trim());
    if (parts.length >= 2 && /^\d{1,3}(\.\d{1,3}){3}$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) {
      out.push({ protocol: 'HTTP', host: parts[0]!, port: Number(parts[1]!) });
    }
  }
  return out;
}

function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const copy = [...arr];
  const picked: T[] = [];
  for (let i = 0; i < n; i++) {
    const j = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(j, 1)[0]!);
  }
  return picked;
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

interface Row {
  key: string;
  name: string;
  entries: number;
  sampled: number;
  alive: number;
  tunnel: number;
  err: string | null;
}

async function main(): Promise<void> {
  const rows: Row[] = [];

  for (const src of CATALOG) {
    const row: Row = { key: src.key, name: src.name, entries: 0, sampled: 0, alive: 0, tunnel: 0, err: null };
    let entries: Entry[] = [];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(src.url, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'ProxyForge/0.1 (+yield check)' },
      });
      const body = await res.text();
      clearTimeout(timer);
      entries = parseEntries(body);
      row.entries = entries.length;
    } catch (e) {
      row.err = e instanceof Error ? e.message.slice(0, 40) : String(e);
      rows.push(row);
      continue;
    }

    const picked = sample(entries, PER_SOURCE);
    row.sampled = picked.length;
    await runPool(picked, PROBE_CONCURRENCY, async (e) => {
      try {
        const r = await probe({ host: e.host, port: e.port, protocol: e.protocol, username: null, password: null });
        if (r.success) {
          row.alive += 1;
          if (r.connectOk === true) row.tunnel += 1;
        }
      } catch {
        /* 单条异常不计入存活 */
      }
    });
    rows.push(row);
    const pct = row.sampled ? ((row.alive / row.sampled) * 100).toFixed(0) : '—';
    process.stdout.write(`  ${row.key.padEnd(22)} 条目 ${String(row.entries).padStart(6)}  样本 ${String(row.sampled).padStart(3)}  活 ${String(row.alive).padStart(3)} (${pct}%)\n`);
  }

  console.log('\n═══ 按存活率排序 ═══');
  console.log('源'.padEnd(24) + '条目'.padStart(8) + '样本'.padStart(6) + '活'.padStart(5) + '隧道'.padStart(6) + '  存活率');
  const sorted = [...rows].sort((a, b) => b.alive / Math.max(b.sampled, 1) - a.alive / Math.max(a.sampled, 1));
  for (const r of sorted) {
    const pct = r.sampled ? ((r.alive / r.sampled) * 100).toFixed(1) + '%' : 'n/a';
    console.log(
      r.key.padEnd(24) + String(r.entries).padStart(8) + String(r.sampled).padStart(6) +
      String(r.alive).padStart(5) + String(r.tunnel).padStart(6) + '  ' + pct + (r.err ? `  [${r.err}]` : ''),
    );
  }

  const totalSampled = rows.reduce((a, r) => a + r.sampled, 0);
  const totalAlive = rows.reduce((a, r) => a + r.alive, 0);
  const totalTunnel = rows.reduce((a, r) => a + r.tunnel, 0);
  console.log('\n合计: 样本 ' + totalSampled + '  活 ' + totalAlive + '  隧道 ' + totalTunnel +
    '  → 存活率 ' + (totalSampled ? ((totalAlive / totalSampled) * 100).toFixed(1) : '0') + '%');
}

main().catch((e) => {
  console.error('诊断失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
