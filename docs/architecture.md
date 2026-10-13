# keihi: スコープ案とアーキテクチャ案（ドラフト v0.1 / 2026-10-13）

目的: 個人事業主（自分）の経費証憑を「スマホで撮る / PDF を転送する」だけで、
OCR → Kev による勘定科目推定 → 自分で確認 → 会計サービス（MF または freee）へ仕訳＋証憑として登録するまでを自動化する。
帳簿の作成、青色申告、確定申告は会計サービス側で行う。
電帳法の保存要件をどちらで満たすかは別担当が検証中。本書はどちらの結論でも作り直しが要らない構成を前提にする。

表記: 【事実】= 一次情報（公式ドキュメント / OpenAPI 定義）で確認した内容。【推測】= 未検証。【要PoC】= 実際に API を叩かないと確定しない内容。

---

> **統合時の注記（docs/README.md §2 参照）**: 本書は法令調査（docs/legal.md）より前に書かれた。
> 次の 3 点は README §2 の整理を優先する: ①法定の保存先は MF/freee、自前保管はバックアップ（「正本」表記は読み替え）
> ②スキャナ保存の入力期限があるため、証憑は確認前に即アップロードする（§3.2 の順序は要修正）
> ③5MB 上限のための縮小は解像度要件（200dpi・24bit）を割らない範囲に限る（Q3）

## 1. MF / freee API 比較（一次情報）

### 1.1 比較表

| 項目 | MF クラウド会計・確定申告 API (v3) | freee 会計 API (v1) |
|---|---|---|
| 個人プランで使えるか | ○ 【事実】「クラウド会計・確定申告を利用中」なら追加料金なし。確定申告側のガイドにも同じページがある [MF1][MF2]。個人プランで実際に使えるかは【要PoC】（アプリポータルの開始に管理コンソールの「全権管理」権限が必要 [MF2]） | ○ 【事実】Web 版で使える機能は API でも使える [FR1]。1 日のコール上限は「上記以外」のプランで 3,000 回/事業所・アプリ [FR1] |
| 料金（個人・税抜） | パーソナルミニ 10,800円/年、パーソナル 15,360円/年、パーソナルプラス 35,760円/年 [MF5]。2026-12 に改定予定（金額は一次情報で未確認） | スターター 11,760円/年、スタンダード 23,760円/年（Web・年払い）[FR5]。※ 公式ヘルプ [FR6] は 403 で本文を確認できていない |
| 認証 | OAuth2 認可コード（アクセストークン 1h、リフレッシュトークン 540 日）または APIキー（無期限、/auth/exchange で 1h の JWT に交換）[MF3][MF4] | OAuth2 認可コード（アクセストークン 6h、リフレッシュトークン 90 日、使い回し不可）[FR2] |
| 自分専用アプリ | ◎ APIキーならユーザー同意の画面が不要で、自動化向けとされている [MF4] | ○ プライベートアプリ（利用は 5 事業所以下、ストア掲載なし）[FR3]。リダイレクト URI に `urn:ietf:wg:oauth:2.0:oob` が使える [FR4] |
| 仕訳 / 取引の登録 | `POST /api/v3/journals`（振替仕訳。明細は 300 行まで。memo 200 字、tags は 1 個 20 字まで）。GET / PUT / DELETE もある [MF6] | `POST /api/1/deals`（取引。`ref_number` と `receipt_ids` を持てる）、`POST /api/1/manual_journals`（振替伝票）[FR1] |
| 証憑のアップロード | ○ **できる**。`POST /api/v3/vouchers`（JSON に base64 を埋め込む。1 ファイル 5MB まで、1 回 5 件まで、保存先はクラウドBox）[MF6][MF7] | ○ `POST /api/1/receipts`（multipart。64MB まで、月 10GB まで、1 分 300 ファイルまで。プランごとに月間の枚数上限がある）[FR1] |
| アップロード時のメタデータ | ✗ **渡せない**。項目は `file_name` / `file_data` / `journal_id` だけ。仕訳 ID を付けずに上げた場合は、電帳法の検索要件（日付・取引先・金額）を Box の画面で入力するか、画面で仕訳に紐付ける必要がある [MF7] | ◎ `receipt_metadatum_partner_name` / `_issue_date` / `_amount`、`document_type`、`qualified_invoice`、`description` を渡せる。登録番号は後から `PUT` で上書きできる [FR1] |
| 仕訳と証憑の紐付け | `journal_id` を付けてアップロードすると紐付く。1 仕訳につき 5 件まで。解除は `DELETE /vouchers`。仕訳を GET すると `voucher_file_ids` が返る [MF6][MF7] | deal / manual_journal の作成時に `receipt_ids` を渡して紐付ける [FR1] |
| 証憑の削除 | ✗ 電帳法対応のため削除できない（ゴミ箱への移動のみ）[MF7] | API に `DELETE /receipts/{id}` がある [FR1] |
| 冪等キー | ✗ 無い（OpenAPI 定義に記載なし）[MF6] | ✗ 無い（OpenAPI 定義に記載なし）[FR1] |
| レート制限 | アクセストークンごとに 3 回/秒 [MF8]。APIキーの交換は 100 回/分 [MF4] | 過剰なアクセスは 403 を返し、約 10 分止まる。上限は 3,000 回/日 [FR1] |
| MCP | 公式。`beta.mcp.developers.biz.moneyforward.com/mcp/ca/v3`。仕訳の一覧・取得・作成・更新、試算表、マスタの参照、明細の作成と仕訳化ができる。**証憑の操作は無い** [MF9] | 公式 `freee/freee-mcp`（OSS）とリモート版 `mcp.freee.co.jp/mcp`。汎用の `freee_api_get/post/...` を提供する。`freee_file_upload` は stdio 版だけ [FR7] |
| サポート | ✗ 技術サポートは原則なし（有償の公認メンバーである士業事務所に限る）[MF1][MF2] | フォームでの問い合わせ窓口がある [FR1] |

