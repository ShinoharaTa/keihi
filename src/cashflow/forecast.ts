// 資金繰り表（docs/mvp-plan-v3.md T303・V11、requirements-v2.md D3）。今月を 1 か月目として、月末残高を推定する。
// 対象口座: include_in_cashflow = 1 かつ active = 1。
// 起点: 対象口座の最新残高の合計（残高が無い口座は 0 として no_balance。カードは残高が無いのが正常なので出さない）。
//   今日付の残高には今日の入出金が反映済みとみなし、今月は今日の翌日からの予定と、目安の残り日数分（今日を含まない）だけを足し引きする。
// 毎月: 予定収入 − 予定支出 − 予定外の支出の目安（[cashflow] include_unplanned_income = true のときだけ + 予定外の収入の目安）。
// 予定外の目安: 今月より前の直近 N か月（[cashflow] unplanned_lookback_months）のうち、対象口座の最初の明細の月より後の月について、
//   対象口座どうしの振替等を除いた明細の合計から、その月に期日のあった予定項目の金額を引いたものの中央値（負なら 0）。
//   振替・チャージは出金側と入金側の両方が対象口座のときだけ、カードの引き落としはカードの口座が対象のときだけ除く。
//   控除する予定は停止したものも含め（期日は anchor_date・end_date から出す）、account_id が null か対象口座のものだけ。
//   使える月が N か月に満たなければ short_history の警告を出す（0 か月なら目安は 0）。
// 月末に残す額: 各月について、その月末の翌日から [cashflow] reserve_months か月の予定支出の合計。
//   トップレベルの reserve は今日から reserve_months か月（今日を含み、応当日の前日まで）の予定支出の合計。
// min_month: margin が最小の月（同じなら早い月）。
// cut_per_month_to_survive: 予定外の支出の目安（unplanned_out_per_month）を毎月いくら減らせば、全期間で margin ≥ 0 になるかの最小の整数。
//   減らした目安で今月の按分もし直す。不足が無ければ 0、目安を 0 にしても足りなければ null。margin は減らすほど増えるので二分探索。
// 金額は整数の円。中央値（偶数個は中の 2 つの平均）と今月の按分は Math.round で丸める。
import { listActiveTransfers, matchesSettlementPattern } from '../bank/transfers.ts';
import { addDays, addMonths } from '../calendar/businessDays.ts';
import { DEFAULT_RESERVE_MONTHS, DEFAULT_UNPLANNED_LOOKBACK_MONTHS } from '../config.ts';
import type { Db } from '../db/index.ts';
import {
  firstCashflowTxnDate,
  listCashflowAccounts,
  listCashflowTxns,
  listScheduledItems,
  txnAccounts,
  type AmountKind,
  type CashflowAccountRow,
  type Direction,
  type Origin,
  type ScheduledItemRow,
} from './repo.ts';
import { nextDueDates } from './schedule.ts';

export const DEFAULT_FORECAST_MONTHS = 36;
export const FORECAST_MAX_MONTHS = 60;
// 最新残高の as_of_date がこの日数より古い（today − 7 日より前）口座は stale_balance。
export const STALE_BALANCE_DAYS = 7;

export type ForecastItem = {
  id: string;
  name: string;
  amount: number;
  direction: Direction;
  due: string;
  origin: Origin;
  estimate_key: string | null;
  pinned: 0 | 1;
  amount_kind: AmountKind; // variable の amount は概算（代表値をそのまま積む）
};

export type ForecastMonth = {
  month: string; // YYYY-MM
  planned_in: number;
  planned_out: number;
  unplanned_in: number; // 残高に足した分（include_unplanned_income = false なら 0）
  unplanned_out: number;
  balance_end: number;
  reserve: number;
  margin: number;
  items: ForecastItem[];
};

export type ForecastWarning =
  | { kind: 'no_balance'; account_id: string }
  | { kind: 'stale_balance'; account_id: string; as_of_date: string }
  | { kind: 'short_history'; months_available: number };

