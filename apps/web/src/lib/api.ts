import type {
  AiProviderRow,
  AiTaskBindingRow,
  AuditEventRow,
  EndpointDetail,
  EndpointSummary,
  GatewayConfigRow,
  GatewayInstanceRow,
  GatewayTrafficPoint,
  OverviewAnalytics,
  Page,
  PolicyRow,
  PoolDetail,
  PoolSummary,
  ProblemDetail,
  PromotionSuggestionRow,
  SourceSummary,
  SourceSyncOutcome,
  SubscriptionRow,
  SubscriptionCreated,
  SubscriptionNodeFilter,
  SubscriptionRoutingMode,
  SystemStatus,
  TrustSummary,
  VerificationJobRow,
} from '@proxyforge/contracts';

const BASE = '/api/v1';
const TOKEN_KEY = 'pf-token';

let token: string | null = localStorage.getItem(TOKEN_KEY);

export class ApiError extends Error {
  readonly problem: ProblemDetail | null;
  readonly status: number;
  constructor(status: number, problem: ProblemDetail | null, message: string) {
    super(message);
    this.status = status;
    this.problem = problem;
  }
}

export const auth = {
  get token(): string | null {
    return token;
  },
  set(t: string | null): void {
    token = t;
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  },
  get isAuthed(): boolean {
    return Boolean(token);
  },
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const ct = res.headers.get('content-type') ?? '';
  const payload = ct.includes('json') ? await res.json() : await res.text();

  if (!res.ok) {
    const problem = ct.includes('json') ? (payload as ProblemDetail) : null;
    if (res.status === 401) auth.set(null);
    throw new ApiError(res.status, problem, problem?.detail ?? problem?.title ?? `HTTP ${res.status}`);
  }
  return payload as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/**
 * 下载二进制/文本文件。
 *
 * 不能直接用 `<a href>`：导出接口走 JWT 鉴权，浏览器发起的导航请求带不上
 * Authorization 头，会直接 401。所以用 fetch 拿 Blob，再触发一次本地下载。
 * 文件名从 Content-Disposition 里取（后端同时给了 ASCII 兜底与 RFC 5987）。
 */
async function downloadFile(path: string): Promise<{ blob: Blob; filename: string }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) {
    const ct = res.headers.get('content-type') ?? '';
    const payload = ct.includes('json') ? ((await res.json()) as ProblemDetail) : null;
    if (res.status === 401) auth.set(null);
    throw new ApiError(res.status, payload, payload?.detail ?? payload?.title ?? `HTTP ${res.status}`);
  }

  const disposition = res.headers.get('content-disposition') ?? '';
  // filename* 优先：它带 UTF-8 编码的中文名，ASCII 那份会把中文换成下划线
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="([^"]+)"/i.exec(disposition);
  let filename = 'subscription';
  if (star?.[1]) {
    try {
      filename = decodeURIComponent(star[1]);
    } catch {
      filename = plain?.[1] ?? filename;
    }
  } else if (plain?.[1]) {
    filename = plain[1];
  }

  return { blob: await res.blob(), filename };
}


export interface LoginResult {
  accessToken: string;
  expiresIn: number;
  user: { id: string; username: string; role: string; scopes: string[] };
}

