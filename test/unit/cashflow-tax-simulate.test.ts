// 税の試算（docs/cashflow.md §14.5、src/cashflow/tax/simulate.ts）。純関数なので DB は使わない。
// 金額は丸めた仮の値。期待値は estimate() の結果か rates.ts の数値から手で計算したもの。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate, type EstimateYear } from '../../src/cashflow/tax/engine.ts';
import { BIZ_TAX_DEDUCTION, ratesLatestYears } from '../../src/cashflow/tax/rates.ts';
import type { TaxProfileValues } from '../../src/cashflow/tax/repo.ts';
import { simulate, type SimInput, type SimResult } from '../../src/cashflow/tax/simulate.ts';
import { DEFAULT_PROFILE } from '../../src/cashflow/tax/sync.ts';

const prof = (p: Partial<TaxProfileValues> = {}): TaxProfileValues => ({ ...DEFAULT_PROFILE, consumption_mode: 'simplified', simplified_class: 5, ...p });
const inp = (v: Partial<SimInput> = {}): SimInput => {
  const expenses = v.expenses ?? 1_000_000;
  return { year: 2027, revenue: 8_000_000, business_income: null, taxable_purchases: expenses, ideco: 0, kyosai: 0, marginal_delta: 1_000_000, ...v, expenses };
};
const sim = (p: Partial<TaxProfileValues> = {}, v: Partial<SimInput> = {}) => simulate(prof(p), inp(v));
const amt = (r: SimResult, kind: string) => r.amounts.find((a) => a.kind === kind)!.amount;
const others = (r: SimResult) => r.amounts.filter((a) => a.kind !== 'ctax').map((a) => a.amount);
const row = (r: SimResult, mode: string, cls: number | null = null) => r.ctax_compare.find((c) => c.mode === mode && c.simplified_class === cls)!;

