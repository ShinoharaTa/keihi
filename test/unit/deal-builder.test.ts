// 取引ビルダ（docs/mvp-plan.md T4-1）。表駆動: 支払手段（現金・事業主借・カード）、按分 0/50/100、軽減税率の混在で 2 行。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Db } from '../../src/db/index.ts';
import { applyMasterItems } from '../../src/masters/sync.ts';
import {
  buildDeal,
  DealBuildError,
  latestApprovedReview,
  parsePayment,
  resolveBuildOptions,
  reviewForDeal,
  type Payment,
  type ReviewForDeal,
  type TaxResolver,
} from '../../src/deals/builder.ts';
import { addDocument, addReview, openTestDb } from './deals-helpers.ts';

const OPTS = { ownerDrawAccountItemId: 104, outOfScopeTaxCode: 3 };
const base = (o: Partial<ReviewForDeal> = {}): ReviewForDeal => ({
  documentId: 'DOC1',
  reviewId: 'R1',
  txnDate: '2026-10-15',
  amount: 1100,
  vendor: 'テスト商店',
  accountItemId: 101,
  taxLines: [{ taxCode: 1, amount: 1100 }],
  payment: { kind: 'cash' },
  prorationPct: 100,
  receiptIds: [7],
  ...o,
});

describe('buildDeal', () => {
  const payments: [string, Payment][] = [
    ['現金', { kind: 'cash' }],
    ['事業主借', { kind: 'owner' }],
    ['連携カード', { kind: 'card', walletableRemoteId: 'credit_card:1' }],
  ];
  for (const [name, payment] of payments) {
    test(`支払手段 ${name}: 未決済（payments を持たない）で、内容は支払手段によらない`, () => {
      const d = buildDeal(base({ payment }), OPTS);
      assert.deepEqual(d.details, [{ accountItemId: 101, taxCode: 1, amount: 1100 }]);
      assert.equal('payments' in d, false);
      assert.deepEqual(d.payment, payment);
      assert.equal(d.refNumber, 'kh-DOC1');
      assert.equal(d.issueDate, '2026-10-15');
      assert.equal(d.partnerName, 'テスト商店');
      assert.deepEqual(d.receiptIds, [7]);
    });
  }

  const cases: { name: string; pct: number; lines: { taxCode: number; amount: number }[]; want: { accountItemId: number; taxCode: number; amount: number }[] }[] = [
    { name: '按分 100', pct: 100, lines: [{ taxCode: 1, amount: 1100 }], want: [{ accountItemId: 101, taxCode: 1, amount: 1100 }] },
    {
      name: '按分 50',
      pct: 50,
      lines: [{ taxCode: 1, amount: 1100 }],
      want: [
        { accountItemId: 101, taxCode: 1, amount: 550 },
        { accountItemId: 104, taxCode: 3, amount: 550 },
      ],
    },
    { name: '按分 0（全額が事業主貸）', pct: 0, lines: [{ taxCode: 1, amount: 1100 }], want: [{ accountItemId: 104, taxCode: 3, amount: 1100 }] },
    {
      name: '按分 50 で端数は事業分を切り捨て',
      pct: 50,
      lines: [{ taxCode: 1, amount: 1101 }],
      want: [
        { accountItemId: 101, taxCode: 1, amount: 550 },
        { accountItemId: 104, taxCode: 3, amount: 551 },
      ],
    },
    {
      name: '軽減税率の混在で 2 行',
      pct: 100,
      lines: [
        { taxCode: 1, amount: 1100 },
        { taxCode: 2, amount: 540 },
      ],
      want: [
        { accountItemId: 101, taxCode: 1, amount: 1100 },
        { accountItemId: 101, taxCode: 2, amount: 540 },
      ],
    },
    {
      name: '軽減税率の混在 + 按分 50（私用分は事業主貸 1 行にまとめる）',
      pct: 50,
      lines: [
        { taxCode: 1, amount: 1100 },
        { taxCode: 2, amount: 540 },
      ],
      want: [
        { accountItemId: 101, taxCode: 1, amount: 550 },
        { accountItemId: 101, taxCode: 2, amount: 270 },
        { accountItemId: 104, taxCode: 3, amount: 820 },
      ],
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const amount = c.lines.reduce((s, l) => s + l.amount, 0);
      const d = buildDeal(base({ amount, prorationPct: c.pct, taxLines: c.lines }), OPTS);
      assert.deepEqual(d.details, c.want);
      assert.equal(
        d.details.reduce((s, x) => s + x.amount, 0),
        amount,
      );
    });
  }

  const bad: [string, Partial<ReviewForDeal>][] = [
    ['内訳の和が合計と違う', { amount: 1000 }],
    ['金額が 0', { amount: 0, taxLines: [{ taxCode: 1, amount: 0 }] }],
    ['按分率が範囲外', { prorationPct: 101 }],
    ['按分率が整数でない', { prorationPct: 33.3 }],
    ['日付が不正', { txnDate: '2026/10/15' }],
    ['行が無い', { taxLines: [] }],
  ];
  for (const [name, o] of bad) {
    test(`不正: ${name}`, () => {
      assert.throws(() => buildDeal(base(o), OPTS), DealBuildError);
    });
  }

  test('取引先が無ければ partnerName を入れない・証憑の重複は除く', () => {
    const d = buildDeal(base({ vendor: null, receiptIds: [3, 3] }), OPTS);
    assert.equal('partnerName' in d, false);
    assert.deepEqual(d.receiptIds, [3]);
  });
});