export const api = {
  async login(username: string, password: string): Promise<LoginResult> {
    const res = await request<LoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    auth.set(res.accessToken);
    return res;
  },

  me: () => get<{ id: string; username: string; role: string; scopes: string[] }>('/auth/me'),
  systemStatus: () => get<SystemStatus & { probeMode: string }>('/system/status'),
  overview: () => get<OverviewAnalytics>('/analytics/overview'),

  resources: (q: string) => get<Page<EndpointSummary>>(`/resources${q ? `?${q}` : ''}`),
  resource: (id: string) => get<EndpointDetail>(`/resources/${id}`),
  quarantine: (id: string) => post<{ ok: boolean }>(`/resources/${id}/quarantine`),
  /** 授权声明 / 改名 / 打标签。authorizationStatus 改成 REVOKED 会连带吊销生命周期。 */
  updateResource: (
    id: string,
    body: { displayName?: string; authorizationStatus?: string; tags?: string[] },
  ) => patch<{ id: string }>(`/resources/${id}`, body),
  importText: (content: string, opts: Record<string, unknown> = {}) =>
    post<{
      jobId: string;
      total: number;
      imported: number;
      duplicated: number;
      skipped: number;
      failed: number;
      errors: Array<{ lineNo: number; rawValue: string; reason: string }>;
    }>('/resources/import', { mode: 'TEXT', content, ...opts }),

  pools: () => get<{ items: PoolSummary[] }>('/pools'),
  pool: (id: string) => get<PoolDetail>(`/pools/${id}`),
  recomputePool: (id: string) => post<{ added: number; removed: number }>(`/pools/${id}/recompute`),

  // ── 来源采集 ────────────────────────────────────────────────
  sources: () => get<{ items: SourceSummary[] }>('/sources'),
  /** 候选区总览。uniqueEndpoints 才是真实资源量，total 含跨源重复。 */
  sourceStats: () =>
    get<{
      total: number;
      uniqueEndpoints: number;
      uniqueHosts: number;
      pending: number;
      promoted: number;
      duplicate: number;
      byProtocol: Array<{ protocol: string | null; count: number }>;
    }>('/sources/stats'),
  /** 把内置目录（17 个公开源）幂等写入 resource_sources */
  importCatalog: () => post<{ created: number; updated: number; total: number }>('/sources/catalog', {}),
  syncSource: (id: string, body: Record<string, unknown> = {}) =>
    post<SourceSyncOutcome>(`/sources/${id}/sync`, body),
  syncAllSources: (body: Record<string, unknown> = {}) =>
    post<{
      total: number;
      succeeded: number;
      failed: number;
      candidates: number;
      results: SourceSyncOutcome[];
    }>('/sources/sync-all', body),
  updateSource: (id: string, body: { enabled?: boolean; trustLevel?: number; name?: string }) =>
    patch<{ ok: boolean }>(`/sources/${id}`, body),
  /**
   * 批量晋级。authorization 必填 —— 批量不等于自动，
   * 仍要显式声明「我有权使用这些代理」。分级固定 PUBLIC_PROXY。
   */
  bulkPromote: (sourceId: string, limit: number, authorization: 'AUTHORIZED' | 'RESTRICTED') =>
    post<{ promoted: number; duplicate: number; remaining: number }>('/candidates/bulk-promote', {
      sourceId,
      limit,
      authorization,
    }),

  policies: () => get<{ items: PolicyRow[] }>('/policies'),
  reloadGateway: () =>
    post<{
      version: number;
      configHash: string;
      memberCount: number;
      policyCount: number;
      warnings: Array<{ code: string; message: string }>;
      instances: Array<{ instanceId: string; name: string; version: number; memberCount: number; policyCount: number }>;
    }>('/gateway/reload'),
  gatewayInstances: () => get<{ items: GatewayInstanceRow[] }>('/gateway/instances'),
  gatewayConfigs: (instanceId: string) =>
    get<{ items: GatewayConfigRow[] }>(`/gateway/configs?instanceId=${instanceId}`),
  gatewayTraffic: (hours = 24) =>
    get<{ items: GatewayTrafficPoint[] }>(`/gateway/traffic?hours=${hours}`),

  trustSummary: () => get<TrustSummary>('/trust/summary'),
  promotions: (status = 'PENDING') =>
    get<{ items: PromotionSuggestionRow[] }>(`/trust/promotions?status=${status}`),
  approvePromotion: (id: string) => post<{ ok: boolean }>(`/trust/promotions/${id}/approve`),
  rejectPromotion: (id: string, reason: string) =>
    post<{ ok: boolean }>(`/trust/promotions/${id}/reject`, { reason }),

  subscriptions: () => get<{ items: SubscriptionRow[] }>('/subscriptions'),
  /** 明文 token 只在这一次响应里出现，之后库里只有 sha256。 */
  createSubscription: (body: {    name: string;
    poolId: string;
    format?: string;
    signingEnabled?: boolean;
    nodeFilter?: SubscriptionNodeFilter;
    nameTemplate?: string | null;
    routingMode?: SubscriptionRoutingMode;
    extraRules?: string[];
  }) => post<SubscriptionCreated>('/subscriptions', body),
  /** 只改渲染相关字段；pool / token / revision 都不动。 */
  updateSubscription: (
    id: string,
    body: {
      name?: string;
      format?: string;
      nameTemplate?: string | null;
      routingMode?: SubscriptionRoutingMode;
      extraRules?: string[];
      nodeFilter?: SubscriptionNodeFilter;
      signingEnabled?: boolean;
    },
  ) => patch<{ ok: boolean; changed: boolean }>(`/subscriptions/${id}`, body),
  /**
   * 过滤条件预览。返回匹配数与协议分布 ——
   * 否则用户设完 minQuality 只能"保存 → 拉取 → 发现是空的 → 再改"。
   */
  previewSubscription: (body: {
    poolId: string;
    nodeFilter?: SubscriptionNodeFilter;
    nameTemplate?: string | null;
    routingMode?: SubscriptionRoutingMode;
    extraRules?: string[];
    format?: string;
    includeBody?: boolean;
  }) =>
    post<{
      poolKey: string;
      matched: number;
      byProtocol: Record<string, number>;
      sampleNames: string[];
      format: string;
      routingMode: string;
      contentType?: string;
      body?: string;
    }>('/subscriptions/preview', body),
  /** 换掉 token_hash：旧 URL 立即失效，订阅本身与版本历史保留。 */
  rotateSubscriptionToken: (id: string) =>
    post<{ id: string; token: string; tokenPrefix: string; url: string; warning: string }>(
      `/subscriptions/${id}/rotate-token`,
    ),
  revokeSubscription: (id: string) => del<{ ok: boolean }>(`/subscriptions/${id}`),
  /**
   * 导出订阅为文件。走 JWT 鉴权，不需要明文 token ——
   * 也就是说刷新页面之后依然能导出，不必重建订阅。
   */
  exportSubscription: (id: string, format: string) =>
    downloadFile(`/subscriptions/${id}/export?format=${encodeURIComponent(format)}`),

  aiProviders: () => get<{ items: AiProviderRow[] }>('/ai/providers'),
  aiBindings: () => get<{ items: AiTaskBindingRow[] }>('/ai/task-bindings'),
  aiTest: (id: string) =>
    post<{ ok: boolean; latencyMs: number; detail: string; models: string[] }>(`/ai/providers/${id}/test`),

  audit: (limit = 60) => get<{ items: AuditEventRow[] }>(`/audit/events?limit=${limit}`),
  verificationJobs: () => get<{ items: VerificationJobRow[] }>('/verification/jobs'),
  runVerification: (scope: string, endpointIds?: string[]) =>
    post<{ id: string; status: string }>('/verification/jobs', { scope, endpointIds }),
  verificationJob: (id: string) =>
    get<{
      id: string;
      scope: string;
      status: string;
      total: number;
      completed: number;
      failedCount: number;
    }>(`/verification/jobs/${id}`),
};

export type { EndpointSummary, EndpointDetail };
