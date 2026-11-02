/**
 * 验证任务端到端回归测试（fixture 探针）。
 *
 * 跑在内存库（`DATABASE_URL=memory://`），`PF_PROBE_MODE=fixture`
 * 保证结果确定、不发真实网络请求。
 *
 * 断言的是"探完之后世界变了"：
 *   · health_checks 落了一条记录
 *   · endpoint_health_state 的滚动窗口字段被更新
 *   · lifecycle_status 按连续成功/失败推进
 *   · 任务状态从 PENDING 走到 SUCCEEDED，且 completed 等于目标数
 *
 * 最后一条最重要：调度器只是"入队"，真正让状态变化的是这里。
 * 如果它卡住，整个分级探测就是空转 —— 界面上任务永远 RUNNING、done 停在 0。
 *
 * 跑法：npm run test:verify
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL ??= 'memory://';
process.env.PF_PROBE_MODE = 'fixture';

const { closeDb, exec, getDb, q1 } = await import('../apps/api/src/db/client.js');
const { migrate } = await import('../apps/api/src/db/migrate.js');
const { runVerificationJob } = await import('../apps/api/src/modules/verification/index.js');

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

/** 超时守卫：卡住时必须报错，而不是让测试挂死在那里 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未返回（疑似死锁）`)), ms),
    ),
  ]);
}

await getDb();
await migrate();

async function mkEndpoint(dedupe: string): Promise<string> {
  const id = randomUUID();
  await exec(
    `INSERT INTO proxy_endpoints
       (id, protocol, host, port, origin_type, lifecycle_status, quality_score, dedupe_key)
     VALUES ($1,'SOCKS5','203.0.113.9',1080,'PUBLIC_PROXY','PENDING_VERIFICATION',0,$2)`,
    [id, dedupe],
  );
  await exec(`INSERT INTO endpoint_health_state (endpoint_id) VALUES ($1)`, [id]);
  return id;
}

async function mkJob(ids: string[]): Promise<string> {
  const id = randomUUID();
  await exec(
    `INSERT INTO verification_jobs (id, scope, endpoint_ids, status, total)
     VALUES ($1,'ENDPOINTS',$2::uuid[],'PENDING',$3)`,
    [id, ids, ids.length],
  );
  return id;
}

console.log('\n[1] 单端点任务能跑完');

await check('1 个端点 → SUCCEEDED，health_checks 落 1 条', async () => {
  const id = await mkEndpoint('one');
  const jobId = await mkJob([id]);
  await withTimeout(runVerificationJob(jobId), 15000, 'runVerificationJob(1)');

  const job = await q1<{ status: string; completed: number; total: number }>(
    'SELECT status, completed, total FROM verification_jobs WHERE id = $1',
    [jobId],
  );
  assert.equal(job?.status, 'SUCCEEDED');
  assert.equal(job?.completed, 1);

  const hc = await q1<{ c: string }>(
    'SELECT count(*)::text AS c FROM health_checks WHERE endpoint_id = $1',
    [id],
  );
  assert.equal(hc?.c, '1');
});

console.log('\n[2] 并发多个端点不卡住');

await check('8 个端点并发探测 → 全部完成（PGlite 单连接 + 并发事务）', async () => {
  const ids = await Promise.all(
    Array.from({ length: 8 }, (_, i) => mkEndpoint(`multi-${i}`)),
  );
  const jobId = await mkJob(ids);
  await withTimeout(runVerificationJob(jobId), 30000, 'runVerificationJob(8)');

  const job = await q1<{ status: string; completed: number }>(
    'SELECT status, completed FROM verification_jobs WHERE id = $1',
    [jobId],
  );
  assert.equal(job?.status, 'SUCCEEDED');
  assert.equal(job?.completed, 8);

  const hc = await q1<{ c: string }>(
    'SELECT count(*)::text AS c FROM health_checks WHERE endpoint_id = ANY($1::uuid[])',
    [ids],
  );
  assert.equal(hc?.c, '8', '每个端点都该有且只有一条记录');
});

console.log('\n[3] 健康态与生命周期');

await check('探测后 health_state 的滚动窗口字段被写入', async () => {
  const id = await mkEndpoint('state');
  await withTimeout(runVerificationJob(await mkJob([id])), 15000, 'runVerificationJob(state)');

  const hs = await q1<{
    last_check_at: string | null; scored_at: string | null; success_rate_24h: string | null;
  }>(
    'SELECT last_check_at, scored_at, success_rate_24h::text FROM endpoint_health_state WHERE endpoint_id = $1',
    [id],
  );
  assert.ok(hs?.last_check_at, 'last_check_at 必须更新，否则调度器会一直认为它到期');
  assert.ok(hs?.scored_at);
  assert.ok(hs?.success_rate_24h !== null, '24h 成功率是质量分的输入，不能为空');
});

await check('从未验证过的端点探测成功 → 离开 PENDING_VERIFICATION', async () => {
  const id = await mkEndpoint('promote');
  await withTimeout(runVerificationJob(await mkJob([id])), 15000, 'runVerificationJob(promote)');
  const e = await q1<{ lifecycle_status: string }>(
    'SELECT lifecycle_status FROM proxy_endpoints WHERE id = $1',
    [id],
  );
  assert.notEqual(e?.lifecycle_status, 'PENDING_VERIFICATION');
});

console.log('\n[3b] 判死：从出生就是死的公开代理');

/**
 * 找一个在 fixture 下必然失败的种子。
 *
 * fixture 探针用 FNV-1a 对 dedupe_key 取模，roll < 16 判失败。
 * 这里复算同一套哈希，保证测试不依赖运气 —— 否则"失败两次"这个前提
 * 本身就成了随机事件，测试会间歇性飘。
 */
