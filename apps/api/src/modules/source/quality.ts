import { exec, q } from '../../db/client.js';

/**
 * 来源质量评分与自动降权。
 *
 * 分数怎么算：
 *   · 存活率（HEALTHY / DEGRADED 占比）权重最高 —— 它直接决定订阅里
 *     有多少节点是能用的
 *   · 平均 quality_score 次之，它包含延迟与成功率的历史
 *   · 上次同步失败一次性扣 25 分：内容都拿不到的源，节点质量再高也没意义
 *
 * 为什么用"连续两次低分"才降权：公开代理列表的失效是成批的，
 * 一次抓取赶上对方在换 IP，整批都会失活。单次低分就降权会让来源
 * 在好/坏之间反复横跳，而每一次横跳都会触发池重算与配置下发。
 *
 * 三条硬约束：
 *   1. AUTHORIZED 的来源永不自动停用 —— 授权是人做的判断，系统只能建议
 *   2. 样本不足（< MIN_SAMPLE）不调分，保持上一次的值
 *   3. 停用必须写明原因和时间，不能变成一个"不知道为什么关掉的源"
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
/** 恢复到这个分数以上，且已被停用超过 6 小时，自动重新启用 */
const RECOVER_SCORE = 75;
const RECOVER_AFTER_MS = 6 * 3600 * 1000;

export interface QualityOutcome {
  sourceId: string;
  key: string;
  score: number | null;
  sampleSize: number;
  action: 'none' | 'downweighted' | 'disabled' | 're-enabled' | 'skipped';
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
    const stats = await q<{
      total: string; alive: string; avg_quality: string | null;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE e.lifecycle_status IN ('HEALTHY','DEGRADED'))::text AS alive,
              avg(e.quality_score)::text AS avg_quality
       FROM endpoint_sources es
       JOIN proxy_endpoints e ON e.id = es.endpoint_id AND e.deleted_at IS NULL
       WHERE es.source_id = $1`,
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
