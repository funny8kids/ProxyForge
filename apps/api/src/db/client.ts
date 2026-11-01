import { PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

let instance: PGlite | null = null;

/**
 * 单进程单连接。PGlite 是 PostgreSQL 16 的 WASM 构建，
 * 因此 ENUM / 分区表 / 部分索引 / plpgsql 触发器 / 视图全部是真实语义，
 * 不存在"H2 兼容模式静默吞掉 DDL"的问题。
 *
 * 生产切到真 PG 时，只需把这里换成 pg.Pool，其余查询代码零改动。
 */
export async function getDb(): Promise<PGlite> {
  if (instance) return instance;

  if (config.databaseUrl === 'memory://') {
    instance = new PGlite();
  } else {
    mkdirSync(config.databaseUrl, { recursive: true });
    instance = await openWithStaleLockRecovery(config.databaseUrl);
  }
  await instance.waitReady;
  return instance;
}

/**
 * 崩溃自愈。
 *
 * 进程被强杀后 PGlite 会留下 postmaster.pid 与 unix socket 锁文件，
 * 下次启动 postmaster 读到失效 pid 直接 RuntimeError: Aborted()，
 * 而报错信息完全看不出是锁文件的问题。
 *
 * 策略是「先正常开，失败才清理，且只清理一次」——
 * 不做启动前无条件删除，因为那会在真有进程持有时破坏现场。
 * 被移开的文件保留在 .data/stale-locks/ 下，不删，便于事后取证。
 */
async function openWithStaleLockRecovery(dataDir: string): Promise<PGlite> {
  // 初始化失败不会在构造时抛，而是 reject 在 waitReady 上，
  // 所以必须把「构造 + 等待就绪」整体包进一次尝试里。
  const attempt = async (): Promise<PGlite> => {
    const db = new PGlite(dataDir);
    await db.waitReady;
    return db;
  };

  try {
    return await attempt();
  } catch (err) {
    const locks = ['postmaster.pid', '.s.PGSQL.5432.lock.out', '.s.PGSQL.5432.lock'];
    const present = locks.filter((f) => existsSync(join(dataDir, f)));
    if (present.length === 0) throw err;

    const graveyard = join(dataDir, '..', 'stale-locks');
    mkdirSync(graveyard, { recursive: true });
    const stamp = Date.now();
    for (const f of present) {
      renameSync(join(dataDir, f), join(graveyard, `${f}.${stamp}`));
    }
    console.warn(
      `[db] 检测到崩溃残留锁文件（${present.join(', ')}），已移至 ${graveyard}，重试打开`,
    );
    return attempt();
  }
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

/** 查询并返回行数组 */
export async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const db = await getDb();
  const res = await db.query<T>(sql, params as never[]);
  return res.rows;
}

/** 查询单行，无结果返回 null */
export async function q1<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

/** 执行写操作，返回受影响行数 */
export async function exec(sql: string, params: unknown[] = []): Promise<number> {
  const db = await getDb();
  const res = await db.query(sql, params as never[]);
  return res.affectedRows ?? 0;
}

/** 事务：回调内抛错则整体回滚 */
export async function tx<T>(fn: (t: TxLike) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(async (t) => {
    const wrapper: TxLike = {
      q: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const res = await t.query<R>(sql, params as never[]);
        return res.rows;
      },
      q1: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const res = await t.query<R>(sql, params as never[]);
        return res.rows[0] ?? null;
      },
      exec: async (sql: string, params: unknown[] = []) => {
        const res = await t.query(sql, params as never[]);
        return res.affectedRows ?? 0;
      },
    };
    return fn(wrapper);
  }) as Promise<T>;
}

export interface TxLike {
  q<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  q1<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R | null>;
  exec(sql: string, params?: unknown[]): Promise<number>;
}

/** 简易健康检查，返回往返延迟 */
export async function ping(): Promise<{ ok: boolean; latencyMs: number }> {
  const t0 = performance.now();
  try {
    await q('SELECT 1 AS ok');
    return { ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - t0) };
  }
}
