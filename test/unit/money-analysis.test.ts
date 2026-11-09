// 分析の画面（#74。pwa/src/money/analysis/）。純関数（期間の束ね・「（一部）」・合計・推移の棒・クロス表・ドリルダウンの URL・色）と、
// 描画だけの部品の SSR スナップショット（wide=false / true の 2 通り。スマホのクロス表は 4 つの切替それぞれで PC の 4 列と同じ値）。
// スナップショットは money-analysis.test.ts.snapshot。描画を変えたら `node --test --test-update-snapshots test/unit/money-analysis.test.ts` で作り直して差分を見る。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import type { ViteDevServer } from 'vite';
import {
  COLS,
  COL_LABELS,
  crossTable,
  drillUrl,
  fetchRange,
  MAX_FETCH_MONTHS,
  monthCount,
  periodLabel,
  periodMonths,
  periodStart,
  pickCell,
  shiftPeriod,
  slice,
  totals,
  trend,
  trendStarts,
  txnsFilter,
  type Col,
  type Span,
} from '../../pwa/src/money/analysis/aggregate.ts';
import { categoryColor, categoryRank, CATEGORY_ORDER } from '../../pwa/src/money/analysis/colors.ts';
import { addMonth, txnsUrl, emptyFilter, type Categories, type MonthlySummary, type Tag, type Txn } from '../../pwa/src/money/model.ts';
import { lines, pretty, renderHtml, startSsr } from './pwa-ssr-helpers.ts';

process.env.TZ = 'Asia/Tokyo';
const TODAY = '2026-11-06';
const noop = () => {};

const cats: Categories = {
  items: [
    { id: 'food', label: '食費' },
    { id: 'daily', label: '日用品' },
    { id: 'telecom', label: '通信' },
    { id: 'tax', label: '税金' },
  ],
  uncategorized_label: '未分類',
};

type R = [Tag, string | null, number, number, number, number]; // tag, category, income, expense, income_count, expense_count
// by_tag_category から by_category・by_tag・total も作る（サーバーと同じ等式が成り立つ形）。
function summary(month: string, rs: R[]): MonthlySummary {
  const rows = rs.map(([tag, category, income, expense, income_count, expense_count]) => ({ tag, category, income, expense, income_count, expense_count }));
  const sum = (xs: typeof rows) =>
    xs.reduce((a, x) => ({ income: a.income + x.income, expense: a.expense + x.expense, income_count: a.income_count + x.income_count, expense_count: a.expense_count + x.expense_count }), { income: 0, expense: 0, income_count: 0, expense_count: 0 });
  const catsIn = [...new Set(rows.map((r) => r.category))].sort((a, b) => categoryRank(a) - categoryRank(b));
  const t = sum(rows);
  return {
    month,
    by_account: [],
    by_category: catsIn.map((category) => ({ category, ...sum(rows.filter((r) => r.category === category)) })),
    by_tag: (['business', 'private', 'unset'] as const).map((tag) => ({ tag, ...sum(rows.filter((r) => r.tag === tag)) })),
    by_tag_category: rows,
    total: { ...t, net: t.income - t.expense },
    excluded: [],
  };
}

// 2025-12〜2026-11 の 12 か月。毎月同じ形で、11 月だけ多い。
const base: R[] = [
  ['business', 'telecom', 0, 2000, 0, 1],
  ['business', null, 300000, 10000, 1, 1],
  ['private', 'food', 0, 40000, 0, 12],
  ['private', 'daily', 0, 8000, 0, 3],
  ['private', null, 0, 5000, 0, 2],
  ['unset', 'food', 0, 3000, 0, 1],
  ['unset', null, 0, 1000, 0, 1],
];
const nov: R[] = [...base, ['private', 'tax', 0, 98000, 0, 1], ['private', 'food', 1000, 2000, 1, 1]];
const months12 = Array.from({ length: 12 }, (_, i) => addMonth('2025-12', i));
const ms: MonthlySummary[] = months12.map((m) => summary(m, m === '2026-11' ? nov : base));

