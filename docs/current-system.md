# keihi 現行実装の見取り図（feature/m0-poc、HEAD 0292ef6、2026-11-05）

Explore エージェントが src/ の実コードで裏を取って作成。docs/ops/system-overview.md v0.1 と食い違う点は §9。【推測】は未確認。

Node 24 で TypeScript をそのまま実行（ビルドなし）し、Hono と `node:sqlite`（WAL）を使う。PWA は Preact + Vite。

## 1. 構成要素
| プロセス | 入口 | 起動（deploy/systemd/） |
|---|---|---|
| web（常駐するのはこれだけ） | `src/web/main.ts:20` | `keihi-web.service`。127.0.0.1:8795 固定（`src/config.ts:21-22`）。起動時にマイグレーションしない |
| worker（oneshot） | `src/worker/main.ts:130` | `keihi-worker.service`。web が `systemctl --user start --no-block` で起こす（`src/jobs/trigger.ts:16-20`）。`keihi-worker.timer` が起動 1 分後と、終了から 2 分ごとに拾う |
| daily | `src/jobs/trigger.ts daily`（`:29`） | `keihi-daily.timer` が 03:30 JST に daily ジョブを 1 件積み、worker を起こす |
| backup / drill | `tools/backup/run.ts`・`drill.ts` | `keihi-backup.timer`（03:30 JST）・`keihi-drill.timer`（quarterly） |
| CLI | `src/cli/keihi.ts` | `freee auth` だけ（oob 方式の再認可）。ほかに `src/db/migrate.ts`、`src/audit.ts verify` |

- docs/ops/systemd.md に書いてあるのは web と worker だけ。daily・backup・drill の unit は deploy/ にあるが、systemd.md には無い。
- config.toml のセクション（`src/config.ts:127-141`。知らないキーはエラー）は 13 個:
  `[paths]` / `[gemini]`（model, paid_tier_confirmed, thinking_level, media_resolution）/ `[freee]`（poc/prod_company_id, target=poc, day_boundary=jst）/ `[provider] kind`（freee/fake）/ `[ingest] max_upload_bytes`（20MB）/ `[calendar]`（deadline_mode early/cycle, year_end_holidays）/ `[deadline] count_from` / `[web]`（port, allowed_users, allowed_hosts）/ `[mcp] port`（8796。予約のみ）/ `[backup]`（6 キー）/ `[retention]` / `[worker]`（linger_ms=1500, reauth_wait_days=7）/ `[reconcile]`（verified_lookback_days=35, max_list_pages=20）
- secrets.env は 0600 でないと起動を拒否（`:232`）。キーは GEMINI_API_KEY / FREEE_CLIENT_ID / FREEE_CLIENT_SECRET と restic・B2 用（`src/backup/settings.ts:13-18`）。

## 2. データの流れ（ジョブは `src/jobs/queue.ts:12` の 6 種類）
documents.status は received → needs_review → approved / personal / duplicate / rejected → sent → verified と進み、どの段からでも needs_attention になる。

1. **取り込み** `POST /api/documents`（`src/web/routes/ingest.ts`）
   - MIME は先頭バイトで判定（JPEG/PNG/PDF）、sha256 が同じなら 409、scan は 200dpi 相当（R2）とカラー（R3）を確かめ、満たさなければ 422。force で受理し紙の保管を「要」にする。
   - 原本は `objects/sha256/ab/cd/<sha>` に 0444 で置く。上書きしない（`src/storage/objects.ts`）。
   - 期限 deadline_on を計算。documents・監査（document.received）・ジョブ upload_receipt と extract を 1 トランザクションで書き、worker を起こす（`:140-183`）。
2. **upload_receipt**（`src/worker/handlers/uploadReceipt.ts:98`）: 原本を加工せず freee ファイルボックスへ。description に `kh-<id>`。
   - 成功で provider_uploads を uploaded、meta_deadline_on = 今日 + 70 日（`:146`）。
   - 2 回目以降は findReceiptsByKey で「実は届いていたか」を確認。
   - 4xx → upload_rejected。期限 2 営業日前超過 → upload_deadline_near。最後の試行 → upload_retries_exhausted（`:177-184`）。
   - invalid_grant は失敗に数えず 6 時間ずつ延期。7 日超で upload_reauth_expired。
