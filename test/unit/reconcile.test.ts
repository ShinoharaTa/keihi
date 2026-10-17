// 日次照合（docs/mvp-plan.md T4-4）。「証憑が外れた」「金額が変わった」「取引が消えた」が needs_attention になる。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Db } from '../../src/db/index.ts';
import { compareDeal, reconcileDeals } from '../../src/deals/reconcile.ts';
import { dealRowForDocument } from '../../src/deals/stateMachine.ts';
import type { TaxResolver } from '../../src/deals/builder.ts';
import { enqueue, getJob } from '../../src/jobs/queue.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { applyMasterItems } from '../../src/masters/sync.ts';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake/index.ts';
import { ProviderError, type Deal } from '../../src/providers/types.ts';
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
  applyMasterItems(db, 'freee', 'walletable', [{ remoteId: 'wallet:9', name: '現金', data: { id: 9, type: 'wallet', name: '現金' } }], T0.toISOString());
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
    assert.deepEqual(fake.calls[0].args, [{ startIssueDate: '2026-10-10', endIssueDate: '2026-10-15', limit: 100, offset: 0 }]);
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

  test('取引ごとの 5xx は飛ばして続け、最後にまとめて再試行に回す（照合できた分は進める）', async () => {
    const a = await sentDocument({ txnDate: '2026-10-10' });
    const b = await sentDocument({ txnDate: '2026-10-15' });
    remote(a).issueDate = '2026-09-01'; // 一覧から外れて getDeal になる
    fake.calls.length = 0;
    const job = enqueue(db, 'reconcile_deals', null, { now: at(60) });
    clock = at(60);
    // 一覧は成功させ、getDeal（a）だけ 5xx にする
    const origGet = fake.getDeal;
    fake.getDeal = async () => {
      throw new ProviderError('server', 'boom', { status: 503 });
    };
    await runUntilEmpty(db, handlers(), { now: () => clock });
    fake.getDeal = origGet;
    assert.equal(getJob(db, job)!.state, 'queued');
    assert.equal(row(a).state, 'receipt_linked');
    assert.equal(row(b).state, 'verified');
    const audit = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'deals.reconciled'`).get() as { payload_json: string };
    const p = JSON.parse(audit.payload_json);
    assert.equal(p.verified, 1);
    assert.equal(p.failed, 1);
    assert.equal(p.errors[0].dealId, row(a).id);
  });

  test('取引ごとの 4xx（attachReceipts の 404）はその取引だけ needs_attention にして続ける', async () => {
    const a = await sentDocument({ uploaded: false });
    const b = await sentDocument();
    const r = await fake.uploadReceipt({ bytes: Buffer.from('y'), fileName: 'a.jpg', mime: 'image/jpeg', key: `kh-${a}` });
    markUploaded(db, a, r.id);
    await fake.deleteDeal(Number(row(a).remote_deal_id));
    fake.calls.length = 0;
    const { job } = await reconcile();
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(row(a).attention_reason, 'deal_missing');
    assert.equal(row(b).state, 'verified');
  });

  test('verified は発生日が直近 35 日のものだけ見る', async () => {
    const old = await sentDocument({ txnDate: '2026-09-10' }); // 今日（JST 2026-10-16）の 36 日前
    const edge = await sentDocument({ txnDate: '2026-09-11' }); // 35 日前
    await reconcile(60);
    assert.equal(row(old).state, 'verified');
    remote(old).receiptIds = [];
    remote(edge).receiptIds = [];
    fake.calls.length = 0;
    await reconcile(120);
    assert.equal(row(old).state, 'verified'); // 範囲外なので見ない
    assert.equal(row(edge).attention_reason, 'receipt_detached');
    assert.deepEqual(fake.calls[0].args, [{ startIssueDate: '2026-09-11', endIssueDate: '2026-09-11', limit: 100, offset: 0 }]);
  });

  test('一覧はページ上限まで。上限で打ち切ったら一覧に無いものは翌日に回す（getDeal しない）', async () => {
    const docs: string[] = [];
    for (let i = 0; i < 3; i++) docs.push(await sentDocument());
    fake.calls.length = 0;
    clock = at(60);
    // 1 ページ 100 件を 2 ページ分に見せるため、他人の取引を 200 件足す
    for (let i = 0; i < 200; i++) await fake.createExpenseDeal({ issueDate: '2026-10-15', refNumber: `other-${i}`, details: [{ accountItemId: 101, taxCode: 1, amount: 1 }] });
    // 自分の取引（ID 1〜3）は 1 ページ目にあるので、上限 1 ページでも見つかる
    let s = await reconcileDeals(db, fake, { providerName: 'freee', now: () => clock, maxPages: 1 });
    assert.equal(s.checked, 3);
    assert.equal(s.deferred, 0);
    // 取引を消すと一覧に無い。上限で打ち切っているので getDeal せずに翌日へ
    await fake.deleteDeal(Number(row(docs[0]).remote_deal_id));
    fake.calls.length = 0;
    s = await reconcileDeals(db, fake, { providerName: 'freee', now: () => clock, maxPages: 1 });
    assert.equal(s.deferred, 1);
    assert.deepEqual(fake.calls.map((c) => c.method), ['listDeals']);
    assert.equal(row(docs[0]).state, 'verified');
    // 上限を上げれば最後まで読み、getDeal で消えたことがわかる
    fake.calls.length = 0;
    s = await reconcileDeals(db, fake, { providerName: 'freee', now: () => clock, maxPages: 20 });
    assert.deepEqual(fake.calls.map((c) => c.method), ['listDeals', 'listDeals', 'listDeals', 'getDeal']);
    assert.equal(row(docs[0]).attention_reason, 'deal_missing');
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
