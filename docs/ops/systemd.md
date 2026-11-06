# keihi-web を systemd --user で動かす（docs/mvp-plan.md T1-14・§4.4）

`deploy/systemd/keihi-web.service` は唯一の常駐プロセス。`127.0.0.1:8795` にだけバインドする。
インストールはリポジトリからは行わない（手作業）。system 側の unit・他プロジェクトの unit には触れない。

## 1. 前提

```sh
cd ~/workspace/keihi
npm ci
npm run build                       # pwa/dist/ を作る（無ければ PWA は配信せず API だけ動く）
ls -l ~/.config/keihi/secrets.env   # 0600 であること（無いと unit が起動しない。EnvironmentFile が必須）
npm run migrate                     # DB のマイグレーション（web は起動時にマイグレーションしない）
```

- `~/.config/keihi/config.toml` の `[web] allowed_users` が空だと `/healthz` 以外はすべて 403。[serve.md](serve.md) の §2 を先に書く。
- ポートの空きを確認する: `ss -ltnp | grep -E '879[56]'`（何も出ないこと）。

## 2. インストールと起動

```sh
mkdir -p ~/.config/systemd/user
ln -s ~/workspace/keihi/deploy/systemd/keihi-web.service ~/.config/systemd/user/
systemd-analyze --user verify ~/.config/systemd/user/keihi-web.service
systemctl --user daemon-reload
systemctl --user enable --now keihi-web.service
systemctl --user status keihi-web.service
curl -s http://127.0.0.1:8795/healthz   # {"ok":true}
```

## 3. 運用

| 操作 | コマンド |
|---|---|
| ログ | `journalctl --user -u keihi-web.service -n 100` |
| 再起動（設定・コードの更新後） | `systemctl --user restart keihi-web.service` |
| 停止 | `systemctl --user stop keihi-web.service` |
| 無効化 | `systemctl --user disable --now keihi-web.service` |
| メモリ | `systemctl --user show keihi-web.service -p MemoryCurrent`（上限 MemoryMax=256M） |

- 落ちたら `Restart=on-failure` で 5 秒後に再起動する。
- 止めた後は `ss -ltnp | grep 8795` で何も出ないことを確かめる。
- MCP（8796）は M7 まで開かない。`ss` に 8796 が出たら異常。

## 4. worker（keihi-worker.service / keihi-worker.timer）

`keihi-worker.service` は oneshot。取り込み・確定のたびに web が `systemctl --user start --no-block` で起動し、
キューの実行できるジョブが無くなったら終了する（常駐しない・ポートを開かない）。

- 動作中（activating）に `start --no-block` しても新しい実行は起動せず畳まれる。worker はキューが空と判断した後に
  `[worker] linger_ms`（既定 1500ms）だけ待ってもう一度 claim し、何も無ければ終了する。
- `keihi-worker.timer` は安全網。起動 1 分後と、worker が終わってから 2 分ごとに起動する（`OnUnitInactiveSec=2min`）。
  再試行のバックオフ（1 / 5 / 30 / 120 分）や、起動を取りこぼしたジョブが次の取り込みや daily まで止まらないようにする。

```sh
ln -s ~/workspace/keihi/deploy/systemd/keihi-worker.service ~/.config/systemd/user/
ln -s ~/workspace/keihi/deploy/systemd/keihi-worker.timer ~/.config/systemd/user/
systemd-analyze --user verify ~/.config/systemd/user/keihi-worker.{service,timer}
systemctl --user daemon-reload
systemctl --user enable --now keihi-worker.timer
systemctl --user list-timers keihi-worker.timer
journalctl --user -u keihi-worker.service -n 50
```

## 5. daily（keihi-daily.service / keihi-daily.timer）

`keihi-daily.service` は oneshot。daily ジョブ（トークンの更新・マスタ同期・検索項目の期限チェック・needs_attention の集計）を
キューに積み、keihi-worker.service を起動して終わる（処理そのものは worker が行う。`src/jobs/trigger.ts daily`）。

