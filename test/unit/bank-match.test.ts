// 明細 ⇔ 証憑の照合（src/bank/match.ts、docs/cashflow.md §16、T206・T207）。:memory: の DB だけを使う。
// 摘要・取引先・金額はすべて架空の値。
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { insertAccount, insertBankTxn, updateAccountSettings, type AccountKind, type Tag } from '../../src/bank/repo.ts';
import { linkDocument, receiptStatusBulk, runMatching, unlinkDocument, type MatchWindows, type TxnMatchRow } from '../../src/bank/match.ts';
import { setTxnTag } from '../../src/bank/tags.ts';
import { insertTransferLink } from '../../src/bank/transferRepo.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { normalizeVendor } from '../../src/vendors/normalize.ts';

const T0 = new Date('2026-11-08T03:00:00.000Z');
const NOW = T0.toISOString();
const W: MatchWindows = { bankDays: 3, cardDays: 10 };

let db: Db;
let docN = 0;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});

function account(kind: AccountKind, defaultTag: Tag = 'business'): string {
  const id = insertAccount(db, { provider: 'fake', name: `口座${kind}`, kind, source: 'csv', now: NOW }).id;
  if (defaultTag !== 'unset') updateAccountSettings(db, id, { defaultTag }, NOW);
  return id;
}

function txn(accountId: string, txnDate: string, amount: number, description = 'ｶﾌｪ ﾃｽﾄ', side: 'income' | 'expense' = 'expense'): string {
  return insertBankTxn(db, { accountId, txnDate, amount, side, description, descriptionNorm: normalizeVendor(description), now: NOW }).id;
}

// 抽出だけがある証憑（確認前）。
function doc(txnDate: string | null, amount: number | null, vendor: string | null = 'カフェテスト', status = 'needs_review'): string {
  const id = `D${String(++docN).padStart(4, '0')}`;
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, status, created_at)
     VALUES (?, ?, 1, 'image/jpeg', 'pwa', 'scan', ?, '2026-11-01', 'server', '2026-11-20', 'early', 'x', ?, ?)`,
  ).run(id, docN.toString(16).padStart(64, '0'), NOW, status, NOW);
  db.prepare(
    `INSERT INTO extractions (id, document_id, engine, raw_json, txn_date, amount_total, vendor_name, created_at) VALUES (?, ?, 'gemini', '{}', ?, ?, ?, ?)`,
  ).run(`E${id}`, id, txnDate, amount, vendor, NOW);
  return id;
}

// 確定の版を足す（金額・日付・相手は確定の値が効く）。
function review(docId: string, v: { txnDate: string; amount: number; vendor: string }, decision = 'approve', status = 'approved'): void {
  const { n } = db.prepare('SELECT count(*) n FROM reviews WHERE document_id = ?').get(docId) as { n: number };
  db.prepare(`INSERT INTO reviews (id, document_id, version, txn_date, amount, vendor, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `R${docId}${n}`, docId, n + 1, v.txnDate, v.amount, v.vendor, decision, NOW,
  );
  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(status, docId);
}

const rows = (): TxnMatchRow[] => db.prepare('SELECT * FROM txn_matches ORDER BY seq').all() as TxnMatchRow[];
const receipt = (id: string) => receiptStatusBulk(db, [id], W).get(id)!;

