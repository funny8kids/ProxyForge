import type {
  CompileWarning,
  CompiledPolicy,
  PolicyStrategy,
  ProxyProtocol,
  TrustTier,
} from '@proxyforge/contracts';
import { q } from '../../db/client.js';
import { toTextArray } from '../../shared/pg-array.js';

/**
 * 策略编译（ADR-0007）
 *
 * 核心约束：一个策略 = 一个监听端口，成员集合在**编译期**固化。
 * 请求期绝不回源控制平面 —— 原因不是性能，而是**语义上做不到**：
 * HTTP 代理会把自定义 Header 转发给目标站点，而 CONNECT 隧道建立后
 * 控制平面根本读不到 Header。所以任何"按请求头动态选路"的设计都是错的。
 *
 * 信任门槛（SEC-001 §6.2）：正式网关只从 v_schedulable_endpoints 取数。
 * 该视图里永远没有 PUBLIC_PROXY —— 这不是代码里的 if，是数据库视图的定义。
 * 公开代理只能进独立的隔离监听器（experimental），永不与正式成员混流。
 */

interface RawMember {
  id: string;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  trust_tier: TrustTier;
  quality_score: string;
  p50_ms: number | null;
  success_rate_24h: string | null;
  weight: number;
}

export interface CompileInput {
  poolId: string;
  poolKey: string;
  poolExperimental: boolean;
  poolAllowedTiers: TrustTier[];
  minQuality: number;
  maxMembers: number | null;
  strategy: PolicyStrategy;
  protocolFilter: ProxyProtocol[];
  regionFilter: string[];
  listenPort: number;
  policyKey: string;
}

export interface CompileOutput {
  policy: CompiledPolicy;
  /** 隔离监听器的成员：仅当池为实验池且含 PUBLIC_PROXY 时存在 */
  experimentalMembers: Array<{
    endpointId: string;
    host: string;
    port: number;
    protocol: ProxyProtocol;
  }>;
}

const STRATEGY_ORDER: Record<PolicyStrategy, string> = {
  DIRECT: '1',
  FASTEST: 'v.p50_ms ASC NULLS LAST, v.quality_score DESC',
  FIXED: 'm.added_at ASC',
  WEIGHTED: 'm.weight DESC, v.quality_score DESC',
  STICKY: 'm.weight DESC, v.quality_score DESC',
  FAILOVER: 'v.quality_score DESC, v.p50_ms ASC NULLS LAST',
  REGION: 'v.quality_score DESC',
};

