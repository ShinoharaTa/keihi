// 税金・保険料の見積もりのエンジン（docs/cashflow.md §14、src/cashflow/tax/engine.ts）。純関数なので DB は使わない。
// 期待値は rates.ts の数値から手で計算したもの（表駆動）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate, nextBusinessDay, nhiRatesOf, salaryIncomeOf, splitInstallments, type EstimateYear } from '../../src/cashflow/tax/engine.ts';
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
  consumption_tax_final: null, prepaid_income_tax: null, salary_income: null, salary_after_deduction: null, salary_withheld_tax: null,
  salary_social_insurance: null, source: 'manual', ...v,
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
  test('月払い: 年度ごとに 1 項目（monthly、5 月末〜翌 4 月末）。2027 年度から 18,290', () => {
    const r = run({ pension_mode: 'monthly' }, ys, { from: '2027-02-01', to: '2027-05-31' });
    const rows = r.items.filter((i) => i.kind === 'pension').map((i) => [i.key, i.due, i.end_date, i.recurrence, i.amount, i.name]);
    assert.deepEqual(rows, [
      ['pension:2026:monthly', '2026-05-31', '2027-04-30', 'monthly', 17_920, '国民年金 2026 年度 月払い（見積）'],
      ['pension:2027:monthly', '2027-05-31', '2028-04-30', 'monthly', 18_290, '国民年金 2027 年度 月払い（見積）'],
    ]);
    // 期間の始まりより前の年度（2025 年度は 2026-04-30 で終わる）は出さない。期間の終わりより後に始まる年度も出さない。
    assert.deepEqual(pick(run({ pension_mode: 'monthly' }, ys, { from: '2026-06-01', to: '2027-04-30' }), 'pension:').map(([k]) => k), ['pension:2026:monthly']);
    // 年度の内訳は 12 か月分。
    assert.equal(r.breakdown.find((b) => b.group === 'pension:2027')!.total, 18_290 * 12);
  });
  test('月払い: 社会保険料控除は月ごとに数える（2026 年 = 2025 年度の 1〜3 月 + 2026 年度の 4〜12 月）', () => {
    const r = run({ pension_mode: 'monthly', nhi_preset: null }, [yr(2026, 'estimate', { business_income: 3_000_000 })], { from: '2026-01-01', to: '2028-12-31' });
    const soc = (y: number) => r.breakdown.find((b) => b.group === `income_tax:${y}`)!.lines.find((l) => l.label === '社会保険料控除')!.amount;
    assert.equal(soc(2026), 17_920 * 12);
    assert.equal(soc(2027), 17_920 * 3 + 18_290 * 9);
  });
  test('付加保険料は月 400 円', () => {
    const r = run({ pension_mode: 'monthly', pension_addon: 1 }, ys, { from: '2026-05-01', to: '2026-05-31' });
    assert.deepEqual(pick(r, 'pension:'), [['pension:2026:monthly', '2026-05-31', 18_320]]);
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
    // monthly（年金の月払い）は最初の回〜end_date が期間に掛かるもの。
    assert.ok(r.items.every((i) => (i.end_date ?? i.due) >= '2026-07-01' && i.due <= '2026-07-31'));
    assert.ok(r.items.filter((i) => i.recurrence === 'once').every((i) => i.due >= '2026-07-01'));
  });
});

