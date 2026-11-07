// マイグレーション 0008_tax と、見積もりの予定台帳への同期（docs/cashflow.md §14.2、src/cashflow/tax/sync.ts）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import { insertAccount } from '../../src/bank/repo.ts';
import { getScheduledItem, listScheduledItems } from '../../src/cashflow/repo.ts';
import { ScheduleError, createItem, deactivateItem, parseBody, updateItem, type ItemInput } from '../../src/cashflow/schedule.ts';
import { insertTaxEstimateRun, listTaxYears } from '../../src/cashflow/tax/repo.ts';
import { DEFAULT_PROFILE, TaxError, estimateWindow, recalculate, saveProfile, saveYear } from '../../src/cashflow/tax/sync.ts';
import { integrityCheck, openDb, type Db } from '../../src/db/index.ts';
import { listMigrations, migrate } from '../../src/db/migrate.ts';

const TODAY = '2026-11-07';
const T0 = new Date('2026-11-07T00:00:00.000Z');
const T1 = new Date('2026-11-08T00:00:00.000Z');
const T2 = new Date('2026-11-09T00:00:00.000Z');
const user = { actor: 'user', user: 'me@example.com' };
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-tax-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function freshDb(): Db {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  return db;
}

const manual: ItemInput = {
  name: '手入力', amount: 1000, direction: 'out', category: 'tax', accountId: null, recurrence: 'once', anchorDate: '2026-12-01', endDate: null, notifyDaysBefore: 14, origin: 'manual',
};
const estimateInput = (key: string): ItemInput => ({ ...manual, origin: 'estimate', estimateKey: key });

