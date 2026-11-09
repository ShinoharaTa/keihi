// PWA の「お金」タブ（docs/mvp-plan-v3.md T111・T304。UI はモック 7 画面）。純関数（グラフの座標・年の折りたたみ・帯の配分・結論の文など）と、
// 各画面の描画だけの部品の SSR スナップショット。
// スナップショットは money-pwa.test.ts.snapshot。描画を変えたら `node --test --test-update-snapshots test/unit/money-pwa.test.ts` で作り直して差分を見る。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import type { ViteDevServer } from 'vite';
import { areaPoints, gapLineChart, lineChart, niceTicks, pairBars, pct, spans, stackBars, xAt, yScale, type Plot } from '../../pwa/src/money/chart.ts';
import {
  accountPatch,
  addMonth,
  applyMatches,
  applyRuleLocally,
  applyTag,
  balanceSeries,
  candidateName,
  candidateNext,
  candidateRange,
  categoriesFor,
  cardUsage,
  ctaxReasonText,
  ctaxRowLabel,
  categoryRows,
  countLabel,
  dateShort,
  emptySimForm,
  bestRow,
  marginalText,
  parseMan,
  seedSimForm,
  simAmountRows,
  simCompareRows,
  simMan,
  simNotices,
  simPct,
  simWarningText,
  stepMan,
  taxSimBody,
  toManInput,
  dayLabel,
  dayOfMonth,
  daysBetween,
  docLine,
  draftBody,
  draftOf,
  draftError,
  emptyDraft,
  expenseFilterText,
  expensesUrl,
  expensesYear,
  expenseVendors,
  failText,
  filterCount,
  flatIncome,
  groupByDate,
  guessCategory,
  heavyMonths,
  incomeAhead,
  incomePct,
  itemInfoMap,
  lastOccurrence,
  linkedText,
  MAIL_ATTENTION_URL,
  mailAttachmentText,
  mailAttention,
  mailAttentionText,
  mailHintText,
  mailStateText,
  mailSyncText,
  ledgerRows,
  man,
  markSize,
  monthlyFixed,
  monthlyLine,
  monthlyRangeUrl,
  monthMarks,
  nextDueMap,
  nextTag,
  nextUnset,
  needsSettlement,
  noIncome,
  notableDiff,
  notices,
  occurrenceCount,
  overviewFallback,
  pageCount,
  parseAmount,
  parseYen,
  peakMonths,
  receiptMark,
  periodRange,
  periodText,
  RECURRENCES,
  runText,
  settlementChoices,
  shortTime,
  signedMan,
  spendBand,
  syncErrorCount,
  syncText,
  tagShares,
  taxCardLine,
  taxIncome,
  taxProfileBody,
  taxProfileDraft,
  taxSaveBody,
  taxWarningText,
  taxYearBodies,
  taxYearDrafts,
  toggleUnset,
  tokyoDate,
  txnIncome,
  txnSummary,
  txnsUrl,
  unsetPosition,
  vendorFilter,
  verdict,
  waitingText,
  warningText,
  yearGroups,
  yearSummary,
  yen,
  type Account,
  type BankStatus,
  type Candidate,
  type Categories,
  type DocBrief,
  type Expenses,
  type ExpenseVendor,
  type Forecast,
  type Matches,
  type ForecastMonth,
  type MailMessage,
  type MailStatus,
  type MonthlySummary,
  type Overview,
  type ScheduledItem,
  type CtaxCompareRow,
  type TaxProfileResponse,
  type TaxSimResponse,
  type TaxYear,
  type Txn,
  type Upcoming,
} from '../../pwa/src/money/model.ts';
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
    { id: 'car', label: '車' },
  ],
  uncategorized_label: '未分類',
};

const account = (over: Partial<Account> = {}): Account => ({
  id: 'A1',
  name: '三井住友 普通',
  kind: 'bank',
  source: 'freee',
  default_tag: 'unset',
  mcp_visibility: 'summary',
  include_in_cashflow: true,
  card_settlement_account_id: null,
  card_settlement_pattern: null,
  active: true,
  sync_status: null,
  latest_balance: { as_of_date: '2026-11-05', balance: 1234567, source: 'freee_walletable' },
  ...over,
});
const card = account({ id: 'C1', name: '楽天カード', kind: 'card', latest_balance: { as_of_date: '2026-11-05', balance: -294061, source: 'freee_walletable' }, card_settlement_account_id: 'A1', card_settlement_pattern: 'ラクテンカード' });
const bareCard = account({ id: 'C2', name: 'PayPay カード', kind: 'card', latest_balance: null });
const wallet = account({ id: 'W1', name: 'PayPay', kind: 'paypay', source: 'csv', include_in_cashflow: false, default_tag: 'private', mcp_visibility: 'none', latest_balance: { as_of_date: '2026-10-20', balance: 3000, source: 'manual' } });

const txn = (over: Partial<Txn> = {}): Txn => ({
  id: 'T1',
  account_id: 'A1',
  account_name: '三井住友 普通',
  txn_date: '2026-11-05',
  amount: 1980,
  side: 'expense',
  description: 'ドコモ ご利用料金',
  balance: null,
  tag: 'business',
  category: 'telecom',
  tag_source: 'rule',
  excluded: false,
  transfer_kind: null,
  ...over,
});

const fmonth = (month: string, over: Partial<ForecastMonth> = {}): ForecastMonth => ({
  month,
  planned_in: 500000,
  planned_out: 20000,
  unplanned_in: 0,
  unplanned_out: 400000,
  balance_end: 1000000,
  reserve: 300000,
  margin: 700000,
  items: [],
  ...over,
});
const months36 = (fn: (i: number, month: string) => Partial<ForecastMonth> = () => ({})) => Array.from({ length: 36 }, (_, i) => fmonth(addMonth('2026-11', i), fn(i, addMonth('2026-11', i))));

const scheduled = (over: Partial<ScheduledItem> = {}): ScheduledItem => ({
  id: 'S1',
  name: '自動車税',
  amount: 39500,
  direction: 'out',
  category: 'car',
  account_id: null,
  recurrence: 'yearly',
  anchor_date: '2026-05-31',
  end_date: null,
  notify_days_before: 14,
  origin: 'manual',
  active: 1,
  ...over,
});
const up = (it: ScheduledItem, due_date: string): Upcoming => ({ ...it, due_date });

const forecast: Forecast = {
  as_of: TODAY,
  opening_balance: 1234567,
  reserve: 300000,
  unplanned_out_per_month: 180000,
  unplanned_in_per_month: 0,
  months: [
    fmonth('2026-11', { planned_in: 0, planned_out: 39500, unplanned_out: 140000, balance_end: 1055067, margin: 755067, items: [{ id: 'S1', name: '自動車税', amount: 39500, direction: 'out', due: '2026-11-30' }] }),
    fmonth('2026-12', { planned_out: 0, unplanned_out: 180000, balance_end: 1375067, margin: 1075067, items: [{ id: 'S4', name: '売上', amount: 500000, direction: 'in', due: '2026-12-25' }] }),
    fmonth('2027-01', { planned_in: 0, planned_out: 1500000, unplanned_out: 180000, balance_end: -304933, reserve: 0, margin: -304933, items: [{ id: 'S2', name: '所得税（予定納税）', amount: 1500000, direction: 'out', due: '2027-01-31' }] }),
  ],
  first_shortfall_month: '2027-01',
  warnings: [
    { kind: 'stale_balance', account_id: 'W1', as_of_date: '2026-10-20' },
    { kind: 'short_history', months_available: 2 },
  ],
  cut_per_month_to_survive: 13200,
};

const monthlyEmpty = (month: string): MonthlySummary => ({ month, by_account: [], by_category: [], by_tag: [], total: { income: 0, expense: 0, net: 0 }, excluded: [] });
const monthly = (month: string, income: number, expense: number, tax = 10000): MonthlySummary => ({
  month,
  by_account: [],
  by_category: [
    { category: 'telecom', income: 0, expense: 1980 },
    { category: 'tax', income: 0, expense: tax },
    { category: null, income, expense: expense - 1980 - tax },
  ],
  by_tag: [
    { tag: 'business', income, expense: 1980 + tax },
    { tag: 'private', income: 0, expense: 3000 },
    { tag: 'unset', income: 0, expense: expense - 1980 - tax - 3000 },
  ],
  total: { income, expense, net: income - expense },
  excluded: [
    { kind: 'card_settlement', count: 1, income: 0, expense: 294061 },
    { kind: 'transfer', count: 3, income: 200000, expense: 200000 },
  ],
});

const P: Plot = { w: 100, h: 60, l: 10, r: 10, t: 10, b: 10 };

describe('グラフの座標（chart.ts）', () => {
  test('目盛りは 0 を含み 1・2・2.5・5 の刻み', () => {
    assert.deepEqual(niceTicks(950000, 1500000), [0, 500000, 1000000, 1500000]);
    assert.deepEqual(niceTicks(-17839, 1340000), [-500000, 0, 500000, 1000000, 1500000]);
    assert.deepEqual(niceTicks(0, 0), [0, 2500, 5000, 7500, 10000]);
    assert.deepEqual(niceTicks(0, 2), [0, 1, 2], '刻みは最低 1 円で、重ならない');
    const t = niceTicks(0, 3, 8);
    assert.equal(new Set(t).size, t.length);
  });
  test('y は目盛りの最小が下端・最大が上端、x は等間隔（1 点なら真ん中）', () => {
    const y = yScale([0, 100], P);
    assert.equal(y(0), 50);
    assert.equal(y(100), 10);
    assert.equal(y(50), 30);
    assert.equal(xAt(0, 3, P), 10);
    assert.equal(xAt(2, 3, P), 90);
    assert.equal(xAt(0, 1, P), 50);
  });
  test('折れ線の点と、残す額の帯の面', () => {
    const c = lineChart([0, 50, 100], P, [], 2);
    assert.equal(c.points, '10,50 50,30 90,10');
    assert.equal(areaPoints(c.pts, 50), '10,50 50,30 90,10 90,50 10,50');
    assert.equal(areaPoints([], 50), '');
  });
  test('欠けた値のある折れ線: 欠けた所で線を切り、目盛りは値のある所だけ', () => {
    const c = gapLineChart([0, null, 100, 50], { w: 100, h: 60, l: 10, r: 0, t: 10, b: 10 }, [], 2);
    assert.deepEqual(c.segs, ['10,50', '70,10 100,30']);
    assert.equal(c.pts[1], null);
    assert.deepEqual(gapLineChart([null, null], P).segs, []);
  });
  test('足りない期間は続きをまとめ、左右は隣との中点まで（端は描画域で止める）', () => {
    assert.deepEqual(spans([false, true, true, false, true], P), [
      { x: 20, w: 40 },
      { x: 80, w: 10 },
    ]);
    assert.deepEqual(spans([false, false], P), []);
  });
  test('2 本並びの棒と積み上げの棒', () => {
    const g = pairBars([{ income: 100, expense: 50 }], { w: 100, h: 60, l: 0, r: 0, t: 10, b: 10 }, 10);
    assert.equal(g.bars[0]!.cx, 50);
    assert.deepEqual(g.bars[0]!.inc, { x: 39, y: 10, h: 40 });
    assert.deepEqual(g.bars[0]!.exp, { x: 51, y: 30, h: 20 });
    const s = stackBars([{ a: 30, b: 10 }, { a: 0, b: 0 }], ['a', 'b'] as const, { w: 100, h: 60, l: 0, r: 0, t: 10, b: 10 });
    assert.deepEqual(s[0]!.segs, [
      { key: 'a', y: 20, h: 30 },
      { key: 'b', y: 10, h: 10 },
    ]);
    assert.deepEqual(s[1]!.segs, []);
    assert.equal(pct(5, 0), 0);
    assert.equal(pct(150, 100), 100);
  });
});