describe('レビュー対応', () => {
  // 社会保険料 0（確定値）、年金・国保なしで基礎控除の行を見る。
  const basic = (year: number, income: number) => {
    const r = run({ pension_mode: 'none', nhi_preset: null }, [yr(year, 'actual', { business_income: income, social_insurance_paid: 0, prepaid_income_tax: 0 })], { from: '2025-01-01', to: '2030-12-31' });
    return r.breakdown.find((b) => b.group === `income_tax:${year}`)!.lines.find((l) => l.label === '基礎控除')!.amount;
  };
  for (const [year, income, want] of [
    [2026, 1_320_000, 950_000], [2026, 1_320_001, 880_000],
    [2026, 3_360_000, 880_000], [2026, 3_360_001, 680_000],
    [2026, 4_890_000, 680_000], [2026, 4_890_001, 630_000],
    [2026, 6_550_000, 630_000], [2026, 6_550_001, 580_000],
    [2025, 3_000_000, 880_000], [2027, 1_320_000, 950_000], [2027, 1_320_001, 580_000], [2027, 3_000_000, 580_000],
  ] as const) {
    test(`基礎控除の境界: ${year} 年分・所得 ${income} → ${want}`, () => assert.equal(basic(year, income), want));
  }

  test('国保の期数と始まりの月: 6 月から 10 期、11 月から 4 期（年またぎ）', () => {
    const ys = [yr(2025, 'actual', { business_income: 3_000_000, income_tax_final: 0 })];
    const ten = pick(run({ nhi_installments: 10, nhi_first_month: 6 }, ys), 'nhi:2026:').map(([k, d]) => [k, d]);
    assert.equal(ten.length, 10);
    assert.deepEqual(ten[0], ['nhi:2026:p1', '2026-06-30']);
    assert.deepEqual(ten.slice(6), [['nhi:2026:p7', '2026-12-31'], ['nhi:2026:p8', '2027-02-01'], ['nhi:2026:p9', '2027-03-01'], ['nhi:2026:p10', '2027-03-31']]);
    const r4 = run({ nhi_installments: 4, nhi_first_month: 11, nhi_members_40_64: 1 }, ys);
    assert.deepEqual(pick(r4, 'nhi:2026:'), [
      ['nhi:2026:p1', '2026-11-30', 102_700], ['nhi:2026:p2', '2026-12-31', 102_400], ['nhi:2026:p3', '2027-02-01', 102_400], ['nhi:2026:p4', '2027-03-01', 102_400],
    ]);
  });

  test('0 円以下の期は作らない（上限 0 の上書き）', () => {
    const over = JSON.stringify({ medical: { cap: 0 }, support: { cap: 0 }, care: { cap: 0 }, children: { cap: 0 } });
    const r = run({ nhi_rates_json: over }, [yr(2025, 'actual', { business_income: 3_000_000 })]);
    assert.deepEqual(pick(r, 'nhi:'), []);
    assert.ok(r.items.every((i) => i.amount > 0));
  });

  test('プリセットが無いとき、nhi_rates_json の区分が欠けていれば国保の料率は無し（null）', () => {
    assert.equal(nhiRatesOf({ nhi_preset: null, nhi_rates_json: JSON.stringify({ medical: { rate: 0.07 } }) }), null);
    const seg = { rate: 0.05, per_capita: 10_000, cap: 500_000 };
    const full = nhiRatesOf({ nhi_preset: null, nhi_rates_json: JSON.stringify({ medical: seg, support: seg, care: seg, children: seg }) });
    assert.deepEqual(full?.medical, { ...seg, per_household: null });
    assert.equal(full?.basic_deduction, 430_000);
  });

});

