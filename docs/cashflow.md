# keihi 明細・可視化・資金繰りの設計（R-A / R-B / R-D の正本）

2026-11-06 時点の `feature/cashflow`（PR #13〜#31）の実装から起こした。要件は requirements-v2.md、タスク分解は mvp-plan-v3.md。
本文は**コードで確認した事実**（ファイル名を添える）。コードから読み取れないことは **【推測】** と書く。
V4・V5・V7・V8・V10・V11 は初期案のまま実装した（2026-11-06 暫定採用・ユーザー未承認。requirements-v2 §4）。

## 0. 何のために
口座・カード・PayPay の明細をローカル SQLite に集め、振替を除いた本当の収支を月ごとに見せ、予定支出（税金・保険・車検など）から 36 か月先までの月末残高と「月末に残す額」を出す（requirements-v2 §1）。

## 1. データの流れ
| 段 | 何をするか | 書く表 | コード |
|---|---|---|---|
| 1. 口座 | daily のマスタ同期で freee の walletable ごとに口座を upsert（既にあれば name だけ更新）。CSV だけの口座は `POST /api/accounts` | money_accounts | `src/masters/sync.ts`・`src/bank/accounts.ts` |
| 2. ジョブ | daily が `sync_bank` を 1 件積む（未完了があれば積まない）。「今すぐ同期」も積むが前回から 10 分以内は積まない | jobs | `src/worker/handlers/daily.ts`・`src/bank/sync.ts` |
| 3. 取得 | freee `wallet_txns`（limit 100、offset でページング）を口座ごとに取り、外部 ID で upsert。続けて `walletables` の last_balance を残高に追記 | bank_txns・bank_txn_sources・account_balances・sync_status | `src/bank/sync.ts` |
| 4. 振替検出 | 同期で 1 件以上取れたら「今回見た明細の最小日 − 2×transfer_window_days 〜 今日」で検出。失敗しても同期の結果は変えない | transfer_links | `src/worker/handlers/syncBank.ts`・`src/bank/transfers.ts` |
| 5. タグ | 読むたびに計算（保存しない）。人が上書きしたら版を追記し、3 回続けば学習ルール | txn_tags・tag_rules | `src/bank/tags.ts` |
| 6. 月次集計 | 振替・引き落とし・チャージを除いて口座別・カテゴリ別・タグ別に集計（読むたびに計算） | ― | `src/bank/summary.ts` |
| 7. 周期検出 | daily が前回までの明細で検出（sync_bank はその後にジョブで走るので 1 日遅れ）。手動は `POST /api/recurrence_candidates/detect` | recurrence_candidates | `src/cashflow/detect.ts` |
| 8. 予定台帳 | 候補を受け入れる（origin=detected）か手入力（origin=manual） | scheduled_items | `src/cashflow/schedule.ts` |
| 9. 資金繰り表 | `GET /api/cashflow` のたびに計算（保存しない） | ― | `src/cashflow/forecast.ts` |

### 1.1 sync_bank の取り方（`src/bank/sync.ts`・`src/worker/handlers/syncBank.ts`）
| 項目 | 内容 |
|---|---|
| 対象 | `provider = [provider] kind`・`source = freee`・`active = 1` の口座。前回成功（last_ok_at）が古い順、未成功が先 |
| 初回 | 「今日の 3 か月前（backfill_from より前には行かない）〜今日」だけ。backfill_done_until をその始まりにする |
| 2 回目以降 | 直近: `max(最新の明細日 − 35 日, backfill_from)`〜今日。過去分: backfill_done_until が backfill_from より後なら、その手前 3 か月を 1 区間だけ（1 回の実行で 1 区間） |
| upsert | 外部 ID は `<freee_walletable_id>:<wallet_txn id>`。既存なら freee_status・due_amount・last_seen_at と、NULL の balance だけ書く。status の変化は監査 `bank_txn.status_changed` |
| status | 1/2/3/4/6 だけ保存。それ以外（5 など）は NULL |
| 不正な行 | id・日付・正の整数の金額が無い行は飛ばして数える（`skipped N rows` を last_error に。摘要は記録しない） |
| ページ上限 | 1 口座 1 区間 50 ページ（5,000 件）。前ページと先頭 id が同じなら offset 不発とみて打ち切り。打ち切ったら backfill_done_until を進めない |
| 予算 | 用途 `sync`（300 回/日）。残り 500 未満・`usage_limited`（403）ならそこで止めてジョブは完了。次回に続きから |
| 再認可 | `auth_invalid_grant` か `freee_reauth_required=1` なら 6 時間後へ延期（回数を数えない） |
| 残高 | 明細の後に `listWalletables` の last_balance を as_of_date=今日・source=freee_walletable で追記。カードと残高 null は追記しない。予算で止まった回は取らない |
| 一部失敗 | 他の口座は続け、最後に例外を投げてジョブの再試行に回す |

## 2. テーブル（0005_bank・0006_cashflow）
日付は JST の暦日 `YYYY-MM-DD`、時刻は UTC ISO8601、金額は整数の円。追記専用・不変の列は SQLite のトリガで拒否する。
mvp-plan-v3 §7 では 0007_cashflow だったが、0006_mcp を後回しにしたので 0006_cashflow に繰り上げた（`0006_cashflow.sql` 冒頭）。