### 1.2 結論
- **MF の API でも証憑はアップロードできる**（ユーザー提供情報のとおり。ただし MCP では扱えず、REST API を使う必要がある）。
- 両者の実質的な違いは次の 3 点。
  1. **メタデータ**: freee はアップロード時に日付・金額・取引先を渡せる。MF は仕訳に紐付けることで要件を満たす設計なので、MF では「仕訳を先に作り、その `journal_id` を付けて証憑を上げる」順番を必ず守る。
  2. **サイズ上限**: MF は 5MB まで。スマホの原寸写真は超えることがあるため、MF に送るのは縮小した派生ファイルになる。その場合、原本と送信ファイルが一致しないことになり、これが電帳法上問題ないかは別担当の判断事項。
  3. **やり直しのしやすさ**: MF は証憑を API で消せない。誤送信すると手作業で掃除することになるので、二重送信の防止が freee より重要になる。
- 冪等キーはどちらにも無い。**送信側で照合キーを埋め込み、送信前に検索して重複を確かめる**設計が必須になる（§3.3）。

---

## 2. スコープ案

| | A: 入口自作 → MF（軸案） | B: 入口自作 → freee | C: A + 自前でも原本を正本として二重保管 |
|---|---|---|---|
| 自作する範囲 | 取り込み、OCR、Kev、確認 UI、MF への送信、照合 | A と同じで送信先が freee | A に加えて WORM 保管、検索 UI、監査ログのエクスポート |
| 会計サービスに任せる範囲 | 帳簿、申告、電帳法の保存（Box） | 帳簿、申告、電帳法の保存（ファイルボックス） | 帳簿、申告。保存は MF と自前の両方 |
| 工数感（1 人・夜間と週末） | MVP 3〜4 週 | 3〜4 週（OAuth のトークン更新が少し面倒） | 5〜6 週（検索要件 UI と保管運用の分が増える） |
| 会計サービスの費用 | パーソナル 15,360円/年 | スタンダード 23,760円/年（スターターはアップロード枚数上限が厳しい可能性あり【要確認】） | A と同じ |
| 自前の費用 | 電気代以外ほぼ 0。オフサイトバックアップに B2 を使って数十円/月 | 同左 | B2 の Object Lock 付き保管も 7 年分で 20GB 程度。月 0〜20 円程度（10GB の無料枠を超えた分が $6.95/TB/月）[BB1] |
| ロックイン | 中（MF Box に置いた証憑は削除不可で、移行は画面から書き出すしかない【推測】） | 中（GET /receipts/{id}/download で取り出せる） | 低（原本と構造化データを自分で持っている） |
| 解約時の持ち出し | 仕訳は GET journals で JSON として取れる。証憑のダウンロード API は v3 に無い【事実：エンドポイント一覧に無い】→ **自前の保管が無いと API では持ち出せない** | 仕訳と証憑の両方を API で持ち出せる | 自前の保管から全部出せる |
| 確定申告との一体性 | ◎（決定済みの軸） | ○ | ◎ |
| 最適度 | ○ | ○ | ◎ |

