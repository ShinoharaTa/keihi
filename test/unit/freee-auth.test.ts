// freee の OAuth（docs/mvp-plan.md T1-10）: 日次の更新、2 プロセスの同時更新、`keihi freee auth`。実 API は叩かない。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main as cli } from '../../src/cli/keihi.ts';
import { openDb } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { REFRESH_TOKEN_LIFETIME_SEC, REFRESH_TOKEN_RENEW_BEFORE_SEC, TokenStore, refreshIfExpiringSoon } from '../../src/providers/freee/auth.ts';
import { freeeTokenPaths } from '../../src/providers/freee/provider.ts';
import { isReauthRequired, setReauthRequired } from '../../src/providers/freee/state.ts';
import { CLIENT_SECRET, COMPANY, REFRESH, createFreeeMock, storedToken } from '../contracts/mock.ts';

const AUTH_TS = fileURLToPath(new URL('../../src/providers/freee/auth.ts', import.meta.url));
const NOW = Math.floor(Date.now() / 1000);
const creds = { clientId: 'client-id-test', clientSecret: CLIENT_SECRET };

let root: string;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-freee-auth-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
async function dir(): Promise<string> {
  const d = path.join(root, String(n++));
  await mkdir(d);
  return d;
}

describe('refreshIfExpiringSoon（日次）', () => {
  test('リフレッシュトークンの残りが 30 日以上なら更新しない', async () => {
    const d = await dir();
    const { tokenPath, lockPath } = freeeTokenPaths(d);
    const store = new TokenStore(tokenPath, lockPath);
    await store.write(storedToken({}, NOW));
    const m = createFreeeMock();
    const age = REFRESH_TOKEN_LIFETIME_SEC - REFRESH_TOKEN_RENEW_BEFORE_SEC - 60;
    const r = await refreshIfExpiringSoon({ store, creds, fetch: m.fetch, nowSec: () => NOW + age });
    assert.equal(r.refreshed, false);
    assert.equal(m.reqs.length, 0);
  });

  test('残り 30 日を切ったら 1 回だけ更新して保存する（0600、一時ファイルを残さない）', async () => {
    const d = await dir();
    const { tokenPath, lockPath } = freeeTokenPaths(d);
    const store = new TokenStore(tokenPath, lockPath);
    await store.write(storedToken({}, NOW));
    const m = createFreeeMock();
    const later = NOW + REFRESH_TOKEN_LIFETIME_SEC - REFRESH_TOKEN_RENEW_BEFORE_SEC + 1;
    const r = await refreshIfExpiringSoon({ store, creds, fetch: m.fetch, nowSec: () => later });
    assert.equal(r.refreshed, true);
    assert.equal(m.reqs.length, 1);
    assert.equal((m.reqs[0].body as URLSearchParams).get('refresh_token'), REFRESH);
    const saved = (await store.read())!;
    assert.equal(saved.refresh_token, 'rt-TEST-new-1-0123456789');
    assert.equal(saved.company_id, COMPANY);
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.equal(lockPath, path.join(d, 'freee-token.lock'));
    await assert.rejects(stat(lockPath), /ENOENT/);
    await assert.rejects(stat(`${tokenPath}.tmp-${process.pid}`), /ENOENT/);
  });

  test('invalid_grant は error = invalid_grant の例外で、トークン・secret を含まない', async () => {
    const d = await dir();
    const store = new TokenStore(freeeTokenPaths(d).tokenPath, freeeTokenPaths(d).lockPath);
    await store.write(storedToken({ created_at: NOW - REFRESH_TOKEN_LIFETIME_SEC }));
    const m = createFreeeMock({ tokenStatus: () => 401 });
    await assert.rejects(refreshIfExpiringSoon({ store, creds, fetch: m.fetch }), (e: Error & { error?: string }) => {
      assert.equal(e.error, 'invalid_grant');
      for (const s of [REFRESH, CLIENT_SECRET]) assert.ok(!e.message.includes(s));
      return true;
    });
  });
});

describe('2 プロセスから同時に更新', () => {
  test('更新の要求は 1 回だけで、両方が同じ新しいトークンを使う', async () => {
    const d = await dir();
    const { tokenPath, lockPath } = freeeTokenPaths(d);
    await new TokenStore(tokenPath, lockPath).write(storedToken({ created_at: NOW - 30000 }));
    const counter = path.join(d, 'token-requests.log');
    await writeFile(counter, '');
    const script = path.join(d, 'child.mjs');
    await writeFile(
      script,
      `import { appendFileSync } from 'node:fs';
import { TokenStore, createTokenProvider } from ${JSON.stringify(pathToFileURL(AUTH_TS).href)};
const [tokenPath, lockPath, counter] = process.argv.slice(2);
let i = 0;
const f = async (url, init) => {
  appendFileSync(counter, process.pid + '\\n');
  await new Promise((r) => setTimeout(r, 300));
  i++;
  return new Response(JSON.stringify({ access_token: 'at-TEST-child-' + process.pid, refresh_token: 'rt-TEST-child-' + process.pid,
    token_type: 'bearer', expires_in: 21600, created_at: Math.floor(Date.now() / 1000), company_id: ${COMPANY}, scope: 'read write' }), { status: 200 });
};
const tp = createTokenProvider({ store: new TokenStore(tokenPath, lockPath), creds: { clientId: 'c', clientSecret: 's' }, fetch: f });
process.stdout.write(await tp.get());
`,
    );
    const run = () =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const p = spawn(process.execPath, [script, tokenPath, lockPath, counter], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        p.stdout.on('data', (b) => (out += b));
        p.stderr.on('data', (b) => (err += b));
        p.on('close', (code) => resolve({ code, out, err }));
      });
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a.code, 0, a.err);
    assert.equal(b.code, 0, b.err);
    const lines = (await readFile(counter, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(a.out, b.out);
    assert.match(a.out, /^at-TEST-child-\d+$/);
  });
});

