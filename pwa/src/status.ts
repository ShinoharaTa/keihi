// バックアップの警告帯（GET /api/status の backup。src/web/routes/status.ts）。
// 最後に成功したバックアップが 2 日より古い（または一度も無い）か、最後の復元訓練（drill）が失敗なら警告を出す。
export type BackupStatus = { last_success_at: string | null; last_drill: { at: string; ok: boolean; failure_count: number | null } | null };
export type StatusResponse = { backup?: BackupStatus };

export const STATUS_URL = '/api/status';
export const BACKUP_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

export function backupWarning(b: BackupStatus | undefined, now: Date): string | null {
  if (!b) return null;
  const parts: string[] = [];
  const last = b.last_success_at ? Date.parse(b.last_success_at) : Number.NaN;
  if (Number.isNaN(last)) parts.push('バックアップがまだ一度も成功していません。');
  else if (now.getTime() - last > BACKUP_MAX_AGE_MS) parts.push(`最後のバックアップが ${b.last_success_at!.slice(0, 10)} から止まっています。`);
  if (b.last_drill && !b.last_drill.ok) parts.push('復元の確認（drill）が失敗しています。');
  return parts.length ? `${parts.join('')}サーバーを確認してください。` : null;
}
