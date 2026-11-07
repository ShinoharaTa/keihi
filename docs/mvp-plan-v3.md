# keihi 実装計画 v3（P0〜P3 のタスク分解 / 2026-11-06・未承認）

> 2026-11-06 時点: 行頭の「済」は feature/cashflow で実装済み、「進行中」は着手済み。実装の詳細は cashflow.md。T305 は API（`/api/documents/counts` の upcoming）まで済で、バッジの表示は T111 に含む。マイグレーションは 0006_cashflow（0006_mcp を後回しにしたので繰り上げ）。

正本は requirements-v2.md（C1〜C13・R-A〜R-D・V1〜V8）。本書はそれを implementer に渡せる粒度に分ける。旧計画 mvp-plan.md（v0.2）の M0〜M5 は実装済み（current-system.md）で、M6・M7 は本書の P1・P2 で置き換える。
書式は mvp-plan.md と同じ: **内容 / 触る / 受け入れ / 依存 / 残る判断**。「残る判断」が「なし」以外のタスクは、§6 の該当項目が決まるまで渡さない。
表記: **[事実]** コード・docs で確認 / **[推測]** 見積もり・解釈 / **[要PoC]** 叩くまで不明 / **[要確認]** ユーザーから資料が要る。
タスク番号: P0 は T0xx、P1 は T1xx、P2 は T2xx、P3 は T3xx（旧計画の T1-1 などとは別の番号）。

## 0. 何のために
口座・カード・PayPay の明細を 1 か所（ローカル SQLite）に集めて資金の流れを見える化し、3 年先までの大きな支出から「月末に残す額」を出す。経費は領収書付きで freee に預け、その操作を self agent が MCP から行えるようにする（requirements-v2 §1）。

## 1. コードで確認した足場 [事実]
- Provider に `listBankTxns`（`GET /api/1/wallet_txns`、limit 100 のページング）、`listRules` / `createRule` / `deleteRule`（`user_matchers`、act = 無視 4 / プライベート推測 11 / 取引推測 0）がある。どのハンドラからも呼ばれていない（`src/providers/freee/provider.ts:399-447`）。
- `BankTxn` の型は id・口座種別・口座 ID・日付・金額・入出金・摘要だけ。**残高・status・due_amount は持っていない**（`src/providers/types.ts`）。`CreateRuleInput` は口座種別しか指定できず、口座 ID は渡せない。
- ジョブの種類は 6 つで固定の union（`src/jobs/queue.ts:12`）。マイグレーションは 0001〜0004。PWA のタブは 4 つ（`pwa/src/main.tsx:17`）。`[mcp] port=8796` は予約されているだけ。
- 監査の actor は確定時に `'user'` 固定（`src/review/confirm.ts:294`）。field_sources の `agent` は予約されているだけ。
- **旧 mcp.md §3.3・§4.6（MCP から確定させない、取り込みは PWA だけ）は C9 で覆った。** P2 では提案の状態機械を作らず、MCP から既存の確定処理を直接呼ぶ。

## 2. 工数の目安 [推測]
| P | 中身 | implementer | ユーザー | 目安の時期 |
|---|---|---|---|---|
| P0 | 実 API の PoC、V1 の確認、穴の修正 | 2〜2.5 日 | 3〜4 時間 | 11 月中 |
| P1 | 明細の取り込み（API + CSV）・重複排除・振替・タグ・明細一覧・月次集計 | 9〜11 日 | 2 時間 | 12 月（G1 = 2027-01-01 の前） |
| P2 | MCP と、明細と領収書の照合 | 6〜7 日 | 1 時間 | 2027-01 |
| P3 | 予定支出・周期検出・資金繰り表・通知（税額の概算は別枠で +2 日） | 5〜6 日 | 1 時間 | 2027-02 |
外部サービスは増やさない（MCP SDK は npm の依存が増えるだけ）。追加の運用費は 0 円。freee の 1 日 3,000 回の枠は、明細の同期に既存の `sync` 枠（300 回/日）を使う。

---

## 3. P0: 残っている PoC と穴の修正

