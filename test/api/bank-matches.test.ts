// 明細 ⇔ 証憑の照合の API と GET /api/bank_txns の excluded・vendor_key・receipt（docs/cashflow.md §16）。
// app.request() で叩く（ポートを開かない）。摘要・取引先・金額はすべて架空の値。
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { runMatching } from '../../src/bank/match.ts';
import { insertAccount, insertBankTxn, updateAccountSettings } from '../../src/bank/repo.ts';
import { insertTransferLink } from '../../src/bank/transferRepo.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { normalizeVendor } from '../../src/vendors/normalize.ts';
import { createApp } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';

const LOCAL = '127.0.0.1:8796';
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

const headers = { Host: LOCAL, 'Tailscale-User-Login': USER, 'Content-Type': 'application/json' };
async function call<T>(method: string, p: string, status: number, body?: unknown): Promise<T> {
  const r = await app.request(`http://${LOCAL}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(r.status, status, `${method} ${p}`);
  return (await r.json()) as T;
}

function account(name = '銀行A', kind: 'bank' | 'card' = 'bank'): string {
  const id = insertAccount(db, { provider: 'fake', name, kind, source: 'csv', now: NOW }).id;
  updateAccountSettings(db, id, { defaultTag: 'business' }, NOW);
  return id;
}
function txn(accountId: string, txnDate: string, amount: number, description = 'ｶﾌｪ ﾃｽﾄ', side: 'income' | 'expense' = 'expense'): string {
  return insertBankTxn(db, { accountId, txnDate, amount, side, description, descriptionNorm: normalizeVendor(description), now: NOW }).id;
}
function doc(txnDate: string, amount: number, o: { vendor?: string; status?: string; mime?: string } = {}): string {
  const id = `D${String(++docN).padStart(4, '0')}`;
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, status, created_at)
     VALUES (?, ?, 1, ?, 'pwa', 'scan', ?, '2026-11-01', 'server', '2026-11-20', 'early', 'x', ?, ?)`,
  ).run(id, docN.toString(16).padStart(64, '0'), o.mime ?? 'image/jpeg', NOW, o.status ?? 'needs_review', NOW);
  db.prepare(
    `INSERT INTO extractions (id, document_id, engine, raw_json, txn_date, amount_total, vendor_name, created_at) VALUES (?, ?, 'gemini', '{}', ?, ?, ?, ?)`,
  ).run(`E${id}`, id, txnDate, amount, o.vendor ?? 'カフェテスト', NOW);
  return id;
}

type DocBrief = { id: string; status: string; kind: string; source: string; txn_date: string | null; amount: number | null; vendor: string | null; thumbnail_url: string | null };
type Link = { bank_txn_id: string; document_id: string; state: string; actor: string; score: number | null; created_at: string; document: DocBrief; txn: Record<string, unknown> };
type Candidate = { document_id: string; score: number; date_diff: number; vendor_match: number; document: DocBrief };
type Item = { id: string; excluded: boolean; receipt: string | null; receipt_hint: { document_id: string; status: string } | null };

describe('GET /api/bank_txns/:id/matches', () => {
  test('候補を score の高い順に返す（DocBrief。PDF はサムネイルなし）。無い明細は 404', async () => {
    const t = txn(account(), '2026-10-15', 1234);
    const near = doc('2026-10-15', 1234);
    const far = doc('2026-10-13', 1234, { vendor: '別の店', mime: 'application/pdf' });
    const r = await call<{ links: Link[]; candidates: Candidate[] }>('GET', `/api/bank_txns/${t}/matches`, 200);
    assert.deepEqual(r.links, []);
    assert.deepEqual(r.candidates, [
      {
        document_id: near, score: 100, date_diff: 0, vendor_match: 1,
        document: { id: near, status: 'needs_review', kind: 'scan', source: 'pwa', txn_date: '2026-10-15', amount: 1234, vendor: 'カフェテスト', thumbnail_url: `/api/documents/${near}/thumbnail` },
      },
      {
        document_id: far, score: 40, date_diff: 2, vendor_match: 0,
        document: { id: far, status: 'needs_review', kind: 'scan', source: 'pwa', txn_date: '2026-10-13', amount: 1234, vendor: '別の店', thumbnail_url: null },
      },
    ]);
    assert.deepEqual(await call('GET', '/api/bank_txns/NOPE/matches', 404), { error: 'not_found' });
  });
});

