import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UserRole } from '@proxyforge/contracts';
import { config } from '../config.js';

/**
 * 紧凑 HS256 JWT。会话 15 分钟有效（API-001 §2.1）。
 * 不引入第三方库：HS256 的规范化就是 base64url(header).base64url(payload)，
 * 自己写反而更容易审计，也少一个供应链风险面。
 */

export interface SessionClaims {
  sub: string;
  username: string;
  role: UserRole;
  iat: number;
  exp: number;
  jti: string;
}

const b64 = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

function signingSecret(): string {
  return `${config.masterKey}::jwt`;
}

export function signSession(claims: Omit<SessionClaims, 'iat' | 'exp'> & { ttlSeconds?: number }): {
  token: string;
  expiresIn: number;
} {
  const ttl = claims.ttlSeconds ?? 900;
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionClaims = {
    sub: claims.sub,
    username: claims.username,
    role: claims.role,
    iat: now,
    exp: now + ttl,
    jti: claims.jti,
  };
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = createHmac('sha256', signingSecret())
    .update(`${header}.${body}`)
    .digest('base64url');
  return { token: `${header}.${body}.${sig}`, expiresIn: ttl };
}

export function verifySession(token: string): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];

  const expected = createHmac('sha256', signingSecret()).update(`${header}.${body}`).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
