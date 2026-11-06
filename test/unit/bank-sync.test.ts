// 口座の管理（T103）と明細の同期ジョブ sync_bank（T104。docs/mvp-plan-v3.md）。fake provider だけを使う（外部へ通信しない）。
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAudit } from '../../src/audit.ts';
import { getAccountByWalletable, getSyncStatus, listAccounts, updateAccountSettings } from '../../src/bank/repo.ts';
import { enqueueSyncBank, MANUAL_SYNC_INTERVAL_MS, planRanges, syncBank } from '../../src/bank/sync.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { getJob } from '../../src/jobs/queue.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { syncMasters } from '../../src/masters/sync.ts';
import { createFakeProvider, DEFAULT_MASTERS, type FakeProvider } from '../../src/providers/fake/index.ts';
import { budgetDay, createBudget, withBudget, type BudgetLimits, DEFAULT_LIMITS } from '../../src/providers/freee/budget.ts';
import { setReauthRequired } from '../../src/providers/freee/state.ts';
import type { Masters } from '../../src/providers/types.ts';
import { createSyncBankHandler } from '../../src/worker/handlers/syncBank.ts';

const T0 = new Date('2026-11-06T03:00:00.000Z'); // JST 2026-11-06
const BACKFILL_FROM = '2025-01-01';
const MASTERS: Masters = {
  ...DEFAULT_MASTERS,
  walletables: [
    { id: 1, type: 'credit_card', name: 'テストカード' },
    { id: 2, type: 'bank_account', name: 'テスト銀行' },
  ],
};

let db: Db;
let fake: FakeProvider;

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db);
  fake = createFakeProvider({ masters: MASTERS });
  await syncMasters(db, fake, { providerName: 'freee', accountProvider: 'fake', now: () => T0 });
});

const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const bankId = () => getAccountByWalletable(db, 'fake', 'bank_account:2')!.id;

function addBankTxns(n: number, date = '2026-10-01') {
  for (let i = 0; i < n; i++) {
    fake.addBankTxn({ walletableType: 'bank_account', walletableId: 2, date, amount: i + 1, entrySide: 'expense', description: `ＴＥＳＴ ${i}`, balance: null, status: 1, dueAmount: i + 1, ruleMatched: false });
  }
}

const sync = (now = T0, provider = fake as Parameters<typeof syncBank>[1]['provider']) => syncBank(db, { provider, providerKind: 'fake', backfillFrom: BACKFILL_FROM, now });

describe('口座（money_accounts）', () => {
  test('マスタ同期を 2 回しても行が増えない。名前だけ変わり、設定の列は触らない', async () => {
    assert.deepEqual(
      listAccounts(db).map((a) => [a.provider, a.kind, a.source, a.freee_walletable_id, a.name, a.default_tag, a.mcp_visibility]),
      [
        ['fake', 'card', 'freee', 'credit_card:1', 'テストカード', 'unset', 'summary'],
        ['fake', 'bank', 'freee', 'bank_account:2', 'テスト銀行', 'unset', 'summary'],
      ],
    );
    updateAccountSettings(db, bankId(), { defaultTag: 'business' }, T0.toISOString());
    const renamed = structuredClone(MASTERS);
    renamed.walletables[1].name = 'テスト銀行（新）';
    await syncMasters(db, createFakeProvider({ masters: renamed }), { providerName: 'freee', accountProvider: 'fake', now: () => T0 });
    await syncMasters(db, createFakeProvider({ masters: renamed }), { providerName: 'freee', accountProvider: 'fake', now: () => T0 });
    assert.equal(listAccounts(db).length, 2);
    const bank = getAccountByWalletable(db, 'fake', 'bank_account:2')!;
    assert.deepEqual([bank.name, bank.default_tag], ['テスト銀行（新）', 'business']);
  });

  test('accountProvider を渡さなければ口座を作らない', async () => {
    const d = openDb(':memory:');
    migrate(d);
    await syncMasters(d, fake, { providerName: 'freee', now: () => T0 });
    assert.equal(listAccounts(d).length, 0);
    d.close();
  });
});

