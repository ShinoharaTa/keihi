# keihi: A2UI 的な確認 UI と Gemini 対話の設計（ドラフト v0.1 / 2026-10-13・未承認）

前提: architecture.md §3（Node v24 + Hono、Vite + Preact の PWA、SQLite、tailscale serve）と README §2・§3.0（撮影したらすぐ送る、Gemini 3.8 Flash の有料 tier）。
表記: **[事実]** 一次情報またはコードで確認したこと / **[推測]** 筆者の見積もりや解釈 / **[要確認]** PoC や税理士の確認が要ること。

## 0. 何のために
- 1 枚あたり数タップで確定できるようにする（科目は画面で選ぶ。キーボード入力はなるべく避ける）。
- AI が迷うところ（会議費か交際費か、按分は何 % か）は、AI がその場で質問し、ユーザーが答えて決める。
- AI の提案と人の確定を分けて記録し、後から説明できるようにする。
- AI が UI を生成しても、任意のコードは動かさない。カタログにない部品は描画しない。値はサーバー側で検証する。

---

## 1. A2UI の現状（2026-10-13 時点）

### 1.1 プロジェクトとバージョン
- [事実] リポジトリは `google/A2UI` から **`a2ui-project/a2ui` に移った**（旧 URL はリダイレクトされる）。ライセンスは Apache-2.0。スターは約 16.7k、最終 push は 2026-10-13。[G1]
- [事実] README の表記は「Early stage public preview」。**本番向けの現行版は v0.9.1**（v0.9 系のパッチ）。**v1.0 はリリース候補（RC）**で、v0.8 はレガシー扱い。[G1][S3]
  - v0.9 の公開は 2026-04 中旬（InfoQ、CopilotKit の記事）。[N1][N2]
  - v0.9.1 での変更は、MIME タイプを `application/a2ui+json` に統一したことと、surfaceId の制約を緩めたこと。[S1]
  - v1.0 RC（ドラフト時の名前は v0.10）。仕様ページの最終更新は 2026-06-08。ロードマップでは「Q4 2026 に v1.0 を確定（安定性の保証、v0.9 からの移行パス、レンダラの認証制度）」となっている。[S3][RM]
  - **v0.9 → v1.0 では catalog API に破壊的変更がある**と仕様に明記されている。[S3]
- [事実] GitHub Releases は Python SDK のものだけ（`python/a2ui-agent-sdk/v0.8.0`、2026-10-08）。npm の Web レンダラは 0.x 系で、毎月のように版が上がっている（下表）。

### 1.2 メッセージ形式（v0.9.1）[S1][S2]
- サーバー → クライアント: 1 メッセージにつき、次の 4 つのキーのうち 1 つだけを持つ。JSONL などのストリームで送る。
  - `createSurface {surfaceId, catalogId, theme?, sendDataModel?}`
  - `updateComponents {surfaceId, components[]}`: コンポーネントは平らなリストで、id で互いを参照する（隣接リスト）。描画は `id: "root"` が来てから始まる。
  - `updateDataModel {surfaceId, path?(JSON Pointer), value?}`
  - `deleteSurface {surfaceId}`
- クライアント → サーバー:
  - `action {name, surfaceId, sourceComponentId, timestamp, context}`
  - `error`（`VALIDATION_FAILED` など）
  - 入力部品はクライアント側のデータモデルと双方向にバインドされる。**サーバーに値が届くのは action が発火したときだけ。**
- カタログ: `catalogId`（URI）で識別する。basic catalog の部品は Text / Image / Icon / Video / AudioPlayer / Row / Column / List / Card / Tabs / Divider / Modal / Button / CheckBox / TextField / DateTimeInput / ChoicePicker / Slider。関数は名前で参照する（required / regex / formatCurrency / openUrl など）。**実行コードは送らない。**
- v1.0 RC で増えるもの: 双方向の関数呼び出し（`callRendererFunction` / `callAgentFunction` / `rendererFunctionResponse` / `agentFunctionResponse`）、`createSurface` に部品と初期データを同梱できること、テーマの分離、UAX #31 の命名規則。[S3]

