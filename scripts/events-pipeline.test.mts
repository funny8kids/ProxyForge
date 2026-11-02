/**
 * Outbox 消费链路回归测试。
 *
 * 跑在**内存库**上（`DATABASE_URL=memory://`），不碰 .data/pg ——
 * 这个环境的 PGlite 数据目录被强杀之后会丢 WAL 尾巴，测试不该冒这个险。
 *
 * 断言的是三件容易做错的事：
 *   · 告警去重：同一个 key 反复触发只累加 count，不新建行
 *   · 告警自愈：条件消失后自动 RESOLVED，而不是永远飘红
 *   · 死信：消费方一直失败时，超过上限要变 DEAD 而不是无限重试，
 *     重放时要跳过已经成功的消费方（否则指标会重复累加）
 *
 * 跑法：npm run test:events
 */
import assert from 'node:assert/strict';
import { closeDb, exec, getDb, q, q1, tx } from '../apps/api/src/db/client.js';
import { migrate } from '../apps/api/src/db/migrate.js';
import { emit, EVENT_TYPES } from '../apps/api/src/shared/events.js';
import { raiseAlert, resolveStale, listAlerts } from '../apps/api/src/modules/events/alerts.js';
import { evaluateAlerts } from '../apps/api/src/modules/events/evaluate.js';
import { CONSUMERS, type Consumer } from '../apps/api/src/modules/events/consumers.js';
import { relayOutbox } from '../apps/api/src/worker/main.js';

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
console.log('\n[1] 事件指标聚合');

await check('同一事件消费两次 → 计数为 2', async () => {
  const evt = {
    id: '1', eventId: 'e1', eventType: 'endpoint.imported', aggregateType: 'endpoint',
    aggregateId: 'a', payload: {}, occurredAt: new Date().toISOString(), attempts: 0,
  };
  const metrics = CONSUMERS.find((c) => c.name === 'metrics')!;
  await metrics.handle(evt);
  await metrics.handle(evt);
  const row = await q1<{ count: string }>(
    `SELECT count::text FROM event_metrics_daily WHERE day = current_date AND event_type = 'endpoint.imported'`,
  );
  assert.equal(Number(row?.count), 2);
});

console.log('\n[2] 告警去重与升级');

await check('同 key 触发三次 → 一行、count=3', async () => {
  for (let i = 0; i < 3; i += 1) {
    await raiseAlert({ key: 'test.dedupe', severity: 'WARNING', title: '测试告警' });
  }
  const rows = await q<{ count: string }>(`SELECT count::text FROM alerts WHERE key = 'test.dedupe'`);
  assert.equal(rows.length, 1, '不该出现重复行');
  assert.equal(Number(rows[0]?.count), 3);
});

await check('severity 只升不降', async () => {
  await raiseAlert({ key: 'test.dedupe', severity: 'CRITICAL', title: '升级' });
  let row = await q1<{ severity: string }>(`SELECT severity FROM alerts WHERE key = 'test.dedupe'`);
  assert.equal(row?.severity, 'CRITICAL');

  // 再报一次低级别，不应该把 CRITICAL 覆盖成 INFO
  await raiseAlert({ key: 'test.dedupe', severity: 'INFO', title: '降级尝试' });
  row = await q1<{ severity: string }>(`SELECT severity FROM alerts WHERE key = 'test.dedupe'`);
  assert.equal(row?.severity, 'CRITICAL');
});

await check('解决后同 key 再触发 → 新建一条（历史保留）', async () => {
  await exec(`UPDATE alerts SET status = 'RESOLVED', resolved_at = now() WHERE key = 'test.dedupe'`);
  await raiseAlert({ key: 'test.dedupe', severity: 'INFO', title: '复发' });
  const rows = await q<{ status: string }>(`SELECT status FROM alerts WHERE key = 'test.dedupe'`);
  assert.equal(rows.length, 2, '已解决的那条应该留着');
  assert.equal(rows.filter((r) => r.status !== 'RESOLVED').length, 1);
});

console.log('\n[3] 自愈');

await check('resolveStale 只关自己前缀范围内的告警', async () => {
  await raiseAlert({ key: 'scope.a:1', severity: 'INFO', title: 'A' });
  await raiseAlert({ key: 'scope.b:1', severity: 'INFO', title: 'B' });

  const n = await resolveStale('scope.a:', []);
  assert.equal(n, 1, '只该关掉 scope.a 那一条');

  const b = await q1<{ status: string }>(`SELECT status FROM alerts WHERE key = 'scope.b:1'`);
  assert.equal(b?.status, 'OPEN', 'scope.b 不该被动到');
});

