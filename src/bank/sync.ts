// 明細の同期（docs/mvp-plan-v3.md T104、requirements-v2.md R-A の A1・A5）。worker の sync_bank ジョブ（src/worker/handlers/syncBank.ts）から呼ぶ。
// - 対象は [provider] kind の freee の口座（source = freee・active = 1）。前回うまくいったのが古い口座から順に取る。
// - 取る範囲: 初めての口座（backfill_done_until が無い）は「今日の 3 か月前（backfill_from より前には行かない）〜今日」だけを取り、
//   backfill_done_until をその始まりにする。2 回目からは max(最新の明細日 − 35 日, backfill_from) 〜今日と、
//   過去分がまだ backfill_from に届いていなければ、その手前の 3 か月を 1 区間だけ取る（1 回の実行で 1 区間）。
// - limit = 100 で offset を進めて全部取る。外部 ID（`<freee_walletable_id>:<wallet_txn の id>`）で upsert し、既にあれば
//   freee_status・due_amount・last_seen_at（と、balance が NULL のときの balance）だけを書く。status の変化は監査に残す（bank_txn.status_changed）。
//   freee_status は既知の値（1 / 2 / 3 / 4 / 6）だけを入れ、それ以外（5 など）は NULL にする（0005_bank.sql の CHECK）。
// - 残高: 明細の後に listWalletables の last_balance を account_balances（source = freee_walletable、as_of_date = 今日）に追記する。
//   カード・残高が無い口座は追記しない。予算で止まった実行では取らない。
// - 予算（用途 sync）が足りなくなったら（BudgetExceededError。残り 500 未満など）そこで止め、その口座の sync_status.last_error に理由を書く。
//   取れた分は保存済みで、backfill_done_until は区間を取り終えたときだけ進めるので、次回は続きから取る。
// - 再認可が要る（auth_invalid_grant）は口座の last_error に書いて投げ直す（ハンドラが延期する）。ほかの失敗は口座の last_error に書いて次の口座に進む。
import { appendAudit } from '../audit.ts';
import { addDays, addMonths, todayInTokyo } from '../calendar/businessDays.ts';
import { tx, type Db } from '../db/index.ts';
import { enqueue } from '../jobs/queue.ts';
import { BudgetExceededError } from '../providers/freee/budget.ts';
import { ProviderError, type BankTxn, type Provider, type WalletableType } from '../providers/types.ts';
import { normalizeVendor } from '../vendors/normalize.ts';
import {
  addBankTxnSource,
  appendBalance,
  findBankTxnByExternalId,
  getAccountByWalletable,
  getSyncStatus,
  insertBankTxn,
  latestTxnDate,
  touchBankTxn,
  updateSyncStatus,
  type AccountProvider,
  type FreeeTxnStatus,
  type MoneyAccountRow,
} from './repo.ts';

export const LOOKBACK_DAYS = 35;
export const BACKFILL_MONTHS = 3;
export const PAGE = 100;
// POST /api/bank/sync（今すぐ同期）で、前回積んでからこの間は積まない。
export const MANUAL_SYNC_INTERVAL_MS = 10 * 60 * 1000;

const KNOWN_STATUS = new Set<number>([1, 2, 3, 4, 6]);
const WALLETABLE_TYPES = new Set<string>(['bank_account', 'credit_card', 'wallet']);

export type SyncBankProvider = Pick<Provider, 'listBankTxns' | 'listWalletables'>;

export type SyncBankOptions = {
  provider: SyncBankProvider;
  providerKind: AccountProvider;
  backfillFrom: string;
  now: Date;
};

export type DateRange = { start: string; end: string };

export type AccountSyncResult = {
  account_id: string;
  ranges: DateRange[];
  fetched: number;
  inserted: number;
  updated: number;
  status_changed: number;
  backfill_done_until: string | null;
  error: string | null;
};

export type SyncBankResult = {
  accounts: AccountSyncResult[];
  balances: number;
  // 予算が足りなくて止めたときの理由（BudgetExceededError のメッセージ）。
  stopped: string | null;
  errors: { account_id: string | null; error: string }[];
};

export type SyncPlan = { ranges: DateRange[]; backfillDoneUntil: string };

const maxDate = (a: string, b: string) => (a > b ? a : b);