describe('分析の純関数（aggregate.ts）', () => {
  test('期間の最初の月・ラベル・前後（四半期は 1〜3・4〜6・7〜9・10〜12 月、年は暦年）', () => {
    assert.equal(periodStart('month', '2026-11'), '2026-11');
    assert.deepEqual(['2026-01', '2026-03', '2026-04', '2026-09', '2026-10', '2026-12'].map((m) => periodStart('quarter', m)), ['2026-01', '2026-01', '2026-04', '2026-07', '2026-10', '2026-10']);
    assert.equal(periodStart('year', '2026-11'), '2026-01');
    assert.deepEqual(periodMonths('quarter', '2026-10'), ['2026-10', '2026-11', '2026-12']);
    assert.equal(periodMonths('year', '2026-01').length, 12);
    assert.equal(shiftPeriod('quarter', '2026-01', -1), '2025-10');
    assert.equal(shiftPeriod('year', '2026-01', 1), '2027-01');
    assert.deepEqual([periodLabel('month', '2026-11'), periodLabel('quarter', '2026-10'), periodLabel('year', '2026-01')], ['2026 年 11 月', '2026 年 10〜12 月', '2026 年']);
  });

  test('読む範囲: 推移 12 本分（年は 3 本）、今月より先は読まない。どれも 36 か月以内', () => {
    assert.deepEqual(fetchRange('month', '2026-11', TODAY), { from: '2025-12', to: '2026-11' });
    assert.deepEqual(fetchRange('quarter', '2026-10', TODAY), { from: '2024-01', to: '2026-11' });
    assert.deepEqual(fetchRange('year', '2026-01', TODAY), { from: '2024-01', to: '2026-11' });
    assert.deepEqual(fetchRange('quarter', '2025-07', TODAY), { from: '2022-10', to: '2025-09' });
    assert.deepEqual(fetchRange('year', '2025-01', TODAY), { from: '2023-01', to: '2025-12' });
    for (const span of ['month', 'quarter', 'year'] as Span[]) {
      for (const b of ['2026-01', '2026-11', '2025-07']) {
        const r = fetchRange(span, periodStart(span, b), TODAY);
        assert.ok(monthCount(r.from, r.to) <= MAX_FETCH_MONTHS, `${span} ${b}`);
      }
    }
    assert.deepEqual(trendStarts('year', '2026-01'), ['2024-01', '2025-01', '2026-01']);
    assert.equal(trendStarts('quarter', '2026-10')[0], '2024-01');
  });

  test('束ね: 月 / 四半期 / 年。月をまたいで足し、並びは tag → カテゴリの固定順 → 未分類最後。端で月が欠けたら「（一部）」', () => {
    const m = slice(ms, 'month', '2026-11');
    assert.equal(m.label, '2026 年 11 月');
    assert.equal(m.partial, false);
    assert.deepEqual(m.rows.map((r) => [r.tag, r.category]), [
      ['business', 'telecom'],
      ['business', null],
      ['private', 'food'],
      ['private', 'daily'],
      ['private', 'tax'],
      ['private', null],
      ['unset', 'food'],
      ['unset', null],
    ]);
    const q = slice(ms, 'quarter', '2026-07');
    assert.equal(q.partial, false);
    assert.deepEqual(q.rows.find((r) => r.tag === 'private' && r.category === 'food'), { tag: 'private', category: 'food', income: 0, expense: 120000, income_count: 0, expense_count: 36 });
    // 10〜12 月は 12 月が無い。2025 年は 12 月だけ。
    assert.equal(slice(ms, 'quarter', '2026-10').label, '2026 年 10〜12 月（一部）');
    assert.equal(slice(ms, 'year', '2025-01').label, '2025 年（一部）');
    assert.equal(slice(ms, 'year', '2026-01').label, '2026 年（一部）');
    const y = slice(ms, 'year', '2026-01');
    assert.equal(totals(y.rows).expense, 10 * 69000 + 169000);
    // by_tag_category の無い古いサーバーの月は空
    assert.deepEqual(slice([{ ...ms[0]!, by_tag_category: undefined }], 'month', '2025-12').rows, []);
  });

  test('合計（収入・支出・差額・件数）とタグの絞り込み', () => {
    const s = slice(ms, 'month', '2026-11');
    assert.deepEqual(totals(s.rows), { income: 301000, expense: 169000, income_count: 2, expense_count: 23, net: 132000 });
    assert.deepEqual(totals(s.rows, 'business'), { income: 300000, expense: 12000, income_count: 1, expense_count: 2, net: 288000 });
    // 月次集計の total と一致
    const t = ms.at(-1)!.total;
    assert.deepEqual(totals(s.rows), { income: t.income, expense: t.expense, income_count: t.income_count, expense_count: t.expense_count, net: t.net });
  });

  test('推移の棒: 期間ごとのカテゴリの積み上げ（向き・タグに従う）', () => {
    const bars = trend(ms, 'month', '2026-11', 'expense');
    assert.equal(bars.length, 12);
    assert.deepEqual(bars.map((b) => b.start), months12.map((m) => m));
    const last = bars.at(-1)!;
    assert.deepEqual(last.segs.map((s) => s.category), ['food', 'daily', 'telecom', 'tax', null]);
    assert.equal(last.amount, 169000);
    assert.equal(last.count, 23, '件数は向きに合ったほう（出金の件数）');
    assert.equal(trend(ms, 'month', '2026-11', 'income').at(-1)!.count, 2);
    assert.equal(last.segs.find((s) => s.category === 'food')!.amount, 45000);
    assert.deepEqual([bars[0]!.yearMark, bars[1]!.yearMark, bars[2]!.yearMark], ['2025', '2026', null]);
    assert.deepEqual(trend(ms, 'month', '2026-11', 'income').at(-1)!.segs, [{ category: 'food', amount: 1000 }, { category: null, amount: 300000 }]);
    assert.equal(trend(ms, 'month', '2026-11', 'expense', 'unset').at(-1)!.amount, 4000);
    const q = trend(ms, 'quarter', '2026-10', 'expense');
    assert.equal(q.length, 12);
    assert.equal(q.filter((b) => b.amount > 0).length, 5, 'データのあるのは 2025 年 10〜12 月（12 月だけ）と 2026 年の各四半期');
    assert.deepEqual(q.slice(-5).map((b) => [b.short, b.partial]), [['10-12月', true], ['1-3月', false], ['4-6月', false], ['7-9月', false], ['10-12月', true]]);
    const y = trend(ms, 'year', '2026-01', 'expense');
    assert.deepEqual(y.map((b) => [b.short, b.partial, b.amount]), [['2024年', true, 0], ['2025年', true, 69000], ['2026年', true, 10 * 69000 + 169000]]);
  });

  test('クロス表: 行 = カテゴリ（固定順 + 未分類最後）、列 = 事業 / 私用 / 未設定 / 計。行・列の合計が一致', () => {
    const s = slice(ms, 'month', '2026-11');
    const c = crossTable(s.rows, 'expense');
    assert.deepEqual(c.rows.map((r) => r.category), ['food', 'daily', 'telecom', 'tax', null]);
    for (const r of c.rows) {
      assert.equal(r.cells.all.amount, r.cells.business.amount + r.cells.private.amount + r.cells.unset.amount, `${r.category}`);
      assert.equal(r.cells.all.count, r.cells.business.count + r.cells.private.count + r.cells.unset.count, `${r.category}`);
    }
    for (const k of COLS) {
      assert.equal(c.total[k].amount, c.rows.reduce((a, r) => a + r.cells[k].amount, 0), k);
      assert.equal(c.total[k].count, c.rows.reduce((a, r) => a + r.cells[k].count, 0), k);
    }
    assert.equal(c.total.all.amount, totals(s.rows).expense);
    assert.deepEqual(c.rows[0]!.cells, { all: { amount: 45000, count: 14 }, business: { amount: 0, count: 0 }, private: { amount: 42000, count: 13 }, unset: { amount: 3000, count: 1 } });
    // 収入の向き: 収入のある行だけ
    const inc = crossTable(s.rows, 'income');
    assert.deepEqual(inc.rows.map((r) => r.category), ['food', null]);
    assert.deepEqual(inc.total.all, { amount: 301000, count: 2 }, '収入の向きは入金の件数');
  });

  test('ドリルダウン: 一覧の URL（excluded=0・未分類は none）、セルの値、明細で開くときの絞り込み', () => {
    assert.equal(drillUrl('month', { start: '2026-11', category: 'food', tag: 'private' }, 'expense', null), '/api/bank_txns?from=2026-11-01&to=2026-11-30&side=expense&excluded=0&limit=50&category=food&tag=private');
    assert.equal(drillUrl('quarter', { start: '2026-01', category: null }, 'income', 'CUR'), '/api/bank_txns?from=2026-01-01&to=2026-03-31&side=income&excluded=0&limit=50&category=none&cursor=CUR');
    assert.equal(drillUrl('year', { start: '2024-01' }, 'expense', null), '/api/bank_txns?from=2024-01-01&to=2024-12-31&side=expense&excluded=0&limit=50');
    const s = slice(ms, 'month', '2026-11');
    assert.deepEqual(pickCell(s.rows, { start: '2026-11', category: 'food' }, 'expense'), { amount: 45000, count: 14 });
    assert.deepEqual(pickCell(s.rows, { start: '2026-11', tag: 'unset' }, 'expense'), { amount: 4000, count: 2 });
    const m = txnsFilter('month', { start: '2026-11', category: null, tag: 'business' }, 'expense');
    assert.deepEqual(m, { period: 'month', month: '2026-11', tag: 'business', category: 'none', side: 'expense', excluded: '0', pillLabel: '分析 · 支出' });
    const q = txnsFilter('quarter', { start: '2026-07', category: 'food' }, 'income');
    assert.deepEqual(q, { period: 'range', range: { from: '2026-07-01', to: '2026-09-30' }, rangeLabel: '2026 年 7〜9 月', tag: '', category: 'food', side: 'income', excluded: '0', pillLabel: '分析 · 収入' });
    // 明細の画面の URL も同じ期間・絞り込みになる
    assert.equal(txnsUrl({ ...emptyFilter(), ...q }, TODAY, null), '/api/bank_txns?limit=50&from=2026-07-01&to=2026-09-30&category=food&side=income&excluded=0');
  });

  test('色: 固定 13 種の順で k-0〜k-11（13 番目は k-0）、未分類と知らないカテゴリは k-none', () => {
    assert.equal(CATEGORY_ORDER.length, 13);
    assert.deepEqual(CATEGORY_ORDER.map(categoryColor), ['k-0', 'k-1', 'k-2', 'k-3', 'k-4', 'k-5', 'k-6', 'k-7', 'k-8', 'k-9', 'k-10', 'k-11', 'k-0']);
    assert.equal(categoryColor(null), 'k-none');
    assert.equal(categoryColor('unknown'), 'k-none');
    assert.ok(categoryRank('other') < categoryRank('unknown') && categoryRank('unknown') < categoryRank(null));
  });
});

