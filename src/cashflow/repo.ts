// 予定の台帳と周期の候補の表への読み書き（docs/mvp-plan-v3.md T301、0006_cashflow.sql）。SQL はここに閉じ込める。
// 値の検査・期日の計算・監査ログは src/cashflow/schedule.ts（呼ぶ側が同じトランザクションで残す）。
import type { Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';

export const DIRECTIONS = ['in', 'out'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const CATEGORIES = ['tax', 'insurance', 'car', 'other', 'income'] as const;
export type Category = (typeof CATEGORIES)[number];
export const RECURRENCES = ['once', 'monthly', 'bimonthly', 'yearly', 'biennial'] as const;
export type Recurrence = (typeof RECURRENCES)[number];
export const ORIGINS = ['manual', 'detected', 'estimate'] as const;
export type Origin = (typeof ORIGINS)[number];
export const INTERVALS = ['monthly', 'bimonthly', 'yearly', 'biennial'] as const;
export type Interval = (typeof INTERVALS)[number];
export const CANDIDATE_STATES = ['open', 'accepted', 'dismissed'] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export type ScheduledItemRow = {
  id: string;
  name: string;
  amount: number;
  direction: Direction;
  category: Category;
  account_id: string | null;
  recurrence: Recurrence;
  anchor_date: string;
  end_date: string | null;
  notify_days_before: number;
  origin: Origin;
  active: 0 | 1;
  created_at: string;
  updated_at: string;
};

export type RecurrenceCandidateRow = {
  id: string;
  account_id: string;
  description_norm: string;
  amount: number;
  interval: Interval;
  occurrences_json: string;
  state: CandidateState;
  scheduled_item_id: string | null;
  created_at: string;
  updated_at: string;
};

// ---- scheduled_items ----

export type NewScheduledItem = {
  name: string;
  amount: number;
  direction: Direction;
  category: Category;
  accountId: string | null;
  recurrence: Recurrence;
  anchorDate: string;
  endDate: string | null;
  notifyDaysBefore: number;
  origin: Origin;
  now: string;
};

export function insertScheduledItem(db: Db, a: NewScheduledItem): ScheduledItemRow {
  const id = ulid(Date.parse(a.now));
  db.prepare(
    `INSERT INTO scheduled_items (id, name, amount, direction, category, account_id, recurrence, anchor_date, end_date, notify_days_before, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, a.name, a.amount, a.direction, a.category, a.accountId, a.recurrence, a.anchorDate, a.endDate, a.notifyDaysBefore, a.origin, a.now, a.now);
  return getScheduledItem(db, id)!;
}

export function getScheduledItem(db: Db, id: string): ScheduledItemRow | null {
  return (db.prepare('SELECT * FROM scheduled_items WHERE id = ?').get(id) as ScheduledItemRow | undefined) ?? null;
}

export function listScheduledItems(db: Db, opts: { includeInactive?: boolean } = {}): ScheduledItemRow[] {
  const where = opts.includeInactive ? '' : 'WHERE active = 1';
  return db.prepare(`SELECT * FROM scheduled_items ${where} ORDER BY created_at, id`).all() as ScheduledItemRow[];
}

export type ScheduledItemPatch = Partial<{
  name: string;
  amount: number;
  direction: Direction;
  category: Category;
  accountId: string | null;
  recurrence: Recurrence;
  anchorDate: string;
  endDate: string | null;
  notifyDaysBefore: number;
  origin: Origin;
  active: 0 | 1;
}>;

const ITEM_COLUMNS: Record<keyof ScheduledItemPatch, string> = {
  name: 'name',
  amount: 'amount',
  direction: 'direction',
  category: 'category',
  accountId: 'account_id',
  recurrence: 'recurrence',
  anchorDate: 'anchor_date',
  endDate: 'end_date',
  notifyDaysBefore: 'notify_days_before',
  origin: 'origin',
  active: 'active',
};

// 渡したキーだけ書く。項目が無ければ null。
export function updateScheduledItem(db: Db, id: string, patch: ScheduledItemPatch, now: string): ScheduledItemRow | null {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, col] of Object.entries(ITEM_COLUMNS) as [keyof ScheduledItemPatch, string][]) {
    const v = patch[k];
    if (v === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(v);
  }
  if (sets.length === 0) return getScheduledItem(db, id);
  const r = db.prepare(`UPDATE scheduled_items SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now, id);
  return r.changes === 0 ? null : getScheduledItem(db, id);
}

// ---- recurrence_candidates（T302 が使う） ----

export type NewRecurrenceCandidate = {
  accountId: string;
  descriptionNorm: string;
  amount: number;
  interval: Interval;
  occurrences: unknown[];
  now: string;
};

export function insertRecurrenceCandidate(db: Db, a: NewRecurrenceCandidate): RecurrenceCandidateRow {
  const id = ulid(Date.parse(a.now));
  db.prepare(
    `INSERT INTO recurrence_candidates (id, account_id, description_norm, amount, interval, occurrences_json, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(id, a.accountId, a.descriptionNorm, a.amount, a.interval, JSON.stringify(a.occurrences), a.now, a.now);
  return getRecurrenceCandidate(db, id)!;
}

export function getRecurrenceCandidate(db: Db, id: string): RecurrenceCandidateRow | null {
  return (db.prepare('SELECT * FROM recurrence_candidates WHERE id = ?').get(id) as RecurrenceCandidateRow | undefined) ?? null;
}

export function listRecurrenceCandidates(db: Db, opts: { state?: CandidateState; accountId?: string } = {}): RecurrenceCandidateRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.state !== undefined) {
    where.push('state = ?');
    args.push(opts.state);
  }
  if (opts.accountId !== undefined) {
    where.push('account_id = ?');
    args.push(opts.accountId);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM recurrence_candidates ${w} ORDER BY created_at, id`).all(...args) as RecurrenceCandidateRow[];
}

// 同じ口座・同じ正規化摘要・同じ周期の候補を古い順に（状態を問わない）。重複を作らない判定と、open の置き換えに使う。
export function listRecurrenceCandidatesFor(db: Db, accountId: string, descriptionNorm: string, interval: Interval): RecurrenceCandidateRow[] {
  return db
    .prepare('SELECT * FROM recurrence_candidates WHERE account_id = ? AND description_norm = ? AND interval = ? ORDER BY created_at, id')
    .all(accountId, descriptionNorm, interval) as RecurrenceCandidateRow[];
}

export type DetectTxnRow = { id: string; account_id: string; txn_date: string; amount: number; description_norm: string };

// 検出に使う支出の明細（from 〜 to、両端を含む）。口座が active かつ include_in_cashflow のものだけ。口座・摘要・日付の順。
export function listExpenseTxnsForDetect(db: Db, from: string, to: string): DetectTxnRow[] {
  return db
    .prepare(
      `SELECT t.id, t.account_id, t.txn_date, t.amount, t.description_norm FROM bank_txns t
       JOIN money_accounts a ON a.id = t.account_id AND a.active = 1 AND a.include_in_cashflow = 1
       WHERE t.side = 'expense' AND t.txn_date >= ? AND t.txn_date <= ? ORDER BY t.account_id, t.description_norm, t.txn_date, t.id`,
    )
    .all(from, to) as DetectTxnRow[];
}

// active な予定項目に、同じ口座で「同じ名前」か「同じ周期で金額の差が tolerancePct% 以内（大きい方が小さい方の 100 + tolerancePct % 以下）」のものがあるか。
export function hasActiveScheduledItemLike(
  db: Db,
  a: { accountId: string; name: string; recurrence: Recurrence; amount: number; tolerancePct: number },
): boolean {
  const k = 100 + a.tolerancePct;
  return !!db
    .prepare(
      `SELECT 1 FROM scheduled_items WHERE active = 1 AND account_id = ?
         AND (name = ? OR (recurrence = ? AND amount * 100 <= ? * ? AND ? * 100 <= amount * ?)) LIMIT 1`,
    )
    .get(a.accountId, a.name, a.recurrence, a.amount, k, a.amount, k);
}

// 状態を変える（accepted なら台帳の項目を結ぶ）。候補が無ければ null。
export function setRecurrenceCandidateState(db: Db, id: string, state: CandidateState, scheduledItemId: string | null, now: string): RecurrenceCandidateRow | null {
  const r = db.prepare('UPDATE recurrence_candidates SET state = ?, scheduled_item_id = ?, updated_at = ? WHERE id = ?').run(state, scheduledItemId, now, id);
  return r.changes === 0 ? null : getRecurrenceCandidate(db, id);
}