export type Forecast = {
  as_of: string;
  opening_balance: number;
  reserve: number;
  unplanned_out_per_month: number;
  unplanned_in_per_month: number;
  months: ForecastMonth[];
  first_shortfall_month: string | null;
  min_month: { month: string; balance_end: number; margin: number } | null; // months が空のときだけ null
  cut_per_month_to_survive: number | null;
  warnings: ForecastWarning[];
};

export type ForecastOptions = {
  today: string;
  months?: number;
  unplannedLookbackMonths?: number;
  reserveMonths?: number;
  includeUnplannedIncome?: boolean;
};

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
    for (const due of nextDueDates(it, from, to)) {
      out.push({ id: it.id, name: it.name, amount: it.amount, direction: it.direction, due, origin: it.origin, estimate_key: it.estimate_key, pinned: it.pinned, amount_kind: it.amount_kind });
    }
  }
  out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  return out;
}

const sumBy = (xs: ForecastItem[], dir: Direction) => xs.reduce((s, x) => (x.direction === dir ? s + x.amount : s), 0);

// 予定外の目安から除く明細の ID。振替・チャージは両側が対象口座のとき、カードの引き落としはカードの口座が対象のときだけ。
// 引き落としのカードは、引き落とし口座と摘要のパターンが合う対象のカードがあるかで見る（transfer_links にカードの口座は無い）。
function excludedTxns(db: Db, accounts: CashflowAccountRow[]): Set<string> {
  const target = new Set(accounts.map((a) => a.id));
  const cards = accounts.filter((a) => a.kind === 'card' && a.card_settlement_account_id !== null);
  const links = listActiveTransfers(db);
  const ids = links.flatMap((l) => (l.in_txn_id ? [l.out_txn_id, l.in_txn_id] : [l.out_txn_id]));
  const acc = txnAccounts(db, ids);
  const s = new Set<string>();
  for (const l of links) {
    const o = acc.get(l.out_txn_id);
    if (!o) continue;
    if (l.kind === 'card_settlement') {
      if (cards.some((c) => c.card_settlement_account_id === o.account_id && matchesSettlementPattern(o.description, c.card_settlement_pattern))) {
        s.add(l.out_txn_id);
      }
      continue;
    }
    const i = l.in_txn_id ? acc.get(l.in_txn_id) : undefined;
    if (i && target.has(o.account_id) && target.has(i.account_id)) {
      s.add(l.out_txn_id);
      s.add(l.in_txn_id!);
    }
  }
  return s;
}

