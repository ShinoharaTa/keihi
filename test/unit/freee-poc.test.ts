// T0-2' freee 版 PoC と最小の OAuth / API クライアント（docs/freee-codex.md §3）。実 API は呼ばない（fetch をモック）。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import {
  LOCK_WAIT_MS,
  TOKEN_TIMEOUT_MS,
  TOKEN_URL,
  TokenStore,
  buildAuthorizeUrl,
  createTokenProvider,
  type StoredToken,
} from '../../src/providers/freee/auth.ts';
import { FreeeGuardError, createFreeeClient } from '../../src/providers/freee/client.ts';
import {
  CreatedLog,
  createDryRunFetch,
  main,
  padJpegTo,
  resultsTemplate,
  shapeOf,
  tokenFile,
  updateResults,
  type CreatedEntry,
} from '../../tools/poc/freee-poc.ts';
import { main as authMain } from '../../tools/poc/freee-auth.ts';

const POC = 111;
const PROD = 222;
const CLIENT_SECRET = 'cs-TEST-not-a-real-secret-0123456789';
const ACCESS = 'at-TEST-old-access-0123456789';
const REFRESH = 'rt-TEST-old-refresh-0123456789';
const FIXTURES = 'test/fixtures/receipts';
const NOW = () => Math.floor(Date.now() / 1000);

let work: string;
let n = 0;

type Req = { method: string; url: URL; headers: Headers; body: unknown };

const token = (over: Partial<StoredToken> = {}): StoredToken => ({
  access_token: ACCESS,
  refresh_token: REFRESH,
  token_type: 'bearer',
  expires_in: 21600,
  created_at: NOW(),
  company_id: POC,
  scope: 'read write',
  ...over,
});

async function makeConfigDir(opts: { token?: StoredToken | null; prodToken?: StoredToken } = {}): Promise<string> {
  const dir = path.join(work, `cfg${n++}`);
  await mkdir(dir);
  await writeFile(path.join(dir, 'config.toml'), `[freee]\npoc_company_id = ${POC}\nprod_company_id = ${PROD}\n`);
  await writeFile(path.join(dir, 'secrets.env'), `FREEE_CLIENT_ID=client-id-test\nFREEE_CLIENT_SECRET=${CLIENT_SECRET}\n`);
  await chmod(path.join(dir, 'secrets.env'), 0o600);
  if (opts.token !== null) await new TokenStore(tokenFile(dir, 'poc')).write(opts.token ?? token());
  if (opts.prodToken) await new TokenStore(tokenFile(dir, 'prod')).write(opts.prodToken);
  return dir;
}

// 送られたリクエストを記録し、トークンエンドポイントは呼ばれるたびに新しいトークンを返すモック。
// それ以外は dry-run の固定応答を使う。
function mockFetch(opts: { tokenStatus?: (refreshToken: string, i: number) => number; override?: (r: Req) => Response | null } = {}) {
  const reqs: Req[] = [];
  const issued: string[] = [];
  const used = new Set<string>();
  const base = createDryRunFetch(() => {}, POC);
  let i = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const r: Req = { method: (init?.method ?? 'GET').toUpperCase(), url, headers: new Headers(init?.headers), body: init?.body };
    reqs.push(r);
    if (`${url.origin}${url.pathname}` === TOKEN_URL) {
      const form = init?.body as URLSearchParams;
      const rt = form.get('refresh_token') ?? '';
      const st = opts.tokenStatus ? opts.tokenStatus(rt, i) : used.has(rt) ? 401 : 200;
      used.add(rt);
      i++;
      if (st !== 200) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'x' }), { status: st });
      const at = `at-TEST-new-${i}-0123456789`;
      const nrt = `rt-TEST-new-${i}-0123456789`;
      issued.push(at, nrt);
      return new Response(JSON.stringify({ access_token: at, refresh_token: nrt, token_type: 'bearer', expires_in: 21600, created_at: NOW(), company_id: POC, scope: 'read write' }), { status: 200 });
    }
    const o = opts.override?.(r);
    if (o) return o;
    return base(input, init);
  }) as typeof fetch;
  return { fetch: f, reqs, issued };
}

