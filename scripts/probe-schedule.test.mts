/**
 * 分级探测调度回归测试。
 *
 * 跑在内存库（`DATABASE_URL=memory://`）。
 *
 * 这个调度器唯一容易做错的地方是**排序**：按"上次探测时间"排会让一堆
 * 长周期的 HEALTHY 节点长期霸占预算，短周期的新候选永远轮不上。
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

console.log('\n[1c] 僵尸任务不能锁死探测');

/**
 * 造一个"半死不活"的调度任务。
 *
 * `ageMin` 控制 started_at 距今多久 —— 这是区分"正常在跑"和"上一个进程
 * 被强杀留下的残骸"的唯一依据。
 */
async function mkStuckJob(status: 'PENDING' | 'RUNNING', ageMin: number): Promise<string> {
  const row = await q1<{ id: string }>(
    `INSERT INTO verification_jobs (scope, endpoint_ids, status, total, priority, filter, started_at)
     VALUES ('ENDPOINTS', ARRAY[]::uuid[], $1, 1, 50, '{"source":"scheduler"}'::jsonb,
             now() - ($2 || ' minutes')::interval)
     RETURNING id`,
    [status, String(ageMin)],
  );
  return row!.id;
}

/**
 * 造一个「建了但从未被认领」的调度任务：`started_at` 为 NULL。
 *
 * 这种形态的年龄只能靠 created_at 衡量 —— 这正是修复的核心：
 * 闸门与回收都要用 `COALESCE(started_at, created_at)` 判断，
 * 否则「没开始」会被当成「刚刚开始」，永远活着。
 */
async function mkUnclaimedJob(ageMin: number): Promise<string> {
  const row = await q1<{ id: string }>(
    `INSERT INTO verification_jobs (scope, endpoint_ids, status, total, priority, filter, created_at)
     VALUES ('ENDPOINTS', ARRAY[]::uuid[], 'PENDING', 1, 50, '{"source":"scheduler"}'::jsonb,
             now() - ($1 || ' minutes')::interval)
     RETURNING id`,
    [String(ageMin)],
  );
  return row!.id;
}

await check('PENDING 但已超窗的僵尸任务不再挡住入队', async () => {
  // 真实事故：进程在探测途中被强杀，任务停在 PENDING、started_at 已写。
  // 回收只扫 RUNNING，闸门却看 PENDING+RUNNING —— 两套条件分叉的结果是
  // 这个任务永远不会被回收，也永远挡着入队，分级探测静默停摆。
  await mkEndpoint('PENDING_VERIFICATION', null);
  const zombie = await mkStuckJob('PENDING', 30);

  const r = await enqueueDueProbes();
  assert.equal(r.reason, undefined, `僵尸任务 ${zombie.slice(0, 8)} 不该让入队返回 ${r.reason}`);
  assert.ok(r.jobId, '僵尸任务超窗后必须放行新任务');

  const after = await q1<{ status: string }>('SELECT status FROM verification_jobs WHERE id = $1', [zombie]);
  assert.equal(after?.status, 'FAILED', '超窗任务必须被标 FAILED，而不是留在 PENDING 里反复失败');
  await clearSchedulerJobs();
});

await check('从未被认领的 PENDING 任务超窗后同样要回收', async () => {
  // 真实事故（第二次踩同一个坑）：任务是 PENDING 且 started_at 为 NULL ——
  // 建了但一次都没被认领。旧闸门把 `started_at IS NULL` 当成"刚刚开始"，
  // 于是它永远算活跃；旧回收又要求 `started_at IS NOT NULL`，永远碰不到它。
  // 两边合起来是永久死锁：探测停摆 96 分钟，日志每 15 秒一行「探测暂停」，
  // 没有任何报错，库里所有端点再也没被探过一次。
  await mkEndpoint('PENDING_VERIFICATION', null);
  const unclaimed = await mkUnclaimedJob(30);

  const r = await enqueueDueProbes();
  assert.equal(r.reason, undefined, '未认领且超窗的任务不该挡住入队');
  assert.ok(r.jobId, '必须放行新任务');

  const after = await q1<{ status: string }>('SELECT status FROM verification_jobs WHERE id = $1', [unclaimed]);
  assert.equal(after?.status, 'FAILED', '未认领但超窗的任务必须被标 FAILED');
  await clearSchedulerJobs();
});

