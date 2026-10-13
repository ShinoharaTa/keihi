# keihi: 勘定科目分類（Kev）と OCR・プライバシーの検討ドラフト

調査日: 2026-10-13 / 担当: spec-writer / 実装なし
表記: 【事実】= 一次情報（リポジトリ・公式ドキュメント）で確認したこと。【推定】= 計算や類似事例から見積もったこと（要実測）。

## 0. 目的
- 個人事業主が領収書画像から「日付・金額・取引先・登録番号・税率区分・勘定科目」を少ない手間で正しく入力できるようにする。
- 制約: N100 / RAM 16GB（常時約 8.5GB 使用、空き約 7GB）/ GPU なし / 常駐プロセスを増やさない / sudo なし。

---

## A. Kev / Jev の裏取り

### A-1. 結論
| 項目 | ユーザー情報 | 確認結果 |
|---|---|---|
| Jev | TypeSafe AI の判断特化 AI、System One API | 【事実】正しい。`POST https://api.typesafe.ai/v1/systemone`、モデル `jev-latest`（応答には `jev-1.13.0` などのバージョンが出る）。質問タイプは noul / choice / score。重みと構造は非公開 |
| 「open jev」 | = Jev | **食い違いあり。** 「OpenJev」は Jev のことではなく、**別々のコミュニティ製クローンが同じ名前を使っている**（TheoLeeCJ/SemIf-OpenJev、razorback16/openjev、SiliconLabAI/OpenJev など）。Kev 自体は OpenJev を名乗っていない |
| Kev の性格 | Jev の OSS 互換 | 【事実】jaredpalmer/kev は「Jev 風の判断モデル」で、API の形式は System One と互換（TypeSafe SDK がそのまま使える）。ただし **Jev の重みやデータは使っていない**（README: "No Jev outputs were used for training"） |
| ライセンス | Apache-2.0 | 【事実】正しい（どちらのリポジトリも。ベースの Qwen3.5/3.8 も Apache-2.0） |
| ベースとサイズ | Qwen3.5/3.8、0.8B〜27B | 【事実】正しい。0.8B / 4B / 9B は Qwen3.5-Base に LoRA とポインタヘッドを載せたもの。27B は Qwen3.8-27B を全重み微調整したもの |
| 0.8B は CPU で動く | 動く | **条件付き。** 公式に検証されているのは CUDA（4GB GPU）と Apple Silicon（MLX）だけ。`--device cpu`（fp32）の経路はあり、MLX との差分比較に使われているが、**x86 CPU での速度は公開されていない** |
| 2 リポジトリの関係 | どちらかが本家？ | **別物で、フォークでもない。** 下表を参照 |

### A-2. 2 つのリポジトリ
| | jaredpalmer/kev | arjun988/Kev（"NotJev : Kev"） |
|---|---|---|
| 中身 | **自前の学習済みモデル**（0.8B/4B/9B/27B）と学習・評価・サーバー一式（Python/PyTorch/MLX） | **重みを持たない API サーバー**（Node/TS）。判断は Ollama / vLLM / OpenAI 互換の任意の LLM にさせる。mock もある |
| 作成日 / 最終 push | 2026-09-17 / 2026-10-12（活発） | 2026-09-22 / 2026-09-23（作成の翌日から更新なし） |
| star / fork / open issue | 9,037 / 604 / 35 | 21 / 2 / - |
| isFork | false | false（README に "Independent project. Not affiliated with TypeSafe AI or OpenJev" とある） |
| 名前の注意 | PyPI の `kev` は別パッケージ（K.E.V. ORM）。pip では入らない | `pip install kev` と書かれているが、上記と同名衝突の可能性 |

→ 「Kev」と言うなら本命は **jaredpalmer/kev**。arjun988/Kev は名前が同じだけの、LLM を包むラッパー。

