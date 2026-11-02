/**
 * 来源质量评分与自动降权回归测试。
 *
 * 跑在内存库（`DATABASE_URL=memory://`），不碰 .data/pg。
 *
 * 这个模块的危险之处在于它**会自动改变系统行为**：停掉一个来源，
 * 那个来源贡献的节点就会在下一轮池重算里消失，进而改变订阅内容。
 * 所以断言的重点不是"分数算对了"，而是三条护栏：
 *
 *   · 样本不足不许调分 —— 否则 1 个节点的源会因为"100% 存活"拿到 100 分
 *   · AUTHORIZED 永不自动停用 —— 授权是人做的判断，系统只能建议
 *   · 连续两次低分才动手 —— 单次低分就停用会让来源在好/坏之间反复横跳，
 *     每一次横跳都触发池重算与配置下发
 *
 * 跑法：npm run test:quality
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// 必须在 import 数据库客户端**之前**落到 env 上：config 是模块加载时求值的，
// 而 ESM 的 import 会被提升到语句之前。所以这里设 env、用动态 import。
// 也顺便解决跨平台问题 —— `VAR=value cmd` 这种前缀在 Windows 的 cmd.exe 下不成立。
process.env.DATABASE_URL ??= 'memory://';

const { closeDb, exec, getDb, q1 } = await import('../apps/api/src/db/client.js');
const { migrate } = await import('../apps/api/src/db/migrate.js');
const { recomputeSourceQuality } = await import('../apps/api/src/modules/source/quality.js');
type QualityOutcome = import('../apps/api/src/modules/source/quality.js').QualityOutcome;

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${(err as Error).message.split('\n').join('\n    ')}`);
  }
}

await getDb();
await migrate();

/** 建一个来源。默认是"公开列表"那种：UNKNOWN 授权、trust 40、启用中。 */
async function mkSource(opts: {
  key: string;
  trust?: number;
  auth?: 'AUTHORIZED' | 'UNKNOWN';
  enabled?: boolean;
  lastSync?: 'NEVER' | 'OK' | 'FAILED';
}): Promise<string> {
  const id = randomUUID();
  await exec(
    `INSERT INTO resource_sources
       (id, key, name, type, url, format_hint, authorization_status, trust_level, enabled, last_sync_status)
     VALUES ($1,$2,$2,'GITHUB_REPO',$3,'text',$4,$5,$6,$7)`,
    [
      id, opts.key, `https://example.invalid/${opts.key}.txt`,
      opts.auth ?? 'UNKNOWN', opts.trust ?? 40, opts.enabled ?? true, opts.lastSync ?? 'OK',
    ],
  );
  return id;
}

/**
 * 给来源挂 n 个节点。
 * `alive` 指 HEALTHY/DEGRADED 的数量，其余记为 UNAVAILABLE —— 这两个状态
 * 的划分直接决定存活率，是评分里权重最高的一项。
 *
 * 必须同时写 endpoint_health_state.last_check_at：评分只统计**探测过**的端点。
 * 没探过的端点不算样本，否则一个刚导入的源会在第一轮探测跑完之前
 * 就被判"存活 0%"，那不是质量信号，是还没开始。
 */
async function mkNodes(
  sourceId: string,
  opts: { n: number; alive: number; quality: number },
): Promise<void> {
  for (let i = 0; i < opts.n; i += 1) {
    const id = randomUUID();
    await exec(
      `INSERT INTO proxy_endpoints
         (id, source_id, protocol, host, port, origin_type, lifecycle_status, quality_score, dedupe_key)
       VALUES ($1,$2,'SOCKS5',$3,$4,'PUBLIC_PROXY',$5,$6,$7)`,
      [
        id, sourceId, `10.${Math.floor(i / 250)}.${i % 250}.1`, 1080 + i,
        i < opts.alive ? 'HEALTHY' : 'UNAVAILABLE', opts.quality, `dk-${id}`,
      ],
    );
    await exec(`INSERT INTO endpoint_sources (endpoint_id, source_id) VALUES ($1,$2)`, [id, sourceId]);
    await exec(
      `INSERT INTO endpoint_health_state (endpoint_id, last_check_at, quality_score)
       VALUES ($1, now(), $2) ON CONFLICT DO NOTHING`,
      [id, opts.quality],
    );
  }
}

