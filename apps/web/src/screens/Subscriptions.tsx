import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, Drawer, Empty, ErrorNote, Panel, Skeleton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { relativeTime } from '../lib/format';
import type {
  ProxyProtocol,
  SubscriptionNodeFilter,
  SubscriptionRow,
  SubscriptionRoutingMode,
} from '@proxyforge/contracts';

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

/**
 * 三档分流。
 *
 * 不提供更多档位（比如"自定义规则模式"）：模式决定的是**内建规则集**，
 * 想更细的控制应该写在追加规则里 —— 那里能表达任何规则，而模式只是
 * 三个常用预设。档位一多，用户就得先理解规则引擎才能选。
 */
const ROUTING_MODES: Array<{ value: SubscriptionRoutingMode; label: string; hint: string }> = [
  { value: 'global', label: 'Global', hint: 'All traffic through the proxy' },
  { value: 'rule', label: 'Rule', hint: 'China direct, everything else proxied' },
  { value: 'direct', label: 'Direct', hint: 'Everything direct — use it to isolate whether the proxy is the problem' },
];

const ALL_PROTOCOLS: ProxyProtocol[] = ['SOCKS5', 'SOCKS4', 'HTTPS_CONNECT', 'HTTP'];

const PROTOCOL_LABEL: Record<ProxyProtocol, string> = {
  SOCKS5: 'SOCKS5',
  SOCKS4: 'SOCKS4',
  HTTPS_CONNECT: 'HTTPS',
  HTTP: 'HTTP',
};