### A-3. jaredpalmer/kev の仕様（事実）
- 重み: Hugging Face `jaredpalmer/kev-0.8b` / `-4b` / `-9b` / `-27b`（Kev 1.0 タグは `v1.0`）。0.8B は LoRA アダプタと `head.pt` だけを配布し、ベースの Qwen3.5-0.8B-Base は初回に別途ダウンロードする。
- 入力: `state`（文字列 / オブジェクト / 配列）と `questions`。出力は choice（1〜255 個の選択肢から最有力の 1 つ）、`probabilities`、`confidence`。**テキストは生成しない**（prefill だけのポインタヘッド方式）。確率は温度で補正済み。
- **対応言語: model card に "Languages: English"、範囲外の用途に "languages other than English" と明記。日本語は評価されていない。**
- 0.8B の精度（新しいソース）: 0.648 / 0.697（dev / test）。4B は 0.817 / 0.838。**誤り率 5% の予算で自動化できる割合は 0.8B だと 0.14 しかない**（4B〜27B は 0.52〜0.69）。
- メモリ: README によると、アダプタをロード時にベースへ畳み込むため一時的に重みが 2 部ある。CPU は fp32 が既定で、`KEV_DTYPE=bf16` も指定できる。
- CPU 向けの GGUF / llama.cpp 対応（**非公式**）:
  - issue #32: monatis/ggmlc（単一バイナリ）。HF `mys/kev-0.8b-GGUF`（f16 1.53GB / q8_0 0.83GB / q4_k_m 0.96GB）。配布されているビルド済みバイナリは CUDA と Metal だけで、CPU 版は自分でビルドする必要がある。GGUF は 2026-09-22 版で、**Kev 1.0 のチェックポイント（09-24 公開）より前の重みの可能性がある**。
  - issue #76: espetro/llama.cpp の kev ブランチ（フォーク）。どちらの issue も open のままで、本体には取り込まれていない。
- 学習: 自分のラベルで追加学習（`--init_from`）できるが、手順は GPU（Modal の H100 で約 $1）が前提。README によると、400 件程度では効果がノイズに埋もれる。

### A-4. N100 で 0.8B を動かす見積もり【推定】
- 前提となる実測: N100（4 スレッド）で llama.cpp、LFM2.5-1.2B Q6_K の pp512 が 33.7 t/s（ntaka1970 のブログ）。0.8B ならおよそ 40〜60 t/s。
- 1 件あたりのトークン数: レシートのテキスト 200〜400 + 科目の選択肢 25 個に説明を付けると 400〜600 で、計 600〜1,000。Qwen3.5 系では質問ごとに独立した行として処理される（state はキャッシュされる）。
- 時間: **llama.cpp 系で 1 件 10〜25 秒、PyTorch fp32 で 15〜60 秒**（codex のセカンドオピニオンも同じ幅）。選択肢を top-5 に絞れば 3〜10 秒程度。
- メモリ: fp32 の重みが 3.2GB、アダプタの畳み込みで一時的に約 6.4GB に PyTorch 本体分が加わり、**ピークは 7GB 前後。空きが約 7GB なのでスワップや OOM の危険がある**。bf16 なら半分になるが、N100 には AVX512-BF16 / AMX が無いので遅くなる見込み。GGUF の q8_0 なら RSS は 1〜1.5GB 程度。
- 常駐させずに使う運用: 可能。ただしコールド起動（Python と torch の import、重みのロード）に 20〜60 秒かかる見込み。月に数十〜数百件を夜間バッチや手動でまとめて処理するなら成立する。
- **評価: 0.8B は英語だけで学習しており、新しいソースでの精度が低い（自動化率 14%）、CPU は公式サポート外、という 3 点が重なる。そのため日本語レシートの科目分類の主力にはしない。**
- 補足（範囲外の候補）: NandhaKishorM/laya の `laya-multilingual`（mmBERT-base 322M、Apache-2.0、100 以上の言語対応、System One 互換）は CPU でも軽い。ただし MASSIVE の 20 択で日本語の zero-shot 精度は 0.64 にとどまり、これも主力にはしにくい。

### A-5. 科目分類の方式比較
科目体系: 青色申告決算書の経費科目（租税公課、荷造運賃、水道光熱費、旅費交通費、通信費、広告宣伝費、接待交際費、損害保険料、修繕費、消耗品費、減価償却費、福利厚生費、給料賃金、外注工賃、利子割引料、地代家賃、貸倒金、雑費）に、任意科目（新聞図書費、支払手数料、会議費、研修費、車両費など）と **「事業主貸（私用）」** を加える。