function pick(rows: QualityOutcome[], key: string): QualityOutcome {
  const row = rows.find((r) => r.key === key);
  assert.ok(row, `结果里应该有 ${key}`);
  return row;
}

async function sourceRow(id: string): Promise<{
  enabled: boolean; trust_level: number; quality_score: string | null;
  quality_low_streak: number; auto_disabled_at: string | null; auto_disable_reason: string | null;
  quality_sample_size: number;
}> {
  const row = await q1<{
    enabled: boolean; trust_level: number; quality_score: string | null;
    quality_low_streak: number; auto_disabled_at: string | null; auto_disable_reason: string | null;
    quality_sample_size: number;
  }>(
    `SELECT enabled, trust_level, quality_score::text, quality_low_streak,
            auto_disabled_at, auto_disable_reason, quality_sample_size
     FROM resource_sources WHERE id = $1`,
    [id],
  );
  assert.ok(row);
  return row;
}

console.log('\n[1] 样本不足不调分');

const tiny = await mkSource({ key: 'tiny' });
await mkNodes(tiny, { n: 7, alive: 7, quality: 100 });

await check('7 个节点（< MIN_SAMPLE 8）→ skipped，分数保持 null', async () => {
  const rows = await recomputeSourceQuality();
  const r = pick(rows, 'tiny');
  assert.equal(r.action, 'skipped');
  assert.equal(r.sampleSize, 7);
  assert.equal(r.score, null);
  const row = await sourceRow(tiny);
  assert.equal(row.quality_score, null, '不该因为样本不足就写一个假的分数');
  assert.equal(row.quality_sample_size, 7, '样本数仍要落库，界面要显示"样本不足"');
});

console.log('\n[2] 健康来源');

const good = await mkSource({ key: 'good' });
await mkNodes(good, { n: 8, alive: 8, quality: 90 });

await check('8 个全 HEALTHY、质量 90 → 94.5 分，信任级从 40 恢复到 45', async () => {
  const r = pick(await recomputeSourceQuality(), 'good');
  // 信任级是双向的：低于 55 扣 5，高于 75 还 5。
  // 没有"还"这一半的话，一次误判（或我们自己的取样口径出错）
  // 会变成永久惩罚 —— 而 trust_level 表达的应该是"最近的表现"。
  assert.equal(r.action, 'trust-restored');
  // 0.55 * 90 + 0.45 * 100
  assert.equal(r.score, 94.5);
  const row = await sourceRow(good);
  assert.equal(row.quality_score, '94.50');
  assert.equal(row.trust_level, 45);
});

await check('信任级恢复到中性值（50）就停，不继续往上加分', async () => {
  // 一次恢复 5 点：40 → 45（上一条）→ 50（这条）
  assert.equal(pick(await recomputeSourceQuality(), 'good').action, 'trust-restored');
  assert.equal((await sourceRow(good)).trust_level, 50, '50 是建库默认值');

  // 到 50 之后不再动它 —— 超过中性值等于替人做背书
  const r = pick(await recomputeSourceQuality(), 'good');
  assert.equal(r.action, 'none');
  assert.equal((await sourceRow(good)).trust_level, 50);
});

console.log('\n[3] 低分降权');

const bad = await mkSource({ key: 'bad', trust: 40 });
await mkNodes(bad, { n: 8, alive: 2, quality: 20 });

await check('存活 2/8、质量 20 → 22.25 分，信任级 40 → 35', async () => {
  const r = pick(await recomputeSourceQuality(), 'bad');
  assert.equal(r.score, 22.25);
  assert.equal(r.action, 'downweighted');
  const row = await sourceRow(bad);
  assert.equal(row.trust_level, 35);
  assert.equal(row.enabled, true, '第一次低分只降权，不停用');
  assert.equal(row.quality_low_streak, 1);
});

console.log('\n[4] 连续低分才停用');

await check('第二次低分 → 自动停用并写明原因', async () => {
  const r = pick(await recomputeSourceQuality(), 'bad');
  assert.equal(r.action, 'disabled');
  const row = await sourceRow(bad);
  assert.equal(row.enabled, false);
  assert.ok(row.auto_disabled_at, '停用必须记录时间');
  assert.match(row.auto_disable_reason ?? '', /连续 2 次/, '停用必须写明原因');
  assert.equal(row.quality_low_streak, 2);
});

