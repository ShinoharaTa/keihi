# keihi v2 と旧決定の差分（spec-writer, 2026-11-05）

出典は既存の docs と src だけ。MF の事実は 10 月の調査結果をそのまま使っており、今日は再確認していない。【推測】と書いたものは確認していない。

## 1. 差分表
| 旧決定（出典） | 旧内容 | v2 での変化 | 対応案 |
|---|---|---|---|
| Y1・README§3.0・freee-codex§1 | freee スタンダードに 2027-01-01 から切替 | MF 継続 | 撤回 |
| Y2・Y4・F1〜F16・T0-2'・F15・G1 | freee のテスト事業所で PoC、本番はお試し、G1 = freee 契約 | 前提が無くなる | 撤回。PoC は v0.1 T0-2 の P1〜P8 と transactions§8.2 の P9〜P18 に戻す。G1 は決め直す（N5） |
| Q2・Q8（architecture§5） | mvp-plan v2 で削除 | MF のプランと、API が使えるかが再び前提 | 復活（N3・N10） |
| P5（transactions§9） | 本番の事業者で書き込みの PoC | MF にはテスト環境が無く、証憑も消せない | 要ユーザー判断（N4） |
| Y3 | MF は申告まで繋いだら無償にする | MF を 7 年使う | 修正: 更新日の確認は残す。論点はプランの選択に変わる（N3） |
| D9・T1-10・T1-15 | freee OAuth（flock・90 日更新）、1 日 3,000 回の予算 | MF は API キー（期限なし。1 時間の JWT に交換）、1 トークン 3 回/秒 | D9 の原案（API キー）に戻す。予算の仕組みは秒単位の間隔制御だけに縮める |
| T1-11・T2-12・R11・保存から 70 日の期限 | 撮ったらすぐ POST /receipts、検索項目は後で PUT | MF は検索項目を渡せず、後から紐付けもできない | 撤回。§2 の案で置き換える |
| R7（legal§7）・README§2 | 撮影直後にアップロード | MF では仕訳 ID 無しの証憑は電子取引扱い | 修正: 電子取引（PDF・EC）はすぐ送る。紙は §2 の案に従う |
| R12・R13 | MF: 仕訳の後に journal_id 付きで証憑、ID の対応表 | 主経路に戻る | 据え置き。R13 の列を remote_journal_id / remote_voucher_ids にする |
| D8・v0.1§5.1 分岐 A/B/C | 仮仕訳（v2 で削除済み） | 矛盾を解く候補として戻る | 要判断（§2 案 B、N2） |
| Q3・税理士#3・R4・D13 | freee は 64MB なので原本を加工せず送る | MF は 1 ファイル 5MB、1 仕訳 5 件まで | 修正: 5MB を超えたら、200dpi・24bit を割らないように再エンコードした派生を送る。原本は手元に残す。#3 を税理士に聞き直す |
| T4-1〜T4-4・Y5・deals の状態機械 | 未決済の deal + receipt_ids、ref_number で照合、消込は freee | MF は journals（照合キーは tags）と journalize | 撤回。Y5 は P3（連携カードは明細起点）に戻す。税理士 → ユーザー（N6） |
| U4' | 按分は 1 枚ごと（実装の既定） | journalize は相手勘定 1 つで、分けられない | 修正（N6） |
| P2'・P2 | 私用は freee の無視・プライベート | MF に対象外の API が無く、しかも私用口座も連携する（v2 の Q12） | 修正: 事業口座での私用は事業主貸で journalize。私用口座は N7 |
| M6・T6-6・K14（ルール提案） | freee の user_matchers を作る提案 | MF にルールの API が無い（画面と CSV だけ） | 修正: ルールは keihi の中だけに持つ。P10 は MVP 外のまま |
| T5-6・R19・ops/backup§7・procedures の年次書き出し | freee から証憑をダウンロードして sha256 を照合 | MF に証憑のダウンロード API が無い | 撤回: verifyRemote は voucher_file_ids があるかの確認だけにする。証憑を持ち出せるのは keihi の原本だけになるので R18 が重くなる |
| Y12・税理士#6 | freee は解約すると取引が見られないので 7 年契約 | MF は解約後も仕訳と Box を見られる | 撤回。CSV が出せない（ミニ・無償）件は税理士に残す |
| Y13・税理士#5・R20・電子取引の規程 | freee なら規程が必須 | MF Box は画面から上げるとタイムスタンプが付く。API 経由は未確認 | 修正: 規程は保険として作る（下書きは既にある）。タイムスタンプは PoC で確認 |
| Y14・税理士#7 | freee で 2027 年分から 75 万円控除 | MF でも狙える（仕訳履歴保存をオン + 届出） | 要判断（N12。期限は 12/31） |
| JIIMA の期限（procedures） | freee の 2027-10 | MF は 2028-03 | 修正 |
| D11'・K12・K13・T0-4 | freee の科目 ID・税区分コード | MF のマスタに置き換え | 修正。「Gemini は税率の区分だけ選び、サーバーが変換する」は据え置き |
| Q9・freee-codex§5.3 | 抽象化は残し、実装は freee だけ | 実装は MF だけ。freee に戻る可能性もある（v2 Q1 の暫定） | 修正: interface を MF の順序で作り直す（§2）。freee 実装は凍結（N11） |
| Y6 | MF の明細は読まない | 全口座を読むのが中核になる | 撤回 |
| P1・K3 | 明細を Gemini やエージェントに出すか（事業用の想定） | 私用の支出が全部入る | 修正（N8） |
| mcp.md§3.2・§6.5「残高・口座情報は返さない」 | 最小化 | R-D の目的は残高の推計 | 修正: 残高と月次集計の読み取りツールを足す（N8・N9） |
| mcp.md§3.3「取り込みは PWA だけ」・§4.6「確定は PWA だけ」 | エージェントは提案しかできない | v2「経費登録・領収書の処理を self agent から」 | **要ユーザー判断（N1）** |
| K10 | freee-mcp を本番に繋がない | MF の公式 MCP（beta）がある。API キーは仕訳の削除までできる | 修正: MF の MCP もエージェントに直接繋がない。MF に書くのは keihi だけ |
| K11・mvp-plan§1 の実施順 | G1 の後に M6 → M7 → M3 | G1 が無くなり、MCP が中核になる | 撤回。N5 で順序を決め直す |
| U10・P4・Y7〜Y10・Codex（freee-codex§4） | keihi の中に自然言語は入れない | v2 も MCP が中核 | 据え置き（入れないまま） |
| README§3.0「ミニ」・plans-comparison§5「MF に残る」 | ― | v2 と一致 | 据え置き。ただしミニの Box は累計 1,000 件までで、7 年の運用で効く（N3） |
| D1〜D7・D10・D12・K1・K2・K4〜K7・K9・U1〜U3・U5〜U9・Q4〜Q6・R1〜R3・R5・R6・R8〜R10・R14〜R18・R21・R22・税理士#2・#8・#9 | ― | 会計サービスに依存しない | 据え置き |

