// 要対応 API（docs/mvp-plan.md T4-5。文書単位、retry / dismiss）と紙原本の廃棄 API（T4-6）。app.request() で叩く（ポートを開かない）。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono, MiddlewareHandler } from 'hono';
import { appendAudit, verifyAudit } from '../../src/audit.ts';
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

// 文書側の要対応（upload・extract・meta）。worker の markNeedsAttention と同じ形で書く。
function attentionDoc(reason: string, o: { at?: Date; extracted?: boolean; review?: boolean; uploaded?: boolean } = {}): string {
  const at = o.at ?? T0;
  const doc = addDocument(db);
  if (o.extracted) {
    db.prepare(`INSERT INTO extractions (id, document_id, engine, raw_json, confidence, created_at) VALUES (?, ?, 'gemini', '{}', 0.9, ?)`).run(`EX${doc}`, doc, at.toISOString());
  }
  if (o.review) addReview(db, doc);
  if (o.uploaded) markUploaded(db, doc, 1);
  const from = (db.prepare('SELECT status FROM documents WHERE id = ?').get(doc) as { status: string }).status;
  db.prepare(`UPDATE documents SET status = 'needs_attention' WHERE id = ?`).run(doc);
  appendAudit(db, { actor: 'worker', action: 'document.needs_attention', entity: 'document', entityId: doc, payload: { reason, from, error: 'x' } }, at);
  return doc;
}
const docOf = (dealId: string) => (db.prepare('SELECT document_id FROM deals WHERE id = ?').get(dealId) as { document_id: string }).document_id;
const statusOf = (doc: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(doc) as { status: string }).status;
const jobsOf = (doc: string) => db.prepare(`SELECT kind, state FROM jobs WHERE ref_id = ? ORDER BY id`).all(doc).map((r) => ({ ...r })) as { kind: string; state: string }[];
const resolveDoc = (doc: string, body?: unknown) => post(`/api/documents/${doc}/attention/resolve`, body);

describe('GET /api/attention', () => {
  test('文書単位で、送信の要対応も文書側の要対応も出す。古い順・理由ごと。dismiss したものは出さない', async () => {
    const a = attentionDeal('amount_changed', T0);
    const b = attentionDoc('upload_rejected', { at: new Date(T0.getTime() + 1000) });
    const c = attentionDeal('amount_changed', new Date(T0.getTime() + 2000));
    const res = await app.request('/api/attention');
    assert.equal(res.status, 200);
    const j = (await res.json()) as { total: number; items: Record<string, any>[]; groups: { reason: string; items: { document_id: string }[] }[] };
    assert.equal(j.total, 3);
    assert.deepEqual(j.items.map((i) => i.document_id), [docOf(a), b, docOf(c)]);
    assert.deepEqual(
      j.groups.map((g) => [g.reason, g.items.map((i) => i.document_id)]),
      [
        ['amount_changed', [docOf(a), docOf(c)]],
        ['upload_rejected', [b]],
      ],
    );
    assert.equal(j.items[0].source, 'deal');
    assert.equal(j.items[0].deal_id, a);
    assert.equal(j.items[0].deal_reason, 'amount_changed');
    assert.deepEqual(j.items[0].detail, { note: 'x' });
    assert.deepEqual(j.items[0].actions, ['retry', 'dismiss']);
    assert.equal(j.items[1].source, 'document');
    assert.equal(j.items[1].kind, 'upload');
    assert.equal(j.items[1].document_reason, 'upload_rejected');
    assert.deepEqual(j.items[1].detail, { error: 'x' });

    assert.equal((await post(`/api/attention/${a}/resolve`, { action: 'dismiss', note: 'freee で直した' })).status, 200);
    assert.equal((await resolveDoc(b, { action: 'dismiss' })).status, 200);
    const j2 = (await (await app.request('/api/attention')).json()) as { total: number };
    assert.equal(j2.total, 1);
  });

  test('自動で直せない理由（backup の差分など）は dismiss だけ', async () => {
    const d = attentionDoc('remote_sha256_mismatch');
    const j = (await (await app.request('/api/attention')).json()) as { items: Record<string, any>[] };
    assert.equal(j.items[0].kind, null);
    assert.deepEqual(j.items[0].actions, ['dismiss']);
    const r = await resolveDoc(d);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'not_retryable' });
  });
});

