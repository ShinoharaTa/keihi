// 送信の状態機械と send_deal ジョブ（docs/mvp-plan.md T4-2・T4-3）。fake の Provider の障害注入で確かめる。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import type { Db } from '../../src/db/index.ts';
import { canTransition, DEAL_STATES, dealRowForDocument, type DealState } from '../../src/deals/stateMachine.ts';
import { enqueue, getJob } from '../../src/jobs/queue.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { applyMasterItems } from '../../src/masters/sync.ts';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake/index.ts';
import { createSendDealHandler } from '../../src/worker/handlers/send.ts';
import type { TaxResolver } from '../../src/deals/builder.ts';
import { addDocument, addReview, markUploaded, openTestDb, T0 } from './deals-helpers.ts';

const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const SEND = 'send_deal';
const resolveTax: TaxResolver = (cat) => ({ taxable_10: 1, taxable_8_reduced: 2, non_taxable: 4, out_of_scope: 3 })[cat];

let root: string;
let n = 0;
let db: Db;
let fake: FakeProvider;
let clock: Date;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-send-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  db = openTestDb(path.join(root, `${n++}.db`));
  applyMasterItems(db, 'freee', 'account', [{ remoteId: '104', name: '事業主貸', data: {} }], T0.toISOString());
  fake = createFakeProvider();
  clock = T0;
});

const handlers = () => ({ send_deal: createSendDealHandler(() => ({ provider: fake, resolveTax })) });
async function runAt(min: number) {
  clock = at(min);
  return runUntilEmpty(db, handlers(), { now: () => clock });
}

// 証憑を fake に上げ、provider_uploads に記録する（upload_receipt ジョブの代わり）。
async function uploadReceipt(docId: string): Promise<number> {
  const r = await fake.uploadReceipt({ bytes: Buffer.from('x'), fileName: 'a.jpg', mime: 'image/jpeg', key: `kh-${docId}` });
  markUploaded(db, docId, r.id);
  fake.calls.length = 0;
  return r.id;
}

function setup(o: { uploaded?: boolean } = {}) {
  const doc = addDocument(db);
  addReview(db, doc, { amount: 1100, taxId: '1' });
  return { doc, upload: o.uploaded === false ? Promise.resolve(null) : uploadReceipt(doc) };
}

const methods = () => fake.calls.map((c) => `${c.method}:${c.outcome}`);
const deal = (doc: string) => dealRowForDocument(db, doc, 'freee')!;
const docStatus = (doc: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(doc) as { status: string }).status;
const actions = () => (db.prepare('SELECT action FROM audit_log ORDER BY seq').all() as { action: string }[]).map((r) => r.action);

describe('状態機械', () => {
  test('許す遷移だけ', () => {
    const ok: [DealState, DealState][] = [
      ['queued', 'sending'],
      ['sending', 'deal_created'],
      ['sending', 'sending'],
      ['deal_created', 'receipt_linked'],
      ['receipt_linked', 'verified'],
      ['verified', 'needs_attention'],
    ];
    for (const [a, b] of ok) assert.equal(canTransition(a, b), true, `${a} → ${b}`);
    const ng: [DealState, DealState][] = [
      ['queued', 'deal_created'],
      ['deal_created', 'verified'],
      ['verified', 'sending'],
      ['receipt_linked', 'deal_created'],
    ];
    for (const [a, b] of ng) assert.equal(canTransition(a, b), false, `${a} → ${b}`);
    for (const s of DEAL_STATES) assert.equal(canTransition('needs_attention', s), false);
  });
});