await check('刚创建、还没被认领的任务仍然挡住入队', async () => {
  // 反面断言：把 COALESCE 加上之后，闸门不能对"排队中的正常任务"失效。
  // 前一个批次还在跑时，新批次排队是正确的行为。
  await mkEndpoint('PENDING_VERIFICATION', null);
  const queued = await mkUnclaimedJob(0);

  const r = await enqueueDueProbes();
  assert.equal(r.reason, 'busy', '排队中的正常任务必须挡住入队');
  assert.equal(r.picked, 0);

  await exec(`UPDATE verification_jobs SET status='SUCCEEDED', finished_at=now() WHERE id=$1`, [queued]);
  await clearSchedulerJobs();
});

await check('刚启动的正常任务仍然挡住入队', async () => {
  // 反面断言：闸门不能因为上面那条修复就形同虚设。慢探测期间每 15 秒堆一个
  // 任务会让同一端点被并发探多次，health_checks 里全是重复样本。
  await mkEndpoint('PENDING_VERIFICATION', null);
  const fresh = await mkStuckJob('RUNNING', 0);

  const r = await enqueueDueProbes();
  assert.equal(r.reason, 'busy', '刚认领的任务必须挡住入队');
  assert.equal(r.picked, 0);

  await exec(`UPDATE verification_jobs SET status='SUCCEEDED', finished_at=now() WHERE id=$1`, [fresh]);
  await clearSchedulerJobs();
});

await check('重启时 RUNNING 任务被判 FAILED，不再挡门', async () => {
  /**
   * 这里原本断言"重置成 PENDING 且清空 started_at"。那个写法有个隐蔽的
   * 副作用：退回 PENDING 之后，`ACTIVE_JOB_PREDICATE` 仍然把
   * 「PENDING 且 created_at 在 10 分钟内」算作正在跑（防止同一端点被并发
   * 探多次），于是被回收的孤儿任务一边挡着 busy 守卫、一边又因为
   * `attempts` 用满而永远不会被认领 —— 探测静默停摆整整 10 分钟。
   *
   * 实测每次重启都撞上：日志一行「探测暂停：上一个调度任务 xxx 仍在运行」，
   * 然后 10 分钟里什么都不发生。
   *
   * 判 FAILED 才是正确语义：进程死在半路，那批结果本来就丢了；
   * 端点仍处于到期状态，下一个调度周期会重新入队。
   */
  const job = await mkStuckJob('RUNNING', 0);
  const { reclaimAllRunning } = await import('../apps/api/src/modules/verification/schedule.js');
  await reclaimAllRunning();

  const row = await q1<{ status: string; finished_at: string | null }>(
    'SELECT status, finished_at FROM verification_jobs WHERE id = $1',
    [job],
  );
  assert.equal(row?.status, 'FAILED', '孤儿任务必须终结，不能退回 PENDING');
  assert.notEqual(row?.finished_at, null, '终结的任务要写 finished_at');

  await exec(`UPDATE verification_jobs SET status='SUCCEEDED', finished_at=now() WHERE id=$1`, [job]);
  await clearSchedulerJobs();
});

