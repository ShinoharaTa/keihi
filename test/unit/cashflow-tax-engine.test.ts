// 税金・保険料の見積もりのエンジン（docs/cashflow.md §14、src/cashflow/tax/engine.ts）。純関数なので DB は使わない。
// 期待値は rates.ts の数値から手で計算したもの（表駆動）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate, nextBusinessDay, splitInstallments, type EstimateYear } from '../../src/cashflow/tax/engine.ts';
import type { TaxProfileValues } from '../../src/cashflow/tax/repo.ts';
import { ratesFor, PENSION_RATES } from '../../src/cashflow/tax/rates.ts';

// docs/cashflow.md §14 の PR1 の既定（40〜64 歳の人数だけ変えて使う）。
const profile: TaxProfileValues = {
  blue_return: '65',
  consumption_mode: 'unset',
  simplified_class: null,
  revenue_includes_tax: 1,
  biz_tax_rate: null,
  resident_pay_mode: 'ordinary4',
  nhi_preset: 'saitama-city-2026',
  nhi_members: 1,
  nhi_members_40_64: 0,
  nhi_installments: 8,
  nhi_first_month: 7,
  nhi_rates_json: null,
  pension_mode: 'monthly',
  pension_addon: 0,
  dependents: 0,
  spouse: 0,
  other_deductions: 0,
  payment_account_id: null,
};

const yr = (year: number, kind: 'actual' | 'estimate', v: Partial<EstimateYear> = {}): EstimateYear => ({
  year, kind, revenue: null, expenses: null, business_income: null, social_insurance_paid: null, income_tax_final: null,
  consumption_tax_final: null, prepaid_income_tax: null, source: 'manual', ...v,
});

const W = { from: '2026-01-01', to: '2029-12-31' };
const run = (p: Partial<TaxProfileValues>, years: EstimateYear[], w = W) => estimate({ ...profile, ...p }, years, w);
const byKey = (r: ReturnType<typeof estimate>) => new Map(r.items.map((i) => [i.key, i]));
const pick = (r: ReturnType<typeof estimate>, prefix: string) => r.items.filter((i) => i.key.startsWith(prefix)).map((i) => [i.key, i.due, i.amount]);

describe('補助', () => {
  test('分割は 2 期目以降を 100 円未満切り捨て、端数は 1 期目', () => {
    assert.deepEqual(splitInstallments(409_900, 8), [51_500, 51_200, 51_200, 51_200, 51_200, 51_200, 51_200, 51_200]);
    assert.deepEqual(splitInstallments(199_500, 4), [50_100, 49_800, 49_800, 49_800]);
  });
  test('休日は翌営業日（祝日データの無い年は土日だけ）', () => {
    assert.equal(nextBusinessDay('2026-03-15'), '2026-03-16'); // 日曜
    assert.equal(nextBusinessDay('2026-10-31'), '2026-11-02'); // 土曜
    assert.equal(nextBusinessDay('2026-05-03'), '2026-05-07'); // 憲法記念日〜振替休日
    assert.equal(nextBusinessDay('2026-06-30'), '2026-06-30');
    assert.equal(nextBusinessDay('2030-02-11'), '2030-02-11'); // 祝日データの無い年: 建国記念の日でも月曜なので営業日
  });
  test('年度の値が無い年は前の年の値を使う', () => {
    assert.equal(ratesFor(PENSION_RATES, 2029).monthly, 18_290);
    assert.equal(ratesFor(PENSION_RATES, 2020).monthly, 17_920);
  });
});

