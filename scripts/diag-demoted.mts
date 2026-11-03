/**
 * 降级复核：把**刚刚被降级**的端点用线上同一条探测链重探一遍。
 *
 * 存在的理由：批次规模一放大，HEALTHY 就开始单调下滑（1013 → 915 / 12 分钟）。
 * 两种解释都说得通，但结论完全相反：
 *
 *   (a) 复探终于跑起来了，抓到的都是真的已经死掉的节点 —— 那 HEALTHY 下滑
 *       是**把虚高的数字纠正到真值**，该继续跑
 *   (b) 落库时间随批次线性增长（122 个 → 1.7s，1063 个 → 14.7s），
 *       单线程 PGlite 把事件循环占满，探测超时被误杀 —— 那是**我们自己
 *       制造假失败**，必须把批次压回去
 *
 * 这个项目之前已经踩过一次 (b)：TCP_TIMEOUT 设 1 秒时，30 个记为 TCP_TIMEOUT
 * 的节点重测有 28 个当场成功。所以这里不能靠"看起来像"下结论。
 *
 * 判定方法：停机（事件循环空闲）后重探刚被降级的那批。若大量成功 → (b)。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/diag-demoted.mts [状态] [样本数] [分钟内]
 */
import { closeDb, q } from '../apps/api/src/db/client.js';
import { probe } from '../apps/api/src/modules/verification/probe.js';
import type { ProxyProtocol } from '@proxyforge/contracts';

const status = process.argv[2] ?? 'DEGRADED';
const limit = Number(process.argv[3] ?? 40);
const withinMinutes = Number(process.argv[4] ?? 20);

interface Row {
  host: string;
  port: number;
  protocol: ProxyProtocol;
  last_check_at: Date | string;
}

const rows = await q<Row>(
  `SELECT e.host, e.port, e.protocol::text AS protocol, hs.last_check_at
   FROM proxy_endpoints e
   JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
   WHERE e.lifecycle_status = $1::lifecycle_status
     AND e.deleted_at IS NULL
     AND hs.last_check_at > now() - ($3 || ' minutes')::interval
   ORDER BY hs.last_check_at DESC
   LIMIT $2`,
  [status, limit, String(withinMinutes)],
);

if (rows.length === 0) {
  console.log(`最近 ${withinMinutes} 分钟内没有被判 ${status} 的端点。`);
  await closeDb();
  process.exit(0);
}

const ageMin = rows.map(
  (r) => (Date.now() - new Date(r.last_check_at).getTime()) / 60000,
);
console.log(
  `复核 ${rows.length} 个最近 ${withinMinutes} 分钟内被判 ${status} 的端点` +
    `（判决距今 ${ageMin[0]!.toFixed(0)}–${ageMin[ageMin.length - 1]!.toFixed(0)} 分钟）\n`,
);

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
console.log(
  `\n重探结果：存活 ${alive}/${rows.length}（${pct(alive)}），` +
    `能建隧道 ${tunnel}/${rows.length}（${pct(tunnel)}）`,
);

if (reasons.size > 0) {
  console.log('\n失败原因分布：');
  for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
}

// 阈值：真死的话存活率应该是个位数（免费代理本身只有 10–27% 存活，
// 被降级的更是最差的一批）。超过 30% 就说明降级判定站不住脚。
const rate = alive / rows.length;
console.log(
  rate >= 0.3
    ? `\n结论：判决有误。${pct(alive)} 的"已降级"节点在空闲条件下仍然存活 ——\n` +
      '      这是探测被事件循环阻塞造成的假失败，批次规模必须压回去。'
    : `\n结论：判决成立。${pct(alive)} 的存活率与"免费代理本来就在死"一致，\n` +
      '      HEALTHY 下滑是把虚高数字纠正到真值，不是误杀。',
);

await closeDb();
process.exit(0);
