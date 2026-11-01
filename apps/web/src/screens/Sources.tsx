import { useMemo, useState } from 'react';
import type { SourceSummary, SourceSyncOutcome } from '@proxyforge/contracts';
import { Icon } from '../components/Icon';
import { Badge, Drawer, Empty, ErrorNote, Metric, Panel, Skeleton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { compact, relativeTime } from '../lib/format';

/**
 * 来源采集。
 *
 * 这一屏存在的理由：采集能力（抓取 / 多格式抽取 / 候选区）之前全在 API 里，
 * 界面上没有任何入口，等于用户只能靠 curl 往里灌资源。
 *
 * 三个数字必须分开显示，否则很容易误判规模：
 *   · 候选总数  —— 含跨源重复
 *   · 去重后    —— 真实独立端点，这才是有意义的量
 *   · 待处理    —— 还没晋级进端点表的
 */

interface Notice {
  tone: 'ok' | 'warn';
  text: string;
}

export function Sources(): JSX.Element {
  const { t, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => api.sources(), []);
  const { data: stats, reload: reloadStats } = useAsync(() => api.sourceStats(), []);

  /** 正在同步的目标：'catalog' | 'all' | <sourceId> */
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [promoting, setPromoting] = useState<SourceSummary | null>(null);
  const [detail, setDetail] = useState<SourceSyncOutcome | null>(null);

  const items = data?.items ?? [];
  const enabled = useMemo(() => items.filter((s) => s.enabled && s.type !== 'MANUAL'), [items]);

  const refreshAll = (): void => {
    reload();
    reloadStats();
  };

  const importCatalog = async (): Promise<void> => {
    setBusy('catalog');
    setNotice(null);
    try {
      const r = await api.importCatalog();
      setNotice({
        tone: 'ok',
        text: t('{n} sources available ({c} new, {u} refreshed)')
          .replace('{n}', String(r.total))
          .replace('{c}', String(r.created))
          .replace('{u}', String(r.updated)),
      });
      refreshAll();
    } catch (err) {
      setNotice({ tone: 'warn', text: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  const syncOne = async (s: SourceSummary): Promise<void> => {
    setBusy(s.id);
    setNotice(null);
    try {
      const r = await api.syncSource(s.id);
      setDetail(r);
      if (!r.ok) setNotice({ tone: 'warn', text: `${s.name}: ${r.error ?? t('Sync failed')}` });
      else if (r.duplicateSnapshot) {
        setNotice({ tone: 'ok', text: `${s.name}: ${t('Content unchanged, snapshot already exists')}` });
      } else {
        setNotice({
          tone: 'ok',
          text: `${s.name}: ${t('{n} candidates').replace('{n}', String(r.candidates))}`,
        });
      }
      refreshAll();
    } catch (err) {
      setNotice({ tone: 'warn', text: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  const syncAll = async (): Promise<void> => {
    setBusy('all');
    setNotice(null);
    try {
      const r = await api.syncAllSources();
      // 只报「同步了 17 个源」没有信息量：公开列表大部分时候内容是不变的，
      // 真正该看的是「几个源有更新 / 新增了多少候选」。
      const changed = r.results.filter((x) => x.ok && !x.duplicateSnapshot).length;
      const unchanged = r.results.filter((x) => x.duplicateSnapshot).length;
      setNotice({
        tone: r.failed > 0 ? 'warn' : 'ok',
        text: t('{ok}/{total} synced · {n} new candidates ({c} updated, {u} unchanged)')
          .replace('{ok}', String(r.succeeded))
          .replace('{total}', String(r.total))
          .replace('{n}', String(r.candidates))
          .replace('{c}', String(changed))
          .replace('{u}', String(unchanged)),
      });
      // 失败明细要能点开看，不能只给一个"2 个失败"
      const firstFail = r.results.find((x) => !x.ok);
      if (firstFail) setDetail(firstFail);
      refreshAll();
    } catch (err) {
      setNotice({ tone: 'warn', text: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (s: SourceSummary): Promise<void> => {
    setBusy(s.id);
    try {
      await api.updateSource(s.id, { enabled: !s.enabled });
      reload();
    } catch (err) {
      setNotice({ tone: 'warn', text: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <div className="t-eyebrow">{t('Discovery pipeline')}</div>
          <h1 className="t-title">{t('Sources')}</h1>
          <p className="t-desc">
            {t(
              'Public lists are fetched, parsed and quarantined as candidates. Nothing reaches the endpoint table until you promote it.',
            )}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost sm" disabled={busy !== null} onClick={importCatalog}>
            <Icon name="download" size={13} />
            {busy === 'catalog' ? t('Importing…') : t('Import catalog')}
          </button>
          <button
            className="btn ghost sm"
            disabled={busy !== null || !enabled.length}
            onClick={syncAll}
            title={t('Fetch every enabled source in sequence')}
          >
            <Icon name="refresh" size={13} />
            {busy === 'all' ? t('Syncing…') : t('Sync all')}
          </button>
          <button className="btn ghost sm" disabled={busy !== null} onClick={refreshAll}>
            <Icon name="refresh" size={13} />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {error && <ErrorNote message={error} />}
      {notice && (
        <div className={notice.tone === 'ok' ? 'info-note' : 'warn-note'} style={{ marginBottom: 14 }}>
          {notice.text}
        </div>
      )}

      <div className="src-body">
        <Panel>
          <div className="metrics">
            <Metric
              label={t('Candidates')}
              value={compact(stats?.total ?? 0)}
              foot={<span>{t('across all sources')}</span>}
            />
            <Metric
              label={t('Unique endpoints')}
              value={compact(stats?.uniqueEndpoints ?? 0)}
              tone="violet"
              foot={
                <span>
                  {t('{n} hosts').replace('{n}', String(stats?.uniqueHosts ?? 0))}
                </span>
              }
            />
            <Metric
              label={t('Pending review')}
              value={compact(stats?.pending ?? 0)}
              foot={<span>{t('waiting to be promoted')}</span>}
            />
            <Metric
              label={t('Promoted')}
              value={compact(stats?.promoted ?? 0)}
              foot={<span>{t('now in the endpoint table')}</span>}
            />
          </div>
          {Boolean(stats?.byProtocol.length) && (
            <div className="proto-strip">
              {stats!.byProtocol.map((p) => (
                <span key={p.protocol ?? 'unknown'} className="proto-chip">
                  <b>{p.protocol ?? '—'}</b>
                  <span className="num">{compact(p.count)}</span>
                </span>
              ))}
            </div>
          )}
        </Panel>

        <Panel fill>
          <div className="table-wrap">
          {loading ? (
            <Skeleton rows={8} />
          ) : items.length === 0 ? (
            <Empty text={t('No sources yet — import the built-in catalog to start.')} icon="download" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>{t('Source')}</th>
                  <th>{t('Protocol')}</th>
                  <th>{t('Format')}</th>
                  <th>{t('Type')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Trust')}</th>
                  <th>{t('Last sync')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Candidates')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => {
                  const off = !s.enabled;
                  return (
                    <tr key={s.id} className={off ? 'row-dim' : undefined}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span>{s.name}</span>
                          {s.type === 'MANUAL' && <Badge tone="muted">{t('manual')}</Badge>}
                        </div>
                        {s.notes && <div className="row-sub">{s.notes}</div>}
                      </td>
                      <td>
                        {s.protocolHint ? (
                          <span className="chip mono">{s.protocolHint}</span>
                        ) : (
                          <span style={{ color: 'var(--text-4)' }}>—</span>
                        )}
                      </td>
                      <td>
                        <span className="chip">{s.formatHint ?? '—'}</span>
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{s.type}</td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {s.trustLevel}
                      </td>
                      <td style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                        {s.lastSyncedAt ? relativeTime(s.lastSyncedAt, lang) : t('never')}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        <span style={{ color: s.pendingCandidates > 0 ? 'var(--text)' : 'var(--text-4)' }}>
                          {compact(s.pendingCandidates)}
                        </span>
                        <span style={{ color: 'var(--text-4)' }}> / {compact(s.totalCandidates)}</span>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {s.type !== 'MANUAL' && (
                          <button
                            className="btn ghost sm"
                            disabled={busy !== null}
                            onClick={() => syncOne(s)}
                          >
                            {busy === s.id ? t('Syncing…') : t('Sync')}
                          </button>
                        )}
                        {s.pendingCandidates > 0 && (
                          <button
                            className="btn ghost sm"
                            disabled={busy !== null}
                            style={{ marginLeft: 6 }}
                            onClick={() => setPromoting(s)}
                          >
                            {t('Promote')}
                          </button>
                        )}
                        {s.type !== 'MANUAL' && (
                          <button
                            className="btn ghost sm"
                            disabled={busy !== null}
                            style={{ marginLeft: 6 }}
                            onClick={() => toggle(s)}
                            title={off ? t('Enable') : t('Disable')}
                          >
                            {off ? t('Enable') : t('Disable')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          </div>
        </Panel>
      </div>

      <PromoteDrawer
        source={promoting}
        onClose={() => setPromoting(null)}
        onDone={(msg) => {
          setPromoting(null);
          setNotice({ tone: 'ok', text: msg });
          refreshAll();
        }}
        onError={(msg) => setNotice({ tone: 'warn', text: msg })}
      />

      <Drawer
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.name ?? ''}
        sub={detail ? `${detail.format} · ${detail.durationMs} ms` : ''}
        foot={
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setDetail(null)}>
            {t('Close')}
          </button>
        }
      >
        {detail && (
          <div style={{ display: 'grid', gap: 16 }}>
            {detail.error ? (
              <div className="warn-note">{detail.error}</div>
            ) : (
              <div className="info-note">
                {t('Snapshot written')} · {detail.duplicateSnapshot ? t('duplicate content') : t('new content')}
              </div>
            )}
            <div className="kv-note">
              <div>
                <span>{t('Entries parsed')}</span>
                <span className="num">{detail.entries}</span>
              </div>
              <div>
                <span>{t('Candidates written')}</span>
                <span className="num">{detail.candidates}</span>
              </div>
              <div>
                <span>{t('Format')}</span>
                <span>{detail.format}</span>
              </div>
              <div>
                <span>{t('Duration')}</span>
                <span className="num">{detail.durationMs} ms</span>
              </div>
            </div>
            {detail.warnings.length > 0 && (
              <div style={{ display: 'grid', gap: 6 }}>
                <div className="field-label">{t('Warnings')}</div>
                {detail.warnings.map((w) => (
                  <div key={w} className="warn-note">
                    {w}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

/**
 * 批量晋级抽屉。
 *
 * 这里的每一个约束都是刻意的：
 *   · 授权声明必勾 —— 晋级 = 承认这些代理我有权使用，不能让默认值代签
 *   · 单次上限 500 —— 4 万条候选一次全推会把验证队列堵死（8 并发 × 3 秒/条）
 *   · 分级只到 PUBLIC_PROXY —— 提级必须走晋升建议 + 他人复核
 */
function PromoteDrawer({
  source,
  onClose,
  onDone,
  onError,
}: {
  source: SourceSummary | null;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const [limit, setLimit] = useState(200);
  const [declared, setDeclared] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!source) return null;

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.bulkPromote(source.id, limit, 'AUTHORIZED');
      onDone(
        t('{p} promoted · {d} duplicates · {r} left in queue')
          .replace('{p}', String(r.promoted))
          .replace('{d}', String(r.duplicate))
          .replace('{r}', String(r.remaining)),
      );
    } catch (err) {
      onError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={t('Promote candidates')}
      sub={`${source.name} · ${compact(source.pendingCandidates)} ${t('pending')}`}
      foot={
        <>
          <button
            className="btn primary sm"
            disabled={!declared || busy}
            onClick={submit}
          >
            {busy ? t('Promoting…') : t('Promote')}
          </button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
            {t('Cancel')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span className="field-label">{t('Batch size')}</span>
          <div className="seg fixed">
            {[100, 200, 500].map((n) => (
              <button key={n} className={limit === n ? 'on' : ''} onClick={() => setLimit(n)}>
                {n}
              </button>
            ))}
          </div>
          <span className="field-hint">
            {t('Promotion only moves candidates into PENDING_VERIFICATION. They still need to pass verification twice before a pool will accept them.')}
          </span>
        </label>

        <div className="kv-note">
          <div>
            <span>{t('Pending')}</span>
            <span className="num">{compact(source.pendingCandidates)}</span>
          </div>
          <div>
            <span>{t('Trust tier')}</span>
            <span className="mono">PUBLIC_PROXY</span>
          </div>
        </div>

        <label className="check-row">
          <input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
          <span>
            {t('I have the right to use these proxies. This declaration is written to the audit log.')}
          </span>
        </label>

        <div className="warn-note">
          {t(
            'Public lists mix in honeypots and compromised hosts. Verifying before routing real traffic through them is not optional.',
          )}
        </div>
      </div>
    </Drawer>
  );
}

function errText(err: unknown): string {
  if (err instanceof ApiError) return `${err.problem?.code ?? 'ERROR'}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
