// npm run build（docs/mvp-plan-v0.1.md T1-1、D2）。サーバーと worker は型ストリップで直接実行するのでビルドしない。
// PWA（pwa/vite.config.ts）があるときだけ、型検査 → vite build（画面）→ vite build（service worker）→ サイズ予算の確認をする。
// サイズ予算（T1-12）: 初期に読む html・js・css の gzip 合計が 60KB 以内（sw.js は含めない）。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const GZIP_BUDGET = 60 * 1024;
const DIST = 'pwa/dist';

function run(args: string[]): boolean {
  const r = spawnSync('npx', args, { stdio: 'inherit' });
  return r.status === 0;
}

export function gzipTotal(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.name === 'sw.js' || !/\.(html|js|css)$/.test(e.name)) continue;
    total += gzipSync(readFileSync(path.join(e.parentPath, e.name))).length;
  }
  return total;
}

if (import.meta.main) {
  if (!existsSync('pwa/vite.config.ts')) {
    console.log('build: pwa/vite.config.ts が無いので PWA のビルドは省略');
  } else {
    const ok =
      run(['tsc', '-p', 'pwa/tsconfig.json']) &&
      run(['tsc', '-p', 'pwa/tsconfig.sw.json']) &&
      run(['vite', 'build', 'pwa']) &&
      run(['vite', 'build', 'pwa', '-c', 'pwa/vite.sw.config.ts']);
    if (!ok) process.exitCode = 1;
    else {
      const total = gzipTotal(DIST);
      console.log(`build: gzip 合計 ${(total / 1024).toFixed(1)}KB（予算 ${GZIP_BUDGET / 1024}KB）`);
      if (total > GZIP_BUDGET) {
        console.error('build: サイズ予算を超えている');
        process.exitCode = 1;
      }
    }
  }
}