**推薦: A を基本にして、原本の保管は最初から C の形で作る（= A+C）。**
- 理由 1: MF の v3 には証憑をダウンロードする API が無い。そのため「解約したら API では証憑を取り出せない」状態になる。自前で原本を持っていればこれを避けられる。
- 理由 2: 電帳法の検証結果が「MF 側で満たせる」でも「自前でも必要」でも、原本を追記専用で保管しておけば後から作り直す必要がない。前者の結果ならバックアップ扱いに格下げするだけで済む。
- 理由 3: 追加の運用費用は B2 で月数十円程度。
- 送信先は Provider インターフェースで抽象化し、B（freee）にも切り替えられるようにしておく（実装コストは小さい）。

---

## 3. アーキテクチャ（A+C 前提）

### 3.1 スマホからの取り込み導線

| 導線 | 長所 | 短所 | 実装コスト | 運用コスト | 最適度 |
|---|---|---|---|---|---|
| PWA + `<input type=file accept=image/* capture=environment>`（tailscale serve で HTTPS 配信） | 確認 UI と同じアプリで完結する。HTTPS 証明書は tailscale serve で取得済み（既に 9443 番で稼働中）。データが外部に出ない | スマホ側で Tailscale を ON にしておく必要がある。iOS では Background Sync が使えず、オフライン時は IndexedDB に溜めて次回開いたときに再送する | 小 | 0 | ◎ |
| 共有シート（Android: Web Share Target / iOS: ショートカットで POST） | 他アプリの PDF や写真をそのまま送れる | iOS の Safari PWA は share_target に非対応のため、ショートカットを使う必要がある | 小 | 0 | ○ |
| メール転送 → IMAP ポーリング（専用 Gmail ラベルかエイリアス） | 電子取引データ（PDF の請求書や領収メール）の受け口として最適。受信サーバーは不要で、systemd timer から取りに行くだけ | Gmail の認証情報（アプリパスワードか OAuth）を管理する必要がある。メール本文そのものが証憑の場合は .eml で保存する | 中 | 0 | ◎（電子取引データ用） |
| Cloudflare Email Routing → Worker | 独自ドメインで受けられる | Worker から Tailscale 内に届かないので、R2 などに中継する必要がある。外部サービスが 1 つ増える | 中 | 無料枠内でほぼ 0 | △ |
| Telegram bot（getUpdates でポーリング） | 受け口のポートを開けなくてよい。撮ってすぐ送れる | 証憑が Telegram のサーバーを通る。画像が再圧縮される（ファイルとして送れば回避できる） | 小 | 0 | △（予備） |
| LINE bot | 普段使いのアプリで送れる | 公開 Webhook が必要になる（127.0.0.1 バインドの方針に反する） | 中 | 0 | ✗ |

**推薦: PWA（撮影と確認 UI を 1 つに）＋ OS の共有シート ＋ IMAP ポーリング（電子取引データ用）の 3 つ。Telegram はやらない。**
共有シートの実装方式はスマホが iOS か Android かで変わる（未決 Q1）。

### 3.2 パイプライン

```
[取り込み] PWA/共有/IMAP
   │ 受信したバイト列をそのまま SHA-256 → 同じハッシュが既にあれば重複として弾く
   ▼
[原本保存] objects/sha256/ab/cd…（書き込みは 1 回だけ。0444 に設定）＋ DB に documents 行と audit を記録
   │ jobs に ocr を積む → `systemctl --user start keihi-worker`（既に動いていれば何もしない）
   ▼
[OCR] worker（ワンショット起動。キューが空になったら終了）→ extractions
   ▼
[分類] まず取引先→科目辞書を引く。当たらなければ Kev → classifications（top-k とスコア）
   ▼
[確認キュー] PWA。日付、金額、取引先、科目、税区分、支払手段を確定させる。私用・重複・却下も選べる → reviews（版を重ねて記録）
   ▼
[送信] outbound の状態機械（下記）→ MF
   ▼
[照合] 日次の timer。GET journals で tags と voucher_file_ids を確認 → verified か要対応か
```

