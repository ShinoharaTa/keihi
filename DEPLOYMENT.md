# keihi をコンテナで動かす（Coolify）

keihi を Docker イメージにして、Coolify（Traefik + Cloudflare Tunnel + Cloudflare Access の裏）で動かすための手順書。
従来の構成（systemd --user + Tailscale。`docs/ops/systemd.md`・`docs/ops/serve.md`）は**そのまま使える**。
環境変数を何も足さなければ、動作は従来と同じ。

- [1. 構成](#1-構成)
- [2. ビルドと起動](#2-ビルドと起動)
- [3. 環境変数](#3-環境変数)
- [4. Coolify の登録](#4-coolify-の登録)
- [5. ヘルスチェック](#5-ヘルスチェック)
- [6. データベースと永続化](#6-データベースと永続化)
- [7. ログ](#7-ログ)
- [8. Cloudflare Access](#8-cloudflare-access)
- [9. 検証](#9-検証)
- [10. 開発サーバーからの運用](#10-開発サーバーからの運用)
- [11. 本番の切り替え](#11-本番の切り替え)
- [12. ロールバック](#12-ロールバック)
- [13. 未解決の課題](#13-未解決の課題)

## 1. 構成

| 項目 | 内容 |
|---|---|
| コンテナ | **1 つ**（Docker Compose は不要） |
| プロセス | `node src/web/main.ts`（PID 1）。worker はこのプロセスが子プロセスで起動する |
| ポート | `8795`（HTTP。TLS は Traefik / Cloudflare 側） |
| 永続化 | `/data`（SQLite・原本の画像と PDF・OAuth のトークン） |
| 実行ユーザー | `node`（uid 1000、非 root） |
| レプリカ | **1 つだけ**（SQLite のファイルを 1 つのコンテナが持つ） |
| 外向きの通信 | freee API・Gemini API・Gmail API・Cloudflare Access の公開鍵（`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`） |
| 外からの通信 | ブラウザ（PWA）と iOS ショートカットの HTTP だけ。**Webhook の受け口・WebSocket・SSE は無い** |

systemd の構成との対応:

| systemd（従来） | コンテナ |
|---|---|
| `keihi-web.service` | コンテナの主プロセス |
| `keihi-worker.service` + `.timer`（2 分ごと） | 主プロセスが子プロセスで起動（`KEIHI_WORKER_MODE=spawn`。起動 1 分後、以後は前回の終了から 2 分後、ジョブを積んだときは即時） |
| `keihi-daily.timer`（毎日 03:30 JST） | 主プロセスの中のタイマー（止まっていて逃した分は、起動時に 1 回だけ補う） |
| `~/.config/keihi/config.toml` | 環境変数 `KEIHI_<セクション>_<キー>`（`/config/config.toml` を置いてもよい） |
| `~/.config/keihi/secrets.env` | 環境変数（Coolify のシークレット） |
| `~/.local/share/keihi/` | `/data`（ボリューム） |
| Tailscale Serve が付ける `Tailscale-User-Login` | Cloudflare Access の JWT（`Cf-Access-Jwt-Assertion`）を検証 |
| journald | 標準出力・標準エラー（JSON） |
| `keihi-backup.timer`（ローカルのスナップショット + restic でオフサイト。導入している場合） | **未対応**（§13 の 2。切り替えの前に決める） |

## 2. ビルドと起動

```sh
docker build -t keihi .
```

- ベースは `node:24.20.0-bookworm-slim`。依存は `package-lock.json` のとおり（`npm ci`）。
- 3 段のマルチステージ: PWA のビルド（dev 依存込み）/ 実行時の依存だけ / 実行イメージ（`src/`・`node_modules/`・`pwa/dist/`）。
- サーバー側はビルドしない（Node の型ストリップで `.ts` をそのまま実行する）。

手元で動かす（外部の API を呼ばない設定。ポートは 127.0.0.1 にだけ出す）:

```sh
docker volume create keihi-data
docker run --rm --name keihi \
  -p 127.0.0.1:18795:8795 -v keihi-data:/data \
  -e KEIHI_PROVIDER_KIND=fake \
  -e KEIHI_WEB_ALLOWED_USERS=you@example.com \
  -e KEIHI_WEB_ALLOWED_HOSTS=127.0.0.1:18795 \
  -e KEIHI_INSECURE_HEADER_AUTH=1 \
  keihi

curl -s http://127.0.0.1:18795/health                                    # {"status":"ok"}
curl -s -H 'Tailscale-User-Login: you@example.com' http://127.0.0.1:18795/api/status
```

`KEIHI_INSECURE_HEADER_AUTH=1` は「ヘッダを信じるだけの認証のまま `0.0.0.0` で待ち受ける」のを許す、手元の検証専用の設定。
**本番では使わない**（付けなければ、その組み合わせでは起動を拒否する）。

停止は `docker stop -t 30 keihi`（SIGTERM）。新しい接続を止め、処理中のリクエスト（最大 8 秒）と worker の実行中のジョブ（最大 20 秒、止まらなければ SIGKILL してさらに最大 2 秒）を待ってから、終了コード 0 で終わる。
`docker stop` の猶予は既定で 10 秒しかないので、`-t 30` を付ける（付けないと、10 秒を超えるジョブの途中でコンテナごと SIGKILL され、終了コードは 137 になる）。

## 3. 環境変数

例は [`.env.example`](.env.example)。本物の値は Coolify の Environment Variables に入れる（リポジトリには置かない）。

### 必須

| 変数 | 例 | 内容 |
|---|---|---|
| `KEIHI_WEB_AUTH` | `cloudflare_access` | 認証の方式。`tailscale`（既定）は 127.0.0.1 でしか使えない |
| `KEIHI_WEB_ACCESS_TEAM_DOMAIN` | `example.cloudflareaccess.com` | Zero Trust のチームドメイン |
| `KEIHI_WEB_ACCESS_AUD` | 64 桁の 16 進 | Access のアプリの「Application Audience (AUD) Tag」 |
| `KEIHI_WEB_ALLOWED_USERS` | `you@example.com` | 通してよい利用者のメールアドレス（カンマ区切り） |
| `KEIHI_WEB_ALLOWED_HOSTS` | `keihi.example.com` | 公開するホスト名（カンマ区切り）。これ以外の `Host` は 400 |

### シークレット

Coolify では **Build time を「Not available during build」（Runtime only）**にする（既定はビルドにも渡る）。

| 変数 | 必要なとき |
|---|---|
| `GEMINI_API_KEY` | 証憑の読み取り（無ければ取り込みのジョブが失敗して残る） |
| `FREEE_CLIENT_ID`・`FREEE_CLIENT_SECRET` | freee との連携 |
| `GMAIL_CLIENT_ID`・`GMAIL_CLIENT_SECRET` | Gmail の取り込みを使うとき |

`/config/secrets.env` があるときはそのファイルだけを読み、環境変数のシークレットは見ない（従来の構成と同じ規則）。
ファイルで渡すときは、コンテナの実行ユーザー（`node`、uid 1000）が読めるようにする（root 所有の 0600 だと起動に失敗する）。

### 業務の設定

`config.toml` の `[セクション] キー` は、どれも `KEIHI_<セクション>_<キー>`（大文字）で上書きできる。キーの一覧と意味は
[`deploy/config.example.toml`](deploy/config.example.toml)。今の本番で設定しているのは次のもの:

| 変数 | config.toml |
|---|---|
| `KEIHI_PROVIDER_KIND` | `[provider] kind`（`fake` にすると freee を呼ばない） |
| `KEIHI_FREEE_TARGET`・`KEIHI_FREEE_POC_COMPANY_ID`・`KEIHI_FREEE_PROD_COMPANY_ID` | `[freee]` |
| `KEIHI_GEMINI_PAID_TIER_CONFIRMED` | `[gemini] paid_tier_confirmed` |
| `KEIHI_CASHFLOW_INCLUDE_UNPLANNED_INCOME` | `[cashflow] include_unplanned_income` |

- 配列はカンマ区切り。真偽値は `true` / `false`。`KEIHI_MAIL_ACCOUNTS` だけは TOML の配列で書く。
- **知らない `KEIHI_…` があると起動しない**（綴り違いで設定が効いていない、を防ぐ）。
- 環境変数で書きにくければ、`/config/config.toml` をファイルとしてマウントしてもよい（環境変数が優先）。

### ログ・実行環境

| 変数 | 既定（イメージ） | 内容 |
|---|---|---|
| `LOG_FORMAT` | `json` | `json` / `text` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `APP_ENV` | `production` | ログの `env` |
| `SERVICE_NAME` | （未設定） | ログの `service`。未設定なら `keihi-web`・`keihi-worker` |
| `LOG_REQUESTS` | （JSON のとき有効） | `1` / `0` でアクセスログを強制 |

### イメージが設定済みのもの（ふつうは変えない）

| 変数 | 値 | 内容 |
|---|---|---|
| `KEIHI_DATA_DIR` | `/data` | データの場所 |
| `KEIHI_CONFIG_DIR` | `/config` | `config.toml`・`secrets.env` を探す場所（無くてよい） |
| `KEIHI_BIND_HOST` | `0.0.0.0` | 待ち受けるアドレス |
| `KEIHI_WORKER_MODE` | `spawn` | worker を子プロセスで動かす |
| `KEIHI_MIGRATE_ON_START` | `1` | 起動時に未適用のマイグレーションを適用する |
| `DATABASE_URL` | （未設定） | DB の場所を変えるときだけ。`sqlite:///data/keihi.db` の形（SQLite だけ。クエリは付けられない）。それ以外の値が入っていると起動しないので、基盤が共通の `DATABASE_URL` を自動で入れる設定にしない |

## 4. Coolify の登録

| 設定 | 値 |
|---|---|
| Source | GitHub のこのリポジトリ、ブランチ `main` |
| Build Pack | **Dockerfile**（`/Dockerfile`、Base Directory `/`） |
| Ports Exposes | `8795` |
| Ports Mappings | **空**（ホストにポートを出さない。Traefik が中から届く） |
| Domains | 公開するホスト名（`KEIHI_WEB_ALLOWED_HOSTS` と同じもの） |
| Auto Deploy | 有効（`main` への push でデプロイ） |
| Persistent Storage | Volume Mount、Destination Path `/data`。**付け忘れてもエラーにならない**（イメージの `VOLUME` で匿名ボリュームができ、再デプロイでデータが見えなくなる）。初回のデプロイの後に、名前付きのボリュームが `/data` に付いていることを確かめる |
| Healthcheck | §5 |
| Container naming | **Consistent name (no rolling updates)**（下の注意） |
| Stop Grace Period | 30 秒（既定がこの値であることを画面で確かめる。短ければ 30 秒にする） |
| Environment Variables | §3。シークレットは Runtime only |

注意:

- **新旧のコンテナを同時に動かさない。** ローリングアップデートは、同じ `/data` を新旧 2 つのコンテナがマウントする時間を作る。
  新しい方が起動時にマイグレーションを当てると、古いコードが新しいスキーマの DB を触ることになる。
  Container naming を「Consistent name」にすると、古い方を止めてから新しい方を起こす（数秒つながらない時間ができる。1 人で使う道具なので許容する）。
- **ボリュームの名前を変えない。** 名前を変えると空のボリュームが新しく作られる（データは古いボリュームに残るが、アプリからは見えなくなる）。
  サーバーの「Delete Unused Volumes」の自動クリーンアップは、このボリュームが外れている間に動くと消しうるので、無効にしておく。
- ボリュームは**ローカルディスク**に置く（NFS・SMB の上に SQLite を置かない）。
- バインドマウントを使うなら、ホスト側のディレクトリを uid 1000 の所有にする。名前付きボリュームは何もしなくてよい。
- コンテナの時刻は UTC のままでよい（`TZ` を設定しない。日付の計算はコードが JST で行う）。

## 5. ヘルスチェック

| パス | 内容 | 用途 |
|---|---|---|
| `GET /health` | 200 `{"status":"ok"}`。プロセスが応答できる | 外形監視 |
| `GET /health/live` | 同上 | liveness |
| `GET /health/ready` | DB を読め、マイグレーションが全部当たっていれば 200 `{"status":"ok"}`。だめなら 503 `{"status":"unavailable","reason":"db"\|"migrations"}` | **Coolify のヘルスチェック** |
| `GET /healthz` | 従来のもの（`{"ok":true}`。`Host` の検査を通る必要がある）。互換のために残してある | — |

- `/health*` は認証も `Host` の検査も通さない。返すのは上の固定の JSON だけ（設定・パス・エラー文は返さない）。DB への問い合わせは `SELECT 1` 相当だけ。
- 待ち受けを始めるのは、設定の読み込み・DB のオープン・マイグレーションが済んだ後。それまでは接続できない（= 正常とは見なされない）。

Coolify の設定（Healthcheck を有効にする。画面の設定はコンテナの中で `curl` を実行する方式で、イメージに `curl` を入れてある）:

| 項目 | 値 |
|---|---|
| Method / Scheme | `GET` / `http` |
| Host | `127.0.0.1`（アプリは IPv4 で待ち受ける） |
| Port | `8795` |
| Path | `/health/ready` |
| Expected code | `200` |
| Interval / Timeout / Retries / Start Period | 30 秒 / 5 秒 / 3 回 / 30 秒 |

- 画面の Healthcheck を無効にした場合は、Dockerfile の `HEALTHCHECK`（同じ内容）が使われる。
- この経路はコンテナの中の `127.0.0.1` なので、Traefik も Cloudflare Access も通らない。
- 外から `https://<公開ホスト名>/health` を監視する場合は、Access がログイン画面に飛ばす。監視側にサービストークンを持たせるか、
  Access で `/health` だけを Bypass にする（返すのは `{"status":"ok"}` だけなので、公開しても情報は漏れない）。

## 6. データベースと永続化

### DB は SQLite のまま（エンジンは変えない）

- 種類: SQLite（Node 組み込みの `node:sqlite`。WAL、`busy_timeout = 5000`、`foreign_keys = ON`、`synchronous = FULL`）。
- 場所: `/data/keihi.db`（と `-wal`・`-shm`）。`KEIHI_DATA_DIR` か `DATABASE_URL=sqlite:///絶対パス` で変えられる。
  接続先はコードに書いていない。SQLite 以外の URL（`postgresql://…` など）を渡すと、起動時にエラーで止まる。
- 認証情報: 無い（ファイル）。DB ユーザーの権限に当たるのは、ボリュームのファイルの所有者（uid 1000）だけ。

**外部 DB（PostgreSQL / MySQL）へ移す必要があるかの評価: 今は移さない。**

| 観点 | SQLite のまま | 外部 DB に移す |
|---|---|---|
| 変更の大きさ | 無し | 全クエリ（同期 API の `node:sqlite` 前提）・16 本のマイグレーション・監査ログのハッシュチェーン・スナップショットとリストア訓練の書き直し |
| 性能・規模 | 利用者 1 人、DB は数 MB。十分 | 利点なし |
| 冗長化 | レプリカ 1 つだけ。コンテナを増やせない | 複数レプリカにできる（今は不要） |
| 基盤側の運用 | ボリュームのバックアップが要る。「Tailscale 経由の SQL」での調査はできない（§10） | 共通の DB 運用（バックアップ・監視・読み取り専用ユーザー）に乗る |
| データ移行の危険 | 無し（ファイルを運ぶだけ） | 金額・日付の型の違い、監査ログの連続性の検証が要る |

移行のためだけにエンジンを変えるのは、得るものに対して壊しうるものが多い。共通の DB 運用に乗せたくなったら、別の作業として計画する。

### 接続の失敗・タイムアウト

- 起動時に DB を開けない（ディレクトリが無い・書けない・WAL にできない）: エラーをログに出して**終了コード 1**。Coolify が再起動を試みる。
- 他のプロセスが書き込み中: 5 秒まで待つ（`busy_timeout`）。越えたらそのリクエストは 500、ジョブは失敗として記録されて再試行に回る。
- ネットワーク越しの接続ではないので、再接続の処理は無い。動作中に DB を読めなくなれば `/health/ready` が 503 になる。

### マイグレーション

- ファイルは `src/db/migrations/NNNN_*.sql`。適用済みかどうかは DB の `schema_migrations`（内容の sha256 も記録し、適用後に書き換えられていたら止まる）。
- コンテナでは起動時に自動で当てる（`KEIHI_MIGRATE_ON_START=1`）。当たり終わるまで待ち受けを始めない。
- 手で当てる場合（ふつうは不要）: アプリを止めて、同じボリュームで `docker run --rm -v <ボリューム>:/data <イメージ> node src/db/migrate.ts`。
- **巻き戻しのマイグレーションは無い。** スキーマを変えるデプロイの前に、エクスポート（下）を取る。

### 永続化が必要なデータ（すべて `/data`）

| パス | 内容 | 失うと |
|---|---|---|
| `keihi.db`（`-wal`・`-shm`） | すべての記録と監査ログ | 全損 |
| `objects/` | 証憑の原本（画像・PDF。内容の sha256 が名前、読み取り専用） | 電子帳簿保存法の原本を失う |
| `freee-token.json`・`gmail-token-*.json` | OAuth のトークン（0600） | 再認可が要る（§13） |
| `snapshots/` | DB のスナップショット（従来の構成では、`keihi-backup.timer` を導入していれば毎日作る。**コンテナでは今は作られない**。§13 の 2） | バックアップの元を失う |
| `drill/` | リストア訓練の作業場所 | 困らない |

コンテナの中の他の場所（`/tmp` など）には、残す必要のあるものを書かない。

### エクスポート・インポート・バックアップ

- **エクスポート**（動作中でも一貫したコピーが取れる）:
  ```sh
  node -e "new (require('node:sqlite').DatabaseSync)('/data/keihi.db').exec(\"VACUUM INTO '/data/export.db'\")"
  ```
  これと `objects/`・トークンのファイルを合わせて持ち出す。**動作中の `keihi.db` を `cp` しない**（WAL の中身が欠ける）。
- **インポート**: コンテナを止めた状態で、`keihi.db`（`-wal`・`-shm` は置かない）・`objects/`・トークンを `/data` に置き、所有者を uid 1000、トークンを 0600 にする。
  起動すると、足りないマイグレーションが当たる。
- **バックアップ**: **コンテナには、自動のバックアップがまだ無い。** 従来の構成では `keihi-backup.timer`（`tools/backup/run.ts`。導入している場合）が毎日
  スナップショットを作って restic でオフサイトに送るが、イメージには restic も `tools/` も入れていない（§13 の 2。**切り替えの前に決める**）。
  基盤側でボリュームを取る場合は、動作中の `keihi.db` をそのまま写すのではなく、上のエクスポートで作ったファイルと `objects/`・トークンを対象にする。
- **復旧**: インポートと同じ手順。確認は `/health/ready` が 200、画面の件数が合うこと。

## 7. ログ

- 出力先は標準出力（info・debug）と標準エラー（warn・error）だけ。ファイルには書かない。Loki へ直接は送らない（基盤側の収集に任せる）。
- `LOG_FORMAT=json` のとき 1 行 1 JSON:
  ```json
  {"ts":"2026-01-01T00:00:00.000Z","level":"info","service":"keihi-web","env":"production","msg":"request","method":"GET","path":"/api/status","status":200,"duration_ms":3,"request_id":"…"}
  ```

| 項目 | 内容 |
|---|---|
| `ts` | ISO 8601（UTC） |
| `level` | `debug` / `info` / `warn` / `error`（`LOG_LEVEL` 未満は出さない） |
| `service` | `keihi-web` / `keihi-worker`（`SERVICE_NAME` で上書き） |
| `env` | `APP_ENV` |
| `msg` | メッセージ |
| `error`・`stack` | 例外のとき（メッセージとスタックトレース） |
| `request_id` | アクセスログとその中のエラー。`X-Request-Id` → `Cf-Ray` → 生成。応答の `X-Request-Id` にも返す |

- アクセスログは `method`・`path`（クエリは出さない）・`status`・`duration_ms`。`/health*` は出さない。利用者・本文・ヘッダは出さない。
- マスキング: 名前が `secret`・`token`・`password`・`authorization`・`api_key`・`cookie`・`assertion` に当たる項目の値、
  読み込んだシークレットの値そのもの、`Bearer …` は `***` に置き換えてから出す。
- worker のログも同じ形式で、同じコンテナの標準出力に出る。
- 未処理の例外は `error` で 1 行出してから終了コード 1 で落ちる（Coolify が再起動する）。

## 8. Cloudflare Access

アプリは自前のログイン画面を持たない。Access がログインさせ、アプリは Access が付ける署名付きの JWT を検証する。

- `KEIHI_WEB_AUTH=cloudflare_access` のとき、リクエストごとに `Cf-Access-Jwt-Assertion` を検証する:
  署名（RS256。公開鍵は `https://<team>/cdn-cgi/access/certs` から取って 1 時間キャッシュ）・`iss`・`aud`・`exp`・`nbf`。
  通った JWT の `email` が `KEIHI_WEB_ALLOWED_USERS` に無ければ 403。
- **ヘッダがあるだけでは通さない。** この方式では `Tailscale-User-Login` や `Cf-Access-Authenticated-User-Email` は読まない。
  Tunnel を通らずにコンテナへ直接届いたリクエスト（同じ Docker ネットワークの別コンテナなど）も、正しい署名の JWT が無ければ 401。
- 監査ログの「だれが」は JWT の `email`。
- 公開鍵を取れないとき（外向きの通信が切れている）は 503。キャッシュに鍵が残っていれば動き続ける。

| 項目 | 状況 |
|---|---|
| リバースプロキシ経由 | 問題なし。アプリは `Host` を許可リスト（`KEIHI_WEB_ALLOWED_HOSTS`）と照合する。Traefik が `Host` を書き換えない設定であること |
| HTTPS リダイレクト | アプリはリダイレクトを出さない（Traefik / Cloudflare 側で行う）。アプリが出すリダイレクトは相対パスだけ |
| Cookie・セッション | アプリは Cookie を使わない。あるのは Access の `CF_Authorization` だけ |
| CSRF | 変更系のリクエストは `Origin` を許可リストと照合する。公開ホスト名を `KEIHI_WEB_ALLOWED_HOSTS` に入れる |
| WebSocket・SSE | 使っていない |
| 外部からの Webhook | 無い（freee・Gmail・Gemini はどれもアプリ側から取りに行く） |
| PWA の manifest | `crossorigin="use-credentials"` を付けてある（付けないと Cookie 無しで取りに行き、ログイン画面に飛ばされる） |
| Service Worker | 同一オリジンの取得なので Cookie が付く。Access のセッションが切れると API がログイン画面へのリダイレクトになる（§13） |
| API クライアント（iOS ショートカット） | ブラウザのログインができない。**Access のサービストークン**を使う（下） |

### iOS ショートカット（ブラウザでログインできないクライアント）

1. Zero Trust でサービストークンを作る。Client ID（`….access` の形）と Client Secret が出る。
2. Access のアプリに、そのトークンを通すポリシー（Action = **Service Auth**）を足す（Allow のままだとログイン画面に飛ばされる）。
3. `KEIHI_WEB_ACCESS_SERVICE_TOKENS` に **Client ID** を設定する（JWT の `common_name` と照合する。トークンの表示名ではない。ここに無いトークンは 403）。
4. ショートカットのリクエストに `CF-Access-Client-Id` と `CF-Access-Client-Secret` のヘッダを足す。

監査ログの「だれが」は `service:<Client ID>` になる。Client Secret はアプリには届かない（Access が検証して、JWT に置き換える）。

## 9. 検証

```sh
tools/docker/smoke.sh                  # docker
DOCKER=podman tools/docker/smoke.sh    # podman
```

イメージをビルドし、使い捨てのボリュームで次を確かめる（ホストにポートを出さない・外部の API を呼ばない）:
起動と `/health*`、非 root、API と PWA、`Host` の検査、JSON のログ、SIGTERM での終了コード 0、
コンテナを作り直してもデータが残る、認証の設定が無ければ起動しない、Access の方式で JWT 無しは 401。

GitHub Actions（`.github/workflows/container.yml`）が、PR と `main` への push で同じスクリプトを実行する。

検証で守ること:

- 本番の `/data`（のコピー）で試すときは、**`KEIHI_PROVIDER_KIND=fake` にし、シークレットとトークンのファイルを渡さない**
  （freee のリフレッシュトークンは使うたびに入れ替わる。コピーの側で更新すると、本番の側のトークンが失効する）。
- 本番と同じ DB ファイルを 2 か所から開かない。

## 10. 開発サーバーからの運用

開発サーバーから Docker のソケットや基盤のホストの管理者権限は使わない前提。

| やりたいこと | 方法 |
|---|---|
| 生きているか | `https://<公開ホスト名>/health`（Access を通す。§5） |
| ログ | Loki の HTTP API / Grafana（`service="keihi-web"` など） |
| デプロイ・再起動・環境変数 | GitHub（`main` への push）と Coolify の API |
| データの中身を調べる | アプリの API（読み取り）。SQL で調べたいときは、エクスポートしたファイルを持ち出して手元で開く |
| マイグレーション | デプロイに含まれる（起動時に適用） |

- **SQLite なので「Tailscale 経由の SQL」はできない。** 読み取り専用の DB ユーザーに当たるものは無い。
  調査はエクスポートしたファイル（§6。読み取り専用で開く）で行う。持ち出す経路は基盤側と決める（§13 の 3）。
- 接続先の URL やトークン（Loki・Grafana・Coolify の API）は、使う側の環境変数に置く。このリポジトリには書かない。
- 書き込み・削除・デプロイにつながる権限（Coolify の API トークン・`main` への push）は、読むだけの権限（Loki・Grafana）と分けて持つ。

## 11. 本番の切り替え

**この手順は、まだ実行していない。** 準備が整ってから、時間を決めて行う。

守ること: **旧環境と新環境の worker を同時に動かさない。** freee のリフレッシュトークンは使うたびに入れ替わるので、
両方が動くと片方が失効し、再認可が要る。同じジョブを二重に処理する危険もある。

1. **事前**（旧環境は動かしたまま）
   - Coolify にアプリを登録し、§3 の環境変数・§4 のボリューム・§5 のヘルスチェックを設定する。
   - Access のアプリ（AUD）とポリシー、iOS ショートカット用のサービストークンを用意する。
   - `KEIHI_PROVIDER_KIND=fake`・シークレット無し・**空のボリューム**で一度デプロイし、`/health/ready` とログイン、ログが Loki に届くことを確かめる。
     確かめたらコンテナを止め、ボリュームを空に戻す。
2. **旧環境を止める**
   ```sh
   systemctl --user stop keihi-worker.timer keihi-daily.timer
   systemctl --user is-active keihi-worker.service   # inactive になるまで待つ
   systemctl --user stop keihi-web.service
   ```
3. **データを取り出す**（旧環境）
   ```sh
   cd ~/.local/share/keihi
   sqlite3 keihi.db "VACUUM INTO 'keihi-move.db'"      # sqlite3 が無ければ §6 の node の 1 行
   tar czf keihi-move.tgz --transform 's/^keihi-move.db$/keihi.db/' keihi-move.db objects freee-token.json   # gmail-token-*.json があれば足す
   ```
4. **新環境に入れる**（基盤の管理者。コンテナは止めたまま）: `keihi-move.tgz` をボリュームの `/data` に展開し、所有者を uid 1000、トークンを 0600 にする。
5. **新環境を起動する**: `KEIHI_PROVIDER_KIND` とシークレットを本番の値にしてデプロイ。
   `/health/ready` が 200、画面の件数が旧環境と同じ、`/api/status` の監査ログの検証が通ること、worker のログ（`keihi-worker`）が出ることを確かめる。
6. **クライアントを切り替える**: PWA を新しい URL で開き直す（ホーム画面のアイコンは作り直し）。iOS ショートカットの URL とヘッダを替える（§8）。
7. **旧環境を無効にする**（消さない）
   ```sh
   systemctl --user disable keihi-web.service keihi-worker.timer keihi-daily.timer
   ```
   `tailscale serve` の設定と旧環境のデータは、新環境が安定するまで残す。

## 12. ロールバック

### デプロイの巻き戻し（新環境の中で）

- Coolify で前のデプロイに戻す（か、`main` を revert して push）。
- スキーマを変えたデプロイの後は、**古いコードが新しいスキーマを読むことになる**。マイグレーションは列・表を足すものが中心だが、巻き戻しは用意していない。
  だめなら、デプロイ前に取ったエクスポート（§6）から `keihi.db` を戻す（その後に入れたデータは失う）。

### 切り替えの巻き戻し（新環境 → 旧環境）

1. 新環境のコンテナを止める（Coolify の Stop）。
2. 新環境で動かした後なら、**新環境の `/data` を取り出して旧環境に戻す**（§11 の 3〜4 の逆）。
   旧環境に残っている `freee-token.json` は、新環境がトークンを更新した時点で失効している。必ず新環境のものを持ち帰る。
   持ち帰れなければ `node src/cli/keihi.ts freee auth` で再認可する。
3. 旧環境を起動する。
   ```sh
   systemctl --user enable --now keihi-web.service keihi-worker.timer keihi-daily.timer
   ```
4. iOS ショートカットと PWA の URL を戻す。

新環境を一度も本番の設定（シークレットあり）で起動していなければ、旧環境をそのまま起動し直すだけでよい。

## 13. 未解決の課題

| # | 課題 | 今の状態・案 |
|---|---|---|
| 1 | **OAuth の再認可**（freee・Gmail） | 認可コードを端末に貼る CLI（`node src/cli/keihi.ts freee auth`）しか無い。コンテナでは Coolify の画面のターミナルから実行する。Docker のソケットを前提にしない運用にするなら、画面から再認可できるようにする作業が要る |
| 2 | **バックアップ（切り替えの前に決める）** | コンテナには自動のバックアップが無い（スナップショットも restic も動かない）。案: (a) 毎日のジョブでローカルのスナップショットを作り、基盤側がボリュームをオフサイトに写す (b) restic と rclone をイメージに入れて従来と同じにする。決めて実装するまで、PWA にバックアップが止まっている旨の帯が出る |
| 3 | **読み取り専用の調査経路** | SQLite なので SQL をネットワーク越しに投げられない。エクスポートしたファイルを開発サーバーへ持ち出す経路（基盤側の定期コピーなど）が要る |
| 4 | **Access のセッション切れ** | PWA を開いたままセッションが切れると、API の応答がログイン画面へのリダイレクトになり、画面にはエラーとして出る。開き直せば戻る。検知して再読み込みを促す表示は未実装 |
| 5 | **停止時のジョブ** | 停止のとき、20 秒待っても終わらないジョブは打ち切られる（デプロイのたびに起きうる）。15 分後に自動で取り直されるが、その間は処理が止まって見える |
| 6 | **実機での確認** | Coolify・Traefik・Cloudflare Tunnel・Access を通した確認（ログイン、manifest、Service Worker、iOS ショートカットのサービストークン、Loki への到達）は、基盤ができてから行う。Access の JWT の検証は、偽の鍵を使った単体テストでだけ確かめてある |
| 7 | **Access の署名鍵のキャッシュ** | 鍵（JWKS）を取り直せない間は、最後に取れた鍵を期限なく使い続ける（Cloudflare 側の障害でログインできなくなるのを避けるため）。ローテーションで外れた鍵も、その間は通る。「最後の取得から 24 時間を過ぎたら通さない」などの上限は未実装 |
