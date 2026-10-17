# keihi: 入出金明細の振り分けと自然言語コマンド（ドラフト v0.1 / 2026-10-17・未承認）

前提: docs/README.md §2・§3.0、architecture.md §1・§3、a2ui-review-ui.md（B 案、U2 = 自由文相談なし、U6 = AI ログ 7 年）、mvp-plan.md（M0〜M5、§3 未決、§5.1 分岐）、plans-comparison.md（Web 版パーソナルミニ継続）。
表記: **[事実]** 一次情報で確認 / **[推測]** 筆者の解釈・見積もり / **[要PoC]** 実際に叩くまで不明 / **[承認要]** spec-writer の初期値提案。

## 0. 何のために
- MF が銀行・カードから自動取得している入出金明細を、keihi の画面から「経費 / 私用 / 対象外 / 領収書と照合」に振り分けて、MF の帳簿に反映させる。
- 撮影した領収書とカード明細を突き合わせ、**同じ支出を二重に計上しない**（architecture.md Q7）。
- 振り分けの判断を学習し、毎月の手作業を「提案を見て確定するだけ」に減らす。
- MF は帳簿と証憑の保存先のまま使う（ユーザーの本音「freee / MF は保存先、自動化は自分で」と一致）。

---

## 1. 結論（先に読む）

1. **[事実] MF の REST API v3 では、連携サービス（銀行・カード）が自動取得した明細の一覧を取得でき、明細から仕訳を作れる。**
   - `GET /api/v3/transactions` の説明は「連携サービスで収集された明細一覧を取得します」[MF-OA]。2026-07-14 に追加 [MF-RN]。
   - `POST /api/v3/transactions/journalize` で明細 1 件から仕訳を作れる（2026-07-14 追加）[MF-OA][MF-RN]。
   - 仕訳済みかどうかは明細の `journalizing_status`（excluded / none / registered / modified / new_voucher_attached）で判定でき、絞り込みもできる [MF-OA]。
2. **[事実] 「対象外にする」専用の API は無い。自動仕訳ルールの API も無い。**
   - 明細の操作は GET（一覧）、POST（作成）、journalize（仕訳化）の 3 つだけ。PUT / PATCH / DELETE は無い [MF-OA]。
   - ただし `DELETE /journals/{id}` の説明に「明細が紐づく仕訳を削除した場合、その明細の仕訳化ステータスは対象外（excluded）となります」とある [MF-OA]。2022 年の FAQ には「明細は再び『連携サービスから入力』に表示される」とあり、食い違っている [MF-FAQ1] → **[要PoC]**。
   - 対象外を解除して未仕訳に戻す操作は、Web 画面の「明細一覧」の「対象外を解除」だけ [MF-FAQ1][MF-FAQ2]。
   - 自動仕訳ルールは画面で操作するか CSV でインポート / エクスポートする [MF-RULE]。API の定義に rule の語は 1 件も無い [MF-OA]。
3. **[事実] architecture.md の「明細の作成と仕訳化」の正確な意味。**
   - `POST /transactions`（明細の作成）は「**明細を手動管理する連携サービスのみ指定できます**」[MF-RN 2026-07-14]。自動取得した口座に明細を足すことはできない。
   - 一方、読み取り（GET）と仕訳化（journalize）は**自動取得した明細も対象** [MF-OA][MF-RN]。
4. **[事実] MCP は REST の一部しか持っていない。keihi から使う理由は無い。**
   - MCP の操作一覧は次のとおり [MF-MCP]。
     - 仕訳: 一覧 / 取得 / 新規作成 / 更新
     - 明細: 入出金明細の作成 / 明細一覧の取得 / 入出金明細からの仕訳作成
     - 他に試算表・推移表・マスタの取得
   - 次のものが無い: **仕訳の削除（= 取り消しの手段）、証憑、連携サービス一覧**。
   - 認証なしで叩いた 401 応答の scope にも voucher の権限が無い（2026-10-17 筆者確認）。
5. **[事実] MCP の状態と接続方法。**
   - 状態: beta（`https://beta.mcp.developers.biz.moneyforward.com/mcp/ca/v3`、2026-04-01 から）。alpha は廃止予定 [MF-MCP]。
   - 認証は 2 通り。
     - OAuth 2.0: RFC 9728 の protected-resource メタデータがあり、認可サーバーに動的クライアント登録（`/register`）がある（筆者確認）。
     - API キー: `Mf-API-Key` ヘッダ [MF-MCP]。
   - 通信方式（transport）は文書に明記が無い。設定例は `"type": "http"`。POST の JSON-RPC に 401 を返す（筆者確認）ので、[推測] Streamable HTTP。
   - keihi のサーバーから MCP クライアントとして接続することは技術的には可能 [推測・要PoC]。
