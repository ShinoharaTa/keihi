// freee の Provider（docs/mvp-plan.md T1-10）。fetch はモック。一時ディレクトリの DB とトークンだけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderError, type ProviderErrorKind } from '../../src/providers/types.ts';
import { PAUSE_MS } from '../../src/providers/freee/budget.ts';
import { getPausedUntil, isReauthRequired } from '../../src/providers/freee/state.ts';
import { ACCESS, CLIENT_SECRET, REFRESH, makeEnv, storedToken } from '../contracts/mock.ts';

let root: string;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-freee-provider-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
const dir = () => path.join(root, String(n++));
const api = <T extends { url: URL }>(reqs: T[]) => reqs.filter((r) => r.url.pathname.startsWith('/api/1/'));
const SECRETS = [ACCESS, REFRESH, CLIENT_SECRET, 'at-TEST-new', 'rt-TEST-new'];

async function rejectsKind(p: Promise<unknown>, kind: ProviderErrorKind): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ProviderError, String(e));
    assert.equal(e.kind, kind, e.message);
    for (const s of SECRETS) assert.ok(!e.message.includes(s), `例外にトークン・secret が含まれる: ${e.message}`);
    return e;
  }
  assert.fail('例外にならなかった');
}

const expired = () => storedToken({ created_at: Math.floor(Date.now() / 1000) - 30000 });

describe('トークン', () => {
  test('トークンが無ければ再認可が要る状態にして、freee を呼ばない', async () => {
    const env = await makeEnv(dir(), { token: null });
    await rejectsKind(env.provider.getDeal(1), 'auth_invalid_grant');
    assert.equal(isReauthRequired(env.db), true);
    assert.equal(env.mock.reqs.length, 0);
    env.db.close();
  });

  test('invalid_grant なら freee_reauth_required = 1、以降はトークンも API も呼ばない', async () => {
    const env = await makeEnv(dir(), { token: expired(), tokenStatus: () => 401 });
    const e = await rejectsKind(env.provider.getDeal(1), 'auth_invalid_grant');
    assert.equal(e.retryable, false);
    assert.equal(isReauthRequired(env.db), true);
    const before = env.mock.reqs.length;
    await rejectsKind(env.provider.uploadReceipt({ bytes: Buffer.from('x'), fileName: 'a.jpg', mime: 'image/jpeg', key: 'kh-1' }), 'auth_invalid_grant');
    assert.equal(env.mock.reqs.length, before);
    env.db.close();
  });

  test('期限切れなら更新して新しいトークンを 0600 で保存してから使う。更新は用途 auth で記録', async () => {
    const env = await makeEnv(dir(), { token: expired() });
    await env.provider.getDeal(501);
    const saved = (await env.store.read())!;
    assert.equal(saved.refresh_token, 'rt-TEST-new-1-0123456789');
    assert.equal((await stat(env.store.path)).mode & 0o777, 0o600);
    assert.equal(api(env.mock.reqs)[0].headers.get('authorization'), `Bearer ${saved.access_token}`);
    const calls = env.db.prepare('SELECT purpose, method, endpoint, status FROM freee_calls ORDER BY id').all();
    assert.deepEqual(calls.map((c) => ({ ...c })), [
      { purpose: 'auth', method: 'POST', endpoint: '/public_api/token', status: 200 },
      { purpose: 'execute', method: 'GET', endpoint: '/api/1/deals/501', status: 200 },
    ]);
    env.db.close();
  });

  test('トークンの事業所が設定と違えば呼ばない', async () => {
    const env = await makeEnv(dir(), { token: storedToken({ company_id: 999 }) });
    await rejectsKind(env.provider.getDeal(1), 'client');
    assert.equal(env.mock.reqs.length, 0);
    env.db.close();
  });
});

