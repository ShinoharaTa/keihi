# iOS ショートカットで領収書を送る（docs/mvp-plan-v0.1.md T1-13）

iOS の Safari の PWA は Web Share Target に対応していないので、共有シートからはショートカットで
`POST /api/documents` に直接送る。Android は PWA を入れると共有メニューに keihi が出る（ショートカットは不要）。

## 1. 前提

- iPhone の Tailscale を ON にしておく（tailnet の外からは届かない）。
- サーバー側で `tailscale serve --bg --https 8444 http://127.0.0.1:8795` 済み（[serve.md](serve.md)）。
- `config.toml` の `[web] allowed_users` に iPhone でログインしている Tailscale のユーザーが入っている。

## 2. 送り先

| 項目 | 値 |
|---|---|
| URL | `https://<machine>.<tailnet>.ts.net:8444/api/documents` |
| 方法 | POST |
| 本文 | フォーム（multipart/form-data） |
| ヘッダ | **付けない。** `Tailscale-User-Login` は tailscale serve が付ける。自分で付けても意味がない |
| Origin | ショートカットは送らない。Origin の無い POST は受け付ける（Origin がある場合だけ一致を確かめる） |

フォームのフィールド（`src/web/routes/ingest.ts` と同じ）:

| フィールド | 必須 | 値 |
|---|---|---|
| `file` | ○ | ショートカットの入力（共有されたファイル）。JPEG・PNG・PDF |
| `kind` | ○ | `e_transaction`（電子でもらった PDF など）か `scan`（紙を撮ったもの） |
| `size_preset` | `scan` のとき○ | `receipt58` / `receipt80` / `a5` / `b5` / `a4` |
| `received_on` | | 受領日 `YYYY-MM-DD`。省略するとサーバーの今日（Asia/Tokyo） |
| `source` | | `share` |
| `no_ai` | | `true` で AI に送らない |
| `force` | | `true` で要件（解像度・カラー）を満たさなくても受け付ける（紙の原本を保管する扱い） |

## 3. ショートカットの作り方

1. ショートカット App →「＋」→ 詳細で「共有シートに表示」を ON。受け入れる種類は「ファイル」「イメージ」「PDF」。
2. 「メニューから選択」: 「電子（PDF）」/「紙（撮影）」。
   - 電子 → テキスト `e_transaction` を変数 `kind` に。
   - 紙 → テキスト `scan` を `kind` に。続けて「メニューから選択」でサイズを選び、`receipt58` などを変数 `size_preset` に。
3. 「現在の日付」→「日付をフォーマット」（カスタム `yyyy-MM-dd`）→ 変数 `received_on`。
4. 「URL の内容を取得」:
   - URL: §2 の URL
   - 方法: POST
   - 本文を要求: フォーム
   - フィールド: `file` =（ファイル）ショートカットの入力、`kind` = 変数 kind、`size_preset` = 変数 size_preset（紙のときだけ）、
     `received_on` = 変数 received_on、`source` = `share`
5. 「通知を表示」で結果（「URL の内容」）を出す。

## 4. 結果の見方

| HTTP | 意味 |
|---|---|
| 201 | 受け付けた。`deadline_on` が期限 |
| 409 | 同じファイルが既にある（`reason: duplicate`） |
| 413 | 大きすぎる |
| 415 | 対応していない形式（HEIC を含む） |
| 422 | 入力の不足・要件を満たさない（`reason` を見る。`resolution_too_low` などは `force=true` で送り直せる） |
| 400 | Host が許可されていない（URL のホスト名が `allowed_hosts` と違う） |
| 401 / 403 | Tailscale が OFF、または `allowed_users` に入っていない |

## 5. 注意

- **HEIC は未対応。** iPhone の写真をそのまま共有すると HEIC のことがあり、415 になる。
  変換してから送るかどうかは F14 の結果待ち（未決）。当面はカメラの設定を「互換性優先」（JPEG）にする。
- 位置情報: 端末側で写真に位置情報を付けない設定を推奨（D13。サーバーは原本を加工しない）。
- ショートカットはオフラインで溜めない。送れなかったら PWA から送り直す。
