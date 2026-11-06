// 保持期限（docs/mvp-plan-v3.md T005、docs/ops/retention.md §3）。期待値は「受領日の年分の翌年 3/16 + (years + extra_years) 年の前日」で手計算したもの。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../../src/config.ts';
import { retainUntil } from '../../src/retention.ts';

const DEFAULT: Pick<Config, 'retention'> = { retention: { years: 7, extraYears: 1, start: 'next_year_0316' } };

describe('retainUntil（既定 7 + 1 年、next_year_0316）', () => {
  const cases: [string, string, string][] = [
    ['1/1 は同じ年分', '2026-01-01', '2035-03-15'],
    ['3/15（申告期限の日）も同じ年分', '2026-03-15', '2035-03-15'],
    ['3/16 も同じ年分（受領日ではなく年で決まる）', '2026-03-16', '2035-03-15'],
    ['12/31 は同じ年分', '2026-12-31', '2035-03-15'],
    ['年末年始: 12/31 → 翌 1/1 で 1 年ずれる', '2027-01-01', '2036-03-15'],
    ['docs/ops/retention.md の例', '2027-05-10', '2036-03-15'],
    ['うるう年の 2/29', '2028-02-29', '2037-03-15'],
  ];
  for (const [name, receivedOn, want] of cases) {
    test(`${name}: ${receivedOn} → ${want}`, () => {
      assert.equal(retainUntil({ received_on: receivedOn }, DEFAULT), want);
    });
  }
});

describe('retainUntil の設定', () => {
  test('years と extra_years を足す（5 年の特例・余裕なし）', () => {
    const cfg: Pick<Config, 'retention'> = { retention: { years: 5, extraYears: 0, start: 'next_year_0316' } };
    assert.equal(retainUntil({ received_on: '2026-12-31' }, cfg), '2032-03-15');
    assert.equal(retainUntil({ received_on: '2027-01-01' }, cfg), '2033-03-15');
  });
  test('start の各モード（今は next_year_0316 だけ）。知らない規則は投げる', () => {
    for (const start of ['next_year_0316'] as const) {
      assert.equal(retainUntil({ received_on: '2026-06-01' }, { retention: { years: 7, extraYears: 1, start } }), '2035-03-15');
    }
    assert.throws(() => retainUntil({ received_on: '2026-06-01' }, { retention: { years: 7, extraYears: 1, start: 'receipt_day' as never } }));
  });
  test('不正な日付は投げる', () => {
    assert.throws(() => retainUntil({ received_on: '2026-02-30' }, DEFAULT));
    assert.throws(() => retainUntil({ received_on: '20260101' }, DEFAULT));
  });
});
