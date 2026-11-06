// 資金繰り表（docs/mvp-plan-v3.md T303・V11、src/cashflow/forecast.ts と GET /api/cashflow）。一時ディレクトリの DB だけを使う。
// fixture の期待値は手で計算したもの（下のコメント）。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { appendBalance, insertAccount, insertBankTxn, updateAccountSettings, type AccountKind, type TxnSide } from '../../src/bank/repo.ts';
import { insertTransferLink } from '../../src/bank/transferRepo.ts';
import type { TransferKind } from '../../src/bank/transferRepo.ts';
import { buildForecast, median } from '../../src/cashflow/forecast.ts';
import { insertScheduledItem, type Direction, type Recurrence } from '../../src/cashflow/repo.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createAuth } from '../../src/web/auth.ts';
import { cashflowRoutes } from '../../src/web/routes/cashflow.ts';

const now = '2026-11-20T00:00:00.000Z';
const TODAY = '2026-11-20';
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-forecast-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

type ItemOpts = { accountId?: string | null; endDate?: string | null };

// 口座・明細・予定を足す道具。
function base() {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  const mk = (name: string, kind: AccountKind) => insertAccount(db, { provider: 'fake', name, kind, source: 'csv', now }).id;
  const bal = (accountId: string, asOfDate: string, balance: number) => appendBalance(db, { accountId, asOfDate, balance, source: 'manual', now });
  const txn = (accountId: string, txnDate: string, amount: number, side: TxnSide, description = 'x') =>
    insertBankTxn(db, { accountId, txnDate, amount, side, description, descriptionNorm: description, now }).id;
  const link = (outTxnId: string, inTxnId: string | null, kind: TransferKind) =>
    insertTransferLink(db, { outTxnId, inTxnId, kind, source: 'auto', state: 'active', now });
  // 作成順（同じ期日の並び）が決まるよう、作成時刻を 1 秒ずつずらす。
  let seq = 0;
  const item = (name: string, amount: number, direction: Direction, recurrence: Recurrence, anchor: string, o: ItemOpts = {}) =>
    insertScheduledItem(db, {
      name, amount, direction, category: 'other', accountId: o.accountId ?? null, recurrence, anchorDate: anchor, endDate: o.endDate ?? null,
      notifyDaysBefore: 14, origin: 'manual', now: new Date(Date.parse(now) + 1000 * seq++).toISOString(),
    }).id;
  const deactivate = (id: string) => db.prepare('UPDATE scheduled_items SET active = 0 WHERE id = ?').run(id);
  return { db, mk, bal, txn, link, item, deactivate };
}

