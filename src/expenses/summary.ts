// 経費の一覧（docs/cashflow.md §16.1、GET /api/expenses）。期間（月の範囲、最大 MAX_EXPENSE_MONTHS か月）の経費の明細を
// 月ごと・相手（description_norm）ごとに集計する。
// - 経費の明細は match.ts の定義（効くタグが business・side = expense・振替の除外でない・active な口座）。receipt（receiptStatusBulk）が
//   null でない明細がちょうどそれなので、receipt で判定する。waiting_count は receipt = waiting の件数。
// - months は古い順で、0 件の月も出す。
// - vendors は amount の多い順（同額は件数の多い順、さらに vendor_key 順）に上位 MAX_VENDORS 件。残りがあれば「その他」1 行
//   （vendor_key = null）を最後に付ける。label はその相手の最新の明細（txn_date, id が最大）の description。category は期間内で
//   最も多いカテゴリ（同数なら新しい明細のもの、全部未分類なら null）。
import type { Db } from '../db/index.ts';
import { listBankTxnsBetween } from '../bank/repo.ts';
import { DEFAULT_MATCH_WINDOWS, receiptStatusBulk, type MatchWindows } from '../bank/match.ts';
import { isMonth, SummaryError } from '../bank/summary.ts';
import { resolveTagsBulk } from '../bank/tags.ts';

export const MAX_EXPENSE_MONTHS = 12;
export const MAX_VENDORS = 50;
export const OTHER_VENDORS_LABEL = 'その他';

export type ExpenseTotal = { amount: number; count: number; waiting_count: number; waiting_amount: number };
export type ExpenseMonth = { month: string; amount: number; count: number; waiting_count: number };
export type ExpenseVendor = { vendor_key: string | null; label: string; count: number; amount: number; waiting_count: number; category: string | null };
export type ExpensesSummary = { from: string; to: string; total: ExpenseTotal; months: ExpenseMonth[]; vendors: ExpenseVendor[] };

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// クエリ（month、または from と to）を月の並びにする。不正なら SummaryError（400）。
export function parseExpensesRange(q: { month?: string; from?: string; to?: string }): string[] {
  if (q.month !== undefined) {
    if (q.from !== undefined || q.to !== undefined) throw new SummaryError('month_and_range');
    if (!isMonth(q.month)) throw new SummaryError('invalid_month');
    return [q.month];
  }
  if (q.from === undefined || q.to === undefined) throw new SummaryError('month_required');
  if (!isMonth(q.from) || !isMonth(q.to)) throw new SummaryError('invalid_month');
  if (q.from > q.to) throw new SummaryError('invalid_range');
  const out: string[] = [];
  for (let m = q.from; m <= q.to; m = nextMonth(m)) {
    out.push(m);
    if (out.length > MAX_EXPENSE_MONTHS) throw new SummaryError('range_too_long');
  }
  return out;
}

type VendorAcc = {
  vendor_key: string;
  label: string;
  latest: string;
  count: number;
  amount: number;
  waiting_count: number;
  // カテゴリ → 件数と最新の明細のキー。
  categories: Map<string, { count: number; latest: string }>;
};

// 明細の新しさのキー（txn_date, id の順。bank_txns の一覧と同じ並び）。
const recency = (r: { txn_date: string; id: string }) => `${r.txn_date}\u0000${r.id}`;

function topCategory(v: VendorAcc): string | null {
  let best: { category: string; count: number; latest: string } | null = null;
  for (const [category, c] of v.categories) {
    if (!best || c.count > best.count || (c.count === best.count && c.latest > best.latest)) best = { category, ...c };
  }
  return best?.category ?? null;
}

// months は YYYY-MM の古い順の並び（parseExpensesRange の結果）。
export function expensesSummary(db: Db, months: readonly string[], opts: { matchWindows?: MatchWindows } = {}): ExpensesSummary {
  const from = months[0]!;
  const to = months[months.length - 1]!;
  const rows = listBankTxnsBetween(db, `${from}-01`, lastDay(to)).filter((r) => r.side === 'expense');
  const receipts = receiptStatusBulk(db, rows.map((r) => r.id), opts.matchWindows ?? DEFAULT_MATCH_WINDOWS);
  const expenses = rows.filter((r) => receipts.get(r.id)?.receipt != null);
  const tags = resolveTagsBulk(db, expenses.map((r) => r.id));

  const total: ExpenseTotal = { amount: 0, count: 0, waiting_count: 0, waiting_amount: 0 };
  const byMonth = new Map<string, ExpenseMonth>(months.map((m) => [m, { month: m, amount: 0, count: 0, waiting_count: 0 }]));
  const vendors = new Map<string, VendorAcc>();
  for (const r of expenses) {
    const waiting = receipts.get(r.id)!.receipt === 'waiting' ? 1 : 0;
    total.amount += r.amount;
    total.count++;
    total.waiting_count += waiting;
    total.waiting_amount += waiting * r.amount;
    const m = byMonth.get(r.txn_date.slice(0, 7))!;
    m.amount += r.amount;
    m.count++;
    m.waiting_count += waiting;
    const key = recency(r);
    let v = vendors.get(r.description_norm);
    if (!v) {
      v = { vendor_key: r.description_norm, label: r.description, latest: key, count: 0, amount: 0, waiting_count: 0, categories: new Map() };
      vendors.set(r.description_norm, v);
    }
    if (key > v.latest) {
      v.latest = key;
      v.label = r.description;
    }
    v.count++;
    v.amount += r.amount;
    v.waiting_count += waiting;
    const cat = tags.get(r.id)?.category ?? null;
    if (cat !== null) {
      const c = v.categories.get(cat);
      if (!c) v.categories.set(cat, { count: 1, latest: key });
      else {
        c.count++;
        if (key > c.latest) c.latest = key;
      }
    }
  }

  const sorted = [...vendors.values()].sort(
    (a, b) => b.amount - a.amount || b.count - a.count || (a.vendor_key < b.vendor_key ? -1 : a.vendor_key > b.vendor_key ? 1 : 0),
  );
  const out: ExpenseVendor[] = sorted.slice(0, MAX_VENDORS).map((v) => ({
    vendor_key: v.vendor_key,
    label: v.label,
    count: v.count,
    amount: v.amount,
    waiting_count: v.waiting_count,
    category: topCategory(v),
  }));
  const rest = sorted.slice(MAX_VENDORS);
  if (rest.length > 0) {
    out.push({
      vendor_key: null,
      label: OTHER_VENDORS_LABEL,
      count: rest.reduce((s, v) => s + v.count, 0),
      amount: rest.reduce((s, v) => s + v.amount, 0),
      waiting_count: rest.reduce((s, v) => s + v.waiting_count, 0),
      category: null,
    });
  }
  return { from, to, total, months: [...byMonth.values()], vendors: out };
}
