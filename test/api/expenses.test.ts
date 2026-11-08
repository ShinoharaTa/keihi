// GET /api/expenses（経費の一覧。docs/cashflow.md §15.1）。app.request() で叩く（ポートを開かない）。摘要・金額はすべて架空の値。
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { insertAccount, insertBankTxn, updateAccountSettings } from '../../src/bank/repo.ts';
import { setTxnTag } from '../../src/bank/tags.ts';
import { insertTransferLink } from '../../src/bank/transferRepo.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { normalizeVendor } from '../../src/vendors/normalize.ts';
import { createApp } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';

const LOCAL = '127.0.0.1:8797';
const USER = 'test@example.com';
const T0 = new Date('2026-11-08T03:00:00.000Z');
const NOW = T0.toISOString();

let db: Db;
let app: Hono;
let docN = 0;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  app = createApp({
    db,
    objectsDir: '/nonexistent',
    config: {
      ingest: { maxBytes: 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
      retention: { years: 7, extraYears: 1, start: 'next_year_0316' },
      provider: { kind: 'fake' },
      bank: { backfillFrom: '2025-01-01', dedupDateWindowDays: 0, transferWindowDays: 3, matchDateWindowDays: 3, matchCardDateWindowDays: 10 },
      cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false },
    },
    auth: createAuth({ allowedUsers: [USER], allowedHosts: [LOCAL] }),
    triggerWorker: () => {},
    now: () => T0,
  });
});

const headers = { Host: LOCAL, 'Tailscale-User-Login': USER };
async function get<T>(p: string, status = 200): Promise<T> {
  const r = await app.request(`http://${LOCAL}${p}`, { headers });
  assert.equal(r.status, status, p);
  return (await r.json()) as T;
}

