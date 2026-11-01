import { useMemo } from 'react';
import { Icon } from '../components/Icon';
import { AreaChart, Badge, Empty, ErrorNote, Metric, Panel, Progress, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { compact, countryLabel, ms, pct, tierLabel, tierTone } from '../lib/format';

/** 展示顺序，不是权限顺序 —— 权限由服务端强制，界面只负责别把颜色排乱 */
const TIER_RANK: Record<string, number> = {
  PRIVATE_PROXY: 0,
  VERIFIED_PROXY: 1,
  PUBLIC_PROXY: 2,
};

const TIER_FILL: Record<string, string> = {
  PRIVATE_PROXY: 'var(--violet)',
  VERIFIED_PROXY: 'var(--cyan)',
  PUBLIC_PROXY: 'var(--warn)',
};

export function Overview(): JSX.Element {
  const { t } = useI18n();
  const { data, error, loading, reload } = useAsync(() => api.overview(), []);

  const trend = data?.qualityTrend ?? [];
  const traffic = data?.gatewayTraffic ?? [];

  const trafficSeries = useMemo(() => traffic.map((p) => p.connections), [traffic]);
  const trafficLabels = useMemo(
    () => traffic.map((p) => p.bucket.slice(11, 16)),
    [traffic],
  );

  if (error) {
    return (
      <div className="screen">
        <PageHead t={t} onRefresh={reload} />
        <ErrorNote message={error} />
      </div>
    );
  }

  const c = data?.counters;

  // 分级按「私有 → 已验证 → 公开」的固定顺序排。
  // 接口返回的是数据库枚举序（PRIVATE, PUBLIC, VERIFIED），照原样画出来是
  // 「私有 / 公开 / 已验证」，紫橙青三条并排，读的人会以为橙那条是异常。
  const sortedTiers = [...(data?.tiers ?? [])].sort(
    (a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9),
  );
  const tierTotal = sortedTiers.reduce((s, x) => s + x.count, 0) || 1;

  return (
    <div className="screen">
      <PageHead t={t} onRefresh={reload} />

      <section className="panel" style={{ marginBottom: 16 }}>
        {loading || !c ? (
          <Skeleton rows={3} />
        ) : (
          <div className="metrics">
            <Metric
              label={t('Total endpoints')}
              value={c.totalEndpoints}
              foot={<span>{c.schedulable} {t('Schedulable').toLowerCase()}</span>}
            />
            <Metric
              label={t('Healthy')}
              value={c.healthy}
              tone="cyan"
              foot={<span style={{ color: 'var(--success-2)' }}>{pct(c.totalEndpoints ? c.healthy / c.totalEndpoints : 0)}</span>}
            />
            <Metric
              label={t('Degraded')}
              value={c.degraded}
              tone="warn"
              foot={<span>{c.quarantined} {t('Quarantined').toLowerCase()}</span>}
            />
            <Metric
              label={t('Pending verification')}
              value={c.pendingVerification}
              tone="violet"
              foot={<span>{t('Gateway eligible')}: {c.schedulable}</span>}
            />
          </div>
        )}
      </section>

      <div className="grid g-main" style={{ marginBottom: 16 }}>
        <Panel
          title={t('Quality trend')}
          sub={`${trend.length || '—'} ${t('days')} · ${t('avg quality score')}`}
          fill
        >
          {loading ? (
            <Skeleton rows={5} />
          ) : trend.length > 1 ? (
            <div style={{ padding: '4px 20px 18px' }}>
              <AreaChart
                points={trend.map((p) => p.avgQuality)}
                height={200}
                yFormat={(v) => v.toFixed(0)}
                xLabels={trend.map((p) => p.day)}
              />
            </div>
          ) : (
            <Empty text={t('No resources')} />
          )}
        </Panel>

        <Panel title={t('Trust tiers')} sub={t('Gateway eligible only')}>
          <div className="panel-body" style={{ display: 'grid', gap: 14 }}>
            {sortedTiers.map((tier) => (
              <div key={tier.tier}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 6,
                    fontSize: 12.5,
                  }}
                >
                  <Badge tone={tierTone[tier.tier] as 'violet' | 'info' | 'warn'}>
                    {t(tierLabel[tier.tier] ?? tier.tier)}
                  </Badge>
                  {tier.tier === 'PUBLIC_PROXY' && (
                    <span style={{ fontSize: 11, color: 'var(--warn-2)' }}>{t('Isolated')}</span>
                  )}
                  <span style={{ marginLeft: 'auto', color: 'var(--text-2)' }} className="num">
                    {tier.count}
                  </span>
                </div>
                <div
                  style={{
                    height: 5,
                    borderRadius: 3,
                    background: 'var(--ov-3)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${(tier.count / tierTotal) * 100}%`,
                      height: '100%',
                      background: TIER_FILL[tier.tier] ?? 'var(--warn)',
                    }}
                  />
                </div>
              </div>
            ))}

            <div
              style={{
                marginTop: 4,
                paddingTop: 12,
                borderTop: '1px solid var(--line)',
                display: 'grid',
                gap: 8,
              }}
            >
              <Row
                k={t('Gateway eligible')}
                v={pct(c ? c.schedulable / Math.max(c.totalEndpoints, 1) : null)}
              />

              {/* 协议分布是三组并列数值，不是一句话。挤成一行会被折行切成
                  「HTTPS_CONNECT」+「22」两段，读起来像两个不同的指标。
                  两列足够容纳最长的 HTTPS_CONNECT，不会出现省略号。 */}
              <div style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('Protocol mix')}</span>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    columnGap: 12,
                    rowGap: 3,
                  }}
                >
                  {(data?.protocolMix ?? []).slice(0, 3).map((p) => (
                    <div
                      key={p.protocol}
                      style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--text-3)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {p.protocol}
                      </span>
                      <span
                        className="num"
                        style={{ fontSize: 12, color: 'var(--text-2)', flex: 'none' }}
                      >
                        {p.count}
                      </span>
                    </div>
                  ))}
                  {(data?.protocolMix ?? []).length === 0 && (
                    <span style={{ fontSize: 12, color: 'var(--text-4)' }}>—</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid g-2">
        <Panel title={t('Top endpoints')} sub={t('by quality score')} fill>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('Host')}</th>
                  <th>{t('Country')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Latency')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Success')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Quality')}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.topEndpoints ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.displayName ?? e.id.slice(0, 8)}</td>
                    <td>{countryLabel(e.countryCode)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{ms(e.p50Ms)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{pct(e.successRate24h)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Progress value={e.qualityScore} tone={e.qualityScore >= 80 ? 'ok' : e.qualityScore >= 60 ? 'warn' : 'bad'} />
                        <span className="num" style={{ width: 26, textAlign: 'right' }}>
                          {e.qualityScore.toFixed(0)}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(data?.topEndpoints ?? []).length === 0 && <Empty text={t('No resources')} />}
          </div>
        </Panel>

        <Panel title={t('Gateway traffic')} sub={t('24h · connections / hour')} fill>
          {trafficSeries.length > 1 ? (
            <div style={{ padding: '4px 20px 18px' }}>
              <AreaChart
                points={trafficSeries}
                height={150}
                yFormat={(v) => compact(v)}
                xLabels={trafficLabels}
              />
              <div
                style={{
                  display: 'flex',
                  gap: 18,
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid var(--line)',
                  fontSize: 12,
                  color: 'var(--text-3)',
                }}
              >
                <span>
                  {t('Total')}:{' '}
                  <b style={{ color: 'var(--text)' }} className="num">
                    {compact(trafficSeries.reduce((s, v) => s + v, 0))}
                  </b>
                </span>
                <span>
                  {t('Peak')}:{' '}
                  <b style={{ color: 'var(--text)' }} className="num">
                    {compact(Math.max(...trafficSeries))}
                  </b>
                </span>
              </div>
            </div>
          ) : (
            <Empty text={t('No events')} />
          )}
        </Panel>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
      <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{k}</span>
      <span style={{ color: 'var(--text-2)', whiteSpace: 'nowrap' }} className="mono">
        {v}
      </span>
    </div>
  );
}

export function PageHead({
  t,
  onRefresh,
}: {
  t: (k: string) => string;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        <div className="t-eyebrow">{t('Network Resource Control Plane')}</div>
        <h1 className="t-title">{t('Command Center')}</h1>
        <p className="t-desc">
          {t(
            'One policy = one listen port. Members are frozen at compile time — the data plane never calls back.',
          )}
        </p>
      </div>
      <div className="head-actions">
        <button className="btn ghost sm" onClick={onRefresh}>
          <Icon name="refresh" size={13} />
          {t('Refresh')}
        </button>
      </div>
    </div>
  );
}
