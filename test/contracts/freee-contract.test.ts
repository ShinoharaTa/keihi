// freee の契約テスト（docs/mvp-plan.md T1-10）。Provider の全メソッドを呼び、送ったリクエストが
// 固定した OpenAPI（test/contracts/freee-openapi.json）の定義に合うかを確かめる。実 API は叩かない。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONTRACT, checkRequest, findOperation, validate } from './openapi.ts';
import { COMPANY, makeEnv, storedToken } from './mock.ts';

let root: string;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-freee-contract-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('検証器そのもの', () => {
  test('定義に無いプロパティ・型違い・必須の欠けを誤りにする', () => {
    const s = CONTRACT.components.schemas.receiptUpdateParams;
    assert.deepEqual(validate(s, { company_id: 1 }, 'b'), []);
    assert.match(validate(s, { company_id: 1, unknown: 1 }, 'b').join(), /定義に無いプロパティ/);
    assert.match(validate(s, { company_id: '1' }, 'b').join(), /integer でない/);
    assert.match(validate(s, {}, 'b').join(), /必須/);
    assert.match(validate(s, { company_id: 1, invoice_registration_number: 'X123' }, 'b').join(), /pattern/);
  });

  test('定義に無い操作・クエリを誤りにする', () => {
    const u = new URL(`https://api.freee.co.jp/api/1/receipts?company_id=${COMPANY}&start_date=2026-10-01&end_date=2026-10-02&bogus=1`);
    assert.match(checkRequest({ method: 'GET', url: u, headers: new Headers(), body: undefined }).join(), /定義に無いクエリ bogus/);
    assert.equal(findOperation('PATCH', '/api/1/receipts/1'), null);
  });
});

describe('Provider の送るリクエスト', () => {
  test('全メソッドのリクエストが定義に合う', async () => {
    const env = await makeEnv(path.join(root, String(n++)));
    const p = env.provider;
    await p.uploadReceipt({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), fileName: 'a.jpg', mime: 'image/jpeg', key: 'kh-01TEST' });
    await p.uploadReceipt({
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      fileName: 'b.jpg',
      mime: 'image/jpeg',
      key: 'kh-02TEST',
      meta: { partnerName: 'ダミー商店', issueDate: '2026-10-01', amount: 1100, documentType: 'receipt', qualifiedInvoice: 'qualified' },
    });
    await p.updateReceiptMeta(1, { partnerName: 'ダミー商店', issueDate: '2026-10-01', amount: 1100, invoiceRegistrationNumber: 'T1234567890123', qualifiedInvoice: 'qualified', documentType: 'receipt' });
    await p.updateReceiptMeta(1, { amount: 1 });
    await p.downloadReceipt(1);
    await p.findReceiptsByKey('kh-01TEST');
    await p.findReceiptsByKey('kh-01TEST', { startDate: '2026-10-01', endDate: '2026-10-18' });
    await p.createExpenseDeal({ issueDate: '2026-10-01', refNumber: 'kh-REF', details: [{ accountItemId: 101, taxCode: 136, amount: 1100, description: 'x' }], receiptIds: [1] });
    await p.createExpenseDeal({ issueDate: '2026-10-01', refNumber: 'kh-REF2', details: [{ accountItemId: 101, taxCode: 136, amount: 1100 }], partnerName: 'ダミー商店' });
    await p.attachReceipts(501, [2]);
    await p.getDeal(501);
    await p.listDeals({ startIssueDate: '2026-10-01', endIssueDate: '2026-10-31', limit: 10, offset: 0 });
    await p.listDeals({ refNumber: 'kh-REF' });
    await p.deleteDeal(501);
    await p.syncMasters();
    await p.listBankTxns({ walletableType: 'credit_card', walletableId: 1, startDate: '2026-10-01', endDate: '2026-10-31' });
    await p.listRules();
    await p.createRule({ matchText: 'DUMMY', action: 'ignore' });
    await p.deleteRule(9);

    const errors = env.mock.reqs.flatMap(checkRequest);
    assert.deepEqual(errors, []);
    // 抜き出した操作は全部使っている（使わない操作を定義に残さない）。
    const used = new Set(env.mock.reqs.map((r) => `${r.method} ${findOperation(r.method, r.url.pathname)?.template}`));
    const defined = Object.entries(CONTRACT.paths).flatMap(([t, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${t}`));
    assert.deepEqual(defined.filter((d) => !used.has(d)), []);
    // 証憑の本文: 原本のバイト列そのまま、照合キーは description。
    const up = env.mock.reqs.find((r) => r.method === 'POST' && r.url.pathname === '/api/1/receipts')!.body as FormData;
    assert.deepEqual(new Uint8Array(await (up.get('receipt') as Blob).arrayBuffer()), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    assert.equal(up.get('description'), 'kh-01TEST');
    assert.equal(up.has('receipt_metadatum_partner_name'), false);
    // attachReceipts は details を全部送り直し、既存の証憑を残す。
    const put = JSON.parse(String(env.mock.reqs.find((r) => r.method === 'PUT' && r.url.pathname === '/api/1/deals/501')!.body));
    assert.deepEqual(put.receipt_ids, [7, 2]);
    assert.equal(put.details[0].id, 9001);
    env.db.close();
  });

  test('トークンの更新のリクエストが定義に合う', async () => {
    const env = await makeEnv(path.join(root, String(n++)), { token: storedToken({ created_at: Math.floor(Date.now() / 1000) - 30000 }) });
    await env.provider.getDeal(501);
    const tokenReqs = env.mock.reqs.filter((r) => r.url.pathname === '/public_api/token');
    assert.equal(tokenReqs.length, 1);
    assert.deepEqual(env.mock.reqs.flatMap(checkRequest), []);
    env.db.close();
  });
});
