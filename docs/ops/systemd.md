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