3. **extract**（`src/worker/handlers/extract.ts`）: 派生画像を Gemini に送り、検証して extractions / classifications / ai_turns に保存、needs_review に。辞書ヒットは source=rule を先に書く。no_ai なら Gemini を呼ばない。
   - スキーマ違反は 1 回再要求、駄目なら ai_schema_invalid。他の 4xx は ai_request_rejected。上限で extract_retries_exhausted（`:184,193,231`）。
4. **確認・確定**（`src/review/card.ts`, `src/review/confirm.ts`）: カードは ui_cards。確定で reviews に版を追記、status を `STATUS_OF` の値に（`confirm.ts:36`）。needs_attention なら残す（`:288`）。
   - approve のときだけ update_receipt_meta と send_deal を積む（`:37,319`）。approve と personal で vendor_rules を学習（`src/review/learn.ts`）。
5. **update_receipt_meta**: PUT /receipts/{id} で発行元・日付・金額・登録番号を送り meta_state=sent（`updateReceiptMeta.ts:116`）。証憑未着なら 10 分後へ延期。70 日超で meta_deadline_passed。他は meta_update_rejected / meta_retries_exhausted。
6. **send_deal**（`src/worker/handlers/send.ts`, `src/deals/builder.ts`）: 最新の approve 版から DealDraft。カードは未決済、現金・事業主借は決済済み。按分の残りは事業主貸 1 行。
   - 状態機械（`src/deals/stateMachine.ts:20-27`）: queued → sending → deal_created → receipt_linked → verified。どこからでも needs_attention。needs_attention → queued は remote_deal_id が NULL のみ。
   - documents.status との対応は `:34-40`。
   - 失敗: send_rejected / send_retries_exhausted / build_failed / duplicate_deals / review_changed_after_send。再認可待ちは 6 時間後に積み直す。
7. **daily**（`src/worker/handlers/daily.ts:1-14`）: トークン更新（残り 30 日）→ マスタ同期 → 再認可待ち upload の再起動 → 70 日期限チェック → reconcile_deals → 紙原本の状態更新 → 30 日ごとの証憑照合 → 要対応の集計。同じ日の再実行では済んだ段を飛ばす。
8. **reconcile_deals**（`src/deals/reconcile.ts`）: freee の取引と比較、一致で verified。差があれば deal_missing / receipt_detached / amount_changed / account_changed。自動では直さない。
9. **要対応の解消**（`src/review/attention.ts:1-11`）: retry は理由に応じたジョブを積み直す（deal 系は requeueDeal。freee に取引があれば 409）。dismiss は監査だけ残す。
- ジョブ共通: バックオフ 1 → 5 → 30 → 120 分、6 回で failed。running 15 分超のロックは取り直す（`src/jobs/queue.ts:8-10`）。

## 3. DB（`src/db/migrations`）
- **0001_init**
  - documents: sha256 UNIQUE, kind, size_preset, resolution_ok, color_ok, paper_required, received_on, deadline_on, storage_key, no_ai, status, paper_status, integrity_checked_at。削除禁止、更新は状態の列のみ
  - extractions: txn_date, amount_total, tax_by_rate_json, vendor_name, invoice_reg_no, raw_json。追記専用
  - classifications: extraction_id, source, candidates_json。追記専用
  - reviews: version, txn_date, amount, vendor, account_id, tax_id, credit_account, decision, field_sources_json。追記専用
  - ai_turns: model, request_sha256, response_json, tokens。追記専用
  - ui_cards: card_json, status（open / answered / superseded）
  - answers: 書き込み箇所なし
  - vendor_rules: vendor_norm PK, invoice_reg_no, account_id, tax_id, hit_count, origin
  - provider_masters: 未使用（0002 で置き換え）
  - provider_uploads: state, remote_receipt_id, meta_state, meta_deadline_on, attempts
  - settings: key, value_json
  - freee_calls: called_on, purpose, endpoint, status, request_id
  - jobs: kind, ref_id, state, attempts, run_after, locked_at
  - audit_log: seq, actor, action, entity, payload_json, prev_hash, hash。更新・削除禁止