### 1.3 Web 向けの公式レンダラ [R1][NPM]
| レンダラ | npm（2026-10-09 時点） | v0.9.1 | v1.0 | 主な依存 |
|---|---|---|---|---|
| React | `@a2ui/react` 0.13.0 | Stable | Planned | react 18/19、zod、markdown-it |
| Lit（Web Components） | `@a2ui/lit` 0.13.0 | Stable | Planned | lit 3、@lit-labs/signals、zod |
| Angular | `@a2ui/angular` 0.12.0 | Stable | Planned | Angular 21 |
| Flutter（GenUI SDK） | 別リポジトリ | Stable | Planned | ― |
| 共通コア | `@a2ui/web_core` 0.13.0 | ― | ― | zod、redos-detector など |

- [事実] Preact と Svelte の公式レンダラは無い。Jetpack Compose は Alpha、SwiftUI は Planned。[R1]
- [事実] **TypeScript のエージェント SDK（`@a2ui/agent` 0.0.1）はリポジトリにあるだけで、npm には未公開**（`npm view` が 404）。KNOWN_GAPS.md には「ストリーム処理でカタログに対するプロパティ検証が行われない」と書かれている。[G2]
  - サーバー側で A2UI を生成・検証する公式ツール群（`DirectJsonFormat` によるプロンプト生成、パーサ、検証）は Python が主。[G3]
- [事実・筆者計測] 規模の目安。2026-10-13 に scratchpad へ入れて esbuild で minify した、エントリの全 import を含むサイズ（tree-shaking 後の実効値はこれより小さくなり得る）。
  - `@a2ui/lit/v0_9` の A2uiSurface + basicCatalog と `@a2ui/web_core/v0_9`: **min 437KB / gzip 121KB**
    - 内訳: web_core 234KB、redos-detector 68KB、zod 60KB
  - `@a2ui/react/v0_9`（react 本体を除く）: min 315KB / gzip 90KB
  - 参考: Preact 本体は min 13KB / gzip 6KB

### 1.4 Gemini との組み合わせ方
- [事実] A2UI の公式ガイドの方式は**プロンプトファースト**。
  - A2UI のスキーマと例をシステムプロンプトに入れる（`DirectJsonFormat`）。
  - モデルの出力は `<a2ui-json>` タグで囲ませ、後から抽出する。
  - 抽出した JSON をスキーマで検証し、不正ならエラーを LLM に戻して直させる。[G3][G4]
  - AG-UI 経由（CopilotKit のランタイムが `generate_a2ui` ツールを注入する）の例もある。[G5]
- [事実] Gemini API の構造化出力は **JSON Schema のサブセット**に対応する。[GM1]
  - 対応しているもの: type、properties、required、additionalProperties、enum、format（date / date-time / time）、minimum / maximum、items、minItems / maxItems、anyOf、`$ref` による再帰。
  - 「非常に大きい、または深くネストしたスキーマは拒否されることがある」と書かれている。
  - Gemini 3 系では、構造化出力と Function Calling を併用できる（preview）。
- [事実] Function Calling の `VALIDATED` モードは、関数のスキーマへの適合を保証する。[GM2]
- [推測] A2UI の公式スキーマは `allOf` と外部 URL への `$ref` を多用している。Gemini のサブセットに収まらない可能性が高く、**制約付きデコード（responseJsonSchema）でそのまま強制するのは難しい**。プロンプトで出させる → 検証 → 失敗したら直させる、の再試行ループが前提になる。[要確認]
- [事実] Interactions API の扱い。[GM3]
  - 既定の `store=true` では、サーバー側に履歴が **有料 tier で 55 日**保存される（7 / 14 / 28 日に短縮できる）。
  - `store=false` か、履歴を毎回自分で送れば保存されない。
  - ステートレスで思考ブロックを含む履歴を送り直す場合は、受け取ったものを改変せずにそのまま返す必要がある。[GM4]
- [事実] 料金: Gemini 3.8 Flash は 2026-12-31 まで入力 $0.75 / 出力（思考トークンを含む）$3.75 per 1M。2027-01-01 から倍になる。[GM5]
  - 思考レベルは low / medium / high で、既定は medium。[GM4]
  - 画像は `media_resolution` によって 280 / 560 / 1120 / 2240 トークン（既定は 1120）。文書の OCR は medium（560）で頭打ちになりやすい。[GM6]