6. **パーソナルミニで使えるか。**
   - [事実] API・MCP ともに、プランによる制限は support の文書に書かれていない（plans-comparison.md §0）。
   - [事実] 法人向けの MCP 製品ページには「ご利用プランによっては対象外となる場合があります」とある [MF-MCPP]。
   - → **[要PoC]** ミニの API キーで `GET /transactions` が 403 にならないか確かめる。
7. **推薦**
   - **keihi は MCP を使わず REST だけを叩く。** Gemini には**書き込みのツールを一切渡さない**。
   - 自然言語は「明細を絞り込む条件と、振り分け方」の構造化 JSON に変換させるだけにする。
   - 実行は確認カードで人が確定した後、サーバーが行う（§3 案 A）。

---

## 2. 一次情報の詳細

### 2.1 MF REST API v3（OpenAPI、2026-10-17 取得。10-13 取得分とバイト一致）

| 操作 | エンドポイント | 自動取得した明細 | 権限（API キー = 発行者のユーザー権限） |
|---|---|---|---|
| 連携サービスと口座の一覧 | `GET /connected_accounts` | ◎ 口座連携分も返す（2026-07-14 から）。口座ごとに紐づく勘定科目・補助科目 ID を返す。`is_manual` で手動管理か判別できる | データ連携（閲覧） |
| 明細の一覧 | `GET /transactions` | ◎ | 自動で仕訳 > 連携サービスから入力（閲覧） |
| 明細の作成 | `POST /transactions` | ✗ 手動管理の連携サービスのみ。1 回 1,000 件まで | 同（編集） |
| 明細から仕訳を作る | `POST /transactions/journalize` | ◎ | 同（編集）+ 仕訳（編集） |
| 仕訳の削除 | `DELETE /journals/{id}` | 明細側は excluded になる（API の説明による） | 仕訳（編集） |
| 仕訳から明細を引く | `GET /journals?transaction_ids=`（50 件まで）。応答に `transaction_id` が入る | ◎ | 仕訳（閲覧） |
| 証憑を仕訳に付ける | `POST /vouchers {journal_id, files}` | ― 明細には直接付けられない。明細から作った仕訳に付ける | ― |
| 対象外にする / 対象外を解除する | なし | ✗ | ― |
| 自動仕訳ルール | なし | ✗ | ― |

- `GET /transactions` の引数 [MF-OA]
  - 必須: `start_date` / `end_date`（期間は 366 日以内）
  - 絞り込み: `connected_account_id` か `connected_sub_account_id`、`side`（INCOME / EXPENSE）、`value_min` / `value_max`
  - `content` は取引内容で、一致方法を exact / partial / forward / backward から選べる
  - `journalizing_statuses[]`、`order`、`page` / `per_page`（10〜500）
- 明細の項目: `id, date, value（正の整数）, side, content, memo, journalizing_status, connected_account_id, connected_sub_account_id, voucher_file_ids[]`
  - **店名などは `content` の 1 文字列だけ**。カード明細の店名の表記（半角カナや英字）は [要PoC]。
- `journalize` の入力: `transaction_id`、`account_id`（必須）、`sub_account_id`、`tax_id`、`invoice_kind`、`trade_partner_code`、`department_id`、`transaction_date`（省略すると明細の日付）、`tags[]`（各 20 字）、`memo`（200 字）、`remark`（200 字）
  - **相手勘定を 1 つ指定するだけ。複数行の仕訳や按分による分割はできない** [事実: スキーマ]。
  - 反対側は連携口座に紐づく科目になる [推測・要PoC]。
- 冪等性
  - journalize には冪等キーが無い。
  - ただし `transaction_id` が自然な照合キーになる。再送する前に `GET /journals?transaction_ids=[id]` か明細のステータスを確認すれば、二重の仕訳化を避けられる [推測]。
- 操作者の記録: 2026-10-13 から、API キーで「明細からの仕訳作成」や仕訳の削除をすると、操作履歴に**発行者本人**が記録される [MF-RN]。
- 権限を絞れるか
  - API キーは発行者の権限で動く [MF-OA]。ミニはメンバーを追加できない（plans-comparison.md §1.2）ので、**権限を絞った別ユーザーを作れない**。
  - → keihi のキーは仕訳を削除する力まで持つ。**サーバー側の許可リストだけが防御線になる**。
  - OAuth にすれば scope 単位で絞れる。ただし journal.write には削除も含まれる。また操作履歴の操作者はシステムユーザーになる [MF-OA]。

### 2.2 MF の画面側の仕様（参考）
- 「対象外」は「連携サービスから入力」で仕訳の対象から外した明細を指す。解除は「明細一覧」の「対象外を解除」から行う。アプリでは操作できず、Web 版で行う [MF-FAQ1][MF-FAQ2]。
- 自動仕訳ルール [MF-RULE][MF-NEWS]
  - 条件: 明細の内容（完全・前方・後方・部分一致）、明細の種類、連携サービス、税率
  - 結果: 勘定科目・補助科目・部門・取引先・税区分・インボイス・摘要
  - CSV でインポート / エクスポートできる
  - 「対象外にする」ルールがあるかはガイドに記載が無い [要確認]
  - 2026-09-15 から、ルールが適用された仕訳にアイコンが付く

