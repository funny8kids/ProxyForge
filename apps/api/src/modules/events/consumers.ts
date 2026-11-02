import { exec, q } from '../../db/client.js';
import { raiseAlert, resolveAlertByKey } from './alerts.js';

/**
 * Outbox 消费方。
 *
 * 一个事件可以有多个消费方。**每个消费方独立记成功/失败**，这是关键：
 * 指标聚合成功了、告警评估失败了，这条事件不能整体重试（会重复计数），
 * 也不能整体标成已发布（告警就永久丢了）。
 * 所以 `consumer_state` 按消费方存 `{ok, at, error}`，
 * 只有**全部**消费方成功才置 PUBLISHED。
 *
 * 没有"缓存失效"消费方：这个系统里没有进程内缓存层。订阅的 ETag 由内容
 * 指纹决定（池成员一变哈希就变），HTTP 层不需要事件驱动失效。硬加一个
 * 空壳消费者只会让人以为那里有逻辑。
 */

export interface OutboxEvent {
  id: string;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  attempts: number;
}

export interface Consumer {
  name: string;
  handle(evt: OutboxEvent): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// 消费方 1：指标聚合
// ─────────────────────────────────────────────────────────────

/**
 * 把事件折进日粒度计数。
 *
 * 幂等性：这个消费方**天然不幂等**（重复消费会多算一次）。缓解方式是
 * 让 event_outbox 的 consumer_state 记住已成功的消费方 —— 重试只补失败的
 * 那几个，不会重复累加。真要严格幂等得按 event_id 去重，代价是一张
 * 与事件同规模的表，对"看趋势"这个用途不值。
 */
const metrics: Consumer = {
  name: 'metrics',
  async handle(evt) {
    await exec(
      `INSERT INTO event_metrics_daily (day, event_type, count, last_at)
       VALUES (current_date, $1, 1, now())
       ON CONFLICT (day, event_type) DO UPDATE
         SET count = event_metrics_daily.count + 1, last_at = now()`,
      [evt.eventType],
    );
  },
};

// ─────────────────────────────────────────────────────────────
// 消费方 2：告警评估（事件驱动的那部分）
// ─────────────────────────────────────────────────────────────

/** 短时间内的隔离量超过这个数，说明某个源的质量在塌方 */
const QUARANTINE_BURST = 10;
const QUARANTINE_WINDOW_MIN = 10;

/**
 * 事件驱动的告警规则。
 *
 * 只放"由单次事件就能判断"的条件。需要看全局状态的（网关没起来、池子空了）
 * 放在周期评估器里 —— 那些不是某个事件触发的，硬塞进事件消费会漏。
 */
const alerts: Consumer = {
  name: 'alerts',
  async handle(evt) {
    switch (evt.eventType) {
      case 'gateway.config.applied': {
        // 编译/下发失败必须立刻可见：它意味着端口上跑的还是旧配置
        const status = String(evt.payload['status'] ?? '');
        if (status === 'APPLIED') {
          // 成功就是"问题已消失"的最强证据，不必等周期评估
          await resolveAlertByKey(`gateway.apply_failed:${evt.aggregateId}`);
        }
        if (status === 'FAILED') {
          await raiseAlert({
            key: `gateway.apply_failed:${evt.aggregateId}`,
            severity: 'CRITICAL',
            title: '网关配置下发失败',
            detail: String(evt.payload['error'] ?? '未提供错误详情'),
            subjectType: 'gateway_instance',
            subjectId: evt.aggregateId,
          });
        }
        break;
      }

      case 'endpoint.quarantined': {
        // 单个端点被隔离是正常的；短时间内大批被隔离才是信号。
        // 用"事件自己数自己"而不是查历史表：告警系统不该依赖它正在监控的表。
        const burst = await q<{ c: string }>(
          `SELECT count(*)::text AS c FROM event_outbox
           WHERE event_type = 'endpoint.quarantined'
             AND occurred_at > now() - ($1 || ' minutes')::interval`,
          [String(QUARANTINE_WINDOW_MIN)],
        );
        if (Number(burst[0]?.c ?? 0) >= QUARANTINE_BURST) {
          await raiseAlert({
            key: 'endpoint.quarantine_burst',
            severity: 'WARNING',
            title: `${QUARANTINE_WINDOW_MIN} 分钟内 ${burst[0]?.c} 个端点被隔离`,
            detail: '通常是某个来源的节点集体失效。检查该来源的存活率，必要时停用它。',
            subjectType: 'endpoint',
            subjectId: evt.aggregateId,
          });
        }
        break;
      }

      case 'pool.membership.changed': {
        const count = Number(evt.payload['memberCount'] ?? -1);
        if (count > 0) await resolveAlertByKey(`pool.empty:${evt.aggregateId}`);
        if (count === 0) {
          await raiseAlert({
            key: `pool.empty:${evt.aggregateId}`,
            severity: 'WARNING',
            title: '资源池没有可用成员',
            detail: '订阅会退化为全部直连；网关策略会编译出空成员表。',
            subjectType: 'pool',
            subjectId: evt.aggregateId,
          });
        }
        break;
      }

      default:
        // 其余事件目前只进指标，不产生告警
        break;
    }
  },
};

export const CONSUMERS: Consumer[] = [metrics, alerts];
