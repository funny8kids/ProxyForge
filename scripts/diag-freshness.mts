/**
 * 诊断：池成员的健康状态有多陈旧。
 *
 * 回答一个具体问题：**订阅里位置越靠后越不可用，是排序问题还是数据过期？**
 *
 * 判据是每个节点「最后一次探测成功」距今多久。如果整池都是几十分钟前的
 * 状态，那订阅发出去的就是陈旧快照，再怎么排序也救不回来 —— 该去查
 * 复探周期（TIER_INTERVAL_MIN）和调度是否卡住。
 *
 * 只读，不写库。需要 API 在跑。
 *
 * 跑法：npm run diag:freshness [poolId]
 */
const BASE = process.env.PF_API_BASE ?? 'http://127.0.0.1:8081/api/v1';

interface Member {
  endpoint_id: string;
  host: string;
  port: number;
  protocol: string;
  quality_score: string;
  connect_ok: boolean | null;
}

interface Health {
  last_check_at: string | null;
  last_success_at: string | null;
  p50_ms: number | null;
  consecutive_failures: number;
  connect_ok: boolean | null;
}

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'proxyforge' }),
  });
  const j = (await r.json()) as { token?: string; accessToken?: string };
  return j.token ?? j.accessToken ?? '';
}

const token = await login();
if (!token) throw new Error('登录失败');
const auth = { authorization: `Bearer ${token}` };

/** 不传池 id 时自动挑一个成员最多的池 */
async function resolvePool(): Promise<string> {
  const arg = process.argv[2];
  if (arg) return arg;
  const r = await fetch(`${BASE}/pools`, { headers: auth });
  const pools = ((await r.json()) as { items?: Array<{ id: string; memberCount?: number }> }).items ?? [];
  const best = pools
    .filter((p) => (p.memberCount ?? 0) > 0)
    .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0))[0];
  if (!best) throw new Error('没有带成员的池');
  return best.id;
}

const POOL = await resolvePool();

const res = await fetch(`${BASE}/pools/${POOL}/members`, { headers: auth });
const members = ((await res.json()) as { items?: Member[] }).items ?? [];

// 订阅取数的排序：connect_ok DESC NULLS LAST, 新鲜度分档, quality_score DESC
// 接口没给 last_success_at，先用 connect_ok + quality 近似 —— 对分桶判断足够。
members.sort((a, b) => {
  const ca = a.connect_ok === null ? 0 : a.connect_ok ? 2 : 1;
  const cb = b.connect_ok === null ? 0 : b.connect_ok ? 2 : 1;
  if (ca !== cb) return cb - ca;
  return Number(b.quality_score) - Number(a.quality_score);
});

// 并发拉健康状态，控制在 24 路以内，避免把 API 打满
const health = new Map<string, Health>();
const queue = [...members];
async function worker(): Promise<void> {
  for (;;) {
    const m = queue.shift();
    if (!m) return;
    try {
      const r = await fetch(`${BASE}/resources/${m.endpoint_id}/health`, { headers: auth });
      if (r.ok) health.set(m.endpoint_id, (await r.json()) as Health);
    } catch {
      /* 单条失败不影响整体分布 */
    }
  }
}
await Promise.all(Array.from({ length: 24 }, worker));

const now = Date.now();
function ageMinutes(iso: string | null): number | null {
  if (!iso) return null;
  return (now - new Date(iso).getTime()) / 60000;
}

function bucket(age: number | null): string {
  if (age === null) return '从未成功';
  if (age <= 10) return '≤10m';
  if (age <= 30) return '10-30m';
  if (age <= 120) return '30m-2h';
  if (age <= 360) return '2-6h';
  return '>6h';
}

const ORDER = ['≤10m', '10-30m', '30m-2h', '2-6h', '>6h', '从未成功'];

const total = members.length;
const BANDS = [
  { label: '位置 0-20', from: 0, to: 20 },
  { label: '位置 20-50', from: 20, to: 50 },
  { label: '位置 50-100', from: 50, to: 100 },
  { label: '位置 100-200', from: 100, to: 200 },
  { label: '位置 200+', from: 200, to: total },
].filter((b) => b.from < total);

console.log(`\n池 ${POOL}`);
console.log(`成员 ${total} 个，拿到健康状态 ${health.size} 个\n`);

const header = ['区间'.padEnd(12), ...ORDER.map((b) => b.padStart(9)), '  新鲜率'].join(' ');
console.log(header);
console.log('-'.repeat(header.length + 6));

for (const band of BANDS) {
  const slice = members.slice(band.from, band.to);
  const counts = new Map<string, number>();
  let fresh = 0;
  let scored = 0;
  for (const m of slice) {
    const h = health.get(m.endpoint_id);
    const b = bucket(ageMinutes(h?.last_success_at ?? null));
    counts.set(b, (counts.get(b) ?? 0) + 1);
    if (h) {
      scored += 1;
      const age = ageMinutes(h.last_success_at);
      if (age !== null && age <= 30) fresh += 1;
    }
  }
  const cells = ORDER.map((b) => String(counts.get(b) ?? 0).padStart(9));
  const rate = scored ? `${((fresh / scored) * 100).toFixed(0)}%` : '-';
  console.log([band.label.padEnd(12), ...cells, `  ${rate.padStart(6)}`].join(' '));
}

const firstStale = members.findIndex((m) => {
  const age = ageMinutes(health.get(m.endpoint_id)?.last_success_at ?? null);
  return age === null || age > 30;
});
console.log(`\n第一个「超过 30 分钟没成功过」的节点位于第 ${firstStale < 0 ? '无（全部新鲜）' : firstStale} 位`);

const alive = members.filter((m) => {
  const age = ageMinutes(health.get(m.endpoint_id)?.last_success_at ?? null);
  return age !== null && age <= 30;
});
console.log(`30 分钟内成功过的节点：${alive.length} / ${total}`);
console.log(`其中 connect_ok=true：${alive.filter((m) => m.connect_ok === true).length} 个`);
console.log(`connect_ok=false：${members.filter((m) => m.connect_ok === false).length} 个`);
console.log(`connect_ok=null：${members.filter((m) => m.connect_ok === null).length} 个\n`);