const txn = (over: Partial<Txn> = {}): Txn => ({
  id: 'T1',
  account_id: 'A1',
  account_name: 'テスト銀行 普通',
  txn_date: '2026-11-05',
  amount: 2000,
  side: 'expense',
  description: 'テストストア',
  balance: null,
  tag: 'private',
  category: 'food',
  tag_source: 'override',
  excluded: false,
  transfer_kind: null,
  ...over,
});

describe('SSR スナップショット（分析）', () => {
  let vite: ViteDevServer;
  const load = (p: string) => vite.ssrLoadModule(p) as Promise<Record<string, (props: any) => unknown>>;
  before(async () => {
    vite = await startSsr();
  });
  after(async () => {
    await vite.close();
  });
  const html = (c: (props: never) => unknown, props: object) => pretty(renderHtml(h(c as never, props as never)));
  const s = slice(ms, 'month', '2026-11');
  const cross = crossTable(s.rows, 'expense');
  const bars = trend(ms, 'month', '2026-11', 'expense');
  // aria-label の「カテゴリ 列 金額 円 n 件」を取り出す。
  const cellsOf = (out: string) => [...out.matchAll(/aria-label="(\S+) (計|事業|私用|未設定) ([\d,]+) 円 (\d+) 件[ 。]/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}|${m[4]}`);

  test('クロス表: PC は 4 列の表、スマホは 4 つの切替それぞれで PC の列と同じ値', async (t) => {
    const m = await load('/src/money/analysis/parts.tsx');
    const props = { cross, start: '2026-11', side: 'expense', cats, col: 'all', selected: null, onCol: noop, onPick: noop };
    const pc = html(m.CrossTable!, { ...props, wide: true });
    assert.match(pc, /<table class="m-an-table">/);
    assert.match(pc, /<th scope="col">事業<\/th><th scope="col">私用<\/th><th scope="col">未設定<\/th><th scope="col">計<\/th>/);
    const pcCells = cellsOf(pc);
    assert.equal(pcCells.length, cross.rows.reduce((n, r) => n + COLS.filter((k) => r.cells[k].amount > 0).length, 0) + COLS.filter((k) => cross.total[k].amount > 0).length);
    const phones: string[] = [];
    for (const col of COLS as readonly Col[]) {
      const phone = html(m.CrossTable!, { ...props, col, wide: false });
      phones.push(phone);
      assert.match(phone, new RegExp(`<button type="button" aria-pressed="true">${COL_LABELS[col]}</button>`));
      const want = pcCells.filter((c) => c.split('|')[1] === COL_LABELS[col]);
      assert.deepEqual(cellsOf(phone), want, `${COL_LABELS[col]}の列`);
      assert.ok(want.length > 0);
    }
    assert.ok(pc.includes('>45,000<') && pc.includes('>14 件<'));
    t.assert.snapshot(lines([pc, ...phones].join('\n')));
  });

  test('合計・推移・ドリルダウン（AnalysisView。wide=false / true）。同じ値が出る', async (t) => {
    const m = await load('/src/money/analysis/parts.tsx');
    const pick = { start: '2026-11', category: 'food', tag: 'private' as const };
    const drill = {
      items: [txn({ id: 'D1', amount: 1200 }), txn({ id: 'D2', txn_date: '2026-11-02', amount: 800, description: 'テストマート' })],
      more: true,
      loading: false,
      msg: '',
    };
    const props = {
      today: TODAY,
      span: 'month',
      start: '2026-11',
      label: s.label,
      canNext: false,
      side: 'expense',
      tag: '',
      col: 'all',
      cats,
      view: { totals: totals(s.rows), bars, cross },
      msg: '',
      pick,
      pickTitle: '2026 年 11 月 · 食費 · 私用 · 支出',
      pickCell: pickCell(s.rows, pick, 'expense'),
      drill,
      filterOpen: false,
      onSpan: noop,
      onShift: noop,
      onSide: noop,
      onTag: noop,
      onCol: noop,
      onPick: noop,
      onBar: noop,
      onMore: noop,
      onTxns: noop,
      onFilter: noop,
    };
    const phone = html(m.AnalysisView!, { ...props, wide: false });
    const pc = html(m.AnalysisView!, { ...props, wide: true });
    for (const out of [phone, pc]) {
      for (const v of ['>301,000<', '>169,000<', '>132,000<', '支出 23 件', '>−1,200<', '>−800<', '>42,000<', '集計 13 件', '明細で開く', 'もっと見る', '2026 年 11 月 · 食費 · 私用 · 支出']) assert.ok(out.includes(v), v);
      assert.equal((out.match(/role="button"/g) ?? []).length, 12, '推移の棒 12 本が押せる');
    }
    assert.match(pc, /class="m-an-cols"/);
    assert.match(pc, /class="m-card m-pad12 m-gap8 m-an-drill"/);
    assert.doesNotMatch(pc, /m-sheet/);
    assert.match(phone, /<div class="m-an-band">/);
    assert.match(phone, /<div class="m-an-scroll"><svg class="m-svg m-an-trend"/);
    assert.match(phone, /class="m-sheet" role="dialog" aria-modal="true" aria-labelledby="m-an-drill"/);
    const filter = html(m.AnalysisView!, { ...props, wide: false, pick: null, drill: null, pickCell: null, pickTitle: null, filterOpen: true });
    assert.match(filter, /aria-labelledby="m-an-filter"/);
    assert.match(filter, /aria-label="向き"/);
    const pcEmpty = html(m.AnalysisView!, { ...props, wide: true, pick: null, drill: null, pickCell: null, pickTitle: null });
    assert.match(pcEmpty, /推移の棒か表のセルを押すと、ここに明細が出ます。/);
    t.assert.snapshot(lines([phone, pc, filter, pcEmpty].join('\n')));
  });
});
