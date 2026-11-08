// 予定の台帳の API（docs/mvp-plan-v3.md T301、src/web/routes/cashflow.ts）。app.request() で叩く（ポートを開かない）。
// app.ts への登録は別にするので、app.ts と同じく認証を先に差し込んだ Hono を自前で組む。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { insertAccount } from '../../src/bank/repo.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';
import { cashflowRoutes } from '../../src/web/routes/cashflow.ts';

// 2026-11-06 09:00 JST
const T0 = new Date('2026-11-06T00:00:00.000Z');
const HOST = '127.0.0.1:8787';
const USER = 'me@example.com';
let root: string;
let n = 0;
let db: Db;
let app: Hono;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-cashflow-api-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  db?.close();
  db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  app = new Hono();
  app.use('*', createAuth({ allowedUsers: [USER], allowedHosts: [HOST] }));
  app.route('/api', cashflowRoutes({ db, now: () => T0, config: { cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false } } }));
});

const headers = { Host: HOST, 'Tailscale-User-Login': USER, 'content-type': 'application/json' };
const get = (url: string) => app.request(url, { headers });
const send = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

const item = { name: '国民年金', amount: 16980, direction: 'out', category: 'tax', recurrence: 'monthly', anchor_date: '2026-11-30' };

async function create(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await send('POST', '/api/scheduled_items', { ...item, ...body });
  assert.equal(res.status, 201);
  return (await res.json()) as Record<string, unknown>;
}

describe('POST /api/scheduled_items', () => {
  test('作成して 201、既定値が入る。監査ログに user が残る', async () => {
    const it = await create();
    assert.equal(it.name, '国民年金');
    assert.equal(it.notify_days_before, 14);
    assert.equal(it.origin, 'manual');
    assert.equal(it.amount_kind, 'fixed');
    assert.equal(it.active, 1);
    assert.equal(it.account_id, null);
    assert.equal(it.end_date, null);
    assert.equal(it.created_at, T0.toISOString());
    const a = db.prepare(`SELECT actor, action, payload_json FROM audit_log WHERE entity = 'scheduled_item'`).all() as { actor: string; action: string; payload_json: string }[];
    assert.equal(a.length, 1);
    assert.equal(a[0].actor, 'user');
    assert.equal(a[0].action, 'scheduled_item.created');
    assert.equal(JSON.parse(a[0].payload_json).user, USER);
  });

  test('口座と任意の列も受ける', async () => {
    const acc = insertAccount(db, { provider: 'freee', name: '普通預金', kind: 'bank', source: 'csv', now: T0.toISOString() });
    const it = await create({ account_id: acc.id, end_date: '2027-03-31', notify_days_before: 7, origin: 'detected' });
    assert.equal(it.account_id, acc.id);
    assert.equal(it.end_date, '2027-03-31');
    assert.equal(it.notify_days_before, 7);
    assert.equal(it.origin, 'detected');
  });

  test('不正な値は 400 で、行を作らない', async () => {
    const cases: [unknown, string][] = [
      ['{', 'invalid_json'],
      ['[]', 'invalid_json'],
      [{ ...item, amount: 0 }, 'invalid_amount'],
      [{ ...item, amount: '100' }, 'invalid_amount'],
      [{ ...item, direction: 'x' }, 'invalid_direction'],
      [{ ...item, category: 'food' }, 'invalid_category'],
      [{ ...item, recurrence: 'weekly' }, 'invalid_recurrence'],
      [{ ...item, anchor_date: '2026-02-29' }, 'invalid_anchor_date'],
      [{ ...item, end_date: '2026-11-29' }, 'end_before_anchor'],
      [{ ...item, notify_days_before: 1.5 }, 'invalid_notify_days_before'],
      [{ ...item, account_id: 'NOPE' }, 'unknown_account'],
      [{ ...item, active: 0 }, 'invalid_field'],
      [{ ...item, name: '' }, 'invalid_name'],
      [{ amount: 1 }, 'missing_name'],
      ['{"toString":1}', 'invalid_field'],
      ['{"__proto__":1}', 'invalid_field'],
      [{ ...item, name: 'x'.repeat(201) }, 'invalid_name'],
      [{ ...item, notify_days_before: 366 }, 'invalid_notify_days_before'],
      [{ ...item, category: 'income' }, 'invalid_category_for_direction'],
      [{ ...item, direction: 'in', category: 'savings' }, 'invalid_category_for_direction'],
      [{ ...item, amount_kind: 'estimate' }, 'invalid_amount_kind'],
      [{ ...item, amount_kind: null }, 'invalid_amount_kind'],
    ];
    for (const [body, code] of cases) {
      const res = await send('POST', '/api/scheduled_items', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error: code });
    }
    assert.equal((db.prepare('SELECT count(*) n FROM scheduled_items').get() as { n: number }).n, 0);
  });

  test('認証は app.ts と同じミドルウェアで通る（ヘッダが無ければ 401）', async () => {
    const res = await app.request('/api/scheduled_items', { method: 'POST', headers: { Host: HOST, 'content-type': 'application/json' }, body: JSON.stringify(item) });
    assert.equal(res.status, 401);
  });

  test('createApp に登録されていて、未認証は 401', async () => {
    const full = createApp({
      db,
      objectsDir: path.join(root, 'objects'),
      config: { ingest: { maxBytes: 1024 }, calendar: { deadlineMode: 'early', yearEndHolidays: false }, deadline: { countFrom: 'receipt_day' }, retention: { years: 7, extraYears: 1, start: 'next_year_0316' }, cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false } },
      auth: createAuth({ allowedUsers: [USER], allowedHosts: [HOST] }),
      triggerWorker: () => {},
      now: () => T0,
    });
    assert.equal((await full.request('/api/scheduled_items', { headers: { Host: HOST } })).status, 401);
    assert.equal((await full.request('/api/scheduled_items', { method: 'POST', headers: { Host: HOST, 'content-type': 'application/json' }, body: JSON.stringify(item) })).status, 401);
    const ok = await full.request('/api/scheduled_items', { headers: { Host: HOST, 'Tailscale-User-Login': USER } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { items: [] });
  });
});