describe('runMatching（表駆動）', () => {
  // 明細の日 − 証憑の日（diff）と口座の種別・相手名で、auto / candidate / none のどれになるか。
  const cases: { name: string; kind: AccountKind; diff: number; vendor: string | null; amountDelta?: number; want: 'auto' | 'candidate' | 'none' }[] = [
    { name: '同じ日・相手名あり → auto（score 100）', kind: 'bank', diff: 0, vendor: 'カフェテスト', want: 'auto' },
    { name: '前日（−1 日）・相手名なし → auto（|date_diff| ≤ 1）', kind: 'bank', diff: -1, vendor: null, want: 'auto' },
    { name: '−2 日は外れる', kind: 'bank', diff: -2, vendor: 'カフェテスト', want: 'none' },
    { name: '銀行 +3 日・相手名あり → auto', kind: 'bank', diff: 3, vendor: 'カフェテスト', want: 'auto' },
    { name: '銀行 +3 日・相手名が違う → 候補のまま（auto にしない）', kind: 'bank', diff: 3, vendor: '別の店', want: 'candidate' },
    { name: '銀行 +4 日（W+1）は外れる', kind: 'bank', diff: 4, vendor: 'カフェテスト', want: 'none' },
    { name: 'カード +10 日・相手名あり → auto', kind: 'card', diff: 10, vendor: 'カフェテスト', want: 'auto' },
    { name: 'カード +11 日（W+1）は外れる', kind: 'card', diff: 11, vendor: 'カフェテスト', want: 'none' },
    { name: '金額が 1 円違えば候補にならない', kind: 'bank', diff: 0, vendor: 'カフェテスト', amountDelta: 1, want: 'none' },
    { name: '相手名が 2 文字なら一致とみなさない（+2 日は候補のまま）', kind: 'bank', diff: 2, vendor: 'カフ', want: 'candidate' },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const acc = account(c.kind);
      const t = txn(acc, '2026-10-15', 1234);
      const d = new Date(Date.UTC(2026, 9, 15 - c.diff)).toISOString().slice(0, 10);
      const dc = doc(d, 1234 + (c.amountDelta ?? 0), c.vendor);
      const created = runMatching(db, T0, { windows: W });
      if (c.want === 'auto') {
        assert.equal(created.length, 1);
        const r = created[0]!;
        assert.deepEqual(
          { bank_txn_id: r.bank_txn_id, document_id: r.document_id, state: r.state, actor: r.actor, date_diff: r.date_diff },
          { bank_txn_id: t, document_id: dc, state: 'auto', actor: 'system', date_diff: c.diff },
        );
        const vm = c.vendor === 'カフェテスト' ? 1 : 0;
        assert.equal(r.vendor_match, vm);
        assert.equal(r.score, vm * 50 + Math.max(0, 50 - 5 * Math.abs(c.diff)));
        assert.equal(receipt(t).receipt, 'pending_review');
      } else {
        assert.equal(created.length, 0);
        assert.equal(receipt(t).receipt, c.want === 'candidate' ? 'candidate' : 'waiting');
      }
    });
  }

  test('1 対 2・2 対 1 は書かない（どちらも候補に見える）', () => {
    const acc = account('bank');
    const t1 = txn(acc, '2026-10-15', 1234);
    doc('2026-10-15', 1234);
    doc('2026-10-15', 1234);
    const t2 = txn(acc, '2026-10-20', 5678);
    const t3 = txn(acc, '2026-10-20', 5678);
    doc('2026-10-20', 5678);
    assert.deepEqual(runMatching(db, T0, { windows: W }), []);
    for (const t of [t1, t2, t3]) assert.equal(receipt(t).receipt, 'candidate');
  });

  test('証憑が 0 件なら何もしない（待ち）', () => {
    const t = txn(account('bank'), '2026-10-15', 1234);
    assert.deepEqual(runMatching(db, T0, { windows: W }), []);
    assert.equal(receipt(t).receipt, 'waiting');
  });

  test('外した（rejected の）組は作り直さない。候補にも出さない', () => {
    const acc = account('bank');
    const t = txn(acc, '2026-10-15', 1234);
    const d = doc('2026-10-15', 1234);
    assert.equal(runMatching(db, T0, { windows: W }).length, 1);
    unlinkDocument(db, { txnId: t, documentId: d, user: null, now: T0 });
    assert.deepEqual(runMatching(db, T0, { windows: W }), []);
    assert.deepEqual(rows().map((r) => r.state), ['auto', 'rejected']);
    assert.equal(receipt(t).receipt, 'waiting');
  });

  test('private の明細は候補にしない。unset の明細は候補にする（receipt は null、receipt_hint が付く）', () => {
    const p = txn(account('bank', 'private'), '2026-10-15', 1234);
    doc('2026-10-15', 1234);
    assert.deepEqual(runMatching(db, T0, { windows: W }), []);
    const u = txn(account('bank', 'unset'), '2026-10-16', 2345);
    const d = doc('2026-10-16', 2345);
    const created = runMatching(db, T0, { windows: W });
    assert.deepEqual(created.map((r) => r.bank_txn_id), [u]);
    assert.deepEqual(receipt(u), { receipt: null, receipt_hint: { document_id: d, status: 'needs_review' }, mail_hint: null });
    assert.deepEqual(receipt(p), { receipt: null, receipt_hint: null, mail_hint: null });
  });

  test('有効な紐付けを持つ明細・証憑は候補にしない。2 回目は何も作らない。監査は txn_match.auto（摘要・金額なし）', () => {
    const acc = account('bank');
    txn(acc, '2026-10-15', 1234);
    doc('2026-10-15', 1234);
    assert.equal(runMatching(db, T0, { windows: W }).length, 1);
    assert.deepEqual(runMatching(db, T0, { windows: W }), []);
    const a = db.prepare(`SELECT actor, payload_json FROM audit_log WHERE action = 'txn_match.auto'`).all() as { actor: string; payload_json: string }[];
    assert.equal(a.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(a[0]!.payload_json)).sort(), ['bank_txn_id', 'document_id', 'score']);
  });
});

