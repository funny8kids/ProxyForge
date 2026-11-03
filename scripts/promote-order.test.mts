/**
 * 候选晋级的取数顺序与过期保留期回归测试。
 *
 * 为什么这两件事值得单独测：它们决定**探测预算花在什么 IP 上**，
 * 而这个错误不会报错、不会告警，只会让"探测在跑、健康数不动"看起来
 * 像"源质量差"。
 *
 * 实测背景（2026-11）：晋级原来是 FIFO，待晋级队列 9,442 条、中位年龄
 * 152 分钟，而免费代理 IP 存活期是几十分钟。按候选年龄分档看晋级后的
 * 探测成功率：
 *
 *   | 候选年龄    | 端点数 | 成功率 |
 *   |------------|-------|-------|
 *   | <30 分钟    | 2,098 |  9.3% |
 *   | 30–60 分钟  |   762 |  4.6% |
 *   | 1–2 小时    | 5,153 |  5.4% |
 *   | >2 小时     |18,159 |  3.7% |
 *
 * 也就是说 FIFO 把 71% 的探测预算花在了成功率最低的那一档上。
 *
 * 跑法：npm run test:promote
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL ??= 'memory://';

const { closeDb, exec, getDb, q } = await import('../apps/api/src/db/client.js');
const { migrate } = await import('../apps/api/src/db/migrate.js');
const { promoteCandidates, expireStaleCandidates } = await import(
  '../apps/api/src/modules/source/promote.js'
);
const { tx } = await import('../apps/api/src/db/client.js');

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${(err as Error).message.split('\n').join('\n    ')}`);
  }
}

await getDb();
await migrate();

async function mkSource(key: string): Promise<string> {
  const id = randomUUID();
  await exec(
    `INSERT INTO resource_sources
       (id, key, name, type, url, format_hint, authorization_status, trust_level, enabled, last_sync_status)
     VALUES ($1,$2,$2,'GITHUB_REPO',$3,'text','RESTRICTED',40,true,'OK')`,
    [id, key, `https://example.invalid/${key}.txt`],
  );
  return id;
}

/** 建一条候选，`ageMinutes` 控制它的"抓取于多久以前"。 */
async function mkCandidate(
  sourceId: string,
  host: string,
  ageMinutes: number,
): Promise<string> {
  const id = randomUUID();
  await exec(
    `INSERT INTO candidate_endpoints
       (id, source_id, raw_value, protocol, host, port, dedupe_key, review_status, created_at)
     VALUES ($1,$2,$3,'SOCKS5',$4,1080,$5,'PENDING', now() - ($6 || ' minutes')::interval)`,
    [id, sourceId, `${host}:1080`, host, `dk-${host}`, String(ageMinutes)],
  );
  return id;
}

async function promotedHosts(): Promise<string[]> {
  const rows = await q<{ host: string }>(
    `SELECT host FROM proxy_endpoints WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  );
  return rows.map((r) => r.host);
}

console.log('\n[1] 晋级取最新候选，不取最老的');

await check('队列里新旧混排时，晋级的是最新那批', async () => {
  const src = await mkSource('order-src');
  // 老候选在前、新候选在后 —— 顺序上老的先插入，FIFO 一定会先取它们
  await mkCandidate(src, '10.0.0.1', 300);
  await mkCandidate(src, '10.0.0.2', 240);
  await mkCandidate(src, '10.0.0.3', 180);
  await mkCandidate(src, '10.0.0.4', 5);
  await mkCandidate(src, '10.0.0.5', 3);

  const r = await tx((t) => promoteCandidates(t, src, 'RESTRICTED', 2));
  assert.equal(r.promoted, 2);

  const hosts = await promotedHosts();
  assert.deepEqual(
    [...hosts].sort(),
    ['10.0.0.4', '10.0.0.5'],
    `晋级的应该是最新的两条，实际 ${hosts.join(',')} —— FIFO 会取 10.0.0.1/2，` +
      '那是 4–5 小时前的 IP，探测它纯属浪费预算',
  );
});

console.log('\n[2] 过期保留期');

await check('超过保留期的候选被标过期，不再进入晋级队列', async () => {
  const src = await mkSource('stale-src');
  await mkCandidate(src, '10.1.0.1', 600); // 10 小时前
  await mkCandidate(src, '10.1.0.2', 10); // 10 分钟前

  const expired = await expireStaleCandidates(); // 默认 6 小时
  assert.ok(expired >= 1, '10 小时前的候选应该被标过期');

  const stale = await q<{ host: string }>(
    `SELECT host FROM candidate_endpoints WHERE stale_at IS NOT NULL AND source_id = $1`,
    [src],
  );
  assert.deepEqual(stale.map((s) => s.host), ['10.1.0.1']);

  const r = await tx((t) => promoteCandidates(t, src, 'RESTRICTED', 10));
  assert.equal(r.promoted, 1, '只有未过期的那条能被晋级');
  const hosts = await promotedHosts();
  assert.ok(hosts.includes('10.1.0.2'));
  assert.ok(!hosts.includes('10.1.0.1'), '过期的候选不该被晋级');
});

await check('保留期可调，且单位是小时（不是天）', async () => {
  const src = await mkSource('stale-unit-src');
  await mkCandidate(src, '10.2.0.1', 120); // 2 小时前

  // 保留期 1 小时 → 2 小时前的那条应该过期
  const expired = await expireStaleCandidates(1);
  assert.ok(expired >= 1, '参数 1 应被理解为 1 小时；若被当成 1 天则这里会是 0');

  const row = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM candidate_endpoints
     WHERE source_id = $1 AND stale_at IS NOT NULL`,
    [src],
  );
  assert.equal(row[0]?.n, 1);
});

