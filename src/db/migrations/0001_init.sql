-- 初期スキーマ（docs/mvp-plan.md T1-3、docs/mvp-plan-v0.1.md T1-3、architecture.md §3.5、a2ui-review-ui.md §3.2）。
-- 日付は Asia/Tokyo の暦日（YYYY-MM-DD）、時刻は UTC の ISO8601、金額は整数の円（D10）。
-- 追記専用の表は UPDATE / DELETE をトリガで拒否する。documents と provider_uploads は状態の列だけ更新を許す。

CREATE TABLE documents (
  id TEXT PRIMARY KEY,                       -- ULID
  sha256 TEXT NOT NULL UNIQUE,               -- 受信したバイト列そのままの sha256（R4）
  bytes INTEGER NOT NULL,
  mime TEXT NOT NULL,
  orig_name TEXT,
  source TEXT NOT NULL CHECK (source IN ('pwa', 'share', 'imap')),
  source_ref TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('scan', 'e_transaction')),               -- R1
  size_preset TEXT,
  width_px INTEGER,
  height_px INTEGER,
  resolution_ok INTEGER CHECK (resolution_ok IN (0, 1)),                       -- R2。NULL は判定対象外（e_transaction）
  color_ok INTEGER CHECK (color_ok IN (0, 1)),                                 -- R3。NULL は判定対象外
  paper_required INTEGER NOT NULL DEFAULT 0 CHECK (paper_required IN (0, 1)),  -- 要件を満たさず受理した等で紙原本の保管が要る
  received_at TEXT NOT NULL,                 -- サーバーが受信した時刻（UTC）
  received_on TEXT NOT NULL,                 -- 受領日（R5。暦日、Asia/Tokyo）
  received_on_source TEXT NOT NULL CHECK (received_on_source IN ('client', 'server')),
  exif_taken_at TEXT,
  deadline_on TEXT NOT NULL,                 -- R6
  deadline_mode TEXT NOT NULL CHECK (deadline_mode IN ('early', 'cycle')),
  storage_key TEXT NOT NULL,
  no_ai INTEGER NOT NULL DEFAULT 0 CHECK (no_ai IN (0, 1)),                    -- D12
  status TEXT NOT NULL DEFAULT 'received',
  paper_status TEXT NOT NULL DEFAULT 'unknown' CHECK (paper_status IN ('keep_required', 'discard_ok', 'unknown')),
  integrity_checked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents は削除できない'); END;

-- 状態の列（status, paper_status, integrity_checked_at, paper_required の 0→1）以外の更新を拒否する。
CREATE TRIGGER documents_immutable BEFORE UPDATE ON documents
WHEN NEW.id IS NOT OLD.id OR NEW.sha256 IS NOT OLD.sha256 OR NEW.bytes IS NOT OLD.bytes OR NEW.mime IS NOT OLD.mime
  OR NEW.orig_name IS NOT OLD.orig_name OR NEW.source IS NOT OLD.source OR NEW.source_ref IS NOT OLD.source_ref
  OR NEW.kind IS NOT OLD.kind OR NEW.size_preset IS NOT OLD.size_preset
  OR NEW.width_px IS NOT OLD.width_px OR NEW.height_px IS NOT OLD.height_px
  OR NEW.resolution_ok IS NOT OLD.resolution_ok OR NEW.color_ok IS NOT OLD.color_ok
  OR (OLD.paper_required = 1 AND NEW.paper_required IS NOT 1)
  OR NEW.received_at IS NOT OLD.received_at OR NEW.received_on IS NOT OLD.received_on
  OR NEW.received_on_source IS NOT OLD.received_on_source OR NEW.exif_taken_at IS NOT OLD.exif_taken_at
  OR NEW.deadline_on IS NOT OLD.deadline_on OR NEW.deadline_mode IS NOT OLD.deadline_mode
  OR NEW.storage_key IS NOT OLD.storage_key OR NEW.no_ai IS NOT OLD.no_ai OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'documents の不変の列は更新できない'); END;

CREATE TABLE extractions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  engine TEXT NOT NULL,
  engine_ver TEXT,
  raw_json TEXT NOT NULL,
  txn_date TEXT,
  amount_total INTEGER,
  tax_by_rate_json TEXT,
  vendor_name TEXT,
  invoice_reg_no TEXT,
  confidence REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX extractions_document ON extractions(document_id);

CREATE TABLE classifications (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL REFERENCES extractions(id),
  source TEXT NOT NULL,
  model_ver TEXT,
  candidates_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  version INTEGER NOT NULL,
  txn_date TEXT,
  amount INTEGER,
  vendor TEXT,
  account_id TEXT,
  tax_id TEXT,
  credit_account TEXT,
  memo TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'personal', 'duplicate', 'reject')),
  field_sources_json TEXT,
  based_on_ai_turn_id TEXT,
  decided_at TEXT NOT NULL,
  UNIQUE (document_id, version)
);