await check('重试耗尽的 PENDING 任务不挡门，且会被判 FAILED', async () => {
  // attempts 用满之后 claimJobs 永远不会再认领它（条件要求 attempts < max_attempts）。
  // 如果还让它算"活跃"，探测就被一个永远跑不了的任务挡死。
  const job = await mkStuckJob('PENDING', 0);
  await exec('UPDATE verification_jobs SET attempts = max_attempts WHERE id = $1', [job]);

  const r = await enqueueDueProbes();
  assert.equal(r.reason !== 'busy', true, '重试耗尽的 PENDING 任务不该挡住入队');

  await clearSchedulerJobs();
  const row = await q1<{ status: string }>('SELECT status FROM verification_jobs WHERE id = $1', [job]);
  assert.equal(row?.status, 'FAILED', '重试耗尽的任务应被回收为 FAILED');
});

console.log('\n[2] 到期入队');
await check('HEALTHY 超过复探周期 → 入队', async () => {
  const id = await mkEndpoint('HEALTHY', 400);
  const r = await enqueueDueProbes();
  assert.ok(r.jobId, '应该创建任务');
  assert.ok((await jobEndpointIds(r.jobId!)).includes(id));
  await clearSchedulerJobs();
});

await check('DEGRADED 超过 10 分钟 → 入队；未满 10 分钟的不入队', async () => {
  // 周期从 30 分钟改成 10 分钟：DEGRADED → HEALTHY 要连续两次成功，
  // 30 分钟一轮意味着误判的节点要在订阅尾部待一小时。
  const due = await mkEndpoint('DEGRADED', 15);
  const notDue = await mkEndpoint('DEGRADED', 5);
  const r = await enqueueDueProbes();
  const ids = await jobEndpointIds(r.jobId!);
  assert.ok(ids.includes(due));
  assert.ok(!ids.includes(notDue), '刚探过的 DEGRADED 不该再探');
  await clearSchedulerJobs();
});

console.log('\n[2b] 池成员优先复探');

/**
 * 造一个池并把端点加进去。
 *
 * 池成员是真正会被下发到订阅里的那批节点，它们的状态陈旧度直接等于
 * 用户看到的故障率；池外节点探得再勤也不产出。所以同档内要让池成员先探。
 */
