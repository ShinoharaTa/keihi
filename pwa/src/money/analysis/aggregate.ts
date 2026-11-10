// 分析の画面（#74）の純関数。月次集計（GET /api/summary/monthly?from&to の MonthlySummary[]、by_tag_category を使う）を
// 期間（月 / 四半期 1〜3・4〜6・7〜9・10〜12 月 / 暦年）に束ね、合計・推移の棒・クロス表・ドリルダウンの URL を作る。
// 期間は最初の月（YYYY-MM）で表す。今期（今月・今四半期・今年。cur を含む期間）は「（一部）」を付けず、過去の期間で読んだ範囲に無い月があるとき
// （36 か月の端の四半期・年）だけラベルに「（一部）」。
// タグの絞り込みは by_tag_category から（月次集計にタグの引数は無い）。口座は月次集計に口座の引数が無く by_account からは作れないので出さない。
// クロス表はタグで列を分けるので、タグの絞り込みは合計と推移にだけ効く。件数は向き（side）に合ったほう（income_count / expense_count）を使う。
import { addMonth, periodRange, TAG_ORDER, TXN_PAGE, UNCATEGORIZED_QUERY, type Categories, type MonthlySummary, type Tag, type TxnFilter } from '../model.ts';
import { categoryRank } from './colors.ts';

export type Span = 'month' | 'quarter' | 'year';
export type Side = 'expense' | 'income';
export const SPANS: readonly Span[] = ['month', 'quarter', 'year'];
export const SPAN_LABELS: Record<Span, string> = { month: '月', quarter: '四半期', year: '年' };
export const SIDE_LABELS: Record<Side, string> = { expense: '支出', income: '収入' };
const SPAN_MONTHS: Record<Span, number> = { month: 1, quarter: 3, year: 12 };
// 推移の棒の本数（月 12 本 = 12 か月、四半期 12 本 = 36 か月、年 3 本 = 36 か月）。
export const TREND_COUNT: Record<Span, number> = { month: 12, quarter: 12, year: 3 };
// 一度に読む月数の上限（src/bank/summary.ts の MAX_MONTHS）。
export const MAX_FETCH_MONTHS = 36;

const pad = (n: number) => String(n).padStart(2, '0');
const yearOf = (m: string) => Number(m.slice(0, 4));
const monOf = (m: string) => Number(m.slice(5, 7));

// その月を含む期間の最初の月。
export function periodStart(span: Span, month: string): string {
  if (span === 'month') return month;
  if (span === 'year') return `${month.slice(0, 4)}-01`;
  return `${month.slice(0, 4)}-${pad(Math.floor((monOf(month) - 1) / 3) * 3 + 1)}`;
}
export const periodMonths = (span: Span, start: string): string[] => Array.from({ length: SPAN_MONTHS[span] }, (_, i) => addMonth(start, i));
export const shiftPeriod = (span: Span, start: string, n: number): string => addMonth(start, n * SPAN_MONTHS[span]);

// 「2026 年 11 月」「2026 年 10〜12 月」「2026 年」。
export function periodLabel(span: Span, start: string): string {
  const y = yearOf(start);
  const m = monOf(start);
  if (span === 'month') return `${y} 年 ${m} 月`;
  if (span === 'quarter') return `${y} 年 ${m}〜${m + 2} 月`;
  return `${y} 年`;
}
// 棒の下のラベル（短く）。年は 1 月始まりの期間と最初の棒にだけ別の行で出す（yearMark）。
export function periodShort(span: Span, start: string): string {
  const m = monOf(start);
  if (span === 'month') return `${m}月`;
  if (span === 'quarter') return `${m}-${m + 2}月`;
  return `${yearOf(start)}年`;
}

// 推移の棒の期間（古い順。最後が base）。
export const trendStarts = (span: Span, base: string): string[] => Array.from({ length: TREND_COUNT[span] }, (_, i) => shiftPeriod(span, base, i - (TREND_COUNT[span] - 1)));

// 読む月の範囲（YYYY-MM、両端を含む）。推移の最初の期間の最初の月〜base の期間の最後の月。今月より先は読まない（その期間は「一部」）。
export function fetchRange(span: Span, base: string, today: string): { from: string; to: string } {
  const cur = today.slice(0, 7);
  const last = addMonth(base, SPAN_MONTHS[span] - 1);
  return { from: trendStarts(span, base)[0]!, to: last > cur ? cur : last };
}
// 読む範囲の月数（MAX_FETCH_MONTHS を超えない）。
export function monthCount(from: string, to: string): number {
  return (yearOf(to) - yearOf(from)) * 12 + monOf(to) - monOf(from) + 1;
}
export const summaryUrl = (r: { from: string; to: string }) => `/api/summary/monthly?from=${r.from}&to=${r.to}`;

