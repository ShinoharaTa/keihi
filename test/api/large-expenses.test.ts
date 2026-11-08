// 大きな出費の API（docs/cashflow.md §15、src/web/routes/cashflow.ts・src/cashflow/large.ts）。app.request() で叩く（ポートを開かない）。摘要・金額は仮のもの。
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { insertAccount, insertBankTxn } from '../../src/bank/repo.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';

const LOCAL = '127.0.0.1:8795';
const USER = 'test@example.com';
// 2026-11-06 12:00 JST
const T0 = new Date('2026-11-06T03:00:00.000Z');

let db: Db;
let app: Hono;
let A: string;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  A = insertAccount(db, { provider: 'fake', name: 'テスト銀行', kind: 'bank', source: 'csv', now: T0.toISOString() }).id;
  app = createApp({
    db,
    objectsDir: '/nonexistent',
    config: {
      ingest: { maxBytes: 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
      retention: { years: 7, extraYears: 1, start: 'next_year_0316' },
      cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false },
      provider: { kind: 'fake' },
    },
    auth: createAuth({ allowedUsers: [USER], allowedHosts: [LOCAL] }),
    triggerWorker: () => {},
    now: () => T0,
  });
});

function req(p: string, opts: { method?: string; body?: unknown; user?: string | null } = {}) {
  const headers: Record<string, string> = { Host: LOCAL };
  if (opts.user !== null) headers['Tailscale-User-Login'] = opts.user ?? USER;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(`http://${LOCAL}${p}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
}
const post = (p: string, body?: unknown) => req(p, { method: 'POST', body });

const txn = (date: string, amount: number, desc: string) =>
  insertBankTxn(db, { accountId: A, txnDate: date, amount, side: 'expense', description: desc, descriptionNorm: desc, now: T0.toISOString() }).id;

describe('GET /api/large_expenses', () => {
  test('5 万円以上の支出を新しい順に。認証が要る', async () => {
    const a = txn('2025-07-01', 60_000, 'テスト保険');
    const b = txn('2026-07-01', 60_000, 'テスト保険');
    txn('2026-07-02', 49_999, 'テスト家電');
    const r = await req('/api/large_expenses');
    assert.equal(r.status, 200);
    const { items } = (await r.json()) as { items: Record<string, unknown>[] };
    assert.deepEqual(items.map((x) => x.bank_txn_id), [b, a]);
    assert.deepEqual(Object.keys(items[0]).sort(), [
      'account_id',
      'account_name',
      'amount',
      'bank_txn_id',
      'description',
      'description_norm',
      'same_desc_count',
      'suggested',
      'txn_date',
    ]);
    assert.deepEqual([items[0].account_name, items[0].same_desc_count, items[0].suggested], ['テスト銀行', 2, 'yearly']);
    assert.notEqual((await req('/api/large_expenses', { user: null })).status, 200);
  });
});

describe('POST /api/large_expenses/:bank_txn_id/schedule', () => {
  test('201 {decision, item}。一覧から消え、台帳に入り、監査に user が残る', async () => {
    const id = txn('2026-06-10', 80_000, 'テスト保険');
    const r = await post(`/api/large_expenses/${id}/schedule`, { recurrence: 'yearly', category: 'insurance' });
    assert.equal(r.status, 201);
    const { decision, item } = (await r.json()) as { decision: Record<string, unknown>; item: Record<string, unknown> };
    assert.deepEqual([decision.bank_txn_id, decision.decision, decision.scheduled_item_id], [id, 'scheduled', item.id]);
    assert.deepEqual([item.name, item.amount, item.category, item.recurrence, item.anchor_date, item.origin, item.direction, item.amount_kind, item.account_id], [
      'テスト保険',
      80_000,
      'insurance',
      'yearly',
      '2027-06-10',
      'detected',
      'out',
      'fixed',
      A,
    ]);
    assert.deepEqual(((await (await req('/api/large_expenses')).json()) as { items: unknown[] }).items, []);
    const { items } = (await (await req('/api/scheduled_items')).json()) as { items: { id: string }[] };
    assert.deepEqual(items.map((x) => x.id), [item.id]);
    const a = db.prepare("SELECT actor, payload_json FROM audit_log WHERE action = 'large_expense.scheduled'").get() as { actor: string; payload_json: string };
    assert.equal(a.actor, 'user');
    assert.equal(JSON.parse(a.payload_json).user, USER);
    assert.equal(verifyAudit(db).ok, true);

    const again = await post(`/api/large_expenses/${id}/schedule`, { recurrence: 'yearly' });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { error: 'already_decided' });
  });

  test('1 回だけは anchor_date が要る（400 anchor_date_required）', async () => {
    const id = txn('2026-06-10', 300_000, 'テスト家電');
    let r = await post(`/api/large_expenses/${id}/schedule`, { recurrence: 'once' });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'anchor_date_required' });
    r = await post(`/api/large_expenses/${id}/schedule`, { recurrence: 'once', anchor_date: '2027-01-20', name: 'テスト買い替え', amount: 250_000 });
    assert.equal(r.status, 201);
    const { item } = (await r.json()) as { item: Record<string, unknown> };
    assert.deepEqual([item.recurrence, item.anchor_date, item.name, item.amount], ['once', '2027-01-20', 'テスト買い替え', 250_000]);
  });

  test('400（JSON・知らないキー・周期）と 404', async () => {
    const id = txn('2026-06-10', 300_000, 'テスト家電');
    const err = async (r: Response) => [r.status, ((await r.json()) as { error: string }).error];
    assert.deepEqual(await err(await post(`/api/large_expenses/${id}/schedule`, '{')), [400, 'invalid_json']);
    assert.deepEqual(await err(await post(`/api/large_expenses/${id}/schedule`, { recurrence: 'yearly', account_id: A })), [400, 'invalid_field']);
    assert.deepEqual(await err(await post(`/api/large_expenses/${id}/schedule`, { recurrence: 'monthly' })), [400, 'invalid_recurrence']);
    assert.deepEqual(await err(await post('/api/large_expenses/NOPE/schedule', { recurrence: 'yearly' })), [404, 'not_found']);
  });
});

describe('POST /api/large_expenses/:bank_txn_id/dismiss', () => {
  test('200 {decision}。2 回目もそのまま 200。予定にした明細は 409', async () => {
    const id = txn('2026-06-10', 300_000, 'テスト家電');
    const r1 = await post(`/api/large_expenses/${id}/dismiss`);
    assert.equal(r1.status, 200);
    const b1 = (await r1.json()) as { decision: Record<string, unknown> };
    assert.deepEqual([b1.decision.bank_txn_id, b1.decision.decision, b1.decision.scheduled_item_id], [id, 'dismissed', null]);
    const r2 = await post(`/api/large_expenses/${id}/dismiss`);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), b1);
    assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action = 'large_expense.dismissed'").get()!.n, 1);

    const s = txn('2026-06-11', 300_000, 'テスト家電B');
    assert.equal((await post(`/api/large_expenses/${s}/schedule`, { recurrence: 'biennial' })).status, 201);
    const r3 = await post(`/api/large_expenses/${s}/dismiss`);
    assert.equal(r3.status, 409);
    assert.deepEqual(await r3.json(), { error: 'already_decided' });
    assert.equal((await post('/api/large_expenses/NOPE/dismiss')).status, 404);
  });
});
