# バックアップ（restic）の導入と運用（docs/mvp-plan.md M5、docs/mvp-plan-v0.1.md T5-0〜T5-2・T5-4）

keihi の DB（スナップショット）と原本（objects/）を restic で暗号化し、オフサイトに**追記のみ**で送る（architecture.md §3.4）。
法令上の保存は freee のファイルボックス。keihi 側のバックアップは「望まれる」控え（legal.md §2.4）。

- 日次: `keihi-backup.timer`（JST 03:30 頃）→ `tools/backup/run.ts`
- 週 1: `restic check`（run.ts が前回の成功から 7 日以上経っていれば実行）
- 四半期: `keihi-drill.timer` → `tools/backup/drill.ts`（[restore-drill.md](restore-drill.md)）
- 月 1: freee の証憑の照合（`src/backup/verifyRemote.ts`。worker から呼ぶ。§7）
- **prune / forget はしない。** 古い restic のスナップショットは消さない（コードは許可リストで呼べないようにしてある）。

## 1. restic を入れる（ユーザー領域。sudo 不要）

apt の restic は古いことがあるので、GitHub release のバイナリを `~/.local/bin` に入れる。
この手順はリポジトリからは実行しない（手作業）。`<ver>` は https://github.com/restic/restic/releases の最新版（例 `0.18.0`）。

```sh
ver=<ver>
mkdir -p ~/.local/bin /tmp/restic-dl && cd /tmp/restic-dl
curl -fLO https://github.com/restic/restic/releases/download/v${ver}/restic_${ver}_linux_amd64.bz2
curl -fLO https://github.com/restic/restic/releases/download/v${ver}/SHA256SUMS
curl -fLO https://github.com/restic/restic/releases/download/v${ver}/SHA256SUMS.asc
# チェックサムの検証（OK と出ること）
grep " restic_${ver}_linux_amd64.bz2\$" SHA256SUMS | sha256sum -c -
# 署名の検証（任意。restic の公開鍵は https://restic.readthedocs.io/ の「Verifying releases」に載っている）
# gpg --verify SHA256SUMS.asc SHA256SUMS
bunzip2 restic_${ver}_linux_amd64.bz2
install -m 0755 restic_${ver}_linux_amd64 ~/.local/bin/restic
~/.local/bin/restic version
cd ~ && rm -rf /tmp/restic-dl
```

- `tools/backup/run.ts` は `RESTIC_BIN` → `~/.local/bin/restic` → `PATH` の順に探す。systemd --user の PATH には
  `~/.local/bin` が入らないので、この場所に置く。見つからなければ「restic が見つからない」と出して終了コード 2（audit にも残る）。
- 更新は同じ手順で上書きする。更新の前後で `restic version` を記録しておく。

### rclone を入れる（保存先を Google Drive にする場合。§2）

restic の `rclone:` バックエンドは rclone を子プロセスとして起動する。restic と同じく GitHub release のバイナリを `~/.local/bin` に入れる（手作業）。
`<ver>` は https://github.com/rclone/rclone/releases の最新版（例 `1.68.2`）。

```sh
ver=<ver>
mkdir -p ~/.local/bin /tmp/rclone-dl && cd /tmp/rclone-dl
curl -fLO https://github.com/rclone/rclone/releases/download/v${ver}/rclone-v${ver}-linux-amd64.zip
curl -fLO https://github.com/rclone/rclone/releases/download/v${ver}/SHA256SUMS
# チェックサムの検証（OK と出ること）
grep " rclone-v${ver}-linux-amd64.zip\$" SHA256SUMS | sha256sum -c -
unzip -q rclone-v${ver}-linux-amd64.zip
install -m 0755 rclone-v${ver}-linux-amd64/rclone ~/.local/bin/rclone
~/.local/bin/rclone version
cd ~ && rm -rf /tmp/rclone-dl
```

- restic の子プロセスの PATH には、keihi が先頭に `~/.local/bin` を足す（`src/backup/restic.ts` の `childEnv`）。systemd --user から動かしても restic が rclone を見つけられる。
- 更新は同じ手順で上書きする。

## 2. 保存先（Q4）

本機は **Google Drive（restic の `rclone:` バックエンド）** を使う。**Backblaze B2（EU リージョン）+ Versioning + Object Lock（governance、保持 8 年）** は代替。
保存先は `RESTIC_REPOSITORY` で差し替えられる（`b2:` / `s3:`（S3 互換）/ `sftp:` / ローカルパス）。コードは保存先を前提にしない。

