# tailscale serve で keihi を tailnet に出す（docs/mvp-plan.md T1-14、D4）

keihi の web は `127.0.0.1:8795` にだけバインドしている。スマホなど tailnet 内の端末からは
`tailscale serve` の **https 8444** 経由で使う。Funnel（インターネット公開）は使わない。

- 9443 は別のサービスが使っている。触らない。
- **8796（MCP、M7 で使う予定）は serve に載せない。** tailnet にも出さない。

## 1. 前提

1. keihi-web が動いている（[systemd.md](systemd.md)）。
   ```sh
   curl -s http://127.0.0.1:8795/healthz      # {"ok":true}
   ```
2. 既存の serve の設定を確認する（9443 が残っていること、8444 が空いていること）。
   ```sh
   tailscale serve status
   ```

## 2. 設定（~/.config/keihi/config.toml）

許可するユーザーと、serve 経由で来るときの Host を書く。

```toml
[web]
# Tailscale-User-Login の値（tailscale serve が付ける）。ここに無いユーザーは 403。
allowed_users = ["you@example.com"]
# tailscale serve 経由の Host。127.0.0.1:8795 は書かなくても常に許可される。
allowed_hosts = ["<machine>.<tailnet>.ts.net:8444"]
```

- ホスト名は `tailscale status --json` の `Self.DNSName`（末尾の `.` を取る）。ポート 8444 まで含める。
- Host が許可リストに無いリクエストは 400（`invalid_host`）、Origin が許可ホスト以外の POST は 403（`invalid_origin`）。
- 書き換えたら `systemctl --user restart keihi-web.service`。

## 3. serve に載せる

```sh
tailscale serve --bg --https 8444 http://127.0.0.1:8795
tailscale serve status
```

権限が足りないと言われたら、ユーザーが手で実行する（エージェントは sudo しない）:

```sh
! sudo tailscale serve --bg --https 8444 http://127.0.0.1:8795
```

外すとき:

```sh
tailscale serve --https 8444 off
```

**8796 を載せるコマンドは実行しない**（`tailscale serve ... 8796` は書かない）。

## 4. 確認（curl）

サーバー上で（127.0.0.1 直）:

```sh
ss -ltnp | grep -E '879[56]'                     # 8795 だけが LISTEN。8796 は出ない
curl -s http://127.0.0.1:8795/healthz            # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/api/status          # 401
curl -s -H 'Tailscale-User-Login: you@example.com' http://127.0.0.1:8795/api/status
# {"ok":true,"user":"you@example.com","documents":{"total":0},"jobs":{...}}
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' http://127.0.0.1:8795/healthz  # 400
```

tailnet 内の別の端末から（serve 経由。ヘッダは serve が付ける）:

```sh
curl -s https://<machine>.<tailnet>.ts.net:8444/healthz
curl -s https://<machine>.<tailnet>.ts.net:8444/api/status
```

- 2 つ目が 400 になる場合、serve が渡す Host が設定と違う。サーバーのログか `allowed_hosts` を見直す
  （serve が Host をそのまま渡すかは実機で確かめる。[ユーザー確認]）。
- 401 になる場合、serve が `Tailscale-User-Login` を付けていない（タグ付きの端末からはユーザーのヘッダが付かない）。

## 5. 信頼の範囲（D7）

- 127.0.0.1 に直接来たリクエストの `Tailscale-User-Login` も信用する。同じ uid のローカルプロセスは DB を直接読めるので、
  信頼の境界の内側とみなす。
- WebAuthn（パスキー）は MVP 外。
