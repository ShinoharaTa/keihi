-- 給与所得（源泉徴収票の 4 欄）を tax_years に足す（docs/cashflow.md §14.1、issue #92）。
-- 給与と事業が混ざる年（退職した年）と給与だけの年を、事業所得の欄に給与所得を入れる代用なしで扱う。
-- salary_after_deduction ≤ salary_income（両方あるとき）と、源泉・社保だけで支払金額も控除後も無い行の禁止は
-- アプリで検査する（src/cashflow/tax/sync.ts）。既存の行は 4 列とも NULL（給与なし）で今と同じ結果になる。
ALTER TABLE tax_years ADD COLUMN salary_income INTEGER CHECK (salary_income IS NULL OR (typeof(salary_income) = 'integer' AND salary_income >= 0));                                   -- 支払金額
ALTER TABLE tax_years ADD COLUMN salary_after_deduction INTEGER CHECK (salary_after_deduction IS NULL OR (typeof(salary_after_deduction) = 'integer' AND salary_after_deduction >= 0)); -- 給与所得控除後の金額
ALTER TABLE tax_years ADD COLUMN salary_withheld_tax INTEGER CHECK (salary_withheld_tax IS NULL OR (typeof(salary_withheld_tax) = 'integer' AND salary_withheld_tax >= 0));             -- 源泉徴収税額
ALTER TABLE tax_years ADD COLUMN salary_social_insurance INTEGER CHECK (salary_social_insurance IS NULL OR (typeof(salary_social_insurance) = 'integer' AND salary_social_insurance >= 0)); -- 社会保険料等の金額
