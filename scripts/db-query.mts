import { closeDb, q } from '../apps/api/src/db/client.js';

/**
 * 一次性 SQL 查询。
 *
 * 存在的理由不是"方便"，而是**安全**：随手写的临时脚本最常见的写法是
 * `db.query(...)` 之后直接 `process.exit(0)`，而 PGlite 是嵌入式 Postgres ——
 * 不 close 就退出，未落盘的 WAL 尾巴直接丢，下次启动报
 * `PANIC: could not locate a valid checkpoint record`，整个数据目录报废，
 * 只能 db:reset。这个坑已经踩过两次，所以把"开库 → 查询 → 关库"固化下来。
 *
 * 用法：
 *   npm run db:query -- "SELECT count(*) FROM proxy_endpoints"
 *   npm run db:query -- "SELECT * FROM subscriptions LIMIT 3"
 *
 * 只允许只读语句。写操作请走迁移或种子 —— 临时改数会让"库里为什么是这样"
 * 变成一个无法复现的问题。
 */

const sql = process.argv.slice(2).join(' ').trim();
if (!sql) {
  console.error('用法：npm run db:query -- "SELECT ..."');
  process.exit(1);
}

if (!/^\s*(select|with|show|explain)\b/i.test(sql)) {
  console.error('只允许只读语句（SELECT / WITH / SHOW / EXPLAIN）。');
  console.error('要改数据请写迁移或改 seed，不要临时 UPDATE。');
  process.exit(1);
}

try {
  const rows = await q<Record<string, unknown>>(sql);
  if (rows.length === 0) {
    console.log('(0 行)');
  } else {
    // 用表格打印：JSON 一坨在终端里读不动，而这里最常见的用途是
    // "到底有几条、字段叫什么"
    const cols = Object.keys(rows[0]!);
    const widths = cols.map((c) =>
      Math.min(48, Math.max(c.length, ...rows.map((r) => fmt(r[c]).length))),
    );
    const line = (cells: string[]): string =>
      cells.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd();
    console.log(line(cols));
    console.log(line(widths.map((w) => '─'.repeat(w))));
    for (const r of rows) console.log(line(cols.map((c) => fmt(r[c]))));
    console.log(`\n(${rows.length} 行)`);
  }
} catch (err) {
  console.error('查询失败：', (err as Error).message);
  await closeDb();
  process.exit(1);
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 48);
  return String(v);
}

// 关键的一步：先关库再退出
await closeDb();
process.exit(0);
