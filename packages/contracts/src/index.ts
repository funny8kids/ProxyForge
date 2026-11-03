/**
 * ProxyForge 共享契约层
 * 单一真相：数据库 ENUM 与 API DTO 的 TypeScript 投影。
 * 服务端与前端都从这里取类型，禁止各自复制一份。
 */

// ─────────────────────────────────────────────────────────────
// 枚举（与 migrations/0001_schema_v1.sql 的 CREATE TYPE 一一对应）
// ─────────────────────────────────────────────────────────────

export const IP_TYPES = ['STATIC', 'DYNAMIC', 'UNKNOWN'] as const;
export type IpType = (typeof IP_TYPES)[number];

export const NETWORK_TYPES = ['RESIDENTIAL', 'DATACENTER', 'MOBILE', 'UNKNOWN'] as const;
export type NetworkType = (typeof NETWORK_TYPES)[number];

export const CONFIDENCES = ['DECLARED', 'OBSERVED', 'INFERRED', 'UNKNOWN'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const PROXY_PROTOCOLS = ['HTTP', 'HTTPS_CONNECT', 'SOCKS4', 'SOCKS5'] as const;
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];

export const ORIGIN_TYPES = ['OWNED', 'FREE_PROVIDER', 'PUBLIC_PROXY', 'PAID_PROVIDER'] as const;
export type OriginType = (typeof ORIGIN_TYPES)[number];

export const AUTHORIZATION_STATUSES = ['AUTHORIZED', 'RESTRICTED', 'UNKNOWN', 'REVOKED'] as const;
export type AuthorizationStatus = (typeof AUTHORIZATION_STATUSES)[number];

