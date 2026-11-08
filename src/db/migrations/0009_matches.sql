-- 明細 ⇔ 証憑の照合（docs/mvp-plan-v3.md T206・T207、docs/cashflow.md §15）。
-- 組 (bank_txn_id, document_id) ごとに行を追記し、seq 最大の行が効く。候補は保存しない（読むたびに計算する。src/bank/match.ts）。
-- 時刻は UTC の ISO8601。

CREATE TABLE txn_matches (
  seq INTEGER PRIMARY KEY,
  bank_txn_id TEXT NOT NULL REFERENCES bank_txns(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  state TEXT NOT NULL CHECK (state IN ('auto', 'confirmed', 'rejected')),   -- auto 自動 / confirmed 人（か agent）が紐付けた / rejected 外した
  actor TEXT NOT NULL CHECK (actor IN ('system', 'user', 'agent')),
  score INTEGER CHECK (score IS NULL OR (typeof(score) = 'integer' AND score BETWEEN 0 AND 100)),   -- 人の紐付けは NULL
  date_diff INTEGER CHECK (date_diff IS NULL OR typeof(date_diff) = 'integer'),   -- 明細の日 − 証憑の日
  vendor_match INTEGER CHECK (vendor_match IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX txn_matches_txn ON txn_matches(bank_txn_id, seq);
CREATE INDEX txn_matches_document ON txn_matches(document_id, seq);

-- 追記専用の表。
CREATE TRIGGER txn_matches_no_update BEFORE UPDATE ON txn_matches BEGIN SELECT RAISE(ABORT, 'txn_matches は追記専用'); END;
CREATE TRIGGER txn_matches_no_delete BEFORE DELETE ON txn_matches BEGIN SELECT RAISE(ABORT, 'txn_matches は追記専用'); END;