### 2.3 freee（比較用。OpenAPI は 2026-10-13 取得）[FR-OA]

| 操作 | freee | MF |
|---|---|---|
| 自動取得した明細の一覧 | `GET /api/1/wallet_txns`（limit は最大 100） | `GET /transactions`（per_page は最大 500） |
| 状態 | `status`: 1 消込待ち / 2 消込済み / 3 無視 / 4 消込中 / 6 対象外。`due_amount`（未登録の金額）で一部だけ登録した状態も分かる | `journalizing_status` の 5 値 |
| 明細を無視・対象外にする | 明細を直接更新する API は無い。`DELETE /wallet_txns/{id}` は同期で取得した明細には使えない | ✗ |
| 自動登録ルール | ◎ `user_matchers` の CRUD がある。`act` = 4 で無視を登録（auto_ignore）、10 で無視を推測、11 でプライベート取引を推測、12 でプライベート取引を登録 | ✗（画面と CSV のみ） |
| 明細から取引を登録 | 取引（deals）の支払に口座を指定して登録する。明細と自動で消し込まれるかは [要確認] | ◎ journalize（明細 ID を指定） |

- [推測] freee は「ルールを API で作り、無視・プライベートの判定を freee 側に任せる」形にできる。MF より自動化しやすい。ただし移行は年の区切りに限る（plans-comparison.md §4.2）ので、2026 年分は MF 前提で設計する。Provider の抽象化に `listBankTxns / journalizeTxn / undoTxn` を足しておく。

---

## 3. アーキテクチャ案（自然言語の受け口）

| | A: keihi 内で Gemini が「意図 JSON」を返す。MF には REST のみ（MCP は使わない） | B: keihi が MF MCP のクライアントになり、MCP のツールを（絞って）Gemini の function calling に渡す | C: 外部の MCP クライアント（Claude など）から keihi の MCP と MF の MCP を両方使う |
|---|---|---|---|
| 流れ | 自由文 → Gemini（構造化出力: filter・action・科目。**明細の中身は送らない**）→ サーバーがローカルにキャッシュした明細を検索 → 確認カード → 人が確定 → REST | 自由文 → Gemini がツールを呼ぶ（明細一覧など）→ 提案 → カード → 確定 → MCP のツールで書き込み | Claude のチャットで指示 → Claude が MF MCP で直接書き込む。確定するのは Claude 側の許可ダイアログ |
| メリット | 書き込みの経路が AI から物理的に切れている。明細の摘要が LLM に入らないので、プロンプトインジェクションが効かない。REST の方が機能が多い（削除、証憑、連携サービス一覧）。トークン量が少ない | 「MCP で MF に繋ぐ」の字義どおり。ツールの追加に MF が追従してくれる | 自作が最少。対話の体験が良い |
| デメリット | 自然言語で表せる操作は意図スキーマの範囲に限られる（それが安全の源でもある） | beta でツール名とスキーマが非公開。変わりうる。削除と証憑が無いので結局 REST も要る。明細の摘要が LLM のコンテキストに入る。B 案のカード（人の確定）を通すには、MCP の書き込みツールを LLM から隠して自前で呼ぶことになり、A と同じ仕組みが要る | 書き込みが keihi の確認カードと監査ログを通らない。Claude Web / Desktop は API キー非対応（2026-09-24 時点）[MF-MCP]。スマホの Claude から tailnet 内の keihi には届かない。領収書との照合と学習は keihi 側にしか無い |
| 実装コスト [推測] | 中: 2〜3 人日（振り分け機能の本体は別に §6） | 大: 4〜6 人日（MCP クライアント、ツールの選別、ツールのスキーマ変更への追従） | 小: 1〜2 人日（keihi の MCP サーバー）。安全策を足すと大 |
| 運用コスト | Gemini 1 コマンドで約 0.4 円 [推測: 入力 2k・出力 0.3k] | 明細を含むので 1 コマンドで数円 [推測] | Claude の契約（既存なら追加 0）。MF・keihi は 0 |
| 安全性 | ◎ | △ | ✗ |
| 最適度 | ◎ | △ | ✗（ただし読み取り専用の分析用途なら ○） |

**推薦: A。**
- 「MCP で接続」は手段であって目的ではない。目的（自然言語で振り分けて MF に反映）は A で満たせる。
- MF の MCP は REST の部分集合で、keihi が使える独自の機能は無い。
- 将来、keihi 自身を「読み取り専用の MCP サーバー」として Claude Code（このサーバー上）に公開する余地は残す（C の安全な部分だけ。MVP 外）。

