// Cloudflare Access の JWT 検証（#102、src/web/access.ts・src/web/auth.ts）。
// RSA 鍵はテストの中で作り、JWKS は偽の fetch で返す（実物の Cloudflare には通信しない）。app.request() で叩く（ポートを開かない）。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createAccessVerifier } from '../../src/web/access.ts';
import { createAuth, userOf } from '../../src/web/auth.ts';
import { tagRoutes } from '../../src/web/routes/tags.ts';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const HOST = 'keihi.example.com';
const USER = 'you@example.com';
const SERVICE = 'svc-0123.access';
const T0 = new Date('2026-11-19T00:00:00Z');
const SEC = T0.getTime() / 1000;

type Pair = { kid: string; priv: KeyObject; jwk: Record<string, unknown> };
let k1: Pair;
let k2: Pair;

function makePair(kid: string): Pair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, priv: privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function jwt(payload: Record<string, unknown>, opts: { pair?: Pair; header?: Record<string, unknown> } = {}): string {
  const pair = opts.pair ?? k1;
  const head = b64(opts.header ?? { alg: 'RS256', kid: pair.kid, typ: 'JWT' });
  const body = b64(payload);
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.priv).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const claims = (extra: Record<string, unknown> = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], email: USER, iat: SEC - 10, nbf: SEC - 10, exp: SEC + 600, ...extra });

