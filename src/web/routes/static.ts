// PWA のビルド成果物（pwa/dist/）の配信（docs/mvp-plan.md T1-12）。認証の後に置く。
// - GET だけ（HEAD は Hono が GET に回して本文を落とす）。dist の外は読まない（.. や NUL を含むパスは 404）。知らないパスは 404（SPA のフォールバックはしない。画面は / の 1 枚）。
// - /assets/* はファイル名にハッシュが付くので長期キャッシュ。それ以外（index.html・sw.js・manifest）は no-cache。
// - POST /share-target は本来 service worker が受ける（T1-13）。SW が未登録のときにここへ来るので、画面へ戻して知らせる。
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// HTML・URL・外部の画像を描画しない方針（a2ui-review-ui.md §2.1）に合わせて、読み込み元を自分だけに絞る。
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function resolveFile(root: string, urlPath: string): Promise<string | null> {
  let p: string;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes('\0') || p.split('/').includes('..')) return null;
  if (p === '/' || p === '') p = '/index.html';
  const file = path.resolve(root, `.${p}`);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function staticRoutes(opts: { pwaDir: string }): Hono {
  const root = path.resolve(opts.pwaDir);
  const r = new Hono();
  r.post('/share-target', (c) => c.redirect('/?share=no_sw', 303));
  r.get('/*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    const file = await resolveFile(root, c.req.path);
    if (file === null) return c.notFound();
    const ext = path.extname(file);
    const headers: Record<string, string> = {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = CSP;
      headers['Referrer-Policy'] = 'no-referrer';
    }
    return c.body(await readFile(file), 200, headers);
  });
  return r;
}
