// T1-9 Provider インターフェースと fake（docs/mvp-plan.md）。外部への通信はしない。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeProvider } from '../../src/providers/fake/index.ts';
import { ProviderError, type CreateExpenseDealInput, type ProviderErrorKind, type UploadReceiptInput } from '../../src/providers/types.ts';

const upload = (key: string, over: Partial<UploadReceiptInput> = {}): UploadReceiptInput => ({
  bytes: Buffer.from(`dummy-${key}`),
  fileName: `${key}.jpg`,
  mime: 'image/jpeg',
  key,
  meta: { partnerName: 'テスト文具店', issueDate: '2026-09-11', amount: 240 },
  ...over,
});

const dealInput = (refNumber: string, receiptIds: number[] = []): CreateExpenseDealInput => ({
  issueDate: '2026-09-11',
  refNumber,
  details: [{ accountItemId: 101, taxCode: 1, amount: 240 }],
  receiptIds,
});

async function rejectsWith(p: Promise<unknown>, kind: ProviderErrorKind): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ProviderError, String(e));
    assert.equal(e.kind, kind);
    return e;
  }
  assert.fail(`${kind} で失敗するはず`);
}

describe('capabilities', () => {
  test('freee の前提を返す（64MB）', () => {
    assert.deepEqual(createFakeProvider().capabilities(), {
      receiptMetaOnUpload: true,
      canLinkExistingReceipt: true,
      canReconcileTxn: false,
      maxReceiptBytes: 64 * 1024 * 1024,
    });
  });

  test('reconcileTxn / ignoreTxn は実装しない（型だけ）', () => {
    const p = createFakeProvider();
    assert.equal(p.reconcileTxn, undefined);
    assert.equal(p.ignoreTxn, undefined);
  });
});

describe('障害注入', () => {
  const cases: [ProviderErrorKind, number | null, boolean][] = [
    ['timeout', null, true],
    ['server', 500, true],
    ['rate_limited', 429, true],
    ['usage_limited', 403, true],
    ['auth_invalid_grant', 401, false],
    ['client', 400, false],
    ['network', null, true],
  ];
  for (const [kind, status, retryable] of cases) {
    test(`${kind}: status=${status} retryable=${retryable}、操作は反映しない`, async () => {
      const p = createFakeProvider();
      p.failNext(kind);
      const e = await rejectsWith(p.uploadReceipt(upload('k1')), kind);
      assert.equal(e.status, status);
      assert.equal(e.retryable, retryable);
      assert.match(e.requestId ?? '', /^fake-req-\d+$/);
      assert.equal(p.state.receipts.size, 0);
      // 次の呼び出しは成功する。
      const r = await p.uploadReceipt(upload('k1'));
      assert.equal(r.id, 1);
      assert.deepEqual(
        p.calls.map((c) => [c.method, c.outcome, c.applied]),
        [
          ['uploadReceipt', kind, false],
          ['uploadReceipt', 'ok', false],
        ],
      );
    });
  }

  test('times 回だけ失敗し、その後は成功する', async () => {
    const p = createFakeProvider();
    p.failNext('rate_limited', { times: 2 });
    await rejectsWith(p.syncMasters(), 'rate_limited');
    await rejectsWith(p.syncMasters(), 'rate_limited');
    const m = await p.syncMasters();
    assert.ok(m.accountItems.length > 0);
    assert.deepEqual(
      p.calls.map((c) => c.outcome),
      ['rate_limited', 'rate_limited', 'ok'],
    );
  });

  test('注入は積んだ順に消費される', async () => {
    const p = createFakeProvider();
    p.failNext('server');
    p.failNext('usage_limited');
    await rejectsWith(p.listRules(), 'server');
    await rejectsWith(p.listRules(), 'usage_limited');
    assert.deepEqual(await p.listRules(), []);
  });

  test('times が不正なら例外', () => {
    assert.throws(() => createFakeProvider().failNext('server', { times: 0 }));
  });

  test('timeout だが実は成功: findReceiptsByKey で見つかる', async () => {
    const p = createFakeProvider();
    p.failNext('timeout', { butSucceed: true });
    await rejectsWith(p.uploadReceipt(upload('kh-001')), 'timeout');
    assert.deepEqual(p.calls[0], {
      method: 'uploadReceipt',
      args: [{ fileName: 'kh-001.jpg', mime: 'image/jpeg', key: 'kh-001', byteSize: 'dummy-kh-001'.length }],
      outcome: 'timeout',
      applied: true,
    });
    const found = await p.findReceiptsByKey('kh-001');
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 1);
    assert.equal(found[0].meta.partnerName, 'テスト文具店');
    assert.deepEqual(await p.findReceiptsByKey('kh-002'), []);
    // 送り直さずに済むので、アップロードの呼び出しは 1 回だけ。
    assert.equal(p.calls.filter((c) => c.method === 'uploadReceipt').length, 1);
  });

  test('timeout だが実は成功: 取引は listDeals の refNumber で見つかる', async () => {
    const p = createFakeProvider();
    p.failNext('timeout', { butSucceed: true });
    await rejectsWith(p.createExpenseDeal(dealInput('kh-d1')), 'timeout');
    const ds = await p.listDeals({ refNumber: 'kh-d1' });
    assert.equal(ds.length, 1);
  });

  test('timeout（成功していない）: findReceiptsByKey で見つからない', async () => {
    const p = createFakeProvider();
    p.failNext('timeout');
    await rejectsWith(p.uploadReceipt(upload('kh-001')), 'timeout');
    assert.deepEqual(await p.findReceiptsByKey('kh-001'), []);
  });
});