describe('ホームの純関数', () => {
  test('万の表記（100 万以上は整数）', () => {
    assert.equal(man(1250000), '125万');
    assert.equal(man(132398), '13.2万');
    assert.equal(man(120000), '12万');
    assert.equal(man(-17839), '−1.8万');
    assert.equal(man(0), '0');
    assert.equal(man(2500), '2,500');
    assert.equal(man(-9999), '−9,999');
    assert.equal(man(10000), '1万');
    assert.equal(signedMan(68000), '+6.8万');
    assert.equal(signedMan(-65000), '−6.5万');
  });
  test('支出の帯は 済み / 予定の残り / 目安 で合計 100%。全部 0 なら 0', () => {
    const b = spendBand({ month: '2026-11', income: 0, expense: 212400, planned_out_remaining: 80300, unplanned_out_estimate: 512000, projected_end_balance: 0 });
    assert.equal(b.total, 804700);
    assert.deepEqual(b.pct, [26.4, 10, 63.6]);
    assert.deepEqual(spendBand({ month: '2026-11', income: 0, expense: 0, planned_out_remaining: 0, unplanned_out_estimate: 0, projected_end_balance: 0 }).pct, [0, 0, 0]);
    assert.equal(incomePct(0, 680000), 0);
    assert.equal(incomePct(700000, 680000), 100);
    assert.equal(incomePct(5, 0), 100);
  });
  test('今月の残りの予定収入と、いちばん早い入金', () => {
    const r = incomeAhead({ ...forecast, months: [fmonth('2026-11', { planned_in: 680000, items: [{ id: 'X', name: '売上', amount: 680000, direction: 'in', due: '2026-11-25' }] })] }, '2026-11');
    assert.equal(r.total, 680000);
    assert.equal(r.first?.due, '2026-11-25');
    assert.deepEqual(incomeAhead(null, '2026-11'), { total: 0, first: null });
  });
  test('overview が無いときの代わり: 資金繰りの起点残高 − 残す額、今月の行、引落元が未設定のカード', () => {
    const month = {
      ...monthly('2026-11', 0, 52000),
      by_account: [
        { account_id: 'A1', name: '三井住友 普通', include_in_cashflow: true, active: true, income: 1000, expense: 50000, net: -49000 },
        { account_id: 'W1', name: 'PayPay', include_in_cashflow: false, active: true, income: 0, expense: 2000, net: -2000 },
        { account_id: 'X9', name: '止めた口座', include_in_cashflow: true, active: false, income: 0, expense: 9999, net: -9999 },
      ],
    };
    const noPattern = account({ id: 'C3', name: 'イオンカード', kind: 'card', card_settlement_account_id: 'A1', card_settlement_pattern: null, latest_balance: null });
    const o = overviewFallback({ today: TODAY, accounts: [account(), card, bareCard, noPattern, wallet], cf: forecast, month, untagged: { n: 100, more: true }, candidates: 3, lastOkAt: '2026-11-06T00:12:00.000Z' })!;
    assert.deepEqual([o.untagged_count, o.untagged_more], [100, true]);
    assert.equal(o.available, 1234567 - 300000);
    assert.deepEqual(o.balances.by_account.map((a) => a.account_id), ['A1']);
    assert.deepEqual(o.cards_without_settlement, [
      { account_id: 'C2', name: 'PayPay カード' },
      { account_id: 'C3', name: 'イオンカード' },
    ], '引落元か摘要の文字のどちらかが空なら済んでいない');
    assert.deepEqual(o.this_month, { month: '2026-11', income: 1000, expense: 50000, planned_out_remaining: 39500, unplanned_out_estimate: 140000, projected_end_balance: 1055067 });
    assert.equal(overviewFallback({ today: TODAY, accounts: [], cf: null, month: null, untagged: { n: 0, more: false }, candidates: 0, lastOkAt: null }), null);
    assert.equal(needsSettlement(card), false);
    assert.equal(needsSettlement(noPattern), true);
    assert.equal(needsSettlement({ ...bareCard, active: false }), false);
    assert.equal(needsSettlement(account()), false);
  });
  test('一覧の件数は集計外を除き、上限まで返ったか次があれば返った件数に +', () => {
    const c = pageCount({ items: [txn({ tag: 'unset' }), txn({ id: 'x', tag: 'unset', excluded: true })], next_cursor: null }, 100);
    assert.deepEqual(c, { n: 1, more: false });
    assert.equal(countLabel(c), '1');
    assert.equal(countLabel(pageCount({ items: [], next_cursor: null }, 100)), '0');
    // 100 件中 1 件が集計外でも、上限まで返ってきたら 100+（99 件と出さない）。
    const full = Array.from({ length: 100 }, (_, i) => txn({ id: `F${i}`, tag: 'unset', excluded: i === 0 }));
    assert.equal(countLabel(pageCount({ items: full, next_cursor: null }, 100)), '100+');
    assert.equal(countLabel(pageCount({ items: full, next_cursor: 'n' }, 100)), '100+');
  });
  test('確認すること: 引落元 → 提案 → 未設定 → 収入なし', () => {
    const o = overviewFallback({ today: TODAY, accounts: [bareCard], cf: forecast, month: null, untagged: { n: 4, more: false }, candidates: 2, lastOkAt: null })!;
    assert.deepEqual(notices(o, forecast).map((n) => n.kind), ['card_settlement', 'candidates', 'untagged']);
    const none = { ...forecast, months: forecast.months.map((m) => ({ ...m, planned_in: 0 })) };
    assert.deepEqual(notices({ ...o, cards_without_settlement: [], open_candidates: 0, untagged_count: 0 }, none).map((n) => n.kind), ['no_income']);
  });
  test('月次の入口の文は目立つ差のカテゴリを添える', () => {
    const ms = [monthly('2026-09', 0, 100000), monthly('2026-10', 680000, 200000, 98000)];
    assert.equal(monthlyLine(ms, '2026-10', cats), '10 月の差額 480,000（税金が平均より多い）');
    assert.equal(monthlyLine([monthly('2026-10', 0, 100000)], '2026-10', cats), '10 月の差額 −100,000');
    assert.equal(monthlyLine(ms, '2026-08', cats), null);
    assert.equal(notableDiff({ expense: 98000, diff: 52000 }), true);
    assert.equal(notableDiff({ expense: 86400, diff: 9200 }), false);
    assert.equal(notableDiff({ expense: 6800, diff: 3500 }), false);
  });
  test('日付まわり・同期の時刻・エラー数・カードの未引落', () => {
    assert.deepEqual(dayOfMonth(TODAY), { day: 6, days: 30 });
    assert.deepEqual(dayOfMonth('2028-02-10'), { day: 10, days: 29 });
    assert.equal(daysBetween(TODAY, '2026-11-25'), 19);
    assert.equal(dateShort('2026-12-01', TODAY), '12/1');
    assert.equal(dateShort('2027-01-31', TODAY), '2027-01-31');
    assert.equal(shortTime('2026-11-06T00:12:00.000Z', TODAY), '今日 9:12');
    assert.equal(shortTime('2026-11-04T23:05:00.000Z', TODAY), '11/5 8:05');
    assert.equal(shortTime(null, TODAY), '—');
    assert.equal(syncErrorCount(['x', 'y']), 2);
    assert.equal(syncErrorCount(3), 3);
    assert.equal(syncErrorCount(null), 0);
    const nov = { ...monthlyEmpty('2026-11'), by_account: [{ account_id: 'C1', name: '楽天カード', include_in_cashflow: true, active: true, net: -36420, income: 0, expense: 36420 }] };
    assert.deepEqual(cardUsage([account(), card, bareCard, { ...card, id: 'C9', active: false }], nov), { C1: 36420, C2: 0 });
    assert.deepEqual(cardUsage([card], null), {});
  });
  test('残高の推移: 最初に残高がある月より前は落とし、全口座の残高が無い月は null', () => {
    const m = (month: string, total: number | null, by_account: Record<string, number | null>) => ({ month, total, by_account });
    assert.deepEqual(
      balanceSeries([m('2025-12', 0, { A1: 0 }), m('2026-01', 400000, { A1: 400000 }), m('2026-02', 0, { A1: null }), m('2026-03', null, {}), m('2026-04', 105000, { A1: 105000 })]),
      [
        { month: '2026-01', total: 400000 },
        { month: '2026-02', total: null },
        { month: '2026-03', total: null },
        { month: '2026-04', total: 105000 },
      ],
    );
    assert.deepEqual(balanceSeries([m('2026-01', -5000, { A1: 5000, A2: -10000 })]), [{ month: '2026-01', total: -5000 }], '負の合計も残高あり');
    assert.deepEqual(balanceSeries([m('2026-01', 0, { A1: 0 })]), []);
  });
  test('提案の表示名は正規化前の摘要（無ければ description_norm）', () => {
    assert.equal(candidateName(candidate), 'さくらインターネット');
    assert.equal(candidateName({ ...candidate, description: 'ｻｸﾗｲﾝﾀｰﾈｯﾄ（株）' }), 'ｻｸﾗｲﾝﾀｰﾈｯﾄ（株）');
  });
});

describe('見通しの純関数', () => {
  test('結論: 不足する月と、減らせば足りる額', () => {
    const v = verdict({ ...forecast, months: months36((i) => (i >= 24 ? { margin: -1000, balance_end: i === 35 ? -17839 : 100 } : {})), first_shortfall_month: '2028-11' });
    assert.equal(v.short, true);
    assert.equal(v.title, '2028-11 に残す額を下回ります');
    assert.equal(v.detail, 'このままだと 2029-10 に残高が −17,839 になります。');
    assert.equal(v.cut, '予定にない支出を月 13,200 円減らすと、3 年間は足ります。');
    const noCut = verdict({ ...forecast, months: months36((i) => (i >= 24 ? { margin: -1000 } : {})), first_shortfall_month: '2028-11', cut_per_month_to_survive: null });
    assert.equal(noCut.cut, null);
    assert.equal(noCut.detail, 'このままだと 2028-11 から残す額に足りません。');
  });
  test('結論: 足りるときは 3 年間足ります + 余裕のいちばん少ない月（min_month があればそれ）', () => {
    const ms = months36((i) => (i === 10 ? { margin: 47030 } : {}));
    const v = verdict({ ...forecast, months: ms, first_shortfall_month: null });
    assert.equal(v.short, false);
    assert.equal(v.title, '3 年間足ります');
    assert.match(v.detail, /2027-09（残す額を引いて 47,030）/);
    assert.match(verdict({ ...forecast, months: ms, first_shortfall_month: null, min_month: { month: '2028-09', balance_end: 1, margin: 5 } }).detail, /2028-09/);
    assert.equal(verdict({ ...forecast, first_shortfall_month: null }).title, '3 か月足ります');
  });
  test('年ごとの折りたたみ: 12 か月ずつ、足りない月の数と最低の余裕', () => {
    const gs = yearGroups(months36((i) => (i >= 24 ? { margin: -100 * (i - 23) } : i === 21 ? { margin: 47030 } : {})));
    assert.deepEqual(gs.map((g) => [g.from, g.to, g.shortCount]), [
      ['2026-11', '2027-10', 0],
      ['2027-11', '2028-10', 0],
      ['2028-11', '2029-10', 12],
    ]);
    assert.equal(yearSummary(gs[0]!), 'ずっと足りる · 最低の余裕 700,000（2026-11）');
    assert.equal(yearSummary(gs[1]!), 'ずっと足りる · 最低の余裕 47,030（2028-08）');
    assert.equal(yearSummary(gs[2]!), '12 か月とも残す額に足りない · 最大 −1,200（2029-10）');
    const part = yearGroups([fmonth('2026-11', { margin: -5 }), fmonth('2026-12')]);
    assert.equal(yearSummary(part[0]!), '1 か月残す額に足りない · 最大 −5（2026-11）');
  });
  test('税金・保険・車の印（毎月の分と収入は除く）、印の大きさ、毎月同じ収入', () => {
    const info = itemInfoMap([scheduled({ id: 'S1', category: 'car' }), scheduled({ id: 'S2', category: 'tax' }), scheduled({ id: 'S3', category: 'insurance', recurrence: 'monthly' })]);
    const ms = [fmonth('2026-11', { items: [{ id: 'S1', name: '自動車税', amount: 39500, direction: 'out', due: '2026-11-30' }, { id: 'S3', name: '生命保険', amount: 12300, direction: 'out', due: '2026-11-27' }] })];
    const mk = monthMarks(ms, info);
    assert.deepEqual([mk[0]!.car, mk[0]!.insurance, mk[0]!.names.length], [39500, 0, 1]);
    assert.deepEqual([markSize(0, 10), markSize(1, 10), markSize(5, 10), markSize(10, 10)], [0, 1, 2, 3]);
    assert.equal(flatIncome(months36()), 500000);
    assert.equal(flatIncome(forecast.months), null);
    assert.equal(noIncome(forecast), false);
  });
});

describe('予定の純関数', () => {
  test('12 か月の山は毎月の分と収入を除いて分類別に積む。重い月は最大の半分以上', () => {
    const tax = scheduled({ id: 'X1', name: '所得税', category: 'tax', amount: 132398 });
    const ins = scheduled({ id: 'X2', name: '国保', category: 'insurance', recurrence: 'quarterly', amount: 68000 });
    const life = scheduled({ id: 'X3', name: '生命保険', category: 'insurance', recurrence: 'monthly', amount: 12300 });
    const income = scheduled({ id: 'X4', name: '売上', direction: 'in', category: 'income', amount: 680000, recurrence: 'monthly' });
    const peaks = peakMonths([up(ins, '2026-11-30'), up(life, '2026-11-27'), up(income, '2026-11-25'), up(tax, '2027-03-15'), up(tax, '2027-11-15')], TODAY);
    assert.equal(peaks.length, 12);
    assert.deepEqual([peaks[0]!.month, peaks[0]!.insurance, peaks[0]!.total], ['2026-11', 68000, 68000]);
    assert.equal(peaks[4]!.tax, 132398);
    assert.equal(peaks[11]!.month, '2027-10');
    assert.deepEqual(heavyMonths(peaks), ['2026-11', '2027-03']);
    assert.deepEqual(heavyMonths(peakMonths([], TODAY)), []);
    assert.equal(monthlyFixed([life, income, scheduled({ id: 'X5', recurrence: 'monthly', amount: 5467, active: 0 })]), 12300);
  });
  test('台帳: 分類で絞り、次の期日順（期日なしは後ろ、停止中は最後）', () => {
    const items = [scheduled({ id: 'a', name: '車検' }), scheduled({ id: 'b', name: '生命保険', category: 'insurance' }), scheduled({ id: 'c', name: '止めた', active: 0 }), scheduled({ id: 'd', name: '期日なし' })];
    const due = { a: '2027-09-15', b: '2026-11-27' };
    assert.deepEqual(ledgerRows(items, due, '', false).map((x) => x.id), ['b', 'a', 'd']);
    assert.deepEqual(ledgerRows(items, due, '', true).map((x) => x.id), ['b', 'a', 'd', 'c']);
    assert.deepEqual(ledgerRows(items, due, 'insurance', true).map((x) => x.id), ['b']);
  });
  test('提案の次の見込み日（月末を超えたら月末）と回数。周期に 3 か月ごと', () => {
    const c = (interval: Candidate['interval'], dates: string[]) => ({ interval, occurrences_json: JSON.stringify(dates.map((date) => ({ date, amount: 1 }))) }) as Candidate;
    assert.equal(candidateNext(c('monthly', ['2026-09-15', '2026-10-15'])), '2026-11-15');
    assert.equal(candidateNext(c('monthly', ['2026-01-31'])), '2026-02-28');
    assert.equal(candidateNext(c('quarterly', ['2026-08-31'])), '2026-11-30');
    assert.equal(candidateNext(c('yearly', ['2025-12-10'])), '2026-12-10');
    assert.equal(candidateNext({ interval: 'monthly', occurrences_json: 'x' } as Candidate), null);
    assert.equal(occurrenceCount(c('monthly', ['2026-09-15', '2026-10-15'])), 2);
    assert.ok(RECURRENCES.includes('quarterly'));
  });
  test('積立: 摘要から推す、支出だけ選べる、山では その他 に寄せる。提案の金額の幅', () => {
    for (const d of ['テスト積立A', 'ﾂﾐﾀﾃ', 'テスト投信', 'テスト証券']) assert.equal(guessCategory(d), 'savings', d);
    assert.ok(categoriesFor('out').includes('savings'));
    assert.ok(!categoriesFor('out').includes('income'));
    assert.ok(!categoriesFor('in').includes('savings'));
    assert.ok(categoriesFor('in').includes('income'));
    const d = { ...emptyDraft(TODAY), name: 'テスト積立A', amount: '20000' };
    assert.equal(draftError({ ...d, direction: 'out', category: 'savings' }), null);
    assert.equal(draftError({ ...d, direction: 'in', category: 'savings' }), 'この分類はこの向きの予定には使えません。');
    assert.equal(draftError({ ...d, direction: 'out', category: 'income' }), 'この分類はこの向きの予定には使えません。');
    const sav = scheduled({ id: 'V1', name: 'テスト積立A', category: 'savings', recurrence: 'yearly', amount: 20000 });
    const peaks = peakMonths([up(sav, '2026-12-27')], TODAY);
    assert.deepEqual([peaks[1]!.other, peaks[1]!.total], [20000, 20000]);
    const json = (xs: unknown) => ({ occurrences_json: JSON.stringify(xs) }) as Candidate;
    assert.deepEqual(candidateRange(json([{ amount: 8000 }, { amount: 15000 }, { amount: 12300 }])), { min: 8000, max: 15000 });
    assert.equal(candidateRange(json([])), null);
    assert.equal(candidateRange({ occurrences_json: 'x' } as Candidate), null);
  });
});

describe('明細・月次の純関数', () => {
  test('日付ごとのまとまり（集計外は差額に入れない）と見出し', () => {
    const gs = groupByDate([txn({ id: 'a', txn_date: TODAY, amount: 1280 }), txn({ id: 'b', txn_date: TODAY, side: 'income', amount: 500 }), txn({ id: 'c', txn_date: '2026-11-05', amount: 10000, excluded: true })]);
    assert.deepEqual(gs.map((g) => [g.date, g.net, g.items.length]), [
      [TODAY, -780, 2],
      ['2026-11-05', 0, 1],
    ]);
    assert.equal(dayLabel(TODAY, TODAY), '11/6（金）今日');
    assert.equal(dayLabel('2026-11-04', TODAY), '11/4（水）');
  });
  test('右端のタグの切り替え・収入の合計・期間の表示', () => {
    assert.deepEqual([nextTag('business'), nextTag('private'), nextTag('unset')], ['private', 'business', 'business']);
    assert.equal(txnIncome([txn({ side: 'income', amount: 5 }), txn({ side: 'income', amount: 7, excluded: true }), txn()]), 5);
    assert.equal(periodText({ period: 'this', accountId: '', tag: '', category: '', q: '' }, TODAY), '11/1〜11/6');
    assert.equal(periodText({ period: 'all', accountId: '', tag: '', category: '', q: '' }, TODAY), '全期間');
  });
  test('ルール化は同じ口座・同じ摘要の未設定の行にも映す。未設定の中での位置', () => {
    const src = txn({ id: 'a', tag: 'unset', description: 'セブン-イレブン' });
    const xs = [src, txn({ id: 'b', tag: 'unset', description: 'セブン-イレブン' }), txn({ id: 'c', tag: 'unset', description: 'セブン-イレブン', account_id: 'W1' }), txn({ id: 'd', tag: 'private', description: 'セブン-イレブン' })];
    const out = applyRuleLocally(xs, src, 'business', 'food');
    assert.deepEqual(out.map((t) => t.tag), ['unset', 'business', 'unset', 'private']);
    assert.equal(out[1]!.tag_source, 'rule');
    assert.deepEqual(unsetPosition(xs, 'b'), { index: 2, total: 3 });
    assert.deepEqual(unsetPosition(xs, 'd'), { index: 0, total: 3 });
  });
  test('事業/私用/未設定の割合と、選んだ月で終わる 6 か月', () => {
    assert.deepEqual(tagShares(monthly('2026-10', 0, 100000)).map((s) => [s.tag, s.expense, s.pct]), [
      ['business', 11980, 12],
      ['private', 3000, 3],
      ['unset', 85020, 85],
    ]);
    assert.deepEqual(tagShares(monthlyEmpty('2026-10')).map((s) => s.pct), [0, 0, 0]);
    assert.equal(monthlyRangeUrl('2026-10'), '/api/summary/monthly?from=2026-05&to=2026-10');
  });
});