## 2. 実装への影響
- **規模**: src で freee に触れているのは 39 ファイル・6,272 行（src の .ts 全体は 8,718 行）。freee だけの部分は `src/providers/freee/` の 5 ファイル・1,253 行（auth 343・provider 450・budget 221・client 194・state 45）。
  - freee の順序が前提になっているもの: `worker/handlers/{uploadReceipt,updateReceiptMeta,send,reconcile,daily}`、`deals/{builder,stateMachine,reconcile}`、`masters/sync`、`backup/verifyRemote`、migration の 0001（`provider_uploads.meta_deadline_on`・`freee_calls`）と 0004（deals）。
  - テストは 29 ファイルが freee に触れている。
- **そのまま使えるもの**: 取り込み、原本の保存、監査のハッシュチェーン、営業日と期限、ジョブ、Gemini の抽出と検証、確認カード、取引先の辞書、紙原本の状態管理、restic。
- **Provider 抽象の評価: △。名前は中立だが、中身は freee の形。**
  1. 処理の順序が逆。interface は「証憑だけ上げる → 検索項目を更新 → 取引 → 上げ済みの証憑を紐付け」。MF は「仕訳 → journal_id 付きで証憑（ファイルを送り直す）」。`attachReceipts`・`updateReceiptMeta`・`findReceiptsByKey`・`downloadReceipt`・`deleteDeal` の 5 つは、MF では作れないか意味が変わる。
  2. `capabilities()` に `receiptMetaOnUpload` と `canLinkExistingReceipt` はあるが、パイプラインはこれで分岐していない。使っているのは `maxReceiptBytes` だけ（`uploadReceipt.ts:115`）。
  3. `DealPayment`（wallet / private_account_item）と数値の ID は freee のもの。MF の ID の型は【要確認】。
  4. 送信先が 5 ファイルで `PROVIDER = 'freee'` の定数になっている。config の `ProviderKind` も `'freee' | 'fake'` だけ。
  - → **Provider の差し替えでは済まない。** 即アップロード（T1-11）と送信の状態機械（T4-2）を MF の順序（queued → journal_created → voucher_attached → verified）で書き直す。【推測】4〜6 日。本番のデータがまだ無いなら migration は作り直してよい【推測: 未デプロイなら】。
