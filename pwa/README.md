# pwa/

PWA（Vite + Preact）。docs/mvp-plan-v0.1.md の T1-12（撮影・送信待ち）・T1-13（共有シート）。

- `npm run build` で型検査 → `pwa/dist/` にビルド（画面: `vite.config.ts`、service worker: `vite.sw.config.ts` → `dist/sw.js`）→ gzip 合計 60KB の予算を確認。
- `pwa/dist/` は web（`src/web/routes/static.ts`）が認証の後ろで配信する。
- `src/capture/form.ts`・`src/queue/{queue,share}.ts` は純関数・抽象化した保存先だけで書き、`test/unit/pwa-*.test.ts` で node:test から試す。
- 描画は Preact のテキストだけ（innerHTML 等は使わない。`npm run lint`）。
