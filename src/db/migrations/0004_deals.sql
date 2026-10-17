-- M4（docs/mvp-plan.md T4-1〜T4-7、architecture.md §3.3）。
-- deals: freee に送る取引（支出・未決済）の状態。1 文書につき 1 行（ref_number = kh-<document_id> が照合キー）。
-- 状態: queued → sending → deal_created → receipt_linked → verified / needs_attention。

CREATE TABLE deals (
  id TEXT PRIMARY KEY,                       -- ULID
  document_id TEXT NOT NULL REFERENCES documents(id),
  review_id TEXT NOT NULL REFERENCES reviews(id),   -- 送る内容を作った確定版
  provider TEXT NOT NULL,
  ref_number TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'sending', 'deal_created', 'receipt_linked', 'verified', 'needs_attention')),
  issue_date TEXT NOT NULL,                  -- 発生日（YYYY-MM-DD）。再送前の照合で GET /deals の範囲に使う
  draft_json TEXT NOT NULL,                  -- 送る内容（DealDraft。キーを並べ替えた JSON）
  draft_sha256 TEXT NOT NULL,
  remote_deal_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,       -- POST /deals を試みた回数
  last_error TEXT,
  attention_reason TEXT,                     -- needs_attention の理由
  attention_detail_json TEXT,
  attention_at TEXT,
  attention_resolved_at TEXT,                -- 人が対応済みにした時刻（POST /api/attention/:id/resolve）
  verified_at TEXT,                          -- 最後に照合で一致を確かめた時刻
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (document_id, provider),
  UNIQUE (provider, ref_number)
);
CREATE INDEX deals_state ON deals(state);

CREATE TRIGGER deals_no_delete BEFORE DELETE ON deals
BEGIN SELECT RAISE(ABORT, 'deals は削除できない'); END;

-- 対象と、一度記録した外部 ID は変えられない。
CREATE TRIGGER deals_immutable BEFORE UPDATE ON deals
WHEN NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id OR NEW.provider IS NOT OLD.provider
  OR NEW.ref_number IS NOT OLD.ref_number OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.remote_deal_id IS NOT NULL AND NEW.remote_deal_id IS NOT OLD.remote_deal_id)
BEGIN SELECT RAISE(ABORT, 'deals の不変の列は更新できない'); END;

-- 紙原本の廃棄（T4-6、R8・R9）。0001 の paper_status の CHECK に「廃棄済」が無いので、時刻の列で持つ。
-- 一度入れた時刻は消せない・変えられない。
ALTER TABLE documents ADD COLUMN paper_discarded_at TEXT;

CREATE TRIGGER documents_paper_discarded_immutable BEFORE UPDATE OF paper_discarded_at ON documents
WHEN OLD.paper_discarded_at IS NOT NULL AND NEW.paper_discarded_at IS NOT OLD.paper_discarded_at
BEGIN SELECT RAISE(ABORT, 'paper_discarded_at は変えられない'); END;