describe('planRanges', () => {
  test('初めては今日から 3 か月だけ。次からは最新日 − 35 日〜今日と、その手前の 3 か月を 1 区間', () => {
    assert.deepEqual(planRanges({ backfillDoneUntil: null, latestTxnDate: null }, '2026-11-06', BACKFILL_FROM), {
      ranges: [{ start: '2026-08-06', end: '2026-11-06' }],
      backfillDoneUntil: '2026-08-06',
    });
    assert.deepEqual(planRanges({ backfillDoneUntil: '2026-08-06', latestTxnDate: '2026-11-01' }, '2026-11-06', BACKFILL_FROM), {
      ranges: [
        { start: '2026-09-27', end: '2026-11-06' },
        { start: '2026-05-06', end: '2026-08-05' },
      ],
      backfillDoneUntil: '2026-05-06',
    });
    // backfill_from で止まる。届いたら最近の分だけ。
    assert.deepEqual(planRanges({ backfillDoneUntil: '2025-02-10', latestTxnDate: null }, '2026-11-06', BACKFILL_FROM), {
      ranges: [
        { start: '2025-02-10', end: '2026-11-06' },
        { start: '2025-01-01', end: '2025-02-09' },
      ],
      backfillDoneUntil: '2025-01-01',
    });
    assert.deepEqual(planRanges({ backfillDoneUntil: '2025-01-01', latestTxnDate: '2026-11-01' }, '2026-11-06', BACKFILL_FROM), {
      ranges: [{ start: '2026-09-27', end: '2026-11-06' }],
      backfillDoneUntil: '2025-01-01',
    });
    // 最新日 − 35 日が backfill_from より前なら backfill_from から。
    assert.deepEqual(planRanges({ backfillDoneUntil: '2025-01-01', latestTxnDate: '2025-01-10' }, '2026-11-06', BACKFILL_FROM).ranges, [
      { start: '2025-01-01', end: '2026-11-06' },
    ]);
  });
});

