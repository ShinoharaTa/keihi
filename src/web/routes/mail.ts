// メールの取り込みの API（docs/cashflow.md §16）。
//   POST /api/mail/sync      → 200 {accounts: [{account_id, job_id, created}]} / 409 {reason: 'mail_disabled'}
//                              （アカウントごとに fetch_mail を積む。未完了のものがあるか、前回積んでから 10 分以内なら積まない）
//   GET  /api/mail/status    → 200 {enabled, provider, accounts: [{id, label, last_run_at, last_ok_at, last_error, reauth_required, attention_count}]}
//   GET  /api/mail/messages?account_id&state（ingested|body_only|unsupported|too_large|error|attention）&cursor&limit（1〜100、既定 50）
//        → 200 {items: [{id, account_id, received_on, from_domain, subject, state, error_reason, attempts,
//                        attachments: [{filename, result, document_id}], hint}], next_cursor} / 400 {reason}
//        新しい順（受信時刻、無ければ記録した時刻）。state=attention は要対応のメール（src/mail/status.ts）。
//        hint は手がかり（{txn_date, amount, vendor, order_ref}。抽出していなければ null）。
// [mail] が無い（設定に無い）ときは enabled = false・アカウント 0 件として扱う。
import { Hono } from 'hono';
import type { Config } from '../../config.ts';
import { ATTENTION_SQL, enqueueFetchMail, mailAccountsStatus, MANUAL_SYNC_INTERVAL_MS } from '../../mail/status.ts';
import type { AppDeps } from '../app.ts';

export const DEFAULT_MESSAGES_LIMIT = 50;
export const MAX_MESSAGES_LIMIT = 100;
const STATES = new Set(['ingested', 'body_only', 'unsupported', 'too_large', 'error', 'attention']);

export const DISABLED_MAIL: Config['mail'] = { enabled: false, provider: 'gmail_api', maxMessagesPerRun: 100, extractHints: true, accounts: [] };

type MessageRow = {
  id: string;
  account_id: string;
  received_on: string | null;
  from_domain: string | null;
  subject: string | null;
  state: string;
  error_reason: string | null;
  attempts: number;
  hint_txn_date: string | null;
  hint_amount: number | null;
  hint_vendor: string | null;
  hint_order_ref: string | null;
  hint_extracted_at: string | null;
  sort_at: string;
};

function encodeCursor(r: MessageRow): string {
  return Buffer.from(JSON.stringify([r.sort_at, r.id])).toString('base64url');
}

function decodeCursor(s: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    // 下で null
  }
  return null;
}

export function mailRoutes(deps: Pick<AppDeps, 'db' | 'config' | 'triggerWorker' | 'now'>): Hono {
  const r = new Hono();
  const now = deps.now ?? (() => new Date());
  const mail = () => deps.config.mail ?? DISABLED_MAIL;

  r.post('/mail/sync', (c) => {
    const m = mail();
    if (!m.enabled) return c.json({ reason: 'mail_disabled' }, 409);
    const at = now();
    const accounts = m.accounts.map((a) => ({ account_id: a.id, ...enqueueFetchMail(deps.db, a.id, at, { minIntervalMs: MANUAL_SYNC_INTERVAL_MS }) }));
    if (accounts.some((a) => a.created)) {
      try {
        deps.triggerWorker();
      } catch {
        // 握りつぶす（bank と同じ。積んだジョブは keihi-worker.timer が拾う）
      }
    }
    return c.json({ accounts });
  });

  r.get('/mail/status', (c) => {
    const m = mail();
    return c.json({ enabled: m.enabled, provider: m.provider, accounts: mailAccountsStatus(deps.db, m) });
  });

  r.get('/mail/messages', (c) => {
    const q = c.req.query();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.account_id !== undefined) {
      if (!mail().accounts.some((a) => a.id === q.account_id)) return c.json({ reason: 'invalid_account_id' }, 400);
      where.push('account_id = ?');
      args.push(q.account_id);
    }
    if (q.state !== undefined) {
      if (!STATES.has(q.state)) return c.json({ reason: 'invalid_state' }, 400);
      if (q.state === 'attention') where.push(ATTENTION_SQL);
      else {
        where.push('state = ?');
        args.push(q.state);
      }
    }
    let limit = DEFAULT_MESSAGES_LIMIT;
    if (q.limit !== undefined) {
      if (!/^\d{1,3}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > MAX_MESSAGES_LIMIT) return c.json({ reason: 'invalid_limit' }, 400);
      limit = Number(q.limit);
    }
    if (q.cursor !== undefined) {
      const cur = decodeCursor(q.cursor);
      if (!cur) return c.json({ reason: 'invalid_cursor' }, 400);
      where.push('(COALESCE(internal_at, created_at) < ? OR (COALESCE(internal_at, created_at) = ? AND id < ?))');
      args.push(cur[0], cur[0], cur[1]);
    }
    const rows = deps.db
      .prepare(
        `SELECT id, account_id, received_on, from_domain, subject, state, error_reason, attempts,
           hint_txn_date, hint_amount, hint_vendor, hint_order_ref, hint_extracted_at, COALESCE(internal_at, created_at) AS sort_at
         FROM mail_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY sort_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as MessageRow[];
    const page = rows.slice(0, limit);
    const att = deps.db.prepare('SELECT filename, result, document_id FROM mail_attachments WHERE mail_message_id = ? ORDER BY part_index');
    const items = page.map((m) => ({
      id: m.id,
      account_id: m.account_id,
      received_on: m.received_on,
      from_domain: m.from_domain,
      subject: m.subject,
      state: m.state,
      error_reason: m.error_reason,
      attempts: m.attempts,
      attachments: att.all(m.id) as { filename: string | null; result: string; document_id: string | null }[],
      hint: m.hint_extracted_at === null ? null : { txn_date: m.hint_txn_date, amount: m.hint_amount, vendor: m.hint_vendor, order_ref: m.hint_order_ref },
    }));
    return c.json({ items, next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null });
  });

  return r;
}
