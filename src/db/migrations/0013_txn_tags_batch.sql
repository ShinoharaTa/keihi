-- 明細のタグの一括の上書きと取り消し（docs/cashflow.md §5、src/bank/tags.ts）。
-- batch_id は一括（POST /api/bank_txns/bulk_tag）とその取り消しで書いた版に付く ULID（1 件ずつの上書きは NULL）。
-- cleared = 1 は「上書きを外す」版（取り消しで、一つ前に上書きが無かった明細に書く。tag = unset・category = NULL）。
-- 最新の上書きが cleared = 1 なら上書き無しとして扱い、ルール・口座の既定で効くタグが決まる。
-- ADD COLUMN は UPDATE ではないので、txn_tags の追記専用のトリガはそのまま効く。
ALTER TABLE txn_tags ADD COLUMN batch_id TEXT;
ALTER TABLE txn_tags ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1));
CREATE INDEX txn_tags_batch ON txn_tags(batch_id) WHERE batch_id IS NOT NULL;

-- 取り消した一括。1 つの一括は 1 回だけ取り消せる。取り消しの一括（revert_batch_id）は取り消せない。
CREATE TABLE txn_tag_batch_reverts (
  batch_id TEXT PRIMARY KEY,
  revert_batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER txn_tag_batch_reverts_no_update BEFORE UPDATE ON txn_tag_batch_reverts BEGIN SELECT RAISE(ABORT, 'txn_tag_batch_reverts は追記専用'); END;
CREATE TRIGGER txn_tag_batch_reverts_no_delete BEFORE DELETE ON txn_tag_batch_reverts BEGIN SELECT RAISE(ABORT, 'txn_tag_batch_reverts は追記専用'); END;