describe('有効な紐付け', () => {
  test('証憑を reject にしたら効かない', () => {
    const t = txn(account('bank'), '2026-10-15', 1234);
    const d = doc('2026-10-15', 1234);
    runMatching(db, T0, { windows: W });
    review(d, { txnDate: '2026-10-15', amount: 1234, vendor: 'カフェテスト' }, 'reject', 'rejected');
    assert.deepEqual(receipt(t), { receipt: 'waiting', receipt_hint: null, mail_hint: null });
  });

  test('auto の後に確定で金額が変わったら効かない。confirmed は効き続ける', () => {
    const acc = account('bank');
    const t1 = txn(acc, '2026-10-15', 1234);
    const d1 = doc('2026-10-15', 1234);
    runMatching(db, T0, { windows: W });
    review(d1, { txnDate: '2026-10-15', amount: 1243, vendor: 'カフェテスト' });
    assert.equal(receipt(t1).receipt, 'waiting');

    const t2 = txn(acc, '2026-10-20', 5678);
    const d2 = doc('2026-10-20', 5678);
    linkDocument(db, { txnId: t2, documentId: d2, user: null, now: T0, windows: W });
    review(d2, { txnDate: '2026-10-20', amount: 5687, vendor: 'カフェテスト' });
    assert.equal(receipt(t2).receipt, 'matched');
  });

  test('1 つの明細に 2 つの証憑を人が付けられる（分割の請求など）', () => {
    const t = txn(account('card'), '2026-10-15', 3000);
    const d1 = doc('2026-10-14', 1000);
    const d2 = doc('2026-10-14', 2000);
    linkDocument(db, { txnId: t, documentId: d1, user: null, now: T0, windows: W });
    const r = linkDocument(db, { txnId: t, documentId: d2, user: null, now: T0, windows: W });
    assert.deepEqual(r.warnings, ['amount_mismatch']);
    assert.equal(receipt(t).receipt, 'pending_review');
    assert.deepEqual(receipt(t).receipt_hint, { document_id: d2, status: 'needs_review' });
  });
});

