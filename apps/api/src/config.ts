import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根目录：apps/api/src -> ../../.. */
export const REPO_ROOT = resolve(here, '../../..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

export const config = {
  port: Number(process.env.PORT ?? 8081),
  host: process.env.HOST ?? '127.0.0.1',
  /** PGlite 数据目录；设为 memory:// 则用内存库（测试用） */
  databaseUrl: process.env.DATABASE_URL ?? join(REPO_ROOT, '.data', 'pg'),
  /** 主密钥（信封加密）。生产必须来自 KMS / 环境注入，绝不能有默认值 */
  masterKey: process.env.PF_MASTER_KEY ?? 'dev-only-master-key-do-not-use-in-prod',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Worker 轮询间隔 */
  outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 500),
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 15000),
  /** 是否允许 AI 供应商访问内网（本地 Ollama 场景，需 ADMIN） */
  allowPrivateAiNetwork: process.env.PF_ALLOW_PRIVATE_AI === 'true',
  /**
   * Worker 运行模式。
   *
   * PGlite 是嵌入式单写者：同一 data 目录被两个进程打开会直接
   * `RuntimeError: Aborted()` 崩在 initdb。所以本地默认 embedded，
   * 把 worker 循环挂在 API 进程里跑。
   *
   * 换成真 PostgreSQL 后设 PF_WORKER_MODE=process，worker 恢复为独立进程，
   * 靠 FOR UPDATE SKIP LOCKED 并行认领——代码路径完全一致，差别只在谁持有连接。
   */
  workerMode: (process.env.PF_WORKER_MODE ?? 'embedded') as 'embedded' | 'process',
} as const;

export function loadMigrationFiles(): Array<{ name: string; sql: string }> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
  }));
}
