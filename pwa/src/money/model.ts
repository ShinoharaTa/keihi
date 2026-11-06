// 「お金」タブの型と純関数（docs/mvp-plan-v3.md T111・T304）。API の形は src/web/routes/{bank,tags,cashflow}.ts・src/bank/summary.ts・
// src/cashflow/forecast.ts に合わせる。描画（*.tsx）から使い、テスト（test/unit/money-pwa.test.ts）からも直接読む。
export type Tag = 'business' | 'private' | 'unset';
export type TransferKind = 'transfer' | 'card_settlement' | 'charge';
export type Amounts = { income: number; expense: number };
export type CategoryItem = { id: string; label: string };
export type Categories = { items: CategoryItem[]; uncategorized_label: string };

export type Txn = {
  id: string;
  account_id: string;
  account_name: string;
  txn_date: string;
  amount: number;
  side: 'income' | 'expense';
  description: string;
  balance: number | null;
  tag: Tag;
  category: string | null;
  tag_source: string;
  excluded: boolean;
  transfer_kind: TransferKind | null;
};
export type TxnPage = { items: Txn[]; next_cursor: string | null };

export type MonthlySummary = {
  month: string;
  by_account: ({ account_id: string; name: string; include_in_cashflow: boolean; active: boolean; net: number } & Amounts)[];
  by_category: ({ category: string | null } & Amounts)[];
  by_tag: ({ tag: Tag } & Amounts)[];
  total: Amounts & { net: number };
  excluded: ({ kind: TransferKind; count: number } & Amounts)[];
};

export type AccountKind = 'bank' | 'card' | 'wallet' | 'paypay' | 'cash';
export type McpVisibility = 'full' | 'summary' | 'none';
export type Account = {
  id: string;
  name: string;
  kind: AccountKind;
  source: 'freee' | 'csv';
  default_tag: Tag;
  mcp_visibility: McpVisibility;
  include_in_cashflow: boolean;
  card_settlement_account_id: string | null;
  card_settlement_pattern: string | null;
  active: boolean;
  sync_status: { last_sync_at: string | null; last_ok_at: string | null; last_error: string | null; last_csv_at: string | null; backfill_done_until: string | null } | null;
  latest_balance: { as_of_date: string; balance: number; source: string } | null;
};
export type BankStatus = {
  account_id: string;
  name: string;
  kind: AccountKind;
  source: string;
  active: boolean;
  last_sync_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_csv_at: string | null;
  backfill_done_until: string | null;
};

export type Direction = 'in' | 'out';
export type ScheduleCategory = 'tax' | 'insurance' | 'car' | 'other' | 'income';
export type Recurrence = 'once' | 'monthly' | 'bimonthly' | 'yearly' | 'biennial';
export type ScheduledItem = {
  id: string;
  name: string;
  amount: number;
  direction: Direction;
  category: ScheduleCategory;
  account_id: string | null;
  recurrence: Recurrence;
  anchor_date: string;
  end_date: string | null;
  notify_days_before: number;
  origin: string;
  active: 0 | 1;
};
export type Candidate = {
  id: string;
  account_id: string;
  description_norm: string;
  amount: number;
  interval: Exclude<Recurrence, 'once'>;
  occurrences_json: string;
  state: string;
};

export type ForecastItem = { id: string; name: string; amount: number; direction: Direction; due: string };
export type ForecastMonth = {
  month: string;
  planned_in: number;
  planned_out: number;
  unplanned_in: number;
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
  warnings: ForecastWarning[];
};

// ---- 表示の文言 ----

export const TAG_LABELS: Record<Tag, string> = { business: '事業', private: '私用', unset: '未設定' };
export const TAG_ORDER: readonly Tag[] = ['business', 'private', 'unset'];
export const KIND_LABELS: Record<TransferKind, string> = { transfer: '振替', card_settlement: '引落', charge: 'チャージ' };
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = { bank: '銀行', card: 'カード', wallet: '電子マネー', paypay: 'PayPay', cash: '現金' };
export const VISIBILITY_LABELS: Record<McpVisibility, string> = { full: '明細まで', summary: '集計だけ', none: '出さない' };
export const VISIBILITY_ORDER: readonly McpVisibility[] = ['full', 'summary', 'none'];
export const SCHEDULE_CATEGORY_LABELS: Record<ScheduleCategory, string> = { tax: '税金', insurance: '保険', car: '車', other: 'その他', income: '収入' };
export const SCHEDULE_CATEGORIES: readonly ScheduleCategory[] = ['tax', 'insurance', 'car', 'other', 'income'];
export const RECURRENCE_LABELS: Record<Recurrence, string> = { once: '1 回', monthly: '毎月', bimonthly: '隔月', yearly: '毎年', biennial: '隔年' };
export const RECURRENCES: readonly Recurrence[] = ['once', 'monthly', 'bimonthly', 'yearly', 'biennial'];
export const DEFAULT_NOTIFY_DAYS = 14;