// 口座の今回の取得範囲と、取り終えたときの backfill_done_until。
export function planRanges(s: { backfillDoneUntil: string | null; latestTxnDate: string | null }, today: string, backfillFrom: string): SyncPlan {
  if (s.backfillDoneUntil === null) {
    const start = maxDate(addMonths(today, -BACKFILL_MONTHS), backfillFrom);
    return { ranges: start <= today ? [{ start, end: today }] : [], backfillDoneUntil: start };
  }
  const ranges: DateRange[] = [];
  const recent = maxDate(s.latestTxnDate === null ? s.backfillDoneUntil : addDays(s.latestTxnDate, -LOOKBACK_DAYS), backfillFrom);
  if (recent <= today) ranges.push({ start: recent, end: today });
  let done = s.backfillDoneUntil;
  if (done > backfillFrom) {
    const start = maxDate(addMonths(done, -BACKFILL_MONTHS), backfillFrom);
    ranges.push({ start, end: addDays(done, -1) });
    done = start;
  }
  return { ranges, backfillDoneUntil: done };
}

// `type:id`（src/masters/sync.ts の walletableRemoteId）を分ける。
export function parseWalletableId(remoteId: string): { type: WalletableType; id: number } {
  const i = remoteId.lastIndexOf(':');
  const type = remoteId.slice(0, i);
  const id = Number(remoteId.slice(i + 1));
  if (i <= 0 || !WALLETABLE_TYPES.has(type) || !Number.isInteger(id)) throw new Error(`freee_walletable_id が不正: ${remoteId}`);
  return { type: type as WalletableType, id };
}

function message(e: unknown): string {
  if (e instanceof ProviderError) return `${e.kind}${e.status ? `(${e.status})` : ''}: ${e.message}`;
  if (e instanceof BudgetExceededError) return `budget: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// 同期の対象の口座。前回うまくいったのが古い順（まだ一度もなければ先頭）。
function targetAccounts(db: Db, providerKind: AccountProvider): MoneyAccountRow[] {
  return db
    .prepare(
      `SELECT a.* FROM money_accounts a LEFT JOIN sync_status s ON s.account_id = a.id
       WHERE a.provider = ? AND a.source = 'freee' AND a.active = 1
       ORDER BY s.last_ok_at IS NOT NULL, s.last_ok_at, a.created_at, a.rowid`,
    )
    .all(providerKind) as MoneyAccountRow[];
}

// 1 件を upsert する。呼び出し側のトランザクションの中で呼ぶ。
function upsertTxn(db: Db, a: MoneyAccountRow, t: BankTxn, now: Date, r: AccountSyncResult): void {
  const iso = now.toISOString();
  const externalId = `${a.freee_walletable_id}:${t.id}`;
  const status = t.status !== null && KNOWN_STATUS.has(t.status) ? (t.status as FreeeTxnStatus) : null;
  const cur = findBankTxnByExternalId(db, a.id, 'freee', externalId);
  if (!cur) {
    const row = insertBankTxn(db, {
      accountId: a.id,
      txnDate: t.date,
      amount: t.amount,
      side: t.entrySide,
      description: t.description,
      descriptionNorm: normalizeVendor(t.description),
      freeeStatus: status,
      dueAmount: t.dueAmount,
      balance: t.balance,
      now: iso,
    });
    addBankTxnSource(db, { bankTxnId: row.id, source: 'freee', externalId });
    r.inserted++;
    return;
  }
  touchBankTxn(db, cur.id, { lastSeenAt: iso, freeeStatus: status, dueAmount: t.dueAmount, balance: t.balance });
  r.updated++;
  if (cur.freee_status !== status) {
    appendAudit(
      db,
      {
        actor: 'worker',
        action: 'bank_txn.status_changed',
        entity: 'bank_txn',
        entityId: cur.id,
        payload: { account_id: a.id, external_id: externalId, from: cur.freee_status, to: status, raw_status: t.status },
      },
      now,
    );
    r.status_changed++;
  }
}

async function syncAccount(db: Db, a: MoneyAccountRow, o: SyncBankOptions, r: AccountSyncResult): Promise<void> {
  const w = parseWalletableId(a.freee_walletable_id!);
  const st = getSyncStatus(db, a.id);
  const plan = planRanges({ backfillDoneUntil: st?.backfill_done_until ?? null, latestTxnDate: latestTxnDate(db, a.id) }, todayInTokyo(o.now), o.backfillFrom);
  r.ranges = plan.ranges;
  for (const range of plan.ranges) {
    for (let offset = 0; ; offset += PAGE) {
      const page = await o.provider.listBankTxns({ walletableType: w.type, walletableId: w.id, startDate: range.start, endDate: range.end, limit: PAGE, offset });
      r.fetched += page.length;
      tx(db, () => {
        for (const t of page) upsertTxn(db, a, t, o.now, r);
      });
      if (page.length < PAGE) break;
    }
  }
  r.backfill_done_until = plan.backfillDoneUntil;
}

// 残高を追記する。追記した件数。
async function syncBalances(db: Db, o: SyncBankOptions): Promise<number> {
  const ws = await o.provider.listWalletables();
  const today = todayInTokyo(o.now);
  const iso = o.now.toISOString();
  return tx(db, () => {
    let n = 0;
    for (const w of ws) {
      if (w.lastBalance === null) continue;
      const a = getAccountByWalletable(db, o.providerKind, `${w.type}:${w.id}`);
      if (!a || a.kind === 'card' || a.active !== 1) continue;
      appendBalance(db, { accountId: a.id, asOfDate: today, balance: w.lastBalance, source: 'freee_walletable', now: iso });
      n++;
    }
    return n;
  });
}

export async function syncBank(db: Db, o: SyncBankOptions): Promise<SyncBankResult> {
  const res: SyncBankResult = { accounts: [], balances: 0, stopped: null, errors: [] };
  const iso = o.now.toISOString();
  for (const a of targetAccounts(db, o.providerKind)) {
    const r: AccountSyncResult = { account_id: a.id, ranges: [], fetched: 0, inserted: 0, updated: 0, status_changed: 0, backfill_done_until: null, error: null };
    res.accounts.push(r);
    updateSyncStatus(db, a.id, { lastSyncAt: iso });
    try {
      await syncAccount(db, a, o, r);
      updateSyncStatus(db, a.id, { lastOkAt: iso, lastError: null, backfillDoneUntil: r.backfill_done_until });
    } catch (e) {
      r.error = message(e).slice(0, 500);
      updateSyncStatus(db, a.id, { lastError: r.error });
      if (e instanceof BudgetExceededError) {
        res.stopped = r.error;
        break;
      }
      if (e instanceof ProviderError && e.kind === 'auth_invalid_grant') throw e;
      res.errors.push({ account_id: a.id, error: r.error });
    }
  }
  if (res.stopped !== null) return res;
  try {
    res.balances = await syncBalances(db, o);
  } catch (e) {
    if (e instanceof BudgetExceededError) res.stopped = message(e);
    else if (e instanceof ProviderError && e.kind === 'auth_invalid_grant') throw e;
    else res.errors.push({ account_id: null, error: message(e).slice(0, 500) });
  }
  return res;
}

// sync_bank を積む。未完了のもの（queued / running）があれば積み増さない。minIntervalMs を渡すと、最後に積んでから
// その間も積まない（今すぐ同期の連打よけ）。
export function enqueueSyncBank(db: Db, now: Date, opts: { minIntervalMs?: number } = {}): { job_id: number; created: boolean } {
  const cur = db.prepare(`SELECT id FROM jobs WHERE kind = 'sync_bank' AND state IN ('queued', 'running') ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
  if (cur) return { job_id: cur.id, created: false };
  if (opts.minIntervalMs !== undefined) {
    const last = db.prepare(`SELECT id, created_at FROM jobs WHERE kind = 'sync_bank' ORDER BY id DESC LIMIT 1`).get() as { id: number; created_at: string } | undefined;
    if (last && now.getTime() - new Date(last.created_at).getTime() < opts.minIntervalMs) return { job_id: last.id, created: false };
  }
  return { job_id: enqueue(db, 'sync_bank', null, { now }), created: true };
}