function failingSeed(prefix: string): string {
  for (let i = 0; i < 10000; i += 1) {
    const s = `${prefix}-${i}`;
    let h = 2166136261;
    for (let k = 0; k < s.length; k += 1) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 16777619);
    }
    if (Math.abs(h % 100) < 16) return s;
  }
  throw new Error('找不到在 fixture 下必然失败的种子');
}

await check('连续 2 次失败且从未成功 → REJECTED（彻底退出探测）', async () => {
  // 免费代理里九成是"出生就是死的"。只降级到 UNAVAILABLE 的话，
  // 它会按 120 分钟一轮被永远重探 —— 攒到几千个时，一半的探测容量
  // 都在给已经不存在的东西做体检。REJECTED 在调度表里是 null 间隔。
  const id = await mkEndpoint(failingSeed('dead'));
  for (let i = 0; i < 2; i += 1) {
    await withTimeout(runVerificationJob(await mkJob([id])), 15000, 'runVerificationJob(dead)');
  }
  const e = await q1<{ lifecycle_status: string }>(
    'SELECT lifecycle_status FROM proxy_endpoints WHERE id = $1',
    [id],
  );
  assert.equal(e?.lifecycle_status, 'REJECTED');
});

await check('成功过一次的端点掉线 → 停在 UNAVAILABLE，不判死', async () => {
  // 活过的节点仍可能回来。自动判死会让人在它恢复之后还得手工捞回来，
  // 那是帮倒忙 —— 所以判死条件必须同时满足"从未成功过"。
  const id = await mkEndpoint(failingSeed('wasalive'));
  await exec('UPDATE endpoint_health_state SET last_success_at = now() WHERE endpoint_id = $1', [id]);
  for (let i = 0; i < 3; i += 1) {
    await withTimeout(runVerificationJob(await mkJob([id])), 15000, 'runVerificationJob(wasalive)');
  }
  const e = await q1<{ lifecycle_status: string }>(
    'SELECT lifecycle_status FROM proxy_endpoints WHERE id = $1',
    [id],
  );
  assert.equal(e?.lifecycle_status, 'UNAVAILABLE');
});