### 1.5 近い仕組みとの違い [G6]
| | A2UI | AG-UI | MCP Apps |
|---|---|---|---|
| 何か | UI の**記述形式**（宣言的な JSON とカタログ） | エージェントとフロントをつなぐ**イベント転送プロトコル**（CopilotKit 発、MIT）[AG1] | MCP の拡張。サーバーが `ui://` で HTML を出し、ホストが sandbox iframe で描画する。2026-01-26 に Stable。ext-apps は v2.0.3（2026-09-25）[MA1] |
| 描画 | ホスト側の信頼済み部品 | 開発者が書く | リモートの HTML |
| keihi との関係 | 概念を借りる対象 | 不要（単一エージェントで、自前の HTTP API で足りる） | 不要（Claude などの MCP ホスト向けの仕組みで、自前の PWA とは無関係） |

---

## 2. keihi への取り込み方（3 案）

| | A: A2UI 公式（v0.9.1 と公式レンダラ） | B: 概念だけ借りる（keihi 独自の小さなカタログを構造化出力で返させる） | C: 固定フォーム（AI はデータと質問の文面だけ返す） |
|---|---|---|---|
| 概要 | Gemini に A2UI JSON をプロンプトで生成させる。サーバーで検証してから PWA の `@a2ui/react` か `@a2ui/lit` で描画する | 確認カードは固定。**質問カードだけ** Gemini が数種類の部品から選び、選択肢と「選んだら何が変わるか（effect）」を enum の制約付きで返す。描画は Preact の自作部品 | 確認フォームは完全に固定。AI は抽出値、科目候補、質問（選択肢付き）を返すだけ |
| メリット | 標準に乗れる。将来ほかのエージェントや UI と相互運用できる | 制約付きデコードでカタログ外の出力が原理的に出にくい。小さい。UI が毎回同じなので、指が操作を覚える | 最小の工数。予測しやすい |
| デメリット | 0.x で破壊的変更がある（v1.0 で catalog API が変わる）。Node 向けの公式 SDK が無い。Gemini のスキーマ制約に乗らず再試行が要る。basic catalog の Image / openUrl / Markdown は外部取得や誘導の経路になるので、自前カタログを作り直す必要がある | 自前で保守する。標準との互換性は無い（ただし語彙を A2UI に寄せておけば移行は可能） | 「AI が状況に応じて UI を出す」体験は弱い。質問の形が増えるたびにコードを変える必要がある |
| 実装コスト [推測] | 大: 8〜12 人日（カタログの作り直し、検証と再試行、モバイル向けのスタイル調整） | 中: 4〜6 人日 | 小: 3〜4 人日 |
| PWA バンドル増 | +90〜120KB gzip（§1.3 の計測値）＋ react を使うならその分 | +5〜10KB gzip [推測] | +3〜5KB gzip [推測] |
| セキュリティ | ○ コードは実行しない。ただし部品とプロパティの検証は自前で強化が要る（TS SDK は未完成） | ◎ enum とホワイトリスト。effect の対象フィールドも固定 | ◎ |
| 仕様追従コスト | ✗ v1.0 確定（Q4 2026 予定）で catalog の移行が要る。npm がほぼ毎月更新される | ◎ 自分で決める。Gemini 側のスキーマのサブセットの変化だけ見ればよい | ◎ |
| 運用コスト | Gemini の再試行分でトークンが 1.2〜2 倍 [推測] | 基準（§3.6） | 基準と同等 |
| 最適度 | △ | ◎ | ○ |

**推薦: B。**
- 1 人用・1 用途の PWA で、A2UI の価値（複数エージェントの横断、プラットフォーム横断）がほとんど効かない。
- 一方で、A の追従コストとバンドル増は確実にかかる。
- C との差は「質問の形を AI が選べる」ことだけなので、B を C の上に小さく足す形で作れる（C から始めて B に育てても手戻りは小さい）。
- 語彙は A2UI に寄せる（surface ≒ 1 枚の確認画面、components、dataModel、action）。v1.0 が確定して公式の Preact / 軽量レンダラが出たら、そのとき A を再検討する。

### 2.1 B のカタログ（`keihi.catalog/v1`、JSON Schema で定義し、サーバーと PWA で共有）
- **固定部品**（Gemini は出さない。サーバーが抽出結果から組み立てる）
  - `ReceiptThumb`: 画像のサムネイル。タップで拡大
  - `AmountField`: 合計と税率別（10% / 8%）の内訳
  - `DateField`
  - `VendorField`: 取引先名と登録番号 T+13 桁。番号は形式を検証する
  - `AccountChips`: 確信度の高い順に上位 3 件と「他の科目…」
  - `AccountSheet`: provider_masters から引ける検索付きのボトムシート
  - `PaymentChips`: 事業主借 / 現金 / カード…
  - `DecisionBar`: 確定 / 私用 / 重複 / 保留