function account(name = '銀行A', defaultTag: 'business' | 'private' | 'unset' = 'business'): string {
  const id = insertAccount(db, { provider: 'fake', name, kind: 'bank', source: 'csv', now: NOW }).id;
  updateAccountSettings(db, id, { defaultTag }, NOW);
  return id;
}
function txn(accountId: string, txnDate: string, amount: number, description = 'ｶﾌｪ ﾃｽﾄ', side: 'income' | 'expense' = 'expense'): string {
  return insertBankTxn(db, { accountId, txnDate, amount, side, description, descriptionNorm: normalizeVendor(description), now: NOW }).id;
}
function tag(txnId: string, t: 'business' | 'private', category: string | null): void {
  setTxnTag(db, { txnId, tag: t, category, actor: 'user', source: 'human', now: T0 });
}
// 金額・日付が同じ証憑（候補になる）。
function doc(txnDate: string, amount: number): string {
  const id = `D${String(++docN).padStart(4, '0')}`;
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, status, created_at)
     VALUES (?, ?, 1, 'image/jpeg', 'pwa', 'scan', ?, '2026-11-01', 'server', '2026-11-20', 'early', 'x', 'needs_review', ?)`,
  ).run(id, docN.toString(16).padStart(64, '0'), NOW, NOW);
  db.prepare(
    `INSERT INTO extractions (id, document_id, engine, raw_json, txn_date, amount_total, vendor_name, created_at) VALUES (?, ?, 'gemini', '{}', ?, ?, '別の店', ?)`,
  ).run(`E${id}`, id, txnDate, amount, NOW);
  return id;
}

type Total = { amount: number; count: number; waiting_count: number; waiting_amount: number };
type Month = { month: string; amount: number; count: number; waiting_count: number };
type Vendor = { vendor_key: string | null; label: string; count: number; amount: number; waiting_count: number; category: string | null };
type Expenses = { from: string; to: string; total: Total; months: Month[]; vendors: Vendor[] };
type Item = { id: string; amount: number; txn_date: string; description: string; receipt: string | null };

async function allTxns(qs: string): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: Item[]; next_cursor: string | null } = await get(`/api/bank_txns?${qs}${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

describe('GET /api/expenses', () => {
  test('月・相手の合計が bank_txns?tag=business&side=expense&excluded=0 と一致し、振替・入金・私用・unset は入らない', async () => {
    const a = account('銀行A');
    const b = account('銀行B');
    const u = account('銀行C', 'unset');
    txn(a, '2026-09-03', 1234, 'ｶﾌｪ ﾃｽﾄ');
    txn(a, '2026-09-20', 2000, 'ｼｮﾃﾝ ﾃｽﾄ');
    txn(a, '2026-11-02', 500, 'ｶﾌｪ ﾃｽﾄ ｼﾃﾝ');
    txn(b, '2026-11-05', 3000, 'ｶﾌｪ ﾃｽﾄ');
    // 入金・私用・unset・振替は経費ではない。
    txn(a, '2026-09-10', 9000, 'ｳﾘｱｹﾞ', 'income');
    tag(txn(a, '2026-09-11', 777, 'ｶﾌｪ ﾃｽﾄ'), 'private', 'food');
    txn(u, '2026-09-12', 888, 'ｶﾌｪ ﾃｽﾄ');
    const out = txn(a, '2026-11-06', 50000, 'ﾌﾘｶｴ');
    const inn = txn(b, '2026-11-06', 50000, 'ﾌﾘｶｴ', 'income');
    insertTransferLink(db, { outTxnId: out, inTxnId: inn, kind: 'transfer', source: 'auto', state: 'active', now: NOW });
    // 範囲外。
    txn(a, '2026-08-31', 100, 'ｶﾌｪ ﾃｽﾄ');
    txn(a, '2026-12-01', 100, 'ｶﾌｪ ﾃｽﾄ');

    const r = await get<Expenses>('/api/expenses?from=2026-09&to=2026-11');
    const rows = await allTxns('tag=business&side=expense&excluded=0&from=2026-09-01&to=2026-11-30');
    assert.equal(rows.length, 4);
    const sum = (xs: Item[]) => xs.reduce((s, x) => s + x.amount, 0);
    assert.equal(r.from, '2026-09');
    assert.equal(r.to, '2026-11');
    assert.deepEqual(r.total, { amount: sum(rows), count: rows.length, waiting_count: 4, waiting_amount: sum(rows) });
    // 0 件の月（10 月）も出す。古い順。
    assert.deepEqual(r.months, [
      { month: '2026-09', amount: sum(rows.filter((x) => x.txn_date.startsWith('2026-09'))), count: 2, waiting_count: 2 },
      { month: '2026-10', amount: 0, count: 0, waiting_count: 0 },
      { month: '2026-11', amount: sum(rows.filter((x) => x.txn_date.startsWith('2026-11'))), count: 2, waiting_count: 2 },
    ]);
    // 相手ごと: 各相手の合計が vendor_key で絞った bank_txns の合計と一致。
    for (const v of r.vendors) {
      const vs = await allTxns(`tag=business&side=expense&excluded=0&from=2026-09-01&to=2026-11-30&vendor_key=${encodeURIComponent(v.vendor_key!)}`);
      assert.equal(v.amount, sum(vs), v.vendor_key!);
      assert.equal(v.count, vs.length);
    }
    assert.equal(r.vendors.reduce((s, v) => s + v.amount, 0), r.total.amount);
    assert.deepEqual(r.vendors.map((v) => [v.vendor_key, v.amount]), [
      [normalizeVendor('ｶﾌｪ ﾃｽﾄ'), 4234],
      [normalizeVendor('ｼｮﾃﾝ ﾃｽﾄ'), 2000],
      [normalizeVendor('ｶﾌｪ ﾃｽﾄ ｼﾃﾝ'), 500],
    ]);
    assert.ok(!r.vendors.some((v) => v.vendor_key === normalizeVendor('ﾌﾘｶｴ')));
  });

  test('waiting_count は receipt = waiting だけ（候補がある明細は数えない）', async () => {
    const a = account();
    txn(a, '2026-10-15', 1234, 'ｶﾌｪ ﾃｽﾄ');
    const withDoc = txn(a, '2026-10-20', 5678, 'ｶﾌｪ ﾃｽﾄ');
    doc('2026-10-20', 5678);
    const items = await allTxns('tag=business&side=expense&excluded=0');
    assert.equal(items.find((x) => x.id === withDoc)!.receipt, 'candidate');
    const r = await get<Expenses>('/api/expenses?month=2026-10');
    assert.deepEqual(r.total, { amount: 6912, count: 2, waiting_count: 1, waiting_amount: 1234 });
    assert.deepEqual(r.months, [{ month: '2026-10', amount: 6912, count: 2, waiting_count: 1 }]);
    assert.equal(r.vendors[0]!.waiting_count, 1);
  });

  test('label は最新の明細の description、category は最も多いカテゴリ（同数なら新しい明細のもの、全部未分類なら null）', async () => {
    const a = account();
    tag(txn(a, '2026-10-01', 100, 'ｶﾌｪ ﾃｽﾄ'), 'business', 'food');
    tag(txn(a, '2026-10-02', 100, 'カフェ テスト'), 'business', 'food');
    tag(txn(a, '2026-10-03', 100, 'ｶﾌｪ  ﾃｽﾄ'), 'business', 'other');
    // 同数（1 対 1）なら新しいほう。
    tag(txn(a, '2026-10-04', 200, 'ｼｮﾃﾝ'), 'business', 'daily');
    tag(txn(a, '2026-10-05', 200, 'ｼｮﾃﾝ'), 'business', 'other');
    txn(a, '2026-10-06', 50, 'ﾐﾌﾞﾝﾙｲ');
    const r = await get<Expenses>('/api/expenses?month=2026-10');
    const by = new Map(r.vendors.map((v) => [v.vendor_key, v]));
    const cafe = by.get(normalizeVendor('ｶﾌｪ ﾃｽﾄ'))!;
    assert.equal(cafe.count, 3);
    assert.equal(cafe.label, 'ｶﾌｪ  ﾃｽﾄ');
    assert.equal(cafe.category, 'food');
    assert.equal(by.get(normalizeVendor('ｼｮﾃﾝ'))!.category, 'other');
    assert.equal(by.get(normalizeVendor('ﾐﾌﾞﾝﾙｲ'))!.category, null);
  });

  test('vendors は amount の多い順に上位 50 + 「その他」1 行', async () => {
    const a = account();
    for (let i = 1; i <= 53; i++) txn(a, '2026-10-10', i * 10, `ﾃｽﾄ ﾃﾝ ${String(i).padStart(2, '0')}`);
    const r = await get<Expenses>('/api/expenses?month=2026-10');
    assert.equal(r.vendors.length, 51);
    assert.deepEqual(r.vendors.slice(0, 50).map((v) => v.amount), Array.from({ length: 50 }, (_, i) => (53 - i) * 10));
    assert.deepEqual(r.vendors[50], { vendor_key: null, label: 'その他', count: 3, amount: 60, waiting_count: 3, category: null });
    assert.equal(r.vendors.reduce((s, v) => s + v.amount, 0), r.total.amount);
  });

  test('50 件以下なら「その他」は付けない。経費が無い期間は 0 と空の vendors', async () => {
    const r = await get<Expenses>('/api/expenses?from=2026-01&to=2026-12');
    assert.equal(r.months.length, 12);
    assert.deepEqual(r.total, { amount: 0, count: 0, waiting_count: 0, waiting_amount: 0 });
    assert.deepEqual(r.vendors, []);
  });

  test('400: month_required・invalid_month・invalid_range・range_too_long（13 か月）・month_and_range', async () => {
    const bad = async (qs: string, error: string) => assert.deepEqual(await get(`/api/expenses${qs}`, 400), { error }, qs);
    await bad('', 'month_required');
    await bad('?from=2026-01', 'month_required');
    await bad('?to=2026-01', 'month_required');
    await bad('?month=2026-13', 'invalid_month');
    await bad('?month=2026-1', 'invalid_month');
    await bad('?from=2026-01&to=2026-1x', 'invalid_month');
    await bad('?from=2026-05&to=2026-04', 'invalid_range');
    await bad('?from=2025-01&to=2026-01', 'range_too_long');
    await bad('?month=2026-01&from=2026-01&to=2026-02', 'month_and_range');
    const ok = await get<Expenses>('/api/expenses?from=2025-02&to=2026-01');
    assert.equal(ok.months.length, 12);
  });
});
