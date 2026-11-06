// 明細の重複排除（docs/mvp-plan-v3.md T106、requirements-v2.md A3）。同じ口座が API と CSV の両方から来ても 1 件にする。
// 次の順に照合し、どれにも当たらなければ新しい明細にする。
// 1. 同じ source・同じ口座・同じ external_id → 同じ明細（touch だけ）
// 2. source が違い、同じ口座・同じ日付（±dedupDateWindowDays）・同じ金額・同じ side の候補がちょうど 1 件 → bank_txn_sources を足す（統合）
// 3. 候補が複数 → 同じ日の中の出現順で 1 対 1 に組み、組めなかった分は新しい明細にして「重複の疑い」として返す
// 組み方: 口座・取得元・side・金額でまとめ、日付順（同じ日は入力の出現順）に、|日付差| が小さい順 → 挿入順の候補を取る。
// 入力の並び順によらず結果が同じになる。バッチの開始時点で候補があったのに組めなかった入力を「重複の疑い」にする。
// 統合したとき、入力が freee なら freee_status・due_amount を書き、残高は NULL のときだけ埋める。csv なら last_seen_at だけ書く。
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
import { fillBankTxnBalance, findDedupCandidates, getCsvImportAccount } from './transferRepo.ts';

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

// csv の入力は freee の列（freee_status・due_amount）を書かない。
function touchFrom(db: Db, id: string, c: DedupInput, now: string): void {
  if (c.source === 'freee') {
    touchBankTxn(db, id, { lastSeenAt: now, freeeStatus: c.freeeStatus, dueAmount: c.dueAmount });
    if (c.balance != null) fillBankTxnBalance(db, id, c.balance);
  } else touchBankTxn(db, id, { lastSeenAt: now });
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export function dedupAndInsert(db: Db, inputs: DedupInput[], opts: { dateWindowDays: number; now: string }): DedupResult {
  const res: DedupResult = { new: [], merged: [], touched: [], suspects: [], errors: [] };
  const w = opts.dateWindowDays;
  const candidatesOf = (c: DedupInput) =>
    findDedupCandidates(db, { accountId: c.accountId, side: c.side, amount: c.amount, from: addDays(c.txnDate, -w), to: addDays(c.txnDate, w), source: c.source });
  return tx(db, () => {
    // 1. 外部 ID の一致。同じ入力の中で同じ外部 ID が重なった 2 行目以降は、日付・金額・side が同じなら先の行の touch、違えば errors。
    const rest: number[] = [];
    const firstOf = new Map<string, number>(); // key → 最初の index
    const dupOf = new Map<number, number>(); // 2 行目以降の index → 最初の index
    for (const [i, c] of inputs.entries()) {
      const err = validate(db, c);
      if (err) {
        res.errors.push({ index: i, reason: err });
        continue;
      }
      const key = JSON.stringify([c.accountId, c.source, c.externalId]);
      const first = firstOf.get(key);
      if (first !== undefined) {
        const f = inputs[first]!;
        if (f.txnDate !== c.txnDate || f.amount !== c.amount || f.side !== c.side) res.errors.push({ index: i, reason: 'external_id_conflict' });
        else dupOf.set(i, first);
        continue;
      }
      firstOf.set(key, i);
      const hit = findBankTxnByExternalId(db, c.accountId, c.source, c.externalId);
      if (hit) {
        if (hit.txn_date !== c.txnDate || hit.amount !== c.amount || hit.side !== c.side) {
          res.errors.push({ index: i, reason: 'external_id_conflict' });
          continue;
        }
        touchFrom(db, hit.id, c, opts.now);
        res.touched.push({ index: i, bankTxnId: hit.id });
      } else rest.push(i);
    }

    // バッチの開始時点（統合・新規を書く前）の候補。
    const initial = new Map<number, string[]>();
    for (const i of rest) initial.set(i, candidatesOf(inputs[i]!).map((x) => x.id));

    // 2・3. 口座・取得元・side・金額でまとめ、日付順（同じ日は出現順）に組む。
    const groups = new Map<string, number[]>();
    for (const i of rest) {
      const c = inputs[i]!;
      const key = JSON.stringify([c.accountId, c.source, c.side, c.amount]);
      const g = groups.get(key);
      if (g) g.push(i);
      else groups.set(key, [i]);
    }
    for (const idxs of groups.values()) {
      idxs.sort((a, b) => (inputs[a]!.txnDate < inputs[b]!.txnDate ? -1 : inputs[a]!.txnDate > inputs[b]!.txnDate ? 1 : a - b));
      for (const i of idxs) {
        const c = inputs[i]!;
        // 取得元 source をまだ持たない明細だけが返るので、先に組んだ明細は候補から外れる。
        const cands = candidatesOf(c).sort((x, y) => dayDiff(x.txn_date, c.txnDate) - dayDiff(y.txn_date, c.txnDate) || x.seq - y.seq);
        const pair = cands[0];
        if (pair) {
          addBankTxnSource(db, { bankTxnId: pair.id, source: c.source, externalId: c.externalId, csvImportId: c.csvImportId, rawSha256: c.rawSha256 });
          touchFrom(db, pair.id, c, opts.now);
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
          freeeStatus: c.source === 'freee' ? c.freeeStatus : null,
          dueAmount: c.source === 'freee' ? c.dueAmount : null,
          balance: c.balance,
          now: opts.now,
        });
        addBankTxnSource(db, { bankTxnId: t.id, source: c.source, externalId: c.externalId, csvImportId: c.csvImportId, rawSha256: c.rawSha256 });
        res.new.push({ index: i, bankTxnId: t.id });
        // 開始時点で候補があったのに組めなかった分は重複の疑い（候補が 0 件なら片側だけにある明細）。
        const init = initial.get(i)!;
        if (init.length > 0) res.suspects.push({ index: i, bankTxnId: t.id, candidateIds: init });
      }
    }

    // 同じ入力の中で外部 ID が重なった 2 行目以降。
    const byIndex = new Map<number, string>();
    for (const h of [...res.touched, ...res.merged, ...res.new]) byIndex.set(h.index, h.bankTxnId);
    for (const [i, first] of dupOf) {
      const id = byIndex.get(first);
      if (!id) {
        res.errors.push({ index: i, reason: 'external_id_conflict' }); // 先の行が errors に入った
        continue;
      }
      touchFrom(db, id, inputs[i]!, opts.now);
      res.touched.push({ index: i, bankTxnId: id });
    }
    for (const k of ['new', 'merged', 'touched', 'suspects', 'errors'] as const) (res[k] as { index: number }[]).sort((a, b) => a.index - b.index);
    return res;
  });
}