/** 信任分级：决定"能用在什么场景"，与 authorization_status（有没有授权）正交 */
export const TRUST_TIERS = ['PRIVATE_PROXY', 'PUBLIC_PROXY', 'VERIFIED_PROXY'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const LIFECYCLE_STATUSES = [
  'DISCOVERED',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'HEALTHY',
  'DEGRADED',
  'UNAVAILABLE',
  'QUARANTINED',
  'REJECTED',
  'REVOKED',
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const POLICY_STRATEGIES = [
  'DIRECT',
  'FIXED',
  'FASTEST',
  'WEIGHTED',
  'STICKY',
  'FAILOVER',
  'REGION',
] as const;
export type PolicyStrategy = (typeof POLICY_STRATEGIES)[number];

export const CHECK_FAILURE_REASONS = [
  'NONE',
  'DNS_FAILURE',
  'TCP_REFUSED',
  'TCP_TIMEOUT',
  'TLS_ERROR',
  'PROTOCOL_ERROR',
  'AUTH_FAILED',
  'EXIT_MISMATCH',
  'TIMEOUT',
  'UNSTABLE',
  'FLAKY',
  'INTERNAL',
] as const;
export type CheckFailureReason = (typeof CHECK_FAILURE_REASONS)[number];

export const USER_ROLES = ['ADMIN', 'OPERATOR', 'VIEWER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const AI_PROVIDER_TYPES = [
  'OPENAI_COMPATIBLE',
  'ANTHROPIC',
  'OLLAMA',
  'CUSTOM',
] as const;
export type AiProviderType = (typeof AI_PROVIDER_TYPES)[number];

export const AI_TASK_TYPES = [
  'DISCOVERY',
  'ANALYZER',
  'CLASSIFIER',
  'EVALUATOR',
  'ASSISTANT',
] as const;
export type AiTaskType = (typeof AI_TASK_TYPES)[number];

export const JOB_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ─────────────────────────────────────────────────────────────
// 通用信封
// ─────────────────────────────────────────────────────────────

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

/** RFC 9457 Problem Details */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  requestId: string;
  errors?: Array<{ field: string; message: string }>;
}

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PARSE_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'AUTHORIZATION_REQUIRED'
  | 'TIER_UPGRADE_FORBIDDEN'
  | 'SELF_REVIEW_FORBIDDEN'
  | 'PUBLIC_PROXY_GATEWAY_FORBIDDEN'
  | 'SIGNATURE_VERSION_UNSUPPORTED'
  | 'SIGNING_KEY_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'DUPLICATE_KEY'
  | 'POLICY_UNSATISFIABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'AI_UNAVAILABLE'
  | 'ENGINE_UNAVAILABLE';

// ─────────────────────────────────────────────────────────────
// 资源端点（对外视图）
// ─────────────────────────────────────────────────────────────

export interface EndpointHealth {
  success: boolean;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  p50Ms: number | null;
  p95Ms: number | null;
  jitterMs: number | null;
  successRate24h: number | null;
  qualityScore: number;
  /**
   * 能否建立 CONNECT 隧道（即能否访问 HTTPS 站点）。
   *
   * `null` = 还没测过。`false` = 只能转发明文 HTTP。
   *
   * 免费代理里存活节点约六成属于 `false` —— 它们在 Clash 里对绝大多数
   * 站点完全不可用，但明文探测是成功的，所以质量分并不低。订阅渲染
   * 会把它们剔除，界面也必须能看见这个字段，否则用户无法理解
   * 「为什么显示 300 个健康节点，实际只有 70 多个能用」。
   */
  connectOk: boolean | null;
}

export interface EndpointSummary {
  id: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  displayName: string | null;
  originType: OriginType;
  trustTier: TrustTier;
  authorizationStatus: AuthorizationStatus;
  lifecycleStatus: LifecycleStatus;
  explicitGatewayGrant: boolean;
  qualityScore: number;
  countryCode: string | null;
  region: string | null;
  tags: string[];
  expectedCountry: string | null;
  lastVerifiedAt: string | null;
  health: EndpointHealth | null;
}

export interface EndpointDetail extends EndpointSummary {
  nodeId: string | null;
  sourceId: string | null;
  ipAssetId: string | null;
  networkType: NetworkType;
  ipType: IpType;
  asn: number | null;
  asOrg: string | null;
  isp: string | null;
  city: string | null;
  labels: Record<string, unknown>;
  credentialRef: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  pools: Array<{ id: string; key: string; name: string }>;
  recentChecks: HealthCheckRow[];
}

export interface HealthCheckRow {
  checkedAt: string;
  success: boolean;
  failureReason: CheckFailureReason;
  failedLayer: number | null;
  dnsMs: number | null;
  tcpMs: number | null;
  handshakeMs: number | null;
  totalMs: number | null;
  exitIp: string | null;
  exitCountry: string | null;
}

// ─────────────────────────────────────────────────────────────
// 导入 / 候选
// ─────────────────────────────────────────────────────────────

export interface ImportRequest {
  mode: 'TEXT' | 'FILE' | 'URL';
  sourceKey?: string;
  content: string;
  defaultProtocol?: ProxyProtocol;
  defaultOriginType?: OriginType;
  trustTier?: TrustTier;
}

export interface ImportResult {
  jobId: string;
  total: number;
  imported: number;
  duplicated: number;
  skipped: number;
  failed: number;
  errors: Array<{ lineNo: number; rawValue: string; reason: string }>;
}

export interface CandidateRow {
  id: string;
  sourceId: string;
  rawValue: string;
  protocol: ProxyProtocol | null;
  host: string | null;
  port: number | null;
  reviewStatus: 'PENDING' | 'PROMOTED' | 'REJECTED' | 'DUPLICATE';
  authorizationGuess: AuthorizationStatus;
  rejectReason: string | null;
  createdAt: string;
}

/** 资源来源。`protocolHint` 从 config 里提出来，界面要直接显示它。 */
export interface SourceSummary {
  id: string;
  key: string;
  name: string;
  type: 'GITHUB_REPO' | 'WEB_PAGE' | 'API' | 'CSV_FEED' | 'MIHOMO_SUB' | 'MANUAL';
  url: string | null;
  formatHint: string | null;
  protocolHint: ProxyProtocol | null;
  authorizationStatus: AuthorizationStatus;
  trustLevel: number;
  enabled: boolean;
  syncIntervalSeconds: number;
  lastSyncedAt: string | null;
  notes: string | null;
  /** 待处理候选数 */
  pendingCandidates: number;
  /** 该源累计产出的候选数（不含已处理的） */
  totalCandidates: number;
  /** 已晋级为端点的数量 */
  promotedCandidates: number;
  /** 上次同步结果；FAILED 会触发告警 */
  lastSyncStatus: 'NEVER' | 'OK' | 'FAILED';
  lastSyncError: string | null;
  /** 0–100；null 表示样本不足还没算过 */
  qualityScore: number | null;
  /** 参与评分的端点数。分数必须和它一起看 */
  qualitySampleSize: number;
  /** 被系统自动停用的时间（AUTHORIZED 来源不会走到这里） */
  autoDisabledAt: string | null;
  autoDisableReason: string | null;
  /**
   * 累计「成功取到内容」的次数（新内容与重复内容都算，拉取失败不算）。
   *
   * 它存在的唯一理由是给重复率一个分母：内容未变时不写快照行，
   * 于是 `distinct / snapshots` 恒等于 1，重复率永远显示 0%。
   */
  syncAttempts: number;
  /** 累计「内容与上次完全相同」的次数。重复率 = duplicateSyncs / syncAttempts */
  duplicateSyncs: number;
}

export interface SourceSyncOutcome {
  sourceId: string;
  key: string;
  name: string;
  ok: boolean;
  snapshotId: string | null;
  entries: number;
  candidates: number;
  duplicateSnapshot: boolean;
  format: string;
  warnings: string[];
  error?: string;
  durationMs: number;
}


// ─────────────────────────────────────────────────────────────
// 验证
// ─────────────────────────────────────────────────────────────

export interface VerificationJobRow {
  id: string;
  scope: 'ENDPOINT' | 'ENDPOINTS' | 'POOL' | 'ALL_PENDING' | 'ALL';
  status: JobStatus;
  total: number;
  completed: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * 已认领次数与重试上限。
   *
   * 暴露出来是因为「任务停在 PENDING 却永远不跑」有两个完全不同的原因：
   * `attempts` 用满（不会再被认领）与 `runAfter` 还在未来（没到点）。
   * 界面上只看到 PENDING 的话，这两种情况长得一模一样。
   */
  attempts: number;
  maxAttempts: number;
  runAfter: string | null;
}

export interface VerificationRunRequest {
  scope: VerificationJobRow['scope'];
  endpointIds?: string[];
  poolId?: string;
}

// ─────────────────────────────────────────────────────────────
// 资源池
// ─────────────────────────────────────────────────────────────

export interface PoolRule {
  id: string;
  ruleOrder: number;
  name: string;
  predicate: Record<string, unknown>;
  enabled: boolean;
}

export interface PoolSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  purpose: string | null;
  minQuality: number;
  maxMembers: number | null;
  memberCount: number;
  allowedTiers: TrustTier[];
  experimental: boolean;
  enabled: boolean;
  version: number;
  health: { healthy: number; degraded: number; avgQuality: number | null };
}

