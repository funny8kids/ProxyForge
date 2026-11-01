import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, Empty, ErrorNote, Panel, Progress, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { pct, tierLabel } from '../lib/format';
import { rationaleText } from '../lib/warnings';

export function Trust(): JSX.Element {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const summary = useAsync(() => api.trustSummary(), []);
  const promos = useAsync(() => api.promotions('PENDING'), []);

  const act = async (id: string, kind: 'approve' | 'reject'): Promise<void> => {
    setBusy(id);
    setActionError(null);
    try {
      if (kind === 'approve') await api.approvePromotion(id);
      else await api.rejectPromotion(id, 'reviewed from console');
      promos.reload();
      summary.reload();
    } catch (err) {
      // 自审禁止、PUBLIC_PROXY 不可授权这类约束会以 403/422 返回。
      // 原来用 alert() 弹出来：原生弹窗既不跟主题走，也会被浏览器拦掉，
      // 结果是「点了没反应」。改成页内提示，错误就落在用户正在看的那张表上方。
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const tiers = summary.data?.tiers ?? [];
  const total = tiers.reduce((s, x) => s + x.total, 0) || 1;
  const pending = promos.data?.items ?? [];

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <div className="t-eyebrow">{t('Tiers & promotion')}</div>
          <h1 className="t-title">{t('Trust')}</h1>
          <p className="t-desc">
            {t('AI can only suggest. Approval requires a different human reviewer.')}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost sm" onClick={summary.reload}>
            <Icon name="refresh" size={13} />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {summary.error && <ErrorNote message={summary.error} />}

      <div className="grid g-3" style={{ marginBottom: 16 }}>
        {summary.loading && <Skeleton rows={4} />}
        {tiers.map((x) => (
          <Panel title={t(tierLabel[x.tier] ?? x.tier)} key={x.tier}>
            <div className="panel-body">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="num" style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.02em' }}>
                  {x.total}
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{pct(x.total / total)}</span>
                <span style={{ marginLeft: 'auto' }}>
                  {x.gatewayEligible ? (
                    <Badge tone="ok">{t('Gateway eligible')}</Badge>
                  ) : (
                    <Badge tone="warn">{t('Isolated')}</Badge>
                  )}
                </span>
              </div>

              <div style={{ display: 'grid', gap: 6, marginTop: 14, fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-3)' }}>{t('Healthy')}</span>
                  <span className="num" style={{ color: 'var(--success-2)' }}>
                    {x.healthy}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-3)' }}>{t('Degraded')}</span>
                  <span className="num" style={{ color: 'var(--warn-2)' }}>
                    {x.degraded}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-3)' }}>{t('Unavailable')}</span>
                  <span className="num" style={{ color: 'var(--danger-2)' }}>
                    {x.unavailable}
                  </span>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <Progress
                  value={(x.healthy / Math.max(x.total, 1)) * 100}
                  tone={x.tier === 'PUBLIC_PROXY' ? 'warn' : 'ok'}
                />
              </div>
            </div>
          </Panel>
        ))}
      </div>

      <Panel
        title={t('Pending promotions')}
        sub={`${pending.length} · ${t('AI can only write suggestions, never change a tier directly')}`}
        fill
      >
        {actionError && <ErrorNote message={actionError} />}
        <div className="table-wrap">
          {promos.loading ? (
            <Skeleton rows={4} />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>{t('Suggested tier')}</th>
                  <th>{t('Source')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Confidence')}</th>
                  <th>{t('Rationale')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Badge tone="warn">
                          {t(tierLabel[p.currentTier ?? 'PUBLIC_PROXY'] ?? '')}
                        </Badge>
                        <span style={{ color: 'var(--text-4)' }}>→</span>
                        <Badge tone="info">{t(tierLabel[p.suggestedTier] ?? p.suggestedTier)}</Badge>
                      </span>
                    </td>
                    <td>
                      <span className="chip">{p.source}</span>
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {pct(p.confidence, 0)}
                    </td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-3)', maxWidth: 420 }}>
                      {rationaleText(p.rationaleCode, p.rationaleParams, p.rationale, lang)}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn ghost sm"
                        disabled={busy === p.id}
                        onClick={() => act(p.id, 'reject')}
                        style={{ marginRight: 6 }}
                      >
                        {t('Reject')}
                      </button>
                      <button
                        className="btn primary sm"
                        disabled={busy === p.id}
                        onClick={() => act(p.id, 'approve')}
                      >
                        {t('Approve')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {pending.length === 0 && !promos.loading && <Empty text={t('No pending suggestions')} />}
        </div>
      </Panel>

      <div style={{ marginTop: 16 }}>
        <Panel title={t('Three hard rules')} sub={`SEC-001 §6.2 · ${t('Enforced server-side')}`}>
          <div
            className="panel-body"
            style={{ display: 'grid', gap: 10, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}
          >
            <div style={{ display: 'flex', gap: 10 }}>
              <Badge tone="bad">422</Badge>
              <span>{t('A PUBLIC_PROXY can never receive a gateway grant.')}</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Badge tone="bad">403</Badge>
              <span>
                {t('No tier can be upgraded directly; a suggestion must be approved by a human.')}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Badge tone="bad">403</Badge>
              <span>{t('The submitter of a suggestion can never be the one who approves it.')}</span>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
