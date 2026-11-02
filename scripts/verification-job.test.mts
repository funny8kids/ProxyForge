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

await closeDb();
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
