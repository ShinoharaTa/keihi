// お金タブのホーム（GET /api/bank/overview、src/bank/overview.ts）と月末残高の推移（GET /api/balance_history、src/bank/balanceHistory.ts）。
// 一時ディレクトリの DB だけを使い、app.request() で叩く（ポートを開かない）。期待値は手で計算したもの（下のコメント）。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { balanceHistory } from '../../src/bank/balanceHistory.ts';
import { appendBalance, insertAccount, insertBankTxn, updateAccountSettings, updateSyncStatus, type AccountKind, type TxnSide } from '../../src/bank/repo.ts';
import { setTxnTag } from '../../src/bank/tags.ts';
import { insertTransferLink } from '../../src/bank/transferRepo.ts';
import { insertRecurrenceCandidate, insertScheduledItem, setRecurrenceCandidateState, type Recurrence } from '../../src/cashflow/repo.ts';
import type { Config } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createAuth } from '../../src/web/auth.ts';
import { bankRoutes } from '../../src/web/routes/bank.ts';

// 2026-11-06 09:00 JST
const T0 = new Date('2026-11-06T00:00:00.000Z');
const now = T0.toISOString();
const HOST = '127.0.0.1:8787';
const USER = 'me@example.com';
const headers = { Host: HOST, 'Tailscale-User-Login': USER };
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-overview-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function base() {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  const mk = (name: string, kind: AccountKind) => insertAccount(db, { provider: 'fake', name, kind, source: 'csv', now }).id;
  const txn = (accountId: string, txnDate: string, amount: number, side: TxnSide, balance: number | null = null) =>
    insertBankTxn(db, { accountId, txnDate, amount, side, description: 'x', descriptionNorm: 'x', balance, now }).id;
  const bal = (accountId: string, asOfDate: string, balance: number) => appendBalance(db, { accountId, asOfDate, balance, source: 'manual', now });
  const item = (name: string, amount: number, recurrence: Recurrence, anchor: string) =>
    insertScheduledItem(db, {
      name, amount, direction: 'out', category: 'other', accountId: null, recurrence, anchorDate: anchor, endDate: null, notifyDaysBefore: 14, origin: 'manual', now,
    });
  return { db, mk, txn, bal, item };
}

function mkApp(db: Db): Hono {
  const app = new Hono();
  app.use('*', createAuth({ allowedUsers: [USER], allowedHosts: [HOST] }));
  const config = { cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false } } as unknown as Config;
  app.route('/api', bankRoutes({ db, config, objectsDir: '/nonexistent', now: () => T0, triggerWorker: () => {} }));
  return app;
}

