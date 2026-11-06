// 口座間振替・カードの引き落とし・チャージの検出（docs/mvp-plan-v3.md T107）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { verifyAudit } from '../../src/audit.ts';
import { insertAccount, insertBankTxn, updateAccountSettings, type AccountKind } from '../../src/bank/repo.ts';
import {
  detectTransfers,
  excludedFromCashflow,
  listActiveTransfers,
  matchesSettlementPattern,
  rejectTransfer,
} from '../../src/bank/transfers.ts';

const now = '2026-11-06T00:00:00.000Z';
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-transfers-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

type Accs = Record<'A' | 'B' | 'C' | 'card' | 'paypay', string>;

function setup(): { db: Db; acc: Accs } {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  const mk = (name: string, kind: AccountKind) => insertAccount(db, { provider: 'fake', name, kind, source: 'csv', now }).id;
  const acc: Accs = { A: mk('銀行A', 'bank'), B: mk('銀行B', 'bank'), C: mk('銀行C', 'bank'), card: mk('カード', 'card'), paypay: mk('PayPay', 'paypay') };
  return { db, acc };
}

const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

type T = [account: keyof Accs, date: string, amount: number, side: 'income' | 'expense', desc?: string];
function addTxns(db: Db, acc: Accs, ts: T[]): string[] {
  return ts.map(([a, txnDate, amount, side, desc]) =>
    insertBankTxn(db, { accountId: acc[a], txnDate, amount, side, description: desc ?? 'ﾌﾘｺﾐ', descriptionNorm: desc ?? 'ふりこみ', now }).id,
  );
}

type Case = {
  name: string;
  window?: number;
  txns: T[];
  want: [outIdx: number, inIdx: number | null, kind: string][];
};

const cases: Case[] = [
  {
    name: 'ちょうど 1 対 1 → transfer',
    txns: [['A', '2026-10-01', 30000, 'expense'], ['B', '2026-10-01', 30000, 'income']],
    want: [[0, 1, 'transfer']],
  },
  {
    name: '日付差 3 日（窓の端）→ 組む',
    txns: [['A', '2026-10-01', 30000, 'expense'], ['B', '2026-10-04', 30000, 'income']],
    want: [[0, 1, 'transfer']],
  },
  {
    name: '日付差 4 日（窓の外）→ 組まない',
    txns: [['A', '2026-10-01', 30000, 'expense'], ['B', '2026-10-05', 30000, 'income']],
    want: [],
  },
  {
    name: '窓 0 日で日付差 1 日 → 組まない',
    window: 0,
    txns: [['A', '2026-10-01', 30000, 'expense'], ['B', '2026-10-02', 30000, 'income']],
    want: [],
  },
  {
    name: '入金の候補が 2 件 → 作らない',
    txns: [['A', '2026-10-01', 30000, 'expense'], ['B', '2026-10-01', 30000, 'income'], ['C', '2026-10-02', 30000, 'income']],
    want: [],
  },
  {
    name: '出金の候補が 2 件 → 作らない',
    txns: [['A', '2026-10-01', 30000, 'expense'], ['C', '2026-10-01', 30000, 'expense'], ['B', '2026-10-01', 30000, 'income']],
    want: [],
  },
  {
    name: '同じ口座の中の出金と入金 → 組まない',
    txns: [['A', '2026-10-01', 30000, 'expense'], ['A', '2026-10-01', 30000, 'income']],
    want: [],
  },
  {
    name: '金額が違う → 組まない',
    txns: [['A', '2026-10-01', 30000, 'expense'], ['B', '2026-10-01', 30001, 'income']],
    want: [],
  },
  {
    name: '銀行から PayPay への入金 → charge',
    txns: [['A', '2026-10-01', 5000, 'expense', 'PAYPAY'], ['paypay', '2026-10-01', 5000, 'income', 'チャージ']],
    want: [[0, 1, 'charge']],
  },
  {
    name: 'カードから PayPay への入金 → charge',
    txns: [['card', '2026-10-01', 5000, 'expense', 'PAYPAY'], ['paypay', '2026-10-02', 5000, 'income', 'チャージ']],
    want: [[0, 1, 'charge']],
  },
  {
    name: 'カードの引き落とし → card_settlement（in は NULL）',
    txns: [['A', '2026-10-27', 48210, 'expense', 'ｶ-ﾄﾞ ﾐﾂｲｽﾐﾄﾓ']],
    want: [[0, null, 'card_settlement']],
  },
  {
    name: '引き落とし口座でない口座の同じ摘要 → card_settlement にしない',
    txns: [['B', '2026-10-27', 48210, 'expense', 'ｶ-ﾄﾞ ﾐﾂｲｽﾐﾄﾓ']],
    want: [],
  },
  {
    name: '引き落としは振替より先に決まり、同額の入金と組まない',
    txns: [['A', '2026-10-27', 48210, 'expense', 'ｶ-ﾄﾞ ﾐﾂｲｽﾐﾄﾓ'], ['B', '2026-10-27', 48210, 'income']],
    want: [[0, null, 'card_settlement']],
  },
];

describe('detectTransfers（表駆動）', () => {
  for (const c of cases) {
    test(c.name, () => {
      const { db, acc } = setup();
      try {
        updateAccountSettings(db, acc.card, { cardSettlementAccountId: acc.A, cardSettlementPattern: 'ﾐﾂｲｽﾐﾄﾓ' }, now);
        const ids = addTxns(db, acc, c.txns);
        const made = detectTransfers(db, { windowDays: c.window ?? 3, now });
        assert.deepEqual(
          made.map((l) => [l.out_txn_id, l.in_txn_id, l.kind, l.source, l.state]),
          c.want.map(([o, i, k]) => [ids[o], i === null ? null : ids[i], k, 'auto', 'active']),
        );
      } finally {
        db.close();
      }
    });
  }
});

