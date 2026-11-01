import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, Empty, ErrorNote, KV, Panel, Progress, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { lifecycleLabel, tierLabel } from '../lib/format';

export function Pools(): JSX.Element {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useAsync(() => api.pools(), []);
  const detail = useAsync(() => (selected ? api.pool(selected) : Promise.resolve(null)), [selected]);

  // 默认选中第一个池：否则首屏只有三张卡片，下面整片空白，
  // 用户还得先猜「要点一下才会出内容」。
  useEffect(() => {
    if (selected) return;
    const first = list.data?.items?.[0];
    if (first) setSelected(first.id);
  }, [list.data, selected]);

  const recompute = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.recomputePool(selected);
      detail.reload();
      list.reload();
    } finally {
      setBusy(false);
    }
  };

  const pools = list.data?.items ?? [];

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <div className="t-eyebrow">{t('Scheduling groups')}</div>
          <h1 className="t-title">{t('Pools')}</h1>
          <p className="t-desc">
            {t('Allowed tiers')} —{' '}
            {t('PUBLIC_PROXY may only join pools that declare it explicitly')}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost sm" onClick={list.reload}>
            <Icon name="refresh" size={13} />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {list.error && <ErrorNote message={list.error} />}

      <div className="grid g-3" style={{ marginBottom: 16 }}>
        {list.loading && <Skeleton rows={4} />}
        {pools.map((p) => (
          <button
            className="panel pool-card"
            aria-pressed={selected === p.id}
            onClick={() => setSelected(p.id)}
            key={p.id}
          >
            <div className="panel-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="p-name" style={{ fontSize: 13.5 }}>
                  {p.name}
                </span>
                {p.experimental && <Badge tone="warn">{t('Experimental')}</Badge>}
              </div>
              <div className="p-sub mono" style={{ fontSize: 11 }}>
                {p.key}
              </div>

              <div style={{ display: 'flex', gap: 18, marginTop: 14 }}>
                <div>
                  <div className="metric-label">{t('Members')}</div>
                  <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>
                    {p.memberCount}
                  </div>
                </div>
                <div>
                  <div className="metric-label">{t('Healthy')}</div>
                  <div
                    className="num"
                    style={{ fontSize: 18, fontWeight: 600, color: 'var(--success-2)' }}
                  >
                    {p.health.healthy}
                  </div>
                </div>
                <div>
                  <div className="metric-label">{t('Avg quality')}</div>
                  <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>
                    {p.health.avgQuality?.toFixed(0) ?? '—'}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 4, marginTop: 12, flexWrap: 'wrap' }}>
                {p.allowedTiers.map((tier) => (
                  <span className="chip" key={tier}>
                    {t(tierLabel[tier] ?? tier)}
                  </span>
                ))}
              </div>
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <Panel
          title={detail.data?.name ?? t('Details')}
          sub={
            detail.data
              ? `${detail.data.memberCount} ${t('Members').toLowerCase()} · ${t('min quality')} ${detail.data.minQuality}`
              : ''
          }
          right={
            <button className="btn ghost sm" onClick={recompute} disabled={busy}>
              <Icon name="play" size={12} />
              {t('Recompute members')}
            </button>
          }
          fill
        >
          {detail.loading && <Skeleton rows={6} />}
          {detail.error && <ErrorNote message={detail.error} />}

          {detail.data && (
            <>
              <div className="panel-body" style={{ display: 'grid', gap: 8, paddingBottom: 8 }}>
                <KV k={t('Min quality')} v={String(detail.data.minQuality)} />
                <KV
                  k={t('Max members')}
                  v={detail.data.maxMembers === null ? '∞' : String(detail.data.maxMembers)}
                />
                <KV k={t('Allowed tiers')} v={detail.data.allowedTiers.join(', ')} />
                <KV k={t('Rules')} v={`${detail.data.rules.length} ${t('active')}`} />
              </div>

              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('Host')}</th>
                      <th>{t('Protocol')}</th>
                      <th>{t('Tier')}</th>
                      <th>{t('Source')}</th>
                      <th style={{ textAlign: 'right' }}>{t('Quality')}</th>
                      <th style={{ textAlign: 'right' }}>{t('Status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.members.slice(0, 60).map((m) => (
                      <tr key={m.endpointId}>
                        <td className="mono">
                          {m.host}:{m.port}
                        </td>
                        <td>
                          <span className="chip">{m.protocol}</span>
                        </td>
                        <td>{t(tierLabel[m.trustTier] ?? m.trustTier)}</td>
                        <td>
                          <span
                            style={{
                              color: m.source === 'MANUAL' ? 'var(--violet-2)' : 'var(--text-3)',
                              fontSize: 11.5,
                            }}
                          >
                            {m.source}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <Progress
                              value={m.qualityScore}
                              tone={m.qualityScore >= 80 ? 'ok' : m.qualityScore >= 60 ? 'warn' : 'bad'}
                            />
                            <span className="num" style={{ width: 24 }}>
                              {m.qualityScore.toFixed(0)}
                            </span>
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {m.suppressed ? (
                            <Badge tone="muted">suppressed</Badge>
                          ) : (
                            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                              {t(lifecycleLabel[m.lifecycleStatus] ?? m.lifecycleStatus)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.data.members.length === 0 && <Empty text={t('No resources')} />}
              </div>
            </>
          )}
        </Panel>
      )}

      {!selected && !list.loading && pools.length === 0 && <Empty text={t('No pools')} />}
    </div>
  );
}