export async function compilePolicy(input: CompileInput): Promise<CompileOutput> {
  const warnings: CompileWarning[] = [];

  // 入参防御：数组列可能以 PG 字面量字符串形式传进来。
  // 用 `filters.length > 0` 判断"有没有过滤条件"时，字符串 "{...}" 恒为真，
  // 会给查询加一个空集合过滤，静默编译出 0 成员——这是最难查的一类故障。
  const protocolFilter = toTextArray(input.protocolFilter);
  const regionFilter = toTextArray(input.regionFilter);
  const allowedTiers = toTextArray(input.poolAllowedTiers);

  // ── 1. 正式成员：只从 v_schedulable_endpoints 取 ──
  // 该视图已强制：deleted_at IS NULL + 授权有效 + 健康 + 分级允许
  const params: unknown[] = [input.poolId, input.minQuality];
  let sql = `
    SELECT v.id, v.host, v.port, v.protocol, v.trust_tier, v.quality_score,
           v.p50_ms, v.success_rate_24h, m.weight
    FROM v_schedulable_endpoints v
    JOIN resource_pool_members m
      ON m.endpoint_id = v.id AND m.pool_id = $1 AND m.suppressed = false
    WHERE v.quality_score >= $2`;

  if (protocolFilter.length > 0) {
    params.push(protocolFilter);
    sql += ` AND v.protocol::text = ANY($${params.length}::text[])`;
  }
  if (regionFilter.length > 0) {
    params.push(regionFilter);
    sql += ` AND v.host = ANY($${params.length}::text[])`; // 占位：真实实现按 country_code 过滤
  }

  // 末尾必须补一个唯一键。
  // 只按 quality_score / p50_ms 排序时，同分成员之间的相对顺序由执行计划决定，
  // 于是同样的输入可能渲染出成员顺序不同的 YAML —— hash 变了、版本号跳了，
  // 但配置语义完全一样。配置产物的稳定性是编译期固化（ADR-0007）的前提。
  sql += ` ORDER BY ${STRATEGY_ORDER[input.strategy]}, v.id ASC`;

  const rows = await q<RawMember>(sql, params);

  let members = rows.map((r) => ({
    endpointId: r.id,
    host: r.host,
    port: r.port,
    protocol: r.protocol,
    weight: r.weight,
    trustTier: r.trust_tier,
  }));

  const limit = input.maxMembers ?? members.length;
  if (members.length > limit) {
    warnings.push({
      code: 'MAX_MEMBERS_TRUNCATED',
      message: `成员数 ${members.length} 超过上限 ${limit}，已按策略排序截断`,
      count: members.length - limit,
    });
    members = members.slice(0, limit);
  }

  // ── 2. 为什么少了人：把"被门槛挡掉"的原因显式统计出来 ──
  // 没有这一步，用户只会看到"池里有 40 个但策略只编出 12 个"，无从排查。
  const excluded = await q<{ reason: string; cnt: number }>(
    `SELECT reason, cnt::int AS cnt FROM (
       SELECT CASE
         WHEN e.authorization_status NOT IN ('AUTHORIZED','RESTRICTED') THEN 'AUTHORIZATION_MISSING'
         WHEN e.lifecycle_status NOT IN ('HEALTHY','DEGRADED') THEN 'UNHEALTHY_EXCLUDED'
         WHEN NOT (e.trust_tier::text = ANY($2::text[])) THEN 'TIER_EXCLUDED'
         ELSE 'OTHER'
       END AS reason, count(*) AS cnt
       FROM resource_pool_members m
       JOIN proxy_endpoints e ON e.id = m.endpoint_id AND e.deleted_at IS NULL
       WHERE m.pool_id = $1 AND m.suppressed = false
       GROUP BY 1
     ) t WHERE reason <> 'OTHER'`,
    [input.poolId, allowedTiers],
  );

  for (const ex of excluded) {
    warnings.push({
      code: ex.reason as CompileWarning['code'],
      message: reasonMessage(ex.reason, ex.cnt),
      count: ex.cnt,
    });
  }

  // ── 3. 公开代理：独立隔离监听器，绝不与正式成员混流 ──
  const experimentalMembers: CompileOutput['experimentalMembers'] = [];
  if (input.poolExperimental && allowedTiers.includes('PUBLIC_PROXY')) {
    const pub = await q<{ id: string; host: string; port: number; protocol: ProxyProtocol }>(
      `SELECT e.id, e.host, e.port, e.protocol
       FROM proxy_endpoints e
       JOIN resource_pool_members m ON m.endpoint_id = e.id AND m.pool_id = $1 AND m.suppressed = false
       WHERE e.deleted_at IS NULL
         AND e.trust_tier = 'PUBLIC_PROXY'
         AND e.lifecycle_status IN ('HEALTHY','DEGRADED')
         AND e.authorization_status IN ('AUTHORIZED','RESTRICTED')
       ORDER BY e.quality_score DESC
       LIMIT 50`,
      [input.poolId],
    );
    for (const p of pub) {
      experimentalMembers.push({
        endpointId: p.id,
        host: p.host,
        port: p.port,
        protocol: p.protocol,
      });
    }
    if (pub.length > 0) {
      warnings.push({
        code: 'PUBLIC_PROXY_EXPERIMENTAL_ONLY',
        message: `${pub.length} 个公开代理被隔离到独立监听器，不参与正式网关`,
        count: pub.length,
      });
    }
  }

  if (members.length === 0) {
    warnings.push({
      code: 'EMPTY_POOL',
      message: '编译后无可用成员：策略将保存但不会产生可路由流量',
    });
  }

  return {
    policy: {
      policyKey: input.policyKey,
      listenPort: input.listenPort,
      strategy: input.strategy,
      members,
      warnings,
    },
    experimentalMembers,
  };
}

function reasonMessage(reason: string, count: number): string {
  switch (reason) {
    case 'AUTHORIZATION_MISSING':
      return `${count} 个成员授权状态未确认，已排除（授权是合规门槛，不是技术状态）`;
    case 'UNHEALTHY_EXCLUDED':
      return `${count} 个成员健康检查未通过，已排除`;
    case 'TIER_EXCLUDED':
      return `${count} 个成员的分级不被该池允许，已排除`;
    default:
      return `${count} 个成员被排除`;
  }
}
