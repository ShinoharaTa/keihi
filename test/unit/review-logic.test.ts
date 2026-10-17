// 確認カード・確定・一覧の純関数（docs/mvp-plan.md T2-7・T2-8・T2-11）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates } from '../../src/review/card.ts';
import { alignTaxRows, amountWarnings, diffSources, missingForApprove, sendableErrors, validateValues } from '../../src/review/confirm.ts';
import { FIELDS, fromStoredTaxRows, paymentChipOptions, toStoredTaxRows, type Sources, type Values } from '../../src/review/fields.ts';
import { businessDaysLeft } from '../../src/review/list.ts';

const ACCOUNTS = [
  { id: '1', name: '会議費', key: '会議費', private: false },
  { id: '2', name: '旅費交通費', key: '旅費交通費', private: false },
  { id: '3', name: '消耗品費', key: '消耗品費', private: false },
  { id: '4', name: '雑費', key: '雑費', private: false },
];
const base = (over: Partial<Values> = {}): Values => ({
  txn_date: '2026-10-14',
  amount: 1100,
  tax_by_rate: [{ category: 'taxable_10', amount_incl_tax: 1100, tax: 100 }],
  vendor: '店',
  invoice_reg_no: null,
  qualified_invoice: false,
  account_id: '1',
  tax_id: 'taxable_10',
  payment: 'cash',
  proration_pct: 100,
  memo: null,
  ...over,
});
const ctx = { accountIds: new Set(['1', '2']), paymentIds: new Set(['cash', 'owner']) };

describe('rankCandidates', () => {
  test('辞書を先頭、残りは確信度の高い順。重複と無効な科目を除いて 3 件', () => {
    const r = rankCandidates(
      [{ account_id: '2', tax_id: 'taxable_10', confidence: 0.1, source: 'dictionary' }],
      [
        { account_id: '3', tax_id: 'taxable_10', confidence: 0.2, source: 'ai' },
        { account_id: '9', tax_id: 'taxable_10', confidence: 0.99, source: 'ai' },
        { account_id: '2', tax_id: 'taxable_10', confidence: 0.9, source: 'ai' },
        { account_id: '1', tax_id: 'taxable_8_reduced', confidence: 0.7, source: 'ai' },
        { account_id: '4', tax_id: 'taxable_10', confidence: 0.1, source: 'ai' },
      ],
      ACCOUNTS,
    );
    assert.deepEqual(r.map((c) => [c.account_id, c.source]), [['2', 'dictionary'], ['1', 'ai'], ['3', 'ai']]);
    assert.equal(r[1].name, '会議費');
  });
});

describe('validateValues', () => {
  test('送らなかった項目はカードの値のまま', () => {
    const r = validateValues({ amount: 1200 }, base(), ctx);
    assert.deepEqual(r.errors, []);
    assert.equal(r.values.amount, 1200);
    assert.equal(r.values.account_id, '1');
    assert.deepEqual([...r.given], ['amount']);
  });
  test('文字列は制御文字を除いて切り詰める。空文字は null', () => {
    const r = validateValues({ vendor: `a‮b${'x'.repeat(200)}`, memo: '   ' }, base(), ctx);
    assert.equal(r.values.vendor, `ab${'x'.repeat(98)}`);
    assert.equal(r.values.memo, null);
  });
  test('登録番号を消すと適格も外れる', () => {
    const r = validateValues({ invoice_reg_no: '' }, base({ invoice_reg_no: 'T1', qualified_invoice: true }), ctx);
    assert.deepEqual(r.errors, []);
    assert.equal(r.values.qualified_invoice, false);
  });
  test('values がオブジェクトでなければエラー', () => {
    assert.equal(validateValues([], base(), ctx).errors.length, 1);
  });
  test('税率別の区分の重複はエラー', () => {
    const row = { category: 'taxable_10', amount_incl_tax: 1, tax: 0 };
    assert.equal(validateValues({ tax_by_rate: [row, row] }, base(), ctx).errors.length, 1);
  });
});

describe('missingForApprove・amountWarnings', () => {
  test('必須の欠け（R10）', () => {
    assert.deepEqual(missingForApprove(base()), []);
    assert.deepEqual(missingForApprove(base({ vendor: null, tax_id: null })), ['vendor', 'tax_id']);
  });
  test('内訳の和 ≠ 合計は警告。内訳が無ければ確かめない', () => {
    assert.deepEqual(amountWarnings(base()), []);
    assert.deepEqual(amountWarnings(base({ amount: 1000 })), ['amount_mismatch']);
    assert.deepEqual(amountWarnings(base({ tax_by_rate: [] })), []);
  });
});