describe('PATCH /api/scheduled_items/:id', () => {
  test('渡した列だけ変え、監査ログに前後を残す', async () => {
    const it = await create();
    const res = await send('PATCH', `/api/scheduled_items/${it.id}`, { amount: 17510, end_date: null });
    assert.equal(res.status, 200);
    const u = (await res.json()) as Record<string, unknown>;
    assert.equal(u.amount, 17510);
    assert.equal(u.name, '国民年金');
    const a = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'scheduled_item.updated'`).all() as { payload_json: string }[];
    assert.equal(a.length, 1);
    assert.deepEqual(JSON.parse(a[0].payload_json).changes, { amount: { from: 16980, to: 17510 } });
    assert.ok(verifyAudit(db).ok);
  });

  test('不正な値は 400、無い項目は 404', async () => {
    const it = await create();
    for (const [body, code] of [
      [{ amount: -1 }, 'invalid_amount'],
      [{ origin: 'estimate' }, 'invalid_field'],
      [{ amount_kind: 'x' }, 'invalid_amount_kind'],
      [{ category: 'savings', direction: 'in' }, 'invalid_category_for_direction'],
      [{ anchor_date: '2027-01-01', end_date: '2026-12-31' }, 'end_before_anchor'],
      ['nope', 'invalid_json'],
    ] as [unknown, string][]) {
      const res = await send('PATCH', `/api/scheduled_items/${it.id}`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error: code });
    }
    const res = await send('PATCH', '/api/scheduled_items/NOPE', { amount: 1 });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });
});

describe('amount_kind と積立（savings）', () => {
  test('POST・PATCH で amount_kind を受け、一覧・upcoming・/api/cashflow の items に amount_kind が付く', async () => {
    const v = await create({ name: 'テストでんき', category: 'savings', amount_kind: 'variable' });
    assert.deepEqual([v.amount_kind, v.category], ['variable', 'savings']);
    const f = await create({ name: '定額' });
    const list = (await (await get('/api/scheduled_items')).json()) as { items: { id: string; amount_kind: string }[] };
    assert.deepEqual(Object.fromEntries(list.items.map((x) => [x.id, x.amount_kind])), { [v.id as string]: 'variable', [f.id as string]: 'fixed' });
    const up = (await (await get('/api/scheduled_items/upcoming')).json()) as { items: { id: string; amount_kind: string }[] };
    assert.equal(up.items.find((x) => x.id === v.id)!.amount_kind, 'variable');
    const cf = (await (await get('/api/cashflow?months=2')).json()) as { months: { items: { id: string; amount_kind: string }[] }[] };
    const items = cf.months.flatMap((m) => m.items);
    assert.ok(items.length > 0);
    assert.ok(items.every((x) => x.amount_kind === (x.id === v.id ? 'variable' : 'fixed')));
    const res = await send('PATCH', `/api/scheduled_items/${v.id}`, { amount_kind: 'fixed' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { amount_kind: string }).amount_kind, 'fixed');
  });
});

describe('POST /api/scheduled_items/:id/deactivate と GET /api/scheduled_items', () => {
  test('止めた項目は既定の一覧に出ず、all=1 で出る', async () => {
    const a = await create({ name: 'A' });
    const b = await create({ name: 'B' });
    const res = await send('POST', `/api/scheduled_items/${b.id}/deactivate`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { active: number }).active, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM scheduled_items').get() as { n: number }).n, 2);

    const list = (await (await get('/api/scheduled_items')).json()) as { items: { id: string }[] };
    assert.deepEqual(list.items.map((x) => x.id), [a.id]);
    const all = (await (await get('/api/scheduled_items?all=1')).json()) as { items: { id: string }[] };
    assert.deepEqual(new Set(all.items.map((x) => x.id)), new Set([a.id, b.id]));
    assert.equal((await get('/api/scheduled_items?all=yes')).status, 400);
    assert.equal((await send('POST', '/api/scheduled_items/NOPE/deactivate')).status, 404);
  });

  test('activate で戻す（冪等）。PATCH では active を変えられない', async () => {
    const a = await create({ name: 'A' });
    await send('POST', `/api/scheduled_items/${a.id}/deactivate`);
    assert.equal((await send('PATCH', `/api/scheduled_items/${a.id}`, { active: 1 })).status, 400);
    for (let i = 0; i < 2; i++) {
      const res = await send('POST', `/api/scheduled_items/${a.id}/activate`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { active: number }).active, 1);
    }
    const acts = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ? ORDER BY seq`).all(a.id as string) as { action: string }[];
    assert.deepEqual(acts.map((x) => x.action), ['scheduled_item.created', 'scheduled_item.deactivated', 'scheduled_item.reactivated']);
    const list = (await (await get('/api/scheduled_items')).json()) as { items: { id: string }[] };
    assert.deepEqual(list.items.map((x) => x.id), [a.id]);
    assert.equal((await send('POST', '/api/scheduled_items/NOPE/activate')).status, 404);
  });
});

