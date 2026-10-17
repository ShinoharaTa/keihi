// 要対応 API（docs/mvp-plan.md T4-5）と紙原本の廃棄 API（T4-6）。app.request() で叩く（ポートを開かない）。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono, MiddlewareHandler } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import type { Db } from '../../src/db/index.ts';
import { ensureDealRow, markNeedsAttention } from '../../src/deals/stateMachine.ts';
import { createApp } from '../../src/web/app.ts';
import { addDocument, addReview, markUploaded, openTestDb, T0 } from '../unit/deals-helpers.ts';

const allow: MiddlewareHandler = async (_c, next) => next();
let root: string;
let n = 0;
let db: Db;
let app: Hono;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-attention-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  db = openTestDb(path.join(root, `${n++}.db`));
  app = createApp({
    db,
    objectsDir: path.join(root, 'objects'),
    config: { ingest: { maxBytes: 1024 }, calendar: { deadlineMode: 'early', yearEndHolidays: false }, deadline: { countFrom: 'receipt_day' } },
    auth: allow,
    triggerWorker: () => {},
    now: () => T0,
  });
});

function attentionDeal(reason: Parameters<typeof markNeedsAttention>[2], at: Date = T0): string {
  const doc = addDocument(db);
  const rid = addReview(db, doc);
  const row = ensureDealRow(db, { documentId: doc, reviewId: rid, provider: 'freee', draft: { refNumber: `kh-${doc}`, issueDate: '2026-10-15', details: [], receiptIds: [], payment: { kind: 'cash' } } }, at);
  markNeedsAttention(db, row.id, reason, { note: 'x' }, at);
  return row.id;
}

const post = (url: string, body?: unknown) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'Tailscale-User-Login': 'me@example.com' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('GET /api/attention', () => {
  test('理由ごとにまとめ、古い順。対応済みは出さない', async () => {
    const a = attentionDeal('amount_changed', T0);
    const b = attentionDeal('send_rejected', new Date(T0.getTime() + 1000));
    const c = attentionDeal('amount_changed', new Date(T0.getTime() + 2000));
    const res = await app.request('/api/attention');
    assert.equal(res.status, 200);
    const j = (await res.json()) as { total: number; groups: { reason: string; items: { id: string; detail: unknown }[] }[] };
    assert.equal(j.total, 3);
    assert.deepEqual(
      j.groups.map((g) => [g.reason, g.items.map((i) => i.id)]),
      [
        ['amount_changed', [a, c]],
        ['send_rejected', [b]],
      ],
    );
    assert.deepEqual(j.groups[0].items[0].detail, { note: 'x' });

    assert.equal((await post(`/api/attention/${a}/resolve`, { note: 'freee で直した' })).status, 200);
    const j2 = (await (await app.request('/api/attention')).json()) as { total: number };
    assert.equal(j2.total, 2);
  });
});

describe('POST /api/attention/:id/resolve', () => {
  test('対応済みにして監査ログに残す。2 回目は 409、無い ID は 404', async () => {
    const id = attentionDeal('receipt_detached');
    const res = await post(`/api/attention/${id}/resolve`, { note: '付け直した' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id, resolved_at: T0.toISOString() });
    const a = db.prepare(`SELECT actor, payload_json FROM audit_log WHERE action = 'deal.attention_resolved'`).get() as { actor: string; payload_json: string };
    assert.equal(a.actor, 'user');
    assert.deepEqual(JSON.parse(a.payload_json), { document_id: (db.prepare('SELECT document_id FROM deals WHERE id = ?').get(id) as { document_id: string }).document_id, note: '付け直した', reason: 'receipt_detached', user: 'me@example.com' });
    const st = db.prepare('SELECT state, attention_resolved_at FROM deals WHERE id = ?').get(id) as { state: string; attention_resolved_at: string };
    assert.equal(st.state, 'needs_attention');
    assert.equal(st.attention_resolved_at, T0.toISOString());
    assert.equal((await post(`/api/attention/${id}/resolve`)).status, 409);
    assert.equal((await post('/api/attention/nope/resolve')).status, 404);
    assert.equal(verifyAudit(db).ok, true);
  });

  test('要対応でないものは 409、note が長すぎれば 400、JSON でなければ 400', async () => {
    const doc = addDocument(db);
    const rid = addReview(db, doc);
    const row = ensureDealRow(db, { documentId: doc, reviewId: rid, provider: 'freee', draft: { refNumber: `kh-${doc}`, issueDate: '2026-10-15', details: [], receiptIds: [], payment: { kind: 'cash' } } }, T0);
    assert.equal((await post(`/api/attention/${row.id}/resolve`)).status, 409);
    const id = attentionDeal('deal_missing');
    assert.equal((await post(`/api/attention/${id}/resolve`, { note: 'a'.repeat(501) })).status, 400);
    const bad = await app.request(`/api/attention/${id}/resolve`, { method: 'POST', body: '{' });
    assert.equal(bad.status, 400);
  });
});