### Google Drive（rclone）

ユーザーの手作業（rclone は §1 の手順で入れておく）:
1. `~/.local/bin/rclone config` で新しいリモートを作る（`n`）。
   - name: 例 `gdrive`
   - Storage: `drive`
   - client_id / client_secret: 空でもよい（rclone 共用のものになる）。共用は混むので、自前の OAuth クライアントを作って入れるのを推奨。
   - scope: **`drive.file`**（rclone が作ったファイルだけ触れる。Drive の他のファイルは見えない）
   - root_folder_id・service_account_file: 空
   - Edit advanced config: No
   - **Use auto config: No**（この機械はヘッドレスでブラウザが無い）
2. ブラウザのある PC に rclone を入れ、表示された指示どおり `rclone authorize "drive"` を実行する（client_id を自前にした場合はそれも渡す）。
   ブラウザで許可すると、その PC の端末にトークン（JSON）が出る。それをこの機械の `rclone config` の入力に貼る。
3. Configure as team drive: No。設定を保存して終了する。`~/.local/bin/rclone lsd gdrive:` がエラーなく終わること。
4. 保存先は `RESTIC_REPOSITORY=rclone:gdrive:keihi-backup`（§3）。
5. `restic init` は手作業で 1 回だけ行う（§4。`tools/backup/run.ts` の許可リストに `init` は無い）。
   restic のパスワード（`RESTIC_PASSWORD`）は**パスワードマネージャに保存する**（紛失すると復元できない）。

**Object Lock に相当するものが無い。** `drive.file` のトークンは rclone が作ったファイル（= バックアップ）を消せるので、
この機械が乗っ取られるとバックアップも消され得る。**Drive のゴミ箱（30 日）が最後の砦**。消されたことに気づいたら 30 日以内にゴミ箱から戻す。

### Backblaze B2（代替）

ユーザーの手作業（B2 に決めた場合）:
1. B2 のアカウントを作る（カード登録が要る）。
2. バケットを作る: Private、**Object Lock を有効**、既定の保持 = governance・8 年（7 年 + 余裕 1 年。[retention.md](retention.md)）。
3. アプリケーションキーをそのバケットだけに限定して発行する。**deleteFiles 等の削除権限を付けない**（listBuckets・listFiles・readFiles・writeFiles のみ）。
4. restic のパスワードを決め、**パスワードマネージャに保存する**（紛失すると復元できない）。

**[要PoC]** Object Lock 下で restic が終了時に lock ファイルを消すと delete marker になり、次の backup が成功するか
（architecture.md §3.4、mvp-plan.md のリスク表）。B2 を採る前にテスト用バケットで init → backup → backup → check を試す。
失敗するなら S3 互換の `s3:` で試すか、Q4 の見直し。

## 3. シークレットと設定

`~/.config/keihi/secrets.env`（0600。0600 以外なら run.ts は起動しない）に足す:

```sh
RESTIC_PASSWORD=...           # パスワードマネージャにも保存
RESTIC_REPOSITORY=b2:<bucket>:keihi   # config.toml の [backup] repository でもよい（そちらが優先）
B2_ACCOUNT_ID=...             # B2 のアプリケーションキー ID
B2_ACCOUNT_KEY=...            # B2 のアプリケーションキー
# S3 互換の場合: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION
```

Google Drive（rclone）の場合は B2 の行が要らない:

```sh
RESTIC_PASSWORD=...           # パスワードマネージャにも保存
RESTIC_REPOSITORY=rclone:gdrive:keihi-backup
```

- rclone のトークンは `~/.config/rclone/rclone.conf` にある（secrets.env には書かない）。keihi のバックアップの対象外なので、
  復元したら §2 の手順で rclone を再認可する。設定ファイルの場所を変えた場合は `RCLONE_CONFIG`（または `XDG_CONFIG_HOME`）を
  親の環境に置けば restic の子プロセスに引き継がれる。

- restic の子プロセスに渡すのは上の名前だけ（`src/backup/settings.ts` の `RESTIC_SECRET_KEYS`）。`GEMINI_API_KEY`・`FREEE_*` は渡さない。
- バックアップの対象は「その日のスナップショット（`<data_dir>/snapshots/keihi-<ts>.db` と `.manifest.json`）」と `<data_dir>/objects/` だけ。
  **`freee-token.json` と `secrets.env` は含めない**（対象のパスで確かめ、`--exclude` も付ける）。復元したら freee は再認可する（§4.3）。

