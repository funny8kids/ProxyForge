/**
 * PostgreSQL 数组列的归一化。
 *
 * 为什么需要这一层：
 *   `trust_tier[]` / `proxy_protocol[]` 是自定义 ENUM 数组。驱动按 OID 决定
 *   要不要走数组解析器，而 ENUM 数组的 OID 不在内置映射表里，于是同一个列
 *   有时返回 string[]，有时返回 PG 字面量字符串 "{PRIVATE_PROXY}"。
 *
 *   这不是纯粹的洁癖问题。编译策略时用 `filters.length > 0` 判断"有没有过滤
 *   条件"——字符串 "{...}" 的 length 恒大于 0，于是给查询加上了一个空集合
 *   过滤，静默编译出 0 个成员，界面上只显示"池是空的"。所以必须在这里
 *   收敛成确定类型，而不是在调用点各写各的防御。
 */

/** 把可能是数组、可能是 PG 字面量字符串、可能是 null 的值收敛成 string[] */
export function toTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value !== 'string') return [];

  const s = value.trim();
  if (s === '' || s === '{}') return [];
  if (!s.startsWith('{')) return [s]; // 裸标量，容错处理

  // 处理带引号/转义的数组字面量：{"a,b","c\"d"}
  const inner = s.slice(1, -1);
  const out: string[] = [];
  let buf = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quoted) {
      if (ch === '\\' && i + 1 < inner.length) {
        buf += inner[i + 1];
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        buf += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out.filter((x) => x !== '');
}