function sink() {
  const lines: string[] = [];
  return { lines, log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) };
}

before(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'keihi-freee-poc-'));
});

after(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('OAuth', () => {
  test('認可 URL は oob と prompt=select_company', () => {
    const u = new URL(buildAuthorizeUrl('cid'));
    assert.equal(u.origin + u.pathname, 'https://accounts.secure.freee.co.jp/public_api/authorize');
    assert.equal(u.searchParams.get('redirect_uri'), 'urn:ietf:wg:oauth:2.0:oob');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('prompt'), 'select_company');
  });

  test('期限切れなら 1 回だけ更新し、新しいトークンを 0600 で保存してから使う', async () => {
    const dir = await makeConfigDir({ token: token({ created_at: NOW() - 30000 }) });
    const store = new TokenStore(tokenFile(dir, 'poc'));
    const m = mockFetch();
    const p = createTokenProvider({ store, creds: { clientId: 'c', clientSecret: CLIENT_SECRET }, fetch: m.fetch });
    // 同時に 2 つ呼んでも更新は 1 回（ロックの中で読み直す）
    const [a, b] = await Promise.all([p.get(), p.get()]);
    assert.equal(a, 'at-TEST-new-1-0123456789');
    assert.equal(b, a);
    const tokenReqs = m.reqs.filter((r) => r.url.href === TOKEN_URL);
    assert.equal(tokenReqs.length, 1);
    const form = tokenReqs[0].body as URLSearchParams;
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), REFRESH);
    const saved = (await store.read())!;
    assert.equal(saved.refresh_token, 'rt-TEST-new-1-0123456789');
    assert.equal(saved.company_id, POC);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    // 有効な間は更新しない
    assert.equal(await p.get(), a);
    assert.equal(m.reqs.length, 1);
  });

  test('401 を受けたら 1 回だけ更新して送り直す', async () => {
    const dir = await makeConfigDir();
    const store = new TokenStore(tokenFile(dir, 'poc'));
    let first = true;
    const m = mockFetch({
      override: (r) => {
        if (r.url.pathname !== '/api/1/companies') return null;
        if (first) {
          first = false;
          return new Response('{}', { status: 401 });
        }
        return null;
      },
    });
    const tokens = createTokenProvider({ store, creds: { clientId: 'c', clientSecret: CLIENT_SECRET }, fetch: m.fetch });
    const client = createFreeeClient({ tokens, companyId: POC, fetch: m.fetch });
    const res = await client.request('GET', '/api/1/companies');
    assert.equal(res.status, 200);
    const api = m.reqs.filter((r) => r.url.pathname === '/api/1/companies');
    assert.equal(api.length, 2);
    assert.equal(api[0].headers.get('authorization'), `Bearer ${ACCESS}`);
    assert.equal(api[1].headers.get('authorization'), 'Bearer at-TEST-new-1-0123456789');
  });

  test('読んだトークンは期限が近づくまでファイルを読み直さない', async () => {
    const dir = await makeConfigDir();
    const store = new TokenStore(tokenFile(dir, 'poc'));
    let now = NOW();
    const m = mockFetch();
    const p = createTokenProvider({ store, creds: { clientId: 'c', clientSecret: CLIENT_SECRET }, fetch: m.fetch, nowSec: () => now });
    assert.equal(await p.get(), ACCESS);
    // 他のプロセスが更新したとする
    await store.write(token({ access_token: 'at-TEST-other-0123456789', created_at: now + 1000 }));
    assert.equal(await p.get(), ACCESS);
    // 期限の近くでは読み直し、他が更新した分を使う（自分では更新しない）
    now += 21600 - 200;
    assert.equal(await p.get(), 'at-TEST-other-0123456789');
    assert.equal(m.reqs.length, 0);
  });

  test('ロックの待ち時間はトークン更新のタイムアウトより長い', () => {
    assert.ok(LOCK_WAIT_MS > TOKEN_TIMEOUT_MS);
  });

  test('ロックファイルに pid と時刻を書き、終わったら消す', async () => {
    const dir = await makeConfigDir();
    const store = new TokenStore(tokenFile(dir, 'poc'));
    const held = await store.withLock(async () => JSON.parse(await readFile(store.lockPath, 'utf8')) as { pid: number; at: string });
    assert.equal(held.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(held.at)));
    await assert.rejects(stat(store.lockPath), /ENOENT/);
  });

  test('保持者の pid が生きていないロックは回収する', async () => {
    const dir = await makeConfigDir();
    const store = new TokenStore(tokenFile(dir, 'poc'));
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    await writeFile(store.lockPath, JSON.stringify({ pid: dead, at: '2026-01-01T00:00:00.000Z' }));
    assert.equal(await store.withLock(async () => 'ok', { waitMs: 200 }), 'ok');
  });

  test('保持者が生きていれば待ち、時間切れでも消せとは言わない。保持者が分からなければ消せと言う', async () => {
    const dir = await makeConfigDir();
    const store = new TokenStore(tokenFile(dir, 'poc'));
    await writeFile(store.lockPath, JSON.stringify({ pid: process.pid, at: '2026-01-01T00:00:00.000Z' }));
    await assert.rejects(store.withLock(async () => 'x', { waitMs: 150 }), (e: Error) => {
      assert.match(e.message, new RegExp(`pid ${process.pid}`));
      assert.doesNotMatch(e.message, /消す/);
      return true;
    });
    await writeFile(store.lockPath, 'garbage');
    await assert.rejects(store.withLock(async () => 'x', { waitMs: 150 }), /確かめてから消す/);
    assert.equal(await readFile(store.lockPath, 'utf8'), 'garbage');
  });

  test('パーミッションが 0600 でないトークンファイルは読まない', async () => {
    const dir = await makeConfigDir();
    await chmod(tokenFile(dir, 'poc'), 0o644);
    await assert.rejects(new TokenStore(tokenFile(dir, 'poc')).read(), /0600/);
  });

  test('F2: 新しいトークンを保存し、古いリフレッシュトークンの再利用は invalid_grant で失敗する', async () => {
    const dir = await makeConfigDir();
    const m = mockFetch();
    const s = sink();
    const results = path.join(work, `r${n++}.md`);
    const code = await main(['--only', 'F2', '--config-dir', dir, '--results', results, '--created', path.join(work, `c${n++}.jsonl`)], { fetch: m.fetch, ...s });
    assert.equal(code, 0, s.lines.join('\n'));
    const forms = m.reqs.filter((r) => r.url.href === TOKEN_URL).map((r) => (r.body as URLSearchParams).get('refresh_token'));
    assert.deepEqual(forms, [REFRESH, REFRESH]);
    const saved = (await new TokenStore(tokenFile(dir, 'poc')).read())!;
    assert.equal(saved.refresh_token, 'rt-TEST-new-1-0123456789');
    const md = await readFile(results, 'utf8');
    assert.match(md, /失敗 401 error=invalid_grant/);
  });
});