### 3.1 案 A の詳細
- **意図スキーマ**（Gemini の構造化出力。function calling は使わない。1 回で返させる）
  ```
  {action: enum[classify_expense, mark_private, mark_exclude, match_receipts, show_unmatched, show],
   filter: {date_from?, date_to?, account_alias?: enum[ユーザーが付けた口座の別名], content_any?: string[] (各≤20字, ≤5個),
            content_match?: enum[partial,forward,exact], side?: enum[EXPENSE,INCOME], amount_min?, amount_max?,
            status?: enum[none,registered,excluded]},
   expense?: {account_id: enum[科目], tax_id?: enum[税区分]},
   save_as_rule: bool,
   clarify?: ChoiceQuestion}   // 曖昧なときは既存の質問部品で聞き返す（最大 1 問）
  ```
- Gemini に送るもの
  - 送る: コマンドの文、今日の日付、科目・税区分の一覧（ID と名前）、口座の**別名**（ユーザーが付ける。例「カードA」）
  - **送らない: 明細の行そのもの**
- サーバー
  1. 意図を再検証する（enum、日付の範囲は 366 日以内、件数）。
  2. ローカルの明細キャッシュに対して実行する。
  3. カードを組み立てる。カードの文言は**サーバーが意図から生成する**（AI の自由文は表示しない）。
- 範囲外の依頼（「これ何費？」など）には固定文で返す。例: 「この画面では明細の振り分けだけできます」。

### 3.2 U2 との関係（整理案）[承認要]
- U2（自由文で AI に相談。AI が文章で答える）は**引き続き MVP に入れない**。
- 新しく **U10「明細の振り分けコマンド」** を立てる。
  - 自由文を受け付けるのは明細画面のコマンド欄だけ。
  - AI の出力は §3.1 の意図スキーマだけで、**AI の文章は画面に出さない**。
  - 書き込みは必ず確認カードを通る。
- 自然言語を使わない経路（絞り込みのチップと一括選択）でも同じことができるようにする。自然言語は便利機能という位置づけ。
- コマンド文は ai_turns に 7 年保存する（U6 に従う）。

---

## 4. 安全設計

### 4.1 書き込みの原則
- Gemini が触れるものは**読み取りすら無い**（案 A では意図を返すだけ）。分類の提案（§4.5）もツールなしの構造化出力。
- MF への書き込みは `txn_ops`（§7）の状態機械からだけ行う。対象は**確定済みのカードに含まれる明細 ID だけ**。サーバーの許可リストは次の 3 つ。
  - `journalize`
  - `POST /vouchers`（照合が確定したときだけ）
  - `DELETE /journals/{id}`（keihi 自身が作った仕訳の取り消しのときだけ。仕訳の tags に照合キー `kh-…` があり、`transaction_id` が一致し、`update_time` が作成時から変わっていないこと）
- これら以外の MF のエンドポイント（PUT journals、POST journals など）は、明細の機能からは呼べないようにコードで分ける。

### 4.2 一括操作の上限 [承認要]
| 項目 | 初期値 | 理由 |
|---|---|---|
| 1 枚のカードに入る明細の数 | 50 | `GET /journals?transaction_ids` の上限が 50 で、事前と事後の確認が 1 回で済む |
| 1 日に書き込む件数 | 200 | 誤操作したときの被害の上限。月に数百件の明細を想定 [推測] |
| 一括に入れない金額 | 1 件 50,000 円以上は 1 件ずつのカード | 高額は個別に見る |
| カードの有効期限 | 24 時間。確定する直前に明細を再取得し、ステータスや金額が変わっていればそのカードを止めて作り直す | MF の画面で並行して操作された場合の対策 |
| 実行の速度 | 1 件ずつ、1 秒間隔（MF の制限は 3 回/秒） | architecture.md §3.2 と同じ |
| 既定のチェック | ルールに一致した明細はオン、AI の提案だけの明細はオフ | 人が見ずに確定するのを防ぐ |

### 4.3 取り消し
| 実行した操作 | 取り消し方 | 制約 |
|---|---|---|
| 仕訳化（経費 / 事業主貸） | `DELETE /journals/{id}` | 明細は excluded になる（API の説明）。未仕訳に戻すには **MF の Web 画面で「対象外を解除」**（API では不可）→ keihi が「MF で解除が要る明細」の一覧を出す [要PoC: P14] |
| 照合して証憑を付けた | 仕訳を削除すると証憑は Box に残る（削除できない）。紐付けを外すには `DELETE /vouchers` | 付け直すには再アップロードが要り、Box の件数（ミニは累計 1,000 件）を消費する → **照合は 1 件ずつ確定し、一括にはしない** |
| 対象外（keihi のローカルの記録だけ） | ローカルの記録を取り消すだけ | MF 側は人が画面で操作する（§5） |
- 取り消しできる期間: 実行後 7 日、かつ確定申告の提出前 [承認要]。それを過ぎたら MF の画面で対応する。
- 取り消しも audit_log に `user.undo` として残す。仕訳の削除は MF の操作履歴にも発行者として記録される [MF-RN]。

