import { closeDb, getDb } from './client.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

/**
 * 重建数据库：DROP SCHEMA → 迁移 → 种子。
 * 仅用于开发环境；生产环境绝不允许此脚本出现在部署路径上。
 */
export async function reset(): Promise<void> {
  const db = await getDb();
  console.log('清空 schema…');
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  console.log('重新迁移…');
  await migrate();
  await seed();
}

const entry = process.argv[1];
if (entry?.endsWith('reset.ts') || entry?.endsWith('reset.js')) {
  await reset();
  console.log('完成。');
  await closeDb();
  process.exit(0);
}