describe('POST /api/documents/:id/attention/resolve', () => {
  test('retry（既定）: upload 系は upload_receipt を積み直し、未抽出なら received に戻す。監査に残す', async () => {
    const d = attentionDoc('upload_retries_exhausted');
    const r = await resolveDoc(d, { note: 'もう一度' });
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, any>;
    assert.equal(j.action, 'retry');
    assert.equal(j.status, 'received');
    assert.equal(j.job.kind, 'upload_receipt');
    assert.equal(statusOf(d), 'received');
    assert.deepEqual(jobsOf(d), [{ kind: 'upload_receipt', state: 'queued' }]);
    const a = db.prepare(`SELECT actor, payload_json FROM audit_log WHERE action = 'document.attention_retried'`).get() as { actor: string; payload_json: string };
    assert.equal(a.actor, 'user');
    const p = JSON.parse(a.payload_json);
    assert.equal(p.reason, 'upload_retries_exhausted');
    assert.equal(p.note, 'もう一度');
    assert.equal(p.user, 'me@example.com');
    assert.deepEqual(p.status, { from: 'needs_attention', to: 'received' });
    // もう要対応ではない
    assert.equal((await resolveDoc(d)).status, 409);
    assert.equal(verifyAudit(db).ok, true);
  });

  test('retry: extract 系は extract（抽出済みなら needs_review）、meta 系は update_receipt_meta（確定済みなら approved）', async () => {
    const e = attentionDoc('ai_schema_invalid', { extracted: true });
    assert.equal(((await (await resolveDoc(e)).json()) as any).job.kind, 'extract');
    assert.equal(statusOf(e), 'needs_review');
    const m = attentionDoc('meta_retries_exhausted', { extracted: true, review: true });
    assert.equal(((await (await resolveDoc(m)).json()) as any).job.kind, 'update_receipt_meta');
    assert.equal(statusOf(m), 'approved');
    // 再認可は証憑が freee にあれば meta、無ければ upload
    const u = attentionDoc('freee_reauth_required');
    const um = attentionDoc('freee_reauth_required', { uploaded: true, review: true });
    assert.equal(((await (await resolveDoc(u)).json()) as any).job.kind, 'upload_receipt');
    assert.equal(((await (await resolveDoc(um)).json()) as any).job.kind, 'update_receipt_meta');
  });

  test('retry: deal 系は send_deal を積み、確定済みなら approved に戻す。queued のジョブがあれば積まずに今すぐにする', async () => {
    const id = attentionDeal('send_rejected');
    const doc = docOf(id);
    db.prepare(`INSERT INTO jobs (kind, ref_id, state, attempts, max_attempts, run_after, created_at, updated_at) VALUES ('send_deal', ?, 'queued', 3, 6, '2099-01-01T00:00:00.000Z', ?, ?)`).run(doc, T0.toISOString(), T0.toISOString());
    const r = await post(`/api/attention/${id}/resolve`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, any>;
    assert.equal(j.id, id);
    assert.equal(j.document_id, doc);
    assert.equal(j.job.kind, 'send_deal');
    assert.equal(statusOf(doc), 'approved');
    const jobs = db.prepare(`SELECT run_after FROM jobs WHERE ref_id = ?`).all(doc).map((r) => ({ ...r }));
    assert.deepEqual(jobs, [{ run_after: T0.toISOString() }]);
    // deals 行も requeueDeal で queued に戻す（監査に deal.queued）
    assert.equal((db.prepare('SELECT state FROM deals WHERE id = ?').get(id) as { state: string }).state, 'queued');
    const q = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'deal.queued' AND entity_id = ? ORDER BY seq DESC LIMIT 1`).get(id) as { payload_json: string };
    assert.equal(JSON.parse(q.payload_json).reason, 'user_retry');
    assert.equal(verifyAudit(db).ok, true);
  });

  test('retry: freee に取引がある送信の要対応は 409 not_retryable と理由。何も変えない', async () => {
    const id = attentionDeal('amount_changed');
    db.prepare(`UPDATE deals SET remote_deal_id = '21' WHERE id = ?`).run(id);
    const doc = docOf(id);
    const r = await post(`/api/attention/${id}/resolve`);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'not_retryable', hint: 'freee に取引がある。照合で確認する' });
    assert.equal((await resolveDoc(doc)).status, 409);
    assert.equal((db.prepare('SELECT state FROM deals WHERE id = ?').get(id) as { state: string }).state, 'needs_attention');
    assert.equal(statusOf(doc), 'needs_attention');
    assert.deepEqual(jobsOf(doc), []);
    assert.equal((db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'document.attention_retried'`).get() as { n: number }).n, 0);
  });

  test('dismiss: 状態は needs_attention のまま。送信の要対応なら deals.attention_resolved_at も入れる。2 回目は 409、無い ID は 404', async () => {
    const id = attentionDeal('receipt_detached');
    const doc = docOf(id);
    const res = await post(`/api/attention/${id}/resolve`, { action: 'dismiss', note: '付け直した' });
    assert.equal(res.status, 200);
    const j = (await res.json()) as Record<string, any>;
    assert.equal(j.id, id);
    assert.equal(j.resolved_at, T0.toISOString());
    assert.equal(j.status, 'needs_attention');
    const a = db.prepare(`SELECT actor, payload_json FROM audit_log WHERE action = 'deal.attention_resolved'`).get() as { actor: string; payload_json: string };
    assert.equal(a.actor, 'user');
    assert.deepEqual(JSON.parse(a.payload_json), { document_id: doc, note: '付け直した', reason: 'receipt_detached', user: 'me@example.com' });
    assert.equal((db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'document.attention_dismissed'`).get() as { n: number }).n, 1);
    const st = db.prepare('SELECT state, attention_resolved_at FROM deals WHERE id = ?').get(id) as { state: string; attention_resolved_at: string };
    assert.equal(st.state, 'needs_attention');
    assert.equal(st.attention_resolved_at, T0.toISOString());
    assert.equal(statusOf(doc), 'needs_attention');
    assert.equal((await post(`/api/attention/${id}/resolve`, { action: 'dismiss' })).status, 409);
    assert.equal((await resolveDoc(doc, { action: 'dismiss' })).status, 409);
    assert.equal((await post('/api/attention/nope/resolve')).status, 404);
    assert.equal((await resolveDoc('nope')).status, 404);
    assert.equal(verifyAudit(db).ok, true);
  });

  test('要対応でないものは 409、action・note が不正なら 400、JSON でなければ 400', async () => {
    const doc = addDocument(db);
    const rid = addReview(db, doc);
    const row = ensureDealRow(db, { documentId: doc, reviewId: rid, provider: 'freee', draft: { refNumber: `kh-${doc}`, issueDate: '2026-10-15', details: [], receiptIds: [], payment: { kind: 'cash' } } }, T0);
    assert.equal((await post(`/api/attention/${row.id}/resolve`)).status, 409);
    assert.equal((await resolveDoc(doc)).status, 409);
    const id = attentionDeal('deal_missing');
    assert.equal((await post(`/api/attention/${id}/resolve`, { note: 'a'.repeat(501) })).status, 400);
    assert.equal((await post(`/api/attention/${id}/resolve`, { action: 'ignore' })).status, 400);
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
