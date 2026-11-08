// 大きな出費（docs/cashflow.md §15、src/cashflow/large.ts）。一時ディレクトリの DB だけを使う。摘要・金額は仮のもの。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import { insertAccount, insertBankTxn, updateAccountSettings, type TxnSide } from '../../src/bank/repo.ts';
import { detectTransfers } from '../../src/bank/transfers.ts';
import { addDays } from '../../src/calendar/businessDays.ts';
import { LARGE_LIST_MAX, dismissLargeExpense, listLargeExpenses, scheduleLargeExpense } from '../../src/cashflow/large.ts';
import { getLargeExpenseDecision, insertRecurrenceCandidate, setRecurrenceCandidateState } from '../../src/cashflow/repo.ts';
import { ScheduleError, createItem, deactivateItem, type ItemInput } from '../../src/cashflow/schedule.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';

// 2026-11-06 09:00 JST
const T0 = new Date('2026-11-06T00:00:00.000Z');
const TODAY = '2026-11-06';
const now = T0.toISOString();
const by = { actor: 'user', user: 'me@example.com' };
const opts = { today: TODAY, now: T0 };
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-large-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function fresh(): { db: Db; A: string; B: string } {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  const A = insertAccount(db, { provider: 'fake', name: '銀行A', kind: 'bank', source: 'csv', now }).id;
  const B = insertAccount(db, { provider: 'fake', name: '銀行B', kind: 'bank', source: 'csv', now }).id;
  return { db, A, B };
}

function txn(db: Db, accountId: string, date: string, amount: number, desc: string, side: TxnSide = 'expense'): string {
  return insertBankTxn(db, { accountId, txnDate: date, amount, side, description: `${desc}（原文）`, descriptionNorm: desc, now }).id;
}

const ids = (db: Db, today = TODAY) => listLargeExpenses(db, today).map((x) => x.bank_txn_id);

const item = (over: Partial<ItemInput> = {}): ItemInput => ({
  name: 'テスト納付',
  amount: 100_000,
  direction: 'out',
  category: 'tax',
  accountId: null,
  recurrence: 'yearly',
  anchorDate: '2026-03-15',
  endDate: null,
  notifyDaysBefore: 14,
  origin: 'estimate',
  ...over,
});

const code = (fn: () => unknown): [string, number] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ScheduleError) return [e.code, e.status];
    throw e;
  }
  assert.fail('ScheduleError が出なかった');
};

