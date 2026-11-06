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
export const VISIBILITY_LABELS: Record<McpVisibility, string> = { full: '明細まで', summary: '集計だけ', none: '見せない' };
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
  invalid_card_settlement_account_id: '引落元の口座が正しくありません。',
  invalid_card_settlement_pattern: '引落の摘要の文字は 1〜200 文字で入れてください。',
  unknown_account: '口座が見つかりません。',
  not_open: 'この提案はもう処理されています。',
  not_found: '見つかりませんでした。読み直してください。',
};

export function failText(status: number, body?: unknown): string {
  if (status === 0) return '通信できません。電波の良い所でもう一度試してください。';
  const err = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null;
  if (err) return ERROR_TEXT[err] ?? `受け付けられませんでした（${err}）`;
  return `サーバーから読めませんでした（HTTP ${status}）`;
}

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
export function txnsUrl(f: TxnFilter, today: string, cursor: string | null): string {
  const p = new URLSearchParams({ limit: String(TXN_PAGE) });
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
  return items.slice(i + 1).find((t) => t.tag === 'unset') ?? null;
}

// ---- 月次 ----

export const MONTHLY_MONTHS = 6;
export function monthlyUrl(today: string): string {
  const to = today.slice(0, 7);
  return `/api/summary/monthly?from=${addMonth(to, -(MONTHLY_MONTHS - 1))}&to=${to}`;
}

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
  return w.months_available === 0
    ? '過去の明細がまだ無いため、予定外支出の目安を 0 円にしています。'
    : `過去の明細が ${w.months_available} か月分しかないため、予定外支出の目安は粗い値です。`;
}

// 予定収入が 36 か月で 0 なら、残高は減る一方の見通し（収入の予定を足すよう促す）。
export const noIncome = (cf: Forecast) => cf.months.every((m) => m.planned_in === 0);
// 推定月末残高のいちばん少ない月（同じなら早い月）。
export function lowestMonth(cf: Forecast): ForecastMonth | null {
  return cf.months.reduce<ForecastMonth | null>((lo, m) => (lo === null || m.balance_end < lo.balance_end ? m : lo), null);
}

// ---- はじめに ----

// お金タブの先頭に出す手順。済んだものは出さない（全部済めば空）。
export type SetupStep =
  | { kind: 'card_settlement'; count: number; accountId: string }
  | { kind: 'income'; count: 0 }
  | { kind: 'candidates'; count: number }
  | { kind: 'unset_tags'; count: number; more: boolean };
export function setupSteps(x: { accounts: Account[]; items: ScheduledItem[] | null; candidates: number; unset: { count: number; more: boolean } | null }): SetupStep[] {
  const out: SetupStep[] = [];
  const cards = x.accounts.filter((a) => a.kind === 'card' && a.active && a.card_settlement_account_id === null);
  if (cards.length > 0) out.push({ kind: 'card_settlement', count: cards.length, accountId: cards[0]!.id });
  if (x.items !== null && !x.items.some((it) => it.active && it.direction === 'in')) out.push({ kind: 'income', count: 0 });
  if (x.candidates > 0) out.push({ kind: 'candidates', count: x.candidates });
  if (x.unset && x.unset.count > 0) out.push({ kind: 'unset_tags', count: x.unset.count, more: x.unset.more });
  return out;
}

// ---- 口座 ----

// カードの引落元に選べる口座（銀行だけ）。
export const settlementChoices = (accounts: Account[]) => accounts.filter((a) => a.kind === 'bank');
// カードで引落元が空のとき出す警告。
export const SETTLEMENT_WARNING = '引落元が未設定のため、カードの支出が銀行の引落と二重に数えられます。';

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

// ISO の日時 → 「YYYY-MM-DD HH:MM」（端末のローカル時刻）。null は「—」。
export function dateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
