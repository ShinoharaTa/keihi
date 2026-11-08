// メールの取り込みの状態（settings）とジョブの積み方、API の読み出し（docs/cashflow.md §17）。
// - settings mail_status_<account_id> = {last_run_at, last_ok_at, last_error, last_internal_at, first_run_on}。
//   first_run_on は [[mail.accounts]] since が無いときの既定（初回実行日の 30 日前）の起点。
// - 要対応のメール = state が error（attempts ≥ 3）・unsupported・too_large、または手がかりの無い body_only。
import { getSetting, setSetting } from '../attention.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { enqueue } from '../jobs/queue.ts';
import { isGmailReauthRequired } from './gmail/auth.ts';

export const STATUS_KEY_PREFIX = 'mail_status_';
export const MAX_ATTEMPTS = 3;
// POST /api/mail/sync（今すぐ取り込む）で、前回積んでからこの間は積まない（bank と同じ）。
export const MANUAL_SYNC_INTERVAL_MS = 10 * 60 * 1000;

export type MailStatus = {
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_internal_at: string | null;
  first_run_on: string | null;
};

export const ATTENTION_SQL = `((state = 'error' AND attempts >= ${MAX_ATTEMPTS}) OR state IN ('unsupported', 'too_large') OR (state = 'body_only' AND hint_extracted_at IS NULL))`;

export function statusKey(accountId: string): string {
  return `${STATUS_KEY_PREFIX}${accountId}`;
}

export function getMailStatus(db: Db, accountId: string): MailStatus {
  const v = getSetting(db, statusKey(accountId));
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return { last_run_at: s('last_run_at'), last_ok_at: s('last_ok_at'), last_error: s('last_error'), last_internal_at: s('last_internal_at'), first_run_on: s('first_run_on') };
}

export function updateMailStatus(db: Db, accountId: string, patch: Partial<MailStatus>, now: Date): MailStatus {
  const next = { ...getMailStatus(db, accountId), ...patch };
  setSetting(db, statusKey(accountId), next, now);
  return next;
}

// fetch_mail を積む（ref_id = account_id）。そのアカウントの未完了のもの（queued / running）があれば積まない。
// minIntervalMs があれば、前回積んでからその間も積まない。
export function enqueueFetchMail(db: Db, accountId: string, now: Date, opts: { minIntervalMs?: number } = {}): { job_id: number; created: boolean } {
  const cur = db.prepare(`SELECT id FROM jobs WHERE kind = 'fetch_mail' AND ref_id = ? AND state IN ('queued', 'running') ORDER BY id LIMIT 1`).get(accountId) as
    | { id: number }
    | undefined;
  if (cur) return { job_id: cur.id, created: false };
  if (opts.minIntervalMs !== undefined) {
    const last = db.prepare(`SELECT id, created_at FROM jobs WHERE kind = 'fetch_mail' AND ref_id = ? ORDER BY id DESC LIMIT 1`).get(accountId) as
      | { id: number; created_at: string }
      | undefined;
    if (last && now.getTime() - new Date(last.created_at).getTime() < opts.minIntervalMs) return { job_id: last.id, created: false };
  }
  return { job_id: enqueue(db, 'fetch_mail', accountId, { now }), created: true };
}

export function attentionCount(db: Db, accountId: string): number {
  return (db.prepare(`SELECT count(*) n FROM mail_messages WHERE account_id = ? AND ${ATTENTION_SQL}`).get(accountId) as { n: number }).n;
}

export type MailAccountStatus = {
  id: string;
  label: string;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  reauth_required: boolean;
  attention_count: number;
};

export function mailAccountsStatus(db: Db, mail: Config['mail']): MailAccountStatus[] {
  return mail.accounts.map((a) => {
    const s = getMailStatus(db, a.id);
    return {
      id: a.id,
      label: a.label,
      last_run_at: s.last_run_at,
      last_ok_at: s.last_ok_at,
      last_error: s.last_error,
      reauth_required: isGmailReauthRequired(db, a.id),
      attention_count: attentionCount(db, a.id),
    };
  });
}