describe('定常状態の 1 年分', () => {
  test('5 年分を手で入れた estimate() の breakdown と 6 kind が一致する', () => {
    const p = prof({ biz_tax_rate: 0.05, nhi_members_40_64: 1 });
    const r = simulate(p, inp());
    const income = 8_000_000 - 1_000_000 - 650_000;
    const years: EstimateYear[] = [2024, 2025, 2026, 2027, 2028].map((year) => ({
      year, kind: 'estimate', revenue: 8_000_000, expenses: 1_000_000, business_income: income, social_insurance_paid: null,
      income_tax_final: null, consumption_tax_final: null, prepaid_income_tax: null,
      salary_income: null, salary_after_deduction: null, salary_withheld_tax: null, salary_social_insurance: null, source: 'manual',
    }));
    const e = estimate(p, years, { from: '2026-01-01', to: '2029-12-31' });
    const b = (kind: string, year: number) => e.breakdown.find((x) => x.kind === kind && x.year === year)!.total;
    assert.deepEqual(
      r.amounts.map((a) => [a.kind, a.year, a.basis, a.amount]),
      [
        ['income_tax', 2027, 'year', b('income_tax', 2027)],
        ['resident', 2028, 'fiscal_year', b('resident', 2028)],
        ['nhi', 2028, 'fiscal_year', b('nhi', 2028)],
        ['pension', 2027, 'fiscal_year', b('pension', 2027)],
        ['biz_tax', 2028, 'fiscal_year', b('biz_tax', 2028)],
        ['ctax', 2027, 'year', b('ctax', 2027)],
      ],
    );
    assert.ok(r.amounts.every((a) => a.amount > 0 && a.lines.length > 0));
    assert.equal(r.total, r.amounts.reduce((s, a) => s + a.amount, 0));
    assert.deepEqual(r.income, { pre_blue: 7_000_000, business_income: income });
    assert.equal(r.cash_profit, 7_000_000);
    assert.equal(r.take_home, 7_000_000 - r.total);
    assert.deepEqual(r.warnings.map((w) => w.kind), ['rates_assumed']); // 住民税 2028 年度だけ（下のテスト）
    assert.deepEqual(r.assumptions, ['steady_state']);
  });

  test('事業税: rate NULL なら 0、5% なら (青色前の所得 − 290 万) × 5% の 100 円未満切り捨て', () => {
    assert.equal(amt(sim({ biz_tax_rate: null }), 'biz_tax'), 0);
    // 青色前の所得 = 8,000,000 − 1,234,500 = 6,765,500 → (6,765,500 − 2,900,000) × 5% = 193,275 → 193,200
    assert.equal(amt(sim({ biz_tax_rate: 0.05 }, { expenses: 1_234_500 }), 'biz_tax'), Math.floor(((6_765_500 - BIZ_TAX_DEDUCTION) * 0.05) / 100) * 100);
    assert.equal(amt(sim({ biz_tax_rate: 0.05 }, { expenses: 1_234_500 }), 'biz_tax'), 193_200);
    // 290 万以下は 0。
    assert.equal(amt(sim({ biz_tax_rate: 0.05 }, { revenue: 3_000_000, expenses: 200_000 }), 'biz_tax'), 0);
  });

  test('business_income だけ: 消費税は 0、比較表はすべて revenue_missing、cash_profit = 所得 + 青色控除', () => {
    const r = sim({}, { revenue: null, business_income: 6_000_000 });
    assert.equal(amt(r, 'ctax'), 0);
    assert.ok(r.ctax_compare.every((c) => !c.available && c.reason === 'revenue_missing' && c.tax === null && c.take_home === null));
    assert.equal(r.best, null);
    assert.equal(r.cash_profit, 6_650_000);
    assert.deepEqual(r.income, { pre_blue: 6_650_000, business_income: 6_000_000 });
    assert.ok(r.warnings.some((w) => w.kind === 'selected_mode_unavailable' && w.reason === 'revenue_missing'));
  });

  test('revenue も business_income も無ければ income_required', () => {
    assert.throws(() => sim({}, { revenue: null }), { code: 'income_required' });
  });

  test('taxable_purchases は本則の消費税だけを変える', () => {
    const a = sim({ consumption_mode: 'standard', simplified_class: null });
    const b = sim({ consumption_mode: 'standard', simplified_class: null }, { taxable_purchases: 500_000 });
    assert.deepEqual(others(a), others(b));
    // 税抜売上 7,272,727 → 売上税額 727,272。課税仕入（税抜）909,090 → 90,909 / 454,545 → 45,454。
    assert.equal(amt(a, 'ctax'), 636_300);
    assert.equal(amt(b, 'ctax'), 681_800);
    assert.equal(row(b, 'simplified', 5).tax, row(a, 'simplified', 5).tax);
  });

  test('税抜入力の cash_profit = 売上 + 売上税額 − 経費 − 課税仕入 × 10%', () => {
    const r = sim({ revenue_includes_tax: 0 }, { revenue: 6_000_000, expenses: 1_000_000, taxable_purchases: 800_000 });
    assert.equal(r.cash_profit, 6_000_000 + 600_000 - 1_000_000 - 80_000);
    assert.equal(r.inputs.revenue_includes_tax, false);
  });

  test('2 年前納は 1 年前納で代え、assumptions に出す', () => {
    const r = sim({ pension_mode: 'prepay24' });
    assert.equal(amt(r, 'pension'), amt(sim({ pension_mode: 'prepay12' }), 'pension'));
    assert.deepEqual(r.assumptions, ['steady_state', 'pension_prepay24_as_prepay12']);
  });

  test('effective_rate は 4 桁で丸め、cash_profit ≤ 0 なら null', () => {
    const r = sim();
    assert.equal(r.effective_rate, Math.round((r.total / r.cash_profit) * 10_000) / 10_000);
    assert.equal(sim({}, { revenue: 1_000_000, expenses: 1_200_000 }).effective_rate, null);
  });

  test('rates_assumed: 表ごとに、引く年（住民税は Y+1）が表の最新年より先なら 1 件', () => {
    const l = ratesLatestYears();
    const ra = (year: number) => sim({}, { year }).warnings.filter((w) => w.kind === 'rates_assumed');
    // 既定の翌年（2027）: 住民税（2028 年度）だけ。
    assert.deepEqual(ra(2027), [{ kind: 'rates_assumed', year: 2028, latest: l.resident, table: 'resident' }]);
    assert.deepEqual(ra(l.resident - 1), []);
    const far = l.income_tax_basic_deduction + 1;
    assert.deepEqual(ra(far), [
      { kind: 'rates_assumed', year: far, latest: l.income_tax_basic_deduction, table: 'income_tax_basic_deduction' },
      { kind: 'rates_assumed', year: far + 1, latest: l.resident, table: 'resident' },
      { kind: 'rates_assumed', year: far, latest: l.pension, table: 'pension' },
    ]);
  });

  test('エンジンの警告は year = Y の分だけ（year を持たない警告はそのまま）', () => {
    // special20_expired は台帳向けの文なので、試算では年によらず出さない。
    for (const year of [2026, 2027]) {
      for (const consumption_mode of ['profile', 'body'] as const) {
        const r = sim({ consumption_mode: 'special20', simplified_class: null }, { year, source: { revenue: 'body', expenses: 'body', consumption_mode } });
        assert.ok(!r.warnings.some((w) => w.kind === 'special20_expired'), `${year} ${consumption_mode}`);
      }
    }
    const bi = sim({}, { year: 2026, revenue: null, business_income: 6_000_000 });
    assert.ok(bi.warnings.filter((w) => w.kind === 'revenue_missing').length <= 1);
    assert.ok(bi.warnings.filter((w) => 'year' in w && w.kind !== 'rates_assumed').every((w) => 'year' in w && w.year === 2026));
    assert.equal(sim({ consumption_mode: 'unset', simplified_class: null }).warnings.filter((w) => w.kind === 'consumption_tax_mode_unset').length, 1);
  });
});

