// 重複排除（T106）と振替の検出（T107）が使う SQL（docs/mvp-plan-v3.md §4・§7、0005_bank.sql）。
// 照合の判断はここに入れない（dedup.ts・transfers.ts）。repo.ts に無い読み書きだけを置く。
import type { Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';
import type { BankTxnRow, TxnSide, TxnSource } from './repo.ts';

export type TransferKind = 'transfer' | 'card_settlement' | 'charge';
export type TransferLinkSource = 'auto' | 'human';
export type TransferState = 'active' | 'rejected';

export type TransferLinkRow = {
  seq: number;
  id: string;
  out_txn_id: string;
  in_txn_id: string | null;
  kind: TransferKind;
  source: TransferLinkSource;
  state: TransferState;
  created_at: string;
};

// 明細に口座の種別と bank_txns の rowid（挿入順）を添えたもの。
export type TxnWithAccount = BankTxnRow & { seq: number; account_kind: string };

// ---- 重複排除（T106） ----

// 同じ口座・side・金額で、日付が [from, to] の明細のうち、取得元 source をまだ持たないもの。日付、挿入順に並べる。
export function findDedupCandidates(
  db: Db,
  q: { accountId: string; side: TxnSide; amount: number; from: string; to: string; source: TxnSource },
): (BankTxnRow & { seq: number })[] {
  return db
    .prepare(
      `SELECT t.rowid AS seq, t.* FROM bank_txns t
       WHERE t.account_id = ? AND t.side = ? AND t.amount = ? AND t.txn_date BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM bank_txn_sources s WHERE s.bank_txn_id = t.id AND s.source = ?)
       ORDER BY t.txn_date, t.rowid`,
    )
    .all(q.accountId, q.side, q.amount, q.from, q.to, q.source) as (BankTxnRow & { seq: number })[];
}

// 残高が NULL のときだけ埋める（CSV で先に入った明細に、後から API の残高を入れる）。
export function fillBankTxnBalance(db: Db, id: string, balance: number): void {
  db.prepare('UPDATE bank_txns SET balance = ? WHERE id = ? AND balance IS NULL').run(balance, id);
}

export function getCsvImportAccount(db: Db, csvImportId: string): string | null {
  const r = db.prepare('SELECT account_id FROM csv_imports WHERE id = ?').get(csvImportId) as { account_id: string } | undefined;
  return r?.account_id ?? null;
}

// ---- 振替（T107） ----

// active な口座の明細を口座の種別付きで返す。範囲を渡さなければ全件。
export function listTxnsWithAccount(db: Db, range: { from?: string; to?: string } = {}): TxnWithAccount[] {
  return db
    .prepare(
      `SELECT t.rowid AS seq, t.*, a.kind AS account_kind FROM bank_txns t JOIN money_accounts a ON a.id = t.account_id
       WHERE a.active = 1 AND (? IS NULL OR t.txn_date >= ?) AND (? IS NULL OR t.txn_date <= ?)
       ORDER BY t.txn_date, t.rowid`,
    )
    .all(range.from ?? null, range.from ?? null, range.to ?? null, range.to ?? null) as TxnWithAccount[];
}

// 組（out_txn_id, in_txn_id）ごとの最新の行（seq 最大）。
const LATEST = `SELECT l.* FROM transfer_links l
  WHERE l.seq = (SELECT max(m.seq) FROM transfer_links m WHERE m.out_txn_id = l.out_txn_id AND m.in_txn_id IS l.in_txn_id)`;

// 組の両側（card_settlement は出金側だけ）が active な口座の明細か。x は LATEST の行。
const BOTH_ACTIVE = `EXISTS (SELECT 1 FROM bank_txns ot JOIN money_accounts oa ON oa.id = ot.account_id WHERE ot.id = x.out_txn_id AND oa.active = 1)
  AND (x.in_txn_id IS NULL OR EXISTS (SELECT 1 FROM bank_txns it JOIN money_accounts ia ON ia.id = it.account_id WHERE it.id = x.in_txn_id AND ia.active = 1))`;

// 組ごとの最新の行のうち、両側が active な口座の明細のもの。
export function listLatestTransferLinks(db: Db): TransferLinkRow[] {
  return db.prepare(`SELECT x.* FROM (${LATEST}) x WHERE ${BOTH_ACTIVE} ORDER BY x.seq`).all() as TransferLinkRow[];
}

// 有効な組（両側が active な口座の明細のものだけ）。範囲は出金側の明細の日付で絞る。
export function listActiveTransferLinks(db: Db, range: { from?: string; to?: string } = {}): (TransferLinkRow & { out_date: string; amount: number })[] {
  return db
    .prepare(
      `SELECT x.*, t.txn_date AS out_date, t.amount AS amount FROM (${LATEST}) x JOIN bank_txns t ON t.id = x.out_txn_id
       WHERE x.state = 'active' AND ${BOTH_ACTIVE} AND (? IS NULL OR t.txn_date >= ?) AND (? IS NULL OR t.txn_date <= ?)
       ORDER BY t.txn_date, x.seq`,
    )
    .all(range.from ?? null, range.from ?? null, range.to ?? null, range.to ?? null) as (TransferLinkRow & { out_date: string; amount: number })[];
}

export function getTransferLink(db: Db, id: string): TransferLinkRow | null {
  return (db.prepare('SELECT * FROM transfer_links WHERE id = ?').get(id) as TransferLinkRow | undefined) ?? null;
}

export function latestTransferLinkForPair(db: Db, outTxnId: string, inTxnId: string | null): TransferLinkRow | null {
  return (
    (db.prepare('SELECT * FROM transfer_links WHERE out_txn_id = ? AND in_txn_id IS ? ORDER BY seq DESC LIMIT 1').get(outTxnId, inTxnId) as
      | TransferLinkRow
      | undefined) ?? null
  );
}

export function insertTransferLink(
  db: Db,
  l: { outTxnId: string; inTxnId: string | null; kind: TransferKind; source: TransferLinkSource; state: TransferState; now: string },
): TransferLinkRow {
  const id = ulid();
  db.prepare('INSERT INTO transfer_links (id, out_txn_id, in_txn_id, kind, source, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, l.outTxnId, l.inTxnId, l.kind, l.source, l.state, l.now,
  );
  return getTransferLink(db, id)!;
}
