/**
 * 判决复核：把库里被判 REJECTED 的端点，用**线上同一条探测链**重探一遍。
 *
 * 存在的理由是一次无法自洽的观测：
 *   · 库里 hideipme-socks5 的 227 个端点，224 个是 REJECTED、0 个存活
 *   · 同一个 URL 现拉现抽样 12 条，8 条活着、6 条能建隧道
 *
 * 两者不可能同时正确。可能是：
 *   (a) 列表换血快，库里那批 IP 早就轮换掉了 —— 那是"库存"与"流量"的区别，
 *       指标算错了对象
 *   (b) 我们对这批特定 IP 的探测本身有问题 —— 那是探测链的 bug
 *
 * 这个脚本只回答 (a) 还是 (b)，不改任何东西。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/diag-rejected.mts [源key] [样本数]
 */
import { closeDb, q } from '../apps/api/src/db/client.js';
import { probe } from '../apps/api/src/modules/verification/probe.js';
import type { ProxyProtocol } from '@proxyforge/contracts';

const sourceKey = process.argv[2] ?? 'hideipme-socks5';
const limit = Number(process.argv[3] ?? 40);

/**
 * 凭据不在这张表上：`proxy_endpoints` 只有 `credential_ref`，明文在 `secrets`。
 * 免费公开代理列表本来就不带认证，所以这里直接按无认证探测。
 */
interface Row {
  host: string;
  port: number;
  protocol: ProxyProtocol;
  lifecycle_status: string;
  last_check_at: Date | string;
}

const rows = await q<Row>(
  `SELECT e.host, e.port, e.protocol::text AS protocol,
          e.lifecycle_status::text AS lifecycle_status, hs.last_check_at
   FROM resource_sources s
   JOIN endpoint_sources es ON es.source_id = s.id
   JOIN proxy_endpoints e ON e.id = es.endpoint_id AND e.deleted_at IS NULL
   JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
   WHERE s.key = $1 AND e.lifecycle_status = 'REJECTED' AND hs.last_check_at IS NOT NULL
   ORDER BY random()
   LIMIT $2`,
  [sourceKey, limit],
);

if (rows.length === 0) {
  console.log(`源 ${sourceKey} 没有可复核的 REJECTED 端点。`);
  await closeDb();
  process.exit(0);
}

console.log(`复核 ${sourceKey}：${rows.length} 个被判 REJECTED 的端点，用线上探测链重探\n`);

let alive = 0;
let tunnel = 0;
const reasons = new Map<string, number>();

// 并发压到 8：这是"复核已有判决"，不是压测。并发太高会重现当初
// 制造假失败的条件（本地 NAT 丢 SYN），那等于用一个已知会误判的方法
// 去检验另一个疑似误判。
const CONCURRENCY = 8;
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= rows.length) return;
      const r = rows[i]!;
      const res = await probe({
        host: r.host, port: r.port, protocol: r.protocol,
        username: null, password: null,
      });
      if (res.success) {
        alive += 1;
        if (res.connectOk === true) tunnel += 1;
      } else {
        const k = res.failureReason ?? 'UNKNOWN';
        reasons.set(k, (reasons.get(k) ?? 0) + 1);
      }
    }
  }),
);

const pct = (n: number): string => `${((n / rows.length) * 100).toFixed(0)}%`;
console.log(`\n重探结果：存活 ${alive}/${rows.length}（${pct(alive)}），能建隧道 ${tunnel}/${rows.length}（${pct(tunnel)}）`);

if (reasons.size > 0) {
  console.log('\n失败原因分布：');
  for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
}

console.log(
  alive === 0
    ? '\n结论：这批端点确实已经死了。库里判 REJECTED 是对的 —— 那么"源质量分"衡量的是\n' +
      '      「当年从该源挖出来的那批 IP 现在还活着吗」，而不是「这个源现在还能不能挖到活的」。\n' +
      '      免费代理列表的 IP 存活期是几十分钟量级，前者对任何源都必然衰减到 0。'
    : '\n结论：判决有误。这批被标 REJECTED 的端点里有相当比例仍然可用 ——\n' +
      '      问题在探测链或判决口径，不在源本身。',
);

await closeDb();
process.exit(0);