describe('所得税 確定申告（所得 × 青色 × 配偶者）', () => {
  // 2026 年分。売上 = 青色控除前の所得、経費 0、社会保険料 50 万（確定値）、予定納税 0。期日は 2027-03-15（月）。
  const cases: [number, '65' | '10', 0 | 1, number][] = [
    [3_000_000, '65', 0, 49_500],
    [3_000_000, '65', 1, 30_100],
    [3_000_000, '10', 0, 77_500],
    [3_000_000, '10', 1, 58_100],
    [5_000_000, '65', 0, 224_100],
    [5_000_000, '65', 1, 185_300],
    [5_000_000, '10', 0, 333_300],
    [5_000_000, '10', 1, 255_700],
    [8_000_000, '65', 0, 843_800],
    [8_000_000, '65', 1, 766_200],
    [8_000_000, '10', 0, 956_100],
    [8_000_000, '10', 1, 878_500],
  ];
  for (const [rev, blue, spouse, want] of cases) {
    test(`所得 ${rev / 10_000} 万・青色 ${blue} 万・配偶者 ${spouse ? 'あり' : 'なし'} → ${want}`, () => {
      const r = run({ blue_return: blue, spouse }, [yr(2026, 'actual', { revenue: rev, expenses: 0, social_insurance_paid: 500_000, prepaid_income_tax: 0 })]);
      const it = byKey(r).get('income_tax:2026:final');
      assert.ok(it);
      assert.equal(it.amount, want);
      assert.equal(it.due, '2027-03-15');
      assert.equal(it.name, '所得税 2026 年分 確定申告（見積）');
      assert.equal(it.category, 'tax');
    });
  }

  test('確定値（申告納税額）があればそれから予定納税を引く。期日 3/15 が日曜なら 3/16', () => {
    const r = run({}, [yr(2025, 'actual', { business_income: 3_000_000, income_tax_final: 160_000, prepaid_income_tax: 40_000 })]);
    assert.deepEqual(pick(r, 'income_tax:2025:'), [['income_tax:2025:final', '2026-03-16', 120_000]]);
  });

  test('見積もりの年は、その年の予定納税を引く', () => {
    const r = run({}, [yr(2025, 'actual', { business_income: 3_000_000, income_tax_final: 300_000, prepaid_income_tax: 0 }), yr(2026, 'estimate', { revenue: 8_000_000, expenses: 0 })]);
    const k = byKey(r);
    // 2026 年分の予定納税 = 300,000 / 3 × 2。確定 = 申告納税額 − 200,000。
    assert.equal(k.get('income_tax:2026:prepay1')!.amount, 100_000);
    const b = r.breakdown.find((x) => x.group === 'income_tax:2026')!;
    assert.equal(k.get('income_tax:2026:final')!.amount, b.total - 200_000);
  });
});

describe('所得税 予定納税', () => {
  for (const [basis, want] of [[149_900, []], [150_000, [['income_tax:2026:prepay1', '2026-07-31', 50_000], ['income_tax:2026:prepay2', '2026-11-30', 50_000]]]] as const) {
    test(`前年の申告納税額 ${basis} 円`, () => {
      const r = run({}, [yr(2025, 'actual', { business_income: 3_000_000, income_tax_final: basis, prepaid_income_tax: 0 })]);
      assert.deepEqual(pick(r, 'income_tax:2026:prepay'), want);
      if (want.length) assert.equal(byKey(r).get('income_tax:2026:prepay1')!.name, '所得税 2026 年分 予定納税 第 1 期（見積）');
    });
  }
});

describe('住民税', () => {
  test('前年の所得から 4 期。2026 年度の期日は 6/30・8/31・11/2・2027-02-01', () => {
    const r = run({}, [yr(2025, 'actual', { business_income: 3_000_000, social_insurance_paid: 600_000, income_tax_final: 0 })]);
    // (300 万 − 60 万 − 43 万) × 10% − 2,500 + 5,000 = 199,500
    assert.deepEqual(pick(r, 'resident:2026:'), [
      ['resident:2026:q1', '2026-06-30', 50_100],
      ['resident:2026:q2', '2026-08-31', 49_800],
      ['resident:2026:q3', '2026-11-02', 49_800],
      ['resident:2026:q4', '2027-02-01', 49_800],
    ]);
    assert.equal(byKey(r).get('resident:2026:q1')!.name, '住民税 2026 年度 第 1 期（見積）');
  });
});

