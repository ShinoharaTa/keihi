-- P1（docs/mvp-plan-v3.md T102・§7、requirements-v2.md R-A）。口座・明細・取り込みの記録・タグ・振替。
-- 明細と取り込みの記録は消さない。追記専用の表は UPDATE / DELETE をトリガで拒否する（0001 の audit_log と同じ）。
-- 日付は Asia/Tokyo の暦日（YYYY-MM-DD）、時刻は UTC の ISO8601、金額は整数の円（D10）。

-- 口座（freee の walletable 1 つ、または CSV だけの口座 1 つにつき 1 行）。
-- freee_walletable_id は src/masters/sync.ts の walletableRemoteId と同じ `type:id`（type が違えば id が重なりうる）。
CREATE TABLE money_accounts (
  id TEXT PRIMARY KEY,                       -- ULID
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bank', 'card', 'wallet', 'paypay', 'cash')),
  source TEXT NOT NULL CHECK (source IN ('freee', 'csv')),
  freee_walletable_id TEXT UNIQUE,
  default_tag TEXT NOT NULL DEFAULT 'unset' CHECK (default_tag IN ('unset', 'business', 'private')),
  mcp_visibility TEXT NOT NULL DEFAULT 'summary' CHECK (mcp_visibility IN ('full', 'summary', 'none')),
  include_in_cashflow INTEGER NOT NULL DEFAULT 1 CHECK (include_in_cashflow IN (0, 1)),
  card_settlement_account_id TEXT REFERENCES money_accounts(id),   -- カードの引き落とし口座（T107）
  card_settlement_pattern TEXT,              -- 引き落としの摘要のパターン（T107）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 設定の列（name, default_tag, mcp_visibility, include_in_cashflow, card_settlement_*, updated_at）以外の更新を拒否する。
-- freee_walletable_id は一度入れたら変えられない。
CREATE TRIGGER money_accounts_immutable BEFORE UPDATE ON money_accounts
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.source IS NOT OLD.source
  OR (OLD.freee_walletable_id IS NOT NULL AND NEW.freee_walletable_id IS NOT OLD.freee_walletable_id)
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'money_accounts の不変の列は更新できない'); END;

-- 明細。1 件の入出金につき 1 行（API と CSV の両方から来ても 1 行。取得元は bank_txn_sources）。
CREATE TABLE bank_txns (
  id TEXT PRIMARY KEY,                       -- ULID
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  txn_date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),   -- 向きは side で持つ
  side TEXT NOT NULL CHECK (side IN ('income', 'expense')),
  description TEXT NOT NULL,
  description_norm TEXT NOT NULL,
  freee_status INTEGER CHECK (freee_status IN (1, 2, 3, 4, 6)),   -- wallet_txns の status。CSV だけの明細は NULL
  due_amount INTEGER,
  balance INTEGER,                           -- 取引後の残高（取れる取得元だけ）
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX bank_txns_account_date ON bank_txns(account_id, txn_date);

CREATE TRIGGER bank_txns_no_delete BEFORE DELETE ON bank_txns
BEGIN SELECT RAISE(ABORT, 'bank_txns は削除できない'); END;

-- 更新してよいのは freee_status・due_amount・last_seen_at だけ。
CREATE TRIGGER bank_txns_immutable BEFORE UPDATE ON bank_txns
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.txn_date IS NOT OLD.txn_date
  OR NEW.amount IS NOT OLD.amount OR NEW.side IS NOT OLD.side
  OR NEW.description IS NOT OLD.description OR NEW.description_norm IS NOT OLD.description_norm
  OR NEW.balance IS NOT OLD.balance OR NEW.first_seen_at IS NOT OLD.first_seen_at
BEGIN SELECT RAISE(ABORT, 'bank_txns の不変の列は更新できない'); END;

-- CSV の取り込み 1 回につき 1 行。同じ口座に同じファイルは 2 回入れない。
CREATE TABLE csv_imports (
  id TEXT PRIMARY KEY,                       -- ULID
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  parser_id TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,                 -- 原本の CSV（objects）
  rows_total INTEGER NOT NULL CHECK (rows_total >= 0),
  rows_new INTEGER NOT NULL CHECK (rows_new >= 0),
  rows_merged INTEGER NOT NULL CHECK (rows_merged >= 0),
  rows_error INTEGER NOT NULL CHECK (rows_error >= 0),
  actor TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (account_id, file_sha256)
);

-- 明細の取得元。account_id は bank_txns と同じ値を持たせ、口座の中で外部 ID を一意にする。
CREATE TABLE bank_txn_sources (
  bank_txn_id TEXT NOT NULL REFERENCES bank_txns(id),
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  source TEXT NOT NULL CHECK (source IN ('freee', 'csv')),
  external_id TEXT NOT NULL,                 -- freee は wallet_txn の id、CSV はパーサーが決める（取引番号など）
  csv_import_id TEXT REFERENCES csv_imports(id),
  raw_sha256 TEXT,
  UNIQUE (account_id, source, external_id)
);
CREATE INDEX bank_txn_sources_txn ON bank_txn_sources(bank_txn_id);

CREATE TRIGGER bank_txn_sources_account BEFORE INSERT ON bank_txn_sources
WHEN NEW.account_id IS NOT (SELECT account_id FROM bank_txns WHERE id = NEW.bank_txn_id)
BEGIN SELECT RAISE(ABORT, 'bank_txn_sources の account_id が明細の口座と違う'); END;

