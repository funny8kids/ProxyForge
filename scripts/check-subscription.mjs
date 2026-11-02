/**
 * 端到端验收：把订阅真实导出，再逐节点用 curl 走 HTTPS 实测。
 *
 * 这是唯一能回答"发出去的节点到底能不能用"的方法 —— 库里的
 * `connect_ok`、`quality_score` 都只是我们自己探测的结论，
 * 只有拿订阅文件本身去连，才等价于用户的真实体验。
 *
 * 用法：node scripts/check-subscription.mjs [订阅ID]
 * 不传订阅 ID 时取第一个 clash 格式的订阅。
 */
import { execFile } from 'node:child_process';
import { devNull } from 'node:os';

const BASE = process.env.PF_API_BASE ?? 'http://127.0.0.1:8081/api/v1';
const CONCURRENCY = 16;

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'proxyforge' }),
  });
  const j = await r.json();
  if (!j.accessToken) throw new Error('登录失败');
  return j.accessToken;
}

function parseNodes(yaml) {
  const out = [];
  const lines = yaml.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const name = /^\s*-\s*name:\s*(\S+)/.exec(line);
    if (name) { cur = { name: name[1] }; continue; }
    if (!cur) continue;
    const type = /^\s+type:\s*(\S+)/.exec(line);
    if (type) { cur.type = type[1]; continue; }
    const server = /^\s+server:\s*(\S+)/.exec(line);
    if (server) { cur.host = server[1]; continue; }
    const port = /^\s+port:\s*(\d+)/.exec(line);
    if (port) { cur.port = Number(port[1]); out.push(cur); cur = null; }
  }
  return out.filter((n) => n.host && n.port);
}

function tryProxy(host, port) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      // 两个坑，都踩过：
      //   1. `--noproxy ""` 不能省。本机环境里常有 http_proxy / no_proxy，
      //      curl 会把请求串到那个代理上，于是所有节点都返回 000 ——
      //      实测就是这样得出"0/92 可用"的假结论，而单独测一个节点立刻 204。
      //   2. 丢弃 body 必须用 `os.devNull`（Windows 上是 NUL），
      //      写死 `/dev/null` 会让 Windows 版 curl 以退出码 23（写 body 失败）
      //      结束 —— 而 http_code 其实已经拿到了，白白被判成不可用。
      ['-sS', '-o', devNull, '-w', '%{http_code}', '-m', '10', '--noproxy', '',
        '--proxy', `http://${host}:${port}`, 'https://www.gstatic.com/generate_204'],
      (err, stdout) => {
        const code = String(stdout).trim();
        // 以 curl 实际打印的状态码为准，退出码只用来兜底
        resolve(/^\d{3}$/.test(code) ? code : '000');
      },
    );
  });
}

async function main() {
  const token = await login();
  let subId = process.argv[2];
  if (!subId) {
    const list = await (await fetch(`${BASE}/subscriptions`, { headers: { authorization: `Bearer ${token}` } })).json();
    const sub = (list.items ?? []).find((s) => s.format === 'clash-provider' || s.format === 'clash');
    if (!sub) throw new Error('没有 clash 格式的订阅');
    subId = sub.id;
  }

  const res = await fetch(`${BASE}/subscriptions/${subId}/export?format=clash`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const yaml = await res.text();
  const nodes = parseNodes(yaml);
  console.log(`订阅 ${subId.slice(0, 8)} → 解析出 ${nodes.length} 个节点`);

  const results = new Array(nodes.length).fill(false);
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < nodes.length) {
        const idx = i++;
        const n = nodes[idx];
        const code = await tryProxy(n.host, n.port);
        results[idx] = code === '204' || code === '200';
      }
    }),
  );

  const ok = results.filter(Boolean).length;
  console.log(`总可用 ${ok} / ${nodes.length}（${((ok / Math.max(nodes.length, 1)) * 100).toFixed(0)}%）`);
  for (const [a, b] of [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100], [100, 200]]) {
    if (a >= results.length) break;
    const s = results.slice(a, Math.min(b, results.length));
    console.log(`  位置 ${String(a).padStart(3)}-${String(Math.min(b, results.length)).padStart(3)}: ${s.filter(Boolean).length}/${s.length}`);
  }
  const firstBad = results.findIndex((x) => !x);
  console.log(`第一个不可用节点位置: ${firstBad === -1 ? '无' : firstBad}`);
}

main().catch((e) => {
  console.error('验收失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
