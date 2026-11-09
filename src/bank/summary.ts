// 明細の一覧と月次の集計（docs/mvp-plan-v3.md T110、requirements-v2.md R-B の B1・B2）。GET /api/bank_txns・/api/summary/monthly から呼ぶ。
// - 一覧: txn_date DESC, id DESC の keyset（cursor）。1 回の上限は MAX_LIMIT 件。タグ・カテゴリの絞り込みは効くタグ（tags.ts の
//   resolveTagsBulk）で決まるので SQL では絞れない。SQL で絞った行を CHUNK 件ずつ読み、効くタグで落としながら limit + 1 件まで集める。
//   摘要の絞り込み（q）は normalizeVendor で揃えて description_norm への部分一致にする（揃えて空になる q は 400）。
//   category=none は未分類（category が null）。既定は active = 1 の口座の明細だけ。include_inactive=1 で active = 0 の口座も含める。
//   excluded（0 = 振替の除外を外す / 1 = 除外だけ）と receipt（match.ts の receipt）も同じく JS 側で絞る。vendor_key は
//   description_norm の完全一致（SQL）。各行に receipt・receipt_hint・mail_hint（match.ts の createReceiptResolver）を付ける。
// - 月次: その月の active = 1 の口座の明細から、振替・カードの引き落とし・チャージ（transfers.ts の excludedFromCashflow）を除いて集計する。
//   by_category・by_tag・total に入金・出金ごとの件数（income_count・expense_count）、by_tag_category にタグ × カテゴリの組（分析の画面。#74）。どれも同じ 1 回のループで数える。
//   除いた分は excluded に kind ごとの「その月に除いた明細」の行数と入金・出金で出す。月をまたぐ組でも、各月で
//   「除く前の合計 = total + excluded」が成り立つ。
// - 除く明細は有効な組（listActiveTransfers）の両側。transfers.ts の excludedFromCashflow と同じ集合を、kind 付きで 1 回で読む。
import type { Db } from '../db/index.ts';
import { normalizeVendor } from '../vendors/normalize.ts';
import {
  listAccounts,
  listBankTxnsBetween,
  listBankTxnsPage,
  TAGS,
  type BankTxnListRow,
  type BankTxnSqlFilter,
  type Tag,
  type TxnSide,
} from './repo.ts';
import { createReceiptResolver, DEFAULT_MATCH_WINDOWS, isReceiptStatus, type MailHintView, type MatchWindows, type ReceiptInfo, type ReceiptStatus } from './match.ts';
import { CATEGORIES, isCategory, isTag, resolveTagsBulk, type ResolvedTag, type TagDecisionSource } from './tags.ts';
import { listActiveTransfers } from './transfers.ts';
import type { TransferKind } from './transferRepo.ts';

export const MAX_LIMIT = 100;
export const MAX_MONTHS = 36;
export const VENDOR_KEY_MAX = 200;
// タグ・カテゴリで絞るときに 1 回で読む行数。
const CHUNK = 500;
const TRANSFER_KINDS: readonly TransferKind[] = ['transfer', 'card_settlement', 'charge'];
const CATEGORY_ORDER = new Map<string, number>(CATEGORIES.map((c, i) => [c, i]));

export class SummaryError extends Error {
  readonly status = 400 as const;
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

// ---- 一覧 ----

export type TxnQuery = BankTxnSqlFilter & {
  tag?: Tag;
  // null は未分類（category=none）。
  category?: string | null;
  // true = 振替の除外だけ、false = 除外を外す。
  excluded?: boolean;
  receipt?: ReceiptStatus;
  cursor?: { txnDate: string; id: string };
  limit: number;
};

export type TxnView = {
  id: string;
  account_id: string;
  account_name: string;
  txn_date: string;
  amount: number;
  side: TxnSide;
  description: string;
  balance: number | null;
  tag: Tag;
  category: string | null;
  tag_source: TagDecisionSource;
  // 振替・引き落とし・チャージとして月次の集計から除かれるか。
  excluded: boolean;
  transfer_kind: TransferKind | null;
  // 照合（match.ts）。receipt は経費の明細のときだけ。
  receipt: ReceiptStatus | null;
  receipt_hint: { document_id: string; status: string } | null;
  // 本文だけのメールの手がかり（receipt が candidate / waiting のときだけ。match.ts）。
  mail_hint: MailHintView | null;
};

export type TxnPage = { items: TxnView[]; next_cursor: string | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const UNCATEGORIZED_QUERY = 'none';

// YYYY-MM-DD で、実在する日付か。
function isDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function encodeCursor(r: { txn_date: string; id: string }): string {
  return Buffer.from(JSON.stringify([r.txn_date, r.id])).toString('base64url');
}

function decodeCursor(s: string): { txnDate: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && isDate(v[0]) && typeof v[1] === 'string' && v[1] !== '') {
      return { txnDate: v[0], id: v[1] };
    }
  } catch {
    // 下で投げる
  }
  throw new SummaryError('invalid_cursor');
}

