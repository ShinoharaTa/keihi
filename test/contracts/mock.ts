// freee のモック（fetch の差し替え）。送られたリクエストを記録し、定義の形に沿った最小の応答を返す。外部へは通信しない。
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { TOKEN_URL, TokenStore, type StoredToken } from '../../src/providers/freee/auth.ts';
import { createFreeeProvider, freeeTokenPaths, type FreeeProvider } from '../../src/providers/freee/provider.ts';

export type Req = { method: string; url: URL; headers: Headers; body: unknown };
export type Override = (r: Req) => Response | null | undefined | Promise<Response | null | undefined>;

export const COMPANY = 111;
export const ACCESS = 'at-TEST-access-0123456789';
export const REFRESH = 'rt-TEST-refresh-0123456789';
export const CLIENT_SECRET = 'cs-TEST-secret-0123456789';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-freee-request-id': `req-${status}` } });

const receipt = (id: number, description: string, over: Record<string, unknown> = {}) => ({
  id,
  status: 'confirmed',
  description,
  mime_type: 'image/jpeg',
  origin: 'public_api',
  created_at: '2026-10-17T10:00:00+09:00',
  user: { id: 1, email: 'dummy@example.invalid' },
  receipt_metadatum: null,
  ...over,
});

export const DEAL = {
  id: 501,
  company_id: COMPANY,
  issue_date: '2026-10-01',
  amount: 1100,
  due_amount: 1100,
  type: 'expense',
  partner_id: 0,
  ref_number: 'kh-REF',
  status: 'unsettled',
  details: [{ id: 9001, account_item_id: 101, tax_code: 136, amount: 1100, vat: 100, description: 'd', entry_side: 'debit' }],
  receipts: [{ id: 7 }],
};

export function createFreeeMock(opts: { override?: Override; tokenStatus?: () => number } = {}) {
  const reqs: Req[] = [];
  let receiptSeq = 0;
  let tokenSeq = 0;
  const uploaded: ReturnType<typeof receipt>[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const r: Req = { method: (init?.method ?? 'GET').toUpperCase(), url, headers: new Headers(init?.headers), body: init?.body };
    reqs.push(r);
    const o = await opts.override?.(r);
    if (o) return o;
    if (`${url.origin}${url.pathname}` === TOKEN_URL) {
      const st = opts.tokenStatus?.() ?? 200;
      if (st !== 200) return json(st, { error: 'invalid_grant', error_description: 'x' });
      tokenSeq++;
      return json(200, {
        access_token: `at-TEST-new-${tokenSeq}-0123456789`,
        refresh_token: `rt-TEST-new-${tokenSeq}-0123456789`,
        token_type: 'bearer',
        expires_in: 21600,
        created_at: Math.floor(Date.now() / 1000),
        company_id: COMPANY,
        scope: 'read write',
      });
    }
    const p = url.pathname;
    const m = r.method;
    if (m === 'POST' && p === '/api/1/receipts') {
      const form = r.body as FormData;
      const x = receipt(++receiptSeq, String(form.get('description') ?? ''));
      uploaded.push(x);
      return json(201, { receipt: x });
    }
    if (m === 'GET' && p === '/api/1/receipts') return json(200, { receipts: uploaded });
    if (m === 'PUT' && /^\/api\/1\/receipts\/\d+$/.test(p)) return json(200, { receipt: receipt(Number(p.split('/')[4]), 'kh-X') });
    if (m === 'GET' && /^\/api\/1\/receipts\/\d+\/download$/.test(p)) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (m === 'POST' && p === '/api/1/deals') return json(201, { deal: { ...DEAL, ref_number: JSON.parse(String(r.body)).ref_number } });
    if (m === 'GET' && p === '/api/1/deals') return json(200, { deals: [DEAL] });
    if ((m === 'GET' || m === 'PUT') && /^\/api\/1\/deals\/\d+$/.test(p)) return json(200, { deal: DEAL });
    if (m === 'DELETE') return new Response(null, { status: 204 });
    if (m === 'GET' && p === '/api/1/account_items') return json(200, { account_items: [{ id: 101, name: '消耗品費' }] });
    if (m === 'GET' && p === '/api/1/taxes/codes') return json(200, { taxes: [{ code: 136, name: 'purchase_with_tax_10', name_ja: '課対仕入10%' }] });
    if (m === 'GET' && p === '/api/1/walletables') return json(200, { walletables: [{ id: 1, type: 'credit_card', name: 'ダミーカード' }] });
    if (m === 'GET' && p === '/api/1/partners') return json(200, { partners: [{ id: 5, name: 'ダミー商店' }] });
    if (m === 'GET' && p === '/api/1/wallet_txns') {
      return json(200, {
        wallet_txns: [{ id: 3, date: '2026-10-01', amount: 1100, entry_side: 'expense', walletable_type: 'credit_card', walletable_id: 1, description: 'DUMMY', status: 1 }],
      });
    }
    if (m === 'GET' && p === '/api/1/user_matchers') return json(200, { data: [{ id: 1, act: 4, description: 'DUMMY' }, { id: 2, act: 1, description: 'AUTO' }] });
    if (m === 'POST' && p === '/api/1/user_matchers') return json(201, { id: 9 });
    return json(404, { message: 'not found' });
  }) as typeof fetch;
  return { fetch: f, reqs, uploaded };
}

// ---- テスト用の組み立て（一時ディレクトリの DB とトークン） ----

export const storedToken = (over: Partial<StoredToken> = {}, nowSec = Math.floor(Date.now() / 1000)): StoredToken => ({
  access_token: ACCESS,
  refresh_token: REFRESH,
  token_type: 'bearer',
  expires_in: 21600,
  created_at: nowSec,
  company_id: COMPANY,
  scope: 'read write',
  ...over,
});

export type Env = {
  dir: string;
  db: Db;
  store: TokenStore;
  provider: FreeeProvider;
  mock: ReturnType<typeof createFreeeMock>;
  clock: { t: number };
  slept: number[];
};

export async function makeEnv(
  dir: string,
  opts: { token?: StoredToken | null; override?: Override; tokenStatus?: () => number; start?: Date } = {},
): Promise<Env> {
  await mkdir(dir, { recursive: true });
  const db = openDb(path.join(dir, 'keihi.db'));
  migrate(db);
  const clock = { t: (opts.start ?? new Date()).getTime() };
  const { tokenPath, lockPath } = freeeTokenPaths(dir);
  const store = new TokenStore(tokenPath, lockPath);
  if (opts.token !== null) await store.write(opts.token ?? storedToken({}, Math.floor(clock.t / 1000)));
  const mock = createFreeeMock({ override: opts.override, tokenStatus: opts.tokenStatus });
  const slept: number[] = [];
  const provider = createFreeeProvider({
    db,
    companyId: COMPANY,
    creds: { clientId: 'client-id-test', clientSecret: CLIENT_SECRET },
    tokenPath,
    lockPath,
    fetch: mock.fetch,
    now: () => new Date(clock.t),
    sleep: async (ms) => {
      slept.push(ms);
      clock.t += ms;
    },
  });
  return { dir, db, store, provider, mock, clock, slept };
}