describe('POST /api/documents/:id/paper', () => {
  const allowDiscard = () => db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('paper_discard_allowed', 'true', ?)`).run(T0.toISOString());

  test('廃棄可なら廃棄済にする（監査ログ）。廃棄可でなければ 409 と理由', async () => {
    const id = addDocument(db, { integrityCheckedAt: T0.toISOString() });
    markUploaded(db, id, 1);
    const ng = await post(`/api/documents/${id}/paper`, { status: 'discarded' });
    assert.equal(ng.status, 409);
    assert.deepEqual(await ng.json(), { error: 'not_discard_ok', paper_status: 'keep_required', reasons: ['tax_advisor_pending'] });
    allowDiscard();
    const ok = await post(`/api/documents/${id}/paper`, { status: 'discarded' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id, paper_status: 'discarded' });
    assert.equal((await post(`/api/documents/${id}/paper`, { status: 'discarded' })).status, 200);
    const n = (db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'document.paper_discarded'`).get() as { n: number }).n;
    assert.equal(n, 1);
  });

  test('status が discarded 以外は 400、無い文書は 404', async () => {
    const id = addDocument(db);
    assert.equal((await post(`/api/documents/${id}/paper`, { status: 'keep_required' })).status, 400);
    assert.equal((await post('/api/documents/nope/paper', { status: 'discarded' })).status, 404);
  });
});

describe('GET /api/export/mapping.csv', () => {
  test('documents と件数が一致し、取引 ID ⇔ 証憑 ID ⇔ keihi の ID を出す', async () => {
    const a = addDocument(db, { receivedOn: '2026-10-16' });
    markUploaded(db, a, 11, '2026-10-16T04:00:00.000Z');
    const rid = addReview(db, a);
    const row = ensureDealRow(db, { documentId: a, reviewId: rid, provider: 'freee', draft: { refNumber: `kh-${a}`, issueDate: '2026-10-15', details: [], receiptIds: [], payment: { kind: 'cash' } } }, T0);
    db.prepare(`UPDATE deals SET state = 'verified', remote_deal_id = '21' WHERE id = ?`).run(row.id);
    const b = addDocument(db, { receivedOn: '2025-12-31', deadlineOn: '2026-01-13' });

    const res = await app.request('/api/export/mapping.csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/csv/);
    const lines = (await res.text()).split('\r\n');
    assert.equal(lines.at(-1), '');
    assert.equal(lines[0], 'document_id,sha256,received_on,uploaded_at,remote_receipt_id,remote_deal_id,status,paper_status');
    const body = lines.slice(1, -1);
    const docs = (db.prepare('SELECT count(*) n FROM documents').get() as { n: number }).n;
    assert.equal(body.length, docs);
    const sha = (id: string) => (db.prepare('SELECT sha256 FROM documents WHERE id = ?').get(id) as { sha256: string }).sha256;
    assert.deepEqual(body, [
      `${b},${sha(b)},2025-12-31,,,,,keep_required`,
      `${a},${sha(a)},2026-10-16,2026-10-16T04:00:00.000Z,11,21,verified,unknown`,
    ]);

    const y = await (await app.request('/api/export/mapping.csv?year=2026')).text();
    assert.equal(y.split('\r\n').length - 2, 1);
    assert.equal((await app.request('/api/export/mapping.csv?year=26')).status, 400);
  });
});
