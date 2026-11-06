// 資金繰り表（docs/mvp-plan-v3.md T303・V11、requirements-v2.md D3）。今月（今日から）を 1 か月目として、月末残高を推定する。
// 起点: include_in_cashflow = 1 かつ active = 1 の口座の最新残高の合計（残高が無い口座は 0 として警告を出す）。
// 毎月: 予定収入 − 予定支出 + 予定外の収入の目安 − 予定外の支出の目安。今月は今日以降の予定と、目安の残り日数分（今日を含む）だけ。
// 予定外の目安: 今月より前の直近 N か月（[cashflow] unplanned_lookback_months）の各月について、
//   振替等（excludedFromCashflow）を除いた明細の合計から、その月に期日のあった予定項目の金額を引いたものの中央値（負なら 0）。
// 月末に残す額: 今日から [cashflow] reserve_months か月（今日を含み、応当日の前日まで）の予定支出の合計。
// 金額は整数の円。中央値（偶数個は中の 2 つの平均）と今月の按分は Math.round で丸める。
import { excludedFromCashflow } from '../bank/transfers.ts';
import { addDays, addMonths } from '../calendar/businessDays.ts';
import { DEFAULT_RESERVE_MONTHS, DEFAULT_UNPLANNED_LOOKBACK_MONTHS } from '../config.ts';
import type { Db } from '../db/index.ts';
import { listCashflowAccounts, listCashflowTxns, listScheduledItems, type Direction, type ScheduledItemRow } from './repo.ts';
import { nextDueDates } from './schedule.ts';

export const DEFAULT_FORECAST_MONTHS = 36;
export const FORECAST_MAX_MONTHS = 60;
// 最新残高の as_of_date がこの日数より古い（today − 7 日より前）口座は stale_balance。
export const STALE_BALANCE_DAYS = 7;

export type ForecastItem = { id: string; name: string; amount: number; direction: Direction; due: string };

export type ForecastMonth = {
  month: string; // YYYY-MM
  planned_in: number;
  planned_out: number;
  unplanned_in: number;
  unplanned_out: number;
  balance_end: number;
  margin: number;
  items: ForecastItem[];
};

export type ForecastWarning = { kind: 'no_balance' | 'stale_balance'; account_id: string; as_of_date?: string };

export type Forecast = {
  as_of: string;
  opening_balance: number;
  reserve: number;
  unplanned_out_per_month: number;
  unplanned_in_per_month: number;
  months: ForecastMonth[];
  first_shortfall_month: string | null;
  warnings: ForecastWarning[];
};

export type ForecastOptions = { today: string; months?: number; unplannedLookbackMonths?: number; reserveMonths?: number };

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (start: string) => addDays(addMonths(start, 1), -1);

// 中央値。偶数個なら中の 2 つの平均を丸める。空なら 0。
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[h] : Math.round((s[h - 1] + s[h]) / 2);
}

// 期日が from〜to（両端を含む）の予定。期日順（同じ日は台帳の作成順）。
function dueItems(items: ScheduledItemRow[], from: string, to: string): ForecastItem[] {
  const out: ForecastItem[] = [];
  for (const it of items) {
    for (const due of nextDueDates(it, from, to)) out.push({ id: it.id, name: it.name, amount: it.amount, direction: it.direction, due });
  }
  out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  return out;
}

const sumBy = (xs: ForecastItem[], dir: Direction) => xs.reduce((s, x) => (x.direction === dir ? s + x.amount : s), 0);

export function buildForecast(db: Db, opts: ForecastOptions): Forecast {
  const { today } = opts;
  const months = opts.months ?? DEFAULT_FORECAST_MONTHS;
  const lookback = opts.unplannedLookbackMonths ?? DEFAULT_UNPLANNED_LOOKBACK_MONTHS;
  const reserveMonths = opts.reserveMonths ?? DEFAULT_RESERVE_MONTHS;
  const items = listScheduledItems(db);

  // 1. 起点
  const warnings: ForecastWarning[] = [];
  let opening = 0;
  const staleBefore = addDays(today, -STALE_BALANCE_DAYS);
  for (const a of listCashflowAccounts(db)) {
    if (a.balance === null || a.as_of_date === null) {
      warnings.push({ kind: 'no_balance', account_id: a.id });
      continue;
    }
    opening += a.balance;
    if (a.as_of_date < staleBefore) warnings.push({ kind: 'stale_balance', account_id: a.id, as_of_date: a.as_of_date });
  }

  // 3. 予定外の目安（今月より前の直近 lookback か月）
  const cur = monthStart(today);
  const lookFrom = addMonths(cur, -lookback);
  const excluded = excludedFromCashflow(db);
  const inByMonth = new Map<string, number>();
  const outByMonth = new Map<string, number>();
  for (const t of listCashflowTxns(db, lookFrom, addDays(cur, -1))) {
    if (excluded.has(t.id)) continue;
    const m = t.txn_date.slice(0, 7);
    const map = t.side === 'income' ? inByMonth : outByMonth;
    map.set(m, (map.get(m) ?? 0) + t.amount);
  }
  const netIn: number[] = [];
  const netOut: number[] = [];
  for (let k = lookback; k >= 1; k--) {
    const s = addMonths(cur, -k);
    const due = dueItems(items, s, monthEnd(s));
    const m = s.slice(0, 7);
    netIn.push((inByMonth.get(m) ?? 0) - sumBy(due, 'in'));
    netOut.push((outByMonth.get(m) ?? 0) - sumBy(due, 'out'));
  }
  const unplannedIn = Math.max(0, median(netIn));
  const unplannedOut = Math.max(0, median(netOut));

  // 5. 月末に残す額
  const reserve = sumBy(dueItems(items, today, addDays(addMonths(today, reserveMonths), -1)), 'out');

  // 4. 月末残高
  const out: ForecastMonth[] = [];
  let balance = opening;
  let shortfall: string | null = null;
  for (let k = 0; k < months; k++) {
    const s = addMonths(cur, k);
    const e = monthEnd(s);
    const due = dueItems(items, k === 0 ? today : s, e);
    let uIn = unplannedIn;
    let uOut = unplannedOut;
    if (k === 0) {
      const days = Number(e.slice(8, 10));
      const left = days - Number(today.slice(8, 10)) + 1;
      uIn = Math.round((unplannedIn * left) / days);
      uOut = Math.round((unplannedOut * left) / days);
    }
    const pIn = sumBy(due, 'in');
    const pOut = sumBy(due, 'out');
    balance += pIn - pOut + uIn - uOut;
    const margin = balance - reserve;
    const month = s.slice(0, 7);
    if (shortfall === null && margin < 0) shortfall = month;
    out.push({ month, planned_in: pIn, planned_out: pOut, unplanned_in: uIn, unplanned_out: uOut, balance_end: balance, margin, items: due });
  }

  return {
    as_of: today,
    opening_balance: opening,
    reserve,
    unplanned_out_per_month: unplannedOut,
    unplanned_in_per_month: unplannedIn,
    months: out,
    first_shortfall_month: shortfall,
    warnings,
  };
}