// 口座: A（残高 1,000,000、11/19）・B（300,000、11/12 = 8 日前）・card（残高なし）・E（0、11/13 = ちょうど 7 日前）を入れる。
// off（include_in_cashflow = 0）と closed（active = 0）は残高も明細も数えない。起点 = 1,300,000。
// 予定: 家賃（毎月 80,000 出、1/31 起点 → 月末）、自動車税（毎年 36,000 出、5/31）、一時金（1 回 200,000 入、2027-02-15）。
// 最初の明細は 2026-04-30（この月は中央値に使わない）。直近 6 か月（2026-05〜10）の明細と、予定を除いた純額:
//   月   支出（家賃・税を含む）          純支出  収入                    純収入
//   05   80,000 + 36,000 + 50,000       50,000  300,000                 300,000
//   06   80,000 + 40,000                40,000  300,000                 300,000
//   07   80,000 + 70,000                70,000  320,000                 320,000
//   08   80,000 + 30,000                30,000  280,000                 280,000
//   09   80,000 + 60,000 + 振替 100,000  60,000  300,000 + 振替 100,000   300,000
//   10   80,000 + 45,001                45,001  290,000                 290,000
// 中央値: 支出 (45,001 + 50,000) / 2 = 47,500.5 → 47,501、収入 (300,000 + 300,000) / 2 = 300,000。
function setup() {
  const b = base();
  const { db, mk, bal, txn, link, item } = b;
  const acc = { A: mk('銀行A', 'bank'), B: mk('銀行B', 'bank'), card: mk('カード', 'card'), E: mk('財布', 'cash'), off: mk('私用', 'bank'), closed: mk('旧口座', 'bank') };
  updateAccountSettings(db, acc.off, { includeInCashflow: false }, now);
  updateAccountSettings(db, acc.closed, { active: false }, now);
  bal(acc.A, '2026-11-19', 900_000);
  bal(acc.A, '2026-11-19', 1_000_000); // 同じ日なら後に記録した方
  bal(acc.A, '2026-11-01', 5); // 後から記録した古い日付は使わない
  bal(acc.B, '2026-11-12', 300_000);
  bal(acc.E, '2026-11-13', 0);
  bal(acc.off, '2026-11-19', 777_777);
  bal(acc.closed, '2026-11-19', 888_888);

  const monthly: [string, number, number][] = [
    ['2026-05', 50_000, 300_000],
    ['2026-06', 40_000, 300_000],
    ['2026-07', 70_000, 320_000],
    ['2026-08', 30_000, 280_000],
    ['2026-09', 60_000, 300_000],
    ['2026-10', 45_001, 290_000],
  ];
  for (const [m, other, income] of monthly) {
    txn(acc.A, `${m}-10`, other, 'expense');
    txn(acc.A, `${m}-25`, income, 'income');
    const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    txn(acc.A, `${m}-${last}`, 80_000, 'expense');
  }
  txn(acc.A, '2026-05-31', 36_000, 'expense');
  // 振替 1 組（A → B。どちらも対象口座なので除く）
  link(txn(acc.A, '2026-09-15', 100_000, 'expense'), txn(acc.B, '2026-09-15', 100_000, 'income'), 'transfer');
  // 最初の明細の月・今月・対象外の口座の明細
  txn(acc.A, '2026-04-30', 999_999, 'expense');
  txn(acc.A, '2026-11-05', 999_999, 'expense');
  txn(acc.off, '2026-10-10', 500_000, 'expense');
  txn(acc.closed, '2026-10-10', 500_000, 'expense');

  item('家賃', 80_000, 'out', 'monthly', '2026-01-31');
  item('自動車税', 36_000, 'out', 'yearly', '2026-05-31');
  item('一時金', 200_000, 'in', 'once', '2027-02-15');
  return { ...b, acc };
}

// 各月の reserve: 翌月から 3 か月の家賃 240,000 と、その中に 5 月があれば自動車税 36,000。
const reserveOf = (month: string) => {
  const m = Number(month.slice(5, 7));
  return 240_000 + ([2, 3, 4].includes(m) ? 36_000 : 0);
};

describe('median', () => {
  test('奇数個は真ん中、偶数個は中の 2 つの平均を丸める、空は 0', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 3); // 2.5 → 3
    assert.equal(median([45_001, 50_000]), 47_501);
    assert.equal(median([]), 0);
  });
});

