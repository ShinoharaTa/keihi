// ULID（時刻 48bit + 乱数 80bit、Crockford Base32 の 26 文字）。documents などの主キー。
import { randomBytes } from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let t = '';
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = B32[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  const r = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += B32[r[i] & 31];
  return t + s;
}
