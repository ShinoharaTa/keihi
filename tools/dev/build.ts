// npm run build（docs/mvp-plan-v0.1.md T1-1、D2）。サーバーと worker は型ストリップで直接実行するのでビルドしない。
// PWA（pwa/vite.config.ts）があるときだけ、型検査 → vite build（画面）→ vite build（service worker）→ サイズ予算の確認をする。
// サイズ予算（T1-12）: 初回に読む分（index.html・それが直接読む js/css・sw.js）の gzip 合計が 60KB 以内。
//   動的 import のチャンク（遅延）は合計に入れず、1 本ごとの上限（LAZY_LIMITS、表に無いものは 20KB）で見る。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const GZIP_BUDGET = 60 * 1024;
// 遅延チャンクの 1 本ごとの上限（KB）。キーは Vite の出力名の先頭（ハッシュを除く）。
export const LAZY_LIMITS: Record<string, number> = { Money: 45 };
export const LAZY_DEFAULT_LIMIT = 20;
const DIST = 'pwa/dist';

function run(args: string[]): boolean {
  const r = spawnSync('npx', args, { stdio: 'inherit' });
  return r.status === 0;
}

const gz = (file: string): number => gzipSync(readFileSync(file)).length;

// index.html が直接読む js/css（script の src・link の href）。dir からの相対パス。
function initialAssets(dir: string): Set<string> {
  const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)) out.add(m[1]!);
  return out;
}

// 初回に読む分の gzip 合計: index.html・それが直接読む js/css・sw.js。
export function gzipTotal(dir: string): number {
  let total = gz(path.join(dir, 'index.html'));
  for (const f of initialAssets(dir)) total += gz(path.join(dir, f));
  if (existsSync(path.join(dir, 'sw.js'))) total += gz(path.join(dir, 'sw.js'));
  return total;
}

// 遅延チャンク（js/css のうち index.html が直接読まないもの）。name は出力名からハッシュを除いたもの。
export function lazyChunks(dir: string): { name: string; file: string; size: number; limit: number }[] {
  const initial = initialAssets(dir);
  const out: { name: string; file: string; size: number; limit: number }[] = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.(js|css)$/.test(e.name)) continue;
    const file = path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    if (file === 'sw.js' || initial.has(file)) continue;
    // ハッシュは Vite 既定の 8 文字（名前にハイフンがあっても最後のハッシュだけを外す）。
    const name = e.name.replace(/-[\w-]{8}\.(js|css)$/, '');
    out.push({ name, file, size: gz(path.join(dir, file)), limit: (LAZY_LIMITS[name] ?? LAZY_DEFAULT_LIMIT) * 1024 });
  }
  return out.sort((a, b) => b.size - a.size);
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
      const kb = (n: number) => (n / 1024).toFixed(1);
      const total = gzipTotal(DIST);
      const lazy = lazyChunks(DIST);
      const lazyText = lazy.map((c) => `${c.name} ${kb(c.size)}KB/${c.limit / 1024}KB`).join(', ') || 'なし';
      console.log(`build: 初回 ${kb(total)}KB（予算 ${GZIP_BUDGET / 1024}KB）、遅延: ${lazyText}`);
      if (total > GZIP_BUDGET) {
        console.error('build: 初回のサイズ予算を超えている');
        process.exitCode = 1;
      }
      for (const c of lazy.filter((c) => c.size > c.limit)) {
        console.error(`build: 遅延チャンク ${c.name}（${c.file}）が ${kb(c.size)}KB で上限 ${c.limit / 1024}KB を超えている`);
        process.exitCode = 1;
      }
    }
  }
}
