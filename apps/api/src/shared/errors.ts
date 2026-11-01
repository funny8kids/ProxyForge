import type { ErrorCode, ProblemDetail } from '@proxyforge/contracts';

const STATUS: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  PARSE_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  AUTHORIZATION_REQUIRED: 403,
  TIER_UPGRADE_FORBIDDEN: 403,
  SELF_REVIEW_FORBIDDEN: 403,
  PUBLIC_PROXY_GATEWAY_FORBIDDEN: 422,
  SIGNATURE_VERSION_UNSUPPORTED: 400,
  SIGNING_KEY_UNAVAILABLE: 503,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  DUPLICATE_KEY: 409,
  POLICY_UNSATISFIABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  AI_UNAVAILABLE: 503,
  ENGINE_UNAVAILABLE: 503,
};

const TITLE: Record<ErrorCode, string> = {
  INVALID_ARGUMENT: 'Invalid argument',
  PARSE_FAILED: 'Parse failed',
  UNAUTHENTICATED: 'Unauthenticated',
  FORBIDDEN: 'Forbidden',
  AUTHORIZATION_REQUIRED: 'Authorization required',
  TIER_UPGRADE_FORBIDDEN: 'Tier upgrade forbidden',
  SELF_REVIEW_FORBIDDEN: 'Self review forbidden',
  PUBLIC_PROXY_GATEWAY_FORBIDDEN: 'Public proxy cannot be granted gateway access',
  SIGNATURE_VERSION_UNSUPPORTED: 'Signature version unsupported',
  SIGNING_KEY_UNAVAILABLE: 'Signing key unavailable',
  NOT_FOUND: 'Not found',
  VERSION_CONFLICT: 'Version conflict',
  DUPLICATE_KEY: 'Duplicate key',
  POLICY_UNSATISFIABLE: 'Policy unsatisfiable',
  RATE_LIMITED: 'Rate limited',
  INTERNAL: 'Internal error',
  AI_UNAVAILABLE: 'AI unavailable',
  ENGINE_UNAVAILABLE: 'Engine unavailable',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: Array<{ field: string; message: string }> | undefined;

  constructor(
    code: ErrorCode,
    detail?: string,
    errors?: Array<{ field: string; message: string }>,
  ) {
    super(detail ?? TITLE[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
    this.errors = errors;
  }

  toProblem(requestId: string, instance?: string): ProblemDetail {
    const pd: ProblemDetail = {
      type: `https://proxyforge.dev/errors/${this.code.toLowerCase().replace(/_/g, '-')}`,
      title: TITLE[this.code],
      status: this.status,
      code: this.code,
      requestId,
    };
    if (this.detail !== undefined) pd.detail = this.detail;
    if (instance !== undefined) pd.instance = instance;
    if (this.errors !== undefined) pd.errors = this.errors;
    return pd;
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const invalid = (detail: string, errors?: Array<{ field: string; message: string }>) =>
  new AppError('INVALID_ARGUMENT', detail, errors);
export const conflict = (detail: string) => new AppError('VERSION_CONFLICT', detail);
export const forbidden = (code: ErrorCode, detail: string) => new AppError(code, detail);
