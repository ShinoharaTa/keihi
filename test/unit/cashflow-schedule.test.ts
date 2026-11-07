// マイグレーション 0006_cashflow・予定の台帳・期日の計算（docs/mvp-plan-v3.md T301）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import { insertAccount } from '../../src/bank/repo.ts';
import {
  getRecurrenceCandidate,
  insertRecurrenceCandidate,
  listRecurrenceCandidates,
  setRecurrenceCandidateState,
  type Recurrence,
} from '../../src/cashflow/repo.ts';
import {
  ScheduleError,
  activateItem,
  createItem,
  deactivateItem,
  getItem,
  listItems,
  nextDue,
  nextDueDates,
  parseBody,
  updateItem,
  upcoming,
  type DueItem,
  type ItemInput,
} from '../../src/cashflow/schedule.ts';
import { integrityCheck, openDb, type Db } from '../../src/db/index.ts';
import { listMigrations, migrate } from '../../src/db/migrate.ts';

const now = '2026-11-06T00:00:00.000Z';
const T0 = new Date(now);
const T1 = new Date('2026-11-07T00:00:00.000Z');
const by = { actor: 'user', user: 'me@example.com' };
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-cashflow-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function freshDb(): Db {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  return db;
}

const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
const audits = (db: Db) => db.prepare(`SELECT action, entity_id, payload_json FROM audit_log WHERE entity = 'scheduled_item' ORDER BY seq`).all() as { action: string; entity_id: string; payload_json: string }[];

const base: ItemInput = {
  name: '自動車税',
  amount: 39500,
  direction: 'out',
  category: 'car',
  accountId: null,
  recurrence: 'yearly',
  anchorDate: '2027-05-31',
  endDate: null,
  notifyDaysBefore: 14,
  origin: 'manual',
};

describe('0006_cashflow のマイグレーション', () => {
  test('空の DB から上がる', () => {
    const db = openDb(path.join(root, `${n++}.db`));
    try {
      assert.ok(migrate(db).includes('0006_cashflow.sql'));
      assert.deepEqual(integrityCheck(db), []);
      assert.equal(count(db, 'scheduled_items'), 0);
      assert.equal(count(db, 'recurrence_candidates'), 0);
    } finally {
      db.close();
    }
  });

  test('0005 まで上げた DB（既存の口座あり）から上がる', () => {
    const db = openDb(path.join(root, `${n++}.db`));
    try {
      const ms = listMigrations();
      const upTo5 = ms.filter((m) => m.version <= 5);
      assert.equal(upTo5.at(-1)!.name, '0005_bank.sql');
      migrate(db, upTo5);
      const acc = insertAccount(db, { provider: 'freee', name: '普通預金', kind: 'bank', source: 'csv', now });
      assert.deepEqual(migrate(db, ms), ms.filter((m) => m.version > 5).map((m) => m.name));
      assert.equal(count(db, 'money_accounts'), 1);
      const it = createItem(db, { ...base, accountId: acc.id }, by, T0);
      assert.equal(it.account_id, acc.id);
      assert.deepEqual(integrityCheck(db), []);
    } finally {
      db.close();
    }
  });
});

