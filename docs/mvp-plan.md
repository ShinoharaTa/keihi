# keihi MVP 実装計画（ドラフト v0.2 / 2026-10-17・未承認）

v0.1（2026-10-13）からの主な変更: 会計サービスを **freee スタンダード（2027 年分から）** に一本化（MF の Provider・T0-2 の MF PoC・§5.1 の分岐 A/B/C・D8 を削除）/ T0-2 を freee の F1〜F16 に置換 / T1-10 を freee の OAuth に / M6 を freee の制約（明細の消込・無視の API なし）に合わせて「提案の基盤と明細の同期」に作り直し / **自然言語（旧 M7）を削除し、M7 を keihi MCP に** / T0-1・T0-3 を完了扱い / T0-3 の仮決め（税区分 3・科目 24・EXIF 除去）の扱いを追加。
前提: docs/README.md §3.0（最新の決定）、freee-codex.md（§3 F1〜F16、§5）、mcp.md（本計画と同時のドラフト）、transactions.md（§4・§6・§7 は freee に読み替えて使う。U10・M7・MF 固有の部分は不採用）、a2ui-review-ui.md（B 案）、legal.md §2.3・§2.4・§7（R1〜R22）、classification-ocr.md。
表記: **[事実]** docs・本機・一次情報で確認 / **[推測]** 見積もり・解釈 / **[要PoC]** 叩くまで不明 / **[承認要]** 初期値の提案。

## 0. 何のために / MVP の範囲

**目的**: 紙の領収書を撮る（または PDF を共有する）だけで、①入力期限内に **freee のファイルボックス**へ証憑が入り、②数タップで科目を確定して取引が入り、③原本・確定の経緯・AI ログが 7 年間、手元とオフサイトに残る。④ユーザー自身のエージェント（Claude Code / Codex）が keihi の MCP から状況を読み、整理の提案を作れる（確定は本人）。

| MVP に入れる | MVP に入れない（理由） |
|---|---|
| PWA 撮影・Android 共有シート・iOS ショートカット POST | IMAP 取り込み（Q5 未決） |
| 原本の追記専用保存、監査ログのハッシュチェーン | **MF の Provider**（2026 年分は MF の画面で手作業。interface は残す） |
| freee への即アップロード（検索項目は後から PUT）、期限管理（R5〜R9） | **keihi 内の自然言語の指示**（2026-10-17 の決定。旧 U10・旧 M7） |
| 辞書 → Gemini 3.8 Flash（抽出 + 科目候補 + 質問） | 自由文の AI 相談（U2） |
| 固定確認カード + 質問カード + 提案カード（keihi.catalog/v1.1） | ローカル OCR（D12: no_ai フラグ + 手入力） |
| freee の取引の送信（状態機械）、日次照合 | WebAuthn、push 通知、TF-IDF 分類、国税庁 Web-API 照合、画像マスク |
| 明細の同期と照合、自動登録ルールの提案、**提案の基盤** | 明細 1 件ごとの消込・無視を keihi から確定（freee に API が無い。公開されたら足す） |
| **keihi MCP**（127.0.0.1、読み取り + 提案） | MCP からの確定・削除・汎用の freee 呼び出し（mcp.md §3.3） |
| restic による暗号化バックアップ、リストア訓練 | prune（追記のみ運用）、別 uid での分離（mcp.md §7.6） |

**本機で確認した事実**
- （2026-10-13）Node v24.20.0（nvm）、`node:sqlite` 可。systemd 255。`tailscale serve` の https:9443 は別プロジェクト（127.0.0.1:8790）が使用中。IPAGothic あり。restic・sqlite3 CLI は未導入。ディスク空き 26GB。
- （2026-10-17）127.0.0.1 の 8795・8796 は空き（`ss -ltn`）。`~/.config/keihi/` が無い → **T0-3 は実 API ではまだ実行されていない**（Gemini のキーが未配置）。依存は `sharp`・`pdf-lib` だけ。git の remote が未設定（`gh issue` / PR の運用の前に remote が要る）。

---

## 1. マイルストーンと順序

```
M0  T0-1 ✔  T0-3 ✔(コード) ─ T0-3r 実 API で実行 ─┐
    T0-2' freee PoC（テスト事業所 F1〜F14,F16）──┼─> T0-4 マスタの対応表（科目・税区分）
    T0-5 送信用の派生画像の向き補正 ────────────┘
M1  基盤・取り込み・原本保存・freee OAuth・即アップロード
 └> M2 抽出・辞書・固定確認カード（freee のマスタで）
     └> M4 取引の送信・照合
         └> M5 バックアップ・リストア訓練
             └> (12 月: F15 本番事業所の読み取り → 契約) ─> G1 本番投入 2027-01-01
                 └> M6 提案の基盤・明細の同期・照合・ルール提案
                     └> M7 keihi MCP（読み取り + 提案）
                         └> M3 質問カード
```

**推薦する実施順: M0 → M1 → M2 → M4 → M5 → G1（2027-01-01）→ M6 → M7 → M3** [承認要]
- G1 は日付が動かない（2027 年分の取引と証憑は 2027-01-01 から freee に入れる。freee-codex.md §2.3）。今日から約 2.5 か月で、M1〜M5 は約 18〜21 日 [推測]。法定の処理（M1・M4）とデータ保全（M5）を先に固める。
- **M6 を M7 の前に置く理由**: 提案の状態機械・確認カード・実行・取り消しは、MCP だけでなく keihi 自身（ルールの学習・照合）も使う共通の部品。M7 はその上にツールを載せるだけにする。
- **M7 の読み取りだけ（T7-1〜T7-3）は G1 の前に前倒ししてよい**（M5 が 12 月半ばまでに終わった場合。テスト事業所のデータで試せる）[承認要: K11]。
- M3（質問カード）は体験の改善。エージェントの提案で代わりが利く部分もあるので、M7 の後に必要性を見直す。
- M2 の Gemini 応答スキーマには最初から `questions[]` を含めて保存だけする（v0.1 と同じ）。
- **ゲート G1**: M1・M2・M4・M5 の受け入れ条件がすべて通る + F15（本番事業所の読み取り）が 403 でない + freee の有償契約済み + §6 の「G1 前」が決まっている + 税理士確認 #1・#4 の回答（無ければ紙原本を全件保管で開始）。

