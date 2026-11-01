import { randomBytes, randomUUID } from 'node:crypto';

/**
 * UUIDv7：时间有序，索引友好。
 * 布局：48 bit 毫秒时间戳 | 4 bit 版本(7) | 12 bit rand_a | 2 bit variant | 62 bit rand_b
 *
 * rand_a 用同毫秒单调递增计数器，而不是纯随机。
 * 纯随机会让同一毫秒内生成的 id 互相乱序——RFC 9562 里这叫"丢失 k-可排序性"，
 * 后果是 ORDER BY id 不再等于插入顺序。多处代码（默认网关实例选取、游标分页）
 * 都依赖这个性质，所以必须补计数器。
 */
let lastMs = 0;
let seq = 0;

export function uuidv7(): string {
  let ms = Date.now();

  if (ms > lastMs) {
    lastMs = ms;
    seq = 0;
  } else {
    // 同一毫秒（或时钟回拨）：时间戳不前进，靠计数器保证递增
    ms = lastMs;
    seq += 1;
    if (seq > 0x0fff) {
      // 12 bit 用尽（单毫秒 4096 个），借下一毫秒
      lastMs += 1;
      ms = lastMs;
      seq = 0;
    }
  }

  const buf = randomBytes(16);

  buf[0] = Math.floor(ms / 2 ** 40) & 0xff;
  buf[1] = Math.floor(ms / 2 ** 32) & 0xff;
  buf[2] = Math.floor(ms / 2 ** 24) & 0xff;
  buf[3] = Math.floor(ms / 2 ** 16) & 0xff;
  buf[4] = Math.floor(ms / 2 ** 8) & 0xff;
  buf[5] = ms & 0xff;

  buf[6] = 0x70 | ((seq >> 8) & 0x0f); // version 7 + rand_a 高 4 位
  buf[7] = seq & 0xff; // rand_a 低 8 位
  buf[8] = (buf[8]! & 0x3f) | 0x80; // variant RFC 4122

  const hex = buf.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export { randomUUID };

/** 32 字节高熵不透明 token，base64url 无填充 */
export function opaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

/** 稳定的 key 生成：中文名也能得到可读 slug，兜底用短随机串 */
export function slugify(input: string, fallbackPrefix = 'item'): string {
  const ascii = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length >= 2) return ascii.slice(0, 48);
  return `${fallbackPrefix}-${randomBytes(3).toString('hex')}`;
}