| 表 | 1 行の意味 | 書き方（更新してよい列） |
|---|---|---|
| money_accounts | 口座 1 つ（freee の walletable か CSV だけの口座）。`UNIQUE(provider, freee_walletable_id)` | 設定の列だけ: name・default_tag・mcp_visibility・include_in_cashflow・card_settlement_account_id・card_settlement_pattern・active・updated_at。削除のトリガは無いが削除する経路も無い |
| bank_txns | 入出金 1 件（API と CSV から来ても 1 行）。amount > 0、向きは side | 削除禁止。更新は freee_status・due_amount・last_seen_at と、NULL の balance を埋めることだけ |
| bank_txn_sources | 明細の取得元。`UNIQUE(account_id, source, external_id)` | 追記専用。口座が明細と違うと INSERT を拒否 |
| csv_imports | CSV 取り込み 1 回。`UNIQUE(account_id, file_sha256)` | 追記専用（書く処理は T105 で未実装） |
| account_balances | 残高の記録。最新は as_of_date 最大 → seq 最大 | 追記専用 |
| txn_tags | 明細のタグの版。version 最大が最新 | 追記専用 |
| tag_rules | タグのルール。account_id NULL は全口座 | 更新・削除可（監査に残す。削除時のパターンは sha256 の先頭 16 桁だけ） |
| transfer_links | 振替・引き落とし・チャージの組。組ごとに seq 最大が有効。card_settlement は in_txn_id NULL | 追記専用 |
| sync_status | 口座ごとの取得状況（A5） | 更新可 |
| freee_rule_links | keihi が freee に作ったルール（act 4 / 12） | 追記専用（書く処理は T109 で未実装） |
| scheduled_items | 予定の項目（direction in / out） | 更新可。id・origin・created_at は不変。削除禁止（active=0 にする）。変更は監査 |
| recurrence_candidates | 周期の検出の候補 | state・scheduled_item_id・updated_at だけ更新可。削除禁止。accepted のときだけ scheduled_item_id を持つ |

## 3. 重複排除（`src/bank/dedup.ts`、T106）
| 段 | 条件 | 結果 |
|---|---|---|
| 1 | 同じ口座・同じ source・同じ external_id | 既存の明細を touch。日付・金額・side が違えば `external_id_conflict` |
| 2 | source が違い、同じ口座・同じ side・同じ金額・日付差 ±`dedup_date_window_days` の候補（その source をまだ持たない明細） | 日付差が小さい順 → 挿入順で 1 件と組み、bank_txn_sources を足す（統合） |
| 3 | 組める相手が残っていない | 新しい明細にする。バッチ開始時点で候補があったなら「重複の疑い」（suspects）として返す |

- 統合時、入力が freee なら freee_status・due_amount を書き、balance は NULL のときだけ埋める。csv なら last_seen_at だけ。全体を 1 トランザクション。入力の検査に落ちた行は errors に入れ、他の行は続ける。
- `dedupAndInsert` はまだどこからも呼ばれていない。freee の同期（sync.ts）は段 1 相当の upsert を自前で行う。CSV 取り込み（T105）から呼ぶ想定【推測】。

## 4. 振替検出（`src/bank/transfers.ts`、T107）
| kind | 条件 | 組 |
|---|---|---|
| card_settlement | カード口座に card_settlement_account_id（bank の口座だけ指定可）と card_settlement_pattern があり、その銀行口座の出金の摘要がパターンを含む（両側を取引先名の正規化で比べる） | 出金 1 件だけ（in_txn_id NULL） |
| transfer | 口座 A の出金と口座 B の入金が同額・日付差 0〜`transfer_window_days` 日で、お互いに候補が 1 件ずつ | 出金 + 入金 |
| charge | transfer の条件で、入金側が paypay・出金側が bank か card | 出金 + 入金 |

- card の出金はチャージの相手としてだけ組む。card の入金（返金）は組まない。
- 有効な組に入っている明細は候補にしない。最新が rejected の組は作らない。候補数は rejected の組も含めて数える（外しても別の相手を自動で選ばない）。
- 組を外す関数 `rejectTransfer`（state=rejected を追記、監査 `transfer.rejected`）はあるが、**HTTP API はまだ無い**。
- **除外**の定義: 有効な組（最新が active）の出金側と入金側の明細（`excludedFromCashflow`）。月次集計と周期検出から除く。資金繰りの予定外の目安では、対象口座どうしの組だけを除く（§8）。

## 5. タグとカテゴリ（`src/bank/tags.ts`、T108・V5・V10）
効くタグの決定順（読むたびに計算）:
| 順 | 出どころ | tag_source |
|---|---|---|
| 1 | txn_tags の最新版のうち source が human / agent のもの（rule の版は上書きとみなさない） | override |
| 2 | tag_rules: 口座のルール > 全口座 → exact > prefix > partial → hit_count が多い → 新しい | rule |
| 3 | 口座の default_tag（unset 以外） | account |
| 4 | どれも無い | none（tag = unset） |

学習: 人（human）の上書きで、同じ口座・同じ正規化摘要の**別々の明細 3 件**の最新の上書きがすべて同じ tag と category なら、match=exact・origin=learned のルールを作る。同じ口座・同じパターンの learned が既にあれば、同じ中身なら hit_count +1、違えば置き換える（2 件目は作らない）。agent の上書き・unset・空の摘要は数えない。監査に摘要は入れない。

