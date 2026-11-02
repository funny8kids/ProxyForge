import { pathToFileURL } from 'node:url';
import { loadMigrationFiles } from '../config.js';
import { closeDb, exec, getDb, q } from './client.js';

/**
 * 迁移执行器。
 * 每个迁移文件自带 BEGIN/COMMIT（与 schema-v1.sql 的既有约定一致），
 * 因此这里不额外包裹事务，避免嵌套 BEGIN 导致 COMMIT 提前释放外层事务。
 */
export async function migrate(verbose = true): Promise<{ applied: string[]; skipped: string[] }> {
  const db = await getDb();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  const done = new Map(
    (await q<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).map(
      (r) => [r.name, r.checksum] as const,
    ),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of loadMigrationFiles()) {
    if (done.has(file.name)) {
      /**
       * 已应用的文件被改过 —— 必须喊出来。
       *
       * 记录的是 `sql.length` 而不是真哈希（历史原因），所以它只能发现
       * "长度变了"这一种情况，但那一已经够用了：开发模式下保存 .sql 会
       * 触发 `tsx watch` 热重启，而重启会跑迁移。文件写到一半就被应用、
       * 记进 schema_migrations，之后补齐的内容永远不会生效 ——
       * 而且没有任何报错。
       *
       * 实际踩过：0016 在"只写了 ALTER + INDEX、还没写视图"的中间状态
       * 被应用（记录 800 字符）。补上视图之后列存在、视图却是旧的，
       * 订阅接口报 `column v.connect_ok does not exist`，排查了半天。
       *
       * 只告警不抛错：抛错会让开发环境彻底起不来，而正确的修法是
       * 新建一个迁移版本号，不是阻止启动。
       */
      const recorded = done.get(file.name);
      const current = String(file.sql.length);
      if (recorded !== current) {
        console.warn(
          `  ! ${file.name} 已应用，但文件内容与记录不符（记录 ${recorded} 字符，当前 ${current} 字符）。` +
            '迁移是只进不退的 —— 改动请新建一个迁移文件，否则改动不会生效。',
        );
      }
      skipped.push(file.name);
      continue;
    }
    const t0 = performance.now();
    try {
      await db.exec(file.sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`迁移失败 ${file.name}: ${msg}`);
    }
    await exec('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
      file.name,
      String(file.sql.length),
    ]);
    applied.push(file.name);
    if (verbose) {
      console.log(`  ✓ ${file.name} (${Math.round(performance.now() - t0)}ms)`);
    }
  }

  return { applied, skipped };
}

// 直接执行时作为 CLI 使用
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  console.log('运行迁移…');
  const res = await migrate();
  console.log(`完成：应用 ${res.applied.length} 个，跳过 ${res.skipped.length} 个`);
  // 必须关库再退出：PGlite 是嵌入式 Postgres，直接 exit 会丢 WAL 尾巴，
  // 下次启动就是 could not locate a valid checkpoint record，只能删库重建。
  await closeDb();
  process.exit(0);
}