- **質問部品**（Gemini が `questions[]` で返す。1 枚につき最大 2 問）
  - `ChoiceQuestion {text≤80字, options[2..4]: {label≤20字, effect}}`
  - `ProrationQuestion {text, min:0, max:100, step:10, suggested}`
  - `YesNoQuestion {text, yes:effect, no:effect}`
  - `effect = {field: enum[account_id, tax_id, proration_pct, decision, memo_tag], value}`。value は field ごとに enum か範囲で制約する。account_id はその時点の provider_masters の ID 一覧を enum にする（約 40 件）。
- **Gemini の応答スキーマ**（制約付きデコード。anyOf と enum だけで書け、`allOf` と外部 `$ref` は使わない）

  ```
  {extraction:{txn_date, amount_total, tax_by_rate[], vendor_name, invoice_reg_no?, payment_hint?},
   account_candidates:[{account_id(enum), tax_id(enum), confidence(0..1), reason≤60字}] maxItems 3,
   questions:[ChoiceQuestion|ProrationQuestion|YesNoQuestion] maxItems 2}
  ```
- **サーバー側の検証**（Gemini が守ったとしても毎回やる）
  - スキーマを再検証する。enum は最新の provider_masters と突き合わせる。
  - 金額は整数かつ正で、税率別の内訳の和が合計と一致するか（不一致なら警告を出し、質問を 1 問足す）。
  - 文字列は長さで切り、制御文字を除く。
  - **カタログにない部品やフィールドは捨てる。** PWA は `textContent` でだけ描画する（HTML、Markdown、URL、画像の参照は一切描画しない）。

---

## 3. 確認画面と対話の流れ（B 前提）

### 3.1 流れ
1. 撮影 → 即アップロード → 原本保存 → **証憑を会計サービスへ先に送る**（README §2。freee なら receipts、MF は PoC 次第）
2. worker が Gemini を 1 回呼ぶ（画像 + 辞書の抜粋 + 科目一覧 → §2.1 のスキーマ）→ extractions / classifications / ai_turns に記録
3. 確認カードを表示する（固定部品 + 質問カード 0〜2 枚）
4. ユーザーが質問の選択肢を選ぶ → **サーバーが effect を決定的に適用する（ここでは Gemini を呼ばない）**
   - 「その他」や「どれでもない」を選んだときだけ、2 回目の Gemini 呼び出しをする（テキストのみ。§3.3）
5. 確定 → reviews に新しい版を追加 → vendor_rules を更新 → outbound（仕訳を送信）

- 辞書の確信度が高く（例: 同じ取引先で過去 3 回以上同じ科目、【閾値は要決定】）、金額の整合も取れていれば、質問は出さない。
- [推測] 大半の領収書は Gemini の呼び出し 1 回で終わる。「対話」はほぼ「AI があらかじめ用意した選択肢に答える」形になる。

### 3.2 状態管理
- **1 枚の領収書（document）につき 1 スレッド。** Gemini 側には状態を持たせない（generateContent か `store=false`）。
  - 理由 1: 55 日保存を避ける [GM3]
  - 理由 2: 思考ブロックを改変せずに送り返す義務を避ける [GM4]
  - 理由 3: 正本を自分の DB に置く
- 追加テーブル（追記のみ。architecture.md §3.5 に足す）
  - `ai_turns`: id, document_id, seq, role(ai|user|system), model, model_ver, thinking_level, request_sha256, response_json, tokens_in, tokens_out, latency_ms, created_at
  - `ui_cards`: id, document_id, ai_turn_id, kind, card_json（検証後）, status(open|answered|superseded)
  - `answers`: id, card_id, option_index | value, applied_effect_json, answered_at
- スレッドを閉じる条件: 確定、私用、重複、却下のいずれか。保留は 14 日たったら確認キューの上に出す。

### 3.3 Gemini に送るコンテキスト
| 呼び出し | 送るもの | 送らないもの |
|---|---|---|
| 1 回目（OCR + 分類 + 質問） | 画像（media_resolution は medium から試す。【要PoC】）、科目と税区分の一覧（名前と ID だけ）、**その取引先の vendor_rules と、類似する取引先の上位 5 件**、按分の既定値の設定 | 過去の仕訳全体、金額の履歴、ユーザーの氏名・住所 |
| 2 回目以降（任意） | 1 回目の抽出 JSON、現在の下書き、これまでの Q&A（構造化したもの）。**画像は再送しない** | 画像（ユーザーが「読み取りが違う」と押したときだけ、high で再 OCR する） |

