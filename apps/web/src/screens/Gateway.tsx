import { useState } from 'react';
import { Icon } from '../components/Icon';
import { AreaChart, Badge, Empty, ErrorNote, KV, Panel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { compact, relativeTime } from '../lib/format';
import { warningText } from '../lib/warnings';

export function Gateway(): JSX.Element {
  const { t, lang } = useI18n();
  const [instance, setInstance] = useState<string>('');
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const instances = useAsync(() => api.gatewayInstances(), []);
  const activeInstance = instance || instances.data?.items[0]?.id || '';

  const configs = useAsync(
    () => (activeInstance ? api.gatewayConfigs(activeInstance) : Promise.resolve({ items: [] })),
    [activeInstance],
  );
  const policies = useAsync(() => api.policies(), []);
  const traffic = useAsync(() => api.gatewayTraffic(24), []);

  const reload = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.reloadGateway();
      configs.reload();
      instances.reload();
    } finally {
      setBusy(false);
    }
  };

  const current =
    configs.data?.items.find((c) => c.version === version) ?? configs.data?.items[0] ?? null;

  const trafficPoints = traffic.data?.items ?? [];

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <div className="t-eyebrow">{t('Compile & distribute')}</div>
          <h1 className="t-title">{t('Gateway')}</h1>
          <p className="t-desc">
            {t(
              'One policy = one listen port. Members are frozen at compile time — the data plane never calls back.',
            )}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost sm" onClick={reload} disabled={busy}>
            <Icon name="play" size={12} />
            {t('Reload')}
          </button>
        </div>
      </div>

      {(instances.error || policies.error) && (
        <ErrorNote message={instances.error ?? policies.error ?? ''} />
      )}

      <div className="grid g-2" style={{ marginBottom: 16 }}>
        <Panel
          title={t('Policies')}
          sub={`${policies.data?.items.length ?? 0} ${t('bound')}`}
          fill
        >
          <div className="table-wrap">
            {policies.loading ? (
              <Skeleton rows={4} />
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('Policies')}</th>
                    <th>{t('Strategy')}</th>
                    <th style={{ textAlign: 'right' }}>{t('Listen port')}</th>
                    <th style={{ textAlign: 'right' }}>{t('Status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(policies.data?.items ?? []).map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div style={{ fontSize: 12.5 }}>{p.name}</div>
                        <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-4)' }}>
                          {p.poolKey}
                        </div>
                      </td>
                      <td>
                        <span className="chip">{p.strategy}</span>
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {p.listenPort}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Badge tone={p.enabled ? 'ok' : 'muted'} dot>
                          {p.enabled ? t('enabled') : t('off')}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(policies.data?.items ?? []).length === 0 && !policies.loading && (
              <Empty text={t('No resources')} />
            )}
          </div>
        </Panel>

        <Panel title={t('Versions')} sub={`${configs.data?.items.length ?? 0} ${t('compiled')}`}>
          <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
            <div className="seg" style={{ flexWrap: 'wrap' }}>
              {(instances.data?.items ?? []).map((i) => (
                <button
                  className={activeInstance === i.id ? 'on' : ''}
                  onClick={() => {
                    setInstance(i.id);
                    setVersion(null);
                  }}
                  key={i.id}
                >
                  {i.name}
                </button>
              ))}
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              {(configs.data?.items ?? []).slice(0, 6).map((c) => (
                <button
                  className={`ver-row${current?.version === c.version ? ' on' : ''}`}
                  onClick={() => setVersion(c.version)}
                  key={c.id}
                >
                  <span className="num" style={{ fontSize: 12, width: 34 }}>
                    v{c.version}
                  </span>
                  <Badge
                    tone={c.status === 'APPLIED' ? 'ok' : c.status === 'FAILED' ? 'bad' : 'muted'}
                  >
                    {t(c.status === 'APPLIED' ? 'applied' : c.status.toLowerCase())}
                  </Badge>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-4)' }}>
                    {c.configHash}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-4)' }}>
                    {relativeTime(c.appliedAt ?? c.createdAt, lang)}
                  </span>
                </button>
              ))}
              {(configs.data?.items ?? []).length === 0 && (
                <Empty text={t('No compiled config yet')} />
              )}
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid g-2" style={{ marginTop: 16 }}>
        <Panel title={t('Instances')} sub={t('Formal and experimental are physically separated')}>
          <div className="panel-body" style={{ display: 'grid', gap: 8 }}>
            {(instances.data?.items ?? []).map((i) => (
              <KV
                k={i.name}
                v={`${i.bindHost}:${i.httpPort} · ${
                  t(i.status === 'APPLIED' ? 'applied' : i.status.toLowerCase())
                } · ${i.activeConfigVersion === null ? t('not compiled') : `v${i.activeConfigVersion}`}`}
                key={i.id}
              />
            ))}
          </div>
        </Panel>

        <Panel
          title={t('Traffic (24h)')}
          sub={`${t('Total')} ${compact(trafficPoints.reduce((s, p) => s + p.connections, 0))}`}
        >
          <div className="panel-body" style={{ paddingTop: 4 }}>
            {traffic.loading ? (
              <Skeleton rows={3} />
            ) : trafficPoints.length > 1 ? (
              <AreaChart
                points={trafficPoints.map((p) => p.connections)}
                height={132}
                yFormat={(v) => compact(v)}
                xLabels={trafficPoints.map((p) => p.bucket.slice(11, 16))}
              />
            ) : (
              <Empty text={t('No traffic samples yet')} />
            )}
          </div>
        </Panel>
      </div>

      {current && (
        <Panel
          title={`${t('Compiled config')} · v${current.version}`}
          sub={`hash ${current.configHash} · ${current.warnings.length} ${
            current.warnings.length === 1 ? t('warning') : t('Warnings').toLowerCase()
          }`}
          fill
        >
          {current.warnings.length > 0 && (
            <div style={{ padding: '12px 20px 0', display: 'grid', gap: 6 }}>
              {current.warnings.map((w, i) => (
                <div style={{ fontSize: 11.5, color: 'var(--warn-2)' }} key={i}>
                  <span className="mono">[{w.code}]</span> {warningText(w, lang)}
                </div>
              ))}
            </div>
          )}
          <pre className="code-block">{current.renderedConfig}</pre>
        </Panel>
      )}
    </div>
  );
}
