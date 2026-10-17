// update_receipt_meta ジョブ（docs/mvp-plan.md T2-12、R11）。fake の Provider を使う。DB は一時ディレクトリ。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ulid } from '../../src/db/ids.ts';
import { migrate } from '../../src/db/migrate.ts';
import { enqueue, getJob } from '../../src/jobs/queue.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake/index.ts';
import { UPLOAD_WAIT_MS, createUpdateReceiptMetaHandler } from '../../src/worker/handlers/updateReceiptMeta.ts';

const T0 = new Date('2026-10-16T03:00:00.000Z'); // JST 2026-10-16
const REG_NO = 'T9995784636321';
let root: string;
let n = 0;
let db: Db;
let fake: FakeProvider;
let clock: Date;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-meta-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  fake = createFakeProvider();
  clock = T0;
});

// 文書・アップロード済みの証憑（fake にも 1 件）・抽出を作る。
async function setup(opts: { metaDeadlineOn?: string; uploaded?: boolean } = {}): Promise<{ id: string; receiptId: number }> {
  const id = ulid(T0.getTime());
  const iso = T0.toISOString();
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, status, created_at)
     VALUES (?, ?, 1, 'image/jpeg', 'pwa', 'scan', ?, '2026-10-16', 'server', '2026-10-26', 'early', 'k', 'confirmed', ?)`,
  ).run(id, id.padEnd(64, '0'), iso, iso);
  const r = await fake.uploadReceipt({ bytes: Buffer.from([1]), fileName: 'a.jpg', mime: 'image/jpeg', key: `kh-${id}` });
  const uploaded = opts.uploaded ?? true;
  db.prepare(
    `INSERT INTO provider_uploads (id, document_id, provider, state, remote_receipt_id, meta_deadline_on, uploaded_at, created_at) VALUES (?, ?, 'freee', ?, ?, ?, ?, ?)`,
  ).run(ulid(), id, uploaded ? 'uploaded' : 'queued', uploaded ? String(r.id) : null, opts.metaDeadlineOn ?? '2026-12-25', uploaded ? iso : null, iso);
  db.prepare(
    `INSERT INTO extractions (id, document_id, engine, raw_json, invoice_reg_no, created_at) VALUES (?, ?, 'gemini', '{}', ?, ?)`,
  ).run(ulid(), id, REG_NO, iso);
  return { id, receiptId: r.id };
}

function review(id: string, version: number, over: Record<string, unknown> = {}) {
  const v = { txn_date: '2026-10-15', amount: 1100, vendor: 'テスト文具店', decision: 'approve', ...over };
  db.prepare(`INSERT INTO reviews (id, document_id, version, txn_date, amount, vendor, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ulid(), id, version, v.txn_date, v.amount, v.vendor, v.decision, clock.toISOString(),
  );
}