describe('消費税', () => {
  const ctaxWarnings = (r: ReturnType<typeof estimate>) => r.warnings.filter((w) => w.kind !== 'income_missing');

  // 2026 年分。売上 500 万・経費 100 万。期日は 2027-03-31（水）。
  // 税込: 税抜売上 4,545,454・売上税額 454,545。税抜: 5,000,000・500,000。本則の控除は税抜経費 × 10%。
  const cases: [0 | 1, 'exempt' | 'special20' | 'simplified' | 'standard', number | null, number | null][] = [
    [1, 'exempt', null, null],
    [1, 'special20', null, 90_900],
    [1, 'simplified', 1, 45_400],
    [1, 'simplified', 5, 227_200],
    [1, 'standard', null, 363_600],
    [0, 'exempt', null, null],
    [0, 'special20', null, 100_000],
    [0, 'simplified', 1, 50_000],
    [0, 'simplified', 5, 250_000],
    [0, 'standard', null, 400_000],
  ];
  for (const [incl, mode, cls, want] of cases) {
    test(`売上 500 万・${incl ? '税込' : '税抜'}・${mode}${cls ? ` 第 ${cls} 種` : ''} → ${want ?? '作らない'}`, () => {
      const r = run({ consumption_mode: mode, simplified_class: cls, revenue_includes_tax: incl }, [yr(2026, 'estimate', { revenue: 5_000_000, expenses: 1_000_000 })], { from: '2026-04-01', to: '2027-12-31' });
      const it = byKey(r).get('ctax:2026:final');
      assert.deepEqual(ctaxWarnings(r), []);
      if (want === null) return assert.equal(it, undefined);
      assert.ok(it);
      assert.deepEqual([it.amount, it.due, it.name, it.category, it.recurrence, it.end_date], [want, '2027-03-31', '消費税 2026 年分 確定申告（見積）', 'tax', 'once', null]);
      const b = r.breakdown.find((x) => x.group === 'ctax:2026')!;
      assert.equal(b.method, mode);
      assert.equal(b.lines[0].amount, incl ? 4_545_454 : 5_000_000);
      assert.equal(b.lines[1].amount, incl ? 454_545 : 500_000);
      assert.equal(b.lines.find((l) => l.label === '年税額（国税 + 地方消費税）')!.amount, want);
    });
  }

  test('2 割特例は 2026 年分まで。2027 年分以降は作らず special20_expired（期日が期間に入る年だけ）', () => {
    const ys = [yr(2026, 'estimate', { revenue: 5_000_000, expenses: 0 }), yr(2027, 'estimate', { revenue: 5_000_000, expenses: 0 })];
    const r = run({ consumption_mode: 'special20', revenue_includes_tax: 0 }, ys, { from: '2026-04-01', to: '2029-12-31' });
    assert.deepEqual(pick(r, 'ctax:'), [['ctax:2026:final', '2027-03-31', 100_000]]);
    // 2029 年分の期日 2030-04-01 は期間（〜2029-12-31）の外。
    assert.deepEqual(ctaxWarnings(r), [{ kind: 'special20_expired', year: 2027 }, { kind: 'special20_expired', year: 2028 }]);
  });

  test('2 割特例: 前年の国税分が 48 万円を超えても、期限切れの年分（2027 年分）の中間申告は作らない', () => {
    // 2026 年分: 売上税額 4,000,000 × 20% = 800,000 → 国税分 624,000（> 48 万）。
    const r = run({ consumption_mode: 'special20', revenue_includes_tax: 0 }, [yr(2026, 'estimate', { revenue: 40_000_000, expenses: 0 })], { from: '2026-04-01', to: '2029-12-31' });
    assert.deepEqual(pick(r, 'ctax:'), [['ctax:2026:final', '2027-03-31', 800_000]]);
    // 同じ入力を本則にすると 2027 年分の中間申告が出る（対照）。
    assert.ok(byKey(run({ consumption_mode: 'standard', revenue_includes_tax: 0 }, [yr(2026, 'estimate', { revenue: 40_000_000, expenses: 0 })])).has('ctax:2027:interim1'));
  });

  test('簡易課税で事業区分が無ければ作らず simplified_class_missing', () => {
    const r = run({ consumption_mode: 'simplified', simplified_class: null }, [yr(2026, 'estimate', { revenue: 5_000_000, expenses: 0 })]);
    assert.deepEqual(pick(r, 'ctax:'), []);
    assert.deepEqual(ctaxWarnings(r), [{ kind: 'simplified_class_missing' }]);
  });

  for (const [prev, want] of [[480_000, null], [480_100, 307_600]] as const) {
    test(`中間申告: 前年の国税分 ${prev} → ${want ?? '無し'}（確定申告は中間の分を引く）`, () => {
      const ys = [yr(2025, 'actual', { business_income: 3_000_000, consumption_tax_final: prev }), yr(2026, 'estimate', { revenue: 5_000_000, expenses: 0 })];
      const r = run({ consumption_mode: 'standard', revenue_includes_tax: 0 }, ys);
      const m = byKey(r);
      if (want === null) {
        assert.equal(m.get('ctax:2026:interim1'), undefined);
        assert.equal(m.get('ctax:2026:final')!.amount, 500_000);
        return;
      }
      // 480,100 × 6/12 = 240,050 → 240,000。地方分 240,000 × 22/78 = 67,692 → 67,600。
      const it = m.get('ctax:2026:interim1')!;
      assert.deepEqual([it.amount, it.due, it.name], [307_600, '2026-08-31', '消費税 2026 年分 中間申告（見積）']);
      assert.equal(m.get('ctax:2026:final')!.amount, 500_000 - 307_600);
      const lines = r.breakdown.find((b) => b.group === 'ctax:2026')!.lines;
      assert.deepEqual(lines.slice(0, 4).map((l) => l.amount), [480_100, 240_000, 67_600, 307_600]);
    });
  }

  test('中間申告: 前年が見込み（estimate）なら見積もりの年税額 × 78/100 を国税分とみなす', () => {
    const r = run({ consumption_mode: 'standard', revenue_includes_tax: 0 }, [yr(2026, 'estimate', { revenue: 8_000_000, expenses: 0 })]);
    const m = byKey(r);
    assert.equal(m.get('ctax:2026:final')!.amount, 800_000);
    assert.equal(m.get('ctax:2026:interim1'), undefined); // 2025 年分が無い
    // 800,000 × 78/100 = 624,000 → 中間 312,000 + 地方 88,000。2027 年分は 2026 年の売上を繰り越す。
    assert.deepEqual([m.get('ctax:2027:interim1')!.amount, m.get('ctax:2027:interim1')!.due], [400_000, '2027-08-31']);
    assert.equal(m.get('ctax:2027:final')!.amount, 400_000);
    const b = r.breakdown.find((x) => x.group === 'ctax:2027')!;
    assert.equal(b.carried_from, 2026);
    assert.deepEqual(b.lines[0], { label: '中間申告の基準（2026 年分の見積もり × 78/100 を国税分とみなす）', amount: 624_000 });
  });

  test('売上がどの年にも無い（所得だけ入れた）なら作らず revenue_missing（期日が期間に入る年だけ）。consumption_tax_not_implemented は出さない', () => {
    const ys = [yr(2025, 'actual', { business_income: 3_000_000, income_tax_final: 0 })];
    // 2029 年分の期日 2030-04-01 は期間（〜2029-12-31）の外。
    const want = [2025, 2026, 2027, 2028].map((year) => ({ kind: 'revenue_missing', year }));
    for (const p of [{ consumption_mode: 'simplified', simplified_class: 1 }, { consumption_mode: 'standard' }] as const) {
      const r = run(p, ys);
      assert.deepEqual(pick(r, 'ctax:'), []);
      assert.deepEqual(r.warnings, want);
    }
    // 方式の設定で作らない年（事業区分が無い・2 割特例の期限切れ）は revenue_missing を出さない。
    assert.deepEqual(run({ consumption_mode: 'simplified', simplified_class: null }, ys).warnings, [{ kind: 'simplified_class_missing' }]);
    assert.deepEqual(run({ consumption_mode: 'special20' }, ys).warnings, [
      { kind: 'special20_expired', year: 2027 }, { kind: 'special20_expired', year: 2028 }, { kind: 'revenue_missing', year: 2025 }, { kind: 'revenue_missing', year: 2026 },
    ]);
    // exempt・unset は数えない。
    assert.deepEqual(run({ consumption_mode: 'exempt' }, ys).warnings, []);
  });
});

