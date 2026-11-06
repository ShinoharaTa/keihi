// 口座の API と明細の同期の API（docs/mvp-plan-v3.md T103・T104）。app.request() で叩く（ポートを開かない）。
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { appendBalance, getAccountByWalletable, updateSyncStatus } from '../../src/bank/repo.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { syncMasters } from '../../src/masters/sync.ts';
import { createFakeProvider, DEFAULT_MASTERS } from '../../src/providers/fake/index.ts';
import { createApp } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';

const LOCAL = '127.0.0.1:8795';
const USER = 'test@example.com';
const T0 = new Date('2026-11-06T03:00:00.000Z');

let db: Db;
let app: Hono;
let clock: Date;
let triggered: number;

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db);
  clock = T0;
  triggered = 0;
  await syncMasters(
    db,
    createFakeProvider({ masters: { ...DEFAULT_MASTERS, walletables: [{ id: 1, type: 'credit_card', name: 'テストカード' }, { id: 2, type: 'bank_account', name: 'テスト銀行' }] } }),
    { providerName: 'freee', accountProvider: 'fake', now: () => T0 },
  );
  app = createApp({
    db,
    objectsDir: '/nonexistent',
    config: {
      ingest: { maxBytes: 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
      retention: { years: 7, extraYears: 1, start: 'next_year_0316' },
      provider: { kind: 'fake' },
    },
    auth: createAuth({ allowedUsers: [USER], allowedHosts: [LOCAL] }),
    triggerWorker: () => void triggered++,
    now: () => clock,
  });
});