const TEST_POOL_ID = '00000000-0000-7000-8000-000000000001';
async function addToPool(endpointId: string): Promise<void> {
  await exec(
    `INSERT INTO resource_pools (id, key, name, min_quality, max_members, allowed_tiers, experimental, enabled)
     VALUES ($1, 'TEST_POOL', '测试池', 0, 1000, ARRAY['PUBLIC_PROXY']::trust_tier[], false, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_POOL_ID],
  );
  await exec(
    `INSERT INTO resource_pool_members (pool_id, endpoint_id, weight, source, suppressed)
     VALUES ($1, $2, 100, 'AUTO', false)
     ON CONFLICT (pool_id, endpoint_id) DO NOTHING`,
    [TEST_POOL_ID, endpointId],
  );
}

await check('同档内池成员排在池外节点前面', async () => {
  await settleAllEndpoints();
  await clearSchedulerJobs();
  // 两个节点超期程度完全相同 —— 唯一能区分它们的只有「是否池成员」
  const inPool = await mkEndpoint('HEALTHY', 400);
  const outside = await mkEndpoint('HEALTHY', 400);
  await addToPool(inPool);

  const r = await enqueueDueProbes();
  const ids = await jobEndpointIds(r.jobId!);
  assert.ok(ids.includes(inPool) && ids.includes(outside), '两个都该入队');
  assert.ok(
    ids.indexOf(inPool) < ids.indexOf(outside),
    '池成员必须先探：它才是会下发到订阅里的那个',
  );
  await clearSchedulerJobs();
});

await check('池成员优先不会改变档位之间的份额', async () => {
  // 反面断言：这只是同档内的顺序调整，不能让 HEALTHY 抢走 VERIFIED 的配额
  await settleAllEndpoints();
  await clearSchedulerJobs();
  const verifiedIds: string[] = [];
  for (let i = 0; i < 60; i += 1) verifiedIds.push(await mkEndpoint('VERIFIED', 60));
  for (let i = 0; i < 60; i += 1) await addToPool(await mkEndpoint('HEALTHY', 400));

  const r = await enqueueDueProbes(20);
  const ids = await jobEndpointIds(r.jobId!);
  assert.ok(
    ids.some((id) => verifiedIds.includes(id)),
    'VERIFIED 是通往 HEALTHY 的关键路径，不能被池成员挤光',
  );
  await clearSchedulerJobs();
});

console.log('\n[3] 排序与优先级');

await check('同档内：超期更狠的先探', async () => {
  // 档位之间靠份额保底（见 [3b]），档位内部靠超期倍数。
  // 用绝对时间排会让"6 小时周期的节点超期 1 小时"排在
  // "30 分钟周期的节点超期 30 分钟"前面，后者其实更急。
  await settleAllEndpoints();
  await clearSchedulerJobs();
  const older = await mkEndpoint('HEALTHY', 3600); // 欠得极多
  const newer = await mkEndpoint('HEALTHY', 400); // 也超期，但欠得少得多
  const r = await enqueueDueProbes();
  const ids = await jobEndpointIds(r.jobId!);
  assert.ok(ids.includes(older) && ids.includes(newer));
  assert.ok(ids.indexOf(older) < ids.indexOf(newer), '同档内欠得多的先探');
  await clearSchedulerJobs();
});

await check('VERIFIED 优先于 PENDING_VERIFICATION（关键路径）', async () => {
  // VERIFIED 是通往 HEALTHY 的唯一路径：一次成功就让节点变成可下发。
  // 按超期倍数排的话它永远排不上 —— PENDING 超期 3 倍 vs VERIFIED 刚超期
  // 1.07 倍，后者会被永久挤掉，于是 HEALTHY 恒为 0。
  await settleAllEndpoints();
  await clearSchedulerJobs();
  const pending = await mkEndpoint('PENDING_VERIFICATION', 30); // 超期 3 倍
  const verified = await mkEndpoint('VERIFIED', 16); // 刚超期
  const r = await enqueueDueProbes();
  const ids = await jobEndpointIds(r.jobId!);
  assert.ok(ids.includes(verified), 'VERIFIED 必须被探，否则 HEALTHY 永远是 0');
  assert.ok(ids.indexOf(verified) < ids.indexOf(pending), '关键路径排在前');
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

await check('HEALTHY 有保底份额，不会被 VERIFIED 挤掉', async () => {
  // 只按优先级排会让 HEALTHY 永远排在 VERIFIED/PENDING 后面，
  // 那样订阅里会长期留着已经死掉的节点 —— 比不产出更糟。
  // 份额保证任何一档都不会饿死，这是构造出来的，不是靠排序碰巧。
  await settleAllEndpoints();
  await clearSchedulerJobs();
  for (let i = 0; i < 200; i += 1) await mkEndpoint('VERIFIED', 30);
  const healthy = await mkEndpoint('HEALTHY', 400); // 超期，但相对 VERIFIED 不算欠得多
  const r = await enqueueDueProbes(40);
  const ids = await jobEndpointIds(r.jobId!);
  assert.ok(ids.includes(healthy), 'HEALTHY 必须分到配额，否则死节点会一直留在订阅里');
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
  // 断言上限而不是具体值：这个数的意义是「订阅快照能有多陈旧」，
  // 不是「常量等于几」。公开代理存活期是几十分钟级别，复探周期一旦
  // 到了小时量级，订阅发出去的全是几小时前的状态 —— 实测过一次：
  // 池里 300 个成员没有一个在 30 分钟内成功过，位置 50 之后可用率 0%。
  assert.ok(
    healthy?.intervalMin !== null && (healthy?.intervalMin ?? 0) > 0 && (healthy?.intervalMin ?? 0) <= 60,
    `HEALTHY 复探周期 ${healthy?.intervalMin} 分钟太长，订阅会发陈旧快照`,
  );
});

await closeDb();
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