describe('リクエスト形', () => {
  test('F4・F8・F12 の本文と事業所 ID', async () => {
    const dir = await makeConfigDir();
    const m = mockFetch();
    const s = sink();
    const code = await main(['--only', 'F4,F8,F12', '--config-dir', dir, '--results', path.join(work, `r${n++}.md`), '--created', path.join(work, `c${n++}.jsonl`)], {
      fetch: m.fetch,
      ...s,
    });
    assert.equal(code, 0, s.lines.join('\n'));
    for (const r of m.reqs) {
      if (r.url.href === TOKEN_URL) continue;
      assert.equal(r.url.origin, 'https://api.freee.co.jp');
      assert.equal(r.headers.get('authorization'), `Bearer ${ACCESS}`);
      assert.ok(!r.url.search.includes(ACCESS));
    }
    const uploads = m.reqs.filter((r) => r.method === 'POST' && r.url.pathname === '/api/1/receipts').map((r) => r.body as FormData);
    // F4a: メタデータなし
    assert.equal(uploads[0].get('company_id'), String(POC));
    assert.ok(uploads[0].get('receipt') instanceof Blob);
    assert.equal(uploads[0].has('receipt_metadatum_partner_name'), false);
    assert.match(String(uploads[0].get('description')), /^kh-POC-\d{14}-F4a$/);
    // F4b: メタデータあり（r02 の正解）
    assert.equal(uploads[1].get('receipt_metadatum_partner_name'), 'ダミー酒場');
    assert.equal(uploads[1].get('receipt_metadatum_issue_date'), '2026-09-10');
    assert.equal(uploads[1].get('receipt_metadatum_amount'), '19010');
    assert.equal(uploads[1].get('document_type'), 'receipt');
    assert.equal(uploads[1].get('qualified_invoice'), 'qualified');
    // F8: 未決済（payments なし）、receipt_ids、ref_number
    const deal = JSON.parse(String(m.reqs.find((r) => r.method === 'POST' && r.url.pathname === '/api/1/deals')!.body));
    assert.equal(deal.company_id, POC);
    assert.equal(deal.type, 'expense');
    assert.equal(deal.payments, undefined);
    assert.equal(deal.receipt_ids.length, 1);
    assert.match(deal.ref_number, /^kh-POC-\d{14}-F8$/);
    assert.equal(deal.details[0].amount, 4750);
    // F12: company_id はクエリ。act 4 / 11 / 0 と 2 回目
    const rules = m.reqs.filter((r) => r.method === 'POST' && r.url.pathname === '/api/1/user_matchers');
    assert.deepEqual(rules.map((r) => JSON.parse(String(r.body)).act), [4, 11, 0, 4]);
    for (const r of rules) assert.equal(r.url.searchParams.get('company_id'), String(POC));
    const exp = JSON.parse(String(rules[2].body));
    assert.equal(exp.account_item_name, '消耗品費');
    assert.equal(exp.tax_name, '課対仕入10%');
    assert.match(exp.description, /^KHPOC\d{14}EXP$/);
  });

  test('--dry-run はシークレットもトークンも読まず、伏せ字で表示する', async () => {
    const dir = await makeConfigDir();
    const s = sink();
    let called = 0;
    const code = await main(['--dry-run', '--only', 'F2,F4', '--config-dir', dir], {
      fetch: (async () => {
        called++;
        return new Response('{}');
      }) as typeof fetch,
      ...s,
    });
    assert.equal(code, 0, s.lines.join('\n'));
    assert.equal(called, 0);
    const out = s.lines.join('\n');
    assert.match(out, /DRY POST https:\/\/api\.freee\.co\.jp\/api\/1\/receipts auth=Bearer \*\*\* multipart\{company_id=111/);
    assert.match(out, /client_secret=\*\*\*, refresh_token=\*\*\*/);
    assert.ok(!out.includes(CLIENT_SECRET));
    assert.ok(!out.includes(ACCESS));
  });
});

describe('本番事業所の拒否', () => {
  test('--prod 無しの F15、--prod での F15 以外、--prod の cleanup は API を呼ばずに拒否', async () => {
    const dir = await makeConfigDir({ prodToken: token({ company_id: PROD }) });
    for (const args of [['--only', 'F15'], ['--prod', '--only', 'F3'], ['--prod', '--cleanup']]) {
      const m = mockFetch();
      const s = sink();
      assert.equal(await main([...args, '--config-dir', dir], { fetch: m.fetch, ...s }), 2, args.join(' '));
      assert.equal(m.reqs.length, 0);
    }
  });

  test('トークンの事業所が poc_company_id と違えば止める', async () => {
    const dir = await makeConfigDir({ token: token({ company_id: PROD }) });
    const m = mockFetch();
    const s = sink();
    assert.equal(await main(['--only', 'F3', '--config-dir', dir], { fetch: m.fetch, ...s }), 1);
    assert.equal(m.reqs.length, 0);
    assert.match(s.lines.join('\n'), /違う。止める/);
  });

  test('--prod の F15 は GET だけ', async () => {
    const dir = await makeConfigDir({ prodToken: token({ company_id: PROD, access_token: 'at-TEST-prod-0123456789' }) });
    const m = mockFetch();
    const s = sink();
    const code = await main(['--prod', '--config-dir', dir, '--results', path.join(work, `r${n++}.md`), '--created', path.join(work, `c${n++}.jsonl`)], { fetch: m.fetch, ...s });
    assert.equal(code, 0, s.lines.join('\n'));
    assert.ok(m.reqs.length > 0);
    for (const r of m.reqs) {
      assert.equal(r.method, 'GET');
      const cid = r.url.searchParams.get('company_id');
      if (cid !== null) assert.equal(cid, String(PROD));
    }
  });

  test('クライアントは送る前に拒否する（読み取り専用・事業所違い・company_id 無し）', async () => {
    let called = 0;
    const f = (async () => {
      called++;
      return new Response('{}');
    }) as typeof fetch;
    const tokens = { get: async () => 'x' };
    const ro = createFreeeClient({ tokens, companyId: PROD, readOnly: true, fetch: f });
    await assert.rejects(ro.request('POST', '/api/1/receipts', { query: { company_id: PROD } }), FreeeGuardError);
    await assert.rejects(ro.request('GET', '/api/1/walletables', { query: { company_id: POC } }), FreeeGuardError);
    const rw = createFreeeClient({ tokens, companyId: POC, fetch: f });
    await assert.rejects(rw.request('DELETE', '/api/1/deals/1', { query: { company_id: PROD } }), FreeeGuardError);
    await assert.rejects(rw.request('POST', '/api/1/deals', { json: { company_id: PROD } }), FreeeGuardError);
    await assert.rejects(rw.request('POST', '/api/1/deals', { json: {} }), FreeeGuardError);
    assert.equal(called, 0);
  });
});

describe('キー・トークンを外に出さない', () => {
  test('全項目の実行でログ・結果・記録にシークレットとトークンが出ない', async () => {
    // 期限切れから始めて更新も通す。エラー本文にトークンが紛れても伏せ字になること。
    const dir = await makeConfigDir({ token: token({ created_at: NOW() - 30000 }) });
    const m = mockFetch({
      override: (r) =>
        r.url.pathname === '/api/1/partners'
          ? new Response(JSON.stringify({ errors: [{ messages: [`bad token ${r.headers.get('authorization')}`] }] }), { status: 400 })
          : null,
    });
    const s = sink();
    const results = path.join(work, `r${n++}.md`);
    const created = path.join(work, `c${n++}.jsonl`);
    await main(['--config-dir', dir, '--results', results, '--created', created], { fetch: m.fetch, ...s });
    const texts = [s.lines.join('\n'), await readFile(results, 'utf8'), await readFile(created, 'utf8')];
    assert.ok(m.issued.length >= 2);
    for (const secret of [CLIENT_SECRET, ACCESS, REFRESH, ...m.issued]) {
      for (const t of texts) assert.ok(!t.includes(secret), `漏れた: ${secret.slice(0, 12)}`);
    }
    assert.match(texts[0], /bad token Bearer \*\*\*/);
    // 結果ファイルに F1〜F16（F15 以外）のブロックが埋まる
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F16']) {
      assert.match(texts[1], new RegExp(`<!-- ${id}:auto:begin -->\\n_自動記録`));
    }
    assert.match(texts[1], /<!-- F15:auto:begin -->\n（未実行）/);
  });
});

