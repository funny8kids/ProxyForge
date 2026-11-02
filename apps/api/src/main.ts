import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { AppError } from './shared/errors.js';
import type { ProblemDetail } from '@proxyforge/contracts';

import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerResourceRoutes } from './modules/resource/index.js';
import { registerSourceRoutes } from './modules/source/index.js';
import { registerVerificationRoutes } from './modules/verification/index.js';
import { registerPoolRoutes } from './modules/pool/index.js';
import { registerPolicyRoutes } from './modules/policy/index.js';
import { registerGatewayRoutes } from './modules/gateway/index.js';
import { registerSubscriptionRoutes } from './modules/subscription/index.js';
import { registerTrustRoutes } from './modules/trust/index.js';
import { registerAnalyticsRoutes } from './modules/analytics/index.js';
import { registerAuditRoutes } from './modules/audit/index.js';
import { registerAiRoutes } from './modules/ai/index.js';
import { registerSystemRoutes } from './modules/system/index.js';

export async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({
    logger: { level: config.logLevel },
    genReqId: () => randomUUID(),
    bodyLimit: 12 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    exposedHeaders: [
      'X-Request-Id',
      'X-PF-Signature-Alg',
      'X-PF-Key-Id',
      'X-PF-Signature-Version',
      'X-PF-Revision',
      'X-PF-Issued-At',
      'X-PF-Expires-At',
      'X-PF-Canonical-Hash',
      'X-PF-Signature',
      'ETag',
    ],
  });

  // 请求追踪
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  // 统一错误出口：RFC 9457。绝不返回 SQL / 堆栈 / 内部路径。
  app.setErrorHandler((rawErr, req, reply) => {
    const requestId = String(req.id);
    const err = rawErr as Error & { statusCode?: number };

    if (err instanceof AppError) {
      return reply.status(err.status).send(err.toProblem(requestId, req.url));
    }

    // 数据库约束：转成可读的业务错误，而不是把 PG 报错原样吐出去
    const msg = err.message ?? '';
    if (msg.includes('ck_endpoint_public_never_granted')) {
      const pd: ProblemDetail = {
        type: 'https://proxyforge.dev/errors/public-proxy-gateway-forbidden',
        title: 'Public proxy cannot be granted gateway access',
        status: 422,
        code: 'PUBLIC_PROXY_GATEWAY_FORBIDDEN',
        requestId,
        detail: '公开代理永远不能获得网关授权（SEC-001 §6.2.6）',
      };
      return reply.status(422).send(pd);
    }
    if (msg.includes('uq_') || msg.includes('duplicate key')) {
      return reply.status(409).send({
        type: 'https://proxyforge.dev/errors/duplicate-key',
        title: 'Duplicate key',
        status: 409,
        code: 'DUPLICATE_KEY',
        requestId,
        detail: '唯一键冲突',
      } satisfies ProblemDetail);
    }
    if (msg.includes('ck_promo_approved_needs_reviewer')) {
      return reply.status(403).send({
        type: 'https://proxyforge.dev/errors/self-review-forbidden',
        title: 'Self review forbidden',
        status: 403,
        code: 'SELF_REVIEW_FORBIDDEN',
        requestId,
        detail: '批准晋升建议必须记录复核人',
      } satisfies ProblemDetail);
    }
    if (msg.includes('VERSION_CONFLICT')) {
      return reply.status(409).send({
        type: 'https://proxyforge.dev/errors/version-conflict',
        title: 'Version conflict',
        status: 409,
        code: 'VERSION_CONFLICT',
        requestId,
      } satisfies ProblemDetail);
    }

    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, '未处理异常');
    }
    return reply.status(status).send({
      type: 'https://proxyforge.dev/errors/internal',
      title: status >= 500 ? 'Internal error' : 'Invalid argument',
      status,
      code: status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT',
      requestId,
      // 5xx 不暴露细节
      detail: status >= 500 ? undefined : err.message,
    } satisfies ProblemDetail);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      type: 'https://proxyforge.dev/errors/not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      requestId: String(req.id),
    } satisfies ProblemDetail);
  });

  await app.register(
    async (scope) => {
      await registerAuthRoutes(scope);
      await registerResourceRoutes(scope);
      await registerSourceRoutes(scope);
      await registerVerificationRoutes(scope);
      await registerPoolRoutes(scope);
      await registerPolicyRoutes(scope);
      await registerGatewayRoutes(scope);
      await registerSubscriptionRoutes(scope);
      await registerTrustRoutes(scope);
      await registerAnalyticsRoutes(scope);
      await registerAuditRoutes(scope);
      await registerAiRoutes(scope);
      await registerSystemRoutes(scope);
    },
    { prefix: '/api/v1' },
  );

  app.get('/health', async () => ({ ok: true }));

  return app;
}

// CLI 入口
const entry = process.argv[1];
const isMain = entry?.endsWith('main.ts') || entry?.endsWith('main.js');
if (isMain) {
  await migrate();
  // 启动时把环境变量里的 AI 密钥注入（幂等）。不这样做的话，
  // 改密钥就得跑一次 db:reset —— 而 reset 会清掉全部真实采集数据。
  const { bootstrapAiFromEnv } = await import('./db/bootstrap-ai.js');
  const aiBootstrap = await bootstrapAiFromEnv();
  for (const r of aiBootstrap) {
    if (r.applied) console.log(`  ✓ AI 密钥：${r.providerKey} — ${r.detail}`);
  }
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  console.log(`ProxyForge API → http://${config.host}:${config.port}/api/v1`);

  // 把网关实例真正拉起来。不做这一步，编译好的配置就只是库里的一行 YAML，
  // 端口上没有任何东西在监听。
  const { startAllRuntimes, stopAllRuntimes } = await import('./modules/gateway/runtime.js');
  for (const r of await startAllRuntimes()) {
    const mark = r.state === 'RUNNING' ? '✓' : '·';
    console.log(`  ${mark} 网关 ${r.name}：${r.state} — ${r.detail}`);
  }

  // PGlite 是嵌入式单写者，第二个进程打开同一 data 目录会直接崩在 initdb。
  // 因此本地默认把 worker 循环挂在本进程内；换真 PG 后设 PF_WORKER_MODE=process
  // 即可恢复独立进程形态，代码路径不变。
  let stopWorker: (() => void) | null = null;
  if (config.workerMode === 'embedded') {
    const { startWorker } = await import('./worker/main.js');
    stopWorker = startWorker();
  }

  /**
   * 优雅退出。
   *
   * 这里必须 **closeDb()**：PGlite 是嵌入式 Postgres，`process.exit()` 时
   * 未落盘的 WAL 尾巴直接丢掉，下次启动会以
   * `PANIC: could not locate a valid checkpoint record` 崩掉，且无法修复 ——
   * 只能删库重建。之前只在 embedded 模式注册处理器、且退出前不关库，
   * 等于每次 Ctrl-C 都在赌运气。
   *
   * 顺序也有讲究：先停 worker（它还在写库），再停网关（它在写文件/端口），
   * 最后关库。反过来会出现"关库之后 worker 还在跑 SQL"的报错噪音。
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[api] 收到 ${signal}，正在停止…`);
    void (async () => {
      try {
        stopWorker?.();
      } catch { /* 停 worker 失败不应阻断关库 */ }
      try {
        await stopAllRuntimes();
      } catch { /* 同上 */ }
      try {
        const { closeDb } = await import('./db/client.js');
        await closeDb();
        console.log('[api] 数据库已正常关闭');
      } catch (err) {
        console.error('[api] 关闭数据库失败：', err);
      }
      process.exit(0);
    })();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => shutdown(sig));
  }
}