カテゴリ（固定 12 種 + 未分類 = null。DB に CHECK は無く、コードで検証）:
food 食費 / daily 日用品 / transport 交通 / telecom 通信 / housing 住居 / utilities 水道光熱 / insurance 保険 / tax 税金 / car 車 / leisure 娯楽 / medical 医療 / other その他。
予定台帳の category（tax / insurance / car / other / income）はこれとは別の一覧。

## 6. 月次集計（`src/bank/summary.ts`、T110）
- その月の全明細から、§4 の除外（全口座の有効な組の両側）を除いて合計する。`include_in_cashflow` では絞らない。
- 出すもの: by_account（income・expense・net と include_in_cashflow・active）、by_category（固定順、未分類は最後）、by_tag、total。
- `excluded`: kind ごとに「その月に除いた明細」の行数・入金・出金。月をまたぐ組でも、各月で「除く前の合計 = total + excluded」が成り立つ。
- カードは利用分（カード口座の出金）を数え、銀行の引き落としを除く。**引き落とし口座とパターンを設定しないと両方が支出に入る（二重計上）。**

## 7. 周期検出（`src/cashflow/detect.ts`、T302）
対象は今日の 26 か月前〜今日の支出。active かつ include_in_cashflow の口座だけで、§4 の除外は除く。同じ口座・同じ正規化摘要でまとめ、金額 ±5%（大きい方 ≤ 小さい方 × 1.05）でさらにまとめる。同じ日・同じ額は 1 件に畳む（2 回線など）。

| 周期 | 隣り合う間隔 | 必要な回数 | 止まったとみなす（最後の出現から今日まで） |
|---|---|---|---|
| monthly | 28〜31 日 | 3 回以上 | 46 日超 |
| bimonthly | 58〜62 日 | 3 回以上 | 93 日超 |
| quarterly | 85〜97 日 | 3 回以上 | 145 日超 |
| yearly | 350〜380 日 | 2 回以上 | 570 日超 |
| biennial | 715〜745 日 | 2 回以上 | 1,117 日超 |

- 条件を満たす連続のうち最も新しいものを採る。最後の出現日が同じなら短い周期を採る。止まった列は採らない。
- 作らない: 同じ口座・摘要・周期で金額 ±5% の候補が既にある（open / accepted / dismissed のどれでも）。同じ口座の active な予定に、同じ名前か「同じ周期で ±5%」のものがある。
- 置き換え（値上げ）: 新しい候補を作ったとき、同じ口座・摘要・周期の open の候補で今回のどの列とも金額が合わないものを dismissed にする（actor=system、`reason: superseded`）。人が dismissed にしたものには触らない。
- 受け入れ: 台帳に direction=out・origin=detected で入れる。名前の既定は正規化摘要、category の既定は other、notify_days_before は 14。anchor_date は「出現日の『日』の最頻値（月末が多ければ月末）を最後の出現月に当て、周期を 1 回足した日」。

## 8. 資金繰り表（`src/cashflow/forecast.ts`、T303・V11）
対象口座 = `include_in_cashflow = 1` かつ `active = 1`。今月を 1 か月目として既定 36 か月（1〜60）。

| 項目 | 式 |
|---|---|
| 起点 opening_balance | 対象口座の最新残高の合計（as_of_date 最大 → seq 最大）。残高が無い口座は 0 |
| 予定 planned_in / out | active な台帳の項目の期日を月に割り当てる。今月は**明日から**月末まで（今日の分は残高に反映済みとみなす） |
| 予定外 unplanned_out | 今月より前の直近 `unplanned_lookback_months` か月のうち「対象口座の最初の明細の月より後」の月について、(その月の対象口座の出金合計 − その月に期日があった予定の out) の中央値。負なら 0 |
| 予定外から除く明細 | transfer / charge は**両側とも対象口座**のときだけ、card_settlement はパターンが合う**対象のカード口座**があるときだけ |
| 履歴から引く予定 | 停止した項目も含め（期日は anchor_date・end_date から出す）、account_id が NULL か対象口座のもの |
| unplanned_in | 同じ式を入金で。`include_unplanned_income = true` のときだけ残高に足す（既定 false） |
| 今月の按分 | 予定外 × (月の日数 − 今日の日) ÷ 月の日数（Math.round） |
| balance_end | 前月末 + planned_in − planned_out + unplanned_in − unplanned_out |
| reserve（月ごと） | その月末の翌日から `reserve_months` か月の予定支出の合計 |
| reserve（トップ） | 今日から reserve_months か月（今日を含み、応当日の前日まで）の予定支出の合計 |
| margin | balance_end − その月の reserve |
| first_shortfall_month | margin が初めて負になる月（無ければ null） |
| min_month | margin が最小の月 `{month, balance_end, margin}`（同じなら早い月） |
| cut_per_month_to_survive | 予定外の支出の目安を毎月いくら減らせば全期間で margin ≥ 0 になるかの最小の整数（今月の按分も減らした目安でし直す。二分探索）。不足が無ければ 0、目安を 0 にしても足りなければ null |

警告: `no_balance`（残高が無い口座。カードは出さない）、`stale_balance`（as_of_date が今日 − 7 日より前）、`short_history`（使える月が lookback に満たない。0 か月なら目安は 0）。
中央値は偶数個なら中央の 2 つの平均を丸める。