export interface PoolDetail extends PoolSummary {
  rules: PoolRule[];
  members: PoolMemberRow[];
}

export interface PoolMemberRow {
  endpointId: string;
  displayName: string | null;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  trustTier: TrustTier;
  source: 'AUTO' | 'MANUAL';
  weight: number;
  suppressed: boolean;
  suppressReason: string | null;
  qualityScore: number;
  lifecycleStatus: LifecycleStatus;
}

// ─────────────────────────────────────────────────────────────
// 策略 / 网关
// ─────────────────────────────────────────────────────────────

export interface PolicyRow {
  id: string;
  key: string;
  name: string;
  strategy: PolicyStrategy;
  poolId: string;
  poolKey: string;
  /** 绑定的网关实例；正式与实验策略必须绑到不同实例 */
  instanceId: string | null;
  listenPort: number;
  enabled: boolean;
  priority: number;
  regionFilter: string[];
  protocolFilter: ProxyProtocol[];
  maxMembers: number | null;
  stickyTtlSeconds: number;
  version: number;
  /** 编译结果摘要：本次编译选中多少成员 */
  compiledMembers?: number;
}

export interface CompiledPolicy {
  policyKey: string;
  listenPort: number;
  strategy: PolicyStrategy;
  members: Array<{
    endpointId: string;
    host: string;
    port: number;
    protocol: ProxyProtocol;
    weight: number;
    trustTier: TrustTier;
  }>;
  warnings: CompileWarning[];
}

export interface CompileWarning {
  code:
    | 'EMPTY_POOL'
    | 'TIER_EXCLUDED'
    | 'AUTHORIZATION_MISSING'
    | 'UNHEALTHY_EXCLUDED'
    | 'MAX_MEMBERS_TRUNCATED'
    | 'PUBLIC_PROXY_EXPERIMENTAL_ONLY'
    | 'POLICY_UNBOUND';
  message: string;
  count?: number;
}

export interface GatewayInstanceRow {
  id: string;
  name: string;
  engine: string;
  status: string;
  bindHost: string;
  httpPort: number;
  socksPort: number;
  activeConfigVersion: number | null;
  lastSeenAt: string | null;
}