describe('0007_recurrence_quarterly のマイグレーション', () => {
  const schema = (db: Db) =>
    (db.prepare(`SELECT type, name, tbl_name FROM sqlite_master WHERE tbl_name IN ('scheduled_items', 'recurrence_candidates') AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name`).all() as { type: string; name: string; tbl_name: string }[]).map((r) => `${r.type}:${r.name}:${r.tbl_name}`);
  const WANT_SCHEMA = [
    'index:recurrence_candidates_account:recurrence_candidates',
    'index:scheduled_items_active:scheduled_items',
    'table:recurrence_candidates:recurrence_candidates',
    'table:scheduled_items:scheduled_items',
    'trigger:recurrence_candidates_immutable:recurrence_candidates',
    'trigger:recurrence_candidates_no_delete:recurrence_candidates',
    'trigger:scheduled_items_immutable:scheduled_items',
    'trigger:scheduled_items_no_delete:scheduled_items',
  ];

  // 0008_tax が scheduled_items に列と索引を足すので、ここでは 0007 まで上げて見る（0008 は cashflow-tax-sync.test.ts）。
  const upTo7 = () => listMigrations().filter((m) => m.version <= 7);

  test('空の DB から上がり、quarterly を入れられる', () => {
    const db = openDb(path.join(root, `${n++}.db`));
    try {
      assert.ok(migrate(db, upTo7()).includes('0007_recurrence_quarterly.sql'));
      assert.deepEqual(integrityCheck(db), []);
      assert.deepEqual(schema(db), WANT_SCHEMA);
      const acc = insertAccount(db, { provider: 'freee', name: '普通預金', kind: 'bank', source: 'csv', now });
      assert.equal(createItem(db, { ...base, recurrence: 'quarterly', accountId: acc.id }, by, T0).recurrence, 'quarterly');
      assert.equal(insertRecurrenceCandidate(db, { accountId: acc.id, descriptionNorm: 'x', amount: 1, interval: 'quarterly', occurrences: [], now }).interval, 'quarterly');
    } finally {
      db.close();
    }
  });

  test('0006 まで上げた DB（行あり）から上がり、行・参照・トリガーが残る', () => {
    const db = openDb(path.join(root, `${n++}.db`));
    try {
      const ms = listMigrations();
      const upTo6 = ms.filter((m) => m.version <= 6);
      assert.equal(upTo6.at(-1)!.name, '0006_cashflow.sql');
      migrate(db, upTo6);
      const acc = insertAccount(db, { provider: 'freee', name: '普通預金', kind: 'bank', source: 'csv', now }).id;
      const item = createItem(db, { ...base, accountId: acc }, by, T0);
      const stopped = deactivateItem(db, createItem(db, { ...base, name: '保険', recurrence: 'monthly' }, by, T0).id, by, T1);
      const open = insertRecurrenceCandidate(db, { accountId: acc, descriptionNorm: 'ﾃﾞﾝｷ', amount: 5000, interval: 'monthly', occurrences: [{ id: 'T1' }], now });
      const acc2 = insertRecurrenceCandidate(db, { accountId: acc, descriptionNorm: 'ｼﾞﾄﾞｳｼｬｾﾞｲ', amount: 39500, interval: 'yearly', occurrences: [], now });
      setRecurrenceCandidateState(db, acc2.id, 'accepted', item.id, now);
      const beforeItems = db.prepare('SELECT * FROM scheduled_items ORDER BY id').all();
      const beforeCands = db.prepare('SELECT * FROM recurrence_candidates ORDER BY id').all();
      assert.throws(() => createItem(db, { ...base, recurrence: 'quarterly' }, by, T0), /CHECK/);

      assert.deepEqual(migrate(db, upTo7()), ['0007_recurrence_quarterly.sql']);
      assert.deepEqual(integrityCheck(db), []);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(schema(db), WANT_SCHEMA);
      assert.equal((db.prepare(`SELECT count(*) n FROM sqlite_master WHERE instr(name, '_old') > 0 OR instr(sql, '_old') > 0`).get() as { n: number }).n, 0);
      assert.deepEqual(db.prepare('SELECT * FROM scheduled_items ORDER BY id').all(), beforeItems);
      assert.deepEqual(db.prepare('SELECT * FROM recurrence_candidates ORDER BY id').all(), beforeCands);
      assert.equal(getItem(db, stopped.id)!.active, 0);
      assert.equal(getRecurrenceCandidate(db, open.id)!.state, 'open');

      // 新しい表でも外部キー・CHECK・トリガーが効く。
      assert.throws(() => db.prepare('UPDATE recurrence_candidates SET scheduled_item_id = ? WHERE id = ?').run('NOPE', acc2.id), /FOREIGN KEY/);
      assert.throws(() => db.prepare(`UPDATE scheduled_items SET account_id = 'NOPE' WHERE id = ?`).run(item.id), /FOREIGN KEY/);
      assert.throws(() => db.prepare('DELETE FROM scheduled_items WHERE id = ?').run(item.id), /削除できない/);
      assert.throws(() => db.prepare('DELETE FROM recurrence_candidates WHERE id = ?').run(open.id), /削除できない/);
      assert.throws(() => db.prepare('UPDATE scheduled_items SET origin = ? WHERE id = ?').run('detected', item.id), /不変/);
      assert.throws(() => db.prepare('UPDATE recurrence_candidates SET amount = 1 WHERE id = ?').run(open.id), /state・scheduled_item_id 以外/);
      assert.throws(() => db.prepare(`UPDATE scheduled_items SET recurrence = 'weekly' WHERE id = ?`).run(item.id), /CHECK/);
      assert.equal(createItem(db, { ...base, recurrence: 'quarterly', accountId: acc }, by, T0).recurrence, 'quarterly');
      assert.equal(verifyAudit(db).ok, true);
    } finally {
      db.close();
    }
  });
});