describe('detectTransfers（作り直さない）', () => {
  test('2 回走らせても active の組を作り直さない', () => {
    const { db, acc } = setup();
    try {
      addTxns(db, acc, [['A', '2026-10-01', 30000, 'expense'], ['B', '2026-10-01', 30000, 'income']]);
      assert.equal(detectTransfers(db, { windowDays: 3, now }).length, 1);
      assert.equal(detectTransfers(db, { windowDays: 3, now }).length, 0);
      assert.equal(count(db, 'transfer_links'), 1);
    } finally {
      db.close();
    }
  });

  test('active の組に入った明細は、後から来た同額の明細と組まない', () => {
    const { db, acc } = setup();
    try {
      addTxns(db, acc, [['A', '2026-10-01', 30000, 'expense'], ['B', '2026-10-01', 30000, 'income']]);
      detectTransfers(db, { windowDays: 3, now });
      addTxns(db, acc, [['C', '2026-10-02', 30000, 'income']]);
      assert.equal(detectTransfers(db, { windowDays: 3, now }).length, 0);
    } finally {
      db.close();
    }
  });

  test('外した組（rejected が最新）は作り直さない', () => {
    const { db, acc } = setup();
    try {
      addTxns(db, acc, [['A', '2026-10-01', 30000, 'expense'], ['B', '2026-10-01', 30000, 'income']]);
      const [l] = detectTransfers(db, { windowDays: 3, now });
      const r = rejectTransfer(db, l!.id, 'user', new Date(now))!;
      assert.equal(r.state, 'rejected');
      assert.equal(r.source, 'human');
      assert.equal(detectTransfers(db, { windowDays: 3, now }).length, 0);
      assert.equal(count(db, 'transfer_links'), 2);
      assert.deepEqual(listActiveTransfers(db), []);
      // 2 回外しても行は増えない。
      rejectTransfer(db, l!.id, 'user', new Date(now));
      assert.equal(count(db, 'transfer_links'), 2);
      const audit = db.prepare(`SELECT actor, action FROM audit_log WHERE action = 'transfer.rejected'`).all();
      assert.deepEqual(audit.map((a) => ({ ...a })), [{ actor: 'user', action: 'transfer.rejected' }]);
      assert.equal(verifyAudit(db).ok, true);
    } finally {
      db.close();
    }
  });

  test('外した引き落とし（in が NULL）も作り直さない', () => {
    const { db, acc } = setup();
    try {
      updateAccountSettings(db, acc.card, { cardSettlementAccountId: acc.A, cardSettlementPattern: 'ﾐﾂｲｽﾐﾄﾓ' }, now);
      addTxns(db, acc, [['A', '2026-10-27', 48210, 'expense', 'ｶ-ﾄﾞ ﾐﾂｲｽﾐﾄﾓ']]);
      const [l] = detectTransfers(db, { windowDays: 3, now });
      assert.equal(l!.in_txn_id, null);
      rejectTransfer(db, l!.id, 'user', new Date(now));
      assert.equal(detectTransfers(db, { windowDays: 3, now }).length, 0);
    } finally {
      db.close();
    }
  });

  test('パターンが無いカードでは引き落としを検出しない', () => {
    const { db, acc } = setup();
    try {
      updateAccountSettings(db, acc.card, { cardSettlementAccountId: acc.A }, now);
      addTxns(db, acc, [['A', '2026-10-27', 48210, 'expense', 'ｶ-ﾄﾞ ﾐﾂｲｽﾐﾄﾓ']]);
      assert.equal(detectTransfers(db, { windowDays: 3, now }).length, 0);
    } finally {
      db.close();
    }
  });

  test('rejectTransfer は無い ID に null を返す', () => {
    const { db } = setup();
    try {
      assert.equal(rejectTransfer(db, 'nope', 'user'), null);
    } finally {
      db.close();
    }
  });
});

describe('範囲・一覧・集計から除く集合', () => {
  test('範囲を渡すと出金側の日付が範囲の組だけ作る（相手は窓の分だけ外も見る）', () => {
    const { db, acc } = setup();
    try {
      const ids = addTxns(db, acc, [
        ['A', '2026-10-31', 30000, 'expense'], ['B', '2026-11-01', 30000, 'income'],
        ['A', '2026-11-02', 7000, 'expense'], ['B', '2026-11-02', 7000, 'income'],
      ]);
      const made = detectTransfers(db, { windowDays: 3, now, from: '2026-10-01', to: '2026-10-31' });
      assert.deepEqual(made.map((l) => [l.out_txn_id, l.in_txn_id]), [[ids[0], ids[1]]]);
      assert.deepEqual(listActiveTransfers(db, { from: '2026-11-01', to: '2026-11-30' }), []);
      assert.equal(listActiveTransfers(db, { from: '2026-10-01', to: '2026-10-31' }).length, 1);
      // 月をまたぐ組の入金側（11 月）も除く集合に入る。
      assert.deepEqual(excludedFromCashflow(db), new Set([ids[0], ids[1]]));
    } finally {
      db.close();
    }
  });

  test('matchesSettlementPattern は全角・半角を揃え、空のパターンには当たらない', () => {
    assert.equal(matchesSettlementPattern('ｶ-ﾄﾞ ﾐﾂｲｽﾐﾄﾓ', 'ミツイスミトモ'), true);
    assert.equal(matchesSettlementPattern('ｶ-ﾄﾞ ﾐﾂｲｽﾐﾄﾓ', ''), false);
    assert.equal(matchesSettlementPattern('ｶ-ﾄﾞ ﾐﾂｲｽﾐﾄﾓ', null), false);
  });
});
