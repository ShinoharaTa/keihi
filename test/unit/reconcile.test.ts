// 日次照合（docs/mvp-plan.md T4-4）。「証憑が外れた」「金額が変わった」「取引が消えた」が needs_attention になる。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Db } from '../../src/db/index.ts';
import { compareDeal } from '../../src/deals/reconcile.ts';
import { dealRowForDocument } from '../../src/deals/stateMachine.ts';
import type { TaxResolver } from '../../src/deals/builder.ts';
import { enqueue, getJob } from '../../src/jobs/queue.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { applyMasterItems } from '../../src/masters/sync.ts';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake/index.ts';
import type { Deal } from '../../src/providers/types.ts';
import { createReconcileHandler } from '../../src/worker/handlers/reconcile.ts';
import { createSendDealHandler } from '../../src/worker/handlers/send.ts';
import { addDocument, addReview, markUploaded, openTestDb, T0 } from './deals-helpers.ts';

const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const resolveTax: TaxResolver = (cat) => ({ taxable_10: 1, taxable_8_reduced: 2, non_taxable: 4, out_of_scope: 3 })[cat];

let root: string;
let n = 0;
let db: Db;
let fake: FakeProvider;
let clock: Date;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-reconcile-'));
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

const handlers = () => ({
  send_deal: createSendDealHandler(() => ({ provider: fake, resolveTax })),
  reconcile_deals: createReconcileHandler(() => ({ provider: fake })),
});
async function runAt(min: number) {
  clock = at(min);
  return runUntilEmpty(db, handlers(), { now: () => clock });
}

async function sentDocument(o: { uploaded?: boolean; txnDate?: string } = {}): Promise<string> {
  const doc = addDocument(db);
  addReview(db, doc, { amount: 1100, taxId: '1', txnDate: o.txnDate });
  if (o.uploaded !== false) {
    const r = await fake.uploadReceipt({ bytes: Buffer.from('x'), fileName: 'a.jpg', mime: 'image/jpeg', key: `kh-${doc}` });
    markUploaded(db, doc, r.id);
  }
  enqueue(db, 'send_deal', doc, { now: clock });
  await runAt(0);
  fake.calls.length = 0;
  return doc;
}

async function reconcile(min = 60) {
  const job = enqueue(db, 'reconcile_deals', null, { now: at(min) });
  const s = await runAt(min);
  return { job, s };
}

const row = (doc: string) => dealRowForDocument(db, doc, 'freee')!;
const remote = (doc: string) => fake.state.deals.get(Number(row(doc).remote_deal_id))!;