describe('0006_cashflow の制約', () => {
  let db: Db;
  let acc: string;
  before(() => {
    db = freshDb();
    acc = insertAccount(db, { provider: 'freee', name: '普通預金', kind: 'bank', source: 'csv', now }).id;
  });
  after(() => db.close());

  const ins = (cols: Record<string, unknown>) => {
    const row = { id: `S${n++}`, name: 'x', amount: 1, direction: 'out', category: 'other', recurrence: 'once', anchor_date: '2026-12-01', origin: 'manual', created_at: now, updated_at: now, ...cols };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO scheduled_items (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(Object.values(row) as (string | number | null)[]));
    return row.id;
  };

  test('scheduled_items の既定値', () => {
    const id = ins({});
    const r = db.prepare('SELECT notify_days_before, active FROM scheduled_items WHERE id = ?').get(id) as { notify_days_before: number; active: number };
    assert.deepEqual({ ...r }, { notify_days_before: 14, active: 1 });
  });

  test('scheduled_items の enum と金額を CHECK で縛る', () => {
    for (const bad of [
      { direction: 'both' },
      { category: 'food' },
      { recurrence: 'weekly' },
      { origin: 'agent' },
      { active: 2 },
      { amount: 0 },
      { amount: -1 },
      { amount: 1.5 },
      { notify_days_before: -1 },
      { account_id: 'NOPE' },
    ]) {
      assert.throws(() => ins(bad), /CHECK|FOREIGN KEY/, JSON.stringify(bad));
    }
  });

  test('scheduled_items は削除できず、id・origin・created_at は変えられない', () => {
    const id = ins({});
    assert.throws(() => db.prepare('DELETE FROM scheduled_items WHERE id = ?').run(id), /削除できない/);
    assert.throws(() => db.prepare('UPDATE scheduled_items SET created_at = ? WHERE id = ?').run('x', id), /不変/);
    assert.throws(() => db.prepare('UPDATE scheduled_items SET id = ? WHERE id = ?').run('Z', id), /不変/);
    assert.throws(() => db.prepare('UPDATE scheduled_items SET origin = ? WHERE id = ?').run('detected', id), /不変/);
    db.prepare('UPDATE scheduled_items SET name = ?, amount = ? WHERE id = ?').run('y', 2, id);
  });

  test('recurrence_candidates は state・scheduled_item_id・updated_at だけ更新できる', () => {
    const c = insertRecurrenceCandidate(db, { accountId: acc, descriptionNorm: 'ﾃﾞﾝｷ', amount: 5000, interval: 'monthly', occurrences: [{ id: 'T1' }, { id: 'T2' }], now });
    assert.equal(c.state, 'open');
    assert.equal(c.occurrences_json, '[{"id":"T1"},{"id":"T2"}]');
    for (const [col, v] of [
      ['description_norm', 'x'],
      ['amount', 1],
      ['interval', 'yearly'],
      ['occurrences_json', '[]'],
      ['created_at', 'x'],
      ['id', 'Z'],
    ] as [string, string | number][]) {
      assert.throws(() => db.prepare(`UPDATE recurrence_candidates SET ${col} = ? WHERE id = ?`).run(v, c.id), /state・scheduled_item_id 以外/, col);
    }
    const acc2 = insertAccount(db, { provider: 'freee', name: 'カード', kind: 'card', source: 'csv', now }).id;
    assert.throws(() => db.prepare('UPDATE recurrence_candidates SET account_id = ? WHERE id = ?').run(acc2, c.id), /state・scheduled_item_id 以外/);
    assert.throws(() => db.prepare('DELETE FROM recurrence_candidates WHERE id = ?').run(c.id), /削除できない/);

    const item = createItem(db, base, by, T0);
    const s = setRecurrenceCandidateState(db, c.id, 'accepted', item.id, '2026-11-07T00:00:00.000Z')!;
    assert.equal(s.state, 'accepted');
    assert.equal(s.scheduled_item_id, item.id);
    assert.equal(s.updated_at, '2026-11-07T00:00:00.000Z');
    assert.equal(setRecurrenceCandidateState(db, 'NOPE', 'dismissed', null, now), null);
    assert.throws(() => setRecurrenceCandidateState(db, c.id, 'closed' as never, null, now), /CHECK/);
  });

  test('recurrence_candidates は accepted のときだけ scheduled_item_id を持つ', () => {
    const c = insertRecurrenceCandidate(db, { accountId: acc, descriptionNorm: 'ｶﾞｽ', amount: 3000, interval: 'monthly', occurrences: [], now });
    const item = createItem(db, base, by, T0);
    assert.throws(() => setRecurrenceCandidateState(db, c.id, 'accepted', null, now), /CHECK/);
    assert.throws(() => setRecurrenceCandidateState(db, c.id, 'dismissed', item.id, now), /CHECK/);
    assert.throws(() => setRecurrenceCandidateState(db, c.id, 'open', item.id, now), /CHECK/);
    assert.throws(
      () => db.prepare(`INSERT INTO recurrence_candidates (id, account_id, description_norm, amount, interval, occurrences_json, state, created_at, updated_at) VALUES ('R8', ?, 'x', 1, 'yearly', '[]', 'accepted', ?, ?)`).run(acc, now, now),
      /CHECK/,
    );
    assert.equal(getRecurrenceCandidate(db, c.id)!.state, 'open');
  });

  test('recurrence_candidates の CHECK と一覧', () => {
    assert.throws(() => insertRecurrenceCandidate(db, { accountId: acc, descriptionNorm: 'x', amount: 1, interval: 'once' as never, occurrences: [], now }), /CHECK/);
    assert.throws(() => insertRecurrenceCandidate(db, { accountId: acc, descriptionNorm: 'x', amount: 0, interval: 'yearly', occurrences: [], now }), /CHECK/);
    assert.throws(
      () => db.prepare(`INSERT INTO recurrence_candidates (id, account_id, description_norm, amount, interval, occurrences_json, created_at, updated_at) VALUES ('R9', ?, 'x', 1, 'yearly', '{}', ?, ?)`).run(acc, now, now),
      /CHECK/,
    );
    const a = insertRecurrenceCandidate(db, { accountId: acc, descriptionNorm: 'ﾎｹﾝ', amount: 12000, interval: 'yearly', occurrences: [], now });
    setRecurrenceCandidateState(db, a.id, 'dismissed', null, now);
    assert.ok(listRecurrenceCandidates(db, { state: 'dismissed' }).some((r) => r.id === a.id));
    assert.ok(!listRecurrenceCandidates(db, { state: 'open' }).some((r) => r.id === a.id));
    assert.ok(listRecurrenceCandidates(db, { accountId: acc }).length >= 1);
    assert.equal(getRecurrenceCandidate(db, a.id)!.state, 'dismissed');
  });
});