export function Subscriptions(): JSX.Element {  const { t, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => api.subscriptions(), []);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [rotating, setRotating] = useState<SubscriptionRow | null>(null);
  const [exporting, setExporting] = useState<SubscriptionRow | null>(null);
  const [editing, setEditing] = useState<SubscriptionRow | null>(null);

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
                      {/*
                        分流档位放在格式旁边，不单开一列 —— 表格已经有九列，
                        再加一列在 1280 宽的窗口里会把操作按钮挤到换行。
                        档位是"这份配置怎么用"的一部分，和格式同类。
                      */}
                      <span
                        className="chip"
                        style={{ marginLeft: 4 }}
                        title={t(ROUTING_MODES.find((m) => m.value === s.routingMode)?.hint ?? '')}
                      >
                        {s.routingMode}
                      </span>
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
                        分流与过滤之前是"建完就定死"的：想换模式只能删了重建，
                        而重建会换掉 token（客户端要重新导入）并丢掉版本历史。
                      */}
                      <button
                        className="btn ghost sm"
                        style={{ marginLeft: 6 }}
                        disabled={Boolean(s.revokedAt)}
                        onClick={() => setEditing(s)}
                        title={t('Routing & filtering')}
                      >
                        {t('Settings')}
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

      {/*
        key 用订阅 id：抽屉里的表单状态是从订阅行初始化的，
        换一个订阅必须重新挂载，否则会拿着上一个订阅的值去保存。
      */}
      {editing && (
        <SettingsDrawer
          key={editing.id}
          sub={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
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
  // 分流档位在创建时就选好：默认 global 对大多数人不对，
  // 而"建完再去设置里改"这一步没人会主动做。
  const [routing, setRouting] = useState<SubscriptionRoutingMode>('rule');
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
        routingMode: routing,
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

        <label className="field">
          <span className="field-label">{t('Routing mode')}</span>
          <div className="seg fixed" style={{ width: 'fit-content' }}>
            {ROUTING_MODES.map((m) => (
              <button
                key={m.value}
                className={routing === m.value ? 'on' : ''}
                onClick={() => setRouting(m.value)}
                title={t(m.hint)}
              >
                {t(m.label)}
              </button>
            ))}
          </div>
          <span className="field-hint">{t(ROUTING_MODES.find((m) => m.value === routing)?.hint ?? '')}</span>
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
// 分流与过滤
// ─────────────────────────────────────────────────────────────

interface PreviewState {
  matched: number;
  byProtocol: Record<string, number>;
  sampleNames: string[];
  loading: boolean;
  error: string | null;
}

/**
 * 分流与节点过滤。
 *
 * 两个设计决定值得说明：
 *
 * 1. **实时预览**。过滤条件是"盲配"的 —— 用户设 minQuality=80 时不知道还剩
 *    几个节点。没有预览，唯一的反馈方式是保存后拉一次订阅，于是变成
 *    "保存 → 发现是空的 → 再改"的循环。这里 400ms 防抖打一次预览接口。
 *
 * 2. **保存只改渲染字段**。不动 token、不动 revision 的语义 —— 内容变了
 *    revision 会自然递增（服务端把分流设置算进了内容指纹），token 不变，
 *    所以客户端不需要重新导入，下次拉取就拿到新配置。
 */
function SettingsDrawer({
  sub,
  onClose,
  onSaved,
}: {
  sub: SubscriptionRow;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { t } = useI18n();

  const [mode, setMode] = useState<SubscriptionRoutingMode>(sub.routingMode);
  const [protocols, setProtocols] = useState<ProxyProtocol[]>(sub.nodeFilter.protocols ?? []);
  const [minQuality, setMinQuality] = useState(str(sub.nodeFilter.minQuality));
  const [maxLatency, setMaxLatency] = useState(str(sub.nodeFilter.maxLatencyMs));
  const [maxNodes, setMaxNodes] = useState(str(sub.nodeFilter.maxNodes));
  const [excludeHosts, setExcludeHosts] = useState((sub.nodeFilter.excludeHosts ?? []).join(', '));
  const [template, setTemplate] = useState(sub.nameTemplate ?? '');
  const [rules, setRules] = useState(sub.extraRules.join('\n'));

  const [preview, setPreview] = useState<PreviewState>({
    matched: 0, byProtocol: {}, sampleNames: [], loading: true, error: null,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /** 组装请求体。预览与保存必须用**同一份**构造逻辑，否则预览的数字会骗人。 */
  const buildBody = (): {
    nodeFilter: SubscriptionNodeFilter;
    nameTemplate: string | null;
    routingMode: SubscriptionRoutingMode;
    extraRules: string[];
  } => {
    const filter: SubscriptionNodeFilter = {};
    if (protocols.length) filter.protocols = protocols;
    const q = num(minQuality);
    if (q !== undefined) filter.minQuality = q;
    const l = num(maxLatency);
    if (l !== undefined) filter.maxLatencyMs = l;
    const n = num(maxNodes);
    if (n !== undefined) filter.maxNodes = n;
    const hosts = excludeHosts.split(/[,\s]+/).map((h) => h.trim()).filter(Boolean);
    if (hosts.length) filter.excludeHosts = hosts;

    return {
      nodeFilter: filter,
      nameTemplate: template.trim() || null,
      routingMode: mode,
      extraRules: rules.split('\n').map((r) => r.trim()).filter(Boolean),
    };
  };

  // 依赖用序列化后的字符串：逐个列出 8 个变量既啰嗦又容易漏，
  // 而漏一个的表现是"改了参数预览不更新"，很难注意到。
  const sig = JSON.stringify([
    mode, protocols, minQuality, maxLatency, maxNodes, excludeHosts, template, rules,
  ]);

  const seq = useRef(0);
  useEffect(() => {
    const id = setTimeout(() => {
      const mine = ++seq.current;
      setPreview((p) => ({ ...p, loading: true, error: null }));
      const body = buildBody();
      void api
        .previewSubscription({ poolId: sub.poolId, ...body })
        .then((r) => {
          // 乱序响应保护：慢的那次不能覆盖新结果
          if (mine !== seq.current) return;
          setPreview({
            matched: r.matched,
            byProtocol: r.byProtocol,
            sampleNames: r.sampleNames,
            loading: false,
            error: null,
          });
        })
        .catch((e: unknown) => {
          if (mine !== seq.current) return;
          setPreview({
            matched: 0, byProtocol: {}, sampleNames: [], loading: false,
            error: e instanceof ApiError ? e.message : String(e),
          });
        });
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await api.updateSubscription(sub.id, buildBody());
      setSaved(true);
      setTimeout(onSaved, 700);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  const toggleProtocol = (p: ProxyProtocol): void => {
    setProtocols((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  };

  const reset = (): void => {
    setMode('global');
    setProtocols([]);
    setMinQuality('');
    setMaxLatency('');
    setMaxNodes('');
    setExcludeHosts('');
    setTemplate('');
    setRules('');
  };

  const empty = !preview.loading && !preview.error && preview.matched === 0;

  return (
    <Drawer
      open
      onClose={onClose}
      title={t('Routing & filtering')}
      sub={`${sub.name} · ${sub.poolKey}`}
      foot={
        <>
          <button className="btn primary sm" disabled={busy || saved || empty} onClick={save}>
            {saved ? t('Saved') : busy ? t('Saving…') : t('Save')}
          </button>
          <button className="btn ghost sm" onClick={reset} disabled={busy}>
            {t('Reset')}
          </button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
            {t('Cancel')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        {/* ── 分流模式 ── */}
        <label className="field">
          <span className="field-label">{t('Routing mode')}</span>
          <div className="seg fixed" style={{ width: 'fit-content' }}>
            {ROUTING_MODES.map((m) => (
              <button
                key={m.value}
                className={mode === m.value ? 'on' : ''}
                onClick={() => setMode(m.value)}
                title={t(m.hint)}
              >
                {t(m.label)}
              </button>
            ))}
          </div>
          <span className="field-hint">{t(ROUTING_MODES.find((m) => m.value === mode)?.hint ?? '')}</span>
        </label>

        {/* ── 协议 ── */}
        <div className="field">
          <span className="field-label">{t('Protocols')}</span>
          <div className="seg" style={{ flexWrap: 'wrap', width: 'fit-content' }}>
            {ALL_PROTOCOLS.map((p) => (
              <button
                key={p}
                className={protocols.includes(p) ? 'on' : ''}
                onClick={() => toggleProtocol(p)}
              >
                {PROTOCOL_LABEL[p]}
              </button>
            ))}
          </div>
          <span className="field-hint">
            {protocols.length === 0
              ? t('None selected means all protocols')
              : t('Only the selected protocols are published')}
          </span>
        </div>

        {/* ── 数值条件 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <label className="field">
            <span className="field-label">{t('Min quality')}</span>
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              placeholder="0"
              value={minQuality}
              onChange={(e) => setMinQuality(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('Max latency')}</span>
            <input
              className="input"
              type="number"
              min={0}
              placeholder="ms"
              value={maxLatency}
              onChange={(e) => setMaxLatency(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('Max nodes')}</span>
            <input
              className="input"
              type="number"
              min={1}
              max={200}
              placeholder="200"
              value={maxNodes}
              onChange={(e) => setMaxNodes(e.target.value)}
            />
          </label>
        </div>
        <span className="field-hint" style={{ marginTop: -6 }}>
          {t('Max latency drops nodes that have never been probed — "unknown" is not "fast".')}
        </span>

        <label className="field">
          <span className="field-label">{t('Exclude hosts')}</span>
          <input
            className="input"
            placeholder="amazonaws, digitalocean"
            value={excludeHosts}
            onChange={(e) => setExcludeHosts(e.target.value)}
          />
          <span className="field-hint">{t('Substring match, comma separated')}</span>
        </label>

        {/* ── 命名 ── */}
        <label className="field">
          <span className="field-label">{t('Name template')}</span>
          <input
            className="input"
            placeholder="{pool}-{protocol}-{index}"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
          <span className="field-hint">
            {t('Placeholders: {index} {protocol} {host} {port} {pool}. Duplicates get a suffix.')}
          </span>
        </label>

        {/* ── 追加规则 ── */}
        <label className="field">
          <span className="field-label">{t('Append rules')}</span>
          <textarea
            className="textarea"
            rows={4}
            placeholder={'DOMAIN-SUFFIX,example.com,DIRECT\nIP-CIDR,203.0.113.0/24,REJECT'}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
          />
          <span className="field-hint">
            {t(
              'One rule per line, mihomo syntax. They run before the built-in rules. Any action other than DIRECT / REJECT means "go through this pool".',
            )}
          </span>
        </label>

        {/* ── 预览 ── */}
        <div className="field">
          <span className="field-label">
            {t('Preview')}
            <span className="num" style={{ marginLeft: 6, color: preview.loading ? 'var(--text-3)' : 'var(--text)' }}>
              {preview.loading ? '…' : preview.matched}
            </span>
            <span style={{ marginLeft: 4, color: 'var(--text-3)', fontWeight: 400 }}>
              {t('nodes')}
            </span>
          </span>
          {preview.error ? (
            <div className="form-error">{preview.error}</div>
          ) : (
            <div className="kv-note">
              <div>
                <span>{t('By protocol')}</span>
                <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {Object.entries(preview.byProtocol).length === 0 ? (
                    <span className="mono">—</span>
                  ) : (
                    Object.entries(preview.byProtocol).map(([p, n]) => (
                      <span className="chip" key={p}>
                        {p} {n}
                      </span>
                    ))
                  )}
                </span>
              </div>
              <div>
                <span>{t('Sample names')}</span>
                <span className="mono" style={{ fontSize: 10.5, textAlign: 'right', overflowWrap: 'anywhere' }}>
                  {preview.sampleNames.slice(0, 4).join(' · ') || '—'}
                </span>
              </div>
            </div>
          )}
          {empty && (
            <div className="warn-note">
              {t('No node matches this filter. Loosen the conditions before saving.')}
            </div>
          )}
        </div>

        {err && <div className="form-error">{err}</div>}

        <div className="info-note">
          {t(
            'The token stays the same, so clients do not need to be re-imported. Revision bumps automatically because the rendered content changed.',
          )}
        </div>
      </div>
    </Drawer>
  );
}

/** 空串表示"不限" —— 不能当成 0，否则 minQuality=0 和"没填"会混成同一个意思 */
function num(v: string): number | undefined {
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: number | undefined): string {
  return v === undefined ? '' : String(v);
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
