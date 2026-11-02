import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, Drawer, Empty, ErrorNote, KV, Panel, Progress, Skeleton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import {
  authorizationLabel,
  countryLabel,
  failureLabel,
  lifecycleLabel,
  lifecycleTone,
  ms,
  pct,
  relativeTime,
  tierLabel,
  tierTone,
} from '../lib/format';

const TIERS = ['', 'PRIVATE_PROXY', 'VERIFIED_PROXY', 'PUBLIC_PROXY'] as const;
const STATUSES = ['', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'PENDING_VERIFICATION'] as const;

export function Resources(): JSX.Element {
  const { t, lang } = useI18n();
  const [tier, setTier] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [cursor, setCursor] = useState<string>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set('limit', '25');
    if (tier) p.set('tier', tier);
    if (status) p.set('status', status);
    if (cursor) p.set('cursor', cursor);
    return p.toString();
  }, [tier, status, cursor]);

  const { data, error, loading, reload } = useAsync(() => api.resources(query), [query]);

  const quarantine = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await api.quarantine(id);
      reload();
      setOpenId(null);
    } finally {
      setBusy(false);
    }
  };

  /** 换筛选条件必须回到第一页 —— 否则旧游标指向的是上一组结果的位置 */
  const pickTier = (v: string): void => {
    setTier(v);
    setCursor('');
  };
  const pickStatus = (v: string): void => {
    setStatus(v);
    setCursor('');
  };

  const items = data?.items ?? [];

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <div className="t-eyebrow">{t('Endpoint inventory')}</div>
          <h1 className="t-title">{t('Resources')}</h1>
          <p className="t-desc">
            {t('Trust')} · {t('Health')} · {t('Quality')} —{' '}
            {data ? `${data.total} ${t('endpoints')}` : '—'}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost sm" onClick={reload}>
            <Icon name="refresh" size={13} />
            {t('Refresh')}
          </button>
          <button className="btn primary sm" onClick={() => setImporting(true)}>
            <Icon name="plus" size={13} />
            {t('Import')}
          </button>
        </div>
      </div>

      <div className="filterbar">
        <div className="seg">
          {TIERS.map((v) => (
            <button
              className={tier === v ? 'on' : ''}
              onClick={() => pickTier(v)}
              key={v || 'all'}
            >
              {t(v ? (tierLabel[v] ?? v) : 'All tiers')}
            </button>
          ))}
        </div>
        <div className="seg">
          {STATUSES.map((v) => (
            <button
              className={status === v ? 'on' : ''}
              onClick={() => pickStatus(v)}
              key={v || 'any'}
            >
              {t(v ? (lifecycleLabel[v] ?? v) : 'All statuses')}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorNote message={error} />}

      <ProbeScheduleStrip />

      <Panel fill>
        <div className="table-wrap">
          {loading ? (
            <Skeleton rows={8} />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>{t('Host')}</th>
                  <th>{t('Protocol')}</th>
                  <th>{t('Tier')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Country')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Latency')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Success')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Quality')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Last verified')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr onClick={() => setOpenId(e.id)} style={{ cursor: 'pointer' }} key={e.id}>
                    <td className="mono">
                      {e.host}:{e.port}
                    </td>
                    <td>
                      <span className="chip">{e.protocol}</span>
                    </td>
                    <td>
                      <Badge tone={tierTone[e.trustTier] as 'violet' | 'cyan' | 'warn'}>
                        {t(tierLabel[e.trustTier] ?? e.trustTier)}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={lifecycleTone[e.lifecycleStatus] as 'ok'} dot>
                        {t(lifecycleLabel[e.lifecycleStatus] ?? e.lifecycleStatus)}
                      </Badge>
                    </td>
                    <td>{countryLabel(e.countryCode)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {ms(e.health?.p50Ms ?? null)}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {pct(e.health?.successRate24h ?? null)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Progress
                          value={e.qualityScore}
                          tone={e.qualityScore >= 80 ? 'ok' : e.qualityScore >= 60 ? 'warn' : 'bad'}
                        />
                        <span className="num" style={{ width: 24, textAlign: 'right' }}>
                          {e.qualityScore.toFixed(0)}
                        </span>
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--text-3)', fontSize: 11.5 }}>
                      {relativeTime(e.lastVerifiedAt, lang)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {items.length === 0 && !loading && <Empty text={t('No resources')} />}
        </div>

        <div className="table-foot">
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {data ? `${data.items.length} ${t('of')} ${data.total}` : ''}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              className="btn ghost sm"
              disabled={!cursor}
              onClick={() => setCursor('')}
              title={t('Previous page')}
            >
              <Icon name="arrow" size={13} className="flip-x" />
            </button>
            <button
              className="btn ghost sm"
              disabled={!data?.hasMore || !data?.nextCursor}
              onClick={() => setCursor(data?.nextCursor ?? '')}
              title={t('Next page')}
            >
              <Icon name="arrow" size={13} />
            </button>
          </div>
        </div>
      </Panel>

      <EndpointDrawer
        id={openId}
        onClose={() => setOpenId(null)}
        onQuarantine={quarantine}
        onChanged={reload}
        busy={busy}
      />

      <ImportDrawer
        open={importing}
        onClose={() => setImporting(false)}
        onDone={() => {
          reload();
        }}
      />
    </div>
  );
}

/**
 * 分级探测的进度条。
 *
 * 这一条存在的理由：`lifecycle_status` 在界面上是静止的，没人能看出
 * "它从没被探过"和"探过、是好的"有什么区别。把每一档的周期和到期数摆出来，
 * 才能回答"为什么这个节点还停在上次的状态"——是调度没开，还是排在后面没轮到。
 *
 * 只显示"到期 / 总数"而不是画进度环：这里的数字几乎总是 0，
 * 一个恒为 0 的进度环只会让人以为坏了。
 */
function ProbeScheduleStrip(): JSX.Element | null {
  const { t } = useI18n();
  const { data } = useAsync(() => api.probeSchedule(), []);
  if (!data) return null;

  const rows = data.tiers.filter((x) => x.total > 0);
  if (rows.length === 0) return null;

  return (
    <div className="panel" style={{ padding: '10px 14px', marginBottom: 12 }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
          fontSize: 12, color: 'var(--muted)',
        }}
      >
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>{t('Probe schedule')}</span>
        {rows.map((x) => (
          <span key={x.status} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{t(lifecycleLabel[x.status] ?? x.status)}</span>
            <span className="mono" style={{ color: 'var(--muted)' }}>
              {x.intervalMin === null ? '—' : `${x.intervalMin}m`}
            </span>
            <span
              className="mono"
              style={{ color: x.due > 0 ? 'var(--warn)' : 'var(--ok)' }}
            >
              {x.due}/{x.total}
            </span>
          </span>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge tone={data.activeJobs > 0 ? 'info' : 'muted'}>
            {data.activeJobs > 0 ? t('Probing') : t('Idle')}
          </Badge>
          <span className="mono" style={{ color: 'var(--muted)' }}>{data.probeMode}</span>
        </span>
      </div>
    </div>
  );
}

/**
 * 探测时间的展示。
 *
 * 只显示 HH:MM:SS 在跨天的列表里是错的：8 条记录可能横跨三天，
 * 「06:26 / 23:26 / 15:26」看不出先后。当天只显示时刻，更早的补上日期。
 */
function checkStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hms = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return hms;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hms.slice(0, 5)}`;
}

/**
 * 端点详情。
 *
 * 用抽屉而不是独立路由：运维的动线是「在列表里扫到一个可疑端点 → 就地展开看探测
 * 历史 → 关掉继续扫」。跳到新页面再返回会丢掉筛选条件和滚动位置，等于每次都要
 * 重新定位一遍。
 */
function EndpointDrawer({
  id,
  onClose,
  onQuarantine,
  onChanged,
  busy,
}: {
  id: string | null;
  onClose: () => void;
  onQuarantine: (id: string) => void;
  onChanged: () => void;
  busy: boolean;
}): JSX.Element | null {
  const { t, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(
    () => (id ? api.resource(id) : Promise.resolve(null)),
    [id],
  );
  const [acting, setActing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!id) return null;

  const e = data;
  const latest = e?.recentChecks[0] ?? null;

  /**
   * 授权声明。
   *
   * 导入的端点默认 UNKNOWN，而订阅取数视图只放行 AUTHORIZED / RESTRICTED ——
   * 少了这一步，端点明明 HEALTHY、也在池里，订阅里却一个节点都没有。
   */
  const authorize = async (): Promise<void> => {
    if (!e) return;
    setActing('authorize');
    setNote(null);
    try {
      await api.updateResource(e.id, { authorizationStatus: 'AUTHORIZED' });
      reload();
      onChanged();
      setNote(t('Authorized. It can now be published through a subscription.'));
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActing(null);
    }
  };

  /** 验证任务由 worker 异步认领，这里只负责提交并给出任务号。 */
  const verify = async (): Promise<void> => {
    if (!e) return;
    setActing('verify');
    setNote(null);
    try {
      const job = await api.runVerification('ENDPOINT', [e.id]);
      setNote(`${t('Verification queued')} · ${job.id.slice(-8)}`);
      reload();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActing(null);
    }
  };

  const unverified = e?.authorizationStatus === 'UNKNOWN';

  return (
    <Drawer
      open
      onClose={onClose}
      title={e ? `${e.host}:${e.port}` : t('Resource detail')}
      sub={
        e
          ? `${e.protocol} · ${t(tierLabel[e.trustTier] ?? e.trustTier)} · ${countryLabel(e.countryCode)}`
          : ''
      }
      foot={
        e && (
          <>
            <button
              className="btn ghost sm"
              disabled={acting !== null}
              onClick={verify}
              title={t('Queue a probe for this endpoint')}
            >
              <Icon name="play" size={12} />
              {acting === 'verify' ? t('Queued…') : t('Verify now')}
            </button>
            <button
              className="btn primary sm"
              disabled={acting !== null || !unverified}
              onClick={authorize}
            >
              {t('Authorize')}
            </button>
            <button
              className="btn danger sm"
              disabled={busy || e.lifecycleStatus === 'QUARANTINED'}
              onClick={() => onQuarantine(e.id)}
            >
              {t('Quarantine')}
            </button>
            <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
              {t('Close')}
            </button>
          </>
        )
      }
    >
      {loading && <Skeleton rows={6} />}
      {error && <ErrorNote message={error} />}

      {e && (
        <div style={{ display: 'grid', gap: 18 }}>
          {note && <div className="info-note">{note}</div>}

          {unverified && (
            <div className="warn-note">
              {t(
                'Authorization is UNKNOWN, so this endpoint is filtered out of every subscription even when it is healthy. Authorize it if you are allowed to use it.',
              )}
            </div>
          )}
          <section>
            <div className="sect-label">{t('Status')}</div>
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <KV
                k={t('Tier')}
                v={
                  <Badge tone={tierTone[e.trustTier] as 'violet' | 'cyan' | 'warn'}>
                    {t(tierLabel[e.trustTier] ?? e.trustTier)}
                  </Badge>
                }
              />
              <KV
                k={t('Status')}
                v={
                  <Badge tone={lifecycleTone[e.lifecycleStatus] as 'ok'} dot>
                    {t(lifecycleLabel[e.lifecycleStatus] ?? e.lifecycleStatus)}
                  </Badge>
                }
              />
              <KV
                k={t('Authorization')}
                v={t(authorizationLabel[e.authorizationStatus] ?? e.authorizationStatus)}
              />
              <KV
                k={t('Gateway grant')}
                v={t(e.explicitGatewayGrant ? 'granted' : 'none')}
              />
              <KV k={t('Quality')} v={e.qualityScore.toFixed(2)} />
            </div>
          </section>

          <section>
            <div className="sect-label">{t('Health')}</div>
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <KV
                k="P50 / P95"
                v={`${ms(e.health?.p50Ms ?? null)} / ${ms(e.health?.p95Ms ?? null)}`}
              />
              <KV k={t('Jitter')} v={ms(e.health?.jitterMs ?? null)} />
              <KV k={t('Success')} v={pct(e.health?.successRate24h ?? null)} />
              <KV
                k={t('Consecutive failures')}
                v={String(e.health?.consecutiveFailures ?? 0)}
              />
              {/* 出口 IP 是识别代理串联的唯一手段：请求成功但出口 IP 变了，
                  说明链路中途被换过，比延迟抖动严重得多。 */}
              <KV k={t('Exit IP')} v={latest?.exitIp ?? '—'} />
              <KV k={t('Last verified')} v={relativeTime(e.lastVerifiedAt, lang)} />
            </div>
          </section>

          {e.pools.length > 0 && (
            <section>
              <div className="sect-label">{t('Member of')}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {e.pools.map((p) => (
                  <span className="chip" key={p.id}>
                    {p.key}
                  </span>
                ))}
              </div>
            </section>
          )}

          {e.recentChecks.length > 0 && (
            <section>
              <div className="sect-label">{t('Recent checks')}</div>
              <div style={{ display: 'grid', gap: 2, marginTop: 8 }}>
                {e.recentChecks.slice(0, 8).map((c, i) => (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11.5,
                      padding: '5px 0',
                      borderBottom: '1px solid var(--ov-2)',
                    }}
                    key={i}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: 3,
                        background: c.success ? 'var(--success)' : 'var(--danger)',
                        flex: '0 0 auto',
                      }}
                    />
                    <span style={{ color: 'var(--text-3)', width: 72, flex: '0 0 auto' }}>
                      {checkStamp(c.checkedAt)}
                    </span>
                    <span style={{ color: c.success ? 'var(--text-2)' : 'var(--danger-2)' }}>
                      {c.success ? t('OK') : t(failureLabel[c.failureReason] ?? c.failureReason)}
                    </span>
                    <span style={{ marginLeft: 'auto' }} className="num">
                      {ms(c.totalMs)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────────
// 批量导入
// ─────────────────────────────────────────────────────────────

const PROTOCOLS = ['HTTP', 'HTTPS_CONNECT', 'SOCKS4', 'SOCKS5'] as const;

interface ImportReport {
  total: number;
  imported: number;
  duplicated: number;
  skipped: number;
  errors: Array<{ lineNo: number; rawValue: string; reason: string }>;
}

/**
 * 导入抽屉。
 *
 * 只支持 HTTP / HTTPS_CONNECT / SOCKS4 / SOCKS5 —— 后端解析器不认
 * ss:// vmess:// trojan:// vless://，贴进来会被逐行拒绝并给出原因，
 * 所以这里直接把格式写清楚，省得用户以为「导入成功但没效果」。
 */
function ImportDrawer({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [protocol, setProtocol] = useState<string>('HTTP');
  const [tier, setTier] = useState<string>('PUBLIC_PROXY');
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;

  const submit = async (): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    setReport(null);
    try {
      const r = await api.importText(text, {
        defaultProtocol: protocol,
        trustTier: tier,
        authorized,
      });
      setReport(r);
      setText('');
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('Import proxies')}
      sub={t('One per line — plain host:port also works')}
      foot={
        <>
          <button className="btn primary sm" disabled={busy || !text.trim()} onClick={submit}>
            {busy ? t('Importing…') : `${t('Import')}${lines ? ` ${lines}` : ''}`}
          </button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span className="field-label">{t('Endpoints')}</span>
          <textarea
            className="input textarea"
            rows={9}
            spellCheck={false}
            placeholder={'1.2.3.4:8080\n5.6.7.8:1080:user:pass\nsocks5://9.9.9.9:1080'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="field-hint">
            {t('Accepted: host:port · host:port:user:pass · scheme://host:port · scheme://user:pass@host:port')}
          </span>
          <span className="field-hint">
            {t('Shadowsocks / VMess / Trojan / VLESS URLs are not supported — they are rejected line by line.')}
          </span>
        </label>

        <div className="grid g-2" style={{ gap: 12 }}>
          <label className="field">
            <span className="field-label">{t('Default protocol')}</span>
            <select className="input" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              {PROTOCOLS.map((p) => (
                <option value={p} key={p}>
                  {p}
                </option>
              ))}
            </select>
            <span className="field-hint">{t('Used when a line has no scheme prefix.')}</span>
          </label>

          <label className="field">
            <span className="field-label">{t('Tier')}</span>
            <select className="input" value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="PUBLIC_PROXY">{t('Public proxy')}</option>
              <option value="PRIVATE_PROXY">{t('Private proxy')}</option>
              <option value="VERIFIED_PROXY">{t('Verified proxy')}</option>
            </select>
            <span className="field-hint">
              {t('Defaults to the strictest tier. Promotion between tiers still goes through review.')}
            </span>
          </label>
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={authorized}
            onChange={(e) => setAuthorized(e.target.checked)}
          />
          <span>
            {t('I am allowed to use these proxies')}
            <span className="field-hint" style={{ display: 'block' }}>
              {t(
                'Marks them AUTHORIZED. Without this they stay UNKNOWN and are filtered out of every subscription.',
              )}
            </span>
          </span>
        </label>

        {err && <div className="form-error">{err}</div>}

        {report && (
          <div className="kv-note">
            <div>
              <span>{t('Imported')}</span>
              <span className="mono">{report.imported}</span>
            </div>
            <div>
              <span>{t('Duplicated')}</span>
              <span className="mono">{report.duplicated}</span>
            </div>
            <div>
              <span>{t('Skipped')}</span>
              <span className="mono">{report.skipped}</span>
            </div>
            {report.errors.slice(0, 5).map((x) => (
              <div key={x.lineNo}>
                <span className="mono">L{x.lineNo}</span>
                <span style={{ color: 'var(--danger-2)' }}>{x.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}
