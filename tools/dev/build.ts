// npm run build（docs/mvp-plan-v0.1.md T1-1、D2）。サーバーと worker は型ストリップで直接実行するのでビルドしない。
// PWA（pwa/vite.config.ts）があるときだけ vite build を走らせる。PWA の導入は T1-12。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('pwa/vite.config.ts')) {
  console.log('build: pwa/vite.config.ts が無いので PWA のビルドは省略（T1-12 で導入）');
} else {
  const r = spawnSync('npx', ['vite', 'build', 'pwa'], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}
