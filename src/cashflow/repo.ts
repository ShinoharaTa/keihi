// 予定の台帳と周期の候補の表への読み書き（docs/mvp-plan-v3.md T301、0006_cashflow.sql）。SQL はここに閉じ込める。
// 値の検査・期日の計算・監査ログは src/cashflow/schedule.ts（呼ぶ側が同じトランザクションで残す）。
import type { Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';

export const DIRECTIONS = ['in', 'out'] as const;
export type Direction = (typeof DIRECTIONS)[number];
// savings（積立）は direction = out だけ（0009_recurrence_v2.sql）。
export const CATEGORIES = ['tax', 'insurance', 'car', 'savings', 'other', 'income'] as const;
export type Category = (typeof CATEGORIES)[number];
export const RECURRENCES = ['once', 'monthly', 'bimonthly', 'quarterly', 'yearly', 'biennial'] as const;
export type Recurrence = (typeof RECURRENCES)[number];
export const ORIGINS = ['manual', 'detected', 'estimate'] as const;
export type Origin = (typeof ORIGINS)[number];
export const INTERVALS = ['monthly', 'bimonthly', 'quarterly', 'yearly', 'biennial'] as const;
export type Interval = (typeof INTERVALS)[number];
export const CANDIDATE_STATES = ['open', 'accepted', 'dismissed'] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];
// 金額の種類。variable は金額が毎回変わる支払い（額は概算。0009_recurrence_v2.sql）。
export const AMOUNT_KINDS = ['fixed', 'variable'] as const;
export type AmountKind = (typeof AMOUNT_KINDS)[number];
// 却下した主体。system は検出が置き換えた（superseded）もの。
export type DismissedBy = 'human' | 'system';

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
  estimate_key: string | null; // origin = estimate のときだけ（0008_tax.sql）
  pinned: 0 | 1; // 人が手直しした見積もりの項目。再計算で上書きしない
  amount_kind: AmountKind; // 0009_recurrence_v2.sql
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
  amount_kind: AmountKind; // 不変
  dismissed_by: DismissedBy | null; // dismissed のときだけ
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
  estimateKey?: string | null;
  amountKind?: AmountKind;
  now: string;
};

// estimate_key は渡したときだけ、amount_kind は variable のときだけ書く
// （0008・0009 より前の版の DB でも見積もり以外・定額は作れるように。マイグレーションのテストが使う）。
export function insertScheduledItem(db: Db, a: NewScheduledItem): ScheduledItemRow {
  const id = ulid(Date.parse(a.now));
  const extra: [string, string][] = [];
  if (a.estimateKey != null) extra.push(['estimate_key', a.estimateKey]);
  if (a.amountKind === 'variable') extra.push(['amount_kind', a.amountKind]);
  db.prepare(
    `INSERT INTO scheduled_items (id, name, amount, direction, category, account_id, recurrence, anchor_date, end_date, notify_days_before, origin, active, created_at, updated_at${extra.map(([c]) => `, ${c}`).join('')})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?${extra.map(() => ', ?').join('')})`,
  ).run(id, a.name, a.amount, a.direction, a.category, a.accountId, a.recurrence, a.anchorDate, a.endDate, a.notifyDaysBefore, a.origin, a.now, a.now, ...extra.map(([, v]) => v));
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
  pinned: 0 | 1;
  amountKind: AmountKind;
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
  pinned: 'pinned',
  amountKind: 'amount_kind',
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
  amountKind?: AmountKind;
  occurrences: unknown[];
  now: string;
};

// amount_kind は variable のときだけ書く（0009 より前の版の DB でも定額は作れるように。マイグレーションのテストが使う）。
export function insertRecurrenceCandidate(db: Db, a: NewRecurrenceCandidate): RecurrenceCandidateRow {
  const id = ulid(Date.parse(a.now));
  const v = a.amountKind === 'variable';
  db.prepare(
    `INSERT INTO recurrence_candidates (id, account_id, description_norm, amount, interval, occurrences_json, state, created_at, updated_at${v ? ', amount_kind' : ''})
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?${v ? ", 'variable'" : ''})`,
  ).run(id, a.accountId, a.descriptionNorm, a.amount, a.interval, JSON.stringify(a.occurrences), a.now, a.now);
  return getRecurrenceCandidate(db, id)!;
}

export function getRecurrenceCandidate(db: Db, id: string): RecurrenceCandidateRow | null {
  return (db.prepare('SELECT * FROM recurrence_candidates WHERE id = ?').get(id) as RecurrenceCandidateRow | undefined) ?? null;
}