// 偽の JWKS。keys を差し替えたり落としたりする。
function fakeJwks(initial: Pair[]) {
  const state = { keys: initial.map((p) => p.jwk) as unknown[], down: false, calls: 0, urls: [] as string[] };
  const f = (async (url: string | URL | Request) => {
    state.calls++;
    state.urls.push(String(url));
    if (state.down) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ keys: state.keys }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { state, fetch: f };
}

function clock(start = T0) {
  let t = start.getTime();
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

before(() => {
  k1 = makePair('kid-1');
  k2 = makePair('kid-2');
});

describe('createAccessVerifier', () => {
  test('正しい JWT は通る（email と common_name を返す）。JWKS は teamDomain の certs から取る', async () => {
    const j = fakeJwks([k1]);
    const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j.fetch, now: () => T0 });
    assert.deepEqual(await v.verify(jwt(claims())), { ok: true, email: USER, commonName: null });
    assert.deepEqual(await v.verify(jwt(claims({ aud: AUD, email: undefined, common_name: SERVICE }))), { ok: true, email: null, commonName: SERVICE });
    assert.deepEqual(j.state.urls, [`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  test('aud 違い・iss 違い・期限切れ・nbf が未来・exp が無いものは通らない', async () => {
    const j = fakeJwks([k1]);
    const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j.fetch, now: () => T0 });
    const cases: [Record<string, unknown>, string][] = [
      [{ aud: ['other-aud'] }, 'aud'],
      [{ aud: 'other-aud' }, 'aud'],
      [{ aud: undefined }, 'aud'],
      [{ iss: 'https://other.cloudflareaccess.com' }, 'iss'],
      [{ exp: SEC - 61 }, 'exp'],
      [{ exp: undefined }, 'exp'],
      [{ exp: String(SEC + 600) }, 'exp'],
      [{ nbf: SEC + 120 }, 'nbf'],
    ];
    for (const [extra, reason] of cases) assert.deepEqual(await v.verify(jwt(claims(extra))), { ok: false, reason }, JSON.stringify(extra));
    // 時計のずれは 60 秒まで許す
    assert.equal((await v.verify(jwt(claims({ exp: SEC - 30, nbf: SEC + 30 })))).ok, true);
  });

  test('alg: none と HS256（公開鍵を共有鍵にした偽造）は拒否する', async () => {
    const j = fakeJwks([k1]);
    const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j.fetch, now: () => T0 });
    const body = b64(claims());
    const none = b64({ alg: 'none', kid: k1.kid });
    assert.equal((await v.verify(`${none}.${body}.`)).ok, false);
    assert.deepEqual(await v.verify(`${none}.${body}.AAAA`), { ok: false, reason: 'alg' });
    const hs = b64({ alg: 'HS256', kid: k1.kid });
    const secret = JSON.stringify(k1.jwk);
    const mac = createHmac('sha256', secret).update(`${hs}.${body}`).digest('base64url');
    assert.deepEqual(await v.verify(`${hs}.${body}.${mac}`), { ok: false, reason: 'alg' });
    assert.deepEqual(await v.verify(jwt(claims(), { header: { alg: 'RS256' } })), { ok: false, reason: 'kid' });
  });

  test('署名の改ざん・別の鍵で署名したものは通らない', async () => {
    const j = fakeJwks([k1]);
    const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j.fetch, now: () => T0 });
    const [h, , s] = jwt(claims()).split('.');
    const forged = `${h}.${b64(claims({ email: 'other@example.com' }))}.${s}`;
    assert.deepEqual(await v.verify(forged), { ok: false, reason: 'signature' });
    const other = makePair('kid-1'); // kid は同じで鍵が違う
    assert.deepEqual(await v.verify(jwt(claims(), { pair: other })), { ok: false, reason: 'signature' });
    assert.deepEqual(await v.verify(`${h}.${b64(claims())}.${s.slice(0, -4)}`), { ok: false, reason: 'signature' });
  });

  test('壊れたトークンは例外にせず ok: false（malformed・too_large）', async () => {
    const j = fakeJwks([k1]);
    const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j.fetch, now: () => T0 });
    for (const t of ['', 'abc', 'a.b', 'a.b.c.d', '!!.!!.!!', 'e30.bm90IGpzb24.AAAA', `${b64([1])}.${b64({})}.AAAA`, `${b64(null)}.${b64({})}.AAAA`]) {
      const r = await v.verify(t);
      assert.equal(r.ok, false, t);
      assert.equal(r.ok === false && r.reason, 'malformed', t);
    }
    assert.deepEqual(await v.verify(jwt(claims({ pad: 'x'.repeat(9000) }))), { ok: false, reason: 'too_large' });
    assert.equal(j.state.calls, 0);
  });

  test('知らない kid は取り直す（60 秒に 1 回まで）', async () => {
    const j = fakeJwks([k1]);
    const c = clock();
    const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j.fetch, now: c.now });
    assert.equal((await v.verify(jwt(claims()))).ok, true);
    assert.equal(j.state.calls, 1);
    // 鍵が入れ替わった: 取り直して通る
    j.state.keys = [k1.jwk, k2.jwk];
    c.advance(61_000);
    assert.equal((await v.verify(jwt(claims({ exp: SEC + 6000 }), { pair: k2 }))).ok, true);
    assert.equal(j.state.calls, 2);
    // 60 秒以内の知らない kid は取り直さない
    const k3 = makePair('kid-3');
    j.state.keys = [k1.jwk, k2.jwk, k3.jwk];
    c.advance(10_000);
    assert.deepEqual(await v.verify(jwt(claims({ exp: SEC + 6000 }), { pair: k3 })), { ok: false, reason: 'kid' });
    assert.equal(j.state.calls, 2);
    c.advance(60_000);
    assert.equal((await v.verify(jwt(claims({ exp: SEC + 6000 }), { pair: k3 }))).ok, true);
    assert.equal(j.state.calls, 3);
    // 知っている kid はキャッシュ（1 時間）で取りに行かない
    assert.equal((await v.verify(jwt(claims({ exp: SEC + 6000 })))).ok, true);
    assert.equal(j.state.calls, 3);
  });

  test('並行のリクエストは同じ取得を待つ（JWKS の取得は 1 本だけ）', async () => {
    const j = fakeJwks([k1]);
    const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j.fetch, now: () => T0 });
    const rs = await Promise.all(Array.from({ length: 5 }, () => v.verify(jwt(claims()))));
    assert.ok(rs.every((r) => r.ok));
    assert.equal(j.state.calls, 1);
  });

  test('JWKS が落ちている: キャッシュがあればそれを使い、無ければ unavailable', async () => {
    const j = fakeJwks([k1]);
    const c = clock();
    const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j.fetch, now: c.now });
    assert.equal((await v.verify(jwt(claims({ exp: SEC + 86400 })))).ok, true);
    j.state.down = true;
    c.advance(2 * 60 * 60 * 1000); // キャッシュの期限切れ → 取り直しに失敗 → キャッシュの鍵を使う
    assert.equal((await v.verify(jwt(claims({ exp: SEC + 86400 })))).ok, true);
    assert.equal(j.state.calls, 2);

    const j2 = fakeJwks([k1]);
    j2.state.down = true;
    const v2 = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j2.fetch, now: () => T0 });
    assert.deepEqual(await v2.verify(jwt(claims())), { ok: false, reason: 'jwks_unavailable', unavailable: true });

    // 500 や RSA 以外の鍵しか無い JWKS も「鍵が無い」
    const j3 = fakeJwks([]);
    j3.state.keys = [{ kty: 'EC', kid: k1.kid, crv: 'P-256', x: 'AAAA', y: 'AAAA' }, { kty: 'RSA', kid: 'broken' }, null, 'x'];
    const v3 = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: j3.fetch, now: () => T0 });
    assert.deepEqual(await v3.verify(jwt(claims())), { ok: false, reason: 'jwks_unavailable', unavailable: true });
    const f500 = (async () => new Response('err', { status: 500 })) as typeof fetch;
    const v4 = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetch: f500, now: () => T0 });
    assert.deepEqual(await v4.verify(jwt(claims())), { ok: false, reason: 'jwks_unavailable', unavailable: true });
  });
});

describe('createAuth（cloudflare_access）', () => {
  let root: string;
  let db: Db;
  let n = 0;
  let app: Hono;
  let jwks: ReturnType<typeof fakeJwks>;
  let warns: { msg: string; fields?: Record<string, unknown> }[];

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'keihi-access-'));
  });
  after(async () => {
    db?.close();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    db?.close();
    db = openDb(path.join(root, `${n++}.db`));
    migrate(db);
    jwks = fakeJwks([k1]);
    warns = [];
    app = new Hono();
    app.use('*', createAuth(
      { allowedUsers: [USER], allowedHosts: [HOST], auth: 'cloudflare_access', accessTeamDomain: TEAM, accessAud: AUD, accessServiceTokens: [SERVICE] },
      { fetch: jwks.fetch, now: () => T0, log: { warn: (msg, fields) => void warns.push({ msg, fields }) } },
    ));
    app.get('/healthz', (c) => c.json({ ok: true }));
    app.get('/whoami', (c) => c.json({ user: userOf(c) }));
    app.route('/api', tagRoutes({ db, now: () => T0 }));
  });

  const call = async (p: string, headers: Record<string, string> = {}, init: RequestInit = {}) => {
    const res = await app.request(`https://${HOST}${p}`, { ...init, headers: { Host: HOST, ...headers } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const as = (token: string) => ({ 'Cf-Access-Jwt-Assertion': token });

  test('通ったら user は JWT の email（大文字小文字は区別しない）', async () => {
    assert.deepEqual(await call('/whoami', as(jwt(claims()))), { status: 200, body: { user: USER } });
    assert.deepEqual(await call('/whoami', as(jwt(claims({ email: 'You@Example.com' })))), { status: 200, body: { user: 'You@Example.com' } });
  });

  test('ヘッダなしは 401 unauthenticated。Tailscale-User-Login を付けても通らない', async () => {
    assert.deepEqual(await call('/whoami'), { status: 401, body: { reason: 'unauthenticated' } });
    assert.deepEqual(await call('/whoami', { 'Tailscale-User-Login': USER }), { status: 401, body: { reason: 'unauthenticated' } });
    assert.deepEqual(await call('/whoami', { 'Cf-Access-Jwt-Assertion': '' }), { status: 401, body: { reason: 'unauthenticated' } });
  });

  test('検証の失敗は 401 invalid_token（種別は warn にだけ、トークンは出さない）', async () => {
    const bad = jwt(claims({ aud: ['other-aud'] }));
    assert.deepEqual(await call('/whoami', { ...as(bad), 'Tailscale-User-Login': USER }), { status: 401, body: { reason: 'invalid_token' } });
    assert.deepEqual(await call('/whoami', as('garbage')), { status: 401, body: { reason: 'invalid_token' } });
    assert.deepEqual(warns.map((w) => w.fields), [{ reason: 'aud' }, { reason: 'malformed' }]);
    assert.ok(!JSON.stringify(warns).includes(bad.split('.')[2]));
  });

  test('JWKS が取れず検証できないときは 503 auth_unavailable', async () => {
    jwks.state.down = true;
    assert.deepEqual(await call('/whoami', as(jwt(claims()))), { status: 503, body: { reason: 'auth_unavailable' } });
    assert.deepEqual(warns.map((w) => w.fields), [{ reason: 'jwks_unavailable' }]);
  });

  test('許可されていない email は 403', async () => {
    assert.deepEqual(await call('/whoami', as(jwt(claims({ email: 'other@example.com' })))), { status: 403, body: { reason: 'forbidden' } });
    // email があればサービストークンとしては見ない
    assert.deepEqual(await call('/whoami', as(jwt(claims({ email: 'other@example.com', common_name: SERVICE })))), { status: 403, body: { reason: 'forbidden' } });
  });

  test('サービストークン: 許可された common_name は service:<名前>、それ以外は 403', async () => {
    assert.deepEqual(await call('/whoami', as(jwt(claims({ email: undefined, common_name: SERVICE })))), { status: 200, body: { user: `service:${SERVICE}` } });
    assert.deepEqual(await call('/whoami', as(jwt(claims({ email: undefined, common_name: 'svc-other.access' })))), { status: 403, body: { reason: 'forbidden' } });
    assert.deepEqual(await call('/whoami', as(jwt(claims({ email: undefined })))), { status: 403, body: { reason: 'forbidden' } });
  });

  test('監査ログの user は JWT の email（Tailscale-User-Login ではない）', async () => {
    const r = await call('/api/categories', { ...as(jwt(claims())), 'Tailscale-User-Login': 'other@example.com', 'content-type': 'application/json' }, {
      method: 'POST',
      body: JSON.stringify({ label: 'テスト', color: 3 }),
    });
    assert.equal(r.status, 201);
    const a = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'bank_category.created' ORDER BY seq DESC LIMIT 1`).get() as { payload_json: string };
    assert.equal(JSON.parse(a.payload_json).user, USER);
  });

  test('Host と /healthz の扱いは今のまま', async () => {
    assert.deepEqual(await call('/healthz'), { status: 200, body: { ok: true } });
    const res = await app.request(`https://${HOST}/whoami`, { headers: { Host: 'evil.example', ...as(jwt(claims())) } });
    assert.equal(res.status, 400);
    assert.equal(jwks.state.calls, 0);
  });

  test('team domain か aud が無ければ createAuth が投げる', () => {
    assert.throws(() => createAuth({ allowedUsers: [USER], allowedHosts: [HOST], auth: 'cloudflare_access', accessTeamDomain: TEAM }));
    assert.throws(() => createAuth({ allowedUsers: [USER], allowedHosts: [HOST], auth: 'cloudflare_access', accessAud: AUD, accessTeamDomain: null }));
    assert.doesNotThrow(() => createAuth({ allowedUsers: [USER], allowedHosts: [HOST], auth: 'tailscale' }));
  });
});

describe('createAuth（tailscale）', () => {
  test('userOf はヘッダの利用者を返す', async () => {
    const app = new Hono();
    app.use('*', createAuth({ allowedUsers: [USER], allowedHosts: [HOST] }));
    app.get('/whoami', (c) => c.json({ user: userOf(c) }));
    const res = await app.request(`https://${HOST}/whoami`, { headers: { Host: HOST, 'Tailscale-User-Login': USER, 'Cf-Access-Jwt-Assertion': 'x' } });
    assert.deepEqual(await res.json(), { user: USER });
  });
});

describe('createAuth（none）', () => {
  const app = new Hono();
  app.use('*', createAuth({ allowedUsers: [USER], allowedHosts: [HOST], auth: 'none' }));
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/whoami', (c) => c.json({ user: userOf(c) }));
  app.post('/whoami', (c) => c.json({ user: userOf(c) }));
  const call = async (p: string, headers: Record<string, string> = {}, init: RequestInit = {}) => {
    const res = await app.request(`https://${HOST}${p}`, { ...init, headers: { Host: HOST, ...headers } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test('ヘッダなしで通り、user は allowed_users の 1 件', async () => {
    assert.deepEqual(await call('/whoami'), { status: 200, body: { user: USER } });
    assert.deepEqual(await call('/whoami', {}, { method: 'POST' }), { status: 200, body: { user: USER } });
  });

  test('Tailscale-User-Login・Cf-Access-Jwt-Assertion を付けても見ない（user は固定のまま）', async () => {
    assert.deepEqual(await call('/whoami', { 'Tailscale-User-Login': 'other@example.com' }), { status: 200, body: { user: USER } });
    assert.deepEqual(await call('/whoami', { 'Cf-Access-Jwt-Assertion': 'garbage' }), { status: 200, body: { user: USER } });
  });

  test('Host と Origin の検査、/healthz は今のまま', async () => {
    const res = await app.request(`https://${HOST}/whoami`, { headers: { Host: 'evil.example' } });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { reason: 'invalid_host' });
    assert.deepEqual(await call('/whoami', { Origin: 'https://evil.example' }, { method: 'POST' }), { status: 403, body: { reason: 'invalid_origin' } });
    assert.deepEqual(await call('/whoami', { Origin: `https://${HOST}` }, { method: 'POST' }), { status: 200, body: { user: USER } });
    assert.deepEqual(await call('/healthz'), { status: 200, body: { ok: true } });
  });

  test('allowed_users が 1 件でなければ createAuth が投げる', () => {
    assert.throws(() => createAuth({ allowedUsers: [], allowedHosts: [HOST], auth: 'none' }));
    assert.throws(() => createAuth({ allowedUsers: [USER, 'other@example.com'], allowedHosts: [HOST], auth: 'none' }));
  });
});
