// バックアップの警告帯と freee・メールの再認可の帯（GET /api/status の backup・freee_reauth_required・mail。src/web/routes/status.ts）。
// バックアップ: 最後に成功したバックアップが 2 日より古い（または一度も無い）か、最後の復元訓練（drill）が失敗なら警告を出す。
export type BackupStatus = { last_success_at: string | null; last_drill: { at: string; ok: boolean; failure_count: number | null } | null };
export type MailAccountStatus = { id: string; reauth_required: boolean; attention_count: number };
export type StatusResponse = { backup?: BackupStatus; freee_reauth_required?: boolean; mail?: { enabled: boolean; accounts: MailAccountStatus[] } };

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

// freee の再認可（settings.freee_reauth_required = 1）。`keihi freee auth` で 0 に戻るまで出す。
export function reauthWarning(st: StatusResponse): string | null {
  return st.freee_reauth_required === true ? 'freee の再認可が必要です。サーバーで keihi freee auth を実行してください' : null;
}

// メールの取り込みの再認可（GET /api/status の mail.accounts[].reauth_required）。アカウントごとに 1 本。取り込みが無効なら出さない。
export function mailReauthWarnings(st: StatusResponse): string[] {
  if (!st.mail?.enabled) return [];
  return st.mail.accounts.filter((a) => a.reauth_required).map((a) => `メール（${a.id}）の再認可が必要です。サーバーで keihi gmail auth ${a.id} を実行してください`);
}