### 4.4 プロンプトインジェクション
- 明細の摘要は第三者が書ける。振込依頼人名や EC の請求名は書き換えられる [推測]。
- 対策
  1. コマンドの経路（§3.1）では、摘要を LLM に入れない。
  2. 分類の提案（§4.5）では、摘要を JSON のデータとして渡す。出力はバッチ内の行番号（enum）ごとの {候補科目 enum, private, exclude, unsure} だけ。ツールは渡さない。
  3. 画面は textContent だけで描画する。
  4. 確定前に人が見る。最悪でも「おかしな提案のチェックがオフで出る」ところで止まる。
- テスト: T0-1 のダミーに「摘要に命令文が入った明細」を足す（手動口座に POST で作る。§6 P11）。

### 4.5 AI による分類の提案（ルールで決まらなかった明細だけ）
- 送るもの: 摘要（NFKC に正規化）、金額、支出か収入か、口座の種類（card / bank）、月
- 送らないもの: 口座名・支店名、残高、MF の ID（バッチ内の行番号に置き換える）、MF のメモ、**収入の明細**（MVP では分類しない）
- 送らない設定: 口座ごとの「AI に送らない」フラグ。振込（content が「振込」で始まる、など）は既定で送らない [承認要]。個人名が入りやすいため。
- 費用 [推測]: ルールで決まらない明細が月 100 件、1 件 30 トークン + プロンプト 2k なら、月 1 円未満。

### 4.6 プライバシーとログ
- 入出金明細は**生活全体の支出パターン**が見えるので、領収書より機微。
- Gemini 有料 tier の不正監視ログは 55 日（classification-ocr.md §B）。`store=false` / generateContent を使い、Interactions の履歴は使わない（a2ui-review-ui.md §3.2 と同じ）。
- **55 日ログを明細にも許容するか**は、領収書とは別にユーザーが決める（§9 P1）。
  - 許容しない場合はルールと照合だけで運用し、AI の分類提案は使わない。コマンド（§3.1）は明細を送らないので使える。
- keihi のローカルに置く明細のキャッシュは SQLite に入り、restic で暗号化して B2 に送られる（M5）。保存期間は帳簿と同じ 7 年 + 1 年 [承認要]。

---

## 5. 私用・対象外の扱い（会計上の分岐。税理士に確認）
- [推測] 連携しているカード・口座が**帳簿に載っている**（connected_accounts に勘定科目が紐づいている）場合、私用の支出を「対象外」にすると、カードの引落しや口座の残高が帳簿と合わなくなる。この場合は **「事業主貸 / 未払金（カード）」で仕訳化**するのが通常の処理。
- **事業主貸での仕訳化は journalize で API から完結する。** つまり「経費にしないものを選り分けて MF に反映」は、帳簿に載っている口座なら API だけで自動化できる。
- 「対象外」が適切なのは、口座間の振替の片側、二重に取得された明細、帳簿に載せていない個人用の口座など [推測]。これは API で設定できない。
  - keihi は「対象外にすべき明細」の一覧を出し、MF の画面で人が対象外にする（月に数件程度の想定）。
  - 取り消しの副作用（仕訳を削除すると excluded になる）を使って API で対象外にする方法は**採らない**。仕訳の作成と削除の履歴が毎回帳簿に残り、優良な電子帳簿の訂正削除履歴としても不自然なため。
- → 未決 P2（下記）。keihi の「私用」ボタンは、口座の設定によって「事業主貸で仕訳化」か「対象外リストへ」のどちらかを実行する。

---

## 6. 明細と領収書の突き合わせ（Q7 の再設計）

### 6.1 方針の変更 [承認要]
- mvp-plan.md の Q7 の初期値「カード払いは未払金で計上し、明細連携からは仕訳化しない」は、明細を全部手で対象外にする必要があり、自動化の目的に合わない。
- **新しい初期値: 連携しているカード・口座で払ったものは「明細起点」で仕訳化する。**
  - 明細を journalize し（反対側はカードの科目）、照合できた領収書をその仕訳の証憑として付ける。
  - 現金や連携していない支払いだけを「領収書起点」（現行の M4）で仕訳化する。
- 二重計上を防ぐ仕組み
  1. 支払手段が「連携カード / 口座」の領収書は、領収書起点の仕訳を作らない。
  2. 明細起点の仕訳は、journalize の前に `journalizing_status = none` を確かめる。
  3. 同じ日・同じ額で、領収書起点の仕訳と明細の両方があれば警告する（既存の照合 timer に足す）。

