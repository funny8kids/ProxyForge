import { exec, q } from '../../db/client.js';

/**
 * 来源质量评分与自动降权。
 *
 * 分数怎么算：
 *   · 存活率（HEALTHY / DEGRADED / VERIFIED 占比）权重最高 —— 它直接决定
 *     订阅里有多少节点是能用的
 *   · 平均 quality_score 次之，它包含延迟与成功率的历史
 *   · 上次同步失败一次性扣 25 分：内容都拿不到的源，节点质量再高也没意义
 *
 * 为什么存活率要算上 VERIFIED：VERIFIED 是"探通过一次、还差一次连续成功"。
 * 只算 HEALTHY/DEGRADED 的话，一个源在导入后的头一两个小时里必然是 0% 存活
 * （因为还没有任何节点走完两次确认），于是**每一个新源**都会立刻被降权 ——
 * 那不是质量信号，是系统还没跑完。VERIFIED 已经是"至少通过了一次真实探测"，
 * 拿来判断"这个列表还新不新"完全够用。
 *
 * 为什么平均质量只对存活的端点取：死节点质量分是 0，混进来等于
 * **把"死亡"算了两次** —— 一次在存活率里，一次在平均分里。
 * 实测后果是一个 44% 存活的源被判 37 分并降权：它的死亡比例已经
 * 在存活率那一项体现过了，平均分该回答的是另一个问题 ——
 * "活下来的那些质量怎么样"。两项分开，才能区分"这个列表死得多"
 * 和"这个列表活着的也很慢"，而这两件事该有不同的处理方式。
 *
 * 为什么用"连续两次低分"才降权：公开代理列表的失效是成批的，
 * 一次抓取赶上对方在换 IP，整批都会失活。单次低分就降权会让来源
 * 在好/坏之间反复横跳，而每一次横跳都会触发池重算与配置下发。
 *
 * 三条硬约束：
 *   1. AUTHORIZED 的来源永不自动停用 —— 授权是人做的判断，系统只能建议
 *   2. 样本不足（< MIN_SAMPLE）不调分，保持上一次的值
 *   3. 停用必须写明原因和时间，不能变成一个"不知道为什么关掉的源"
 *
 * 一条软约束：信任级是**双向**的。降到 55 分以下就扣，回到 75 分以上就还，
 * 但只还到中性值（50），不往上加分 —— 超过中性等于替人做背书。
 */

const MIN_SAMPLE = 8;
/** 低于这个分数进入"低分"计数 */
const LOW_SCORE = 40;
/** 连续两次低分才停用 */
const DISABLE_AFTER_STREAK = 2;
/** 低于这个分数降 trust_level */
const DOWNWEIGHT_SCORE = 55;
const TRUST_STEP = 5;
const TRUST_FLOOR = 10;
/** 恢复上限：建库默认信任级。超过它等于给源加分，那是人的判断 */
const NEUTRAL_TRUST = 50;
/** 恢复到这个分数以上，且已被停用超过 6 小时，自动重新启用 */
const RECOVER_SCORE = 75;
const RECOVER_AFTER_MS = 6 * 3600 * 1000;

export interface QualityOutcome {
  sourceId: string;
  key: string;
  score: number | null;
  sampleSize: number;
  action: 'none' | 'downweighted' | 'trust-restored' | 'disabled' | 're-enabled' | 'skipped';
  detail: string;
}

interface SourceRow {
  id: string;
  key: string;
  enabled: boolean;
  trust_level: number;
  authorization_status: string;
  last_sync_status: string;
  quality_score: string | null;
  quality_low_streak: number;
  auto_disabled_at: string | null;
}

/**
 * 重算全部来源的质量分。
 *
 * 返回逐条结果而不是只返回计数：自动降权是个会改变系统行为的动作，
 * 调用方（worker 日志 / 手动触发接口）需要知道**具体动了谁**。
 */
