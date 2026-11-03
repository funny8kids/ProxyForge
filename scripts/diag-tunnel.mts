/**
 * 隧道复核：把**已判定"建不起隧道"**的 HEALTHY 端点重探一遍。
 *
 * 存在的理由：订阅的可用节点数被 `connect_ok IS TRUE` 卡死在 227 个，
 * 而 HEALTHY 有 1,125 个 —— 也就是 80% 的健康节点被判"能转发明文 HTTP、
 * 但开不了 CONNECT 隧道"，于是被 `excludeTunnelIncapable` 剔出订阅。
 *
 * 这个 20% 有两种解释，结论完全相反：
 *
 *   (a) 免费代理真的就是这样 —— 大量节点只放行 80 端口、或对 443 返回 403。
 *       那 227 就是真值，只能靠换源来提升。
 *   (b) `connect_ok=false` 是**我们自己压出来的假失败** —— 主探测成功后
 *       紧接着在同一条事件循环里做 CONNECT + 完整 TLS 握手（要求证书链对
 *       www.gstatic.com 有效），96 路并发下 TLS 握手互相抢 CPU 与 NAT 表，
 *       超时被判 false。那 227 是测量伪影，真实可用数可能翻倍。
 *
 * 这个项目已经三次栽在 (b) 这类"指标伪装成现实"上（TCP_TIMEOUT=1s、
 * 落库线性增长误杀降级、批次放大导致 PROTOCOL_ERROR），所以必须实测。
 *
 * 判定方法：停机（事件循环空闲）后以并发 8 重探。并发压到 8 的理由与
 * diag-demoted 相同 —— 这是复核已有判决，不是压测；用会制造误判的条件
 * 去检验另一个疑似误判，等于什么都没证明。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/diag-tunnel.mts [每协议样本数]
 *
 * 只读，不写库。
 */
import { closeDb, q } from '../apps/api/src/db/client.js';
import { probe } from '../apps/api/src/modules/verification/probe.js';
import type { ProxyProtocol } from '@proxyforge/contracts';

const perProtocol = Number(process.argv[2] ?? 25);

interface Row {
  id: string;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  protocol_bucket: string;
}

/**
 * 按协议分层抽样。
 *
 * 不能简单地 `ORDER BY random() LIMIT N` 混着取：SOCKS4 占 HEALTHY 的 20%
 * 但隧道率只有 2.2%，混抽会让样本被它主导，算出来的总复核率毫无意义。
 * 分协议各取一批，才能分别回答"哪一类是被误杀的"。
 */
const rows = await q<Row>(
  `SELECT e.id, e.host, e.port,
          e.protocol::text AS protocol, e.protocol::text AS protocol_bucket
   FROM proxy_endpoints e
   JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
   WHERE e.lifecycle_status = 'HEALTHY'
     AND e.deleted_at IS NULL
     AND hs.connect_ok IS FALSE
   ORDER BY random()`,
  [],
);

// 上面拿到的是全量候选，下面按协议截取。
const byProtocol = new Map<string, Row[]>();
for (const r of rows) {
  const list = byProtocol.get(r.protocol_bucket) ?? [];
  if (list.length < perProtocol) list.push(r);
  byProtocol.set(r.protocol_bucket, list);
}
const sample = [...byProtocol.values()].flat();

if (sample.length === 0) {
  console.log('没有 connect_ok=false 的 HEALTHY 端点，无需复核。');
  await closeDb();
  process.exit(0);
}

console.log(
  `复核 ${sample.length} 个被判"建不起隧道"的 HEALTHY 端点：` +
    [...byProtocol.entries()].map(([k, v]) => `${k} ${v.length}`).join(' · ') +
    '\n',
);

let alive = 0;
let tunnel = 0;
const reasons = new Map<string, number>();
const perBucket = new Map<string, { n: number; alive: number; tunnel: number }>();

const CONCURRENCY = 8;
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, sample.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= sample.length) return;
      const r = sample[i]!;
      const res = await probe({
        host: r.host, port: r.port, protocol: r.protocol,
        username: null, password: null,
      });
      const bucket = perBucket.get(r.protocol_bucket) ?? { n: 0, alive: 0, tunnel: 0 };
      bucket.n += 1;
      if (res.success) {
        alive += 1;
        bucket.alive += 1;
        if (res.connectOk === true) {
          tunnel += 1;
          bucket.tunnel += 1;
        }
      } else {
        const k = res.failureReason ?? 'UNKNOWN';
        reasons.set(k, (reasons.get(k) ?? 0) + 1);
      }
      perBucket.set(r.protocol_bucket, bucket);
    }
  }),
);

const pct = (n: number, d: number): string => `${((n / d) * 100).toFixed(0)}%`;

console.log(`重探结果：存活 ${alive}/${sample.length}（${pct(alive, sample.length)}），` +
  `能建隧道 ${tunnel}/${sample.length}（${pct(tunnel, sample.length)}）`);

console.log('\n分协议：');
for (const [k, v] of [...perBucket.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    `  ${k.padEnd(16)} 样本 ${String(v.n).padStart(3)} · ` +
      `存活 ${String(v.alive).padStart(3)}（${pct(v.alive, v.n)}） · ` +
      `隧道 ${String(v.tunnel).padStart(3)}（${pct(v.tunnel, v.n)}）`,
  );
}

if (reasons.size > 0) {
  console.log('\n失败原因分布：');
  for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
}

const rate = tunnel / sample.length;
console.log(
  rate >= 0.3
    ? `\n结论：判决有误。空闲条件下 ${pct(tunnel, sample.length)} 的"隧道不可用"节点其实能建隧道 ——\n` +
      '      connect_ok=false 是并发压出来的假失败，必须复核（降并发或重试一次）。'
    : `\n结论：判决成立。空闲条件下仍只有 ${pct(tunnel, sample.length)} 能建隧道，\n` +
      '      说明这批节点确实只放行明文 HTTP，227 是真值。',
);

await closeDb();
process.exit(0);
