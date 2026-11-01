import { useCallback, useEffect, useState } from 'react';
import { Icon, IconSprite } from './components/Icon';
import { Prefs } from './components/Prefs';
import { CommandPalette } from './components/CommandPalette';
import { Badge } from './components/ui';
import { I18nProvider, useI18n } from './lib/i18n';
import { api, auth } from './lib/api';
import { Login } from './screens/Login';
import { Overview } from './screens/Overview';
import { Resources } from './screens/Resources';
import { Pools } from './screens/Pools';
import { Gateway } from './screens/Gateway';
import { Trust } from './screens/Trust';
import { Subscriptions } from './screens/Subscriptions';
import { AiProviders } from './screens/AiProviders';
import { Audit } from './screens/Audit';
import { Topology } from './screens/Topology';
import { Sources } from './screens/Sources';

interface NavDef {
  id: string;
  label: string;
  icon: string;
  group: 'core' | 'control' | 'system';
}

const NAV: NavDef[] = [
  { id: 'overview', label: 'Overview', icon: 'overview', group: 'core' },
  { id: 'topology', label: 'Topology', icon: 'topology', group: 'core' },
  { id: 'resources', label: 'Resources', icon: 'resources', group: 'core' },
  { id: 'sources', label: 'Sources', icon: 'download', group: 'core' },
  { id: 'pools', label: 'Pools', icon: 'pools', group: 'control' },
  { id: 'gateway', label: 'Gateway', icon: 'gateway', group: 'control' },
  { id: 'trust', label: 'Trust', icon: 'trust', group: 'control' },
  { id: 'subscriptions', label: 'Subscriptions', icon: 'subscriptions', group: 'control' },
  { id: 'ai', label: 'AI Providers', icon: 'ai', group: 'system' },
  { id: 'audit', label: 'Audit', icon: 'verification', group: 'system' },
];

const SCREENS: Record<string, () => JSX.Element> = {
  overview: Overview,
  topology: Topology,
  resources: Resources,
  sources: Sources,
  pools: Pools,
  gateway: Gateway,
  trust: Trust,
  subscriptions: Subscriptions,
  ai: AiProviders,
  audit: Audit,
};

function useHashRoute(): [string, (id: string) => void] {
  const read = (): string => {
    const raw = window.location.hash.replace(/^#\/?/, '').trim();
    return raw && raw in SCREENS ? raw : 'overview';
  };
  const [route, setRoute] = useState<string>(read);

  useEffect(() => {
    const onHash = (): void => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((id: string) => {
    window.location.hash = `#/${id}`;
  }, []);

  return [route, go];
}

function Shell(): JSX.Element {
  const { t, lang } = useI18n();
  const [route, go] = useHashRoute();
  const [user, setUser] = useState<{ username: string; role: string } | null>(null);
  const [authed, setAuthed] = useState(auth.isAuthed);
  const [probeMode, setProbeMode] = useState<string>('');
  // worker 报错数。后台任务失败不会让任何页面变红，所以必须显式暴露，
  // 否则「池成员一直是 0」这种问题只能靠翻日志发现。
  const [workerErrors, setWorkerErrors] = useState(0);
  const [palette, setPalette] = useState(false);

  // ⌘K / Ctrl+K 打开命令面板。注册在 document 上而不是输入框上：
  // 面板关着的时候没有输入框可挂，而快捷键必须随时可用。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!authed) return;
    api
      .me()
      .then((u) => setUser({ username: u.username, role: u.role }))
      .catch(() => {
        auth.set(null);
        setAuthed(false);
      });
    api
      .systemStatus()
      .then((s) => {
        setProbeMode(s.probeMode);
        setWorkerErrors(s.worker?.errors ?? 0);
      })
      .catch(() => setProbeMode(''));
  }, [authed]);

  if (!authed) {
    // 雪碧图必须挂在登录页外面：它原来只在登录后的分支里渲染，
    // 于是登录页所有 <Icon> 的 <use href="#i-..."> 都指向不存在的 symbol，
    // 静默渲染成空白——主题开关变成一个空方块，登录按钮上没有箭头。
    return (
      <>
        <IconSprite />
        <Login onDone={() => setAuthed(true)} />
      </>
    );
  }

  const Screen = SCREENS[route] ?? Overview;
  const current = NAV.find((n) => n.id === route);
  const groups: Array<{ key: NavDef['group']; label: string }> = [
    { key: 'core', label: '' },
    { key: 'control', label: t('Control') },
    { key: 'system', label: t('System') },
  ];

  return (
    <div className="app">
      <IconSprite />

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 2.6 20.5 7v10L12 21.4 3.5 17V7z"
                style={{ fill: 'none', stroke: 'var(--violet)', strokeWidth: 1.5 }}
              />
              <path
                d="M12 7.2 16.6 9.6v4.8L12 16.8 7.4 14.4V9.6z"
                style={{ fill: 'color-mix(in srgb, var(--violet) 22%, transparent)', stroke: 'var(--violet)', strokeWidth: 1.1 }}
              />
            </svg>
          </div>
          <div>
            <div className="brand-name">ProxyForge</div>
            <div className="brand-sub">{t('Network Resource Control Plane')}</div>
          </div>
        </div>

        <nav className="nav">
          {groups.map((g) => {
            const items = NAV.filter((n) => n.group === g.key);
            if (items.length === 0) return null;
            return (
              <div key={g.key} className="nav-group">
                {g.label && <div className="sect-label">{g.label}</div>}
                {items.map((item) => (
                  <button
                    key={item.id}
                    className={`nav-item${route === item.id ? ' active' : ''}`}
                    aria-current={route === item.id ? 'page' : undefined}
                    onClick={() => go(item.id)}
                  >
                    <Icon name={item.icon} size={16} />
                    <span>{t(item.label)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          {probeMode === 'fixture' && (
            <div className="note" style={{ marginBottom: 8 }}>
              <Badge tone="warn">{t('Fixture data')}</Badge>
            </div>
          )}
          {workerErrors > 0 && (
            <div className="note" style={{ marginBottom: 8 }} title={t('Check the API log for the full stack')}>
              <Badge tone="bad">{`${t('Worker errors')} ${workerErrors}`}</Badge>
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minWidth: 0,
            }}
          >
            <div className="avatar">{user?.username?.slice(0, 1).toUpperCase() ?? 'A'}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{user?.username ?? '—'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{user?.role ?? ''}</div>
            </div>
            <button
              className="icon-btn"
              title={t('Sign out')}
              aria-label={t('Sign out')}
              onClick={() => {
                auth.set(null);
                setAuthed(false);
              }}
            >
              <Icon name="arrow" size={15} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumb">
            <span style={{ color: 'var(--text-3)' }}>ProxyForge</span>
            <span style={{ color: 'var(--text-4)' }}>/</span>
            <span style={{ color: 'var(--text)' }}>{t(current?.label ?? 'Overview')}</span>
          </div>

          <div className="head-actions">
            <button className="search" onClick={() => setPalette(true)} aria-label={t('Search')}>
              <Icon name="search" size={14} />
              <span>{t('Search')}…</span>
              <span className="kbd">⌘K</span>
            </button>

            <Prefs />
          </div>
        </header>

        <main className="content">
          <Screen />
        </main>
      </div>

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onPick={go}
        items={NAV.map((n) => ({
          id: n.id,
          label: n.label,
          icon: n.icon,
          group: n.group === 'core' ? t('Core') : n.group === 'control' ? t('Control') : t('System'),
        }))}
      />
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}
