import { PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
    // 必须在**构造 PGlite 之前**拦住，不能等打开失败再判断：
    // 第二个实例一旦开始初始化就会写坏 WAL，之后再抛错也已经晚了。
    // 这个坑很贵 —— 现场是"数据库莫名其妙损坏"，而根因只是"忘了先停服务"。
    const holder = dataDirHolder(config.databaseUrl);
    if (holder !== null) throw heldByProcessError(holder, config.databaseUrl);
    acquireInstanceLock(config.databaseUrl);
    instance = await openWithStaleLockRecovery(config.databaseUrl);
  }
  await instance.waitReady;
  return instance;
}

/**
 * 进程级独占锁。
 *
 * 为什么不能只依赖 `postmaster.pid`：那个文件会被 `openWithStaleLockRecovery`
 * 搬到 `.data/stale-locks/`。于是出现过这样的序列 ——
 *   A 启动 → 把上一位留下的 pid 文件搬走 → 正常持有数据库
 *   B 启动 → 目录里已经没有 pid 文件了 → 认为"没人占用" → 也打开了同一个目录
 * 两个 PGlite 各自按自己的 WAL 恢复，一个看到 122 个端点，另一个看到 0 个。
 * 表现出来是"数据忽有忽无"，而两边都不报错。
 *
 * 所以需要一个**我们自己控制、且不会被恢复逻辑搬走**的锁。
 * 用 `wx` 独占创建，内容是 pid；启动时若发现 pid 还活着就拒绝。
 */
const LOCK_FILE = 'proxyforge.lock';

function acquireInstanceLock(dataDir: string): void {
  const lockPath = join(dataDir, LOCK_FILE);
  const holder = lockHolderPid(lockPath);
  if (holder !== null && isAlive(holder)) throw heldByProcessError(holder, dataDir);

  // 陈旧锁（pid 已死）直接覆盖。writeFileSync 用 'w' 是覆盖语义，
  // 这里不需要 wx —— 前面已经确认过没有活着的持有者。
  writeFileSync(lockPath, `${process.pid}\n`);
  process.once('exit', () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* 退出阶段删不掉（比如 safe-delete shim 拦截）不该影响退出 */
    }
  });
}

/** 数据目录是否被一个**活着的**进程占用；是则返回那个 pid */
export function dataDirHolder(dataDir: string): number | null {
  if (dataDir === 'memory://') return null;
  const own = lockHolderPid(join(dataDir, LOCK_FILE));
  if (own !== null && isAlive(own)) return own;
  const pid = lockHolderPid(join(dataDir, 'postmaster.pid'));
  if (pid === null) return null;
  return isAlive(pid) ? pid : null;
}

