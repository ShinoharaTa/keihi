-- 大きな出費（5 万円以上。docs/cashflow.md §15）。一覧は明細から読むたびに計算し、ここには人の判断だけを残す。
-- 1 件の明細につき判断は 1 回だけ（予定にした scheduled か、しない dismissed）。追記専用で、取り消しは無い（予定にしたものは台帳で停止する）。

CREATE TABLE large_expense_decisions (
  id TEXT PRIMARY KEY,                       -- ULID
  bank_txn_id TEXT NOT NULL UNIQUE REFERENCES bank_txns(id),
  decision TEXT NOT NULL CHECK (decision IN ('scheduled', 'dismissed')),
  scheduled_item_id TEXT REFERENCES scheduled_items(id),
  created_at TEXT NOT NULL,
  CHECK ((decision = 'scheduled') = (scheduled_item_id IS NOT NULL))   -- 台帳の項目を結ぶのは予定にしたときだけ
);

CREATE TRIGGER large_expense_decisions_no_update BEFORE UPDATE ON large_expense_decisions
BEGIN SELECT RAISE(ABORT, 'large_expense_decisions は追記専用'); END;

CREATE TRIGGER large_expense_decisions_no_delete BEFORE DELETE ON large_expense_decisions
BEGIN SELECT RAISE(ABORT, 'large_expense_decisions は削除できない'); END;