- 送信は 1 件ずつ逐次処理する。MF の 3 回/秒の制限に対しては 1 件あたり 2〜3 リクエストしか使わないので、余裕を持たせて 1 秒間隔で送る。
- OCR と Kev はいずれも **同時に 1 本しか動かさない**（systemd の unit が二重起動しないことを利用）。各ジョブには `MemoryMax` と `CPUQuota` を付け、他のサービスを圧迫しないようにする。

### 3.3 MF 送信の状態機械（冪等性）
照合キー `kh-<ULID の先頭 17 文字>` を作る（tags は 1 個 20 字までのため）。

1. `queued` → DB に照合キーを記録してから `sending_journal` に進む
2. `POST /journals`（memo と tags に照合キーを入れる）
   - 成功: `journal_created(remote_journal_id)`
   - タイムアウトや 5xx: **再送する前に** `GET /journals?start_date=end_date=取引日` を叩き、tags に照合キーがあるか探す → あればその ID を採用し、無ければ再送する
3. `POST /vouchers {journal_id, file}`。MF の証憑は消せないので、再送の前に `GET /journals/{id}` で `voucher_file_ids` が空かどうかを確かめる
4. 照合で verified にする。4xx は自動で再送せず `needs_attention` にして UI に出す
- 再送は指数バックオフ（1 分 → 5 分 → 30 分 → 2 時間、最大 6 回）。429 のときは少し待つ。401 のときはトークンを更新して 1 回だけやり直す。
- freee の場合は順序が逆になる。receipts（メタデータ付き）を先に上げ、その後 deals に `receipt_ids` と `ref_number` を付けて作る。重複の確認には GET の `ref_number` を使い、証憑は期間指定の GET で確認する。

### 3.4 自作側の保存
- **原本**: 内容アドレス方式で保存する。上書きはせず追記のみ（アプリから削除する API を作らない）。ファイルを 0444 にするのは慣習レベルの保護にとどまる（`chattr +i` は root 権限が要るので使わない）。改ざんを検知する仕組みは次の 2 つで担保する。
  - 監査ログをハッシュチェーンにする（各行が直前の行のハッシュを持つ）
  - オフサイトに WORM で置く
- **保持期間**: デフォルトは「年度末から 7 年＋余裕 1 年」。正確な起算日は別担当の結論に従い、設定値として持つ。期間を過ぎても自動では消さず、一覧に出して人が判断する。
- **保存先の比較**

| 保存先 | 料金 | 改ざん防止 | 評価 |
|---|---|---|---|
| ローカルディスク | 0（空きは 27GB、使用率 72%） | 無し | ◎（正本） |
| Cloudflare R2 | Standard は $0.015/GB/月、10GB まで無料、egress 無料 [CF1] | Bucket Locks は prefix 単位で保持期間を設定できるが、ルールは管理者が削除できる。S3 の Object Lock や Versioning の API は未実装 [CF2][CF3] | △（WORM としては弱い） |
| Backblaze B2 | $6.95/TB/月、10GB まで無料、保存量の 3 倍まで egress 無料、最低保存期間なし [BB1] | Object Lock に対応（compliance / governance、S3 互換）。compliance はサポートでも解除できない [BB2] | ◎（オフサイト WORM） |

- **バックアップ**: restic（cargo か GitHub release でユーザー領域に入れる）で暗号化し、B2 に送る。
  - バケットは Versioning と Object Lock（governance、保持 8 年）を有効にする。restic の鍵は削除権限を持たせない形で発行する。
  - prune は使わず、追記のみで運用する（7 年分でも 20GB 程度）。
  - restic が終了時に lock ファイルを消そうとしたとき、delete marker になって正常に動くかは【要PoC】。
  - SQLite は `VACUUM INTO` でスナップショットを取ってから restic に渡す。
  - restic のパスワードは別の場所（パスワードマネージャ）に保管する。紛失すると復元できない。
- **リストア訓練**: 四半期に 1 回、systemd timer で `restic check --read-data-subset=5%` を流す。加えて、別ディレクトリに全量を復元し、SHA-256 と DB の照合まで行う。結果は audit に記録し、失敗したら通知する。