// ---- 期間に束ねる ----

export type Cell = { income: number; expense: number; income_count: number; expense_count: number };
const countKey = (side: Side) => (side === 'income' ? 'income_count' : 'expense_count');
export type Row = { tag: Tag; category: string | null } & Cell;
export type Slice = { start: string; label: string; partial: boolean; rows: Row[] };
const zero = (): Cell => ({ income: 0, expense: 0, income_count: 0, expense_count: 0 });
const addTo = (a: Cell, b: Cell) => {
  a.income += b.income;
  a.expense += b.expense;
  a.income_count += b.income_count;
  a.expense_count += b.expense_count;
};
const rowOrder = (cats: Categories | null) => (a: Row, b: Row) => TAG_ORDER.indexOf(a.tag) - TAG_ORDER.indexOf(b.tag) || categoryRank(cats, a.category) - categoryRank(cats, b.category);

// 期間のタグ × カテゴリ（月をまたいで足す）。並びは tag 順 → カテゴリの台帳の順（cats。colors.ts）→ 未分類最後。cur は今月（YYYY-MM）。
export function slice(ms: readonly MonthlySummary[], span: Span, start: string, cur: string, cats: Categories | null = null): Slice {
  const months = periodMonths(span, start);
  const byMonth = new Map(ms.map((m) => [m.month, m]));
  const acc = new Map<string, Row>();
  let missing = 0;
  for (const m of months) {
    const s = byMonth.get(m);
    if (!s) {
      missing++;
      continue;
    }
    for (const r of s.by_tag_category ?? []) {
      const k = `${r.tag}\u0000${r.category ?? ''}`;
      let a = acc.get(k);
      if (!a) acc.set(k, (a = { tag: r.tag, category: r.category, ...zero() }));
      addTo(a, r);
    }
  }
  const current = start <= cur && cur <= months[months.length - 1]!;
  const partial = missing > 0 && !current;
  return { start, label: `${periodLabel(span, start)}${partial ? '（一部）' : ''}`, partial, rows: [...acc.values()].sort(rowOrder(cats)) };
}

const byTag = (rows: readonly Row[], tag: '' | Tag) => (tag === '' ? rows : rows.filter((r) => r.tag === tag));

export type Totals = Cell & { net: number };
// 合計（収入・支出・差額・入金と出金の件数）。tag は絞り込み（'' は全部）。
export function totals(rows: readonly Row[], tag: '' | Tag = ''): Totals {
  const t = zero();
  for (const r of byTag(rows, tag)) addTo(t, r);
  return { ...t, net: t.income - t.expense };
}

// ---- 推移 ----

export type TrendBar = { start: string; label: string; short: string; yearMark: string | null; partial: boolean; amount: number; count: number; segs: { category: string | null; amount: number }[] };
// 期間ごとのカテゴリの積み上げ（side の金額。下から台帳の順、未分類が上）。
export function trend(ms: readonly MonthlySummary[], span: Span, base: string, side: Side, cur: string, tag: '' | Tag = '', cats: Categories | null = null): TrendBar[] {
  return trendStarts(span, base).map((start, i) => {
    const s = slice(ms, span, start, cur, cats);
    const sums = new Map<string | null, number>();
    let count = 0;
    for (const r of byTag(s.rows, tag)) {
      count += r[countKey(side)];
      if (r[side] > 0) sums.set(r.category, (sums.get(r.category) ?? 0) + r[side]);
    }
    const segs = [...sums].sort(([a], [b]) => categoryRank(cats, a) - categoryRank(cats, b)).map(([category, amount]) => ({ category, amount }));
    const yearMark = span !== 'year' && (i === 0 || monOf(start) === 1) ? String(yearOf(start)) : null;
    return { start, label: s.label, short: periodShort(span, start), yearMark, partial: s.partial, amount: segs.reduce((a, x) => a + x.amount, 0), count, segs };
  });
}

// ---- クロス表 ----