-- 残高の記録。最新は (account_id ごとに) as_of_date が最大の行。
CREATE TABLE account_balances (
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  as_of_date TEXT NOT NULL,
  balance INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('freee_walletable', 'freee_txn', 'csv', 'manual')),
  recorded_at TEXT NOT NULL
);
CREATE INDEX account_balances_account_date ON account_balances(account_id, as_of_date);

-- 明細の事業/私用タグとカテゴリ。明細ごとに版を追記し、version 最大の行が有効。
CREATE TABLE txn_tags (
  bank_txn_id TEXT NOT NULL REFERENCES bank_txns(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  tag TEXT NOT NULL CHECK (tag IN ('business', 'private', 'unset')),
  category TEXT,                             -- 一覧は V10（T108）
  source TEXT NOT NULL CHECK (source IN ('rule', 'human', 'agent')),
  actor TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  UNIQUE (bank_txn_id, version)
);

-- タグのルール（T108）。account_id が NULL なら全口座に当たる。
CREATE TABLE tag_rules (
  id TEXT PRIMARY KEY,                       -- ULID
  account_id TEXT REFERENCES money_accounts(id),
  pattern TEXT NOT NULL,
  match TEXT NOT NULL CHECK (match IN ('exact', 'prefix', 'partial')),
  tag TEXT NOT NULL CHECK (tag IN ('business', 'private', 'unset')),
  category TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('learned', 'manual')),
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tag_rules_account ON tag_rules(account_id);

-- 口座間の振替・カードの引き落とし・チャージの組（T107）。組ごとに id 最大の行が有効。
CREATE TABLE transfer_links (
  id TEXT PRIMARY KEY,                       -- ULID
  out_txn_id TEXT NOT NULL REFERENCES bank_txns(id),
  in_txn_id TEXT NOT NULL REFERENCES bank_txns(id),
  kind TEXT NOT NULL CHECK (kind IN ('transfer', 'card_settlement', 'charge')),
  source TEXT NOT NULL CHECK (source IN ('auto', 'human')),
  state TEXT NOT NULL CHECK (state IN ('active', 'rejected')),
  created_at TEXT NOT NULL
);
CREATE INDEX transfer_links_out ON transfer_links(out_txn_id);
CREATE INDEX transfer_links_in ON transfer_links(in_txn_id);

-- 口座ごとの取得状況（A5）。
CREATE TABLE sync_status (
  account_id TEXT PRIMARY KEY REFERENCES money_accounts(id),
  last_sync_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  last_csv_at TEXT,
  backfill_done_until TEXT                   -- 過去分をここまで取った（暦日。T104）
);

-- keihi が freee に作った自動登録ルール（T109）。作ったときと消したときに 1 行ずつ追記する。
CREATE TABLE freee_rule_links (
  id TEXT PRIMARY KEY,                       -- ULID
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  remote_matcher_id TEXT NOT NULL,
  act INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  created_at TEXT NOT NULL
);
CREATE INDEX freee_rule_links_account ON freee_rule_links(account_id);

-- 追記専用の表。
CREATE TRIGGER bank_txn_sources_no_update BEFORE UPDATE ON bank_txn_sources BEGIN SELECT RAISE(ABORT, 'bank_txn_sources は追記専用'); END;
CREATE TRIGGER bank_txn_sources_no_delete BEFORE DELETE ON bank_txn_sources BEGIN SELECT RAISE(ABORT, 'bank_txn_sources は追記専用'); END;
CREATE TRIGGER csv_imports_no_update BEFORE UPDATE ON csv_imports BEGIN SELECT RAISE(ABORT, 'csv_imports は追記専用'); END;
CREATE TRIGGER csv_imports_no_delete BEFORE DELETE ON csv_imports BEGIN SELECT RAISE(ABORT, 'csv_imports は追記専用'); END;
CREATE TRIGGER account_balances_no_update BEFORE UPDATE ON account_balances BEGIN SELECT RAISE(ABORT, 'account_balances は追記専用'); END;
CREATE TRIGGER account_balances_no_delete BEFORE DELETE ON account_balances BEGIN SELECT RAISE(ABORT, 'account_balances は追記専用'); END;
CREATE TRIGGER txn_tags_no_update BEFORE UPDATE ON txn_tags BEGIN SELECT RAISE(ABORT, 'txn_tags は追記専用'); END;
CREATE TRIGGER txn_tags_no_delete BEFORE DELETE ON txn_tags BEGIN SELECT RAISE(ABORT, 'txn_tags は追記専用'); END;
CREATE TRIGGER transfer_links_no_update BEFORE UPDATE ON transfer_links BEGIN SELECT RAISE(ABORT, 'transfer_links は追記専用'); END;
CREATE TRIGGER transfer_links_no_delete BEFORE DELETE ON transfer_links BEGIN SELECT RAISE(ABORT, 'transfer_links は追記専用'); END;
CREATE TRIGGER freee_rule_links_no_update BEFORE UPDATE ON freee_rule_links BEGIN SELECT RAISE(ABORT, 'freee_rule_links は追記専用'); END;
CREATE TRIGGER freee_rule_links_no_delete BEFORE DELETE ON freee_rule_links BEGIN SELECT RAISE(ABORT, 'freee_rule_links は追記専用'); END;
