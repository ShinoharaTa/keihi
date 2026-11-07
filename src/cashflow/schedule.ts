// 予定の台帳（docs/mvp-plan-v3.md T301、requirements-v2.md D1）。値の検査・作成・更新・停止と、期日の計算。
// 項目は削除しない（active = 0 にする）。変更はすべて監査ログに残す（同じトランザクションで）。
// 期日は anchor_date から周期の分だけ月を足して出す。応当日が無い月は月末（31 日起点 → 4/30・2/28、2/29 起点の毎年 → 平年は 2/28）。
// 毎回 anchor_date から数えるので、月末に寄せた後も 31 日の月には 31 日に戻る。
// 見積もりの項目（origin = estimate。src/cashflow/tax/sync.ts が作る）を system 以外が name・amount・anchor_date を変えるか止めると pinned = 1 にする
// （再計算で上書きしない）。pinned は見積もりの項目にだけ付けられる。
import { appendAudit } from '../audit.ts';
import { addDays, addMonths } from '../calendar/businessDays.ts';
import { tx, type Db } from '../db/index.ts';
import {
  CATEGORIES,
  DIRECTIONS,
  ORIGINS,
  RECURRENCES,
  getScheduledItem,
  insertScheduledItem,
  listScheduledItems,
  updateScheduledItem,
  type Category,
  type Direction,
  type Origin,
  type Recurrence,
  type ScheduledItemPatch,
  type ScheduledItemRow,
} from './repo.ts';

export const DEFAULT_NOTIFY_DAYS_BEFORE = 14;
export const NOTIFY_DAYS_MAX = 365;
export const NAME_MAX = 200;

// 周期ごとの月数（once は 1 回だけ）。
const STEP_MONTHS: Record<Exclude<Recurrence, 'once'>, number> = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12, biennial: 24 };

