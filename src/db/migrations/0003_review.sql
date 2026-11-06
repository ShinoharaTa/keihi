-- 確定（docs/mvp-plan.md T2-8・T2-9、mvp-plan-v0.1.md T2-8・T2-9）。
-- reviews に T4 の取引ビルダが読む列を足す（契約）:
--   proration_pct: 事業の割合（0〜100 の整数、既定 100）
--   tax_by_rate_json: [{category: '10'|'8r'|'exempt'|'na', amount_incl_tax, tax}]
--   invoice_reg_no: 登録番号（T + 13 桁）、qualified_invoice: 適格請求書として扱うか（0/1）
-- credit_account は 'cash' | 'owner' | 'card:<walletable の remote_id>' の形で入れる（src/review/fields.ts）。
ALTER TABLE reviews ADD COLUMN proration_pct INTEGER NOT NULL DEFAULT 100 CHECK (proration_pct BETWEEN 0 AND 100);
ALTER TABLE reviews ADD COLUMN tax_by_rate_json TEXT;
ALTER TABLE reviews ADD COLUMN invoice_reg_no TEXT;
ALTER TABLE reviews ADD COLUMN qualified_invoice INTEGER CHECK (qualified_invoice IN (0, 1));

-- 学習（T2-9）: AI（または辞書）の提案と人の確定が食い違った回数。
ALTER TABLE vendor_rules ADD COLUMN mismatch_count INTEGER NOT NULL DEFAULT 0;
