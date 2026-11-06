// 明細の重複排除（docs/mvp-plan-v3.md T106、requirements-v2.md A3）。同じ口座が API と CSV の両方から来ても 1 件にする。
// 次の順に照合し、どれにも当たらなければ新しい明細にする。
// 1. 同じ source・同じ口座・同じ external_id → 同じ明細（touch だけ）
// 2. source が違い、同じ口座・同じ日付（±dedupDateWindowDays）・同じ金額・同じ side の候補がちょうど 1 件 → bank_txn_sources を足す（統合）
// 3. 候補が複数 → 同じ日の中の出現順で 1 対 1 に組み、組めなかった分は新しい明細にして「重複の疑い」として返す
// 全体を 1 トランザクションで書く。入力の検査に落ちた行は errors に入れ、他の行は続ける。
import { tx, type Db } from '../db/index.ts';
import { normalizeVendor } from '../vendors/normalize.ts';
import {
  addBankTxnSource,
  findBankTxnByExternalId,
  getAccount,
  insertBankTxn,
  touchBankTxn,
  type FreeeTxnStatus,
  type TxnSide,
  type TxnSource,
} from './repo.ts';
import { findDedupCandidates, getCsvImportAccount } from './transferRepo.ts';

export type DedupInput = {
  accountId: string;
  source: TxnSource;
  externalId: string;
  txnDate: string; // YYYY-MM-DD
  amount: number; // 正の整数の円
  side: TxnSide;
  description: string;
  descriptionNorm?: string; // 省略時は normalizeVendor(description)
  csvImportId?: string | null;
  rawSha256?: string | null;
  balance?: number | null;
  freeeStatus?: FreeeTxnStatus | null;
  dueAmount?: number | null;
};

// index は入力の配列での位置。
export type DedupHit = { index: number; bankTxnId: string };
export type DedupSuspect = DedupHit & { candidateIds: string[] }; // candidateIds: 組む相手の候補だった既存の明細
export type DedupResult = {
  new: DedupHit[];
  merged: DedupHit[];
  touched: DedupHit[];
  suspects: DedupSuspect[];
  errors: { index: number; reason: string }[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validate(db: Db, c: DedupInput): string | null {
  if (!getAccount(db, c.accountId)) return 'account_not_found';
  if (c.source !== 'freee' && c.source !== 'csv') return 'invalid_source';
  if (typeof c.externalId !== 'string' || c.externalId === '') return 'invalid_external_id';
  if (!DATE_RE.test(c.txnDate) || addDays(c.txnDate, 0) !== c.txnDate) return 'invalid_date';
  if (!Number.isSafeInteger(c.amount) || c.amount <= 0) return 'invalid_amount';
  if (c.side !== 'income' && c.side !== 'expense') return 'invalid_side';
  if (typeof c.description !== 'string') return 'invalid_description';
  if (c.csvImportId != null && getCsvImportAccount(db, c.csvImportId) !== c.accountId) return 'csv_import_mismatch';
  return null;
}

export function dedupAndInsert(db: Db, inputs: DedupInput[], opts: { dateWindowDays: number; now: string }): DedupResult {
  const res: DedupResult = { new: [], merged: [], touched: [], suspects: [], errors: [] };
  const w = opts.dateWindowDays;
  return tx(db, () => {
    // 1. 外部 ID の一致。同じ入力の中で同じ外部 ID が重なった分も、先に入った方の touch にする。
    const rest: number[] = [];
    const seenInBatch = new Map<string, number>(); // key → 最初の index
    for (const [i, c] of inputs.entries()) {
      const err = validate(db, c);
      if (err) {
        res.errors.push({ index: i, reason: err });
        continue;
      }
      const key = JSON.stringify([c.accountId, c.source, c.externalId]);
      if (seenInBatch.has(key)) continue; // 先の行が決まってから touch にする（下）
      seenInBatch.set(key, i);
      const hit = findBankTxnByExternalId(db, c.accountId, c.source, c.externalId);
      if (hit) {
        touchBankTxn(db, hit.id, { lastSeenAt: opts.now, freeeStatus: c.freeeStatus, dueAmount: c.dueAmount });
        res.touched.push({ index: i, bankTxnId: hit.id });
      } else rest.push(i);
    }

    // 2・3. 口座・取得元・side・金額・日付でまとめ、出現順を保って既存の明細と組む。
    const groups = new Map<string, number[]>();
    for (const i of rest) {
      const c = inputs[i]!;
      const key = JSON.stringify([c.accountId, c.source, c.side, c.amount, c.txnDate]);
      const g = groups.get(key);
      if (g) g.push(i);
      else groups.set(key, [i]);
    }
    for (const idxs of groups.values()) {
      const c0 = inputs[idxs[0]!]!;
      const cands = findDedupCandidates(db, {
        accountId: c0.accountId,
        side: c0.side,
        amount: c0.amount,
        from: addDays(c0.txnDate, -w),
        to: addDays(c0.txnDate, w),
        source: c0.source,
      });
      const clean = cands.length === 1 && idxs.length === 1;
      for (const [k, i] of idxs.entries()) {
        const c = inputs[i]!;
        const pair = cands[k];
        if (pair) {
          addBankTxnSource(db, { bankTxnId: pair.id, source: c.source, externalId: c.externalId, csvImportId: c.csvImportId, rawSha256: c.rawSha256 });
          res.merged.push({ index: i, bankTxnId: pair.id });
          continue;
        }
        const t = insertBankTxn(db, {
          accountId: c.accountId,
          txnDate: c.txnDate,
          amount: c.amount,
          side: c.side,
          description: c.description,
          descriptionNorm: c.descriptionNorm ?? normalizeVendor(c.description),
          freeeStatus: c.freeeStatus,
          dueAmount: c.dueAmount,
          balance: c.balance,
          now: opts.now,
        });
        addBankTxnSource(db, { bankTxnId: t.id, source: c.source, externalId: c.externalId, csvImportId: c.csvImportId, rawSha256: c.rawSha256 });
        res.new.push({ index: i, bankTxnId: t.id });
        // 候補があったのに組めなかった分は重複の疑い（候補が 0 件なら片側だけにある明細）。
        if (!clean && cands.length > 0) res.suspects.push({ index: i, bankTxnId: t.id, candidateIds: cands.map((x) => x.id) });
      }
    }

    // 同じ入力の中で外部 ID が重なった 2 行目以降。
    const byIndex = new Map<number, string>();
    for (const h of [...res.touched, ...res.merged, ...res.new]) byIndex.set(h.index, h.bankTxnId);
    for (const [i, c] of inputs.entries()) {
      if (res.errors.some((e) => e.index === i)) continue;
      const first = seenInBatch.get(JSON.stringify([c.accountId, c.source, c.externalId]))!;
      if (first === i) continue;
      const id = byIndex.get(first)!;
      touchBankTxn(db, id, { lastSeenAt: opts.now, freeeStatus: c.freeeStatus, dueAmount: c.dueAmount });
      res.touched.push({ index: i, bankTxnId: id });
    }
    for (const k of ['new', 'merged', 'touched'] as const) res[k].sort((a, b) => a.index - b.index);
    res.suspects.sort((a, b) => a.index - b.index);
    return res;
  });
}