describe('エラーの対応', () => {
  const cases: [number, ProviderErrorKind][] = [
    [500, 'server'],
    [503, 'server'],
    [429, 'rate_limited'],
    [403, 'usage_limited'],
    [400, 'client'],
    [404, 'client'],
  ];
  for (const [status, kind] of cases) {
    test(`HTTP ${status} → ${kind}`, async () => {
      const env = await makeEnv(dir(), {
        override: (r) => (r.url.pathname.startsWith('/api/1/') ? new Response(`{"secret":"${ACCESS}"}`, { status, headers: { 'x-freee-request-id': 'rq' } }) : null),
      });
      const e = await rejectsKind(env.provider.getDeal(1), kind);
      assert.equal(e.status, status);
      assert.equal(e.requestId, 'rq');
      env.db.close();
    });
  }

  test('タイムアウト → timeout、接続できない → network', async () => {
    let mode: 'timeout' | 'network' = 'timeout';
    const env = await makeEnv(dir(), {
      override: () => {
        if (mode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        throw new TypeError('fetch failed');
      },
    });
    await rejectsKind(env.provider.getDeal(1), 'timeout');
    mode = 'network';
    await rejectsKind(env.provider.getDeal(1), 'network');
    // 応答の無い呼び出しも数える（届いているかもしれない）。
    const rows = env.db.prepare('SELECT status FROM freee_calls').all() as { status: number | null }[];
    assert.deepEqual(rows.map((r) => r.status), [null, null]);
    env.db.close();
  });

  test('403 を受けたら 10 分は全用途で freee を呼ばない', async () => {
    let first = true;
    const env = await makeEnv(dir(), {
      override: (r) => {
        if (first && r.url.pathname.startsWith('/api/1/')) {
          first = false;
          return new Response('{}', { status: 403 });
        }
        return null;
      },
    });
    await rejectsKind(env.provider.listDeals({ limit: 1 }), 'usage_limited');
    assert.equal(getPausedUntil(env.db)!.getTime(), env.clock.t + PAUSE_MS);
    const before = env.mock.reqs.length;
    env.clock.t += PAUSE_MS - 1;
    await rejectsKind(env.provider.uploadReceipt({ bytes: Buffer.from('x'), fileName: 'a.jpg', mime: 'image/jpeg', key: 'kh-1' }), 'usage_limited');
    assert.equal(env.mock.reqs.length, before);
    env.clock.t += 1;
    await env.provider.uploadReceipt({ bytes: Buffer.from('x'), fileName: 'a.jpg', mime: 'image/jpeg', key: 'kh-1' });
    assert.equal(env.mock.reqs.length, before + 1);
    env.db.close();
  });
});

describe('直列化と download の上限', () => {
  test('同時に呼んでも 1 本ずつ送る', async () => {
    let inFlight = 0;
    let max = 0;
    const env = await makeEnv(dir(), {
      override: async (r) => {
        if (!r.url.pathname.startsWith('/api/1/')) return null;
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((res) => setTimeout(res, 5));
        inFlight--;
        return null;
      },
    });
    await Promise.all([env.provider.getDeal(501), env.provider.getDeal(501), env.provider.syncMasters(), env.provider.listRules()]);
    assert.equal(max, 1);
    env.db.close();
  });

  test('/receipts/{id}/download は 1 秒 3 回まで（4 回目は待つ）', async () => {
    const sent: number[] = [];
    const env = await makeEnv(dir(), {
      override: (r) => {
        if (r.url.pathname.endsWith('/download')) sent.push(env.clock.t);
        return null;
      },
    });
    const t0 = env.clock.t;
    await Promise.all([1, 2, 3, 4, 5].map((i) => env.provider.downloadReceipt(i)));
    assert.deepEqual(sent.map((t) => t - t0), [0, 0, 0, 1000, 1000]);
    // 他の GET は待たない
    env.slept.length = 0;
    await env.provider.getDeal(501);
    assert.deepEqual(env.slept, []);
    env.db.close();
  });
});

describe('予算の用途', () => {
  test('downloadReceipt は既定で user、purpose を渡せば差し替える', async () => {
    const env = await makeEnv(dir());
    await env.provider.downloadReceipt(1);
    await env.provider.downloadReceipt(2, { purpose: 'sync' });
    const rows = env.db.prepare(`SELECT purpose FROM freee_calls WHERE endpoint LIKE '%/download' ORDER BY id`).all() as { purpose: string }[];
    assert.deepEqual(rows.map((r) => r.purpose), ['user', 'sync']);
    env.db.close();
  });
});

describe('対応づけ', () => {
  test('findReceiptsByKey は description が一致し削除されていないものだけ。期間は既定で 30 日前〜明日', async () => {
    const env = await makeEnv(dir(), {
      start: new Date('2026-10-17T03:00:00Z'),
      override: (r) =>
        r.method === 'GET' && r.url.pathname === '/api/1/receipts'
          ? new Response(
              JSON.stringify({
                receipts: [
                  { id: 1, description: 'kh-A', status: 'confirmed', mime_type: 'image/jpeg' },
                  { id: 2, description: 'kh-A', status: 'deleted', mime_type: 'image/jpeg' },
                  { id: 3, description: 'kh-AB', status: 'confirmed', mime_type: 'image/jpeg' },
                ],
              }),
              { status: 200 },
            )
          : null,
    });
    const hits = await env.provider.findReceiptsByKey('kh-A');
    assert.deepEqual(hits.map((h) => h.id), [1]);
    const q = api(env.mock.reqs)[0].url.searchParams;
    assert.equal(q.get('start_date'), '2026-09-17');
    assert.equal(q.get('end_date'), '2026-10-18');
    assert.equal(q.get('category'), 'without_deal');
    env.db.close();
  });

  test('アップロードで登録番号は送らない（送れないので例外）・64MB 超は送らない', async () => {
    const env = await makeEnv(dir());
    await rejectsKind(env.provider.uploadReceipt({ bytes: Buffer.from('x'), fileName: 'a.jpg', mime: 'image/jpeg', key: 'k', meta: { invoiceRegistrationNumber: 'T1234567890123' } }), 'client');
    await rejectsKind(env.provider.uploadReceipt({ bytes: Buffer.alloc(64 * 1024 * 1024 + 1), fileName: 'a.jpg', mime: 'image/jpeg', key: 'k' }), 'client');
    assert.equal(env.mock.reqs.length, 0);
    env.db.close();
  });

  test('listRules は act 4 / 11 / 12 / 0 だけを返す', async () => {
    const env = await makeEnv(dir());
    assert.deepEqual(await env.provider.listRules(), [
      { id: 1, matchText: 'DUMMY', action: 'ignore' },
      { id: 3, matchText: 'PRIVATE', action: 'private_register' },
    ]);
    env.db.close();
  });

  test('listBankTxns は 1 ページだけ取り、limit・offset の範囲外は送らずに client', async () => {
    const env = await makeEnv(dir());
    await env.provider.listBankTxns({ walletableType: 'bank_account', walletableId: 2, offset: 100 });
    const q = env.mock.reqs.filter((r) => r.url.pathname === '/api/1/wallet_txns').map((r) => Object.fromEntries(r.url.searchParams));
    assert.deepEqual(q, [{ company_id: '111', walletable_type: 'bank_account', walletable_id: '2', limit: '100', offset: '100' }]);
    const n = env.mock.reqs.length;
    await rejectsKind(env.provider.listBankTxns({ limit: 101 }), 'client');
    await rejectsKind(env.provider.listBankTxns({ limit: 0 }), 'client');
    await rejectsKind(env.provider.listBankTxns({ offset: -1 }), 'client');
    assert.equal(env.mock.reqs.length, n);
    env.db.close();
  });

  test('listBankTxns は status・due_amount・balance が欠けた明細も読む', async () => {
    const env = await makeEnv(dir(), {
      override: (r) =>
        r.url.pathname === '/api/1/wallet_txns'
          ? new Response(JSON.stringify({ wallet_txns: [{ id: 5, date: '2026-10-01', amount: 100, entry_side: 'expense', walletable_type: 'credit_card', walletable_id: 1, description: 'X', status: 5 }, { id: 6, date: '2026-10-01', amount: 100, entry_side: 'expense', walletable_type: 'credit_card', walletable_id: 1, description: 'Y' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
          : null,
    });
    const ts = await env.provider.listBankTxns();
    assert.deepEqual(ts.map((t) => [t.id, t.status, t.dueAmount, t.balance, t.ruleMatched]), [
      [5, 5, 0, null, false],
      [6, null, 0, null, false],
    ]);
    env.db.close();
  });

  test('createRule の口座指定は送らずに client（walletable の書式が未確認）', async () => {
    const env = await makeEnv(dir());
    await rejectsKind(env.provider.createRule({ matchText: 'X', action: 'ignore', walletableId: 2 }), 'client');
    assert.equal(env.mock.reqs.length, 0);
    env.db.close();
  });
});