describe('証憑', () => {
  test('上げたバイト列をそのまま返す。呼び出し側の書き換えは状態に及ばない', async () => {
    const p = createFakeProvider();
    const input = upload('k');
    const r = await p.uploadReceipt(input);
    input.bytes.fill(0);
    const d = await p.downloadReceipt(r.id);
    assert.equal(d.bytes.toString(), 'dummy-k');
    assert.equal(d.mime, 'image/jpeg');
    d.bytes.fill(0);
    assert.equal((await p.downloadReceipt(r.id)).bytes.toString(), 'dummy-k');
  });

  test('updateReceiptMeta は渡した項目だけ上書きする', async () => {
    const p = createFakeProvider();
    const r = await p.uploadReceipt(upload('k'));
    const u = await p.updateReceiptMeta(r.id, { invoiceRegistrationNumber: 'T9995784636321', amount: 300 });
    assert.deepEqual(u.meta, {
      partnerName: 'テスト文具店',
      issueDate: '2026-09-11',
      amount: 300,
      invoiceRegistrationNumber: 'T9995784636321',
    });
  });

  test('64MB を超えると client', async () => {
    const p = createFakeProvider();
    await rejectsWith(p.uploadReceipt(upload('big', { bytes: Buffer.alloc(64 * 1024 * 1024 + 1) })), 'client');
    assert.equal(p.state.receipts.size, 0);
  });

  test('存在しない ID は client（404）', async () => {
    const p = createFakeProvider();
    const e = await rejectsWith(p.downloadReceipt(99), 'client');
    assert.equal(e.status, 404);
    assert.equal(p.calls[0].outcome, 'client');
  });

  test('ID は決定的（種類ごとに 1 から）', async () => {
    const ids = async () => {
      const p = createFakeProvider();
      const a = await p.uploadReceipt(upload('a'));
      const b = await p.uploadReceipt(upload('b'));
      const d = await p.createExpenseDeal(dealInput('r'));
      return [a.id, b.id, d.id];
    };
    assert.deepEqual(await ids(), [1, 2, 1]);
    assert.deepEqual(await ids(), [1, 2, 1]);
  });
});

describe('取引', () => {
  test('未決済の支出として作り、receiptIds で紐付く', async () => {
    const p = createFakeProvider();
    const r = await p.uploadReceipt(upload('k'));
    const d = await p.createExpenseDeal(dealInput('kh-1', [r.id]));
    assert.equal(d.type, 'expense');
    assert.equal(d.settled, false);
    assert.equal(d.amount, 240);
    assert.deepEqual(d.receiptIds, [r.id]);
    assert.equal((await p.findReceiptsByKey('k'))[0].dealId, d.id);
  });

  test('attachReceipts が既存の取引に証憑を足す（重複は足さない）', async () => {
    const p = createFakeProvider();
    const r1 = await p.uploadReceipt(upload('k1'));
    const r2 = await p.uploadReceipt(upload('k2'));
    const d = await p.createExpenseDeal(dealInput('kh-1', [r1.id]));
    const after = await p.attachReceipts(d.id, [r2.id, r1.id]);
    assert.deepEqual(after.receiptIds, [r1.id, r2.id]);
    assert.deepEqual((await p.getDeal(d.id)).receiptIds, [r1.id, r2.id]);
    assert.equal((await p.findReceiptsByKey('k2'))[0].dealId, d.id);
  });

  test('attachReceipts: 存在しない証憑があれば何も足さない', async () => {
    const p = createFakeProvider();
    const d = await p.createExpenseDeal(dealInput('kh-1'));
    await rejectsWith(p.attachReceipts(d.id, [99]), 'client');
    assert.deepEqual((await p.getDeal(d.id)).receiptIds, []);
  });

  test('listDeals の絞り込みと deleteDeal（証憑の紐付けを外す）', async () => {
    const p = createFakeProvider();
    const r = await p.uploadReceipt(upload('k'));
    const d1 = await p.createExpenseDeal(dealInput('a', [r.id]));
    await p.createExpenseDeal({ ...dealInput('b'), issueDate: '2026-10-01' });
    assert.equal((await p.listDeals()).length, 2);
    assert.deepEqual((await p.listDeals({ startIssueDate: '2026-10-01' })).map((d) => d.refNumber), ['b']);
    assert.deepEqual((await p.listDeals({ limit: 1, offset: 1 })).map((d) => d.refNumber), ['b']);
    await p.deleteDeal(d1.id);
    await rejectsWith(p.getDeal(d1.id), 'client');
    assert.equal((await p.findReceiptsByKey('k'))[0].dealId, null);
  });
});

