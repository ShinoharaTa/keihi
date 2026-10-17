# リストア訓練と復元の手順（docs/mvp-plan-v0.1.md T5-3、architecture.md §3.4）

## 1. 自動のリストア訓練（四半期）

`keihi-drill.timer`（1/4/7/10 月の 1 日、JST 09:00 頃）→ `tools/backup/drill.ts`。

1. `restic check --read-data-subset=5%`（リポジトリの 5% のデータを実際に読んで検証）
2. `<drill_dir>/drill-<ts>/` に最新の restic スナップショット（tag `keihi`）を全量 `restic restore`
3. 復元した DB スナップショット: `PRAGMA integrity_check`、manifest との照合（ファイルの sha256、documents の件数と sha256 一覧のハッシュ、
   監査ログの最終 seq と hash）、監査ログのハッシュチェーンの verify
4. 復元した原本: documents.sha256 のすべてについてファイルがあり、中身の sha256 が一致するか。objects/ の全ファイルの sha256 を再計算し、名前と一致するか
5. 結果を本体の DB の audit（`backup.drill`）に記録。成功したら復元先を消す。**失敗したら復元先を残す**（調べ終わったら手で消す）

終了コード: 0 = 成功、1 = 失敗、2 = 始められない。通知は未決（Q6）なので、結果は journal と audit だけ。

```sh
journalctl --user -u keihi-drill --since -100d
sqlite3 ~/.local/share/keihi/keihi.db \
  "SELECT ts, json_extract(payload_json,'$.ok'), json_extract(payload_json,'$.failure_count') FROM audit_log WHERE action='backup.drill' ORDER BY seq DESC LIMIT 4"
```

- 復元先には全量が入る。`df -h ~/.local/share/keihi` で、原本の合計の 1.2 倍以上の空きがあることを確かめておく。足りなければ `[backup] drill_dir` を別のディスクに。
- 手で実行する: `~/.nvm/versions/node/v24.20.0/bin/node tools/backup/drill.ts`

### 失敗したとき

| 出力 | 見るところ |
|---|---|
| `restic check ... が失敗` | `restic check` を手で流し、壊れた pack を確かめる。保存先の障害か。新しい backup が取れているか |
| `原本の sha256 が一致しない` / `復元されていない` | 手元の原本（`~/.local/share/keihi/objects/`）の同じファイルを `sha256sum`。手元が正しければ、次の backup の後に再訓練 |
| `manifest と違う` / `integrity_check` / `監査ログの verify` | 復元した DB の問題。手元の DB で `node src/audit.ts verify` |
| `restic restore が失敗` | 保存先・パスワード・キーの期限 |

## 2. 本番の復元（ディスクの故障・機械の入れ替え）

前提: restic のパスワード（パスワードマネージャ）、保存先のキー。freee のトークンはバックアップに無いので、**再認可する**。

```sh
# 0. keihi を止める
systemctl --user stop keihi-web.service keihi-backup.timer keihi-drill.timer
# 1. restic を入れる（backup.md §1）。secrets.env を作り直す（§3。シークレットの再発行は 4 節）
set -a; . ~/.config/keihi/secrets.env; set +a
~/.local/bin/restic snapshots --tag keihi
# 2. 別の場所に復元して中身を確かめる（本番のディレクトリへ直接戻さない）
~/.local/bin/restic restore latest --tag keihi --target ~/keihi-restore
ls ~/keihi-restore/home/shino3/.local/share/keihi/snapshots/
# 3. 最新のスナップショットを DB として置く。objects をそのまま移す
mkdir -p ~/.local/share/keihi && chmod 700 ~/.local/share/keihi
cp ~/keihi-restore/home/shino3/.local/share/keihi/snapshots/keihi-<最新>.db ~/.local/share/keihi/keihi.db
cp -a ~/keihi-restore/home/shino3/.local/share/keihi/objects ~/.local/share/keihi/
# 4. 確かめる
cd ~/workspace/keihi
~/.nvm/versions/node/v24.20.0/bin/node src/audit.ts verify
npm run migrate
# 5. freee を再認可（freee-token.json は復元されない）
node src/cli/keihi.ts freee auth   # 本番の事業所
# 6. 再開
systemctl --user start keihi-web.service keihi-backup.timer keihi-drill.timer
```

- 復元した DB は「最後の backup の時点」。その後に取り込んだ書類は keihi 側に無い。freee のファイルボックスには上がっている
  （即アップロード）ので、freee 側で期間を区切って確かめ、必要なら手で取り込み直す。
- 復元した事実（いつ・どのスナップショットから・欠けた期間）を [procedures.md](procedures.md) の記録に残す。

## 3. 訓練の記録

四半期ごとに、audit の `backup.drill` の結果を見て、次を procedures.md の記録表に書く: 実施日、ok / fail、documents の件数、所要時間、対応。

## 4. シークレットの再発行

| シークレット | 再発行 | 備考 |
|---|---|---|
| restic のパスワード | **できない**（失うと復元不能） | パスワードマネージャから。変更は `restic key add` → `restic key remove`（旧鍵） |
| B2 のアプリケーションキー | B2 の管理画面で新しいキー → secrets.env → 旧キーを削除 | バケット限定・削除権限なし（backup.md §2） |
| freee の client_secret | freee アプリストアで再発行 → secrets.env | |
| freee のトークン | `keihi freee auth` で再認可 | バックアップに含めない |
| Gemini API キー | Google Cloud の keihi 専用プロジェクトで再発行 | 有料 tier のみ |