**T001 Gemini の実 API PoC（旧 T0-3r）** — ユーザー手作業 + 実行
- ユーザー: keihi 専用の GCP プロジェクトで有料 API キーを発行し、`~/.config/keihi/secrets.env`（0600）に `GEMINI_API_KEY` を置く。`[gemini] paid_tier_confirmed = true` にする。
- implementer: `tools/poc/gemini-poc.ts` をダミー領収書 30 枚に対して実行し、`poc/gemini-results.csv` と要約（4 条件の一致率・トークン数・1 枚あたりの円）を作る。
- 受け入れ: 30 枚すべての結果がスキーマ検証を通る。命令文入りの画像でも enum の外の値が出ない。要約がある。依存: キーの配置。残る判断: U7（結果を見て spec-writer が提案する）。

**T002 freee の実 API PoC（旧 T0-2'）** — ユーザー手作業 + 実行
- ユーザー: プライベートアプリを登録して client_id / secret を secrets.env に置く。`keihi freee auth` で認可する（C10 により本番事業所でよい）。
- implementer: `tools/poc/freee-poc.ts` に F1〜F14・F16 を実装して実行する。書き込みは `[freee] target` の事業所 ID と一致するときだけ行い、作ったものは `poc/freee-created.jsonl` に残す。後片付けのスクリプトで逆順に消す。結果は `poc/freee-results.md`。
- 受け入れ: F1〜F14・F16 の結果が表になっている。後片付けを実行したあと、keihi が作った取引・証憑・ルールが 0 件になる。依存: アプリ登録。残る判断: なし。

**T003 V1・F17・F18 の確認（明細の PoC）** — ユーザー手作業 + implementer
- ユーザー: 私用を含む全口座・カードを freee に連携する（C2）。
- implementer: `tools/poc/freee-bank-poc.ts`（読み取りが中心）で次を確かめ、`poc/freee-bank-results.md` に**形式と件数だけ**を書く（摘要の中身は書かない）。
  - V1: 連携できた口座の数。口座ごとに `wallet_txns` の最も古い日付。`balance` 列があるか、`walletables?with_balance=true` の残高。status の分布。
  - F17: 私用口座の明細を freee 上で処理済みにする方法。(a) 口座を指定し、どの摘要にも当たる `user_matchers` act=4 が作れて実際に当たるか、(b) freee の口座設定に「プライベート用」に当たる機能があるか。
  - F18: カードの明細の日付（利用日か計上日か）と、速報値が後から変わるか。
- 受け入れ: 3 項目の結論が書いてある。作ったルールは後片付けで消す。依存: T002。残る判断: なし（結果は V9・V12 の判断材料になる）。

**T004 同等確認（integrity_checked_at）を記録する**（current-system §8）
- 内容: スキャン（kind=scan）の確認カードに「欠け・折れ・裏面を確認した」のチェックを置く（legal R9）。approve の要求に `integrity_checked: true` があれば、同じトランザクションで `documents.integrity_checked_at` を今の時刻にする（一度入れたら変えない）。監査のアクションは `document.integrity_checked`。
- 触る: `src/review/card.ts`、`src/review/confirm.ts`、`src/web/routes/review.ts`、`pwa/src/review/*`、`test/unit/confirm*.test.ts`
- 受け入れ: チェック付きの approve で時刻が入る。チェックなしなら NULL のまま。2 回目は上書きしない。e_transaction では無視する。期限内アップロード済み + paper_discard_allowed=1 のとき paper.ts が discard_ok を返す。依存: なし。残る判断: なし。

**T005 retention を使う**: 文書ごとに `retain_until`（`[retention]` から計算）を出す関数を作り、`mapping.csv` に列を足す。`/api/status` には最も早い retain_until を出す。保持期間内の削除を拒む処理は今は無いので、「削除の経路が無いこと」をテストで固定する（DELETE 文を grep するテスト）。触る: `src/deals/export.ts`、`src/web/routes/status.ts`、新規 `src/retention.ts`。受け入れ: 年度をまたぐ境界（`next_year_0316`）の表駆動テスト。残る判断: 税理士 #8（年数。値は設定にあるので実装は止まらない）。