export interface GatewayConfigRow {
  id: string;
  instanceId: string;
  version: number;
  status: 'DRAFT' | 'COMPILED' | 'APPLIED' | 'FAILED' | 'SUPERSEDED' | 'ROLLED_BACK';
  configHash: string;
  renderedConfig: string;
  policyIds: string[];
  warnings: CompileWarning[];
  error: string | null;
  appliedAt: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────
// 订阅
// ─────────────────────────────────────────────────────────────

/**
 * 订阅节点过滤条件。
 *
 * 过滤在服务端做，不是把 200 个节点全丢给客户端让它自己筛 ——
 * 客户端筛掉的节点仍然会被 url-test 探测，等于没筛。
 */
export interface SubscriptionNodeFilter {
  protocols?: ProxyProtocol[];
  excludeProtocols?: ProxyProtocol[];
  /** quality_score 下限，0–100 */
  minQuality?: number;
  /** p50 延迟上限（毫秒） */
  maxLatencyMs?: number;
  /** 主机名黑名单，子串匹配 */
  excludeHosts?: string[];
  /** 出口国家白名单，ISO 3166-1 alpha-2（如 SG / JP / US） */
  countries?: string[];
  /** 出口国家黑名单 */
  excludeCountries?: string[];
  /** 节点数上限，1–500 */
  maxNodes?: number;
}

/** 分流模式：全局代理 / 规则分流 / 全部直连（排障） */
export type SubscriptionRoutingMode = 'global' | 'rule' | 'direct';

export interface SubscriptionRow {
  id: string;
  name: string;
  poolId: string;
  poolKey: string;
  /** 默认导出格式；拉取时可用 ?format= 覆盖 */
  format: 'mihomo' | 'clash' | 'singbox' | 'base64' | 'plain' | 'clash-provider';
  tokenPrefix: string;
  signingEnabled: boolean;
  revision: number;
  expiresAt: string | null;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  createdAt: string;
  /** 节点过滤条件 */
  nodeFilter: SubscriptionNodeFilter;
  /** 命名模板，占位符 {index} {protocol} {host} {port} {pool} */
  nameTemplate: string | null;
  routingMode: SubscriptionRoutingMode;
  /** 追加分流规则，mihomo 行语法 */
  extraRules: string[];
}

export interface SubscriptionCreated extends SubscriptionRow {
  /** 明文 token，仅创建时返回一次 */
  token: string;
  url: string;
  warning: string;
}

export interface SigningKeyRow {
  keyId: string;
  algorithm: 'Ed25519';
  publicKey: string;
  status: 'ACTIVE' | 'STANDBY' | 'RETIRED' | 'COMPROMISED';
  signatureVersion: number;
  notBefore: string;
  notAfter: string | null;
  activatedAt: string | null;
}

// ─────────────────────────────────────────────────────────────
// 信任分级
// ─────────────────────────────────────────────────────────────

export interface TrustSummary {
  tiers: Array<{
    tier: TrustTier;
    total: number;
    healthy: number;
    degraded: number;
    unavailable: number;
    /** 该分级是否可进入正式网关 */
    gatewayEligible: boolean;
  }>;
  pendingPromotions: number;
  publicProxyHealthRate: number | null;
}

export interface PromotionSuggestionRow {
  id: string;
  endpointId: string | null;
  candidateId: string | null;
  suggestedTier: TrustTier;
  currentTier: TrustTier | null;
  confidence: number;
  rationale: string | null;
  /**
   * 理由的机器可读码。界面按当前语言渲染，`rationale` 原文只在
   * code 为空时作为回退（外部 LLM 产出的自由文本没有 code）。
   */
  rationaleCode?: string | null;
  rationaleParams?: Record<string, unknown>;
  source: 'AI' | 'RULE' | 'HUMAN';
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewedBy: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────
// 分析
// ─────────────────────────────────────────────────────────────

export interface OverviewAnalytics {
  counters: {
    totalEndpoints: number;
    schedulable: number;
    healthy: number;
    degraded: number;
    quarantined: number;
    pendingVerification: number;
  };
  tiers: Array<{ tier: TrustTier; count: number }>;
  protocolMix: Array<{ protocol: ProxyProtocol; count: number }>;
  originMix: Array<{ originType: OriginType; count: number }>;
  /**
   * 每日探测趋势。**只包含完整日**，且每个字段都来自 `health_checks` 里
   * 不可变的原始记录 —— 不掺端点当前状态。
   *
   * 曾经这里叫 `avgQuality`，算法是「当天被探过的端点，它们的**现在**质量分均值」。
   * 于是同一个历史日期会随着端点后来死掉而不断改写：11-02 那天重探了大批
   * 已死端点，均值从 63 掉到 10，图上画出一条断崖 —— 而当天的事实没有变过。
   * 历史桶里放当前状态，是这份数据模型里最容易犯的错。
   */
  qualityTrend: Array<{ day: string; checks: number; successRate: number; avgMs: number | null }>;
  regionDistribution: Array<{ countryCode: string; count: number; avgLatency: number | null }>;
  topEndpoints: Array<{
    id: string;
    displayName: string | null;
    countryCode: string | null;
    p50Ms: number | null;
    successRate24h: number | null;
    qualityScore: number;
  }>;
  gatewayTraffic: Array<{ bucket: string; connections: number; bytesIn: number; bytesOut: number }>;
}

/** /gateway/traffic 的单个小时桶。比 overview 多一个 errors 计数。 */
export interface GatewayTrafficPoint {
  bucket: string;
  connections: number;
  bytesIn: number;
  bytesOut: number;
  errors: number;
}

// ─────────────────────────────────────────────────────────────
// AI
// ─────────────────────────────────────────────────────────────

export interface AiProviderRow {
  id: string;
  key: string;
  name: string;
  type: AiProviderType;
  baseUrl: string;
  apiKeyMasked: string | null;
  enabled: boolean;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  budgetMonthlyUsd: number | null;
  spentCurrentMonth: number;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  models: Array<{ modelName: string; displayName: string | null; enabled: boolean }>;
}

export interface AiTaskBindingRow {
  taskType: AiTaskType;
  chain: Array<{
    providerId: string;
    providerKey: string;
    providerName: string;
    modelId: string;
    modelName: string;
    priority: number;
    enabled: boolean;
  }>;
}

// ─────────────────────────────────────────────────────────────
// 审计
// ─────────────────────────────────────────────────────────────

export interface AuditEventRow {
  id: number;
  occurredAt: string;
  actorType: 'USER' | 'API_KEY' | 'SYSTEM' | 'SCHEDULER';
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  sourceIp: string | null;
  requestId: string | null;
  beforeState: unknown;
  afterState: unknown;
}

// ─────────────────────────────────────────────────────────────
// 系统状态
// ─────────────────────────────────────────────────────────────

export interface SystemStatus {
  version: string;
  uptimeSeconds: number;
  db: { ok: boolean; latencyMs: number };
  gateway: { status: 'APPLIED' | 'STALE' | 'FAILED' | 'UNKNOWN'; configVersion: number | null };
  outbox: { pending: number; failed: number };
  worker: {
    lastHeartbeatAt: string | null;
    /**
     * 周期任务的累计错误数与本进程最后一次错误。
     * 没有这两个字段时，「池重算每轮都抛异常」只能靠翻日志发现 ——
     * 它会连续几天静默地把所有池成员算成 0。
     */
    errors?: number;
    lastError?: string | null;
    lastErrorAt?: string | null;
    /**
     * 最后一轮周期任务成功完成的时间。
     *
     * 与 `lastHeartbeatAt` 分开：后者是**节点**心跳（proxy_nodes 可以合法为空，
     * 那它就永远是 null），前者是**worker** 自己的进度。把两者混成一个字段，
     * 会让人把"没有节点"误读成"worker 没在跑"。
     */
    lastCycleAt?: string | null;
  };
  /** 三层平面的进程边界自检结果 */
  planes: { control: boolean; data: boolean; intelligence: boolean };
}

// ─────────────────────────────────────────────────────────────
// 告警与事件
// ─────────────────────────────────────────────────────────────

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface AlertRow {
  id: string;
  /** 去重键：同一 key 未解决时只累加 count */
  key: string;
  severity: AlertSeverity;
  /** ACKED 表示人看到了但问题仍在 —— 不从列表里消失 */
  status: 'OPEN' | 'ACKED' | 'RESOLVED';
  title: string;
  detail: string | null;
  subjectType: string | null;
  subjectId: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  autoResolved: boolean;
}

export interface EventMetricPoint {
  day: string;
  eventType: string;
  count: number;
}

export interface EventPipelineStats {
  byStatus: Record<'PENDING' | 'PUBLISHED' | 'DEAD', number>;
  items: Array<{
    id: string;
    eventId: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
    attempts: number;
    lastError: string | null;
    deadAt: string | null;
    consumerState: Record<string, { ok: boolean; at: string; error?: string }> | null;
  }>;
}
