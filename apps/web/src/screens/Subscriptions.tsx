import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, Drawer, Empty, ErrorNote, Panel, Skeleton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { relativeTime } from '../lib/format';
import type { SubscriptionRow } from '@proxyforge/contracts';

/** 创建成功后拿到的一次性明文 Token。库里只有 sha256，丢了只能重签发。 */
interface Issued {
  id: string;
  name: string;
  url: string;
  token: string;
  rotated: boolean;
  format: string;
}

/**
 * 导出格式。
 *
 * label 保留英文技术名词不翻译 —— 用户就是靠 "Clash" "sing-box" "base64"
 * 这些词判断该选哪个，翻成中文反而对不上客户端里的叫法。
 */
const FORMATS: Array<{ value: string; label: string; client: string; ext: string }> = [
  {
    value: 'mihomo',
    label: 'Clash / Mihomo YAML',
    client: 'Clash Verge · FlClash · Mihomo Party · OpenClash',
    ext: '.yaml',
  },
  {
    value: 'singbox',
    label: 'sing-box JSON',
    client: 'sing-box core · Clash Verge Rev · FlClash',
    ext: '.json',
  },
  {
    value: 'base64',
    label: 'Base64 subscription',
    client: 'v2rayN · Shadowrocket · 通用订阅格式',
    ext: '.txt',
  },
  {
    value: 'plain',
    label: 'Plain URI list',
    client: '人工查看 · 粘到别处',
    ext: '.txt',
  },
];

const formatLabel = (v: string): string => FORMATS.find((f) => f.value === v)?.label ?? v;

