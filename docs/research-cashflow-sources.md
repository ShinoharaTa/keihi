# キャッシュフローの取得元の調査（2026-11-04、spec-writer）

requirements-v2.md Q2「ME の Web UI 自動操作以外に MCP / API が使えないか」への回答。出典 URL 付き。【推測】は未検証。

## 結論
- **推薦（ME にこだわらない場合）: MF クラウド確定申告に全口座・カードを直接連携し、keihi は Public API v3 の `GET /connected_accounts` と `GET /transactions` で明細を読んで自前 DB に記録する。PayPay 残高払いは PayPay アプリの CSV を keihi に取り込む。** Q1（MF でいく）と矛盾せず、追加費用 0 円、規約上の問題も無い。ME はスマホで見るだけの家計簿として残せる。
- 次点: freee 個人（スタンダード、年 23,760 円）の口座同期と `GET /api/1/wallet_txns`。公式 MCP（`https://mcp.freee.co.jp/mcp`）あり。会計を freee に戻す場合だけ選ぶ。
- **ME にこだわる場合: Playwright で Web UI を自動操作する。** ただし規約違反のリスクがあり、headless では 403 が返るという報告もあるので、壊れても困らない「補助」に限る。ME の公式 API は無い。ChatGPT 向けアプリはあるが keihi からは使えない。
- **どの手段でも PayPay（残高払い）は自動では取れない。** PayPay が API を出していないため。PayPay カード・PayPay 銀行は別で、自動連携できる。

## 比較表
| 手段 | 取得方法 | PayPay | 安定性 / 規約リスク | 費用 | MCP |
|---|---|---|---|---|---|
| A MF クラウド確定申告 + API v3 | 公式 REST（API キー） | CSV（手動） | ◎ / ◎ | 既存契約のまま 0 円 | ○ 公式 beta（会計向け） |
| B freee 個人 + wallet_txns | 公式 REST（OAuth） | CSV（手動） | ◎ / ◎ | スタンダード 年 23,760 円 | ◎ 公式 Remote MCP |
| C ME の Web 自動操作 | Playwright | ME への CSV 取り込み経由（iOS のみ） | △ / ✗ | 連携 5 件以上ならプレミアム 月 540 円 | ✗ |
| D ME 公式の ChatGPT アプリ | ChatGPT 内からのみ | ― | ― | ― | ✗ keihi からは使えない |
| E Zaim API | OAuth1 | CSV | ✗ 2026-12-07 に終了 | ― | 非公式のみ |
| F Moneytree LINK API Private | REST | ✗ | ○ / ○ | 法人限定 | ✗ |

## 各手段の詳細
### A. MF クラウド確定申告（transactions.md §1, §2.1 の調査済み事実）
- 自動取得した明細は `GET /transactions` で読める（1 ページ最大 500 件）。口座一覧は `GET /connected_accounts`（連携分も返る、2026-07-14 から）。仕訳は `journalize` で作れる。
- `POST /transactions` は手動管理の連携サービスに限って使える → PayPay の CSV を「手動口座」として MF 側にも送れる【推測・要 PoC】。
- PayPay カードとは 2022-06 から連携可。https://biz.moneyforward.com/support/tax-return/news/new-feature/20220629.html
- PayPay 銀行は口座によっては残高しか取れない（2023 年 FAQ）。https://biz.moneyforward.com/support/tax-return/faq/specificinformation/paypay-bank.html
- **既存 docs の訂正:** 「Public API は個人向けプランでは停止」は誤り。plans-comparison.md §0 / transactions.md の結論は「プランによる制限は書かれていない。ミニで 403 にならないか要 PoC」。「停止」は freee の**解約後**の話（plans-comparison.md §2.3）との混同。
- 【推測】私用の口座やカードも会計側に連携することになる。私用分は keihi が「対象外」として扱う設計が要る。