CREATE TABLE ai_turns (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ai', 'user', 'system')),
  model TEXT,
  model_ver TEXT,
  thinking_level TEXT,
  request_sha256 TEXT,
  response_json TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, seq)
);

CREATE TABLE ui_cards (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  ai_turn_id TEXT REFERENCES ai_turns(id),
  kind TEXT NOT NULL,
  card_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'superseded'))
);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES ui_cards(id),
  option_index INTEGER,
  value TEXT,
  applied_effect_json TEXT,
  answered_at TEXT NOT NULL
);

CREATE TABLE vendor_rules (
  vendor_norm TEXT NOT NULL,
  invoice_reg_no TEXT,
  account_id TEXT,
  tax_id TEXT,
  credit_account TEXT,
  qa_memory_json TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'learned')),
  PRIMARY KEY (vendor_norm)
);

CREATE TABLE provider_masters (
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'tax', 'partner')),
  remote_id TEXT NOT NULL,
  name TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider, kind, remote_id)
);

-- 会計サービスへの証憑のアップロード（mvp-plan.md T1-3 の変更。meta_deadline_on は保存から 70 日）。
CREATE TABLE provider_uploads (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  provider TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  remote_receipt_id TEXT,
  meta_state TEXT NOT NULL DEFAULT 'none' CHECK (meta_state IN ('none', 'sent', 'verified')),
  meta_deadline_on TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  uploaded_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, provider)
);

CREATE TRIGGER provider_uploads_no_delete BEFORE DELETE ON provider_uploads
BEGIN SELECT RAISE(ABORT, 'provider_uploads は削除できない'); END;

-- 対象（document_id, provider）と、一度記録した外部 ID・アップロード日時は変えられない。
CREATE TRIGGER provider_uploads_immutable BEFORE UPDATE ON provider_uploads
WHEN NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id OR NEW.provider IS NOT OLD.provider
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.remote_receipt_id IS NOT NULL AND NEW.remote_receipt_id IS NOT OLD.remote_receipt_id)
  OR (OLD.uploaded_at IS NOT NULL AND NEW.uploaded_at IS NOT OLD.uploaded_at)
BEGIN SELECT RAISE(ABORT, 'provider_uploads の不変の列は更新できない'); END;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- freee API の呼び出し記録（T1-15 の予算）。called_on は JST の暦日（F16 が分かるまで）。
CREATE TABLE freee_calls (
  id INTEGER PRIMARY KEY,
  called_on TEXT NOT NULL,
  called_at TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('upload', 'sync', 'execute', 'auth', 'user')),
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status INTEGER,
  request_id TEXT
);
CREATE INDEX freee_calls_day ON freee_calls(called_on, purpose);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX jobs_ready ON jobs(state, run_after);

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);

-- 追記専用の表（v0.1 T1-3: audit_log・reviews・extractions・classifications・ai_turns・answers）。
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log は追記専用'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log は追記専用'); END;
CREATE TRIGGER reviews_no_update BEFORE UPDATE ON reviews BEGIN SELECT RAISE(ABORT, 'reviews は追記専用'); END;
CREATE TRIGGER reviews_no_delete BEFORE DELETE ON reviews BEGIN SELECT RAISE(ABORT, 'reviews は追記専用'); END;
CREATE TRIGGER extractions_no_update BEFORE UPDATE ON extractions BEGIN SELECT RAISE(ABORT, 'extractions は追記専用'); END;
CREATE TRIGGER extractions_no_delete BEFORE DELETE ON extractions BEGIN SELECT RAISE(ABORT, 'extractions は追記専用'); END;
CREATE TRIGGER classifications_no_update BEFORE UPDATE ON classifications BEGIN SELECT RAISE(ABORT, 'classifications は追記専用'); END;
CREATE TRIGGER classifications_no_delete BEFORE DELETE ON classifications BEGIN SELECT RAISE(ABORT, 'classifications は追記専用'); END;
CREATE TRIGGER ai_turns_no_update BEFORE UPDATE ON ai_turns BEGIN SELECT RAISE(ABORT, 'ai_turns は追記専用'); END;
CREATE TRIGGER ai_turns_no_delete BEFORE DELETE ON ai_turns BEGIN SELECT RAISE(ABORT, 'ai_turns は追記専用'); END;
CREATE TRIGGER answers_no_update BEFORE UPDATE ON answers BEGIN SELECT RAISE(ABORT, 'answers は追記専用'); END;
CREATE TRIGGER answers_no_delete BEFORE DELETE ON answers BEGIN SELECT RAISE(ABORT, 'answers は追記専用'); END;
