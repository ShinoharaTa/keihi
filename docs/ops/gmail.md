# Gmail からの証憑の取り込みを設定する（docs/cashflow.md §16）

Gmail で **ラベル `keihi` を付けたメール**を keihi が 1 日 1 回（daily）取りに行き、添付の PDF・JPEG・PNG を
証憑（電子取引）として取り込む。メール全体は `.eml` として原本ストアに残る。

- 使うのは Gmail API の **読み取り専用**（`gmail.readonly`）だけ。keihi はラベルを付けない・既読にしない・消さない。
- どのメールを取り込むかは **Gmail のフィルタ**で決める（keihi 側に送信元の一覧は持たない）。
- アカウントは複数書ける（例: 個人の Gmail と Google Workspace）。OAuth クライアントは 1 つを共用し、
  トークンはアカウントごとに `<data_dir>/gmail-token-<id>.json`（0600、バックアップに含めない）。

## 1. GCP のプロジェクトを作る

1. https://console.cloud.google.com/ にログインし、新しいプロジェクトを作る（例: `keihi-mail`）。
   既存の Gemini 用のプロジェクトとは分けておくと、権限と課金の見通しがよい。
2. 「API とサービス」→「ライブラリ」で **Gmail API** を探して「有効にする」。

## 2. OAuth 同意画面

「API とサービス」→「OAuth 同意画面」（Google Auth Platform の「ブランディング」「対象」）。

1. **User type は「外部」**にする（個人の Gmail と Workspace の両方を同じクライアントで認可するため）。
2. アプリ名・サポートメール・デベロッパーの連絡先を入れる（自分のアドレスでよい）。
3. スコープに `https://www.googleapis.com/auth/gmail.readonly` を足す（無くても認可のときに求めるが、書いておくと画面で確かめられる）。
4. **公開ステータスを「本番環境」にする（「アプリを公開」）。**
   - 「テスト」のままだと、**リフレッシュトークンが 7 日で失効する**。毎週 `keihi gmail auth` をやり直すことになる。
   - 本番にしても Google の審査は要らない（自分だけで使い、ユーザーが 100 人に届かないため）。認可のときに
     「Google はこのアプリを確認していません」と出るので、「詳細」→「（安全ではないページ）に移動」で進む。
5. Workspace のアカウントで「管理者がこのアプリをブロックしている」と出たら、Workspace の管理コンソール
   （セキュリティ → API の制御）でこのクライアント ID を信頼済みにする。

## 3. OAuth クライアントを作る

「API とサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」。

- アプリケーションの種類: **デスクトップ アプリ**（推奨）か **ウェブ アプリケーション**。
- ウェブ アプリケーションにした場合は、承認済みのリダイレクト URI に **`http://127.0.0.1:8797/`** を足す
  （デスクトップ アプリは 127.0.0.1 のループバックが最初から許されているので設定は要らない）。
- 作ったら **クライアント ID** と **クライアント シークレット**を控える。

keihi はポート 8797 で**待ち受けない**。認可の後にブラウザが `http://127.0.0.1:8797/?...` を開こうとして
「接続できません」で止まるので、その URL を貼り付けて使う（§6）。

## 4. secrets.env に 2 つの値を書く

`~/.config/keihi/secrets.env`（0600 のまま）に足す。

```sh
GMAIL_CLIENT_ID=<クライアント ID>
GMAIL_CLIENT_SECRET=<クライアント シークレット>
```

```sh
chmod 600 ~/.config/keihi/secrets.env
```

## 5. config.toml にアカウントを書く

`~/.config/keihi/config.toml` に足す（例は個人の Gmail と Workspace の 2 件）。

```toml
[mail]
enabled = true
# max_messages_per_run = 100   # 1 回に取り込む通数（アカウントごと）

[[mail.accounts]]
id = "personal"          # 個人の Gmail。英数字と - の 1〜32 字
label = "keihi"
since = "2026-10-01"     # 取り始める日。無ければ初回実行日の 30 日前

[[mail.accounts]]
id = "work"              # Google Workspace
label = "keihi"
# query = "has:attachment"   # 検索式に AND で足す（任意）
```

- `id` はトークンのファイル名（`gmail-token-<id>.json`）と API の `account_id` になる。後から変えるとトークンも取り直しになる。
- 知らないキーは起動時エラーになる（綴りを確かめる）。`provider = "imap"` は予約だけで、指定すると起動しない。

## 6. アカウントごとに認可する

```sh
cd ~/workspace/keihi
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
node src/cli/keihi.ts gmail auth personal
```