// 3 桁区切りの円。負は「−」。
export function yen(n: number): string {
  const s = String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `−${s}` : s;
}
// 明細の金額。支出は「−」、収入は「+」。
export const signedYen = (side: Txn['side'], amount: number) => (side === 'expense' ? `−${yen(amount)}` : `+${yen(amount)}`);

export function categoryLabel(cats: Categories | null, id: string | null): string {
  if (id === null) return cats?.uncategorized_label ?? '未分類';
  return cats?.items.find((c) => c.id === id)?.label ?? id;
}

export function failText(status: number, body?: unknown): string {
  if (status === 0) return '通信できません。電波の良い所でもう一度試してください。';
  const err = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null;
  return err ? `受け付けられませんでした（${err}）` : `サーバーから読めませんでした（HTTP ${status}）`;
}

// ---- 明細の絞り込み ----

export type Period = 'this' | 'last' | 'three' | 'all';
export const PERIOD_LABELS: Record<Period, string> = { this: '今月', last: '先月', three: '3 か月', all: '全部' };
export const PERIODS: readonly Period[] = ['this', 'last', 'three', 'all'];

const pad = (n: number) => String(n).padStart(2, '0');
// YYYY-MM に n か月足す（負も可）。
export function addMonth(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  return `${yy}-${pad(((m % 12) + 12) % 12 + 1)}`;
}
function lastDay(month: string): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return `${month}-${pad(d.getUTCDate())}`;
}

// 期間 → {from, to}（YYYY-MM-DD）。3 か月は今月を含む直近 3 か月。全部は絞らない。
export function periodRange(p: Period, today: string): { from?: string; to?: string } {
  const m = today.slice(0, 7);
  if (p === 'this') return { from: `${m}-01`, to: today };
  if (p === 'last') {
    const l = addMonth(m, -1);
    return { from: `${l}-01`, to: lastDay(l) };
  }
  if (p === 'three') return { from: `${addMonth(m, -2)}-01`, to: today };
  return {};
}

export type TxnFilter = { period: Period; accountId: string; tag: '' | Tag; category: string; q: string };
export const emptyFilter = (): TxnFilter => ({ period: 'this', accountId: '', tag: '', category: '', q: '' });
export const UNCATEGORIZED_QUERY = 'none';
export const TXN_PAGE = 50;

// GET /api/bank_txns の URL。category は '' = 全部、'none' = 未分類。q は前後の空白を落とし、空なら送らない。
export function txnsUrl(f: TxnFilter, today: string, cursor: string | null): string {
  const p = new URLSearchParams({ limit: String(TXN_PAGE) });
  const r = periodRange(f.period, today);
  if (r.from) p.set('from', r.from);
  if (r.to) p.set('to', r.to);
  if (f.accountId) p.set('account_id', f.accountId);
  if (f.tag) p.set('tag', f.tag);
  if (f.category) p.set('category', f.category);
  const q = f.q.trim();
  if (q) p.set('q', q);
  if (cursor) p.set('cursor', cursor);
  return `/api/bank_txns?${p.toString()}`;
}

// タグを付けた結果（POST /api/bank_txns/:id/tag の effective）で行を差し替える。
export type TagResult = { effective: { tag: Tag; category: string | null; source: string } };
export function applyTag(items: Txn[], id: string, r: TagResult): Txn[] {
  return items.map((t) => (t.id === id ? { ...t, tag: r.effective.tag, category: r.effective.category, tag_source: r.effective.source } : t));
}

// ---- 月次 ----

export const MONTHLY_MONTHS = 6;
export function monthlyUrl(today: string): string {
  const to = today.slice(0, 7);
  return `/api/summary/monthly?from=${addMonth(to, -(MONTHLY_MONTHS - 1))}&to=${to}`;
}

// 口座別を資金繰りの対象と対象外に分ける（対象外は区切りの下に出す）。
export function splitByCashflow(rows: MonthlySummary['by_account']) {
  return { inside: rows.filter((r) => r.include_in_cashflow), outside: rows.filter((r) => !r.include_in_cashflow) };
}

// ---- 予定 ----

// 候補の最後の出現（occurrences_json の date の最大）。読めなければ null。
export function lastOccurrence(c: Candidate): string | null {
  try {
    const v = JSON.parse(c.occurrences_json) as unknown;
    if (!Array.isArray(v)) return null;
    let last: string | null = null;
    for (const o of v) {
      const d = (o as { date?: unknown } | null)?.date;
      if (typeof d === 'string' && (last === null || d > last)) last = d;
    }
    return last;
  } catch {
    return null;
  }
}

// 次の期日: GET /api/scheduled_items/upcoming の項目（期日順）から、項目ごとに最初の due_date。
export const UPCOMING_DAYS = 1096;
export function nextDueMap(items: { id: string; due_date: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) if (!(it.id in out)) out[it.id] = it.due_date;
  return out;
}