// 口座ごとの取得状況（A5。GET /api/bank/status）。
export type BankStatusItem = {
  account_id: string;
  name: string;
  kind: string;
  source: string;
  active: boolean;
  last_sync_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_csv_at: string | null;
  backfill_done_until: string | null;
};

export function bankStatus(db: Db): BankStatusItem[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.kind, a.source, a.active, s.last_sync_at, s.last_ok_at, s.last_error, s.last_csv_at, s.backfill_done_until
       FROM money_accounts a LEFT JOIN sync_status s ON s.account_id = a.id ORDER BY a.created_at, a.rowid`,
    )
    .all() as (Omit<BankStatusItem, 'account_id' | 'active'> & { id: string; active: number })[];
  return rows.map((r) => ({
    account_id: r.id,
    name: r.name,
    kind: r.kind,
    source: r.source,
    active: r.active === 1,
    last_sync_at: r.last_sync_at ?? null,
    last_ok_at: r.last_ok_at ?? null,
    last_error: r.last_error ?? null,
    last_csv_at: r.last_csv_at ?? null,
    backfill_done_until: r.backfill_done_until ?? null,
  }));
}

// /api/status の要約（件数と日時だけ）。使っている口座の数、最後にうまくいった同期、last_error がある口座の数。
export function bankSummary(db: Db): { accounts: number; last_ok_at: string | null; errors: number } {
  const r = db
    .prepare(
      `SELECT count(*) n, max(s.last_ok_at) last_ok_at, coalesce(sum(s.last_error IS NOT NULL), 0) errors
       FROM money_accounts a LEFT JOIN sync_status s ON s.account_id = a.id WHERE a.active = 1`,
    )
    .get() as { n: number; last_ok_at: string | null; errors: number };
  return { accounts: r.n, last_ok_at: r.last_ok_at, errors: r.errors };
}