- **MF v3 でできないことと、パイプラインへの影響**
  - 証憑に日付・金額・取引先を渡せない → 検索要件は仕訳に紐付けて満たすしかない。紙の証憑は、仕訳ができるまでスキャナ保存として完結しない。
  - 仕訳 ID 無しで上げると電子取引扱い。上げ済みの証憑を後から仕訳に付ける API も無い → 「すぐ上げて後で紐付け」が成り立たない。後から付けるとファイルの再送になり、Box に 2 件残る（消せない。ミニの 1,000 件も減る）。
  - 証憑の削除・ダウンロードの API が無い → 二重送信は取り返しがつかない。送る前に必ず `GET /journals/{id}` の `voucher_file_ids` を確かめる。sha256 の照合と API での持ち出しはできない。
  - 対象外にする API、ルールの API が無い → 振替や私用口座の明細は MF の画面での作業が残る。keihi は一覧を出すだけ。
  - journalize は相手勘定 1 つだけ → 複数税率や按分がある支出は `POST /journals` で作る。
- **legal.md の MF の注意（再掲。§0-2・§2.2・README§2）**: 仕訳 ID を付けずに API で上げた証憑は電子取引データ扱いになる。紙をスキャナ保存にするには、送る時点で仕訳が要る。一方、仕訳は確認の後でないと作れない。API で上げた証憑にタイムスタンプが付くか、区分が何になるかも未確認（§2.2 要確認 1〜3）。
- **解決案**
  - **案 A（推薦）: 業務処理サイクル方式を採る**（規程を作れば期限は 2 か月 + 7 営業日）。
    - 紙の証憑は「確定 → `POST /journals` → journal_id 付きで `POST /vouchers`」をまとめて行う。すぐ上げるのは電子取引だけ。
    - 期限の 5 営業日前に未確定なら警告し、期限を過ぎたら紙原本を保管する（R8）。
    - メリット: 帳簿に未確定の仕訳が載らない。Box に二重に残らない。今の「確定 → 送信」の流れに寄せられる。
    - デメリット: 規程を作る必要があり、税理士 #4 の確認が要る。確定を溜めると紙の保管が増える。
  - **案 B: 仮仕訳**（v0.1 の分岐 B・D8）。
    - 抽出の数分後に AI の値で仮仕訳を作り、journal_id 付きで証憑を上げる。確定したら `PUT /journals` で直す。期限は 7 営業日のままでよい。
    - デメリット: 未確定の仕訳と訂正の履歴が帳簿に残り、75 万円控除（優良帳簿）と相性が悪い。PUT の後も紐付けが残るかは PoC が要る（v0.1 P6）。
  - どちらの案でも、API で上げた証憑のタイムスタンプと区分を PoC で確かめるのが前提。付かなければ、どちらでも紙原本を保管する（分岐 C）。