**T006 運用文書とコメントの食い違い**: docs/ops/systemd.md に daily・backup・drill の unit と timer を足す。`/api/status` に `freee_reauth_required` を足し、PWA に再認可の帯を出す（daily のコメントに書いてある約束）。`stateMachine.ts:139` の存在しないパスのコメントを直す。受け入れ: status の API テスト、帯の SSR テスト。残る判断: なし。

---

## 4. P1: 明細の取り込み（R-A）と可視化（R-B の一部）

済 **T101 Provider の明細型を広げる**: `BankTxn` に `balance?: number`・`status: 1|2|3|4|6`・`dueAmount`・`ruleMatched` を足す。`ListBankTxnsQuery` に limit/offset を、`CreateRuleInput` に `walletableId` と `action: 'private_register'`（act=12）を足す。fake provider と契約テストも直す。触る: `src/providers/types.ts`、`freee/provider.ts`、`fake/index.ts`、`test/contracts/*`。受け入れ: 契約テストが OpenAPI に合う。fake のページングが 100 件ずつ。依存: T003（balance があるか）。残る判断: なし。

済 **T102 マイグレーション 0005_bank**（§7 の表）とリポジトリ層 `src/bank/repo.ts`。受け入れ: 空の DB と 0004 の DB の両方から上がる。追記専用の表に UPDATE / DELETE するとトリガーでエラーになる（0001 の audit_log と同じやり方）。依存: なし。残る判断: なし。

済 **T103 口座（money_accounts）の管理**: マスタ同期のたびに freee の walletable ごとに 1 行を作る（既にあれば名前だけ更新）。CSV だけの口座（PayPay 残高など）は API で作る。`default_tag` の初期値は `unset`、`mcp_visibility` は `summary`。API は `GET/POST /api/accounts`、`PATCH /api/accounts/:id`（設定の変更は監査に残す）。触る: `src/bank/accounts.ts`、`src/masters/sync.ts`、`src/web/routes/bank.ts`、`src/web/app.ts`。受け入れ: 同期を 2 回しても行が増えない。PATCH が監査に出る。残る判断: なし。

済 **T104 明細の同期ジョブ `sync_bank`**: JobKind に足す。daily の中で 1 件積む。PWA の「今すぐ同期」でも積むが、前回から 10 分以内なら積まない。口座ごとに `max(前回の最新日 − 35 日, backfill_from)` から今日までを取る。初めての口座は 3 か月ずつさかのぼり、1 回の実行で 1 区間だけ進める（`sync_status.backfill_done_until`）。外部 ID（walletable_id + wallet_txn id）で upsert し、変わってよいのは freee_status・due_amount・last_seen_at だけ。残高は `account_balances` に追記する。予算の用途は `sync`。触る: `src/bank/sync.ts`、`src/worker/handlers/syncBank.ts`、`src/worker/handlers/daily.ts`、`src/jobs/queue.ts`。受け入れ: 同じ明細を 2 回取っても 1 行。status の変化が監査に残る。予算の残りが 500 を切ったら途中で止め、次回に続きから取る。invalid_grant では延期する。依存: T101・T102。残る判断: V8（`[bank] backfill_from` の値）。

**T105 CSV インポーターの枠と PayPay パーサー**: `src/bank/csv/index.ts` に `Parser = { id, detect(head), parse(text) → ParsedRow[] }` を定める。文字コードは BOM で判定し、無ければ UTF-8 として読んで失敗したら Shift_JIS（TextDecoder）で読む。原本の CSV は objects に sha256 で置く。同じファイルを 2 回入れたら 409。`POST /api/accounts/:id/import`（multipart、上限 5MB）は 1 トランザクションで `csv_imports`・`bank_txns`・`bank_txn_sources` を書く。パーサーは `src/bank/csv/paypay.ts`。列は【要確認】で、想定は「取引日・出金金額・入金金額・取引内容・取引先・取引方法・取引番号」。取引番号を外部 ID にする。受け入れ: ユーザーが用意した伏せ字のサンプルから作る fixture で、件数・金額・符号が一致する。同じ行を重ねて入れても増えない。壊れた行はその行番号と理由を返し、ほかの行は入る（`rows_error`）。依存: T102、PayPay CSV のサンプル（ユーザー）。残る判断: V3（P1 は PWA からのアップロードだけ。MCP は T204）。