### 3.5 データモデル概略（SQLite）
- `documents`: id(ULID), sha256 UNIQUE, bytes, mime, orig_name, source(pwa|share|imap), source_ref(Message-ID など), kind(scan|e_transaction), received_at, exif_taken_at, storage_key, status
- `extractions`: id, document_id, engine, engine_ver, raw_json, txn_date, amount_total, tax_by_rate_json(10%/8%), vendor_name, invoice_reg_no, confidence, created_at
- `classifications`: id, extraction_id, source(rule|kev), model_ver, candidates_json(top-k の科目、税区分、スコア), created_at
- `reviews`: id, document_id, version, txn_date, amount, vendor, account_id, tax_id, credit_account(事業主借/現金/カード…), memo, decision(approve|personal|duplicate|reject), decided_at
- `outbound`: id, review_id+version, provider(mf|freee), match_key UNIQUE, state, remote_journal_id, remote_voucher_ids, attempts, next_retry_at, last_error, sent_payload_sha256, created_at, updated_at
- `jobs`: id, kind(ocr|classify|send|reconcile), ref_id, state, attempts, run_after, locked_at
- `audit_log`: seq, ts, actor(user|worker|timer), action, entity, entity_id, payload_json, prev_hash, hash
- `vendor_rules`: vendor_norm, invoice_reg_no, account_id, tax_id, credit_account, hit_count, last_used_at, origin(manual|learned)
- `provider_masters`: provider, kind(account|tax|partner), remote_id, name, fetched_at（MF 側の科目 ID と表示名のキャッシュ）
- 方針: 抽出結果、分類結果、確認内容は**上書きせず、新しい行を追加する**。そのため「どの版を送ったか」を常に追跡できる。

### 3.6 技術スタック（N100 向けの軽量構成）
- Web と API: Node v24 + Hono（または Fastify）。PWA は Vite + Preact の静的ビルドを同じプロセスから配信する。
  - 常駐させるのはこの 1 プロセス（RSS 60〜100MB 程度【推測】）。127.0.0.1 にバインドし、`tailscale serve` の別ポートで HTTPS 化する。
  - 案として、systemd の user socket activation で接続が来たときだけ起動し、一定時間アイドルなら終了させる方法もある。
- Worker: Python venv（OCR と Kev の推論は別担当の選定に従う）のワンショット CLI。web からの `systemctl --user start` と 5 分ごとの timer の両方で起動する。キューが空になったら終了する。
- DB: **SQLite（WAL）を推薦**。既存の postgres（127.0.0.1:5433 と思われるもの）に相乗りしない理由は次の 3 つ。
  - 他プロジェクトとの障害やメンテナンスの巻き込みを避けたい
  - 書き込みは 1 人分なので SQLite で十分
  - 1 ファイルで済むのでバックアップしやすい
  - 置き場所は Node 側が better-sqlite3（または node:sqlite）、Python 側が標準の sqlite3 で、同じファイルを共有する。
- 通知: ntfy か、確認待ちの件数を PWA のバッジに出す（未決 Q6）。

### 3.7 認証とシークレット
- ネットワーク: 公開するのは tailscale serve（tailnet only）だけ。Funnel は使わない。
- アプリ認証（+α）: Tailscale の `Tailscale-User-Login` ヘッダを許可リストと照合する（serve 経由のときだけ付与される。直接 127.0.0.1 に来た場合はヘッダを信用しない）。さらに WebAuthn（パスキー）を 1 本登録しておくと、端末を紛失した場合にも耐えられる。
- CSRF: SameSite=Strict の Cookie と Origin の検証。アップロードはサイズ上限と MIME の検証を行う。
- シークレット: MF の APIキー、Gmail の認証情報、restic のパスワード。
  - `~/.config/keihi/secrets.env`（0600）に置き、systemd の `EnvironmentFile=` で渡す。
  - 推薦は systemd-creds（user）か age 暗号化ファイル。DB とログにはトークンを出さない。
  - MF の認証方式は **APIキーを推薦**する。リフレッシュ処理が要らず、JWT を 1h キャッシュするだけで済み、操作履歴に発行者が記録されるため [MF6]。

---