describe('0008_tax のマイグレーション', () => {
  test('空の DB から上がる', () => {
    const db = openDb(path.join(root, `${n++}.db`));
    try {
      assert.ok(migrate(db).includes('0008_tax.sql'));
      assert.deepEqual(integrityCheck(db), []);
      for (const t of ['tax_profile', 'tax_years', 'tax_estimate_runs']) assert.equal((db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  });

  test('0007 まで上げた DB（行あり）から上がり、既存の行は estimate_key = NULL・pinned = 0', () => {
    const db = openDb(path.join(root, `${n++}.db`));
    try {
      const ms = listMigrations();
      migrate(db, ms.filter((m) => m.version <= 7));
      const acc = insertAccount(db, { provider: 'freee', name: '普通預金', kind: 'bank', source: 'csv', now: T0.toISOString() }).id;
      const it = createItem(db, { ...manual, accountId: acc, recurrence: 'quarterly' }, user, T0);
      assert.deepEqual(migrate(db, ms), ['0008_tax.sql']);
      assert.deepEqual(integrityCheck(db), []);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const row = getScheduledItem(db, it.id)!;
      assert.equal(row.estimate_key, null);
      assert.equal(row.pinned, 0);
      assert.equal(row.recurrence, 'quarterly');
      // 不変・削除禁止のトリガーは残る。
      assert.throws(() => db.prepare(`UPDATE scheduled_items SET origin = 'detected' WHERE id = ?`).run(it.id), /不変/);
      assert.throws(() => db.prepare('DELETE FROM scheduled_items WHERE id = ?').run(it.id), /削除できない/);
    } finally {
      db.close();
    }
  });

  test('有効な estimate_key の重複は入らない。停止した行となら同じ key を持てる', () => {
    const db = freshDb();
    try {
      const a = createItem(db, estimateInput('income_tax:2026:final'), user, T0);
      assert.throws(() => createItem(db, estimateInput('income_tax:2026:final'), user, T0), /UNIQUE/);
      deactivateItem(db, a.id, user, T1);
      assert.equal(createItem(db, estimateInput('income_tax:2026:final'), user, T1).estimate_key, 'income_tax:2026:final');
      assert.throws(() => db.prepare('UPDATE scheduled_items SET active = 1 WHERE id = ?').run(a.id), /UNIQUE/);
    } finally {
      db.close();
    }
  });

  test('estimate_key・pinned は見積もりの項目だけ。estimate_key は不変', () => {
    const db = freshDb();
    try {
      const m = createItem(db, manual, user, T0);
      assert.throws(() => db.prepare('UPDATE scheduled_items SET pinned = 1 WHERE id = ?').run(m.id), /CHECK/);
      assert.throws(() => createItem(db, { ...manual, estimateKey: 'x' }, user, T0), (e: unknown) => e instanceof ScheduleError && e.code === 'invalid_estimate_key');
      const e = createItem(db, estimateInput('k'), user, T0);
      assert.throws(() => db.prepare(`UPDATE scheduled_items SET estimate_key = 'k2' WHERE id = ?`).run(e.id), /不変/);
      db.prepare('UPDATE scheduled_items SET pinned = 1 WHERE id = ?').run(e.id);
    } finally {
      db.close();
    }
  });

  test('tax_estimate_runs は追記専用。tax_profile は 1 行だけ', () => {
    const db = freshDb();
    try {
      insertTaxEstimateRun(db, { id: 'R1', actor: 'user', inputs: {}, results: {}, created: 0, updated: 0, deactivated: 0, skippedPinned: 0, warnings: [], now: T0.toISOString() });
      assert.throws(() => db.prepare(`UPDATE tax_estimate_runs SET actor = 'x'`).run(), /追記専用/);
      assert.throws(() => db.prepare('DELETE FROM tax_estimate_runs').run(), /追記専用/);
      assert.throws(() => db.prepare(`INSERT INTO tax_profile (id, blue_return, consumption_mode, revenue_includes_tax, resident_pay_mode, nhi_members, nhi_members_40_64, nhi_installments, nhi_first_month, pension_mode, pension_addon, dependents, spouse, other_deductions, updated_at)
        VALUES ('other', '65', 'unset', 1, 'ordinary4', 1, 0, 8, 7, 'monthly', 0, 0, 0, 0, 'x')`).run(), /CHECK/);
    } finally {
      db.close();
    }
  });
});

describe('pinned の自動付与（schedule.ts）', () => {
  test('system 以外が name・amount・anchor_date を変えると pinned = 1。system なら付かない。他の列でも付かない', () => {
    const db = freshDb();
    try {
      const e = createItem(db, estimateInput('k'), user, T0);
      assert.equal(updateItem(db, e.id, { amount: 2000 }, { actor: 'system' }, T1).pinned, 0);
      assert.equal(updateItem(db, e.id, { notifyDaysBefore: 7 }, user, T1).pinned, 0);
      const u = updateItem(db, e.id, { amount: 3000 }, user, T1);
      assert.equal(u.pinned, 1);
      const a = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'scheduled_item.updated' ORDER BY seq DESC LIMIT 1`).get() as { payload_json: string };
      assert.deepEqual(JSON.parse(a.payload_json).changes, { amount: { from: 2000, to: 3000 }, pinned: { from: 0, to: 1 } });
      // pinned: false で戻す。
      assert.equal(updateItem(db, e.id, { pinned: false }, user, T2).pinned, 0);
      // 手入力の項目は変えても pinned は付かない。pinned を渡すと 400。
      const m = createItem(db, manual, user, T0);
      assert.equal(updateItem(db, m.id, { amount: 5 }, user, T1).pinned, 0);
      assert.throws(() => updateItem(db, m.id, { pinned: true }, user, T1), (x: unknown) => x instanceof ScheduleError && x.code === 'invalid_pinned');
      assert.throws(() => parseBody({ pinned: 1 }, 'update'), (x: unknown) => x instanceof ScheduleError && x.code === 'invalid_pinned');
      assert.throws(() => parseBody({ pinned: true }, 'create'), (x: unknown) => x instanceof ScheduleError && x.code === 'invalid_field');
    } finally {
      db.close();
    }
  });

  test('system 以外が止めると pinned = 1', () => {
    const db = freshDb();
    try {
      const a = createItem(db, estimateInput('a'), user, T0);
      const b = createItem(db, estimateInput('b'), user, T0);
      assert.equal(deactivateItem(db, a.id, user, T1).pinned, 1);
      assert.equal(deactivateItem(db, b.id, { actor: 'system' }, T1).pinned, 0);
    } finally {
      db.close();
    }
  });
});

// 年金・国保なしで、所得税（予定納税 + 確定）と住民税だけが出る入力。
function setup(db: Db, prof: Record<string, unknown> = {}) {
  const acc = insertAccount(db, { provider: 'freee', name: '普通預金', kind: 'bank', source: 'csv', now: T0.toISOString() }).id;
  const o = { by: user, today: TODAY, now: T0 };
  saveYear(db, 2025, { kind: 'actual', business_income: 3_000_000, income_tax_final: 150_000, prepaid_income_tax: 0, social_insurance_paid: 600_000 }, o);
  saveYear(db, 2026, { kind: 'estimate', business_income: 3_000_000 }, o);
  const r = saveProfile(db, { pension_mode: 'none', nhi_preset: null, payment_account_id: acc, ...prof }, o);
  return { acc, run: r.run };
}

const estimates = (db: Db) => listScheduledItems(db, { includeInactive: true }).filter((i) => i.origin === 'estimate');
const byKey = (db: Db) => new Map(estimates(db).filter((i) => i.active === 1).map((i) => [i.estimate_key!, i]));
const auditsFor = (db: Db, id: string) =>
  (db.prepare(`SELECT actor, action, payload_json FROM audit_log WHERE entity = 'scheduled_item' AND entity_id = ? ORDER BY seq`).all(id) as { actor: string; action: string; payload_json: string }[]).map(
    (a) => ({ actor: a.actor, action: a.action, payload: JSON.parse(a.payload_json) as Record<string, unknown> }),
  );

describe('再計算と台帳の同期（§14.2 の表）', () => {
  test('key が無い → 作る（origin=estimate・once・account_id = 納税口座・通知 30 日前）。監査は actor=system・run_id', () => {
    const db = freshDb();
    try {
      const { acc, run } = setup(db);
      const k = byKey(db);
      assert.deepEqual([...k.keys()].sort(), [
        // 2026 年分の申告納税額は 15 万未満なので 2027 年分以降の予定納税は無い。
        'income_tax:2025:final', 'income_tax:2026:final', 'income_tax:2026:prepay1', 'income_tax:2026:prepay2', 'income_tax:2027:final', 'income_tax:2028:final',
        'resident:2025:q4', 'resident:2026:q1', 'resident:2026:q2', 'resident:2026:q3', 'resident:2026:q4', 'resident:2027:q1', 'resident:2027:q2', 'resident:2027:q3', 'resident:2027:q4',
        'resident:2028:q1', 'resident:2028:q2', 'resident:2028:q3', 'resident:2028:q4', 'resident:2029:q1', 'resident:2029:q2', 'resident:2029:q3', 'resident:2029:q4',
      ].sort());
      const p1 = k.get('income_tax:2026:prepay1')!;
      assert.deepEqual(
        { name: p1.name, amount: p1.amount, anchor: p1.anchor_date, origin: p1.origin, recurrence: p1.recurrence, account: p1.account_id, notify: p1.notify_days_before, pinned: p1.pinned, direction: p1.direction, category: p1.category },
        { name: '所得税 2026 年分 予定納税 第 1 期（見積）', amount: 50_000, anchor: '2026-07-31', origin: 'estimate', recurrence: 'once', account: acc, notify: 30, pinned: 0, direction: 'out', category: 'tax' },
      );
      const a = auditsFor(db, p1.id);
      assert.equal(a.length, 1);
      assert.equal(a[0].actor, 'system');
      assert.equal(a[0].action, 'scheduled_item.created');
      assert.equal(a[0].payload.run_id, run.run_id);
      assert.equal(a[0].payload.estimate_key, 'income_tax:2026:prepay1');
      assert.equal(run.created, k.size);
      assert.deepEqual([run.updated, run.deactivated, run.skipped_pinned], [0, 0, []]);
      // 期間は今年の 1/1 〜 今日 + 39 か月。
      assert.deepEqual(estimateWindow(TODAY), { from: '2026-01-01', to: '2030-02-07' });
      assert.ok(verifyAudit(db).ok);
    } finally {
      db.close();
    }
  });

  test('key があり額・期日が同じ → 何もしない（監査も書かない）', () => {
    const db = freshDb();
    try {
      setup(db);
      const before = db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number };
      const r = recalculate(db, { today: TODAY, now: T1, actor: 'user' });
      assert.deepEqual([r.created, r.updated, r.deactivated], [0, 0, 0]);
      assert.equal((db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n, before.n);
      assert.equal((db.prepare('SELECT count(*) n FROM tax_estimate_runs').get() as { n: number }).n, 4);
    } finally {
      db.close();
    }
  });

  test('差がある・pinned=0 → その行を書き換える（id は同じ）。監査 reason=tax_recalc', () => {
    const db = freshDb();
    try {
      setup(db);
      const id = byKey(db).get('income_tax:2026:prepay1')!.id;
      const { run } = saveYear(db, 2025, { income_tax_final: 300_000 }, { by: user, today: TODAY, now: T1 });
      const after = byKey(db).get('income_tax:2026:prepay1')!;
      assert.equal(after.id, id);
      assert.equal(after.amount, 100_000);
      assert.ok(run.updated >= 2);
      assert.equal(run.created, 0);
      const a = auditsFor(db, id).at(-1)!;
      assert.equal(a.actor, 'system');
      assert.equal(a.action, 'scheduled_item.updated');
      assert.equal(a.payload.reason, 'tax_recalc');
      assert.equal(a.payload.run_id, run.run_id);
      assert.deepEqual(a.payload.changes, { amount: { from: 50_000, to: 100_000 } });
    } finally {
      db.close();
    }
  });

  test('pinned=1 → 触らない。skipped_pinned に計算値と現在値', () => {
    const db = freshDb();
    try {
      setup(db);
      const it = byKey(db).get('income_tax:2026:prepay1')!;
      updateItem(db, it.id, { amount: 55_000 }, user, T1);
      const { run } = saveYear(db, 2025, { income_tax_final: 300_000 }, { by: user, today: TODAY, now: T2 });
      assert.equal(getScheduledItem(db, it.id)!.amount, 55_000);
      assert.deepEqual(run.skipped_pinned, [{ key: 'income_tax:2026:prepay1', item_id: it.id, computed: { amount: 100_000, due: '2026-07-31' }, current: { amount: 55_000, due: '2026-07-31', active: 1 } }]);
      assert.equal(byKey(db).get('income_tax:2026:prepay2')!.amount, 100_000);
    } finally {
      db.close();
    }
  });

  test('出なくなった key・pinned=0 → 止める（reason=estimate_withdrawn）。pinned=1 → 触らず警告', () => {
    const db = freshDb();
    try {
      setup(db);
      const p1 = byKey(db).get('income_tax:2026:prepay1')!;
      const p2 = byKey(db).get('income_tax:2026:prepay2')!;
      updateItem(db, p2.id, { name: '予定納税 2 期（手直し）' }, user, T1);
      // 前年の申告納税額が閾値未満 → 2026 年分の予定納税が出なくなる。
      const { run } = saveYear(db, 2025, { income_tax_final: 149_900 }, { by: user, today: TODAY, now: T2 });
      assert.equal(getScheduledItem(db, p1.id)!.active, 0);
      assert.equal(getScheduledItem(db, p2.id)!.active, 1);
      assert.equal(run.deactivated, 1);
      assert.deepEqual(run.warnings.filter((w) => w.kind === 'pinned_withdrawn'), [{ kind: 'pinned_withdrawn', key: 'income_tax:2026:prepay2', item_id: p2.id }]);
      const a = auditsFor(db, p1.id).at(-1)!;
      assert.deepEqual([a.actor, a.action, a.payload.reason, a.payload.run_id], ['system', 'scheduled_item.deactivated', 'estimate_withdrawn', run.run_id]);
      assert.equal(getScheduledItem(db, p1.id)!.pinned, 0);
      // 閾値に戻ると、止めた行とは別に作り直す。
      const back = saveYear(db, 2025, { income_tax_final: 150_000 }, { by: user, today: TODAY, now: new Date('2026-11-10T00:00:00Z') });
      assert.equal(back.run.created, 1);
      assert.notEqual(byKey(db).get('income_tax:2026:prepay1')!.id, p1.id);
    } finally {
      db.close();
    }
  });

  test('人が止めた見積もりは pinned になり、再計算で作り直さない', () => {
    const db = freshDb();
    try {
      setup(db);
      const it = byKey(db).get('resident:2027:q1')!;
      deactivateItem(db, it.id, user, T1);
      const r = recalculate(db, { today: TODAY, now: T2, actor: 'user' });
      assert.equal(r.created, 0);
      assert.equal(byKey(db).has('resident:2027:q1'), false);
      assert.deepEqual(r.skipped_pinned.map((s) => [s.key, s.current.active]), [['resident:2027:q1', 0]]);
    } finally {
      db.close();
    }
  });

  test('PATCH pinned: false → 次の再計算で上書きに戻る', () => {
    const db = freshDb();
    try {
      setup(db);
      const it = byKey(db).get('income_tax:2026:prepay1')!;
      updateItem(db, it.id, { amount: 55_000 }, user, T1);
      updateItem(db, it.id, { pinned: false }, user, T1);
      const r = recalculate(db, { today: TODAY, now: T2, actor: 'user' });
      assert.equal(getScheduledItem(db, it.id)!.amount, 50_000);
      assert.equal(r.updated, 1);
    } finally {
      db.close();
    }
  });

  test('同じ category で ±45 日・±10% の manual / detected があれば possible_duplicate（消さない）', () => {
    const db = freshDb();
    try {
      const pre = createItem(db, { ...manual, name: '予定納税', amount: 52_000, anchorDate: '2026-08-20' }, user, T0); // 7/31 から 20 日、+4%
      createItem(db, { ...manual, name: '遠い', amount: 50_000, anchorDate: '2026-09-30' }, user, T0); // 61 日
      createItem(db, { ...manual, name: '高い', amount: 56_000, anchorDate: '2026-07-31' }, user, T0); // +12%
      createItem(db, { ...manual, name: '別の区分', amount: 50_000, anchorDate: '2026-07-31', category: 'other' }, user, T0);
      const { run } = setup(db);
      const est = byKey(db).get('income_tax:2026:prepay1')!;
      const dups = run.warnings.filter((w) => w.kind === 'possible_duplicate');
      assert.deepEqual(dups.filter((w) => w.key === 'income_tax:2026:prepay1'), [{ kind: 'possible_duplicate', key: 'income_tax:2026:prepay1', item_ids: [est.id, pre.id] }]);
      assert.equal(getScheduledItem(db, pre.id)!.active, 1);
    } finally {
      db.close();
    }
  });

  test('プロファイルが無ければ何も作らず tax_profile_missing。run は残す', () => {
    const db = freshDb();
    try {
      const r = recalculate(db, { today: TODAY, now: T0, actor: 'user' });
      assert.deepEqual([r.created, r.warnings], [0, [{ kind: 'tax_profile_missing' }]]);
      assert.equal(estimates(db).length, 0);
      assert.equal((db.prepare('SELECT count(*) n FROM tax_estimate_runs').get() as { n: number }).n, 1);
    } finally {
      db.close();
    }
  });

  test('過去の期間（今年の 1/1 より前）の項目は出なくなっても止めない', () => {
    const db = freshDb();
    try {
      setup(db);
      const old = byKey(db).get('resident:2025:q4')!; // 2026-02-02
      const r = recalculate(db, { today: '2027-03-01', now: T1, actor: 'user' });
      assert.equal(getScheduledItem(db, old.id)!.active, 1);
      assert.equal(r.deactivated, 0);
    } finally {
      db.close();
    }
  });
});

describe('入力の保存', () => {
  test('プロファイル: 既定値に重ねて保存し、変わった列を tax_profile.updated に残す。知らないキー・不正な値は 400', () => {
    const db = freshDb();
    try {
      const o = { by: user, today: TODAY, now: T0 };
      const { profile } = saveProfile(db, { spouse: true }, o);
      assert.equal(profile.spouse, 1);
      assert.equal(profile.nhi_preset, DEFAULT_PROFILE.nhi_preset);
      saveProfile(db, { nhi_members_40_64: 1 }, o);
      const a = db.prepare(`SELECT actor, entity_id, payload_json FROM audit_log WHERE action = 'tax_profile.updated' ORDER BY seq`).all() as { actor: string; entity_id: string; payload_json: string }[];
      assert.equal(a.length, 2);
      assert.deepEqual(JSON.parse(a[1].payload_json), { changes: { nhi_members_40_64: { from: 0, to: 1 } }, user: 'me@example.com' });
      for (const [body, code] of [
        [{ nope: 1 }, 'invalid_field'],
        [{ blue_return: '30' }, 'invalid_blue_return'],
        [{ spouse: 1 }, 'invalid_spouse'],
        [{ nhi_preset: 'tokyo' }, 'invalid_nhi_preset'],
        [{ nhi_members: 1, nhi_members_40_64: 2 }, 'invalid_nhi_members_40_64'],
        [{ biz_tax_rate: 5 }, 'invalid_biz_tax_rate'],
        [{ nhi_rates_json: { medical: { rate: 2 } } }, 'invalid_nhi_rates_json'],
        [{ payment_account_id: 'NOPE' }, 'unknown_account'],
      ] as [Record<string, unknown>, string][]) {
        assert.throws(() => saveProfile(db, body, o), (e: unknown) => e instanceof TaxError && e.code === code, JSON.stringify(body));
      }
      assert.equal((db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'tax_profile.updated'`).get() as { n: number }).n, 2);
    } finally {
      db.close();
    }
  });

  test('年: 新しい年は kind が要る。変わった列を tax_year.updated に残す', () => {
    const db = freshDb();
    try {
      const o = { by: user, today: TODAY, now: T0 };
      assert.throws(() => saveYear(db, 2026, { revenue: 1 }, o), (e: unknown) => e instanceof TaxError && e.code === 'missing_kind');
      saveYear(db, 2026, { kind: 'estimate', revenue: 5_000_000, expenses: 1_000_000 }, o);
      saveYear(db, 2026, { expenses: 1_200_000 }, o);
      assert.deepEqual(listTaxYears(db).map((y) => [y.year, y.kind, y.revenue, y.expenses, y.source]), [[2026, 'estimate', 5_000_000, 1_200_000, 'manual']]);
      const a = db.prepare(`SELECT entity_id, payload_json FROM audit_log WHERE action = 'tax_year.updated' ORDER BY seq`).all() as { entity_id: string; payload_json: string }[];
      assert.equal(a.length, 2);
      assert.equal(a[1].entity_id, '2026');
      assert.deepEqual(JSON.parse(a[1].payload_json).changes, { expenses: { from: 1_000_000, to: 1_200_000 } });
      for (const [body, code] of [[{ source: 'annualized' }, 'invalid_field'], [{ revenue: -1 }, 'invalid_revenue'], [{ kind: 'guess' }, 'invalid_kind'], [{ revenue: 1.5 }, 'invalid_revenue']] as [Record<string, unknown>, string][]) {
        assert.throws(() => saveYear(db, 2026, body, o), (e: unknown) => e instanceof TaxError && e.code === code, JSON.stringify(body));
      }
    } finally {
      db.close();
    }
  });
});