// 口座: A（銀行、既定タグ business、残高 1,000,000）・W（財布、250,000）・card1（引き落とし未設定）・card2（設定済み）・
//   card4（口座だけ設定、パターン空）・card3（active = 0、未設定）・off（include_in_cashflow = 0、残高 777）。
// 残高: A + W = 1,250,000（カードは残高 null で by_account に入る）。
// 予定: 家賃 80,000（毎月、2026-11-25 起点）、税 30,000（1 回、2026-11-15、14 日前から通知 → 期日が近い 1 件）。
//   reserve（今日〜2027-02-05）= 家賃 11/25・12/25・1/25 + 税 = 270,000。available = 980,000。
// 予定外: 最初の明細は 2026-04（使わない）、05〜10 は A に毎月 30,000 の支出（その月の予定は無い）→ 中央値 30,000。
//   今月の按分: round(30,000 × (30 − 6) / 30) = 24,000。今月の予定（11/7〜30）: 家賃 + 税 = 110,000。
//   projected_end_balance = 1,250,000 − 110,000 − 24,000 = 1,116,000。
// 今月の明細: A 入金 300,000・A 出金 20,000・振替 A → W 50,000（集計外）・W 出金 5,000（unset）・W 出金 7,000（private にした）・off 出金 1,000（unset）。
//   income 300,000、expense 20,000 + 5,000 + 7,000 = 32,000（資金繰りの対象口座だけ）。all_income 300,000、all_expense 32,000 + off 1,000 = 33,000。untagged = W 5,000 と off 1,000 の 2 件（振替の入金側は数えない）。
function setupOverview() {
  const b = base();
  const { db, mk, txn, bal, item } = b;
  const A = mk('銀行A', 'bank');
  const W = mk('財布', 'wallet');
  const card1 = mk('カード1', 'card');
  const card2 = mk('カード2', 'card');
  const card3 = mk('カード3', 'card');
  const card4 = mk('カード4', 'card');
  const off = mk('私用', 'bank');
  updateAccountSettings(db, A, { defaultTag: 'business' }, now);
  updateAccountSettings(db, card2, { cardSettlementAccountId: A, cardSettlementPattern: 'ｶｰﾄﾞ2' }, now);
  updateAccountSettings(db, card3, { active: false }, now);
  updateAccountSettings(db, card4, { cardSettlementAccountId: A }, now);
  updateAccountSettings(db, off, { includeInCashflow: false }, now);
  bal(A, '2026-11-05', 1_000_000);
  bal(W, '2026-11-06', 250_000);
  bal(off, '2026-11-06', 777);

  txn(A, '2026-04-10', 60_000, 'expense');
  for (const m of ['05', '06', '07', '08', '09', '10']) txn(A, `2026-${m}-10`, 30_000, 'expense');
  txn(A, '2026-11-02', 300_000, 'income');
  txn(A, '2026-11-03', 20_000, 'expense');
  insertTransferLink(db, { outTxnId: txn(A, '2026-11-04', 50_000, 'expense'), inTxnId: txn(W, '2026-11-04', 50_000, 'income'), kind: 'transfer', source: 'auto', state: 'active', now });
  txn(W, '2026-11-05', 5_000, 'expense');
  setTxnTag(db, { txnId: txn(W, '2026-11-05', 7_000, 'expense'), tag: 'private', actor: 'user', source: 'human', now: T0 });
  txn(off, '2026-11-03', 1_000, 'expense');

  item('家賃', 80_000, 'monthly', '2026-11-25');
  item('税', 30_000, 'once', '2026-11-15');

  insertRecurrenceCandidate(db, { accountId: A, descriptionNorm: 'a', amount: 1000, interval: 'monthly', occurrences: [], now });
  insertRecurrenceCandidate(db, { accountId: A, descriptionNorm: 'b', amount: 2000, interval: 'quarterly', occurrences: [], now });
  const d = insertRecurrenceCandidate(db, { accountId: A, descriptionNorm: 'c', amount: 3000, interval: 'yearly', occurrences: [], now });
  setRecurrenceCandidateState(db, d.id, 'dismissed', null, now);

  updateSyncStatus(db, A, { lastOkAt: '2026-11-05T21:00:00.000Z' });
  updateSyncStatus(db, W, { lastOkAt: '2026-11-04T21:00:00.000Z', lastError: 'boom' });
  updateSyncStatus(db, off, { lastError: 'boom' }); // include_in_cashflow = 0 でも active なので数える
  return { ...b, A, W, card1, card2, card3, card4, off };
}