## 3. 新たに生じる未決
| # | 内容 | 初期案 | 決める人 |
|---|---|---|---|
| N1 | self agent にどこまで許すか: (a) MCP から領収書を投入、(b) MCP から確定まで | (a) 許す（PWA と同じ取り込み API を通す）、(b) 許さない（PWA で確定） | ユーザー |
| N2 | 紙の証憑の送り方（§2 の案 A / B） | A | 税理士 #1・#4 → ユーザー |
| N3 | MF のプラン: ミニ（Box 累計 1,000 件・100MB・CSV ✗・消費税申告 ✗）か、パーソナル（年 22,560 円）か。あわせて更新日 | ミニで始め、800 件でパーソナルに上げる | ユーザー |
| N4 | 本番の事業者で PoC をしてよいか | 読み取りは本番で行う。書き込みは手動口座のダミーと、証憑 1 枚まで（Box に残るのを許容） | ユーザー |
| N5 | G1 と実施順 | MF PoC → 明細の同期と可視化 → MF への送信（帳簿は 2027-01-01 から）→ MCP → 資金繰り表 | ユーザー |
| N6 | 連携カード払いを明細起点（journalize）にするか領収書起点にするか。按分と複数税率の扱い | 明細起点。按分・複数税率は `POST /journals` | 税理士 → ユーザー |
| N7 | 私用口座を MF クラウド確定申告に連携してよいか（帳簿ソフトに私用の全履歴が載る。【推測】税務調査で見える）。MF 側では未処理のまま置くか、対象外にするか | ― | 税理士 → ユーザー |
| N8 | 私用の明細と残高を MCP に出すか（エージェントのモデル提供者に渡る） | 口座ごとに出すかを設定。私用口座は既定で集計値だけ | ユーザー |
| N9 | API で残高が取れるか【要PoC】 | 取れなければ、初期残高を手で入れて明細を積み上げる | PoC → spec-writer |
| N10 | ミニで連携できる口座の数と、取れる過去の期間【要PoC】 | 足りなければ各社の CSV | PoC |
| N11 | freee 実装の扱い | タグを打って凍結し、main からは消す。2 つの実装は保守しない | ユーザー |
| N12 | 75 万円控除を MF で狙うか（仕訳履歴保存を 12/31 までにオン） | 税理士 #7 次第 | 税理士 → ユーザー |

## 4. docs の構成案
- **正本にして書き直す**
  - requirements-v2.md → requirements.md。v2 の Q1〜Q15 は architecture.md の Q1〜Q9 と番号がぶつかるので、V1〜 に振り直す。
  - mvp-plan.md → v3（MF + 明細 + MCP 中核で書き直す）。
  - mcp.md（MF、残高のツール、N1 を反映）。
  - docs/ops の system-overview・procedures・backup§7・restore-drill（freee → MF）。templates/ の規程は残す。
  - README.md（索引と §3.0 の決定）。
- **新しく作る**
  - mf-api.md: architecture§1・transactions§2・plans-comparison§1・legal§2.2 に散らばった MF の事実と、PoC の結果を 1 か所にまとめる。
  - cashflow.md: R-A / R-B / R-D（明細の取り込み、CSV、予定支出、資金繰り表）。
- **一部だけ直す**
  - transactions.md: MF の §2・§4〜§7 を生かし、§3（自然言語）と U10 を消す。
  - legal.md: §6 を MF 版に戻し、N7 を足す。R4・R7・R11 に注記。
  - plans-comparison.md: freee の節は参考扱いにし、N3 を足す。
  - architecture.md: 冒頭に v2 の注記を入れる。§3.3 の MF の状態機械はそのまま生きる。
- **凍結して docs/archive/ へ移す**: freee-codex.md、mvp-plan.md の v2、mvp-plan-v0.1.md（分岐 A/B/C の原典として参照だけ）。
- **そのまま**: a2ui-review-ui.md、classification-ocr.md、research-cashflow-sources.md。
- **削除はしない**（経緯の記録として archive に残す）。
