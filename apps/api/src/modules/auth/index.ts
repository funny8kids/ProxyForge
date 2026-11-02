import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@proxyforge/contracts';
import { q1, exec } from '../../db/client.js';
import { AppError, forbidden } from '../../shared/errors.js';
import { sha256Hex } from '../../shared/crypto.js';
import { verifySession } from '../../shared/jwt.js';

export type Scope =
  | 'resource:read'
  | 'resource:write'
  | 'source:read'
  | 'source:write'
  | 'verification:run'
  | 'pool:read'
  | 'pool:write'
  | 'policy:read'
  | 'policy:write'
  | 'gateway:read'
  | 'gateway:apply'
  | 'subscription:read'
  | 'subscription:write'
  | 'trust:read'
  | 'trust:write'
  | 'trust:review'
  | 'signing:manage'
  | 'ai:read'
  | 'ai:write'
  | 'audit:read'
  | 'alert:read'
  | 'alert:write'
  /**
   * 运维级操作（主动 CHECKPOINT、将来的保留策略执行）。
   * 只给 ADMIN：这类操作没有业务语义，动的是存储本身。
   */
  | 'system:admin';

export interface Actor {
  kind: 'USER' | 'API_KEY';
  id: string;
  username: string;
  role: UserRole;
  scopes: Set<string>;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

const ROLE_SCOPES: Record<UserRole, Scope[]> = {
  ADMIN: [
    'resource:read', 'resource:write', 'source:read', 'source:write',
    'verification:run', 'pool:read', 'pool:write', 'policy:read', 'policy:write',
    'gateway:read', 'gateway:apply', 'subscription:read', 'subscription:write',
    'trust:read', 'trust:write', 'trust:review', 'signing:manage',
    'ai:read', 'ai:write', 'audit:read', 'alert:read', 'alert:write', 'system:admin',
  ],
  OPERATOR: [
    'resource:read', 'resource:write', 'source:read', 'source:write',
    'verification:run', 'pool:read', 'pool:write', 'policy:read', 'policy:write',
    'gateway:read', 'subscription:read', 'subscription:write',
    'trust:read', 'trust:write', 'trust:review', 'ai:read', 'audit:read', 'alert:read', 'alert:write',
  ],
  VIEWER: [
    'resource:read', 'source:read', 'pool:read', 'policy:read',
    'gateway:read', 'subscription:read', 'trust:read', 'ai:read', 'audit:read', 'alert:read',
  ],
};

export function scopesForRole(role: UserRole): Set<string> {
  return new Set(ROLE_SCOPES[role]);
}

/**
 * 认证顺序：凭据 → 角色 → scope → 资源归属（API-001 §2.2）。
 * 任何一步失败都返回 401/403，且不泄露资源是否存在。
 */
export async function authenticate(req: FastifyRequest): Promise<Actor> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new AppError('UNAUTHENTICATED', '缺少 Bearer 凭据');
  }
  const token = header.slice(7).trim();

  // API Key：pf_ 前缀
  if (token.startsWith('pf_')) {
    const hash = sha256Hex(token);
    const row = await q1<{
      id: string;
      user_id: string;
      username: string;
      role: UserRole;
      scopes: string[];
      expires_at: string | null;
    }>(
      `SELECT k.id, k.user_id, u.username, u.role, k.scopes, k.expires_at
       FROM api_keys k JOIN proxy_users u ON u.id = k.user_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.enabled = true`,
      [hash],
    );
    if (!row) throw new AppError('UNAUTHENTICATED', 'API Key 无效或已撤销');
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      throw new AppError('UNAUTHENTICATED', 'API Key 已过期');
    }
    void exec('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
    return {
      kind: 'API_KEY',
      id: row.user_id,
      username: row.username,
      role: row.role,
      // scope 必须是角色的子集：交集保证越权配置不会生效
      scopes: new Set(row.scopes.filter((s) => ROLE_SCOPES[row.role].includes(s as Scope))),
    };
  }

  // 会话 JWT
  const claims = verifySession(token);
  if (!claims) throw new AppError('UNAUTHENTICATED', '会话已过期或签名无效');
  return {
    kind: 'USER',
    id: claims.sub,
    username: claims.username,
    role: claims.role,
    scopes: scopesForRole(claims.role),
  };
}

/** 路由守卫：自动挂载 actor 并校验 scope */
export function guard(scope: Scope) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const actor = await authenticate(req);
    req.actor = actor;
    if (!actor.scopes.has(scope)) {
      throw forbidden('FORBIDDEN', `缺少 scope: ${scope}`);
    }
  };
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new AppError('UNAUTHENTICATED', '未认证');
  return req.actor;
}