describe('parsePayment', () => {
  test('cash / owner / card:<walletable>', () => {
    assert.deepEqual(parsePayment('cash'), { kind: 'cash' });
    assert.deepEqual(parsePayment('owner'), { kind: 'owner' });
    assert.deepEqual(parsePayment('card:credit_card:1'), { kind: 'card', walletableRemoteId: 'credit_card:1' });
    for (const v of ['card:', 'bank', null]) assert.throws(() => parsePayment(v), DealBuildError);
  });
});

describe('DB からの読み出し', () => {
  let root: string;
  let n = 0;
  let db: Db;
  const resolveTax: TaxResolver = (cat) => ({ taxable_10: 1, taxable_8_reduced: 2, non_taxable: 4, out_of_scope: 3 })[cat];

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'keihi-builder-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    db = openTestDb(path.join(root, `${n++}.db`));
  });

  test('approve の version 最大を読む。最新が approve でなければ null', () => {
    const doc = addDocument(db);
    addReview(db, doc, { version: 1, amount: 1000, taxId: '1' });
    addReview(db, doc, { version: 2, amount: 1100, taxId: '1' });
    assert.equal(latestApprovedReview(db, doc)?.version, 2);
    addReview(db, doc, { version: 3, decision: 'personal' });
    assert.equal(latestApprovedReview(db, doc), null);
  });

  test('tax_by_rate_json（10 と 8r）から 2 行、credit_account と proration_pct を読む', () => {
    const doc = addDocument(db);
    addReview(db, doc, {
      amount: 1640,
      creditAccount: 'card:credit_card:1',
      prorationPct: 50,
      taxByRate: [
        { category: '10', amount_incl_tax: 1100, tax: 100 },
        { category: '8r', amount_incl_tax: 540, tax: 40 },
      ],
    });
    const r = reviewForDeal(latestApprovedReview(db, doc)!, [5], resolveTax);
    assert.deepEqual(r.taxLines, [
      { taxCode: 1, amount: 1100 },
      { taxCode: 2, amount: 540 },
    ]);
    assert.deepEqual(r.payment, { kind: 'card', walletableRemoteId: 'credit_card:1' });
    assert.equal(r.prorationPct, 50);
    assert.equal(r.accountItemId, 101);
  });

  test('内訳が無ければ tax_id（コードか税率の区分）で 1 行', () => {
    const doc = addDocument(db);
    addReview(db, doc, { taxId: 'taxable_8_reduced', amount: 540 });
    assert.deepEqual(reviewForDeal(latestApprovedReview(db, doc)!, [], resolveTax).taxLines, [{ taxCode: 2, amount: 540 }]);
    const doc2 = addDocument(db);
    addReview(db, doc2, { taxId: 'xx' });
    assert.throws(() => reviewForDeal(latestApprovedReview(db, doc2)!, [], resolveTax), DealBuildError);
  });

  test('事業主貸は同期済みのマスタから名前で引く', () => {
    assert.throws(() => resolveBuildOptions(db, 'freee', resolveTax, '2026-10-15'), DealBuildError);
    applyMasterItems(db, 'freee', 'account', [{ remoteId: '104', name: '事業主貸', data: {} }], '2026-10-16T00:00:00.000Z');
    assert.deepEqual(resolveBuildOptions(db, 'freee', resolveTax, '2026-10-15'), { ownerDrawAccountItemId: 104, outOfScopeTaxCode: 3 });
  });
});