`~/.config/keihi/config.toml` の `[backup]`（すべて省略可）:

| キー | 既定 | 意味 |
|---|---|---|
| `repository` | secrets.env の `RESTIC_REPOSITORY` | restic の保存先 |
| `keep_snapshots` | 7 | 手元に残す DB スナップショットの数（原本ではないので古いものは消す） |
| `check_interval_days` | 7 | `restic check` の間隔 |
| `read_data_subset` | `"5%"` | リストア訓練の `restic check --read-data-subset` |
| `drill_dir` | `<data_dir>/drill` | リストア訓練の復元先の親（空き容量に注意。全量が入る） |
| `remote_verify_mode` | `"download_only"` | freee の証憑の照合（§7） |

`[backup]` は `src/config.ts` の `loadConfig` で読む（web / worker / tools/backup で同じ。知らないキーはエラー）。

## 4. 初期化と手動の実行

```sh
set -a; . ~/.config/keihi/secrets.env; set +a     # この端末だけ。終わったら閉じる
~/.local/bin/restic init                          # 最初の 1 回だけ
cd ~/workspace/keihi
~/.nvm/versions/node/v24.20.0/bin/node tools/backup/run.ts --check   # 0 なら成功
~/.local/bin/restic snapshots --tag keihi
```

終了コード: 0 = 成功、1 = 失敗（audit の `backup.run` に `ok: false` と理由）、2 = 始められない（restic・DB・設定が無い）。

## 5. timer のインストール

```sh
ln -s ~/workspace/keihi/deploy/systemd/keihi-backup.service ~/.config/systemd/user/
ln -s ~/workspace/keihi/deploy/systemd/keihi-backup.timer   ~/.config/systemd/user/
ln -s ~/workspace/keihi/deploy/systemd/keihi-drill.service  ~/.config/systemd/user/
ln -s ~/workspace/keihi/deploy/systemd/keihi-drill.timer    ~/.config/systemd/user/
systemd-analyze --user verify ~/.config/systemd/user/keihi-{backup,drill}.{service,timer}
systemctl --user daemon-reload
systemctl --user enable --now keihi-backup.timer keihi-drill.timer
systemctl --user list-timers 'keihi-*'
```

- 本機のタイムゾーンは UTC。日次は `03:30 Asia/Tokyo` と明示している。四半期は `quarterly`（UTC 00:00 = JST 09:00、1/4/7/10 月の 1 日）。
- 他プロジェクトの unit・system 側の unit には触れない。

## 6. 結果の確認

```sh
journalctl --user -u keihi-backup --since -3d
sqlite3 ~/.local/share/keihi/keihi.db \
  "SELECT ts, json_extract(payload_json,'$.ok'), json_extract(payload_json,'$.check'), json_extract(payload_json,'$.error') FROM audit_log WHERE action='backup.run' ORDER BY seq DESC LIMIT 7"
```

- 通知は未決（Q6）。PWA の帯（「バックアップが 3 日以上失敗」）と `GET /api/status` は web 側の担当（v0.1 T5-4）で、まだ無い。それまでは上の確認を週 1 回、手で行う（[procedures.md](procedures.md)）。

## 7. freee の証憑の照合（T5-6）

月 1 回、keihi が上げた証憑を `GET /receipts/{id}/download`（1 秒 3 回以内、1 回 200 件まで、予算の sync 枠）で取り、手元の原本と比べる。

- `remote_verify_mode = "download_only"`（既定）: ダウンロードできて空でないことだけを確かめる。sha256 が一致したかは audit（`receipt.remote_verified` の `sha256_match`）に残すだけ。
- `remote_verify_mode = "sha256"`: freee 側と手元の原本の sha256 が違えば、その書類を要対応（needs_attention、理由 `remote_sha256_mismatch`）。手元の原本が壊れていれば `local_object_corrupt`。
- **F6（freee が再圧縮するか）を確かめてから** `sha256` に切り替える。`download_only` の audit で `sha256_match` が全件 true なら再圧縮していない材料になる。
- 4xx（消された等）は要対応（`remote_download_failed`）。429・403（使用制限）・再認可が要るときは、そこで止めて次回に回す。

## 8. エージェントにシークレットを読ませない

同じ uid のエージェントは secrets.env を読める（mvp-plan.md §4.3、D7）。Claude Code では `~/.claude/settings.json` の
`permissions.deny` に `Read(~/.config/keihi/**)` と `Read(~/.local/share/keihi/**)` を入れる。restic のパスワードを
エージェントとの会話に貼らない。