describe('消費税の方式の比較', () => {
  test('9 行の順序、exempt = 0、方式で消費税以外は変わらない、take_home の式', () => {
    const r = sim({ biz_tax_rate: 0.05 });
    assert.deepEqual(
      r.ctax_compare.map((c) => [c.mode, c.simplified_class]),
      [['exempt', null], ['special20', null], ...[1, 2, 3, 4, 5, 6].map((c) => ['simplified', c]), ['standard', null]],
    );
    assert.equal(row(r, 'exempt').tax, 0);
    assert.deepEqual(row(r, 'exempt').notes, ['exempt_requires_no_invoice']);
    assert.deepEqual(row(r, 'standard').notes, ['standard_approx']);
    const ctax = amt(r, 'ctax');
    for (const c of r.ctax_compare.filter((x) => x.available)) {
      assert.equal(c.take_home, r.take_home + ctax - c.tax!, `${c.mode} ${c.simplified_class}`);
      const alt = sim({ biz_tax_rate: 0.05, consumption_mode: c.mode, simplified_class: c.simplified_class });
      assert.deepEqual(others(alt), others(r));
      assert.equal(amt(alt, 'ctax'), c.tax);
    }
  });

  test('2 割特例は 2026 年分まで、税抜売上 1,000 万超で over_10m、5,000 万超で簡易も over_50m', () => {
    const y26 = sim({}, { year: 2026 });
    assert.equal(row(y26, 'special20').available, true);
    // 8,000,000 / 1.1 = 7,272,727 → 727,272 × 20% = 145,454 → 145,400
    assert.equal(row(y26, 'special20').tax, 145_400);
    assert.equal(row(sim({}, { year: 2027 }), 'special20').reason, 'special20_expired');

    const big = sim({}, { year: 2026, revenue: 12_000_000 });
    assert.deepEqual([row(big, 'exempt').reason, row(big, 'special20').reason, row(big, 'simplified', 1).available], ['over_10m', 'over_10m', true]);
    // 税込 1,100 万 = 税抜 1,000 万はちょうどなので免税で可。
    assert.equal(row(sim({}, { revenue: 11_000_000 }), 'exempt').available, true);

    const huge = sim({}, { revenue: 60_000_000 });
    assert.ok(huge.ctax_compare.filter((c) => c.mode === 'simplified').every((c) => c.reason === 'over_50m'));
    assert.equal(row(huge, 'standard').available, true);
    assert.deepEqual(huge.warnings.filter((w) => w.kind === 'selected_mode_unavailable'), [{ kind: 'selected_mode_unavailable', mode: 'simplified', reason: 'over_50m' }]);
  });

  test('best: exempt を選ばない、同額は special20 → simplified → standard の順、使える方式が無ければ null', () => {
    assert.deepEqual(sim().best, { mode: 'simplified', simplified_class: 1 });
    // 経費 = 売上なら本則は 0 円、簡易より安い。
    assert.deepEqual(sim({}, { taxable_purchases: 8_000_000 }).best, { mode: 'standard', simplified_class: null });
    // 売上 0 なら全方式 0 円: 表の順で special20。
    assert.deepEqual(sim({}, { year: 2026, revenue: 0, expenses: 0 }).best, { mode: 'special20', simplified_class: null });
    assert.deepEqual(sim({}, { year: 2027, revenue: 0, expenses: 0 }).best, { mode: 'simplified', simplified_class: 1 });
    assert.equal(sim({}, { revenue: null, business_income: 5_000_000 }).best, null);
  });

  test('方式の警告: unset は ctax = 0 で consumption_tax_mode_unset、区分なしは simplified_class_missing（1 件ずつ）', () => {
    const u = sim({ consumption_mode: 'unset', simplified_class: null });
    assert.equal(amt(u, 'ctax'), 0);
    assert.equal(u.warnings.filter((w) => w.kind === 'consumption_tax_mode_unset').length, 1);
    assert.equal(u.ctax_compare.length, 9);
    const m = sim({ simplified_class: null });
    assert.equal(amt(m, 'ctax'), 0);
    assert.equal(m.warnings.filter((w) => w.kind === 'simplified_class_missing').length, 1);
    assert.ok(!m.warnings.some((w) => w.kind === 'selected_mode_unavailable'));
  });
});