- 各ターンは独立した 1 回きりの呼び出しにする。履歴は要約した JSON で渡すので、思考ブロックの送り返しは要らない。

### 3.4 トークン費用の見積もり [推測]
- 1 回目: 入力約 3k（画像 560〜1120、プロンプトとカタログ約 1.5k、辞書約 0.5k）、出力約 1k（JSON 0.4k + 思考 low で約 0.5k）
  - ≈ $0.006（約 0.9 円、1 ドル 150 円で換算）
- 2 回目: 入力約 2k、出力約 0.6k ≈ $0.004（約 0.6 円）
- 月 100 枚、うち 30% が 2 回目を 1.5 回呼ぶとすると、**月 約 120 円**。2027 年からは約 240 円。
  - 思考を medium にすると出力が増えて 1.3〜1.5 倍【要PoC】。Batch（半額）は即時性が要らない夜間処理なら使える。

### 3.5 学習の経路
- 確定時に `vendor_rules`（取引先の正規化名 or 登録番号 → 科目・税区分・支払手段・按分 %）を upsert する。hit_count と origin(learned|manual) も更新する。
- 質問への答えも記憶する（`vendor_rules.qa_memory_json`）。例: 「この取引先は会議費」。次回は同じ質問を出さない。
- AI の提案と確定が食い違った回数を記録する。辞書が外れ続ける取引先は、ルールを自動では上書きせず「ルールを更新しますか？」を 1 問出す。
- 自動確定（タップ 0）はしない。最低 1 タップで人が確定する（説明責任のため。§3.6）。

### 3.6 監査ログ（AI の提案と人の確定を分ける）
- audit_log の action を分ける: `ai.proposed` / `ai.asked` / `user.answered` / `user.overrode` / `user.confirmed` / `rule.learned`。actor は ai|user|worker。
- reviews に `field_sources_json` を持たせる（各フィールドが ocr / ai / rule / user のどれ由来か）。`based_on_ai_turn_id` も持たせる。
- Gemini の応答原文（response_json）とプロンプトのハッシュ、モデルのバージョンを保存する。これで「何を根拠に誰が決めたか」を後から再現できる。
- [推測] 電帳法が直接求めるのは帳簿と証憑の訂正削除履歴などで、AI 提案の記録そのものは法定要件ではない。説明責任と品質改善のための記録として持つ。保存期間は未決（§5）。

### 3.7 スマホ（片手）
- 縦 1 画面に収める。上: サムネイルと金額（大きく）。中: 日付・取引先（タップで編集）、科目チップ 3 つ、支払手段。下 1/3（親指の届く範囲）: 質問カードと「確定」（幅いっぱいの大ボタン）。「私用」は副ボタン。
- タップ数の目標
  - 辞書に当たったとき: **1 タップ**（確定）
  - AI の第 1 候補が正しいとき: 1 タップ
  - 第 2・第 3 候補のとき: 2 タップ
  - 質問 1 問あり: +1 タップ
  - 「他の科目」から選ぶとき: 検索シートで 3〜4 タップ
- 按分スライダーは 10% 刻みで吸着させ、よく使う値（0 / 50 / 100 など、設定から取る）をチップで横に並べる。スライダーだけに頼らない。
- 金額の修正は `inputmode="decimal"`。確定したら次の未確認に自動で進む。スワイプ専用の操作は作らない（誤操作と発見しにくさのため）。
- 質問の文面は 80 字以内。選択肢のボタンは 44pt 以上。

---

## 4. プライバシー
- **リスクが増えるところ**
  - 対話の回答（例: 会食の相手、私用か事業用か、自宅の家賃按分）が Gemini に渡る。
  - 有料 tier でも不正監視のログは 55 日残る（classification-ocr.md §B）。Interactions API を `store=true` で使うと、さらに履歴が 55 日保存される。
- **制限**
  1. 質問は選択式・スライダー・はい/いいえだけにする（MVP では自由入力の質問を出さない）。ユーザーの答えは enum の値として送り、文章は送らない。
  2. 参加者名や目的のメモなど自由記述は**ローカルにだけ保存**し、Gemini には送らない。
  3. 送る辞書は「取引先 → 科目」の集計だけにする。金額の履歴や仕訳の一覧は送らない。
  4. `store=false`（または generateContent）にする。API キーは Gemini 専用のプロジェクトで発行する。
  5. 機微区分（医療など。README §3 の 3）の領収書は、対話も含めて Gemini に送らない（ローカル OCR + 固定フォームのみ）。