| MS | 中身 | 工数 [推測] | 前提 |
|---|---|---|---|
| M0 | 残り: T0-3r（実行）、T0-2'（freee PoC）、T0-4（マスタの対応表）、T0-5（向き補正） | ユーザー 1.5h + 実装 1.5 日 | Y2、Gemini 有料キー、テスト事業所 |
| M1 | 雛形、設定、DB、監査ログ、原本保存、取り込み API、期限計算、ジョブ、Provider、**freee OAuth**、**API 予算**、即アップロード、PWA 撮影、共有、systemd | 7〜8 日 | T0-2'（F1・F2・F4・F7・F14） |
| M2 | マスタ同期（freee）、辞書、Gemini 抽出、検証、確認カード（固定）、確定 API、学習、**検索項目の PUT** | 5〜5.5 日 | M1、T0-4、U7・U8 |
| M4 | 取引ビルダ（連携カードは未決済・現金/事業主借は決済済み + receipt_ids）、送信状態機械、freee 送信、照合、要対応、紙原本ステータス、対応表 | 4 日 | M2、F8・F9、Y5・U4' |
| M5 | restic、スナップショット、バックアップ、リストア訓練、**証憑の sha256 照合**、運用文書 | 2.5〜3 日 | Q4、F6 |
| M6 | 提案の基盤、明細の同期、照合、ルール提案、確認カード v1.1 | 5〜6 日 | G1、F10〜F12、Y5・P2' |
| M7 | keihi MCP | 約 5 日 | M6、K1〜K3 |
| M3 | 質問カード | 3〜4 日 | M2、U3・U4・U5 |

---

## 2. タスク一覧（implementer に渡す粒度）

書式: **目的 / 触る / 入出力 / 受け入れ条件 / 残る判断**。「残る判断」が「なし」でないタスクは、§3 の該当項目が決まるまで渡さない。
検証の原則（v0.1 と同じ）: HTTP は Hono の `app.request()` で（ポートを開かずに）テスト。curl の確認は §4.2 の手順で起動 → 確認 → 停止まで。UI は surface JSON と Preact の SSR 文字列。実機が要るものは **[ユーザー確認]**。

### M0: PoC（実在の領収書・個人情報は使わない）

**T0-1 ダミー領収書の生成器** — **完了**（3e1b677、`tools/fixtures/gen-receipts.ts`、`test/unit/gen-receipts.test.ts`）
- 追加（T0-5 と一緒に）: EXIF の Orientation = 6・8 のダミー（画素は横倒し、タグで縦に見せる）を 2 枚足す。命令文入りの明細の摘要（M6・M7 の試験用の文字列表）を `test/fixtures/injection-strings.json` に置く。

**T0-3 Gemini PoC** — **コード完了**（2d7428e、`src/ai/gemini/client.ts`、`tools/poc/gemini-poc.ts`、`test/unit/gemini-poc.test.ts`）
- 仮決めした点（コードで確認）: 科目は名前そのものを ID にした 24 件（青色申告決算書の経費科目 + 新聞図書費・支払手数料・会議費・研修費・車両費 + 事業主貸）、税区分は仮の 3 区分（課税仕入10% / 課税仕入8%（軽減）/ 対象外）、送信用の画像は APP1（Exif/XMP）・APP13・COM を落とす（**Orientation も消える**）。→ T0-4・T0-5 で扱う。

**T0-3r Gemini PoC の実行（ユーザー手作業 + 実行）**
- ユーザー手作業: keihi 専用の GCP プロジェクト（Cloud Billing 有効）で API キーを発行 → `~/.config/keihi/secrets.env`（0600）に置き、`paid_tier_confirmed = true` を設定。
- 受け入れ: `poc/gemini-results.csv` と要約（4 条件の一致率・トークン・円/枚）。命令文入りの画像でスキーマの範囲内。結果から spec-writer が U7 を提案。
- 残る判断: なし。

**T0-2' freee PoC（テスト事業所。freee-codex.md §3 で T0-2 を置換）**
- ユーザー手作業（implementer は代行できない）: freee-codex.md §3.1 の 1〜7（テスト事業所、プライベートアプリ、client_id/secret を秘密ファイルへ、認可、手動口座 2 つ、画面の目視）。
- implementer の作るもの: `tools/poc/freee-auth.ts`（認可 URL・コードの交換・トークンの保存）、`tools/poc/freee-poc.ts`（F1〜F14・F16。書き込みは `company_id` が PoC 用と一致するときだけ。作ったものは `poc/freee-created.jsonl`）、後片付けのスクリプト（逆順に削除）。
- 受け入れ: `poc/freee-results.md` に F1〜F14・F16 の結果。§5.1 の M6 の分岐（F10〜F12）の結論が書いてある。
- F15（本番事業所の読み取りだけ）は 2026-12 上旬（G1 の前提）。
- 残る判断: Y2。

**T0-4 マスタの対応表（科目・税区分）**
- 目的: T0-3 の仮の科目と税区分を、freee のマスタに置き換える方針を確定する。
- 入力: F3 の結果（テスト事業所の `account_items`・`taxes/codes`。個人の本番事業所の既定の科目は F15 で再確認）。
- 出力: `docs/masters-mapping.md`（keihi の候補 24 件 → freee の勘定科目 ID と名前、freee に無い科目の扱い）と、税区分の方針。
- 方針の提案 [承認要: K12・K13]:
  - **科目**: Gemini には freee の勘定科目の**名前**を見せ、enum の値は freee の ID にする（T2-4）。freee の既定に無い科目（例: 研修費・車両費・会議費。有無は F3 で確認 [要PoC]）は、ユーザーが freee で作るか、近い科目に寄せる。
  - **税区分**: Gemini には**税率の区分だけ**（10% / 8% 軽減 / 対象外・不課税 / 非課税）を選ばせ、freee の税区分コードへは**サーバーが決定的に変換**する（登録番号の有無・経過措置の割合・課税方式で変わるため。R16・R17、税理士 #9）。変換表は設定値。
  - 再検証: 変換後の科目名で T0-3 の PoC を 1 条件（暫定の U7）だけ再実行し、一致率が落ちないことを確かめる。