function heldByProcessError(pid: number, dataDir: string): Error {
  return new Error(
    [
      `数据库被另一个进程占用：${dataDir}`,
      `锁文件指向 pid ${pid}，该进程仍在运行。`,
      '',
      'PGlite 是嵌入式单写者：两个进程同时打开同一数据目录会把 WAL 写坏，',
      '而且损坏之后无法修复（只能 db:reset）。所以这里直接拒绝，不冒险重试。',
      '',
      '先停掉那个进程再继续。查是谁占着：',
      '  netstat -ano | findstr 8081     # 找 API 的 pid',
      '  taskkill /PID <pid>             # 正常停（不要用 /F，强杀会丢 WAL）',
    ].join('\n'),
  );
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
 *
 * 注意这里**只能**修锁文件。WAL 损坏（`could not locate a valid checkpoint
 * record`）是另一类故障，清锁文件救不回来 —— 见 openFailureHint。
 */
async function openWithStaleLockRecovery(dataDir: string): Promise<PGlite> {
  // 初始化失败不会在构造时抛，而是 reject 在 waitReady 上，
  // 所以必须把「构造 + 等待就绪」整体包进一次尝试里。
  const attempt = async (): Promise<PGlite> => {
    const db = new PGlite(dataDir);
    try {
      await db.waitReady;
      return db;
    } catch (err) {
      // waitReady 失败后 wasm 实例已不可用，必须显式释放，
      // 否则重试时会同时存在两个实例抢同一个数据目录。
      await db.close().catch(() => {});
      throw err;
    }
  };

  try {
    return await attempt();
  } catch (err) {
    const locks = ['postmaster.pid', '.s.PGSQL.5432.lock.out', '.s.PGSQL.5432.lock'];
    const present = locks.filter((f) => existsSync(join(dataDir, f)));
    if (present.length === 0) throw openFailureHint(err, dataDir);

    // PGlite 即便 close() 正常退出也会留下 postmaster.pid，
    // 所以"有锁文件"不等于"上次崩了"。真正的判据是里面的 pid 还活着没。
    const holder = lockHolderPid(join(dataDir, 'postmaster.pid'));
    if (holder !== null && isAlive(holder)) {
      throw new Error(
        [
          `数据库被另一个进程占用：${dataDir}`,
          `postmaster.pid 指向 pid ${holder}，该进程仍在运行。`,
          '',
          'PGlite 是单写者，两个进程打开同一数据目录必然崩在 initdb。',
          '先停掉那个进程（npm run dev 是不是还开着？），再启动本进程。',
        ].join('\n'),
      );
    }

    const graveyard = join(dataDir, '..', 'stale-locks');
    mkdirSync(graveyard, { recursive: true });
    const stamp = Date.now();
    for (const f of present) {
      renameSync(join(dataDir, f), join(graveyard, `${f}.${stamp}`));
    }
    // 这是正常路径（正常关闭也会留 pid 文件），不打 warn，
    // 否则每次启动都有一条"崩溃"提示，真正的崩溃反而被淹没。
    console.log(`[db] 清理上次遗留的锁文件（${present.join(', ')}）`);
    try {
      return await attempt();
    } catch (err2) {
      throw openFailureHint(err2, dataDir);
    }
  }
}

/** 读 postmaster.pid 第一行的 pid；文件不存在或内容不是数字返回 null */
function lockHolderPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    const first = readFileSync(pidFile, 'utf8').split('\n')[0]?.trim() ?? '';
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    // signal 0 不发送信号，只做存在性检查
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但无权操作 —— 依然算活着
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 把 PGlite 的 `RuntimeError: Aborted()` 翻译成能照着做的提示。
 *
 * 原始错误只有一句 `Aborted(). Build with -sASSERTIONS for more info.`，
 * 真正的死因（`PANIC: could not locate a valid checkpoint record`）埋在
 * wasm 的 stderr 里，默认看不到。遇到这种情况继续排查方向是错的 ——
 * 数据目录已经回不来了，唯一出路是重置，而人会先在错误信息里找半天。
 */
function openFailureHint(err: unknown, dataDir: string): Error {
  const msg = String((err as Error)?.message ?? err);
  const corrupt = /PANIC|checkpoint|Aborted|invalid|corrupt/i.test(msg);
  if (!corrupt) return err instanceof Error ? err : new Error(msg);
  return new Error(
    [
      `数据库无法打开：${dataDir}`,
      '数据目录的 WAL 已损坏（通常是进程被强杀、写入未落盘导致），无法自动修复。',
      '',
      '处理办法：',
      `  1. 备份现场：mv "${dataDir}" "${dataDir}.corrupt-$(date +%s)"`,
      '  2. 重建：npm run db:reset   （会重新迁移并写入种子数据）',
      '  3. 如果里面有要保留的数据，只能从备份目录人工捞，PGlite 没有离线修复工具。',
      '',
      `底层错误：${msg}`,
    ].join('\n'),
  );
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
  // 主动释放独占锁：正常情况下 exit 钩子也会做，
  // 但 migrate/seed/reset 这类脚本是 closeDb 之后立刻 exit，
  // 留一个死 pid 的锁文件会让下一次启动多一次"陈旧锁"判断。
  if (config.databaseUrl !== 'memory://') {
    try {
      unlinkSync(join(config.databaseUrl, LOCK_FILE));
    } catch {
      /* 没有锁文件或删不掉都不影响正确性 */
    }
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