describe('POST /api/bank_txns/:id/matches と unlink', () => {
  test('201 で confirmed を追記し、監査に残す。2 回目は 409 already_linked', async () => {
    const t = txn(account('銀行A'), '2026-10-15', 1234);
    const d = doc('2026-10-15', 1234);
    const r = await call<{ link: Link; warnings: string[] }>('POST', `/api/bank_txns/${t}/matches`, 201, { document_id: d });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.link.state, 'confirmed');
    assert.equal(r.link.actor, 'user');
    assert.equal(r.link.score, null);
    assert.deepEqual(r.link.txn, { id: t, account_name: '銀行A', txn_date: '2026-10-15', amount: 1234, description: 'ｶﾌｪ ﾃｽﾄ' });
    assert.equal(r.link.document.id, d);
    assert.deepEqual(await call('POST', `/api/bank_txns/${t}/matches`, 409, { document_id: d }), { error: 'already_linked' });
    const a = db.prepare(`SELECT actor, entity_id, payload_json FROM audit_log WHERE action = 'txn_match.linked'`).all() as { actor: string; entity_id: string; payload_json: string }[];
    assert.equal(a.length, 1);
    assert.equal(a[0]!.actor, 'user');
    assert.deepEqual(JSON.parse(a[0]!.payload_json), { bank_txn_id: t, document_id: d, warnings: [], user: USER });
    const links = await call<{ links: Link[] }>('GET', `/api/documents/${d}/matches`, 200);
    assert.deepEqual(links.links.map((l) => [l.bank_txn_id, l.state]), [[t, 'confirmed']]);
  });

  test('金額・日付が外れていても紐付け、warnings に amount_mismatch・date_out_of_window', async () => {
    const t = txn(account(), '2026-10-15', 1234);
    const d = doc('2026-09-01', 1000);
    const r = await call<{ link: Link; warnings: string[] }>('POST', `/api/bank_txns/${t}/matches`, 201, { document_id: d });
    assert.deepEqual(r.warnings, ['amount_mismatch', 'date_out_of_window']);
  });

  test('404 not_found・document_not_found、422 document_not_matchable、400 document_id_required', async () => {
    const t = txn(account(), '2026-10-15', 1234);
    const d = doc('2026-10-15', 1234);
    assert.deepEqual(await call('POST', '/api/bank_txns/NOPE/matches', 404, { document_id: d }), { error: 'not_found' });
    assert.deepEqual(await call('POST', `/api/bank_txns/${t}/matches`, 404, { document_id: 'NOPE' }), { error: 'document_not_found' });
    for (const status of ['rejected', 'duplicate', 'personal']) {
      const x = doc('2026-10-15', 1234, { status });
      assert.deepEqual(await call('POST', `/api/bank_txns/${t}/matches`, 422, { document_id: x }), { error: 'document_not_matchable' }, status);
    }
    assert.deepEqual(await call('POST', `/api/bank_txns/${t}/matches`, 400, {}), { error: 'document_id_required' });
    assert.equal((db.prepare('SELECT count(*) n FROM txn_matches').get() as { n: number }).n, 0);
  });

  test('unlink → rejected を追記し監査に残す。2 回目は 409 not_linked。自動照合で作り直さない', async () => {
    const t = txn(account(), '2026-10-15', 1234);
    const d = doc('2026-10-15', 1234);
    assert.equal(runMatching(db, T0).length, 1);
    const r = await call<{ link: Link }>('POST', `/api/bank_txns/${t}/matches/${d}/unlink`, 200);
    assert.equal(r.link.state, 'rejected');
    assert.equal(r.link.actor, 'user');
    assert.deepEqual(await call('POST', `/api/bank_txns/${t}/matches/${d}/unlink`, 409), { error: 'not_linked' });
    assert.deepEqual(await call('POST', `/api/bank_txns/NOPE/matches/${d}/unlink`, 404), { error: 'not_found' });
    assert.deepEqual(await call('POST', `/api/bank_txns/${t}/matches/NOPE/unlink`, 404), { error: 'document_not_found' });
    assert.deepEqual(runMatching(db, T0), []);
    assert.deepEqual((db.prepare('SELECT state, actor FROM txn_matches ORDER BY seq').all() as { state: string; actor: string }[]).map((x) => [x.state, x.actor]), [['auto', 'system'], ['rejected', 'user']]);
    const a = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'txn_match.unlinked'`).all() as { payload_json: string }[];
    assert.deepEqual(a.map((x) => JSON.parse(x.payload_json)), [{ bank_txn_id: t, document_id: d, from: 'auto', user: USER }]);
    assert.deepEqual((await call<{ links: Link[] }>('GET', `/api/documents/${d}/matches`, 200)).links, []);
    // 外した後でも人は紐付け直せる。
    assert.equal((await call<{ link: Link }>('POST', `/api/bank_txns/${t}/matches`, 201, { document_id: d })).link.state, 'confirmed');
  });

  test('GET /api/documents/:id/matches は無い証憑で 404', async () => {
    assert.deepEqual(await call('GET', '/api/documents/NOPE/matches', 404), { error: 'not_found' });
  });
});

describe('GET /api/bank_txns の excluded・vendor_key・receipt', () => {
  function seed() {
    const a = account('銀行A');
    const b = account('銀行B');
    const waiting = txn(a, '2026-10-01', 1111, 'ｶﾌｪ ﾃｽﾄ');
    const linked = txn(a, '2026-10-02', 2222, 'ｶﾌｪ ﾃｽﾄ');
    const d = doc('2026-10-02', 2222);
    const other = txn(a, '2026-10-03', 3333, 'ﾎﾝﾔ ﾃｽﾄ');
    const out = txn(a, '2026-10-04', 5000, 'ﾌﾘｶｴ');
    const inn = txn(b, '2026-10-04', 5000, 'ﾌﾘｶｴ', 'income');
    insertTransferLink(db, { outTxnId: out, inTxnId: inn, kind: 'transfer', source: 'auto', state: 'active', now: NOW });
    runMatching(db, T0);
    return { waiting, linked, d, other, out, inn };
  }
  const ids = (p: { items: Item[] }) => p.items.map((i) => i.id);

  test('excluded=0 は振替を外し、excluded=1 は振替だけ', async () => {
    const s = seed();
    assert.deepEqual(ids(await call<{ items: Item[] }>('GET', '/api/bank_txns?excluded=1', 200)), [s.inn, s.out].sort().reverse());
    const kept = ids(await call<{ items: Item[] }>('GET', '/api/bank_txns?excluded=0', 200));
    assert.deepEqual(kept, [s.other, s.linked, s.waiting]);
  });

  test('vendor_key は description_norm の完全一致（q の部分一致とは別）', async () => {
    const s = seed();
    assert.deepEqual(ids(await call<{ items: Item[] }>('GET', `/api/bank_txns?vendor_key=${encodeURIComponent(normalizeVendor('ｶﾌｪ ﾃｽﾄ'))}`, 200)), [s.linked, s.waiting]);
    assert.deepEqual(ids(await call<{ items: Item[] }>('GET', `/api/bank_txns?vendor_key=${encodeURIComponent('カフェ')}`, 200)), []);
    assert.deepEqual(ids(await call<{ items: Item[] }>('GET', `/api/bank_txns?q=${encodeURIComponent('テスト')}`, 200)), [s.other, s.linked, s.waiting]);
  });

  test('receipt で絞り、各行に receipt・receipt_hint が付く（領収書待ちの一覧）', async () => {
    const s = seed();
    const w = await call<{ items: Item[] }>('GET', '/api/bank_txns?tag=business&side=expense&excluded=0&receipt=waiting', 200);
    assert.deepEqual(ids(w), [s.other, s.waiting]);
    const p = await call<{ items: Item[] }>('GET', '/api/bank_txns?receipt=pending_review', 200);
    assert.deepEqual(p.items.map((i) => [i.id, i.receipt, i.receipt_hint]), [[s.linked, 'pending_review', { document_id: s.d, status: 'needs_review' }]]);
    const all = await call<{ items: Item[] }>('GET', '/api/bank_txns', 200);
    const byId = new Map(all.items.map((i) => [i.id, i]));
    assert.equal(byId.get(s.out)!.receipt, null); // 振替は経費にしない
    assert.equal(byId.get(s.inn)!.receipt, null); // 入金
    assert.equal(byId.get(s.waiting)!.receipt_hint, null);
  });

  test('不正な値は 400', async () => {
    for (const [q, error] of [
      ['excluded=2', 'invalid_excluded'],
      ['excluded=true', 'invalid_excluded'],
      ['vendor_key=', 'invalid_vendor_key'],
      [`vendor_key=${'a'.repeat(201)}`, 'invalid_vendor_key'],
      ['receipt=none', 'invalid_receipt'],
    ] as const) assert.deepEqual(await call('GET', `/api/bank_txns?${q}`, 400), { error }, q);
    await call('GET', `/api/bank_txns?vendor_key=${'a'.repeat(200)}`, 200);
  });

  test('mail_hint: 領収書待ちの明細に、金額が等しく日付の幅に入る注文の確認メールの手がかり', async () => {
    const a = account('カードA', 'card');
    const t = txn(a, '2026-10-15', 1234);
    const other = txn(a, '2026-10-16', 2345);
    db.prepare(
      `INSERT INTO mail_messages (id, account_id, provider, remote_id, from_domain, subject, internal_at, received_on, state, attempts,
         hint_txn_date, hint_amount, hint_order_ref, hint_extracted_at, created_at, updated_at)
       VALUES ('M1', 'personal', 'gmail_api', 'r1', 'example.com', 'ご注文の確認', ?, '2026-10-08', 'body_only', 0, '2026-10-07', 1234, '123-0000000', ?, ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);
    const r = await call<{ items: (Item & { mail_hint: unknown })[] }>('GET', '/api/bank_txns?from=2026-10-01&to=2026-10-31', 200);
    const by = new Map(r.items.map((i) => [i.id, i]));
    assert.deepEqual(by.get(t)!.mail_hint, { mail_message_id: 'M1', account_id: 'personal', received_on: '2026-10-08', from_domain: 'example.com', subject: 'ご注文の確認', order_ref: '123-0000000' });
    assert.equal(by.get(other)!.mail_hint, null);
  });
});

describe('GET /api/bank/overview の receipt_waiting_count', () => {
  test('今日の 12 か月前の月初〜今日の、領収書待ちの経費の明細の数', async () => {
    const a = account();
    txn(a, '2025-10-31', 1001); // 期間の前
    txn(a, '2025-11-01', 1002);
    txn(a, '2026-11-08', 1003);
    txn(a, '2026-11-09', 1004); // 今日より後
    const linked = txn(a, '2026-10-02', 2222);
    await call('POST', `/api/bank_txns/${linked}/matches`, 201, { document_id: doc('2026-10-02', 2222) });
    const o = await call<{ receipt_waiting_count: number }>('GET', '/api/bank/overview', 200);
    assert.equal(o.receipt_waiting_count, 2);
  });
});