describe('receipt', () => {
  test('matched・pending_review・candidate・waiting と null（入金・振替・private）', () => {
    const acc = account('bank');
    const matched = txn(acc, '2026-10-01', 1111);
    review(doc('2026-10-01', 1111), { txnDate: '2026-10-01', amount: 1111, vendor: 'カフェテスト' });
    const pending = txn(acc, '2026-10-02', 2222);
    doc('2026-10-02', 2222);
    runMatching(db, T0, { windows: W });
    const candidate = txn(acc, '2026-10-03', 3333);
    doc('2026-10-03', 3333, '別の店');
    doc('2026-10-04', 3333, '別の店'); // 2 件あるので auto にならない
    const waiting = txn(acc, '2026-10-05', 4444);
    const income = txn(acc, '2026-10-06', 5555, 'ｶﾌｪ ﾃｽﾄ', 'income');
    const out = txn(acc, '2026-10-07', 6666);
    const other = account('bank');
    insertTransferLink(db, { outTxnId: out, inTxnId: txn(other, '2026-10-07', 6666, 'ﾌﾘｶｴ', 'income'), kind: 'transfer', source: 'auto', state: 'active', now: NOW });
    const priv = txn(acc, '2026-10-08', 7777);
    setTxnTag(db, { txnId: priv, tag: 'private', actor: 'user', source: 'human', now: T0 });
    const m = receiptStatusBulk(db, [matched, pending, candidate, waiting, income, out, priv], W);
    assert.deepEqual(
      [matched, pending, candidate, waiting, income, out, priv].map((id) => m.get(id)!.receipt),
      ['matched', 'pending_review', 'candidate', 'waiting', null, null, null],
    );
  });

  test('私用のタグにしたら待ちから消える。紐付けたら待ちから消える（T207）', () => {
    const acc = account('bank');
    const a = txn(acc, '2026-10-01', 1111);
    const b = txn(acc, '2026-10-02', 2222);
    assert.equal(receipt(a).receipt, 'waiting');
    assert.equal(receipt(b).receipt, 'waiting');
    setTxnTag(db, { txnId: a, tag: 'private', actor: 'user', source: 'human', now: T0 });
    assert.equal(receipt(a).receipt, null);
    linkDocument(db, { txnId: b, documentId: doc('2026-09-01', 9999), user: null, now: T0, windows: W });
    assert.equal(receipt(b).receipt, 'pending_review');
  });

  test('active = 0 の口座の明細は経費にしない', () => {
    const acc = account('bank');
    const t = txn(acc, '2026-10-01', 1111);
    updateAccountSettings(db, acc, { active: false }, NOW);
    assert.equal(receipt(t).receipt, null);
  });
});

describe('txn_matches は追記専用', () => {
  test('UPDATE・DELETE が失敗する', () => {
    const t = txn(account('bank'), '2026-10-15', 1234);
    doc('2026-10-15', 1234);
    runMatching(db, T0, { windows: W });
    assert.throws(() => db.prepare(`UPDATE txn_matches SET state = 'rejected'`).run(), /追記専用/);
    assert.throws(() => db.prepare('DELETE FROM txn_matches').run(), /追記専用/);
    assert.equal(rows().length, 1);
    assert.equal(rows()[0]!.bank_txn_id, t);
  });
});