export async function recomputeSourceQuality(): Promise<QualityOutcome[]> {
  const sources = await q<SourceRow>(
    `SELECT id, key, enabled, trust_level, authorization_status, last_sync_status,
            quality_score::text, quality_low_streak, auto_disabled_at
     FROM resource_sources
     WHERE type <> 'MANUAL'`,
  );

  const out: QualityOutcome[] = [];

  for (const s of sources) {
    // 样本只算**已经探测过**的端点。
    //
    // 早期版本直接对全部端点取 alive 比例，结果是新导入的源在第一轮探测
    // 跑完之前就被判"存活 0/200（0%）"并降权 —— 那不是证据，是还没开始。
    // 一个源刚导入就有几十个端点是常态（免费列表一次几千条），
    // 用未探测的端点稀释存活率会让所有新源一开始就挨一刀。
    //
    // 换成 INNER JOIN 之后，未探测的端点自然不计入样本，
    // 于是"样本不足不调分"这条约束会在正确的地方生效。
    const stats = await q<{
      total: string; alive: string; avg_quality: string | null;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (
                WHERE e.lifecycle_status IN ('HEALTHY','DEGRADED','VERIFIED')
              )::text AS alive,
              avg(e.quality_score) FILTER (
                WHERE e.lifecycle_status IN ('HEALTHY','DEGRADED','VERIFIED')
              )::text AS avg_quality
       FROM endpoint_sources es
       JOIN proxy_endpoints e ON e.id = es.endpoint_id AND e.deleted_at IS NULL
       JOIN endpoint_health_state hs ON hs.endpoint_id = e.id
       WHERE es.source_id = $1 AND hs.last_check_at IS NOT NULL`,
      [s.id],
    );

    const total = Number(stats[0]?.total ?? 0);
    const alive = Number(stats[0]?.alive ?? 0);
    const avgQuality = stats[0]?.avg_quality === null || stats[0]?.avg_quality === undefined
      ? null
      : Number(stats[0].avg_quality);

    // 样本不足：不调分。此时算出来的"100 分"其实只基于 1 个节点。
    if (total < MIN_SAMPLE) {
      await exec(
        `UPDATE resource_sources SET quality_sample_size = $2, quality_computed_at = now()
         WHERE id = $1`,
        [s.id, total],
      );
      out.push({
        sourceId: s.id, key: s.key, score: s.quality_score ? Number(s.quality_score) : null,
        sampleSize: total, action: 'skipped',
        detail: `样本不足（${total} < ${MIN_SAMPLE}），保持原分数`,
      });
      continue;
    }

    const aliveRatio = alive / total;
    let score = 0.55 * (avgQuality ?? 0) + 0.45 * (aliveRatio * 100);
    if (s.last_sync_status === 'FAILED') score -= 25;
    score = Math.max(0, Math.min(100, Math.round(score * 100) / 100));
    const lowStreak = score < LOW_SCORE ? s.quality_low_streak + 1 : 0;
    const authorized = s.authorization_status === 'AUTHORIZED';

    let action: QualityOutcome['action'] = 'none';
    let detail = `存活 ${alive}/${total}（${(aliveRatio * 100).toFixed(0)}%），平均质量 ${(avgQuality ?? 0).toFixed(0)}`;

    // ── 自动停用 ──
    if (
      lowStreak >= DISABLE_AFTER_STREAK &&
      s.enabled &&
      !authorized
    ) {
      await exec(
        `UPDATE resource_sources
         SET enabled = false, auto_disabled_at = now(), auto_disable_reason = $2
         WHERE id = $1`,
        [s.id, `连续 ${lowStreak} 次质量分低于 ${LOW_SCORE}（当前 ${score}）：${detail}`],
      );
      action = 'disabled';
      detail += ` → 已自动停用（连续 ${lowStreak} 次低分）`;
    }
    // ── 自动重新启用 ──
    else if (
      !s.enabled &&
      s.auto_disabled_at !== null &&
      score >= RECOVER_SCORE &&
      Date.now() - new Date(s.auto_disabled_at).getTime() > RECOVER_AFTER_MS
    ) {
      await exec(
        `UPDATE resource_sources
         SET enabled = true, auto_disabled_at = NULL, auto_disable_reason = NULL
         WHERE id = $1`,
        [s.id],
      );
      action = 're-enabled';
      detail += ` → 已自动恢复（分数回到 ${score}）`;
    }
    // ── 降权 ──
    else if (score < DOWNWEIGHT_SCORE && !authorized && s.trust_level > TRUST_FLOOR) {
      const next = Math.max(TRUST_FLOOR, s.trust_level - TRUST_STEP);
      await exec(`UPDATE resource_sources SET trust_level = $2 WHERE id = $1`, [s.id, next]);
      action = 'downweighted';
      detail += ` → 信任级 ${s.trust_level} → ${next}`;
    }
    // ── 恢复信任级 ──
    // 没有这条时 trust_level 是单向阀：降下去就再也回不来。
    // 一次误判（比如源临时改格式、或者我们自己的取样口径错了）会变成永久惩罚，
    // 而"信任级"本来表达的是"这个源最近的表现"，不该是历史最低点。
    //
    // 上限是 NEUTRAL_TRUST（建库默认值），不往上恢复：
    // 超过中性值等于给这个源加分，那是人的判断，不是统计能得出的结论。
    else if (score >= RECOVER_SCORE && s.trust_level < NEUTRAL_TRUST) {
      const next = Math.min(NEUTRAL_TRUST, s.trust_level + TRUST_STEP);
      await exec(`UPDATE resource_sources SET trust_level = $2 WHERE id = $1`, [s.id, next]);
      action = 'trust-restored';
      detail += ` → 信任级 ${s.trust_level} → ${next}`;
    }
    // ── AUTHORIZED 但质量差：只记录，不动它 ──
    else if (score < DOWNWEIGHT_SCORE && authorized) {
      detail += ' → 已授权来源，仅记录不降权（需要人工决定）';
    }

    await exec(
      `UPDATE resource_sources
       SET quality_score = $2, quality_sample_size = $3, quality_computed_at = now(),
           quality_low_streak = $4
       WHERE id = $1`,
      [s.id, score, total, lowStreak],
    );

    out.push({ sourceId: s.id, key: s.key, score, sampleSize: total, action, detail });
  }

  return out;
}
