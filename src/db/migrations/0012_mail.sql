-- メールからの証憑の取り込み（docs/cashflow.md §17、src/mail/）。
-- mail_messages は 1 通 1 行（アカウント・方式・メールの ID で一意）。添付は mail_attachments に 1 つ 1 行で追記する。
-- 件名・送信元のドメインは DB にだけ置き、監査ログには入れない。時刻は UTC の ISO8601、日付は Asia/Tokyo の暦日。

CREATE TABLE mail_messages (
  id TEXT PRIMARY KEY,                       -- ULID
  account_id TEXT NOT NULL,                  -- config.toml の [[mail.accounts]] id
  provider TEXT NOT NULL CHECK (provider IN ('gmail_api', 'imap')),
  remote_id TEXT NOT NULL,                   -- Gmail のメッセージ ID
  rfc822_message_id TEXT,                    -- Message-ID ヘッダ（documents.source_ref に入れる）
  from_domain TEXT,
  subject TEXT,
  internal_at TEXT,                          -- Gmail の internalDate（UTC）
  received_on TEXT,                          -- internal_at の JST 暦日（documents.received_on）
  raw_sha256 TEXT,                           -- メール全体（.eml）の原本
  raw_storage_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('ingested', 'body_only', 'unsupported', 'too_large', 'error')),
  error_reason TEXT CHECK (error_reason IS NULL OR error_reason IN ('fetch_failed', 'parse_failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
  -- 本文だけのメールの手がかり（埋めるのは後の PR）。
  hint_txn_date TEXT,
  hint_amount INTEGER CHECK (hint_amount IS NULL OR typeof(hint_amount) = 'integer'),
  hint_vendor TEXT,
  hint_order_ref TEXT,
  hint_extracted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, provider, remote_id)
);
CREATE INDEX mail_messages_account_internal ON mail_messages(account_id, internal_at);
CREATE INDEX mail_messages_state ON mail_messages(state);

CREATE TRIGGER mail_messages_no_delete BEFORE DELETE ON mail_messages
BEGIN SELECT RAISE(ABORT, 'mail_messages は削除できない'); END;

-- 更新できるのは state・error_reason・attempts・hint_*・updated_at だけ。メールの中身の列は、取得に失敗した行（error）を
-- 取り直したときに NULL から 1 回だけ埋められる（一度入った値は変えられない）。
CREATE TRIGGER mail_messages_immutable BEFORE UPDATE ON mail_messages
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.provider IS NOT OLD.provider
  OR NEW.remote_id IS NOT OLD.remote_id OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.rfc822_message_id IS NOT NULL AND NEW.rfc822_message_id IS NOT OLD.rfc822_message_id)
  OR (OLD.from_domain IS NOT NULL AND NEW.from_domain IS NOT OLD.from_domain)
  OR (OLD.subject IS NOT NULL AND NEW.subject IS NOT OLD.subject)
  OR (OLD.internal_at IS NOT NULL AND NEW.internal_at IS NOT OLD.internal_at)
  OR (OLD.received_on IS NOT NULL AND NEW.received_on IS NOT OLD.received_on)
  OR (OLD.raw_sha256 IS NOT NULL AND NEW.raw_sha256 IS NOT OLD.raw_sha256)
  OR (OLD.raw_storage_key IS NOT NULL AND NEW.raw_storage_key IS NOT OLD.raw_storage_key)
BEGIN SELECT RAISE(ABORT, 'mail_messages の不変の列は更新できない'); END;

CREATE TABLE mail_attachments (
  id TEXT PRIMARY KEY,                       -- ULID
  mail_message_id TEXT NOT NULL REFERENCES mail_messages(id),
  part_index INTEGER NOT NULL CHECK (typeof(part_index) = 'integer' AND part_index >= 0),   -- メールの中の添付の順番（0 から）
  filename TEXT,
  mime TEXT,                                 -- 先頭バイトで判定した MIME（対象外なら宣言の MIME）
  bytes INTEGER CHECK (bytes IS NULL OR typeof(bytes) = 'integer'),
  sha256 TEXT,                               -- too_large は取得しないので NULL
  document_id TEXT REFERENCES documents(id),  -- ingested は作った証憑、duplicate は既存の証憑
  result TEXT NOT NULL CHECK (result IN ('ingested', 'duplicate', 'unsupported', 'too_large')),
  created_at TEXT NOT NULL,
  UNIQUE (mail_message_id, part_index)
);
CREATE INDEX mail_attachments_document ON mail_attachments(document_id);

-- 追記専用の表。
CREATE TRIGGER mail_attachments_no_update BEFORE UPDATE ON mail_attachments BEGIN SELECT RAISE(ABORT, 'mail_attachments は追記専用'); END;
CREATE TRIGGER mail_attachments_no_delete BEFORE DELETE ON mail_attachments BEGIN SELECT RAISE(ABORT, 'mail_attachments は追記専用'); END;
