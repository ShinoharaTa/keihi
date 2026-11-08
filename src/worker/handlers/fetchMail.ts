// fetch_mail ジョブ（docs/cashflow.md §16）。ref_id = [[mail.accounts]] の id。daily がアカウントごとに 1 件、
// POST /api/mail/sync が積む。本体は src/mail/gmail/fetch.ts。
// - [mail] enabled = false、またはアカウントが設定から消えていれば何もしない（完了）。
// - 再認可待ち（settings.gmail_reauth_required_<id> = 1）なら Gmail を呼ばずに完了。
// - invalid_grant・401・トークンが無い → gmail_reauth_required_<id> = 1、監査（mail.reauth_required）、ジョブは完了（再試行しない）。
//   `keihi gmail auth <id>` で 0 に戻す。
// - 429・5xx・ネットワーク（とその他の失敗）→ 例外を投げてジョブの再試行（既存のバックオフ）。取り込めた通は記録済み。
// - settings.mail_status_<id> に last_run_at・last_ok_at・last_error・last_internal_at を残す。
import { appendAudit } from '../../audit.ts';
import type { Config } from '../../config.ts';
import type { Handler } from '../../jobs/worker.ts';
import { GmailAuthError, isGmailReauthRequired, setGmailReauthRequired } from '../../mail/gmail/auth.ts';
import type { GmailClient } from '../../mail/gmail/client.ts';
import { fetchMailForAccount, lastInternalAt } from '../../mail/gmail/fetch.ts';
import { updateMailStatus } from '../../mail/status.ts';

export type FetchMailDeps = {
  mail: Config['mail'];
  config: Pick<Config, 'ingest' | 'calendar' | 'deadline'>;
  objectsDir: string;
  // アカウントの Gmail のクライアント（トークンはアカウントごと）。
  client: (accountId: string) => GmailClient;
  log?: (s: string) => void;
};

// 再認可が要る失敗か（それ以外の GmailAuthError はジョブの再試行）。
export function isReauthError(e: unknown): boolean {
  return e instanceof GmailAuthError && (e.status === null || e.status === 401 || e.error === 'invalid_grant');
}

export function createFetchMailHandler(getDeps: () => FetchMailDeps): Handler {
  return async (job, ctx) => {
    const { db } = ctx;
    const deps = getDeps();
    const log = deps.log ?? ((s: string) => console.error(s));
    const accountId = job.ref_id ?? '';
    const account = deps.mail.accounts.find((a) => a.id === accountId);
    if (!deps.mail.enabled || !account) {
      log(`fetch_mail: ${accountId || '(account_id なし)'} は ${deps.mail.enabled ? '設定に無い' : '[mail] enabled = false'} ので何もしない`);
      return;
    }
    const startedAt = ctx.now();
    if (isGmailReauthRequired(db, account.id)) {
      updateMailStatus(db, account.id, { last_run_at: startedAt.toISOString(), last_error: 'reauth_required' }, startedAt);
      return;
    }
    updateMailStatus(db, account.id, { last_run_at: startedAt.toISOString() }, startedAt);
    try {
      const r = await fetchMailForAccount({
        db, objectsDir: deps.objectsDir, config: deps.config, now: ctx.now,
        client: deps.client(account.id), account, maxMessages: deps.mail.maxMessagesPerRun,
      });
      const at = ctx.now();
      updateMailStatus(db, account.id, { last_ok_at: at.toISOString(), last_error: null, last_internal_at: lastInternalAt(db, account.id) }, at);
      log(`fetch_mail ${account.id}: listed=${r.listed} processed=${r.processed} remaining=${r.remaining} documents=${r.documents}`);
    } catch (e) {
      const at = ctx.now();
      const last = lastInternalAt(db, account.id);
      if (isReauthError(e)) {
        setGmailReauthRequired(db, account.id, true, at);
        updateMailStatus(db, account.id, { last_error: 'reauth_required', last_internal_at: last }, at);
        appendAudit(db, { actor: 'worker', action: 'mail.reauth_required', entity: 'system', entityId: null, payload: { account_id: account.id } }, at);
        log(`fetch_mail ${account.id}: 再認可が要る（keihi gmail auth ${account.id}）: ${(e as Error).message}`);
        return;
      }
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      updateMailStatus(db, account.id, { last_error: msg, last_internal_at: last }, at);
      throw e;
    }
  };
}