describe('前からある純関数', () => {
  test('yen は 3 桁区切りで、負は −', () => {
    assert.equal(yen(0), '0');
    assert.equal(yen(1234567), '1,234,567');
    assert.equal(yen(-980), '−980');
  });
  test('期間: 今月・先月・3 か月（今月を含む）・全部', () => {
    assert.deepEqual(periodRange('this', TODAY), { from: '2026-11-01', to: TODAY });
    assert.deepEqual(periodRange('last', TODAY), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(periodRange('last', '2026-03-10'), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(periodRange('three', '2026-01-15'), { from: '2025-11-01', to: '2026-01-15' });
    assert.deepEqual(periodRange('all', TODAY), {});
    assert.equal(addMonth('2026-01', -1), '2025-12');
    assert.equal(addMonth('2026-12', 1), '2027-01');
  });
  test('明細の URL: 絞り込み・未分類は none・空の検索語は送らない・cursor・件数', () => {
    const f = { period: 'this' as const, accountId: 'A1', tag: 'private' as const, category: 'none', q: '  ' };
    assert.equal(txnsUrl(f, TODAY, null), '/api/bank_txns?limit=50&from=2026-11-01&to=2026-11-06&account_id=A1&tag=private&category=none');
    assert.equal(txnsUrl({ period: 'all', accountId: '', tag: '', category: '', q: ' ドコモ ' }, TODAY, 'abc'), '/api/bank_txns?limit=50&q=%E3%83%89%E3%82%B3%E3%83%A2&cursor=abc');
    assert.equal(txnsUrl({ period: 'all', accountId: '', tag: 'unset', category: '', q: '' }, TODAY, null, 100), '/api/bank_txns?limit=100&tag=unset');
  });
  test('月を指定した期間・絞り込みの数・件数と支出の合計（集計外は数えない）', () => {
    const f = { period: 'month' as const, month: '2026-02', accountId: '', tag: '' as const, category: 'food', q: ' ' };
    assert.equal(txnsUrl(f, TODAY, null), '/api/bank_txns?limit=50&from=2026-02-01&to=2026-02-28&category=food');
    assert.equal(filterCount(f), 1);
    assert.deepEqual(txnSummary([txn(), txn({ id: 'T2', side: 'income', amount: 5 }), txn({ id: 'T3', amount: 100, excluded: true })]), { count: 3, expense: 1980 });
  });
  test('タグの保存結果（effective）で行を差し替える・次の未設定（集計外は飛ばす）', () => {
    const out = applyTag([txn(), txn({ id: 'T2' })], 'T2', { effective: { tag: 'private', category: null, source: 'override' } });
    assert.equal(out[0]!.tag, 'business');
    assert.deepEqual([out[1]!.tag, out[1]!.category, out[1]!.tag_source], ['private', null, 'override']);
    const xs = [txn({ id: 'a', tag: 'unset' }), txn({ id: 'b' }), txn({ id: 'c', tag: 'unset', excluded: true }), txn({ id: 'd', tag: 'unset' })];
    assert.equal(nextUnset(xs, 'b')?.id, 'd');
    assert.equal(nextUnset(xs, 'd'), null);
  });
  test('カテゴリ別は支出の大きい順で、取った月の平均との差（無い月は 0）', () => {
    const m = (month: string, rows: [string | null, number][]) => ({ ...monthlyEmpty(month), by_category: rows.map(([category, expense]) => ({ category, income: 0, expense })) });
    const rows = categoryRows([m('2026-10', [['food', 30000]]), m('2026-11', [['food', 50000], ['tax', 90000]])], '2026-11');
    assert.deepEqual(rows.map((r) => [r.category, r.diff]), [['tax', 45000], ['food', 10000]]);
  });
  test('候補の最後の出現と、台帳の次の期日', () => {
    const c = { occurrences_json: '[{"date":"2026-08-27","amount":1},{"date":"2026-10-27","amount":1},{"date":"2026-09-27","amount":1}]' } as Candidate;
    assert.equal(lastOccurrence(c), '2026-10-27');
    assert.equal(lastOccurrence({ occurrences_json: 'x' } as Candidate), null);
    assert.deepEqual(nextDueMap([{ id: 'a', due_date: '2026-11-10' }, { id: 'b', due_date: '2026-11-20' }, { id: 'a', due_date: '2026-12-10' }]), { a: '2026-11-10', b: '2026-11-20' });
  });
  test('予定の本文と下書きの検証（金額・名称・日数 0〜365・終わり ≥ 最初・支出に収入の分類は付けない）', () => {
    const d = { ...emptyDraft(TODAY), name: ' 自動車税 ', amount: '３９,５００円' };
    assert.deepEqual(draftBody(d), { name: '自動車税', amount: 39500, direction: 'out', category: 'other', recurrence: 'monthly', anchor_date: TODAY, end_date: null, notify_days_before: 14 });
    assert.equal(draftBody({ ...d, amount: '0' }), null);
    assert.equal(draftBody({ ...d, name: ' ' }), null);
    assert.equal(draftBody({ ...d, category: 'income' }), null);
    assert.equal(draftBody({ ...d, recurrence: 'quarterly' })?.recurrence, 'quarterly');
    assert.equal(parseYen('1.5'), null);
    assert.match(draftError({ ...d, notify_days_before: '366' })!, /0〜365/);
    assert.match(draftError({ ...d, end_date: '2026-11-05' })!, /最初の支払日より後/);
    assert.match(draftError({ ...d, name: 'あ'.repeat(201) })!, /200 文字/);
    assert.equal(emptyDraft(TODAY, 'in').category, 'income');
  });
  test('口座の PATCH は変わった項目だけ。カード以外は引落の設定を送らない。引落元は銀行だけ', () => {
    const base = { default_tag: card.default_tag, include_in_cashflow: true, mcp_visibility: card.mcp_visibility, active: true, card_settlement_account_id: 'A1', card_settlement_pattern: 'ラクテンカード' };
    assert.deepEqual(accountPatch(card, base), {});
    assert.deepEqual(accountPatch(card, { ...base, default_tag: 'business', card_settlement_account_id: '', card_settlement_pattern: ' ' }), { default_tag: 'business', card_settlement_account_id: null, card_settlement_pattern: null });
    assert.deepEqual(accountPatch(account(), { ...base, card_settlement_account_id: 'X', include_in_cashflow: false }), { include_in_cashflow: false });
    assert.deepEqual(settlementChoices([account(), card, wallet]).map((a) => a.id), ['A1']);
  });
  test('failText（400 の理由を日本語に）・同期の結果・資金繰りの警告', () => {
    assert.equal(failText(400, { error: 'invalid_q' }), '検索語が短すぎるか、法人格だけです。');
    assert.match(failText(400, { error: 'invalid_recurrence' }), /3 か月ごと/);
    assert.equal(failText(400, { error: 'weird_code' }), '受け付けられませんでした（weird_code）');
    assert.match(failText(500, null), /HTTP 500/);
    assert.match(failText(0), /通信できません/);
    assert.equal(syncText(false), '実行中か、10 分以内に実行済みです。');
    const name = (id: string) => (id === 'A1' ? '三井住友 普通' : id);
    assert.equal(warningText({ kind: 'no_balance', account_id: 'A1' }, name), '三井住友 普通 の残高がありません（0 円として計算しています）。');
    assert.match(warningText({ kind: 'short_history', months_available: 2 }, name), /2 か月分しかない/);
    assert.equal(guessCategory('ｿﾝﾎﾟｼﾞｬﾊﾟﾝ'), 'insurance');
    assert.equal(guessCategory('ネットフリックス'), 'other');
  });
});

// ---- 税・保険の見積もり ----

const taxYear = (year: number, over: Partial<TaxYear> = {}): TaxYear => ({
  year,
  kind: 'estimate',
  revenue: null,
  expenses: null,
  business_income: null,
  social_insurance_paid: null,
  income_tax_final: null,
  consumption_tax_final: null,
  prepaid_income_tax: null,
  ...over,
});
const taxYears = [
  taxYear(2025, { kind: 'actual', business_income: 3200000, income_tax_final: 180000, prepaid_income_tax: 0, consumption_tax_final: 210000, social_insurance_paid: 620000 }),
  taxYear(2026, { revenue: 5000000, expenses: 350000 }),
];
const taxData: TaxProfileResponse = {
  profile: { ...taxProfileDraftBase(), consumption_mode: 'unset' },
  years: taxYears,
  presets: [{ id: 'saitama-city-2026', label: 'さいたま市 令和 8 年度' }],
  missing: ['consumption_mode'],
};
function taxProfileDraftBase() {
  return { blue_return: '65' as const, simplified_class: null, revenue_includes_tax: true, biz_tax_rate: null, nhi_preset: 'saitama-city-2026', nhi_members: 1, nhi_members_40_64: 0, pension_mode: 'monthly' as const, pension_addon: false, dependents: 0, spouse: false, other_deductions: 0, payment_account_id: 'A1' };
}

describe('税・保険の見積もりの純関数', () => {
  test('所得: 直接の所得 > 売上 − 経費 − 青色控除。無い年は前の年を繰り越す', () => {
    assert.equal(taxIncome(taxYears, 2026, '65'), 4000000);
    assert.equal(taxIncome(taxYears, 2026, 'white'), 4650000);
    assert.equal(taxIncome(taxYears, 2028, '65'), 4000000, '2027・2028 は 2026 を繰り越す');
    assert.equal(taxIncome(taxYears, 2025, '65'), 3200000);
    assert.equal(taxIncome([taxYear(2026, { revenue: 100000, expenses: 0 })], 2026, '65'), 0, '負にしない');
    assert.equal(taxIncome([], 2026, '65'), null);
    assert.equal(tokyoDate('2026-11-06T15:30:00.000Z'), '2026-11-07');
    assert.equal(taxCardLine({ ...taxData, last_run_at: '2026-11-06T15:30:00.000Z' }, TODAY), '2026 年分 所得 400万円 · 消費税 未設定 / 最終計算 11/7');
    const s20 = { ...taxData, profile: { ...taxData.profile!, consumption_mode: 'special20' as const }, last_run_at: '2026-11-06T15:30:00.000Z' };
    assert.equal(taxCardLine(s20, TODAY), '2026 年分 所得 400万円 · 消費税 2 割特例 / 最終計算 11/7');
    assert.equal(taxCardLine({ ...taxData, years: [], last_run_at: null }, TODAY), '2026 年分 所得 未入力 · 消費税 未設定 / 最終計算 —');
  });
  test('プロファイルの本文: 人数の検査、空の口座は null、無ければ既定値', () => {
    const d = taxProfileDraft(null);
    assert.equal(d.blue_return, '65');
    assert.equal(d.nhi_preset, 'saitama-city-2026');
    assert.deepEqual(taxProfileBody(d), {
      blue_return: '65', consumption_mode: 'unset', simplified_class: null, revenue_includes_tax: true, biz_tax_rate: null, nhi_preset: 'saitama-city-2026', nhi_members: 1, nhi_members_40_64: 0, pension_mode: 'monthly',
      pension_addon: false, spouse: false, dependents: 0, other_deductions: 0, payment_account_id: null,
    });
    assert.equal((taxProfileBody({ ...d, other_deductions: '２７６,０００' }) as Record<string, unknown>).other_deductions, 276000);
    assert.match(taxProfileBody({ ...d, nhi_members_40_64: '2' }) as string, /加入人数以下/);
    assert.match(taxProfileBody({ ...d, dependents: 'x' }) as string, /扶養/);
  });
  test('年の本文: 変えた年だけ、空欄は null、まだ無い年で全部空欄なら送らない、所得だけ負を許す', () => {
    const drafts = taxYearDrafts(taxYears, TODAY);
    assert.deepEqual(drafts.map((d) => [d.year, d.kind]), [[2025, 'actual'], [2026, 'estimate'], [2027, 'estimate'], [2028, 'estimate']]);
    assert.equal(drafts[0]!.values.income_tax_final, '180000');
    assert.equal(drafts[2]!.values.revenue, '');
    assert.deepEqual(taxYearBodies(drafts, taxYears), [], '何も変えなければ送らない');
    const edited = drafts.map((d) => (d.year === 2026 ? { ...d, values: { ...d.values, expenses: '' } } : d.year === 2027 ? { ...d, values: { ...d.values, business_income: '−100000' } } : d));
    assert.deepEqual(taxYearBodies(edited, taxYears), [
      { year: 2026, body: { kind: 'estimate', revenue: 5000000, expenses: null, business_income: null } },
      { year: 2027, body: { kind: 'estimate', revenue: null, expenses: null, business_income: -100000 } },
    ]);
    assert.match(taxYearBodies([{ ...drafts[1]!, values: { revenue: '-5' } }], taxYears) as string, /2026 年の「売上」/);
  });
  test('年が替わっても、見込みの行は確定の欄に値を入れるまで送らない（kind を書き換えない）', () => {
    const next = taxYearDrafts(taxYears, '2027-01-05');
    assert.deepEqual(next.map((d) => [d.year, d.kind]), [[2026, 'actual'], [2027, 'estimate'], [2028, 'estimate'], [2029, 'estimate']]);
    assert.equal(next[0]!.values.business_income, '');
    assert.equal(next[0]!.placeholders?.business_income, '見込みの値（売上 − 経費）のまま');
    assert.deepEqual(taxYearBodies(next, taxYears), [], '何も編集していなければ空');
    const filled = next.map((d) => (d.year === 2026 ? { ...d, values: { ...d.values, income_tax_final: '150000' } } : d));
    assert.deepEqual(taxYearBodies(filled, taxYears), [
      { year: 2026, body: { kind: 'actual', business_income: null, income_tax_final: 150000, prepaid_income_tax: null, consumption_tax_final: null, social_insurance_paid: null } },
    ]);
    assert.equal(taxYearDrafts(taxYears, TODAY)[0]!.placeholders, undefined, '確定の行には出さない');
  });
  test('金額の入力: 小数・指数・+ は弾く。負（全角マイナスも）は所得だけ', () => {
    assert.equal(parseAmount(''), null);
    assert.equal(parseAmount('１,２００円'), 1200);
    for (const x of ['1.5', '1e3', '+5', '-5', '−5']) assert.equal(parseAmount(x), undefined, x);
    assert.equal(parseAmount('−100000', true), -100000);
    assert.equal(parseAmount('－5', true), -5);
    assert.equal(parseAmount('1.5', true), undefined);
  });
  test('一括保存（PUT /api/tax）の本文: 変えた列と変えた年だけ。何も変えていなければ送らない', () => {
    const draft = taxProfileDraft(taxData.profile);
    const drafts = taxYearDrafts(taxYears, TODAY);
    assert.equal(taxSaveBody(draft, drafts, taxData), null, '何も変えていなければ null');
    assert.deepEqual(taxSaveBody({ ...draft, consumption_mode: 'simplified', simplified_class: '5' }, drafts, taxData), {
      profile: { consumption_mode: 'simplified', simplified_class: 5 },
    });
    const edited = drafts.map((d) => (d.year === 2027 ? { ...d, values: { ...d.values, revenue: '6000000' } } : d));
    assert.deepEqual(taxSaveBody(draft, edited, taxData), { years: [{ year: 2027, kind: 'estimate', revenue: 6000000, expenses: null, business_income: null }] });
    assert.deepEqual(taxSaveBody({ ...draft, revenue_includes_tax: false }, edited, taxData), {
      profile: { revenue_includes_tax: false },
      years: [{ year: 2027, kind: 'estimate', revenue: 6000000, expenses: null, business_income: null }],
    });
    const full = taxSaveBody(taxProfileDraft(null), drafts, { profile: null, years: taxYears });
    assert.deepEqual(Object.keys((full as { profile: object }).profile).length, 14, 'プロファイルが無ければ全部の列を送る（作る）');
    assert.match(taxSaveBody({ ...draft, dependents: 'x' }, drafts, taxData) as string, /扶養/);
    assert.equal(taxSaveBody({ ...draft, consumption_mode: 'simplified', simplified_class: '' }, drafts, taxData), '簡易課税の事業区分を選んでください。', '事業区分が未選択なら止める');
    const simpData = { ...taxData, profile: { ...taxData.profile!, consumption_mode: 'simplified' as const, simplified_class: 3 } };
    const simpDraft = taxProfileDraft(simpData.profile);
    assert.equal(taxSaveBody(simpDraft, drafts, simpData), null);
    assert.deepEqual(taxSaveBody({ ...simpDraft, consumption_mode: 'standard' }, drafts, simpData), { profile: { consumption_mode: 'standard', simplified_class: null } }, '簡易課税から変えたら事業区分は null');
    const noClass = { ...taxData, profile: { ...taxData.profile!, consumption_mode: 'simplified' as const, simplified_class: null } };
    assert.deepEqual(taxSaveBody({ ...taxProfileDraft(noClass.profile), consumption_mode: 'exempt' }, drafts, noClass), { profile: { consumption_mode: 'exempt', simplified_class: null } }, '差が無くても null を含める');
    const actual = drafts.map((d) => (d.year === 2025 ? { ...d, values: { ...d.values, income_tax_final: '190000' } } : d));
    assert.deepEqual(taxSaveBody(draft, actual, taxData), {
      years: [{ year: 2025, kind: 'actual', business_income: 3200000, income_tax_final: 190000, prepaid_income_tax: 0, consumption_tax_final: 210000, social_insurance_paid: 620000 }],
    }, '確定の年は kind: actual と確定の欄だけ');
    assert.equal(taxSaveBody({ ...draft, nhi_members: ' 1 ' }, drafts, taxData), null, '空白を足しただけなら変えていない');
    assert.match(taxSaveBody(draft, [{ ...drafts[1]!, values: { revenue: '-5' } }], taxData) as string, /2026 年の「売上」/);
  });
  test('結果の 1 行: 件数と警告', () => {
    const r = (o: object) => ({ run_id: 'R', created: 0, updated: 0, deactivated: 0, skipped_pinned: [], warnings: [], ...o });
    assert.equal(
      runText(r({ created: 23, updated: 1, skipped_pinned: [{}], warnings: [{ kind: 'consumption_tax_mode_unset' }, { kind: 'income_missing', year: 2025 }] }), '保存しました。'),
      '保存しました。予定は作成 23・更新 1・停止 0 件（手直しの 1 件はそのまま）。消費税は未反映です。2025 年の所得が無い分は作っていません。',
    );
    assert.equal(runText(r({ warnings: [{ kind: 'tax_profile_missing' }] }), '再計算しました。'), '再計算しました。予定は作成 0・更新 0・停止 0 件。設定がまだ無いので作っていません。');
    assert.equal(
      runText(r({ created: 2, deactivated: 1, warnings: [{ kind: 'special20_expired', year: 2027 }, { kind: 'simplified_class_missing' }] }), '保存しました。'),
      '保存しました。予定は作成 2・更新 0・停止 1 件。2 割特例は 2026 年分までです。2027 年分以降の消費税は方式を選ぶまで見通しに入りません。簡易課税の事業区分が未設定なので消費税は見通しに入りません。',
    );
    assert.equal(warningText({ kind: 'special20_expired', year: 2027 }, (x) => x), '2 割特例は 2026 年分までです。2027 年分以降の消費税は方式を選ぶまで見通しに入りません。');
    assert.equal(warningText({ kind: 'simplified_class_missing' }, (x) => x), '簡易課税の事業区分が未設定なので消費税は見通しに入りません。');
    assert.match(warningText({ kind: 'tax_profile_missing' }, (x) => x), /税・保険の見積もりが未設定/);
    assert.match(warningText({ kind: 'consumption_tax_mode_unset' }, (x) => x), /消費税は見通しに入っていません/);
    assert.equal(warningText({ kind: 'revenue_missing', year: 2026 }, (x) => x), '2026 年分は売上が未入力なので消費税は見通しに入りません（所得だけでは計算できません）。');
    assert.equal(taxWarningText({ kind: 'revenue_missing', year: 2025 }), '2025 年分は売上が未入力なので消費税は見通しに入りません（所得だけでは計算できません）。');
  });
});

// ---- SSR スナップショット ----

const status: BankStatus[] = [
  { account_id: 'A1', name: '三井住友 普通', kind: 'bank', source: 'freee', active: true, last_sync_at: '2026-11-06T00:12:00.000Z', last_ok_at: '2026-11-06T00:12:00.000Z', last_error: null, last_csv_at: null, backfill_done_until: '2024-11-01' },
  { account_id: 'C1', name: '楽天カード', kind: 'card', source: 'freee', active: true, last_sync_at: '2026-11-06T01:00:00.000Z', last_ok_at: '2026-11-05T00:00:00.000Z', last_error: 'freee_http_503', last_csv_at: null, backfill_done_until: null },
  { account_id: 'W1', name: 'PayPay', kind: 'paypay', source: 'csv', active: true, last_sync_at: null, last_ok_at: null, last_error: null, last_csv_at: '2026-10-31T03:00:00.000Z', backfill_done_until: null },
];
const overview: Overview = {
  today: TODAY,
  balances: { total: 1250000, by_account: [{ account_id: 'A1', name: '三井住友 普通', kind: 'bank', balance: 1250000, as_of_date: TODAY }, { account_id: 'C1', name: '楽天カード', kind: 'card', balance: null, as_of_date: null }] },
  reserve: 420000,
  available: 830000,
  untagged_count: 12,
  cards_without_settlement: [{ account_id: 'C2', name: 'PayPay カード' }],
  open_candidates: 3,
  this_month: { month: '2026-11', income: 0, expense: 212400, planned_out_remaining: 80300, unplanned_out_estimate: 512000, projected_end_balance: 1337700 },
  sync: { last_ok_at: '2026-11-06T00:12:00.000Z', errors: 0 },
};
const history = { months: Array.from({ length: 12 }, (_, i) => ({ month: addMonth('2025-12', i), total: [980000, 1010000, 1050000, 950000, 1030000, 1100000, 1080000, 1150000, 1130000, 1090000, 1160000, 1250000][i]!, by_account: {} })) };
const candidate: Candidate = {
  id: 'R1',
  account_id: 'C1',
  description_norm: 'さくらインターネット',
  amount: 1571,
  interval: 'monthly',
  occurrences_json: '[{"date":"2026-09-15","amount":1571},{"date":"2026-10-15","amount":1571}]',
  state: 'open',
};

// ---- 税の試算 ----

const cmp = (mode: CtaxCompareRow['mode'], cls: number | null, o: Partial<CtaxCompareRow> = {}): CtaxCompareRow => ({
  mode, simplified_class: cls, available: true, reason: null, tax: 100000, take_home: 5000000, notes: [], ...o,
});
const simCompare: CtaxCompareRow[] = [
  cmp('exempt', null, { tax: 0, notes: ['exempt_requires_no_invoice'] }),
  cmp('special20', null, { available: false, reason: 'special20_expired', tax: null, take_home: null }),
  ...[1, 2, 3, 4, 5, 6].map((c) => cmp('simplified', c, { tax: 80000 * (7 - c) })),
  cmp('standard', null, { tax: 640000, notes: ['standard_approx'] }),
];
const simRes: TaxSimResponse = {
  year: 2027,
  inputs: {
    revenue: 8000000, expenses: 1000000, business_income: null, taxable_purchases: 1000000, ideco: 0, kyosai: 0, other_deductions: 0,
    revenue_includes_tax: true, blue_return: '65', consumption_mode: 'simplified', simplified_class: 5, source: { revenue: 'tax_years:2026', expenses: 'tax_years:2026' },
  },
  income: { pre_blue: 7000000, business_income: 6350000 },
  amounts: [
    { kind: 'income_tax', year: 2027, basis: 'year', amount: 700000, lines: [] },
    { kind: 'resident', year: 2028, basis: 'fiscal_year', amount: 600000, lines: [] },
    { kind: 'nhi', year: 2028, basis: 'fiscal_year', amount: 800000, lines: [] },
    { kind: 'pension', year: 2027, basis: 'fiscal_year', amount: 210000, lines: [] },
    { kind: 'biz_tax', year: 2028, basis: 'fiscal_year', amount: 0, lines: [] },
    { kind: 'ctax', year: 2027, basis: 'year', amount: 160000, lines: [] },
  ],
  total: 2470000, cash_profit: 7000000, take_home: 4530000, free_cash: 4530000, effective_rate: 0.3529,
  marginal: { delta: 1000000, total_increase: 377000, take_home_increase: 623000, rate: 0.377 },
  deductions: { ideco: 0, kyosai: 0, saving: 0 },
  ctax_compare: simCompare,
  best: { mode: 'simplified', simplified_class: 1 },
  warnings: [],
  assumptions: ['steady_state'],
};

describe('税の試算の純関数', () => {
  test('万円 ↔ 円。「−100 万」で 0 未満にならない', () => {
    assert.equal(toManInput(8000000), '800');
    assert.equal(toManInput(8125000), '813', '整数に丸める');
    assert.equal(parseMan('800'), 8000000);
    assert.equal(parseMan('１,２００'), 12000000);
    assert.equal(parseMan(''), null);
    for (const x of ['-1', '1.5', 'x']) assert.equal(parseMan(x), undefined, x);
    assert.equal(stepMan('800', 100), '900');
    assert.equal(stepMan('50', -100), '0');
    assert.equal(stepMan('', -100), '0');
    assert.equal(stepMan('', 100), '100');
    assert.equal(stepMan('x', 100), '100', '読めなければ 0 から');
    assert.equal(simMan(1234567), '123.5万');
    assert.equal(simMan(0), '0.0万');
    assert.equal(simMan(-50000), '−5.0万');
    assert.equal(simPct(0.3529), '35.3%');
    assert.equal(simPct(0.4), '40.0%');
    assert.equal(simPct(null), '—');
  });
  test('本文: 最初は空。空の欄は送らない（既定）。方式を選べば profile を上書き、区分は簡易課税のときだけ', () => {
    assert.deepEqual(taxSimBody(emptySimForm()), {});
    const f = seedSimForm(emptySimForm(), simRes);
    assert.deepEqual(f, { year: '2027', revenue: '800', expenses: '100', purchases: '', ideco: '', kyosai: '', mode: 'simplified', cls: '5' });
    assert.deepEqual(taxSimBody(f), { year: 2027, revenue: 8000000, expenses: 1000000, profile: { consumption_mode: 'simplified', simplified_class: 5 } });
    assert.deepEqual(taxSimBody({ ...f, mode: 'standard', purchases: '60', ideco: '24', kyosai: '84' }), {
      year: 2027, revenue: 8000000, expenses: 1000000, taxable_purchases: 600000, ideco: 240000, kyosai: 840000, profile: { consumption_mode: 'standard' },
    });
    assert.deepEqual((taxSimBody({ ...f, cls: '' }) as Record<string, unknown>).profile,{ consumption_mode: 'simplified' });
    assert.equal(taxSimBody({ ...f, expenses: '-1' }), '「経費」は 0 以上の整数（万円）で入れてください。');
    const other = { ...simRes, inputs: { ...simRes.inputs, taxable_purchases: 800000, ideco: 240000, simplified_class: null, revenue: null } };
    assert.deepEqual(seedSimForm(emptySimForm(), other), { year: '2027', revenue: '', expenses: '100', purchases: '80', ideco: '24', kyosai: '', mode: 'simplified', cls: '' });
    assert.equal(seedSimForm({ ...emptySimForm(), revenue: '500', mode: 'standard' }, simRes).revenue, '500', '入れてある欄は埋めない');
    // 方式を補正した応答（2 割特例 → 本則）なら、方式のセレクトは補正後の方式になる。
    const defaulted = { ...simRes, inputs: { ...simRes.inputs, consumption_mode: 'standard' as const, simplified_class: null, source: { ...simRes.inputs.source, consumption_mode: 'defaulted' } } };
    const d = seedSimForm(emptySimForm(), defaulted);
    assert.deepEqual([d.mode, d.cls], ['standard', '']);
  });
  test('負担の表: 年分 / 年度の見出し、個人事業税は 0 なら出さない。限界の 1 行', () => {
    assert.deepEqual(simAmountRows(simRes.amounts).map((r) => r.label), ['所得税（2027 年分）', '住民税（2028 年度）', '国保（2028 年度）', '国民年金（2027 年度）', '消費税（2027 年分）']);
    const biz = simRes.amounts.map((a) => (a.kind === 'biz_tax' ? { ...a, amount: 50000 } : a));
    assert.equal(simAmountRows(biz)[4]!.label, '個人事業税（2028 年度）');
    assert.equal(marginalText(simRes.marginal), '+100万で手取り +62.3万（負担率 37.7%）');
  });
  test('比較表の 3 行: 2 割特例 / 簡易（入力 → プロファイル → 第 5 種）/ 本則。免税は出さない', () => {
    const rows = (i: number | null, p: number | null) => simCompareRows(simCompare, i, p).map(ctaxRowLabel);
    assert.deepEqual(rows(3, 2), ['2 割特例', '簡易（第 3 種）', '本則（概算）']);
    assert.deepEqual(rows(null, 2), ['2 割特例', '簡易（第 2 種）', '本則（概算）']);
    assert.deepEqual(rows(null, null), ['2 割特例', '簡易（第 5 種）', '本則（概算）']);
    const best = (rows: CtaxCompareRow[]) => {
      const b = bestRow(rows);
      return b === null ? null : ctaxRowLabel(b);
    };
    assert.equal(best(simCompareRows(simCompare, 1, null)), '簡易（第 1 種）', '表示する 3 行の中で最小（API の best は使わない）');
    assert.equal(best(simCompareRows(simCompare, 5, null)), '簡易（第 5 種）', '区分 5 でも簡易が最安');
    const cheapStd = simCompare.map((r) => (r.mode === 'standard' ? { ...r, tax: 100000 } : r));
    assert.equal(best(simCompareRows(cheapStd, 5, null)), '本則（概算）');
    const tie = simCompare.map((r) => (r.mode === 'special20' ? { ...r, available: true, reason: null, tax: 160000, take_home: 5000000 } : r));
    assert.equal(best(simCompareRows(tie, 5, null)), '2 割特例', '同額なら 2 割特例 → 簡易 → 本則');
    const none = simCompare.map((r) => ({ ...r, available: false, reason: 'revenue_missing' as const, tax: null, take_home: null }));
    assert.equal(best(simCompareRows(none, 5, null)), null, '使える行が無ければ印なし');
  });
  test('理由と警告の文言', () => {
    assert.equal(ctaxReasonText('special20_expired'), '2026 年分まで');
    assert.equal(ctaxReasonText('over_10m'), '売上 1,000 万超');
    assert.equal(ctaxReasonText('over_50m'), '売上 5,000 万超');
    assert.equal(ctaxReasonText('revenue_missing'), '売上が未入力');
    assert.equal(simWarningText({ kind: 'consumption_tax_mode_unset' }), '消費税の方式が未設定なので、消費税は 0 円で計算しています。');
    assert.equal(simWarningText({ kind: 'selected_mode_unavailable', mode: 'special20', reason: 'special20_expired' }), '選んだ方式（2 割特例）は使えない条件です（2026 年分まで）。消費税は 0 円で計算しています。');
    assert.equal(simWarningText({ kind: 'selected_mode_unavailable', mode: 'special20', reason: 'over_10m' }), '選んだ方式（2 割特例）は使えない条件です（売上 1,000 万超）。消費税はその方式のまま計算しています。');
    assert.equal(simWarningText({ kind: 'rates_assumed', year: 2028, latest: 2026 }), '2028 年の税率・料率はまだ無いので、2026 年の値で計算しています。');
    assert.equal(simWarningText({ kind: 'special20_expired', year: 2027 }), taxWarningText({ kind: 'special20_expired', year: 2027 }), '知らない kind は見積もりの文言');
    assert.equal(
      simWarningText({ kind: 'mode_defaulted', from: 'special20', to: 'simplified', simplified_class: 5 }, 2027),
      '2 割特例は 2027 年分から使えないため、簡易課税（第 5 種）で計算しています。',
    );
    assert.equal(simWarningText({ kind: 'mode_defaulted', from: 'special20', to: 'standard', simplified_class: null }, 2028), '2 割特例は 2027 年分から使えないため、本則（概算）で計算しています。');
    assert.equal(simWarningText({ kind: 'mode_defaulted', from: 'special20', to: 'simplified', simplified_class: 3 }, 2026), '売上 1,000 万円超のため、簡易課税（第 3 種）で計算しています。');
    assert.equal(simWarningText({ kind: 'mode_defaulted', from: 'exempt', to: 'standard', simplified_class: null }, 2027), '売上 1,000 万円超のため、本則（概算）で計算しています。');
    assert.deepEqual(simNotices({ year: 2027, warnings: [{ kind: 'simplified_class_missing' }, { kind: 'simplified_class_missing' }], assumptions: ['steady_state', 'pension_prepay24_as_prepay12'] }), [
      '簡易課税の事業区分が未選択なので、消費税は 0 円で計算しています。',
      '国民年金の 2 年前納は、1 年前納として計算しています。',
    ]);
    assert.deepEqual(simNotices(simRes), []);
  });
});

const doc = (over: Partial<DocBrief> = {}): DocBrief => ({ id: 'D1', status: 'approved', kind: 'receipt', source: 'pwa', txn_date: '2026-11-03', amount: 1234, vendor: 'サンプル商店', thumbnail_url: '/api/documents/D1/thumbnail', ...over });
const link = (d: DocBrief, created_at = '2026-11-06T01:00:00Z') => ({ bank_txn_id: 'T1', document_id: d.id, state: 'confirmed', actor: 'user', score: null, created_at, document: d });
const vendor = (over: Partial<ExpenseVendor> = {}): ExpenseVendor => ({ vendor_key: 'サンプルショウテン', label: 'サンプル商店', count: 3, amount: 3702, waiting_count: 1, category: 'daily', ...over });
const expenses: Expenses = {
  from: '2026-11',
  to: '2026-11',
  total: { amount: 15702, count: 5, waiting_count: 2, waiting_amount: 5234 },
  months: [{ month: '2026-11', amount: 15702, count: 5, waiting_count: 2 }],
  vendors: [vendor({ vendor_key: 'カ）エービーシー', label: 'カ）エービーシー', count: 1, amount: 10000, waiting_count: 0, category: null }), vendor(), vendor({ vendor_key: null, label: 'その他', count: 1, amount: 2000, waiting_count: 1, category: null })],
};

describe('照合・経費の一覧の純関数', () => {
  test('行の印: receipt の 4 通り、未設定で証憑ありは「証憑あり・未タグ」、どれでもなければ出さない', () => {
    assert.deepEqual(
      (['matched', 'pending_review', 'candidate', 'waiting'] as const).map((r) => receiptMark(txn({ receipt: r }))?.label),
      ['証憑', '確認待ち', '候補', '待ち'],
    );
    assert.deepEqual(receiptMark(txn({ tag: 'unset', receipt: null, receipt_hint: { document_id: 'D1', status: 'approved' } })), { kind: 'hint', label: '証憑あり・未タグ' });
    assert.equal(receiptMark(txn({ tag: 'private', receipt: null, receipt_hint: { document_id: 'D1', status: 'approved' } })), null);
    assert.equal(receiptMark(txn()), null, '古いサーバー（receipt が無い）');
  });
  test('明細の URL に経費の絞り込み（side・excluded・vendor_key・receipt）を足す', () => {
    const u = new URL(txnsUrl({ period: 'month', month: '2026-10', accountId: '', tag: 'business', category: '', q: '', side: 'expense', excluded: '0', vendorKey: 'カ）エービーシー', vendorLabel: '表示だけ', receipt: 'waiting' }, TODAY, null), 'http://x');
    assert.deepEqual(Object.fromEntries(u.searchParams), { limit: '50', from: '2026-10-01', to: '2026-10-31', tag: 'business', side: 'expense', excluded: '0', vendor_key: 'カ）エービーシー', receipt: 'waiting' });
    assert.equal(txnsUrl({ period: 'all', accountId: '', tag: '', category: '', q: '' }, TODAY, null), '/api/bank_txns?limit=50', '無ければ送らない');
  });
  test('相手の行 → 明細の絞り込み（待ちだけなら receipt も。「その他」は null）・見出し', () => {
    assert.deepEqual(vendorFilter(vendor(), '2026-10', false), { period: 'month', month: '2026-10', tag: 'business', side: 'expense', excluded: '0', vendorKey: 'サンプルショウテン', vendorLabel: 'サンプル商店' });
    const w = vendorFilter(vendor(), '2026-10', true)!;
    assert.equal(w.receipt, 'waiting');
    assert.equal(vendorFilter(vendor({ vendor_key: null }), '2026-10', true), null);
    assert.equal(expenseFilterText({ period: 'month', accountId: '', tag: 'business', category: '', q: '', ...w }), '経費 · サンプル商店 · 領収書待ちだけ');
    assert.equal(expenseFilterText({ period: 'all', accountId: '', tag: 'business', category: '', q: '', side: 'expense', excluded: '0', receipt: 'waiting' }), '経費 · 領収書待ちだけ');
    assert.equal(expenseFilterText({ period: 'all', accountId: '', tag: 'business', category: '', q: '' }), null);
  });
  test('待ちの文・待ちだけの相手・URL', () => {
    assert.equal(waitingText(3, 5234), '領収書待ち 3 件 / 5,234 円');
    assert.equal(waitingText(3), '領収書待ち 3 件');
    assert.equal(waitingText(0, 0), '領収書待ちはありません');
    assert.deepEqual(expenseVendors(expenses.vendors, true).map((v) => v.label), ['サンプル商店', 'その他']);
    assert.equal(expenseVendors(expenses.vendors, false).length, 3);
    assert.equal(expensesUrl('2026-10'), '/api/expenses?month=2026-10');
  });
  test('領収書待ちで開く期間: 今月を含む直近 12 か月（年をまたぐ）。明細へは period=year', () => {
    assert.deepEqual(expensesYear(TODAY), { from: '2025-12', to: '2026-11' });
    assert.deepEqual(expensesYear('2026-01-15'), { from: '2025-02', to: '2026-01' });
    assert.equal(expensesUrl(null, TODAY), '/api/expenses?from=2025-12&to=2026-11');
    assert.deepEqual(periodRange('year', TODAY), { from: '2025-12-01', to: TODAY });
    const f = vendorFilter(vendor(), null, true)!;
    assert.deepEqual([f.period, f.month, f.receipt], ['year', undefined, 'waiting']);
    assert.equal(new URL(txnsUrl({ period: 'all', accountId: '', tag: '', category: '', q: '', ...f }, TODAY, null), 'http://x').searchParams.get('from'), '2025-12-01');
  });
  test('「未設定だけ」に切り替えると経費の絞り込み（receipt・vendor_key・excluded・side）を外す。戻すとタグだけ外す', () => {
    const f = { period: 'month' as const, month: '2026-10', accountId: 'A1', tag: 'business' as const, category: '', q: 'x', side: 'expense' as const, excluded: '0' as const, vendorKey: 'K', vendorLabel: 'L', receipt: 'waiting' as const };
    const on = toggleUnset(f);
    assert.equal(new URL(txnsUrl(on, TODAY, null), 'http://x').search, '?limit=50&from=2026-10-01&to=2026-10-31&account_id=A1&tag=unset&q=x');
    assert.equal(expenseFilterText(on), null);
    assert.equal(toggleUnset(on).tag, '');
  });
  test('紐付け/解除の後の行: 確認済みの証憑で matched、確認前だけなら pending_review、無くなれば candidate / waiting', () => {
    const t = txn({ receipt: 'candidate', receipt_hint: null });
    const done: Matches = { links: [link(doc({ id: 'D0', status: 'needs_review' }), '2026-11-05T00:00:00Z'), link(doc())], candidates: [] };
    assert.deepEqual([applyMatches(t, done).receipt, applyMatches(t, done).receipt_hint], ['matched', { document_id: 'D1', status: 'approved' }]);
    assert.equal(applyMatches(t, { links: [link(doc({ status: 'received' }))], candidates: [] }).receipt, 'pending_review');
    assert.equal(applyMatches(t, { links: [], candidates: [{ document_id: 'D2', score: 90, date_diff: 1, vendor_match: 1, document: doc({ id: 'D2' }) }] }).receipt, 'candidate');
    const empty = applyMatches(t, { links: [], candidates: [] });
    assert.deepEqual([empty.receipt, empty.receipt_hint], ['waiting', null]);
    const unset = applyMatches(txn({ tag: 'unset', receipt: null }), done);
    assert.deepEqual([unset.receipt, unset.receipt_hint?.document_id], [null, 'D1'], '経費でない明細は receipt を作らない');
  });
  test('事業でなくしたら receipt を外す。証憑の 1 行・紐付けの警告', () => {
    const out = applyTag([txn({ receipt: 'waiting' })], 'T1', { effective: { tag: 'private', category: null, source: 'override' } });
    assert.equal(out[0]!.receipt, null);
    assert.equal(applyTag([txn({ receipt: 'waiting' })], 'T1', { effective: { tag: 'business', category: null, source: 'override' } })[0]!.receipt, 'waiting');
    assert.equal(docLine(doc()), 'サンプル商店 · 11/3 · 1,234 円');
    assert.equal(docLine(doc({ vendor: null, txn_date: null, amount: null, status: 'needs_review' })), '相手名なし · 確認前');
    assert.equal(linkedText([]), '');
    assert.equal(linkedText(['amount_mismatch', 'date_out_of_window']), '紐付けました（金額が明細と違います・日付が離れています）。');
  });
});

describe('SSR スナップショット', () => {
  let vite: ViteDevServer;
  const load = (p: string) => vite.ssrLoadModule(p) as Promise<Record<string, (props: any) => unknown>>;
  before(async () => {
    vite = await startSsr();
  });
  after(async () => {
    await vite.close();
  });
  const html = (c: (props: never) => unknown, props: object) => pretty(renderHtml(h(c as never, props as never)));

  test('ホーム: 今日使えるお金・今月の進み・残高の推移・確認すること・入口', async (t) => {
    const m = await load('/src/money/Home.tsx');
    const cf = { ...forecast, months: [fmonth('2026-11', { planned_in: 680000, items: [{ id: 'S4', name: '売上の入金', amount: 680000, direction: 'in', due: '2026-11-25' }] }), ...forecast.months.slice(1)] };
    const d = {
      o: overview,
      history,
      cf,
      months: [monthly('2026-09', 650000, 600000), monthly('2026-10', 680000, 700000, 98000), { ...monthlyEmpty('2026-11'), by_account: [{ account_id: 'C1', name: '楽天カード', include_in_cashflow: true, active: true, net: -36420, income: 0, expense: 36420 }] }],
      upcoming: [up(scheduled({ id: 'L1', name: '生命保険', amount: 12300, category: 'insurance' }), '2026-11-27')],
      status,
    };
    const out = html(m.HomeView!, { today: TODAY, d, accounts: [account(), card, bareCard, wallet], cats, go: noop });
    assert.match(out, /830,000<small>円/);
    assert.match(out, /残高の合計（1 口座）/, '残高の無いカードは数えない');
    assert.match(out, /カードの今月の利用 36,420 円はまだ残高から引かれていません。/);
    assert.match(out, /11 月の進み[\s\S]*6 日目 \/ 30 日/);
    assert.match(out, /見込み 680,000/);
    assert.match(out, /width="26.4"/);
    assert.match(out, /確認すること（3）/);
    assert.match(out, /PayPay カード の引落の設定が済んでいません/);
    assert.match(out, /10 月の差額 −20,000（税金が平均より多い）/);
    assert.match(out, /2027-01 に残す額を下回る見込み/);
    assert.match(out, /次: 11\/27 生命保険 12,300/);
    assert.match(out, /同期エラー 1 件・PayPay の CSV は 10\/31 が最後/);
    assert.match(out, /<polyline class="c-line"/);
    const bare = html(m.HomeView!, { today: TODAY, d: { o: null, history: null, cf: null, months: [], upcoming: [], status: [] }, accounts: [], cats, go: noop });
    assert.match(bare, /残高を読めませんでした/);
    assert.doesNotMatch(bare, /<svg class="m-svg"/, '推移が無ければ隠す');
    // 最初の 2 か月は残高が無い（0）、6 月も無い。残す額 0。
    const gaps = { months: history.months.map((x, i) => (i < 2 || i === 6 ? { ...x, total: 0 } : x)) };
    const gap = html(m.HomeView!, { today: TODAY, d: { ...d, o: { ...overview, reserve: 0 }, history: gaps, months: [] }, accounts: [account()], cats, go: noop });
    assert.match(gap, /月末・直近 10 か月/, '最初に残高がある月より前は描かない');
    assert.equal((gap.match(/<polyline class="c-line"/g) ?? []).length, 2, '残高の無い月で線を切る');
    assert.doesNotMatch(gap, /残す額 0/, '残す額 0 のラベルは出さない');
    assert.doesNotMatch(gap, /今月の利用/, '利用が 0 なら注記を出さない');
    t.assert.snapshot(lines(out));
    t.assert.snapshot(lines(gap));
  });

  test('画面の上の帯（戻る・題・右端）', async (t) => {
    const m = await load('/src/money/Money.tsx');
    const out = [html(m.ScreenHead!, { title: '見通し', sub: '36 か月 · 2026-11〜2029-10', onBack: noop }), html(m.ScreenHead!, { title: '予定', locked: true, flat: true, onBack: noop })].join('\n');
    assert.match(out, /aria-label="お金に戻る" disabled/);
    assert.match(html(m.ScreenHead!, { title: '税・保険の見積もり', backLabel: '予定に戻る', onBack: noop }), /aria-label="予定に戻る"/);
    t.assert.snapshot(lines(out));
  });

  test('別チャンクの画面を読んでいる間・読めなかったとき', async (t) => {
    const m = await load('/src/money/Money.tsx');
    const out = [html(m.Pending!, { label: '経費', failed: false }), html(m.Pending!, { label: '経費', failed: true })].join('\n');
    assert.match(out, /読み込み中…/);
    assert.match(out, /経費の画面を読めませんでした/);
    t.assert.snapshot(lines(out));
  });

  test('月次: 月の切り替え・合計・カテゴリ別の横棒・事業/私用・集計外・6 か月の棒', async (t) => {
    const m = await load('/src/money/Monthly.tsx');
    const ms = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((x, i) => monthly(x, 680000, [612000, 745000, 650000, 735000, 648000, 700000][i]!, x === '2026-10' ? 98000 : 46000));
    const out = [
      html(m.MonthBar!, { month: '2026-10', today: TODAY, onSelect: noop }),
      html(m.MonthBar!, { month: '2026-11', today: TODAY, onSelect: noop }),
      html(m.MonthlyView!, { months: ms, selected: '2026-10', cats, uncat: { n: 100, more: true }, unset: { n: 23, more: false }, onSelect: noop, onTxns: noop, onAnalysis: noop }),
    ].join('\n');
    assert.match(out, /締まった月/);
    assert.match(out, /aria-label="次の月（12 月）" disabled/);
    assert.ok(out.indexOf('税金') < out.indexOf('通信'), 'カテゴリ別は支出の大きい順');
    assert.match(out, /class="d up strong">\+43,333</);
    assert.match(out, /100\+ 件を分類する/);
    assert.match(out, /未設定の 23 件をタグ付け/);
    assert.match(out, /カード引落<span class="m-sub13"> · 1 件/);
    assert.match(out, /class="f-sel"/);
    assert.match(out, /tabindex="0" role="button" aria-label="10月に切り替える" aria-pressed="true"/, 'グラフの月はキーボードで選べる');
    const ch = await load('/src/money/Charts.tsx');
    assert.doesNotMatch(html(ch.CatBar!, { value: 100, avg: 0, max: 100 }), /f-avg/, '平均 0 なら縦線を描かない');
    assert.match(html(ch.CatBar!, { value: 100, avg: 50, max: 100 }), /class="f-avg" x1="50"/);
    assert.match(html(m.MonthlyView!, { months: [], selected: '2026-10', cats, uncat: null, unset: null, onSelect: noop, onTxns: noop }), /この月の集計はありません/);
    t.assert.snapshot(lines(out));
  });

  test('明細: 期間・未設定だけ・折りたたみ、日付ごとの行（タグ・集計外）、タグ付けシート', async (t) => {
    const m = await load('/src/money/Txns.tsx');
    const rows = [
      txn({ id: 'T0', txn_date: TODAY, description: 'セブン-イレブン', account_name: 'PayPay', amount: 1280, tag: 'unset', category: null, tag_source: 'none' }),
      txn({ id: 'T1', txn_date: TODAY }),
      txn({ id: 'T2', side: 'income', amount: 300000, description: '振込 カ）エービーシー', tag: 'private', category: null }),
      txn({ id: 'T3', amount: 10000, description: 'PayPay チャージ', excluded: true, transfer_kind: 'charge', tag: 'private', category: null }),
    ];
    const out = [
      html(m.TxnFilters!, { f: { period: 'last', accountId: 'A1', tag: 'unset', category: 'none', q: 'ドコモ' }, q: 'ドコ', expanded: true, unsetCount: '12', accounts: [account(), card], cats, onChange: noop, onQ: noop, onExpand: noop }),
      html(m.TxnFilters!, { f: { period: 'month', month: '2026-10', accountId: '', tag: '', category: 'food', q: '' }, q: '', expanded: false, unsetCount: '100+', accounts: [], cats, onChange: noop, onQ: noop, onExpand: noop }),
      html(m.TxnList!, { items: rows, f: { period: 'this', accountId: '', tag: '', category: '', q: '' }, today: TODAY, more: true, cats, busyIds: ['T1'], hint: true, onHint: noop, onOpen: noop, onToggle: noop }),
      html(m.TagSheet!, { txn: rows[0], draft: { tag: 'business', category: 'food', rule: true }, pos: { index: 1, total: 12 }, cats, saving: false, error: '通信できません。', onDraft: noop, onSave: noop, onClose: noop }),
      html(m.TagSheet!, { txn: rows[1], draft: { tag: 'unset', category: null, rule: false }, pos: { index: 0, total: 0 }, cats, saving: true, error: '', onDraft: noop, onSave: noop, onClose: noop }),
    ].join('\n');
    assert.match(out, /未設定だけ（12）/);
    assert.match(out, /口座・カテゴリ・検索（3）/);
    assert.match(out, /11\/6（金）今日/);
    assert.match(out, /m-amt m-amt-out">−1,280/);
    assert.match(out, /m-amt m-amt-in">\+300,000/);
    assert.match(out, /m-amt m-amt-ex">10,000[\s\S]*集計外 · チャージ/);
    assert.match(out, /aria-label="タグ: 事業。押すと私用に切り替え" disabled/);
    assert.match(out, /aria-label="タグ: 未設定。押すと事業に切り替え"/);
    assert.match(out, /未設定 1 \/ 12/);
    assert.match(out, /PayPay の「セブン-イレブン」すべて[\s\S]*事業 · 食費 にします/);
    assert.match(out, /class="m-scrim"/);
    assert.match(out, /未設定のままではルールにできません/);
    t.assert.snapshot(lines(out));
  });

  test('見通し: 結論・警告・36 か月の折れ線と印・前提・年ごとの行（1 年目だけ開く）', async (t) => {
    const m = await load('/src/money/Cashflow.tsx');
    const info = itemInfoMap([scheduled({ id: 'S1', name: '自動車税', category: 'car' }), scheduled({ id: 'S2', name: '所得税', category: 'tax' }), scheduled({ id: 'S3', name: '国保', category: 'insurance', recurrence: 'quarterly' })]);
    const ms = months36((i, month) => ({
      planned_in: 680000,
      balance_end: 1340000 - i * 40000,
      reserve: 460000,
      margin: 1340000 - i * 40000 - 460000,
      items: [
        ...(month.endsWith('-03') ? [{ id: 'S2', name: '所得税', amount: 132398, direction: 'out' as const, due: `${month}-15` }] : []),
        ...(month.endsWith('-05') ? [{ id: 'S1', name: '自動車税', amount: 39500, direction: 'out' as const, due: `${month}-31` }] : []),
        ...(i % 3 === 0 ? [{ id: 'S3', name: '国保', amount: 68000, direction: 'out' as const, due: `${month}-28` }] : []),
      ],
    }));
    const first = ms.find((x) => x.margin < 0)!.month;
    const cf: Forecast = { ...forecast, months: ms, first_shortfall_month: first, warnings: [{ kind: 'stale_balance', account_id: 'W1', as_of_date: '2026-10-20' }], cut_per_month_to_survive: 13200 };
    const out = html(m.CashflowView!, { cf, info, accounts: [account(), wallet], openYears: [0], onToggleYear: noop, onJump: noop, onMonthly: noop, onSchedule: noop, onAddIncome: noop });
    assert.match(out, new RegExp(`${first} に残す額を下回ります`));
    assert.match(out, /月 13,200 円減らすと、3 年間は足ります/);
    assert.match(out, /PayPay の残高が 2026-10-20 から更新されていません/);
    assert.match(out, /class="f-short"/);
    assert.match(out, /class="f-tax"[\s\S]*class="f-insurance"[\s\S]*class="f-car"/);
    assert.match(out, /収入は毎月 680,000 のため省略/);
    assert.match(out, /aria-label="年ごとの行へ移る"[\s\S]*1 年目の行へ[\s\S]*3 年目の行へ/);
    assert.equal((out.match(/aria-expanded="true"/g) ?? []).length, 1);
    assert.equal((out.match(/<li [^>]*class="m-frow/g) ?? []).length, 12, '1 年目だけ行を出す');
    assert.match(out, /12 か月とも残す額に足りない/);
    const ok = html(m.CashflowView!, { cf: { ...forecast, months: months36(), first_shortfall_month: null, warnings: [], cut_per_month_to_survive: null }, info: {}, accounts: [], openYears: [0, 2], onToggleYear: noop, onJump: noop, onMonthly: noop, onSchedule: noop, onAddIncome: noop });
    assert.match(ok, /3 年間足ります/);
    assert.equal((ok.match(/<li [^>]*class="m-frow/g) ?? []).length, 24);
    t.assert.snapshot(lines(out));
  });

  test('予定: 提案・12 か月の山・台帳（分類の絞り込み・停止中）・追加/編集のフォーム', async (t) => {
    const m = await load('/src/money/Schedule.tsx');
    const tax = scheduled({ id: 'X1', name: '所得税（確定申告）', category: 'tax', amount: 132398, anchor_date: '2027-03-15' });
    const ins = scheduled({ id: 'X2', name: '国民健康保険', category: 'insurance', recurrence: 'quarterly', amount: 68000 });
    const life = scheduled({ id: 'X3', name: '生命保険', category: 'insurance', recurrence: 'monthly', amount: 12300 });
    const sales = scheduled({ id: 'X4', name: '売上の入金', direction: 'in', category: 'income', amount: 680000, recurrence: 'monthly' });
    const ntt = scheduled({ id: 'X5', name: 'NTT 光', category: 'other', recurrence: 'monthly', amount: 5467, origin: 'detected' });
    const off = scheduled({ id: 'X6', name: '止めた保険', category: 'insurance', active: 0 });
    const upcoming = [up(sales, '2026-11-25'), up(life, '2026-11-27'), up(ins, '2026-11-30'), up(ntt, '2026-12-01'), up(ins, '2027-02-28'), up(tax, '2027-03-15')];
    const due = nextDueMap(upcoming);
    const peaks = peakMonths(upcoming, TODAY);
    const out = [
      html(m.CandidateList!, { items: [candidate, { ...candidate, id: 'R2', description_norm: 'JAF 年会費', description: 'ＪＡＦ　年会費', account_name: '三井住友（普通）', amount: 4000, interval: 'yearly', account_id: 'A1', occurrences_json: '[{"date":"2024-12-10","amount":4000},{"date":"2025-12-10","amount":4000}]' }], accounts: [account(), card], today: TODAY, busy: false, onAccept: noop, onDismiss: noop }),
      html(m.PeakCard!, { peaks, fixed: monthlyFixed([life, ntt, sales]) }),
      html(m.Ledger!, { items: [tax, ins, life, sales, ntt, off], nextDue: due, today: TODAY, filter: '', showInactive: false, onFilter: noop, onShowInactive: noop, onOpen: noop }),
      html(m.Ledger!, { items: [tax, ins, life, off], nextDue: due, today: TODAY, filter: 'insurance', showInactive: true, onFilter: noop, onShowInactive: noop, onOpen: noop }),
      html(m.ItemForm!, { draft: emptyDraft(TODAY), editing: null, busy: false, onChange: noop, onSave: noop, onToggle: noop, onClose: noop }),
      html(m.ItemForm!, { draft: { ...emptyDraft(TODAY), name: '国民健康保険', amount: '68000', category: 'insurance', recurrence: 'quarterly' }, editing: ins, busy: false, onChange: noop, onSave: noop, onToggle: noop, onClose: noop }),
    ].join('\n');
    assert.match(out, /予定にする（その他）/);
    assert.match(out, /楽天カード · 最後 10\/15（2 回） · 次は 11\/15 ごろ/);
    assert.match(out, /三井住友（普通） · 最後 2025-12-10（2 回） · 次は 12\/10 ごろ/, '口座名は account_name があればそれ');
    assert.match(out, /<h3 class="m-h3">ＪＡＦ　年会費<\/h3>/, '摘要は正規化前');
    assert.match(out, /毎月の 17,767 は除く/);
    assert.match(out, /class="f-insurance"/);
    assert.match(out, /あと 19 日[\s\S]*売上の入金[\s\S]*\+680,000/);
    assert.match(out, /3 か月ごと/);
    assert.match(out, /毎月 · 明細から/);
    assert.match(out, /停止中の 1 件も表示/);
    assert.match(out, /m-lrow m-lrow-off/);
    assert.match(out, /<option value="quarterly">3 か月ごと<\/option>/);
    assert.doesNotMatch(out.split('id="m-item-form"')[1]!, /value="income"/, '支出のフォームに収入の分類は出さない');
    t.assert.snapshot(lines(out));
  });

  test('口座: 引落元が未設定のカードはその場で直す、設定を開いたカード、CSV の取り込みと結果、CSV だけの口座の追加', async (t) => {
    const m = await load('/src/money/Accounts.tsx');
    const mm = await load('/src/money/model.ts');
    const withStatus = mm.withStatus as unknown as (a: Account[], s: BankStatus[]) => unknown[];
    const accounts = [account(), card, wallet, bareCard];
    const draft = { default_tag: 'unset', include_in_cashflow: true, mcp_visibility: 'summary', active: true, card_settlement_account_id: 'A1', card_settlement_pattern: 'ラクテンカード' };
    const out = [
      html(m.AccountsView!, { rows: withStatus(accounts, status), today: TODAY, accounts, usage: { C1: 36420, C2: 0 }, edit: { id: 'C1', draft, open: true }, busy: false, onOpen: noop, onDraft: noop, onSave: noop }),
      html(m.AccountsView!, { rows: withStatus([wallet], status), today: TODAY, accounts: [wallet], edit: { id: 'W1', draft: { ...draft, default_tag: 'private', mcp_visibility: 'none', include_in_cashflow: false }, open: true }, busy: false, onOpen: noop, onDraft: noop, onSave: noop }),
    ].join('\n');
    const result = {
      csv_import_id: 'I1', parser: 'paypay', rows_total: 30, rows_new: 25, rows_merged: 1, rows_skipped_points: 4, rows_error: 2,
      errors: [{ line: 10, reason: 'invalid_date' }, { line: 12, reason: 'mystery' }], date_range: { from: '2026-10-01', to: '2026-10-31' },
    };
    const csvOut = [
      html(m.AccountsView!, { rows: withStatus([wallet], status), today: TODAY, accounts: [wallet], edit: null, busy: false, csv: { W1: { busy: false, result } }, onOpen: noop, onDraft: noop, onSave: noop, onImport: noop }),
      html(m.AccountsView!, { rows: withStatus([wallet], status), today: TODAY, accounts: [wallet], edit: null, busy: false, csv: { W1: { busy: false, fail: '同じファイルは取り込み済みです。' } }, onOpen: noop, onDraft: noop, onSave: noop, onImport: noop }),
      html(m.AccountsView!, { rows: withStatus([wallet], status), today: TODAY, accounts: [wallet], edit: null, busy: false, csv: { W1: { busy: true } }, onOpen: noop, onDraft: noop, onSave: noop, onImport: noop }),
      html(m.CsvAccountForm!, { draft: { name: '', kind: 'paypay' }, busy: false, onChange: noop, onSave: noop, onClose: noop }),
    ].join('\n');
    assert.ok(out.indexOf('PayPay カード') < out.indexOf('三井住友 普通'), '引落元が未設定のカードを先に');
    assert.match(out, /引落の設定が済んでいません。[\s\S]*disabled>保存して二重計上を直す/, '摘要の文字が空のあいだは押せない');
    assert.match(out, /同期エラー: freee_http_503/);
    assert.match(out, /過去分 2024-11 まで済み/);
    assert.match(out, /CSV · 最後の取り込み 10\/31/);
    assert.doesNotMatch(out, /準備中/);
    assert.equal(out.match(/type="file"/g)?.length, 2, 'CSV の口座のカードだけ（設定を開いていても 1 つ）');
    assert.match(out, /PayPay の CSV を取り込む[\s\S]*accept="\.csv,text\/csv"/);
    assert.match(csvOut, /新規 25 件・統合 1 件・ポイント 4 件を除外・エラー 2 件/);
    assert.match(csvOut, /<li>10 行目: 日付が読めません<\/li>\s*<li>12 行目: mystery<\/li>/);
    assert.match(csvOut, /同じファイルは取り込み済みです。/);
    assert.match(csvOut, /m-csv-pick m-csv-pick-off[\s\S]*取り込み中…[\s\S]*disabled/);
    assert.match(csvOut, /CSV だけの口座を追加[\s\S]*PayPay<\/button>[\s\S]*銀行<\/button>[\s\S]*その他<\/button>[\s\S]*disabled>追加/);
    assert.match(out, /−36,420<br\/?>\s*<span class="m-sub">今月の利用<\/span>/, 'カードは残高ではなく今月の利用');
    assert.doesNotMatch(out, /294,061/);
    assert.match(out, /見せない<\/button>[\s\S]*合計だけ<\/button>[\s\S]*明細も<\/button>/);
    assert.doesNotMatch(out.split('aria-expanded="true"')[1]!.split('</article>')[0]!, /value="W1"/, '引落元は銀行だけ');
    t.assert.snapshot(lines(`${out}\n${csvOut}`));
  });
  test('税・保険の見積もり: カード（未設定 / 設定済み）と設定画面（年は縦に並べる）', async (t) => {
    const m = await load('/src/money/Tax.tsx');
    const unset = html(m.TaxCard!, { tax: { profile: null, years: [], presets: taxData.presets, missing: ['profile'], last_run_at: null }, today: TODAY, busy: false, onOpen: noop, onRecalc: noop });
    const set = html(m.TaxCard!, { tax: { ...taxData, last_run_at: '2026-11-06T15:30:00.000Z' }, today: TODAY, busy: false, onOpen: noop, onRecalc: noop });
    assert.match(unset, /税・保険の見積もり[\s\S]*設定する/);
    assert.doesNotMatch(unset, /再計算/);
    assert.match(set, /2026 年分 所得 400万円 · 消費税 未設定 \/ 最終計算 11\/7/);
    const set20 = html(m.TaxCard!, { tax: { ...taxData, profile: { ...taxData.profile!, consumption_mode: 'special20' }, last_run_at: '2026-11-06T15:30:00.000Z' }, today: TODAY, busy: false, onOpen: noop, onRecalc: noop });
    assert.match(set20, /2026 年分 所得 400万円 · 消費税 2 割特例 \/ 最終計算 11\/7/);
    assert.match(set, /設定を開く[\s\S]*再計算/);
    const draft = taxProfileDraft(taxData.profile);
    const form = html(m.TaxForm!, { data: taxData, draft, years: taxYearDrafts(taxYears, TODAY), accounts: [account(), { ...wallet, active: false }], busy: false, error: null, dirty: false, onDraft: noop, onYears: noop, onSave: noop, onReset: noop });
    assert.match(form, /aria-pressed="true">65 万/);
    assert.match(form, /<legend>消費税の方式<\/legend>[\s\S]*>免税<\/button>[\s\S]*>2 割特例<\/button>[\s\S]*>簡易課税<\/button>[\s\S]*>本則<\/button>[\s\S]*<span class="m-sub">未設定<\/span>[\s\S]*2 割特例は 2026 年分まで/);
    assert.doesNotMatch(form.split('<legend>消費税の方式</legend>')[1]!.split('</fieldset>')[0]!, /aria-pressed="true"/, '未設定ならどれも選ばない');
    assert.doesNotMatch(form, /事業区分|売上の入力は税込/, '未設定なら事業区分もトグルも出さない');
    const simp = html(m.TaxForm!, { data: taxData, draft: { ...draft, consumption_mode: 'simplified', simplified_class: '' }, years: taxYearDrafts(taxYears, TODAY), accounts: [], busy: false, error: null, dirty: true, onDraft: noop, onYears: noop, onSave: noop, onReset: noop });
    assert.match(simp, /aria-pressed="true">簡易課税/);
    assert.doesNotMatch(simp, /<span class="m-sub">未設定<\/span>/);
    assert.doesNotMatch(simp, /2 割特例は 2026 年分まで/, '簡易課税なら 2 割特例の注記は出さない');
    assert.match(simp, /事業区分[\s\S]*<option value="">選んでください<\/option>[\s\S]*第 1 種 卸売 90%[\s\S]*第 6 種 不動産 40%[\s\S]*売上の入力は税込/);
    const s20 = html(m.TaxForm!, { data: taxData, draft: { ...draft, consumption_mode: 'special20' }, years: taxYearDrafts(taxYears, TODAY), accounts: [], busy: false, error: null, dirty: true, onDraft: noop, onYears: noop, onSave: noop, onReset: noop });
    assert.doesNotMatch(s20, /事業区分/);
    assert.match(s20, /売上の入力は税込/);
    assert.match(s20, /2 割特例は 2026 年分まで/);
    const ex = html(m.TaxForm!, { data: taxData, draft: { ...draft, consumption_mode: 'exempt' }, years: taxYearDrafts(taxYears, TODAY), accounts: [], busy: false, error: null, dirty: true, onDraft: noop, onYears: noop, onSave: noop, onReset: noop });
    assert.doesNotMatch(ex, /売上の入力は税込|事業区分|2 割特例は 2026 年分まで/, '免税ならトグルも注記も出さない');
    assert.match(form, /<option value="saitama-city-2026">さいたま市 令和 8 年度<\/option>/);
    assert.match(form, /aria-pressed="true">月払い/);
    assert.match(form, /<option value="A1">三井住友 普通<\/option>/);
    assert.doesNotMatch(form, /value="W1"/, '無効な口座は選べない');
    assert.match(form, /2025 年（確定）[\s\S]*所得税の申告納税額[\s\S]*value="180000"[\s\S]*2026 年（見込み）[\s\S]*2027 年（見込み）[\s\S]*2028 年（見込み）/);
    assert.doesNotMatch(form, /<table/, '年ごとの表は横のテーブルにしない');
    assert.match(form, /disabled>やめる/, '変えていなければ「やめる」は押せない');
    const bad = html(m.TaxForm!, { data: taxData, draft, years: taxYearDrafts(taxYears, TODAY), accounts: [], busy: false, error: '扶養の人数は 0〜20 で入れてください。', dirty: true, onDraft: noop, onYears: noop, onSave: noop, onReset: noop });
    assert.match(bad, /扶養の人数は 0〜20[\s\S]*disabled>保存して再計算/);
    const own = html(m.TaxForm!, {
      data: { ...taxData, profile: { ...taxData.profile!, nhi_preset: null, payment_account_id: 'W1' } },
      draft: { ...draft, nhi_preset: '', payment_account_id: 'W1' },
      years: taxYearDrafts([taxYear(2026, { revenue: 5000000, expenses: 350000 })], '2027-01-05'),
      accounts: [account(), { ...wallet, active: false }], busy: false, error: null, dirty: false, onDraft: noop, onYears: noop, onSave: noop, onReset: noop,
    });
    assert.match(own, /<option value="">（独自の料率）<\/option>/);
    assert.doesNotMatch(form, /独自の料率/);
    assert.match(own, /<option value="W1">PayPay<\/option>/, '今の納税口座は無効でも選択肢に残す');
    assert.match(own, /id="m-tax-2026-business_income" class="m-field" inputMode="numeric" placeholder="見込みの値（売上 − 経費）のまま"/);
    t.assert.snapshot(lines([unset, set, set20, form, simp].join('\n')));
  });

  test('税・保険の見積もり: 台帳の「 · 見積」「 · 手直し」、編集の注記と「自動計算に戻す」、見通しの月の「 · 見積」', async (t) => {
    const m = await load('/src/money/Schedule.tsx');
    const est = scheduled({ id: 'E1', name: '国民健康保険税 2026 年度 第 6 期（見積）', category: 'insurance', recurrence: 'once', amount: 51500, anchor_date: '2026-12-28', origin: 'estimate', estimate_key: 'nhi:2026:p6', pinned: 0 });
    const pin = scheduled({ id: 'E2', name: '所得税 2026 年分 確定申告（見積）', category: 'tax', recurrence: 'once', amount: 120000, anchor_date: '2027-03-15', origin: 'estimate', estimate_key: 'income_tax:2026:final', pinned: 1 });
    const pen = scheduled({ id: 'E3', name: '国民年金 2026 年度（見積）', category: 'insurance', recurrence: 'monthly', amount: 17510, anchor_date: '2026-04-30', end_date: '2027-03-31', origin: 'estimate', estimate_key: 'pension:2026', pinned: 0 });
    const ctax = scheduled({ id: 'E4', name: '消費税 2026 年分 確定申告（見積）', category: 'tax', recurrence: 'once', amount: 200000, anchor_date: '2027-03-31', origin: 'estimate', estimate_key: 'ctax:2026:final', pinned: 0 });
    const due = nextDueMap([up(est, '2026-12-28'), up(pin, '2027-03-15'), up(pen, '2026-11-30'), up(ctax, '2027-03-31')]);
    const out = [
      html(m.Ledger!, { items: [est, pin, pen, ctax, scheduled()], nextDue: due, today: TODAY, filter: '', showInactive: false, onFilter: noop, onShowInactive: noop, onOpen: noop }),
      html(m.ItemForm!, { draft: draftOf(est), editing: est, busy: false, onChange: noop, onSave: noop, onToggle: noop, onUnpin: noop, onClose: noop }),
      html(m.ItemForm!, { draft: draftOf(pin), editing: pin, busy: false, onChange: noop, onSave: noop, onToggle: noop, onUnpin: noop, onClose: noop }),
    ].join('\n');
    assert.match(out, /1 回 · 見積<\/span>/);
    assert.match(out, /1 回 · 見積 · 手直し<\/span>/);
    assert.match(out, /国民年金 2026 年度（見積）[\s\S]*?毎月 · 見積<\/span>/, '月払いの年金は「毎月 · 見積」');
    assert.match(out, /消費税 2026 年分 確定申告（見積）[\s\S]*?1 回 · 見積<\/span>/);
    assert.match(out, /毎年<\/span>/, '手入力の行には印を付けない');
    const [, f1, f2] = out.split('id="m-item-form"');
    assert.match(f1!, /金額や日付を直すと、再計算で上書きされなくなります。/);
    assert.doesNotMatch(f1!, /自動計算に戻す/);
    assert.match(f2!, /自動計算に戻す/);
    const c = await load('/src/money/Cashflow.tsx');
    const info = itemInfoMap([est, scheduled({ id: 'S1', category: 'car' })]);
    const ms = months36((i) => (i === 1 ? { items: [{ id: 'E1', name: est.name, amount: 51500, direction: 'out' as const, due: '2026-12-28', origin: 'estimate', estimate_key: 'nhi:2026:p6', pinned: 0 as const }, { id: 'S1', name: '自動車税', amount: 39500, direction: 'out' as const, due: '2026-12-31', origin: 'manual' }] } : {}));
    const cf = html(c.CashflowView!, { cf: { ...forecast, months: ms, first_shortfall_month: null, warnings: [{ kind: 'tax_profile_missing' }], cut_per_month_to_survive: null }, info, accounts: [], openYears: [0], onToggleYear: noop, onJump: noop, onMonthly: noop, onSchedule: noop, onAddIncome: noop });
    assert.match(cf, /第 6 期（見積） · 見積 51,500/);
    assert.match(cf, /自動車税 39,500/);
    assert.match(cf, /税・保険の見積もりが未設定です/);
    const row = cf.split('id="m-f-2026-12"')[1]!.split('</li>')[0]!;
    t.assert.snapshot(lines(`${out}\n${row}`));
  });

  test('税の試算: 入力（年・売上 ±100 万・方式と区分）、負担の表、方式の比較の 3 行（使えない方式は理由）', async (t) => {
    const m = await load('/src/money/TaxSim.tsx');
    const form = seedSimForm(emptySimForm(), simRes);
    const input = html(m.SimForm!, { today: TODAY, form, includesTax: true, more: true, onForm: noop, onMore: noop });
    assert.match(input, /売上（万円・税込）/);
    assert.match(input, /<option value="2026">2026 年<\/option>[\s\S]*<option value="2028">2028 年<\/option>/);
    assert.match(input, /第 5 種 サービス 50%/);
    assert.match(input, /placeholder="経費と同じ"/);
    const withSaving = { ...simRes, deductions: { ideco: 240000, kyosai: 0, saving: 72000 }, free_cash: 4290000, warnings: [{ kind: 'rates_assumed' as const, year: 2028, latest: 2026 }] };
    const out = html(m.TaxSimResult!, { res: withSaving, inputClass: 5, profileClass: 5 });
    assert.doesNotMatch(out, /個人事業税|免税/);
    assert.match(out, /2026 年分まで/);
    assert.match(out, /自由に使える額/);
    assert.match(out, /2028 年の税率・料率はまだ無い/);
    const best = html(m.TaxSimResult!, { res: simRes, inputClass: 1, profileClass: 5 });
    assert.match(out, /簡易（第 5 種）<span class="m-badge b-income m-sim-best">最安<\/span>/, '区分 5 の行に最安');
    assert.match(best, /簡易（第 1 種）<span class="m-badge b-income m-sim-best">最安<\/span>/);
    t.assert.snapshot(lines(`${input}\n${out}`));
  });

  test('不定額: 提案の「約」と金額の幅、台帳の「 · 概算」、見通しの月の「約」。積立のバッジ', async () => {
    const m = await load('/src/money/Schedule.tsx');
    const vc: Candidate = {
      ...candidate,
      id: 'R3',
      description_norm: 'テストでんき',
      amount: 12300,
      amount_kind: 'variable',
      occurrences_json: '[{"date":"2026-09-10","amount":8000},{"date":"2026-10-10","amount":15000},{"date":"2026-11-10","amount":12000}]',
    };
    const cards = html(m.CandidateList!, { items: [vc, candidate], accounts: [account()], today: TODAY, busy: false, onAccept: noop, onDismiss: noop });
    assert.match(cards, /約 12,300<span class="m-per"> \/ 毎月<\/span>/);
    assert.match(cards, /8,000〜15,000/);
    assert.equal((cards.match(/約 /g) ?? []).length, 1, '定額の提案には付けない');
    const v = scheduled({ id: 'V1', name: 'テストでんき', category: 'other', recurrence: 'monthly', amount: 12300, origin: 'detected', amount_kind: 'variable' });
    const sav = scheduled({ id: 'V2', name: 'テスト積立A', category: 'savings', recurrence: 'monthly', amount: 20000 });
    const ledger = html(m.Ledger!, { items: [v, sav], nextDue: {}, today: TODAY, filter: '', showInactive: false, onFilter: noop, onShowInactive: noop, onOpen: noop });
    assert.match(ledger, /毎月 · 明細から · 概算<\/span>/);
    assert.match(ledger, /<span class="m-badge b-savings">積立<\/span>/);
    assert.match(ledger, /aria-pressed="false">積立<\/button>/);
    const c = await load('/src/money/Cashflow.tsx');
    const ins = scheduled({ id: 'S2', category: 'insurance', recurrence: 'bimonthly' });
    const ms = months36((i) => (i === 1 ? { items: [{ id: 'S2', name: 'テスト保険', amount: 9000, direction: 'out' as const, due: '2026-12-20', origin: 'detected', amount_kind: 'variable' as const }] } : {}));
    const cf = html(c.CashflowView!, { cf: { ...forecast, months: ms, first_shortfall_month: null, warnings: [], cut_per_month_to_survive: null }, info: itemInfoMap([ins]), accounts: [], openYears: [0], onToggleYear: noop, onJump: noop, onMonthly: noop, onSchedule: noop, onAddIncome: noop });
    assert.match(cf.split('id="m-f-2026-12"')[1]!.split('</li>')[0]!, /テスト保険 約 9,000/);
  });

  test('大きな出費: 既定 3 件と「もっと見る」、ボタン 5 つ（suggested を accent、しないは幅いっぱい）、同じ摘要の回数と合計は 2 以上だけ。1 回だけのフォーム', async () => {
    const m = await load('/src/money/Schedule.tsx');
    const big = (i: number, over: Record<string, unknown> = {}) => ({
      bank_txn_id: `L${i}`,
      account_id: 'A1',
      account_name: 'テスト銀行',
      txn_date: `2026-0${9 - i}-10`,
      amount: 50_000 + i * 10_000,
      description: `テスト大口${i}（原文）`,
      description_norm: `テスト大口${i}`,
      same_desc_count: 1,
      total_amount: 50_000 + i * 10_000,
      first_date: `2026-0${9 - i}-10`,
      suggested: 'yearly',
      ...over,
    });
    const items = [big(1, { same_desc_count: 2, total_amount: 115_000 }), big(2, { suggested: 'biennial', txn_date: '2025-07-10' }), big(3), big(4)];
    const props = { items, today: TODAY, busy: false, onShowAll: noop, onSchedule: noop, onDismiss: noop };
    const out = html(m.LargeList!, { ...props, showAll: false });
    assert.match(out, /大きな出費（5 万円以上）（4）/);
    assert.equal((out.match(/<article /g) ?? []).length, 3);
    assert.match(out, /もっと見る（あと 1 件）/);
    assert.match(out, /<h3 class="m-h3">テスト大口1（原文）<\/h3>/, '名前は正規化前の摘要');
    assert.match(out, /テスト銀行 · 8\/10 · 同じ摘要 2 回 · 合計 115,000<\/p>/);
    assert.match(out, /テスト銀行 · 2025-07-10<\/p>/);
    const card2 = out.split('テスト大口2（原文）')[1]!.split('</article>')[0]!;
    assert.match(card2, /class="m-btn">毎年<\/button>/);
    assert.match(card2, /class="m-btn m-btn-accent">2 年ごと<\/button>/);
    assert.match(card2, /class="m-btn">毎月<\/button>/);
    assert.match(card2, />1 回だけ<\/button>[\s\S]*class="m-btn m-span2">しない<\/button>/);
    const card4 = html(m.LargeList!, { ...props, items: [big(4, { suggested: 'monthly', same_desc_count: 6 })], showAll: false });
    assert.match(card4, /class="m-btn m-btn-accent">毎月<\/button>/);
    assert.equal((card4.match(/m-btn-accent/g) ?? []).length, 1);
    const all = html(m.LargeList!, { ...props, showAll: true });
    assert.equal((all.match(/<article /g) ?? []).length, 4);
    assert.doesNotMatch(all, /もっと見る/);
    assert.doesNotMatch(html(m.LargeList!, { ...props, items: [], showAll: false }), /保険の年払い/);
    const form = html(m.ItemForm!, {
      draft: { ...emptyDraft(TODAY), name: 'テスト大口1（原文）', amount: '60000', recurrence: 'once', anchor_date: '' },
      editing: null,
      busy: false,
      onChange: noop,
      onSave: noop,
      onToggle: noop,
      onClose: noop,
      recurrences: ['once', 'monthly', 'yearly', 'biennial'],
    });
    assert.deepEqual([...form.matchAll(/<option value="(\w+)"/g)].map((x) => x[1]).filter((v) => ['once', 'monthly', 'bimonthly', 'quarterly', 'yearly', 'biennial'].includes(v!)), ['once', 'monthly', 'yearly', 'biennial']);
    assert.doesNotMatch(form, /何日前に知らせる|終わりの日|aria-label="向き"/);
    assert.match(form, /最初の支払日/);
  });

  test('経費: 合計・領収書待ちだけ・相手ごとの行（「その他」は押せない）', async (t) => {
    const m = await load('/src/money/Expenses.tsx');
    const all = html(m.ExpensesView!, { data: expenses, month: '2026-11', cats, waitingOnly: false, onWaiting: noop, onTxns: noop });
    const waiting = html(m.ExpensesView!, { data: expenses, month: '2026-11', cats, waitingOnly: true, onWaiting: noop, onTxns: noop });
    const none = html(m.ExpensesView!, { data: { ...expenses, total: { amount: 0, count: 0, waiting_count: 0, waiting_amount: 0 }, vendors: [] }, month: '2026-11', cats, waitingOnly: true, onWaiting: noop, onTxns: noop });
    assert.match(all, /<b>15,702<\/b>/);
    assert.match(all, /<b>2 件<\/b>[\s\S]*5,234 円/);
    assert.match(all, /aria-pressed="false">領収書待ちだけ（2）/);
    assert.match(all, /カ）エービーシー/);
    assert.match(all, /日用品<\/span>[\s\S]*待ち 1/);
    assert.match(all, /<div class="m-nav-row">[\s\S]*その他/, '「その他」は押せない');
    assert.doesNotMatch(waiting, /カ）エービーシー/, '待ちだけなら待ちの無い相手を隠す');
    assert.match(none, /領収書待ちはありません/);
    assert.match(html(m.YearBar!, { from: '2025-12', to: '2026-11', onMonth: noop }), /直近 12 か月<\/b><span class="m-sub">2025-12〜2026-11<\/span>[\s\S]*今月だけにする/);
    assert.match(html(m.ExpensesView!, { data: expenses, month: null, cats, waitingOnly: true, onWaiting: noop, onTxns: noop }), /aria-label="直近 12 か月の経費"/);
    t.assert.snapshot(lines([all, waiting, none].join('\n')));
  });

  test('明細の証憑: 行の印・経費の絞り込みのピル・シートの「証憑」の段', async (t) => {
    const m = await load('/src/money/Txns.tsx');
    const rows = [
      txn({ id: 'R1', receipt: 'matched' }),
      txn({ id: 'R2', receipt: 'pending_review' }),
      txn({ id: 'R3', receipt: 'candidate' }),
      txn({ id: 'R4', receipt: 'waiting' }),
      txn({ id: 'R5', tag: 'unset', category: null, receipt: null, receipt_hint: { document_id: 'D1', status: 'approved' } }),
    ];
    const ef = { period: 'month', month: '2026-11', accountId: '', tag: 'business', category: '', q: '', side: 'expense', excluded: '0', vendorKey: 'サンプルショウテン', vendorLabel: 'サンプル商店', receipt: 'waiting' };
    const sheet = (matches: unknown) =>
      html(m.TagSheet!, { txn: rows[2], draft: { tag: 'business', category: 'telecom', rule: false }, pos: { index: 0, total: 0 }, cats, saving: false, error: '', matches, matchBusy: false, onDraft: noop, onSave: noop, onClose: noop, onLink: noop, onUnlink: noop, onCapture: noop });
    const out = [
      html(m.TxnFilters!, { f: ef, q: '', expanded: false, unsetCount: '', accounts: [], cats, onChange: noop, onQ: noop, onExpand: noop }),
      html(m.TxnList!, { items: rows, f: ef, today: TODAY, more: false, cats, busyIds: [], hint: false, onHint: noop, onOpen: noop, onToggle: noop }),
      sheet({ links: [link(doc())], candidates: [{ document_id: 'D2', score: 95, date_diff: 0, vendor_match: 1, document: doc({ id: 'D2', status: 'needs_review', thumbnail_url: null }) }] }),
      sheet(null),
      sheet('error'),
      sheet({ links: [], candidates: [] }),
    ].join('\n');
    assert.match(out, /aria-label="経費 · サンプル商店 · 領収書待ちだけ。押すと外す"/);
    for (const [k, l] of [
      ['matched', '証憑'],
      ['pending_review', '確認待ち'],
      ['candidate', '候補'],
      ['waiting', '待ち'],
      ['hint', '証憑あり・未タグ'],
    ])
      assert.match(out, new RegExp(`m-rc m-rc-${k}">${l}<`));
    assert.match(out, /サンプル商店 · 11\/3 · 1,234 円<\/span>[\s\S]*外す/);
    assert.match(out, /候補（押すと紐付けます）[\s\S]*PDF<\/span>[\s\S]*確認前/);
    assert.match(out, /証憑を読めませんでした/);
    assert.match(out, /紐付いた証憑も候補もありません/);
    assert.match(out, /領収書を撮る・共有で入れる/);
    const plain = html(m.TagSheet!, { txn: rows[0], draft: { tag: 'business', category: null, rule: false }, pos: { index: 0, total: 0 }, cats, saving: false, error: '', onDraft: noop, onSave: noop, onClose: noop });
    assert.doesNotMatch(plain, /証憑<\/legend>/, '照合を渡さなければ段を出さない');
    t.assert.snapshot(lines(out));
  });
  test('「証憑」の段に注文の確認メールの手がかり（mail_hint）の 1 行。行の印は変えない', async () => {
    const m = await load('/src/money/Txns.tsx');
    const hint = { mail_message_id: 'M1', account_id: 'personal', received_on: '2026-11-03', from_domain: 'example.com', subject: 'ご注文の確認', order_ref: '123-0000000' };
    const row = txn({ id: 'R4', receipt: 'waiting', mail_hint: hint });
    const out = html(m.TagSheet!, { txn: row, draft: { tag: 'business', category: null, rule: false }, pos: { index: 0, total: 0 }, cats, saving: false, error: '', matches: { links: [], candidates: [] }, matchBusy: false, onDraft: noop, onSave: noop, onClose: noop, onCapture: noop });
    assert.match(out, /注文 #123-0000000 の確認メールあり（11\/3、example\.com）→ 注文履歴から領収書を保存して共有シートで入れてください/);
    const none = html(m.TagSheet!, { txn: txn({ id: 'R4', receipt: 'waiting' }), draft: { tag: 'business', category: null, rule: false }, pos: { index: 0, total: 0 }, cats, saving: false, error: '', matches: { links: [], candidates: [] }, matchBusy: false, onDraft: noop, onSave: noop, onClose: noop });
    assert.doesNotMatch(none, /確認メールあり/);
    const list = html(m.TxnList!, { items: [row], f: { period: 'this', accountId: '', tag: '', category: '', q: '' }, today: TODAY, more: false, cats, busyIds: [], hint: false, onHint: noop, onOpen: noop, onToggle: noop });
    assert.match(list, /m-rc m-rc-waiting">待ち</);
    assert.doesNotMatch(list, /確認メール/);
    assert.equal(mailHintText({ ...hint, order_ref: null, received_on: null, from_domain: null }), '注文の確認メールあり→ 注文履歴から領収書を保存して共有シートで入れてください');
    // 紐付けたら消える（待ち・候補の明細だけに付く）。
    assert.equal(applyMatches(row, { links: [link(doc())], candidates: [] }).mail_hint, null);
    assert.deepEqual(applyMatches(row, { links: [], candidates: [] }).mail_hint, hint);
  });

  test('ホーム: 経費の入口に領収書待ちの件数（0 なら件数を出さない）', async () => {
    const m = await load('/src/money/Home.tsx');
    const d = { o: { ...overview, receipt_waiting_count: 4 }, history: null, cf: null, months: [], upcoming: [], status: [] };
    const out = html(m.HomeView!, { today: TODAY, d, accounts: [], cats, go: noop });
    assert.match(out, /経費<\/span><span class="m-nav-sub m-warn-text">領収書待ち 4 件<\/span><\/span><span class="m-count">4<\/span>/);
    const zero = html(m.HomeView!, { today: TODAY, d: { ...d, o: { ...overview, receipt_waiting_count: 0 } }, accounts: [], cats, go: noop });
    assert.match(zero, /経費<\/span><span class="m-nav-sub">事業の支出を相手ごとに<\/span><\/span><svg/);
  });
});

const mailStatus = (over: Partial<MailStatus> = {}): MailStatus => ({
  enabled: true,
  provider: 'gmail_api',
  accounts: [
    { id: 'personal', label: 'keihi', last_run_at: null, last_ok_at: null, last_error: null, reauth_required: false, attention_count: 2 },
    { id: 'work', label: 'keihi', last_run_at: null, last_ok_at: null, last_error: null, reauth_required: false, attention_count: 1 },
  ],
  ...over,
});
const mailMsg = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'M1',
  account_id: 'personal',
  received_on: '2026-11-03',
  from_domain: 'example.com',
  subject: 'ご請求書のお知らせ',
  state: 'unsupported',
  error_reason: null,
  attempts: 0,
  attachments: [{ filename: 'invoice.xlsx', result: 'unsupported', document_id: null }],
  hint: null,
  ...over,
});

describe('メールの取り込みの純関数', () => {
  test('要対応の件数はアカウントの合計。無効・読めないなら 0', () => {
    assert.equal(mailAttention(mailStatus()), 3);
    assert.equal(mailAttention(mailStatus({ enabled: false })), 0);
    assert.equal(mailAttention(mailStatus({ accounts: [] })), 0);
    assert.equal(mailAttention(null), 0);
    assert.equal(mailAttention(undefined), 0);
    assert.equal(mailAttentionText(3), 'メールの要対応 3 件');
    assert.equal(MAIL_ATTENTION_URL, '/api/mail/messages?state=attention&limit=100');
  });
  test('状態と添付の文', () => {
    assert.equal(mailStateText(mailMsg()), '未対応の形式');
    assert.equal(mailStateText(mailMsg({ state: 'body_only' })), '添付なし');
    assert.equal(mailStateText(mailMsg({ state: 'too_large' })), '大きすぎる');
    assert.equal(mailStateText(mailMsg({ state: 'error', error_reason: 'fetch_failed', attempts: 3 })), '取得に失敗（3 回）');
    assert.equal(mailStateText(mailMsg({ state: 'error', error_reason: 'parse_failed', attempts: 4 })), '解析に失敗（4 回）');
    assert.equal(mailStateText(mailMsg({ state: 'error', error_reason: null, attempts: 3 })), '失敗（3 回）');
    assert.equal(mailAttachmentText({ filename: 'invoice.pdf', result: 'ingested', document_id: 'D1' }), 'invoice.pdf: 取り込み済み');
    assert.equal(mailAttachmentText({ filename: 'a.pdf', result: 'duplicate', document_id: 'D1' }), 'a.pdf: 取り込み済み（重複）');
    assert.equal(mailAttachmentText({ filename: null, result: 'too_large', document_id: null }), '名前なし: 大きすぎる');
  });
  test('今すぐ取り込むの結果の文', () => {
    assert.equal(mailSyncText(200, { accounts: [{ account_id: 'personal', job_id: 'J1', created: false }, { account_id: 'work', job_id: 'J2', created: true }] }), '取り込みを始めました。しばらくしてから読み直してください。');
    assert.equal(mailSyncText(200, { accounts: [{ account_id: 'personal', job_id: 'J1', created: false }] }), '実行中か、10 分以内に実行済みです。');
    assert.equal(mailSyncText(200, { accounts: [] }), '実行中か、10 分以内に実行済みです。');
    assert.equal(mailSyncText(409, { reason: 'mail_disabled' }), 'メールの取り込みは無効です（config.toml の [mail] enabled）。');
    assert.equal(mailSyncText(0, null), failText(0));
    assert.equal(mailSyncText(500, null), 'サーバーから読めませんでした（HTTP 500）');
  });
});

describe('SSR スナップショット（メール）', () => {
  let vite: ViteDevServer;
  const load = (p: string) => vite.ssrLoadModule(p) as Promise<Record<string, (props: any) => unknown>>;
  before(async () => {
    vite = await startSsr();
  });
  after(async () => {
    await vite.close();
  });
  const html = (c: (props: never) => unknown, props: object) => pretty(renderHtml(h(c as never, props as never)));

  test('ホーム: 要対応があれば入口に「メールの要対応 n 件」。無効・0 件・読めないときは出さない', async () => {
    const m = await load('/src/money/Home.tsx');
    const d = { o: overview, history: null, cf: null, months: [], upcoming: [], status: [] };
    const out = html(m.HomeView!, { today: TODAY, d: { ...d, mail: mailStatus() }, accounts: [], cats, go: noop });
    assert.match(out, /メール<\/span><span class="m-nav-sub m-warn-text">メールの要対応 3 件<\/span><\/span><span class="m-count">3<\/span>/);
    for (const mail of [mailStatus({ enabled: false }), mailStatus({ accounts: [] }), null, undefined]) {
      assert.doesNotMatch(html(m.HomeView!, { today: TODAY, d: { ...d, mail }, accounts: [], cats, go: noop }), /メールの要対応/);
    }
  });

  test('要対応のメールの一覧: 今すぐ取り込む・受信日・送信元・件名・状態・添付', async (t) => {
    const m = await load('/src/money/Mail.tsx');
    const items = [
      mailMsg(),
      mailMsg({ id: 'M2', received_on: '2025-12-28', from_domain: 'example.net', subject: null, state: 'error', error_reason: 'fetch_failed', attempts: 3, attachments: [] }),
      mailMsg({ id: 'M3', received_on: null, from_domain: null, state: 'body_only', attachments: [] }),
      mailMsg({ id: 'M4', state: 'too_large', attachments: [{ filename: 'scan.pdf', result: 'too_large', document_id: null }, { filename: 'note.pdf', result: 'ingested', document_id: 'D9' }] }),
    ];
    const out = html(m.MailView!, { page: { items, next_cursor: null }, today: TODAY, busy: false, onSync: noop });
    const more = html(m.MailView!, { page: { items: items.slice(0, 1), next_cursor: 'c1' }, today: TODAY, busy: true, onSync: noop });
    const none = html(m.MailView!, { page: { items: [], next_cursor: null }, today: TODAY, busy: false, onSync: noop });
    t.assert.snapshot(lines([out, more, none].join('\n')));
    assert.match(none, /要対応のメールはありません。/);
    assert.match(more, /<button type="button" class="m-btn" disabled>今すぐ取り込む/);
  });
});