## 9. 期日の通知（`src/cashflow/upcoming.ts`、T305・V4）
- `dueSoonCount`: active な項目のうち、次の期日（今日を含む）の `notify_days_before` 日前（既定 14）〜当日に入る件数。`GET /api/documents/counts` の `upcoming` に出す。
- プッシュ通知はしない。PWA のバッジ表示は「お金」タブ（T111）が入ってから。MCP の `list_upcoming` は P2。

## 10. API（すべて認証の後。書き込みは actor=user で監査に残す）
| メソッド・パス | 引数 | 応答の要点 |
|---|---|---|
| GET /api/accounts | ― | `{accounts}`。列 + sync_status + latest_balance |
| POST /api/accounts | `{name, kind}` | 201。CSV だけの口座（source=csv） |
| PATCH /api/accounts/:id | default_tag・mcp_visibility・include_in_cashflow・card_settlement_account_id（bank の口座だけ）・card_settlement_pattern（1〜200 字）・active | 変わった列を `money_account.updated` に |
| POST /api/bank/sync | ― | `{job_id, created}`。未完了があるか 10 分以内なら積まない |
| GET /api/bank/status | ― | 口座ごとの last_sync_at・last_ok_at・last_error・last_csv_at・backfill_done_until |
| GET /api/bank_txns | from・to・account_id・tag・category（none = 未分類）・side・amount_min・amount_max・q（正規化して部分一致）・excluded（0/1）・vendor_key（description_norm の完全一致、1〜200 字）・receipt（§15）・cursor・limit（1〜100） | `{items, next_cursor}`。items に tag・category・tag_source・excluded・transfer_kind・receipt・receipt_hint |
| GET /api/summary/monthly | `month=YYYY-MM` か `from&to`（最大 36 か月） | MonthlySummary か `{months}` |
| GET /api/bank/overview | ― | ホーム用。balances（対象口座の最新残高。カードは null で total に入れない）・reserve・available（total − reserve）・untagged_count・cards_without_settlement・open_candidates・upcoming_due・this_month（income・expense は月次集計のうち対象口座の分、all_income・all_expense は全口座、残りは今月 1 か月の資金繰り表）。untagged_count は一覧（`tag=unset`）と一致させるため全口座・sync・receipt_waiting_count（§15）（`src/bank/overview.ts`） |
| GET /api/balance_history | months（1〜60、既定 12） | `{months: [{month, total, by_account}]}`。対象口座のうちカード以外の月末残高（月末〈今月は今日〉までの account_balances の最後と、明細の最後の balance のうち日付が新しいほう。同じ日なら account_balances。今日より後は見ない。無ければ 0）（`src/bank/balanceHistory.ts`） |
| POST /api/bank_txns/:id/tag | `{tag, category?}` | version・learned_rule・effective |
| GET / POST /api/tag_rules、DELETE /api/tag_rules/:id | account_id?・pattern・match・tag・category? | 手で作るのは origin=manual |
| GET /api/categories | ― | 12 種と未分類のラベル |
| GET /api/scheduled_items | `all=1` で停止中も | `{items}` |
| POST /api/scheduled_items、PATCH /api/scheduled_items/:id | name・amount・direction・category・recurrence（once/monthly/bimonthly/quarterly/yearly/biennial）・anchor_date・account_id?・end_date?・notify_days_before?（0〜365、既定 14） | out に income は不可。origin は変えられない |
| POST /api/scheduled_items/:id/deactivate・/activate | ― | active を切り替え |
| GET /api/scheduled_items/upcoming | days（1〜1096、既定 30） | 今日〜今日 + days（両端を含む）の期日順 |
| GET /api/recurrence_candidates | state? | `{candidates}`。各候補に description（occurrences_json の最後〈最新〉の明細の正規化前の摘要）・account_name（口座名）。見つからなければ null |
| POST /api/recurrence_candidates/detect | ― | `{created, updated}` |
| POST /api/recurrence_candidates/:id/accept | category?・name?・amount? | `{candidate, item}` |
| POST /api/recurrence_candidates/:id/dismiss | ― | 候補 |
| GET /api/cashflow | months（1〜60、既定 36） | Forecast（§8 の各項目と months[]・warnings） |
| GET /api/status | ― | `bank: {accounts, last_ok_at, errors, latest_txn_date}` が増えた |
| GET /api/documents/counts | ― | `upcoming` が増えた |

期日は anchor_date から周期の月数を足して出し、応当日が無い月は月末（31 日起点 → 4/30、2/29 起点の毎年 → 平年は 2/28）。毎回 anchor_date から数えるので 31 日の月には 31 日に戻る。

## 11. 設定（config.toml。知らないキーはエラー）
| キー | 既定 | 意味 |
|---|---|---|
| [bank] backfill_from | 2025-01-01 | 過去の明細を取り始める日（V8） |
| [bank] dedup_date_window_days | 0 | API と CSV の照合の日付幅 |
| [bank] transfer_window_days | 3 | 振替の日付差の上限 |
| [bank] match_date_window_days | 3 | 明細⇔証憑の照合の日付の幅（カード以外の口座。§15） |
| [bank] match_card_date_window_days | 10（0〜31） | 同じくカードの口座の幅 |
| [cashflow] unplanned_lookback_months | 6（最大 24） | 予定外の目安に見る月数 |
| [cashflow] reserve_months | 3（最大 12） | 残す額に積む予定支出の月数 |
| [cashflow] include_unplanned_income | false | 予定外の収入の目安を残高に足すか |

