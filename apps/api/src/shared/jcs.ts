/**
 * RFC 8785 — JSON Canonicalization Scheme (JCS)
 *
 * 为什么必须规范化：订阅签名签的是"规范化 JSON"，不是 YAML 字节流。
 * YAML 序列化不唯一（键序、缩进、引号风格都可能变），签字节流必然在
 * 不同客户端上验签失败。详见 SEC-001 §6.4.2 与 ADR-0009。
 *
 * 本实现遵循 RFC 8785：
 *   - 对象键按 UTF-16 码元序升序排列
 *   - 无任何空白
 *   - 数字用 ECMAScript Number::toString 语义（JSON.stringify 即是）
 *   - 字符串用 JSON 最小转义
 */
export function canonicalize(value: unknown): string {
  return write(value);
}

function write(v: unknown): string {
  if (v === null || v === undefined) return 'null';

  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';

  if (t === 'number') {
    const n = v as number;
    if (!Number.isFinite(n)) {
      throw new TypeError('JCS: 非有限数值不可序列化');
    }
    // -0 在 ES 序列化中为 "0"
    return JSON.stringify(Object.is(n, -0) ? 0 : n);
  }

  if (t === 'bigint') {
    const n = v as bigint;
    if (n > Number.MAX_SAFE_INTEGER || n < Number.MIN_SAFE_INTEGER) {
      throw new TypeError('JCS: 超出安全整数范围的 bigint 不可序列化');
    }
    return n.toString();
  }

  if (t === 'string') return JSON.stringify(v);

  if (Array.isArray(v)) {
    return `[${v.map((item) => write(item)).join(',')}]`;
  }

  if (t === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort(compareCodeUnits);
    const parts: string[] = [];
    for (const k of keys) {
      const val = obj[k];
      // undefined 字段按 RFC 8785 视为不存在
      if (val === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${write(val)}`);
    }
    return `{${parts.join(',')}}`;
  }

  throw new TypeError(`JCS: 不支持的类型 ${t}`);
}

/** UTF-16 码元序比较（RFC 8785 §3.2.3） */
function compareCodeUnits(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}
