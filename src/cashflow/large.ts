// 大きな出費（5 万円以上。docs/cashflow.md §15）。周期の検出に掛からない大口の支出を一覧し、人が「毎月 / 毎年 / 2 年ごと / 1 回だけ / しない」を選ぶ。
// 一覧は読むたびに明細から計算する（保存しない）。保存するのは判断だけ（large_expense_decisions。追記専用、明細 1 件に 1 回）。
// 対象の明細: 今日の LARGE_LOOKBACK_MONTHS か月前〜今日の、LARGE_MIN_AMOUNT 円以上の支出（active かつ include_in_cashflow の口座）。除くもの:
//   - 振替・カードの引き落とし・チャージ（§4 の除外）
//   - open・accepted の周期の候補の occurrences に入っている明細（候補の方で扱う）
//   - 判断済みの明細と、同じ口座・摘要でその明細日以前の明細
//   - active な台帳の項目（origin を問わない。account_id が NULL か同じ口座）で、期日が明細日 ±ITEM_WINDOW_DAYS 日・金額 ±ITEM_TOLERANCE_PCT % のものがある明細
//     （税の見積もりで既に入っている納付など）
// 一覧は同じ口座・正規化摘要の明細を 1 行にまとめる（bank_txn_id・金額・日付は最新の明細）。判断はその最新の明細に記録する。
// 予定にすると台帳に origin = detected・direction = out・amount_kind = fixed で入る。
import { appendAudit } from '../audit.ts';
import { excludedFromCashflow } from '../bank/transfers.ts';
import { addDays, addMonths } from '../calendar/businessDays.ts';
import { tx, type Db } from '../db/index.ts';
import {
  candidateTxnIds,
  listDecidedLargeExpenseTxns,
  getLargeExpenseDecision,
  insertLargeExpenseDecision,
  listExpenseTxnsForDetect,
  listLargeExpenseTxns,
  listScheduledItems,
  type Category,
  type LargeExpenseDecisionRow,
  type LargeExpenseTxnRow,
  type ScheduledItemRow,
} from './repo.ts';
import { DEFAULT_NOTIFY_DAYS_BEFORE, ScheduleError, createItem, isDate, nextDueDates, type By } from './schedule.ts';

export const LARGE_MIN_AMOUNT = 50_000;
export const LARGE_LOOKBACK_MONTHS = 24;
export const LARGE_LIST_MAX = 50;
// 台帳の項目と同じ支払いとみなす幅（期日のずれの日数と、金額の差 %。大きい方が小さい方の 110% 以下）。
const ITEM_WINDOW_DAYS = 7;
const ITEM_TOLERANCE_PCT = 10;
// suggested: 同じ口座・摘要の大口がこの回数以上なら毎月。そうでなく同じ摘要の明細がこの日数だけ前にあれば毎年 / 2 年ごと。
const MONTHLY_MIN_COUNT = 6;
const YEARLY_DAYS = [350, 380] as const;
const BIENNIAL_DAYS = [715, 745] as const;

export const LARGE_RECURRENCES = ['monthly', 'yearly', 'biennial', 'once'] as const;
// anchor_date の既定（明細日に足す月数）。once は既定が無い。
const DEFAULT_ANCHOR_MONTHS = { monthly: 1, yearly: 12, biennial: 24 } as const;
export type LargeRecurrence = (typeof LARGE_RECURRENCES)[number];

export type LargeExpense = {
  bank_txn_id: string;
  account_id: string;
  account_name: string;
  txn_date: string;
  amount: number;
  description: string;
  description_norm: string;
  same_desc_count: number; // この行にまとめた明細（同じ口座・摘要の対象の明細）の件数
  total_amount: number; // その合計
  first_date: string; // そのうち最も古い明細日
  suggested: 'monthly' | 'yearly' | 'biennial';
};

const dayNumber = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
const nearAmount = (a: number, b: number) => Math.max(a, b) * 100 <= Math.min(a, b) * (100 + ITEM_TOLERANCE_PCT);

// 台帳の項目に、同じ支払いとみなすものがあるか。
function coveredByItem(t: LargeExpenseTxnRow, items: ScheduledItemRow[]): boolean {
  return items.some(
    (it) =>
      (it.account_id === null || it.account_id === t.account_id) &&
      nearAmount(it.amount, t.amount) &&
      nextDueDates(it, addDays(t.txn_date, -ITEM_WINDOW_DAYS), addDays(t.txn_date, ITEM_WINDOW_DAYS)).length > 0,
  );
}

