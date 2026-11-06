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

// 状態を変える（accepted なら台帳の項目を結ぶ）。候補が無ければ null。
export function setRecurrenceCandidateState(db: Db, id: string, state: CandidateState, scheduledItemId: string | null, now: string): RecurrenceCandidateRow | null {
  const r = db.prepare('UPDATE recurrence_candidates SET state = ?, scheduled_item_id = ?, updated_at = ? WHERE id = ?').run(state, scheduledItemId, now, id);
  return r.changes === 0 ? null : getRecurrenceCandidate(db, id);
}

// ---- forecast（T303） ----

// 資金繰りに入れる口座（include_in_cashflow = 1 かつ active = 1）と、その最新の残高（as_of_date DESC, seq DESC。無ければ NULL）。
export type CashflowAccountRow = {
  id: string;
  name: string;
  kind: string;
  card_settlement_account_id: string | null;
  card_settlement_pattern: string | null;
  balance: number | null;
  as_of_date: string | null;
};

export function listCashflowAccounts(db: Db): CashflowAccountRow[] {
  return db.prepare(
    `SELECT a.id, a.name, a.kind, a.card_settlement_account_id, a.card_settlement_pattern, b.balance, b.as_of_date
       FROM money_accounts a
       LEFT JOIN account_balances b ON b.seq = (
         SELECT seq FROM account_balances WHERE account_id = a.id ORDER BY as_of_date DESC, seq DESC LIMIT 1)
      WHERE a.include_in_cashflow = 1 AND a.active = 1
      ORDER BY a.created_at, a.id`,
  ).all() as CashflowAccountRow[];
}

// 資金繰りに入れる口座の明細（from〜to、両端を含む）。
export type CashflowTxnRow = { id: string; account_id: string; txn_date: string; amount: number; side: 'income' | 'expense' };

export function listCashflowTxns(db: Db, from: string, to: string): CashflowTxnRow[] {
  return db.prepare(
    `SELECT t.id, t.account_id, t.txn_date, t.amount, t.side
       FROM bank_txns t JOIN money_accounts a ON a.id = t.account_id
      WHERE a.include_in_cashflow = 1 AND a.active = 1 AND t.txn_date >= ? AND t.txn_date <= ?
      ORDER BY t.txn_date, t.id`,
  ).all(from, to) as CashflowTxnRow[];
}

// 資金繰りに入れる口座の、いちばん古い明細の日付（無ければ null）。
export function firstCashflowTxnDate(db: Db): string | null {
  const r = db.prepare(
    `SELECT min(t.txn_date) d FROM bank_txns t JOIN money_accounts a ON a.id = t.account_id
      WHERE a.include_in_cashflow = 1 AND a.active = 1`,
  ).get() as { d: string | null };
  return r.d;
}

// 明細の口座と摘要（振替の組の相手の口座を調べる）。
export function txnAccounts(db: Db, ids: string[]): Map<string, { account_id: string; description: string }> {
  const rows = db.prepare(
    'SELECT id, account_id, description FROM bank_txns WHERE id IN (SELECT value FROM json_each(?))',
  ).all(JSON.stringify(ids)) as { id: string; account_id: string; description: string }[];
  return new Map(rows.map((r) => [r.id, { account_id: r.account_id, description: r.description }]));
}
