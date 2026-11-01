import type { CompileWarning } from '@proxyforge/contracts';

/**
 * 编译告警的界面文案。
 *
 * 后端返回的是「code + count + 一句人话」。那句人话是中文的，直接渲染会在
 * 英文界面里漏出中文——这是双语产品里最容易被看见的破绽。
 * 所以界面按 code 自己出文案，后端那句只作为未知 code 的兜底。
 */
const TEXT: Record<string, { en: (n: number) => string; zh: (n: number) => string }> = {
  EMPTY_POOL: {
    en: () => 'No eligible member after compile — the policy is saved but will not route traffic',
    zh: () => '编译后无可用成员：策略会保存，但不会产生可路由流量',
  },
  TIER_EXCLUDED: {
    en: (n) => `${n} member(s) excluded: trust tier not in the pool's allowed tiers`,
    zh: (n) => `${n} 个成员因分级不在池的允许范围内被排除`,
  },
  AUTHORIZATION_MISSING: {
    en: (n) => `${n} member(s) excluded: authorization not confirmed (compliance gate, not health)`,
    zh: (n) => `${n} 个成员授权状态未确认，已排除（授权是合规门槛，不是技术状态）`,
  },
  UNHEALTHY_EXCLUDED: {
    en: (n) => `${n} member(s) excluded: health check not passing`,
    zh: (n) => `${n} 个成员健康检查未通过，已排除`,
  },
  MAX_MEMBERS_TRUNCATED: {
    en: (n) => `${n} member(s) over the limit, truncated by strategy order`,
    zh: (n) => `成员数超出上限，已按策略排序截断 ${n} 个`,
  },
  PUBLIC_PROXY_EXPERIMENTAL_ONLY: {
    en: (n) => `${n} public proxy(ies) isolated to a dedicated listener, never in the formal gateway`,
    zh: (n) => `${n} 个公开代理被隔离到独立监听器，不参与正式网关`,
  },
  POLICY_UNBOUND: {
    en: (n) => `${n} enabled policy(ies) are not bound to a gateway instance and were skipped`,
    zh: (n) => `${n} 条启用中的策略未绑定网关实例，本次编译已跳过`,
  },
};

export function warningText(w: CompileWarning, lang: 'en' | 'zh'): string {
  const entry = TEXT[w.code];
  if (!entry) return w.message; // 未知 code 兜底用后端文案
  const n = w.count ?? 0;
  return lang === 'zh' ? entry.zh(n) : entry.en(n);
}

/**
 * 晋升建议的理由。
 *
 * 同一类问题：`rationale` 是生成时刻的语言，界面语言是用户偏好，两者无关。
 * 有 code 就按 code 出文案；没有 code（外部 LLM 自由文本）才回退原文。
 */
const RATIONALE: Record<string, { en: (p: Record<string, unknown>) => string; zh: (p: Record<string, unknown>) => string }> = {
  STABLE_EXIT_IP: {
    en: (p) =>
      `Online for ${p.days ?? '?'} consecutive days, exit IP unchanged, no header injection detected. Suggest a human review of the authorization source before promoting.`,
    zh: (p) =>
      `连续 ${p.days ?? '?'} 天在线，出口 IP 未变，未检测到头部注入。建议人工复核授权来源后再提升。`,
  },
};

export function rationaleText(
  code: string | null | undefined,
  params: Record<string, unknown> | undefined,
  fallback: string | null,
  lang: 'en' | 'zh',
): string {
  const entry = code ? RATIONALE[code] : undefined;
  if (!entry) return fallback ?? '—';
  return lang === 'zh' ? entry.zh(params ?? {}) : entry.en(params ?? {});
}