- 受け入れ: 対応表がユーザーに承認されている。税区分の変換の表駆動テストの元データ（登録番号あり/なし × 10%/8% × 課税方式）が揃っている。
- 残る判断: K12・K13、税理士 #9。

**T0-5 送信用の派生画像の向き補正**
- 目的: EXIF を落とすと Orientation が消え、スマホの写真が横倒しで Gemini に届く（T0-3 の仮決めの副作用）。
- 触る: `src/ai/gemini/derive.ts`（PoC の strip 処理を移す）
- 内容: 派生画像は「Orientation に従って画素を回転（sharp の `rotate()`）→ メタデータを全部落として再エンコード（JPEG 品質 90）」。派生画像は法定の記録ではないので再エンコードしてよい（D13）。**freee へ送る原本は加工しない**（R4）。PWA のサムネイルも同じ関数で作る。
- 受け入れ: T0-1 の Orientation 6・8 のダミーで、派生画像の縦横が入れ替わり、EXIF が無い。原本の sha256 は変わらない。Orientation の無い画像では画素が変わらない（寸法一致）。
- 残る判断: なし。

### M1: 基盤・取り込み・原本保存・freee 認証・即アップロード

**T1-1 リポジトリ雛形**（v0.1 と同じ）
- `package.json`（npm）、`tsconfig.json`（`erasableSyntaxOnly`）、`src/`、`pwa/`（Vite + Preact）、`test/`、`deploy/`、`.gitignore`（既存に `poc/` の結果・`*.env` を足す）。
- 受け入れ: `npm ci && npm test && npm run build` が通る。`node src/web/main.ts` で起動。lint で `innerHTML`・`dangerouslySetInnerHTML`・`eval` を検出して失敗。
- 残る判断: D2・D3。

**T1-2 設定とシークレット**（v0.1 + freee）
- `~/.config/keihi/config.toml` + `secrets.env`（0600 以外は起動拒否）。freee の `client_id`・`client_secret`・`company_id`（本番とテストを別の名前で）を追加。トークンは別ファイル `~/.local/share/keihi/freee-token.json`（0600、§4.3）。
- 受け入れ: v0.1 と同じ + `freee.company_id` が無ければ freee を呼ぶ処理が起動時エラー。ダンプ関数がシークレットとトークンを `***` にする。
- 残る判断: なし。

**T1-3 DB とマイグレーション**（v0.1 から変更）
- `documents`（v0.1 と同じ列）、`provider_uploads`（`provisional_journal_id` を削除し、`remote_receipt_id`, `meta_state(none|sent|verified)`, `meta_deadline_on`（保存から 70 日）を追加）、`settings`、`freee_calls`（日付・用途・エンドポイント・ステータス・request_id）。
- M6 以降の表（`proposals` など）は M6 のマイグレーションで足す。
- 受け入れ: v0.1 と同じ（integrity_check、追記専用の表のトリガ）。
- 残る判断: D1。

**T1-4 監査ログ（ハッシュチェーン）**・**T1-5 原本ストア**・**T1-6 取り込み API（R1〜R5）**・**T1-7 営業日と期限（R6）**・**T1-8 ジョブキューと worker**: v0.1 と同じ。
- T1-6 の変更: サイズ上限の初期値を 20MB のまま（freee は 64MB [事実]）。Q3（5MB 超）の論点は消える。

**T1-9 Provider インターフェースと fake**（freee-codex.md §5.3 で置換）
- 触る: `src/providers/types.ts`、`src/providers/fake/`
- 内容: `uploadReceipt`, `updateReceiptMeta`, `downloadReceipt`, `findReceiptsByKey`, `createExpenseDeal(unsettled)`, `attachReceipts`, `getDeal`, `listDeals`, `deleteDeal`, `syncMasters`, `listBankTxns`, `listRules`, `createRule`, `deleteRule`, `capabilities()`（`receiptMetaOnUpload: true`, `canLinkExistingReceipt: true`, `canReconcileTxn: false`, `maxReceiptBytes`）。`reconcileTxn / ignoreTxn` は将来用に型だけ空けておく。
- 受け入れ: fake が in-memory で状態を持ち、障害注入（タイムアウト後に実は成功、5xx、429、403 の使用制限、401 の `invalid_grant`）ができる。
- 残る判断: なし。

**T1-10 freee OAuth クライアント**（MF クライアントを置換。D9 を書き換え）
- 触る: `src/providers/freee/{auth,client,provider}.ts`、`test/contracts/freee-openapi.json`（[FR-OA] の該当パスを抜き出して固定）、`src/cli/keihi.ts freee auth`（初回の認可。認可 URL を出し、リダイレクト先の callback か貼り付けで code を受ける）
- 内容: アクセストークン 6 時間、**リフレッシュトークンは 1 回限り** [FR-AUTH] → 更新は `flock`（`~/.local/share/keihi/freee-token.lock`）で web と worker の間で排他。新しいトークンを一時ファイル → fsync → rename で保存してから使う。90 日の失効を防ぐ日次 timer（`keihi-daily` の中で、残り 30 日を切ったら更新）。`invalid_grant` なら「再認可が要る」状態にして PWA に帯。直列化（1 本ずつ）、`/receipts/{id}/download` は 1 秒 3 回まで。
- 受け入れ: 契約テスト（送るボディが固定した定義に合う）。並行する 2 プロセスから同時に更新しても、更新の要求は 1 回だけ（テスト）。ログ・例外にトークンと secret が含まれない（文字列検査）。実 API は叩かない。
- 残る判断: なし（リダイレクト URI は freee-codex.md §3.1 の 3）。

