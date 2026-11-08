// Gmail の OAuth（PKCE）と `keihi gmail auth <id>`。一時ディレクトリだけを使い、トークンエンドポイントは fetch のモック。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main as cli } from '../../src/cli/keihi.ts';
import { openDb } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import {
  buildAuthorizeUrl,
  createGmailTokenProvider,
  createPkce,
  gmailTokenPaths,
  isGmailReauthRequired,
  parseAuthResponse,
  REDIRECT_URI,
  SCOPE,
  setGmailReauthRequired,
  TOKEN_URL,
  type GmailToken,
} from '../../src/mail/gmail/auth.ts';
import { TokenStore } from '../../src/providers/freee/auth.ts';
import { createGmailMock, token } from './gmail-mock.ts';

const CLIENT_SECRET = 'gmail-client-secret-TEST';
let root: string;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-gmail-auth-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('PKCE と認可 URL', () => {
  test('S256 の challenge、scope は gmail.readonly だけ、redirect_uri はループバック、offline + consent', () => {
    const p = createPkce();
    assert.ok(p.verifier.length >= 43 && p.verifier.length <= 128);
    assert.equal(p.challenge, createHash('sha256').update(p.verifier).digest('base64url'));
    const u = new URL(buildAuthorizeUrl('cid', p));
    assert.equal(u.searchParams.get('scope'), SCOPE);
    assert.equal(SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:8797/');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('code_challenge'), p.challenge);
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('prompt'), 'consent');
    assert.equal(u.searchParams.get('state'), p.state);
    assert.ok(!u.href.includes(p.verifier));
  });

  test('止まった URL か code だけから code を取り出す。state 違い・error・code なしは拒否', () => {
    assert.equal(parseAuthResponse(`${REDIRECT_URI}?state=s1&code=4%2Fabc&scope=x`, 's1'), '4/abc');
    assert.equal(parseAuthResponse('  4/abc  ', 's1'), '4/abc');
    assert.throws(() => parseAuthResponse(`${REDIRECT_URI}?state=s2&code=x`, 's1'), /state/);
    assert.throws(() => parseAuthResponse(`${REDIRECT_URI}?error=access_denied&state=s1`, 's1'), /access_denied/);
    assert.throws(() => parseAuthResponse(`${REDIRECT_URI}?state=s1`, 's1'), /code/);
    assert.throws(() => parseAuthResponse('', 's1'), /空/);
  });

  test('URL なら state は必須、host は 127.0.0.1:8797', () => {
    assert.throws(() => parseAuthResponse(`${REDIRECT_URI}?code=x`, 's1'), /state が無い/);
    assert.throws(() => parseAuthResponse('http://127.0.0.1:9999/?state=s1&code=x', 's1'), /ホスト/);
    assert.throws(() => parseAuthResponse('https://evil.example.com/?state=s1&code=x', 's1'), /ホスト/);
  });

  test('http:// が欠けた 127.0.0.1:8797/?… も URL として扱う', () => {
    assert.equal(parseAuthResponse('127.0.0.1:8797/?state=s1&code=4%2Fabc', 's1'), '4/abc');
    assert.throws(() => parseAuthResponse('127.0.0.1:8797/?state=s2&code=x', 's1'), /state/);
  });
});

describe('トークンの更新', () => {
  test('期限が近ければ更新し、refresh_token が応答に無ければ前のものを残す', async () => {
    const d = await mkdtemp(path.join(root, 'tp-'));
    const { tokenPath, lockPath } = gmailTokenPaths(d, 'personal');
    assert.equal(path.basename(tokenPath), 'gmail-token-personal.json');
    const store = new TokenStore<GmailToken>(tokenPath, lockPath);
    await store.write(token({ created_at: 1 }));
    const gm = createGmailMock();
    const tp = createGmailTokenProvider({ store, creds: { clientId: 'c', clientSecret: 's' }, fetch: gm.fetch });
    assert.equal(await tp.get(), 'access-NEW');
    const saved = (await store.read())!;
    assert.equal(saved.refresh_token, 'refresh-SECRET-1');
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.equal(gm.calls[0]!.url, TOKEN_URL);
    // 2 回目はキャッシュ（呼ばない）。
    assert.equal(await tp.get(), 'access-NEW');
    assert.equal(gm.calls.length, 1);
  });
});

