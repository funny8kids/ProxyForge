/**
 * 同步频率的依据：每个源的内容**多久才换一次**。
 *
 * 提高同步频率的收益不在「拿到更多条目」——同一批 IP 反复拉到只会推高重复率。
 * 收益在「更早拿到新出现的 IP」：免费代理存活期是几十分钟量级，一小时同步一次
 * 意味着我们拿到的是「一小时前就在列表里」的地址，探测完可能已经死了一半。
 *
 * 但盲目把所有源改成 10 分钟也没意义：内容一小时才换一次的源，多拉 5 次
 * 全是同一个 content_hash，纯属白烧 HTTP 与解析。所以频率要按**实测换血速度**定。
 *
 * 这个脚本回答两件事：
 *   1. 每个源的历史快照里，不同 content_hash 之间隔多久（换血间隔）
 *   2. 重复率 —— **必须用 `duplicateSyncs / syncAttempts` 这两个计数器算**
 *
 * 第 2 点踩过一次坑，记在这里免得再犯：早先版本用
 * `1 - distinct / snaps` 当重复率，而 `syncSource` 在 content_hash 命中时
 * 根本不写快照行，于是 `distinct / snaps` 恒等于 1、重复率恒等于 0%。
 * 那个 0% 不是测出来的，是这个指标在这套数据模型下**不可能不为 0**，
 * 却让我据此断言"列表一直在换血、我们只看到 1/6"—— 现网日志里
 * `同步 3 个源（成功 3）新增候选 0` 反复出现，直接反证了它。
 *
 * 分母必须先被记下来，比值才有意义。计数器见 migrations/0019。
 *
 * 只读 HTTP，不碰库。
 *
 * 跑法：npm run diag:cadence
 */

const BASE = process.env.PF_API_BASE ?? 'http://127.0.0.1:8081/api/v1';

interface Snapshot {
  id: string;
  fetched_at: string;
  content_hash: string;
  candidate_count: number;
  http_status: number | null;
}

