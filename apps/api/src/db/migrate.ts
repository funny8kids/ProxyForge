import { pathToFileURL } from 'node:url';
import { loadMigrationFiles } from '../config.js';
import { exec, getDb, q } from './client.js';

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

  const done = new Set(
    (await q<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of loadMigrationFiles()) {
    if (done.has(file.name)) {
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
  process.exit(0);
}
