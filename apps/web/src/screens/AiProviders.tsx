import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, Empty, ErrorNote, Panel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { providerTypeLabel, relativeTime } from '../lib/format';

/** 供应商标识 → 图标 id。用抽象字形，不引入第三方商标。 */
const PROVIDER_ICON: Record<string, string> = {
  deepseek: 'pv-deepseek',
  openrouter: 'pv-openrouter',
  ollama: 'pv-ollama',
};

export function AiProviders(): JSX.Element {
  const { t, lang } = useI18n();
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, { ok: boolean; latencyMs: number }>>({});

  const providers = useAsync(() => api.aiProviders(), []);
  const bindings = useAsync(() => api.aiBindings(), []);

  const test = async (id: string): Promise<void> => {
    setTesting(id);
    try {
      const r = await api.aiTest(id);
      setResult((prev) => ({ ...prev, [id]: { ok: r.ok, latencyMs: r.latencyMs } }));
    } catch {
      setResult((prev) => ({ ...prev, [id]: { ok: false, latencyMs: 0 } }));
    } finally {
      setTesting(null);
    }
  };

  const list = providers.data?.items ?? [];
  const chain = bindings.data?.items ?? [];

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <div className="t-eyebrow">{t('Suggestion engine')}</div>
          <h1 className="t-title">{t('AI Providers')}</h1>
          <p className="t-desc">
            {t('Never returns plaintext keys')} — {t('Only shown once, at creation time')}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost sm" onClick={providers.reload}>
            <Icon name="refresh" size={13} />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {providers.error && <ErrorNote message={providers.error} />}

      <div className="grid g-3" style={{ marginBottom: 16 }}>
        {providers.loading && <Skeleton rows={4} />}
        {list.map((p) => {
          const icon = PROVIDER_ICON[p.key.split('-')[0] ?? ''] ?? 'ai';
          const r = result[p.id];
          return (
            <Panel key={p.id}>
              <div className="panel-body prov-body">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      display: 'grid',
                      placeItems: 'center',
                      background: 'var(--ov-3)',
                    }}
                  >
                    <Icon name={icon} size={17} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="p-name" style={{ fontSize: 13 }}>
                      {p.name}
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-4)' }}>
                      {t(providerTypeLabel[p.type] ?? p.type)}
                    </div>
                  </div>
                  <span style={{ marginLeft: 'auto' }}>
                    <Badge tone={p.enabled ? 'ok' : 'muted'} dot>
                      {p.enabled ? t('on') : t('off')}
                    </Badge>
                  </span>
                </div>

                <div style={{ marginTop: 14, display: 'grid', gap: 7, fontSize: 11.5 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-3)' }}>{t('Base URL')}</span>
                    <span
                      className="mono"
                      style={{
                        color: 'var(--text-2)',
                        maxWidth: 180,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={p.baseUrl}
                    >
                      {p.baseUrl.replace(/^https?:\/\//, '')}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-3)' }}>{t('Key')}</span>
                    <span className="mono" style={{ color: 'var(--text-3)' }}>
                      {p.apiKeyMasked ?? '—'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-3)' }}>{t('Monthly budget')}</span>
                    <span className="num" style={{ color: 'var(--text-2)' }}>
                      {p.budgetMonthlyUsd === null
                        ? '∞'
                        : `$${p.spentCurrentMonth.toFixed(2)} / $${p.budgetMonthlyUsd}`}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-3)' }}>{t('Models')}</span>
                    <span style={{ color: 'var(--text-2)' }}>{p.models.length}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                  {p.models.slice(0, 3).map((m) => (
                    <span className="chip" key={m.modelName}>
                      {m.modelName}
                    </span>
                  ))}
                </div>

                {/* 三张卡的模型数量不同，按钮行必须吸底，
                    否则「连接测试」在每张卡里落在不同高度，一眼看上去像没对齐。 */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 'auto',
                    paddingTop: 14,
                  }}
                >
                  <button
                    className="btn ghost sm"
                    disabled={testing === p.id}
                    onClick={() => test(p.id)}
                  >
                    <Icon name="play" size={11} />
                    {t('Test connection')}
                  </button>
                  {r && (
                    <span
                      style={{ fontSize: 11, color: r.ok ? 'var(--success-2)' : 'var(--danger-2)' }}
                    >
                      {r.ok ? `${r.latencyMs}ms` : t('failed')}
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-4)' }}>
                    {relativeTime(p.lastTestedAt, lang)}
                  </span>
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel title={t('Task routing')} sub={t('Lower priority number is tried first')} fill>
        <div className="table-wrap">
          {bindings.loading ? (
            <Skeleton rows={4} />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>{t('Task')}</th>
                  <th>{t('Fallback chain')}</th>
                </tr>
              </thead>
              <tbody>
                {chain.map((b) => (
                  <tr key={b.taskType}>
                    <td>
                      <span className="chip">{b.taskType}</span>
                    </td>
                    <td>
                      <span
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                      >
                        {b.chain.map((c, i) => (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} key={c.modelId}>
                            {i > 0 && <span style={{ color: 'var(--text-4)' }}>→</span>}
                            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
                              {c.providerKey}/{c.modelName}
                            </span>
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {chain.length === 0 && !bindings.loading && <Empty text={t('No events')} />}
        </div>
      </Panel>
    </div>
  );
}
