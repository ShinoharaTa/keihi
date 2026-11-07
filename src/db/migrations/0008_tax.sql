-- 税金・保険料の見積もり（docs/cashflow.md §14、mvp-plan-v3.md T306・PR1）。
-- 入力（tax_profile・tax_years）と再計算の記録（tax_estimate_runs）。計算した予定は scheduled_items に origin = 'estimate' で入れ、
-- estimate_key で追跡する（src/cashflow/tax/sync.ts）。法定の料率は DB でなく src/cashflow/tax/rates.ts。
-- 日付は Asia/Tokyo の暦日（YYYY-MM-DD）、時刻は UTC の ISO8601、金額は整数の円（D10）。

-- 税プロファイル。1 行だけ（id = 'default'）。変更は監査 tax_profile.updated。
CREATE TABLE tax_profile (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  blue_return TEXT NOT NULL CHECK (blue_return IN ('65', '55', '10', 'white')),
  consumption_mode TEXT NOT NULL CHECK (consumption_mode IN ('unset', 'exempt', 'special20', 'simplified', 'standard')),
  simplified_class INTEGER CHECK (simplified_class IS NULL OR simplified_class BETWEEN 1 AND 6),   -- 簡易課税の事業区分
  revenue_includes_tax INTEGER NOT NULL CHECK (revenue_includes_tax IN (0, 1)),
  biz_tax_rate REAL CHECK (biz_tax_rate IS NULL OR (biz_tax_rate > 0 AND biz_tax_rate < 1)),         -- NULL = 個人事業税を作らない
  resident_pay_mode TEXT NOT NULL CHECK (resident_pay_mode IN ('ordinary4')),                        -- 普通徴収 4 期
  nhi_preset TEXT,                                                                                     -- 'saitama-city-2026' 等（rates.ts）
  nhi_members INTEGER NOT NULL CHECK (typeof(nhi_members) = 'integer' AND nhi_members >= 0),
  nhi_members_40_64 INTEGER NOT NULL CHECK (typeof(nhi_members_40_64) = 'integer' AND nhi_members_40_64 >= 0 AND nhi_members_40_64 <= nhi_members),
  nhi_installments INTEGER NOT NULL CHECK (typeof(nhi_installments) = 'integer' AND nhi_installments BETWEEN 1 AND 12),
  nhi_first_month INTEGER NOT NULL CHECK (typeof(nhi_first_month) = 'integer' AND nhi_first_month BETWEEN 1 AND 12),
  nhi_rates_json TEXT CHECK (nhi_rates_json IS NULL OR (json_valid(nhi_rates_json) AND json_type(nhi_rates_json) = 'object')),   -- プリセットの上書き
  pension_mode TEXT NOT NULL CHECK (pension_mode IN ('monthly', 'prepay6', 'prepay12', 'prepay24', 'none')),
  pension_addon INTEGER NOT NULL CHECK (pension_addon IN (0, 1)),                                     -- 付加保険料
  dependents INTEGER NOT NULL CHECK (typeof(dependents) = 'integer' AND dependents >= 0),
  spouse INTEGER NOT NULL CHECK (spouse IN (0, 1)),
  other_deductions INTEGER NOT NULL CHECK (typeof(other_deductions) = 'integer' AND other_deductions >= 0),   -- iDeCo・小規模共済など年額
  payment_account_id TEXT REFERENCES money_accounts(id),                                              -- 納税口座（予定の account_id）
  updated_at TEXT NOT NULL
);

-- 年ごとの所得など。actual = 前年の確定値（申告書から転記）、estimate = 今年〜の見込み。変更は監査 tax_year.updated。
-- business_income（青色控除後）を入れたら revenue・expenses より優先する。
CREATE TABLE tax_years (
  id TEXT PRIMARY KEY,                       -- ULID
  year INTEGER NOT NULL UNIQUE CHECK (typeof(year) = 'integer' AND year BETWEEN 2000 AND 2100),
  kind TEXT NOT NULL CHECK (kind IN ('actual', 'estimate')),
  revenue INTEGER CHECK (revenue IS NULL OR (typeof(revenue) = 'integer' AND revenue >= 0)),
  expenses INTEGER CHECK (expenses IS NULL OR (typeof(expenses) = 'integer' AND expenses >= 0)),
  business_income INTEGER CHECK (business_income IS NULL OR typeof(business_income) = 'integer'),
  social_insurance_paid INTEGER CHECK (social_insurance_paid IS NULL OR (typeof(social_insurance_paid) = 'integer' AND social_insurance_paid >= 0)),
  income_tax_final INTEGER CHECK (income_tax_final IS NULL OR (typeof(income_tax_final) = 'integer' AND income_tax_final >= 0)),
  consumption_tax_final INTEGER CHECK (consumption_tax_final IS NULL OR (typeof(consumption_tax_final) = 'integer' AND consumption_tax_final >= 0)),
  prepaid_income_tax INTEGER CHECK (prepaid_income_tax IS NULL OR (typeof(prepaid_income_tax) = 'integer' AND prepaid_income_tax >= 0)),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'annualized')),
  updated_at TEXT NOT NULL
);

-- 再計算 1 回の記録。追記専用。inputs_json は profile + years のスナップショット、results_json は項目ごとの key・amount・due・内訳。
CREATE TABLE tax_estimate_runs (
  id TEXT PRIMARY KEY,                       -- ULID
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
  results_json TEXT NOT NULL CHECK (json_valid(results_json)),
  created INTEGER NOT NULL CHECK (typeof(created) = 'integer' AND created >= 0),
  updated INTEGER NOT NULL CHECK (typeof(updated) = 'integer' AND updated >= 0),
  deactivated INTEGER NOT NULL CHECK (typeof(deactivated) = 'integer' AND deactivated >= 0),
  skipped_pinned INTEGER NOT NULL CHECK (typeof(skipped_pinned) = 'integer' AND skipped_pinned >= 0),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array')
);

CREATE TRIGGER tax_estimate_runs_no_update BEFORE UPDATE ON tax_estimate_runs
BEGIN SELECT RAISE(ABORT, 'tax_estimate_runs は追記専用'); END;

CREATE TRIGGER tax_estimate_runs_no_delete BEFORE DELETE ON tax_estimate_runs
BEGIN SELECT RAISE(ABORT, 'tax_estimate_runs は追記専用'); END;

-- 見積もりの予定。estimate_key は 'income_tax:2026:final' など（origin = 'estimate' のときだけ）。
-- pinned = 1 は人が手直しした印で、再計算で上書きしない（origin = 'estimate' のときだけ）。
ALTER TABLE scheduled_items ADD COLUMN estimate_key TEXT CHECK (estimate_key IS NULL OR origin = 'estimate');
ALTER TABLE scheduled_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1) AND (pinned = 0 OR origin = 'estimate'));

-- 同じ key の有効な項目は 1 つだけ（停止した行は残るので部分索引）。
CREATE UNIQUE INDEX scheduled_items_estimate_key ON scheduled_items(estimate_key) WHERE active = 1 AND estimate_key IS NOT NULL;

-- estimate_key も不変にする（0006 の不変トリガーを置き換える）。
DROP TRIGGER scheduled_items_immutable;
CREATE TRIGGER scheduled_items_immutable BEFORE UPDATE ON scheduled_items
WHEN NEW.id IS NOT OLD.id OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at OR NEW.estimate_key IS NOT OLD.estimate_key
BEGIN SELECT RAISE(ABORT, 'scheduled_items の不変の列は更新できない'); END;
