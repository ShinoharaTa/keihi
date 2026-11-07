// 税金・保険料の見積もりの API（docs/cashflow.md §14.4、src/web/routes/tax.ts）と、予定台帳・資金繰りの応答に足した列。
// app.request() で叩く（ポートを開かない）。cashflow-routes.test.ts と同じく認証を先に差し込んだ Hono を自前で組む。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createAuth } from '../../src/web/auth.ts';
import { cashflowRoutes } from '../../src/web/routes/cashflow.ts';
import { taxRoutes } from '../../src/web/routes/tax.ts';
import { taxProfileDraft, taxSaveBody, taxYearDrafts } from '../../pwa/src/money/model.ts';

// 2026-11-07 09:00 JST
const T0 = new Date('2026-11-07T00:00:00.000Z');
const HOST = '127.0.0.1:8787';
const USER = 'me@example.com';
let root: string;
let n = 0;
let db: Db;
let app: Hono;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-tax-api-'));
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
  app.route('/api', taxRoutes({ db, now: () => T0 }));
});

const headers = { Host: HOST, 'Tailscale-User-Login': USER, 'content-type': 'application/json' };
const get = async (url: string) => {
  const res = await app.request(url, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const send = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe('税の見積もりの API', () => {
  test('PUT → 台帳に項目ができる → PATCH amount で pinned=1 → recalculate で変わらない', async () => {
    // まだ何も無い: プロファイルは null、資金繰りに tax_profile_missing。
    const p0 = await get('/api/tax/profile');
    assert.equal(p0.status, 200);
    assert.deepEqual({ ...p0.body, presets: undefined }, { profile: null, years: [], presets: undefined, missing: ['profile'] });
    assert.deepEqual(p0.body.presets, [{ id: 'saitama-city-2026', label: 'さいたま市 令和 8 年度' }]);
    assert.ok((await get('/api/cashflow')).body.warnings.some((w: { kind: string }) => w.kind === 'tax_profile_missing'));

    const y25 = await send('PUT', '/api/tax/years/2025', { kind: 'actual', business_income: 3_000_000, income_tax_final: 150_000, prepaid_income_tax: 0, social_insurance_paid: 600_000 });
    assert.equal(y25.status, 200);
    assert.equal(y25.body.year.year, 2025);
    assert.deepEqual(y25.body.run.warnings, [{ kind: 'tax_profile_missing' }]);
    assert.equal((await send('PUT', '/api/tax/years/2026', { kind: 'estimate', revenue: 5_000_000, expenses: 1_500_000 })).status, 200);

    const put = await send('PUT', '/api/tax/profile', { nhi_members_40_64: 1 });
    assert.equal(put.status, 200);
    assert.equal(put.body.profile.nhi_preset, 'saitama-city-2026');
    assert.equal(put.body.profile.spouse, false);
    assert.ok(put.body.run.created > 0);
    assert.deepEqual(Object.keys(put.body.run).sort(), ['created', 'deactivated', 'run_id', 'skipped_pinned', 'updated', 'warnings']);

    // 台帳: estimate_key・pinned・origin が出る。
    const list = (await get('/api/scheduled_items')).body.items as Record<string, any>[];
    const nhi1 = list.find((i) => i.estimate_key === 'nhi:2026:p1')!;
    assert.deepEqual([nhi1.origin, nhi1.pinned, nhi1.amount, nhi1.anchor_date, nhi1.name], ['estimate', 0, 51_500, '2026-07-31', '国民健康保険税 2026 年度 第 1 期（見積）']);
    assert.equal(list.length, put.body.run.created);

    // 資金繰りの items にも同じ列。
    const cf = (await get('/api/cashflow')).body;
    const dec = cf.months.find((m: { month: string }) => m.month === '2026-12');
    // 年金の月払いは monthly の 1 項目（anchor 2026-05-31。各月分を翌月末に納める）。毎月の期日は月末。
    const pension = dec.items.find((i: { estimate_key: string }) => i.estimate_key === 'pension:2026:monthly');
    assert.deepEqual([pension.origin, pension.pinned, pension.amount, pension.due], ['estimate', 0, 17_920, '2026-12-31']);
    assert.equal(cf.warnings.some((w: { kind: string }) => w.kind === 'tax_profile_missing'), false);
    assert.ok(cf.warnings.some((w: { kind: string }) => w.kind === 'consumption_tax_mode_unset'));

    // 手で直すと pinned = 1。
    const target = list.find((i) => i.estimate_key === 'resident:2027:q1')!;
    const patched = await send('PATCH', `/api/scheduled_items/${target.id}`, { amount: 60_000 });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.pinned, 1);

    const re = await send('POST', '/api/tax/recalculate');
    assert.equal(re.status, 200);
    assert.deepEqual([re.body.created, re.body.updated, re.body.deactivated], [0, 0, 0]);
    assert.deepEqual(re.body.skipped_pinned.map((s: { key: string }) => s.key), ['resident:2027:q1']);
    const after = (await get('/api/scheduled_items')).body.items.find((i: { id: string }) => i.id === target.id);
    assert.deepEqual([after.amount, after.pinned], [60_000, 1]);

    // 最新の結果: 内訳の行つき。
    const est = (await get('/api/tax/estimates')).body;
    assert.equal(est.run_id, re.body.run_id);
    const it = est.items.find((i: { key: string }) => i.key === 'nhi:2026:p1');
    assert.equal(it.kind, 'nhi');
    assert.equal(it.year, 2026);
    assert.ok(it.lines.some((l: { label: string; amount: number }) => l.label === '年税額' && l.amount === 409_900));

    // pinned: false で戻すと、次の再計算で計算値に戻る。
    assert.equal((await send('PATCH', `/api/scheduled_items/${target.id}`, { pinned: false })).body.pinned, 0);
    const re2 = await send('POST', '/api/tax/recalculate');
    assert.equal(re2.body.updated, 1);
    assert.equal((await get('/api/scheduled_items')).body.items.find((i: { id: string }) => i.id === target.id).amount, target.amount);

    const prof = (await get('/api/tax/profile')).body;
    assert.deepEqual(prof.years.map((y: { year: number }) => y.year), [2025, 2026]);
    assert.deepEqual(prof.missing, ['consumption_mode']);
    assert.ok(verifyAudit(db).ok);
  });

  test('不正な入力は 400', async () => {
    for (const [method, url, body, code] of [
      ['PUT', '/api/tax/profile', { nope: 1 }, 'invalid_field'],
      ['PUT', '/api/tax/profile', { pension_mode: 'weekly' }, 'invalid_pension_mode'],
      ['PUT', '/api/tax/profile', 'nope', 'invalid_json'],
      ['PUT', '/api/tax/profile', { nhi_preset: null, nhi_rates_json: { medical: { rate: 0.07 } } }, 'invalid_nhi_rates_json'],
      ['PUT', '/api/tax/years/26', { kind: 'actual' }, 'invalid_year'],
      ['PUT', '/api/tax/years/2026', { kind: 'actual', nope: 1 }, 'invalid_field'],
      ['PUT', '/api/tax/years/2026', { revenue: 1 }, 'missing_kind'],
    ] as [string, string, unknown, string][]) {
      const r = await send(method, url, body);
      assert.equal(r.status, 400, `${url} ${JSON.stringify(body)}`);
      assert.deepEqual(r.body, { error: code });
    }
    assert.equal((db.prepare('SELECT count(*) n FROM tax_profile').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM tax_years').get() as { n: number }).n, 0);
    assert.deepEqual((await get('/api/tax/estimates')).body.run_id, null);
  });

  test('PUT /api/tax: profile と years を一括で保存し、再計算は 1 回', async () => {
    const r = await send('PUT', '/api/tax', {
      profile: { consumption_mode: 'standard', revenue_includes_tax: false, nhi_members_40_64: 1 },
      years: [
        { year: 2025, kind: 'actual', business_income: 3_000_000, income_tax_final: 150_000, prepaid_income_tax: 0, social_insurance_paid: 600_000 },
        { year: 2026, kind: 'estimate', revenue: 5_000_000, expenses: 1_500_000 },
      ],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['profile', 'run', 'years']);
    assert.equal(r.body.profile.revenue_includes_tax, false);
    assert.deepEqual(r.body.years.map((y: { year: number }) => y.year), [2025, 2026]);
    assert.deepEqual(Object.keys(r.body.run).sort(), ['created', 'deactivated', 'run_id', 'skipped_pinned', 'updated', 'warnings']);
    assert.equal((db.prepare('SELECT count(*) n FROM tax_estimate_runs').get() as { n: number }).n, 1);
    // 消費税（本則・税抜）: 500,000 − 150,000 = 350,000。
    const list = (await get('/api/scheduled_items')).body.items as Record<string, any>[];
    assert.equal(list.find((i) => i.estimate_key === 'ctax:2026:final')!.amount, 350_000);
    // 資金繰りの警告に消費税の未実装は出ない。
    assert.equal((await get('/api/cashflow')).body.warnings.some((w: { kind: string }) => w.kind.startsWith('consumption_tax')), false);

    for (const [body, code] of [
      [{}, 'empty_body'],
      [{ nope: 1 }, 'invalid_field'],
      [{ profile: { nope: 1 } }, 'invalid_field'],
      [{ years: [{ year: 2026, kind: 'weekly' }] }, 'invalid_kind'],
      ['nope', 'invalid_json'],
    ] as [unknown, string][]) {
      assert.deepEqual(await send('PUT', '/api/tax', body), { status: 400, body: { error: code } }, JSON.stringify(body));
    }
    assert.equal((db.prepare('SELECT count(*) n FROM tax_estimate_runs').get() as { n: number }).n, 1);
    assert.ok(verifyAudit(db).ok);
  });

  test('PUT /api/tax: PWA の taxSaveBody の形（プロファイル未作成で全列、他方式で simplified_class: null、years は {year, kind, 欄}）', async () => {
    const draft = { ...taxProfileDraft(null), consumption_mode: 'standard' as const, revenue_includes_tax: false };
    const drafts = taxYearDrafts([], '2026-11-07').map((d) =>
      d.year === 2025 ? { ...d, values: { ...d.values, business_income: '3000000', income_tax_final: '150000', prepaid_income_tax: '0', social_insurance_paid: '600000' } }
      : d.year === 2026 ? { ...d, values: { ...d.values, revenue: '5000000', expenses: '1500000' } }
      : d,
    );
    const body = taxSaveBody(draft, drafts, { profile: null, years: [] });
    assert.ok(body && typeof body === 'object');
    assert.equal(body.profile!.simplified_class, null);
    assert.deepEqual(body.years!.map((y) => [y.year, y.kind]), [[2025, 'actual'], [2026, 'estimate']]);
    const r = await send('PUT', '/api/tax', body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.profile.consumption_mode, 'standard');
    assert.deepEqual(r.body.years.map((y: { year: number }) => y.year), [2025, 2026]);
    const list = (await get('/api/scheduled_items')).body.items as Record<string, any>[];
    assert.equal(list.find((i) => i.estimate_key === 'ctax:2026:final')!.amount, 350_000);
  });

  test('GET /api/cashflow の warnings: simplified_class_missing（プロファイルから）・special20_expired（最新の run から）', async () => {
    assert.equal((await send('PUT', '/api/tax', { profile: { consumption_mode: 'simplified' }, years: [{ year: 2026, kind: 'estimate', revenue: 5_000_000, expenses: 0 }] })).status, 200);
    const kinds = async () => (await get('/api/cashflow')).body.warnings.filter((w: { kind: string }) => /^(simplified|special20|consumption)/.test(w.kind));
    assert.deepEqual(await kinds(), [{ kind: 'simplified_class_missing' }]);
    assert.equal((await send('PUT', '/api/tax', { profile: { consumption_mode: 'special20' } })).status, 200);
    assert.deepEqual(await kinds(), [{ kind: 'special20_expired', year: 2027 }, { kind: 'special20_expired', year: 2028 }]);
  });

  test('PATCH /api/scheduled_items/:id の pinned は見積もりの項目だけ', async () => {
    const it = await send('POST', '/api/scheduled_items', { name: '手入力', amount: 1000, direction: 'out', category: 'tax', recurrence: 'once', anchor_date: '2026-12-01' });
    assert.equal(it.status, 201);
    assert.equal(it.body.pinned, 0);
    assert.equal(it.body.estimate_key, null);
    assert.deepEqual(await send('PATCH', `/api/scheduled_items/${it.body.id}`, { pinned: true }), { status: 400, body: { error: 'invalid_pinned' } });
    assert.deepEqual(await send('PATCH', `/api/scheduled_items/${it.body.id}`, { pinned: 'yes' }), { status: 400, body: { error: 'invalid_pinned' } });
    assert.deepEqual(await send('POST', '/api/scheduled_items', { name: 'x', amount: 1, direction: 'out', category: 'tax', recurrence: 'once', anchor_date: '2026-12-01', pinned: true }), { status: 400, body: { error: 'invalid_field' } });
  });
});