describe('既定の方式の補正（mode_defaulted）', () => {
  const src = (consumption_mode: 'profile' | 'body') => ({ source: { revenue: 'body' as const, expenses: 'body' as const, consumption_mode } });

  test('profile が 2 割特例・Y = 2027・body に方式なし: profile の区分の簡易課税で計算する', () => {
    const r = sim({ consumption_mode: 'special20', simplified_class: 5 }, { year: 2027, ...src('profile') });
    const s5 = sim({ consumption_mode: 'simplified', simplified_class: 5 }, { year: 2027 });
    assert.equal(amt(r, 'ctax'), amt(s5, 'ctax'));
    assert.ok(amt(r, 'ctax') > 0);
    assert.deepEqual([r.inputs.consumption_mode, r.inputs.simplified_class, r.inputs.source.consumption_mode], ['simplified', 5, 'defaulted']);
    assert.deepEqual(r.warnings.filter((w) => w.kind === 'mode_defaulted'), [{ kind: 'mode_defaulted', from: 'special20', to: 'simplified', simplified_class: 5 }]);
    assert.ok(!r.warnings.some((w) => w.kind === 'selected_mode_unavailable' || w.kind === 'special20_expired'));
    // source が無いとき（純関数の直接呼び出し）も profile 扱い。
    assert.equal(sim({ consumption_mode: 'special20', simplified_class: 5 }, { year: 2027 }).inputs.source.consumption_mode, 'defaulted');
  });

  test('区分が無ければ本則、売上 1,000 万超（免税・2 割特例）も補正する', () => {
    const r = sim({ consumption_mode: 'special20', simplified_class: null }, { year: 2027 });
    assert.deepEqual([r.inputs.consumption_mode, r.inputs.source.consumption_mode], ['standard', 'defaulted']);
    assert.equal(amt(r, 'ctax'), amt(sim({ consumption_mode: 'standard', simplified_class: null }, { year: 2027 }), 'ctax'));
    assert.deepEqual(r.warnings.filter((w) => w.kind === 'mode_defaulted'), [{ kind: 'mode_defaulted', from: 'special20', to: 'standard', simplified_class: null }]);
    const big = sim({ consumption_mode: 'exempt', simplified_class: 3 }, { year: 2026, revenue: 12_000_000 });
    assert.deepEqual(big.warnings.filter((w) => w.kind === 'mode_defaulted'), [{ kind: 'mode_defaulted', from: 'exempt', to: 'simplified', simplified_class: 3 }]);
  });

  test('Y = 2026 なら補正しない', () => {
    const r = sim({ consumption_mode: 'special20', simplified_class: 5 }, { year: 2026, ...src('profile') });
    assert.deepEqual([r.inputs.consumption_mode, r.inputs.source.consumption_mode], ['special20', 'profile']);
    assert.equal(amt(r, 'ctax'), row(r, 'special20').tax);
    assert.ok(!r.warnings.some((w) => w.kind === 'mode_defaulted' || w.kind === 'selected_mode_unavailable'));
  });

  test('body で 2 割特例を明示したら補正せず selected_mode_unavailable のまま', () => {
    const r = sim({ consumption_mode: 'special20', simplified_class: 5 }, { year: 2027, ...src('body') });
    assert.deepEqual([r.inputs.consumption_mode, r.inputs.source.consumption_mode], ['special20', 'body']);
    assert.equal(amt(r, 'ctax'), 0);
    assert.deepEqual(r.warnings.filter((w) => w.kind === 'selected_mode_unavailable'), [{ kind: 'selected_mode_unavailable', mode: 'special20', reason: 'special20_expired' }]);
    assert.ok(!r.warnings.some((w) => w.kind === 'mode_defaulted' || w.kind === 'special20_expired'));
  });
});