describe('国民健康保険税（さいたま市 令和 8 年度）', () => {
  test('市の計算例: 42 歳・所得 300 万 → 409,900 円を 8 期（7 月末〜翌 2 月末）', () => {
    const r = run({ nhi_members_40_64: 1 }, [yr(2025, 'actual', { business_income: 3_000_000 })]);
    assert.equal(r.breakdown.find((b) => b.group === 'nhi:2026')!.total, 409_900);
    assert.deepEqual(pick(r, 'nhi:2026:'), [
      ['nhi:2026:p1', '2026-07-31', 51_500],
      ['nhi:2026:p2', '2026-08-31', 51_200],
      ['nhi:2026:p3', '2026-09-30', 51_200],
      ['nhi:2026:p4', '2026-11-02', 51_200],
      ['nhi:2026:p5', '2026-11-30', 51_200],
      ['nhi:2026:p6', '2026-12-31', 51_200],
      ['nhi:2026:p7', '2027-02-01', 51_200],
      ['nhi:2026:p8', '2027-03-01', 51_200],
    ]);
    const it = byKey(r).get('nhi:2026:p1')!;
    assert.equal(it.category, 'insurance');
    assert.equal(it.name, '国民健康保険税 2026 年度 第 1 期（見積）');
  });

  test('40 歳未満なら介護分が無い', () => {
    const r = run({ nhi_members_40_64: 0 }, [yr(2025, 'actual', { business_income: 3_000_000 })]);
    assert.equal(r.breakdown.find((b) => b.group === 'nhi:2026')!.total, 409_900 - 77_000);
  });

  test('上限に当たる所得: 67 万 + 26 万 + 17 万 + 3 万', () => {
    const r = run({ nhi_members_40_64: 1 }, [yr(2025, 'actual', { business_income: 20_000_000 })]);
    assert.equal(r.breakdown.find((b) => b.group === 'nhi:2026')!.total, 1_130_000);
    assert.equal(byKey(r).get('nhi:2026:p1')!.amount, 141_600);
    assert.equal(byKey(r).get('nhi:2026:p2')!.amount, 141_200);
  });

  test('nhi_rates_json で区分の一部を上書きできる', () => {
    const over = JSON.stringify({ care: { cap: 0 } });
    const r = run({ nhi_members_40_64: 1, nhi_rates_json: over }, [yr(2025, 'actual', { business_income: 3_000_000 })]);
    assert.equal(r.breakdown.find((b) => b.group === 'nhi:2026')!.total, 409_900 - 77_000);
  });
});

describe('個人事業税', () => {
  test('biz_tax_rate が NULL なら作らない', () => {
    const r = run({ biz_tax_rate: null }, [yr(2025, 'actual', { business_income: 8_000_000 })]);
    assert.deepEqual(pick(r, 'biz_tax:'), []);
  });
  test('青色控除の前の所得が 290 万以下なら作らない', () => {
    const r = run({ biz_tax_rate: 0.05 }, [yr(2025, 'actual', { business_income: 2_900_000 - 650_000 })]);
    assert.deepEqual(pick(r, 'biz_tax:2026:'), []);
  });
  test('(所得 + 青色控除 − 290 万) × 5% を 8 月・11 月', () => {
    const r = run({ biz_tax_rate: 0.05 }, [yr(2025, 'actual', { business_income: 5_000_000 - 650_000 })]);
    assert.deepEqual(pick(r, 'biz_tax:2026:'), [['biz_tax:2026:1', '2026-08-31', 52_500], ['biz_tax:2026:2', '2026-11-30', 52_500]]);
  });
  test('1 万円以下は 8 月に一括', () => {
    const r = run({ biz_tax_rate: 0.05 }, [yr(2025, 'actual', { revenue: 3_100_000, expenses: 0 })]);
    assert.deepEqual(pick(r, 'biz_tax:2026:'), [['biz_tax:2026:1', '2026-08-31', 10_000]]);
  });
});

