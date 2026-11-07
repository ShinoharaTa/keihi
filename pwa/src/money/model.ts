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
// quarterly は API 側で追加中（古いサーバーは invalid_recurrence で断る）。
export type Recurrence = 'once' | 'monthly' | 'bimonthly' | 'quarterly' | 'yearly' | 'biennial';
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
  // 税・保険の見積もり（origin = estimate）の key と、人が手直ししたか（古いサーバーには無い）。
  estimate_key?: string | null;
  pinned?: 0 | 1;
};
export type Candidate = {
  id: string;
  account_id: string;
  description_norm: string;
  // 追加中の項目（古いサーバーには無い）: 正規化前の摘要と口座名。
  description?: string;
  account_name?: string;
  amount: number;
  interval: Exclude<Recurrence, 'once'>;
  occurrences_json: string;
  state: string;
};

// 提案の表示名。正規化前の摘要（description）があればそれ、無ければ description_norm。
export const candidateName = (c: Candidate) => c.description || c.description_norm;

// origin・estimate_key・pinned は追加中の項目（古いサーバーには無い）。
export type ForecastItem = { id: string; name: string; amount: number; direction: Direction; due: string; origin?: string; estimate_key?: string | null; pinned?: 0 | 1 };
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
  | { kind: 'short_history'; months_available: number }
  | { kind: 'tax_profile_missing' }
  | { kind: 'consumption_tax_mode_unset' };
export type Forecast = {
  as_of: string;
  opening_balance: number;
  reserve: number;
  unplanned_out_per_month: number;
  unplanned_in_per_month: number;
  months: ForecastMonth[];
  first_shortfall_month: string | null;
  warnings: ForecastWarning[];
  // 追加中の項目（古いサーバーには無い）。
  min_month?: { month: string; balance_end: number; margin: number } | null;
  cut_per_month_to_survive?: number | null;
};

// GET /api/bank/overview（src/bank/overview.ts。404 の古いサーバーでは overviewFallback で代わりを作る）。
export type ThisMonth = { month: string; income: number; expense: number; planned_out_remaining: number; unplanned_out_estimate: number; projected_end_balance: number };
export type Overview = {
  today: string;
  // 残高の無い口座（カードなど）は balance null で入り、total には入らない。
  balances: { total: number; by_account: { account_id: string; name: string; kind: string; balance: number | null; as_of_date: string | null }[] };
  reserve: number;
  available: number;
  untagged_count: number;
  // クライアントだけの印: 代わりの計算で未設定が 100 件を超えた（「100+」と出す）。
  untagged_more?: boolean;
  cards_without_settlement: { account_id: string; name: string }[];
  open_candidates: number;
  upcoming_due?: unknown;
  this_month: ThisMonth;
  sync: { last_ok_at: string | null; errors: unknown };
};
// GET /api/balance_history?months=12（追加中。古い順、最後が今月）。
// 今のサーバーは残高の無い口座を 0 で返す（null で返すようになっても読めるようにしておく）。
export type BalanceHistory = { months: { month: string; total: number | null; by_account: Record<string, number | null> }[] };
// 残高の推移の系列。全口座の残高が無い月（total が null、または 0 で口座ごとも全部 null か 0）は null。
// 最初に残高がある月より前は落とす（0 に落ちた線を描かない）。どの月にも無ければ空。
export function balanceSeries(months: BalanceHistory['months']): { month: string; total: number | null }[] {
  const out = months.map((m) => {
    const none = m.total === null || (m.total === 0 && Object.values(m.by_account).every((v) => v === null || v === 0));
    return { month: m.month, total: none ? null : m.total };
  });
  const first = out.findIndex((m) => m.total !== null);
  return first < 0 ? [] : out.slice(first);
}
// GET /api/scheduled_items/upcoming の項目（台帳の項目 + 期日）。
export type Upcoming = ScheduledItem & { due_date: string };

// ---- 表示の文言 ----

export const TAG_LABELS: Record<Tag, string> = { business: '事業', private: '私用', unset: '未設定' };
export const TAG_ORDER: readonly Tag[] = ['business', 'private', 'unset'];
export const KIND_LABELS: Record<TransferKind, string> = { transfer: '振替', card_settlement: '引落', charge: 'チャージ' };
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = { bank: '銀行', card: 'カード', wallet: '電子マネー', paypay: 'PayPay', cash: '現金' };
export const VISIBILITY_LABELS: Record<McpVisibility, string> = { full: '明細も', summary: '合計だけ', none: '見せない' };
export const VISIBILITY_ORDER: readonly McpVisibility[] = ['none', 'summary', 'full'];
export const SCHEDULE_CATEGORY_LABELS: Record<ScheduleCategory, string> = { tax: '税金', insurance: '保険', car: '車', other: 'その他', income: '収入' };
export const SCHEDULE_CATEGORIES: readonly ScheduleCategory[] = ['tax', 'insurance', 'car', 'other', 'income'];
export const RECURRENCE_LABELS: Record<Recurrence, string> = { once: '1 回', monthly: '毎月', bimonthly: '隔月', quarterly: '3 か月ごと', yearly: '毎年', biennial: '隔年' };
export const RECURRENCES: readonly Recurrence[] = ['once', 'monthly', 'bimonthly', 'quarterly', 'yearly', 'biennial'];
export const RECURRENCE_MONTHS: Record<Exclude<Recurrence, 'once'>, number> = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12, biennial: 24 };
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