済 **T106 重複排除（API と CSV が同じ口座）**: 次の順に照合し、どれにも当たらなければ新しい明細にする。(1) 同じ source・同じ外部 ID → 同じ明細。(2) source が違い、同じ口座・同じ日付・同じ金額・同じ入出金の候補がちょうど 1 件 → `bank_txn_sources` に足すだけ。(3) 候補が複数 → 同じ日の中の出現順で 1 対 1 に組み、組めなかった分を「重複の疑い」にする。日付の幅は `[bank] dedup_date_window_days`（既定 0）。触る: `src/bank/dedup.ts`。受け入れ: 表駆動で、同額・同日に 2 件あるケース、片側だけに存在するケース、幅を 1 日にしたケースを確かめる。依存: T104・T105。残る判断: なし（F18 の結果でカードの既定の幅を見直す）。

済 **T107 口座間振替の検出**: 自分の口座 A の出金と口座 B の入金が、同じ金額で日付差 0〜3 日、かつ 1 対 1 → `transfer_links`（kind=transfer、source=auto）。カードの引き落としは、口座設定 `card_settlement_account_id` + 摘要のパターンに当たる出金を kind=card_settlement にする（カードの利用分を数え、引き落としは集計から除く）。PayPay のチャージは kind=charge。人が外したら state=rejected の行を足し、次回からは同じ組を作らない。触る: `src/bank/transfers.ts`。受け入れ: 表駆動で、ちょうど 1 対 1、候補が 2 件（作らない）、外した組を作り直さない、を確かめる。依存: T106。残る判断: なし。

済 **T108 事業/私用タグとカテゴリ**: 効くタグは「明細の上書き（txn_tags の最新版）> keihi のルール（tag_rules）> 口座の既定」の順で決める（V5）。カテゴリは固定 12 種（食費・日用品・交通・通信・住居・水道光熱・保険・税金・車・娯楽・医療・その他）+ 未分類。人が上書きしたら版を追記する。同じ口座・同じ正規化摘要で 3 回同じ上書きが続いたら tag_rules を作る（origin=learned）。正規化は取引先辞書の正規化を使う。触る: `src/bank/tags.ts`、`src/vendors/normalize*`、`src/web/routes/bank.ts`（`POST /api/bank_txns/:id/tag`）。受け入れ: 順の表駆動テスト、3 回目でルールが 1 件だけできる。依存: T102。残る判断: V5・V10（カテゴリの一覧）。

**T109 私用明細を freee 側で処理済みにする**: F17 の結果によって分かれる。(a) 口座単位のルールが当たる場合: default_tag=private の口座に act=4（無視を登録）のルールを 1 本作り、`freee_rule_links` に記録する。(b) 当たらない場合: 「freee の画面で処理が要る明細」の一覧（`GET /api/bank_txns?freee_action=needed`）だけを出す。事業口座の中の私用の明細は、明細 1 件を無視する API が無い [事実: freee-codex §1-3] ので、同じ一覧に出す。T108 のルールを「freee にも反映」にしたときは act=12（プライベートを登録）を作る。触る: `src/bank/freeeRules.ts`。受け入れ: fake でルールが 1 口座 1 本だけ作られる。default_tag を private から外したら `deleteRule` を呼ぶ。作るのも消すのも監査に残る。依存: T003・T101・T108。残る判断: **V12**（事業口座の私用を act=12 にするか act=4 にするか）。

済 **T110 明細一覧と月次集計の API**: `GET /api/bank_txns`（期間・口座・タグ・カテゴリ・金額の範囲・摘要の部分一致・cursor。上限 100）、`GET /api/summary/monthly?month=YYYY-MM`（口座別・カテゴリ別・事業/私用別の収入・支出・差額。振替・引き落とし・チャージは除き、除いた額は別の行に出す）、`GET /api/bank/status`（口座ごとの最終同期・最終 CSV・エラー。A5）。`/api/status` にも要約を足す。触る: `src/bank/summary.ts`、`src/web/routes/bank.ts`。受け入れ: fixture の明細 50 件で、集計の合計 = 振替を除いた明細の合計。cursor で重複も抜けも起きない。依存: T106〜T108。残る判断: なし。

