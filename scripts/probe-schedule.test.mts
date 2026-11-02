/**
 * 分级探测调度回归测试。
 *
 * 跑在内存库（`DATABASE_URL=memory://`）。
 *
 * 这个调度器唯一容易做错的地方是**排序**：按"上次探测时间"排会让一堆
 * 6 小时周期的 HEALTHY 节点长期霸占预算，10 分钟周期的新候选永远轮不上。
 * 所以断言的重点是「谁先被探」，而不是「入队了几个」。
 *
 * 跑法：npm run test:schedule
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL ??= 'memory://';

const { closeDb, exec, getDb, q1 } = await import('../apps/api/src/db/client.js');
const { migrate } = await import('../apps/api/src/db/migrate.js');
const { enqueueDueProbes, scheduleBacklog } = await import('../apps/api/src/modules/verification/schedule.js');

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

/**
 * 造一个端点。
 * `ageMin` 是"上次探测距今多少分钟"，null 表示从没探过（用 created_at 兜底）。
 */
async function mkEndpoint(
  status: string,
  ageMin: number | null,
  opts: { deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await exec(
    `INSERT INTO proxy_endpoints
       (id, protocol, host, port, origin_type, lifecycle_status, quality_score, dedupe_key, deleted_at, created_at)
     VALUES ($1,'SOCKS5','203.0.113.1',1080,'PUBLIC_PROXY',$2,50,$3,$4,
             now() - ($5 || ' minutes')::interval)`,
    [id, status, `dk-${id}`, opts.deleted ? new Date() : null, String(ageMin ?? 0)],
  );
  if (ageMin !== null) {
    await exec(
      `INSERT INTO endpoint_health_state (endpoint_id, last_check_at)
       VALUES ($1, now() - ($2 || ' minutes')::interval)`,
      [id, String(ageMin)],
    );
  }
  return id;
}

/** 把调度任务标记为完成，解除 busy 守卫 */
async function clearSchedulerJobs(): Promise<void> {
  await exec(
    `UPDATE verification_jobs SET status = 'SUCCEEDED', finished_at = now()
     WHERE filter = '{"source":"scheduler"}'::jsonb AND status IN ('PENDING','RUNNING')`,
  );
}

/**
 * 把库里所有端点都置为"刚探过"。
 *
 * 后面几段测试关心的是排序与预算，前提是"没有别的端点抢在前面"。
 * 而"从没探过"的端点按设计会永远排在最前 —— 所以这里必须把
 * 还没有 health_state 行的端点也补一行，否则上一段留下的未探端点
 * 会一直插队，让后面的断言测的其实是它。
 */
async function settleAllEndpoints(): Promise<void> {
  await exec(
    `INSERT INTO endpoint_health_state (endpoint_id, last_check_at)
     SELECT e.id, now() FROM proxy_endpoints e
     WHERE NOT EXISTS (
       SELECT 1 FROM endpoint_health_state s WHERE s.endpoint_id = e.id
     )
     ON CONFLICT DO NOTHING`,
  );
  await exec(`UPDATE endpoint_health_state SET last_check_at = now()`);
}

async function jobEndpointIds(jobId: string): Promise<string[]> {
  const row = await q1<{ endpoint_ids: string[] }>(
    'SELECT endpoint_ids FROM verification_jobs WHERE id = $1',
    [jobId],
  );
  return row?.endpoint_ids ?? [];
}

console.log('\n[1] 未到期不入队');

await check('全部刚探过 → nothing-due，不创建任务', async () => {
  await mkEndpoint('HEALTHY', 5);
  await mkEndpoint('DEGRADED', 5);
  const r = await enqueueDueProbes();
  assert.equal(r.jobId, null);
  assert.equal(r.reason, 'nothing-due');
});

console.log('\n[1b] 首次探测不该等满间隔');

await check('从没探过的端点立刻到期，不用等满该档间隔', async () => {
  // 晋级出来的端点只有 created_at，没有 last_check_at。
  // 早期版本用 `COALESCE(last_check_at, created_at) <= now() - interval` 判定到期，
  // 于是刚晋级的端点要干等 10 分钟才轮到第一次探测 ——
  // 现场表现是"晋级了 400 个，探测队列 due 恒为 0，界面一动不动"，
  // 而日志里一切正常，只有数字全是零。档位里的分钟数是**复探**间隔，
  // 不该管首次探测。
  const id = await mkEndpoint('PENDING_VERIFICATION', null);
  const r = await enqueueDueProbes();
  assert.ok(r.jobId, '从没探过的端点应该立刻入队');
  assert.ok((await jobEndpointIds(r.jobId!)).includes(id));
  await clearSchedulerJobs();
});

await check('到期统计与入队判定一致', async () => {
  // 这两处曾经各写一份 SQL：界面按新间隔算 due，调度器按旧间隔入队，
  // 两边都不报错，只是数字对不上。现在共用 DUE_PREDICATE，断言它们同口径。
  const id = await mkEndpoint('PENDING_VERIFICATION', null);
  const pending = (await scheduleBacklog()).find((t) => t.status === 'PENDING_VERIFICATION');
  assert.ok((pending?.due ?? 0) >= 1, '界面必须能看见这个端点是到期的');

  const r = await enqueueDueProbes();
  assert.ok((await jobEndpointIds(r.jobId!)).includes(id), '界面说到期，调度器就必须入队');
  await clearSchedulerJobs();
});

console.log('\n[2] 到期入队');
await check('HEALTHY 超过 6 小时 → 入队', async () => {
  const id = await mkEndpoint('HEALTHY', 400);
  const r = await enqueueDueProbes();
  assert.ok(r.jobId, '应该创建任务');
  assert.ok((await jobEndpointIds(r.jobId!)).includes(id));
  await clearSchedulerJobs();
});

await check('DEGRADED 超过 30 分钟 → 入队；未满 30 分钟的不入队', async () => {
  const due = await mkEndpoint('DEGRADED', 45);
  const notDue = await mkEndpoint('DEGRADED', 20);
  const r = await enqueueDueProbes();
  const ids = await jobEndpointIds(r.jobId!);
  assert.ok(ids.includes(due));
  assert.ok(!ids.includes(notDue), '刚探过的 DEGRADED 不该再探');
  await clearSchedulerJobs();
});

console.log('\n[3] 排序：超期倍数优先');

await check('HEALTHY 超期 10 倍 排在 DISCOVERED 超期 1.1 倍 之前', async () => {
  // 清空可调度范围，只留这两个
  await settleAllEndpoints();
  const healthy = await mkEndpoint('HEALTHY', 3600);   // 360 分钟周期，超期 10 倍
  const fresh = await mkEndpoint('DISCOVERED', 11);    // 10 分钟周期，超期 1.1 倍
  const r = await enqueueDueProbes();
  const ids = await jobEndpointIds(r.jobId!);
  assert.equal(ids[0], healthy, '超期更狠的应该先探，否则慢周期节点会饿死快周期节点');
  assert.ok(ids.includes(fresh));
  await clearSchedulerJobs();
});

console.log('\n[3b] 首次探测与复探都不许饿死');

await check('新端点积压时，复探仍能进入批次', async () => {
  // 曾经的排序把"从没探过"放在绝对最前，于是只要有几十个新端点待探，
  // 复探永远轮不上。后果不是"慢"，而是**生命周期冻结**：
  // VERIFIED 等不到第二次确认 → HEALTHY 恒为 0 → 池子空 → 订阅空；
  // PENDING 凑不满连续失败 → REJECTED 永远不出现 → 死节点永不退出探测。
  await settleAllEndpoints();
  await clearSchedulerJobs();
  for (let i = 0; i < 50; i += 1) await mkEndpoint('PENDING_VERIFICATION', null);
  const verified = await mkEndpoint('VERIFIED', 20); // 15 分钟周期，已超期
  const r = await enqueueDueProbes(10);
  const ids = await jobEndpointIds(r.jobId!);
  assert.ok(ids.includes(verified), '复探必须分到配额，否则生命周期永远不推进');
  await clearSchedulerJobs();
});

await check('复探不足时，余量让给首次探测', async () => {
  await settleAllEndpoints();
  await clearSchedulerJobs();
  for (let i = 0; i < 10; i += 1) await mkEndpoint('PENDING_VERIFICATION', null);
  const r = await enqueueDueProbes(6);
  assert.equal(
    (await jobEndpointIds(r.jobId!)).length,
    6,
    '没有复探可做时批次必须用满，不能只入一半',
  );
  await clearSchedulerJobs();
});

console.log('\n[4] 预算上限');
await check('batch 参数限制单次入队数量', async () => {
  await settleAllEndpoints();
  await exec(`UPDATE endpoint_health_state SET last_check_at = now() - interval '10 hours'`);
  for (let i = 0; i < 12; i += 1) await mkEndpoint('HEALTHY', 600);
  const r = await enqueueDueProbes(5);
  assert.equal(r.picked, 5);
  assert.equal((await jobEndpointIds(r.jobId!)).length, 5);
  await clearSchedulerJobs();
});

console.log('\n[5] busy 守卫');

await check('已有调度任务在跑 → 不再入队（防止同一端点被并发探多次）', async () => {
  const first = await enqueueDueProbes(3);
  assert.ok(first.jobId);
  const second = await enqueueDueProbes(3);
  assert.equal(second.jobId, null);
  assert.equal(second.reason, 'busy');
  await clearSchedulerJobs();
});

console.log('\n[6] 永不探测的档位');

await check('REJECTED / REVOKED 再老也不入队', async () => {
  await exec(`UPDATE endpoint_health_state SET last_check_at = now()`);
  const rejected = await mkEndpoint('REJECTED', 99999);
  const revoked = await mkEndpoint('REVOKED', 99999);
  const r = await enqueueDueProbes();
  if (r.jobId) {
    const ids = await jobEndpointIds(r.jobId);
    assert.ok(!ids.includes(rejected), '人工否决的节点不该消耗探测预算');
    assert.ok(!ids.includes(revoked));
  }
  await clearSchedulerJobs();
});

await check('已软删除的端点不入队', async () => {
  await exec(`UPDATE endpoint_health_state SET last_check_at = now()`);
  const gone = await mkEndpoint('HEALTHY', 9999, { deleted: true });
  const r = await enqueueDueProbes();
  if (r.jobId) assert.ok(!(await jobEndpointIds(r.jobId)).includes(gone));
  await clearSchedulerJobs();
});

console.log('\n[7] 到期统计');

await check('scheduleBacklog 覆盖全部档位，且 due ≤ total', async () => {
  const tiers = await scheduleBacklog();
  assert.ok(tiers.length >= 7);
  for (const t of tiers) {
    assert.ok(t.due <= t.total, `${t.status}: due ${t.due} 不该大于 total ${t.total}`);
    assert.ok(t.intervalMin === null || t.intervalMin > 0);
  }
  const healthy = tiers.find((t) => t.status === 'HEALTHY');
  assert.equal(healthy?.intervalMin, 360);
});

await closeDb();
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