**T1-15 freee の API 予算（新規）**
- 目的: 1 日 3,000 回（事業所とアプリごと）[FR-OA] の中で、法定の処理（即アップロード）が必ず通るようにする。
- 触る: `src/providers/freee/budget.ts`
- 内容: 呼び出しの前に用途（`upload` / `sync` / `execute` / `auth` / `user`）で予算を確認し、`freee_calls` に記録。配分は mcp.md §5.3。403（使用制限）を受けたら全用途を 10 分止める（DB の `settings` に `freee_paused_until`）。
- 受け入れ: 予算を超えた `sync` は呼ばずに延期、`upload` は予約枠の範囲で通る（表駆動）。403 の後 10 分は fake への呼び出しが 0 回。
- 残る判断: 日の区切り（F16。分かるまで JST の暦日）。

**T1-11 即アップロード（upload_receipt ジョブ）**（分岐を削除）
- 目的: R7。確認を待たずに期限内に freee へ証憑を入れる。
- 触る: `src/worker/handlers/uploadReceipt.ts`
- 内容: 取り込み直後に `POST /receipts`（メタデータは空、`description` に照合キー `kh-<document_id>`）。OCR・確定の後に `PUT /receipts/{id}` で発行元・発行日・金額（R11。T2-12）。
- 受け入れ: fake で 1 回の upload が記録され `provider_uploads.state=uploaded`。タイムアウト後に実は成功していたケースで、再送の前に `GET /receipts?category=without_deal` の照合キーで既存を採用し、二重に上げない（F7 が前提）。`deadline_on - 2 営業日` を過ぎて未送信なら `needs_attention`。予算の予約枠を使う（T1-15）。
- 残る判断: なし（F4・F7 の結果で照合の方法を微調整）。

**T1-12 PWA の殻・撮影・送信待ち**・**T1-13 共有シート**: v0.1 と同じ（T1-12 の HEIC の扱いは F14 の結果も見る）。

**T1-14 Web サーバー・認証・systemd・serve 手順**（v0.1 + MCP のポート予約）
- v0.1 と同じ。加えて設定に `mcp.port = 8796`（M7 まで無効）を持ち、`tailscale serve` の手順書に「8796 は載せない」を書く。
- 残る判断: D4。

### M2: 抽出・辞書・固定確認カード

**T2-1 マスタ同期（freee）**: `syncMasters` で `account_items`・`taxes/codes`・`partners`・`walletables` を `provider_masters` に保存。`enabled_accounts`（D11'、T0-4 の対応表）で Gemini に見せる科目を絞る。受け入れ: fake で同期 → 再同期で差分だけ追記。walletables は名前を保存し、別名（alias）は keihi 側で付ける（M6・M7 で使う）。残る判断: D11'。
**T2-2 取引先の正規化と辞書引き**: v0.1 と同じ。
**T2-3 Gemini クライアント**: PoC の `src/ai/gemini/client.ts` を本実装にする（受け入れは v0.1 と同じ）。送信用の画像は T0-5 の関数を使う。残る判断: U7（T0-3r）。
**T2-4 応答スキーマとカタログ定義**: v0.1 と同じ。ただし科目の enum は freee の勘定科目 ID、税は「税率の区分」の enum（T0-4）。
**T2-5 サーバー側の検証**: v0.1 と同じ + 税率の区分 → freee の税区分コードへの変換（表駆動テスト。T0-4 の元データ）。
**T2-6 抽出ジョブ**・**T2-7 確認カードの surface API**・**T2-8 確定 API**・**T2-9 学習**・**T2-10 PWA 確認画面**・**T2-11 一覧**: v0.1 と同じ。
- T2-8 の追加: `field_sources_json` の出所に `agent` を予約（M7 の提案から確定したとき）。

**T2-12 検索項目の更新（新規）**
- 目的: R11。確定した日付・金額・取引先を freee の証憑に入れる。
- 触る: `src/worker/handlers/updateReceiptMeta.ts`
- 内容: approve の後に `PUT /receipts/{id}`（発行元・発行日・金額、登録番号、`qualified_invoice`）。確定の版が変わったら再度 PUT（freee に履歴が残る [FR-EBOOK]）。
- 受け入れ: 保存から 70 日を過ぎた証憑は PUT せず `needs_attention: meta_deadline_passed`。期限の 7 日前に PWA の一覧で警告。fake で 2 回の訂正が 2 回の PUT になる。
- 残る判断: なし。

### M4: 取引の送信・照合

**T4-1 取引ビルダ**: 確定版の review → `DealDraft`（支出。**連携カード（card:*）は未決済**＝payments なし、**現金は wallet「現金」・事業主借は private_account_item「事業主借」の payments 付きで決済済み**（統合時に決定、2026-10-17）、`details`: 科目・税区分・金額、`partner`、`receipt_ids`、`ref_number` = 照合キー）。按分は U4'。受け入れ: 表駆動（現金・事業主借・カード、按分 0/50/100、軽減税率混在で 2 行）。残る判断: **Y5**（連携カードの支払いを未決済の取引で作り、freee で消込）、U4'。
**T4-2 送信の状態機械**: architecture.md §3.3 の状態（queued → sending → deal_created → receipt_linked → verified / needs_attention）。受け入れ: fake の「タイムアウトだが成功」で、再送の前に**発生日の範囲で `GET /deals` を取り、`ref_number` をローカルで照合**（GET に ref_number の絞り込みは無い [事実: FR-OA]）して既存を採用。4xx は再送せず needs_attention。
**T4-3 freee 送信**: `POST /deals`（receipt_ids 付き）。証憑なしで作った取引に後から付けるときは `PUT /deals/{id}`（**details を全部送り直す**。F9）。受け入れ: 契約テストと fake のシナリオ。
**T4-4 日次照合**: `GET /deals`（keihi が作った取引）で金額・科目・`receipt_ids` を確認 → verified。freee 側で人が編集した取引は差分を報告するだけ。受け入れ: 「証憑が外れた」「金額が変わった」「取引が消えた」の 3 ケースが needs_attention。
**T4-5 要対応 API と PWA**・**T4-6 紙原本ステータス（R8・R9）**: v0.1 と同じ。
**T4-7 対応表のエクスポート（R13）**: 列を `remote_receipt_id, remote_deal_id` に変更。

