import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Prefs } from '../components/Prefs';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

/** 产品不变量。这里写的是真的会被服务端强制执行的约束，不是营销词。 */
const FACTS = [
  'One policy = one listen port. Members are frozen at compile time — the data plane never calls back.',
  'PUBLIC_PROXY is isolated to a dedicated listener and can never receive a gateway grant.',
  'Subscriptions are signed with Ed25519 over JCS-canonical JSON, never over the YAML byte stream.',
  'AI can only write a suggestion. Approving it requires a different human reviewer.',
];

export function Login({ onDone }: { onDone: () => void }): JSX.Element {
  const { t } = useI18n();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('proxyforge');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-prefs">
        <Prefs />
      </div>

      <div className="login-grid">
        <aside className="login-aside">
          <div className="brand">
            <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 2.6 20.5 7v10L12 21.4 3.5 17V7z"
                style={{ fill: 'none', stroke: 'var(--violet)', strokeWidth: 1.5 }}
              />
              <path
                d="M12 7.2 16.6 9.6v4.8L12 16.8 7.4 14.4V9.6z"
                style={{
                  fill: 'color-mix(in srgb, var(--violet) 22%, transparent)',
                  stroke: 'var(--violet)',
                  strokeWidth: 1.1,
                }}
              />
            </svg>
            <div>
              <div className="brand-name">ProxyForge</div>
              <div className="brand-sub">{t('Network Resource Control Plane')}</div>
            </div>
          </div>

          <p className="login-lede">
            {t('A control plane for proxy endpoints: inventory, trust tiers, pools, and a compiler that freezes each policy into a gateway config.')}
          </p>

          <ul className="login-facts">
            {FACTS.map((f) => (
              <li key={f}>{t(f)}</li>
            ))}
          </ul>
        </aside>

        <form onSubmit={submit} className="panel login-card">
          <div className="login-card-head">
            <div className="p-name">{t('Sign in')}</div>
            <div className="p-sub">{t('Session token is kept in this browser only')}</div>
          </div>

          <div className="login-fields">
            <label className="field">
              <span className="metric-label">{t('Username')}</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                spellCheck={false}
                className="input"
              />
            </label>
            <label className="field">
              <span className="metric-label">{t('Password')}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="input"
              />
            </label>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="btn primary login-submit" disabled={busy}>
            {busy ? t('Loading') : t('Sign in')}
            <Icon name="arrow" size={14} />
          </button>

          <div className="login-hint">
            {t('Demo')}: <span className="mono">admin / proxyforge</span>
          </div>
        </form>
      </div>
    </div>
  );
}
