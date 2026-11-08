// 1 アカウント分のメールの取得（fetch_mail ジョブの本体。docs/cashflow.md §16）。
// - 検索式: `label:<label> after:<UNIX 秒>`（[[mail.accounts]] query があれば `(<query>)` を AND で足す）。
//   after = max(since の JST 0 時, 前回までに取り込んだ最後のメールの受信時刻 − 2 日)。since が無ければ初回実行日の 30 日前。
// - messages.list で ID を集め（最大 MAX_LIST_PAGES ページ）、まだ取り込んでいないもの（と、attempts < 3 の error）を
//   古い順に [mail] max_messages_per_run 通まで処理する。残りは次回（after は取り込んだ最後のメールから決まるので取りこぼさない）。
// - 1 通ずつ src/mail/ingest.ts の ingestMessage（1 通 1 トランザクション）。1 通の失敗は他の通を止めない。
//   認可（GmailAuthError）と一時的な失敗（GmailRetryableError）は投げ直す（それまでに取り込んだ通は記録済み）。
// - 手がかりの抽出（deps.hints）があれば、新しい通の前に、前回までに抜き出せなかった body_only を最大 20 通取り直す
//   （src/mail/hints.ts の retryPendingHints）。
import { addDays, todayInTokyo } from '../../calendar/businessDays.ts';
import type { MailAccount } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { retryPendingHints } from '../hints.ts';
import { ingestMessage, MAIL_PROVIDER, type MailIngestDeps, type MailState } from '../ingest.ts';
import { getMailStatus, MAX_ATTEMPTS, updateMailStatus } from '../status.ts';
import type { GmailClient } from './client.ts';

export const MAX_LIST_PAGES = 20;
export const DEFAULT_SINCE_DAYS = 30;
export const OVERLAP_MS = 2 * 86_400_000;

export type FetchMailResult = {
  account_id: string;
  query: string;
  listed: number;
  processed: number;
  remaining: number;
  states: Partial<Record<MailState, number>>;
  documents: number;
  // 取り直した手がかりの通数。
  hint_retries: number;
};

function quoteLabel(label: string): string {
  return /^[^\s"()]+$/.test(label) ? label : `"${label.replace(/"/g, '')}"`;
}

// JST の暦日の 0 時（UNIX 秒）。
function jstMidnightSec(d: string): number {
  return Math.floor(new Date(`${d}T00:00:00+09:00`).getTime() / 1000);
}

export function buildQuery(account: MailAccount, afterSec: number): string {
  const q = `label:${quoteLabel(account.label)} after:${afterSec}`;
  return account.query.trim() ? `${q} (${account.query.trim()})` : q;
}

// 取り込んだ最後のメールの受信時刻（error 以外）。
export function lastInternalAt(db: Db, accountId: string): string | null {
  return (
    db.prepare(`SELECT MAX(internal_at) t FROM mail_messages WHERE account_id = ? AND provider = ? AND state != 'error'`).get(accountId, MAIL_PROVIDER) as {
      t: string | null;
    }
  ).t;
}

export async function fetchMailForAccount(
  deps: MailIngestDeps & { client: GmailClient; account: MailAccount; maxMessages: number },
): Promise<FetchMailResult> {
  const { db, client, account } = deps;
  const now = deps.now();
  let status = getMailStatus(db, account.id);
  if (status.first_run_on === null) status = updateMailStatus(db, account.id, { first_run_on: todayInTokyo(now) }, now);
  const since = account.since ?? addDays(status.first_run_on!, -DEFAULT_SINCE_DAYS);
  let afterSec = jstMidnightSec(since);
  const last = lastInternalAt(db, account.id);
  if (last !== null) afterSec = Math.max(afterSec, Math.floor((new Date(last).getTime() - OVERLAP_MS) / 1000));
  const query = buildQuery(account, afterSec);

  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    const page = await client.listMessages(query, { pageToken });
    for (const m of page.messages ?? []) if (typeof m?.id === 'string' && m.id) ids.push(m.id);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  const known = new Map(
    (db.prepare('SELECT remote_id, state, attempts FROM mail_messages WHERE account_id = ? AND provider = ?').all(account.id, MAIL_PROVIDER) as {
      remote_id: string;
      state: MailState;
      attempts: number;
    }[]).map((r) => [r.remote_id, r]),
  );
  const retryable = (id: string) => {
    const k = known.get(id);
    return !k || (k.state === 'error' && k.attempts < MAX_ATTEMPTS);
  };
  // list は新しい順なので、古い順にする。検索の範囲から外れた error も取り直す。
  const seen = new Set<string>();
  const todo: string[] = [];
  for (const id of [...ids].reverse()) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (retryable(id)) todo.push(id);
  }
  for (const [id, k] of known) if (!seen.has(id) && k.state === 'error' && k.attempts < MAX_ATTEMPTS) todo.unshift(id);

  const result: FetchMailResult = { account_id: account.id, query, listed: ids.length, processed: 0, remaining: 0, states: {}, documents: 0, hint_retries: 0 };
  // この回で取り込む通は ingestMessage の中で 1 回だけ呼ぶので、取り直しは先に済ませる。
  if (deps.hints) result.hint_retries = await retryPendingHints(db, deps.hints, client, account.id, MAIL_PROVIDER, deps.now);
  const batch = todo.slice(0, deps.maxMessages);
  result.remaining = todo.length - batch.length;
  for (const id of batch) {
    const r = await ingestMessage(deps, client, account.id, id);
    result.processed++;
    result.states[r.state] = (result.states[r.state] ?? 0) + 1;
    result.documents += r.documents;
  }
  return result;
}