describe('一覧の対象', () => {
  test('5 万円以上の支出だけ、24 か月前〜今日、新しい順。各項目の列', () => {
    const { db, A } = fresh();
    const big = txn(db, A, '2026-06-10', 50_000, 'テスト保険A');
    txn(db, A, '2026-06-11', 49_999, 'テスト家電');
    txn(db, A, '2026-06-12', 80_000, 'テスト入金', 'income');
    const edge = txn(db, A, '2024-11-06', 60_000, 'テスト旅行');
    txn(db, A, '2024-10-06', 60_000, 'テスト旅行'); // 25 か月前
    txn(db, A, '2026-11-07', 60_000, 'テスト先日付'); // 明日
    const xs = listLargeExpenses(db, TODAY);
    assert.deepEqual(xs.map((x) => x.bank_txn_id), [big, edge]);
    assert.deepEqual(xs[0], {
      bank_txn_id: big,
      account_id: A,
      account_name: '銀行A',
      txn_date: '2026-06-10',
      amount: 50_000,
      description: 'テスト保険A（原文）',
      description_norm: 'テスト保険A',
      same_desc_count: 1,
      suggested: 'yearly',
    });
    db.close();
  });

  test('振替・引き落とし（§4 の除外）は出さない', () => {
    const { db, A, B } = fresh();
    txn(db, A, '2026-06-10', 100_000, 'テスト振込');
    txn(db, B, '2026-06-10', 100_000, 'テスト振込', 'income');
    assert.equal(ids(db).length, 1);
    assert.equal(detectTransfers(db, { windowDays: 3, now: T0 }).length, 1);
    assert.deepEqual(ids(db), []);
    db.close();
  });

  test('active = 0 / include_in_cashflow = 0 の口座は出さない', () => {
    const { db, A, B } = fresh();
    txn(db, A, '2026-06-10', 100_000, 'テスト口座A');
    txn(db, B, '2026-06-10', 100_000, 'テスト口座B');
    assert.equal(ids(db).length, 2);
    updateAccountSettings(db, A, { active: false }, now);
    updateAccountSettings(db, B, { includeInCashflow: false }, now);
    assert.deepEqual(ids(db), []);
    db.close();
  });

  test('open・accepted の候補の明細は出さない（dismissed の候補の明細は出す）', () => {
    const { db, A } = fresh();
    const a = txn(db, A, '2026-06-10', 100_000, 'テスト年払いA');
    const b = txn(db, A, '2026-06-11', 100_000, 'テスト年払いB');
    const c = txn(db, A, '2026-06-12', 100_000, 'テスト年払いC');
    const cand = (id: string, desc: string, date: string) =>
      insertRecurrenceCandidate(db, { accountId: A, descriptionNorm: desc, amount: 100_000, interval: 'yearly', occurrences: [{ date, amount: 100_000, bank_txn_id: id }], now });
    cand(a, 'テスト年払いA', '2026-06-10');
    const cb = cand(b, 'テスト年払いB', '2026-06-11');
    const cc = cand(c, 'テスト年払いC', '2026-06-12');
    const it = createItem(db, item({ name: '別の予定', origin: 'detected', category: 'other', amount: 1000 }), by, T0);
    setRecurrenceCandidateState(db, cb.id, 'accepted', it.id, now);
    setRecurrenceCandidateState(db, cc.id, 'dismissed', null, now, 'human');
    assert.deepEqual(ids(db), [c]);
    db.close();
  });

  test('判断済みは出さない', () => {
    const { db, A } = fresh();
    const a = txn(db, A, '2026-06-10', 100_000, 'テスト家電A');
    const b = txn(db, A, '2026-06-11', 100_000, 'テスト家電B');
    dismissLargeExpense(db, a, by, opts);
    assert.deepEqual(ids(db), [b]);
    scheduleLargeExpense(db, b, { recurrence: 'yearly' }, by, opts);
    assert.deepEqual(ids(db), []);
    db.close();
  });

  test('active な台帳の項目で期日が ±7 日・金額が ±10% のものがあれば出さない（口座は NULL か同じ口座）', () => {
    const { db, A } = fresh();
    createItem(db, item(), by, T0); // 毎年 3/15、10 万円、口座なし
    const in7 = txn(db, A, '2026-03-22', 109_000, 'テスト納付'); // +7 日・+9%
    const before7 = txn(db, A, '2026-03-08', 100_000, 'テスト納付'); // −7 日
    const day8 = txn(db, A, '2026-03-23', 100_000, 'テスト納付'); // +8 日
    const amt11 = txn(db, A, '2026-03-15', 111_000, 'テスト納付'); // +11%
    const low = txn(db, A, '2026-03-16', 91_000, 'テスト納付'); // 100,000 は 91,000 の 109.9%
    const xs = ids(db);
    assert.ok(!xs.includes(in7) && !xs.includes(before7) && !xs.includes(low));
    assert.ok(xs.includes(day8) && xs.includes(amt11));

    // 別の口座の項目は数えない。止めた項目も数えない。
    const { db: db2, A: A2, B: B2 } = fresh();
    createItem(db2, item({ accountId: B2 }), by, T0);
    const off = createItem(db2, item({ anchorDate: '2026-05-15', origin: 'manual' }), by, T0);
    deactivateItem(db2, off.id, by, T0);
    const x = txn(db2, A2, '2026-03-15', 100_000, 'テスト納付');
    const y = txn(db2, A2, '2026-05-15', 100_000, 'テスト納付');
    const z = txn(db2, B2, '2026-03-15', 100_000, 'テスト納付');
    assert.deepEqual(ids(db2), [y, x]);
    assert.ok(!ids(db2).includes(z));
    db.close();
    db2.close();
  });

  test('same_desc_count と suggested（350〜380 日前 → 毎年、715〜745 日前 → 2 年ごと、無ければ毎年）', () => {
    const { db, A, B } = fresh();
    const y1 = txn(db, A, '2025-07-01', 60_000, 'テスト保険B');
    const y2 = txn(db, A, '2026-07-01', 60_000, 'テスト保険B'); // 365 日後
    txn(db, A, '2026-08-01', 3_000, 'テスト保険B'); // 小口も回数に入る
    txn(db, B, '2026-07-01', 60_000, 'テスト保険B'); // 別の口座は数えない
    const b1 = txn(db, A, '2024-11-08', 120_000, 'テスト車検');
    const b2 = txn(db, A, '2026-11-06', 120_000, 'テスト車検'); // 728 日後
    const late = txn(db, A, addDays('2025-01-10', 381), 70_000, 'テスト会費');
    txn(db, A, '2025-01-10', 70_000, 'テスト会費');
    const xs = new Map(listLargeExpenses(db, TODAY).map((x) => [x.bank_txn_id, x]));
    const pick = (id: string) => [xs.get(id)!.same_desc_count, xs.get(id)!.suggested];
    assert.deepEqual(pick(y2), [3, 'yearly']);
    assert.deepEqual(pick(y1), [3, 'yearly']);
    assert.deepEqual(pick(b2), [2, 'biennial']);
    assert.deepEqual(pick(b1), [2, 'yearly']);
    assert.deepEqual(pick(late), [2, 'yearly']);
    db.close();
  });

  test(`上限 ${LARGE_LIST_MAX} 件（新しい順）`, () => {
    const { db, A } = fresh();
    const all = Array.from({ length: LARGE_LIST_MAX + 5 }, (_, i) => txn(db, A, addDays('2026-01-01', i), 50_000 + i, `テスト大口${i}`));
    assert.deepEqual(ids(db), all.reverse().slice(0, LARGE_LIST_MAX));
    db.close();
  });
});

