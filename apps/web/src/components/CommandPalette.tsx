import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';

export interface PaletteItem {
  id: string;
  label: string;
  icon: string;
  group: string;
}

/**
 * 命令面板（⌘K）。
 *
 * 存在的理由不是「有个搜索框更好看」：顶栏原来放的是一个没人接管的
 * <input>，能打字但什么也不发生 —— 这种「看起来能用、其实没用」的控件
 * 比没有控件更糟。要么实现它，要么删掉。这里实现它。
 *
 * 只做一件事：跳到某一屏。没有假的全局搜索 —— 资源检索在资源页里有
 * 真正的筛选条件，把两种语义混进同一个输入框只会让人猜不透搜的是哪一层。
 */
export function CommandPalette({
  open,
  items,
  onPick,
  onClose,
}: {
  open: boolean;
  items: PaletteItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    // 同时匹配英文键与当前语言的显示名。只比英文键的话，中文界面里
    // 输入「资源」会得到「没有匹配的屏」—— 用户看到的字和搜索的词对不上。
    return items.filter(
      (i) =>
        t(i.label).toLowerCase().includes(needle) ||
        i.label.toLowerCase().includes(needle) ||
        i.id.includes(needle),
    );
  }, [items, q, t]);

  // 每次打开都重置：上次的查询词留着，下次按 ⌘K 会看到一份被过滤过的列表，
  // 而用户以为自己什么都没输。
  useEffect(() => {
    if (!open) return;
    setQ('');
    setCursor(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [q]);

  if (!open) return null;

  const commit = (id: string): void => {
    onPick(id);
    onClose();
  };

  return (
    <div
      className="cmdk open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk-box">
        <div className="cmdk-input">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('Jump to a screen…')}
            aria-label={t('Search')}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const hit = results[cursor];
                if (hit) commit(hit.id);
              }
            }}
          />
        </div>

        <div className="cmdk-list" role="listbox">
          {results.map((item, i) => (
            <div
              className={`cmdk-item${i === cursor ? ' on' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(item.id);
              }}
              role="option"
              aria-selected={i === cursor}
              key={item.id}
            >
              <Icon name={item.icon} size={15} />
              <span>{t(item.label)}</span>
              <span className="g">{t(item.group)}</span>
            </div>
          ))}
          {results.length === 0 && (
            <div className="cmdk-item" style={{ cursor: 'default', color: 'var(--text-4)' }}>
              {t('No matching screen')}
            </div>
          )}
        </div>

        <div className="cmdk-foot">
          <span>
            <kbd>↑↓</kbd>
            {t('Navigate')}
          </span>
          <span>
            <kbd>↵</kbd>
            {t('Open')}
          </span>
          <span>
            <kbd>esc</kbd>
            {t('Close')}
          </span>
        </div>
      </div>
    </div>
  );
}
