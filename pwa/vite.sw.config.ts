// service worker のビルド。ES module の SW に頼らないよう、1 ファイルの IIFE で dist/sw.js に出す（ハッシュを付けない）。
// vite.config.ts のビルドの後に走らせる（dist を消さない）。
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    lib: { entry: 'src/sw.ts', formats: ['iife'], name: 'keihiSw', fileName: () => 'sw.js' },
  },
});