describe('予定にする', () => {
  test('毎年: 既定値（名前は正規化摘要・その他・明細の額・明細日 + 12 か月）。判断と監査', () => {
    const { db, A } = fresh();
    const id = txn(db, A, '2026-06-10', 80_000, 'テスト保険C');
    const r = scheduleLargeExpense(db, id, { recurrence: 'yearly' }, by, opts);
    const it = r.item;
    assert.deepEqual(
      [it.name, it.amount, it.category, it.account_id, it.recurrence, it.anchor_date, it.origin, it.direction, it.amount_kind, it.notify_days_before],
      ['テスト保険C', 80_000, 'other', A, 'yearly', '2027-06-10', 'detected', 'out', 'fixed', 14],
    );
    assert.deepEqual([r.decision.bank_txn_id, r.decision.decision, r.decision.scheduled_item_id, r.decision.created_at], [id, 'scheduled', it.id, now]);
    assert.deepEqual(getLargeExpenseDecision(db, id), r.decision);
    const a = db.prepare("SELECT actor, entity, entity_id, payload_json FROM audit_log WHERE action = 'large_expense.scheduled'").all() as {
      actor: string;
      entity: string;
      entity_id: string;
      payload_json: string;
    }[];
    assert.equal(a.length, 1);
    assert.deepEqual([a[0].actor, a[0].entity, a[0].entity_id], ['user', 'large_expense', id]);
    assert.deepEqual(JSON.parse(a[0].payload_json), { scheduled_item_id: it.id, recurrence: 'yearly', user: 'me@example.com' });
    assert.doesNotMatch(a[0].payload_json, /テスト保険C/, '摘要は入れない');
    assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action = 'scheduled_item.created'").get()!.n, 1);
    assert.equal(verifyAudit(db).ok, true);
    db.close();
  });

  test('2 年ごとは + 24 か月。上書き（分類・名前・金額・anchor_date）', () => {
    const { db, A } = fresh();
    const id = txn(db, A, '2025-06-10', 120_000, 'テスト車検');
    let it = scheduleLargeExpense(db, id, { recurrence: 'biennial', category: 'car', name: '  車検  ', amount: 130_000 }, by, opts).item;
    assert.deepEqual([it.recurrence, it.anchor_date, it.category, it.name, it.amount], ['biennial', '2027-06-10', 'car', '車検', 130_000]);
    const id2 = txn(db, A, '2025-07-10', 60_000, 'テスト積立');
    it = scheduleLargeExpense(db, id2, { recurrence: 'yearly', category: 'savings', anchor_date: '2026-07-25' }, by, opts).item;
    assert.deepEqual([it.category, it.anchor_date], ['savings', '2026-07-25']);
    db.close();
  });

  test('anchor_date の既定は応当日が無ければ月末（2/29 → 平年の 2/28）', () => {
    const { db, A } = fresh();
    const today = '2026-01-15';
    const a = txn(db, A, '2024-02-29', 70_000, 'テスト閏A');
    const b = txn(db, A, '2024-02-29', 70_000, 'テスト閏B');
    const c = txn(db, A, '2025-01-31', 70_000, 'テスト月末');
    const at = (id: string, recurrence: string) => scheduleLargeExpense(db, id, { recurrence }, by, { today, now: T0 }).item.anchor_date;
    assert.equal(at(a, 'yearly'), '2025-02-28');
    assert.equal(at(b, 'biennial'), '2026-02-28');
    assert.equal(at(c, 'yearly'), '2026-01-31');
    db.close();
  });

  test('1 回だけは今日より後の anchor_date が要る', () => {
    const { db, A } = fresh();
    const id = txn(db, A, '2026-06-10', 300_000, 'テスト家電');
    assert.deepEqual(code(() => scheduleLargeExpense(db, id, { recurrence: 'once' }, by, opts)), ['anchor_date_required', 400]);
    assert.deepEqual(code(() => scheduleLargeExpense(db, id, { recurrence: 'once', anchor_date: TODAY }, by, opts)), ['anchor_date_required', 400]);
    assert.deepEqual(code(() => scheduleLargeExpense(db, id, { recurrence: 'once', anchor_date: '2026-02-30' }, by, opts)), ['invalid_anchor_date', 400]);
    assert.equal(getLargeExpenseDecision(db, id), null, '失敗したら判断は残さない');
    const it = scheduleLargeExpense(db, id, { recurrence: 'once', anchor_date: '2026-11-07' }, by, opts).item;
    assert.deepEqual([it.recurrence, it.anchor_date], ['once', '2026-11-07']);
    db.close();
  });

  test('周期は yearly・biennial・once だけ。値は createItem が確かめる', () => {
    const { db, A } = fresh();
    const id = txn(db, A, '2026-06-10', 300_000, 'テスト家電');
    assert.deepEqual(code(() => scheduleLargeExpense(db, id, { recurrence: 'monthly' }, by, opts)), ['invalid_recurrence', 400]);
    assert.deepEqual(code(() => scheduleLargeExpense(db, id, {}, by, opts)), ['invalid_recurrence', 400]);
    assert.deepEqual(code(() => scheduleLargeExpense(db, id, { recurrence: 'yearly', category: 'income' }, by, opts)), ['invalid_category_for_direction', 400]);
    assert.deepEqual(code(() => scheduleLargeExpense(db, id, { recurrence: 'yearly', amount: 0 }, by, opts)), ['invalid_amount', 400]);
    assert.equal(db.prepare('SELECT count(*) n FROM scheduled_items').get()!.n, 0);
    db.close();
  });

  test('判断済みは 409 already_decided、一覧に出せない明細は 404', () => {
    const { db, A } = fresh();
    const a = txn(db, A, '2026-06-10', 300_000, 'テスト家電A');
    const b = txn(db, A, '2026-06-11', 300_000, 'テスト家電B');
    const small = txn(db, A, '2026-06-12', 49_999, 'テスト家電C');
    scheduleLargeExpense(db, a, { recurrence: 'yearly' }, by, opts);
    dismissLargeExpense(db, b, by, opts);
    assert.deepEqual(code(() => scheduleLargeExpense(db, a, { recurrence: 'yearly' }, by, opts)), ['already_decided', 409]);
    assert.deepEqual(code(() => scheduleLargeExpense(db, b, { recurrence: 'yearly' }, by, opts)), ['already_decided', 409]);
    assert.deepEqual(code(() => dismissLargeExpense(db, a, by, opts)), ['already_decided', 409]);
    assert.deepEqual(code(() => scheduleLargeExpense(db, small, { recurrence: 'yearly' }, by, opts)), ['not_found', 404]);
    assert.deepEqual(code(() => dismissLargeExpense(db, 'NOPE', by, opts)), ['not_found', 404]);
    db.close();
  });
});