describe('GET /api/bank/overview', () => {
  test('手計算した fixture と一致する', async () => {
    const { db, A, W, card1, card4 } = setupOverview();
    const res = await mkApp(db).request('/api/bank/overview', { headers });
    assert.equal(res.status, 200);
    const o = (await res.json()) as Record<string, unknown> & { balances: { total: number; by_account: { account_id: string }[] } };
    const byId = (id: string) => o.balances.by_account.find((a) => a.account_id === id);
    assert.equal(o.balances.total, 1_250_000);
    assert.equal(o.balances.by_account.length, 5);
    assert.deepEqual(byId(A), { account_id: A, name: '銀行A', kind: 'bank', balance: 1_000_000, as_of_date: '2026-11-05' });
    assert.deepEqual(byId(W), { account_id: W, name: '財布', kind: 'wallet', balance: 250_000, as_of_date: '2026-11-06' });
    assert.deepEqual(byId(card1), { account_id: card1, name: 'カード1', kind: 'card', balance: null, as_of_date: null });
    const { balances: _, ...rest } = o;
    assert.deepEqual(rest, {
      today: '2026-11-06',
      reserve: 270_000,
      available: 980_000,
      untagged_count: 2,
      cards_without_settlement: [{ account_id: card1, name: 'カード1' }, { account_id: card4, name: 'カード4' }], // 口座の作成順
      open_candidates: 2,
      upcoming_due: 1,
      this_month: { month: '2026-11', income: 300_000, expense: 32_000, all_income: 300_000, all_expense: 33_000, planned_out_remaining: 110_000, unplanned_out_estimate: 24_000, projected_end_balance: 1_116_000 },
      sync: { last_ok_at: '2026-11-05T21:00:00.000Z', errors: 2 },
    });
  });

  test('active = 0 の口座の明細は untagged_count と all_income / all_expense に入らない', async () => {
    const { db, txn, card3 } = setupOverview();
    txn(card3, '2026-11-03', 4_000, 'expense');
    const res = await mkApp(db).request('/api/bank/overview', { headers });
    const o = (await res.json()) as { untagged_count: number; this_month: { all_income: number; all_expense: number } };
    assert.equal(o.untagged_count, 2);
    assert.deepEqual([o.this_month.all_income, o.this_month.all_expense], [300_000, 33_000]);
  });

  test('空の DB でも 200（0 と空の配列）', async () => {
    const { db } = base();
    const res = await mkApp(db).request('/api/bank/overview', { headers });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      today: '2026-11-06',
      balances: { total: 0, by_account: [] },
      reserve: 0,
      available: 0,
      untagged_count: 0,
      cards_without_settlement: [],
      open_candidates: 0,
      upcoming_due: 0,
      this_month: { month: '2026-11', income: 0, expense: 0, all_income: 0, all_expense: 0, planned_out_remaining: 0, unplanned_out_estimate: 0, projected_end_balance: 0 },
      sync: { last_ok_at: null, errors: 0 },
    });
  });
});

// 銀行 A・B・D と、残高も明細も無い銀行 C。カード・include_in_cashflow = 0・active = 0 の口座は出さない。今日は 2026-11-06、4 か月（08〜11）。
// 各月は「月末までの残高の記録の最後」と「月末までの明細の最後の balance」のうち日付が新しいほう。
//   A: 明細 05/20 100（期間の前）、08/05 1,000、08/20 1,200、08/25 balance NULL、10/03 900、10/30 1,500、11/02 1,600
//      記録 09/15 1,100、11/05 1,700、11/20 8,888（今日より後）
//      → 08 1,200 / 09 1,100（記録 09/15 が明細 08/20 より新しい）/ 10 1,500（明細 10/30 が記録 09/15 より新しい）/ 11 1,700（記録 11/05）
//   B: 明細 07/31 5,000（期間の前）、09/10 4,000、11/04 4,500、11/20 9,999（今日より後）、記録なし
//      → 08 5,000（期間の前から引き継ぎ）/ 09 4,000 / 10 4,000 / 11 4,500（今日までの明細）
//   D: 明細なし、記録 08/15 3,000、10/01 3,500、12/01 99,999（今日より後）→ 08 3,000 / 09 3,000 / 10 3,500 / 11 3,500
//   C: 0。合計: 08 9,200 / 09 8,100 / 10 9,000 / 11 9,700
function setupHistory() {
  const b = base();
  const { db, mk, txn, bal } = b;
  const A = mk('銀行A', 'bank');
  const B = mk('銀行B', 'bank');
  const C = mk('銀行C', 'bank');
  const D = mk('銀行D', 'bank');
  const card = mk('カード', 'card');
  const off = mk('私用', 'bank');
  const closed = mk('旧口座', 'cash');
  updateAccountSettings(db, off, { includeInCashflow: false }, now);
  updateAccountSettings(db, closed, { active: false }, now);
  txn(A, '2026-05-20', 1, 'expense', 100);
  txn(A, '2026-08-05', 1, 'expense', 1_000);
  txn(A, '2026-08-20', 1, 'expense', 1_200);
  txn(A, '2026-08-25', 1, 'expense', null);
  txn(A, '2026-10-03', 1, 'expense', 900);
  txn(A, '2026-10-30', 1, 'income', 1_500);
  txn(A, '2026-11-02', 1, 'income', 1_600);
  bal(A, '2026-09-15', 1_100);
  bal(A, '2026-11-05', 1_700);
  bal(A, '2026-11-20', 8_888);
  bal(D, '2026-08-15', 3_000);
  bal(D, '2026-10-01', 3_500);
  bal(D, '2026-12-01', 99_999);
  txn(B, '2026-07-31', 1, 'income', 5_000);
  txn(B, '2026-09-10', 1, 'expense', 4_000);
  txn(B, '2026-11-04', 1, 'income', 4_500);
  txn(B, '2026-11-20', 1, 'income', 9_999);
  txn(card, '2026-10-10', 1, 'expense', 123);
  txn(off, '2026-10-10', 1, 'expense', 456);
  txn(closed, '2026-10-10', 1, 'expense', 789);
  bal(off, '2026-11-05', 777);
  return { ...b, A, B, C, D };
}