describe('限界負担と掛金', () => {
  test('marginal: 既定 100 万、rate = total_increase / delta', () => {
    const r = sim();
    const up = sim({}, { revenue: 9_000_000 });
    assert.equal(r.marginal.delta, 1_000_000);
    assert.equal(r.marginal.total_increase, up.total - r.total);
    assert.equal(r.marginal.take_home_increase, up.take_home - r.take_home);
    assert.equal(r.marginal.rate, Math.round(((up.total - r.total) / 1_000_000) * 10_000) / 10_000);
    // business_income 指定時はそれにも足す。
    const b = sim({}, { revenue: null, business_income: 5_000_000, marginal_delta: 500_000 });
    assert.equal(b.marginal.total_increase, sim({}, { revenue: null, business_income: 5_500_000 }).total - b.total);
  });

  test('国保の上限を超える所得では国保の増分 0', () => {
    const a = sim({}, { revenue: 30_000_000 });
    const b = sim({}, { revenue: 31_000_000 });
    assert.equal(amt(a, 'nhi'), amt(b, 'nhi'));
    assert.equal(amt(a, 'nhi'), 670_000 + 260_000 + 30_000);
  });

  test('iDeCo・共済: 所得税・住民税だけ減り、free_cash = take_home − 掛金', () => {
    const base = sim();
    const r = sim({}, { ideco: 240_000, kyosai: 600_000 });
    assert.equal(r.deductions.saving, base.total - r.total);
    assert.ok(r.deductions.saving > 0);
    for (const k of ['nhi', 'pension', 'ctax', 'biz_tax']) assert.equal(amt(r, k), amt(base, k), k);
    assert.ok(amt(r, 'income_tax') < amt(base, 'income_tax') && amt(r, 'resident') < amt(base, 'resident'));
    assert.equal(r.free_cash, r.take_home - 840_000);
    assert.equal(r.cash_profit, base.cash_profit);
    assert.equal(r.inputs.other_deductions, 0);
    assert.deepEqual(base.deductions, { ideco: 0, kyosai: 0, saving: 0 });
  });
});
