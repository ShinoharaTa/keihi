// PWA の「お金」タブ（docs/mvp-plan-v3.md T111・T304）。純関数と、各画面の描画だけの部品の SSR スナップショット。
// スナップショットは money-pwa.test.ts.snapshot。描画を変えたら `node --test --test-update-snapshots test/unit/money-pwa.test.ts` で作り直して差分を見る。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import type { ViteDevServer } from 'vite';
import {
  accountPatch,
  addMonth,
  applyTag,
  draftBody,
  emptyDraft,
  lastOccurrence,
  monthlyUrl,
  nextDueMap,
  parseYen,
  periodRange,
  syncText,
  categoryRows,
  draftError,
  failText,
  filterCount,
  guessCategory,
  lowestMonth,
  nextUnset,
  noIncome,
  settlementChoices,
  setupSteps,
  txnSummary,
  txnsUrl,
  warningText,
  yen,
  type Account,
  type BankStatus,
  type Candidate,
  type Categories,
  type Forecast,
  type MonthlySummary,
  type ScheduledItem,
  type Txn,
} from '../../pwa/src/money/model.ts';
import { lines, pretty, renderHtml, startSsr } from './pwa-ssr-helpers.ts';

process.env.TZ = 'Asia/Tokyo';
const TODAY = '2026-11-06';
const noop = () => {};