await check('已停用后再跑 → 不会重复写停用时间', async () => {
  const before = (await sourceRow(bad)).auto_disabled_at;
  const r = pick(await recomputeSourceQuality(), 'bad');
  // enabled 已经是 false，条件里的 s.enabled 不满足 → 落到"仅记录"
  assert.notEqual(r.action, 'disabled');
  // timestamptz 取回来是 Date 对象，assert.equal 比的是引用，必须比时间戳
  assert.equal(
    new Date((await sourceRow(bad)).auto_disabled_at!).getTime(),
    new Date(before!).getTime(),
    '停用时间不该被反复刷新 —— 那会让"停用了多久"失去意义',
  );
});

console.log('\n[5] AUTHORIZED 豁免');

const authorized = await mkSource({ key: 'authorized-bad', auth: 'AUTHORIZED', trust: 80 });
await mkNodes(authorized, { n: 8, alive: 0, quality: 5 });

await check('授权来源再差也只记录，不降权不停用', async () => {
  await recomputeSourceQuality();
  const second = pick(await recomputeSourceQuality(), 'authorized-bad');
  assert.equal(second.action, 'none');
  assert.match(second.detail, /已授权来源/, '要说明"需要人工决定"');
  const row = await sourceRow(authorized);
  assert.equal(row.enabled, true);
  assert.equal(row.trust_level, 80, '信任级不能被系统动');
  assert.ok(row.quality_low_streak >= 2, '低分仍要计数，供人看');
});

console.log('\n[6] 自动恢复');

await check('分数回到 75 以上且停用超 6 小时 → 自动重新启用', async () => {
  // 把停用时间推到 7 小时前，并把节点全部修好
  await exec(
    `UPDATE resource_sources SET auto_disabled_at = now() - interval '7 hours' WHERE id = $1`,
    [bad],
  );
  await exec(
    `UPDATE proxy_endpoints SET lifecycle_status = 'HEALTHY', quality_score = 95 WHERE source_id = $1`,
    [bad],
  );
  const r = pick(await recomputeSourceQuality(), 'bad');
  assert.equal(r.action, 're-enabled');
  const row = await sourceRow(bad);
  assert.equal(row.enabled, true);
  assert.equal(row.auto_disabled_at, null, '恢复后要清掉停用痕迹');
  assert.equal(row.auto_disable_reason, null);
});

await check('停用不满 6 小时 → 不恢复（防止抖动）', async () => {
  const recent = await mkSource({ key: 'recently-disabled', enabled: false });
  await mkNodes(recent, { n: 8, alive: 8, quality: 95 });
  await exec(
    `UPDATE resource_sources SET auto_disabled_at = now() - interval '1 hour' WHERE id = $1`,
    [recent],
  );
  const r = pick(await recomputeSourceQuality(), 'recently-disabled');
  assert.notEqual(r.action, 're-enabled');
  assert.equal((await sourceRow(recent)).enabled, false);
});

console.log('\n[7] 同步失败扣分');

const failing = await mkSource({ key: 'sync-failing', trust: 100, lastSync: 'FAILED' });
await mkNodes(failing, { n: 8, alive: 8, quality: 60 });

await check('全健康但上次同步失败 → 78 - 25 = 53 分，落到降权区间', async () => {
  const r = pick(await recomputeSourceQuality(), 'sync-failing');
  assert.equal(r.score, 53);
  assert.equal(r.action, 'downweighted');
  assert.equal((await sourceRow(failing)).trust_level, 95);
});

console.log('\n[8] MANUAL 来源不参与评分');

await check('MANUAL 类型来源不出现在结果里', async () => {
  const manual = randomUUID();
  await exec(
    `INSERT INTO resource_sources (id, key, name, type, authorization_status, trust_level)
     VALUES ($1,'manual-test','Manual','MANUAL','AUTHORIZED',70)`,
    [manual],
  );
  const rows = await recomputeSourceQuality();
  assert.ok(!rows.some((r) => r.key === 'manual-test'), '手工录入的节点没有"来源质量"可言');
});

await closeDb();
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
