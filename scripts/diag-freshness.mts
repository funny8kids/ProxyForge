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
  lifecycle_status: string;
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
const allMembers = ((await res.json()) as { items?: Member[] }).items ?? [];
// 订阅会剔除 connect_ok=false 的节点（建不起 CONNECT 隧道，对 HTTPS 无用），
// 这里跟着剔，否则分桶出来的"位置"比真实订阅靠后。
const members = allMembers.filter((m) => m.connect_ok !== false);
const dropped = allMembers.length - members.length;

// 并发拉健康状态，控制在 24 路以内，避免把 API 打满。
// 必须先拉完才能排序 —— 真实订阅顺序里的第二排序键是「新鲜度分档」，
// 而成员接口不返回 last_success_at。
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

/**
 * 新鲜度分档，与 loadExportProxies 的 ORDER BY 保持一致。
 *
 * 这里必须复刻真实排序，否则分桶出来的"位置"不是用户实际看到的位置 ——
 * 那样会得出「排在前面的反而不新鲜」的错误结论。
 */
function freshTier(m: Member): number {
  const age = ageMinutes(health.get(m.endpoint_id)?.last_success_at ?? null);
  if (age === null) return 3;
  if (age <= 10) return 0;
  if (age <= 30) return 1;
  if (age <= 120) return 2;
  return 3;
}

members.sort((a, b) => {
  const ca = a.connect_ok === null ? 0 : a.connect_ok ? 2 : 1;
  const cb = b.connect_ok === null ? 0 : b.connect_ok ? 2 : 1;
  if (ca !== cb) return cb - ca;
  const fa = freshTier(a);
  const fb = freshTier(b);
  if (fa !== fb) return fa - fb;
  return Number(b.quality_score) - Number(a.quality_score);
});

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
console.log(`成员 ${total} 个（另有 ${dropped} 个建不起隧道、订阅已剔除），拿到健康状态 ${health.size} 个\n`);

const header = ['区间'.padEnd(12), ...ORDER.map((b) => b.padStart(9)), '  成功新鲜', '  探测新鲜'].join(' ');
console.log(header);
console.log('-'.repeat(header.length + 6));

for (const band of BANDS) {
  const slice = members.slice(band.from, band.to);
  const counts = new Map<string, number>();
  let fresh = 0;
  let checked = 0;
  let scored = 0;
  for (const m of slice) {
    const h = health.get(m.endpoint_id);
    const b = bucket(ageMinutes(h?.last_success_at ?? null));
    counts.set(b, (counts.get(b) ?? 0) + 1);
    if (h) {
      scored += 1;
      const age = ageMinutes(h.last_success_at);
      if (age !== null && age <= 30) fresh += 1;
      const cAge = ageMinutes(h.last_check_at);
      if (cAge !== null && cAge <= 30) checked += 1;
    }
  }
  const cells = ORDER.map((b) => String(counts.get(b) ?? 0).padStart(9));
  const rate = scored ? `${((fresh / scored) * 100).toFixed(0)}%` : '-';
  const cRate = scored ? `${((checked / scored) * 100).toFixed(0)}%` : '-';
  console.log([band.label.padEnd(12), ...cells, `  ${rate.padStart(7)}`, `  ${cRate.padStart(7)}`].join(' '));
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

// 生命周期分布 —— 用来区分「调度没探它」和「探了但失败」。
// 如果大部分是 UNAVAILABLE，说明它们早被判死，只是还挂在池成员表里。
const byStatus = new Map<string, number>();
for (const m of members) byStatus.set(m.lifecycle_status, (byStatus.get(m.lifecycle_status) ?? 0) + 1);
console.log('生命周期分布：');
for (const [status, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${status.padEnd(20)} ${String(n).padStart(5)}`);
}

// 池成员表与订阅视图的口径差：订阅视图只收 HEALTHY/DEGRADED，
// 池成员表若含其它状态，说明池重算没把它们摘掉。
const notEligible = members.filter((m) => !['HEALTHY', 'DEGRADED'].includes(m.lifecycle_status));
if (notEligible.length > 0) {
  console.log(`\n注意：${notEligible.length} 个池成员不在订阅视图的收录范围内（非 HEALTHY/DEGRADED）`);
}
console.log();