const handlers = () => ({ update_receipt_meta: createUpdateReceiptMetaHandler(() => ({ provider: fake })) });
const run = () => runUntilEmpty(db, handlers(), { now: () => clock });
const puts = () => fake.calls.filter((c) => c.method === 'updateReceiptMeta');
const status = (id: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status;
const metaState = (id: string) => (db.prepare('SELECT meta_state FROM provider_uploads WHERE document_id = ?').get(id) as { meta_state: string }).meta_state;

describe('update_receipt_meta', () => {
  test('approve の後に発行元・発行日・金額・登録番号・qualified_invoice を PUT し、meta_state = sent', async () => {
    const { id, receiptId } = await setup();
    review(id, 1);
    enqueue(db, 'update_receipt_meta', id, { now: clock });
    assert.deepEqual(await run(), { done: 1, failed: 0 });
    assert.equal(puts().length, 1);
    assert.deepEqual(puts()[0].args, [
      receiptId,
      { partnerName: 'テスト文具店', issueDate: '2026-10-15', amount: 1100, invoiceRegistrationNumber: REG_NO, qualifiedInvoice: 'qualified' },
    ]);
    assert.equal(fake.state.receipts.get(receiptId)!.meta.amount, 1100);
    assert.equal(metaState(id), 'sent');
    assert.equal(verifyAudit(db).ok, true);
  });

  test('2 回の訂正は 2 回の PUT になる（同じ版は再送しない）', async () => {
    const { id, receiptId } = await setup();
    review(id, 1);
    enqueue(db, 'update_receipt_meta', id, { now: clock });
    await run();
    review(id, 2, { amount: 1200 });
    enqueue(db, 'update_receipt_meta', id, { now: clock });
    await run();
    review(id, 3, { amount: 1300, vendor: 'テスト文具店 本店' });
    enqueue(db, 'update_receipt_meta', id, { now: clock });
    enqueue(db, 'update_receipt_meta', id, { now: clock }); // 同じ版の重複
    await run();
    assert.deepEqual(puts().map((c) => (c.args[1] as { amount: number }).amount), [1100, 1200, 1300]);
    assert.equal(puts().length - 1, 2); // 訂正 2 回 = 追加の PUT 2 回
    assert.equal(fake.state.receipts.get(receiptId)!.meta.partnerName, 'テスト文具店 本店');
  });

  test('登録番号が無ければ qualified_invoice = unselected で、登録番号は送らない', async () => {
    const { id } = await setup();
    db.prepare(`INSERT INTO extractions (id, document_id, engine, raw_json, invoice_reg_no, created_at) VALUES (?, ?, 'gemini', '{}', NULL, ?)`).run(
      ulid(), id, new Date(T0.getTime() + 1000).toISOString(),
    );
    review(id, 1);
    enqueue(db, 'update_receipt_meta', id, { now: clock });
    await run();
    assert.deepEqual(puts()[0].args[1], { partnerName: 'テスト文具店', issueDate: '2026-10-15', amount: 1100, qualifiedInvoice: 'unselected' });
  });

  test('meta_deadline_on を過ぎていれば PUT せず needs_attention: meta_deadline_passed', async () => {
    const { id } = await setup({ metaDeadlineOn: '2026-10-15' });
    review(id, 1);
    const job = enqueue(db, 'update_receipt_meta', id, { now: clock });
    assert.deepEqual(await run(), { done: 1, failed: 0 });
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(puts().length, 0);
    assert.equal(status(id), 'needs_attention');
    const p = JSON.parse((db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'document.needs_attention'`).get() as { payload_json: string }).payload_json);
    assert.equal(p.reason, 'meta_deadline_passed');
    assert.equal(metaState(id), 'none');
  });

  test('期限の当日はまだ送る', async () => {
    const { id } = await setup({ metaDeadlineOn: '2026-10-16' });
    review(id, 1);
    enqueue(db, 'update_receipt_meta', id, { now: clock });
    await run();
    assert.equal(puts().length, 1);
  });

  test('approve でなければ送らない', async () => {
    const { id } = await setup();
    review(id, 1, { decision: 'personal' });
    enqueue(db, 'update_receipt_meta', id, { now: clock });
    assert.deepEqual(await run(), { done: 1, failed: 0 });
    assert.equal(puts().length, 0);
  });

  test('証憑が未アップロードなら回数を数えずに 10 分後へ延期し、上がったら送る', async () => {
    const a = await setup({ uploaded: false });
    review(a.id, 1);
    const j1 = enqueue(db, 'update_receipt_meta', a.id, { now: clock });
    for (let i = 0; i < 8; i++) {
      assert.deepEqual(await runUntilEmpty(db, handlers(), { now: () => new Date(clock.getTime() + i * UPLOAD_WAIT_MS) }), { done: 0, failed: 0 });
    }
    const j = getJob(db, j1)!;
    assert.equal(j.state, 'queued');
    assert.equal(j.attempts, 0);
    assert.equal(j.run_after, new Date(clock.getTime() + 8 * UPLOAD_WAIT_MS).toISOString());
    assert.match(j.last_error!, /^upload_pending/);
    db.prepare(`UPDATE provider_uploads SET state = 'uploaded', remote_receipt_id = '1', uploaded_at = ? WHERE document_id = ?`).run(clock.toISOString(), a.id);
    assert.deepEqual(await runUntilEmpty(db, handlers(), { now: () => new Date(clock.getTime() + 8 * UPLOAD_WAIT_MS) }), { done: 1, failed: 0 });
    assert.equal(puts().length, 1);
    assert.equal(status(a.id), 'confirmed');
  });

  test('未アップロードのまま meta_deadline_on（無ければ受領日 + 70 日）を過ぎたら needs_attention で終える', async () => {
    const a = await setup({ uploaded: false });
    db.prepare('UPDATE provider_uploads SET meta_deadline_on = NULL WHERE document_id = ?').run(a.id);
    review(a.id, 1);
    const j1 = enqueue(db, 'update_receipt_meta', a.id, { now: clock });
    clock = new Date('2026-12-25T03:00:00.000Z'); // 受領日 10/16 + 70 日 = 12/25 の当日はまだ待つ
    db.prepare('UPDATE jobs SET run_after = ?').run(clock.toISOString());
    assert.deepEqual(await run(), { done: 0, failed: 0 });
    clock = new Date('2026-12-26T03:00:00.000Z');
    db.prepare('UPDATE jobs SET run_after = ?').run(clock.toISOString());
    assert.deepEqual(await run(), { done: 1, failed: 0 });
    assert.equal(getJob(db, j1)!.state, 'done');
    assert.equal(status(a.id), 'needs_attention');
    assert.equal(puts().length, 0);
  });

  test('freee の一時的な失敗は再試行、4xx は needs_attention', async () => {

    const b = await setup();
    review(b.id, 1);
    fake.failNext('server');
    const j2 = enqueue(db, 'update_receipt_meta', b.id, { now: clock });
    assert.deepEqual(await run(), { done: 0, failed: 1 });
    assert.equal(getJob(db, j2)!.state, 'queued');
    assert.equal(status(b.id), 'confirmed');
    db.prepare('DELETE FROM jobs').run();

    fake.failNext('client');
    enqueue(db, 'update_receipt_meta', b.id, { now: clock });
    assert.deepEqual(await run(), { done: 0, failed: 1 });
    assert.equal(status(b.id), 'needs_attention');
  });
});
