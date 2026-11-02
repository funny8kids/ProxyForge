import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, Empty, ErrorNote, Panel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { actorTypeLabel, relativeTime } from '../lib/format';

const ACTION_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'muted'> = {
  'resource.import': 'info',
  'endpoint.quarantine': 'bad',
  'endpoint.tier.change': 'warn',
  'promotion.approve': 'ok',
  'gateway.config.apply': 'ok',
  'policy.update': 'info',
  'subscription.create': 'info',
  'auth.login': 'muted',
};

export function Audit(): JSX.Element {
  const { t, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => api.audit(80), []);

  const items = data?.items ?? [];
  // 整列都是「—」的列没有信息量，只占宽度。只有在真的有 requestId 时才显示。
  const hasRequest = items.some((e) => e.requestId);

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <div className="t-eyebrow">{t('Change trail')}</div>
          <h1 className="t-title">{t('Audit')}</h1>
          <p className="t-desc">
            {t('Append-only; production must REVOKE UPDATE/DELETE from the app role')}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost sm" onClick={reload}>
            <Icon name="refresh" size={13} />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {error && <ErrorNote message={error} />}

      {/*
        告警与事件管道放在审计表之前：审计是"过去发生过什么"，
        这两块是"现在哪里不对"。出问题时先看上面。
      */}
      <div className="grid g-2" style={{ marginBottom: 16 }}>
        <AlertsPanel />
        <PipelinePanel />
      </div>

      <Panel fill>
        <div className="table-wrap">
          {loading ? (
            <Skeleton rows={8} />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>{t('Time')}</th>
                  <th>{t('Action')}</th>
                  <th>{t('Actor')}</th>
                  <th>{t('Resource')}</th>
                  {hasRequest && <th>{t('Request')}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={`${e.id}-${e.occurredAt}`}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 11.5, color: 'var(--text-3)' }}>
                      {relativeTime(e.occurredAt, lang)}
                    </td>
                    <td>
                      <Badge tone={ACTION_TONE[e.action] ?? 'muted'}>{e.action}</Badge>
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      <span style={{ color: 'var(--text-2)' }}>
                        {t(actorTypeLabel[e.actorType] ?? e.actorType)}
                      </span>
                      {e.actorId && (
                        <span
                          className="mono"
                          style={{ color: 'var(--text-4)', marginLeft: 6, fontSize: 10.5 }}
                        >
                          {e.actorId.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td
                      style={{ fontSize: 11.5, color: 'var(--text-3)' }}
                      title={e.resourceType ?? undefined}
                    >
                      {e.resourceType ? t(e.resourceType) : '—'}
                      {e.resourceId && (
                        <span
                          className="mono"
                          style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--text-4)' }}
                        >
                          {e.resourceId.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    {hasRequest && (
                      <td className="mono" style={{ fontSize: 10.5, color: 'var(--text-4)' }}>
                        {e.requestId?.slice(0, 8) ?? '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {items.length === 0 && !loading && <Empty text={t('No events')} />}
        </div>
      </Panel>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 告警
// ─────────────────────────────────────────────────────────────

const SEVERITY_TONE: Record<string, 'bad' | 'warn' | 'info'> = {
  CRITICAL: 'bad',
  WARNING: 'warn',
  INFO: 'info',
};

/**
 * 未解决告警。
 *
 * 空列表也要显示面板 —— "没有面板"和"没有告警"在界面上是两种完全不同的
 * 含义，而用户分不出来。空状态明确写"全部正常"。
 */
function AlertsPanel(): JSX.Element {
  const { t, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => api.alerts('open'), []);
  const [busy, setBusy] = useState<string | null>(null);

  const items = data?.items ?? [];

  const act = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(id);
    try {
      await fn();
      reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title={t('Alerts')}
      sub={
        items.length > 0
          ? t('{n} open').replace('{n}', String(items.length))
          : t('Condition-based; clears itself when the cause goes away')
      }
    >
      <div className="panel-body" style={{ display: 'grid', gap: 8 }}>
        {error && <ErrorNote message={error} />}
        {loading && <Skeleton rows={3} />}

        {!loading && items.length === 0 && (
          <div className="info-note">{t('All clear — nothing is currently failing.')}</div>
        )}

        {items.map((a) => (
          <div key={a.id} className="alert-row">
            <div style={{ minWidth: 0, display: 'grid', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Badge tone={SEVERITY_TONE[a.severity] ?? 'muted'} dot>
                  {a.severity}
                </Badge>
                <span style={{ fontSize: 12, fontWeight: 500 }}>{a.title}</span>
                {/* 次数很重要：一条 count=340 的告警和 count=1 的性质完全不同 */}
                {a.count > 1 && <span className="chip">×{a.count}</span>}
                {a.status === 'ACKED' && <span className="chip">{t('acked')}</span>}
              </div>
              {a.detail && (
                <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.6 }}>{a.detail}</div>
              )}
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-4)' }}>
                {a.key} · {relativeTime(a.lastSeenAt, lang)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
              {a.status === 'OPEN' && (
                <button
                  className="btn ghost sm"
                  disabled={busy === a.id}
                  onClick={() => act(a.id, () => api.ackAlert(a.id))}
                >
                  {t('Ack')}
                </button>
              )}
              <button
                className="btn ghost sm"
                disabled={busy === a.id}
                onClick={() => act(a.id, () => api.resolveAlert(a.id))}
                title={t('Mark resolved manually')}
              >
                {t('Resolve')}
              </button>
            </div>
          </div>
        ))}

        <button
          className="btn ghost sm"
          style={{ justifySelf: 'start' }}
          onClick={() => act('__eval__', () => api.evaluateAlerts())}
          disabled={busy === '__eval__'}
        >
          <Icon name="refresh" size={13} />
          {t('Re-evaluate now')}
        </button>
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────
// 事件管道
// ─────────────────────────────────────────────────────────────

/**
 * 事件管道的健康度。
 *
 * 三个数字就够了：待消费、已发布、死信。死信是关键 —— 之前事件失败超过
 * 重试上限后会永久停在"既不在队列、也不在结果"的状态，谁也看不见。
 */
function PipelinePanel(): JSX.Element {
  const { t, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => api.deadLetters(), []);
  const metrics = useAsync(() => api.eventMetrics(7), []);
  const [busy, setBusy] = useState<string | null>(null);

  const byStatus = data?.byStatus ?? { PENDING: 0, PUBLISHED: 0, DEAD: 0 };
  const dead = data?.items ?? [];
  const top = (metrics.data?.byType ?? []).slice(0, 4);

  const replay = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      await api.replayDeadLetter(id);
      reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title={t('Event pipeline')} sub={t('Outbox → consumers → metrics / alerts')}>
      <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
        {error && <ErrorNote message={error} />}

        <div className="kv-note">
          <div>
            <span>{t('Pending')}</span>
            <span className="num">{byStatus.PENDING}</span>
          </div>
          <div>
            <span>{t('Published')}</span>
            <span className="num">{byStatus.PUBLISHED}</span>
          </div>
          <div>
            <span>{t('Dead letters')}</span>
            <span className="num" style={{ color: byStatus.DEAD > 0 ? 'var(--bad)' : undefined }}>
              {byStatus.DEAD}
            </span>
          </div>
        </div>

        {top.length > 0 && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {top.map((m) => (
              <span className="chip" key={m.eventType} title={m.eventType}>
                {m.eventType} {m.count}
              </span>
            ))}
          </div>
        )}

        {loading && <Skeleton rows={2} />}

        {dead.map((d) => (
          <div key={d.id} className="alert-row">
            <div style={{ minWidth: 0, display: 'grid', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Badge tone="bad" dot>
                  {t('DEAD')}
                </Badge>
                <span className="mono" style={{ fontSize: 11 }}>{d.eventType}</span>
                <span className="chip">×{d.attempts}</span>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.6, wordBreak: 'break-word' }}>
                {d.lastError ?? '—'}
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-4)' }}>
                {d.aggregateType}/{d.aggregateId.slice(0, 12)} · {relativeTime(d.deadAt, lang)}
              </div>
            </div>
            <button
              className="btn ghost sm"
              style={{ flex: '0 0 auto' }}
              disabled={busy === d.id}
              onClick={() => replay(d.id)}
              title={t('Re-run only the consumers that failed')}
            >
              {t('Replay')}
            </button>
          </div>
        ))}

        {!loading && dead.length === 0 && byStatus.PUBLISHED === 0 && byStatus.PENDING === 0 && (
          <div className="info-note">{t('No events consumed yet.')}</div>
        )}
      </div>
    </Panel>
  );
}