進行中 **T111 PWA の「お金」タブ**: タブを 1 つ足し、中を「明細」「月次」「口座」の切り替えにする（タブは 5 つまで）。明細は無限スクロールで、行をタップするとタグ・カテゴリを変えられる。月次は表で出す（グラフは P4）。口座は既定タグ・MCP の公開範囲・CSV の取り込み・同期の状態。触る: `pwa/src/main.tsx`、新規 `pwa/src/money/*.tsx`。受け入れ: 各画面の SSR スナップショット。CSV の結果（新規・統合・エラーの件数）を表示する。**[ユーザー確認]** スマホで月次の表が横にはみ出さない。依存: T110。残る判断: V7（ux-reviewer。既定は本タスクの形）。

---

## 5. P2: MCP（R-C）と明細⇔領収書の照合

**T201 マイグレーション 0006_mcp と MCP のリスナー**: `@modelcontextprotocol/server` 2.3.x + `@modelcontextprotocol/hono` で、keihi-web の中に `127.0.0.1:8796/mcp` を立てる（K1 = 案 A）。Host の検査、Origin・Tailscale 系のヘッダがあれば拒否、ベアラートークン（`mcp_clients` には sha256 だけ保存）、scope によって `tools/list` を出し分ける。CLI に `keihi mcp token create|revoke|list` を足す。触る: 新規 `src/mcp/{server,auth}.ts`、`src/web/main.ts`、`src/cli/keihi.ts`、`package.json`。受け入れ: Host 違い・Origin あり・トークンなし・失効済み・scope 外が 403/401（`app.request()` で確かめる）。SDK の Client で `tools/list` が取れる。バインド先が loopback 以外なら起動しない。依存: なし（P1 と並行して進められる）。残る判断: K2。

**T202 監査に実行主体を残す**: actor を `user`（PWA）/ `agent:<client>`（MCP）にする。MCP から確定したときは field_sources で値を変えた項目を `agent` にする。ツールの呼び出しはすべて `mcp.call`（ツール名・引数の sha256・件数・結果）として記録する。触る: `src/review/confirm.ts`（actor を引数にする）、`src/review/attention.ts`、`src/audit.ts`、`src/mcp/audit.ts`。受け入れ: PWA と MCP で同じ確定をしたとき、actor と field_sources だけが違う。トークンの文字列が監査に入らない（文字列で検査するテスト）。依存: T201。残る判断: K7（保存期間）。

**T203 書くツール**: `ingest_receipt {path, kind, received_on?, no_ai?}` は `[mcp] inbox_dir` の中のファイルだけを受け付ける（realpath で確かめ、symlink で外に出るものは拒否）。中は既存の取り込み処理を呼ぶ。LLM は大きなファイルを base64 で書き出せないので、パスで渡す。`get_card {document_id}`。`confirm_document {document_id, decision, card_version, overrides?}` は PWA の確定と同じ関数を呼び、card_version が古ければ 409。`resolve_attention {id, action}`。`set_txn_tag {bank_txn_id, tag, category?}`。触る: `src/mcp/tools/write.ts`。受け入れ: inbox の外・symlink・サイズ超過を拒否する。確定のあとジョブが PWA の確定と同じように積まれる。レート上限（既定 60 回/時/クライアント）で 429 に当たるエラーを返す。依存: T201・T202。残る判断: **V13**（MCP からの確定に金額の上限を設けるか）。

**T204 CSV を MCP から渡す**: `import_statement_csv {path, account_id}`。T105 の処理を、inbox_dir の制限付きで呼ぶ。受け入れ: PWA から入れたときと結果が同じ。同じファイルは 409。依存: T105・T203。残る判断: V3。

**T205 読むツールと公開範囲（V2）**: `get_overview`・`list_documents`・`list_attention`・`list_bank_txns`・`get_monthly_summary`・`get_cashflow`（P3 まではツール自体を出さない）・`list_upcoming`（P3）・`list_receipt_missing`（T207）。口座の `mcp_visibility` が full なら行を返し、summary なら月次の合計だけ（行・摘要・残高は返さない）、none なら件数も返さない。第三者が書いた文字列（摘要・取引先名）は `untrusted` の下にだけ置く（mcp.md §6.2）。1 回の結果は 20,000 文字まで、cursor でページングする。触る: `src/mcp/tools/read.ts`、`src/mcp/sanitize.ts`。受け入れ: 公開範囲 3 種の表駆動テスト（summary の口座の摘要が結果のどこにも出ない）、命令文入りの文字列（injection-strings.json）が untrusted の中にだけある。依存: T110・T201。残る判断: **V2**（private の既定を summary にするか、残高を出してよいか）、K3。