describe('buildForecast', () => {
  test('手計算した fixture と 36 か月分の月末残高が一致する（予定外の収入も足す）', () => {
    const { db } = setup();
    const f = buildForecast(db, { today: TODAY, includeUnplannedIncome: true });
    assert.equal(f.as_of, TODAY);
    assert.equal(f.opening_balance, 1_300_000);
    assert.equal(f.unplanned_out_per_month, 47_501);
    assert.equal(f.unplanned_in_per_month, 300_000);
    // 今日〜2027-02-19 の予定支出: 家賃 11/30・12/31・1/31
    assert.equal(f.reserve, 240_000);
    assert.equal(f.months.length, 36);
    assert.equal(f.months[0].month, '2026-11');
    assert.equal(f.months[35].month, '2029-10');

    // 今月（11/21〜30 の 10 日 / 30 日）: 1,300,000 + round(300,000 × 10/30) − round(47,501 × 10/30) − 80,000
    assert.deepEqual(
      { ...f.months[0], items: f.months[0].items.map((i) => i.name) },
      {
        month: '2026-11', planned_in: 0, planned_out: 80_000, unplanned_in: 100_000, unplanned_out: 15_834,
        balance_end: 1_304_166, reserve: 240_000, margin: 1_064_166, items: ['家賃'],
      },
    );
    // 来月以降は毎月 300,000 − 47,501 − 80,000 = +172,499。2027-02 に +200,000、毎年 5 月に −36,000。
    const extra: Record<string, number> = { '2027-02': 200_000, '2027-05': -36_000, '2028-05': -36_000, '2029-05': -36_000 };
    let b = 1_304_166;
    const expected = [b];
    for (const m of f.months.slice(1)) {
      b += 172_499 + (extra[m.month] ?? 0);
      expected.push(b);
    }
    assert.deepEqual(f.months.map((m) => m.balance_end), expected);
    assert.equal(f.months[1].balance_end, 1_476_665);
    assert.equal(f.months[3].balance_end, 2_021_663);
    assert.equal(f.months[6].balance_end, 2_503_160);
    assert.equal(f.months[35].balance_end, 7_433_631);
    assert.deepEqual(f.months.map((m) => m.reserve), f.months.map((m) => reserveOf(m.month)));
    assert.deepEqual(f.months.map((m) => m.margin), f.months.map((m, k) => expected[k] - reserveOf(m.month)));
    for (const m of f.months.slice(1)) {
      assert.equal(m.unplanned_in, 300_000);
      assert.equal(m.unplanned_out, 47_501);
    }
    assert.equal(f.first_shortfall_month, null);
  });

  test('既定（include_unplanned_income = false）は予定外の収入を足さず、表示だけ返す', () => {
    const { db } = setup();
    const f = buildForecast(db, { today: TODAY });
    assert.equal(f.unplanned_in_per_month, 300_000);
    assert.ok(f.months.every((m) => m.unplanned_in === 0));
    // 今月: 1,300,000 − round(47,501 × 10/30) − 80,000。来月以降は毎月 −127,501（2027-02 に +200,000、2027-05 に −36,000）
    assert.equal(f.months[0].balance_end, 1_204_166);
    assert.equal(f.months[1].balance_end, 1_076_665);
    // 2027-07: 1,204,166 − 8 × 127,501 + 200,000 − 36,000 = 348,158（reserve 240,000）
    // 2027-08: 220,657 < 240,000 → 最初に割る月
    const by = (m: string) => f.months.find((x) => x.month === m)!;
    assert.equal(by('2027-07').balance_end, 348_158);
    assert.equal(by('2027-08').balance_end, 220_657);
    assert.equal(by('2027-08').margin, -19_343);
    assert.equal(f.first_shortfall_month, '2027-08');
  });

  test('月末と 2 月: 家賃は月末、2 月は 28 日（閏年は 29 日）。同じ月の項目は期日順', () => {
    const { db } = setup();
    const f = buildForecast(db, { today: TODAY });
    const by = (m: string) => f.months.find((x) => x.month === m)!;
    assert.deepEqual(by('2026-12').items.map((i) => i.due), ['2026-12-31']);
    assert.deepEqual(by('2027-04').items.map((i) => i.due), ['2027-04-30']);
    assert.deepEqual(
      by('2027-02').items.map((i) => [i.name, i.due, i.direction, i.amount]),
      [['一時金', '2027-02-15', 'in', 200_000], ['家賃', '2027-02-28', 'out', 80_000]],
    );
    assert.deepEqual(by('2028-02').items.map((i) => i.due), ['2028-02-29']);
    assert.deepEqual(by('2027-05').items.map((i) => [i.name, i.due]), [['家賃', '2027-05-31'], ['自動車税', '2027-05-31']]);
    assert.equal(by('2027-02').planned_in, 200_000);
    assert.equal(by('2027-02').planned_out, 80_000);
  });

  test('今日が月末: 今月は残り 0 日で、当日の予定も足さない（今日付の残高に反映済み）', () => {
    const { db } = setup();
    const f = buildForecast(db, { today: '2026-11-30', months: 2 });
    assert.deepEqual(
      [f.months[0].unplanned_in, f.months[0].unplanned_out, f.months[0].planned_out, f.months[0].items, f.months[0].balance_end],
      [0, 0, 0, [], 1_300_000],
    );
    assert.equal(f.months.length, 2);
  });

  test('今日が月初: 翌日からの 30 日 / 31 日を按分。lookback は 2026-06〜11（11 月の明細も入る）', () => {
    const { db } = setup();
    const f = buildForecast(db, { today: '2026-12-01', months: 1 });
    // 純支出: 06 40,000 / 07 70,000 / 08 30,000 / 09 60,000 / 10 45,001 / 11 999,999 − 家賃 80,000 = 919,999
    // → 中央値 (45,001 + 60,000) / 2 = 52,500.5 → 52,501。今月: round(52,501 × 30/31) = 50,807
    assert.equal(f.unplanned_out_per_month, 52_501);
    assert.equal(f.unplanned_in_per_month, 295_000); // 0, 280,000, 290,000, 300,000, 300,000, 320,000
    assert.equal(f.months[0].unplanned_out, 50_807);
    assert.equal(f.months[0].balance_end, 1_300_000 - 50_807 - 80_000);
  });

  test('年をまたぐ lookback と short_history: 2027-01 時点で 9 か月を見ると 2026-04 は最初の月なので外し 8 か月', () => {
    const { db } = setup();
    const f = buildForecast(db, { today: '2027-01-15', months: 1, unplannedLookbackMonths: 9 });
    // 05〜10 は上と同じ、11 月 919,999、12 月は明細なしで家賃 −80,000 → 8 個の中央値 (45,001 + 50,000) / 2
    assert.equal(f.unplanned_out_per_month, 47_501);
    assert.deepEqual(f.warnings.filter((w) => w.kind === 'short_history'), [{ kind: 'short_history', months_available: 8 }]);
  });

  test('残高が無い口座は 0 で no_balance（カードは出さない）、8 日前の残高は stale_balance（ちょうど 7 日前は出さない）', () => {
    const { db, acc, mk } = setup();
    const cash = mk('現金', 'cash');
    const f = buildForecast(db, { today: TODAY });
    const sorted = [...f.warnings].sort((a, b) => (a.kind < b.kind ? -1 : 1));
    assert.deepEqual(sorted, [
      { kind: 'no_balance', account_id: cash },
      { kind: 'stale_balance', account_id: acc.B, as_of_date: '2026-11-12' },
    ]);
  });

  test('月ごとの reserve で first_shortfall_month を決める（残高が正でも、先の大きな支出で割る）', () => {
    const { db, item } = setup();
    item('車検', 2_100_000, 'out', 'once', '2027-03-10');
    const f = buildForecast(db, { today: TODAY, includeUnplannedIncome: true });
    const by = (m: string) => f.months.find((x) => x.month === m)!;
    // 11 月の reserve は 12〜2 月（240,000）、12 月は 1〜3 月で車検を含む（240,000 + 2,100,000）
    assert.equal(by('2026-11').margin, 1_064_166);
    assert.equal(by('2026-12').reserve, 2_340_000);
    assert.equal(by('2026-12').margin, 1_476_665 - 2_340_000);
    assert.equal(f.first_shortfall_month, '2026-12');
    // 2027-03 の残高は 2,021,663 + 172,499 − 2,100,000 = 94,162 で正のまま
    assert.equal(by('2027-03').balance_end, 94_162);
    assert.equal(f.reserve, 240_000); // 今日時点（〜2027-02-19）は車検を含まない
  });

  test('reserve_months と unplanned_lookback_months を変えられる', () => {
    const { db } = setup();
    const f1 = buildForecast(db, { today: TODAY, reserveMonths: 1 });
    // 今日〜2026-12-19: 家賃 11/30 だけ。各月は翌月の家賃だけ
    assert.equal(f1.reserve, 80_000);
    assert.equal(f1.months[0].reserve, 80_000);
    assert.equal(f1.months.find((m) => m.month === '2027-04')!.reserve, 116_000);
    // 直近 1 か月（10 月）だけ: 純支出 45,001、純収入 290,000
    const f = buildForecast(db, { today: TODAY, unplannedLookbackMonths: 1 });
    assert.equal(f.unplanned_out_per_month, 45_001);
    assert.equal(f.unplanned_in_per_month, 290_000);
  });

  test('予定外の純額が負なら 0 にする', () => {
    const { db, item } = setup();
    // 毎月 200,000 の支出予定（明細に無い）→ 純支出は全月で負
    item('予定だけ', 200_000, 'out', 'monthly', '2026-01-01');
    assert.equal(buildForecast(db, { today: TODAY }).unplanned_out_per_month, 0);
  });
});