// 一覧に出せる行をすべて（上限なし。最新の明細日の新しい順）。
function eligible(db: Db, today: string): LargeExpense[] {
  const from = addMonths(today, -LARGE_LOOKBACK_MONTHS);
  const excluded = excludedFromCashflow(db);
  const inCandidates = candidateTxnIds(db);
  const items = listScheduledItems(db);
  const key = (t: { account_id: string; description_norm: string }) => JSON.stringify([t.account_id, t.description_norm]);
  // 同じ口座・摘要で判断済みの明細のうち最も新しい明細日（その日以前の明細は出さない）。
  const decidedUntil = new Map<string, string>();
  for (const d of listDecidedLargeExpenseTxns(db)) {
    const k = key(d);
    if (d.txn_date > (decidedUntil.get(k) ?? '')) decidedUntil.set(k, d.txn_date);
  }
  // 同じ口座・摘要の支出の日付（suggested の毎年 / 2 年ごとに使う。金額は問わない）。
  const dates = new Map<string, string[]>();
  for (const t of listExpenseTxnsForDetect(db, from, today)) {
    if (excluded.has(t.id)) continue;
    const k = key(t);
    const g = dates.get(k);
    if (g) g.push(t.txn_date);
    else dates.set(k, [t.txn_date]);
  }
  // 新しい順に読むので、各まとまりの先頭が最新の明細。
  const groups = new Map<string, LargeExpenseTxnRow[]>();
  for (const t of listLargeExpenseTxns(db, from, today, LARGE_MIN_AMOUNT)) {
    const k = key(t);
    const until = decidedUntil.get(k);
    if (excluded.has(t.id) || inCandidates.has(t.id) || (until !== undefined && t.txn_date <= until) || coveredByItem(t, items)) continue;
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  const out: LargeExpense[] = [];
  for (const [k, g] of groups) {
    const t = g[0];
    const before = (dates.get(k) ?? []).map((d) => dayNumber(t.txn_date) - dayNumber(d));
    const within = ([lo, hi]: readonly [number, number]) => before.some((n) => n >= lo && n <= hi);
    out.push({
      bank_txn_id: t.id,
      account_id: t.account_id,
      account_name: t.account_name,
      txn_date: t.txn_date,
      amount: t.amount,
      description: t.description,
      description_norm: t.description_norm,
      same_desc_count: g.length,
      total_amount: g.reduce((a, x) => a + x.amount, 0),
      first_date: g[g.length - 1].txn_date,
      suggested: g.length >= MONTHLY_MIN_COUNT ? 'monthly' : within(YEARLY_DAYS) ? 'yearly' : within(BIENNIAL_DAYS) ? 'biennial' : 'yearly',
    });
  }
  // まとまりは最新の明細が新しい順に作られている（Map は入れた順）。
  return out;
}

// 一覧（最新の明細日の新しい順、上限 LARGE_LIST_MAX 行）。today は Asia/Tokyo の暦日。
export function listLargeExpenses(db: Db, today: string): LargeExpense[] {
  return eligible(db, today).slice(0, LARGE_LIST_MAX);
}

function findEligible(db: Db, bankTxnId: string, today: string): LargeExpense {
  const x = eligible(db, today).find((e) => e.bank_txn_id === bankTxnId);
  if (!x) throw new ScheduleError('not_found', 404);
  return x;
}

export type ScheduleLargeInput = { recurrence?: unknown; category?: Category; name?: string; amount?: number; anchor_date?: unknown };

// 予定にする: 台帳の項目を作り（createItem が値を確かめ、監査に残す）、判断を残す。
// bank_txn_id は一覧の行の明細（最新の明細）。anchor_date の既定は monthly が明細日 + 1 か月、yearly が + 12 か月、biennial が + 24 か月
// （応当日が無ければ月末）。once は今日より後の anchor_date が要る。判断済みは 409 already_decided、一覧の行の明細でなければ 404。
export function scheduleLargeExpense(
  db: Db,
  bankTxnId: string,
  input: ScheduleLargeInput,
  by: By,
  opts: { today: string; now?: Date },
): { decision: LargeExpenseDecisionRow; item: ScheduledItemRow } {
  const now = opts.now ?? new Date();
  return tx(db, () => {
    if (getLargeExpenseDecision(db, bankTxnId)) throw new ScheduleError('already_decided', 409);
    const x = findEligible(db, bankTxnId, opts.today);
    const recurrence = input.recurrence;
    if (!(LARGE_RECURRENCES as readonly unknown[]).includes(recurrence)) throw new ScheduleError('invalid_recurrence');
    let anchorDate: unknown;
    if (recurrence === 'once') {
      if (input.anchor_date === undefined) throw new ScheduleError('anchor_date_required');
      if (!isDate(input.anchor_date)) throw new ScheduleError('invalid_anchor_date');
      if (input.anchor_date <= opts.today) throw new ScheduleError('anchor_date_required');
      anchorDate = input.anchor_date;
    } else {
      anchorDate = input.anchor_date ?? addMonths(x.txn_date, DEFAULT_ANCHOR_MONTHS[recurrence as Exclude<LargeRecurrence, 'once'>]);
    }
    const item = createItem(
      db,
      {
        name: input.name ?? x.description_norm,
        amount: input.amount ?? x.amount,
        direction: 'out',
        category: input.category ?? 'other',
        accountId: x.account_id,
        recurrence: recurrence as LargeRecurrence,
        anchorDate: anchorDate as string,
        endDate: null,
        notifyDaysBefore: DEFAULT_NOTIFY_DAYS_BEFORE,
        origin: 'detected',
        amountKind: 'fixed',
      },
      by,
      now,
    );
    const decision = insertLargeExpenseDecision(db, { bankTxnId, decision: 'scheduled', scheduledItemId: item.id, now: now.toISOString() });
    appendAudit(
      db,
      { actor: by.actor, action: 'large_expense.scheduled', entity: 'large_expense', entityId: bankTxnId, payload: { scheduled_item_id: item.id, recurrence, user: by.user ?? null } },
      now,
    );
    return { decision, item };
  });
}

// しない: 判断を残す。既に dismissed ならそのまま返す（監査ログは書かない）。scheduled は 409 already_decided。
export function dismissLargeExpense(db: Db, bankTxnId: string, by: By, opts: { today: string; now?: Date }): LargeExpenseDecisionRow {
  const now = opts.now ?? new Date();
  return tx(db, () => {
    const cur = getLargeExpenseDecision(db, bankTxnId);
    if (cur?.decision === 'dismissed') return cur;
    if (cur) throw new ScheduleError('already_decided', 409);
    findEligible(db, bankTxnId, opts.today);
    const decision = insertLargeExpenseDecision(db, { bankTxnId, decision: 'dismissed', scheduledItemId: null, now: now.toISOString() });
    appendAudit(db, { actor: by.actor, action: 'large_expense.dismissed', entity: 'large_expense', entityId: bankTxnId, payload: { user: by.user ?? null } }, now);
    return decision;
  });
}