describe('send_deal', () => {
  test('成功: 証憑付きで 1 回作り receipt_linked。未決済・ref_number・監査ログ', async () => {
    const { doc, upload } = setup();
    const rid = await upload;
    enqueue(db, SEND, doc, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 1, failed: 0 });
    assert.deepEqual(methods(), ['createExpenseDeal:ok']);
    const d = fake.state.deals.get(1)!;
    assert.equal(d.refNumber, `kh-${doc}`);
    assert.equal(d.settled, false);
    assert.deepEqual(d.receiptIds, [rid]);
    assert.deepEqual(d.details, [{ accountItemId: 101, taxCode: 1, amount: 1100 }]);
    const row = deal(doc);
    assert.equal(row.state, 'receipt_linked');
    assert.equal(row.remote_deal_id, '1');
    assert.equal(row.attempts, 1);
    assert.equal(docStatus(doc), 'sent');
    assert.deepEqual(
      actions().filter((a) => a.startsWith('deal.')),
      ['deal.queued', 'deal.sending', 'deal.deal_created', 'deal.receipt_linked'],
    );
    assert.equal(verifyAudit(db).ok, true);
  });

  test('証憑がまだ: 取引を先に作り deal_created。アップロード後の再実行で attachReceipts → receipt_linked', async () => {
    const doc = addDocument(db);
    addReview(db, doc);
    enqueue(db, SEND, doc, { now: T0 });
    await runAt(0);
    assert.equal(deal(doc).state, 'deal_created');
    assert.deepEqual(fake.state.deals.get(1)!.receiptIds, []);
    const rid = await uploadReceipt(doc);
    enqueue(db, SEND, doc, { now: at(10) });
    await runAt(10);
    assert.deepEqual(methods(), ['attachReceipts:ok']);
    assert.equal(deal(doc).state, 'receipt_linked');
    assert.deepEqual(fake.state.deals.get(1)!.receiptIds, [rid]);
    assert.equal(fake.state.deals.size, 1);
  });

  test('タイムアウトだが成功: 再送の前に発生日の範囲で一覧を取り、ref_number で既存を採用（取引は 1 件）', async () => {
    const { doc, upload } = setup();
    await upload;
    fake.failNext('timeout', { butSucceed: true });
    const job = enqueue(db, SEND, doc, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 0, failed: 1 });
    assert.equal(deal(doc).state, 'sending');
    assert.equal(getJob(db, job)!.run_after, at(1).toISOString()); // バックオフ 1 分
    assert.deepEqual(await runAt(1), { done: 1, failed: 0 });
    assert.deepEqual(methods(), ['createExpenseDeal:timeout', 'listDeals:ok']);
    assert.deepEqual(fake.calls[1].args, [{ startIssueDate: '2026-10-15', endIssueDate: '2026-10-15' }]); // ref_number では絞らない
    assert.equal(fake.state.deals.size, 1);
    assert.equal(deal(doc).state, 'receipt_linked');
    assert.equal(deal(doc).attempts, 1);
  });

  test('タイムアウト（届いていない）: 一覧に無ければ送り直す', async () => {
    const { doc, upload } = setup();
    await upload;
    fake.failNext('timeout');
    enqueue(db, SEND, doc, { now: T0 });
    await runAt(0);
    await runAt(1);
    assert.deepEqual(methods(), ['createExpenseDeal:timeout', 'listDeals:ok', 'createExpenseDeal:ok']);
    assert.equal(fake.state.deals.size, 1);
    assert.equal(deal(doc).attempts, 2);
  });

  test('5xx が 2 回: 1 → 5 分のバックオフで 3 回目に成功', async () => {
    const { doc, upload } = setup();
    await upload;
    fake.failNext('server', { times: 2 });
    const job = enqueue(db, SEND, doc, { now: T0 });
    await runAt(0);
    await runAt(1);
    assert.equal(getJob(db, job)!.run_after, at(1 + 5).toISOString());
    await runAt(6);
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(deal(doc).state, 'receipt_linked');
    assert.equal(fake.state.deals.size, 1);
  });

  test('403（使用制限）は再試行に回す', async () => {
    const { doc, upload } = setup();
    await upload;
    fake.failNext('usage_limited');
    const job = enqueue(db, SEND, doc, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 0, failed: 1 });
    assert.equal(getJob(db, job)!.state, 'queued');
    assert.notEqual(deal(doc).state, 'needs_attention');
    await runAt(1);
    assert.equal(deal(doc).state, 'receipt_linked');
  });

  test('4xx: 再送せず needs_attention（ジョブは完了）', async () => {
    const { doc, upload } = setup();
    await upload;
    fake.failNext('client');
    const job = enqueue(db, SEND, doc, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 1, failed: 0 });
    assert.equal(getJob(db, job)!.state, 'done');
    const row = deal(doc);
    assert.equal(row.state, 'needs_attention');
    assert.equal(row.attention_reason, 'send_rejected');
    assert.match(row.last_error!, /client\(400\)/);
    assert.equal(docStatus(doc), 'needs_attention');
    await runAt(200);
    assert.deepEqual(methods(), ['createExpenseDeal:client']);
  });

  test('401 invalid_grant: freee_reauth_required', async () => {
    const { doc, upload } = setup();
    await upload;
    fake.failNext('auth_invalid_grant');
    enqueue(db, SEND, doc, { now: T0 });
    await runAt(0);
    assert.equal(deal(doc).attention_reason, 'freee_reauth_required');
  });

  test('最大 6 回で諦めて needs_attention（send_retries_exhausted）、ジョブは failed', async () => {
    const { doc, upload } = setup();
    await upload;
    fake.failNext('server', { times: 6 });
    const job = enqueue(db, SEND, doc, { now: T0 });
    for (const m of [0, 1, 6, 36, 156, 276]) await runAt(m);
    assert.equal(getJob(db, job)!.state, 'failed');
    assert.equal(deal(doc).state, 'needs_attention');
    assert.equal(deal(doc).attention_reason, 'send_retries_exhausted');
    assert.equal(fake.state.deals.size, 0);
  });

  test('一覧に同じ ref_number が 2 件: 小さい ID を採用して duplicate_deals', async () => {
    const { doc, upload } = setup();
    await upload;
    fake.failNext('timeout', { butSucceed: true });
    enqueue(db, SEND, doc, { now: T0 });
    await runAt(0);
    await fake.createExpenseDeal({ issueDate: '2026-10-15', refNumber: `kh-${doc}`, details: [{ accountItemId: 101, taxCode: 1, amount: 1100 }] });
    await runAt(1);
    const row = deal(doc);
    assert.equal(row.remote_deal_id, '1');
    assert.equal(row.attention_reason, 'duplicate_deals');
    assert.ok(actions().includes('deal.duplicate_found'));
  });

  test('最新の版が approve でなければ送らない', async () => {
    const doc = addDocument(db);
    addReview(db, doc, { version: 1 });
    addReview(db, doc, { version: 2, decision: 'personal' });
    enqueue(db, SEND, doc, { now: T0 });
    await runAt(0);
    assert.deepEqual(methods(), []);
    assert.equal(dealRowForDocument(db, doc, 'freee'), null);
    assert.ok(actions().includes('deal.skipped'));
  });

  test('送った後に確定版が変わったら上書きせず needs_attention', async () => {
    const { doc, upload } = setup();
    await upload;
    enqueue(db, SEND, doc, { now: T0 });
    await runAt(0);
    addReview(db, doc, { version: 2, amount: 2200 });
    enqueue(db, SEND, doc, { now: at(5) });
    await runAt(5);
    assert.equal(deal(doc).attention_reason, 'review_changed_after_send');
    assert.equal(fake.state.deals.get(1)!.amount, 1100);
    assert.deepEqual(methods(), ['createExpenseDeal:ok']);
  });

  test('取引を作れない確定版（事業主貸が無いのに按分 50）: build_failed で送らない', async () => {
    db.prepare(`INSERT INTO provider_master_versions (provider, kind, remote_id, name, data_json, data_sha256, fetched_at, retired_at) VALUES ('freee', 'account', '104', '事業主貸', '{}', 'x', ?, ?)`).run(at(1).toISOString(), at(1).toISOString());
    const doc = addDocument(db);
    addReview(db, doc, { prorationPct: 50 });
    enqueue(db, SEND, doc, { now: T0 });
    await runAt(0);
    assert.deepEqual(methods(), []);
    assert.equal(deal(doc).attention_reason, 'build_failed');
  });

  test('同じ文書のジョブを 2 回積んでも取引は 1 件', async () => {
    const { doc, upload } = setup();
    await upload;
    enqueue(db, SEND, doc, { now: T0 });
    enqueue(db, SEND, doc, { now: T0 });
    await runAt(0);
    assert.equal(fake.state.deals.size, 1);
    assert.equal((db.prepare('SELECT count(*) n FROM deals').get() as { n: number }).n, 1);
  });
});
