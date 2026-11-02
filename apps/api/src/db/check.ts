import { PGlite } from '@electric-sql/pglite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { closeDb, dataDirHolder } from './client.js';

/**
 * 数据目录体检。
 *
 * 存在理由：PGlite 是嵌入式 Postgres，进程被强杀时 WAL 尾巴会丢，
 * 下次启动报 `RuntimeError: Aborted()` —— 这句话对排查毫无帮助，
 * 而真正的原因（`PANIC: could not locate a valid checkpoint record`）
 * 埋在 wasm 的 stderr 里，默认看不到。
 *
 * 这个脚本做三件事：
 *   1. 只读地看一眼目录（大小、WAL 段数、残留锁文件）
 *   2. 尝试打开并查询，失败时给出可执行的下一步
 *   3. 打开成功则打印关键表的行数，用来确认"迁移和种子真的进去了"
 *
 * 跑法：npm run db:check
 */

const dataDir = config.databaseUrl;

function human(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
    } catch {
      /* 权限/竞态：跳过，体检不该因为一个文件读不到就失败 */
    }
  }
  return total;
}

console.log('');
console.log(`数据目录：${dataDir}`);

if (config.databaseUrl === 'memory://') {
  console.log('内存模式（memory://），无需体检。');
  process.exit(0);
}

if (!existsSync(join(dataDir, 'PG_VERSION'))) {
  console.log('状态：尚未初始化（没有 PG_VERSION）。首次启动或 npm run db:migrate 会自动建库。');
  process.exit(0);
}

const locks = ['postmaster.pid', '.s.PGSQL.5432.lock.out', '.s.PGSQL.5432.lock'].filter((f) =>
  existsSync(join(dataDir, f)),
);
const walDir = join(dataDir, 'pg_wal');
const walSegments = existsSync(walDir) ? readdirSync(walDir).filter((f) => /^[0-9A-F]{24}$/.test(f)) : [];

console.log(`体积：${human(dirSize(dataDir))}`);
console.log(`WAL 段：${walSegments.length} 个${walSegments.length ? `（最新 ${walSegments.sort().at(-1)}）` : ''}`);
console.log(`残留锁：${locks.length ? locks.join(', ') + '（下次启动会被自动移走）' : '无'}`);

try {
  // 体检要拿到**原始**失败原因，所以不走 getDb（它会改写现场）。
  // 但"有没有别的进程占着"必须先查 —— 直接 new PGlite 打开一个正在被
  // 服务使用的目录，会把 WAL 写坏。体检工具不该造成它要诊断的故障。
  const holder = dataDirHolder(dataDir);
  if (holder !== null) {
    console.log(`状态：被进程 ${holder} 占用`);
    console.log('');
    console.log('PGlite 是单写者，服务运行时不能体检（会写坏 WAL）。');
    console.log('先停服务再跑：');
    console.log('  netstat -ano | findstr 8081   # 找 pid');
    console.log('  taskkill /PID <pid>           # 正常停，不要 /F');
    process.exit(1);
  }

  const db = new PGlite(dataDir);
  await db.waitReady;
  const counts = await db.query<{ t: string; n: number }>(
    `SELECT 'proxy_endpoints' AS t, count(*)::int AS n FROM proxy_endpoints
     UNION ALL SELECT 'resource_pools', count(*)::int FROM resource_pools
     UNION ALL SELECT 'subscriptions', count(*)::int FROM subscriptions
     UNION ALL SELECT 'gateway_instances', count(*)::int FROM gateway_instances
     UNION ALL SELECT 'ai_usage_records', count(*)::int FROM ai_usage_records
     UNION ALL SELECT 'schema_migrations', count(*)::int FROM schema_migrations`,
  );
  const version = await db.query<Record<string, string>>('SHOW server_version');
  const ver = Object.values(version.rows[0] ?? {})[0] ?? '?';
  console.log(`状态：正常（PostgreSQL ${ver}）`);
  console.log('');
  for (const r of counts.rows) console.log(`  ${r.t.padEnd(20)} ${r.n}`);
  await db.close();
  console.log('');
  console.log('可以启动：npm run dev');
  process.exit(0);
} catch (err) {
  const msg = String((err as Error)?.message ?? err);
  console.log(`状态：无法打开 — ${msg}`);
  console.log('');
  if (/PANIC|checkpoint|Aborted|corrupt/i.test(msg)) {
    console.log('诊断：WAL 损坏，数据目录已不可用（通常是进程被强杀导致）。');
    console.log('PGlite 没有离线修复工具，只能重建：');
    console.log(`  1. mv "${dataDir}" "${dataDir}.corrupt"`);
    console.log('  2. npm run db:reset');
    console.log('如果里面有要保留的数据，只能从 .corrupt 目录人工捞。');
  } else {
    console.log('诊断：不是已知的 WAL 损坏。先确认没有第二个进程在写同一个目录');
    console.log('（PGlite 是单写者，双开必然崩），再试 npm run db:check。');
  }
  // 体检自己不该占着库：万一 partial open 成功过，释放掉
  await closeDb().catch(() => {});
  process.exit(1);
}
