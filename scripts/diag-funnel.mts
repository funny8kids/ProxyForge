/**
 * 诊断：候选池 → 端点的漏斗，究竟卡在哪一环。
 *
 * 回答的问题：为什么候选有六万多、待验证三千、HEALTHY 只有六百。
 *
 * 判断依据是**每个状态里节点的探测履历**：
 *   · 从没探测过 → 调度没排上它（预算或排序问题）
 *   · 探测过但从没成功 → 节点本身就是死的（正常淘汰）
 *   · 成功过 1 次 → 卡在「连续 2 次成功」门槛上（门槛问题）
 *
 * 只读，不写库。需要 API 在跑。
 *
 * 跑法：npm run diag:funnel
 */
const BASE = process.env.PF_API_BASE ?? 'http://127.0.0.1:8081/api/v1';

interface Health {
  success: boolean;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  successRate24h: number | null;
}

interface Item {
  id: string;
  host: string;
  port: number;
  protocol: string;
  lifecycleStatus: string;
  trustTier: string;
  qualityScore: number | null;
  health: Health | null;
}

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'proxyforge' }),
  });
  const j = (await r.json()) as { accessToken?: string };
  if (!j.accessToken) throw new Error('登录失败');
  return j.accessToken;
}

async function page(token: string, status: string, cursor: string | null): Promise<{ items: Item[]; next: string | null; total: number }> {
  const qs = new URLSearchParams({ status, limit: '200' });
  if (cursor) qs.set('cursor', cursor);
  const r = await fetch(`${BASE}/resources?${qs}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return (await r.json()) as { items: Item[]; nextCursor: string | null; total: number };
}

function ageMin(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

function fmtAge(m: number | null): string {
  if (m === null) return '—';
  if (m < 1) return '<1m';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}

async function collect(token: string, status: string): Promise<{ items: Item[]; total: number }> {
  const all: Item[] = [];
  let cursor: string | null = null;
  let total = 0;
  for (let i = 0; i < 400; i++) {
    const p = await page(token, status, cursor);
    total = p.total;
    all.push(...p.items);
    if (!p.next) break;
    cursor = p.next;
  }
  return { items: all, total };
}

function bucketOf(it: Item): string {
  const h = it.health;
  if (!h || h.lastCheckAt === null) return '① 从没探测过';
  if (h.consecutiveSuccesses >= 2) return '④ 已连击 2 次（该晋级了）';
  if (h.lastSuccessAt !== null || h.consecutiveSuccesses >= 1) return '③ 成功过但没连击';
  if (h.consecutiveFailures >= 2) return '②b 失败≥2 且从未成功';
  return '②a 失败 1 次且从未成功';
}

function report(status: string, items: Item[], total: number): void {
  console.log(`\n═══ ${status}  (total=${total}, 实取 ${items.length}) ═══`);
  if (!items.length) return;

  const buckets = new Map<string, Item[]>();
  for (const it of items) {
    const b = bucketOf(it);
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(it);
  }
  for (const k of [...buckets.keys()].sort()) {
    const rows = buckets.get(k)!;
    const pct = ((rows.length / items.length) * 100).toFixed(0);
    console.log(`  ${k.padEnd(26)} ${String(rows.length).padStart(5)}  ${pct.padStart(3)}%`);
  }

  // 探测新鲜度：有多少个在最近 10 / 30 / 120 分钟内被探过
  const ages = items.map((i) => ageMin(i.health?.lastCheckAt ?? null)).filter((x): x is number => x !== null);
  if (ages.length) {
    ages.sort((a, b) => a - b);
    const pct = (n: number) => `${((ages.filter((a) => a <= n).length / ages.length) * 100).toFixed(0)}%`;
    console.log(`  探测新鲜度: ≤10m ${pct(10)}  ≤30m ${pct(30)}  ≤2h ${pct(120)}  中位 ${fmtAge(ages[Math.floor(ages.length / 2)]!)}`);
  }

  const succ = items.map((i) => i.health?.successRate24h).filter((x): x is number => x !== null);
  if (succ.length) {
    const avg = succ.reduce((a, b) => a + b, 0) / succ.length;
    console.log(`  24h 成功率: 均值 ${(avg * 100).toFixed(1)}%  非零 ${succ.filter((s) => s > 0).length}/${succ.length}`);
  }
}

async function main(): Promise<void> {
  const token = await login();
  const statuses = ['PENDING_VERIFICATION', 'VERIFIED', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE'];

  const summary: Array<{ status: string; total: number }> = [];
  for (const s of statuses) {
    const { items, total } = await collect(token, s);
    summary.push({ status: s, total });
    report(s, items, total);
  }

  console.log('\n═══ 漏斗汇总 ═══');
  for (const s of summary) console.log(`  ${s.status.padEnd(22)} ${String(s.total).padStart(6)}`);
}

main().catch((e) => {
  console.error('诊断失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