- **プロンプトインジェクション**: 領収書の文字に命令文が混ざっていても、出力は enum とホワイトリストの effect に限られ、サーバーで再検証する。PWA はテキストとしてしか描画しない。被害は「おかしな候補や質問が出る」程度に抑えられる [推測]。

---

## 5. 未決事項
| # | 質問 | 決める人 |
|---|---|---|
| U1 | 推薦の B（固定の確認カード + AI が選ぶ質問カード）でよいか。まず C で作って B に育てる順序でよいか | ユーザー |
| U2 | ユーザーから AI に自由文で相談する機能（「これ何費？」）を MVP に入れるか（プライバシーと費用が増える） | ユーザー |
| U3 | 1 枚あたりの質問の上限（推薦は 2 問）と、質問を出さない辞書の確信度の閾値 | ユーザー（初期値は spec-writer が提案） |
| U4 | 家事按分の既定値を科目ごとに設定するか（通信費・地代家賃・水道光熱費など）。AI はその値から提案する | ユーザー（妥当性は税理士） |
| U5 | 会議費 / 交際費などの判断基準を、AI のプロンプトにどう書くか（個人事業主では交際費に上限は無いが、事業関連性の説明が要る【要確認】） | 税理士 → ユーザー |
| U6 | Gemini の応答原文と ai_turns をどれだけ保存するか（証憑と同じ 7 年以上か、1 年か） | ユーザー |
| U7 | 思考レベル（low / medium）と media_resolution（medium / high）の選択 | PoC の結果で spec-writer が提案 → ユーザー |
| U8 | 「AI 提案のまま確定」を 1 タップで許すか、差分が無いときも確認を 1 画面挟むか | ユーザー |
| U9 | v1.0 確定後（Q4 2026 予定）に A を再評価するか | spec-writer（v1.0 リリース時） |

## 出典
- [G1] https://github.com/a2ui-project/a2ui （旧 https://github.com/google/A2UI 。README、LICENSE、2026-10-13 に確認）
- [G2] https://github.com/a2ui-project/a2ui/blob/main/typescript/a2ui_agent/KNOWN_GAPS.md
- [G3] https://github.com/a2ui-project/a2ui/blob/main/docs/public/guides/agent-development.md
- [G4] https://github.com/a2ui-project/a2ui/blob/main/docs/public/concepts/glossary.md
- [G5] https://github.com/a2ui-project/a2ui/blob/main/docs/public/guides/a2ui-with-any-agent-framework.md
- [G6] https://github.com/a2ui-project/a2ui/blob/main/docs/public/introduction/agent-ui-ecosystem.md
- [R1] https://github.com/a2ui-project/a2ui/blob/main/docs/public/reference/renderers.md
- [S1] https://a2ui.org/specification/v0.9.1-a2ui/ ・ https://a2ui.org/
- [S2] https://a2ui.org/specification/v0.9-a2ui/
- [S3] https://a2ui.org/specification/v1.0-a2ui/
- [RM] https://a2ui.org/roadmap/
- [NPM] https://www.npmjs.com/package/@a2ui/lit ・ https://www.npmjs.com/package/@a2ui/react ・ https://www.npmjs.com/package/@a2ui/angular ・ https://www.npmjs.com/package/@a2ui/web_core （`npm view` で 2026-10-13 に確認）
- [N1] https://www.infoq.com/news/2026/07/google-a2ui-genui/ （二次）
- [N2] https://www.copilotkit.ai/blog/a2ui-whats-new-in-google-generative-ui-spec （二次）
- [GM1] https://ai.google.dev/gemini-api/docs/structured-output
- [GM2] https://ai.google.dev/gemini-api/docs/function-calling
- [GM3] https://ai.google.dev/gemini-api/docs/interactions
- [GM4] https://ai.google.dev/gemini-api/docs/thinking
- [GM5] https://ai.google.dev/gemini-api/docs/pricing
- [GM6] https://ai.google.dev/gemini-api/docs/media-resolution
- [AG1] https://docs.ag-ui.com/introduction ・ https://github.com/ag-ui-protocol/ag-ui （MIT）
- [MA1] https://github.com/modelcontextprotocol/ext-apps ・ https://modelcontextprotocol.io/docs/extensions/apps