### M5: バックアップとリストア訓練
**T5-0〜T5-4**: v0.1 と同じ。
**T5-6 証憑の sha256 照合（新規）**: 月 1 回、keihi が上げた証憑を `GET /receipts/{id}/download`（1 秒 3 回以内）で取り、手元の原本の sha256 と比べる。受け入れ: 不一致を needs_attention。予算の `sync` 枠を使い、1 回の上限 200 件。前提: F6 で「freee は再圧縮しない」と確認できたこと（再圧縮するなら、このタスクは「ダウンロードできること」の確認に変える）。
**T5-5 運用文書**: v0.1 の内容を freee 向けに（年次の書き出しは freee の API でダウンロードできる）。加えて**電子取引の訂正削除防止の規程**の下書き（freee のテンプレート。Y13）、システム概要書に M7（エージェントは提案だけ）を書く。

### G1 の前（2026-12）
- **F15**（本番事業所・お試し）: freee-codex.md §3.1 の 8〜11。読み取りだけ。
- 契約（年払い）、本番の `company_id` を設定、本番で `keihi freee auth`。
- スモークテスト（ユーザー立ち会い）: ダミーではなく実在の領収書 1 枚で、撮影 → freee のファイルボックスに出る → 確定 → 取引 → 証憑の紐付け（2027-01-01 以降に実施）。

### M6: 提案の基盤・明細の同期・照合・ルール提案（freee 版。transactions.md M6 を作り直し）

前提の事実: freee の Public API には明細 1 件を消込・無視する API が無い（2026-10-15 版のスキーマ）[FR-OA]。ルール（user_matchers）の CRUD はある。明細の一覧に status の絞り込みは無い。

**T6-1 freee クライアントの追加**: `walletables`、`wallet_txns`（期間・口座・入出金、limit 100 のページング）、`user_matchers`（一覧・作成・削除）、`deals` の一覧。fake も。受け入れ: 契約テスト、fake のページング。残る判断: なし。
**T6-2 明細の同期とキャッシュ**: `walletables_local`（remote_id, name（ローカルのみ）, alias, kind, mcp_allowed, ai_allowed）、`bank_txns`（remote_id UNIQUE, walletable_id, date, amount, entry_side, description, description_norm, status, due_amount, rule_matched, first_seen_at, last_seen_at, raw_sha256）。6 時間ごと + PWA で開いたとき（10 分以内は再取得しない）。口座の設定画面（別名・MCP に出すか）。受け入れ: 同じ明細の再取得で行が増えない、status の変化を記録、予算の `sync` 枠を使う。残る判断: K3（mcp_allowed の既定）。
**T6-3 提案の基盤**: `proposals`（id, kind, proposer, status, content_json, content_hash, preconditions_json, expires_at, decided_by, decided_at）、`proposal_items`（id, proposal_id, target, op, state, exec_key, remote_id, attempts, last_error）。状態機械は mcp.md §4.1、上限は §4.2、冪等キーと取り消しは §4.4。提案者は `keihi`（ルールの学習・照合）と `agent:<client>`（M7）と `user`。受け入れ: 状態遷移の表駆動テスト（不正な遷移は例外）、`content_hash` 不一致の確定は 409、期限切れと前提の変化で expired、タイムアウト後に実は成功した item を exec_key で採用し二重に作らない、取り消しの提案が逆の操作になる。残る判断: K5・K6。
**T6-4 確認カード v1.1 と確定 API**: `keihi.catalog/v1.1`（mcp.md §4.3 の部品 + transactions.md の `TxnBatchCard`・`TxnRow`・`MatchCard`・`UndoBar`）、`POST /api/proposals/:id/decision`、PWA の「提案」一覧とバッジ。受け入れ: SSR スナップショット、item を外した確定、高額と `suspicious` の item が既定オフ。**[ユーザー確認]** 12 件の一括カードが片手で確定できる。残る判断: K4。
**T6-5 照合（領収書 ↔ 明細）**: transactions.md §6.2 の規則（金額一致必須、日付 0〜+3 日、取引先の類似度 + `vendor_aliases`）。照合は keihi の記録（`matches`）で、freee の消込は freee の「自動で経理」と本人の画面操作に任せる（freee-codex.md §5.2）。一覧「領収書はあるが明細が無い」「明細はあるが領収書が無い」「**freee で消込・無視が要る**」。受け入れ: 候補 1 件 + 取引先一致で提案（keihi が提案者）、複数は MatchCard、0 件は未照合。自動確定しない。残る判断: P7'（日付の幅）。
**T6-6 ルールの提案**: 同じ口座・同じ摘要のパターンで 3 回同じ分類が続いたら、`user_matchers` の作成を提案（自動では作らない）。確定前にキャッシュの直近 90 日に当てた件数を出す。受け入れ: 3 回目の分類で提案が 1 件だけでき、同じ条件の重複提案は作られない。残る判断: F12 の結果（API で作った明細にもルールが当たるか）、K14。
- 削除した v0.1/transactions.md のタスク: journalize・「MF で解除が要る」一覧（MF 固有）、T7-1 自然言語コマンド（決定により不採用）、T6-6 Gemini による明細の分類（**MVP 外に移す**。エージェントの提案で代わりにする。P1 は K3 に統合）。