function nonNegInt(s: string, reason: string): number {
  if (!/^\d+$/.test(s)) throw new SummaryError(reason);
  return Number(s);
}

// クエリ文字列を TxnQuery にする。不正なら SummaryError（400）。
export function parseTxnQuery(q: Record<string, string | undefined>): TxnQuery {
  const out: TxnQuery = { limit: MAX_LIMIT };
  if (q.from !== undefined) {
    if (!isDate(q.from)) throw new SummaryError('invalid_from');
    out.from = q.from;
  }
  if (q.to !== undefined) {
    if (!isDate(q.to)) throw new SummaryError('invalid_to');
    out.to = q.to;
  }
  if (q.account_id !== undefined) out.accountId = q.account_id;
  if (q.include_inactive !== undefined) {
    if (q.include_inactive !== '0' && q.include_inactive !== '1') throw new SummaryError('invalid_include_inactive');
    if (q.include_inactive === '1') out.includeInactive = true;
  }
  if (q.tag !== undefined) {
    if (!isTag(q.tag)) throw new SummaryError('invalid_tag');
    out.tag = q.tag;
  }
  if (q.category !== undefined) {
    if (q.category === UNCATEGORIZED_QUERY) out.category = null;
    else if (isCategory(q.category)) out.category = q.category;
    else throw new SummaryError('invalid_category');
  }
  if (q.side !== undefined) {
    if (q.side !== 'income' && q.side !== 'expense') throw new SummaryError('invalid_side');
    out.side = q.side;
  }
  if (q.amount_min !== undefined) out.amountMin = nonNegInt(q.amount_min, 'invalid_amount_min');
  if (q.amount_max !== undefined) out.amountMax = nonNegInt(q.amount_max, 'invalid_amount_max');
  if (out.from !== undefined && out.to !== undefined && out.from > out.to) throw new SummaryError('invalid_range');
  if (out.amountMin !== undefined && out.amountMax !== undefined && out.amountMin > out.amountMax) throw new SummaryError('invalid_range');
  if (q.excluded !== undefined) {
    if (q.excluded !== '0' && q.excluded !== '1') throw new SummaryError('invalid_excluded');
    out.excluded = q.excluded === '1';
  }
  if (q.vendor_key !== undefined) {
    if (q.vendor_key.length < 1 || q.vendor_key.length > VENDOR_KEY_MAX) throw new SummaryError('invalid_vendor_key');
    out.descriptionNormExact = q.vendor_key;
  }
  if (q.receipt !== undefined) {
    if (!isReceiptStatus(q.receipt)) throw new SummaryError('invalid_receipt');
    out.receipt = q.receipt;
  }
  if (q.q !== undefined) {
    const n = normalizeVendor(q.q);
    if (n === '') throw new SummaryError('invalid_q');
    out.descriptionNorm = n;
  }
  if (q.cursor !== undefined) out.cursor = decodeCursor(q.cursor);
  if (q.limit !== undefined) {
    const n = nonNegInt(q.limit, 'invalid_limit');
    if (n < 1 || n > MAX_LIMIT) throw new SummaryError('invalid_limit');
    out.limit = n;
  }
  return out;
}