const cats: Categories = {
  items: [
    { id: 'food', label: '食費' },
    { id: 'telecom', label: '通信' },
    { id: 'tax', label: '税金' },
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
const card = account({ id: 'C1', name: '楽天カード', kind: 'card', latest_balance: null, include_in_cashflow: true, card_settlement_account_id: 'A1', card_settlement_pattern: 'ラクテンカード' });
const wallet = account({ id: 'W1', name: 'PayPay', kind: 'paypay', include_in_cashflow: false, default_tag: 'private', mcp_visibility: 'none', latest_balance: { as_of_date: '2026-10-20', balance: 3000, source: 'manual' } });

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

describe('純関数', () => {
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
  test('明細の URL: 絞り込み・未分類は none・空の検索語は送らない・cursor', () => {
    const f = { period: 'this' as const, accountId: 'A1', tag: 'private' as const, category: 'none', q: '  ' };
    assert.equal(txnsUrl(f, TODAY, null), '/api/bank_txns?limit=50&from=2026-11-01&to=2026-11-06&account_id=A1&tag=private&category=none');
    assert.equal(txnsUrl({ period: 'all', accountId: '', tag: '', category: '', q: ' ドコモ ' }, TODAY, 'abc'), '/api/bank_txns?limit=50&q=%E3%83%89%E3%82%B3%E3%83%A2&cursor=abc');
  });
  test('タグの保存結果（effective）で行を差し替える', () => {
    const out = applyTag([txn(), txn({ id: 'T2' })], 'T2', { effective: { tag: 'private', category: null, source: 'override' } });
    assert.equal(out[0]!.tag, 'business');
    assert.deepEqual([out[1]!.tag, out[1]!.category, out[1]!.tag_source], ['private', null, 'override']);
  });
  test('月次は直近 6 か月', () => {
    assert.equal(monthlyUrl(TODAY), '/api/summary/monthly?from=2026-06&to=2026-11');
    assert.equal(monthlyUrl('2026-03-01'), '/api/summary/monthly?from=2025-10&to=2026-03');
  });
  test('候補の最後の出現と、台帳の次の期日', () => {
    const c = { occurrences_json: '[{"date":"2026-08-27","amount":1},{"date":"2026-10-27","amount":1},{"date":"2026-09-27","amount":1}]' } as Candidate;
    assert.equal(lastOccurrence(c), '2026-10-27');
    assert.equal(lastOccurrence({ occurrences_json: 'x' } as Candidate), null);
    assert.deepEqual(nextDueMap([{ id: 'a', due_date: '2026-11-10' }, { id: 'b', due_date: '2026-11-20' }, { id: 'a', due_date: '2026-12-10' }]), { a: '2026-11-10', b: '2026-11-20' });
  });
  test('予定の本文: 金額・名称・日数を確かめる。支出に収入の分類は付けない', () => {
    const d = { ...emptyDraft(TODAY), name: ' 自動車税 ', amount: '３９,５００円' };
    assert.deepEqual(draftBody(d), {
      name: '自動車税',
      amount: 39500,
      direction: 'out',
      category: 'other',
      recurrence: 'monthly',
      anchor_date: TODAY,
      end_date: null,
      notify_days_before: 14,
    });
    assert.equal(draftBody({ ...d, amount: '0' }), null);
    assert.equal(draftBody({ ...d, name: ' ' }), null);
    assert.equal(draftBody({ ...d, notify_days_before: '-1' }), null);
    assert.equal(draftBody({ ...d, category: 'income' }), null);
    assert.equal(draftBody({ ...d, direction: 'in', category: 'income', end_date: '2027-03-31' })?.end_date, '2027-03-31');
    assert.equal(parseYen('1.5'), null);
  });
  test('口座の PATCH は変わった項目だけ。カード以外は引落の設定を送らない', () => {
    const base = { default_tag: card.default_tag, include_in_cashflow: true, mcp_visibility: card.mcp_visibility, active: true, card_settlement_account_id: 'A1', card_settlement_pattern: 'ラクテンカード' };
    assert.deepEqual(accountPatch(card, base), {});
    assert.deepEqual(accountPatch(card, { ...base, default_tag: 'business', card_settlement_account_id: '', card_settlement_pattern: ' ' }), {
      default_tag: 'business',
      card_settlement_account_id: null,
      card_settlement_pattern: null,
    });
    assert.deepEqual(accountPatch(account(), { ...base, card_settlement_account_id: 'X', include_in_cashflow: false }), { include_in_cashflow: false });
  });
  test('同期の結果と、資金繰りの警告の文', () => {
    assert.equal(syncText(false), '実行中か、10 分以内に実行済みです。');
    const name = (id: string) => (id === 'A1' ? '三井住友 普通' : id);
    assert.equal(warningText({ kind: 'no_balance', account_id: 'A1' }, name), '三井住友 普通 の残高がありません（0 円として計算しています）。');
    assert.equal(warningText({ kind: 'stale_balance', account_id: 'A1', as_of_date: '2026-10-20' }, name), '三井住友 普通 の残高が 2026-10-20 から更新されていません。');
    assert.match(warningText({ kind: 'short_history', months_available: 2 }, name), /2 か月分しかない/);
    assert.match(warningText({ kind: 'short_history', months_available: 0 }, name), /0 円にしています/);
  });
});

describe('レビューで足した純関数', () => {
  test('failText は 400 の理由を日本語に。知らないコードはそのまま', () => {
    assert.equal(failText(400, { error: 'invalid_q' }), '検索語が短すぎるか、法人格だけです。');
    assert.equal(failText(400, { error: 'weird_code' }), '受け付けられませんでした（weird_code）');
    assert.match(failText(500, null), /HTTP 500/);
    assert.match(failText(0), /通信できません/);
  });
  test('月を指定した期間・絞り込みの数・件数と支出の合計（集計外は数えない）', () => {
    const f = { period: 'month' as const, month: '2026-02', accountId: '', tag: '' as const, category: 'food', q: ' ' };
    assert.equal(txnsUrl(f, TODAY, null), '/api/bank_txns?limit=50&from=2026-02-01&to=2026-02-28&category=food');
    assert.equal(filterCount(f), 1);
    assert.deepEqual(txnSummary([txn(), txn({ id: 'T2', side: 'income', amount: 5 }), txn({ id: 'T3', amount: 100, excluded: true })]), { count: 3, expense: 1980 });
  });
  test('次の未設定の明細（今の行より下）', () => {
    const xs = [txn({ id: 'a', tag: 'unset' }), txn({ id: 'b' }), txn({ id: 'c' }), txn({ id: 'd', tag: 'unset' })];
    assert.equal(nextUnset(xs, 'b')?.id, 'd');
    assert.equal(nextUnset(xs, 'd'), null);
  });
  test('カテゴリ別は支出の大きい順で、取った月の平均との差（無い月は 0）', () => {
    const m = (month: string, rows: [string | null, number][]) => ({ ...monthlyEmpty(month), by_category: rows.map(([category, expense]) => ({ category, income: 0, expense })) });
    const rows = categoryRows([m('2026-10', [['food', 30000]]), m('2026-11', [['food', 50000], ['tax', 90000]])], '2026-11');
    assert.deepEqual(rows.map((r) => [r.category, r.diff]), [['tax', 45000], ['food', 10000]]);
  });
  test('提案の分類の初期値を摘要から推す（半角カナも）', () => {
    assert.equal(guessCategory('ｿﾝﾎﾟｼﾞｬﾊﾟﾝ'), 'insurance');
    assert.equal(guessCategory('ニッセイ生命'), 'insurance');
    assert.equal(guessCategory('国保'), 'tax');
    assert.equal(guessCategory('ｼﾞﾄﾞｳｼｬｾﾞｲ'), 'tax');
    assert.equal(guessCategory('三井のリパーク駐車場'), 'car');
    assert.equal(guessCategory('ネットフリックス'), 'other');
  });
  test('予定の下書きの検証（日数 0〜365・終わり ≥ 最初・名称 200 文字まで）', () => {
    const d = { ...emptyDraft(TODAY), name: '税', amount: '100' };
    assert.equal(draftError(d), null);
    assert.equal(draftError({ ...d, notify_days_before: '0' }), null);
    assert.match(draftError({ ...d, notify_days_before: '366' })!, /0〜365/);
    assert.match(draftError({ ...d, end_date: '2026-11-05' })!, /最初の支払日より後/);
    assert.equal(draftError({ ...d, end_date: TODAY }), null);
    assert.match(draftError({ ...d, name: 'あ'.repeat(201) })!, /200 文字/);
    assert.equal(emptyDraft(TODAY, 'in').category, 'income');
  });
  test('資金繰り: 収入の予定が無い・いちばん少ない月', () => {
    assert.equal(noIncome(forecast), false);
    assert.equal(noIncome({ ...forecast, months: forecast.months.map((x) => ({ ...x, planned_in: 0 })) }), true);
    assert.equal(lowestMonth(forecast)?.month, '2027-01');
  });
  test('引落元に選べるのは銀行だけ。はじめにの手順は済んだものを出さない', () => {
    assert.deepEqual(settlementChoices([account(), card, wallet]).map((a) => a.id), ['A1']);
    const bare = account({ id: 'C2', kind: 'card', card_settlement_account_id: null });
    const steps = setupSteps({ accounts: [account(), bare], items: [], candidates: 2, unset: { count: 100, more: true } });
    assert.deepEqual(steps.map((s) => s.kind), ['card_settlement', 'income', 'candidates', 'unset_tags']);
    assert.deepEqual(setupSteps({ accounts: [account(), card], items: [scheduled({ direction: 'in', category: 'income' })], candidates: 0, unset: { count: 0, more: false } }), []);
    assert.deepEqual(setupSteps({ accounts: [], items: null, candidates: 0, unset: null }), [], '読めていないものは出さない');
  });
});

// ---- SSR スナップショット ----

const monthlyEmpty = (month: string): MonthlySummary => ({ month, by_account: [], by_category: [], by_tag: [], total: { income: 0, expense: 0, net: 0 }, excluded: [] });
const monthly = (month: string, income: number, expense: number): MonthlySummary => ({
  month,
  by_account: [
    { account_id: 'A1', name: '三井住友 普通', include_in_cashflow: true, active: true, income, expense: expense - 3000, net: income - expense + 3000 },
    { account_id: 'W1', name: 'PayPay', include_in_cashflow: false, active: true, income: 0, expense: 3000, net: -3000 },
  ],
  by_category: [
    { category: 'telecom', income: 0, expense: 1980 },
    { category: null, income, expense: expense - 1980 },
  ],
  by_tag: [
    { tag: 'business', income, expense: 1980 },
    { tag: 'unset', income: 0, expense: expense - 1980 },
  ],
  total: { income, expense, net: income - expense },
  excluded: [{ kind: 'card_settlement', count: 1, income: 0, expense: 45000 }],
});

const forecast: Forecast = {
  as_of: TODAY,
  opening_balance: 1234567,
  reserve: 300000,
  unplanned_out_per_month: 180000,
  unplanned_in_per_month: 0,
  months: [
    { month: '2026-11', planned_in: 0, planned_out: 39500, unplanned_in: 0, unplanned_out: 140000, balance_end: 1055067, reserve: 300000, margin: 755067, items: [{ id: 'S1', name: '自動車税', amount: 39500, direction: 'out', due: '2026-11-30' }] },
    { month: '2026-12', planned_in: 500000, planned_out: 0, unplanned_in: 0, unplanned_out: 180000, balance_end: 1375067, reserve: 300000, margin: 1075067, items: [] },
    { month: '2027-01', planned_in: 0, planned_out: 1500000, unplanned_in: 0, unplanned_out: 180000, balance_end: -304933, reserve: 0, margin: -304933, items: [{ id: 'S2', name: '所得税（予定納税）', amount: 1500000, direction: 'out', due: '2027-01-31' }] },
  ],
  first_shortfall_month: '2027-01',
  warnings: [
    { kind: 'stale_balance', account_id: 'W1', as_of_date: '2026-10-20' },
    { kind: 'short_history', months_available: 2 },
  ],
};

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
const candidate: Candidate = {
  id: 'R1',
  account_id: 'A1',
  description_norm: 'ニッセイ',
  amount: 12000,
  interval: 'monthly',
  occurrences_json: '[{"date":"2026-09-27","amount":12000},{"date":"2026-10-27","amount":12000}]',
  state: 'open',
};
const status: BankStatus[] = [
  { account_id: 'A1', name: '三井住友 普通', kind: 'bank', source: 'freee', active: true, last_sync_at: '2026-11-06T00:00:00.000Z', last_ok_at: '2026-11-06T00:00:00.000Z', last_error: null, last_csv_at: null, backfill_done_until: '2025-11-01' },
  { account_id: 'C1', name: '楽天カード', kind: 'card', source: 'freee', active: true, last_sync_at: '2026-11-06T01:00:00.000Z', last_ok_at: '2026-11-05T00:00:00.000Z', last_error: 'freee_http_503', last_csv_at: null, backfill_done_until: null },
];

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

  test('お金タブのセグメント（フォーム中は他を押せない）と「はじめに」', async (t) => {
    const m = await load('/src/money/Money.tsx');
    const steps = [
      { kind: 'card_settlement', count: 1, accountId: 'C2' },
      { kind: 'income', count: 0 },
      { kind: 'candidates', count: 2 },
      { kind: 'unset_tags', count: 100, more: true },
    ];
    const out = [
      html(m.MoneySeg!, { view: 'cashflow', locked: false, onView: noop }),
      html(m.MoneySeg!, { view: 'schedule', locked: true, onView: noop }),
      html(m.SetupCard!, { steps, onStep: noop }),
    ].join('\n');
    assert.equal(html(m.SetupCard!, { steps: [], onStep: noop }), '');
    assert.equal((out.match(/disabled/g) ?? []).length, 4);
    t.assert.snapshot(lines(out));
  });

  test('明細: 絞り込み・行（支出/収入/振替）・タグのシート', async (t) => {
    const m = await load('/src/money/Txns.tsx');
    const rows = [
      txn(),
      txn({ id: 'T2', side: 'income', amount: 300000, description: '振込 カ）エービーシー', tag: 'unset', category: null }),
      txn({ id: 'T3', amount: 45000, description: 'ラクテンカード', excluded: true, transfer_kind: 'card_settlement', tag: 'private', category: null }),
    ];
    const out = [
      html(m.TxnFilters!, { f: { period: 'last', accountId: 'A1', tag: '', category: 'none', q: 'ドコモ' }, q: 'ドコ', expanded: true, accounts: [account(), card], cats, onChange: noop, onQ: noop, onExpand: noop }),
      html(m.TxnFilters!, { f: { period: 'month', month: '2026-10', accountId: '', tag: '', category: 'food', q: '' }, q: '', expanded: false, accounts: [], cats, onChange: noop, onQ: noop, onExpand: noop }),
      html(m.TxnRows!, { items: rows, more: true, cats, onOpen: noop }),
      html(m.TagSheet!, { txn: rows[0], category: 'telecom', cats, saving: false, error: '通信できません。', onTag: noop, onCategory: noop, onClose: noop }),
    ].join('\n');
    assert.match(out, /class="num out">−1,980</);
    assert.match(out, /class="num in">\+300,000</);
    assert.match(out, /txn-excluded[\s\S]*集計外[\s\S]*引落/);
    assert.match(out, /絞り込み（3）/);
    assert.match(out, /class="scrim"/);
    t.assert.snapshot(lines(out));
  });

  test('月次: 月のカードと、口座別（資金繰り対象外は区切りの下）・カテゴリ別・事業/私用・除外', async (t) => {
    const m = await load('/src/money/Monthly.tsx');
    const out = html(m.MonthlyView!, { months: [monthly('2026-10', 500000, 230000), monthly('2026-11', 0, 52000)], selected: '2026-11', cats, onSelect: noop, onCategory: noop });
    const div = out.indexOf('資金繰り対象外');
    assert.ok(div > out.indexOf('三井住友 普通') && div < out.indexOf('PayPay'));
    assert.ok(out.indexOf('2026-11') < out.indexOf('2026-10'), '新しい月が先');
    assert.ok(out.indexOf('未分類') < out.indexOf('通信'), 'カテゴリ別は支出の大きい順');
    t.assert.snapshot(lines(out));
  });

  test('予定: 提案（追加の確認中と通常）と台帳（停止中を含む）、追加・編集のフォーム', async (t) => {
    const m = await load('/src/money/Schedule.tsx');
    const out = [
      html(m.CandidateList!, { items: [candidate, { ...candidate, id: 'R2', description_norm: 'ネットフリックス', amount: 1490 }], accounts: [account()], accepting: { id: 'R1', category: 'insurance', amount: '12000' }, busy: false, onAccept: noop, onChange: noop, onConfirm: noop, onDismiss: noop }),
      html(m.ItemRows!, { items: [scheduled(), scheduled({ id: 'S3', name: '国民年金', active: 0, recurrence: 'monthly' }), scheduled({ id: 'S4', name: '売上', direction: 'in', category: 'income', amount: 500000 })], nextDue: { S1: '2027-05-31', S3: '2026-11-30', S4: '2026-12-25' }, onOpen: noop }),
      html(m.ItemForm!, { draft: emptyDraft(TODAY), editing: null, busy: false, onChange: noop, onSave: noop, onToggle: noop, onClose: noop }),
      html(m.ItemForm!, { draft: { ...emptyDraft(TODAY), name: '自動車税', amount: '39500', category: 'car', recurrence: 'yearly' }, editing: scheduled(), busy: false, onChange: noop, onSave: noop, onToggle: noop, onClose: noop }),
    ].join('\n');
    assert.doesNotMatch(out.split('<p class="sheet-title">')[1]!, /value="income"/, '支出のフォームに収入の分類は出さない');
    assert.match(out, /停止中/);
    t.assert.snapshot(lines(out));
  });

  test('資金繰り: 起点・目安・警告（口座名つき）と月の行、開いた月の内訳', async (t) => {
    const m = await load('/src/money/Cashflow.tsx');
    const out = html(m.CashflowView!, { cf: forecast, accounts: [account(), wallet], open: '2027-01', onOpen: noop, onAddIncome: noop });
    assert.match(out, /PayPay の残高が 2026-10-20 から更新されていません/);
    assert.match(out, /2027-01 に足りなくなります/);
    assert.match(out, /cf-short[\s\S]*class="num out">−304,933/);
    assert.match(out, /所得税（予定納税）/);
    assert.ok(out.indexOf('更新されていません') < out.indexOf('足りなくなります') && out.indexOf('足りなくなります') < out.indexOf('起点残高'), '警告 → 結論 → 起点残高');
    assert.doesNotMatch(out, /収入の予定がない/);
    const noInc = html(m.CashflowView!, { cf: { ...forecast, first_shortfall_month: null, warnings: [], months: forecast.months.map((x) => ({ ...x, planned_in: 0 })) }, accounts: [], open: null, onOpen: noop, onAddIncome: noop });
    assert.match(noInc, /収入の予定がないため[\s\S]*収入を予定に追加/);
    assert.match(noInc, /36 か月の範囲で不足なし[\s\S]*いちばん少ないのは 2027-01/);
    t.assert.snapshot(lines(out));
  });

  test('口座: 残高・同期・エラー・過去分と、カードの設定フォーム', async (t) => {
    const m = await load('/src/money/Accounts.tsx');
    const mm = await load('/src/money/model.ts');
    const withStatus = mm.withStatus as unknown as (a: Account[], s: BankStatus[]) => unknown[];
    const out = [
      html(m.AccountRows!, { rows: withStatus([account(), card, wallet, account({ id: 'C2', name: 'イオンカード', kind: 'card', latest_balance: null })], status), onEdit: noop }),
      html(m.AccountForm!, { account: card, draft: { default_tag: 'unset', include_in_cashflow: true, mcp_visibility: 'summary', active: true, card_settlement_account_id: '', card_settlement_pattern: '' }, accounts: [account(), card, wallet], busy: false, onChange: noop, onSave: noop, onClose: noop }),
    ].join('\n');
    assert.match(out, /freee_http_503/);
    assert.match(out, /2025-11-01 まで取り込み済み/);
    assert.match(out, /イオンカード[\s\S]*二重に数えられます/);
    assert.doesNotMatch(out.split('「楽天カード」の設定')[1]!, /value="W1"/, '引落元は銀行だけ');
    assert.match(out, /placeholder="例: ミツイスミトモ"/);
    t.assert.snapshot(lines(out));
  });
});