describe('syncBank', () => {
  test('250 件を 100 件ずつ取り込み、2 回目で増えない', async () => {
    addBankTxns(250);
    const r1 = await sync();
    assert.equal(count('SELECT count(*) n FROM bank_txns'), 250);
    assert.equal(count(`SELECT count(*) n FROM bank_txn_sources WHERE source = 'freee'`), 250);
    const bank = r1.accounts.find((a) => a.account_id === bankId())!;
    assert.deepEqual([bank.fetched, bank.inserted, bank.updated], [250, 250, 0]);
    const pages = fake.calls.filter((c) => c.method === 'listBankTxns' && (c.args[0] as { walletableId: number }).walletableId === 2);
    assert.deepEqual(pages.map((c) => (c.args[0] as { offset: number; limit: number }).offset), [0, 100, 200]);
    assert.ok(pages.every((c) => (c.args[0] as { limit: number }).limit === 100));
    const row = db.prepare(`SELECT t.description_norm, s.external_id FROM bank_txns t JOIN bank_txn_sources s ON s.bank_txn_id = t.id ORDER BY t.amount LIMIT 1`).get() as { description_norm: string; external_id: string };
    assert.deepEqual({ ...row }, { description_norm: 'test0', external_id: 'bank_account:2:1' });

    const r2 = await sync(new Date(T0.getTime() + 3_600_000));
    assert.equal(count('SELECT count(*) n FROM bank_txns'), 250);
    assert.deepEqual([r2.accounts.find((a) => a.account_id === bankId())!.inserted, r2.accounts.find((a) => a.account_id === bankId())!.updated], [0, 250]);
    const st = getSyncStatus(db, bankId())!;
    assert.equal(st.last_error, null);
    assert.equal(st.last_ok_at, new Date(T0.getTime() + 3_600_000).toISOString());
  });

  test('status・due_amount の変化を書き、status の変化は監査に残す。NULL の balance は埋める', async () => {
    addBankTxns(3);
    await sync();
    const t = fake.state.bankTxns.get(2)!;
    t.status = 2;
    t.dueAmount = 0;
    t.balance = 9000;
    fake.state.bankTxns.get(3)!.status = 5; // 知らない値は NULL
    await sync(new Date(T0.getTime() + 60_000));
    const rows = db.prepare(`SELECT s.external_id, t.freee_status, t.due_amount, t.balance FROM bank_txns t JOIN bank_txn_sources s ON s.bank_txn_id = t.id ORDER BY s.external_id`).all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { external_id: 'bank_account:2:1', freee_status: 1, due_amount: 1, balance: null },
      { external_id: 'bank_account:2:2', freee_status: 2, due_amount: 0, balance: 9000 },
      { external_id: 'bank_account:2:3', freee_status: null, due_amount: 3, balance: null },
    ]);
    const audits = db.prepare(`SELECT json_extract(payload_json, '$.external_id') ext, json_extract(payload_json, '$.from') f, json_extract(payload_json, '$.to') t FROM audit_log WHERE action = 'bank_txn.status_changed' ORDER BY seq`).all();
    assert.deepEqual(audits.map((r) => ({ ...r })), [
      { ext: 'bank_account:2:2', f: 1, t: 2 },
      { ext: 'bank_account:2:3', f: 1, t: null },
    ]);
    // 3 回目は変化が無いので監査は増えない。
    await sync(new Date(T0.getTime() + 120_000));
    assert.equal(count(`SELECT count(*) n FROM audit_log WHERE action = 'bank_txn.status_changed'`), 2);
    assert.equal(verifyAudit(db).ok, true);
  });

  test('初めての口座は 3 か月ずつさかのぼり、1 回の実行で 1 区間だけ進める', async () => {
    addBankTxns(1, '2026-10-01');
    addBankTxns(1, '2026-06-01');
    addBankTxns(1, '2026-03-01');
    await sync();
    assert.equal(getSyncStatus(db, bankId())!.backfill_done_until, '2026-08-06');
    assert.equal(count('SELECT count(*) n FROM bank_txns'), 1);
    await sync(new Date(T0.getTime() + 60_000));
    assert.equal(getSyncStatus(db, bankId())!.backfill_done_until, '2026-05-06');
    assert.equal(count('SELECT count(*) n FROM bank_txns'), 2);
    await sync(new Date(T0.getTime() + 120_000));
    assert.equal(getSyncStatus(db, bankId())!.backfill_done_until, '2026-02-06');
    assert.equal(count('SELECT count(*) n FROM bank_txns'), 3);
    const last = fake.calls.filter((c) => c.method === 'listBankTxns' && (c.args[0] as { walletableId: number }).walletableId === 2).slice(-2);
    assert.deepEqual(last.map((c) => [(c.args[0] as { startDate: string }).startDate, (c.args[0] as { endDate: string }).endDate]), [
      ['2026-08-27', '2026-11-06'], // 最新日（2026-10-01）− 35 日〜今日
      ['2026-02-06', '2026-05-05'],
    ]);
  });

  test('予算の残りが 500 を切ったら途中で止め、last_error に書き、次回に続きから取る', async () => {
    addBankTxns(250);
    const limits: BudgetLimits = { ...DEFAULT_LIMITS, uploadReserve: 0, legalOnlyBelow: 0 };
    const budget = createBudget({ db, now: () => T0, limits });
    // 残り 502 にする（カード 1 回、銀行 2 回で 499 になり、銀行の 3 ページ目で止まる）。
    const ins = db.prepare(`INSERT INTO freee_calls (called_on, called_at, purpose, method, endpoint) VALUES (?, ?, 'user', 'GET', 'x')`);
    for (let i = 0; i < DEFAULT_LIMITS.daily - 502; i++) ins.run(budgetDay(T0), T0.toISOString());
    const r = await sync(T0, withBudget(fake, budget));
    assert.match(r.stopped ?? '', /sync_stopped/);
    assert.equal(count('SELECT count(*) n FROM bank_txns'), 200);
    const st = getSyncStatus(db, bankId())!;
    assert.match(st.last_error ?? '', /^budget: /);
    assert.equal(st.backfill_done_until, null); // 区間を取り終えていないので進めない
    assert.equal(r.balances, 0); // 止まった実行では残高を取らない
    assert.equal(fake.calls.filter((c) => c.method === 'listWalletables').length, 0);

    // 翌日（予算が戻る）: 続きから取り切る。
    const t1 = new Date(T0.getTime() + 86_400_000);
    await sync(t1, withBudget(fake, createBudget({ db, now: () => t1, limits })));
    assert.equal(count('SELECT count(*) n FROM bank_txns'), 250);
    const st2 = getSyncStatus(db, bankId())!;
    assert.deepEqual([st2.last_error, st2.last_ok_at, st2.backfill_done_until], [null, t1.toISOString(), '2026-08-07']);
  });

  test('残高は明細の後に account_balances に追記する（カード・残高無しは追記しない）', async () => {
    fake.setWalletableBalance('bank_account', 2, 51000);
    fake.setWalletableBalance('credit_card', 1, 1200);
    const r = await sync();
    assert.equal(r.balances, 1);
    const rows = db.prepare('SELECT account_id, as_of_date, balance, source FROM account_balances').all();
    assert.deepEqual(rows.map((x) => ({ ...x })), [{ account_id: bankId(), as_of_date: '2026-11-06', balance: 51000, source: 'freee_walletable' }]);
  });

  test('ほかの失敗は口座の last_error に書いて次の口座に進む', async () => {
    addBankTxns(1);
    fake.failNext('server'); // 先頭のカードの 1 回目
    const r = await sync();
    assert.equal(r.errors.length, 1);
    const card = getAccountByWalletable(db, 'fake', 'credit_card:1')!;
    assert.match(getSyncStatus(db, card.id)!.last_error ?? '', /^server\(500\)/);
    assert.equal(getSyncStatus(db, bankId())!.last_error, null);
    assert.equal(count('SELECT count(*) n FROM bank_txns'), 1);
  });

  test('対象は [provider] kind の freee の使っている口座だけ', async () => {
    updateAccountSettings(db, bankId(), { active: false }, T0.toISOString());
    addBankTxns(1);
    const r = await sync();
    assert.deepEqual(r.accounts.map((a) => a.account_id), [getAccountByWalletable(db, 'fake', 'credit_card:1')!.id]);
    const other = await syncBank(db, { provider: fake, providerKind: 'freee', backfillFrom: BACKFILL_FROM, now: T0 });
    assert.deepEqual(other.accounts, []);
  });
});