describe('mail_hint（本文だけのメールの手がかり。src/mail/hints.ts）', () => {
  let mailN = 0;
  // 手がかりを抜き出した body_only のメール。送信元・注文番号は架空の値。
  function mail(hintDate: string | null, hintAmount: number | null, over: { state?: string; orderRef?: string | null } = {}): string {
    const id = `M${String(++mailN).padStart(4, '0')}`;
    db.prepare(
      `INSERT INTO mail_messages (id, account_id, provider, remote_id, from_domain, subject, internal_at, received_on, state, attempts,
         hint_txn_date, hint_amount, hint_order_ref, hint_extracted_at, created_at, updated_at)
       VALUES (?, 'personal', 'gmail_api', ?, 'example.com', 'ご注文の確認', ?, '2026-10-16', ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(id, `r${id}`, NOW, over.state ?? 'body_only', hintDate, hintAmount, over.orderRef === undefined ? '123-0000000' : over.orderRef, NOW, NOW, NOW);
    return id;
  }
  const view = (id: string) => ({ mail_message_id: id, account_id: 'personal', received_on: '2026-10-16', from_domain: 'example.com', subject: 'ご注文の確認', order_ref: '123-0000000' });

  // 明細の日 − 手がかりの日（diff）と口座の種別で、付くか。
  const cases: { name: string; kind: AccountKind; diff: number; amountDelta?: number; want: boolean }[] = [
    { name: '同じ日・同じ金額 → 付く', kind: 'bank', diff: 0, want: true },
    { name: '−1 日 → 付く', kind: 'bank', diff: -1, want: true },
    { name: '−2 日 → 外れる', kind: 'bank', diff: -2, want: false },
    { name: '銀行 +3 日 → 付く', kind: 'bank', diff: 3, want: true },
    { name: '銀行 +4 日（W+1）→ 外れる', kind: 'bank', diff: 4, want: false },
    { name: 'カード +10 日 → 付く', kind: 'card', diff: 10, want: true },
    { name: 'カード +11 日（W+1）→ 外れる', kind: 'card', diff: 11, want: false },
    { name: '金額が 1 円違う → 外れる', kind: 'bank', diff: 0, amountDelta: 1, want: false },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const t = txn(account(c.kind), '2026-10-15', 1234);
      const m = mail(new Date(Date.UTC(2026, 9, 15 - c.diff)).toISOString().slice(0, 10), 1234 + (c.amountDelta ?? 0));
      assert.equal(receipt(t).receipt, 'waiting');
      assert.deepEqual(receipt(t).mail_hint, c.want ? view(m) : null);
    });
  }

  test('日付差が最小の 1 件。候補のある明細（candidate）にも付く', () => {
    const t = txn(account('card'), '2026-10-15', 1234);
    mail('2026-10-10', 1234);
    const near = mail('2026-10-14', 1234);
    mail('2026-10-16', 1234, { orderRef: null }); // −1 日（絶対値 1 で同じ）。先の行を採る
    doc('2026-10-12', 1234, '別の店');
    doc('2026-10-13', 1234, '別の店');
    assert.equal(receipt(t).receipt, 'candidate');
    assert.deepEqual(receipt(t).mail_hint, view(near));
  });

  test('紐付いた明細（pending_review）・経費でない明細には付かない。日付・金額の無い手がかり・body_only 以外は使わない', () => {
    const acc = account('bank');
    const linked = txn(acc, '2026-10-15', 1234);
    linkDocument(db, { txnId: linked, documentId: doc('2026-09-01', 9999), user: null, now: T0, windows: W });
    const priv = txn(account('bank', 'private'), '2026-10-15', 1234);
    const unset = txn(account('bank', 'unset'), '2026-10-15', 1234);
    mail('2026-10-15', 1234);
    assert.equal(receipt(linked).receipt, 'pending_review');
    assert.equal(receipt(linked).mail_hint, null);
    assert.equal(receipt(priv).mail_hint, null);
    assert.equal(receipt(unset).mail_hint, null);

    const t = txn(acc, '2026-10-20', 2222);
    mail(null, 2222);
    mail('2026-10-20', null);
    mail('2026-10-20', 2222, { state: 'ingested' });
    assert.equal(receipt(t).mail_hint, null);
  });

  test('一括で引く: 複数の明細に 1 回で付ける', () => {
    const acc = account('bank');
    const ids = Array.from({ length: 5 }, (_, i) => txn(acc, `2026-10-1${i}`, 1000 + i));
    const m = mail('2026-10-12', 1002);
    const out = receiptStatusBulk(db, ids, W);
    assert.deepEqual(ids.map((id) => out.get(id)!.mail_hint?.mail_message_id ?? null), [null, null, m, null, null]);
  });
});