- `keihi-daily.timer` は `OnCalendar=*-*-* 03:30:00 Asia/Tokyo`（毎日 JST 03:30。本機は UTC なのでタイムゾーンを明示する）。
- `Persistent=true`: 止まっていた間の分は、次に起動したときに 1 回だけ実行する。
- freee のリフレッシュトークンが失効していたら settings.freee_reauth_required = 1 になり、PWA の上に再認可の帯が出る
  （`GET /api/status` の `freee_reauth_required`）。`keihi freee auth` で 0 に戻る。

```sh
ln -s ~/workspace/keihi/deploy/systemd/keihi-daily.service ~/.config/systemd/user/
ln -s ~/workspace/keihi/deploy/systemd/keihi-daily.timer ~/.config/systemd/user/
systemd-analyze --user verify ~/.config/systemd/user/keihi-daily.{service,timer}
systemctl --user daemon-reload
systemctl --user enable --now keihi-daily.timer
systemctl --user list-timers keihi-daily.timer
journalctl --user -u keihi-daily.service -n 50
```

## 6. バックアップ（keihi-backup.service / keihi-backup.timer）

`keihi-backup.service` は oneshot。スナップショット → restic backup → 週 1 回 restic check（prune はしない。`tools/backup/run.ts`）。
restic は `~/.local/bin/restic`。シークレットは run.ts が secrets.env から restic 用の値だけを読む（EnvironmentFile にしない）。
詳細は [backup.md](backup.md)。

- `keihi-backup.timer` は `OnCalendar=*-*-* 03:30:00 Asia/Tokyo` + `RandomizedDelaySec=15m`（毎日 JST 03:30〜03:45）。
- `Persistent=true`: 止まっていた間の分は、次に起動したときに 1 回実行する。
- 上限は `MemoryMax=512M`・`CPUQuota=50%`・`IOSchedulingClass=idle`・`TimeoutStartSec=6h`。
- 失敗は監査ログ（backup.run）に記録し、終了コード非 0。最後の成功が 2 日より古いと PWA の上に警告帯が出る。

```sh
ln -s ~/workspace/keihi/deploy/systemd/keihi-backup.service ~/.config/systemd/user/
ln -s ~/workspace/keihi/deploy/systemd/keihi-backup.timer ~/.config/systemd/user/
systemd-analyze --user verify ~/.config/systemd/user/keihi-backup.{service,timer}
systemctl --user daemon-reload
systemctl --user enable --now keihi-backup.timer
systemctl --user list-timers keihi-backup.timer
journalctl --user -u keihi-backup.service -n 50
```

## 7. リストア訓練（keihi-drill.service / keihi-drill.timer）

`keihi-drill.service` は oneshot。restic check --read-data-subset=5% → 全量 restore → sha256 と DB の照合（`tools/backup/drill.ts`）。
詳細は [restore-drill.md](restore-drill.md)。

- `keihi-drill.timer` は `OnCalendar=quarterly` + `RandomizedDelaySec=1h`（`*-01,04,07,10-01 00:00:00`。本機は UTC なので JST の 09:00〜10:00）。
  日次バックアップ（JST 03:30 頃）と重ならない。
- `Persistent=true`: 止まっていた間の分は、次に起動したときに 1 回実行する。
- 上限は `MemoryMax=1G`・`CPUQuota=50%`・`IOSchedulingClass=idle`・`TimeoutStartSec=12h`。
- 結果は監査ログ（backup.drill）と journal。失敗は終了コード非 0 で、PWA の上に警告帯が出る。

```sh
ln -s ~/workspace/keihi/deploy/systemd/keihi-drill.service ~/.config/systemd/user/
ln -s ~/workspace/keihi/deploy/systemd/keihi-drill.timer ~/.config/systemd/user/
systemd-analyze --user verify ~/.config/systemd/user/keihi-drill.{service,timer}
systemctl --user daemon-reload
systemctl --user enable --now keihi-drill.timer
systemctl --user list-timers keihi-drill.timer
journalctl --user -u keihi-drill.service -n 50
```
