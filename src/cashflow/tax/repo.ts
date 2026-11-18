// 税金・保険料の見積もりの表への読み書き（0008_tax.sql、docs/cashflow.md §14）。SQL はここに閉じ込める。
// 値の検査・監査ログ・再計算は src/cashflow/tax/sync.ts（呼ぶ側が同じトランザクションで残す）。
import type { Db } from '../../db/index.ts';
import { ulid } from '../../db/ids.ts';
import type { ScheduledItemRow } from '../repo.ts';

export const BLUE_RETURNS = ['65', '55', '10', 'white'] as const;
export type BlueReturn = (typeof BLUE_RETURNS)[number];
export const CONSUMPTION_MODES = ['unset', 'exempt', 'special20', 'simplified', 'standard'] as const;
export type ConsumptionMode = (typeof CONSUMPTION_MODES)[number];
// tax_years で上書きできる方式（'unset' は持たない。0016_tax_year_ctax.sql）。
export const YEAR_CONSUMPTION_MODES = ['exempt', 'special20', 'simplified', 'standard'] as const;
export type YearConsumptionMode = (typeof YEAR_CONSUMPTION_MODES)[number];
export const RESIDENT_PAY_MODES = ['ordinary4'] as const;
export type ResidentPayMode = (typeof RESIDENT_PAY_MODES)[number];
export const PENSION_MODES = ['monthly', 'prepay6', 'prepay12', 'prepay24', 'none'] as const;
export type PensionMode = (typeof PENSION_MODES)[number];
export const YEAR_KINDS = ['actual', 'estimate'] as const;
export type YearKind = (typeof YEAR_KINDS)[number];

export type TaxProfileRow = {
  id: 'default';
  blue_return: BlueReturn;
  consumption_mode: ConsumptionMode;
  simplified_class: number | null;
  revenue_includes_tax: 0 | 1;
  biz_tax_rate: number | null;
  resident_pay_mode: ResidentPayMode;
  nhi_preset: string | null;
  nhi_members: number;
  nhi_members_40_64: number;
  nhi_installments: number;
  nhi_first_month: number;
  nhi_rates_json: string | null;
  pension_mode: PensionMode;
  pension_addon: 0 | 1;
  dependents: number;
  spouse: 0 | 1;
  other_deductions: number;
  payment_account_id: string | null;
  updated_at: string;
};

// 書く列（id・updated_at 以外）。
export type TaxProfileValues = Omit<TaxProfileRow, 'id' | 'updated_at'>;

export type TaxYearRow = {
  id: string;
  year: number;
  kind: YearKind;
  revenue: number | null;
  expenses: number | null;
  business_income: number | null;
  social_insurance_paid: number | null;
  income_tax_final: number | null;
  consumption_tax_final: number | null;
  prepaid_income_tax: number | null;
  salary_income: number | null; // 源泉徴収票の支払金額
  salary_after_deduction: number | null; // 給与所得控除後の金額（無ければ salary_income から計算）
  salary_withheld_tax: number | null; // 源泉徴収税額
  salary_social_insurance: number | null; // 社会保険料等の金額（給与天引き）
  consumption_mode: YearConsumptionMode | null; // その年分の消費税の方式（NULL なら tax_profile。後の年に繰り越さない）
  simplified_class: number | null; // consumption_mode = simplified のときだけ 1〜6
  source: 'manual' | 'annualized';
  updated_at: string;
};

export type TaxYearValues = Omit<TaxYearRow, 'id' | 'year' | 'updated_at'>;

export type TaxEstimateRunRow = {
  id: string;
  created_at: string;
  actor: string;
  inputs_json: string;
  results_json: string;
  created: number;
  updated: number;
  deactivated: number;
  skipped_pinned: number;
  warnings_json: string;
};

export const PROFILE_COLUMNS = [
  'blue_return', 'consumption_mode', 'simplified_class', 'revenue_includes_tax', 'biz_tax_rate', 'resident_pay_mode', 'nhi_preset',
  'nhi_members', 'nhi_members_40_64', 'nhi_installments', 'nhi_first_month', 'nhi_rates_json', 'pension_mode', 'pension_addon',
  'dependents', 'spouse', 'other_deductions', 'payment_account_id',
] as const satisfies readonly (keyof TaxProfileValues)[];

