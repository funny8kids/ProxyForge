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

/**
 * 建一个来源。默认是"公开列表"那种：UNKNOWN 授权、trust 40、启用中。
 *
 * `lastYield` 决定最近一次快照解析出多少条目 —— 这是「这个源还能不能采到东西」
 * 的唯一信号，也是自动停用的前置条件。不传 = 从来没有过快照（新加的源）。
 */
async function mkSource(opts: {
  key: string;
  trust?: number;
  auth?: 'AUTHORIZED' | 'UNKNOWN';
  enabled?: boolean;
  lastSync?: 'NEVER' | 'OK' | 'FAILED';
  lastYield?: number;
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
  if (opts.lastYield !== undefined) {
    await exec(
      `INSERT INTO source_snapshots (source_id, http_status, content_hash, candidate_count)
       VALUES ($1, 200, $2, $3)`,
      [id, `hash-${id}`, opts.lastYield],
    );
  }
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

await check('8 个全 HEALTHY、质量 90 → 79.9 分，信任级从 40 恢复到 45', async () => {
  const r = pick(await recomputeSourceQuality(), 'good');
  // 信任级是双向的：低于 45 扣 5，高于 75 还 5。
  // 没有"还"这一半的话，一次误判（或我们自己的取样口径出错）
  // 会变成永久惩罚 —— 而 trust_level 表达的应该是"最近的表现"。
  assert.equal(r.action, 'trust-restored');
  // 0.55 * 90 + 0.45 * wilsonLower(8, 8)
  //
  // 存活率用的是 Wilson 下界而不是裸比例。8 个样本全活，裸比例是 100%，
  // 下界只有 67.6% —— 那正是我们想要的态度：样本少就别说满话。
  // 用裸比例时这里算出来是 94.5 分，一个只探过 8 个节点的源能拿到
  // 接近满分，而它下一轮可能就掉一半。
  assert.equal(r.score, 79.9);
  const row = await sourceRow(good);
  assert.equal(row.quality_score, '79.90');
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

// 最近一次同步抓到 0 条 —— 这个源"采不到东西"，才具备被停用的资格
const bad = await mkSource({ key: 'bad', trust: 40, lastYield: 0 });
await mkNodes(bad, { n: 8, alive: 2, quality: 20 });

await check('存活 2/8、质量 20 → 14.22 分，信任级 40 → 35', async () => {
  const r = pick(await recomputeSourceQuality(), 'bad');
  // 0.55 * 20 + 0.45 * wilsonLower(2, 8) = 11 + 0.45 * 7.15
  assert.equal(r.score, 14.22);
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

console.log('\n[4b] 公开代理的正常存活率不该被停用');

await check('存活 12%、质量 45 的源连续多轮不被停用', async () => {
  // 这是公开代理列表的典型水平：thespeedx-http 实测存活 381/3196（12%）、
  // 平均质量 45。按公式 0.55*45 + 0.45*wilsonLower(12,100)*100 ≈ 27.9 分。
  //
  // 旧阈值 30 下这种源会被判死 —— 实测启用 16 个内置源后，15 个在两轮
  // 重算内被自动停用，其中 thespeedx-http 已经贡献了 3368 个候选。
  // 把阈值调回 30 会让「多节点」的入口自己关上，所以这里钉住行为。
  const normal = await mkSource({ key: 'normal-survival', trust: 40 });
  await mkNodes(normal, { n: 100, alive: 12, quality: 45 });

  for (let i = 0; i < 3; i += 1) await recomputeSourceQuality();

  const row = await sourceRow(normal);
  assert.equal(row.enabled, true, '正常存活率的公开源不该被自动停用');
  assert.equal(row.auto_disabled_at, null);
});

await check('采不到条目的源照样会被停用（阈值下调不是放水）', async () => {
  // 反面断言：降到 20 之后，真的没救的源必须仍然被停掉。
  // proxifly / hideipme-http 实测存活 0/200 和 0/33。
  //
  // 这里必须给 `lastYield: 0`：从 2026-11 起，"零存活"本身不再是停用的理由
  // （见下一条用例），停用要求源**采不到东西**。
  const dead = await mkSource({ key: 'dead-source', trust: 40, lastYield: 0 });
  await mkNodes(dead, { n: 50, alive: 0, quality: 0 });

  await recomputeSourceQuality();
  await recomputeSourceQuality();

  const row = await sourceRow(dead);
  assert.equal(row.enabled, false, '采不到东西的源必须停用，否则白烧探测预算');
});

await check('零存活但仍在正常产出的源：只降权，绝不停用', async () => {
  // 这是实际踩到的坑。免费代理的 IP 存活期是几十分钟量级，而 HEALTHY 的
  // 复探周期是 30 分钟 —— 一个**完全正常**的源，库存里的节点也会随时间
  // 大批死亡，"库存存活率"必然衰减到 0。
  //
  // 实测：26 个源里 10 个被自动停用，其中 9 个 last_sync_status 是 OK、
  // 最近一次同步分别抓到 167–1251 条。最刺眼的是 hideipme-socks5 ——
  // 被停用时分数 19.54（存活 2/227），而同一个 URL 现拉现测 24 条抽样
  // 是 15 条存活、8 条能建隧道（33%），**它是全库最好的源**。
  //
  // 更关键的是停用根本达不到目的：停用只掐掉同步（新 IP 进不来），
  // 却不掐掉探测（enqueueDueProbes 里没有 resource_sources），
  // 于是一边继续为死库存烧预算，一边焊死了唯一能让分数回升的路径。
  const yielding = await mkSource({ key: 'zero-stock-but-yielding', trust: 40, lastYield: 640 });
  await mkNodes(yielding, { n: 200, alive: 0, quality: 0 });

  for (let i = 0; i < 4; i += 1) await recomputeSourceQuality();

  const row = await sourceRow(yielding);
  assert.equal(row.enabled, true, '能拉到 640 条/次的源不该被停用');
  assert.equal(row.auto_disabled_at, null);
  assert.equal(row.trust_level, 25, '但要被降到信任级地板 —— 它是可逆的惩罚');
  assert.ok(row.quality_low_streak >= 2, '低分仍要计数，供人看');
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

await check('全健康但上次同步失败 → 63.4 - 25 = 38.4 分，落到降权区间', async () => {
  const r = pick(await recomputeSourceQuality(), 'sync-failing');
  // 0.55 * 60 + 0.45 * wilsonLower(8, 8) = 33 + 30.4，再扣同步失败的 25
  assert.equal(r.score, 38.4);
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
