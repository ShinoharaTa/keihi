// 月末残高の推移（GET /api/balance_history）。今月を最後に、古い順に months か月分。
// 対象口座: include_in_cashflow = 1 かつ active = 1 で、kind が bank / wallet / paypay / cash（カードは残高を持たないので除く）。
// 各月の口座の残高は、その月末（今月は今日）までの次の 2 つのうち日付が新しいほう。同じ日なら残高の記録を採る。
//   - 残高の記録（account_balances）のうち as_of_date が最も新しいもの（同じ日なら seq が大きい方）
//   - 明細のうち balance が NULL でない最後のもの（txn_date, id の順で最後）
//   その月に無ければ直前の月の値を引き継ぐ（期間より前も見る）。今日より後の日付は見ない。どちらも無ければ 0。
// today は呼ぶ側が Asia/Tokyo の暦日で渡す。
import { addDays, addMonths } from '../calendar/businessDays.ts';
import { listCashflowAccounts } from '../cashflow/repo.ts';
import type { Db } from '../db/index.ts';
import { listBalancesUpTo, listTxnBalances } from './repo.ts';

export const BALANCE_HISTORY_DEFAULT_MONTHS = 12;
export const BALANCE_HISTORY_MAX_MONTHS = 60;
const KINDS = new Set(['bank', 'wallet', 'paypay', 'cash']);

export type BalanceHistoryMonth = { month: string; total: number; by_account: Record<string, number> };
export type BalanceHistory = { months: BalanceHistoryMonth[] };

// 日付の昇順の列を、to 以前の最後の 1 件まで読み進める。
function cursor(rows: { date: string; balance: number }[]) {
  let i = 0;
  let last: { date: string; balance: number } | null = null;
  return (to: string) => {
    while (i < rows.length && rows[i]!.date <= to) last = rows[i++]!;
    return last;
  };
}

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
    const rec = cursor(listBalancesUpTo(db, a.id, today).map((r) => ({ date: r.as_of_date, balance: r.balance })));
    const txn = cursor(listTxnBalances(db, a.id, today).map((r) => ({ date: r.txn_date, balance: r.balance })));
    ends.forEach((e, k) => {
      const r = rec(e.to);
      const t = txn(e.to);
      const v = r && (!t || r.date >= t.date) ? r.balance : (t?.balance ?? 0);
      out[k]!.by_account[a.id] = v;
      out[k]!.total += v;
    });
  }
  return { months: out };
}