## 4. 実装分解（implementer に渡す粒度。順番どおり）
0. **PoC（spec 確定の前提）**: 個人プランで MF のアプリポータルを開始し、APIキーを発行する。その上で journals の POST と vouchers の POST（journal_id 付き）を試す。tags で検索できること、5MB を超えるファイルで 413 になることも確認する。← ユーザーの手作業が要る
1. リポジトリ雛形、systemd user unit（web、worker、timers）、tailscale serve の設定手順書
2. 取り込み API と原本の保存（SHA-256 による重複排除、audit のハッシュチェーン）
3. jobs キューと worker の骨組み（OCR と Kev はスタブで代用）
4. 確認 UI（PWA。一覧、詳細、承認、却下）
5. MF Provider（マスタの同期、送信の状態機械、照合 timer）
6. IMAP 取り込み
7. restic と B2 のバックアップ、リストア訓練の timer
8. OCR と Kev の差し込み（別担当の選定結果を受けて）

## 5. 決定事項 / 未決事項
決定（本書の前提）: 送信先は MF（A）。原本は自前でも追記専用で保管する（C の形）。DB は SQLite。tailnet の外には公開しない。冪等性は照合キーの埋め込みで担保する。

未決（決める人）:
- Q1 スマホは iOS と Android のどちらか（共有シートの実装方式が変わる）→ ユーザー
- Q2 MF のプラン（ミニかパーソナルか）。2026-12 の改定後の価格を確認する → ユーザー
- Q3 MF の 5MB 上限のため縮小した派生ファイルを送ることになるが、電帳法上許容されるか。また正本を MF と自前のどちらに置くか → 法令担当
- Q4 オフサイト保管を B2 にしてよいか（カードの登録が必要。リージョンは US/EU で、日本は無い）。R2 の方が良いか → ユーザー
- Q5 電子取引データの受け口を Gmail のラベルにするか独自アドレスにするか → ユーザー
- Q6 確認待ちの通知を ntfy（セルフホスト）にするか、通知無しにするか → ユーザー
- Q7 支払手段の扱い（カード払いの経費を「未払金」で計上するか、MF の明細連携と突き合わせるか）。二重計上のリスクがある → ユーザー（税理士に確認でも可）
- Q8 個人プランで MF のアプリポータルと APIキーが使えるか → PoC の結果（ユーザーの手作業）
- Q9 freee に切り替える可能性がゼロなら、Provider の抽象化をやめて工数を減らすか → ユーザー

## 出典
- [MF1] https://biz.moneyforward.com/support/account/news/new-feature/20260326.html
- [MF2] https://biz.moneyforward.com/support/account/guide/others/ot09.html / https://biz.moneyforward.com/support/tax-return/guide/others/ot09.html
- [MF3] https://developers.biz.moneyforward.com/docs/common/oauth/overview
- [MF4] https://developers.biz.moneyforward.com/docs/common/api-keys/overview , https://developers.biz.moneyforward.com/docs/tutorials/api-keys/step-2-exchange-for-jwt
- [MF5] https://biz.moneyforward.com/tax_return/price/
- [MF6] https://developers.api-accounting.moneyforward.com/ （OpenAPI: /v3/openapi.yaml）
- [MF7] https://developers.api-accounting.moneyforward.com/specs/vouchers
- [MF8] https://developers.api-accounting.moneyforward.com/rate_limiter
- [MF9] https://biz.moneyforward.com/support/account/guide/others/ot10.html
- [FR1] https://github.com/freee/freee-api-schema （v2020_06_15/open-api-3/api-schema.json、2026-10-13 時点）
- [FR2] https://developer.freee.co.jp/reference/faq/token_lifetime
- [FR3] https://developer.freee.co.jp/reference/faq/application-types
- [FR4] https://developer.freee.co.jp/startguide/getting-access-token
- [FR5] https://www.freee.co.jp/personal-business/accounting/pricing/ （検索結果経由。ページ本文は直接確認していない）
- [FR6] https://support.freee.co.jp/hc/ja/articles/213726523 （403 で本文を確認できていない）
- [FR7] https://github.com/freee/freee-mcp
- [CF1] https://developers.cloudflare.com/r2/pricing/
- [CF2] https://developers.cloudflare.com/r2/buckets/bucket-locks/
- [CF3] https://developers.cloudflare.com/r2/api/s3/api/
- [BB1] https://www.backblaze.com/cloud-storage/pricing
- [BB2] https://www.backblaze.com/docs/cloud-storage-object-lock