// 有効な組に入っている明細の ID → 組の kind（キーの集合が excludedFromCashflow と同じ）。
function transferKinds(db: Db): Map<string, TransferKind> {
  const m = new Map<string, TransferKind>();
  for (const l of listActiveTransfers(db)) {
    m.set(l.out_txn_id, l.kind);
    if (l.in_txn_id) m.set(l.in_txn_id, l.kind);
  }
  return m;
}

function view(r: BankTxnListRow, t: ResolvedTag, kinds: Map<string, TransferKind>, m: ReceiptInfo): TxnView {
  return {
    id: r.id,
    account_id: r.account_id,
    account_name: r.account_name,
    txn_date: r.txn_date,
    amount: r.amount,
    side: r.side,
    description: r.description,
    balance: r.balance,
    tag: t.tag,
    category: t.category,
    tag_source: t.source,
    excluded: kinds.has(r.id),
    transfer_kind: kinds.get(r.id) ?? null,
    receipt: m.receipt,
    receipt_hint: m.receipt_hint,
    mail_hint: m.mail_hint,
  };
}

export function listTxns(db: Db, q: TxnQuery, opts: { matchWindows?: MatchWindows } = {}): TxnPage {
  const limit = Math.min(Math.max(q.limit, 1), MAX_LIMIT);
  const byJs = q.tag !== undefined || q.category !== undefined || q.excluded !== undefined || q.receipt !== undefined;
  const chunk = byJs ? CHUNK : limit + 1;
  const kinds = transferKinds(db);
  const receipts = createReceiptResolver(db, opts.matchWindows ?? DEFAULT_MATCH_WINDOWS);
  const out: TxnView[] = [];
  let after = q.cursor ?? null;
  for (;;) {
    const rows = listBankTxnsPage(db, q, after, chunk);
    const tags = resolveTagsBulk(db, rows.map((r) => r.id));
    const ms = receipts(rows.map((r) => r.id));
    for (const r of rows) {
      const t = tags.get(r.id)!;
      if (q.tag !== undefined && t.tag !== q.tag) continue;
      if (q.category !== undefined && t.category !== q.category) continue;
      if (q.excluded !== undefined && kinds.has(r.id) !== q.excluded) continue;
      const m = ms.get(r.id)!;
      if (q.receipt !== undefined && m.receipt !== q.receipt) continue;
      out.push(view(r, t, kinds, m));
      if (out.length > limit) break;
    }
    if (out.length > limit || rows.length < chunk) break;
    const last = rows[rows.length - 1]!;
    after = { txnDate: last.txn_date, id: last.id };
  }
  const items = out.slice(0, limit);
  return { items, next_cursor: out.length > limit ? encodeCursor(items[items.length - 1]!) : null };
}

// ---- 月次の集計 ----

export type Amounts = { income: number; expense: number };
// 入金・出金それぞれの件数。
type Counted = Amounts & { income_count: number; expense_count: number };
export type MonthlySummary = {
  month: string;
  by_account: ({ account_id: string; name: string; include_in_cashflow: boolean; active: boolean; net: number } & Amounts)[];
  by_category: ({ category: string | null } & Counted)[];
  by_tag: ({ tag: Tag } & Counted)[];
  // タグ × カテゴリ（分析の画面のクロス表。#74）。件数のある組だけ。tag 順 → カテゴリの固定順 → 未分類（null）最後。
  by_tag_category: ({ tag: Tag; category: string | null } & Counted)[];
  total: Counted & { net: number };
  // その月に除いた明細の行数と入金・出金。
  excluded: ({ kind: TransferKind; count: number } & Amounts)[];
};

export function isMonth(s: unknown): s is string {
  return typeof s === 'string' && MONTH.test(s);
}

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// from〜to の月（両端を含む）。不正・逆順・MAX_MONTHS 超えは SummaryError。
export function monthsBetween(from: string, to: string): string[] {
  if (!isMonth(from)) throw new SummaryError('invalid_from');
  if (!isMonth(to)) throw new SummaryError('invalid_to');
  if (from > to) throw new SummaryError('invalid_range');
  const out: string[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) {
    out.push(m);
    if (out.length > MAX_MONTHS) throw new SummaryError('too_many_months');
  }
  return out;
}

