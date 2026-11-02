/**
 * 微基准：探测链本身的耗时，和写库开销分开看。
 *
 * 线上实测「180 个一批要 17 秒」，而 96 路并发下如果单节点只要 4 秒，
 * 应该是 96/4 ≈ 24 个/秒 = 8 秒一批。差的那 9 秒要么在 `probe()` 里，
 * 要么在每条结果那个事务里。
 *
 * 这个脚本只调 `probe()`，不碰数据库。拿它和线上的批次耗时对比，
 * 就能把「探测慢」和「写库慢」分开：
 *   · 脚本也是 17 秒 → 瓶颈在探测链（超时叠加、socket 未及时释放）
 *   · 脚本只要 8 秒  → 瓶颈在写库（PGlite 单写者，96 路并发抢一个事务队列）
 *
 * 只读，不写库。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/bench-probe.mts [样本数] [并发]
 */
const BASE = process.env.PF_API_BASE ?? 'http://127.0.0.1:8081/api/v1';
const SAMPLE = Number(process.argv[2] ?? 180);
const CONCURRENCY = Number(process.argv[3] ?? 96);

interface Item {
  host: string;
  port: number;
  protocol: 'HTTP' | 'HTTPS_CONNECT' | 'SOCKS4' | 'SOCKS5';
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

async function main(): Promise<void> {
  const { probe } = await import('../apps/api/src/modules/verification/probe.js');

  const token = await login();
  // 从待验证队列取样本：这批节点的分布最接近线上真实负载（绝大多数是死的）
  const targets: Item[] = [];
  let cursor: string | null = null;
  while (targets.length < SAMPLE) {
    const qs = new URLSearchParams({ status: 'PENDING_VERIFICATION', limit: '200' });
    if (cursor) qs.set('cursor', cursor);
    const res = await fetch(`${BASE}/resources?${qs}`, { headers: { authorization: `Bearer ${token}` } });
    const page = (await res.json()) as { items: Item[]; nextCursor: string | null };
    targets.push(...page.items);
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  targets.length = Math.min(targets.length, SAMPLE);

  const durations: number[] = [];
  let alive = 0;
  let i = 0;
  const t0 = performance.now();

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      while (i < targets.length) {
        const t = targets[i++]!;
        const s = performance.now();
        try {
          const r = await probe({ host: t.host, port: t.port, protocol: t.protocol, username: null, password: null });
          if (r.success) alive += 1;
        } catch {
          /* 计为失败 */
        }
        durations.push(performance.now() - s);
      }
    }),
  );

  const wall = performance.now() - t0;
  durations.sort((a, b) => a - b);
  const pick = (p: number) => Math.round(durations[Math.floor((durations.length - 1) * p)] ?? 0);

  console.log(`样本 ${targets.length}  并发 ${CONCURRENCY}  存活 ${alive}`);
  console.log(`墙钟 ${(wall / 1000).toFixed(1)}s → ${((targets.length / wall) * 60000).toFixed(0)} 个/分钟`);
  console.log(`单节点耗时  p50 ${pick(0.5)}ms  p90 ${pick(0.9)}ms  p99 ${pick(0.99)}ms  max ${pick(1)}ms`);
  const avg = durations.reduce((a, b) => a + b, 0) / Math.max(durations.length, 1);
  console.log(`单节点均值 ${Math.round(avg)}ms  → 理论吞吐 ${((CONCURRENCY / avg) * 60000).toFixed(0)} 个/分钟`);
}

main().catch((e) => {
  console.error('基准失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