export const YEAR_COLUMNS = [
  'kind', 'revenue', 'expenses', 'business_income', 'social_insurance_paid', 'income_tax_final', 'consumption_tax_final', 'prepaid_income_tax',
  'salary_income', 'salary_after_deduction', 'salary_withheld_tax', 'salary_social_insurance', 'consumption_mode', 'simplified_class', 'source',
] as const satisfies readonly (keyof TaxYearValues)[];

// ---- tax_profile ----

export function getTaxProfile(db: Db): TaxProfileRow | null {
  return (db.prepare(`SELECT * FROM tax_profile WHERE id = 'default'`).get() as TaxProfileRow | undefined) ?? null;
}

// 行が無ければ作り、あれば全列を書き換える。
export function upsertTaxProfile(db: Db, v: TaxProfileValues, now: string): TaxProfileRow {
  const cols = PROFILE_COLUMNS.join(', ');
  db.prepare(
    `INSERT INTO tax_profile (id, ${cols}, updated_at) VALUES ('default', ${PROFILE_COLUMNS.map(() => '?').join(', ')}, ?)
     ON CONFLICT(id) DO UPDATE SET ${PROFILE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`,
  ).run(...PROFILE_COLUMNS.map((c) => v[c]), now);
  return getTaxProfile(db)!;
}

// ---- tax_years ----

export function getTaxYear(db: Db, year: number): TaxYearRow | null {
  return (db.prepare('SELECT * FROM tax_years WHERE year = ?').get(year) as TaxYearRow | undefined) ?? null;
}

export function listTaxYears(db: Db): TaxYearRow[] {
  return db.prepare('SELECT * FROM tax_years ORDER BY year').all() as TaxYearRow[];
}

export function upsertTaxYear(db: Db, year: number, v: TaxYearValues, now: string): TaxYearRow {
  const cols = YEAR_COLUMNS.join(', ');
  db.prepare(
    `INSERT INTO tax_years (id, year, ${cols}, updated_at) VALUES (?, ?, ${YEAR_COLUMNS.map(() => '?').join(', ')}, ?)
     ON CONFLICT(year) DO UPDATE SET ${YEAR_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`,
  ).run(ulid(Date.parse(now)), year, ...YEAR_COLUMNS.map((c) => v[c]), now);
  return getTaxYear(db, year)!;
}

// ---- tax_estimate_runs（追記専用） ----

export type NewTaxEstimateRun = {
  id: string;
  actor: string;
  inputs: unknown;
  results: unknown;
  created: number;
  updated: number;
  deactivated: number;
  skippedPinned: number;
  warnings: unknown[];
  now: string;
};

export function insertTaxEstimateRun(db: Db, a: NewTaxEstimateRun): TaxEstimateRunRow {
  db.prepare(
    `INSERT INTO tax_estimate_runs (id, created_at, actor, inputs_json, results_json, created, updated, deactivated, skipped_pinned, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(a.id, a.now, a.actor, JSON.stringify(a.inputs), JSON.stringify(a.results), a.created, a.updated, a.deactivated, a.skippedPinned, JSON.stringify(a.warnings));
  return db.prepare('SELECT * FROM tax_estimate_runs WHERE id = ?').get(a.id) as TaxEstimateRunRow;
}

// 同じ時刻なら後に入れた方（ULID は同じミリ秒の中で順序がつかない）。
export function latestTaxEstimateRun(db: Db): TaxEstimateRunRow | null {
  return (db.prepare('SELECT * FROM tax_estimate_runs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as TaxEstimateRunRow | undefined) ?? null;
}

// ---- scheduled_items の見積もりの項目 ----

// key ごとの最新の行（停止したものも含む。作成順で最後）。
export function latestItemsByEstimateKey(db: Db): Map<string, ScheduledItemRow> {
  const rows = db
    .prepare(`SELECT * FROM scheduled_items WHERE estimate_key IS NOT NULL ORDER BY active, created_at, rowid`)
    .all() as ScheduledItemRow[];
  // active = 1 を後に並べるので、有効な行があればそれが残る。無ければ最も新しい停止した行。
  const m = new Map<string, ScheduledItemRow>();
  for (const r of rows) m.set(r.estimate_key!, r);
  return m;
}