コードの定数（設定に無い）: 振り返り 35 日、backfill 3 か月、ページ 100 件・上限 50 ページ、今すぐ同期の間隔 10 分、周期検出の対象 26 か月・±5%、残高の鮮度 7 日、通知の既定 14 日、学習の閾値 3 回。

## 12. 運用の注意
1. **カードの引落元とパターンを必ず設定する。** カード口座を PATCH で `card_settlement_account_id`（銀行口座）と `card_settlement_pattern`（引き落としの摘要に含まれる文字）にしないと、カードの利用と銀行の引き落としが両方とも支出になる（月次・周期検出・資金繰りの予定外の目安のすべて）。パターンに何を入れるかは銀行の摘要を見て決める【推測: 例「ミツイスミトモカード」のようなカナ表記】。
2. **資金繰りの対象から外す口座**は `include_in_cashflow = false`、使わない口座（切り替え前の事業所など）は `active = false`。外した口座が相手の振替は、資金繰りの予定外の目安では除かれず出金として数える。
3. **収入は予定台帳に入れないと予測に乗らない。** 周期検出は支出だけを拾い、予定外の収入は既定で足さない。売上・給与などは `direction=in`・`category=income` で手入力する。
4. CSV だけの口座（PayPay など）は、CSV 取り込みも手入力の残高 API もまだ無いので、資金繰りでは残高 0（no_balance の警告）になる。
5. 周期検出は daily で前日までの明細を使う。同期の直後に見たいときは `POST /api/recurrence_candidates/detect`。
6. 過去分は 1 回の同期で 1 区間（3 か月）ずつ進む。backfill_from = 2025-01-01 なら、2026-11 に始めた口座は初回を含めて 8 回の同期で届く（初回 3 か月 + 3 か月 × 7 回）。

## 13. 未実装・次にやること
| 項目 | 状態 | 止まっている理由 |
|---|---|---|
| T105 CSV インポーター + PayPay パーサー | 未着手（csv_imports 表と dedupAndInsert だけある） | PayPay CSV のサンプル（ユーザー） |
| CSV 取り込み後の振替検出 | 未着手 | T105 の後。今は sync_bank の後にしか検出しない |
| 手入力の残高（account_balances の source=manual） | API なし | T105 と一緒に足すのがよい【推測】 |
| 振替の組を外す API（rejectTransfer は実装済み） | API なし | T111 の明細画面と一緒に |
| T109 freee 側のルール（私用を処理済みに） | 未着手 | T003（F17）、V9・V12 |
| T111 PWA「お金」タブ・T304 資金繰り表の画面 | 進行中（本ブランチには無い） | ― |
| T306 税額の概算 | 実装済み（PR1: 所得税・住民税・国保・事業税・国民年金。§14）。PWA の画面（T307e）・消費税・振替納税の日付・明細からの年換算は未実装 | PR2 |
| P2 MCP（get_cashflow・list_upcoming・list_bank_txns 等） | 未着手 | K1〜K3・V2 |
| 月次・資金繰りのグラフ | P4 | ― |

## 14. 税・保険の見積もり（`src/cashflow/tax/`、T306・T307 PR1）
年ごとの所得（前年の確定値 + 今年〜の見込み、手入力）と税プロファイルから、所得税・住民税・国民健康保険税・個人事業税・国民年金の**期日と額を概算**し、予定台帳に `origin = estimate` の項目として入れる。入力が変われば差し替える。目的は「いつ・いくら口座から出るか」を ±1〜2 割で先に知ること（税額の正確さではない）。消費税は PR2（作らない。`consumption_mode = 'unset'` なら `consumption_tax_mode_unset`、exempt 以外の方式なら `consumption_tax_not_implemented` の警告）。0 円以下になった期は作らない。自動車税・車検は対象外（周期検出・手入力のまま）。

| ファイル | 中身 |
|---|---|
| `src/db/migrations/0008_tax.sql` | tax_profile（id='default' の 1 行）・tax_years（UNIQUE(year)）・tax_estimate_runs（追記専用）。scheduled_items に `estimate_key`（origin=estimate のときだけ、不変）と `pinned`（0/1、origin=estimate のときだけ）、部分 UNIQUE INDEX `(estimate_key) WHERE active = 1 AND estimate_key IS NOT NULL` |
| `src/cashflow/tax/rates.ts` | 年度別の法定の数値（§14.3）。定義の無い年は前の年の値 |
| `src/cashflow/tax/engine.ts` | 純関数 `estimate(profile, years, window) → {items, warnings, breakdown}` |
| `src/cashflow/tax/sync.ts` | 入力の検査・保存（監査 `tax_profile.updated` / `tax_year.updated`）と、台帳への同期（§14.2） |
| `src/web/routes/tax.ts` | API（§14.4） |

### 14.1 計算
所得 = 事業所得（青色申告特別控除の後）。tax_years の `business_income` があればそれ、無ければ `revenue − expenses − 青色控除`（負なら 0）。丸め: 課税所得は 1,000 円未満、税額・保険料は 100 円未満を切り捨て。分割は 2 期目以降を「総額 ÷ 期数」の 100 円未満切り捨て、端数は 1 期目。期日は名目の日が休日なら翌営業日（`holidays.json` の祝日 + 土日。祝日データの無い年は土日だけ）。