describe('sendableErrors・alignTaxRows（取引ビルダと揃える）', () => {
  test('内訳 0 円・内訳の和 ≠ 合計・按分の範囲外を拒否する。内訳が空なら合計だけで可', () => {
    assert.deepEqual(sendableErrors(base()), []);
    assert.deepEqual(sendableErrors(base({ tax_by_rate: [] })), []);
    assert.equal(sendableErrors(base({ amount: 1000 })).length, 1);
    assert.equal(sendableErrors(base({ amount: 1100, tax_by_rate: [{ category: 'taxable_10', amount_incl_tax: 1100, tax: 100 }, { category: 'non_taxable', amount_incl_tax: 0, tax: 0 }] })).length, 1);
    assert.equal(sendableErrors(base({ proration_pct: 101 })).length, 1);
    assert.equal(sendableErrors(base({ proration_pct: 50.5 })).length, 1);
  });
  test('tax_id を変えたら 1 行の内訳はその区分に揃える。複数行は内訳も送っていなければエラー', () => {
    const v = base({ tax_id: 'taxable_8_reduced' });
    assert.deepEqual(alignTaxRows(base(), v, new Set(['tax_id'])), []);
    assert.equal(v.tax_by_rate[0].category, 'taxable_8_reduced');
    const same = base();
    assert.deepEqual(alignTaxRows(base(), same, new Set(['tax_id'])), []);
    const rows = [{ category: 'taxable_10' as const, amount_incl_tax: 600, tax: 54 }, { category: 'taxable_8_reduced' as const, amount_incl_tax: 500, tax: 37 }];
    const multi = base({ tax_id: 'non_taxable', tax_by_rate: rows });
    assert.equal(alignTaxRows(base({ tax_by_rate: rows }), multi, new Set(['tax_id'])).length, 1);
    assert.deepEqual(alignTaxRows(base({ tax_by_rate: rows }), multi, new Set(['tax_id', 'tax_by_rate'])), []);
  });
});

describe('diffSources', () => {
  test('変えた項目は human、変えていない項目はカードの出所。null の項目は null', () => {
    const src = Object.fromEntries(FIELDS.map((f) => [f, null])) as Sources;
    src.account_id = 'ai';
    src.amount = 'ocr';
    const r = diffSources(base(), src, base({ account_id: '2' }));
    assert.deepEqual(r.changed, ['account_id']);
    assert.equal(r.sources.account_id, 'human');
    assert.equal(r.sources.amount, 'ocr');
    assert.equal(r.sources.memo, null);
    assert.equal(r.sources.proration_pct, 'human'); // 提案の無い既定値は人が確定したものとして扱う
  });
});

describe('税率別の符号（T4 との契約）', () => {
  test('往復できる', () => {
    const rows = [
      { category: 'taxable_10', amount_incl_tax: 1100, tax: 100 },
      { category: 'taxable_8_reduced', amount_incl_tax: 540, tax: 40 },
      { category: 'non_taxable', amount_incl_tax: 10, tax: 0 },
      { category: 'out_of_scope', amount_incl_tax: 5, tax: 0 },
    ] as const;
    const stored = toStoredTaxRows(rows);
    assert.deepEqual(stored.map((r) => r.category), ['10', '8r', 'exempt', 'na']);
    assert.deepEqual(fromStoredTaxRows(JSON.stringify(stored)), rows);
    assert.deepEqual(fromStoredTaxRows('not json'), []);
  });
});

describe('paymentChipOptions', () => {
  test('8 件まで。選択中が溢れていれば最後と入れ替える', () => {
    const all = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, label: `${i}` }));
    assert.equal(paymentChipOptions(all, null).length, 8);
    const r = paymentChipOptions(all, 'p9');
    assert.equal(r.length, 8);
    assert.equal(r[7].id, 'p9');
  });
});

describe('businessDaysLeft', () => {
  const cases: [string, string, number][] = [
    ['2026-10-16', '2026-10-16', 0],
    ['2026-10-16', '2026-10-19', 1], // 金 → 月
    ['2026-10-16', '2026-10-17', 0], // 土まで: 営業日なし
    ['2026-10-16', '2026-10-26', 6],
    ['2026-10-16', '2026-10-15', -1],
    ['2026-10-19', '2026-10-16', -1], // 月から見て前の金
    ['2026-11-02', '2026-11-04', 1], // 11/3 は文化の日
  ];
  for (const [today, dl, want] of cases) test(`${today} → ${dl} = ${want}`, () => assert.equal(businessDaysLeft(today, dl), want));
  test('年末年始を休みにする設定', () => {
    assert.equal(businessDaysLeft('2026-12-28', '2027-01-05', { yearEndHolidays: true }), 2);
    assert.equal(businessDaysLeft('2026-12-28', '2027-01-05', { yearEndHolidays: false }), 5);
  });
});
