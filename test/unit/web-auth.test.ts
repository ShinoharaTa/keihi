// web の認証・Host 検査・/healthz・/api/status・PWA の配信（docs/mvp-plan.md T1-14、v0.1 T1-13・T1-14）。
// app.request() で叩く（ポートを開かない）。DB・設定・PWA の置き場所は一時ディレクトリ。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { setSetting } from '../../src/attention.ts';
import { appendAudit } from '../../src/audit.ts';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';

const LOCAL = '127.0.0.1:8795';
const TS_HOST = 'keihi.example-tailnet.ts.net:8444';
const USER = 'test@example.com';

let root: string;
let db: Db;
let app: Hono;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-web-'));
  db = openDb(path.join(root, 'web.db'));
  migrate(db);
  const pwaDir = path.join(root, 'dist');
  await mkdir(path.join(pwaDir, 'assets'), { recursive: true });
  await writeFile(path.join(pwaDir, 'index.html'), '<!doctype html><title>keihi</title>');
  await writeFile(path.join(pwaDir, 'assets', 'index-abc.js'), 'console.log(1)');
  await writeFile(path.join(pwaDir, 'sw.js'), '/* sw */');
  await writeFile(path.join(root, 'secret.txt'), 'secret');
  app = createApp({
    db,
    objectsDir: path.join(root, 'objects'),
    config: {
      ingest: { maxBytes: 1024 * 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
      retention: { years: 7, extraYears: 1, start: 'next_year_0316' },
    },
    auth: createAuth({ allowedUsers: [USER], allowedHosts: [LOCAL, TS_HOST] }),
    triggerWorker: () => {},
    pwaDir,
  });
});
after(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

function req(p: string, opts: { host?: string | null; user?: string; origin?: string; method?: string; body?: BodyInit } = {}) {
  const headers: Record<string, string> = {};
  if (opts.host !== null) headers.Host = opts.host ?? LOCAL;
  if (opts.user !== undefined) headers['Tailscale-User-Login'] = opts.user;
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  return app.request(`http://${LOCAL}${p}`, { method: opts.method ?? 'GET', headers, body: opts.body });
}

describe('Host の検査', () => {
  test('許可リストに無い Host は 400（/healthz も）', async () => {
    for (const host of ['evil.example', '127.0.0.1:8796', 'localhost:8795', '0.0.0.0:8795', null]) {
      const r = await req('/healthz', { host });
      assert.equal(r.status, 400, String(host));
      assert.deepEqual(await r.json(), { reason: 'invalid_host' });
      assert.equal((await req('/api/status', { host, user: USER })).status, 400);
    }
  });
  test('tailscale serve のホスト名は通る（大文字小文字は区別しない）', async () => {
    assert.equal((await req('/api/status', { host: TS_HOST.toUpperCase(), user: USER })).status, 200);
  });
});

describe('/healthz', () => {
  test('認証なしで ok だけを返す', async () => {
    const r = await req('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });
});

describe('Tailscale-User-Login', () => {
  test('ヘッダなしは 401、許可外は 403、許可ユーザーは 200', async () => {
    assert.equal((await req('/api/status')).status, 401);
    assert.equal((await req('/api/status', { user: '' })).status, 401);
    const f = await req('/api/status', { user: 'other@example.com' });
    assert.equal(f.status, 403);
    assert.deepEqual(await f.json(), { reason: 'forbidden' });
    const ok = await req('/api/status', { user: USER });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      ok: true,
      user: USER,
      documents: { total: 0, needs_attention: 0 },
      jobs: { queued: 0, running: 0, failed: 0 },
      backup: { last_success_at: null, last_drill: null },
      freee_reauth_required: false,
      retention: { earliest_retain_until: null, documents: 0 },
    });
  });
  test('取り込み API・一覧・PWA も認証の後ろにある', async () => {
    assert.equal((await req('/api/documents', { method: 'POST', body: new FormData() })).status, 401);
    assert.equal((await req('/api/documents')).status, 401);
    assert.equal((await req('/')).status, 401);
    assert.equal((await req('/sw.js', { user: 'other@example.com' })).status, 403);
  });
  test('許可リストが空なら誰も通らない', async () => {
    const auth = createAuth({ allowedUsers: [], allowedHosts: [LOCAL] });
    let passed = false;
    const c = {
      req: { header: (k: string) => ({ Host: LOCAL, 'Tailscale-User-Login': USER })[k], path: '/api/status', method: 'GET' },
      json: (b: unknown, s: number) => ({ b, s }),
    };
    const r = (await auth(c as never, async () => {
      passed = true;
    })) as unknown as { s: number };
    assert.equal(passed, false);
    assert.equal(r.s, 403);
  });
});

describe('Origin（CSRF）', () => {
  const fd = () => new FormData();
  test('Origin の無い POST（iOS ショートカット）は通す', async () => {
    const r = await req('/api/documents', { method: 'POST', user: USER, body: fd() });
    assert.equal(r.status, 422); // 認証は通り、取り込み API の検証で落ちる
  });
  test('Origin が許可ホストなら通す', async () => {
    assert.equal((await req('/api/documents', { method: 'POST', user: USER, origin: `https://${TS_HOST}`, body: fd() })).status, 422);
  });
  test('Origin が違う・壊れている・null なら 403', async () => {
    for (const origin of ['https://evil.example', 'null', 'not a url', `https://${TS_HOST.split(':')[0]}`]) {
      const r = await req('/api/documents', { method: 'POST', user: USER, origin, body: fd() });
      assert.equal(r.status, 403, origin);
      assert.deepEqual(await r.json(), { reason: 'invalid_origin' });
    }
  });
  test('GET は Origin を見ない', async () => {
    assert.equal((await req('/api/status', { user: USER, origin: 'https://evil.example' })).status, 200);
  });
});

describe('GET /api/documents', () => {
  test('一覧を返す（空）', async () => {
    const r = await req('/api/documents', { user: USER });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { items: [] });
  });
});

describe('PWA の配信', () => {
  test('/ は index.html（CSP 付き、no-cache）', async () => {
    const r = await req('/', { user: USER });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(await r.text(), '<!doctype html><title>keihi</title>');
  });
  test('/assets/* は長期キャッシュ、sw.js は no-cache', async () => {
    const a = await req('/assets/index-abc.js', { user: USER });
    assert.equal(a.status, 200);
    assert.match(a.headers.get('cache-control') ?? '', /immutable/);
    assert.match(a.headers.get('content-type') ?? '', /^text\/javascript/);
    const s = await req('/sw.js', { user: USER });
    assert.equal(s.headers.get('cache-control'), 'no-cache');
  });
  test('dist の外・知らないパス・/api/* の知らないものは 404', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/nope.html', '/api/nope', '/%00']) {
      assert.equal((await req(p, { user: USER })).status, 404, p);
    }
  });
  test('SW が無いときの POST /share-target は / へ戻す', async () => {
    const r = await req('/share-target', { method: 'POST', user: USER, body: fd() });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/?share=no_sw');
  });
  function fd() {
    return new FormData();
  }
});