| key（estimate_key） | 決まる入力 | 式 | 期日 | category |
|---|---|---|---|---|
| `income_tax:Y:final` | Y の所得・社会保険料（Y が actual で social_insurance_paid があればそれ、無ければ年金 + 国保の見積もりのうち名目の期日が Y 年のもの）+ other_deductions・基礎控除・配偶者/扶養 38 万 × 人数 | 課税所得 → 速算表 → + 復興 2.1% = 申告納税額。Y が actual で income_tax_final があればそれ。− Y の予定納税（actual の prepaid_income_tax があればそれ、無ければ見積もり）。0 以下なら作らない | Y+1 の 3/15 | tax |
| `income_tax:Y:prepay1`・`prepay2` | Y−1 年分の申告納税額（予定納税基準額） | 15 万以上なら各 1/3 | Y の 7/31・11/30 | tax |
| `resident:Y:q1`〜`q4` | Y−1 の所得・社会保険料 | (所得 − 社保 − other − 43 万 − 33 万 × 人数) × 10% − 調整控除 2,500 + 均等割 5,000 | 6/30・8/31・10/31・Y+1 の 1/31 | tax |
| `nhi:Y:p1`〜 | Y−1 の所得・加入人数・40〜64 歳の人数・プリセット | 課税標準 = 所得 − 43 万。区分ごとに 所得割 + 均等割 × 人数（+ 平等割）を 100 円未満切り捨て、上限で抑える。介護分は 40〜64 歳の人数だけ | nhi_first_month（7）から nhi_installments（8）期、毎月末 | insurance |
| `biz_tax:Y:1`・`2` | Y−1 の青色控除前の所得 | (所得 − 290 万) × biz_tax_rate。biz_tax_rate が NULL か、(所得 − 290 万) が 0 以下なら作らない。1 万円以下は 8 月に一括 | 8/31・11/30 | tax |
| `pension:F:MM` | pension_mode・pension_addon | monthly: 月額（+ 付加 400）を毎月末。prepay6: 4 月末・10 月末。prepay12: 4 月末。prepay24: 偶数の年度の 4 月末 | 月末 | insurance |

- 国民年金の月払いは「その月の分をその月末」に置いている。実際の納期限は翌月末なので 1 か月ずれる（概算として許容）。
- 2 年前納は「偶数の年度の 4 月」に仮置きしている（実際に始めた年度に合わせるなら rates ではなく engine.ts の判定を変える）。

- 入力が無い年: 直近の前の年の所得を繰り越す（内訳に `carried_from`）。住民税・国保・事業税で Y−1 がどこにも無ければ Y の所得で代える（`assumed_prev_year`）。予定納税は前年の申告納税額が要るので代えない。所得が出せない年は警告 `income_missing`。
- 項目名は「所得税 2026 年分 確定申告（見積）」「住民税 2026 年度 第 1 期（見積）」「国民健康保険税 2026 年度 第 1 期（見積）」「国民年金 2026 年度 4 月分（見積）」の形。
- 概算で切り捨てるもの: 生命保険料・医療費・寄附金の控除、国保の低所得軽減、住民税の調整控除の厳密計算・非課税限度、事業税の専従者控除・損失繰越、源泉徴収の精算、配偶者控除の所得制限。

### 14.2 再計算と台帳の同期ルール
契機: `POST /api/tax/recalculate`、`PUT /api/tax/profile`・`PUT /api/tax/years/:year` の直後（同じトランザクション）。daily では走らせない（rates.ts を更新したリリースの後に 1 回手で叩く）。
対象の期間: 今年の 1/1 〜 今日 + 39 か月（36 か月 + 3 か月）。過去の期日も作る（forecast が履歴から予定分を引くので、過去の納付が予定外の中央値に混ざらない）。1 回ごとに tax_estimate_runs に 1 行（inputs_json = profile + years、results_json = 項目・内訳・skipped_pinned）。

| 状況 | 動き | 監査 |
|---|---|---|
| key が無い（有効な行が無く、最新の停止した行も pinned でない） | create（origin=estimate、recurrence=once、category は §14.1、account_id = payment_account_id、notify_days_before = 30） | scheduled_item.created actor=system payload.run_id・estimate_key |
| key があり amount・anchor_date が同じ | 何もしない | — |
| key があり amount・anchor_date・name・account_id のどれかが違う、pinned=0 | その行を in-place 更新（id は変えない。納税口座を後から入れたときも口座が揃う） | scheduled_item.updated actor=system payload.reason='tax_recalc'・run_id |
| key があり pinned=1 | 触らない。run の `skipped_pinned` に key と「計算値 vs 現在値」 | — |
| 今回の計算で key が出なくなった（期日が対象の期間にあるもの）、pinned=0 | deactivate | scheduled_item.deactivated actor=system payload.reason='estimate_withdrawn'・run_id |
| 同上で pinned=1 | 触らない。warnings に `pinned_withdrawn` | — |
| 人（actor が system 以外）が estimate 項目の name・amount・anchor_date を変える or 止める or 戻す | 自動で pinned=1（`src/cashflow/schedule.ts` の updateItem / deactivateItem / activateItem）。戻すとき同じ key の有効な行が既にあれば 400 `estimate_key_active` | 既存の updated / deactivated / reactivated（changes に pinned） |
| 人が PATCH `pinned: false` | 次の再計算で上書き対象に戻る | scheduled_item.updated |
| 同じ category で ±45 日・±10% の manual / detected の有効な項目がある | 作るが warnings に `possible_duplicate`（`item_ids`: [見積もり, 相手]）。自動で消さない | — |

