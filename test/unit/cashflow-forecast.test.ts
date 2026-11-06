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

type Fx = { db: Db; acc: Record<'A' | 'B' | 'card' | 'E' | 'off' | 'closed', string>; item: (name: string, amount: number, direction: Direction, recurrence: Recurrence, anchor: string) => string };

// 口座: A（残高 1,000,000、11/19）・B（300,000、11/10 = 7 日より古い）・card（残高なし）・E（0、11/13 = ちょうど 7 日前）を入れる。
// off（include_in_cashflow = 0）と closed（active = 0）は残高も明細も数えない。起点 = 1,300,000。
// 予定: 家賃（毎月 80,000 出、1/31 起点 → 月末）、自動車税（毎年 36,000 出、5/31）、一時金（1 回 200,000 入、2027-02-15）。
// 直近 6 か月（2026-05〜10）の明細と、予定を除いた純額:
//   月   支出（家賃・税を含む）        純支出  収入                  純収入
//   05   80,000 + 36,000 + 50,000     50,000  300,000               300,000
//   06   80,000 + 40,000              40,000  300,000               300,000
//   07   80,000 + 70,000              70,000  320,000               320,000
//   08   80,000 + 30,000              30,000  280,000               280,000
//   09   80,000 + 60,000 + 振替 100,000 60,000  300,000 + 振替 100,000 300,000
//   10   80,000 + 45,001              45,001  290,000               290,000
// 中央値: 支出 (45,001 + 50,000) / 2 = 47,500.5 → 47,501、収入 (300,000 + 300,000) / 2 = 300,000。
function setup(): Fx {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  const mk = (name: string, kind: AccountKind) => insertAccount(db, { provider: 'fake', name, kind, source: 'csv', now }).id;
  const acc = { A: mk('銀行A', 'bank'), B: mk('銀行B', 'bank'), card: mk('カード', 'card'), E: mk('財布', 'cash'), off: mk('私用', 'bank'), closed: mk('旧口座', 'bank') };
  updateAccountSettings(db, acc.off, { includeInCashflow: false }, now);
  updateAccountSettings(db, acc.closed, { active: false }, now);
  const bal = (accountId: string, asOfDate: string, balance: number) => appendBalance(db, { accountId, asOfDate, balance, source: 'manual', now });
  bal(acc.A, '2026-11-19', 900_000);
  bal(acc.A, '2026-11-19', 1_000_000); // 同じ日なら後に記録した方
  bal(acc.A, '2026-11-01', 5); // 後から記録した古い日付は使わない
  bal(acc.B, '2026-11-10', 300_000);
  bal(acc.E, '2026-11-13', 0);
  bal(acc.off, '2026-11-19', 777_777);
  bal(acc.closed, '2026-11-19', 888_888);

  const txn = (accountId: string, txnDate: string, amount: number, side: TxnSide) =>
    insertBankTxn(db, { accountId, txnDate, amount, side, description: 'x', descriptionNorm: 'x', now }).id;
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
  // 振替 1 組（A → B）
  const out = txn(acc.A, '2026-09-15', 100_000, 'expense');
  const inn = txn(acc.B, '2026-09-15', 100_000, 'income');
  insertTransferLink(db, { outTxnId: out, inTxnId: inn, kind: 'transfer', source: 'auto', state: 'active', now });
  // 範囲外・対象外の明細
  txn(acc.A, '2026-04-30', 999_999, 'expense');
  txn(acc.A, '2026-11-05', 999_999, 'expense');
  txn(acc.off, '2026-10-10', 500_000, 'expense');
  txn(acc.closed, '2026-10-10', 500_000, 'expense');

  // 作成順（同じ期日の並び）が決まるよう、作成時刻を 1 秒ずつずらす。
  let seq = 0;
  const item = (name: string, amount: number, direction: Direction, recurrence: Recurrence, anchor: string) =>
    insertScheduledItem(db, {
      name, amount, direction, category: 'other', accountId: null, recurrence, anchorDate: anchor, endDate: null, notifyDaysBefore: 14, origin: 'manual',
      now: new Date(Date.parse(now) + 1000 * seq++).toISOString(),
    }).id;
  item('家賃', 80_000, 'out', 'monthly', '2026-01-31');
  item('自動車税', 36_000, 'out', 'yearly', '2026-05-31');
  item('一時金', 200_000, 'in', 'once', '2027-02-15');
  return { db, acc, item };
}

describe('median', () => {
  test('奇数個は真ん中、偶数個は中の 2 つの平均を丸める、空は 0', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 3); // 2.5 → 3
    assert.equal(median([45_001, 50_000]), 47_501);
    assert.equal(median([]), 0);
  });
});