### 6.2 照合キー [承認要]
| 特徴 | 条件 | 重み |
|---|---|---|
| 金額 | 税込の合計 = 明細の value（完全一致を必須）。外貨は ±3% で「要確認」にする | 必須 |
| 日付 | 領収書の日付 ≤ 明細の日付 ≤ +3 日（設定値）。サブスクは ±1 日 | 高 |
| 取引先 | 両方を正規化して類似度を見る（NFKC、カナの統一、大文字化、「株式会社」などの除去）+ 学習した `vendor_aliases`（明細の表記 → 取引先） | 中 |
- 候補が 1 件で、取引先も一致した → 「照合の提案」（チェック済み）
- 候補が複数 → MatchCard で選ばせる
- 候補が 0 件 → 未照合のまま
- **自動では確定しない。** 1 件ずつ確定する（§4.3 の理由）。

### 6.3 流れと入力期限
1. 撮影 → 原本保存（既存）。支払手段が連携カードなら「明細待ち」の状態にする。
2. 明細の同期（日次の timer + 画面を開いたとき。`GET /transactions` で直近 60 日分）→ 照合の候補を作る。
3. 人が MatchCard で確定する → `journalize`（科目は領収書の確認内容から）→ `POST /vouchers {journal_id}` → 状態が new_voucher_attached / registered になったことを確かめる。
4. **期限の安全弁**: 明細待ちのまま「入力期限の 2 営業日前」（R5〜R9）になったら、既存の領収書起点の経路（§5.1 の分岐 B なら仮仕訳）で送る。その明細は後で届いたときに「対象外にすべき」一覧に出す。
- 未照合の一覧は 2 つの面に出す: 「領収書はあるが明細が無い」「明細はあるが領収書が無い（経費に分類したもの）」。後者は「領収書なしで確定」も選べる（少額の交通費など）。
- [事実] 証憑を API で既存の仕訳に後から付けるには、`POST /vouchers` でファイルごと送り直す必要がある（既に Box にあるファイルを紐付ける API は無い）[MF-OA]。→ §5.1 分岐 A（後から API で紐付け）はスキーマ上、成立しにくい。P4 の結果は否定的な見込み [推測]。

### 6.4 振り分けルールの学習
- `txn_rules`
  - 条件: 連携口座（任意）、支出か収入か、摘要のパターン（exact / forward / partial）、金額の範囲（任意）
  - 結果: action = expense（科目・税区分）/ private / exclude / needs_receipt
  - 記録: hit_count / miss_count、origin（learned / manual）
- 学習の仕方
  - カードの「次回から同じ明細に適用」を確定するか、同じ口座・同じパターンで 3 回同じ判断が続いたら、ルールの作成を提案する（自動では作らない）。
  - 優先順位は MF と同じ考え方にする: 口座の指定あり > 完全一致 > 前方一致 > 部分一致。
- ルールは**提案のチェックを既定でオンにするだけ**。確定は人がする（a2ui-review-ui.md §3.5 と同じ）。
- 将来: MF の自動仕訳ルール CSV に書き出し、手で取り込む（形式は [要確認]。MVP 外）。

---

## 7. 追加するデータとカタログ

### 7.1 テーブル（追記のみ。architecture.md §3.5 に足す）
- `connected_accounts`: remote_id, name（ローカルのみ）, alias（AI に見せる名前）, kind(card|bank|other), account_id, sub_account_id, on_books bool, ai_allowed bool, synced_at
- `bank_txns`: remote_id UNIQUE, connected_account_id, sub_id, date, value, side, content, content_norm, status, voucher_ids_json, first_seen_at, last_seen_at, raw_sha256
- `txn_decisions`: id, bank_txn_id, version, decision(expense|private_drawing|exclude_ui|match|hold), account_id, tax_id, invoice_kind, document_id?, proposal_id, decided_at
- `proposals`: id, source(rule|ai|command|match), intent_json, item_ids_json, ai_turn_id?, status(open|confirmed|executing|done|cancelled|expired), expires_at
- `txn_ops`: id, decision_id, op(journalize|attach_voucher|delete_journal), match_key, state, remote_journal_id, attempts, last_error
- `txn_rules`, `vendor_aliases`, `matches`(bank_txn_id, document_id, score, features_json, state)

