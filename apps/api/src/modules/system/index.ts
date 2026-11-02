import type { FastifyInstance } from 'fastify';
import type { SystemStatus } from '@proxyforge/contracts';
import { exec, ping, q1 } from '../../db/client.js';
import { guard } from '../auth/index.js';
import { PROBE_MODE } from '../verification/index.js';
import { workerHealth } from '../../worker/main.js';

const STARTED_AT = Date.now();

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/system/status', { preHandler: guard('resource:read') }, async (): Promise<SystemStatus & { probeMode: string }> => {
    const db = await ping();

    const gw = await q1<{ status: string; active_config_version: number | null }>(
      'SELECT status, active_config_version FROM gateway_instances ORDER BY created_at ASC LIMIT 1',
    );

    const outbox = await q1<{ pending: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE published_at IS NULL)::text AS pending,
              count(*) FILTER (WHERE attempts >= 5 AND published_at IS NULL)::text AS failed
       FROM event_outbox`,
    );

    const hb = await q1<{ last_heartbeat_at: string | null }>(
      'SELECT max(last_heartbeat_at)::text AS last_heartbeat_at FROM proxy_nodes',
    );

    return {
      version: '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      db,
      gateway: {
        status: (gw?.status as SystemStatus['gateway']['status']) ?? 'UNKNOWN',
        configVersion: gw?.active_config_version ?? null,
      },
      outbox: {
        pending: Number(outbox?.pending ?? 0),
        failed: Number(outbox?.failed ?? 0),
      },
      worker: {
        lastHeartbeatAt: hb?.last_heartbeat_at ?? null,
        // 进程内统计：PF_WORKER_MODE=process 时本进程不跑 worker，这里会是 0。
        ...workerHealth(),
      },
      // 进程边界自检：三平面在单进程内用模块边界模拟，Phase 2 拆为独立进程
      planes: { control: true, data: true, intelligence: true },
      probeMode: PROBE_MODE,
    };
  });

  /**
   * 主动刷盘。
   *
   * 存在的理由很具体：PGlite 把 WAL 写缓冲放在 wasm 侧，进程被**强杀**
   * （`taskkill /F`、容器 OOM、Windows 上停后台任务）时最后一段 WAL 会丢，
   * 而 `pg_control` 已经指向它 —— 下次启动就是
   * `PANIC: could not locate a valid checkpoint record`，整个数据目录报废。
   * 本地已经因为这个错误重建过五次库。
   *
   * CHECKPOINT 会强制刷脏页并写下一条可恢复的检查点记录。在重启、
   * 备份、迁移这类"马上要动它"的操作之前调一次，能把丢失窗口压到零。
   * worker 每 15 秒也会做一次，但强杀随时可能落在那 15 秒里。
   */
  app.post('/system/db/checkpoint', { preHandler: guard('system:admin') }, async () => {
    const started = Date.now();
    await exec('CHECKPOINT');
    return { ok: true, elapsedMs: Date.now() - started };
  });
}
