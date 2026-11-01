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