console.log('\n[3] 重复候选不占探测预算');

await check('同一 IP 已被别的源晋级过 → 候选标 DUPLICATE，不再建端点', async () => {
  // 同一源内的重复在插入时就被 `uq_candidate_source_dedupe` 拦住了，
  // 所以重复判定真正要处理的是**跨源**：同一个 IP 出现在两个列表里。
  const srcA = await mkSource('dup-src-a');
  const srcB = await mkSource('dup-src-b');

  await mkCandidate(srcA, '10.3.0.1', 1);
  const first = await tx((t) => promoteCandidates(t, srcA, 'RESTRICTED', 10));
  assert.equal(first.promoted, 1);

  await mkCandidate(srcB, '10.3.0.1', 1);
  const second = await tx((t) => promoteCandidates(t, srcB, 'RESTRICTED', 10));
  assert.equal(second.promoted, 0);
  assert.equal(second.duplicate, 1, '跨源重复要被标 DUPLICATE，而不是再建一个端点');

  const n = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM proxy_endpoints WHERE dedupe_key = $1`,
    ['dk-10.3.0.1'],
  );
  assert.equal(n[0]?.n, 1, '同一个 IP 在端点表里只能有一行');
});

console.log('\n[4] 判死的端点被重新列出时重获一次探测机会');

/** 直接建一个已判死的端点，`lastCheckMinutes` 控制它上次被探测的时间。 */
async function mkRejectedEndpoint(
  sourceId: string,
  host: string,
  lastCheckMinutes: number,
): Promise<string> {
  const id = randomUUID();
  await exec(
    `INSERT INTO proxy_endpoints
       (id, source_id, protocol, host, port, origin_type, authorization_status, trust_tier,
        lifecycle_status, dedupe_key, display_name)
     VALUES ($1,$2,'SOCKS5',$3,1080,'PUBLIC_PROXY','RESTRICTED','PUBLIC_PROXY',
             'REJECTED',$4,$5)`,
    [id, sourceId, host, `dk-${host}`, `${host}:1080`],
  );
  await exec(
    `INSERT INTO endpoint_health_state (endpoint_id, last_check_at, consecutive_failures)
     VALUES ($1, now() - ($2 || ' minutes')::interval, 2)`,
    [id, String(lastCheckMinutes)],
  );
  return id;
}

async function lifecycleOf(id: string): Promise<string> {
  const row = await q<{ s: string }>(
    `SELECT lifecycle_status::text AS s FROM proxy_endpoints WHERE id = $1`,
    [id],
  );
  return row[0]?.s ?? 'MISSING';
}

await check('判死 13 小时后源站重新列出 → 复活为待验证，而不是永久丢弃', async () => {
  // 实测（2026-11）：87,897 条被判 DUPLICATE 的候选里 77,037 条的对应端点是
  // REJECTED，那些端点上一次被探测的中位时间是 13 小时前。而 REJECTED 在调度
  // 表里是 null 间隔（永不重测）—— 等于源站把同一个地址重新列一百次也没用。
  const srcA = await mkSource('revive-src-a');
  const srcB = await mkSource('revive-src-b');
  const epId = await mkRejectedEndpoint(srcA, '10.4.0.1', 13 * 60);

  await mkCandidate(srcB, '10.4.0.1', 1);
  const r = await tx((t) => promoteCandidates(t, srcB, 'RESTRICTED', 10));

  assert.equal(r.promoted, 0, '不该新建端点');
  assert.equal(r.duplicate, 1, '候选本身仍算重复');
  assert.equal(r.revived, 1, '应该复活一次');
  assert.equal(
    await lifecycleOf(epId),
    'PENDING_VERIFICATION',
    'REJECTED 必须回到待验证，否则永远进不了探测队列',
  );

  // 溯源要补：漏了它，新列出的那个源永远拿不到这份产出的 credit
  const prov = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM endpoint_sources WHERE endpoint_id = $1 AND source_id = $2`,
    [epId, srcB],
  );
  assert.equal(prov[0]?.n, 1, '复活时必须补写 endpoint_sources');
});

await check('刚探过不久的判死端点不复活（防止列表陈旧导致无限循环）', async () => {
  // 源站列表里常有一批早已失效的地址被反复列出。没有这个防抖，
  // 一个真死的地址会被「重新列出 → 复活 → 探测失败 → 判死」无限循环。
  const srcA = await mkSource('debounce-src-a');
  const srcB = await mkSource('debounce-src-b');
  const epId = await mkRejectedEndpoint(srcA, '10.5.0.1', 10); // 10 分钟前才探过

  await mkCandidate(srcB, '10.5.0.1', 1);
  const r = await tx((t) => promoteCandidates(t, srcB, 'RESTRICTED', 10));

  assert.equal(r.revived, 0, '刚探过的端点不该被复活');
  assert.equal(await lifecycleOf(epId), 'REJECTED');
});

await check('已在复探周期里的 UNAVAILABLE 不复活（它本来就会被重探）', async () => {
  const srcA = await mkSource('unavail-src-a');
  const srcB = await mkSource('unavail-src-b');
  const epId = await mkRejectedEndpoint(srcA, '10.6.0.1', 13 * 60);
  await exec(`UPDATE proxy_endpoints SET lifecycle_status = 'UNAVAILABLE' WHERE id = $1`, [epId]);

  await mkCandidate(srcB, '10.6.0.1', 1);
  const r = await tx((t) => promoteCandidates(t, srcB, 'RESTRICTED', 10));

  assert.equal(r.revived, 0);
  assert.equal(await lifecycleOf(epId), 'UNAVAILABLE', 'UNAVAILABLE 有自己的 120 分钟节奏，不该被插队');
});

await closeDb();
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