describe('設定（[web]・[mcp]）', () => {
  async function cfgDir(toml: string): Promise<string> {
    const d = path.join(root, `cfg${n++}`);
    await mkdir(d);
    await writeFile(path.join(d, 'config.toml'), toml);
    return d;
  }
  test('既定: 8795、MCP は 8796 を予約、Host は 127.0.0.1:8795、許可ユーザーは空', async () => {
    const c = loadConfig({ configDir: await cfgDir(''), dataDir: '/nonexistent/keihi' });
    assert.deepEqual(c.web, { port: 8795, allowedUsers: [], allowedHosts: ['127.0.0.1:8795'] });
    assert.deepEqual(c.mcp, { port: 8796 });
  });
  test('許可ユーザーと tailscale serve のホスト名を足せる', async () => {
    const d = await cfgDir(`[web]\nport = 18795\nallowed_users = ["${USER}"]\nallowed_hosts = ["Keihi.Example.ts.net:8444", "127.0.0.1:18795"]\n`);
    const c = loadConfig({ configDir: d, dataDir: '/nonexistent/keihi' });
    assert.deepEqual(c.web, { port: 18795, allowedUsers: [USER], allowedHosts: ['127.0.0.1:18795', 'keihi.example.ts.net:8444'] });
  });
  test('不正な値・知らないキー（bind など）は拒否', async () => {
    for (const toml of [
      '[web]\nport = 70000\n',
      '[web]\nport = 8796\n',
      '[web]\nallowed_users = "a@example.com"\n',
      '[web]\nallowed_users = [""]\n',
      '[web]\nbind = "0.0.0.0"\n',
      '[mcp]\nenabled = true\n',
    ]) {
      const d = await cfgDir(toml);
      assert.throws(() => loadConfig({ configDir: d, dataDir: '/nonexistent/keihi' }), ConfigError, toml);
    }
  });
});

describe('main.ts', () => {
  test('127.0.0.1 にだけバインドする（0.0.0.0 を書かない）', async () => {
    const src = await readFile('src/web/main.ts', 'utf8');
    assert.doesNotMatch(src, /0\.0\.0\.0|'::'|hostname:\s*['"]/);
    assert.match(src, /hostname: WEB_HOST/);
    const cfg = await readFile('src/config.ts', 'utf8');
    assert.match(cfg, /export const WEB_HOST = '127\.0\.0\.1';/);
  });
});

describe('/api/status のバックアップ状態', () => {
  test('最後に成功した backup.run と最後の backup.drill を監査ログから読む', async () => {
    const a = (action: string, payload: Record<string, unknown>, ts: string) => appendAudit(db, { actor: 'backup', action, entity: 'backup', entityId: null, payload }, new Date(ts));
    a('backup.run', { ok: true }, '2026-10-10T00:00:00.000Z');
    a('backup.run', { ok: false, error: 'x' }, '2026-10-11T00:00:00.000Z');
    a('backup.drill', { ok: true, failure_count: 0 }, '2026-10-01T00:00:00.000Z');
    a('backup.drill', { ok: false, failure_count: 2, failures: ['secret'] }, '2026-10-12T00:00:00.000Z');
    const r = await req('/api/status', { user: USER });
    const j = (await r.json()) as { backup: unknown };
    assert.deepEqual(j.backup, { last_success_at: '2026-10-10T00:00:00.000Z', last_drill: { at: '2026-10-12T00:00:00.000Z', ok: false, failure_count: 2 } });
  });
});

describe('/api/status の freee_reauth_required', () => {
  const get = async () => ((await (await req('/api/status', { user: USER })).json()) as { freee_reauth_required: unknown }).freee_reauth_required;
  test('settings が無い・0 なら false、1 なら true', async () => {
    db.prepare(`DELETE FROM settings WHERE key = 'freee_reauth_required'`).run();
    assert.equal(await get(), false);
    setSetting(db, 'freee_reauth_required', 0);
    assert.equal(await get(), false);
    setSetting(db, 'freee_reauth_required', 1);
    assert.equal(await get(), true);
    setSetting(db, 'freee_reauth_required', 0);
  });
});