interface Source {
  id: string;
  key: string;
  enabled: boolean;
  type: string;
  syncIntervalSeconds: number;
  lastSyncStatus: string;
  /** 成功取到内容的次数（重复与新内容都算）。重复率的分母 */
  syncAttempts: number;
  /** 内容未变、未写快照的次数。重复率的分子 */
  duplicateSyncs: number;
}

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'proxyforge' }),
  });
  const j = (await r.json()) as { accessToken?: string };
  if (!j.accessToken) throw new Error('登录失败');
  return j.accessToken;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function main(): Promise<void> {
  const token = await login();
  const h = { authorization: `Bearer ${token}` };

  const listRes = await fetch(`${BASE}/sources`, { headers: h });
  const list = (await listRes.json()) as { items: Source[] };
  const sources = list.items.filter((s) => s.type !== 'MANUAL' && s.enabled);

  interface Row {
    key: string;
    intervalMin: number;
    snaps: number;
    distinct: number;
    changeEveryMin: number | null;
    windowHours: number;
    dupRate: number;
    attempts: number;
    note: string;
  }
  const rows: Row[] = [];

  for (const s of sources) {
    const res = await fetch(`${BASE}/sources/${s.id}/snapshots`, { headers: h });
    if (!res.ok) {
      rows.push({
        key: s.key, intervalMin: s.syncIntervalSeconds / 60, snaps: 0, distinct: 0,
        changeEveryMin: null, windowHours: 0, dupRate: 0, attempts: s.syncAttempts,
        note: `快照接口 ${res.status}`,
      });
      continue;
    }
    const body = (await res.json()) as { items: Snapshot[] };
    // 接口按 fetched_at DESC 返回，反转成时间正序才能算间隔
    const snaps = [...body.items].sort(
      (a, b) => new Date(a.fetched_at).getTime() - new Date(b.fetched_at).getTime(),
    );

    // 相邻两次快照里 content_hash 变化的时刻 —— 那才是"换血"发生的时点
    const changes: number[] = [];
    for (let i = 1; i < snaps.length; i += 1) {
      if (snaps[i]!.content_hash !== snaps[i - 1]!.content_hash) {
        changes.push(new Date(snaps[i]!.fetched_at).getTime());
      }
    }
    const gaps: number[] = [];
    for (let i = 1; i < changes.length; i += 1) {
      gaps.push((changes[i]! - changes[i - 1]!) / 60_000);
    }

    const distinct = new Set(snaps.map((x) => x.content_hash)).size;
    const windowMin = snaps.length >= 2
      ? (new Date(snaps[snaps.length - 1]!.fetched_at).getTime()
         - new Date(snaps[0]!.fetched_at).getTime()) / 60_000
      : 0;

    rows.push({
      key: s.key,
      intervalMin: s.syncIntervalSeconds / 60,
      snaps: snaps.length,
      distinct,
      changeEveryMin: median(gaps),
      windowHours: Math.round(windowMin / 6) / 10,
      // 重复率只能来自计数器 —— `distinct / snaps` 恒等于 1，见文件头
      dupRate: s.syncAttempts > 0 ? s.duplicateSyncs / s.syncAttempts : 0,
      attempts: s.syncAttempts,
      note: s.syncAttempts === 0
        ? '计数器上线后还没同步过'
        : snaps.length < 3 ? '快照太少，换血间隔不足以下结论' : '',
    });
  }

  const p = (v: string | number, w: number): string => String(v).padEnd(w);
  console.log(
    '\n' + p('源', 24) + p('当前周期', 10) + p('尝试', 6) + p('快照', 6) + p('不同内容', 10) +
    p('重复率', 8) + p('覆盖时长', 10) + '换血间隔(中位)',
  );
  console.log('-'.repeat(104));
  rows.sort((a, b) => (a.changeEveryMin ?? 1e9) - (b.changeEveryMin ?? 1e9));
  for (const r of rows) {
    console.log(
      p(r.key, 24) + p(`${r.intervalMin}分`, 10) + p(r.attempts, 6) +
      p(r.snaps, 6) + p(r.distinct, 10) +
      p(`${(r.dupRate * 100).toFixed(0)}%`, 8) + p(`${r.windowHours}h`, 10) +
      (r.changeEveryMin === null ? '—（观察期内没换过）' : `${r.changeEveryMin.toFixed(1)} 分`) +
      (r.note ? `  [${r.note}]` : ''),
    );
  }

  const measurable = rows.filter((r) => r.changeEveryMin !== null && r.snaps >= 3);
  console.log(`\n可测源 ${measurable.length} 个 / 启用 ${rows.length} 个`);
  const fast = measurable.filter((r) => (r.changeEveryMin ?? 1e9) <= 20);
  const slow = measurable.filter((r) => (r.changeEveryMin ?? 0) > 60);
  console.log(`  换血 ≤20 分钟：${fast.length} 个 —— 提频有收益`);
  console.log(`  换血 >60 分钟：${slow.length} 个 —— 提频买不到新内容`);
  if (fast.length) console.log(`  值得提频的：${fast.map((r) => r.key).join(', ')}`);

  // 这条限制必须印出来，否则读表的人会把"换血间隔"当成真值。
  //
  // 换血间隔是**相邻两次落库快照**的时间差，而快照只在内容变化时才写 ——
  // 所以这个值被历史同步周期量化了：一个每 5 分钟变一次的源，在 15 分钟
  // 周期下测出来就是 15 分钟。**等于历史周期的那一行只说明"每次同步都变了"，
  // 是上界，不是真实间隔**。要看真值，得在提频之后再测一轮。
  const quantized = measurable.filter(
    (r) => r.changeEveryMin !== null && r.changeEveryMin <= r.intervalMin * 1.1,
  );
  if (quantized.length) {
    console.log(
      `\n注意：${quantized.map((r) => r.key).join(', ')} 的换血间隔贴近当前周期，` +
        '说明观察期内**每次同步内容都变了** —— 这个数是上界，不是真实换血间隔。',
    );
  }
}

main().catch((e) => {
  console.error('失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
