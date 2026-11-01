/**
 * 图标雪碧图（复用原型 23 个 24px symbol，路径逐字保留）。
 * 用 <use href="#id"> 引用，避免每个图标重复内联路径。
 */
const SPRITE = `<defs><symbol id="i-overview" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="8.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="5" rx="2"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="2"/><rect x="3" y="15" width="7.5" height="6" rx="2"/></symbol><symbol id="i-topology" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="6" r="2.4"/><circle cx="18.5" cy="6" r="2.4"/><circle cx="12" cy="18.5" r="2.4"/><path d="M7.9 6h8.2M6.7 8.1 10.8 16.4M17.3 8.1 13.2 16.4"/></symbol><symbol id="i-resources" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="18" height="7" rx="2.2"/><rect x="3" y="13.5" width="18" height="7" rx="2.2"/><path d="M7 7h.01M7 17h.01"/></symbol><symbol id="i-verification" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 4.7 5.6v5.8c0 4.4 3 8.2 7.3 9.7 4.3-1.5 7.3-5.3 7.3-9.7V5.6L12 2.8Z"/><path d="m8.8 11.9 2.2 2.2 4.2-4.4"/></symbol><symbol id="i-pools" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 8.6 4.4L12 11.8 3.4 7.4 12 3Z"/><path d="m3.4 12 8.6 4.4 8.6-4.4"/><path d="m3.4 16.6 8.6 4.4 8.6-4.4"/></symbol><symbol id="i-trust" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 4.7 5.6v5.8c0 4.4 3 8.2 7.3 9.7 4.3-1.5 7.3-5.3 7.3-9.7V5.6L12 2.8Z"/><path d="M12 8.4v4.2"/><circle cx="12" cy="15.6" r=".95" fill="currentColor" stroke="none"/></symbol><symbol id="i-subscriptions" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.2a8.8 8.8 0 0 1 8.8 8.8"/><path d="M4 4.4A15.6 15.6 0 0 1 19.6 20"/><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/></symbol><symbol id="i-gateway" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="8" width="19" height="8" rx="2.4"/><path d="M6.6 12h.01M10.2 12h.01"/><path d="M17.6 12h.01"/></symbol><symbol id="i-ai" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.4 3.4 13 8.9l5.5 1.6-5.5 1.6-1.6 5.5-1.6-5.5L4.3 10.5 9.8 8.9l1.6-5.5Z"/><path d="m18.6 3.2.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z"/></symbol><symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.3"/><path d="m15.7 15.7 4 4"/></symbol><symbol id="i-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2a4.8 4.8 0 0 1 4.8 4.8c0 3.9 1.5 5.3 1.5 5.3H5.7s1.5-1.4 1.5-5.3A4.8 4.8 0 0 1 12 3.2Z"/><path d="M10 16.6a2 2 0 0 0 4 0"/></symbol><symbol id="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4.1"/><path d="M12 2.6v2.2M12 19.2v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6"/></symbol><symbol id="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.3 14.6A8.6 8.6 0 0 1 9.4 3.7a8.6 8.6 0 1 0 10.9 10.9Z"/></symbol><symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></symbol><symbol id="i-download" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v11"/><path d="m7.6 10.4 4.4 4.4 4.4-4.4"/><path d="M4 19.5h16"/></symbol><symbol id="i-play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 4.8 19 12 7.5 19.2V4.8Z"/></symbol><symbol id="i-command" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8.6 3.5a2.6 2.6 0 0 1 2.6 2.6v11.8a2.6 2.6 0 1 1-2.6-2.6h6.8a2.6 2.6 0 1 1-2.6 2.6V6.1a2.6 2.6 0 1 1 2.6 2.6H8.6a2.6 2.6 0 1 1 0-5.2Z"/></symbol><symbol id="i-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="m13 6.5 5.5 5.5L13 17.5"/></symbol><symbol id="i-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3.8v4.6h-4.6"/></symbol><symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m4.8 12.6 4.6 4.6L19.4 7"/></symbol><!-- ── 供应商标识：抽象字形，不使用第三方商标 ───────────── --><symbol id="i-pv-deepseek" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 14.6c2.6-5.6 5.2-6.4 6.6-1.2 1.2 4.4 3.4 5.6 5.6 2.4"/><path d="M15.4 15.8c2.4-3.4 4-3.6 5.4-1.4"/><circle cx="7.6" cy="9.2" r=".9" fill="currentColor" stroke="none"/></symbol><symbol id="i-pv-openrouter" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h5.4"/><path d="M8.4 12 12 7.2h6.2"/><path d="M8.4 12 12 16.8h6.2"/><path d="m15.6 4.8 2.6 2.4-2.6 2.4"/><path d="m15.6 14.4 2.6 2.4-2.6 2.4"/></symbol><symbol id="i-pv-ollama" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.6 19.6 6.8v8.4L12 19.4 4.4 15.2V6.8L12 2.6Z"/><path d="M12 8.2v6"/><path d="M9.2 9.8h5.6"/></symbol></defs>`;

/**
 * 雪碧图容器必须是 <svg>，不能是 <div style="display:none">。
 *
 * 用 div 承载时，浏览器按 HTML 规则解析里面的 <defs>/<symbol>，它们会变成
 * HTMLUnknownElement 而不是 SVG 元素，于是所有 <use href="#..."> 静默渲染为空白——
 * 不报错、不告警，只是图标不见了。宽度设 0 且脱离文档流，不影响布局。
 */
export function IconSprite(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="0"
      height="0"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      dangerouslySetInnerHTML={{ __html: SPRITE }}
    />
  );
}

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      aria-hidden="true"
      style={{ flex: '0 0 auto' }}
    >
      <use href={`#i-${name}`} />
    </svg>
  );
}