origin は不変なので estimate ↔ manual の変換はしない。手で作った項目を見積もりに置き換えたいときは、manual を止めて再計算する。

### 14.3 法定の数値（2026 年時点）と出典
| 項目 | 値 | 出典 |
|---|---|---|
| 所得税 速算表 | 〜194.9 万 5% / 〜329.9 万 10% −97,500 / 〜694.9 万 20% −427,500 / 〜899.9 万 23% −636,000 / 〜1,799.9 万 33% −1,536,000 / 〜3,999.9 万 40% −2,796,000 / 4,000 万〜 45% −4,796,000 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm |
| 復興特別所得税 | 基準所得税額 × 2.1%（令和 9 年以後は防衛特別所得税と組み替え。合計率は不変） | 同上 |
| 基礎控除（所得税） | 令和 7・8 年分: 合計所得 ≤132 万 95 万 / 〜336 万 88 万 / 〜489 万 68 万 / 〜655 万 63 万 / 〜2,350 万 58 万。令和 9 年分〜: ≤132 万 95 万 / 〜2,350 万 58 万。2,350 万超は 48 / 32 / 16 / 0 万 | https://www.nta.go.jp/users/gensen/2025kiso/index.htm / https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm |
| 配偶者・扶養控除（一般） | 所得税 38 万、住民税 33 万 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1191.htm / https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1180.htm |
| 青色申告特別控除 | 65 万 / 55 万 / 10 万 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2072.htm |
| 予定納税 | 基準額 15 万円以上。7 月・11 月に各 1/3 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2040.htm |
| 住民税（さいたま市） | 所得割 市 8% + 県 2%。均等割 市 3,000 + 県 1,000 + 森林環境税 1,000 = 5,000。基礎控除 43 万。調整控除 2,500（単身で仮置き）。普通徴収 6 月末・8 月末・10 月末・翌 1 月末（令和 8 年度: 6/30・8/31・11/2・2027-02-01） | https://www.city.saitama.lg.jp/001/153/004/002/001/001/p013654.html / https://www.city.saitama.lg.jp/faq/001/001/003/p110417.html / https://www.city.saitama.lg.jp/001/153/004/003/p013060_d/fil/8nennouki.pdf / https://www.pref.tochigi.lg.jp/b07/life/zeikin/zeikin/documents/09r7zeiseikaiseinogaiyou.pdf |
| 国保（さいたま市 令和 8 年度、プリセット `saitama-city-2026`） | 医療 7.64% + 43,300 上限 67 万 / 支援 2.73% + 14,900 上限 26 万 / 介護（40〜64 歳）2.37% + 16,100 上限 17 万 / 子ども・子育て 0.26% + 1,700 上限 3 万。平等割なし。基礎控除 43 万。8 期 = 7 月末〜翌 2 月末。計算例: 42 歳・所得 300 万 → 409,900 円 | https://www.city.saitama.lg.jp/001/153/002/004/p010020.html / https://www.city.saitama.lg.jp/faq/001/001/003/p110417.html |
| 個人事業税（埼玉県） | 事業主控除 290 万。第 1 種・第 3 種 5%。8 月・11 月（1 万円以下は 8 月一括） | https://www.pref.saitama.lg.jp/a0209/z-kurashiindex/z-2-4.html |
| 国民年金 | 2026 年度 17,920 円/月、2027 年度 18,290 円/月。付加 400 円/月。口座振替前納（2026 年度）: 6 か月 106,300 / 1 年 210,530 / 2 年 417,150（2027 年度の前納額は未公表のため 2026 年度の値を使う） |

年度の値の更新（年 1 回）: 新しい年度の値が公表されたら `src/cashflow/tax/rates.ts` の表に年のキーを足し（2027 年度の前納額は公表され次第 `PENSION_RATES[2027]` を書き換える）、リリースの後に `POST /api/tax/recalculate` を 1 回叩く。 https://www.nenkin.go.jp/service/kokunen/hokenryo/zenno.html / https://www.city.saitama.lg.jp/001/153/003/005/p082987.html |

### 14.4 API（すべて認証の後。書き込みは監査に残す）
| メソッド・パス | 引数 | 応答の要点 |
|---|---|---|
| GET /api/tax/profile | ― | `{profile（無ければ null。revenue_includes_tax・pension_addon・spouse は boolean、nhi_rates_json はオブジェクト）, years, presets: [{id, label}], missing}`。missing は `profile`・`actual:<前年>`・`estimate:<今年>`・`consumption_mode` |
| PUT /api/tax/profile | プロファイルの列（知らないキーは 400。無いキーは今の値、プロファイルが無ければ PR1 の既定値。nhi_rates_json はプリセットが無いとき 4 区分すべての rate・per_capita・cap が要る。キーを並べて保存） | `{profile, run}`。同じトランザクションで再計算 |
| PUT /api/tax/years/:year | kind（新しい年は必須）・revenue・expenses・business_income・social_insurance_paid・income_tax_final・consumption_tax_final・prepaid_income_tax | `{year, run}`。同上 |
| POST /api/tax/recalculate | ― | `{run_id, created, updated, deactivated, skipped_pinned[], warnings[]}` |
| GET /api/tax/estimates | ― | 最新の run の `{run_id, created_at, window, items（kind・year・key・amount・due・lines・income_year・assumed_prev_year・carried_from）, breakdown, skipped_pinned, warnings}`。まだ無ければ run_id: null |
| PATCH /api/scheduled_items/:id | `pinned`（boolean。estimate 以外は 400 invalid_pinned） | GET /api/scheduled_items の items に estimate_key・pinned が増えた |
| GET /api/cashflow | ― | months[].items に origin・estimate_key・pinned が増えた。warnings に `tax_profile_missing` / `consumption_tax_mode_unset` / `consumption_tax_not_implemented`（方式は設定済みだが PR1 は消費税を作らない） |

