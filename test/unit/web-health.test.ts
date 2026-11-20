// ヘルスチェック（/health・/health/live・/health/ready）・アクセスログ・onError（src/web/app.ts）。
// app.request() で叩く（ポートを開かない）。DB・PWA の置き場所は一時ディレクトリ。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createLogger, type Logger } from '../../src/log.ts';
import { createApp, requestLogEnabled, type AppDeps } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';

const LOCAL = '127.0.0.1:8795';
const USER = 'you@example.com';

let root: string;
let db: Db;
let pwaDir: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-health-'));
  db = openDb(path.join(root, 'web.db'));
  migrate(db);
  pwaDir = path.join(root, 'dist');
  await mkdir(path.join(pwaDir, 'health'), { recursive: true });
  await writeFile(path.join(pwaDir, 'index.html'), '<!doctype html><title>keihi</title>');
  // static の /* が /health* を拾わないことの確認用
  await writeFile(path.join(pwaDir, 'health', 'live'), 'static');
  await writeFile(path.join(pwaDir, 'health', 'ready'), 'static');
});
after(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

function capture(): { log: Logger; lines: () => Record<string, unknown>[] } {
  const raw: string[] = [];
  const log = createLogger({ service: 'keihi-web', env: { LOG_FORMAT: 'json', LOG_LEVEL: 'debug' }, out: (l) => raw.push(l), err: (l) => raw.push(l) });
  return { log, lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function app(extra: Partial<AppDeps> = {}): Hono {
  return createApp({
    db,
    objectsDir: path.join(root, 'objects'),
    config: {
      ingest: { maxBytes: 1024 * 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
      retention: { years: 7, extraYears: 1, start: 'next_year_0316' },
      cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false },
    },
    auth: createAuth({ allowedUsers: [USER], allowedHosts: [LOCAL] }),
    triggerWorker: () => {},
    pwaDir,
    ...extra,
  });
}

describe('ヘルスチェック', () => {
  test('/health・/health/live・/health/ready は Host・認証なしで 200 {"status":"ok"}、no-store', async () => {
    const a = app();
    for (const p of ['/health', '/health/live', '/health/ready']) {
      for (const headers of [{}, { Host: 'evil.example.com' }, { Host: LOCAL }] as Record<string, string>[]) {
        const r = await a.request(p, { headers });
        assert.equal(r.status, 200, `${p} ${JSON.stringify(headers)}`);
        assert.equal(r.headers.get('Cache-Control'), 'no-store');
        assert.match(r.headers.get('Content-Type') ?? '', /application\/json/);
        assert.deepEqual(await r.json(), { status: 'ok' });
      }
    }
  });
  test('static（/*）が /health* を拾わない', async () => {
    const r = await app().request('/health/live', { headers: { Host: LOCAL, 'Tailscale-User-Login': USER } });
    assert.deepEqual(await r.json(), { status: 'ok' });
    // static そのものは動いている
    const idx = await app().request('/', { headers: { Host: LOCAL, 'Tailscale-User-Login': USER } });
    assert.equal(idx.status, 200);
  });
  test('/health/ready: マイグレーションが最新でなければ 503 migrations', async () => {
    const fresh = openDb(path.join(root, `fresh${n++}.db`));
    try {
      const r = await app({ db: fresh }).request('/health/ready');
      assert.equal(r.status, 503);
      assert.equal(r.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await r.json(), { status: 'unavailable', reason: 'migrations' });
      fresh.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)');
      fresh.prepare(`INSERT INTO schema_migrations VALUES (1, 'x', 'x', 'x')`).run();
      assert.deepEqual(await (await app({ db: fresh }).request('/health/ready')).json(), { status: 'unavailable', reason: 'migrations' });
      // /health は DB を触らない
      assert.equal((await app({ db: fresh }).request('/health')).status, 200);
    } finally {
      fresh.close();
    }
  });
  test('/health/ready: DB を使えなければ 503 db（パス・エラー文は返さない）', async () => {
    const file = path.join(root, `closed${n++}.db`);
    const closed = openDb(file);
    migrate(closed);
    const a = app({ db: closed });
    closed.close();
    const r = await a.request('/health/ready');
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { status: 'unavailable', reason: 'db' });
    assert.ok(!text.includes(file));
  });
  test('ready を差し替えられる', async () => {
    const r = await app({ ready: () => ({ ok: false, reason: 'db' }) }).request('/health/ready');
    assert.equal(r.status, 503);
  });
  test('/healthz は今のまま（Host の検査の後、{ok:true}）', async () => {
    const a = app();
    assert.equal((await a.request('/healthz', { headers: { Host: 'evil.example.com' } })).status, 400);
    const r = await a.request('/healthz', { headers: { Host: LOCAL } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });
});

describe('アクセスログ', () => {
  test('requestLogEnabled: LOG_REQUESTS=1 で有効・0 で無効、未設定なら LOG_FORMAT=json のときだけ', () => {
    assert.equal(requestLogEnabled({}), false);
    assert.equal(requestLogEnabled({ LOG_FORMAT: 'text' }), false);
    assert.equal(requestLogEnabled({ LOG_FORMAT: 'json' }), true);
    assert.equal(requestLogEnabled({ LOG_FORMAT: 'json', LOG_REQUESTS: '0' }), false);
    assert.equal(requestLogEnabled({ LOG_REQUESTS: '1' }), true);
  });
  test('method・path（クエリなし）・status・duration_ms・request_id を出し、利用者は出さない。応答に X-Request-Id', async () => {
    const { log, lines } = capture();
    const a = app({ requestLog: true, log });
    const r = await a.request('/api/status?token=abc&q=1', { headers: { Host: LOCAL, 'Tailscale-User-Login': USER, 'X-Request-Id': 'req-1<script>' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('X-Request-Id'), 'req-1script');
    const l = lines();
    assert.equal(l.length, 1);
    const o = l[0];
    assert.equal(o.msg, 'request');
    assert.equal(o.method, 'GET');
    assert.equal(o.path, '/api/status');
    assert.equal(o.status, 200);
    assert.equal(typeof o.duration_ms, 'number');
    assert.equal(o.request_id, 'req-1script');
    assert.ok(!JSON.stringify(o).includes(USER));
    assert.ok(!JSON.stringify(o).includes('token=abc'));
  });
  test('認証で落ちたものも出す。request_id は X-Request-Id → Cf-Ray → randomUUID（128 字まで）', async () => {
    const { log, lines } = capture();
    const a = app({ requestLog: true, log });
    const r1 = await a.request('/api/status', { headers: { Host: LOCAL, 'Cf-Ray': '8a1b2c3d4e5f-NRT' } });
    assert.equal(r1.status, 401);
    assert.equal(r1.headers.get('X-Request-Id'), '8a1b2c3d4e5f-NRT');
    const r2 = await a.request('/api/status', { headers: { Host: LOCAL, 'X-Request-Id': '!!!', 'Cf-Ray': 'ray.1' } });
    assert.equal(r2.headers.get('X-Request-Id'), 'ray.1');
    const r3 = await a.request('/api/status', { headers: { Host: LOCAL } });
    assert.match(r3.headers.get('X-Request-Id') ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const r4 = await a.request('/api/status', { headers: { Host: LOCAL, 'X-Request-Id': 'a'.repeat(300) } });
    assert.equal(r4.headers.get('X-Request-Id'), 'a'.repeat(128));
    assert.deepEqual(lines().map((o) => o.status), [401, 401, 401, 401]);
  });
  test('ヘルスチェックは出さない', async () => {
    const { log, lines } = capture();
    const a = app({ requestLog: true, log });
    for (const p of ['/health', '/health/live', '/health/ready']) assert.equal((await a.request(p)).headers.get('X-Request-Id'), null);
    await a.request('/healthz', { headers: { Host: LOCAL } });
    assert.deepEqual(lines(), []);
  });
  test('無効なら出さず、X-Request-Id も付けない', async () => {
    const { log, lines } = capture();
    const r = await app({ log }).request('/api/status', { headers: { Host: LOCAL, 'Tailscale-User-Login': USER, 'X-Request-Id': 'r1' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('X-Request-Id'), null);
    assert.deepEqual(lines(), []);
  });
});

describe('onError', () => {
  test('log.error に出し、応答は今と同じ 500 Internal Server Error', async () => {
    const { log, lines } = capture();
    const a = app({ log, ready: () => { throw new Error('boom-in-ready'); } });
    const r = await a.request('/health/ready?x=1', { headers: { 'X-Request-Id': 'rid-1' } });
    assert.equal(r.status, 500);
    assert.equal(await r.text(), 'Internal Server Error');
    const [o] = lines();
    assert.equal(o.level, 'error');
    assert.equal(o.msg, 'web: unhandled error');
    assert.equal(o.error, 'boom-in-ready');
    assert.equal(typeof o.stack, 'string');
    assert.equal(o.method, 'GET');
    assert.equal(o.path, '/health/ready');
    assert.equal(o.request_id, 'rid-1');
  });
  test('アクセスログが有効なら同じ request_id。HTTPException はその応答を返す（今の挙動）', async () => {
    const { log, lines } = capture();
    const a = app({ log, requestLog: true, pwaDir: undefined });
    a.get('/boom', () => {
      throw new Error('boom');
    });
    a.get('/teapot', () => {
      throw new HTTPException(418, { message: 'teapot' });
    });
    const r = await a.request('/boom', { headers: { Host: LOCAL, 'Tailscale-User-Login': USER } });
    assert.equal(r.status, 500);
    const id = r.headers.get('X-Request-Id');
    const l = lines();
    assert.equal(l[0].msg, 'web: unhandled error');
    assert.equal(l[0].request_id, id);
    assert.equal(l[1].msg, 'request');
    assert.equal(l[1].status, 500);
    const t = await a.request('/teapot', { headers: { Host: LOCAL, 'Tailscale-User-Login': USER } });
    assert.equal(t.status, 418);
    assert.equal(await t.text(), 'teapot');
    assert.equal(lines().filter((o) => o.level === 'error').length, 1);
  });
});