describe('しない', () => {
  test('冪等（2 回目はそのまま返し、監査は 1 件）', () => {
    const { db, A } = fresh();
    const id = txn(db, A, '2026-06-10', 300_000, 'テスト家電');
    const d1 = dismissLargeExpense(db, id, by, opts);
    const d2 = dismissLargeExpense(db, id, by, { today: TODAY, now: new Date('2026-11-07T00:00:00.000Z') });
    assert.deepEqual(d2, d1);
    assert.deepEqual([d1.decision, d1.scheduled_item_id], ['dismissed', null]);
    const a = db.prepare("SELECT entity_id, payload_json FROM audit_log WHERE action = 'large_expense.dismissed'").all() as { entity_id: string; payload_json: string }[];
    assert.equal(a.length, 1);
    assert.deepEqual([a[0].entity_id, JSON.parse(a[0].payload_json)], [id, { user: 'me@example.com' }]);
    db.close();
  });
});

describe('large_expense_decisions（0010）', () => {
  test('追記専用。scheduled のときだけ scheduled_item_id を持つ。明細 1 件に 1 行', () => {
    const { db, A } = fresh();
    const a = txn(db, A, '2026-06-10', 300_000, 'テスト家電A');
    const b = txn(db, A, '2026-06-11', 300_000, 'テスト家電B');
    dismissLargeExpense(db, a, by, opts);
    assert.throws(() => db.prepare("UPDATE large_expense_decisions SET decision = 'scheduled'").run(), /追記専用/);
    assert.throws(() => db.prepare('DELETE FROM large_expense_decisions').run(), /削除できない/);
    const ins = db.prepare('INSERT INTO large_expense_decisions (id, bank_txn_id, decision, scheduled_item_id, created_at) VALUES (?, ?, ?, ?, ?)');
    assert.throws(() => ins.run('X1', b, 'scheduled', null, now), /CHECK/);
    assert.throws(() => ins.run('X2', a, 'dismissed', null, now), /UNIQUE/);
    db.close();
  });
});