await check('条件消失 → 评估器自动关闭网关告警', async () => {
  // 只跑 migrate 不跑 seed，实例要自己建
  await exec(`INSERT INTO gateway_instances (name, runtime_state) VALUES ('test-gw', 'RUNNING')`);
  const inst = await q1<{ id: string }>(`SELECT id FROM gateway_instances WHERE name = 'test-gw'`);
  assert.ok(inst, '测试实例没建出来');

  await exec(`UPDATE gateway_instances SET runtime_state = 'FAILED', runtime_error = '测试' WHERE id = $1`, [inst!.id]);
  const first = await evaluateAlerts();
  assert.ok(first.raised >= 1, '应该提出告警');

  const open = await q1<{ severity: string }>(
    `SELECT severity FROM alerts WHERE key = $1 AND status <> 'RESOLVED'`,
    [`gateway.not_running:${inst!.id}`],
  );
  assert.equal(open?.severity, 'CRITICAL');

  await exec(`UPDATE gateway_instances SET runtime_state = 'RUNNING', runtime_error = NULL WHERE id = $1`, [inst!.id]);
  await evaluateAlerts();

  const after = await q1<{ status: string; auto_resolved: boolean }>(
    `SELECT status, auto_resolved FROM alerts WHERE key = $1 ORDER BY last_seen_at DESC LIMIT 1`,
    [`gateway.not_running:${inst!.id}`],
  );
  assert.equal(after?.status, 'RESOLVED');
  assert.equal(after?.auto_resolved, true, '应该标记为自动解决');
});

console.log('\n[4] 死信与重放');

await check('消费方持续失败 → 退避后进入 DEAD', async () => {
  const poison: Consumer = {
    name: 'poison',
    async handle() {
      throw new Error('故意失败');
    },
  };

  await tx(async (t) => {
    await emit(t, {
      type: EVENT_TYPES.ENDPOINT_IMPORTED,
      aggregateType: 'endpoint',
      aggregateId: 'dead-test',
      payload: { n: 1 },
    });
  });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // 退避会把 next_attempt_at 推到未来，测试里直接拉回来
    await exec(`UPDATE event_outbox SET next_attempt_at = now() WHERE status = 'PENDING'`);
    await relayOutbox([poison]);
  }

  const row = await q1<{ status: string; attempts: number; last_error: string }>(
    `SELECT status, attempts, last_error FROM event_outbox WHERE aggregate_id = 'dead-test'`,
  );
  assert.equal(row?.status, 'DEAD', `期望 DEAD，实际 ${row?.status}`);
  assert.equal(row?.attempts, 5);
  assert.match(row?.last_error ?? '', /故意失败/);
});

await check('重放跳过已成功的消费方', async () => {
  // 一条新事件：metrics 成功、poison 失败
  const poison: Consumer = {
    name: 'poison',
    async handle() {
      throw new Error('故意失败');
    },
  };
  await tx(async (t) => {
    await emit(t, {
      type: EVENT_TYPES.POOL_MEMBERSHIP_CHANGED,
      aggregateType: 'pool',
      aggregateId: 'replay-test',
      payload: { memberCount: 5 },
    });
  });

  await exec(`UPDATE event_outbox SET next_attempt_at = now() WHERE status = 'PENDING'`);
  await relayOutbox([CONSUMERS[0]!, poison]); // metrics 成功，poison 失败

  const mid = await q1<{ consumer_state: Record<string, { ok: boolean }> }>(
    `SELECT consumer_state FROM event_outbox WHERE aggregate_id = 'replay-test'`,
  );
  assert.equal(mid?.consumer_state['metrics']?.ok, true, 'metrics 应该已成功');
  assert.equal(mid?.consumer_state['poison']?.ok, false);

  // 重放语义：清掉失败消费方、保留成功的
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mid?.consumer_state ?? {})) if (v.ok) kept[k] = v;
  await exec(
    `UPDATE event_outbox SET status = 'PENDING', attempts = 0, consumer_state = $1::jsonb,
            next_attempt_at = now(), last_error = NULL WHERE aggregate_id = 'replay-test'`,
    [JSON.stringify(kept)],
  );

  const before = await q1<{ count: string }>(
    `SELECT count::text FROM event_metrics_daily WHERE event_type = 'pool.membership.changed'`,
  );

  // 再跑一次，只传一个会成功的 consumer —— metrics 不该被再次执行
  await relayOutbox([{ name: 'poison', async handle() {} }]);

  const after = await q1<{ count: string }>(
    `SELECT count::text FROM event_metrics_daily WHERE event_type = 'pool.membership.changed'`,
  );
  assert.equal(before?.count, after?.count, '重放不该让指标重复累加');

  const done = await q1<{ status: string }>(
    `SELECT status FROM event_outbox WHERE aggregate_id = 'replay-test'`,
  );
  assert.equal(done?.status, 'PUBLISHED');
});

console.log('\n[5] 告警列表');

await check('listAlerts 按严重度排序，默认只返回未解决', async () => {
  const items = await listAlerts({ status: 'open', limit: 50 });
  assert.ok(items.length > 0);
  assert.ok(items.every((a) => a.status !== 'RESOLVED'));
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(rank[items[i - 1]!.severity] <= rank[items[i]!.severity], 'CRITICAL 应排在前面');
  }
});

await closeDb();
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
