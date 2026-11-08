// お金タブのホーム（GET /api/bank/overview）。残高・月末に残す額・使える額・今月の見込みと、手を入れるべきものの件数をまとめて返す。
// - balances: 資金繰りに入れる口座（include_in_cashflow = 1 かつ active = 1）の最新残高。残高が無い口座（カードなど）は balance null で
//   by_account に入れ、total には入れない。
// - reserve / this_month の見込み: buildForecast（今月の 1 か月分）の値。available = total − reserve。
// - this_month の income / expense: 今月の月次集計（monthlySummary。振替・引き落とし・チャージは除く）のうち、資金繰りに入れる口座の分。
//   all_income / all_expense は対象外の口座も含めた合計（monthlySummary の total）。
// - untagged_count: 効くタグが unset の明細の件数（振替・引き落とし・チャージは数えない）。
//   PWA の一覧（GET /api/bank_txns?tag=unset）の既定と一致させるため active = 1 の口座すべて（include_in_cashflow では絞らない）。
// - receipt_waiting_count: 今日の 12 か月前の月初〜今日の経費の明細（active = 1 の口座）のうち、receipt が waiting（領収書待ち。match.ts）の件数。
// - cards_without_settlement: 使っているカードのうち、引き落とし口座かパターンが空のもの（二重計上になる。docs/cashflow.md §12）。
// - open_candidates: open の周期の候補の件数。upcoming_due: 期日の近い予定の件数（upcoming.ts の dueSoonCount）。
// - sync: 同期の要約（sync.ts の bankSummary の last_ok_at・errors）。
// today は呼ぶ側が Asia/Tokyo の暦日で渡す。
import { buildForecast, type ForecastOptions } from '../cashflow/forecast.ts';
import { listCashflowAccounts, listRecurrenceCandidates } from '../cashflow/repo.ts';
import { dueSoonCount } from '../cashflow/upcoming.ts';
import type { Db } from '../db/index.ts';
import { createReceiptResolver, DEFAULT_MATCH_WINDOWS, type MatchWindows } from './match.ts';
import { listAccounts, listAllBankTxnIds, listBankTxnsBetween } from './repo.ts';
import { monthlySummary } from './summary.ts';
import { bankSummary } from './sync.ts';
import { resolveTagsBulk } from './tags.ts';
import { excludedFromCashflow } from './transfers.ts';

export type Overview = {
  today: string;
  balances: {
    total: number;
    by_account: { account_id: string; name: string; kind: string; balance: number | null; as_of_date: string | null }[];
  };
  reserve: number;
  available: number;
  untagged_count: number;
  receipt_waiting_count: number;
  cards_without_settlement: { account_id: string; name: string }[];
  open_candidates: number;
  upcoming_due: number;
  this_month: {
    month: string;
    income: number;
    expense: number;
    all_income: number;
    all_expense: number;
    planned_out_remaining: number;
    unplanned_out_estimate: number;
    projected_end_balance: number;
  };
  sync: { last_ok_at: string | null; errors: number };
};

export type OverviewOptions = Omit<ForecastOptions, 'months'> & { matchWindows?: MatchWindows };

// 領収書待ちを数える期間の月数（今日の 12 か月前の月初から）。
export const RECEIPT_WAITING_MONTHS = 12;

function monthsBeforeStart(today: string, months: number): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) - months;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

export function buildOverview(db: Db, opts: OverviewOptions): Overview {
  const { today } = opts;
  const byAccount = listCashflowAccounts(db).map((a) => ({ account_id: a.id, name: a.name, kind: a.kind, balance: a.balance, as_of_date: a.as_of_date }));
  const total = byAccount.reduce((s, a) => s + (a.balance ?? 0), 0);

  const f = buildForecast(db, { ...opts, months: 1 });
  const m0 = f.months[0]!;
  const summary = monthlySummary(db, today.slice(0, 7));
  const target = summary.by_account.filter((a) => a.include_in_cashflow && a.active);

  const excluded = excludedFromCashflow(db);
  const ids = listAllBankTxnIds(db).filter((id) => !excluded.has(id));
  let untagged = 0;
  for (const t of resolveTagsBulk(db, ids).values()) if (t.tag === 'unset') untagged++;

  const waitingIds = listBankTxnsBetween(db, monthsBeforeStart(today, RECEIPT_WAITING_MONTHS), today).map((r) => r.id);
  let waiting = 0;
  for (const m of createReceiptResolver(db, opts.matchWindows ?? DEFAULT_MATCH_WINDOWS)(waitingIds).values()) if (m.receipt === 'waiting') waiting++;

  const cards = listAccounts(db)
    .filter((a) => a.kind === 'card' && a.active === 1 && (!a.card_settlement_account_id || !a.card_settlement_pattern))
    .map((a) => ({ account_id: a.id, name: a.name }));

  const sync = bankSummary(db);
  return {
    today,
    balances: { total, by_account: byAccount },
    reserve: f.reserve,
    available: total - f.reserve,
    untagged_count: untagged,
    receipt_waiting_count: waiting,
    cards_without_settlement: cards,
    open_candidates: listRecurrenceCandidates(db, { state: 'open' }).length,
    upcoming_due: dueSoonCount(db, today),
    this_month: {
      month: m0.month,
      income: target.reduce((s, a) => s + a.income, 0),
      expense: target.reduce((s, a) => s + a.expense, 0),
      all_income: summary.total.income,
      all_expense: summary.total.expense,
      planned_out_remaining: m0.planned_out,
      unplanned_out_estimate: m0.unplanned_out,
      projected_end_balance: m0.balance_end,
    },
    sync: { last_ok_at: sync.last_ok_at, errors: sync.errors },
  };
}