export function Subscriptions(): JSX.Element {
  const { t, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => api.subscriptions(), []);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [rotating, setRotating] = useState<SubscriptionRow | null>(null);
  const [exporting, setExporting] = useState<SubscriptionRow | null>(null);

  const items = data?.items ?? [];

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <div className="t-eyebrow">{t('Signed distribution')}</div>
          <h1 className="t-title">{t('Subscriptions')}</h1>
          <p className="t-desc">
            {t(
              'The signed object is JCS-canonical JSON, not the YAML byte stream. A monotonic revision blocks replay.',
            )}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost sm" onClick={reload}>
            <Icon name="refresh" size={13} />
            {t('Refresh')}
          </button>
          <button className="btn primary sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={13} />
            {t('New subscription')}
          </button>
        </div>
      </div>

      {error && <ErrorNote message={error} />}

      <Panel fill>
        <div className="table-wrap">
          {loading ? (
            <Skeleton rows={5} />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('Pool')}</th>
                  <th>{t('Format')}</th>
                  <th>{t('Token prefix')}</th>
                  <th>{t('Signed')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Revision')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Accesses')}</th>
                  <th style={{ textAlign: 'right' }}>{t('Expires')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {s.poolKey}
                    </td>
                    <td>
                      <span className="chip">{s.format}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {s.tokenPrefix}…
                    </td>
                    <td>
                      {s.signingEnabled ? (
                        <Badge tone="ok" dot>
                          Ed25519
                        </Badge>
                      ) : (
                        <Badge tone="muted">{t('unsigned')}</Badge>
                      )}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {s.revision}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {s.accessCount}
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--text-3)' }}>
                      {s.revokedAt ? t('revoked') : relativeTime(s.expiresAt, lang)}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {/*
                        导出走 JWT 接口，不依赖明文 token —— 所以刷新页面之后
                        依然能导出任意订阅，不必为了拿文件去重建订阅。
                      */}
                      <button
                        className="btn ghost sm"
                        disabled={Boolean(s.revokedAt)}
                        onClick={() => setExporting(s)}
                        title={s.revokedAt ? t('Revoked subscriptions cannot be exported') : t('Export')}
                      >
                        <Icon name="download" size={13} />
                        {t('Export')}
                      </button>
                      {/*
                        明文 Token 只在创建时返回一次，界面上原本没有任何入口能把它拿回来。
                        重签发换掉 token_hash，旧 URL 立刻失效 —— 这比「删了重建」更安全，
                        也不会丢掉访问计数与版本历史。
                      */}
                      <button
                        className="btn ghost sm"
                        style={{ marginLeft: 6 }}
                        disabled={Boolean(s.revokedAt)}
                        onClick={() => setRotating(s)}
                        title={t('Reissue token')}
                      >
                        {t('Reissue')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {items.length === 0 && !loading && <Empty text={t('No subscriptions yet')} icon="subscriptions" />}
        </div>
      </Panel>

      <div style={{ marginTop: 16 }} className="grid g-2">
        <Panel
          title={t('Signing keys')}
          sub={t('Private key lives only in the secrets table; the API never returns it')}
        >
          <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Badge tone="ok" dot>
                {t('ACTIVE')}
              </Badge>
              <span className="mono" style={{ fontSize: 11.5 }}>
                pf-sub-2026-11
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.7 }}>
              {t('Public key distribution:')}{' '}
              <span className="mono">/.well-known/proxyforge-signing-keys.json</span>
              <br />
              {t(
                'Client verification order: known signatureVersion → matching canonicalHash → Ed25519 verify → increasing revision → not expired.',
              )}
            </div>
          </div>
        </Panel>

        <Panel title={t('Render endpoints')} sub={t('Token auth, not JWT')}>
          <div className="panel-body" style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.8 }}>
            <div className="mono">GET /api/v1/subscriptions/{'{token}'}</div>
            <div className="mono">GET /api/v1/subscriptions/{'{token}'}?format=singbox</div>
            <div className="mono">GET /api/v1/subscriptions/{'{token}'}?download=1</div>
            <div className="mono">GET /api/v1/subscriptions/{'{id}'}/export?format=base64</div>
            <div style={{ marginTop: 8 }}>
              {t(
                'format accepts mihomo / clash / singbox / base64 / plain. Overriding it does not bump the revision.',
              )}
            </div>
            <div>
              {t('Missing / revoked / expired all return 404, to prevent enumeration.')}
            </div>
          </div>
        </Panel>
      </div>

      <CreateDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onIssued={(v) => {
          setCreating(false);
          setIssued(v);
          reload();
        }}
      />

      <RotateDrawer
        sub={rotating}
        onClose={() => setRotating(null)}
        onIssued={(v) => {
          setRotating(null);
          setIssued(v);
        }}
      />

      <IssuedDrawer issued={issued} onClose={() => setIssued(null)} />

      <ExportDrawer sub={exporting} onClose={() => setExporting(null)} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 新建订阅
// ─────────────────────────────────────────────────────────────