const add = (a: Amounts, side: TxnSide, amount: number) => {
  if (side === 'income') a.income += amount;
  else a.expense += amount;
};
const addCounted = (a: Counted, side: TxnSide, amount: number) => {
  add(a, side, amount);
  if (side === 'income') a.income_count++;
  else a.expense_count++;
};
const zero = (): Counted => ({ income: 0, expense: 0, income_count: 0, expense_count: 0 });

type AccountInfo = { order: number; includeInCashflow: boolean; active: boolean };

function summarize(db: Db, month: string, kinds: Map<string, TransferKind>, accountInfo: Map<string, AccountInfo>): MonthlySummary {
  const { from, to } = monthRange(month);
  const all = listBankTxnsBetween(db, from, to);
  const rows = all.filter((r) => !kinds.has(r.id));
  const tags = resolveTagsBulk(db, rows.map((r) => r.id));
  const total = zero();
  const accounts = new Map<string, { name: string } & Amounts>();
  const categories = new Map<string | null, Counted>();
  const byTag = new Map<Tag, Counted>(TAGS.map((t) => [t, zero()]));
  const byTagCat = new Map<Tag, Map<string | null, Counted>>(TAGS.map((t) => [t, new Map()]));
  for (const r of rows) {
    const t = tags.get(r.id)!;
    addCounted(total, r.side, r.amount);
    let a = accounts.get(r.account_id);
    if (!a) accounts.set(r.account_id, (a = { name: r.account_name, income: 0, expense: 0 }));
    add(a, r.side, r.amount);
    let c = categories.get(t.category);
    if (!c) categories.set(t.category, (c = zero()));
    addCounted(c, r.side, r.amount);
    addCounted(byTag.get(t.tag)!, r.side, r.amount);
    const tc = byTagCat.get(t.tag)!;
    let x = tc.get(t.category);
    if (!x) tc.set(t.category, (x = zero()));
    addCounted(x, r.side, r.amount);
  }
  const excluded = new Map<TransferKind, { count: number } & Amounts>(TRANSFER_KINDS.map((k) => [k, { count: 0, income: 0, expense: 0 }]));
  for (const r of all) {
    const k = kinds.get(r.id);
    if (k === undefined) continue;
    const e = excluded.get(k)!;
    e.count++;
    add(e, r.side, r.amount);
  }
  // カテゴリは固定の順（tags.ts の CATEGORIES）、未分類（null）は最後。
  const catRank = (c: string | null) => (c === null ? CATEGORIES.length + 1 : (CATEGORY_ORDER.get(c) ?? CATEGORIES.length));
  return {
    month,
    by_account: [...accounts]
      .sort(([a], [b]) => (accountInfo.get(a)?.order ?? 0) - (accountInfo.get(b)?.order ?? 0))
      .map(([id, a]) => ({
        account_id: id,
        name: a.name,
        include_in_cashflow: accountInfo.get(id)?.includeInCashflow ?? false,
        active: accountInfo.get(id)?.active ?? false,
        income: a.income,
        expense: a.expense,
        net: a.income - a.expense,
      })),
    by_category: [...categories].sort(([a], [b]) => catRank(a) - catRank(b)).map(([category, a]) => ({ category, ...a })),
    by_tag: [...byTag].map(([tag, a]) => ({ tag, ...a })),
    by_tag_category: [...byTagCat].flatMap(([tag, m]) => [...m].sort(([a], [b]) => catRank(a) - catRank(b)).map(([category, a]) => ({ tag, category, ...a }))),
    total: { ...total, net: total.income - total.expense },
    excluded: [...excluded].map(([kind, e]) => ({ kind, ...e })),
  };
}

// 月ごとの集計。months は YYYY-MM の並び（呼ぶ側で検証済み）。
export function monthlySummaries(db: Db, months: readonly string[]): MonthlySummary[] {
  const kinds = transferKinds(db);
  const accountInfo = new Map(listAccounts(db).map((a, i) => [a.id, { order: i, includeInCashflow: a.include_in_cashflow === 1, active: a.active === 1 }]));
  return months.map((m) => summarize(db, m, kinds, accountInfo));
}

export function monthlySummary(db: Db, month: string): MonthlySummary {
  if (!isMonth(month)) throw new SummaryError('invalid_month');
  return monthlySummaries(db, [month])[0]!;
}
