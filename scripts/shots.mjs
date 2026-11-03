#!/usr/bin/env node
/**
 * 界面回归截图 + 内容渲染断言。
 *
 * 存在的理由：截图「看起来正常」不是证据。此前 9 屏全部截到了空白内容区，
 * 因为 .screen{display:none} 没有 .active。所以这里不只截图，还断言
 *   · .content 内至少有一个面板
 *   · 面板可见高度 > 120px
 *   · 没有 console error / pageerror
 * 任何一条不满足即非零退出。
 *
 * 用法：node scripts/shots.mjs [--url http://localhost:5173] [--out .shots]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// playwright 装在 npx 缓存里，不在本仓库 node_modules。显式回退，避免安装体积。
function loadPlaywright() {
  const candidates = [
    'playwright',
    'C:/Users/15240/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 继续尝试下一个 */
    }
  }
  throw new Error('未找到 playwright，请先执行 npx playwright install');
}

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = argOf('url', 'http://localhost:5173');
const OUT = argOf('out', '.shots');
const API = argOf('api', 'http://127.0.0.1:8081/api/v1');
// 语言与主题可指定：双语界面的漏翻问题只有把九屏全部按目标语言跑一遍才看得见，
// 逐屏手点截图既慢又容易漏。
const LANG = argOf('lang', 'en');
const THEME = argOf('theme', 'dark');

const SCREENS = [
  'overview',
  'topology',
  'resources',
  'sources',
  'pools',
  'gateway',
  'trust',
  'subscriptions',
  'ai',
  'audit',
];

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'proxyforge' }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.accessToken ?? body.token;
}

const { chromium } = loadPlaywright();

const token = await login();
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  deviceScaleFactor: 2,
  locale: 'en-US',
});

// 免去每屏走登录表单；顺便固定主题与语言，保证截图可比
await ctx.addInitScript(
  ([tok, lang, theme]) => {
    localStorage.setItem('pf-token', tok);
    localStorage.setItem('pf-lang', lang);
    localStorage.setItem('pf-theme', theme);
  },
  [token, LANG, THEME],
);

const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

const results = [];

for (const id of SCREENS) {
  await page.goto(`${BASE}/#/${id}`, { waitUntil: 'networkidle' });
  // 等数据落地：面板出现且高度稳定
  await page.waitForSelector('.content .panel, .content .empty, .content .note', { timeout: 15000 });
  // 等骨架屏消失 —— 否则截到的是「四个 0 + 五条灰条」，
  // 而高度断言照样通过（骨架屏自己就比 120px 高）。这是本脚本之前漏掉的一类假绿。
  await page
    .waitForFunction(() => document.querySelectorAll('[data-skeleton]').length === 0, { timeout: 15000 })
    .catch(() => problems.push(`${id}: 骨架屏 15s 内未消失（数据没加载出来）`));
  // 再等一轮网络空闲：同一屏往往并发取多个接口，而 PGlite 是单线程串行执行，
  // 慢的那个（sources 列表 3.4s）会把快的那个（stats 0.5s）堵在后面。
  // 只等骨架屏消失会截到「列表已出、统计卡还是 0」的半成品。
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // 固定再等一拍：PGlite 单线程下同一屏的多个接口是排队执行的，
  // networkidle 有可能在「前一个请求刚结束、后一个还没发出去」的空隙里就满足了。
  await page.waitForTimeout(1200);

  const probe = await page.evaluate(() => {
    const content = document.querySelector('.content');
    const panels = [...document.querySelectorAll('.content .panel')];
    const visible = panels
      .map((p) => p.getBoundingClientRect())
      .filter((r) => r.height > 0 && r.width > 0);
    const active = document.querySelector('.nav-item.active');
    return {
      panels: panels.length,
      visiblePanels: visible.length,
      tallest: visible.reduce((m, r) => Math.max(m, r.height), 0),
      contentHeight: content ? content.getBoundingClientRect().height : 0,
      activeNav: active ? active.textContent.trim() : null,
      docHeight: document.documentElement.scrollHeight,
    };
  });

  const ok =
    probe.panels > 0 &&
    probe.visiblePanels > 0 &&
    probe.tallest > 120 &&
    probe.activeNav !== null;

  if (!ok) problems.push(`${id}: 内容未渲染 ${JSON.stringify(probe)}`);

  await page.screenshot({ path: join(OUT, `${id}-${LANG}-${THEME}.png`), fullPage: false });
  results.push({ id, ok, ...probe });
}

// 浅色 + 中文各一张，验证主题与双语没有破版。
// 必须走真实交互（点按钮），不能改 localStorage —— addInitScript 每次导航都会重置它，
// 那样测的是「初始化脚本能不能写回 dark」，不是「主题开关能不能用」。
await page.goto(`${BASE}/#/overview`, { waitUntil: 'networkidle' });
await page.waitForSelector('.content .panel', { timeout: 15000 });

// 断言的是「开关能让主题真的翻过去」，而不是「翻过去之后一定是浅色」——
// 后者在 --theme light 启动时会把断言变成永假。
const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
await page.click('button[aria-label="Toggle theme"]');
await page.click('.seg button:has-text("中")');
await page.waitForTimeout(500);

const lightProbe = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  lang: document.documentElement.lang,
  navText: document.querySelector('.nav-item.active')?.textContent?.trim() ?? null,
  panels: document.querySelectorAll('.content .panel').length,
  // 浅色主题最容易破的地方：文字与背景色撞色，取一个面板验算对比
  bodyBg: getComputedStyle(document.body).backgroundColor,
  textColor: getComputedStyle(document.body).color,
}));
if (lightProbe.theme === themeBefore) problems.push('主题开关未生效');
if (lightProbe.panels === 0) problems.push('切换主题后内容为空');
await page.screenshot({ path: join(OUT, `overview-${lightProbe.theme}-zh.png`), fullPage: false });

await browser.close();

await writeFile(join(OUT, 'report.json'), JSON.stringify({ results, lightProbe, problems }, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('screen', 16)}${pad('panels', 8)}${pad('tallest', 9)}nav`);
console.log('─'.repeat(52));
for (const r of results) {
  console.log(
    `${pad(r.id, 16)}${pad(r.visiblePanels, 8)}${pad(Math.round(r.tallest), 9)}${r.activeNav ?? '—'}`,
  );
}
console.log('─'.repeat(52));
console.log(
  `light/zh: theme=${lightProbe.theme} lang=${lightProbe.lang} panels=${lightProbe.panels} nav=${lightProbe.navText}`,
);
console.log(`          bg=${lightProbe.bodyBg} text=${lightProbe.textColor}`);

if (problems.length) {
  console.error(`\n✗ ${problems.length} 个问题:`);
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(`\n✓ ${SCREENS.length} 屏全部渲染正常，无 console error → ${OUT}/`);
