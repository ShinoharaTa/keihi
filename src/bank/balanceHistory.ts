// 月末残高の推移（GET /api/balance_history）。今月を最後に、古い順に months か月分。
// 対象口座: include_in_cashflow = 1 かつ active = 1 で、kind が bank / wallet / paypay / cash（カードは残高を持たないので除く）。
// 各月の口座の残高 = その月末までの明細のうち、balance が NULL でない最後のもの（txn_date, id の順で最後）。
//   その月に無ければ直前の月の値を引き継ぐ（期間より前の明細も見る）。今月は今日時点で、account_balances の最新
//   （bank/repo.ts の latestBalance）があればそれ、無ければ今日までの明細から。どちらも無ければ 0。
// today は呼ぶ側が Asia/Tokyo の暦日で渡す。
import { addDays, addMonths } from '../calendar/businessDays.ts';
import { listCashflowAccounts } from '../cashflow/repo.ts';
import type { Db } from '../db/index.ts';
import { latestBalance, listTxnBalances } from './repo.ts';

export const BALANCE_HISTORY_DEFAULT_MONTHS = 12;
export const BALANCE_HISTORY_MAX_MONTHS = 60;
const KINDS = new Set(['bank', 'wallet', 'paypay', 'cash']);

export type BalanceHistoryMonth = { month: string; total: number; by_account: Record<string, number> };
export type BalanceHistory = { months: BalanceHistoryMonth[] };

export function balanceHistory(db: Db, opts: { today: string; months?: number }): BalanceHistory {
  const { today } = opts;
  const n = opts.months ?? BALANCE_HISTORY_DEFAULT_MONTHS;
  const cur = `${today.slice(0, 7)}-01`;
  // 古い順の月と、その月の残高を見る最後の日（今月は今日）。
  const ends = Array.from({ length: n }, (_, i) => {
    const s = addMonths(cur, i - (n - 1));
    return { month: s.slice(0, 7), to: i === n - 1 ? today : addDays(addMonths(s, 1), -1) };
  });
  const out: BalanceHistoryMonth[] = ends.map((e) => ({ month: e.month, total: 0, by_account: {} }));
  for (const a of listCashflowAccounts(db)) {
    if (!KINDS.has(a.kind)) continue;
    const rows = listTxnBalances(db, a.id, today);
    let i = 0;
    let last: number | null = null;
    ends.forEach((e, k) => {
      while (i < rows.length && rows[i]!.txn_date <= e.to) last = rows[i++]!.balance;
      let v = last ?? 0;
      if (k === n - 1) v = latestBalance(db, a.id)?.balance ?? v;
      out[k]!.by_account[a.id] = v;
      out[k]!.total += v;
    });
  }
  return { months: out };
}