### B. freee
- 公式 MCP: https://github.com/freee/freee-mcp（Apache-2.0、2026-11-03 にも push）。Remote 版 `https://mcp.freee.co.jp/mcp`。`freee_api_get` / `post` / `put` などの汎用ツールで wallet_txns も叩ける。
- PayPay との API 連携は無く CSV 取り込みで対応（2026-03 の解説記事。公式ヘルプは未確認）。https://freeerapper.vercel.app/blog/freee-paypay
- スターターは keihi に使えない（ファイルボックス月 5 枚まで。plans-comparison.md §0）。

### C. ME の Web 自動操作
- 規約（2024-11-01 改定）第 13 条 43 号「正式には公開されていない操作方法、及び本サービス利用契約において定められた方法以外の方法によって…サービスを利用する行為」を禁止。41 号も「システム的アクセス行為等」を禁止。https://moneyforward.com/terms
- 非公式の実装例:
  - mfme-cli: 初回のみ画面ありブラウザでログインしセッション保存、以降 headless。取引の取得とメモ・カテゴリ更新。https://github.com/TakashiAihara/mfme-cli
  - oshiro の記事（2026-04-22）: メール + PW + TOTP でログインし 1 日 2 回取得。https://oshiro-kazuma.github.io/tech-notes/playwright-mf-scraping.html
  - moyuu-az PR（2026-11-02）: 「MF はヘッドレス Chrome を 403 で拒否」「Playwright 経由だと Google ログインも拒否」。https://github.com/moyuu-az/userscripts/pull/4
  - 【推測】このサーバーで画面ありブラウザを動かすには xvfb が要る（apt、sudo 要）。
- reCAPTCHA に触れた資料は無し。
- CSV: プレミアム限定。アプリ版は 1 年単位、Web 版は 1 か月単位（二次情報）。https://support.me.moneyforward.com/hc/ja/articles/24478005732889
- 料金: スタンダード 月 540 円 / 年 5,940 円（2025-08-05 改定）。https://support.me.moneyforward.com/hc/ja/articles/48081250560409
- 無料で連携できるのは 4 件まで（二次情報）。

### D. ME の ChatGPT アプリ（2026-09-17 開始）
- ChatGPT 内で入出金・家計簿・資産を読み取り専用で参照。Claude / MCP への言及無し。https://corp.moneyforward.com/news/release/service/20260917-mf-press-3/
- 【推測】Apps in ChatGPT は MCP ベースだが接続先・OAuth クライアントは非公開。keihi からは使えない。

### E〜F. その他
- Zaim: 新規アプリ登録は 2026-11-09 終了、API 自体も 2026-12-07 終了。後継無し。https://content.zaim.net/notices/show/2280
- Moneytree LINK API Private: 法人限定。https://getmoneytree.com/jp/link/link-api-private
- OsidOri: 公開 API 見つからず。

### PayPay 本体
- アプリから CSV を出せる（2025-02 開始）。過去 2 年分、1 回 365 日まで。https://paypay.ne.jp/notice/20250206/f-transactionhistory/
- API は無い。https://www.itmedia.co.jp/news/articles/2510/31/news087.html

## keihi 側に残る未決
- 案 A の採否。私用の口座も MF クラウドに連携してよいか、ME は残すか → ユーザー
- ミニの API キーで `GET /transactions` / `connected_accounts` が通るか、連携口座数の上限 → PoC
- PayPay CSV の取り込み経路（PWA アップロード / MCP にファイル）と頻度 → ユーザー / spec-writer
- PayPay 明細を MF の手動口座へ `POST /transactions` で送るか、keihi 内だけで持つか → PoC 後
- 取得頻度・保持期間（Q2c）、Web UI で見たいもの（Q3a）→ ユーザー
- ME 自動操作を補助として残すか（規約リスク）→ ユーザー
- 未確認: freee 公式ヘルプの PayPay 記述、ME CSV の列形式、MF クラウドの明細 CSV インポート