describe('buildForecast', () => {
  test('手計算した fixture と 36 か月分の月末残高が一致する', () => {
    const { db } = setup();
    const f = buildForecast(db, { today: TODAY });
    assert.equal(f.as_of, TODAY);
    assert.equal(f.opening_balance, 1_300_000);
    assert.equal(f.unplanned_out_per_month, 47_501);
    assert.equal(f.unplanned_in_per_month, 300_000);
    // 今日〜2027-02-19 の予定支出: 家賃 11/30・12/31・1/31
    assert.equal(f.reserve, 240_000);
    assert.equal(f.months.length, 36);
    assert.equal(f.months[0].month, '2026-11');
    assert.equal(f.months[35].month, '2029-10');

    // 今月（11/20〜30 の 11 日 / 30 日）: 1,300,000 + round(300,000 × 11/30) − round(47,501 × 11/30) − 80,000
    assert.deepEqual(
      { ...f.months[0], items: f.months[0].items.map((i) => i.name) },
      { month: '2026-11', planned_in: 0, planned_out: 80_000, unplanned_in: 110_000, unplanned_out: 17_417, balance_end: 1_312_583, margin: 1_072_583, items: ['家賃'] },
    );
    // 来月以降は毎月 300,000 − 47,501 − 80,000 = +172,499。2027-02 に +200,000、毎年 5 月に −36,000。
    const extra: Record<string, number> = { '2027-02': 200_000, '2027-05': -36_000, '2028-05': -36_000, '2029-05': -36_000 };
    let b = 1_312_583;
    const expected = [b];
    for (const m of f.months.slice(1)) {
      b += 172_499 + (extra[m.month] ?? 0);
      expected.push(b);
    }
    assert.deepEqual(f.months.map((m) => m.balance_end), expected);
    assert.equal(f.months[1].balance_end, 1_485_082);
    assert.equal(f.months[3].balance_end, 2_030_080);
    assert.equal(f.months[6].balance_end, 2_511_577);
    assert.equal(f.months[35].balance_end, 7_442_048);
    assert.deepEqual(f.months.map((m) => m.margin), expected.map((x) => x - 240_000));
    for (const m of f.months.slice(1)) {
      assert.equal(m.unplanned_in, 300_000);
      assert.equal(m.unplanned_out, 47_501);
    }
    assert.equal(f.first_shortfall_month, null);
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

  test('今日が月末: 残り 1 日分だけ按分し、当日の予定を含む', () => {
    const { db } = setup();
    const f = buildForecast(db, { today: '2026-11-30', months: 2 });
    // round(300,000 / 30) = 10,000、round(47,501 / 30) = 1,583
    assert.deepEqual(
      [f.months[0].unplanned_in, f.months[0].unplanned_out, f.months[0].planned_out, f.months[0].balance_end],
      [10_000, 1_583, 80_000, 1_300_000 + 10_000 - 1_583 - 80_000],
    );
    assert.equal(f.months.length, 2);
  });

  test('残高が無い口座は 0 で no_balance、7 日より古い残高は stale_balance（ちょうど 7 日前は出さない）', () => {
    const { db, acc } = setup();
    const f = buildForecast(db, { today: TODAY });
    const sorted = [...f.warnings].sort((a, b) => (a.kind < b.kind ? -1 : 1));
    assert.deepEqual(sorted, [
      { kind: 'no_balance', account_id: acc.card },
      { kind: 'stale_balance', account_id: acc.B, as_of_date: '2026-11-10' },
    ]);
  });

  test('月末に残す額を割る最初の月が first_shortfall_month（残高が正でも margin が負なら）', () => {
    const { db, item } = setup();
    item('車検', 2_100_000, 'out', 'once', '2027-03-10');
    const f = buildForecast(db, { today: TODAY });
    const mar = f.months.find((m) => m.month === '2027-03')!;
    // 2,030,080 + 172,499 − 2,100,000 = 102,579、margin = 102,579 − 240,000
    assert.equal(mar.balance_end, 102_579);
    assert.equal(mar.margin, -137_421);
    assert.equal(f.first_shortfall_month, '2027-03');
    assert.equal(f.months.find((m) => m.month === '2027-02')!.margin > 0, true);
  });

  test('reserve_months と unplanned_lookback_months を変えられる', () => {
    const { db } = setup();
    // 今日〜2026-12-19: 家賃 11/30 だけ
    assert.equal(buildForecast(db, { today: TODAY, reserveMonths: 1 }).reserve, 80_000);
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

describe('GET /api/cashflow', () => {
  const HOST = '127.0.0.1:8787';
  const USER = 'me@example.com';
  const headers = { Host: HOST, 'Tailscale-User-Login': USER };
  const mkApp = (db: Db, config?: { cashflow: { unplannedLookbackMonths: number; reserveMonths: number } }) => {
    const app = new Hono();
    app.use('*', createAuth({ allowedUsers: [USER], allowedHosts: [HOST] }));
    // 2026-11-20 09:00 JST
    app.route('/api', cashflowRoutes({ db, now: () => new Date('2026-11-20T00:00:00.000Z'), config }));
    return app;
  };

  test('既定は 36 か月。months は 1〜60、それ以外は 400', async () => {
    const { db } = setup();
    const app = mkApp(db);
    const res = await app.request('/api/cashflow', { headers });
    assert.equal(res.status, 200);
    const f = (await res.json()) as { as_of: string; months: { balance_end: number }[]; reserve: number };
    assert.equal(f.as_of, TODAY);
    assert.equal(f.months.length, 36);
    assert.equal(f.months[35].balance_end, 7_442_048);
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
    const res = await mkApp(db, { cashflow: { unplannedLookbackMonths: 1, reserveMonths: 1 } }).request('/api/cashflow', { headers });
    const f = (await res.json()) as { reserve: number; unplanned_out_per_month: number };
    assert.equal(f.reserve, 80_000);
    assert.equal(f.unplanned_out_per_month, 45_001);
  });
});
