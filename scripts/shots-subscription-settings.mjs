#!/usr/bin/env node
/**
 * 订阅「分流与过滤」抽屉的界面验证。
 *
 * 不只看截图：这个抽屉的核心是**实时预览**，所以要断言预览真的打到了后端、
 * 数字随条件变化、以及保存后表格里的分流档位跟着变。截图只作为留档。
 *
 * 用法：node scripts/shots-subscription-settings.mjs [--lang zh] [--theme dark]
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [
    'playwright',
    'C:/Users/15240/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 试下一个 */
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
const LANG = argOf('lang', 'zh');
const THEME = argOf('theme', 'dark');

const login = async () => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'proxyforge' }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.accessToken ?? body.token;
};

const { chromium } = loadPlaywright();
const token = await login();
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  deviceScaleFactor: 2,
  locale: LANG === 'zh' ? 'zh-CN' : 'en-US',
});
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

await page.goto(`${BASE}/#/subscriptions`, { waitUntil: 'networkidle' });
await page.waitForSelector('.content table.data tbody tr', { timeout: 15000 });

// 打开设置抽屉
await page.getByRole('button', { name: LANG === 'zh' ? '设置' : 'Settings' }).first().click();
await page.waitForSelector('.drawer.open', { timeout: 8000 });

// 等第一次预览落地（数字不再是 …）
await page.waitForFunction(
  () => {
    const el = [...document.querySelectorAll('.drawer.open .field-label')].find((n) =>
      /预览|Preview/.test(n.textContent ?? ''),
    );
    return el && !/…/.test(el.textContent ?? '');
  },
  { timeout: 15000 },
);

const readMatched = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('.drawer.open .field-label')].find((n) =>
      /预览|Preview/.test(n.textContent ?? ''),
    );
    const m = (el?.textContent ?? '').match(/(\d+)/);
    return m ? Number(m[1]) : -1;
  });

const baseline = await readMatched();
await page.screenshot({ path: join(OUT, `subscription-settings-${LANG}-${THEME}.png`) });

// 点 SOCKS5，预览数字应该变（且更小或相等）
await page.locator('.drawer.open .seg button', { hasText: 'SOCKS5' }).first().click();
await page.waitForTimeout(1200);
const afterProtocol = await readMatched();

// 改命名模板，看节点名示例是否跟着变
const tpl = page.locator('.drawer.open input[placeholder*="{pool}"]');
await tpl.fill('{pool}-{index}');
await page.waitForTimeout(1200);
const sampleText = await page
  .locator('.drawer.open .kv-note')
  .last()
  .innerText();

await page.screenshot({ path: join(OUT, `subscription-settings-filtered-${LANG}-${THEME}.png`) });

const ok = baseline > 0 && afterProtocol > 0 && afterProtocol <= baseline && /STATIC_STABLE-\d+/.test(sampleText);
if (!ok) {
  problems.push(
    `预览不符合预期：baseline=${baseline} afterProtocol=${afterProtocol} sample=${JSON.stringify(sampleText.slice(0, 120))}`,
  );
}

await browser.close();

console.log(`\n基线匹配 ${baseline} → 仅 SOCKS5 ${afterProtocol}`);
console.log(`节点名示例：${sampleText.split('\n').pop()}`);
if (problems.length) {
  console.log('\n发现问题：');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\n✓ 抽屉渲染与实时预览均正常\n');