**T206 照合のデータ**: `txn_matches` に、領収書（approve 済み）と明細（タグが business の支出）の組の候補を作る。条件は、金額が完全に一致し、領収書の日付 ≤ 明細の日付 ≤ +3 日（設定値）で、取引先の正規化名が似ているかを得点にする（transactions.md §6.2）。お互いに候補が 1 件ずつなら state=auto、それ以外は candidate。人か agent が confirmed / rejected の行を足す。照合は keihi の中だけで記録し、freee の消込は freee の画面に任せる（Y5）。触る: `src/bank/match.ts`、`src/worker/handlers/syncBank.ts`（同期のあとに実行）。受け入れ: 1 対 1 / 1 対 2 / 0 件の表駆動テスト。rejected の組は作り直さない。依存: T104・T108。残る判断: **V14**（1 対 1 を自動で照合済みにしてよいか）、P7'（日付の幅）。

**T207 領収書待ちの一覧（C3・C8）**: タグが business の支出で、照合済みの領収書が無いものを「領収書待ち」とし、経過日数の順に並べる。PWA の確認タブに 3 つ目の切り替えとして出し、MCP には `list_receipt_missing` で出す。明細から経費は作らない（C8）。触る: `src/bank/match.ts`、`src/web/routes/bank.ts`、`pwa/src/review/*`。受け入れ: 照合したら一覧から消える。私用タグにしたら消える。依存: T206。残る判断: なし。

**T208 クライアントの設定手順**: `docs/ops/mcp-clients.md` を書く（Claude Code / Codex の設定、トークンを置く場所、`~/.config/keihi/**` の Read を deny する設定）。**[ユーザー確認]** エージェントから領収書を投入し、確定し、freee に取引が入るまでを一周させる。依存: T203・T205。残る判断: なし。

---

## 6. P3: 将来の資金の動き（R-D）

済 **T301 マイグレーション 0007_cashflow と予定支出の台帳**: `scheduled_items` の CRUD（API と PWA の「お金」タブの中の「予定」）。周期は once / monthly / bimonthly / yearly / biennial。変更は監査に残す。触る: 新規 `src/cashflow/schedule.ts`、`src/web/routes/cashflow.ts`、`pwa/src/money/Schedule.tsx`。受け入れ: 周期ごとの「次の期日」の計算を表駆動で確かめる（月末日・2 月 29 日を含む）。依存: T102。残る判断: なし。

済 **T302 周期の検出（C11）**: 同じ口座・同じ正規化摘要の支出で、金額の差が ±5% 以内のものを次の条件で拾う。毎月は間隔 28〜31 日が 3 回以上、隔月は 58〜62 日が 3 回以上、毎年は 350〜380 日が 2 回以上、隔年は 715〜745 日が 2 回以上。拾ったものを `recurrence_candidates`（open）にする。人が受け入れると台帳に入る。dismissed にしたものは同じ条件では出さない。去年の税・保険の納付もここで拾う（C12 の段階 1）。触る: `src/cashflow/detect.ts`。受け入れ: 合成した 24 か月の明細で、毎月 2 本・毎年 1 本・ノイズ（1 回だけ）を正しく分ける。依存: T110・T301。残る判断: なし。

済 **T303 資金繰り表（36 か月）**: 起点は `include_in_cashflow=1` の口座の最新残高の合計。残高が取れない口座（CSV だけ）は手で入れた残高を使う。月ごとに「予定収入 − 予定支出 − 予定外の支出の目安」を足し引きして月末残高を推定する。予定外の支出の目安は、直近 6 か月の「振替と予定項目を除いた純支出」の中央値。「月末に残す額」は、今後 3 か月の予定支出の合計（設定で変えられる）。API は `GET /api/cashflow`、MCP は `get_cashflow`。触る: `src/cashflow/forecast.ts`。受け入れ: 手計算した fixture と 36 か月分が一致する。残高の日付が 7 日より古い口座があれば警告を出す。依存: T104・T301。残る判断: **V11**（予定外の支出の目安の出し方、残す額の定義）。

