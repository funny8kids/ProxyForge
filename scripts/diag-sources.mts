/**
 * 诊断：内置源目录里每个 URL 现在还活着吗、能吐出多少条。
 *
 * 目录里的地址是写代码时实测过的，但公开代理列表站点会改路径、关站、
 * 加 Cloudflare。停用的源尤其可疑 —— 它们可能正是因为拉不到才被停。
 *
 * 只读，不写库，不需要 API 在跑。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/diag-sources.mts
 */
import { CATALOG } from '../apps/api/src/shared/sources-catalog.js';

interface Result {
  key: string;
  name: string;
  status: number | string;
  bytes: number;
  entries: number;
  firstLine: string;
  note: string;
}

const TIMEOUT_MS = 15_000;

/** 粗略数条目：非空、非注释、含冒号的行 */
function countEntries(body: string): number {
  let n = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!line.includes(':')) continue;
    n += 1;
  }
  return n;
}

async function probe(entry: (typeof CATALOG)[number]): Promise<Result> {
  const base: Result = {
    key: entry.key,
    name: entry.name,
    status: '-',
    bytes: 0,
    entries: 0,
    firstLine: '',
    note: entry.notes.slice(0, 30),
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(entry.url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'ProxyForge/0.1 (+source health check)' },
    });
    clearTimeout(timer);
    const body = await res.text();
    base.status = res.status;
    base.bytes = body.length;
    base.entries = countEntries(body);
    base.firstLine = (body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? '').slice(0, 40);
    return base;
  } catch (err) {
    base.status = err instanceof Error ? (err.name === 'AbortError' ? 'timeout' : err.name) : 'error';
    return base;
  }
}

// 并发 6 路，避免被 GitHub raw 限流
const results: Result[] = [];
const queue = [...CATALOG];
async function worker(): Promise<void> {
  for (;;) {
    const e = queue.shift();
    if (!e) return;
    results.push(await probe(e));
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

results.sort((a, b) => b.entries - a.entries);

console.log(`\n源目录共 ${CATALOG.length} 条\n`);
const header = ['key'.padEnd(24), 'status'.padStart(8), 'KB'.padStart(7), '条目'.padStart(7), ' 首行'];
console.log(header.join(' '));
console.log('-'.repeat(header.join(' ').length + 34));
for (const r of results) {
  console.log(
    [
      r.key.padEnd(24),
      String(r.status).padStart(8),
      (r.bytes / 1024).toFixed(0).padStart(7),
      String(r.entries).padStart(7),
      ` ${r.firstLine}`,
    ].join(' '),
  );
}

const alive = results.filter((r) => typeof r.status === 'number' && r.status === 200 && r.entries > 0);
const dead = results.filter((r) => !alive.includes(r));
const totalEntries = alive.reduce((s, r) => s + r.entries, 0);

console.log(`\n可用源 ${alive.length} 个，合计约 ${totalEntries} 条候选`);
console.log(`不可用 ${dead.length} 个：${dead.map((d) => `${d.key}(${d.status})`).join(', ') || '无'}\n`);