function req(p: string, opts: { method?: string; body?: unknown; user?: string } = {}) {
  const headers: Record<string, string> = { Host: LOCAL, 'Tailscale-User-Login': opts.user ?? USER };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(`http://${LOCAL}${p}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

const bankId = () => getAccountByWalletable(db, 'fake', 'bank_account:2')!.id;

describe('口座の API', () => {
  test('GET /api/accounts は sync_status と最新残高も返す', async () => {
    updateSyncStatus(db, bankId(), { lastOkAt: T0.toISOString(), backfillDoneUntil: '2026-08-06' });
    appendBalance(db, { accountId: bankId(), asOfDate: '2026-11-06', balance: 51000, source: 'freee_walletable', now: T0.toISOString() });
    const r = await req('/api/accounts');
    assert.equal(r.status, 200);
    const { accounts } = (await r.json()) as { accounts: Record<string, unknown>[] };
    assert.deepEqual(accounts.map((a) => [a.name, a.kind, a.include_in_cashflow, a.active]), [
      ['テストカード', 'card', true, true],
      ['テスト銀行', 'bank', true, true],
    ]);
    assert.equal(accounts[0].sync_status, null);
    assert.equal(accounts[0].latest_balance, null);
    assert.deepEqual(accounts[1].sync_status, { last_sync_at: null, last_ok_at: T0.toISOString(), last_error: null, last_csv_at: null, backfill_done_until: '2026-08-06' });
    assert.deepEqual(accounts[1].latest_balance, { as_of_date: '2026-11-06', balance: 51000, source: 'freee_walletable' });
  });

  test('POST /api/accounts は CSV だけの口座を作り、監査に残す', async () => {
    const r = await req('/api/accounts', { method: 'POST', body: { name: ' PayPay 残高 ', kind: 'paypay' } });
    assert.equal(r.status, 201);
    const a = (await r.json()) as Record<string, unknown>;
    assert.deepEqual([a.name, a.kind, a.source, a.provider, a.freee_walletable_id, a.default_tag, a.mcp_visibility], ['PayPay 残高', 'paypay', 'csv', 'fake', null, 'unset', 'summary']);
    const audit = db.prepare(`SELECT actor, entity_id, payload_json FROM audit_log WHERE action = 'money_account.created'`).get() as { actor: string; entity_id: string; payload_json: string };
    assert.equal(audit.entity_id, a.id);
    assert.equal(JSON.parse(audit.payload_json).user, USER);
    assert.equal((await req('/api/accounts', { method: 'POST', body: { name: '', kind: 'paypay' } })).status, 400);
    assert.equal((await req('/api/accounts', { method: 'POST', body: { name: 'x', kind: 'stock' } })).status, 400);
    assert.equal((await req('/api/accounts', { method: 'POST', body: { name: 'x'.repeat(201), kind: 'paypay' } })).status, 400);
    assert.equal((await req('/api/accounts', { method: 'POST', body: { name: 'x'.repeat(200), kind: 'paypay' } })).status, 201);
    assert.equal((await req('/api/accounts', { method: 'POST', body: [] })).status, 400);
  });

  test('PATCH /api/accounts/:id は変わった列だけを監査に残す', async () => {
    const card = getAccountByWalletable(db, 'fake', 'credit_card:1')!.id;
    const body = { default_tag: 'business', mcp_visibility: 'none', include_in_cashflow: false, card_settlement_account_id: bankId(), card_settlement_pattern: 'ﾃｽﾄｶｰﾄﾞ', active: true };
    const r = await req(`/api/accounts/${card}`, { method: 'PATCH', body });
    assert.equal(r.status, 200);
    const a = (await r.json()) as Record<string, unknown>;
    assert.deepEqual([a.default_tag, a.mcp_visibility, a.include_in_cashflow, a.card_settlement_account_id, a.card_settlement_pattern, a.active], ['business', 'none', false, bankId(), 'ﾃｽﾄｶｰﾄﾞ', true]);
    const rows = db.prepare(`SELECT entity_id, payload_json FROM audit_log WHERE action = 'money_account.updated'`).all() as { entity_id: string; payload_json: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entity_id, card);
    const p = JSON.parse(rows[0].payload_json);
    assert.equal(p.user, USER);
    assert.deepEqual(Object.keys(p.changes).sort(), ['card_settlement_account_id', 'card_settlement_pattern', 'default_tag', 'include_in_cashflow', 'mcp_visibility']);
    assert.deepEqual(p.changes.default_tag, { from: 'unset', to: 'business' });
    assert.deepEqual(p.changes.include_in_cashflow, { from: 1, to: 0 });
    // 同じ値をもう一度送っても監査は増えない。
    assert.equal((await req(`/api/accounts/${card}`, { method: 'PATCH', body })).status, 200);
    assert.equal((db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'money_account.updated'`).get() as { n: number }).n, 1);
    assert.equal(verifyAudit(db).ok, true);
  });

  test('PATCH の不正は 400、無い口座は 404', async () => {
    const card = getAccountByWalletable(db, 'fake', 'credit_card:1')!.id;
    for (const body of [{ default_tag: 'x' }, { mcp_visibility: 1 }, { include_in_cashflow: 1 }, { active: 'yes' }, { card_settlement_pattern: 3 }, { name: 'x' }, { kind: 'bank' }]) {
      assert.equal((await req(`/api/accounts/${card}`, { method: 'PATCH', body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await req(`/api/accounts/${card}`, { method: 'PATCH', body: { card_settlement_account_id: card } })).status, 400);
    assert.equal((await req(`/api/accounts/${card}`, { method: 'PATCH', body: { card_settlement_account_id: 'NOPE' } })).status, 400);
    // 引き落とし口座は bank だけ。
    const paypay = ((await (await req('/api/accounts', { method: 'POST', body: { name: 'PayPay', kind: 'paypay' } })).json()) as { id: string }).id;
    assert.equal((await req(`/api/accounts/${card}`, { method: 'PATCH', body: { card_settlement_account_id: paypay } })).status, 400);
    // パターンは 1〜200 文字。
    assert.equal((await req(`/api/accounts/${card}`, { method: 'PATCH', body: { card_settlement_pattern: '' } })).status, 400);
    assert.equal((await req(`/api/accounts/${card}`, { method: 'PATCH', body: { card_settlement_pattern: 'x'.repeat(201) } })).status, 400);
    assert.equal((await req(`/api/accounts/${card}`, { method: 'PATCH', body: { card_settlement_pattern: 'x'.repeat(200) } })).status, 200);
    assert.equal((await req('/api/accounts/NOPE', { method: 'PATCH', body: { active: false } })).status, 404);
    assert.equal((db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'money_account.updated'`).get() as { n: number }).n, 1); // 200 文字のパターンだけ
  });

  test('allowed_users 以外は拒否', async () => {
    for (const [method, p] of [['GET', '/api/accounts'], ['POST', '/api/accounts'], ['PATCH', `/api/accounts/${bankId()}`], ['POST', '/api/bank/sync'], ['GET', '/api/bank/status']]) {
      assert.equal((await req(p, { method, user: 'other@example.com', body: method === 'GET' ? undefined : {} })).status, 403, `${method} ${p}`);
    }
    assert.equal((db.prepare(`SELECT count(*) n FROM jobs`).get() as { n: number }).n, 0);
  });
});

describe('同期の API', () => {
  test('POST /api/bank/sync は積んで worker を起こす。10 分以内は積まない', async () => {
    const a = await req('/api/bank/sync', { method: 'POST' });
    assert.equal(a.status, 200);
    const ja = (await a.json()) as { job_id: number; created: boolean };
    assert.equal(ja.created, true);
    assert.equal(triggered, 1);
    db.prepare(`UPDATE jobs SET state = 'done'`).run();
    clock = new Date(T0.getTime() + 9 * 60_000);
    const b = await req('/api/bank/sync', { method: 'POST' });
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), { job_id: ja.job_id, created: false });
    assert.equal(triggered, 1);
    clock = new Date(T0.getTime() + 11 * 60_000);
    assert.equal(((await (await req('/api/bank/sync', { method: 'POST' })).json()) as { created: boolean }).created, true);
    assert.equal((db.prepare(`SELECT count(*) n FROM jobs WHERE kind = 'sync_bank'`).get() as { n: number }).n, 2);
  });

  test('GET /api/bank/status と /api/status の bank', async () => {
    updateSyncStatus(db, bankId(), { lastSyncAt: T0.toISOString(), lastOkAt: T0.toISOString(), backfillDoneUntil: '2026-08-06' });
    const card = getAccountByWalletable(db, 'fake', 'credit_card:1')!.id;
    updateSyncStatus(db, card, { lastSyncAt: T0.toISOString(), lastError: 'server(500): x' });
    const r = await req('/api/bank/status');
    assert.equal(r.status, 200);
    const { accounts } = (await r.json()) as { accounts: Record<string, unknown>[] };
    assert.deepEqual(accounts, [
      { account_id: card, name: 'テストカード', kind: 'card', source: 'freee', active: true, last_sync_at: T0.toISOString(), last_ok_at: null, last_error: 'server(500): x', last_csv_at: null, backfill_done_until: null },
      { account_id: bankId(), name: 'テスト銀行', kind: 'bank', source: 'freee', active: true, last_sync_at: T0.toISOString(), last_ok_at: T0.toISOString(), last_error: null, last_csv_at: null, backfill_done_until: '2026-08-06' },
    ]);
    const s = (await (await req('/api/status')).json()) as { bank: unknown };
    assert.deepEqual(s.bank, { accounts: 2, last_ok_at: T0.toISOString(), errors: 1 });
  });
});