console.log('\n[4] 幂等');
await check('对已完成的任务再跑一次 → 不重复写记录', async () => {
  const id = await mkEndpoint('idem');
  const jobId = await mkJob([id]);
  await withTimeout(runVerificationJob(jobId), 15000, 'runVerificationJob(idem)#1');
  await withTimeout(runVerificationJob(jobId), 15000, 'runVerificationJob(idem)#2');

  const hc = await q1<{ c: string }>(
    'SELECT count(*)::text AS c FROM health_checks WHERE endpoint_id = $1',
    [id],
  );
  assert.equal(hc?.c, '1', 'SUCCEEDED 的任务不该再探一遍');
});

console.log('\n[5] 与周期任务并发');

await check('探测进行中同时执行 CHECKPOINT / 池重算 → 不死锁', async () => {
  const ids = await Promise.all(
    Array.from({ length: 20 }, (_, i) => mkEndpoint(`race-${i}`)),
  );
  const jobId = await mkJob(ids);

  // 复现线上的真实并发：worker 的 tick（跑探测）和 periodic（CHECKPOINT、
  // 池重算、告警评估）是两条独立的循环，会同时打在同一个 PGlite 连接上。
  // 这里手动制造这个交叠。
  const job = runVerificationJob(jobId);
  const noise = (async () => {
    for (let i = 0; i < 5; i += 1) {
      await exec('CHECKPOINT');
      await exec('SELECT 1');
    }
  })();

  await withTimeout(
    Promise.all([job, noise]),
    30000,
    '探测 + CHECKPOINT 并发',
  );

  const j = await q1<{ status: string; completed: number }>(
    'SELECT status, completed FROM verification_jobs WHERE id = $1',
    [jobId],
  );
  assert.equal(j?.status, 'SUCCEEDED');
  assert.equal(j?.completed, 20);
});

console.log('\n[质量分不能奖励小样本]');

const { qualityScore, smoothedSuccessRate } = await import('../apps/api/src/modules/verification/probe.js');

await check('一次成功不该拿满分成功率', async () => {
  // 裸成功率下 1/1 就是 1.0，能拿 70 分满分，压过所有打过多轮的老节点。
  // 实测后果：池子里换进一批刚探一次的新节点，导出订阅后抽查 12 个
  // 只有 1 个能连 HTTPS（此前 9/12）。
  const one = smoothedSuccessRate(1, 1);
  const four = smoothedSuccessRate(4, 4);
  assert.ok(one < 0.7, `1/1 的平滑成功率 ${one} 不该接近满分`);
  assert.ok(four > one, '4/4 必须比 1/1 更可信');
  assert.ok(four - one > 0.1, `差距 ${four - one} 太小，排不开序`);
});

await check('质量分排序：多轮全胜 > 单次全胜 > 半数成功', async () => {
  const fast = { p50Ms: 600, jitterMs: 50 };
  const q1 = qualityScore({ successes: 4, total: 4, ...fast });
  const q2 = qualityScore({ successes: 1, total: 1, ...fast });
  const q3 = qualityScore({ successes: 2, total: 4, ...fast });
  assert.ok(q1 > q2, `4/4 (${q1}) 应高于 1/1 (${q2})`);
  assert.ok(q2 > q3, `1/1 (${q2}) 应高于 2/4 (${q3})`);
});

await check('零样本按先验半分，不按 0 分', async () => {
  // total=0 时不能返回 0：那会让"刚建出来还没探过"和"探了全失败"同分，
  // 而前者恰恰是最该给它一次机会的。
  assert.equal(smoothedSuccessRate(0, 0), 0.5);
  const none = qualityScore({ successes: 0, total: 0, p50Ms: null, jitterMs: null });
  const allFail = qualityScore({ successes: 0, total: 5, p50Ms: null, jitterMs: null });
  assert.ok(none > allFail, `没探过 (${none}) 不该低于全失败 (${allFail})`);
});

