-- 周期検出 第 2 版（docs/cashflow.md §7）。不定額の印 amount_kind と、予定のカテゴリ savings（積立）を足す。
-- recurrence_candidates には却下した主体 dismissed_by（人 = human、置き換え = system）も足す。
-- category の CHECK を変えるので、0007_recurrence_quarterly.sql と同じ手順で表を作り直す:
-- 旧表を *_old に RENAME（他の表からの参照も *_old に付け替わる）→ 新しい表を作って INSERT … SELECT → 参照されなくなった旧表を DROP。
-- 列・索引・トリガーは 0008_tax.sql までの定義をそのまま写す（CHECK と足した列だけ違う）。DROP TABLE は削除のトリガーを発火しない。

ALTER TABLE recurrence_candidates RENAME TO recurrence_candidates_old;
ALTER TABLE scheduled_items RENAME TO scheduled_items_old;

CREATE TABLE scheduled_items (
  id TEXT PRIMARY KEY,                       -- ULID
  name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),   -- 向きは direction で持つ
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  category TEXT NOT NULL CHECK (category IN ('tax', 'insurance', 'car', 'savings', 'other', 'income')),
  account_id TEXT REFERENCES money_accounts(id),
  recurrence TEXT NOT NULL CHECK (recurrence IN ('once', 'monthly', 'bimonthly', 'quarterly', 'yearly', 'biennial')),
  anchor_date TEXT NOT NULL,
  end_date TEXT,                             -- これより後の期日は出さない（NULL なら終わりなし）
  notify_days_before INTEGER NOT NULL DEFAULT 14 CHECK (typeof(notify_days_before) = 'integer' AND notify_days_before >= 0),
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'detected', 'estimate')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  estimate_key TEXT CHECK (estimate_key IS NULL OR origin = 'estimate'),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1) AND (pinned = 0 OR origin = 'estimate')),
  amount_kind TEXT NOT NULL DEFAULT 'fixed' CHECK (amount_kind IN ('fixed', 'variable'))   -- variable = 金額が毎回変わる（額は概算）
);
INSERT INTO scheduled_items (id, name, amount, direction, category, account_id, recurrence, anchor_date, end_date, notify_days_before, origin, active, created_at, updated_at, estimate_key, pinned)
SELECT id, name, amount, direction, category, account_id, recurrence, anchor_date, end_date, notify_days_before, origin, active, created_at, updated_at, estimate_key, pinned
  FROM scheduled_items_old ORDER BY rowid;

CREATE TABLE recurrence_candidates (
  id TEXT PRIMARY KEY,                       -- ULID
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  description_norm TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
  interval TEXT NOT NULL CHECK (interval IN ('monthly', 'bimonthly', 'quarterly', 'yearly', 'biennial')),
  occurrences_json TEXT NOT NULL CHECK (json_valid(occurrences_json) AND json_type(occurrences_json) = 'array'),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'dismissed')),
  scheduled_item_id TEXT REFERENCES scheduled_items(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  amount_kind TEXT NOT NULL DEFAULT 'fixed' CHECK (amount_kind IN ('fixed', 'variable')),   -- variable の amount は直近の中央値
  dismissed_by TEXT CHECK (dismissed_by IN ('human', 'system')),   -- 却下した主体（system = 検出が置き換えた）。dismissed でなければ NULL
  CHECK ((state = 'accepted') = (scheduled_item_id IS NOT NULL))   -- 台帳の項目を結ぶのは受け入れたときだけ
);
-- 既存の dismissed は、監査ログに system の置き換え（reason = superseded）があれば system、それ以外は human。
INSERT INTO recurrence_candidates (id, account_id, description_norm, amount, interval, occurrences_json, state, scheduled_item_id, created_at, updated_at, dismissed_by)
SELECT id, account_id, description_norm, amount, interval, occurrences_json, state, scheduled_item_id, created_at, updated_at,
       CASE
         WHEN state <> 'dismissed' THEN NULL
         WHEN id IN (SELECT entity_id FROM audit_log
                      WHERE actor = 'system' AND action = 'recurrence_candidate.dismissed' AND json_extract(payload_json, '$.reason') = 'superseded') THEN 'system'
         ELSE 'human'
       END
  FROM recurrence_candidates_old ORDER BY rowid;

-- 旧表の索引・トリガーは旧表と一緒に消える。
DROP TABLE recurrence_candidates_old;
DROP TABLE scheduled_items_old;

CREATE INDEX scheduled_items_active ON scheduled_items(active);

-- 同じ key の有効な項目は 1 つだけ（停止した行は残るので部分索引）。
CREATE UNIQUE INDEX scheduled_items_estimate_key ON scheduled_items(estimate_key) WHERE active = 1 AND estimate_key IS NOT NULL;

CREATE TRIGGER scheduled_items_immutable BEFORE UPDATE ON scheduled_items
WHEN NEW.id IS NOT OLD.id OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at OR NEW.estimate_key IS NOT OLD.estimate_key
BEGIN SELECT RAISE(ABORT, 'scheduled_items の不変の列は更新できない'); END;

CREATE TRIGGER scheduled_items_no_delete BEFORE DELETE ON scheduled_items
BEGIN SELECT RAISE(ABORT, 'scheduled_items は削除できない（active = 0 にする）'); END;

CREATE INDEX recurrence_candidates_account ON recurrence_candidates(account_id, state);

-- 更新してよいのは state・scheduled_item_id・dismissed_by・updated_at だけ。
CREATE TRIGGER recurrence_candidates_immutable BEFORE UPDATE ON recurrence_candidates
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.description_norm IS NOT OLD.description_norm
  OR NEW.amount IS NOT OLD.amount OR NEW.interval IS NOT OLD.interval OR NEW.occurrences_json IS NOT OLD.occurrences_json
  OR NEW.created_at IS NOT OLD.created_at OR NEW.amount_kind IS NOT OLD.amount_kind
BEGIN SELECT RAISE(ABORT, 'recurrence_candidates は state・scheduled_item_id・dismissed_by 以外を更新できない'); END;

CREATE TRIGGER recurrence_candidates_no_delete BEFORE DELETE ON recurrence_candidates
BEGIN SELECT RAISE(ABORT, 'recurrence_candidates は削除できない'); END;
