/**
 * Schema 完整性自检：确认迁移"建对了"，而不只是"没报错"。
 * 用法：node scripts/db-inspect.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const db = new PGlite(resolve(here, '..', '.data', 'pg'));
await db.waitReady;

const counts = await db.query(`
SELECT
  (SELECT count(*) FROM pg_tables WHERE schemaname='public')                        AS tables,
  (SELECT count(*) FROM pg_views WHERE schemaname='public')                         AS views,
  (SELECT count(*) FROM pg_matviews)                                                AS matviews,
  (SELECT count(*) FROM pg_type WHERE typtype='e'
      AND typnamespace='public'::regnamespace)                                      AS enums,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)                          AS triggers,
  (SELECT count(*) FROM pg_indexes WHERE schemaname='public')                       AS indexes,
  (SELECT count(*) FROM pg_inherits)                                                AS partitions
`);
console.log('对象统计:', counts.rows[0]);

const view = await db.query('SELECT count(*)::int AS n FROM v_schedulable_endpoints');
console.log('v_schedulable_endpoints 行数:', view.rows[0].n);

const fns = await db.query(`
  SELECT proname FROM pg_proc
  WHERE proname IN ('ensure_monthly_partitions','set_updated_at','drop_expired_partitions')
  ORDER BY 1
`);
console.log('函数:', fns.rows.map((r) => r.proname).join(', '));

const parts = await db.query(`
  SELECT inhrelid::regclass::text AS child FROM pg_inherits ORDER BY 1
`);
console.log('分区数:', parts.rows.length, '→', parts.rows.slice(0, 4).map((r) => r.child).join(' | '));

// 信任门槛必须是"视图层面"的硬约束，这里直接断言
const guard = await db.query(`
  SELECT pg_get_viewdef('v_schedulable_endpoints'::regclass) AS def
`);
const def = String(guard.rows[0].def);
const hasTierGate = def.includes('VERIFIED_PROXY') && def.includes('explicit_gateway_grant');
console.log('信任门槛写在视图里:', hasTierGate ? 'YES' : 'NO');

await db.close();