describe('明細・ルール', () => {
  test('listBankTxns は addBankTxn で入れた明細を絞り込んで返す', async () => {
    const p = createFakeProvider();
    const card = { walletableType: 'credit_card', walletableId: 1, entrySide: 'expense', balance: null, status: 1, ruleMatched: false } as const;
    p.addBankTxn({ ...card, date: '2026-09-11', amount: 240, dueAmount: 240, description: 'TEST SHOP' });
    p.addBankTxn({ ...card, date: '2026-10-11', amount: 500, dueAmount: 500, description: 'TEST CAFE' });
    p.addBankTxn({ walletableType: 'bank_account', walletableId: 2, date: '2026-09-12', amount: 1000, entrySide: 'income', description: 'TEST BANK', balance: 51000, status: 1, dueAmount: 1000, ruleMatched: true });
    assert.equal(p.calls.length, 0);
    const ts = await p.listBankTxns({ endDate: '2026-09-30', walletableType: 'credit_card' });
    assert.deepEqual(ts.map((t) => [t.id, t.amount, t.balance]), [[1, 240, null]]);
    const bank = await p.listBankTxns({ walletableType: 'bank_account', walletableId: 2 });
    assert.deepEqual(bank.map((t) => [t.id, t.balance, t.status, t.dueAmount, t.ruleMatched]), [[3, 51000, 1, 1000, true]]);
  });

  test('listBankTxns は 100 件ずつ返し、offset で続きが取れる', async () => {
    const p = createFakeProvider();
    for (let i = 0; i < 250; i++) {
      p.addBankTxn({ walletableType: 'bank_account', walletableId: 2, date: '2026-10-01', amount: i + 1, entrySide: 'expense', description: `T${i}`, balance: 0, status: 1, dueAmount: i + 1, ruleMatched: false });
    }
    const pages = [];
    for (let offset = 0; ; offset += 100) {
      const page = await p.listBankTxns({ walletableId: 2, offset });
      pages.push(page.length);
      if (page.length < 100) break;
    }
    assert.deepEqual(pages, [100, 100, 50]);
    assert.deepEqual((await p.listBankTxns({ limit: 2, offset: 248 })).map((t) => t.id), [249, 250]);
    assert.deepEqual(await p.listBankTxns({ offset: 250 }), []);
    await rejectsWith(p.listBankTxns({ limit: 101 }), 'client');
    await rejectsWith(p.listBankTxns({ limit: 0 }), 'client');
    await rejectsWith(p.listBankTxns({ offset: -1 }), 'client');
  });

  test('createRule / listRules / deleteRule', async () => {
    const p = createFakeProvider();
    const r = await p.createRule({ matchText: 'TEST CAFE', action: 'ignore' });
    assert.equal(r.id, 1);
    assert.deepEqual(await p.listRules(), [{ matchText: 'TEST CAFE', action: 'ignore', id: 1 }]);
    await p.deleteRule(r.id);
    assert.deepEqual(await p.listRules(), []);
    await rejectsWith(p.deleteRule(r.id), 'client');
    const r2 = await p.createRule({ matchText: 'TEST SHOP', action: 'private_register' });
    assert.deepEqual(await p.listRules(), [{ matchText: 'TEST SHOP', action: 'private_register', id: r2.id }]);
    // freee と同じく、口座の指定は client。
    await rejectsWith(p.createRule({ matchText: 'TEST SHOP', action: 'ignore', walletableId: 2 }), 'client');
    assert.equal((await p.listRules()).length, 1);
  });
});