describe('reconcile_deals', () => {
  test('一致なら verified（documents.status も verified）。一覧 1 回で済む', async () => {
    const a = await sentDocument();
    const b = await sentDocument({ txnDate: '2026-10-10' });
    await reconcile();
    assert.equal(row(a).state, 'verified');
    assert.equal(row(b).state, 'verified');
    assert.ok(row(a).verified_at);
    assert.deepEqual(
      fake.calls.map((c) => c.method),
      ['listDeals'],
    );
    assert.deepEqual(fake.calls[0].args, [{ startIssueDate: '2026-10-10', endIssueDate: '2026-10-15' }]);
    assert.equal((db.prepare('SELECT status FROM documents WHERE id = ?').get(a) as { status: string }).status, 'verified');
  });

  test('証憑が外れた → needs_attention（receipt_detached）', async () => {
    const doc = await sentDocument();
    remote(doc).receiptIds = [];
    await reconcile();
    assert.equal(row(doc).state, 'needs_attention');
    assert.equal(row(doc).attention_reason, 'receipt_detached');
  });

  test('金額が変わった → needs_attention（amount_changed）。freee 側は上書きしない', async () => {
    const doc = await sentDocument();
    const d = remote(doc);
    d.details[0].amount = 1000;
    d.amount = 1000;
    await reconcile();
    assert.equal(row(doc).attention_reason, 'amount_changed');
    assert.equal(remote(doc).amount, 1000);
    assert.ok(!fake.calls.some((c) => c.method === 'attachReceipts' || c.method === 'createExpenseDeal'));
    const detail = JSON.parse(row(doc).attention_detail_json!);
    assert.deepEqual(detail.diffs[0], { kind: 'amount_changed', expected: 1100, actual: 1000 });
  });

  test('取引が消えた → needs_attention（deal_missing）。一覧に無いものは getDeal で確かめる', async () => {
    const doc = await sentDocument();
    await fake.deleteDeal(Number(row(doc).remote_deal_id));
    fake.calls.length = 0;
    await reconcile();
    assert.equal(row(doc).attention_reason, 'deal_missing');
    assert.deepEqual(
      fake.calls.map((c) => `${c.method}:${c.outcome}`),
      ['listDeals:ok', 'getDeal:client'],
    );
  });

  test('人が発生日を変えた取引（一覧の範囲外）は getDeal で見つけ、金額・科目・証憑が同じなら verified', async () => {
    const doc = await sentDocument();
    remote(doc).issueDate = '2026-09-01';
    await reconcile();
    assert.equal(row(doc).state, 'verified');
  });

  test('科目が変わった → account_changed', async () => {
    const doc = await sentDocument();
    remote(doc).details[0].accountItemId = 102;
    await reconcile();
    assert.equal(row(doc).attention_reason, 'account_changed');
  });

  test('verified の後に変わっても needs_attention に戻す。needs_attention は以後見ない', async () => {
    const doc = await sentDocument();
    await reconcile(60);
    assert.equal(row(doc).state, 'verified');
    remote(doc).receiptIds = [];
    await reconcile(120);
    assert.equal(row(doc).state, 'needs_attention');
    fake.calls.length = 0;
    await reconcile(180);
    assert.deepEqual(fake.calls, []);
  });

  test('deal_created（証憑がまだ）: アップロード済みになっていれば attachReceipts で付けてから照合', async () => {
    const doc = await sentDocument({ uploaded: false });
    assert.equal(row(doc).state, 'deal_created');
    await reconcile(30);
    assert.equal(row(doc).state, 'deal_created'); // 証憑がまだなので verified にしない
    const r = await fake.uploadReceipt({ bytes: Buffer.from('y'), fileName: 'a.jpg', mime: 'image/jpeg', key: `kh-${doc}` });
    markUploaded(db, doc, r.id);
    fake.calls.length = 0;
    await reconcile(60);
    assert.deepEqual(
      fake.calls.map((c) => c.method),
      ['attachReceipts', 'listDeals'],
    );
    assert.equal(row(doc).state, 'verified');
    assert.deepEqual(remote(doc).receiptIds, [r.id]);
  });

  test('一覧の取得が 5xx ならジョブを再試行に回す（状態は変えない）', async () => {
    const doc = await sentDocument();
    fake.failNext('server');
    const { job } = await reconcile();
    assert.equal(getJob(db, job)!.state, 'queued');
    assert.equal(row(doc).state, 'receipt_linked');
  });
});

describe('compareDeal', () => {
  const base: Deal = {
    id: 1,
    issueDate: '2026-10-15',
    refNumber: 'kh-x',
    type: 'expense',
    settled: false,
    amount: 1100,
    details: [
      { accountItemId: 101, taxCode: 1, amount: 550 },
      { accountItemId: 104, taxCode: 3, amount: 550 },
    ],
    partnerName: null,
    receiptIds: [5],
  };
  const exp = { amount: 1100, details: base.details, receiptIds: [5] };
  test('一致・税区分や取引先の違いは見ない', () => {
    assert.deepEqual(compareDeal(exp, base), []);
    assert.deepEqual(compareDeal(exp, { ...base, partnerName: 'X', details: base.details.map((d) => ({ ...d, taxCode: 9 })) }), []);
  });
  test('証憑が増えただけなら一致', () => {
    assert.deepEqual(compareDeal(exp, { ...base, receiptIds: [5, 6] }), []);
  });
  test('合計が同じでも行の金額（按分）が変われば amount_changed', () => {
    const d = { ...base, details: [{ ...base.details[0], amount: 1000 }, { ...base.details[1], amount: 100 }] };
    assert.deepEqual(compareDeal(exp, d).map((x) => x.kind), ['amount_changed']);
  });
  test('取引が無い', () => {
    assert.deepEqual(compareDeal(exp, null), [{ kind: 'deal_missing' }]);
  });
});