進行中 **T304 PWA の資金繰り表**: 縦に 36 行（月・推定残高・予定の内訳）を並べ、横にはスクロールさせない。触る: `pwa/src/money/Cashflow.tsx`。受け入れ: SSR スナップショット。**[ユーザー確認]** スマホで読める。依存: T303。残る判断: V7。

済 **T305 期日通知（V4）**: 期日の N 日前（既定 14 日、項目ごとに変えられる）から、PWA の「お金」タブにバッジを付け、`/api/documents/counts` に `upcoming` を足す。MCP の `list_upcoming` は今後 30 日を返す。プッシュ通知はしない。触る: `src/cashflow/upcoming.ts`、`pwa/src/main.tsx`。受け入れ: 境界日（N 日前ちょうど・期日の当日・期日の翌日）のテスト。依存: T301。残る判断: V4。

**T306 税額の概算（C12 の段階 2・別枠）**: **実装済み（PR1。docs/cashflow.md §14。消費税・PWA の画面は残り）**。 今年の freee の損益（keihi で確定した経費 + 手で入れた売上）から、所得税・住民税・国保・個人事業税を概算し、T303 に予定項目（origin=estimate）として流す。触る: `src/cashflow/tax.ts`。受け入れ: 年度の税率表を fixture にした表駆動テスト。依存: T303、税理士 #7・#9。残る判断: **V15**（概算に使う控除・国保の自治体の料率を誰が入れるか）。T303 が動いてから着手する。

---

## 7. 新しいテーブル（マイグレーション 0005〜0007）
| マイグレーション | テーブル | 主な列 | 書き方 |
|---|---|---|---|
| 0005_bank | money_accounts | id, name, kind(bank/card/wallet/paypay/cash), source(freee/csv), freee_walletable_id UNIQUE NULL, default_tag(unset/business/private), mcp_visibility(full/summary/none), include_in_cashflow, card_settlement_account_id, card_settlement_pattern | 設定の列だけ更新（監査に残す） |
| | bank_txns | id, account_id, txn_date, amount, side, description, description_norm, freee_status, due_amount, first_seen_at, last_seen_at | 削除禁止。更新は freee_status・due_amount・last_seen_at だけ |
| | bank_txn_sources | bank_txn_id, source(freee/csv), external_id, csv_import_id, raw_sha256。UNIQUE(account_id, source, external_id) | 追記専用 |
| | csv_imports | id, account_id, parser_id, file_sha256, storage_key, rows_total/new/merged/error, actor, imported_at。UNIQUE(account_id, file_sha256) | 追記専用 |
| | account_balances | account_id, as_of_date, balance, source(freee_walletable/freee_txn/csv/manual), recorded_at | 追記専用 |
| | txn_tags | bank_txn_id, version, tag, category, source(rule/human/agent), actor, decided_at | 追記専用（最新版が有効） |
| | tag_rules | id, account_id NULL, pattern, match(exact/prefix/partial), tag, category, origin(learned/manual), hit_count | 更新可（監査に残す） |
| | transfer_links | id, out_txn_id, in_txn_id, kind(transfer/card_settlement/charge), source(auto/human), state(active/rejected), created_at | 追記専用（最新の行が有効） |
| | sync_status | account_id PK, last_sync_at, last_ok_at, last_error, last_csv_at, backfill_done_until | 更新可 |
| | freee_rule_links | id, account_id, remote_matcher_id, act, state(active/deleted), created_at | 追記専用 |
| 0007_mcp | mcp_clients | id, name, token_sha256, scopes_json, created_at, expires_at, revoked_at, last_used_at | 更新は revoked_at・last_used_at だけ |
| | txn_matches | id, bank_txn_id, document_id, score, features_json, state(auto/candidate/confirmed/rejected), actor, created_at | 追記専用（最新の行が有効） |
| 0006_cashflow | scheduled_items | id, name, amount, direction(in/out), category(tax/insurance/car/other/income), account_id, recurrence, anchor_date, end_date, notify_days_before, origin(manual/detected/estimate), active | 更新可（監査に残す） |
| | recurrence_candidates | id, account_id, description_norm, amount, interval, occurrences_json, state(open/accepted/dismissed), scheduled_item_id | 状態の列だけ更新 |
config.toml に足すセクション: `[bank]`（backfill_from, dedup_date_window_days, transfer_window_days=3, match_date_window_days=3）と、`[mcp]` に inbox_dir・rate_per_hour を足す。