describe('cleanup', () => {
  test('記録した ID のうち、この事業所の未削除のものだけを順に消す', async () => {
    const dir = await makeConfigDir();
    const created = path.join(work, `c${n++}.jsonl`);
    const at = '2026-10-17T00:00:00.000Z';
    const e = (op: CreatedEntry['op'], type: CreatedEntry['type'], id: number, company_id = POC): CreatedEntry => ({ op, type, id, company_id, step: 'F4', at });
    const entries = [
      e('created', 'receipt', 11),
      e('created', 'deal', 12),
      e('created', 'wallet_txn', 13),
      e('created', 'user_matcher', 14),
      e('created', 'receipt', 15),
      e('deleted', 'wallet_txn', 13),
      e('created', 'receipt', 99, PROD),
    ];
    await writeFile(created, entries.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const m = mockFetch({ override: (r) => (r.url.pathname === '/api/1/receipts/15' ? new Response('{}', { status: 404 }) : null) });
    const s = sink();
    assert.equal(await main(['--cleanup', '--config-dir', dir, '--created', created], { fetch: m.fetch, ...s }), 0, s.lines.join('\n'));
    const dels = m.reqs.filter((r) => r.method === 'DELETE');
    assert.deepEqual(
      dels.map((r) => r.url.pathname),
      ['/api/1/deals/12', '/api/1/receipts/15', '/api/1/receipts/11', '/api/1/user_matchers/14'],
    );
    for (const r of dels) assert.equal(r.url.searchParams.get('company_id'), String(POC));
    assert.equal(m.reqs.filter((r) => r.method !== 'DELETE' && r.url.href !== TOKEN_URL).length, 0);
    // 2 回目は何も消さない（404 も削除済みとして記録した）
    const m2 = mockFetch();
    assert.equal(await main(['--cleanup', '--config-dir', dir, '--created', created], { fetch: m2.fetch, ...sink() }), 0);
    assert.equal(m2.reqs.filter((r) => r.method === 'DELETE').length, 0);
    assert.deepEqual(
      (await new CreatedLog(created, { dryRun: false }).outstanding(PROD)).map((x) => x.id),
      [99],
    );
  });

  test('実行で作ったものが記録され、F13 で消したものは削除済みになる', async () => {
    const dir = await makeConfigDir();
    const created = path.join(work, `c${n++}.jsonl`);
    const m = mockFetch();
    assert.equal(await main(['--only', 'F13', '--config-dir', dir, '--results', path.join(work, `r${n++}.md`), '--created', created], { fetch: m.fetch, ...sink() }), 0);
    const log = new CreatedLog(created, { dryRun: false });
    const all = await log.readAll();
    assert.deepEqual(all.filter((x) => x.op === 'created').map((x) => x.type), ['receipt', 'receipt', 'deal', 'user_matcher']);
    // F13 は紐付き中の証憑以外を全部消すので、残るのは（モックでは消せた扱いなので）無し
    assert.equal((await log.outstanding(POC)).length, 0);
  });
});

describe('補助', () => {
  test('padJpegTo はちょうどの大きさで、画像として読める', async () => {
    const src = await readFile(path.join(FIXTURES, 'r01_receipt58.jpg'));
    for (const size of [src.length + 4, src.length + 65537, src.length + 65539, 6 * 1024 * 1024]) {
      const out = padJpegTo(src, size);
      assert.equal(out.length, size);
      const meta = await sharp(out).metadata();
      assert.equal(meta.format, 'jpeg');
    }
  });

  test('shapeOf は文字の中身を残さない', () => {
    const s = shapeOf('ｱﾏｿﾞﾝ AMAZON.CO.JP 1234');
    assert.ok(!/AMAZON|1234|アマゾン/.test(s));
    assert.match(s, /^J\{\d+\}_A\{6\}\.A\{2\}\.A\{2\}_9\{4\}$/);
  });

  test('結果ファイルは自動記録のブロックだけを書き換え、メモを残す', () => {
    const src = resultsTemplate().replace('- 電子保存項目の表示: ', '- 電子保存項目の表示: ユーザーのメモ');
    const out = updateResults(src, [{ id: 'F4', title: 't', calls: [{ label: 'x', method: 'POST', path: '/api/1/receipts', status: 201, requestId: 'r1' }], notes: ['n'], error: null }], { at: 'AT', runId: 'RID' }, (x) => x);
    assert.match(out, /ユーザーのメモ/);
    assert.match(out, /<!-- F4:auto:begin -->\n_自動記録 AT run=RID_\n\n- `POST \/api\/1\/receipts`（x）→ 201 req=r1\n- n\n<!-- F4:auto:end -->/);
    assert.match(out, /<!-- F5:auto:begin -->\n（未実行）/);
  });
});

describe('freee-auth', () => {
  test('認可コードを交換して 0600 で保存する。コードとシークレットは表示しない', async () => {
    const dir = await makeConfigDir({ token: null });
    const CODE = 'authcode-TEST-0123456789';
    const reqs: URLSearchParams[] = [];
    const f = (async (_u: string | URL | Request, init?: RequestInit) => {
      reqs.push(init?.body as URLSearchParams);
      return new Response(JSON.stringify({ access_token: 'at-TEST-auth-0123456789', refresh_token: 'rt-TEST-auth-0123456789', expires_in: 21600, created_at: NOW(), company_id: POC, token_type: 'bearer', scope: 'read write' }));
    }) as typeof fetch;
    const s = sink();
    assert.equal(await authMain(['--config-dir', dir], { fetch: f, readCode: async () => `${CODE}\n`, ...s }), 0, s.lines.join('\n'));
    assert.equal(reqs[0].get('grant_type'), 'authorization_code');
    assert.equal(reqs[0].get('code'), CODE);
    assert.equal(reqs[0].get('redirect_uri'), 'urn:ietf:wg:oauth:2.0:oob');
    const file = tokenFile(dir, 'poc');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await new TokenStore(file).read())!.company_id, POC);
    const out = s.lines.join('\n');
    for (const v of [CODE, CLIENT_SECRET, 'at-TEST-auth-0123456789', 'rt-TEST-auth-0123456789']) assert.ok(!out.includes(v));
    assert.match(out, /prompt=select_company/);
  });

  test('選んだ事業所が設定と違えば保存しない。--prod でテスト事業所を選んでも保存しない', async () => {
    for (const [args, cid] of [[[], PROD], [['--prod'], POC]] as const) {
      const dir = await makeConfigDir({ token: null });
      const f = (async () =>
        new Response(JSON.stringify({ access_token: 'at-TEST-x-0123456789', refresh_token: 'rt-TEST-x-0123456789', expires_in: 21600, company_id: cid }))) as typeof fetch;
      const s = sink();
      assert.equal(await authMain([...args, '--config-dir', dir], { fetch: f, readCode: async () => 'c0de-TEST', ...s }), 1);
      assert.equal(await new TokenStore(tokenFile(dir, args.length ? 'prod' : 'poc')).read(), null);
    }
  });

  test('poc_company_id が未設定でも、prod_company_id と同じ事業所はテスト事業所用に保存しない', async () => {
    const dir = await makeConfigDir({ token: null });
    await writeFile(path.join(dir, 'config.toml'), `[freee]\nprod_company_id = ${PROD}\n`);
    const f = (async () =>
      new Response(JSON.stringify({ access_token: 'at-TEST-y-0123456789', refresh_token: 'rt-TEST-y-0123456789', expires_in: 21600, company_id: PROD }))) as typeof fetch;
    const s = sink();
    assert.equal(await authMain(['--config-dir', dir], { fetch: f, readCode: async () => 'c0de-TEST', ...s }), 1);
    assert.equal(await new TokenStore(tokenFile(dir, 'poc')).read(), null);
    assert.match(s.lines.join('\n'), /prod_company_id と同じ/);
  });
});
