// freee 連携の状態（settings 表。value_json は JSON）。PWA の帯の元になる。
// - freee_reauth_required = 1: リフレッシュトークンが失効した（invalid_grant）か、トークンが無い。`keihi freee auth` で 0 に戻す。
// - freee_paused_until = ISO8601: 403（使用制限）を受けて全用途を止めている期限（T1-15）。
import type { Db } from '../../db/index.ts';

export const REAUTH_KEY = 'freee_reauth_required';
export const PAUSED_KEY = 'freee_paused_until';

function get(db: Db, key: string): unknown {
  const r = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  if (!r) return undefined;
  try {
    return JSON.parse(r.value_json) as unknown;
  } catch {
    return undefined;
  }
}

function set(db: Db, key: string, value: unknown, now: Date): void {
  db.prepare(
    'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(value), now.toISOString());
}

export function isReauthRequired(db: Db): boolean {
  return get(db, REAUTH_KEY) === 1;
}

export function setReauthRequired(db: Db, required: boolean, now: Date = new Date()): void {
  set(db, REAUTH_KEY, required ? 1 : 0, now);
}

export function getPausedUntil(db: Db): Date | null {
  const v = get(db, PAUSED_KEY);
  if (typeof v !== 'string') return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t;
}

// 既に後の時刻まで止めていれば縮めない。
export function setPausedUntil(db: Db, until: Date, now: Date = new Date()): void {
  const cur = getPausedUntil(db);
  if (cur && cur.getTime() >= until.getTime()) return;
  set(db, PAUSED_KEY, until.toISOString(), now);
}