### M7: keihi MCP（mcp.md §8）
**T7-1** リスナー・認証・scope・プロトコル版（1 日）/ **T7-2** 読み取りのツール（1.5 日）/ **T7-3** untrusted・正規化・suspicious・最小化（0.5 日）/ **T7-4** 提案のツール → T6-3（1 日）/ **T7-5** 監査・レート制限・予算（0.5 日）/ **T7-6** クライアントの設定手順と **[ユーザー確認]**（0.5 日）。
- 依存の追加: `@modelcontextprotocol/server` ^2.3、`@modelcontextprotocol/hono` ^2.0、`zod` ^4.2（server の依存）。`hono` は M1 で入るものと版を揃える（peer ^4.11.4）。
- 受け入れ条件の全体は mcp.md §8。残る判断: K1〜K3・K7・K8。

### M3: 質問カード（B 案）
**T3-1〜T3-6**: v0.1 と同じ（effect の `account_id` は freee の勘定科目 ID、`tax_id` は税率の区分）。

---

## 3. 未決事項と、決める必要があるタスクの対応

### 3.1 整理の結果（既存の Q・U・D・P・Y）
| 区分 | 項目 | 扱い |
|---|---|---|
| 解決・不要 | Q1（OS: 両方）、Q9（抽象化を残す）、Y1（freee 切り替え: 承認済み）、Y11（エージェントから MCP: 決定済み、mcp.md） | 閉じる |
| 削除（MF 固有） | Q2（MF のプラン）、Q8（MF 個人プランの API キー）、D8（分岐 B の仮仕訳）、§5.1 の分岐 A/B/C、P5（MF の本番事業者で PoC）、P10（MF の自動仕訳ルール CSV） | 削除 |
| 削除（自然言語をやめた） | U10・P4（明細の自然言語コマンド）、Y7〜Y10（ChatGPT のプラン・学習オフ・Gemini 予備・Codex のモデル） | 削除。ただし Y8（ChatGPT の学習オフ）は「エージェントに keihi のデータを渡す」場合にも効くので **K3 の注記として残す** |
| 消えた論点 | Q3（5MB 超）: freee は 64MB で縮小不要。税理士 #3 は「加工しない」で運用 | 閉じる |
| 置き換え | Q7 → **Y5**（未決済の取引 → freee で消込）、P3 → Y5 に統合、P1 → **K3**（明細を外部の AI に出すか）、P2 → **P2'**（freee 版: 私用を事業主貸の取引にするか、freee の無視・プライベートにするか）、P6 → K5・K6、P7 → P7'、P8 → 本計画 §1 の順序、Y6（MF の明細を読む）→ 削除（読まない） | 下表 |
| 書き換え | D9（MF の API キー → freee OAuth、T1-10）、D11 → **D11'**（freee の勘定科目に合わせる。T0-4）、D13（向き補正を追加。T0-5）、税理士 #6（MF → freee の解約後の保存。Y12 と同じ） | 下表 |

### 3.2 未決の一覧（「期限」= そのタスクを渡す前に決まっている必要がある）
| # | 内容 | 期限 | 初期値の提案 | 決める人 |
|---|---|---|---|---|
| Y2 | freee のアカウントの有無、テスト事業所を作ってよいか | T0-2'（今） | 作る | ユーザー |
| U7 | Gemini の思考レベル・media_resolution | T2-3 | T0-3r の結果で提案。暫定は low + medium | spec-writer → ユーザー |
| K12 | freee に無い科目（研修費・車両費・会議費など。有無は F3 で確認）を freee で作るか、近い科目に寄せるか | T0-4 | 使う頻度の高いものだけ freee で作る | ユーザー（妥当性は税理士） |
| K13 | 税区分は「Gemini は税率の区分だけ選び、サーバーが freee の税区分コードに変換」でよいか | T0-4 | そうする | ユーザー（課税方式は税理士 #9） |
| D11' | Gemini に見せる科目の一覧（T0-4 の対応表） | T2-1 | 24 件を freee の名前に寄せる | ユーザー |
| D1〜D7・D10・D12・D13 | v0.1 §3.4 のとおり（D4 に MCP 8796 を追加、D7 は mcp.md §6.1 の脅威モデルを追記、D13 に向き補正を追加） | 各タスク | v0.1 の提案 | ユーザー |
| Q4 | オフサイトを B2 にするか | T5-0 | B2（EU）、月約 10 円 [推測] | ユーザー |
| Q6 | 通知 | T5-4 | push なし（帯とバッジ） | ユーザー |
| U8 | AI（またはエージェント）の提案のまま 1 タップ確定を許すか | T2-10・T6-4 | 許す。R10 の項目が同じ画面に出ていること | ユーザー |
| U4' | 按分を 1 枚ごとの取引で分けるか、年末に freee で一括か | T4-1 | 年末一括 | 税理士 → ユーザー |
| Y5 | 連携カードの支払いを「未決済の取引 → freee の画面で消込」で扱う | T4-1 | そうする | 税理士 → ユーザー |
| Y3 | MF の契約の更新日（2026 年分の申告まで繋ぐ） | 2026-12 | 申告まで繋ぎ、その後は無償状態 | ユーザー |
| Y4 | 本番事業所（お試し）でダミーの証憑を 1 枚試すか | 2026-12 | しない | ユーザー |
| Y12 | freee の有償契約を 7 年以上続ける前提でよいか（解約すると取引が見られない） | 契約の前 | 続ける | ユーザー（出力で足りるかは税理士） |
| Y13 | 電子取引の訂正削除防止の規程を freee のテンプレートで 2027-01-01 から備える | 2026-12 | 作る（下書き T5-5） | ユーザー（内容は税理士） |
| Y14 | 75 万円控除（優良電子帳簿）を 2027 年分から狙うか | 2026-12 | 税理士 #7 次第 | 税理士 → ユーザー |
| P2' | 私用の支出（事業用カードでの私用など）を、①事業主貸の取引にするか、②freee の「プライベート」「無視」で処理するか | T6-5 | 帳簿に載っている口座 = ①、それ以外 = ② | 税理士 → ユーザー |
| P7' | 照合の日付の幅（+3 日）、外貨 | T6-5 | +3 日、外貨は要確認 | ユーザー（明細の実際の遅れを見て） |
| P9 | 月の明細の件数、連携する口座・カードの数 | T6-2 | ― | ユーザー |
| K1〜K10 | MCP（transport、繋ぐエージェント、外部 AI に出すデータ、メモの表示、上限、取り消しの期限、監査の保存、再取得、別 uid、freee-mcp） | M6・M7 | mcp.md §9 | ユーザー |
| K11 | M7 の読み取り（T7-1〜T7-3）を G1 の前に前倒ししてよいか | 2026-12 | M5 が 12 月半ばまでに終われば前倒し | ユーザー |
| K14 | keihi 自身が「3 回同じ分類でルールを提案」してよいか（エージェントの提案と重なる） | T6-6 | 提案する（自動では作らない） | ユーザー |
| U3・U4・U5 | 質問カードの上限・按分の既定値・会議費/交際費の基準 | M3 | v0.1 の提案 | ユーザー / 税理士 |