describe('keihi freee auth', () => {
  async function setup(opts: { prod?: number | null; poc?: number | null; db?: boolean } = {}) {
    const base = await dir();
    const configDir = path.join(base, 'config');
    const dataDir = path.join(base, 'data');
    await mkdir(configDir);
    await mkdir(dataDir);
    const lines = ['[freee]'];
    if (opts.poc !== null) lines.push(`poc_company_id = ${opts.poc ?? 222}`);
    if (opts.prod !== null) lines.push(`prod_company_id = ${opts.prod ?? COMPANY}`);
    await writeFile(path.join(configDir, 'config.toml'), lines.join('\n') + '\n');
    await writeFile(path.join(configDir, 'secrets.env'), `FREEE_CLIENT_ID=client-id-test\nFREEE_CLIENT_SECRET=${CLIENT_SECRET}\n`);
    await chmod(path.join(configDir, 'secrets.env'), 0o600);
    if (opts.db !== false) {
      const db = openDb(path.join(dataDir, 'keihi.db'));
      migrate(db);
      setReauthRequired(db, true);
      db.close();
    }
    const out: string[] = [];
    const deps = { log: (s: string) => out.push(s), error: (s: string) => out.push(s), readCode: async () => 'code-TEST-0123456789\n' };
    return { configDir, dataDir, out, deps, args: ['--config-dir', configDir, '--data-dir', dataDir] };
  }

  test('認可 URL を出し、code を交換して保存し、再認可の印を消す。トークン・secret・code は表示しない', async () => {
    const s = await setup();
    const m = createFreeeMock();
    assert.equal(await cli(['freee', 'auth', ...s.args], { ...s.deps, fetch: m.fetch }), 0, s.out.join('\n'));
    const url = new URL(s.out.find((l) => l.startsWith('https://'))!);
    assert.equal(url.searchParams.get('redirect_uri'), 'urn:ietf:wg:oauth:2.0:oob');
    assert.equal(url.searchParams.get('prompt'), 'select_company');
    const body = m.reqs[0].body as URLSearchParams;
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'code-TEST-0123456789');
    const { tokenPath } = freeeTokenPaths(s.dataDir);
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.equal((await new TokenStore(tokenPath).read())!.access_token, 'at-TEST-new-1-0123456789');
    const text = s.out.join('\n');
    for (const secret of [CLIENT_SECRET, 'code-TEST-0123456789', 'at-TEST-new-1', 'rt-TEST-new-1']) assert.ok(!text.includes(secret), secret);
    const db = openDb(path.join(s.dataDir, 'keihi.db'));
    assert.equal(isReauthRequired(db), false);
    assert.deepEqual((db.prepare('SELECT purpose, status FROM freee_calls').all()).map((r) => ({ ...r })), [{ purpose: 'auth', status: 200 }]);
    db.close();
  });

  test('応答の事業所が対象と違えば保存しない', async () => {
    const s = await setup({ prod: 333 });
    const m = createFreeeMock();
    assert.equal(await cli(['freee', 'auth', ...s.args], { ...s.deps, fetch: m.fetch }), 1);
    assert.match(s.out.join('\n'), /対象（333）と違う。保存しない/);
    await assert.rejects(stat(freeeTokenPaths(s.dataDir).tokenPath), /ENOENT/);
  });

  test('--company は設定の poc / prod のどちらかだけ。prod が無く --company も無ければ止める', async () => {
    const s = await setup({ prod: null, poc: COMPANY });
    const m = createFreeeMock();
    assert.equal(await cli(['freee', 'auth', '--company', '999', ...s.args], { ...s.deps, fetch: m.fetch }), 1);
    assert.match(s.out.join('\n'), /どちらでもない/);
    assert.equal(await cli(['freee', 'auth', ...s.args], { ...s.deps, fetch: m.fetch }), 1);
    assert.match(s.out.join('\n'), /prod_company_id が無い/);
    assert.equal(m.reqs.length, 0);
    assert.equal(await cli(['freee', 'auth', '--company', String(COMPANY), ...s.args], { ...s.deps, fetch: m.fetch }), 0, s.out.join('\n'));
  });

  test('DB が無くても保存はする（再認可の印は更新しないと表示）', async () => {
    const s = await setup({ db: false });
    const m = createFreeeMock();
    assert.equal(await cli(['freee', 'auth', ...s.args], { ...s.deps, fetch: m.fetch }), 0, s.out.join('\n'));
    assert.match(s.out.join('\n'), /freee_reauth_required は更新していない/);
    await assert.rejects(stat(path.join(s.dataDir, 'keihi.db')), /ENOENT/);
  });

  test('知らないサブコマンドは使い方を出して 2', async () => {
    const out: string[] = [];
    assert.equal(await cli(['freee', 'nope'], { error: (s) => out.push(s) }), 2);
    assert.match(out.join(), /使い方/);
  });
});