describe('sync_bank ジョブ', () => {
  const handlers = () => ({ sync_bank: createSyncBankHandler(() => ({ provider: fake, providerKind: 'fake', backfillFrom: BACKFILL_FROM })) });

  test('動かすと明細が入り、ジョブは完了する', async () => {
    addBankTxns(3);
    const { job_id } = enqueueSyncBank(db, T0);
    assert.deepEqual(await runUntilEmpty(db, handlers(), { now: () => T0 }), { done: 1, failed: 0 });
    assert.equal(getJob(db, job_id)!.state, 'done');
    assert.equal(count('SELECT count(*) n FROM bank_txns'), 3);
  });

  test('再認可待ちは呼ばずに延期する（回数を数えない）。provider の invalid_grant も同じ', async () => {
    setReauthRequired(db, true, T0);
    const a = enqueueSyncBank(db, T0).job_id;
    assert.deepEqual(await runUntilEmpty(db, handlers(), { now: () => T0 }), { done: 0, failed: 0 });
    let j = getJob(db, a)!;
    assert.deepEqual([j.state, j.attempts], ['queued', 0]);
    assert.match(j.last_error ?? '', /^reauth_pending since=2026-11-06T03:00:00.000Z: /);
    assert.equal(j.run_after, new Date(T0.getTime() + 6 * 3_600_000).toISOString());
    assert.equal(fake.calls.filter((c) => c.method === 'listBankTxns').length, 0);

    setReauthRequired(db, false, T0);
    fake.failNext('auth_invalid_grant');
    const t1 = new Date(T0.getTime() + 6 * 3_600_000);
    await runUntilEmpty(db, handlers(), { now: () => t1 });
    j = getJob(db, a)!;
    assert.deepEqual([j.state, j.attempts], ['queued', 0]);
    assert.match(j.last_error ?? '', /^reauth_pending since=2026-11-06T03:00:00.000Z: /); // 待ちの開始は最初のまま
    assert.match(getSyncStatus(db, getAccountByWalletable(db, 'fake', 'credit_card:1')!.id)!.last_error ?? '', /^auth_invalid_grant/);
  });

  test('一部の口座が失敗したらジョブの再試行に回す', async () => {
    fake.failNext('server');
    const a = enqueueSyncBank(db, T0).job_id;
    assert.deepEqual(await runUntilEmpty(db, handlers(), { now: () => T0 }), { done: 0, failed: 1 });
    assert.deepEqual([getJob(db, a)!.state, getJob(db, a)!.attempts], ['queued', 1]);
  });

  test('enqueueSyncBank: 未完了があれば積まない。minIntervalMs の間は積まない', () => {
    const a = enqueueSyncBank(db, T0, { minIntervalMs: MANUAL_SYNC_INTERVAL_MS });
    assert.equal(a.created, true);
    assert.deepEqual(enqueueSyncBank(db, T0), { job_id: a.job_id, created: false });
    db.prepare(`UPDATE jobs SET state = 'done' WHERE id = ?`).run(a.job_id);
    const t9 = new Date(T0.getTime() + 9 * 60_000);
    assert.deepEqual(enqueueSyncBank(db, t9, { minIntervalMs: MANUAL_SYNC_INTERVAL_MS }), { job_id: a.job_id, created: false });
    assert.equal(enqueueSyncBank(db, t9).created, true); // daily は間隔を見ない
    db.prepare(`UPDATE jobs SET state = 'done'`).run();
    const t20 = new Date(T0.getTime() + 20 * 60_000);
    assert.equal(enqueueSyncBank(db, t20, { minIntervalMs: MANUAL_SYNC_INTERVAL_MS }).created, true);
  });
});