1. 表示された `https://accounts.google.com/...` の URL をスマホのブラウザで開く。
2. **取り込みたいアカウント**を選び、「Gmail のメールの閲覧」を許可する（未確認アプリの警告は §2-4 のとおり進む）。
3. ブラウザが `http://127.0.0.1:8797/?state=...&code=...` を開こうとして止まる。**アドレスバーの URL をまるごとコピー**する。
4. ターミナルに貼り付けて Enter。`保存した: .../gmail-token-personal.json（0600）` と `認可したアカウント: ...` が出れば終わり。
   出たアドレスが意図したアカウントか確かめる（違えばもう一度 `gmail auth personal`）。
5. 2 つ目のアカウントも同じように `node src/cli/keihi.ts gmail auth work`。ブラウザで**別のアカウントに切り替えてから**許可する。

再認可（トークンの失効・取り消し）も同じコマンド。成功すると `gmail_reauth_required_<id>` が 0 に戻る。

## 7. Gmail 側: ラベルとフィルタ

各アカウントの Gmail（ブラウザ版）で行う。

1. 左の「ラベル」→「新しいラベルを作成」で **`keihi`** を作る（config の `label` と同じ名前）。
2. 設定 →「フィルタとブロック中のアドレス」→「新しいフィルタを作成」。
   - From に請求書・領収書を送ってくる送信元を `OR` でつなぐ。例:
     ```
     from:(@billing.example.com OR @invoice.example.net OR receipts@example.org)
     ```
   - 「フィルタを作成」→ **「ラベルを付ける: keihi」**にチェック（「受信トレイをスキップ」は好みで）。
   - 「一致するスレッドにもフィルタを適用する」にチェックすると、過去のメールにも付く（取り込むのは `since` 以降）。
3. **Amazon は通常のアカウントと Amazon ビジネスの両方の通知を入れる。** 注文確認・発送・請求書の通知は送信元が
   分かれているので、届いたメールの From を見て両方をフィルタに足す（例の形: `from:(@amazon.example.com OR @business.amazon.example.com)`。
   実際のドメインは届いたメールで確かめる）。
   - Amazon の注文確認メールには領収書 PDF が付かない。本文だけのメールは `body_only` として残り、領収書は
     注文履歴から PDF を保存して共有シートで入れる（docs/cashflow.md §16）。
4. 添付の無い宣伝メールまで拾うときは、config の `query = "has:attachment"` で絞れる（本文だけの注文確認も要らなくなる点に注意）。

## 8. 確認する

web が動いている前提（[systemd.md](systemd.md)）。`Tailscale-User-Login` は [serve.md](serve.md) と同じく許可ユーザーの値にする。

```sh
H='Tailscale-User-Login: you@example.com'
# 今すぐ取り込む（アカウントごとに fetch_mail を積む。10 分以内の 2 回目は積まない）
curl -s -X POST -H "$H" http://127.0.0.1:8795/api/mail/sync
# {"accounts":[{"account_id":"personal","job_id":123,"created":true},{"account_id":"work","job_id":124,"created":true}]}

# 少し待ってから状態を見る
curl -s -H "$H" http://127.0.0.1:8795/api/mail/status
# {"enabled":true,"provider":"gmail_api","accounts":[{"id":"personal","label":"keihi","last_run_at":"...","last_ok_at":"...",
#   "last_error":null,"reauth_required":false,"attention_count":0}, ...]}

# 取り込んだメール（新しい順。state=attention で要対応だけ）
curl -s -H "$H" 'http://127.0.0.1:8795/api/mail/messages?account_id=personal&limit=10'
```

| 見えたもの | 意味と対処 |
|---|---|
| `409 {"reason":"mail_disabled"}` | `[mail] enabled = true` になっていない。直して web と worker を再起動する |
| `reauth_required: true`、`last_error: "reauth_required"` | トークンが失効・取り消された（テストのままで 7 日経った、など）。§6 をやり直す |
| `last_error` に `HTTP 429` / `HTTP 5xx` | 一時的な失敗。ジョブが自動で再試行する |
| `last_error` に `GMAIL_CLIENT_ID が無い` | §4 の secrets.env |
| `attention_count` が増えた | `messages?state=attention` を見る。`unsupported`（zip 等）・`too_large`（`[ingest] max_upload_bytes` 超え）・`error`（3 回失敗）・`body_only`（本文だけ）は手で証憑を入れる |

取り込んだ添付は通常の証憑と同じく抽出 → 確認カードに出る（source は `imap`）。
