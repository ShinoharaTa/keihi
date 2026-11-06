// CSV の取り込みの API（docs/mvp-plan-v3.md T105）。app.request() で叩く（ポートを開かない）。fixture は架空の店名・相手。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { dedupAndInsert } from '../../src/bank/dedup.ts';
import { getSyncStatus, insertAccount } from '../../src/bank/repo.ts';
import { listActiveTransfers } from '../../src/bank/transfers.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { hasObject, sha256Hex } from '../../src/storage/objects.ts';
import { createApp } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';

const LOCAL = '127.0.0.1:8795';
const USER = 'test@example.com';
const T0 = new Date('2026-11-06T03:00:00.000Z');
const FIX = path.resolve(import.meta.dirname, '../fixtures/csv');

let root: string;
let n = 0;
let db: Db;
let app: Hono;
let objectsDir: string;
let paypay: string;
let bank: string;
let freeeBank: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-import-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  objectsDir = path.join(root, `objects-${n++}`);
  const now = T0.toISOString();
  paypay = insertAccount(db, { provider: 'fake', name: 'PayPay 残高', kind: 'paypay', source: 'csv', now }).id;
  bank = insertAccount(db, { provider: 'fake', name: 'CSV 銀行', kind: 'bank', source: 'csv', now }).id;
  freeeBank = insertAccount(db, { provider: 'fake', name: 'テスト銀行', kind: 'bank', source: 'freee', freeeWalletableId: 'bank_account:1', now }).id;
  app = createApp({
    db,
    objectsDir,
    config: {
      ingest: { maxBytes: 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
      retention: { years: 7, extraYears: 1, start: 'next_year_0316' },
      cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false },
      provider: { kind: 'fake' },
      bank: { backfillFrom: '2025-01-01', dedupDateWindowDays: 0, transferWindowDays: 3, matchDateWindowDays: 3 },
    },
    auth: createAuth({ allowedUsers: [USER], allowedHosts: [LOCAL] }),
    triggerWorker: () => {},
    now: () => T0,
  });
});

const headers = { Host: LOCAL, 'Tailscale-User-Login': USER };

