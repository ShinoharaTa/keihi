// PWA のビルド（docs/mvp-plan-v0.1.md T1-12、D2）。`npm run build`（tools/dev/build.ts）から `vite build pwa` で呼ぶ。
// 成果物は pwa/dist/。service worker は別の設定（vite.sw.config.ts）で dist/sw.js に出す。
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  publicDir: 'public',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // CSP（src/web/routes/static.ts）で外部・インラインを禁じているので、小さな資産もファイルで出す。
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