PR1 の既定のプロファイル: blue_return='65'、consumption_mode='unset'、revenue_includes_tax=1、biz_tax_rate=NULL、resident_pay_mode='ordinary4'、nhi_preset='saitama-city-2026'、nhi_members=1、nhi_members_40_64=0、nhi_installments=8、nhi_first_month=7、pension_mode='monthly'、pension_addon=0、spouse=0、dependents=0、other_deductions=0、payment_account_id=NULL。

## 15. 照合（`src/bank/match.ts`、T206・T207）
明細と証憑（documents）の組を `txn_matches`（0009_matches。追記専用、組ごとに seq 最大の行が効く）に残す。候補は保存せず読むたびに計算する。

| 用語 | 定義 |
|---|---|
| 経費の明細 | 効くタグが business・side = expense・振替の除外（§4）でない・active な口座の明細 |
| 照合の候補にできる明細 | 経費の明細 + タグが unset の支出（private は入れない） |
| 候補にできる証憑 | status が rejected / duplicate / personal 以外。値は最新の reviews の版、無ければ最新の extractions |
| 有効な紐付け | 組の最新が auto か confirmed で、証憑が候補にできる状態。auto は証憑の今の金額 = 明細の金額のときだけ |
| 候補 | 金額が等しく、証憑の日 − 1 ≤ 明細の日 ≤ 証憑の日 + W（カードは `match_card_date_window_days`、それ以外は `match_date_window_days`）。組に行がある（rejected を含む）か、どちらかが有効な紐付けを持つなら除く |
| score | 相手名の一致（証憑の vendor を正規化し、短いほうが 3 文字以上でどちらかが他方を含む）で 50 + max(0, 50 − 5 × \|日付差\|) |

| receipt（経費の明細だけ。それ以外は null） | 条件 |
|---|---|
| matched | 有効な紐付けの証憑のうち 1 件以上が approved / sent / verified |
| pending_review | 有効な紐付けはあるが、証憑が確認前 |
| candidate | 有効な紐付けが無く、候補が 1 件以上 |
| waiting | どれでもない（領収書待ち） |

- 自動照合（`runMatching`）: 明細から見ても証憑から見ても候補が 1 件ずつで、相手名が一致するか日付差が 1 日以内なら state=auto（actor=system）を追記し、監査 `txn_match.auto`（bank_txn_id・document_id・score だけ）。それ以外は書かない。外した組は作り直さない。
- 呼ぶところ: sync_bank の振替検出の後・CSV 取り込みの後・extract の成功後・確定の後・daily の段 `match`。失敗しても呼び元は失敗にせず、ログと監査 `txn_match.failed` に残す。
- receipt_hint: 経費か unset の支出に有効な紐付けがあるとき、最後に紐付けた証憑の `{document_id, status}`（unset の明細に証憑が付いたら「事業の候補」として目立たせる）。
- 人の紐付けは 1 明細に複数の証憑・1 証憑に複数の明細でよい（分割の請求）。自動は 1 対 1 だけ。
- 領収書待ちの一覧: `GET /api/bank_txns?tag=business&side=expense&excluded=0&receipt=waiting`。ホームの件数は overview の `receipt_waiting_count`（今日の 12 か月前の月初〜今日）。

| メソッド・パス | 引数 | 応答の要点 |
|---|---|---|
| GET /api/bank_txns/:id/matches | ― | `{links: [Link], candidates: [Candidate]}`（候補は score の高い順・最大 10 件。照合の候補にできない明細なら空）/ 404 |
| POST /api/bank_txns/:id/matches | `{document_id}` | 201 `{link, warnings}`（`amount_mismatch`・`date_out_of_window`。拒否はしない）/ 400 document_id_required / 404 not_found・document_not_found / 409 already_linked / 422 document_not_matchable。監査 `txn_match.linked` |
| POST /api/bank_txns/:id/matches/:document_id/unlink | ― | 200 `{link}`（state=rejected を追記）/ 404 / 409 not_linked。監査 `txn_match.unlinked` |
| GET /api/documents/:id/matches | ― | `{links: [Link]}`（有効な紐付けだけ）/ 404 |

Link は `{bank_txn_id, document_id, state, actor, score, created_at, document: DocBrief, txn: TxnBrief}`、Candidate は `{document_id, score, date_diff, vendor_match, document: DocBrief}`。DocBrief は `{id, status, kind, source, txn_date, amount, vendor, thumbnail_url}`（PDF は thumbnail_url = null）、TxnBrief は `{id, account_name, txn_date, amount, description}`。