### 3.3 税理士確認（legal.md §6。freee 版に読み替え）
| # | 内容 | 影響 | 回答までの初期運用 |
|---|---|---|---|
| 1 | API で上げたスマホ画像（origin=public_api）がスキャナ保存として有効か | G1、T4-6 | 紙原本を全件保管 |
| 2 | 自作部分のシステム概要書の要否 | T5-5 | 下書きは作る（M7 の工程も入れる） |
| 3 | 撮影後の加工 | ― | 加工しない（freee は 64MB なので縮小不要） |
| 4 | 業務処理サイクル方式 | T1-7 | 7 営業日 |
| 5 | 電子取引の規程 | T5-5 | freee 運用なら必須として作る（Y13） |
| 6 | 解約後 7 年の保存 | 運用 | freee の契約を続ける（Y12） |
| 7 | 75 万円控除 | 運用（2027-01-01 から） | Y14 |
| 8 | 5 年特例か一律 7 年か | T1-3 | 一律 7 年 + 1 年 |
| 9 | 消費税の課税方式 | T0-4・T2-5（税区分の変換） | 登録番号・税率区分・税込額は全件記録（R16） |
| 新 | Y5・P2'・U4' | T4-1・T6-5 | 上表の初期値 |

---

## 4. 構成・テスト・シークレット・systemd

### 4.1 ディレクトリ構成案（v0.1 から変更した部分）
```
src/
  providers/     types.ts  fake/  freee/{auth,client,provider,budget}.ts      (mf/ は作らない)
  ai/            gemini/{client,derive,prompt,schema}.ts  validate.ts
  proposals/     model.ts  stateMachine.ts  executor.ts  undo.ts             (M6)
  bank/          sync.ts  match.ts  rules.ts                                   (M6)
  mcp/           server.ts  auth.ts  tools/{read,propose}.ts  sanitize.ts      (M7)
  worker/        handlers/{uploadReceipt,updateReceiptMeta,extract,send,reconcile,daily,executeProposalItem,syncBank}.ts
  catalog/       keihi.catalog.v1.schema.json  keihi.catalog.v1_1.schema.json
test/            contracts/freee-openapi.json  fixtures/{receipts,injection-strings.json}  mocks/{gemini,freee}/
tools/           fixtures/gen-receipts.ts ✔  poc/{gemini-poc ✔, freee-auth, freee-poc}.ts  update-holidays.ts
実行時データ（リポジトリ外）:
  ~/.local/share/keihi/  keihi.db  objects/  snapshots/  drill/  freee-token.json (0600)  freee-token.lock
  ~/.config/keihi/       config.toml  secrets.env (0600)  mcp/<client>.env (0600、M7)
```

### 4.2 テスト方針（v0.1 + 追加）
- 外部 API は全てモック（freee は fake + 固定した OpenAPI の契約テスト、Gemini は固定 JSON）。テスト中に外部への通信が起きたら失敗。
- 実在の領収書・個人情報は使わない（T0-1 の生成器のみ）。命令文の文字列は `test/fixtures/injection-strings.json`。
- MCP は SDK の Client を `app.request()` 相当の in-process fetch に繋いで試す（ポートを開かない）。
- curl の確認手順（各 PR で 1 回）: `ss -ltnp | grep -E '879[56]'` で空きを確認 → 起動 → `curl -s -H 'Tailscale-User-Login: <許可ユーザー>' http://127.0.0.1:8795/api/status`（M7 以降は 8796 の `/mcp` に `tools/list` も）→ **止めてポートの解放を確認**。
- 実 API を叩くのは T0-2'（テスト事業所）・T0-3r（ダミー画像）・F15（本番の読み取りのみ）・G1 のスモークテストだけ。

### 4.3 シークレット管理
| シークレット | 置き場所 | 備考 |
|---|---|---|
| freee の client_id / client_secret | `~/.config/keihi/secrets.env`（0600） | アプリストアで再発行できる |
| freee のアクセス/リフレッシュトークン | `~/.local/share/keihi/freee-token.json`（0600） | 1 回限りの更新。flock で排他。バックアップに**含めない**（復元時は再認可） |
| Gemini API キー | secrets.env | 有料 tier の専用プロジェクトのみ |
| restic パスワード | secrets.env + パスワードマネージャ | 紛失すると復元不能 |
| B2 アプリケーションキー | secrets.env | バケット限定 |
| MCP のクライアントトークン | DB には sha256 のみ。平文は `~/.config/keihi/mcp/<client>.env`（0600） | M7。失効は CLI |
- 同じ uid のエージェントはこれらを読める（D7、mcp.md §6.1）。Claude Code の permissions で `~/.config/keihi/**` と `~/.local/share/keihi/**` の Read を deny する手順を docs/ops に書く。

### 4.4 systemd --user unit（v0.1 と同じ + 変更）
| unit | 変更 |
|---|---|
| keihi-web.service | リスナーが 2 つ（8795、M7 から 8796）。MemoryMax=256M のまま |
| keihi-daily.service / .timer | freee のトークンの更新（残り 30 日）、マスタ同期、取引の照合、検索項目の期限チェック、証憑の sha256 照合（月 1 回）を enqueue |
| keihi-bank-sync.timer（M6） | 6 時間ごとに明細の同期を enqueue → worker |
- 他プロジェクトの unit に触れない。unit 名は `keihi-` で統一。

