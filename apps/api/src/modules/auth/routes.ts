import type { FastifyInstance } from 'fastify';
import { q1, exec } from '../../db/client.js';
import { AppError } from '../../shared/errors.js';
import { verifyPassword } from '../../shared/crypto.js';
import { signSession } from '../../shared/jwt.js';
import { authenticate, scopesForRole } from './index.js';
import { audit } from '../../shared/events.js';
import { uuidv7 } from '../../shared/id.js';
import type { UserRole } from '@proxyforge/contracts';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req) => {
    const body = req.body as { username?: string; password?: string };
    if (!body?.username || !body?.password) {
      throw new AppError('INVALID_ARGUMENT', 'username 与 password 必填');
    }

    const user = await q1<{
      id: string; username: string; password_hash: string; role: UserRole; enabled: boolean;
    }>(
      'SELECT id, username, password_hash, role, enabled FROM proxy_users WHERE lower(username) = lower($1)',
      [body.username],
    );

    // 统一错误信息，不区分"用户不存在"与"密码错误"
    if (!user || !user.enabled || !verifyPassword(body.password, user.password_hash)) {
      throw new AppError('UNAUTHENTICATED', '用户名或密码错误');
    }

    const { token, expiresIn } = signSession({
      sub: user.id,
      username: user.username,
      role: user.role,
      jti: uuidv7(),
    });

    await exec('UPDATE proxy_users SET last_login_at = now() WHERE id = $1', [user.id]);
    await audit(
      { q: async () => [], q1: async () => null, exec: async (s, p) => exec(s, p) },
      {
        actorType: 'USER',
        actorId: user.id,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
      },
    );

    return {
      accessToken: token,
      expiresIn,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        scopes: [...scopesForRole(user.role)],
      },
    };
  });

  app.get('/auth/me', async (req) => {
    const actor = await authenticate(req);
    return {
      id: actor.id,
      username: actor.username,
      role: actor.role,
      scopes: [...actor.scopes],
      credential: actor.kind,
    };
  });
}