### 7.2 カタログの拡張（keihi.catalog/v1 → v1.1。すべてサーバーが組み立てる固定部品）
| 部品 | 中身 |
|---|---|
| `IntentChips` | 解釈した条件（期間・口座・摘要・金額）をチップで表示する。タップで直せる（AI の解釈違いを打ち直さずに直せる） |
| `TxnBatchCard` | 件数・合計額・実行内容（例「12 件を 事業主貸 で仕訳化」）、TxnRow のリスト（チェック付き）、確定（N 件）/ 取消 |
| `TxnRow` | 日付・金額・摘要（textContent）・口座の別名・状態チップ・照合済みのサムネイル |
| `MatchCard` | 領収書のサムネイルと候補の明細 1〜3 件（ラジオボタン）、「どれでもない」 |
| `RuleSaveToggle` | 「次回から同じ明細に適用」 |
| `UndoBar` | 「取り消す（N 件の仕訳を削除）」。MF での解除が要る場合は、その旨を固定文で出す |
| 既存の `ChoiceQuestion` | 意図が曖昧なときの聞き返し（最大 1 問） |

---

## 8. スコープへの影響と工数

### 8.1 どこに入れるか [承認要]
- **推薦: MVP に入れる。ただし G1（本番投入）の後、M3 より前に「M6 明細の振り分け」として置く。自然言語コマンドはその後に M7 として置く。**
  - 理由 1: 領収書から MF へ送る経路（M1・M2・M4・M5）は、法令の期限とデータ保全に効くので先に固める。
  - 理由 2: 振り分けは、ルール + カード + 一括確定だけで価値の大半が出る。自然言語は入口の便利機能。
  - 理由 3: ただし **Q7 の方針（明細起点）は M4 の仕訳ビルダ（T4-1）に効く**。そのため Q7 は M4 の前に決める。M4 では「支払手段 = 連携カードなら領収書起点の仕訳を作らず、明細待ちにする」分岐だけ入れておく。
- 新しい実施順: M0（+明細の PoC）→ M1 → M2 → M4（明細待ちの分岐あり）→ M5 → G1 → **M6** → M7 → M3

### 8.2 M0 の T0-2 に足す確認項目（P9〜P19）
本番の事業者で行う。読み取り（P9・P10・P18）は安全。書き込み（P11〜P17）は、**画面で作った「PoC 用の手動口座」のダミー明細にだけ**行う。

| # | 確認すること |
|---|---|
| P9 | `GET /connected_accounts`: 連携中の口座が出るか。各口座に勘定科目が紐づいているか（= 帳簿に載っているか。§5） |
| P10 | `GET /transactions`（直近 30 日）: ミニで 403 にならないか、件数、ステータスの分布、content の表記（**結果のメモには内容を書かず、形式だけ書く**）、カードの速報明細が出るか |
| P11 | MF の画面で手動口座「keihi-PoC」を作る → `POST /transactions` でダミー明細 3 件（うち 1 件は摘要に命令文） |
| P12 | `journalize`（経費の科目）→ `GET /journals?transaction_ids` で `transaction_id` が返るか、反対側の科目、明細が registered になるか |
| P13 | その仕訳に `POST /vouchers` → 明細の `voucher_file_ids` と new_voucher_attached |
| P14 | `DELETE /journals/{id}` → 明細が excluded になるか（API の説明）、再表示されるか（FAQ）。証憑はどうなるか |
| P15 | 画面で「対象外を解除」→ none に戻るか |
| P16 | 事業主貸で journalize できるか（税区分は対象外） |
| P17 | 同じ明細を 2 回 journalize したときの応答（二重化されるか、4xx になるか） |
| P18 | MCP: Node の MCP SDK から `Mf-API-Key` で接続し、`tools/list` だけ取ってツール名とスキーマを記録する（書き込みのツールは呼ばない）。通信方式の確認 |
| P19 | 観察（ユーザー、1〜2 週間）: カードの利用日と、明細が MF に出る日の差 |
- PoC の後始末: 手動口座のダミー仕訳を削除し、口座を削除できるか確かめる。仕訳の作成と削除の履歴は MF の操作履歴に残る（許容するかは §9 P5）。
- 工数 [推測]: implementer 0.5 日、ユーザー 30 分 + 観察。

### 8.3 M6 / M7 のタスク概要（承認後に implementer 向けに分解する）
| タスク | 中身 | 工数 [推測] |
|---|---|---|
| T6-1 | MF クライアントに connected_accounts / transactions / journalize / delete を追加。fake も用意 | 0.5 日 |
| T6-2 | 明細の同期（timer + 画面を開いたとき）、キャッシュ、口座の設定画面（別名・帳簿に載っているか・AI 可否） | 1 日 |
| T6-3 | ルールのエンジンと学習、TxnBatchCard、絞り込みのチップ（自然言語なしの振り分け） | 2 日 |
| T6-4 | txn_ops の状態機械（事前の再取得、上限、冪等性の確認、取り消し、「MF で解除が要る」一覧） | 1.5 日 |
| T6-5 | 照合のエンジン、MatchCard、未照合の一覧、期限の安全弁、M4 の明細待ちとの接続 | 2 日 |
| T6-6 | AI の分類提案（§4.5、ツールなしの構造化出力） | 1 日 |
| T7-1 | 自然言語コマンド（意図スキーマ、IntentChips、範囲外の固定応答、インジェクションのテスト） | 2 日 |
| 計 | | **約 10 日**（M6 が 8 日、M7 が 2 日） |
- 外部サービスは増えない。追加の費用は Gemini だけで月数円〜数十円 [推測]。