// 小さな fixture: 対象口座 A（残高 100,000、今日付）。最初の明細は 2026-04-01 の 1 円。05〜10 月に毎月 10 日 10,000 の支出。
function mini(today = TODAY) {
  const b = base();
  const A = b.mk('銀行A', 'bank');
  b.bal(A, today, 100_000);
  b.txn(A, '2026-04-01', 1, 'expense');
  for (const m of ['05', '06', '07', '08', '09', '10']) b.txn(A, `2026-${m}-10`, 10_000, 'expense');
  return { ...b, A };
}

describe('buildForecast: 振替等の除外は対象口座どうしだけ', () => {
  test('対象外の口座への振替は支出として残し、対象口座どうしの振替は除く', () => {
    const { db, mk, txn, link, A } = mini();
    const B = mk('銀行B', 'bank');
    const P = mk('私用', 'bank');
    const pay = mk('PayPay', 'paypay');
    updateAccountSettings(db, P, { includeInCashflow: false }, now);
    updateAccountSettings(db, pay, { includeInCashflow: false }, now);
    link(txn(A, '2026-10-15', 100_000, 'expense'), txn(P, '2026-10-15', 100_000, 'income'), 'transfer');
    link(txn(A, '2026-10-16', 30_000, 'expense'), txn(pay, '2026-10-16', 30_000, 'income'), 'charge');
    link(txn(A, '2026-10-17', 50_000, 'expense'), txn(B, '2026-10-17', 50_000, 'income'), 'transfer');
    const f = buildForecast(db, { today: TODAY, unplannedLookbackMonths: 1 });
    // 10 月: 10,000 + 私用への振替 100,000 + 対象外の PayPay へのチャージ 30,000（B への振替 50,000 は除く）
    assert.equal(f.unplanned_out_per_month, 140_000);
    assert.equal(f.unplanned_in_per_month, 0);
  });

  test('カードの引き落としは、カードの口座が対象のときだけ除く', () => {
    for (const included of [true, false]) {
      const { db, mk, txn, link, A } = mini('2026-10-20');
      const card = mk('カード', 'card');
      updateAccountSettings(db, card, { cardSettlementAccountId: A, cardSettlementPattern: 'カード', includeInCashflow: included }, now);
      link(txn(A, '2026-09-27', 70_000, 'expense', 'カード引落'), null, 'card_settlement');
      const f = buildForecast(db, { today: '2026-10-20', unplannedLookbackMonths: 1 });
      assert.equal(f.unplanned_out_per_month, included ? 10_000 : 80_000, `included=${included}`);
    }
  });
});