async function upload(accountId: string, bytes: Uint8Array<ArrayBuffer>, name = 'Transactions.csv') {
  const fd = new FormData();
  fd.append('file', new File([bytes], name, { type: 'text/csv' }));
  const r = await app.request(`http://${LOCAL}/api/accounts/${accountId}/import`, { method: 'POST', headers, body: fd });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const fixture = async (name: string) => new Uint8Array(await readFile(path.join(FIX, name)));
const count = (t: string, where = '') => (db.prepare(`SELECT count(*) n FROM ${t} ${where}`).get() as { n: number }).n;

describe('POST /api/accounts/:id/import', () => {
  test('PayPay の CSV: 件数・金額・符号、原本の保存、csv_imports、last_csv_at、監査', async () => {
    const bytes = await fixture('paypay-2026-10.csv');
    const r = await upload(paypay, bytes, 'Transactions_20261001-20261031.csv');
    assert.equal(r.status, 201);
    const { csv_import_id, transfers, ...rest } = r.body;
    assert.equal(typeof csv_import_id, 'string');
    assert.deepEqual(rest, {
      parser: 'paypay',
      rows_total: 30,
      rows_new: 25,
      rows_merged: 0,
      rows_skipped_points: 4,
      rows_error: 1,
      errors: [{ line: 10, reason: 'invalid_date' }],
      date_range: { from: '2026-10-01', to: '2026-10-31' },
    });
    assert.deepEqual(transfers, { from: '2026-09-25', to: '2026-11-06', created: 0 });
    const sums = db.prepare(`SELECT side, count(*) n, sum(amount) s FROM bank_txns WHERE account_id = ? GROUP BY side ORDER BY side`).all(paypay);
    assert.deepEqual(sums.map((x) => ({ ...x })), [
      { side: 'expense', n: 21, s: 67320 },
      { side: 'income', n: 4, s: 19500 },
    ]);
    const sha = sha256Hex(bytes);
    assert.equal(await hasObject(objectsDir, sha), true);
    const imp = db.prepare('SELECT * FROM csv_imports WHERE id = ?').get(csv_import_id as string) as Record<string, unknown>;
    assert.deepEqual(
      [imp.account_id, imp.parser_id, imp.file_sha256, imp.rows_total, imp.rows_new, imp.rows_merged, imp.rows_error, imp.actor, imp.imported_at],
      [paypay, 'paypay', sha, 30, 25, 0, 1, 'user', T0.toISOString()],
    );
    assert.equal(count('bank_txn_sources', `WHERE csv_import_id = '${csv_import_id}' AND source = 'csv' AND raw_sha256 IS NOT NULL`), 25);
    assert.equal(count('bank_txn_sources', `WHERE external_id = '4800000000000000000#11111'`), 1);
    assert.equal(getSyncStatus(db, paypay)?.last_csv_at, T0.toISOString());
    const a = db.prepare(`SELECT actor, payload_json FROM audit_log WHERE action = 'csv.imported'`).get() as { actor: string; payload_json: string };
    assert.equal(a.actor, 'user');
    assert.deepEqual(JSON.parse(a.payload_json).file_name, 'Transactions_20261001-20261031.csv');
    assert.equal(verifyAudit(db).ok, true);
  });

  test('同じファイルの 2 回目は 409。境界で重なる別のファイルは増えない', async () => {
    const first = await upload(paypay, await fixture('paypay-2026-10.csv'));
    const again = await upload(paypay, await fixture('paypay-2026-10.csv'));
    assert.equal(again.status, 409);
    assert.deepEqual(again.body, { error: 'already_imported', csv_import_id: first.body.csv_import_id });
    assert.equal(count('csv_imports'), 1);
    const before = count('bank_txns');
    const r = await upload(paypay, await fixture('paypay-2026-11-overlap.csv'));
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.rows_total, r.body.rows_new, r.body.rows_merged, r.body.rows_skipped_points, r.body.rows_error], [5, 3, 1, 1, 0]);
    assert.equal(count('bank_txns'), before + 3);
    assert.equal(count('csv_imports'), 2);
  });

  test('Shift_JIS の CSV も読む', async () => {
    const r = await upload(paypay, await fixture('paypay-sjis.csv'));
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.rows_total, r.body.rows_new, r.body.rows_skipped_points, r.body.rows_error], [3, 2, 1, 0]);
    const d = db.prepare(`SELECT description FROM bank_txns WHERE account_id = ? ORDER BY txn_date`).all(paypay).map((x) => (x as { description: string }).description);
    assert.deepEqual(d, ['チャージ テスト銀行 *****99', '支払い テスト商店']);
  });

  test('取り込みの後に、銀行の同額の出金とチャージの組を作る', async () => {
    const at = T0.toISOString();
    const out = (externalId: string, txnDate: string, amount: number) => ({
      accountId: freeeBank, source: 'freee' as const, externalId, txnDate, amount, side: 'expense' as const, description: 'PAYPAY',
    });
    const res = dedupAndInsert(db, [out('b1', '2026-10-25', 10000), out('b2', '2026-10-11', 5000), out('b3', '2026-10-20', 999)], { dateWindowDays: 0, now: at });
    const r = await upload(paypay, await fixture('paypay-2026-10.csv'));
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.transfers, { from: '2026-09-25', to: '2026-11-06', created: 2 });
    const links = listActiveTransfers(db);
    assert.deepEqual(
      links.map((l) => [l.kind, l.out_txn_id, l.amount]),
      [
        ['charge', res.new[1]!.bankTxnId, 5000],
        ['charge', res.new[0]!.bankTxnId, 10000],
      ],
    );
    const a = db.prepare(`SELECT actor, payload_json FROM audit_log WHERE action = 'transfers.detected'`).get() as { actor: string; payload_json: string };
    assert.deepEqual([a.actor, JSON.parse(a.payload_json)], ['user', { from: '2026-09-25', to: '2026-11-06', created: 2, kinds: { charge: 2 } }]);
  });

  test('404・not_csv_account・unknown_format・file_required・413', async () => {
    const csv = await fixture('paypay-2026-10.csv');
    assert.deepEqual(await upload('nope', csv), { status: 404, body: { error: 'not_found' } });
    assert.deepEqual(await upload(freeeBank, csv), { status: 400, body: { error: 'not_csv_account' } });
    assert.deepEqual(await upload(bank, new TextEncoder().encode('日付,金額,摘要\n2026-10-01,100,x\n')), { status: 400, body: { error: 'unknown_format' } });
    const fd = new FormData();
    fd.append('other', 'x');
    const r = await app.request(`http://${LOCAL}/api/accounts/${paypay}/import`, { method: 'POST', headers, body: fd });
    assert.deepEqual([r.status, await r.json()], [400, { error: 'file_required' }]);
    const big = await upload(paypay, new Uint8Array(5 * 1024 * 1024 + 1));
    assert.deepEqual(big, { status: 413, body: { error: 'too_large', max_bytes: 5 * 1024 * 1024 } });
    assert.equal(count('csv_imports'), 0);
    assert.equal(count('bank_txns'), 0);
  });

  test('kind が bank の CSV 口座にも入れられる', async () => {
    const r = await upload(bank, await fixture('paypay-sjis.csv'));
    assert.equal(r.status, 201);
    assert.equal(count('bank_txns', `WHERE account_id = '${bank}'`), 2);
  });
});

describe('GET /api/accounts/:id/imports', () => {
  test('新しい順に日時・ファイル名・件数', async () => {
    await upload(paypay, await fixture('paypay-2026-10.csv'), 'a.csv');
    await upload(paypay, await fixture('paypay-2026-11-overlap.csv'), 'b.csv');
    const r = await app.request(`http://${LOCAL}/api/accounts/${paypay}/imports`, { headers });
    assert.equal(r.status, 200);
    const { imports } = (await r.json()) as { imports: Record<string, unknown>[] };
    assert.deepEqual(
      imports.map((i) => [i.file_name, i.imported_at, i.parser_id, i.rows_total, i.rows_new, i.rows_merged, i.rows_error]),
      [
        ['b.csv', T0.toISOString(), 'paypay', 5, 3, 1, 0],
        ['a.csv', T0.toISOString(), 'paypay', 30, 25, 0, 1],
      ],
    );
    const nf = await app.request(`http://${LOCAL}/api/accounts/nope/imports`, { headers });
    assert.equal(nf.status, 404);
  });
});