- **0002_m2**: provider_master_versions（版を追記、kind に walletable、retired_at）/ walletable_aliases / vendor_rules.confidence
- **0003_review**: reviews に proration_pct, tax_by_rate_json, invoice_reg_no, qualified_invoice / vendor_rules.mismatch_count
- **0004_deals**: deals（ref_number=`kh-<doc>`, state, issue_date, draft_json, draft_sha256, remote_deal_id, attention_reason, attention_at, attention_resolved_at, verified_at。削除禁止）/ documents.paper_discarded_at（一度入れたら不変）

## 4. HTTP API（`src/web/app.ts:76-84`）
認証は全ルート共通のミドルウェア（`src/web/auth.ts:109-127`）: ① Host が許可リストに無ければ 400 → ② `/healthz` は通す → ③ 変更系で Origin が許可外なら 403 → ④ `Tailscale-User-Login` が無ければ 401、allowed_users 外なら 403。

| メソッド・パス | 役割 |
|---|---|
| GET /healthz | 死活確認 |
| POST /api/documents | 取り込み（multipart） |
| GET /api/documents[?status=] | 一覧（`src/review/list.ts:11`） |
| GET /api/documents/counts | 確認待ち・要対応・期限間近の件数 |
| GET /api/status | 件数・ジョブ・バックアップの状態 |
| GET /api/documents/:id/card | 確認カード |
| GET /api/documents/:id/thumbnail | サムネイル（長辺 640px） |
| POST /api/documents/:id/{approve,reject,mark_private,mark_duplicate} | 確定 |
| GET /api/attention | 要対応の一覧 |
| POST /api/documents/:id/attention/resolve | 要対応の解消（retry / dismiss） |
| POST /api/attention/:id/resolve | 同上（互換。:id は deals.id） |
| POST /api/documents/:id/paper | 紙原本を「廃棄済」に |
| GET /api/export/mapping.csv | 取引 ID ⇔ 証憑 ID ⇔ keihi ID の対応表 |
| POST /share-target, GET /* | PWA の静的配信（`routes/static.ts`、CSP 付き） |

- PWA（`pwa/src/main.tsx:17`）は 4 タブ: 撮影（Capture）/ 確認（ReviewList、確認待ち・要対応を切替）/ 送信待ち（QueueList、IndexedDB のキュー）/ 送信済み（SentList）。service worker（`sw.ts`）と Android の Web Share Target。
- PWA は paper・export の API を呼ばない。

## 5. 外部連携
- **Gemini**（`src/ai/gemini/client.ts`）: 既定 `gemini-3.8-flash`、thinking=low、media_resolution=medium（`src/config.ts:14-17`）。REST generateContent を fetch で直接。EXIF を落とした派生画像だけを inline で送る（`derive.ts`）。科目 enum は enabled_accounts。税は税率の区分だけ選ばせ、税区分コードはサーバーが変換（`validate.ts`）。paid_tier_confirmed が無いと起動しない（`config.ts:317`）。
- **freee**（`src/providers/freee/`）
  - OAuth 認可コード + oob。トークンは `<data_dir>/freee-token.json`（0600）、lock で排他（`auth.ts:13-15`）。残り 30 日で更新。
  - 使う API（`provider.ts:253-447`）: receipts（POST / PUT / GET / download）、deals（POST / PUT / GET / DELETE）、account_items、taxes/codes、walletables、partners、wallet_txns、user_matchers。
  - 予算（`budget.ts:1-23`）: 1 日 3000 回。upload に 600 回の予約枠。用途別上限 sync 300 / execute 600 / auth 50。残り 500 で sync 停止、200 で upload と auth のみ。403 で 10 分停止。download は 1 秒 3 回（`client.ts:33`）。1 本ずつ直列。
  - invalid_grant で settings.freee_reauth_required=1、以降 freee を呼ばない。
- **restic / B2**（`src/backup/`）: サブコマンドは backup / check / restore / snapshots / version のみ（`restic.ts:8`）。DB は VACUUM INTO + manifest（`snapshot.ts`）。freee-token.json と *.env は除外（`backup.ts:16`）。B2 は例示のみ（`deploy/config.example.toml:48`）。
- **Provider interface**（`src/providers/types.ts:178-202`）: capabilities, uploadReceipt, updateReceiptMeta, downloadReceipt, findReceiptsByKey, createExpenseDeal, attachReceipts, getDeal, listDeals, deleteDeal, syncMasters, listBankTxns, listRules, createRule, deleteRule, reconcileTxn?, ignoreTxn?。capabilities は receiptMetaOnUpload / canLinkExistingReceipt / canReconcileTxn / maxReceiptBytes（freee: true / true / false / 64MB、`provider.ts:43-46`）。エラー種別と再試行可否は `types.ts:7-24`。

## 6. 横断機能
- **監査ログ**（`src/audit.ts:1-5,45-73`）: hash = sha256(prev_hash ‖ canonical_json(seq, ts, actor, action, entity, entity_id, payload_json))。先頭の prev_hash は 0×64。`verifyAudit` は最初に壊れた seq を返す。状態変更と同じトランザクションで追記。
- **営業日・期限**（`src/calendar/businessDays.ts:1-8,101`）: 休業日は土日 + 内閣府祝日（holidays.json、1955〜2027）。年末年始は設定で追加可。early = 受領日から 7 営業日目、cycle = 受領日 + 2 か月を起点に 7 営業日目。祝日データの無い年は warnings。
- **紙原本**（`src/deals/paper.ts:33-50`）: keep_required / discard_ok / discarded / unknown。電子取引は unknown。discard_ok は「期限内アップロード」かつ「期限内の同等確認（integrity_checked_at）」かつ settings.paper_discard_allowed のときだけ。
- **取引先辞書**（`src/vendors/`）: 正規化は NFKC → 小文字 → ハイフン統一 → 法人格除去 → 空白除去。引く順は登録番号 → 正規化名（`dictionary.ts:48`）。
- **マスタ**（`src/masters/`）: sync.ts で内容の変わった版だけ追記。科目 accounts.ts と税 tax-map.ts は `config/*.json` が無いと仮の表。

## 7. テスト（`node --test`）
- unit 40 ファイル 約 446 件 / api 3 ファイル 約 50 件 / contracts 1 ファイル 4 件（`freee-openapi.json` + fetch モックでリクエストが定義に合うか）/ fixtures: 領収書 30 枚 + truth.json、`injection-strings.json`。件数は grep の概数。
- fake provider（`src/providers/fake/index.ts`）: メモリ内のみ。`failNext` で障害注入、`butSucceed` で「タイムアウトだが実は成功」を再現。`[provider] kind="fake"` で開発用にも使える。

## 8. まだ無いもの・仮のもの
- 仮の対応表: `src/masters/default-account-map.json`（provisional、24 件）と `default-tax-map.json`（本則課税を仮定）。`config/` は無い。
- **integrity_checked_at に書き込む箇所が無い**（読むのは paper.ts と export.ts のみ）。【推測】このため discard_ok には実際にはならない。
- 書き込まれない列・表: meta_state=verified、answers、provider_masters、documents.exif_taken_at、source=imap。
- Provider の未使用メソッド: listBankTxns / ルール系 / deleteDeal はハンドラから呼ばれない（M6）。reconcileTxn 未実装。
- 入口の無い機能: MCP（8796）は予約のみ。field_sources の agent も予約のみ（M7）。`[retention]` は読むが未使用。バックアップ失敗の通知（Q6）は未決。
- 実装と食い違うコメント: `POST /api/outbound/:id/retry`（`stateMachine.ts:139`）は存在しない（実際は attention/resolve）。daily のコメントにある再認可の「PWA の帯」は無く、/api/status は reauth を返さない。

## 9. system-overview.md と実装の食い違い
- §3-8（月 1 回の証憑照合）: 既定 `remote_verify_mode="download_only"` ではダウンロードできて空でないことしか確かめない。原本と比べるのは sha256 モードのみ（`src/backup/verifyRemote.ts:6-9`）。
- §3-3（紙の廃棄）: integrity_checked_at と paper_discard_allowed により【推測】いまは常に保管要。
- §5（保持 8 年）: 設定は 7 + 1 年だが、保持期間を使う処理は無い。
