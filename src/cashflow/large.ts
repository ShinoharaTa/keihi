// 大きな出費（5 万円以上。docs/cashflow.md §15）。周期の検出に掛からない単発の大口の支出を一覧し、人が「毎年 / 2 年ごと / 1 回だけ / しない」を選ぶ。
// 一覧は読むたびに明細から計算する（保存しない）。保存するのは判断だけ（large_expense_decisions。追記専用、明細 1 件に 1 回）。
// 一覧に出す: 今日の LARGE_LOOKBACK_MONTHS か月前〜今日の、LARGE_MIN_AMOUNT 円以上の支出（active かつ include_in_cashflow の口座）。除くもの:
//   - 振替・カードの引き落とし・チャージ（§4 の除外）
//   - open・accepted の周期の候補の occurrences に入っている明細（候補の方で扱う）
//   - 判断済みの明細
//   - active な台帳の項目（origin を問わない。account_id が NULL か同じ口座）で、期日が明細日 ±ITEM_WINDOW_DAYS 日・金額 ±ITEM_TOLERANCE_PCT % のものがある明細
//     （税の見積もりで既に入っている納付など）
// 予定にすると台帳に origin = detected・direction = out・amount_kind = fixed で入る。
import { appendAudit } from '../audit.ts';
import { excludedFromCashflow } from '../bank/transfers.ts';
import { addDays, addMonths } from '../calendar/businessDays.ts';
import { tx, type Db } from '../db/index.ts';
import {
  candidateTxnIds,
  decidedLargeExpenseTxnIds,
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
// suggested: 同じ摘要の明細がこの日数だけ前にあれば毎年 / 2 年ごと。
const YEARLY_DAYS = [350, 380] as const;
const BIENNIAL_DAYS = [715, 745] as const;

export const LARGE_RECURRENCES = ['yearly', 'biennial', 'once'] as const;
export type LargeRecurrence = (typeof LARGE_RECURRENCES)[number];

export type LargeExpense = {
  bank_txn_id: string;
  account_id: string;
  account_name: string;
  txn_date: string;
  amount: number;
  description: string;
  description_norm: string;
  same_desc_count: number; // 同じ口座・摘要の、期間内の支出の回数（この明細を含む。§4 の除外は数えない）
  suggested: 'yearly' | 'biennial';
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

// 一覧に出せる明細をすべて（上限なし。新しい順）。
function eligible(db: Db, today: string): LargeExpense[] {
  const from = addMonths(today, -LARGE_LOOKBACK_MONTHS);
  const excluded = excludedFromCashflow(db);
  const inCandidates = candidateTxnIds(db);
  const decided = decidedLargeExpenseTxnIds(db);
  const items = listScheduledItems(db);
  // 同じ口座・摘要の支出の日付（回数と suggested に使う）。
  const dates = new Map<string, string[]>();
  const key = (accountId: string, desc: string) => JSON.stringify([accountId, desc]);
  for (const t of listExpenseTxnsForDetect(db, from, today)) {
    if (excluded.has(t.id)) continue;
    const k = key(t.account_id, t.description_norm);
    dates.set(k, [...(dates.get(k) ?? []), t.txn_date]);
  }
  const out: LargeExpense[] = [];
  for (const t of listLargeExpenseTxns(db, from, today, LARGE_MIN_AMOUNT)) {
    if (excluded.has(t.id) || inCandidates.has(t.id) || decided.has(t.id) || coveredByItem(t, items)) continue;
    const same = dates.get(key(t.account_id, t.description_norm)) ?? [];
    const before = same.map((d) => dayNumber(t.txn_date) - dayNumber(d));
    const within = ([lo, hi]: readonly [number, number]) => before.some((n) => n >= lo && n <= hi);
    out.push({
      bank_txn_id: t.id,
      account_id: t.account_id,
      account_name: t.account_name,
      txn_date: t.txn_date,
      amount: t.amount,
      description: t.description,
      description_norm: t.description_norm,
      same_desc_count: same.length,
      suggested: within(YEARLY_DAYS) ? 'yearly' : within(BIENNIAL_DAYS) ? 'biennial' : 'yearly',
    });
  }
  return out;
}

// 一覧（新しい順、上限 LARGE_LIST_MAX 件）。today は Asia/Tokyo の暦日。
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
// anchor_date の既定は yearly が明細日 + 12 か月、biennial が + 24 か月（応当日が無ければ月末）。once は今日より後の anchor_date が要る。
// 判断済みは 409 already_decided、一覧に出せない明細は 404。
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
      anchorDate = input.anchor_date ?? addMonths(x.txn_date, recurrence === 'yearly' ? 12 : 24);
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
