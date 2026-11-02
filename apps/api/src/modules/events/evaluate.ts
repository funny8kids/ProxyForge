import { q } from '../../db/client.js';
import { raiseAlert, resolveStale } from './alerts.js';

/**
 * 周期告警评估。
 *
 * 这里只放**不是某个事件触发**的条件：网关进程挂了、有死信堆积、
 * 导入连续失败。这些状态的变化没有对应的领域事件（进程崩溃不会写 outbox），
 * 只能轮询。
 *
 * 每个评估器必须同时算出"当前活跃的 key 集合"，交给 resolveStale 关掉
 * 已经不成立的告警 —— 否则告警只增不减，很快就没人看了。
 */

export interface EvaluationResult {
  raised: number;
  resolved: number;
}

/** 网关实例运行态异常。STOPPED 不算：实验室实例本来就该是停着的。 */
async function evalGateway(): Promise<EvaluationResult> {
  const rows = await q<{ id: string; name: string; runtime_state: string; runtime_error: string | null }>(
    `SELECT id, name, runtime_state, runtime_error FROM gateway_instances
     WHERE runtime_state IN ('FAILED', 'DEGRADED')`,
  );
  const active: string[] = [];
  for (const r of rows) {
    const key = `gateway.not_running:${r.id}`;
    active.push(key);
    await raiseAlert({
      key,
      severity: r.runtime_state === 'FAILED' ? 'CRITICAL' : 'WARNING',
      title: `网关 ${r.name} 未正常运行（${r.runtime_state}）`,
      detail: r.runtime_error ?? '端口上可能没有在转发，订阅方会全部失败。',
      subjectType: 'gateway_instance',
      subjectId: r.id,
    });
  }
  const resolved = await resolveStale('gateway.not_running:', active);
  return { raised: active.length, resolved };
}

/**
 * 死信堆积。
 *
 * 事件超过重试上限后会被标成 DEAD 并停止重试 —— 不告警的话它就是一个
 * 静默的黑洞：数据改了、事件没被消费，而界面上一切正常。
 */
async function evalDeadLetters(): Promise<EvaluationResult> {
  const row = await q<{ c: string; oldest: string | null }>(
    `SELECT count(*)::text AS c, min(dead_at)::text AS oldest FROM event_outbox WHERE status = 'DEAD'`,
  );
  const count = Number(row[0]?.c ?? 0);
  const active: string[] = [];
  if (count > 0) {
    active.push('outbox.dead');
    await raiseAlert({
      key: 'outbox.dead',
      severity: 'WARNING',
      title: `${count} 条事件进入死信队列`,
      detail: `最早一条在 ${row[0]?.oldest ?? '?'}。指标聚合与告警评估都漏掉了这些事件，需要人工重放。`,
      subjectType: 'event_outbox',
    });
  }
  const resolved = await resolveStale('outbox.dead', active);
  return { raised: active.length, resolved };
}

/**
 * 来源同步失败。
 *
 * 读的是 `resource_sources.last_sync_status` 这个**状态列**，而不是事件：
 * 同步失败不写任何领域事件（失败发生在事务之外，没有可回滚的业务写），
 * 而状态列是权威的 —— 它同时被同步流程写入、被界面读取、被这里评估。
 * 三处读同一个来源，不会出现"界面说失败、告警说正常"。
 */
async function evalSourceSync(): Promise<EvaluationResult> {
  const rows = await q<{ id: string; key: string; name: string; last_sync_error: string | null }>(
    `SELECT id, key, name, last_sync_error FROM resource_sources
     WHERE last_sync_status = 'FAILED' AND enabled = true
     ORDER BY last_attempt_at DESC LIMIT 50`,
  );
  const active: string[] = [];
  for (const r of rows) {
    const key = `source.sync_failed:${r.id}`;
    active.push(key);
    await raiseAlert({
      key,
      severity: 'WARNING',
      title: `来源 ${r.name} 同步失败`,
      detail: r.last_sync_error ?? '未记录错误详情。',
      subjectType: 'source',
      subjectId: r.id,
    });
  }
  const resolved = await resolveStale('source.sync_failed:', active);
  return { raised: active.length, resolved };
}

/**
 * 隔离风暴。
 *
 * 这条由事件消费方首次提出（第 10 个隔离事件时），之后由这里续命与自愈 ——
 * 因为"窗口内还有没有那么多隔离"只有随时间推移才能判断。
 */
async function evalQuarantineBurst(): Promise<EvaluationResult> {
  const row = await q<{ c: string }>(
    `SELECT count(*)::text AS c FROM event_outbox
     WHERE event_type = 'endpoint.quarantined' AND occurred_at > now() - interval '10 minutes'`,
  );
  const count = Number(row[0]?.c ?? 0);
  const active: string[] = [];
  if (count >= 10) {
    active.push('endpoint.quarantine_burst');
    await raiseAlert({
      key: 'endpoint.quarantine_burst',
      severity: 'WARNING',
      title: `10 分钟内 ${count} 个端点被隔离`,
      detail: '通常是某个来源的节点集体失效。',
      subjectType: 'endpoint',
    });
  }
  const resolved = await resolveStale('endpoint.quarantine_burst', active);
  return { raised: active.length, resolved };
}

/**
 * 全量评估。
 *
 * 每个评估器各自 try/catch：一个查询写错了不该让其它告警也停摆 ——
 * 那正是"监控系统自己挂了却没人知道"的经典场景。
 */
export async function evaluateAlerts(): Promise<EvaluationResult> {
  const evaluators: Array<[string, () => Promise<EvaluationResult>]> = [
    ['gateway', evalGateway],
    ['dead-letters', evalDeadLetters],
    ['source-sync', evalSourceSync],
    ['quarantine', evalQuarantineBurst],
  ];

  let raised = 0;
  let resolved = 0;
  for (const [name, fn] of evaluators) {
    try {
      const r = await fn();
      raised += r.raised;
      resolved += r.resolved;
    } catch (err) {
      console.error(`[alerts] 评估器 ${name} 失败`, err);
    }
  }
  return { raised, resolved };
}
