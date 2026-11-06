// 明細の重複排除（docs/mvp-plan-v3.md T106）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { insertAccount, listBankTxnSources, getBankTxn } from '../../src/bank/repo.ts';
import { addDays, dedupAndInsert, type DedupInput } from '../../src/bank/dedup.ts';

const now = '2026-11-06T00:00:00.000Z';
const later = '2026-11-07T00:00:00.000Z';
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-dedup-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(): { db: Db; acc: string } {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  const acc = insertAccount(db, { provider: 'fake', name: '銀行', kind: 'bank', source: 'csv', now }).id;
  return { db, acc };
}

const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

type Row = [source: 'freee' | 'csv', externalId: string, date: string, amount: number, side?: 'income' | 'expense'];
const rows = (acc: string, rs: Row[]): DedupInput[] =>
  rs.map(([source, externalId, txnDate, amount, side]) => ({
    accountId: acc, source, externalId, txnDate, amount, side: side ?? 'expense', description: `ﾃｽﾄ ${externalId}`,
  }));

type Case = {
  name: string;
  window: number;
  first: Row[]; // 先に入れる（API など）
  second: Row[]; // 後から入れる（CSV など）
  want: { new: number; merged: number; touched: number; suspects: number; txns: number };
};

const cases: Case[] = [
  {
    name: '同じ日・同じ金額の 1 件ずつ → 統合',
    window: 0,
    first: [['freee', 'f1', '2026-10-01', 1000]],
    second: [['csv', 'c1', '2026-10-01', 1000]],
    want: { new: 0, merged: 1, touched: 0, suspects: 0, txns: 1 },
  },
  {
    name: '同額・同日に 2 件ずつ → 出現順で 1 対 1 に組む',
    window: 0,
    first: [['freee', 'f1', '2026-10-01', 500], ['freee', 'f2', '2026-10-01', 500]],
    second: [['csv', 'c1', '2026-10-01', 500], ['csv', 'c2', '2026-10-01', 500]],
    want: { new: 0, merged: 2, touched: 0, suspects: 0, txns: 2 },
  },
  {
    name: '同額・同日に API 1 件、CSV 2 件 → 1 件統合、1 件は新規で疑い',
    window: 0,
    first: [['freee', 'f1', '2026-10-01', 500]],
    second: [['csv', 'c1', '2026-10-01', 500], ['csv', 'c2', '2026-10-01', 500]],
    want: { new: 1, merged: 1, touched: 0, suspects: 1, txns: 2 },
  },
  {
    name: '片側だけに存在する → 新規（疑いにしない）',
    window: 0,
    first: [['freee', 'f1', '2026-10-01', 1000]],
    second: [['csv', 'c1', '2026-10-01', 1000], ['csv', 'c2', '2026-10-05', 2000], ['csv', 'c3', '2026-10-01', 1000, 'income']],
    want: { new: 2, merged: 1, touched: 0, suspects: 0, txns: 3 },
  },
  {
    name: '日付が 1 日ずれる・幅 0 → 別の明細',
    window: 0,
    first: [['freee', 'f1', '2026-10-01', 1000]],
    second: [['csv', 'c1', '2026-10-02', 1000]],
    want: { new: 1, merged: 0, touched: 0, suspects: 0, txns: 2 },
  },
  {
    name: '日付が 1 日ずれる・幅 1 → 統合',
    window: 1,
    first: [['freee', 'f1', '2026-10-31', 1000]],
    second: [['csv', 'c1', '2026-11-01', 1000]],
    want: { new: 0, merged: 1, touched: 0, suspects: 0, txns: 1 },
  },
  {
    name: '幅 1 で候補が前後に 2 件 → 1 件と組み、疑いにはしない',
    window: 1,
    first: [['freee', 'f1', '2026-10-01', 1000], ['freee', 'f2', '2026-10-03', 1000]],
    second: [['csv', 'c1', '2026-10-02', 1000]],
    want: { new: 0, merged: 1, touched: 0, suspects: 0, txns: 2 },
  },
  {
    name: '日付が 2 日ずれる・幅 1 → 別の明細',
    window: 1,
    first: [['freee', 'f1', '2026-10-01', 1000]],
    second: [['csv', 'c1', '2026-10-03', 1000]],
    want: { new: 1, merged: 0, touched: 0, suspects: 0, txns: 2 },
  },
  {
    name: '同じ取得元の別の外部 ID は統合しない',
    window: 0,
    first: [['csv', 'c1', '2026-10-01', 1000]],
    second: [['csv', 'c2', '2026-10-01', 1000]],
    want: { new: 1, merged: 0, touched: 0, suspects: 0, txns: 2 },
  },
  {
    name: '同じ行を重ねて入れても増えない',
    window: 0,
    first: [['csv', 'c1', '2026-10-01', 1000], ['csv', 'c2', '2026-10-01', 1000]],
    second: [['csv', 'c1', '2026-10-01', 1000], ['csv', 'c2', '2026-10-01', 1000]],
    want: { new: 0, merged: 0, touched: 2, suspects: 0, txns: 2 },
  },
];