// 支出の予定には「収入」の分類を選べない（サーバーも invalid_category_for_direction で断る）。
export const categoriesFor = (d: Direction): readonly ScheduleCategory[] => (d === 'out' ? SCHEDULE_CATEGORIES.filter((c) => c !== 'income') : SCHEDULE_CATEGORIES);

export type ItemDraft = {
  name: string;
  amount: string;
  direction: Direction;
  category: ScheduleCategory;
  recurrence: Recurrence;
  anchor_date: string;
  end_date: string;
  notify_days_before: string;
};
export const emptyDraft = (today: string): ItemDraft => ({
  name: '',
  amount: '',
  direction: 'out',
  category: 'other',
  recurrence: 'monthly',
  anchor_date: today,
  end_date: '',
  notify_days_before: String(DEFAULT_NOTIFY_DAYS),
});
export const draftOf = (it: ScheduledItem): ItemDraft => ({
  name: it.name,
  amount: String(it.amount),
  direction: it.direction,
  category: it.category,
  recurrence: it.recurrence,
  anchor_date: it.anchor_date,
  end_date: it.end_date ?? '',
  notify_days_before: String(it.notify_days_before),
});

// 全角数字・カンマ・円記号を許す正の整数。だめなら null。
export function parseYen(s: string): number | null {
  const t = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，¥￥円\s]/g, '');
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

// POST / PATCH /api/scheduled_items の本文。だめなら null（保存ボタンを押せない）。
export function draftBody(d: ItemDraft): Record<string, unknown> | null {
  const amount = parseYen(d.amount);
  const notify = /^\d+$/.test(d.notify_days_before.trim()) ? Number(d.notify_days_before.trim()) : null;
  if (!d.name.trim() || amount === null || notify === null || !d.anchor_date) return null;
  if (d.direction === 'out' && d.category === 'income') return null;
  return {
    name: d.name.trim(),
    amount,
    direction: d.direction,
    category: d.category,
    recurrence: d.recurrence,
    anchor_date: d.anchor_date,
    end_date: d.end_date || null,
    notify_days_before: notify,
  };
}

// ---- 資金繰り ----

export function warningText(w: ForecastWarning, accountName: (id: string) => string): string {
  if (w.kind === 'no_balance') return `${accountName(w.account_id)} の残高がありません（0 円として計算しています）。`;
  if (w.kind === 'stale_balance') return `${accountName(w.account_id)} の残高が ${w.as_of_date} から更新されていません。`;
  return w.months_available === 0
    ? '過去の明細がまだ無いため、予定外支出の目安を 0 円にしています。'
    : `過去の明細が ${w.months_available} か月分しかないため、予定外支出の目安は粗い値です。`;
}

// ---- 口座 ----

// 口座と同期の状態を id で結ぶ。
export function withStatus(accounts: Account[], status: BankStatus[]): (Account & { status: BankStatus | null })[] {
  const by = new Map(status.map((s) => [s.account_id, s]));
  return accounts.map((a) => ({ ...a, status: by.get(a.id) ?? null }));
}

export type AccountDraft = {
  default_tag: Tag;
  include_in_cashflow: boolean;
  mcp_visibility: McpVisibility;
  active: boolean;
  card_settlement_account_id: string;
  card_settlement_pattern: string;
};
export const accountDraft = (a: Account): AccountDraft => ({
  default_tag: a.default_tag,
  include_in_cashflow: a.include_in_cashflow,
  mcp_visibility: a.mcp_visibility,
  active: a.active,
  card_settlement_account_id: a.card_settlement_account_id ?? '',
  card_settlement_pattern: a.card_settlement_pattern ?? '',
});

// PATCH /api/accounts/:id の本文。変わった項目だけ。カード以外は引落の設定を送らない。
export function accountPatch(a: Account, d: AccountDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d.default_tag !== a.default_tag) out.default_tag = d.default_tag;
  if (d.include_in_cashflow !== a.include_in_cashflow) out.include_in_cashflow = d.include_in_cashflow;
  if (d.mcp_visibility !== a.mcp_visibility) out.mcp_visibility = d.mcp_visibility;
  if (d.active !== a.active) out.active = d.active;
  if (a.kind === 'card') {
    const sid = d.card_settlement_account_id || null;
    if (sid !== a.card_settlement_account_id) out.card_settlement_account_id = sid;
    const pat = d.card_settlement_pattern.trim() || null;
    if (pat !== a.card_settlement_pattern) out.card_settlement_pattern = pat;
  }
  return out;
}

export const syncText = (created: boolean) => (created ? '同期を始めました。しばらくしてから読み直してください。' : '10 分以内に実行済みです。');

// ISO の日時 → 「YYYY-MM-DD HH:MM」（端末のローカル時刻）。null は「—」。
export function dateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