| 案 | 内容 | 精度（初期） | 精度（データが貯まった後） | N100 負荷 | 実装コスト | 運用コスト |
|---|---|---|---|---|---|---|
| 1. ルールと取引先辞書のみ | 取引先を正規化（株式会社や支店名を除き、全角半角を統一）して完全一致で引き、品目キーワードのルールを足す | △ | ○（繰り返し使う取引先には強い） | ◎ | ◎ 小 | ◎ 0円 |
| 2. 辞書 → OCR と同じ Gemini 呼び出しで科目候補（enum 付きの構造化出力）→ ユーザー確認で辞書に学習 | 辞書にあれば辞書を使い、無ければ Gemini の候補を使う | ○ | ◎ | ◎ | ○ 中 | ◎ OCR 料金に含まれ、追加はほぼ 0 |
| 3. 案 2 に、ローカルの TF-IDF（文字 n-gram）+ LR や埋め込み kNN を加える | 確定した仕訳が 200 件程度を超えたら、Gemini 候補より前段に置き、確率で閾値判定する | ○ | ◎ | ○（scikit-learn なら 1 件 10ms 未満） | △ 中〜大 | ◎ 0円 |
| (参考) Kev-0.8B | 選択肢付きの choice で確率を得る | △（日本語は未検証） | ○（追加学習には GPU が要る） | ✗ | △ | ○（電気代のみ） |

- Gemini の候補には「確信度」が出ないので、**最初の段階は全件をユーザーが確認する UI を前提にする**。辞書にヒットした場合は自動確定、外れた場合は確認、という流れ。
- **推薦: 案 2 から始め、確定仕訳が約 200 件を超えたら案 3 へ進む。Kev は MVP に入れない。** 将来、手元に 300 件以上のラベルが貯まった時点で、Kev-0.8B GGUF と TF-IDF+LR を同じテストセットで比べるオフライン実験を「任意」として残す。

---

## B. OCR とプライバシー

### B-1. Gemini Flash-Lite のラインナップ【事実: ai.google.dev/gemini-api/docs/models、pricing】
- **「Gemini 3.8 Flash Lite」というテキスト / マルチモーダルのモデルは存在しない。** 3.8 の Flash-Lite は TTS（`gemini-3.8-flash-lite-tts`）だけ。おそらく取り違え。
- 画像の OCR に使える Lite 系: `gemini-3.5-flash-lite`（Stable、入力 $0.30 / 出力 $2.50 per 1M）、`gemini-3.1-flash-lite`（Stable、$0.25 / $1.50）。上位の `gemini-3.8-flash` は 2026-12-31 まで $0.75 / $3.75 で、2027-01-01 から $1.50 / $7.50。
- 3 モデルとも無料枠がある。料金表の「Used to improve our products」欄は、無料が Yes、有料が No。
- 費用の目安【推定】: 1 枚あたり入力約 1,500 トークン（画像とプロンプト）、出力約 300 トークンとすると、3.5 Flash-Lite で約 $0.0012/枚。月 100 枚で約 $0.12（20 円前後）、月 1,000 枚でも 200 円前後。

### B-2. データの扱い【事実】
- 無料枠（Unpaid Services）: 入力と出力が製品の改善や開発に使われ、**人間のレビュアーが読むことがある**。規約に "Do not submit sensitive, confidential, or personal information to the Unpaid Services" と明記されている。→ **領収書には使えない。**
- 有料（Paid Services、Cloud Billing を有効にしたプロジェクト）: 学習には使われない。不正利用の監視のためにプロンプトと応答が **55 日間** ログとして保持される。Developer API には監視ログを止める手段が無く、ZDR ページは「保証された ZDR が必要なら Vertex AI を使え」としている。Files API は手動で消さないとファイルが残るので、**inline で送る**。明示的なキャッシュは使わない。暗黙の in-memory キャッシュ（24 時間）は ZDR 違反には当たらないとされている。
- Vertex AI: 許可なく学習には使わない。in-memory キャッシュ（24 時間）はプロジェクト単位で無効化できる。不正利用監視の例外を申請すれば ZDR にできる（GCP 規約の範囲内）。リージョンも選べる。代償として、GCP プロジェクトとサービスアカウントの設定が増える。
- EEA / 英国 / スイスの利用者には有料の扱いが強制されるが、日本の利用者には関係しない。

### B-3. 領収書に含まれる個人情報とリスク
| 情報 | 例 | リスク |
|---|---|---|
| カード番号の下 4 桁、承認番号、端末番号 | 「****1234」「承認No」 | 単独なら低いが、他の情報と組み合わさると特定につながる |
| 氏名・宛名 | 「〇〇様」、手書きの宛名 | 本人を特定できる |
| 住所・電話 | 宛名の住所、配送伝票 | 本人を特定できる。自宅住所が漏れる |
| 購入品目 | 書籍名、薬、嗜好品 | 嗜好や健康状態が推測される |
| 医療機関・薬局名 | クリニック名、調剤明細 | **要配慮個人情報に近い**（病歴の推測）。そもそも事業経費ではない場合が多い |
| 位置と時刻 | 店舗と日時の並び | 行動履歴が分かる |