function candidateWhere(opts: { state?: CandidateState; accountId?: string }, alias: string): { w: string; args: string[] } {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.state !== undefined) {
    where.push(`${alias}state = ?`);
    args.push(opts.state);
  }
  if (opts.accountId !== undefined) {
    where.push(`${alias}account_id = ?`);
    args.push(opts.accountId);
  }
  return { w: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export function listRecurrenceCandidates(db: Db, opts: { state?: CandidateState; accountId?: string } = {}): RecurrenceCandidateRow[] {
  const { w, args } = candidateWhere(opts, '');
  return db.prepare(`SELECT * FROM recurrence_candidates ${w} ORDER BY created_at, id`).all(...args) as RecurrenceCandidateRow[];
}

// 画面に出す一覧。description は occurrences_json の最後（最新）の明細の正規化前の摘要、account_name は口座名（明細・口座が無ければ null）。
export type RecurrenceCandidateView = RecurrenceCandidateRow & { description: string | null; account_name: string | null };

export function listRecurrenceCandidateViews(db: Db, opts: { state?: CandidateState; accountId?: string } = {}): RecurrenceCandidateView[] {
  const { w, args } = candidateWhere(opts, 'c.');
  return db
    .prepare(
      `SELECT c.*, t.description AS description, a.name AS account_name
         FROM recurrence_candidates c
         LEFT JOIN bank_txns t ON t.id = json_extract(c.occurrences_json, '$[#-1].bank_txn_id')
         LEFT JOIN money_accounts a ON a.id = c.account_id
         ${w} ORDER BY c.created_at, c.id`,
    )
    .all(...args) as RecurrenceCandidateView[];
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
// excludeOrigin を渡すと、金額で合わせる方からその origin の項目を除く（同じ名前の方は除かない）。
export function hasActiveScheduledItemLike(
  db: Db,
  a: { accountId: string; name: string; recurrence: Recurrence; amount: number; tolerancePct: number; excludeOrigin?: Origin },
): boolean {
  const k = 100 + a.tolerancePct;
  const ex = a.excludeOrigin !== undefined ? ' AND origin <> ?' : '';
  return !!db
    .prepare(
      `SELECT 1 FROM scheduled_items WHERE active = 1 AND account_id = ?
         AND (name = ? OR (recurrence = ? AND amount * 100 <= ? * ? AND ? * 100 <= amount * ?${ex})) LIMIT 1`,
    )
    .get(a.accountId, a.name, a.recurrence, a.amount, k, a.amount, k, ...(a.excludeOrigin !== undefined ? [a.excludeOrigin] : []));
}

// 状態を変える（accepted なら台帳の項目を結ぶ）。dismissed にするときは dismissedBy に却下した主体を渡す。候補が無ければ null。
// dismissed_by は渡したときだけ書く（0009 より前の版の DB でも状態は変えられるように。マイグレーションのテストが使う）。
export function setRecurrenceCandidateState(
  db: Db,
  id: string,
  state: CandidateState,
  scheduledItemId: string | null,
  now: string,
  dismissedBy?: DismissedBy,
): RecurrenceCandidateRow | null {
  const by = dismissedBy !== undefined ? ', dismissed_by = ?' : '';
  const r = db
    .prepare(`UPDATE recurrence_candidates SET state = ?, scheduled_item_id = ?, updated_at = ?${by} WHERE id = ?`)
    .run(state, scheduledItemId, now, ...(dismissedBy !== undefined ? [dismissedBy] : []), id);
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

// ---- 大きな出費（0010_large_expenses.sql。src/cashflow/large.ts が使う） ----

export type LargeDecision = 'scheduled' | 'dismissed';

export type LargeExpenseDecisionRow = {
  id: string;
  bank_txn_id: string;
  decision: LargeDecision;
  scheduled_item_id: string | null; // scheduled のときだけ
  created_at: string;
};

export type LargeExpenseTxnRow = {
  id: string;
  account_id: string;
  account_name: string;
  txn_date: string;
  amount: number;
  description: string;
  description_norm: string;
};

// minAmount 以上の支出の明細（from 〜 to、両端を含む）。口座が active かつ include_in_cashflow のものだけ。新しい順。
export function listLargeExpenseTxns(db: Db, from: string, to: string, minAmount: number): LargeExpenseTxnRow[] {
  return db
    .prepare(
      `SELECT t.id, t.account_id, a.name AS account_name, t.txn_date, t.amount, t.description, t.description_norm FROM bank_txns t
       JOIN money_accounts a ON a.id = t.account_id AND a.active = 1 AND a.include_in_cashflow = 1
       WHERE t.side = 'expense' AND t.amount >= ? AND t.txn_date >= ? AND t.txn_date <= ? ORDER BY t.txn_date DESC, t.id DESC`,
    )
    .all(minAmount, from, to) as LargeExpenseTxnRow[];
}

// open・accepted の候補の occurrences に入っている明細の ID。
export function candidateTxnIds(db: Db): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(o.value, '$.bank_txn_id') AS id FROM recurrence_candidates c, json_each(c.occurrences_json) o
       WHERE c.state IN ('open', 'accepted')`,
    )
    .all() as { id: string | null }[];
  return new Set(rows.flatMap((r) => (r.id === null ? [] : [r.id])));
}

export function insertLargeExpenseDecision(
  db: Db,
  a: { bankTxnId: string; decision: LargeDecision; scheduledItemId: string | null; now: string },
): LargeExpenseDecisionRow {
  const id = ulid(Date.parse(a.now));
  db.prepare('INSERT INTO large_expense_decisions (id, bank_txn_id, decision, scheduled_item_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    a.bankTxnId,
    a.decision,
    a.scheduledItemId,
    a.now,
  );
  return getLargeExpenseDecision(db, a.bankTxnId)!;
}

export function getLargeExpenseDecision(db: Db, bankTxnId: string): LargeExpenseDecisionRow | null {
  return (db.prepare('SELECT * FROM large_expense_decisions WHERE bank_txn_id = ?').get(bankTxnId) as LargeExpenseDecisionRow | undefined) ?? null;
}

export function decidedLargeExpenseTxnIds(db: Db): Set<string> {
  return new Set((db.prepare('SELECT bank_txn_id FROM large_expense_decisions').all() as { bank_txn_id: string }[]).map((r) => r.bank_txn_id));
}
