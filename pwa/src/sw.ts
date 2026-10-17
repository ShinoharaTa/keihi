// service worker（docs/mvp-plan-v0.1.md T1-12・T1-13）。
// - キャッシュするのはアプリの殻（/、/assets/*、manifest、アイコン）だけ。/api/* と /healthz はキャッシュせず素通しする。
// - 画面遷移はネットワーク優先（更新をすぐ反映する）。つながらなければキャッシュした / を返す。
// - /assets/* はファイル名にハッシュが付くのでキャッシュ優先。
// - POST /share-target（Android の共有シート）を受けて送信待ちキューに draft で積み、/ へ戻す。送信は画面が行う。
/// <reference lib="webworker" />
import { idbStore } from './queue/idb.ts';
import { acceptShare, SHARE_PATH, shareRedirect } from './queue/share.ts';

declare const self: ServiceWorkerGlobalScope;

const CACHE = 'keihi-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function putIfOk(key: string | Request, res: Response): Promise<void> {
  if (res.ok && res.type === 'basic') await (await caches.open(CACHE)).put(key, res.clone());
}

async function navigate(req: Request): Promise<Response> {
  try {
    const res = await fetch(req);
    if (new URL(req.url).pathname === '/') await putIfOk('/', res);
    return res;
  } catch {
    return (await caches.match('/')) ?? Response.error();
  }
}

async function cacheFirst(req: Request): Promise<Response> {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  await putIfOk(req, res);
  return res;
}

async function networkFirst(req: Request): Promise<Response> {
  try {
    const res = await fetch(req);
    await putIfOk(req, res);
    return res;
  } catch {
    return (await caches.match(req)) ?? Response.error();
  }
}

async function share(req: Request): Promise<Response> {
  let r: { queued: number; unsupported: number } | null = null;
  try {
    r = await acceptShare(await req.formData(), idbStore, { now: new Date(), newId: () => crypto.randomUUID() });
  } catch {
    r = null;
  }
  return Response.redirect(shareRedirect(r), 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method === 'POST' && url.pathname === SHARE_PATH) {
    e.respondWith(share(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (e.request.mode === 'navigate') e.respondWith(navigate(e.request));
  else if (url.pathname.startsWith('/assets/')) e.respondWith(cacheFirst(e.request));
  else if (SHELL.includes(url.pathname)) e.respondWith(networkFirst(e.request));
});