// API の {error} の文言。知らないコードはそのまま出す。
export const ERROR_TEXT: Record<string, string> = {
  invalid_q: '検索語が短すぎるか、法人格だけです。',
  invalid_range: '期間か金額の範囲が逆になっています。',
  invalid_cursor: '続きの位置が読めませんでした。読み直してください。',
  invalid_from: '期間の始まりが正しくありません。',
  invalid_to: '期間の終わりが正しくありません。',
  invalid_category: 'カテゴリが正しくありません。',
  invalid_tag: 'タグが正しくありません。',
  invalid_name: '名称を入れてください（200 文字まで）。',
  invalid_amount: '金額は 1 円以上の整数で入れてください。',
  invalid_anchor_date: '最初の支払日が正しくありません。',
  invalid_end_date: '終わりの日が正しくありません。',
  invalid_notify_days_before: '知らせる日数は 0〜365 で入れてください。',
  end_before_anchor: '終わりの日は最初の支払日より後にしてください。',
  invalid_category_for_direction: '支出の予定に「収入」の分類は付けられません。',
  invalid_recurrence: '周期が正しくありません（「3 か月ごと」はサーバーの更新後に使えます）。',
  invalid_pattern: '摘要の文字が正しくありません。',
  invalid_card_settlement_account_id: '引落元の口座が正しくありません。',
  invalid_card_settlement_pattern: '引落の摘要の文字は 1〜200 文字で入れてください。',
  unknown_account: '口座が見つかりません。',
  not_open: 'この提案はもう処理されています。',
  not_found: '見つかりませんでした。読み直してください。',
  invalid_kind: '種別が正しくありません。',
  not_csv_account: 'この口座は CSV では取り込めません（freee から同期する口座です）。',
  unknown_format: 'この CSV の形式は読めません（今は PayPay の CSV だけ）。',
  file_required: 'ファイルを選んでください。',
  too_large: 'ファイルが大きすぎます（5MB まで）。',
  already_imported: '同じファイルは取り込み済みです。',
  empty_file: 'CSV に明細の行がありません。',
};

export function failText(status: number, body?: unknown): string {
  if (status === 0) return '通信できません。電波の良い所でもう一度試してください。';
  const err = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null;
  if (err) return ERROR_TEXT[err] ?? `受け付けられませんでした（${err}）`;
  return `サーバーから読めませんでした（HTTP ${status}）`;
}

// ---- CSV の取り込み（POST /api/accounts/:id/import、src/bank/csv/import.ts） ----

export type CsvImportResult = {
  csv_import_id: string;
  parser: string;
  rows_total: number;
  rows_new: number;
  rows_merged: number;
  rows_skipped_points: number;
  rows_error: number;
  errors: { line: number; reason: string }[];
  date_range: { from: string; to: string } | null;
};

const CSV_ROW_ERROR_TEXT: Record<string, string> = {
  invalid_columns: '列の数が違います',
  invalid_date: '日付が読めません',
  invalid_amount: '金額が読めません',
  no_amount: '出金にも入金にも金額がありません',
  both_amounts: '出金と入金の両方に金額があります',
  missing_external_id: '取引番号がありません',
  duplicate_in_file: '同じ取引番号の行が前にあります',
  mixed_method: 'ポイントとの併用払いで、残高から出た額が読めません',
  external_id_conflict: '取り込み済みの同じ取引番号と日付か金額が違います',
};
export const CSV_ERRORS_SHOWN = 20;
// サーバーの上限（src/web/routes/bank.ts の CSV_MAX_BYTES）。選んだ時点で超えていれば送らない。
export const CSV_MAX_BYTES = 5 * 1024 * 1024;

export function csvRowError(e: { line: number; reason: string }): string {
  return `${e.line} 行目: ${CSV_ROW_ERROR_TEXT[e.reason] ?? e.reason}`;
}

export function importSummary(r: CsvImportResult): string {
  return `新規 ${r.rows_new} 件・統合 ${r.rows_merged} 件・ポイント ${r.rows_skipped_points} 件を除外・エラー ${r.rows_error} 件`;
}

// CSV だけの口座の種別（POST /api/accounts の kind）。「その他」は wallet。
export const CSV_ACCOUNT_KINDS: readonly { kind: AccountKind; label: string }[] = [
  { kind: 'paypay', label: 'PayPay' },
  { kind: 'bank', label: '銀行' },
  { kind: 'wallet', label: 'その他' },
];

// ---- 明細の絞り込み ----

// month は月次から来たときの「その月」（TxnFilter.month）。
export type Period = 'this' | 'last' | 'three' | 'all' | 'month';
export const PERIOD_LABELS: Record<Exclude<Period, 'month'>, string> = { this: '今月', last: '先月', three: '3 か月', all: '全部' };
export const PERIODS: readonly Exclude<Period, 'month'>[] = ['this', 'last', 'three', 'all'];

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

// 期間 → {from, to}（YYYY-MM-DD）。3 か月は今月を含む直近 3 か月。全部は絞らない。month は指定の月。
export function periodRange(p: Period, today: string, month?: string): { from?: string; to?: string } {
  const m = today.slice(0, 7);
  if (p === 'month' && month) return { from: `${month}-01`, to: lastDay(month) };
  if (p === 'this') return { from: `${m}-01`, to: today };
  if (p === 'last') {
    const l = addMonth(m, -1);
    return { from: `${l}-01`, to: lastDay(l) };
  }
  if (p === 'three') return { from: `${addMonth(m, -2)}-01`, to: today };
  return {};
}

export type TxnFilter = { period: Period; month?: string; accountId: string; tag: '' | Tag; category: string; q: string };
export const emptyFilter = (): TxnFilter => ({ period: 'this', accountId: '', tag: '', category: '', q: '' });
// 「絞り込み（n）」の n（期間は数えない）。
export const filterCount = (f: TxnFilter) => [f.accountId, f.tag, f.category, f.q.trim()].filter((x) => x !== '').length;
export const UNCATEGORIZED_QUERY = 'none';
export const TXN_PAGE = 50;

