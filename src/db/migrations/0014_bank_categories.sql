-- 明細のカテゴリの台帳（docs/cashflow.md §5、src/bank/categories.ts）。固定 13 種（builtin = 1）+ ユーザー定義（id = c_ + ULID）。
-- tag_rules と同じ可変の設定で、label・color・sort_order・archived_at・updated_at は更新してよい。id・builtin・created_at は不変。
-- 削除はしない（アーカイブだけ）。変更は監査 bank_category.created / updated / archived / unarchived に残す。
-- 並びは sort_order → id だけで決める（親子は持たない。後から parent_id を ADD COLUMN できるよう id は不変）。
-- color は style.css の k-0〜k-11。種の色は分析の画面（pwa/src/money/analysis/colors.ts）の今までの割り当て（13 番目の other は k-0 に戻る）。
CREATE TABLE bank_categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  color INTEGER NOT NULL CHECK (color BETWEEN 0 AND 11),
  sort_order INTEGER NOT NULL,
  builtin INTEGER NOT NULL CHECK (builtin IN (0, 1)),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER bank_categories_no_delete BEFORE DELETE ON bank_categories BEGIN SELECT RAISE(ABORT, 'bank_categories は削除しない（アーカイブする）'); END;
CREATE TRIGGER bank_categories_immutable BEFORE UPDATE OF id, builtin, created_at ON bank_categories BEGIN SELECT RAISE(ABORT, 'bank_categories の id・builtin・created_at は不変'); END;

INSERT INTO bank_categories (id, label, color, sort_order, builtin, archived_at, created_at, updated_at) VALUES
  ('food', '食費', 0, 10, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('daily', '日用品', 1, 20, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('transport', '交通', 2, 30, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('telecom', '通信', 3, 40, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('housing', '住居', 4, 50, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('utilities', '水道光熱', 5, 60, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('insurance', '保険', 6, 70, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('tax', '税金', 7, 80, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('car', '車', 8, 90, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('leisure', '娯楽', 9, 100, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('medical', '医療', 10, 110, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('savings', '積立', 11, 120, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z'),
  ('other', 'その他', 0, 130, 1, NULL, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z');