describe('GET /api/balance_history', () => {
  test('手計算した fixture と一致する（記録と明細の新しいほう、無い月は引き継ぎ、今日より後は見ない）', async () => {
    const { db, A, B, C, D } = setupHistory();
    const res = await mkApp(db).request('/api/balance_history?months=4', { headers });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      months: [
        { month: '2026-08', total: 9_200, by_account: { [A]: 1_200, [B]: 5_000, [C]: 0, [D]: 3_000 } },
        { month: '2026-09', total: 8_100, by_account: { [A]: 1_100, [B]: 4_000, [C]: 0, [D]: 3_000 } },
        { month: '2026-10', total: 9_000, by_account: { [A]: 1_500, [B]: 4_000, [C]: 0, [D]: 3_500 } },
        { month: '2026-11', total: 9_700, by_account: { [A]: 1_700, [B]: 4_500, [C]: 0, [D]: 3_500 } },
      ],
    });
  });

  test('既定は 12 か月（2025-12〜2026-11）、months は 1〜60、それ以外は 400', async () => {
    const { db, A } = setupHistory();
    const app = mkApp(db);
    const months = ((await (await app.request('/api/balance_history', { headers })).json()) as { months: { month: string; by_account: Record<string, number> }[] }).months;
    assert.equal(months.length, 12);
    assert.equal(months[0]!.month, '2025-12');
    assert.equal(months[11]!.month, '2026-11');
    assert.equal(months[0]!.by_account[A], 0); // 最初の明細より前
    assert.equal(months.find((m) => m.month === '2026-05')!.by_account[A], 100);
    for (const [q, len] of [['1', 1], ['60', 60]] as const) {
      const r = await app.request(`/api/balance_history?months=${q}`, { headers });
      assert.equal(((await r.json()) as { months: unknown[] }).months.length, len);
    }
    for (const q of ['0', '61', 'abc', '1.5', '-1', '']) {
      const r = await app.request(`/api/balance_history?months=${q}`, { headers });
      assert.equal(r.status, 400, q);
      assert.deepEqual(await r.json(), { error: 'invalid_months' });
    }
  });

  test('同じ日なら残高の記録を採る', () => {
    const { db, mk, txn, bal } = base();
    const E = mk('銀行E', 'bank');
    txn(E, '2026-11-03', 1, 'expense', 500);
    bal(E, '2026-11-03', 600);
    assert.equal(balanceHistory(db, { today: '2026-11-06', months: 1 }).months[0]!.by_account[E], 600);
  });

  test('年をまたぐ', () => {
    const { db, A, D } = setupHistory();
    const h = balanceHistory(db, { today: '2027-01-10', months: 3 });
    assert.deepEqual(h.months.map((m) => m.month), ['2026-11', '2026-12', '2027-01']);
    // 今日が 2027-01-10 なら A の 11/20 の記録 8,888 も D の 12/01 の記録 99,999 も過去になる（12・1 月は引き継ぎ）
    assert.deepEqual(h.months.map((m) => m.by_account[A]), [8_888, 8_888, 8_888]);
    assert.deepEqual(h.months.map((m) => m.by_account[D]), [3_500, 99_999, 99_999]);
  });
});