export function buildForecast(db: Db, opts: ForecastOptions): Forecast {
  const { today } = opts;
  const months = opts.months ?? DEFAULT_FORECAST_MONTHS;
  const lookback = opts.unplannedLookbackMonths ?? DEFAULT_UNPLANNED_LOOKBACK_MONTHS;
  const reserveMonths = opts.reserveMonths ?? DEFAULT_RESERVE_MONTHS;
  const includeIn = opts.includeUnplannedIncome ?? false;
  const items = listScheduledItems(db);
  const accounts = listCashflowAccounts(db);

  // 1. 起点
  const warnings: ForecastWarning[] = [];
  let opening = 0;
  const staleBefore = addDays(today, -STALE_BALANCE_DAYS);
  for (const a of accounts) {
    if (a.balance === null || a.as_of_date === null) {
      if (a.kind !== 'card') warnings.push({ kind: 'no_balance', account_id: a.id });
      continue;
    }
    opening += a.balance;
    if (a.as_of_date < staleBefore) warnings.push({ kind: 'stale_balance', account_id: a.id, as_of_date: a.as_of_date });
  }

  // 3. 予定外の目安（今月より前の直近 lookback か月のうち、最初の明細の月より後の月）
  const cur = monthStart(today);
  const first = firstCashflowTxnDate(db);
  const usable: string[] = [];
  for (let k = lookback; k >= 1; k--) {
    const s = addMonths(cur, -k);
    if (first !== null && s.slice(0, 7) > first.slice(0, 7)) usable.push(s);
  }
  if (usable.length < lookback) warnings.push({ kind: 'short_history', months_available: usable.length });
  let unplannedIn = 0;
  let unplannedOut = 0;
  if (usable.length > 0) {
    const target = new Set(accounts.map((a) => a.id));
    const excluded = excludedTxns(db, accounts);
    const inByMonth = new Map<string, number>();
    const outByMonth = new Map<string, number>();
    for (const t of listCashflowTxns(db, usable[0], addDays(cur, -1))) {
      if (excluded.has(t.id)) continue;
      const m = t.txn_date.slice(0, 7);
      const map = t.side === 'income' ? inByMonth : outByMonth;
      map.set(m, (map.get(m) ?? 0) + t.amount);
    }
    // 履歴から引く予定は、停止したものも含め、口座が無いか対象口座のもの。
    const pastItems = listScheduledItems(db, { includeInactive: true })
      .filter((it) => it.account_id === null || target.has(it.account_id))
      .map((it) => ({ ...it, active: 1 as const }));
    const netIn: number[] = [];
    const netOut: number[] = [];
    for (const s of usable) {
      const due = dueItems(pastItems, s, monthEnd(s));
      const m = s.slice(0, 7);
      netIn.push((inByMonth.get(m) ?? 0) - sumBy(due, 'in'));
      netOut.push((outByMonth.get(m) ?? 0) - sumBy(due, 'out'));
    }
    unplannedIn = Math.max(0, median(netIn));
    unplannedOut = Math.max(0, median(netOut));
  }

  // 5. 今日時点の月末に残す額
  const reserve = sumBy(dueItems(items, today, addDays(addMonths(today, reserveMonths), -1)), 'out');

  // 4. 月末残高。予定外の支出の目安だけを変えて引き直せるよう、月ごとの予定・残す額・按分を先に出す。
  const plans = Array.from({ length: months }, (_, k) => {
    const s = addMonths(cur, k);
    const e = monthEnd(s);
    const due = dueItems(items, k === 0 ? addDays(today, 1) : s, e);
    let uIn = includeIn ? unplannedIn : 0;
    // 今月は残りの日数で按分する（share = 残り日数 / 月の日数）。
    let share: [number, number] | null = null;
    if (k === 0) {
      const days = Number(e.slice(8, 10));
      share = [days - Number(today.slice(8, 10)), days];
      uIn = Math.round((uIn * share[0]) / share[1]);
    }
    return {
      month: s.slice(0, 7),
      due,
      pIn: sumBy(due, 'in'),
      pOut: sumBy(due, 'out'),
      uIn,
      share,
      reserve: sumBy(dueItems(items, addMonths(s, 1), monthEnd(addMonths(s, reserveMonths))), 'out'),
    };
  });
  const project = (perMonthOut: number): ForecastMonth[] => {
    let balance = opening;
    return plans.map((p) => {
      const uOut = p.share ? Math.round((perMonthOut * p.share[0]) / p.share[1]) : perMonthOut;
      balance += p.pIn - p.pOut + p.uIn - uOut;
      return {
        month: p.month, planned_in: p.pIn, planned_out: p.pOut, unplanned_in: p.uIn, unplanned_out: uOut, balance_end: balance, reserve: p.reserve,
        margin: balance - p.reserve, items: p.due,
      };
    });
  };
  const out = project(unplannedOut);
  const shortfall = out.find((m) => m.margin < 0)?.month ?? null;
  let minMonth: ForecastMonth | null = null;
  for (const m of out) if (minMonth === null || m.margin < minMonth.margin) minMonth = m;

  // 6. 不足を避けるのに要る、予定外の支出の毎月の削減額（cut 円減らせば足りる最小の cut）。
  const survives = (cut: number) => project(unplannedOut - cut).every((m) => m.margin >= 0);
  let cut: number | null = 0;
  if (shortfall !== null) {
    if (!survives(unplannedOut)) cut = null;
    else {
      let lo = 0; // lo では足りない
      let hi = unplannedOut; // hi なら足りる
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (survives(mid)) hi = mid;
        else lo = mid;
      }
      cut = hi;
    }
  }

  return {
    as_of: today,
    opening_balance: opening,
    reserve,
    unplanned_out_per_month: unplannedOut,
    unplanned_in_per_month: unplannedIn,
    months: out,
    first_shortfall_month: shortfall,
    min_month: minMonth && { month: minMonth.month, balance_end: minMonth.balance_end, margin: minMonth.margin },
    cut_per_month_to_survive: cut,
    warnings,
  };
}
