# pwa/

PWA（Vite + Preact）。docs/mvp-plan-v0.1.md の T1-12（撮影・送信待ち）・T1-13（共有シート）。

- `npm run build` で型検査 → `pwa/dist/` にビルド（画面: `vite.config.ts`、service worker: `vite.sw.config.ts` → `dist/sw.js`）→ gzip の予算を確認（初回に読む分〈index.html・それが直接読む js/css・sw.js〉の合計が 60KB 以内。動的 import の遅延チャンクは合計に入れず 1 本ごとの上限: お金〈Money〉45KB、それ以外〈試算・経費・メールなど〉20KB。表は `tools/dev/build.ts` の `LAZY_LIMITS`）。
- `pwa/dist/` は web（`src/web/routes/static.ts`）が認証の後ろで配信する。
- `src/capture/form.ts`・`src/queue/{queue,share}.ts` は純関数・抽象化した保存先だけで書き、`test/unit/pwa-*.test.ts` で node:test から試す。
- 描画は Preact のテキストだけ（innerHTML 等は使わない。`npm run lint`）。