// GET /api/bank_txns の URL。category は '' = 全部、'none' = 未分類。q は前後の空白を落とし、空なら送らない。
export function txnsUrl(f: TxnFilter, today: string, cursor: string | null, limit = TXN_PAGE): string {
  const p = new URLSearchParams({ limit: String(limit) });
  const r = periodRange(f.period, today, f.month);
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

// 読み込んだ明細の件数と、集計から除く分を除いた支出の合計。
export function txnSummary(items: Txn[]): { count: number; expense: number } {
  return { count: items.length, expense: items.reduce((a, t) => (t.side === 'expense' && !t.excluded ? a + t.amount : a), 0) };
}

// タグを付けた後に開く、次の未設定の明細（今の行より下）。無ければ null。
export function nextUnset(items: Txn[], id: string): Txn | null {
  const i = items.findIndex((t) => t.id === id);
  return items.slice(i + 1).find((t) => t.tag === 'unset' && !t.excluded) ?? null;
}

// ---- 月次 ----

export const MONTHLY_MONTHS = 6;

// カテゴリ別: 支出の大きい順に、取った月（最大 6 か月）の平均との差（支出）を付ける。無い月は 0 円として数える。
export type CategoryRow = { category: string | null; income: number; expense: number; diff: number };
export function categoryRows(months: MonthlySummary[], month: string): CategoryRow[] {
  const cur = months.find((m) => m.month === month);
  if (!cur || months.length === 0) return [];
  const key = (c: string | null) => c ?? '';
  const sum = new Map<string, number>();
  for (const m of months) for (const r of m.by_category) sum.set(key(r.category), (sum.get(key(r.category)) ?? 0) + r.expense);
  return cur.by_category
    .map((r) => ({ ...r, diff: r.expense - Math.round((sum.get(key(r.category)) ?? 0) / months.length) }))
    .sort((a, b) => b.expense - a.expense);
}
export const signed = (n: number) => (n > 0 ? `+${yen(n)}` : yen(n));

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

// 提案の分類の初期値を摘要から推す。摘要は normalizeVendor 済み（NFKC で半角カナは全角）。
const GUESS: [RegExp, ScheduleCategory][] = [
  [/ソンポ|保険|生命|共済/, 'insurance'],
  [/税|ゼイ|国保|年金/, 'tax'],
  [/車|ジドウシャ|ガソリン|駐車/, 'car'],
];
export function guessCategory(description: string): ScheduleCategory {
  const s = description.normalize('NFKC');
  return GUESS.find(([re]) => re.test(s))?.[1] ?? 'other';
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
export const emptyDraft = (today: string, direction: Direction = 'out'): ItemDraft => ({
  name: '',
  amount: '',
  direction,
  category: direction === 'in' ? 'income' : 'other',
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

export const TEXT_MAX = 200;
export const NOTIFY_MAX = 365;
const notifyOf = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);

// 予定の下書きのまずい所（サーバーと同じ条件）。良ければ null。
export function draftError(d: ItemDraft): string | null {
  const name = d.name.trim();
  if (!name || name.length > TEXT_MAX) return ERROR_TEXT.invalid_name!;
  if (parseYen(d.amount) === null) return ERROR_TEXT.invalid_amount!;
  if (!d.anchor_date) return ERROR_TEXT.invalid_anchor_date!;
  if (d.end_date && d.end_date < d.anchor_date) return ERROR_TEXT.end_before_anchor!;
  const n = notifyOf(d.notify_days_before);
  if (n === null || n > NOTIFY_MAX) return ERROR_TEXT.invalid_notify_days_before!;
  if (d.direction === 'out' && d.category === 'income') return ERROR_TEXT.invalid_category_for_direction!;
  return null;
}

// POST / PATCH /api/scheduled_items の本文。だめなら null（保存ボタンを押せない。理由は draftError）。
export function draftBody(d: ItemDraft): Record<string, unknown> | null {
  if (draftError(d) !== null) return null;
  const amount = parseYen(d.amount);
  const notify = notifyOf(d.notify_days_before);
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
  if (w.kind === 'tax_profile_missing') return '税・保険の見積もりが未設定です（予定 → 税・保険の見積もり）。';
  if (w.kind === 'consumption_tax_mode_unset') return '消費税は見通しに入っていません（方式が未設定）。';
  return w.months_available === 0
    ? '過去の明細がまだ無いため、予定外支出の目安を 0 円にしています。'
    : `過去の明細が ${w.months_available} か月分しかないため、予定外支出の目安は粗い値です。`;
}

// 予定収入が 36 か月で 0 なら、残高は減る一方の見通し（収入の予定を足すよう促す）。
export const noIncome = (cf: Forecast) => cf.months.every((m) => m.planned_in === 0);
// ---- 口座 ----

// 引落の設定が済んでいないカード（引落元か摘要の文字が空。サーバーの cards_without_settlement と同じ条件）。二重計上になる。
export const needsSettlement = (a: Account) => a.kind === 'card' && a.active && (!a.card_settlement_account_id || !a.card_settlement_pattern);

// GET /api/bank_txns（tag=unset・category=none など）の 1 ページから件数（集計外は数えない）。
// 上限（limit）まで返ってきたか次があるなら、集計外を除いた数に関係なく返ってきた件数で more（limit=100 なら「100+」）。
export function pageCount(p: TxnPage, limit: number): { n: number; more: boolean } {
  if (p.next_cursor !== null || p.items.length >= limit) return { n: p.items.length, more: true };
  return { n: p.items.filter((t) => !t.excluded).length, more: false };
}
export const countLabel = (c: { n: number; more: boolean }) => `${c.n}${c.more ? '+' : ''}`;

// カードの引落元に選べる口座（銀行だけ）。
export const settlementChoices = (accounts: Account[]) => accounts.filter((a) => a.kind === 'bank');
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

export const syncText = (created: boolean) => (created ? '同期を始めました。しばらくしてから読み直してください。' : '実行中か、10 分以内に実行済みです。');

// ---- お金のホーム（今日使えるお金・今月の進み・確認すること・各画面への入口） ----

// 「125万」「13.2万」「−1.8万」。100 万以上は整数、それ未満は小数 1 桁（.0 は落とす）。
export function man(n: number): string {
  if (Math.abs(n) < 10000) return yen(n);
  const v = n / 10000;
  const a = Math.abs(v);
  const s = a >= 100 ? String(Math.round(a)) : String(Math.round(a * 10) / 10);
  return `${v < 0 && s !== '0' ? '−' : ''}${s}万`;
}
// 差額の「+6.8万」。
export const signedMan = (n: number) => (n > 0 ? `+${man(n)}` : man(n));

// 今日は月の何日目か。
export function dayOfMonth(today: string): { day: number; days: number } {
  const days = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  return { day: Number(today.slice(8, 10)), days };
}

// 「11/6」。
export const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export const weekday = (date: string) => WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
// 日付の差（b − a、日）。
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// ISO の日時 → 「今日 9:12」「11/5 9:12」（端末のローカル時刻）。null は「—」。
export function shortTime(iso: string | null, today: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${d.getHours()}:${pad(d.getMinutes())}`;
  return day === today ? `今日 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// overview の sync.errors（形は追加中）を件数にする。配列なら長さ、数ならそのまま。
export function syncErrorCount(e: unknown): number {
  if (Array.isArray(e)) return e.length;
  return typeof e === 'number' && e > 0 ? e : 0;
}

// /api/bank/overview が無いサーバー向けの代わり。資金繰り（起点残高・残す額・今月の行）、今月の月次、口座から作る。
// 資金繰りが読めなければ残高が分からないので null（その部分を隠す）。
export function overviewFallback(x: {
  today: string;
  accounts: Account[];
  cf: Forecast | null;
  month: MonthlySummary | null;
  untagged: { n: number; more: boolean };
  candidates: number;
  lastOkAt: string | null;
}): Overview | null {
  if (!x.cf) return null;
  const cur = x.cf.months.find((m) => m.month === x.today.slice(0, 7)) ?? null;
  // 今月の収支は資金繰りに入れる口座の分だけ（サーバーの overview と同じ）。
  const inCf = (x.month?.by_account ?? []).filter((r) => r.include_in_cashflow && r.active);
  const byAccount = x.accounts
    .filter((a) => a.active && a.include_in_cashflow && a.kind !== 'card' && a.latest_balance)
    .map((a) => ({ account_id: a.id, name: a.name, kind: a.kind, balance: a.latest_balance!.balance, as_of_date: a.latest_balance!.as_of_date }));
  return {
    today: x.today,
    balances: { total: x.cf.opening_balance, by_account: byAccount },
    reserve: x.cf.reserve,
    available: x.cf.opening_balance - x.cf.reserve,
    untagged_count: x.untagged.n,
    untagged_more: x.untagged.more,
    cards_without_settlement: x.accounts.filter(needsSettlement).map((a) => ({ account_id: a.id, name: a.name })),
    open_candidates: x.candidates,
    this_month: {
      month: x.today.slice(0, 7),
      income: inCf.reduce((a, r) => a + r.income, 0),
      expense: inCf.reduce((a, r) => a + r.expense, 0),
      planned_out_remaining: cur?.planned_out ?? 0,
      unplanned_out_estimate: cur?.unplanned_out ?? 0,
      projected_end_balance: cur?.balance_end ?? x.cf.opening_balance,
    },
    sync: { last_ok_at: x.lastOkAt, errors: 0 },
  };
}

// 支出の帯: 済み / 予定の残り / 予定にない支出の目安 の割合（%、合計 100。全部 0 なら 0）。
export function spendBand(t: ThisMonth): { done: number; planned: number; unplanned: number; total: number; pct: [number, number, number] } {
  const done = Math.max(0, t.expense);
  const planned = Math.max(0, t.planned_out_remaining);
  const unplanned = Math.max(0, t.unplanned_out_estimate);
  const total = done + planned + unplanned;
  if (total === 0) return { done, planned, unplanned, total, pct: [0, 0, 0] };
  const a = Math.round((done / total) * 1000) / 10;
  const b = Math.round((planned / total) * 1000) / 10;
  return { done, planned, unplanned, total, pct: [a, b, Math.round((100 - a - b) * 10) / 10] };
}
// 収入の進み（%、0〜100）。
export const incomePct = (income: number, expected: number) => (expected <= 0 ? (income > 0 ? 100 : 0) : Math.min(100, Math.round((income / expected) * 1000) / 10));

// 今月の残りの予定収入（資金繰りの今月の行）と、いちばん早い入金。
export function incomeAhead(cf: Forecast | null, month: string): { total: number; first: ForecastItem | null } {
  const m = cf?.months.find((x) => x.month === month);
  const items = (m?.items ?? []).filter((it) => it.direction === 'in').sort((a, b) => a.due.localeCompare(b.due));
  return { total: m?.planned_in ?? 0, first: items[0] ?? null };
}

// ホームの「確認すること」。並びは 引落元 → 提案 → 未設定の明細 → 収入の予定なし。
export type Notice =
  | { kind: 'card_settlement'; accountId: string; name: string }
  | { kind: 'candidates'; count: number }
  | { kind: 'untagged'; count: number; more: boolean }
  | { kind: 'no_income' };
export function notices(o: Overview, cf: Forecast | null): Notice[] {
  const out: Notice[] = o.cards_without_settlement.map((c) => ({ kind: 'card_settlement' as const, accountId: c.account_id, name: c.name }));
  if (o.open_candidates > 0) out.push({ kind: 'candidates', count: o.open_candidates });
  if (o.untagged_count > 0) out.push({ kind: 'untagged', count: o.untagged_count, more: o.untagged_more === true });
  if (cf && noIncome(cf)) out.push({ kind: 'no_income' });
  return out;
}

// カテゴリ別の差が目立つか（平均より 2 万円以上、かつ平均の半分以上多い）。太字と、ホームの月次の文に使う。
export function notableDiff(r: { expense: number; diff: number }): boolean {
  const avg = r.expense - r.diff;
  return r.diff >= 20000 && r.diff >= avg * 0.5;
}

// 月次の入口の 1 行: 「10 月の差額 −20,000（税金が平均より多い）」。目立つ差のうちいちばん大きいカテゴリを添える。
export function monthlyLine(months: MonthlySummary[], month: string, cats: Categories | null): string | null {
  const cur = months.find((m) => m.month === month);
  if (!cur) return null;
  const top = categoryRows(months, month)
    .filter((r) => r.category !== null && notableDiff(r))
    .sort((a, b) => b.diff - a.diff)[0];
  const head = `${Number(month.slice(5, 7))} 月の差額 ${yen(cur.total.net)}`;
  return top ? `${head}（${categoryLabel(cats, top.category)}が平均より多い）` : head;
}

// 有効なカードの今月の利用（月次集計の口座別の支出）。口座 id → 額。カードは残高を持たないので、口座の画面とホームの注記はこれを出す。
export function cardUsage(accounts: Account[], s: MonthlySummary | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!s) return out;
  for (const a of accounts) {
    if (a.kind !== 'card' || !a.active) continue;
    out[a.id] = s.by_account.find((r) => r.account_id === a.id)?.expense ?? 0;
  }
  return out;
}

// ---- 見通し ----

// 結論。不足する月があれば「YYYY-MM に残す額を下回ります」、無ければ「3 年間足ります」。減らせば足りる額（cut_per_month_to_survive）があれば添える。
export function verdict(cf: Forecast): { short: boolean; title: string; detail: string; cut: string | null } {
  const n = cf.months.length;
  const span = n > 0 && n % 12 === 0 ? `${n / 12} 年間` : `${n} か月`;
  const last = cf.months[n - 1];
  const cut = cf.cut_per_month_to_survive;
  const cutText = typeof cut === 'number' && cut > 0 ? `予定にない支出を月 ${yen(cut)} 円減らすと、${span}は足ります。` : null;
  if (cf.first_shortfall_month) {
    const detail =
      last && last.balance_end < 0 ? `このままだと ${last.month} に残高が ${yen(last.balance_end)} になります。` : `このままだと ${cf.first_shortfall_month} から残す額に足りません。`;
    return { short: true, title: `${cf.first_shortfall_month} に残す額を下回ります`, detail, cut: cutText };
  }
  const lo = cf.months.reduce<ForecastMonth | null>((a, m) => (a === null || m.margin < a.margin ? m : a), null);
  const low = cf.min_month ?? (lo ? { month: lo.month, margin: lo.margin } : null);
  return { short: false, title: `${span}足ります`, detail: low ? `いちばん余裕が少ないのは ${low.month}（残す額を引いて ${yen(low.margin)}）。` : '', cut: null };
}

// 年ごとに 12 か月ずつ。足りない月（margin < 0）の数と、最低の余裕（同じなら早い月）。
export type YearGroup = { index: number; from: string; to: string; months: ForecastMonth[]; shortCount: number; low: { month: string; margin: number } };
export function yearGroups(months: ForecastMonth[]): YearGroup[] {
  const out: YearGroup[] = [];
  for (let i = 0; i < months.length; i += 12) {
    const ms = months.slice(i, i + 12);
    const low = ms.reduce((a, m) => (m.margin < a.margin ? m : a), ms[0]!);
    out.push({ index: i / 12, from: ms[0]!.month, to: ms[ms.length - 1]!.month, months: ms, shortCount: ms.filter((m) => m.margin < 0).length, low: { month: low.month, margin: low.margin } });
  }
  return out;
}
export function yearSummary(g: YearGroup): string {
  if (g.shortCount === 0) return `ずっと足りる · 最低の余裕 ${yen(g.low.margin)}（${g.low.month}）`;
  const all = g.shortCount === g.months.length;
  return `${all ? `${g.months.length} か月とも` : `${g.shortCount} か月`}残す額に足りない · 最大 ${yen(g.low.margin)}（${g.low.month}）`;
}

// 予定の分類と周期（資金繰りの items は id・名前・金額だけなので、台帳から id で引く）。
export type ItemInfo = { category: ScheduleCategory; recurrence: Recurrence };
export const itemInfoMap = (items: ScheduledItem[]): Record<string, ItemInfo> => Object.fromEntries(items.map((it) => [it.id, { category: it.category, recurrence: it.recurrence }]));

// 見通しの印: 月ごとの 税金・保険・車 の予定支出（毎月の分は除く）。
export type MarkCat = 'tax' | 'insurance' | 'car';
export type MonthMarks = { month: string; tax: number; insurance: number; car: number; names: { category: MarkCat; name: string; amount: number; estimate?: true }[] };
export function monthMarks(months: ForecastMonth[], info: Record<string, ItemInfo>): MonthMarks[] {
  return months.map((m) => {
    const out: MonthMarks = { month: m.month, tax: 0, insurance: 0, car: 0, names: [] };
    for (const it of m.items) {
      const i = info[it.id];
      if (it.direction !== 'out' || !i || i.recurrence === 'monthly') continue;
      if (i.category !== 'tax' && i.category !== 'insurance' && i.category !== 'car') continue;
      out[i.category] += it.amount;
      out.names.push({ category: i.category, name: it.name, amount: it.amount, ...(it.origin === 'estimate' ? { estimate: true as const } : {}) });
    }
    return out;
  });
}
// 印の大きさ（0 = 無し、1〜3）。いちばん大きい月を 3。
export function markSize(amount: number, max: number): 0 | 1 | 2 | 3 {
  if (amount <= 0 || max <= 0) return 0;
  const r = amount / max;
  return r > 0.66 ? 3 : r > 0.33 ? 2 : 1;
}
// 予定収入が毎月同じなら、その額（行では省略する）。違えば null。
export function flatIncome(months: ForecastMonth[]): number | null {
  if (months.length === 0) return null;
  const v = months[0]!.planned_in;
  return v > 0 && months.every((m) => m.planned_in === v) ? v : null;
}

// ---- 予定 ----

// この先 12 か月の山: 今月から 12 か月、月ごとに分類別の予定支出（毎月の分は除く）。upcoming は期日つきの項目。
export type PeakMonth = { month: string; tax: number; insurance: number; car: number; other: number; total: number };
export function peakMonths(upcoming: Upcoming[], today: string): PeakMonth[] {
  const start = today.slice(0, 7);
  const out: PeakMonth[] = Array.from({ length: 12 }, (_, i) => ({ month: addMonth(start, i), tax: 0, insurance: 0, car: 0, other: 0, total: 0 }));
  for (const it of upcoming) {
    if (it.direction !== 'out' || it.recurrence === 'monthly') continue;
    const m = out.find((x) => x.month === it.due_date.slice(0, 7));
    if (!m) continue;
    const k = it.category === 'income' ? 'other' : it.category;
    m[k] += it.amount;
    m.total += it.amount;
  }
  return out;
}
// 山から除いた毎月の予定支出（1 か月あたり）。
export const monthlyFixed = (items: ScheduledItem[]) => items.filter((it) => it.active && it.direction === 'out' && it.recurrence === 'monthly').reduce((a, it) => a + it.amount, 0);
// 重い月（いちばん大きい月の半分以上のうち、大きい順に 3 つまで。並びは月の順）。
export function heavyMonths(peaks: PeakMonth[]): string[] {
  const max = Math.max(0, ...peaks.map((p) => p.total));
  if (max === 0) return [];
  const top = peaks.filter((p) => p.total >= max / 2).sort((a, b) => b.total - a.total).slice(0, 3);
  return peaks.filter((p) => top.includes(p)).map((p) => p.month);
}

// 台帳: 分類で絞り、次の期日の順（期日の無いものは後ろ、停止中は最後）。
export type LedgerFilter = '' | ScheduleCategory;
export function ledgerRows(items: ScheduledItem[], nextDue: Record<string, string>, filter: LedgerFilter, showInactive: boolean): ScheduledItem[] {
  const key = (it: ScheduledItem) => (it.active ? (nextDue[it.id] ?? '9999') : '~');
  return items
    .filter((it) => (showInactive || it.active) && (filter === '' || it.category === filter))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.name.localeCompare(b.name)));
}

// 提案の次の見込み日（最後の出現 + 周期。月末を超えたら月末）。
export function candidateNext(c: Candidate): string | null {
  const last = lastOccurrence(c);
  if (!last) return null;
  const m = addMonth(last.slice(0, 7), RECURRENCE_MONTHS[c.interval]);
  const d = Math.min(Number(last.slice(8, 10)), Number(lastDay(m).slice(8, 10)));
  return `${m}-${pad(d)}`;
}
// 提案の出現回数。
export function occurrenceCount(c: Candidate): number {
  try {
    const v = JSON.parse(c.occurrences_json) as unknown;
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

// ---- 明細 ----

// 日付ごとのまとまり（並びはそのまま）。net は集計外を除いた 収入 − 支出。
export type DayGroup = { date: string; net: number; items: Txn[] };
export function groupByDate(items: Txn[]): DayGroup[] {
  const out: DayGroup[] = [];
  for (const t of items) {
    let g = out[out.length - 1];
    if (!g || g.date !== t.txn_date) {
      g = { date: t.txn_date, net: 0, items: [] };
      out.push(g);
    }
    g.items.push(t);
    if (!t.excluded) g.net += t.side === 'income' ? t.amount : -t.amount;
  }
  return out;
}
// 「11/6（金）今日」。
export const dayLabel = (date: string, today: string) => `${md(date)}（${weekday(date)}）${date === today ? '今日' : ''}`;
// 右端のタグを押したときの次のタグ（事業 ⇄ 私用。未設定は事業へ）。
export const nextTag = (t: Tag): Tag => (t === 'business' ? 'private' : 'business');
// 読み込んだ分の収入の合計（集計外は数えない）。
export const txnIncome = (items: Txn[]) => items.reduce((a, t) => (t.side === 'income' && !t.excluded ? a + t.amount : a), 0);
// 期間の表示「11/1〜11/6」。全部は「全期間」。
export function periodText(f: TxnFilter, today: string): string {
  const r = periodRange(f.period, today, f.month);
  return r.from && r.to ? `${md(r.from)}〜${md(r.to)}` : '全期間';
}
// ルール化したとき、同じ口座・同じ摘要の未設定の行にも同じタグを付けて見せる（サーバーのルールは次の読み込みから効く）。
export function applyRuleLocally(items: Txn[], src: Txn, tag: Tag, category: string | null): Txn[] {
  return items.map((t) =>
    t.id !== src.id && t.tag === 'unset' && !t.excluded && t.account_id === src.account_id && t.description === src.description ? { ...t, tag, category, tag_source: 'rule' } : t,
  );
}
// 未設定の中での位置（1 始まり。未設定でなければ 0）と数（読み込んだ分）。
export function unsetPosition(items: Txn[], id: string): { index: number; total: number } {
  const unset = items.filter((t) => t.tag === 'unset' && !t.excluded);
  return { index: unset.findIndex((t) => t.id === id) + 1, total: unset.length };
}

// ---- 月次 ----

// 選んだ月で終わる 6 か月（平均と 6 か月の棒に使う）。
export const monthlyRangeUrl = (month: string) => `/api/summary/monthly?from=${addMonth(month, -(MONTHLY_MONTHS - 1))}&to=${month}`;
// 事業/私用/未設定の支出と割合（%）。
export function tagShares(cur: MonthlySummary): { tag: Tag; expense: number; pct: number }[] {
  const total = cur.by_tag.reduce((a, r) => a + r.expense, 0);
  return TAG_ORDER.map((tag) => {
    const expense = cur.by_tag.find((r) => r.tag === tag)?.expense ?? 0;
    return { tag, expense, pct: total > 0 ? Math.round((expense / total) * 1000) / 10 : 0 };
  });
}

// 期日の短い表示: 今年なら「11/27」、それ以外は「2027-01-31」。
export const dateShort = (date: string, today: string) => (date.slice(0, 4) === today.slice(0, 4) ? md(date) : date);

// ---- 税・保険の見積もり（GET/PUT /api/tax/profile・PUT /api/tax/years/:year・POST /api/tax/recalculate、src/web/routes/tax.ts） ----

export type BlueReturn = '65' | '55' | '10' | 'white';
export type PensionMode = 'monthly' | 'prepay6' | 'prepay12' | 'prepay24' | 'none';
export type TaxProfile = {
  blue_return: BlueReturn;
  consumption_mode: string;
  biz_tax_rate: number | null;
  nhi_preset: string | null;
  nhi_members: number;
  nhi_members_40_64: number;
  pension_mode: PensionMode;
  pension_addon: boolean;
  dependents: number;
  spouse: boolean;
  other_deductions: number;
  payment_account_id: string | null;
};
export type TaxYearKind = 'actual' | 'estimate';
export type TaxYear = {
  year: number;
  kind: TaxYearKind;
  revenue: number | null;
  expenses: number | null;
  business_income: number | null;
  social_insurance_paid: number | null;
  income_tax_final: number | null;
  consumption_tax_final: number | null;
  prepaid_income_tax: number | null;
};
export type TaxProfileResponse = { profile: TaxProfile | null; years: TaxYear[]; presets: { id: string; label: string }[]; missing: string[] };
export type TaxWarning =
  | { kind: 'tax_profile_missing' }
  | { kind: 'consumption_tax_mode_unset' }
  | { kind: 'income_missing'; year: number }
  | { kind: 'pinned_withdrawn'; key: string; item_id: string }
  | { kind: 'possible_duplicate'; key: string; item_ids: [string, string] };
export type RunSummary = { run_id: string; created: number; updated: number; deactivated: number; skipped_pinned: unknown[]; warnings: TaxWarning[] };
// 予定の先頭のカードに出すもの（profile の応答と、最新の再計算の時刻 = GET /api/tax/estimates の created_at）。
export type TaxSummary = TaxProfileResponse & { last_run_at: string | null };

export const BLUE_RETURN_LABELS: Record<BlueReturn, string> = { '65': '65 万', '55': '55 万', '10': '10 万', white: '白色' };
export const BLUE_RETURNS: readonly BlueReturn[] = ['65', '55', '10', 'white'];
const BLUE_DEDUCTION: Record<BlueReturn, number> = { '65': 650000, '55': 550000, '10': 100000, white: 0 };
export const PENSION_LABELS: Record<Exclude<PensionMode, 'none'>, string> = { monthly: '月払い', prepay6: '6 か月', prepay12: '1 年', prepay24: '2 年' };
export const PENSION_MODES: readonly Exclude<PensionMode, 'none'>[] = ['monthly', 'prepay6', 'prepay12', 'prepay24'];
export const CONSUMPTION_LABELS: Record<string, string> = { unset: '未設定', exempt: '免税', special20: '2 割特例', simplified: '簡易課税', standard: '本則' };
// 個人事業税の納税通知が来ているときの税率。
export const BIZ_TAX_RATE = 0.05;

// プロファイルが無いときのフォームの初期値（サーバーの DEFAULT_PROFILE と同じ）。
export const DEFAULT_TAX_PROFILE: TaxProfile = {
  blue_return: '65',
  consumption_mode: 'unset',
  biz_tax_rate: null,
  nhi_preset: 'saitama-city-2026',
  nhi_members: 1,
  nhi_members_40_64: 0,
  pension_mode: 'monthly',
  pension_addon: false,
  dependents: 0,
  spouse: false,
  other_deductions: 0,
  payment_account_id: null,
};

// その年の所得（青色控除後）。その年に無ければ前の年で最も新しいものを繰り越す（サーバーの engine.ts と同じ）。出せなければ null。
export function taxIncome(years: TaxYear[], year: number, blue: BlueReturn): number | null {
  const rows = years.filter((y) => y.year <= year).sort((a, b) => b.year - a.year);
  for (const y of rows) {
    if (y.business_income !== null) return y.business_income;
    if (y.revenue !== null && y.expenses !== null) return Math.max(0, y.revenue - y.expenses - BLUE_DEDUCTION[blue]);
  }
  return null;
}

// ISO の日時 → 東京の暦日（YYYY-MM-DD）。
export const tokyoDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);

// カードの 1 行: 「2026 年分 所得 400万円 / 最終計算 11/7」。
export function taxCardLine(t: TaxSummary, today: string): string {
  const y = Number(today.slice(0, 4));
  const inc = taxIncome(t.years, y, t.profile?.blue_return ?? '65');
  const last = t.last_run_at ? md(tokyoDate(t.last_run_at)) : '—';
  return `${y} 年分 所得 ${inc === null ? '未入力' : `${man(inc)}円`} / 最終計算 ${last}`;
}

export type TaxProfileDraft = {
  blue_return: BlueReturn;
  biz_tax_rate: number | null;
  nhi_preset: string;
  nhi_members: string;
  nhi_members_40_64: string;
  pension_mode: PensionMode;
  pension_addon: boolean;
  spouse: boolean;
  dependents: string;
  other_deductions: string;
  payment_account_id: string;
};
export function taxProfileDraft(p: TaxProfile | null): TaxProfileDraft {
  const v = p ?? DEFAULT_TAX_PROFILE;
  return {
    blue_return: v.blue_return,
    biz_tax_rate: v.biz_tax_rate,
    nhi_preset: v.nhi_preset ?? '',
    nhi_members: String(v.nhi_members),
    nhi_members_40_64: String(v.nhi_members_40_64),
    pension_mode: v.pension_mode,
    pension_addon: v.pension_addon,
    spouse: v.spouse,
    dependents: String(v.dependents),
    other_deductions: String(v.other_deductions),
    payment_account_id: v.payment_account_id ?? '',
  };
}

// 全角数字・カンマ・円記号を許す 0 以上の整数（signed なら負も）。空は null、だめなら undefined。
export function parseAmount(s: string, signed = false): number | null | undefined {
  const t = s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，¥￥円\s]/g, '')
    .replace(/^[−－]/, '-');
  if (t === '') return null;
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

// PUT /api/tax/profile の本文（フォームで扱う列だけ。消費税の方式は送らない）。だめなら理由の文。
export function taxProfileBody(d: TaxProfileDraft): Record<string, unknown> | string {
  const members = parseAmount(d.nhi_members);
  const m4064 = parseAmount(d.nhi_members_40_64);
  const deps = parseAmount(d.dependents);
  const other = parseAmount(d.other_deductions);
  if (typeof members !== 'number' || members > 20) return '国保の加入人数は 0〜20 で入れてください。';
  if (typeof m4064 !== 'number' || m4064 > members) return '40〜64 歳の人数は加入人数以下で入れてください。';
  if (typeof deps !== 'number' || deps > 20) return '扶養の人数は 0〜20 で入れてください。';
  if (other === undefined) return 'iDeCo 等の年額は 0 以上の整数で入れてください。';
  return {
    blue_return: d.blue_return,
    biz_tax_rate: d.biz_tax_rate,
    nhi_preset: d.nhi_preset || null,
    nhi_members: members,
    nhi_members_40_64: m4064,
    pension_mode: d.pension_mode,
    pension_addon: d.pension_addon,
    spouse: d.spouse,
    dependents: deps,
    other_deductions: other ?? 0,
    payment_account_id: d.payment_account_id || null,
  };
}

// 年ごとの入力の列。確定の年と見込みの年で項目が違う。
export type TaxYearField = Exclude<keyof TaxYear, 'year' | 'kind'>;
export const ACTUAL_FIELDS: readonly { k: TaxYearField; label: string }[] = [
  { k: 'business_income', label: '所得（青色控除後）' },
  { k: 'income_tax_final', label: '所得税の申告納税額' },
  { k: 'prepaid_income_tax', label: '納めた予定納税' },
  { k: 'consumption_tax_final', label: '消費税額（国税分）' },
  { k: 'social_insurance_paid', label: '社会保険料' },
];
export const ESTIMATE_FIELDS: readonly { k: TaxYearField; label: string }[] = [
  { k: 'revenue', label: '売上' },
  { k: 'expenses', label: '経費' },
  { k: 'business_income', label: '所得を直接（入れたら優先）' },
];
export type TaxYearDraft = { year: number; kind: TaxYearKind; values: Partial<Record<TaxYearField, string>> };
const fieldsOf = (kind: TaxYearKind) => (kind === 'actual' ? ACTUAL_FIELDS : ESTIMATE_FIELDS);

// 今年の前年は確定、今年から 3 年は見込み。
export function taxYearDrafts(years: TaxYear[], today: string): TaxYearDraft[] {
  const y = Number(today.slice(0, 4));
  return [y - 1, y, y + 1, y + 2].map((year) => {
    const kind: TaxYearKind = year < y ? 'actual' : 'estimate';
    const row = years.find((r) => r.year === year);
    return { year, kind, values: Object.fromEntries(fieldsOf(kind).map((f) => [f.k, row?.[f.k] == null ? '' : String(row[f.k])])) };
  });
}

// 変えた年の PUT /api/tax/years/:year の本文。だめな値があれば理由の文。まだ無い年で全部空欄なら送らない（前の年を繰り越す）。
export function taxYearBodies(drafts: TaxYearDraft[], years: TaxYear[]): { year: number; body: Record<string, unknown> }[] | string {
  const out: { year: number; body: Record<string, unknown> }[] = [];
  for (const d of drafts) {
    const row = years.find((r) => r.year === d.year);
    const body: Record<string, unknown> = { kind: d.kind };
    let changed = row !== undefined && row.kind !== d.kind;
    let any = false;
    for (const f of fieldsOf(d.kind)) {
      const v = parseAmount(d.values[f.k] ?? '', f.k === 'business_income');
      if (v === undefined) return `${d.year} 年の「${f.label}」は整数で入れてください。`;
      body[f.k] = v;
      if (v !== null) any = true;
      if ((row?.[f.k] ?? null) !== v) changed = true;
    }
    if (!row && !any) continue;
    if (changed) out.push({ year: d.year, body });
  }
  return out;
}

export function taxWarningText(w: TaxWarning): string {
  switch (w.kind) {
    case 'tax_profile_missing':
      return '設定がまだ無いので作っていません。';
    case 'consumption_tax_mode_unset':
      return '消費税は未反映です。';
    case 'income_missing':
      return `${w.year} 年の所得が無い分は作っていません。`;
    case 'pinned_withdrawn':
      return '計算から外れた手直しの項目を残しています。';
    case 'possible_duplicate':
      return '似た予定が台帳にあります。重なりを確かめてください。';
  }
}

// 保存・再計算の結果の 1 行。何回か PUT したら件数は足し、警告は最後の回のもの。
export function runText(runs: RunSummary[], head: string): string {
  const sum = (k: 'created' | 'updated' | 'deactivated') => runs.reduce((a, r) => a + r[k], 0);
  const last = runs[runs.length - 1];
  const pinned = last ? last.skipped_pinned.length : 0;
  const warns = last ? [...new Set(last.warnings.map(taxWarningText))] : [];
  return [`${head}予定は作成 ${sum('created')}・更新 ${sum('updated')}・停止 ${sum('deactivated')} 件`, pinned > 0 ? `（手直しの ${pinned} 件はそのまま）` : '', '。', ...warns].join('');
}
