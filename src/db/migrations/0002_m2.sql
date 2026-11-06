-- M2（docs/mvp-plan.md T2-1・T2-2）。
-- 0001 の provider_masters は主キーが (provider, kind, remote_id) で版を持てず、kind に walletable も無いので、
-- 版を追記する表を別に作る（provider_masters は残すが使わない）。

-- マスタの版（T2-1）。同期のたびに、内容が変わったものだけ 1 行追記する。
-- 消えたものは retired_at を入れた行を追記する（廃止の版）。再び現れたら retired_at が NULL の行を追記する。
-- 現在の状態は (provider, kind, remote_id) ごとの id 最大の行。
CREATE TABLE provider_master_versions (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'tax', 'partner', 'walletable')),
  remote_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,                   -- 取得した 1 件（キーを並べ替えた JSON）
  data_sha256 TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE INDEX provider_master_versions_key ON provider_master_versions(provider, kind, remote_id, id);

CREATE TRIGGER provider_master_versions_no_update BEFORE UPDATE ON provider_master_versions
BEGIN SELECT RAISE(ABORT, 'provider_master_versions は追記専用'); END;
CREATE TRIGGER provider_master_versions_no_delete BEFORE DELETE ON provider_master_versions
BEGIN SELECT RAISE(ABORT, 'provider_master_versions は追記専用'); END;

-- 口座・カードの別名（T2-1。keihi 側で付ける。M6・M7 で使う）。remote_id は provider_master_versions の walletable と同じ。
CREATE TABLE walletable_aliases (
  provider TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, remote_id)
);

-- 取引先の辞書（T2-2）。確信度を足し、登録番号でも引けるようにする。
ALTER TABLE vendor_rules ADD COLUMN confidence REAL;
CREATE INDEX vendor_rules_invoice ON vendor_rules(invoice_reg_no);
