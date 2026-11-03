import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { countryLabel, countryName, extent, regionOf, REGION_LABEL } from '../lib/format';

// ─────────────────────────────────────────────────────────────
// 面板
// ─────────────────────────────────────────────────────────────

export function Panel({
  title,
  sub,
  right,
  children,
  fill,
  rule,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  fill?: boolean;
  rule?: boolean;
}): JSX.Element {
  return (
    <section className={`panel${fill ? ' fill' : ''}`}>
      {(title || right) && (
        <header className={`panel-head${rule ? ' with-rule' : ''}`}>
          <div style={{ minWidth: 0 }}>
            {title && <div className="p-name">{title}</div>}
            {sub && <div className="p-sub">{sub}</div>}
          </div>
          {right && <div className="right">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// 指标
// ─────────────────────────────────────────────────────────────

export function Metric({
  label,
  value,
  unit,
  foot,
  spark,
  tone,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  foot?: ReactNode;
  spark?: number[];
  tone?: 'cyan' | 'violet' | 'warn';
}): JSX.Element {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {value}
        {unit && <span className="unit"> {unit}</span>}
      </div>
      {foot && <div className="metric-foot">{foot}</div>}
      {spark && spark.length > 1 && <Sparkline values={spark} tone={tone} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 迷你曲线：preserveAspectRatio=none 会拉伸描边，故用 non-scaling-stroke 固定 1.3px
// ─────────────────────────────────────────────────────────────

export function Sparkline({
  values,
  tone = 'cyan',
  height = 26,
}: {
  values: number[];
  tone?: 'cyan' | 'violet' | 'warn';
  height?: number;
}): JSX.Element {
  const [lo, hi] = extent(values);
  const d = values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * 100;
      const y = 100 - ((v - lo) / (hi - lo)) * 100;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const stroke = tone === 'violet' ? 'var(--violet)' : tone === 'warn' ? 'var(--warn)' : 'var(--cyan)';

  return (
    <svg className="metric-spark" viewBox="0 0 100 40" preserveAspectRatio="none" style={{ height }}>
      <path d={d} style={{ stroke, fill: 'none', strokeWidth: 1.3, vectorEffect: 'non-scaling-stroke' }} />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// 面积折线（带网格与刻度）
// ─────────────────────────────────────────────────────────────

export function AreaChart({
  points,
  height = 190,
  tone = 'cyan',
  yFormat = (v: number) => String(Math.round(v)),
  xLabels,
}: {
  points: number[];
  height?: number;
  tone?: 'cyan' | 'violet' | 'warn';
  yFormat?: (v: number) => string;
  xLabels?: string[];
}): JSX.Element {
  const [lo, hi] = extent(points);

  // 纵向映射：把数据带拉伸到 viewBox 的 8..92，上下各留 8% 呼吸位。
  // 不用「对数值域加 12% padding」的写法——那样最大值只落在 29% 高度处，
  // 曲线被压成中间一条，纵向空间浪费一半。
  const flat = hi - lo < 1e-9;
  const yOf = (v: number): number => (flat ? 50 : 92 - ((v - lo) / (hi - lo)) * 84);

  const line = points
    .map((v, i) => {
      const x = (i / Math.max(points.length - 1, 1)) * 100;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${yOf(v).toFixed(2)}`;
    })
    .join(' ');

  // 面积收到刻度基线（y=92）而不是画布底部（y=100）：
  // 否则填充会溢出到最下方刻度线以下，出现一条没有刻度的色带。
  const area = `${line} L100,92 L0,92 Z`;
  const stroke = tone === 'violet' ? 'var(--violet)' : tone === 'warn' ? 'var(--warn)' : 'var(--cyan)';

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        {/* 纵轴刻度独立成列，而不是把 min/max 摆到横轴下方——
            后者会被读成「左小右大」的趋势，是错误信息。 */}
        <div
          style={{
            width: 32,
            flex: 'none',
            height,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            fontSize: 10,
            lineHeight: 1,
            color: 'var(--text-4)',
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
            paddingTop: height * 0.08 - 5,
            paddingBottom: height * 0.08 - 5,
          }}
        >
          <span>{yFormat(hi)}</span>
          <span>{yFormat((hi + lo) / 2)}</span>
          <span>{yFormat(lo)}</span>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{ width: '100%', height, display: 'block' }}
          >
            {[8, 29, 50, 71, 92].map((y) => (
              <line
                key={y}
                x1="0"
                x2="100"
                y1={y}
                y2={y}
                style={{ stroke: 'var(--ov-2)', strokeWidth: 1, vectorEffect: 'non-scaling-stroke' }}
              />
            ))}
            <path d={area} style={{ fill: `color-mix(in srgb, ${stroke} 14%, transparent)` }} />
            <path
              d={line}
              style={{ fill: 'none', stroke, strokeWidth: 1.6, vectorEffect: 'non-scaling-stroke' }}
            />
          </svg>
          {xLabels && xLabels.length > 0 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10,
                color: 'var(--text-4)',
                marginTop: 6,
              }}
            >
              <span>{xLabels[0]}</span>
              <span>{xLabels[xLabels.length - 1]}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 徽章
// ─────────────────────────────────────────────────────────────

// 设计令牌里的 pill 变体名与语义名不一致（品牌色叫 brand、灰阶叫 neutral）。
// 这里做一层映射，避免调用方到处记忆 CSS 类名。
const PILL_CLASS: Record<string, string> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  info: 'info',
  violet: 'brand',
  cyan: 'info', // tierTone 里 VERIFIED_PROXY 用语义名 cyan，落到 info 变体
  muted: 'neutral',
};

export function Badge({
  tone = 'muted',
  children,
  dot,
}: {
  tone?: 'ok' | 'warn' | 'bad' | 'info' | 'cyan' | 'violet' | 'muted';
  children: ReactNode;
  dot?: boolean;
}): JSX.Element {
  return (
    <span className={`pill ${PILL_CLASS[tone] ?? 'neutral'}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// 国家/地区徽章
// ─────────────────────────────────────────────────────────────

/**
 * 出口地区徽章。
 *
 * 纯文字列表读不出分布：300 个节点里"北美 240 / 欧洲 40 / 亚洲 20"
 * 和"三洲各 100"在表格里长得一模一样，只有滚动到底才发现某一洲根本是空的。
 * 加一个按大洲着色的色点，扫一眼就能看出这个池子的出口偏向。
 *
 * 颜色只用来说明"属于哪一洲"，不带好坏含义 —— 所以没有用 success/danger
 * 那套语义色，避免让人误以为"红色地区的节点质量差"。
 *
 * 没有出口国家时显示 `—` 而不是隐藏：那一列空着会让人以为是渲染 bug，
 * 而 `—` 配 tooltip 说明"尚未探测出出口 IP"，是一个可解释的状态。
 */
export function CountryBadge({
  code,
  showName = false,
}: {
  code: string | null | undefined;
  showName?: boolean;
}): JSX.Element {
  if (!code) {
    return (
      <span className="country-badge is-unknown" title="尚未探测出出口 IP（需要至少一次成功探测）">
        —
      </span>
    );
  }
  const region = regionOf(code);
  const name = countryName(code);
  return (
    <span className={`country-badge r-${region}`} title={`${name} · ${REGION_LABEL[region] ?? '其他'}`}>
      <i className="country-dot" aria-hidden />
      {showName ? name : countryLabel(code)}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// 抽屉：优先于 Modal（设计系统 §5）
// ─────────────────────────────────────────────────────────────

export function Drawer({
  open,
  onClose,
  title,
  sub,
  foot,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/*
        这两个类名必须带上 `open`。
        CSS 里 .scrim 默认 opacity:0 + pointer-events:none，.drawer 默认
        translateX(100%)，靠 .open 才浮上来。组件只写了基础类，于是
        「点资源行 → 详情抽屉」这条动线实际是：抽屉被渲染在屏幕右侧之外，
        遮罩透明且不接收点击 —— 点下去什么都不发生，也不报错。
      */}
      <div className={`scrim${open ? ' open' : ''}`} onClick={onClose} />
      <aside
        className={`drawer${open ? ' open' : ''}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
      >
        <header className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="p-name">{title}</div>
            {sub && <div className="p-sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            {/* 抽屉从右侧滑出，用左箭头表示「退回去」。
                原来指向右，和「关闭」的语义正好相反。 */}
            <Icon name="arrow" size={16} className="flip-x" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {foot && <footer className="drawer-foot">{foot}</footer>}
      </aside>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 空态 / 进度条 / 键值
// ─────────────────────────────────────────────────────────────

/**
 * 空态。
 *
 * 之前只是一行居中的灰字，和「加载失败」「还没请求」长得一样。
 * 给一个静默的图标容器，让「这里本来就没有东西」和「这里出问题了」
 * 在视觉上分开 —— 空态不该看起来像错误。
 */
export function Empty({ text, icon = 'resources' }: { text: string; icon?: string }): JSX.Element {
  return (
    <div className="empty">
      <span className="empty-ico">
        <Icon name={icon} size={18} />
      </span>
      <span>{text}</span>
    </div>
  );
}

export function Progress({ value, tone }: { value: number; tone?: string }): JSX.Element {
  const color =
    tone === 'ok'
      ? 'var(--success)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'bad'
          ? 'var(--danger)'
          : 'var(--cyan)';
  return (
    <div className="prog" style={{ width: 64 }}>
      <i style={{ width: `${Math.max(2, Math.min(100, value))}%`, background: color }} />
    </div>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }): JSX.Element {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }): JSX.Element {
  // `data-skeleton` 是给截图回归用的钩子。
  // 之前 shots.mjs 的「渲染就绪」判据只看面板高度 > 120px，
  // 而骨架屏本身就超过 120px —— 于是「数据还没到」和「数据为空」都算通过，
  // 截出来的图是四个 0 加五条灰条，断言全绿。判据必须能区分这两种情况。
  return (
    <div data-skeleton="" style={{ padding: '16px 20px', display: 'grid', gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            height: 12,
            borderRadius: 4,
            background: 'var(--ov-3)',
            width: `${90 - i * 12}%`,
          }}
        />
      ))}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }): JSX.Element {
  return (
    <div
      className="note"
      style={{
        margin: '12px 20px',
        color: 'var(--danger-2)',
        background: 'var(--danger-bg)',
        padding: '10px 12px',
        borderRadius: 8,
        fontSize: 12.5,
      }}
    >
      {message}
    </div>
  );
}
