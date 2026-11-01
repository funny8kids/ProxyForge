import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';

/**
 * 语言与主题开关。
 *
 * 顶栏和登录页共用同一份实现。原来只有顶栏有这两个开关，于是登录页
 * 对中文用户是「只能看英文」的：还没登录就换不了语言，而这恰恰是第一屏。
 */
export function Prefs(): JSX.Element {
  const { lang, theme, setLang, setTheme } = useI18n();

  return (
    <div className="prefs">
      <div className="seg" role="group" aria-label="Language">
        <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>
          EN
        </button>
        <button className={lang === 'zh' ? 'on' : ''} onClick={() => setLang('zh')}>
          中
        </button>
      </div>
      <button
        className="icon-btn"
        aria-label="Toggle theme"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>
    </div>
  );
}