// 2025 年分（令和 7 年分）の値で確かめる（2026 年分の基礎控除は令和 8 年度改正の別 PR で変わるため、2026 年の給与所得控除は salaryIncomeOf 単体だけ）。
describe('給与所得（源泉徴収票の 4 欄）', () => {
  const line = (r: ReturnType<typeof estimate>, group: string, label: string) => r.breakdown.find((b) => b.group === group)!.lines.find((l) => l.label === label)?.amount;
  const total = (r: ReturnType<typeof estimate>, group: string) => r.breakdown.find((b) => b.group === group)?.total;
  const refunds = (r: ReturnType<typeof estimate>) => r.warnings.filter((w) => w.kind === 'income_tax_refund');

  test('給与所得控除の後の金額（令和 7 年分・令和 8 年分）', () => {
    for (const [income, want] of [[1_500_000, 850_000], [2_000_000, 1_320_000], [5_000_000, 3_560_000], [7_000_000, 5_200_000], [9_000_000, 7_050_000], [600_000, 0]]) {
      assert.equal(salaryIncomeOf(income, 2025), want, `2025 ${income}`);
    }
    for (const [income, want] of [[2_000_000, 1_260_000], [3_000_000, 2_020_000], [3_001_234, 2_020_000], [500_000, 0]]) {
      assert.equal(salaryIncomeOf(income, 2026), want, `2026 ${income}`);
    }
  });

  test('事業と給与が混ざる年: 合計所得で所得税・住民税・国保、事業税は事業だけ', () => {
    const r = run({ biz_tax_rate: 0.05 }, [
      yr(2025, 'estimate', { business_income: 2_000_000, salary_income: 2_000_000, salary_withheld_tax: 60_000, salary_social_insurance: 300_000, social_insurance_paid: 200_000 }),
    ]);
    const g = 'income_tax:2025';
    assert.equal(line(r, g, '2025 年の事業所得'), 2_000_000);
    assert.equal(line(r, g, '2025 年の給与所得'), 1_320_000);
    assert.equal(line(r, g, '合計所得'), 3_320_000);
    assert.equal(line(r, g, '社会保険料控除'), 500_000);
    assert.equal(line(r, g, '基礎控除'), 880_000);
    assert.equal(line(r, g, '課税所得'), 1_940_000);
    assert.equal(line(r, g, '所得税（速算表）'), 97_000);
    assert.equal(line(r, g, '年税額（復興特別所得税を含む）'), 99_037);
    assert.equal(line(r, g, '給与の源泉徴収税額'), 60_000);
    assert.equal(line(r, g, '申告納税額'), 39_000);
    assert.deepEqual(pick(r, 'income_tax:2025:'), [['income_tax:2025:final', '2026-03-16', 39_000]]);
    assert.deepEqual(pick(r, 'income_tax:2026:prepay'), []);
    assert.equal(total(r, 'resident:2026'), 241_500);
    assert.equal(total(r, 'nhi:2026'), 366_900);
    // 給与を事業税に入れると (3,320,000 + 650,000 − 2,900,000) × 5% = 53,500 になる。事業だけなら 290 万以下で作らない。
    assert.deepEqual(pick(r, 'biz_tax:'), []);
  });

  test('源泉徴収が年税額より多ければ還付: 項目は作らず income_tax_refund', () => {
    const ys = [yr(2025, 'estimate', { salary_income: 2_000_000, salary_withheld_tax: 150_000, salary_social_insurance: 300_000, social_insurance_paid: 0 })];
    const r = run({}, ys);
    // 合計所得 1,320,000 − 社保 300,000 − 基礎控除 950,000 = 70,000 → 3,500 + 73 = 3,573。
    assert.deepEqual(pick(r, 'income_tax:'), []);
    assert.deepEqual(refunds(r), [{ kind: 'income_tax_refund', year: 2025, amount: 146_427 }]);
    // 住民税は合計所得 132 万（事業 0・給与 132 万）で作る。
    assert.deepEqual(r.breakdown.find((b) => b.group === 'resident:2026')!.lines.slice(0, 3), [
      { label: '2025 年の事業所得', amount: 0 }, { label: '2025 年の給与所得', amount: 1_320_000 }, { label: '合計所得', amount: 1_320_000 },
    ]);
    // 確定申告の期日（2026-03-16）が期間の外なら警告しない。
    assert.deepEqual(refunds(run({}, ys, { from: '2026-04-01', to: '2029-12-31' })), []);
  });

  test('予定納税で納めすぎた分も還付: 予定納税の項目は残し、内訳に「還付見込み」', () => {
    const r = run({ pension_mode: 'none', nhi_preset: null }, [
      yr(2024, 'actual', { business_income: 3_000_000, income_tax_final: 300_000, prepaid_income_tax: 0 }),
      yr(2025, 'estimate', { salary_income: 2_000_000, salary_withheld_tax: 10_000, social_insurance_paid: 0 }),
    ], { from: '2025-01-01', to: '2028-12-31' });
    // 1,320,000 − 950,000 = 370,000 → 18,500 + 388 = 18,888 − 10,000 = 8,888 → 8,800。予定納税 200,000 − 8,800 = 191,200 の還付。
    assert.equal(line(r, 'income_tax:2025', '申告納税額'), 8_800);
    assert.equal(line(r, 'income_tax:2025', '還付見込み'), 191_200);
    assert.equal(total(r, 'income_tax:2025'), 8_800);
    assert.deepEqual(pick(r, 'income_tax:2025:'), [['income_tax:2025:prepay1', '2025-07-31', 100_000], ['income_tax:2025:prepay2', '2025-12-01', 100_000]]);
    assert.deepEqual(refunds(r), [{ kind: 'income_tax_refund', year: 2025, amount: 191_200 }]);
  });

  test('actual の申告納税額（確定値）からは源泉徴収を引かない', () => {
    const r = run({}, [yr(2025, 'actual', { income_tax_final: 39_000, salary_withheld_tax: 60_000 })]);
    assert.deepEqual(pick(r, 'income_tax:2025:'), [['income_tax:2025:final', '2026-03-16', 39_000]]);
  });

  test('給与の代わりに事業所得へ入れていた行と、給与の列に移した行で住民税・国保が同じ。所得税は源泉の分だけ減る', () => {
    const old = run({}, [yr(2025, 'actual', { business_income: 3_560_000, social_insurance_paid: 700_000 })]);
    const neu = run({}, [
      yr(2025, 'actual', { salary_income: 5_000_000, salary_after_deduction: 3_560_000, salary_social_insurance: 700_000, social_insurance_paid: 0, salary_withheld_tax: 123_030 }),
    ]);
    for (const r of [old, neu]) {
      assert.equal(total(r, 'resident:2026'), 245_500);
      assert.equal(total(r, 'nhi:2026'), 392_500);
    }
    assert.deepEqual(pick(old, 'income_tax:2025:'), [['income_tax:2025:final', '2026-03-16', 123_000]]);
    assert.deepEqual(pick(neu, 'income_tax:2025:'), []);
    assert.deepEqual(refunds(neu), []);
  });

  test('給与は繰り越さない: 行の無い年は事業所得だけを繰り越し、給与天引きの社会保険料も入れない', () => {
    const ys = (soc: number) => [yr(2025, 'estimate', { business_income: 2_000_000, salary_income: 2_000_000, salary_social_insurance: soc })];
    const r = run({ pension_mode: 'none', nhi_preset: null }, ys(300_000));
    assert.equal(r.breakdown.find((x) => x.group === 'income_tax:2026')!.carried_from, 2025);
    assert.equal(line(r, 'income_tax:2026', '合計所得'), 2_000_000);
    assert.equal(line(r, 'income_tax:2026', '2025 年の給与所得'), undefined);
    assert.equal(line(r, 'income_tax:2026', '社会保険料控除'), 0);
    // 2025 年は天引き分が入る（所得税・住民税とも）。
    assert.equal(line(r, 'income_tax:2025', '社会保険料控除'), 300_000);
    assert.equal(line(r, 'resident:2026', '社会保険料控除'), 300_000);
    // 年金・国保の見積もりがあっても、2026 年分の社会保険料控除は 2025 年の天引き分で変わらない。
    const soc = (x: ReturnType<typeof estimate>) => line(x, 'income_tax:2026', '社会保険料控除');
    assert.equal(soc(run({}, ys(300_000))), soc(run({}, ys(0))));
  });

  test('事業の値が無く給与だけの年は事業 0（前の年の事業を繰り越さない）。estimate の social_insurance_paid も使う', () => {
    const r = run({}, [
      yr(2024, 'actual', { business_income: 5_000_000 }),
      yr(2025, 'estimate', { salary_income: 1_500_000, social_insurance_paid: 100_000 }),
    ]);
    assert.equal(r.breakdown.find((x) => x.group === 'resident:2026')!.carried_from, undefined);
    assert.equal(line(r, 'resident:2026', '合計所得'), 850_000);
    assert.equal(line(r, 'resident:2026', '社会保険料控除'), 100_000);
  });
});