describe('GET /api/scheduled_items/upcoming', () => {
  test('今日（JST）から days 日後までを期日順に', async () => {
    await create({ name: '年金', recurrence: 'monthly', anchor_date: '2026-10-31' });
    await create({ name: '車検', recurrence: 'biennial', anchor_date: '2024-11-20', category: 'car' });
    await create({ name: '昨日', recurrence: 'once', anchor_date: '2026-11-05', category: 'other' });
    const res = await get('/api/scheduled_items/upcoming');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { from: string; to: string; items: { name: string; due_date: string }[] };
    assert.equal(body.from, '2026-11-06');
    assert.equal(body.to, '2026-12-06');
    assert.deepEqual(body.items.map((x) => [x.name, x.due_date]), [['車検', '2026-11-20'], ['年金', '2026-11-30']]);

    const long = (await (await get('/api/scheduled_items/upcoming?days=60')).json()) as { items: { name: string; due_date: string }[] };
    assert.deepEqual(long.items.map((x) => [x.name, x.due_date]), [['車検', '2026-11-20'], ['年金', '2026-11-30'], ['年金', '2026-12-31']]);
  });

  test('今日は JST の暦日（14:59:59Z は前日、15:00:00Z は当日）', async () => {
    await create({ name: '前日', recurrence: 'once', anchor_date: '2026-11-05', category: 'other' });
    const at = async (iso: string) => {
      const a = new Hono();
      a.route('/api', cashflowRoutes({ db, now: () => new Date(iso), config: { cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false } } }));
      return (await (await a.request('/api/scheduled_items/upcoming?days=1', { headers })).json()) as { from: string; to: string; items: { name: string }[] };
    };
    const before = await at('2026-11-05T14:59:59Z');
    assert.equal(before.from, '2026-11-05');
    assert.equal(before.to, '2026-11-06');
    assert.deepEqual(before.items.map((x) => x.name), ['前日']);
    const afterMidnight = await at('2026-11-05T15:00:00Z');
    assert.equal(afterMidnight.from, '2026-11-06');
    assert.equal(afterMidnight.to, '2026-11-07');
    assert.deepEqual(afterMidnight.items, []);
  });

  test('days が不正なら 400', async () => {
    for (const q of ['0', '-1', '1.5', 'abc', '1097', '']) {
      const res = await get(`/api/scheduled_items/upcoming?days=${q}`);
      assert.equal(res.status, 400, q);
      assert.deepEqual(await res.json(), { error: 'invalid_days' });
    }
    assert.equal((await get('/api/scheduled_items/upcoming?days=1096')).status, 200);
  });
});