---

## 9. 決定事項と未決事項

**本書の前提（承認されれば決定）**: MF には REST だけを使う（MCP は使わない）。AI は書き込みもツールも持たない。書き込みは確認カードを経て、サーバーの許可リストからだけ行う。照合は 1 件ずつ確定する。対象外を取り消しの副作用で作らない。

| # | 質問 | 期限 | 初期値の提案 | 決める人 |
|---|---|---|---|---|
| P1 | 入出金明細（摘要・金額）を Gemini に送ってよいか（55 日のログ）。送るなら口座ごとの除外と振込の除外でよいか | T6-6 | 送る。ただし振込と「AI 不可」の口座は除外し、収入は送らない | ユーザー |
| P2 | 私用の支出を「事業主貸で仕訳化」と「対象外」のどちらで扱うか（口座が帳簿に載っているか次第） | T6-3 | 帳簿に載っている口座 = 事業主貸、載っていない口座 = 対象外 | 税理士 → ユーザー |
| P3 | Q7 の変更: 連携カードの支払いは明細起点で仕訳化する | **T4-1（M4 の前）** | 明細起点。期限の 2 営業日前に安全弁 | 税理士 → ユーザー |
| P4 | U10 の新設: 明細画面に限って自由文コマンドを入れる（U2 は維持） | T7-1 | 入れる（M7） | ユーザー |
| P5 | PoC の書き込み（手動口座のダミー明細、仕訳の作成と削除）を本番の事業者で行ってよいか。操作履歴に残る | T0-2 | 行う（読み取りは問題なし） | ユーザー |
| P6 | 一括の上限（50 件 / 日 200 件 / 5 万円以上は個別）と、取り消しできる期間（7 日） | T6-4 | 左の値 | ユーザー |
| P7 | 照合の日付の幅（+3 日）と、外貨の扱い | T6-5 | +3 日、外貨は要確認 | ユーザー（P19 の観察後） |
| P8 | 実施順: M6 / M7 を G1 の後、M3 より前に置く | ― | 左のとおり | ユーザー |
| P9 | 月あたりの明細の件数と、連携している口座・カードの数（上限値の妥当性の確認用） | T6-2 | ― | ユーザー |
| P10 | MF の自動仕訳ルールに「対象外」の結果があるか、CSV の形式 | MVP 外 | ― | ユーザーが画面で確認（エクスポート 1 回） |

## 出典（取得日 2026-10-17。FR-OA のみ 10-13）
- [MF-OA] https://developers.api-accounting.moneyforward.com/v3/openapi.yaml （/api/v3/transactions、/transactions/journalize、/connected_accounts、/journals/{id} の DELETE、/vouchers、Transaction スキーマ）
- [MF-RN] https://developers.api-accounting.moneyforward.com/release-notes （2025-10-08、2026-07-14、2026-09-24、2026-10-13）
- [MF-MCP] https://biz.moneyforward.com/support/account/guide/others/ot10.html （2026-09-24 更新）・ https://biz.moneyforward.com/support/tax-return/guide/others/ot10.html
- [MF-MCPP] https://biz.moneyforward.com/accounting/smb/function/mcp/ （「ご利用プランによっては対象外となる場合があります」）
- MCP の 401 応答と認証メタデータ（筆者が 2026-10-17 に認証なしで取得）: https://beta.mcp.developers.biz.moneyforward.com/.well-known/oauth-protected-resource/mcp/ca/v3 ・ https://api.biz.moneyforward.com/.well-known/oauth-authorization-server
- [MF-FAQ1] https://biz.moneyforward.com/support/tax-return/faq/journal/20220223.html （2022-02-23）
- [MF-FAQ2] https://biz.moneyforward.com/support/tax-return/faq/setting-linkage/st07.html （2024-02-02）
- [MF-RULE] https://biz.moneyforward.com/support/tax-return/guide/journal02/jo17.html （2026-07-09）
- [MF-NEWS] https://biz.moneyforward.com/support/tax-return/news/new-feature/202609152.html （2026-09-15）
- [FR-OA] https://github.com/freee/freee-api-schema （/api/1/wallet_txns、/api/1/user_matchers、wallet_txn.status）
- Gemini のログ 55 日: docs/classification-ocr.md §B（https://ai.google.dev/gemini-api/docs/usage-policies 、 https://ai.google.dev/gemini-api/docs/zdr ）
- セカンドオピニオン: codex exec（OpenAPI を取得できず (1)(2) は判断保留。(3) MCP に削除と証憑の操作が無いことは同意）