export class ScheduleError extends Error {
  readonly code: string;
  readonly status: 400 | 404;
  constructor(code: string, status: 400 | 404 = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// payload は監査ログの payload に足すもの（再計算の run_id・reason など）。
export type By = { actor: string; user?: string | null; payload?: Record<string, unknown> };

// これ以外の actor が見積もりの項目を手直しすると pinned = 1 にする。
export const SYSTEM_ACTOR = 'system';
// 手直しとみなす列（docs/cashflow.md §14.2）。
const PIN_ON_CHANGE = new Set<string>(['name', 'amount', 'anchor_date']);

// ---- 値の検査 ----

export function isDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export type ItemInput = {
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
  estimateKey?: string | null; // 見積もりの項目だけ（API からは受けない）
};

// 更新で渡せるもの。pinned は見積もりの項目だけ。
export type ItemPatch = Partial<ItemInput> & { pinned?: boolean };

// API の body（snake_case）のキーと ItemInput のキー。
const BODY_KEYS = {
  name: 'name',
  amount: 'amount',
  direction: 'direction',
  category: 'category',
  account_id: 'accountId',
  recurrence: 'recurrence',
  anchor_date: 'anchorDate',
  end_date: 'endDate',
  notify_days_before: 'notifyDaysBefore',
  origin: 'origin',
} as const satisfies Record<string, keyof ItemInput>;

// 作成のときだけ受ける（origin は作った経路の記録なので更新では変えない）。
const CREATE_ONLY = new Set<string>(['origin']);

const isEnum = <T extends string>(xs: readonly T[], v: unknown): v is T => (xs as readonly unknown[]).includes(v);

// 検査して、保存する値を返す（name は前後の空白を落とす）。
function checkField(key: keyof ItemInput, v: unknown): unknown {
  if (key === 'name') {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t.length < 1 || t.length > NAME_MAX) throw new ScheduleError('invalid_name');
    return t;
  }
  const ok = (() => {
    switch (key) {
      case 'amount':
        return Number.isSafeInteger(v) && (v as number) > 0;
      case 'direction':
        return isEnum(DIRECTIONS, v);
      case 'category':
        return isEnum(CATEGORIES, v);
      case 'accountId':
        return v === null || (typeof v === 'string' && v !== '');
      case 'recurrence':
        return isEnum(RECURRENCES, v);
      case 'anchorDate':
        return isDate(v);
      case 'endDate':
        return v === null || isDate(v);
      case 'notifyDaysBefore':
        return Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= NOTIFY_DAYS_MAX;
      case 'origin':
        return isEnum(ORIGINS, v);
    }
  })();
  if (!ok) throw new ScheduleError(`invalid_${snake(key)}`);
  return v;
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// API の body を検査して ItemInput（作成）か部分（更新）にする。知らないキーも 400。更新では pinned（真偽値）も受ける。
export function parseBody(body: Record<string, unknown>, mode: 'create' | 'update'): ItemPatch {
  const out: Partial<Record<keyof ItemPatch, unknown>> = {};
  for (const [k, v] of Object.entries(body)) {
    if (mode === 'update' && k === 'pinned') {
      if (typeof v !== 'boolean') throw new ScheduleError('invalid_pinned');
      out.pinned = v;
      continue;
    }
    if (!Object.hasOwn(BODY_KEYS, k) || (mode === 'update' && CREATE_ONLY.has(k))) throw new ScheduleError('invalid_field');
    const key = BODY_KEYS[k as keyof typeof BODY_KEYS];
    out[key] = checkField(key, v);
  }
  if (mode === 'create') {
    out.accountId ??= null;
    out.endDate ??= null;
    out.notifyDaysBefore ??= DEFAULT_NOTIFY_DAYS_BEFORE;
    out.origin ??= 'manual';
    for (const k of ['name', 'amount', 'direction', 'category', 'recurrence', 'anchorDate'] as const) {
      if (out[k] === undefined) throw new ScheduleError(`missing_${snake(k)}`);
    }
  }
  return out as ItemPatch;
}

function checkConsistent(db: Db, v: { direction: Direction; category: Category; accountId: string | null; anchorDate: string; endDate: string | null }): void {
  if (v.direction === 'out' && v.category === 'income') throw new ScheduleError('invalid_category_for_direction');
  if (v.endDate !== null && v.endDate < v.anchorDate) throw new ScheduleError('end_before_anchor');
  if (v.accountId !== null && !db.prepare('SELECT 1 FROM money_accounts WHERE id = ?').get(v.accountId)) throw new ScheduleError('unknown_account');
}

// ---- 作成・更新・停止・再開 ----

export function createItem(db: Db, input: ItemInput, by: By, now: Date = new Date()): ScheduledItemRow {
  input = { ...input };
  for (const k of Object.values(BODY_KEYS)) (input as Record<string, unknown>)[k] = checkField(k, input[k]);
  const key = input.estimateKey ?? null;
  if (key !== null && (typeof key !== 'string' || key === '' || input.origin !== 'estimate')) throw new ScheduleError('invalid_estimate_key');
  checkConsistent(db, input);
  return tx(db, () => {
    const row = insertScheduledItem(db, { ...input, now: now.toISOString() });
    const extra = row.estimate_key !== null ? { estimate_key: row.estimate_key } : {};
    appendAudit(db, { actor: by.actor, action: 'scheduled_item.created', entity: 'scheduled_item', entityId: row.id, payload: { ...rowPayload(row), ...extra, user: by.user ?? null, ...by.payload } }, now);
    return row;
  });
}

// 渡したキーだけ変える。変わった列の前後を監査ログに残す（何も変わらなければ書かない）。
// 見積もりの項目を system 以外が name・amount・anchor_date で変えたら pinned = 1 も一緒に書く（pinned を明示したらそちらを優先）。
export function updateItem(db: Db, id: string, patch: ItemPatch, by: By, now: Date = new Date()): ScheduledItemRow {
  patch = { ...patch };
  const { pinned } = patch;
  delete patch.pinned;
  if (pinned !== undefined && typeof pinned !== 'boolean') throw new ScheduleError('invalid_pinned');
  for (const [k, v] of Object.entries(patch) as [keyof ItemInput, unknown][]) {
    if (v === undefined) continue;
    if (k === 'origin' || k === 'estimateKey') throw new ScheduleError('invalid_field');
    (patch as Record<string, unknown>)[k] = checkField(k, v);
  }
  return tx(db, () => {
    const cur = getScheduledItem(db, id);
    if (!cur) throw new ScheduleError('not_found', 404);
    if (pinned !== undefined && cur.origin !== 'estimate') throw new ScheduleError('invalid_pinned');
    const next = {
      direction: patch.direction ?? cur.direction,
      category: patch.category ?? cur.category,
      accountId: patch.accountId !== undefined ? patch.accountId : cur.account_id,
      anchorDate: patch.anchorDate ?? cur.anchor_date,
      endDate: patch.endDate !== undefined ? patch.endDate : cur.end_date,
    };
    checkConsistent(db, next);
    const before = rowPayload(cur);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const p: ScheduledItemPatch = {};
    for (const [k, v] of Object.entries(patch) as [keyof ItemInput, unknown][]) {
      if (v === undefined) continue;
      const col = snake(k) as keyof typeof before;
      if (before[col] === v) continue;
      changes[col] = { from: before[col], to: v };
      (p as Record<string, unknown>)[k] = v;
    }
    const pin = pinned !== undefined ? (pinned ? 1 : 0) : cur.origin === 'estimate' && by.actor !== SYSTEM_ACTOR && Object.keys(changes).some((c) => PIN_ON_CHANGE.has(c)) ? 1 : cur.pinned;
    if (pin !== cur.pinned) {
      changes.pinned = { from: cur.pinned, to: pin };
      p.pinned = pin;
    }
    if (Object.keys(changes).length === 0) return cur;
    const row = updateScheduledItem(db, id, p, now.toISOString())!;
    appendAudit(db, { actor: by.actor, action: 'scheduled_item.updated', entity: 'scheduled_item', entityId: id, payload: { changes, user: by.user ?? null, ...by.payload } }, now);
    return row;
  });
}

// active = 0 にする。既に止めてあればそのまま返す（監査ログは書かない）。
// 見積もりの項目を system 以外が止めたら pinned = 1 も書く（再計算で作り直さない）。
export function deactivateItem(db: Db, id: string, by: By, now: Date = new Date()): ScheduledItemRow {
  return tx(db, () => {
    const cur = getScheduledItem(db, id);
    if (!cur) throw new ScheduleError('not_found', 404);
    if (cur.active === 0) return cur;
    const pin = cur.origin === 'estimate' && by.actor !== SYSTEM_ACTOR && cur.pinned === 0;
    const row = updateScheduledItem(db, id, pin ? { active: 0, pinned: 1 } : { active: 0 }, now.toISOString())!;
    const extra = pin ? { pinned: { from: 0, to: 1 } } : {};
    appendAudit(db, { actor: by.actor, action: 'scheduled_item.deactivated', entity: 'scheduled_item', entityId: id, payload: { user: by.user ?? null, ...extra, ...by.payload } }, now);
    return row;
  });
}

// active = 1 に戻す（deactivateItem と対）。既に有効ならそのまま返す（監査ログは書かない）。
export function activateItem(db: Db, id: string, by: By, now: Date = new Date()): ScheduledItemRow {
  return tx(db, () => {
    const cur = getScheduledItem(db, id);
    if (!cur) throw new ScheduleError('not_found', 404);
    if (cur.active === 1) return cur;
    const row = updateScheduledItem(db, id, { active: 1 }, now.toISOString())!;
    appendAudit(db, { actor: by.actor, action: 'scheduled_item.reactivated', entity: 'scheduled_item', entityId: id, payload: { user: by.user ?? null } }, now);
    return row;
  });
}

export function getItem(db: Db, id: string): ScheduledItemRow | null {
  return getScheduledItem(db, id);
}

export function listItems(db: Db, opts: { includeInactive?: boolean } = {}): ScheduledItemRow[] {
  return listScheduledItems(db, opts);
}

function rowPayload(r: ScheduledItemRow) {
  return {
    name: r.name,
    amount: r.amount,
    direction: r.direction,
    category: r.category,
    account_id: r.account_id,
    recurrence: r.recurrence,
    anchor_date: r.anchor_date,
    end_date: r.end_date,
    notify_days_before: r.notify_days_before,
    origin: r.origin,
  };
}

// ---- 期日 ----

export type DueItem = Pick<ScheduledItemRow, 'recurrence' | 'anchor_date' | 'end_date' | 'active'>;

// k 回目（0 始まり）の期日。
function dueAt(item: DueItem, k: number): string {
  if (item.recurrence === 'once') return item.anchor_date;
  return addMonths(item.anchor_date, k * STEP_MONTHS[item.recurrence]);
}

// date 以上になる最初の k の目安（これより前の回は date より前）。
function firstIndexNear(item: DueItem, date: string): number {
  if (item.recurrence === 'once' || date <= item.anchor_date) return 0;
  const months = (Number(date.slice(0, 4)) - Number(item.anchor_date.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(item.anchor_date.slice(5, 7));
  return Math.max(0, Math.floor(months / STEP_MONTHS[item.recurrence]) - 1);
}

// from 〜 to（両端を含む）の期日をすべて、日付順で。active = 0 と end_date より後は出さない。
export function nextDueDates(item: DueItem, from: string, to: string): string[] {
  if (item.active === 0) return [];
  const last = item.end_date !== null && item.end_date < to ? item.end_date : to;
  const out: string[] = [];
  for (let k = firstIndexNear(item, from); ; k++) {
    const d = dueAt(item, k);
    if (d > last) break;
    if (d >= from) out.push(d);
    if (item.recurrence === 'once') break;
  }
  return out;
}

// today 以降（当日を含む）の最初の期日。無ければ null。
export function nextDue(item: DueItem, today: string): string | null {
  if (item.active === 0) return null;
  for (let k = firstIndexNear(item, today); ; k++) {
    const d = dueAt(item, k);
    if (item.end_date !== null && d > item.end_date) return null;
    if (d >= today) return d;
    if (item.recurrence === 'once') return null;
  }
}

export type Upcoming = ScheduledItemRow & { due_date: string };

// active な項目の期日を、期日順（同じ日は作成順）に並べる。
// 範囲は今日〜今日 + days 日で、両端を含む（days = 30 なら 31 日分。today は呼ぶ側が Asia/Tokyo の暦日で渡す）。
export function upcoming(db: Db, today: string, days: number): { from: string; to: string; items: Upcoming[] } {
  const to = addDays(today, days);
  const items: Upcoming[] = [];
  for (const it of listScheduledItems(db)) {
    for (const d of nextDueDates(it, today, to)) items.push({ ...it, due_date: d });
  }
  items.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
  return { from: today, to, items };
}