describe('dedupAndInsert（表駆動）', () => {
  for (const c of cases) {
    test(c.name, () => {
      const { db, acc } = setup();
      try {
        const r1 = dedupAndInsert(db, rows(acc, c.first), { dateWindowDays: c.window, now });
        assert.equal(r1.new.length, c.first.length);
        const r2 = dedupAndInsert(db, rows(acc, c.second), { dateWindowDays: c.window, now: later });
        assert.deepEqual(
          { new: r2.new.length, merged: r2.merged.length, touched: r2.touched.length, suspects: r2.suspects.length, txns: count(db, 'bank_txns') },
          c.want,
        );
        assert.deepEqual(r2.errors, []);
        assert.equal(count(db, 'bank_txn_sources'), c.first.length + c.second.length - c.want.touched);
      } finally {
        db.close();
      }
    });
  }
});

describe('dedupAndInsert（細部）', () => {
  test('同額・同日 2 件は出現順に組む（1 件目同士・2 件目同士）', () => {
    const { db, acc } = setup();
    try {
      const r1 = dedupAndInsert(db, rows(acc, [['freee', 'f1', '2026-10-01', 500], ['freee', 'f2', '2026-10-01', 500]]), { dateWindowDays: 0, now });
      const r2 = dedupAndInsert(db, rows(acc, [['csv', 'c1', '2026-10-01', 500], ['csv', 'c2', '2026-10-01', 500]]), { dateWindowDays: 0, now });
      assert.deepEqual(r2.merged.map((h) => h.bankTxnId), r1.new.map((h) => h.bankTxnId));
      assert.deepEqual(listBankTxnSources(db, r1.new[0]!.bankTxnId).map((s) => s.external_id), ['f1', 'c1']);
    } finally {
      db.close();
    }
  });

  test('疑いには候補だった明細の ID が付く', () => {
    const { db, acc } = setup();
    try {
      const r1 = dedupAndInsert(db, rows(acc, [['freee', 'f1', '2026-10-01', 500]]), { dateWindowDays: 0, now });
      const r2 = dedupAndInsert(db, rows(acc, [['csv', 'c1', '2026-10-01', 500], ['csv', 'c2', '2026-10-01', 500]]), { dateWindowDays: 0, now });
      assert.equal(r2.suspects.length, 1);
      assert.equal(r2.suspects[0]!.index, 1);
      assert.deepEqual(r2.suspects[0]!.candidateIds, [r1.new[0]!.bankTxnId]);
    } finally {
      db.close();
    }
  });

  test('同じ入力の中で外部 ID が重なった行は 1 件にする', () => {
    const { db, acc } = setup();
    try {
      const r = dedupAndInsert(db, rows(acc, [['csv', 'c1', '2026-10-01', 500], ['csv', 'c1', '2026-10-01', 500]]), { dateWindowDays: 0, now });
      assert.equal(r.new.length, 1);
      assert.deepEqual(r.touched, [{ index: 1, bankTxnId: r.new[0]!.bankTxnId }]);
      assert.equal(count(db, 'bank_txns'), 1);
    } finally {
      db.close();
    }
  });

  test('touch は last_seen_at と freee_status を書く', () => {
    const { db, acc } = setup();
    try {
      const [inp] = rows(acc, [['freee', 'f1', '2026-10-01', 500]]);
      const r1 = dedupAndInsert(db, [{ ...inp!, freeeStatus: 1 }], { dateWindowDays: 0, now });
      dedupAndInsert(db, [{ ...inp!, freeeStatus: 2 }], { dateWindowDays: 0, now: later });
      const t = getBankTxn(db, r1.new[0]!.bankTxnId)!;
      assert.equal(t.last_seen_at, later);
      assert.equal(t.freee_status, 2);
      assert.equal(t.description_norm, 'テスト f1'.normalize('NFKC').toLowerCase().replace(/\s/g, ''));
    } finally {
      db.close();
    }
  });

  test('検査に落ちた行は errors に入り、他の行は入る', () => {
    const { db, acc } = setup();
    try {
      const good = rows(acc, [['csv', 'c1', '2026-10-01', 500]])[0]!;
      const r = dedupAndInsert(
        db,
        [good, { ...good, externalId: 'x1', amount: 0 }, { ...good, externalId: 'x2', txnDate: '2026-02-30' }, { ...good, externalId: 'x3', accountId: 'nope' },
          { ...good, externalId: 'x4', csvImportId: 'nope' }],
        { dateWindowDays: 0, now },
      );
      assert.equal(r.new.length, 1);
      assert.deepEqual(r.errors.map((e) => [e.index, e.reason]), [[1, 'invalid_amount'], [2, 'invalid_date'], [3, 'account_not_found'], [4, 'csv_import_mismatch']]);
    } finally {
      db.close();
    }
  });

  test('途中で例外が出たら全体を戻す', () => {
    const { db, acc } = setup();
    try {
      db.exec(`CREATE TRIGGER t_fail BEFORE INSERT ON bank_txn_sources WHEN NEW.external_id = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
      assert.throws(() => dedupAndInsert(db, rows(acc, [['csv', 'c1', '2026-10-01', 500], ['csv', 'boom', '2026-10-02', 600]]), { dateWindowDays: 0, now }));
      assert.equal(count(db, 'bank_txns'), 0);
    } finally {
      db.close();
    }
  });

  test('CSV が先・freee が後で統合 → freee_status・due_amount・balance・last_seen_at が入る', () => {
    const { db, acc } = setup();
    try {
      const [c] = rows(acc, [['csv', 'c1', '2026-10-01', 500]]);
      const r1 = dedupAndInsert(db, [{ ...c!, balance: null }], { dateWindowDays: 0, now });
      const [f] = rows(acc, [['freee', 'f1', '2026-10-01', 500]]);
      const r2 = dedupAndInsert(db, [{ ...f!, freeeStatus: 1, dueAmount: 500, balance: 12000 }], { dateWindowDays: 0, now: later });
      assert.equal(r2.merged.length, 1);
      const t = getBankTxn(db, r1.new[0]!.bankTxnId)!;
      assert.deepEqual([t.freee_status, t.due_amount, t.balance, t.last_seen_at], [1, 500, 12000, later]);
    } finally {
      db.close();
    }
  });

  test('freee が先・CSV が後で統合 → freee の値は消えず、残高も上書きしない', () => {
    const { db, acc } = setup();
    try {
      const [f] = rows(acc, [['freee', 'f1', '2026-10-01', 500]]);
      const r1 = dedupAndInsert(db, [{ ...f!, freeeStatus: 2, dueAmount: 0, balance: 12000 }], { dateWindowDays: 0, now });
      const [c] = rows(acc, [['csv', 'c1', '2026-10-01', 500]]);
      dedupAndInsert(db, [{ ...c!, freeeStatus: null, dueAmount: null, balance: 99999 }], { dateWindowDays: 0, now: later });
      // 同じ CSV をもう一度（touch）でも消えない。
      dedupAndInsert(db, [{ ...c!, freeeStatus: null, dueAmount: null }], { dateWindowDays: 0, now: later });
      const t = getBankTxn(db, r1.new[0]!.bankTxnId)!;
      assert.deepEqual([t.freee_status, t.due_amount, t.balance, t.last_seen_at], [2, 0, 12000, later]);
    } finally {
      db.close();
    }
  });

  test('窓 1: 入力の並び順（古い順・新しい順）によらず同じ組になる', () => {
    const existing: Row[] = [['freee', 'f1', '2026-10-01', 700], ['freee', 'f2', '2026-10-02', 700], ['freee', 'f3', '2026-10-04', 700]];
    const csv: Row[] = [['csv', 'c1', '2026-10-01', 700], ['csv', 'c2', '2026-10-02', 700], ['csv', 'c3', '2026-10-03', 700]];
    const run = (order: Row[]) => {
      const { db, acc } = setup();
      try {
        const r1 = dedupAndInsert(db, rows(acc, existing), { dateWindowDays: 1, now });
        const name = new Map(r1.new.map((h) => [h.bankTxnId, existing[h.index]![1]]));
        const r2 = dedupAndInsert(db, rows(acc, order), { dateWindowDays: 1, now });
        return Object.fromEntries(r2.merged.map((h) => [order[h.index]![1], name.get(h.bankTxnId)]));
      } finally {
        db.close();
      }
    };
    const asc = run(csv);
    // 同じ日の明細と組む（c1-f1、c2-f2）。c3 は 1 日差の f3 と組む。
    assert.deepEqual(asc, { c1: 'f1', c2: 'f2', c3: 'f3' });
    assert.deepEqual(run([...csv].reverse()), asc);
  });

  test('窓 1: 日付の違う入力が同じ明細を取り合ったら、組めなかった方は疑い', () => {
    const { db, acc } = setup();
    try {
      const r1 = dedupAndInsert(db, rows(acc, [['freee', 'f1', '2026-10-02', 700]]), { dateWindowDays: 1, now });
      const r2 = dedupAndInsert(db, rows(acc, [['csv', 'c3', '2026-10-03', 700], ['csv', 'c1', '2026-10-01', 700]]), { dateWindowDays: 1, now });
      assert.deepEqual(r2.merged.map((h) => h.index), [1]); // 日付の早い c1 が先に組む
      assert.deepEqual(r2.suspects.map((h) => [h.index, h.candidateIds]), [[0, [r1.new[0]!.bankTxnId]]]);
    } finally {
      db.close();
    }
  });

  test('同じ外部 ID で日付・金額が違う 2 行目は errors（touch しない）', () => {
    const { db, acc } = setup();
    try {
      const r = dedupAndInsert(
        db,
        rows(acc, [['csv', 'c1', '2026-10-01', 500], ['csv', 'c1', '2026-10-01', 501], ['csv', 'c1', '2026-10-02', 500]]),
        { dateWindowDays: 0, now },
      );
      assert.equal(r.new.length, 1);
      assert.deepEqual(r.touched, []);
      assert.deepEqual(r.errors, [{ index: 1, reason: 'external_id_conflict' }, { index: 2, reason: 'external_id_conflict' }]);
      // 既にある明細と金額が違う再取り込みも errors。
      const r2 = dedupAndInsert(db, rows(acc, [['csv', 'c1', '2026-10-01', 999]]), { dateWindowDays: 0, now });
      assert.deepEqual(r2.errors, [{ index: 0, reason: 'external_id_conflict' }]);
    } finally {
      db.close();
    }
  });

  test('addDays は月末・うるう年をまたぐ', () => {
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });
});