describe('buildForecast: 履歴から引く予定項目と履歴の長さ', () => {
  test('停止した予定も end_date までは履歴から引く。予定の表には出さない', () => {
    const { db, item, deactivate } = mini();
    deactivate(item('旧サブスク', 10_000, 'out', 'monthly', '2026-01-10', { endDate: '2026-07-31' }));
    const f = buildForecast(db, { today: TODAY });
    // 純支出: 05〜07 は 0、08〜10 は 10,000 → 中央値 (0 + 10,000) / 2 = 5,000
    assert.equal(f.unplanned_out_per_month, 5_000);
    assert.ok(f.months.every((m) => m.items.length === 0));
  });

  test('対象外の口座を指す予定は履歴から引かないが、予定の表には入れる', () => {
    const { db, mk, item } = mini();
    const P = mk('私用', 'bank');
    updateAccountSettings(db, P, { includeInCashflow: false }, now);
    item('私用の積立', 10_000, 'out', 'monthly', '2026-01-10', { accountId: P });
    item('口座なしの予定', 4_000, 'out', 'monthly', '2026-01-10');
    const f = buildForecast(db, { today: TODAY });
    // 履歴から引くのは口座なしの 4,000 だけ → 6,000
    assert.equal(f.unplanned_out_per_month, 6_000);
    assert.equal(f.months[1].planned_out, 14_000);
  });

  test('最初の明細の月は外し、使える月が足りなければ short_history。0 か月なら目安は 0', () => {
    const b = base();
    const A = b.mk('銀行A', 'bank');
    b.bal(A, TODAY, 100_000);
    b.txn(A, '2026-09-15', 99_999, 'expense'); // 最初の月（途中から）
    b.txn(A, '2026-10-10', 20_000, 'expense');
    const f = buildForecast(b.db, { today: TODAY });
    assert.equal(f.unplanned_out_per_month, 20_000);
    assert.deepEqual(f.warnings, [{ kind: 'short_history', months_available: 1 }]);

    const c = base();
    const C = c.mk('銀行C', 'bank');
    c.bal(C, TODAY, 100_000);
    c.txn(C, '2026-10-10', 20_000, 'expense');
    const g = buildForecast(c.db, { today: TODAY });
    assert.equal(g.unplanned_out_per_month, 0);
    assert.deepEqual(g.warnings, [{ kind: 'short_history', months_available: 0 }]);
  });

  test('閏年の 2 月の按分: 2/10 なら 19 日 / 29 日', () => {
    const b = base();
    const A = b.mk('銀行A', 'bank');
    b.bal(A, '2028-02-10', 100_000);
    b.txn(A, '2027-07-01', 1, 'expense');
    for (const m of ['2027-08', '2027-09', '2027-10', '2027-11', '2027-12', '2028-01']) b.txn(A, `${m}-10`, 29_000, 'expense');
    const f = buildForecast(b.db, { today: '2028-02-10', months: 1 });
    assert.equal(f.unplanned_out_per_month, 29_000);
    assert.equal(f.months[0].unplanned_out, 19_000);
    assert.equal(f.months[0].balance_end, 81_000);
    assert.deepEqual(f.warnings, []);
  });
});