console.log('\n[隧道能力 connect_ok]');

await check('成功探测会写入 connect_ok，失败探测不会把它抹掉', async () => {
  // 语义要点：`connect_ok = null` 表示"这次没测"，写入时必须 COALESCE 保留旧值。
  // 如果写成直接赋值，一次失败探测就会把已知的"支持隧道"抹成 NULL ——
  // 池子与订阅都按 connect_ok 排序，节点会在排序里来回跳。
  const ids: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    const id = await mkEndpoint(`connect-${i}`);
    // 先给它一个已知结论，再看失败探测会不会覆盖掉
    await exec(`UPDATE endpoint_health_state SET connect_ok = true WHERE endpoint_id = $1`, [id]);
    ids.push(id);
  }

  const jobId = await mkJob(ids);
  await withTimeout(runVerificationJob(jobId), 30000, '验证任务');

  const rows = await q1<{ ok_fail: string; kept: string; succ_null: string; total: string }>(
    `SELECT
       count(*) FILTER (WHERE hc.success = false AND hs.connect_ok IS NOT true)::text AS ok_fail,
       count(*) FILTER (WHERE hc.success = true  AND hs.connect_ok IS NOT NULL)::text AS kept,
       count(*) FILTER (WHERE hc.success = true  AND hs.connect_ok IS NULL)::text     AS succ_null,
       count(*)::text AS total
     FROM endpoint_health_state hs
     JOIN LATERAL (
       SELECT success FROM health_checks WHERE endpoint_id = hs.endpoint_id
       ORDER BY checked_at DESC LIMIT 1
     ) hc ON true
     WHERE hs.endpoint_id = ANY($1::uuid[])`,
    [ids],
  );

  assert.equal(Number(rows?.ok_fail), 0, '失败探测把已有的 connect_ok 抹掉了');
  assert.equal(Number(rows?.succ_null), 0, '成功探测必须给出确定的 connect_ok');
  assert.ok(Number(rows?.kept) > 0, '样本里没有任何成功探测，断言没有意义');
  assert.equal(Number(rows?.total), 24);
});

await check('健康节点失败一次就降到 DEGRADED', async () => {
  // 为什么这条重要：HEALTHY 的复探周期 360 分钟、DEGRADED 是 30 分钟。
  // 失败后留在 HEALTHY 的话，要攒满 3 次连续失败才变 UNAVAILABLE，
  // 也就是一个已经死掉的节点会在池子和订阅里赖 18 小时。
  // 实测：300 个池成员全量复探，122 个当场失败却全部仍是 HEALTHY，
  // 均匀抽 40 个连 HTTPS，29 个完全不通。
  const ids: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    const id = await mkEndpoint(`degrade-${i}`);
    await exec(`UPDATE proxy_endpoints SET lifecycle_status = 'HEALTHY' WHERE id = $1`, [id]);
    ids.push(id);
  }

  const jobId = await mkJob(ids);
  await withTimeout(runVerificationJob(jobId), 30000, '验证任务');

  const bad = await q1<{ c: string }>(
    `SELECT count(*)::text AS c
       FROM endpoint_health_state hs
       JOIN proxy_endpoints e ON e.id = hs.endpoint_id
       JOIN LATERAL (
         SELECT success FROM health_checks WHERE endpoint_id = hs.endpoint_id
         ORDER BY checked_at DESC LIMIT 1
       ) hc ON true
      WHERE hs.endpoint_id = ANY($1::uuid[])
        AND hc.success = false
        AND hs.consecutive_failures = 1
        AND e.lifecycle_status <> 'DEGRADED'`,
    [ids],
  );
  assert.equal(Number(bad?.c), 0, '首次失败的节点必须降级，否则要 18 小时才会被摘掉');
});

await closeDb();
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
