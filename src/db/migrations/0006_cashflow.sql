-- P3（docs/mvp-plan-v3.md T301・§7、requirements-v2.md R-D の D1）。予定支出・予定収入の台帳と、周期の検出の候補（T302 が書く）。
-- §7 では 0007_cashflow だが、0006_mcp を後回しにしたので番号を繰り上げた。
-- 日付は Asia/Tokyo の暦日（YYYY-MM-DD）、時刻は UTC の ISO8601、金額は整数の円（D10）。日付の形は src/cashflow/schedule.ts で確かめる。

-- 予定の項目。削除はせず active = 0 にする。変更は監査ログに残す（src/cashflow/schedule.ts）。
-- anchor_date は周期の起点（最初の期日）。期日は anchor_date から周期の分だけ月を足して出す（応当日が無い月は月末）。
CREATE TABLE scheduled_items (
  id TEXT PRIMARY KEY,                       -- ULID
  name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),   -- 向きは direction で持つ
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  category TEXT NOT NULL CHECK (category IN ('tax', 'insurance', 'car', 'other', 'income')),
  account_id TEXT REFERENCES money_accounts(id),
  recurrence TEXT NOT NULL CHECK (recurrence IN ('once', 'monthly', 'bimonthly', 'yearly', 'biennial')),
  anchor_date TEXT NOT NULL,
  end_date TEXT,                             -- これより後の期日は出さない（NULL なら終わりなし）
  notify_days_before INTEGER NOT NULL DEFAULT 14 CHECK (typeof(notify_days_before) = 'integer' AND notify_days_before >= 0),
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'detected', 'estimate')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX scheduled_items_active ON scheduled_items(active);

CREATE TRIGGER scheduled_items_immutable BEFORE UPDATE ON scheduled_items
WHEN NEW.id IS NOT OLD.id OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'scheduled_items の不変の列は更新できない'); END;

CREATE TRIGGER scheduled_items_no_delete BEFORE DELETE ON scheduled_items
BEGIN SELECT RAISE(ABORT, 'scheduled_items は削除できない（active = 0 にする）'); END;

-- 周期の検出の候補（T302）。人が受け入れると scheduled_items に入れて accepted、要らなければ dismissed。
-- occurrences_json は根拠にした明細（JSON の配列）。
CREATE TABLE recurrence_candidates (
  id TEXT PRIMARY KEY,                       -- ULID
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  description_norm TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
  interval TEXT NOT NULL CHECK (interval IN ('monthly', 'bimonthly', 'yearly', 'biennial')),
  occurrences_json TEXT NOT NULL CHECK (json_valid(occurrences_json) AND json_type(occurrences_json) = 'array'),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'dismissed')),
  scheduled_item_id TEXT REFERENCES scheduled_items(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'accepted') = (scheduled_item_id IS NOT NULL))   -- 台帳の項目を結ぶのは受け入れたときだけ
);
CREATE INDEX recurrence_candidates_account ON recurrence_candidates(account_id, state);

-- 更新してよいのは state・scheduled_item_id・updated_at だけ。
CREATE TRIGGER recurrence_candidates_immutable BEFORE UPDATE ON recurrence_candidates
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.description_norm IS NOT OLD.description_norm
  OR NEW.amount IS NOT OLD.amount OR NEW.interval IS NOT OLD.interval OR NEW.occurrences_json IS NOT OLD.occurrences_json
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'recurrence_candidates は state・scheduled_item_id 以外を更新できない'); END;

CREATE TRIGGER recurrence_candidates_no_delete BEFORE DELETE ON recurrence_candidates
BEGIN SELECT RAISE(ABORT, 'recurrence_candidates は削除できない'); END;