緩和策（効果が大きい順）:
1. 無料枠を使わない（API キーは課金を有効にしたプロジェクトのものだけにする。コードの設定で無料キーを使えないようにするのが望ましい）。
2. inline 送信のみとし、Files API とキャッシュを使わない。送った画像はローカルにだけ保存する。
3. 送る前に画像を切り抜く。アップロード時に「宛名や伝票部分を除外」できるようにする（任意、手動の矩形マスク）。
4. 機微なカテゴリ（医療・薬局など）は「ローカルのみ」と指定でき、B-4 のローカル OCR に回す。
5. より強い保証が必要になったら Vertex AI（ZDR）に移る。

### B-4. ローカル OCR の比較
| | ライセンス | 日本語レシート | N100 CPU の速度 / メモリ | 構造化 | 備考 |
|---|---|---|---|---|---|
| Tesseract (jpn) | Apache-2.0 | ✗ 感熱紙の小さい文字や斜めの写真に弱い【推定】 | ◎ 1〜3 秒、200MB 程度【推定】 | ✗ テキストのみ | apt が要るので sudo が必要になる点に注意 |
| PaddleOCR（PP-OCRv6） | Apache-2.0 | ○ 日本語に対応（PP-OCRv6 は 1 モデルで中・英・日を含む 50 言語）。CPU で v5 比 5.2 倍速いとされる【事実】 | ○ 2〜6 秒、1〜2GB【推定】 | △ テキストと座標 | pip（venv）で入る |
| NDLOCR-Lite（国立国会図書館） | CC BY-4.0（同梱モデルは DINOv3 ライセンスにも従う） | △ 図書や雑誌向け。横書きの平均 CER は 0.264（NDL 自身の評価セット）【事実】 | ○ GPU 無しが前提の設計 | △ | レシートでの実績は確認できず |
| YomiToku（`--lite`） | **CC BY-NC-SA 4.0** | ◎ 日本語の文書に特化【事実: 主張】 | ○ lite は CPU 向け | ○ レイアウトと表 | **商用ガイドライン 2-2「社内業務の自動化・効率化」は商用扱いで、個人事業の経理に使うには有償の商用ライセンスが必要**。検証（PoC）だけなら無償 |
| PaddleOCR-VL-1.6（0.9B VLM） | Apache-2.0 | ○〜◎ 日本語を含む 109 言語。Markdown / JSON で出力 | ✗〜△ CPU で 1 枚あたり数十秒〜数分、RAM 3〜5GB【推定】 | ○ | N100 では夜間バッチ向き |

構造化抽出（ローカル経路で使う場合）:
- 日付: 和暦、西暦、`yyyy/mm/dd` の正規表現。
- 金額: 「合計」「お預り」「釣銭」の行を区別する。税率ごとの小計は「8%対象」「10%対象」「※は軽減税率」。
- 登録番号: `T\d{13}`。法人なら下位 12 桁が法人番号のチェックディジット規則に従うので、ローカルで検算できる。個人事業者の番号の検算規則は未確認。**最終確認は国税庁の適格請求書発行事業者公表サイト Web-API（無料、アプリ ID の申請が必要）が確実**。外部サービスが 1 つ増えるが、費用は 0 円。
- 取引先: 先頭の数行、電話番号、登録番号から逆引きする（公表サイトで名称が取れる）。

### B-5. OCR 方式の比較と推薦
| 案 | 内容 | 精度 | プライバシー | N100 負荷 | 実装 | 運用費 |
|---|---|---|---|---|---|---|
| A. Gemini 3.5 Flash-Lite（有料）に画像を直接送り、JSON スキーマで構造化出力し、科目候補も同時に得る | 1 回の呼び出しで抽出から科目候補まで済む | ◎ | ○（学習には使われない、ログは 55 日） | ◎ | ◎ 小 | ◎ 月 20〜200 円 |
| B. ローカルの PP-OCRv6 でテキスト化し、マスクした**テキストだけ**を Gemini（有料）で構造化 | 画像は外に出ない。カード番号や宛名は正規表現で伏せる | ○（OCR の誤りがそのまま残る） | ◎ | ○ | △ 中 | ◎ さらに安い |
| C. 完全ローカル（PP-OCRv6 と正規表現、または PaddleOCR-VL） | 外部へ送らない | △〜○ | ◎ | △ | ✗ 大 | ◎ 0 円 |