describe('国民年金', () => {
  const ys = [yr(2025, 'actual', { business_income: 3_000_000 })];
  test('月払い: 毎月末。2027 年度から 18,290', () => {
    const r = run({ pension_mode: 'monthly' }, ys, { from: '2027-02-01', to: '2027-05-31' });
    assert.deepEqual(pick(r, 'pension:'), [
      ['pension:2026:01', '2027-02-01', 17_920],
      ['pension:2026:02', '2027-03-01', 17_920],
      ['pension:2026:03', '2027-03-31', 17_920],
      ['pension:2027:04', '2027-04-30', 18_290],
      ['pension:2027:05', '2027-05-31', 18_290],
    ]);
    assert.equal(byKey(r).get('pension:2027:04')!.name, '国民年金 2027 年度 4 月分（見積）');
  });
  test('付加保険料は月 400 円', () => {
    const r = run({ pension_mode: 'monthly', pension_addon: 1 }, ys, { from: '2026-04-01', to: '2026-04-30' });
    assert.deepEqual(pick(r, 'pension:'), [['pension:2026:04', '2026-04-30', 18_320]]);
  });
  test('6 か月前納: 4 月末と 10 月末', () => {
    const r = run({ pension_mode: 'prepay6' }, ys, { from: '2026-01-01', to: '2026-12-31' });
    assert.deepEqual(pick(r, 'pension:'), [['pension:2026:04', '2026-04-30', 106_300], ['pension:2026:10', '2026-11-02', 106_300]]);
  });
  test('1 年前納: 4 月末', () => {
    const r = run({ pension_mode: 'prepay12' }, ys, { from: '2026-01-01', to: '2027-12-31' });
    assert.deepEqual(pick(r, 'pension:'), [['pension:2026:04', '2026-04-30', 210_530], ['pension:2027:04', '2027-04-30', 210_530]]);
  });
  test('2 年前納: 偶数の年度の 4 月末だけ', () => {
    const r = run({ pension_mode: 'prepay24' }, ys, { from: '2026-01-01', to: '2028-12-31' });
    assert.deepEqual(pick(r, 'pension:'), [['pension:2026:04', '2026-04-30', 417_150], ['pension:2028:04', '2028-05-01', 417_150]]);
  });
  test('none なら作らない', () => {
    assert.deepEqual(pick(run({ pension_mode: 'none' }, ys), 'pension:'), []);
  });
});

describe('入力が無いとき', () => {
  test('見込みが無い年は直近の年を繰り越す（carried_from）', () => {
    const r = run({}, [yr(2025, 'actual', { business_income: 3_000_000, income_tax_final: 50_000 }), yr(2026, 'estimate', { revenue: 5_000_000, expenses: 1_000_000 })]);
    const b2027 = r.breakdown.find((b) => b.group === 'income_tax:2027')!;
    assert.equal(b2027.carried_from, 2026);
    assert.equal(r.breakdown.find((b) => b.group === 'income_tax:2026')!.carried_from, undefined);
    // 2028 年度の住民税は 2027 年の所得（2026 から繰り越し）。
    const res2028 = r.breakdown.find((b) => b.group === 'resident:2028')!;
    assert.equal(res2028.income_year, 2026);
    assert.equal(res2028.carried_from, 2026);
    assert.ok(byKey(r).has('income_tax:2028:final'));
  });

  test('前年の確定値が無ければ、今年の見込みで住民税・国保・事業税を出す（assumed_prev_year）', () => {
    const r = run({ biz_tax_rate: 0.05, nhi_members_40_64: 1 }, [yr(2026, 'estimate', { business_income: 3_000_000 })]);
    for (const g of ['resident:2026', 'nhi:2026']) {
      const b = r.breakdown.find((x) => x.group === g)!;
      assert.equal(b.assumed_prev_year, true, g);
      assert.equal(b.income_year, 2026, g);
    }
    assert.equal(r.breakdown.find((x) => x.group === 'nhi:2026')!.total, 409_900);
    assert.equal(r.breakdown.find((x) => x.group === 'resident:2027')!.assumed_prev_year, undefined);
    // 予定納税は前年の申告納税額が要るので作らない。2025 年分の所得税も作らない。
    assert.deepEqual(pick(r, 'income_tax:2026:prepay'), []);
    assert.deepEqual(pick(r, 'income_tax:2025:'), []);
    assert.deepEqual(r.warnings, [{ kind: 'consumption_tax_mode_unset' }, { kind: 'income_missing', year: 2025 }]);
  });

  test('年が 1 つも無ければ何も作らない（年金だけ）', () => {
    const r = run({}, []);
    assert.ok(r.items.every((i) => i.kind === 'pension'));
  });

  test('消費税は作らない。方式が未設定なら警告', () => {
    const ys = [yr(2025, 'actual', { business_income: 3_000_000, income_tax_final: 0 })];
    assert.deepEqual(run({ consumption_mode: 'unset' }, ys).warnings, [{ kind: 'consumption_tax_mode_unset' }]);
    assert.deepEqual(run({ consumption_mode: 'exempt' }, ys).warnings, []);
  });

  test('期間の外の期日は出さない', () => {
    const r = run({}, [yr(2025, 'actual', { business_income: 3_000_000, income_tax_final: 0 })], { from: '2026-07-01', to: '2026-07-31' });
    assert.ok(r.items.length > 0);
    assert.ok(r.items.every((i) => i.due >= '2026-07-01' && i.due <= '2026-07-31'));
  });
});
