import { invalid } from './errors.js';

/** 游标分页：编码最后一条的排序键，避免深翻页 offset 退化 */
export interface Cursor {
  /** 排序键值 */
  k: string | number;
  /** 次级键（通常是 id），保证唯一稳定 */
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'k' in parsed &&
      'id' in parsed &&
      (typeof (parsed as Cursor).k === 'string' || typeof (parsed as Cursor).k === 'number')
    ) {
      return parsed as Cursor;
    }
    throw new Error('shape');
  } catch {
    throw invalid('cursor 格式非法', [{ field: 'cursor', message: '无法解析的分页游标' }]);
  }
}

export function parseLimit(raw: unknown, def = 50, max = 200): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw invalid('limit 必须是正整数', [{ field: 'limit', message: String(raw) }]);
  }
  return Math.min(n, max);
}

/** 逗号分隔的多值参数 -> 大写枚举数组，非法值直接报错并指出字段 */
export function parseEnumList<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): T[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const bad = parts.filter((p) => !allowed.includes(p as T));
  if (bad.length > 0) {
    throw invalid(`${field} 含非法枚举值`, bad.map((b) => ({ field, message: b })));
  }
  return parts as T[];
}
