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
  await exec(`UPDATE endpoint_health_state SET last_check_at = now()`);
  const healthy = await mkEndpoint('HEALTHY', 3600);   // 360 分钟周期，超期 10 倍
  const fresh = await mkEndpoint('DISCOVERED', 11);    // 10 分钟周期，超期 1.1 倍
  const r = await enqueueDueProbes();
  const ids = await jobEndpointIds(r.jobId!);
  assert.equal(ids[0], healthy, '超期更狠的应该先探，否则慢周期节点会饿死快周期节点');
  assert.ok(ids.includes(fresh));
  await clearSchedulerJobs();
});

console.log('\n[4] 预算上限');

await check('batch 参数限制单次入队数量', async () => {
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
