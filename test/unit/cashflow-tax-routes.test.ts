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

  test('給与の 4 欄: 保存・GET で返る・監査の changes に出る。控除後 > 支払金額・源泉だけ・負の値は 400', async () => {
    const salary = { salary_income: 5_000_000, salary_after_deduction: 3_560_000, salary_withheld_tax: 123_030, salary_social_insurance: 700_000 };
    const put = await send('PUT', '/api/tax/years/2025', { kind: 'actual', social_insurance_paid: 0, ...salary });
    assert.equal(put.status, 200);
    assert.deepEqual(
      [put.body.year.salary_income, put.body.year.salary_after_deduction, put.body.year.salary_withheld_tax, put.body.year.salary_social_insurance],
      [5_000_000, 3_560_000, 123_030, 700_000],
    );
    const y = (await get('/api/tax/profile')).body.years.find((x: { year: number }) => x.year === 2025);
    assert.deepEqual({ ...salary, ...y }, y);
    const a = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'tax_year.updated' ORDER BY seq DESC LIMIT 1`).get() as { payload_json: string };
    const changes = JSON.parse(a.payload_json).changes;
    for (const [k, v] of Object.entries(salary)) assert.deepEqual(changes[k], { from: null, to: v }, k);

    // 部分更新: 重ねた後の値で確かめる（支払金額だけ下げて控除後を超える）。
    for (const [body, code] of [
      [{ salary_income: 3_000_000 }, 'invalid_salary_after_deduction'],
      [{ salary_income: -1 }, 'invalid_salary_income'],
      [{ salary_after_deduction: -1 }, 'invalid_salary_after_deduction'],
      [{ salary_withheld_tax: -1 }, 'invalid_salary_withheld_tax'],
      [{ salary_social_insurance: 1.5 }, 'invalid_salary_social_insurance'],
      [{ salary_income: null, salary_after_deduction: null }, 'salary_income_required'],
    ] as [Record<string, unknown>, string][]) {
      assert.deepEqual(await send('PUT', '/api/tax/years/2025', body), { status: 400, body: { error: code } }, JSON.stringify(body));
    }
    assert.deepEqual(await send('PUT', '/api/tax/years/2026', { kind: 'estimate', salary_withheld_tax: 10_000 }), { status: 400, body: { error: 'salary_income_required' } });
    assert.deepEqual(await send('PUT', '/api/tax/years/2026', { kind: 'estimate', salary_social_insurance: 10_000 }), { status: 400, body: { error: 'salary_income_required' } });
    // 控除後の金額だけでも給与所得は出せる。支払金額 = 控除後 は通る。
    assert.equal((await send('PUT', '/api/tax/years/2026', { kind: 'estimate', salary_after_deduction: 1_000_000, salary_withheld_tax: 10_000 })).status, 200);
    assert.equal((await send('PUT', '/api/tax/years/2026', { salary_income: 1_000_000 })).status, 200);
    assert.ok(verifyAudit(db).ok);
  });

  test('年ごとの消費税の方式: 保存・GET で返る・監査に出る・検査は 400・両方 null で上書きが消える・DB の CHECK', async () => {
    assert.equal((await send('PUT', '/api/tax/profile', { consumption_mode: 'simplified', simplified_class: 5 })).status, 200);
    const put = await send('PUT', '/api/tax/years/2026', { kind: 'estimate', revenue: 5_500_000, expenses: 0, consumption_mode: 'special20' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual([put.body.year.consumption_mode, put.body.year.simplified_class], ['special20', null]);
    const y = (await get('/api/tax/profile')).body.years.find((x: { year: number }) => x.year === 2026);
    assert.deepEqual([y.consumption_mode, y.simplified_class], ['special20', null]);
    const a = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'tax_year.updated' ORDER BY seq DESC LIMIT 1`).get() as { payload_json: string };
    assert.deepEqual(JSON.parse(a.payload_json).changes.consumption_mode, { from: null, to: 'special20' });
    const ctax = async () => ((await get('/api/scheduled_items')).body.items as Record<string, any>[]).find((i) => i.estimate_key === 'ctax:2026:final' && i.active === 1)?.amount;
    // 2 割特例: 税抜 5,000,000 × 10% × 20%。
    assert.equal(await ctax(), 100_000);

    for (const [body, code] of [
      [{ consumption_mode: 'simplified' }, 'simplified_class_required'],
      [{ simplified_class: 5 }, 'invalid_simplified_class'], // 重ねた後は special20 + 区分
      [{ consumption_mode: 'special20', simplified_class: 5 }, 'invalid_simplified_class'],
      [{ consumption_mode: 'simplified', simplified_class: 7 }, 'invalid_simplified_class'],
      [{ consumption_mode: null, simplified_class: 5 }, 'invalid_simplified_class'],
      [{ consumption_mode: 'unset' }, 'invalid_consumption_mode'],
      [{ consumption_mode: 'weekly' }, 'invalid_consumption_mode'],
    ] as [Record<string, unknown>, string][]) {
      assert.deepEqual(await send('PUT', '/api/tax/years/2026', body), { status: 400, body: { error: code } }, JSON.stringify(body));
    }
    assert.deepEqual(
      await send('PUT', '/api/tax', { years: [{ year: 2027, kind: 'estimate', consumption_mode: 'simplified' }] }),
      { status: 400, body: { error: 'simplified_class_required' } },
    );
    // 簡易課税の上書きは区分と一緒に保存できる。
    const s = await send('PUT', '/api/tax/years/2026', { consumption_mode: 'simplified', simplified_class: 1 });
    assert.deepEqual([s.status, s.body.year.consumption_mode, s.body.year.simplified_class], [200, 'simplified', 1]);
    assert.equal(await ctax(), 50_000);
    // 両方 null で上書きを消す → profile の第 5 種。
    const c = await send('PUT', '/api/tax/years/2026', { consumption_mode: null, simplified_class: null });
    assert.deepEqual([c.status, c.body.year.consumption_mode, c.body.year.simplified_class], [200, null, null]);
    assert.equal(await ctax(), 250_000);

    // 2 割特例で 2027 年以降も保存できる（警告で知らせる）。
    const e = await send('PUT', '/api/tax/years/2027', { kind: 'estimate', consumption_mode: 'special20' });
    assert.equal(e.status, 200);
    assert.ok(e.body.run.warnings.some((w: { kind: string; year?: number }) => w.kind === 'special20_expired' && w.year === 2027));
    assert.deepEqual(
      (await get('/api/cashflow')).body.warnings.filter((w: { kind: string }) => w.kind === 'special20_expired'),
      [{ kind: 'special20_expired', year: 2027 }],
    );

    // アプリの検査を通らない値は DB の CHECK でも落ちる。
    assert.throws(() => db.prepare(`UPDATE tax_years SET consumption_mode = 'simplified' WHERE year = 2026`).run(), /CHECK constraint failed/);
    assert.throws(() => db.prepare(`UPDATE tax_years SET simplified_class = 5 WHERE year = 2027`).run(), /CHECK constraint failed/);
    assert.throws(() => db.prepare(`UPDATE tax_years SET consumption_mode = 'unset' WHERE year = 2026`).run(), /CHECK constraint failed/);
    assert.ok(verifyAudit(db).ok);
  });

  test('GET /api/cashflow の consumption_tax_mode_unset は最新の run から: 期間の年すべてに上書きがあれば出ない', async () => {
    const years = [2025, 2026, 2027, 2028, 2029, 2030].map((year) => ({ year, kind: 'estimate', revenue: 5_000_000, expenses: 0, consumption_mode: 'standard' }));
    const unset = async () => (await get('/api/cashflow')).body.warnings.some((w: { kind: string }) => w.kind === 'consumption_tax_mode_unset');
    assert.equal((await send('PUT', '/api/tax', { profile: { consumption_mode: 'unset' }, years: years.slice(0, 5) })).status, 200);
    assert.equal(await unset(), true); // 2030 年（期間の最後の年）は profile の unset
    assert.equal((await send('PUT', '/api/tax', { years: years.slice(5) })).status, 200);
    assert.equal(await unset(), false);
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

describe('POST /api/tax/simulate', () => {
  const counts = () =>
    ['scheduled_items', 'tax_estimate_runs', 'audit_log', 'tax_profile', 'tax_years'].map((t) => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n);

  test('body 空: profile と tax_years が既定になり、DB の行数は変わらない', async () => {
    const saved = await send('PUT', '/api/tax', {
      profile: { consumption_mode: 'simplified', simplified_class: 5 },
      years: [{ year: 2025, kind: 'actual', revenue: 5_000_000, expenses: 500_000 }, { year: 2026, kind: 'estimate', revenue: 6_000_000, expenses: 1_000_000 }],
    });
    assert.equal(saved.status, 200);
    const before = counts();
    const r = await send('POST', '/api/tax/simulate', '');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.year, 2027); // 今年 + 1
    assert.deepEqual(
      [r.body.inputs.revenue, r.body.inputs.expenses, r.body.inputs.taxable_purchases, r.body.inputs.consumption_mode, r.body.inputs.simplified_class],
      [6_000_000, 1_000_000, 1_000_000, 'simplified', 5],
    );
    assert.deepEqual(r.body.inputs.source, { revenue: 'tax_years:2026', expenses: 'tax_years:2026', consumption_mode: 'profile' });
    // body の値と profile の上書きが勝つ（DB の profile は変わらない）。
    const o = await send('POST', '/api/tax/simulate', { year: 2026, expenses: 2_000_000, profile: { consumption_mode: 'special20' } });
    assert.equal(o.status, 200);
    assert.deepEqual(o.body.inputs.source, { revenue: 'tax_years:2026', expenses: 'body', consumption_mode: 'body' });
    assert.equal(o.body.inputs.consumption_mode, 'special20');
    assert.deepEqual(counts(), before);
    assert.equal((await get('/api/tax/profile')).body.profile.consumption_mode, 'simplified');
  });

  test('profile の 2 割特例が Y 年に使えなければ簡易課税に補正、body で明示したら補正しない', async () => {
    assert.equal((await send('PUT', '/api/tax/profile', { consumption_mode: 'special20', simplified_class: 5 })).status, 200);
    const r = await send('POST', '/api/tax/simulate', { revenue: 6_000_000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.year, r.body.inputs.consumption_mode, r.body.inputs.simplified_class, r.body.inputs.source.consumption_mode], [2027, 'simplified', 5, 'defaulted']);
    assert.deepEqual(r.body.warnings.filter((w: { kind: string }) => w.kind === 'mode_defaulted'), [{ kind: 'mode_defaulted', from: 'special20', to: 'simplified', simplified_class: 5 }]);
    const b = await send('POST', '/api/tax/simulate', { revenue: 6_000_000, profile: { consumption_mode: 'special20' } });
    assert.deepEqual([b.body.inputs.consumption_mode, b.body.inputs.source.consumption_mode], ['special20', 'body']);
    assert.ok(b.body.warnings.some((w: { kind: string }) => w.kind === 'selected_mode_unavailable'));
    assert.ok(!b.body.warnings.some((w: { kind: string }) => w.kind === 'mode_defaulted' || w.kind === 'special20_expired'));
  });

  test('試算の方式: body → year の行の上書き → profile の順。year の行の方式も使えなければ補正する', async () => {
    const sim = (body: Record<string, unknown> = {}) => send('POST', '/api/tax/simulate', { year: 2027, revenue: 6_000_000, ...body });
    const modeOf = (r: { body: Record<string, any> }) => [r.body.inputs.consumption_mode, r.body.inputs.simplified_class, r.body.inputs.source.consumption_mode];
    const defaulted = (r: { body: Record<string, any> }) => r.body.warnings.filter((w: { kind: string }) => w.kind === 'mode_defaulted');

    // profile = 2 割特例・第 5 種、2027 年の行 = 簡易課税 第 5 種 → 行の方式（補正なし）。
    assert.equal((await send('PUT', '/api/tax/profile', { consumption_mode: 'special20', simplified_class: 5 })).status, 200);
    assert.equal((await send('PUT', '/api/tax/years/2027', { kind: 'estimate', consumption_mode: 'simplified', simplified_class: 5 })).status, 200);
    const a = await sim();
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(modeOf(a), ['simplified', 5, 'tax_years:2027']);
    assert.deepEqual(defaulted(a), []);

    // profile = 簡易課税 第 5 種、2027 年の行 = 2 割特例 → 2027 年分は使えないので簡易課税（profile の区分）に補正。
    assert.equal((await send('PUT', '/api/tax/profile', { consumption_mode: 'simplified', simplified_class: 5 })).status, 200);
    assert.equal((await send('PUT', '/api/tax/years/2027', { consumption_mode: 'special20', simplified_class: null })).status, 200);
    const b = await sim();
    assert.deepEqual(modeOf(b), ['simplified', 5, 'defaulted']);
    assert.deepEqual(defaulted(b), [{ kind: 'mode_defaulted', from: 'special20', to: 'simplified', simplified_class: 5 }]);

    // body.profile の方式は year の行より優先（補正しない）。
    const c = await sim({ profile: { consumption_mode: 'special20' } });
    assert.deepEqual(modeOf(c), ['special20', 5, 'body']);
    assert.deepEqual(defaulted(c), []);
    assert.ok(c.body.warnings.some((w: { kind: string }) => w.kind === 'selected_mode_unavailable'));

    // 行の無い年（2028）は profile。
    assert.deepEqual(modeOf(await sim({ year: 2028 })), ['simplified', 5, 'profile']);
  });

  test('profile も tax_years も無ければ 400 income_required、revenue だけなら DEFAULT_PROFILE で 200', async () => {
    assert.deepEqual(await send('POST', '/api/tax/simulate', {}), { status: 400, body: { error: 'income_required' } });
    const r = await send('POST', '/api/tax/simulate', { revenue: 6_000_000 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.inputs.blue_return, r.body.inputs.consumption_mode, r.body.inputs.expenses], ['65', 'unset', 0]);
    assert.deepEqual(r.body.inputs.source, { revenue: 'body', expenses: 'default', consumption_mode: 'profile' });
    assert.ok(r.body.warnings.some((w: { kind: string }) => w.kind === 'consumption_tax_mode_unset'));
    assert.deepEqual(counts(), [0, 0, 0, 0, 0]);
  });

  test('不正な入力は 400', async () => {
    for (const [body, code] of [
      [{ revenue: 1, nope: 1 }, 'invalid_field'],
      [{ revenue: 1, profile: { nope: 1 } }, 'invalid_field'],
      [{ revenue: 1, profile: { pension_mode: 'weekly' } }, 'invalid_pension_mode'],
      [{ revenue: 1, profile: [] }, 'invalid_profile'],
      [{ revenue: 1, year: 1999 }, 'invalid_year'],
      [{ revenue: 1, year: 2101 }, 'invalid_year'],
      [{ revenue: -1 }, 'invalid_revenue'],
      [{ revenue: 1, expenses: 1.5 }, 'invalid_expenses'],
      [{ revenue: 1, ideco: -1 }, 'invalid_ideco'],
      [{ revenue: 1, kyosai: '1' }, 'invalid_kyosai'],
      [{ revenue: 1, taxable_purchases: null }, 'invalid_taxable_purchases'],
      [{ revenue: 1, marginal_delta: 0 }, 'invalid_marginal_delta'],
      [[1], 'invalid_body'],
      ['nope', 'invalid_body'],
      ['3', 'invalid_body'],
    ] as [unknown, string][]) {
      const r = await send('POST', '/api/tax/simulate', typeof body === 'string' ? body : JSON.stringify(body));
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.body, { error: code }, JSON.stringify(body));
    }
    assert.deepEqual(counts(), [0, 0, 0, 0, 0]);
  });

  test('応答のキーと順序（amounts 6 要素・ctax_compare 9 要素）', async () => {
    const r = await send('POST', '/api/tax/simulate', { revenue: 8_000_000, expenses: 1_000_000, taxable_purchases: 800_000, profile: { consumption_mode: 'simplified', simplified_class: 5 } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), [
      'year', 'inputs', 'income', 'amounts', 'total', 'cash_profit', 'take_home', 'free_cash', 'effective_rate', 'marginal', 'deductions', 'ctax_compare', 'best', 'warnings', 'assumptions',
    ]);
    assert.deepEqual(Object.keys(r.body.inputs), [
      'revenue', 'expenses', 'business_income', 'taxable_purchases', 'ideco', 'kyosai', 'other_deductions', 'revenue_includes_tax', 'blue_return', 'consumption_mode', 'simplified_class', 'source',
    ]);
    assert.deepEqual(Object.keys(r.body.income), ['pre_blue', 'business_income']);
    assert.deepEqual(r.body.amounts.map((a: Record<string, unknown>) => [a.kind, a.year, a.basis]), [
      ['income_tax', 2027, 'year'], ['resident', 2028, 'fiscal_year'], ['nhi', 2028, 'fiscal_year'], ['pension', 2027, 'fiscal_year'], ['biz_tax', 2028, 'fiscal_year'], ['ctax', 2027, 'year'],
    ]);
    assert.deepEqual(Object.keys(r.body.amounts[0]), ['kind', 'year', 'basis', 'amount', 'lines']);
    assert.deepEqual(Object.keys(r.body.marginal), ['delta', 'total_increase', 'take_home_increase', 'rate']);
    assert.deepEqual(Object.keys(r.body.deductions), ['ideco', 'kyosai', 'saving']);
    assert.deepEqual(r.body.ctax_compare.map((c: Record<string, unknown>) => [c.mode, c.simplified_class]), [
      ['exempt', null], ['special20', null], ['simplified', 1], ['simplified', 2], ['simplified', 3], ['simplified', 4], ['simplified', 5], ['simplified', 6], ['standard', null],
    ]);
    assert.deepEqual(Object.keys(r.body.ctax_compare[0]), ['mode', 'simplified_class', 'available', 'reason', 'tax', 'take_home', 'notes']);
    assert.deepEqual(r.body.ctax_compare[1], { mode: 'special20', simplified_class: null, available: false, reason: 'special20_expired', tax: null, take_home: null, notes: [] });
    assert.deepEqual(r.body.best, { mode: 'simplified', simplified_class: 1 });
    assert.deepEqual(r.body.assumptions, ['steady_state']);
    assert.equal(r.body.income.pre_blue, 7_000_000);
  });
});