## 8. 渡す前に決まっている必要がある判断
| # | 問い | 初期案 | 決める人 | 止まるタスク |
|---|---|---|---|---|
| ― | PayPay CSV のサンプル（伏せ字のもの）と列の形式 | ユーザーが 1 か月分を出力して伏せる | ユーザー | T105 |
| V8 | 過去の明細をいつから入れるか | 2025-01-01（周期の検出に 2 年分） | **採用（暫定）**: 2026-11-06 初期案のまま実装（ユーザー未承認）。最終はユーザー | T104 |
| V5 | タグの既定を口座単位にし、明細で上書きする | そうする | **採用（暫定）**: 2026-11-06 初期案のまま実装（ユーザー未承認）。最終はユーザー | T108 |
| V10 | カテゴリの一覧（固定 12 種） | T108 のとおり | **採用（暫定）**: 2026-11-06 初期案のまま実装（ユーザー未承認）。最終はユーザー | T108 |
| V12 | 事業口座の中の私用を freee で act=12（プライベート）にするか act=4（無視）にするか | act=12（事業主貸で残高を合わせる） | 税理士 → ユーザー | T109 |
| V9 | 私用口座の処理方法（F17 の (a) か (b) か） | T003 の結果で (a) が使えれば (a) | spec-writer → ユーザー | T109 |
| V7 | PWA に「お金」タブを 1 つ足す形でよいか | よい | **採用（暫定）**: 2026-11-06 初期案のまま実装（ユーザー未承認）。ux-reviewer → ユーザー | T111・T304 |
| K1・K2 | MCP は案 A（HTTP 127.0.0.1:8796）か。繋ぐクライアントと scope | A。Claude Code と Codex、全 scope | ユーザー | T201 |
| V2・K3 | 私用口座の公開範囲の既定と、残高を出すか | summary。残高は合計値だけ出す | ユーザー | T205 |
| V13 | MCP からの確定に金額の上限を設けるか | 50,000 円以上は MCP から確定できず、PWA で確定する | ユーザー | T203 |
| V14 | 1 対 1 の照合を自動で照合済み（auto）にするか | する（keihi の中だけの記録で、取り消せる） | ユーザー | T206 |
| K7 | mcp.call の監査をいつまで残すか | 1 年。確定は 7 + 1 年 | ユーザー | T202 |
| V11 | 予定外の支出の目安、残す額の定義 | 6 か月の中央値、3 か月分の予定支出（月ごと） | **採用（暫定）**: 2026-11-06 初期案のまま実装（ユーザー未承認）。最終はユーザー | T303 |
| V4 | 通知の経路と N 日 | PWA のバッジ・14 日（通知は未実装。MCP は P2） | **採用（暫定）**: 2026-11-06 初期案のまま実装（ユーザー未承認）。最終はユーザー | T305 |
| V15 | 税額の概算に使う料率・控除の入力 | ユーザーが年 1 回、設定に入れる | 税理士 → ユーザー | T306 |
P0 で止まるのはユーザーの手作業（キーの発行、アプリの登録、口座の連携）だけ。Y5・U4'・税理士 #1・#4・#9 は G1 の前に要るが、本書のタスクは止めない。

## 9. 本書の外に残るもの
- mcp.md の改訂（C9 に合わせて §3.3・§4 の提案の状態機械を「MCP から直接確定」に置き換える） → spec-writer。cashflow.md は 2026-11-06 に作成済み。
- P4: 質問カード（M3）、月次のグラフ、明細の分類を Gemini に任せること、消込の API が一般公開されたら明細 1 件ごとに freee で消込・無視すること。
