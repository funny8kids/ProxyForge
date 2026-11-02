import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根目录：apps/api/src -> ../../.. */
export const REPO_ROOT = resolve(here, '../../..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

/**
 * 加载仓库根目录的 `.env`。
 *
 * 用 Node 22 内置的 `process.loadEnvFile`，不引 dotenv —— 少一个依赖，
 * 而且它不覆盖已存在的环境变量，和「命令行显式指定优先」的直觉一致。
 * 文件不存在是正常情况（.env 被 gitignore），不能让启动失败。
 */
try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch {
  // 没有 .env，全部走下面的默认值
}

/**
 * 解析数据库位置。
 *
 * `.env` 里写的是 `DATABASE_URL=.data/pg` 这种相对路径，而各条命令的工作目录
 * 并不一致：`npm run db:reset` 经 `npm -w @proxyforge/api` 跑时 cwd 是 apps/api，
 * `scripts/dev.mjs` 起 API 时 cwd 是仓库根。相对路径按 cwd 解析会让两条命令
 * 打开**两个不同的数据库** —— 迁移写进 A，服务读 B，表现出来就是"迁移明明跑了，
 * 但代码里查不到新表"。
 *
 * 所以：相对路径一律相对仓库根解析，`memory://` 和绝对路径原样透传。
 */
function resolveDatabaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return join(REPO_ROOT, '.data', 'pg');
  if (value.startsWith('memory://')) return value;
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}

export const config = {
  port: Number(process.env.PORT ?? 8081),
  host: process.env.HOST ?? '127.0.0.1',
  /** PGlite 数据目录；设为 memory:// 则用内存库（测试用） */
  databaseUrl: resolveDatabaseUrl(process.env.DATABASE_URL),
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