---

## 5. リスクと PoC で変わる分岐

### 5.1 F10〜F12 の結果による M6 の分岐（v0.1 §5.1 の MF の分岐を置換）
| 結果 | M6 の変更 |
|---|---|
| F11 で「未決済の取引 + 同額の明細」を freee の自動で経理が消込の候補に出す | 推薦の流れ（領収書 → 未決済の取引 → freee で消込）のまま |
| F11 で候補に出ない | 連携カードの支払いは「決済済みの取引（payments に口座）」で作る案を F10 で検証。明細と二重にならないかが鍵。だめなら「明細起点で、本人が freee で取引を登録 → keihi は証憑を後から紐付け」に寄せる（T6-5 の一覧を主役にする） |
| F12 で API で作った明細にルールが当たらない | 本番の同期の明細でしか確かめられない → F15 の後に、本人の明細で 1 件だけルールを作って試す（読み取り以外の操作になるので本人の承認が要る） |

### 5.2 その他のリスク
| リスク | 影響 | 対策 |
|---|---|---|
| freee のリフレッシュトークンが失効（90 日、または競合で無効） | 即アップロードが止まる | flock の排他、日次の更新、失効時は PWA の帯と再認可の CLI（T1-10）。期限の 2 営業日前の警告（T1-11） |
| 1 日 3,000 回を超えて 403、10 分止まる | 期限内のアップロードが遅れる | 用途別の予算と予約枠（T1-15）。MCP はキャッシュだけを読む |
| 消込の API が一般ユーザーに来ない | 明細の処理が freee の画面に残る | 推薦の流れで月数分 [推測]。spec-writer が月 1 回 freee の更新情報を確認 |
| テスト事業所で個人を選べない | 個人特有の点が PoC で見えない | F15（本番お試し）で読み取りを確認 |
| お試しのファイルボックスは月 15 枚 | 2027 年 1 月に止まる | 2027-01-01 より前に有償契約（freee-codex.md §2.3） |
| freee を解約すると取引が見られない | 7 年の保存 | 契約を続ける（Y12） |
| freee の JIIMA スキャナ保存認証の期限 2027-10-15 | 認証の空白 | 2027-10 に一覧を確認 |
| エージェントがインジェクションで操られる | おかしな提案、データの持ち出し | 提案しか作れない・上限・本人の確定・最小化（mcp.md §6） |
| 同じ uid のエージェントが秘密を読める | freee を直接叩かれる | permissions の deny（事故防止）。本当に止めるなら別 uid（K9） |
| MCP 仕様の改訂（2026-07-28 で大きく変わった） | SDK の更新に追従 | v2 SDK の範囲で使い、独自の拡張に頼らない。v1 は 2027-01 頃まで修正のみ |
| Gemini 3.8 Flash の料金が 2027-01-01 に倍 | 月 120 → 240 円 [推測] | 許容。設定値で Flash-Lite に替えられる |
| iOS の HEIC・EXIF 位置情報 | 受け付け不可・情報漏れ | accept で JPEG、F14、端末側で位置情報を付けない（D13） |
| restic が Object Lock 下で lock を消せない | バックアップ失敗 | T5-0 の PoC（v0.1 と同じ） |
| ディスク空き 26GB | 7 年で 20GB 程度 [推測] | snapshots は直近 7 日分だけ手元に |

---

## 6. 決定事項と未決事項のまとめ

**決定済み（ユーザー回答）**: サーバー + PWA（両 OS）/ **freee スタンダード（帳簿は 2027-01-01 から、PoC はテスト事業所）**/ MF の Provider は MVP 外 / Gemini 3.8 Flash 有料 tier（Kev なし）/ B 案（自由文相談なし）/ AI ログ 7 年 / 即アップロード + 自前の追記専用保管 + restic / SQLite / ワンショット worker / **keihi 内の自然言語なし** / **エージェントは keihi の MCP（127.0.0.1）から読み取りと提案、確定は PWA で本人、freee への書き込みは keihi だけ**。

**今すぐ（M0）**: Y2、T0-3r のキー配置（ユーザー）。
**M1 の前**: D1〜D4・D7・D10、テスト事業所での F1・F2・F4・F7・F14 の結果。
**M2 の前**: K12・K13・D11'（T0-4）、U7（T0-3r）、U8。
**M4 の前**: Y5・U4'（税理士 → ユーザー）。
**2026-12（G1 の前）**: Y3・Y4・Y12・Y13・Y14・Q4・Q6・K10・K11、F15、有償契約、税理士 #1・#4。
**M6 の前**: P2'・P7'・P9・K4・K5・K6・K14、F10〜F12 の結論。
**M7 の前**: K1・K2・K3・K7・K8。
**M3 の前**: U3・U4・U5。
**MVP 後**: Q5（IMAP）、K9（別 uid）、U9（A2UI v1.0 の再評価）、Gemini による明細の分類（旧 transactions.md T6-6）、消込 API が来たら明細 1 件の確定。

## 出典（追加分。既存は各ドキュメントの出典を参照。取得日 2026-10-17）
- [FR-OA] https://github.com/freee/freee-api-schema （2026-10-15 のコミット。API 使用制限、`GET /wallet_txns`・`GET /deals`・`GET /receipts` の引数、明細の消込・無視のパスが無いこと）
- [FR-AUTH] https://developer.freee.co.jp/reference/認可コード
- [FR-EBOOK] https://support.freee.co.jp/hc/ja/articles/4413886154649
- MCP 仕様 2026-07-28・TypeScript SDK v2・Claude Code / Codex の MCP 設定: mcp.md の出典
- 本機: `git log`（3e1b677・2d7428e）、`tools/poc/gemini-poc.ts` の `ACCOUNTS`・`TAX_IDS`・`JPEG_DROP`、`ls ~/.config/keihi`（無し）、`ss -ltn`、`npm view`