describe('keihi gmail auth <id>', () => {
  async function setup(opts: { db?: boolean; accounts?: string[] } = {}) {
    const base = path.join(root, `cli-${n++}`);
    const configDir = path.join(base, 'config');
    const dataDir = path.join(base, 'data');
    await mkdir(configDir, { recursive: true });
    await mkdir(dataDir);
    const lines: string[] = [];
    for (const id of opts.accounts ?? ['personal', 'work']) lines.push('[[mail.accounts]]', `id = "${id}"`);
    await writeFile(path.join(configDir, 'config.toml'), lines.join('\n') + '\n');
    await writeFile(path.join(configDir, 'secrets.env'), `GMAIL_CLIENT_ID=gmail-client-id\nGMAIL_CLIENT_SECRET=${CLIENT_SECRET}\n`);
    await chmod(path.join(configDir, 'secrets.env'), 0o600);
    if (opts.db !== false) {
      const db = openDb(path.join(dataDir, 'keihi.db'));
      migrate(db);
      setGmailReauthRequired(db, 'work', true);
      setGmailReauthRequired(db, 'personal', true);
      db.close();
    }
    const out: string[] = [];
    let state = '';
    let pasted = (s: string) => `${REDIRECT_URI}?state=${s}&code=4%2Fcode-TEST-0123&scope=${encodeURIComponent(SCOPE)}`;
    const deps = {
      log: (s: string) => out.push(s),
      error: (s: string) => out.push(s),
      readCode: async () => {
        state = new URL(out.find((l) => l.startsWith('https://accounts.google.com/'))!).searchParams.get('state')!;
        return pasted(state) + '\n';
      },
    };
    return { configDir, dataDir, out, deps, args: ['--config-dir', configDir, '--data-dir', dataDir], setPasted: (f: (s: string) => string) => (pasted = f) };
  }

  test('URL を出し、code を PKCE で交換して 0600 で保存し、そのアカウントの再認可の印だけを消す。秘密は表示しない', async () => {
    const s = await setup();
    const gm = createGmailMock();
    gm.setToken(200, { access_token: 'access-FIRST', refresh_token: 'refresh-FIRST-SECRET', expires_in: 3599, token_type: 'Bearer', scope: SCOPE });
    const reqs: { url: string; body: string }[] = [];
    const f: typeof fetch = async (input, init) => {
      reqs.push({ url: String(input), body: String(init?.body ?? '') });
      return gm.fetch(input, init);
    };
    assert.equal(await cli(['gmail', 'auth', 'work', ...s.args], { ...s.deps, fetch: f }), 0, s.out.join('\n'));
    const tokenReq = reqs.find((r) => r.url === TOKEN_URL)!;
    const body = new URLSearchParams(tokenReq.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), '4/code-TEST-0123');
    assert.equal(body.get('redirect_uri'), REDIRECT_URI);
    const authUrl = new URL(s.out.find((l) => l.startsWith('https://accounts.google.com/'))!);
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), authUrl.searchParams.get('code_challenge'));
    const { tokenPath } = gmailTokenPaths(s.dataDir, 'work');
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(tokenPath, 'utf8')) as GmailToken;
    assert.equal(saved.refresh_token, 'refresh-FIRST-SECRET');
    const db = openDb(path.join(s.dataDir, 'keihi.db'));
    assert.equal(isGmailReauthRequired(db, 'work'), false);
    assert.equal(isGmailReauthRequired(db, 'personal'), true);
    db.close();
    const all = s.out.join('\n');
    for (const secret of [CLIENT_SECRET, 'access-FIRST', 'refresh-FIRST-SECRET', '4/code-TEST-0123', body.get('code_verifier')!]) assert.ok(!all.includes(secret), secret);
    assert.match(all, /someone@example\.com/);
  });

  test('知らないアカウント・state 違い・引数なしは失敗し、保存しない', async () => {
    const s = await setup();
    const gm = createGmailMock();
    assert.equal(await cli(['gmail', 'auth', 'nope', ...s.args], { ...s.deps, fetch: gm.fetch }), 1);
    assert.match(s.out.join('\n'), /personal, work/);
    s.setPasted(() => `${REDIRECT_URI}?state=other&code=x`);
    assert.equal(await cli(['gmail', 'auth', 'work', ...s.args], { ...s.deps, fetch: gm.fetch }), 1);
    await assert.rejects(stat(gmailTokenPaths(s.dataDir, 'work').tokenPath));
    assert.equal(gm.calls.length, 0);
    assert.equal(await cli(['gmail', 'auth', ...s.args], { ...s.deps, fetch: gm.fetch }), 2);
  });

  test('応答の scope に gmail.readonly が無ければ（権限のチェックを外した）保存しない', async () => {
    const s = await setup();
    const gm = createGmailMock();
    gm.setToken(200, { access_token: 'a', refresh_token: 'r', expires_in: 3599, token_type: 'Bearer', scope: 'openid' });
    assert.equal(await cli(['gmail', 'auth', 'work', ...s.args], { ...s.deps, fetch: gm.fetch }), 1);
    assert.match(s.out.join('\n'), /権限のチェックが外されています。やり直してください/);
    await assert.rejects(stat(gmailTokenPaths(s.dataDir, 'work').tokenPath));
    const db = openDb(path.join(s.dataDir, 'keihi.db'));
    assert.equal(isGmailReauthRequired(db, 'work'), true);
    db.close();
  });

  test('invalid_grant（code の使い回しなど）は失敗し、保存しない', async () => {
    const s = await setup();
    const gm = createGmailMock();
    gm.setToken(400, { error: 'invalid_grant' });
    assert.equal(await cli(['gmail', 'auth', 'personal', ...s.args], { ...s.deps, fetch: gm.fetch }), 1);
    assert.match(s.out.join('\n'), /invalid_grant/);
    await assert.rejects(stat(gmailTokenPaths(s.dataDir, 'personal').tokenPath));
  });
});