function CreateDrawer({
  open,
  onClose,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  onIssued: (v: Issued) => void;
}): JSX.Element {
  const { t } = useI18n();
  const pools = useAsync(() => (open ? api.pools() : Promise.resolve({ items: [] })), [open]);

  const [name, setName] = useState('clash');
  const [poolId, setPoolId] = useState('');
  const [format, setFormat] = useState('mihomo');
  const [signing, setSigning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const list = pools.data?.items ?? [];
  const pool = poolId || list[0]?.id || '';

  const submit = async (): Promise<void> => {
    if (!name.trim() || !pool) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createSubscription({
        name: name.trim(),
        poolId: pool,
        format,
        signingEnabled: signing,
      });
      onIssued({ id: r.id, name: r.name, url: absoluteUrl(r.url), token: r.token, rotated: false, format });
      setName('clash');
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
      title={t('New subscription')}
      sub={t('Pick a pool, then paste the URL into your client')}
      foot={
        <>
          <button className="btn primary sm" disabled={busy || !pool} onClick={submit}>
            {busy ? t('Creating…') : t('Create')}
          </button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
            {t('Cancel')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span className="field-label">{t('Name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="field">
          <span className="field-label">{t('Pool')}</span>
          <select className="input" value={pool} onChange={(e) => setPoolId(e.target.value)}>
            {list.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name} · {p.memberCount} {t('endpoints')}
              </option>
            ))}
          </select>
          {list.length === 0 && !pools.loading && (
            <span className="field-hint">{t('No pool available — create one first.')}</span>
          )}
        </label>

        <label className="field">
          <span className="field-label">{t('Default format')}</span>
          <select className="input" value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((f) => (
              <option value={f.value} key={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <span className="field-hint">
            {t('{client} reads this format.')
              .replace('{client}', FORMATS.find((f) => f.value === format)?.client ?? '')}
          </span>
          <span className="field-hint">
            {t('This is only the default — any subscription can be exported to all four formats later.')}
          </span>
        </label>

        <label className="check-row">
          <input type="checkbox" checked={signing} onChange={(e) => setSigning(e.target.checked)} />
          <span>
            {t('Sign with Ed25519')}
            <span className="field-hint" style={{ display: 'block' }}>
              {t('Adds X-PF-Signature and X-PF-Revision headers. Clients may verify; the body stays standard YAML.')}
            </span>
          </span>
        </label>

        {err && <div className="form-error">{err}</div>}
      </div>
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────────
// 重签发
// ─────────────────────────────────────────────────────────────

function RotateDrawer({
  sub,
  onClose,
  onIssued,
}: {
  sub: SubscriptionRow | null;
  onClose: () => void;
  onIssued: (v: Issued) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!sub) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.rotateSubscriptionToken(sub.id);
      onIssued({
        id: sub.id,
        name: sub.name,
        url: absoluteUrl(r.url),
        token: r.token,
        rotated: true,
        format: sub.format,
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={Boolean(sub)}
      onClose={onClose}
      title={t('Reissue token')}
      sub={sub?.name}
      foot={
        <>
          <button className="btn danger sm" disabled={busy} onClick={submit}>
            {busy ? t('Working…') : t('Reissue now')}
          </button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
            {t('Cancel')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="warn-note">
          {t('The current URL stops working the moment you confirm. Any client still using it starts failing.')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.8 }}>
          {t('The subscription itself, its revision and its version history are kept. Only the token is replaced.')}
        </div>
        {err && <div className="form-error">{err}</div>}
      </div>
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────────
// 一次性 Token 展示
// ─────────────────────────────────────────────────────────────

function IssuedDrawer({
  issued,
  onClose,
}: {
  issued: Issued | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);
  const [dl, setDl] = useState<string | null>(null);
  const [dlErr, setDlErr] = useState<string | null>(null);

  const copy = async (text: string, which: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const download = async (fmt: string): Promise<void> => {
    if (!issued) return;
    setDl(fmt);
    setDlErr(null);
    try {
      const { blob, filename } = await api.exportSubscription(issued.id, fmt);
      saveBlob(blob, filename);
    } catch (e) {
      setDlErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setDl(null);
    }
  };

  return (
    <Drawer
      open={Boolean(issued)}
      onClose={onClose}
      title={issued?.rotated ? t('Token reissued') : t('Subscription created')}
      sub={issued?.name}
      foot={
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
          {t('Done')}
        </button>
      }
    >
      {issued && (
        <div className="form-grid">
          <div className="warn-note">
            {t('This token is shown once and never again. The database only stores its hash.')}
          </div>

          <label className="field">
            <span className="field-label">{t('Subscription URL')}</span>
            {/*
              不能用 <input> 展示：订阅地址有 60 多个字符，抽屉只有 355px 宽，
              输入框里永远只能看到开头一段 —— 而这一段恰恰是每个订阅都一样的前缀。
              换成会折行的块，整条地址一次看全。
            */}
            <div className="url-box">
              <code>{issued.url}</code>
              <button className="btn ghost sm" onClick={() => copy(issued.url, 'url')}>
                <Icon name={copied === 'url' ? 'check' : 'download'} size={13} />
                {copied === 'url' ? t('Copied') : t('Copy')}
              </button>
            </div>
            <span className="field-hint">
              {t('Paste this into Clash / FlClash / Mihomo as a remote config URL.')}
            </span>
          </label>

          <div className="kv-note">
            <div>
              <span>{t('Default format')}</span>
              <span className="mono">{formatLabel(issued.format)}</span>
            </div>
            <div>
              <span>{t('Refresh')}</span>
              <span>{t('Clients re-pull on their own schedule; revision bumps on every content change.')}</span>
            </div>
          </div>

          {/*
            直接下载和「粘 URL」是两种用法：前者适合当场导入客户端，
            后者适合让客户端自己定期拉取。两个都给，不做取舍。
          */}
          <div className="field">
            <span className="field-label">{t('Download now')}</span>
            <div className="dl-row">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  className="btn ghost sm"
                  disabled={dl !== null}
                  onClick={() => download(f.value)}
                  title={f.client}
                >
                  <Icon name="download" size={13} />
                  {dl === f.value ? t('Downloading…') : f.label}
                </button>
              ))}
            </div>
            <span className="field-hint">
              {t('Downloads the same node set in another serialisation. The revision does not change.')}
            </span>
            {dlErr && <div className="form-error">{dlErr}</div>}
          </div>
        </div>
      )}
    </Drawer>
  );
}

/**
 * 订阅 URL 必须是绝对地址才能粘进客户端。
 * 后端返回的是相对路径（它不知道自己在哪个域名后面），由前端补全。
 */
function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${window.location.origin}${path}`;
}

/**
 * 触发浏览器保存。
 *
 * 必须 `revokeObjectURL`：不释放的话每个 Blob 都会一直挂在文档上，
 * 用户导出几次之后页面内存里就多了几份几 MB 的字符串。
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给浏览器一点时间开始读取，立刻 revoke 在部分版本上会让下载变成 0 字节
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ─────────────────────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────────────────────

function ExportDrawer({
  sub,
  onClose,
}: {
  sub: SubscriptionRow | null;
  onClose: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const [dl, setDl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!sub) return null;

  const download = async (fmt: string): Promise<void> => {
    setDl(fmt);
    setErr(null);
    setDone(null);
    try {
      const { blob, filename } = await api.exportSubscription(sub.id, fmt);
      saveBlob(blob, filename);
      setDone(filename);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setDl(null);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={t('Export subscription')}
      sub={`${sub.name} · ${sub.poolKey}`}
      foot={
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
          {t('Close')}
        </button>
      }
    >
      <div className="form-grid">
        <div className="kv-note">
          <div>
            <span>{t('Default format')}</span>
            <span className="mono">{formatLabel(sub.format)}</span>
          </div>
          <div>
            <span>{t('Revision')}</span>
            <span className="num">{sub.revision}</span>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          {FORMATS.map((f) => (
            <div className="fmt-row" key={f.value}>
              <div style={{ minWidth: 0 }}>
                <div className="fmt-name">
                  {f.label}
                  {f.value === sub.format && <span className="chip" style={{ marginLeft: 8 }}>{t('default')}</span>}
                </div>
                <div className="fmt-client">{f.client}</div>
              </div>
              <button
                className="btn ghost sm"
                disabled={dl !== null}
                onClick={() => download(f.value)}
                style={{ flex: '0 0 auto' }}
              >
                <Icon name="download" size={13} />
                {dl === f.value ? t('Downloading…') : t('Download')}
              </button>
            </div>
          ))}
        </div>

        {done && (
          <div className="info-note">
            {t('Saved as {file}').replace('{file}', done)}
          </div>
        )}
        {err && <div className="form-error">{err}</div>}

        <div className="warn-note">
          {t(
            'These exports carry the same node set but no signature. Signature headers only come with the token URL.',
          )}
        </div>
      </div>
    </Drawer>
  );
}
