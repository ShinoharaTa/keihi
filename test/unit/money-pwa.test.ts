// PWA の「お金」タブ（docs/mvp-plan-v3.md T111・T304。UI はモック 7 画面）。純関数（グラフの座標・年の折りたたみ・帯の配分・結論の文など）と、
// 各画面の描画だけの部品の SSR スナップショット。
// スナップショットは money-pwa.test.ts.snapshot。描画を変えたら `node --test --test-update-snapshots test/unit/money-pwa.test.ts` で作り直して差分を見る。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import type { ViteDevServer } from 'vite';
import { areaPoints, lineChart, niceTicks, pairBars, pct, spans, stackBars, xAt, yScale, type Plot } from '../../pwa/src/money/chart.ts';
import {
  accountPatch,
  addMonth,
  applyRuleLocally,
  applyTag,
  candidateNext,
  cardsOutstanding,
  categoryRows,
  dateShort,
  dayLabel,
  dayOfMonth,
  daysBetween,
  draftBody,
  draftError,
  emptyDraft,
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
  noIncome,
  notableDiff,
  notices,
  occurrenceCount,
  overviewFallback,
  parseYen,
  peakMonths,
  periodRange,
  periodText,
  RECURRENCES,
  settlementChoices,
  shortTime,
  signedMan,
  spendBand,
  syncErrorCount,
  syncText,
  tagShares,
  txnIncome,
  txnSummary,
  txnsUrl,
  unsetPosition,
  verdict,
  warningText,
  yearGroups,
  yearSummary,
  yen,
  type Account,
  type BankStatus,
  type Candidate,
  type Categories,
  type Forecast,
  type ForecastMonth,
  type MonthlySummary,
  type Overview,
  type ScheduledItem,
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
    assert.equal(man(0), '0万');
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
    const o = overviewFallback({ today: TODAY, accounts: [account(), card, bareCard, wallet], cf: forecast, month: monthly('2026-11', 0, 52000), untagged: 12, candidates: 3, lastOkAt: '2026-11-06T00:12:00.000Z' })!;
    assert.equal(o.available, 1234567 - 300000);
    assert.deepEqual(o.balances.by_account.map((a) => a.account_id), ['A1']);
    assert.deepEqual(o.cards_without_settlement, [{ account_id: 'C2', name: 'PayPay カード' }]);
    assert.deepEqual(o.this_month, { month: '2026-11', income: 0, expense: 52000, planned_out_remaining: 39500, unplanned_out_estimate: 140000, projected_end_balance: 1055067 });
    assert.equal(overviewFallback({ today: TODAY, accounts: [], cf: null, month: null, untagged: 0, candidates: 0, lastOkAt: null }), null);
  });
  test('確認すること: 引落元 → 提案 → 未設定 → 収入なし', () => {
    const o = overviewFallback({ today: TODAY, accounts: [bareCard], cf: forecast, month: null, untagged: 4, candidates: 2, lastOkAt: null })!;
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
    assert.deepEqual(cardsOutstanding([account(), card, bareCard]), [{ name: '楽天カード', amount: 294061 }]);
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
      months: [monthly('2026-09', 650000, 600000), monthly('2026-10', 680000, 700000, 98000)],
      upcoming: [up(scheduled({ id: 'L1', name: '生命保険', amount: 12300, category: 'insurance' }), '2026-11-27')],
      status,
    };
    const out = html(m.HomeView!, { today: TODAY, d, accounts: [account(), card, bareCard, wallet], cats, go: noop });
    assert.match(out, /830,000<small>円/);
    assert.match(out, /残高の合計（1 口座）/, '残高の無いカードは数えない');
    assert.match(out, /楽天カードの未引落 294,061 円/);
    assert.match(out, /11 月の進み[\s\S]*6 日目 \/ 30 日/);
    assert.match(out, /見込み 680,000/);
    assert.match(out, /width="26.4"/);
    assert.match(out, /確認すること（3）/);
    assert.match(out, /PayPay カード の引落元が未設定/);
    assert.match(out, /10 月の差額 −20,000（税金が平均より多い）/);
    assert.match(out, /2027-01 に残す額を下回る見込み/);
    assert.match(out, /次: 11\/27 生命保険 12,300/);
    assert.match(out, /同期エラー 1 件・PayPay の CSV は 10\/31 が最後/);
    assert.match(out, /<polyline class="c-line"/);
    const bare = html(m.HomeView!, { today: TODAY, d: { o: null, history: null, cf: null, months: [], upcoming: [], status: [] }, accounts: [], cats, go: noop });
    assert.match(bare, /残高を読めませんでした/);
    assert.doesNotMatch(bare, /<svg class="m-svg"/, '推移が無ければ隠す');
    t.assert.snapshot(lines(out));
  });

  test('画面の上の帯（戻る・題・右端）', async (t) => {
    const m = await load('/src/money/Money.tsx');
    const out = [html(m.ScreenHead!, { title: '見通し', sub: '36 か月 · 2026-11〜2029-10', onBack: noop }), html(m.ScreenHead!, { title: '予定', locked: true, flat: true, onBack: noop })].join('\n');
    assert.match(out, /aria-label="お金に戻る" disabled/);
    t.assert.snapshot(lines(out));
  });

  test('月次: 月の切り替え・合計・カテゴリ別の横棒・事業/私用・集計外・6 か月の棒', async (t) => {
    const m = await load('/src/money/Monthly.tsx');
    const ms = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((x, i) => monthly(x, 680000, [612000, 745000, 650000, 735000, 648000, 700000][i]!, x === '2026-10' ? 98000 : 46000));
    const out = [
      html(m.MonthBar!, { month: '2026-10', today: TODAY, onSelect: noop }),
      html(m.MonthBar!, { month: '2026-11', today: TODAY, onSelect: noop }),
      html(m.MonthlyView!, { months: ms, selected: '2026-10', cats, uncat: { n: 100, more: true }, unset: { n: 23, more: false }, onSelect: noop, onTxns: noop }),
    ].join('\n');
    assert.match(out, /締まった月/);
    assert.match(out, /aria-label="次の月（12 月）" disabled/);
    assert.ok(out.indexOf('税金') < out.indexOf('通信'), 'カテゴリ別は支出の大きい順');
    assert.match(out, /class="d up strong">\+43,333</);
    assert.match(out, /100\+ 件を分類する/);
    assert.match(out, /未設定の 23 件をタグ付け/);
    assert.match(out, /カード引落<span class="m-sub13"> · 1 件/);
    assert.match(out, /class="f-sel"/);
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
      html(m.CandidateList!, { items: [candidate, { ...candidate, id: 'R2', description_norm: 'JAF 年会費', amount: 4000, interval: 'yearly', account_id: 'A1', occurrences_json: '[{"date":"2024-12-10","amount":4000},{"date":"2025-12-10","amount":4000}]' }], accounts: [account(), card], today: TODAY, busy: false, onAccept: noop, onDismiss: noop }),
      html(m.PeakCard!, { peaks, fixed: monthlyFixed([life, ntt, sales]) }),
      html(m.Ledger!, { items: [tax, ins, life, sales, ntt, off], nextDue: due, today: TODAY, filter: '', showInactive: false, onFilter: noop, onShowInactive: noop, onOpen: noop }),
      html(m.Ledger!, { items: [tax, ins, life, off], nextDue: due, today: TODAY, filter: 'insurance', showInactive: true, onFilter: noop, onShowInactive: noop, onOpen: noop }),
      html(m.ItemForm!, { draft: emptyDraft(TODAY), editing: null, busy: false, onChange: noop, onSave: noop, onToggle: noop, onClose: noop }),
      html(m.ItemForm!, { draft: { ...emptyDraft(TODAY), name: '国民健康保険', amount: '68000', category: 'insurance', recurrence: 'quarterly' }, editing: ins, busy: false, onChange: noop, onSave: noop, onToggle: noop, onClose: noop }),
    ].join('\n');
    assert.match(out, /予定にする（その他）/);
    assert.match(out, /楽天カード · 最後 10\/15（2 回） · 次は 11\/15 ごろ/);
    assert.match(out, /三井住友 普通 · 最後 2025-12-10（2 回） · 次は 12\/10 ごろ/);
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

  test('口座: 引落元が未設定のカードはその場で直す、設定を開いたカード、CSV は準備中', async (t) => {
    const m = await load('/src/money/Accounts.tsx');
    const mm = await load('/src/money/model.ts');
    const withStatus = mm.withStatus as unknown as (a: Account[], s: BankStatus[]) => unknown[];
    const accounts = [account(), card, wallet, bareCard];
    const draft = { default_tag: 'unset', include_in_cashflow: true, mcp_visibility: 'summary', active: true, card_settlement_account_id: 'A1', card_settlement_pattern: 'ラクテンカード' };
    const out = [
      html(m.AccountsView!, { rows: withStatus(accounts, status), today: TODAY, accounts, edit: { id: 'C1', draft, open: true }, busy: false, onOpen: noop, onDraft: noop, onSave: noop }),
      html(m.AccountsView!, { rows: withStatus([wallet], status), today: TODAY, accounts: [wallet], edit: { id: 'W1', draft: { ...draft, default_tag: 'private', mcp_visibility: 'none', include_in_cashflow: false }, open: true }, busy: false, onOpen: noop, onDraft: noop, onSave: noop }),
    ].join('\n');
    assert.ok(out.indexOf('PayPay カード') < out.indexOf('三井住友 普通'), '引落元が未設定のカードを先に');
    assert.match(out, /引落元が未設定です。[\s\S]*保存して二重計上を直す/);
    assert.match(out, /同期エラー: freee_http_503/);
    assert.match(out, /過去分 2024-11 まで済み/);
    assert.match(out, /CSV · 最後の取り込み 10\/31/);
    assert.match(out, /CSV を取り込む（準備中）/);
    assert.match(out, /見せない<\/button>[\s\S]*合計だけ<\/button>[\s\S]*明細も<\/button>/);
    assert.doesNotMatch(out.split('aria-expanded="true"')[1]!.split('</article>')[0]!, /value="W1"/, '引落元は銀行だけ');
    t.assert.snapshot(lines(out));
  });
});