describe('GET /api/cashflow', () => {
  const HOST = '127.0.0.1:8787';
  const USER = 'me@example.com';
  const headers = { Host: HOST, 'Tailscale-User-Login': USER };
  type Cf = { unplannedLookbackMonths: number; reserveMonths: number; includeUnplannedIncome: boolean };
  const DEFAULT_CF: Cf = { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false };
  const mkApp = (db: Db, config: { cashflow: Cf } = { cashflow: DEFAULT_CF }) => {
    const app = new Hono();
    app.use('*', createAuth({ allowedUsers: [USER], allowedHosts: [HOST] }));
    // 2026-11-20 09:00 JST
    app.route('/api', cashflowRoutes({ db, now: () => new Date('2026-11-20T00:00:00.000Z'), config }));
    return app;
  };

  test('既定（設定も既定値）は 36 か月。months は 1〜60、それ以外は 400', async () => {
    const { db } = setup();
    const app = mkApp(db);
    const res = await app.request('/api/cashflow', { headers });
    assert.equal(res.status, 200);
    const f = (await res.json()) as { as_of: string; months: { balance_end: number }[]; reserve: number };
    assert.equal(f.as_of, TODAY);
    assert.equal(f.months.length, 36);
    assert.equal(f.months[0].balance_end, 1_204_166);
    assert.equal(f.reserve, 240_000);
    for (const [q, len] of [['1', 1], ['60', 60]] as const) {
      const r = await app.request(`/api/cashflow?months=${q}`, { headers });
      assert.equal(((await r.json()) as { months: unknown[] }).months.length, len);
    }
    for (const q of ['0', '61', 'abc', '1.5', '-1', '']) {
      const r = await app.request(`/api/cashflow?months=${q}`, { headers });
      assert.equal(r.status, 400, q);
      assert.deepEqual(await r.json(), { error: 'invalid_months' });
    }
  });

  test('[cashflow] の設定を使う', async () => {
    const { db } = setup();
    const res = await mkApp(db, { cashflow: { unplannedLookbackMonths: 1, reserveMonths: 1, includeUnplannedIncome: true } }).request('/api/cashflow', { headers });
    const f = (await res.json()) as { reserve: number; unplanned_out_per_month: number; months: { unplanned_in: number }[] };
    assert.equal(f.reserve, 80_000);
    assert.equal(f.unplanned_out_per_month, 45_001);
    assert.equal(f.months[1].unplanned_in, 290_000);
  });
});