describe('次の期日（表駆動）', () => {
  const item = (recurrence: Recurrence, anchor: string, o: Partial<DueItem> = {}): DueItem => ({ recurrence, anchor_date: anchor, end_date: null, active: 1, ...o });
  const cases: { name: string; item: DueItem; from: string; to: string; want: string[] }[] = [
    { name: 'monthly 31 日起点は 30 日の月が月末、2 月は 28 日', item: item('monthly', '2027-01-31'), from: '2027-01-01', to: '2027-05-31', want: ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31'] },
    { name: 'monthly 31 日起点、閏年の 2 月は 29 日', item: item('monthly', '2027-12-31'), from: '2028-01-01', to: '2028-03-31', want: ['2028-01-31', '2028-02-29', '2028-03-31'] },
    { name: 'monthly 30 日起点', item: item('monthly', '2026-11-30'), from: '2026-11-01', to: '2027-03-31', want: ['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28', '2027-03-30'] },
    { name: 'monthly、from が起点より後（途中から）', item: item('monthly', '2020-01-15'), from: '2026-11-16', to: '2027-01-15', want: ['2026-12-15', '2027-01-15'] },
    { name: 'monthly、起点より前の期間は出ない', item: item('monthly', '2027-01-10'), from: '2026-11-01', to: '2026-12-31', want: [] },
    { name: 'bimonthly 31 日起点', item: item('bimonthly', '2026-12-31'), from: '2026-12-01', to: '2027-08-31', want: ['2026-12-31', '2027-02-28', '2027-04-30', '2027-06-30', '2027-08-31'] },
    { name: 'bimonthly、from と to の両端を含む', item: item('bimonthly', '2026-01-10'), from: '2026-03-10', to: '2026-07-10', want: ['2026-03-10', '2026-05-10', '2026-07-10'] },
    { name: 'quarterly 31 日起点', item: item('quarterly', '2026-12-31'), from: '2026-12-01', to: '2027-12-31', want: ['2026-12-31', '2027-03-31', '2027-06-30', '2027-09-30', '2027-12-31'] },
    { name: 'quarterly 11/30 起点は 2 月が月末', item: item('quarterly', '2026-11-30'), from: '2026-11-01', to: '2027-05-31', want: ['2026-11-30', '2027-02-28', '2027-05-30'] },
    { name: 'yearly 2/29 起点は平年 2/28、閏年 2/29', item: item('yearly', '2024-02-29'), from: '2024-01-01', to: '2029-12-31', want: ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29', '2029-02-28'] },
    { name: 'yearly 5/31', item: item('yearly', '2026-05-31'), from: '2026-11-06', to: '2028-11-06', want: ['2027-05-31', '2028-05-31'] },
    { name: 'biennial', item: item('biennial', '2025-03-15'), from: '2025-01-01', to: '2031-12-31', want: ['2025-03-15', '2027-03-15', '2029-03-15', '2031-03-15'] },
    { name: 'biennial 2/29 起点', item: item('biennial', '2024-02-29'), from: '2024-01-01', to: '2028-12-31', want: ['2024-02-29', '2026-02-28', '2028-02-29'] },
    { name: 'once は anchor_date 1 回だけ', item: item('once', '2027-03-15'), from: '2026-01-01', to: '2030-12-31', want: ['2027-03-15'] },
    { name: 'once、期間の外', item: item('once', '2027-03-15'), from: '2027-03-16', to: '2030-12-31', want: [] },
    { name: 'end_date で止まる（当日は含む）', item: item('monthly', '2026-11-25', { end_date: '2027-02-25' }), from: '2026-11-01', to: '2027-12-31', want: ['2026-11-25', '2026-12-25', '2027-01-25', '2027-02-25'] },
    { name: 'end_date で止まる（月末寄せの回の手前）', item: item('monthly', '2027-01-31', { end_date: '2027-04-29' }), from: '2027-01-01', to: '2027-12-31', want: ['2027-01-31', '2027-02-28', '2027-03-31'] },
    { name: 'yearly の end_date', item: item('yearly', '2026-06-30', { end_date: '2028-06-29' }), from: '2026-01-01', to: '2035-12-31', want: ['2026-06-30', '2027-06-30'] },
    { name: 'active=0 は出ない', item: item('monthly', '2026-11-01', { active: 0 }), from: '2026-11-01', to: '2027-12-31', want: [] },
    { name: 'active=0 の once も出ない', item: item('once', '2026-12-01', { active: 0 }), from: '2026-11-01', to: '2027-12-31', want: [] },
  ];
  for (const c of cases) {
    test(`nextDueDates: ${c.name}`, () => {
      assert.deepEqual(nextDueDates(c.item, c.from, c.to), c.want);
    });
  }

  const next: { name: string; item: DueItem; today: string; want: string | null }[] = [
    { name: 'monthly 31 日起点、4 月は 30 日', item: item('monthly', '2027-01-31'), today: '2027-04-01', want: '2027-04-30' },
    { name: 'monthly、当日は当日', item: item('monthly', '2027-01-31'), today: '2027-03-31', want: '2027-03-31' },
    { name: 'monthly、翌日は次の月', item: item('monthly', '2027-01-31'), today: '2027-05-01', want: '2027-05-31' },
    { name: 'monthly、起点より前なら起点', item: item('monthly', '2027-01-31'), today: '2026-11-06', want: '2027-01-31' },
    { name: 'monthly、長く前の起点', item: item('monthly', '2010-08-31'), today: '2026-11-06', want: '2026-11-30' },
    { name: 'bimonthly', item: item('bimonthly', '2026-01-31'), today: '2026-11-06', want: '2026-11-30' },
    { name: 'bimonthly、偶数月だけ', item: item('bimonthly', '2026-02-10'), today: '2026-11-11', want: '2026-12-10' },
    { name: 'quarterly', item: item('quarterly', '2026-01-25'), today: '2026-11-06', want: '2027-01-25' },
    { name: 'quarterly、当日は当日', item: item('quarterly', '2026-01-25'), today: '2026-10-25', want: '2026-10-25' },
    { name: 'yearly 2/29 起点の平年', item: item('yearly', '2024-02-29'), today: '2026-11-06', want: '2027-02-28' },
    { name: 'yearly 2/29 起点の閏年', item: item('yearly', '2024-02-29'), today: '2027-03-01', want: '2028-02-29' },
    { name: 'biennial', item: item('biennial', '2025-03-15'), today: '2026-11-06', want: '2027-03-15' },
    { name: 'once、前', item: item('once', '2027-03-15'), today: '2026-11-06', want: '2027-03-15' },
    { name: 'once、過ぎた', item: item('once', '2026-03-15'), today: '2026-11-06', want: null },
    { name: 'end_date を超えたら null', item: item('monthly', '2026-01-10', { end_date: '2026-11-09' }), today: '2026-11-06', want: null },
    { name: 'end_date の当日まで', item: item('monthly', '2026-01-10', { end_date: '2026-12-10' }), today: '2026-11-11', want: '2026-12-10' },
    { name: 'once の end_date が起点より前（手で入れた行）', item: item('once', '2027-03-15', { end_date: '2027-03-14' }), today: '2026-11-06', want: null },
    { name: 'active=0 は null', item: item('yearly', '2026-12-01', { active: 0 }), today: '2026-11-06', want: null },
  ];
  for (const c of next) {
    test(`nextDue: ${c.name}`, () => {
      assert.equal(nextDue(c.item, c.today), c.want);
    });
  }
});

describe('台帳の作成・更新・停止', () => {
  let db: Db;
  let acc: string;
  before(() => {
    db = freshDb();
    acc = insertAccount(db, { provider: 'freee', name: '普通預金', kind: 'bank', source: 'csv', now }).id;
  });
  after(() => db.close());

  test('作成は監査ログに残す', () => {
    const it = createItem(db, { ...base, accountId: acc }, by, T0);
    assert.equal(it.active, 1);
    assert.equal(it.created_at, now);
    assert.equal(getItem(db, it.id)!.name, '自動車税');
    const a = audits(db).filter((x) => x.entity_id === it.id);
    assert.equal(a.length, 1);
    assert.equal(a[0].action, 'scheduled_item.created');
    const p = JSON.parse(a[0].payload_json);
    assert.equal(p.amount, 39500);
    assert.equal(p.user, 'me@example.com');
    assert.ok(verifyAudit(db).ok);
  });

  test('作成の検査', () => {
    const bad: [Partial<ItemInput>, string][] = [
      [{ name: '  ' }, 'invalid_name'],
      [{ amount: 0 }, 'invalid_amount'],
      [{ amount: 1.5 }, 'invalid_amount'],
      [{ direction: 'x' as never }, 'invalid_direction'],
      [{ category: 'food' as never }, 'invalid_category'],
      [{ recurrence: 'weekly' as never }, 'invalid_recurrence'],
      [{ anchorDate: '2027-02-30' }, 'invalid_anchor_date'],
      [{ anchorDate: '2027/02/01' }, 'invalid_anchor_date'],
      [{ endDate: '2027-13-01' }, 'invalid_end_date'],
      [{ endDate: '2027-05-30' }, 'end_before_anchor'],
      [{ notifyDaysBefore: -1 }, 'invalid_notify_days_before'],
      [{ notifyDaysBefore: 366 }, 'invalid_notify_days_before'],
      [{ name: 'あ'.repeat(201) }, 'invalid_name'],
      [{ category: 'income' }, 'invalid_category_for_direction'],
      [{ origin: 'agent' as never }, 'invalid_origin'],
      [{ accountId: 'NOPE' }, 'unknown_account'],
    ];
    const before = count(db, 'scheduled_items');
    for (const [patch, code] of bad) {
      assert.throws(() => createItem(db, { ...base, ...patch }, by, T0), (e: unknown) => e instanceof ScheduleError && e.code === code, code);
    }
    assert.equal(count(db, 'scheduled_items'), before);
  });

  test('更新は変わった列の前後を監査ログに残す。変わらなければ書かない', () => {
    const it = createItem(db, base, by, T0);
    const u = updateItem(db, it.id, { amount: 40000, endDate: '2030-05-31', name: '自動車税' }, by, T1);
    assert.equal(u.amount, 40000);
    assert.equal(u.end_date, '2030-05-31');
    assert.equal(u.updated_at, T1.toISOString());
    assert.equal(u.created_at, now);
    let a = audits(db).filter((x) => x.entity_id === it.id);
    assert.deepEqual(a.map((x) => x.action), ['scheduled_item.created', 'scheduled_item.updated']);
    assert.deepEqual(JSON.parse(a[1].payload_json).changes, { amount: { from: 39500, to: 40000 }, end_date: { from: null, to: '2030-05-31' } });

    updateItem(db, it.id, { amount: 40000 }, by, T1);
    a = audits(db).filter((x) => x.entity_id === it.id);
    assert.equal(a.length, 2);

    updateItem(db, it.id, { endDate: null, accountId: acc }, by, T1);
    assert.equal(getItem(db, it.id)!.end_date, null);
    assert.equal(getItem(db, it.id)!.account_id, acc);
    assert.ok(verifyAudit(db).ok);
  });

  test('name は前後の空白を落として 200 文字まで、notify_days_before は 365 まで', () => {
    const it = createItem(db, { ...base, name: `  ${'あ'.repeat(200)}  `, notifyDaysBefore: 365 }, by, T0);
    assert.equal(it.name, 'あ'.repeat(200));
    assert.equal(it.notify_days_before, 365);
    assert.equal(updateItem(db, it.id, { name: ' 車検 ' }, by, T1).name, '車検');
    assert.equal(createItem(db, { ...base, direction: 'in', category: 'income' }, by, T0).category, 'income');
  });

  test('更新の検査', () => {
    const it = createItem(db, base, by, T0);
    assert.throws(() => updateItem(db, it.id, { category: 'income' }, by, T1), (e: unknown) => e instanceof ScheduleError && e.code === 'invalid_category_for_direction');
    const inc = createItem(db, { ...base, direction: 'in', category: 'income' }, by, T0);
    assert.throws(() => updateItem(db, inc.id, { direction: 'out' }, by, T1), (e: unknown) => e instanceof ScheduleError && e.code === 'invalid_category_for_direction');
    assert.equal(updateItem(db, inc.id, { direction: 'out', category: 'other' }, by, T1).direction, 'out');
    assert.throws(() => updateItem(db, it.id, { endDate: '2027-01-01' }, by, T1), (e: unknown) => e instanceof ScheduleError && e.code === 'end_before_anchor');
    assert.throws(() => updateItem(db, it.id, { amount: -5 }, by, T1), (e: unknown) => e instanceof ScheduleError && e.code === 'invalid_amount');
    assert.throws(() => updateItem(db, it.id, { origin: 'detected' }, by, T1), (e: unknown) => e instanceof ScheduleError && e.code === 'invalid_field');
    assert.throws(() => updateItem(db, 'NOPE', { amount: 1 }, by, T1), (e: unknown) => e instanceof ScheduleError && e.code === 'not_found' && e.status === 404);
    assert.equal(getItem(db, it.id)!.amount, 39500);
  });

  test('停止は active=0（削除しない）。一覧は既定で active だけ', () => {
    const it = createItem(db, { ...base, name: '保険' }, by, T0);
    const d = deactivateItem(db, it.id, by, T1);
    assert.equal(d.active, 0);
    assert.equal(deactivateItem(db, it.id, by, T1).active, 0);
    const a = audits(db).filter((x) => x.entity_id === it.id);
    assert.deepEqual(a.map((x) => x.action), ['scheduled_item.created', 'scheduled_item.deactivated']);
    assert.ok(!listItems(db).some((r) => r.id === it.id));
    assert.ok(listItems(db, { includeInactive: true }).some((r) => r.id === it.id));
    assert.throws(() => deactivateItem(db, 'NOPE', by, T1), (e: unknown) => e instanceof ScheduleError && e.status === 404);
  });

  test('再開は active=1 に戻し、冪等', () => {
    const it = createItem(db, { ...base, name: '再開' }, by, T0);
    assert.equal(activateItem(db, it.id, by, T1).active, 1);
    deactivateItem(db, it.id, by, T1);
    assert.equal(activateItem(db, it.id, by, T1).active, 1);
    assert.equal(activateItem(db, it.id, by, T1).active, 1);
    const a = audits(db).filter((x) => x.entity_id === it.id);
    assert.deepEqual(a.map((x) => x.action), ['scheduled_item.created', 'scheduled_item.deactivated', 'scheduled_item.reactivated']);
    assert.ok(listItems(db).some((r) => r.id === it.id));
    assert.throws(() => activateItem(db, 'NOPE', by, T1), (e: unknown) => e instanceof ScheduleError && e.status === 404);
    assert.ok(verifyAudit(db).ok);
  });

  test('parseBody', () => {
    assert.deepEqual(parseBody({ name: 'x', amount: 1, direction: 'in', category: 'income', recurrence: 'monthly', anchor_date: '2026-11-25' }, 'create'), {
      name: 'x', amount: 1, direction: 'in', category: 'income', recurrence: 'monthly', anchorDate: '2026-11-25', accountId: null, endDate: null, notifyDaysBefore: 14, origin: 'manual',
    });
    assert.throws(() => parseBody({ name: 'x' }, 'create'), (e: unknown) => e instanceof ScheduleError && e.code === 'missing_amount');
    assert.throws(() => parseBody({ active: 1 }, 'update'), (e: unknown) => e instanceof ScheduleError && e.code === 'invalid_field');
    assert.throws(() => parseBody({ origin: 'manual' }, 'update'), (e: unknown) => e instanceof ScheduleError && e.code === 'invalid_field');
    assert.deepEqual(parseBody({ end_date: null }, 'update'), { endDate: null });
    for (const body of [{ toString: 1 }, JSON.parse('{"__proto__":1}'), { hasOwnProperty: 1 }]) {
      for (const mode of ['create', 'update'] as const) {
        assert.throws(() => parseBody(body, mode), (e: unknown) => e instanceof ScheduleError && e.code === 'invalid_field', `${JSON.stringify(body)} ${mode}`);
      }
    }
  });

  test('upcoming は期日順に、active だけ', () => {
    const db2 = freshDb();
    try {
      const a = createItem(db2, { ...base, name: 'A', recurrence: 'monthly', anchorDate: '2026-10-31' }, by, T0);
      const b = createItem(db2, { ...base, name: 'B', recurrence: 'once', anchorDate: '2026-11-10' }, by, T0);
      const c = createItem(db2, { ...base, name: 'C', recurrence: 'yearly', anchorDate: '2025-11-30' }, by, T1);
      const d = createItem(db2, { ...base, name: 'D', recurrence: 'monthly', anchorDate: '2026-11-07' }, by, T0);
      deactivateItem(db2, d.id, by, T0);
      const r = upcoming(db2, '2026-11-06', 30);
      assert.equal(r.from, '2026-11-06');
      assert.equal(r.to, '2026-12-06');
      assert.deepEqual(r.items.map((x) => [x.name, x.due_date]), [['B', '2026-11-10'], ['A', '2026-11-30'], ['C', '2026-11-30']]);
      assert.equal(r.items[1].id, a.id);
      assert.equal(r.items[0].id, b.id);
      assert.equal(r.items[2].id, c.id);
    } finally {
      db2.close();
    }
  });
});