**推薦: 案 A を MVP とする。** 条件は「有料 tier 限定、inline 送信、Files API とキャッシュは使わない」の 3 つ。医療・薬局などの機微な領収書だけは、ユーザーが「ローカルのみ」と指定して案 C（PP-OCRv6 と正規表現、手入力で補う）に回せるようにする。理由: レシートの OCR 精度と N100 の空きメモリ（約 7GB）を考えると、ローカル VLM を常用するのは割に合わない。費用も月数十円で済む。

---

## 決定事項（本ドラフトでの提案）
1. Kev は MVP に入れない（英語のみ、CPU 非公式、0.8B の精度不足）。
2. 科目は「取引先辞書 → Gemini の候補 → ユーザー確認 → 辞書に学習」とする。科目の体系は青色申告決算書の経費科目に、任意科目と事業主貸を加えたもの。
3. OCR は Gemini 3.5 Flash-Lite の有料 tier で行い、無料枠は禁止する。

## 未決事項（決める人）
| 項目 | 決める人 |
|---|---|
| 「3.8 Flash Lite」が 3.5 Flash-Lite の取り違えでよいか（3.8 Flash を使うなら費用は約 2.5 倍、2027 年からはさらに倍） | ユーザー |
| 有料の Developer API（ログ 55 日）で許容するか、Vertex AI の ZDR まで求めるか | ユーザー |
| 任意科目の一覧（使う科目の確定） | ユーザー（税理士や過去の決算書を参照） |
| 「ローカルのみ」経路を MVP に含めるか、Phase 2 に回すか | ユーザー |
| 登録番号の照合に国税庁 Web-API を使うか（アプリ ID の申請が要る） | ユーザー |
| 個人事業者の登録番号に検算規則があるか | spec-writer が追加調査 |
| Kev-0.8B GGUF の N100 実測（任意の実験、ラベルが 300 件以上貯まってから） | 後日 implementer（llama-bench で計測するだけ） |

## 受け入れ条件（MVP、テスト可能な形）
- 無料枠のキーを設定して起動すると、エラーで止まる（または起動時に課金が有効なプロジェクトか確認する）。
- 画像は inline で送り、Files API の呼び出しがコード中に無い。
- レシート 1 枚から {日付, 合計, 税率別の金額, 取引先, 登録番号|null, 科目候補} の JSON が得られ、スキーマ違反は再試行せずエラーになる。
- 登録番号が `^T\d{13}$` に合わない場合は null にして警告を出す。
- 確定した仕訳の取引先は辞書に保存され、同じ取引先の 2 件目以降は Gemini の候補より辞書が優先される。
- 「ローカルのみ」とした領収書について、外部 API の呼び出しが 0 回であることをテストで確認する。

## 出典
- https://github.com/jaredpalmer/kev （README、docs/model-cards/kev-0.8b.md、issue #32 / #76）
- https://github.com/arjun988/Kev
- https://huggingface.co/jaredpalmer/kev-0.8b / https://huggingface.co/mys/kev-0.8b-GGUF
- https://github.com/monatis/ggmlc/blob/main/examples/laya/README.md / https://github.com/espetro/llama.cpp/tree/kev
- https://docs.typesafe.ai/api
- https://pasqualepillitteri.it/en/news/17263/typesafe-jev-open-source-clones-free-rtx-3090 （Jev はクローズド、クローンが乱立、という二次情報）
- OpenJev を名乗るリポジトリ: https://github.com/TheoLeeCJ/SemIf-OpenJev / https://github.com/razorback16/openjev / https://github.com/SiliconLabAI/OpenJev
- https://github.com/NandhaKishorM/laya （BENCHMARKS.md、ja 0.640）
- N100 での llama.cpp 実測: https://ntaka1970.hatenablog.com/entry/2026/07/11/110136
- https://ai.google.dev/gemini-api/docs/models / https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/terms （2026-03-23 発効、2026-04-28 更新）
- https://ai.google.dev/gemini-api/docs/usage-policies （55 日間の保持） / https://ai.google.dev/gemini-api/docs/zdr
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/data-governance
- https://github.com/kotaro-kinoshita/yomitoku （README の LICENSE、docs/commercial_use_guideline.ja.md）
- https://github.com/ndl-lab/ndlocr-lite / https://github.com/PaddlePaddle/PaddleOCR / https://github.com/tesseract-ocr/tesseract
- セカンドオピニオン: codex exec（N100 の推論時間の見積もり。上の実測ブログで裏取り済み）