export type Col = Tag | 'all';
export const COLS: readonly Col[] = ['all', 'business', 'private', 'unset'];
export const COL_LABELS: Record<Col, string> = { all: '計', business: '事業', private: '私用', unset: '未設定' };
export type CrossCell = { amount: number; count: number };
export type CrossCells = Record<Col, CrossCell>;
export type CrossRow = { category: string | null; cells: CrossCells };
export type Cross = { rows: CrossRow[]; total: CrossCells };
const emptyCells = (): CrossCells => ({ all: { amount: 0, count: 0 }, business: { amount: 0, count: 0 }, private: { amount: 0, count: 0 }, unset: { amount: 0, count: 0 } });

// 行 = カテゴリ（台帳の順 + 未分類最後。side の金額がある行だけ）、列 = 事業 / 私用 / 未設定 / 計。セルは side の金額と件数。
export function crossTable(rows: readonly Row[], side: Side, cats: Categories | null = null): Cross {
  const m = new Map<string | null, CrossCells>();
  const total = emptyCells();
  for (const r of rows) {
    if (r[side] <= 0) continue;
    let c = m.get(r.category);
    if (!c) m.set(r.category, (c = emptyCells()));
    for (const col of ['all', r.tag] as const) {
      c[col].amount += r[side];
      c[col].count += r[countKey(side)];
      total[col].amount += r[side];
      total[col].count += r[countKey(side)];
    }
  }
  return { rows: [...m].sort(([a], [b]) => categoryRank(cats, a) - categoryRank(cats, b)).map(([category, cells]) => ({ category, cells })), total };
}
// 列の中での割合（%、小数 1 桁）。
export const share = (v: number, total: number) => (total > 0 ? Math.round((v / total) * 1000) / 10 : 0);

// ---- ドリルダウン ----

// 選んだ所: 期間（start）と、カテゴリ（undefined = 全部、null = 未分類）・タグ（undefined = 全部）。
export type Pick = { start: string; category?: string | null; tag?: Tag };
export const samePick = (a: Pick | null, b: Pick | null) => !!a && !!b && a.start === b.start && a.category === b.category && a.tag === b.tag;

// 期間の日付（YYYY-MM-DD）。最後の月の末日まで。
export function pickRange(span: Span, start: string): { from: string; to: string } {
  const last = addMonth(start, SPAN_MONTHS[span] - 1);
  return { from: `${start}-01`, to: periodRange('month', '', last).to! };
}

// GET /api/bank_txns の URL（振替などの除外を外す = 集計と同じ明細）。
export function drillUrl(span: Span, p: Pick, side: Side, cursor: string | null, limit = TXN_PAGE): string {
  const r = pickRange(span, p.start);
  const q = new URLSearchParams({ from: r.from, to: r.to, side, excluded: '0', limit: String(limit) });
  if (p.category !== undefined) q.set('category', p.category ?? UNCATEGORIZED_QUERY);
  if (p.tag) q.set('tag', p.tag);
  if (cursor) q.set('cursor', cursor);
  return `/api/bank_txns?${q.toString()}`;
}

// ドリルダウンの読み込みに失敗したときの状態。「もっと見る」（cursor あり）の失敗は読んだ分と cursor を残し、もう一度押せるようにする。
export function drillFailed<T>(prev: { items: T[] } | null, cursor: string | null, msg: string): { items: T[]; more: boolean; loading: false; msg: string; cursor: string | null } {
  return { items: cursor ? (prev?.items ?? []) : [], more: cursor !== null, loading: false, msg, cursor };
}

// 選んだ所の金額と件数（集計の値。一覧の合計と一致する）。
export function pickCell(rows: readonly Row[], p: Pick, side: Side): CrossCell {
  let amount = 0;
  let count = 0;
  for (const r of rows) {
    if (r[side] <= 0) continue;
    if (p.tag && r.tag !== p.tag) continue;
    if (p.category !== undefined && r.category !== p.category) continue;
    amount += r[side];
    count += r[countKey(side)];
  }
  return { amount, count };
}

// 明細の画面へ同じ絞り込みで移るときの初期値（月は period=month、四半期・年は period=range）。
export function txnsFilter(span: Span, p: Pick, side: Side): Partial<TxnFilter> {
  const period: Partial<TxnFilter> = span === 'month' ? { period: 'month', month: p.start } : { period: 'range', range: pickRange(span, p.start), rangeLabel: periodLabel(span, p.start) };
  return {
    ...period,
    tag: p.tag ?? '',
    category: p.category === undefined ? '' : (p.category ?? UNCATEGORIZED_QUERY),
    side,
    excluded: '0',
    pillLabel: `分析 · ${SIDE_LABELS[side]}`,
  };
}
