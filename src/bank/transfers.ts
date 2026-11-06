// 口座間振替・カードの引き落とし・PayPay のチャージの検出（docs/mvp-plan-v3.md T107、requirements-v2.md A4）。
// 見つけた組は transfer_links（source=auto、state=active）に追記し、月次の集計から除く。
// - 振替: 口座 A の出金と口座 B の入金が同額・日付差 0〜windowDays 日で、お互いに候補が 1 件ずつ → kind=transfer
// - チャージ: 上の組のうち、入金側が paypay の口座で出金側が bank / card の口座 → kind=charge
//   card の出金はチャージの相手としてだけ組む。card の入金（返金）は組まない
//   paypay の口座の入金は摘要が「チャージ」で始まるものだけを候補にする（受け取った金額などを誤って組まない）。
//   paypay の口座の出金（送った金額・支払い）は組まない
// - 引き落とし: カードの口座に card_settlement_account_id と card_settlement_pattern があるとき、その銀行口座の出金で
//   摘要がパターンを含むもの → kind=card_settlement（in_txn_id は NULL。カード側に引き落としの明細は無い）
// 同じ組で最新の行が rejected なら作らない。active な組に入っている明細は候補にしない（作り直さない）。
import { tx, type Db } from '../db/index.ts';
import { appendAudit } from '../audit.ts';
import { normalizeVendor } from '../vendors/normalize.ts';
import { listAccounts } from './repo.ts';
import { addDays } from './dedup.ts';
import {
  getTransferLink,
  insertTransferLink,
  latestTransferLinkForPair,
  listActiveTransferLinks,
  listLatestTransferLinks,
  listTxnsWithAccount,
  type TransferKind,
  type TransferLinkRow,
  type TxnWithAccount,
} from './transferRepo.ts';

export type TransferPair = { outTxnId: string; inTxnId: string | null; kind: TransferKind };

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

const pairKey = (outId: string, inId: string | null) => JSON.stringify([outId, inId]);

// 摘要がパターンを含むか。両側を取引先名の正規化（NFKC・小文字・空白除去など）で揃える。
export function matchesSettlementPattern(description: string, pattern: string | null): boolean {
  if (pattern == null) return false;
  const p = normalizeVendor(pattern);
  return p !== '' && normalizeVendor(description).includes(p);
}

function groupByAmount(ts: TxnWithAccount[]): Map<number, TxnWithAccount[]> {
  const m = new Map<number, TxnWithAccount[]>();
  for (const t of ts) {
    const g = m.get(t.amount);
    if (g) g.push(t);
    else m.set(t.amount, [t]);
  }
  return m;
}

const CHARGE_PREFIX = 'チャージ';

// 振替・チャージの候補になる組か。card の出金は入金側が paypay のとき（チャージ）だけ。
// paypay の出金は組まない。paypay の入金は摘要が「チャージ」で始まるものだけ。
function pairable(o: TxnWithAccount, i: TxnWithAccount, windowDays: number): boolean {
  if (o.account_id === i.account_id) return false;
  if (o.account_kind === 'paypay') return false;
  if (i.account_kind === 'paypay' && !i.description.trimStart().startsWith(CHARGE_PREFIX)) return false;
  if (o.account_kind === 'card' && i.account_kind !== 'paypay') return false;
  return dayDiff(o.txn_date, i.txn_date) <= windowDays;
}

// 純粋な検出。txns は対象の明細、linked は active な組に入っている明細の ID、rejected は最新が rejected の組のキー。
export function findTransferPairs(
  txns: TxnWithAccount[],
  cards: { settlementAccountId: string; pattern: string }[],
  opts: { windowDays: number; linked: Set<string>; rejected: Set<string> },
): TransferPair[] {
  const out: TransferPair[] = [];
  const used = new Set(opts.linked);
  const free = txns.filter((t) => !used.has(t.id));

  // カードの引き落とし。
  for (const t of free) {
    if (t.side !== 'expense') continue;
    if (!cards.some((c) => c.settlementAccountId === t.account_id && matchesSettlementPattern(t.description, c.pattern))) continue;
    if (opts.rejected.has(pairKey(t.id, null))) continue;
    out.push({ outTxnId: t.id, inTxnId: null, kind: 'card_settlement' });
    used.add(t.id);
  }

  // 振替・チャージ。card の入金（返金）は候補にしない。候補の数は rejected の組も含めて数える（外した組があっても別の相手を自動では選ばない）。
  const rest = free.filter((t) => !used.has(t.id));
  const outs = groupByAmount(rest.filter((t) => t.side === 'expense'));
  const ins = groupByAmount(rest.filter((t) => t.side === 'income' && t.account_kind !== 'card'));
  const w = opts.windowDays;
  for (const [amount, os] of outs) {
    const is = ins.get(amount);
    if (!is) continue;
    for (const o of os) {
      const oc = is.filter((i) => pairable(o, i, w));
      if (oc.length !== 1) continue;
      const i = oc[0]!;
      if (os.filter((x) => pairable(x, i, w)).length !== 1) continue;
      if (opts.rejected.has(pairKey(o.id, i.id))) continue;
      const kind: TransferKind = i.account_kind === 'paypay' && (o.account_kind === 'bank' || o.account_kind === 'card') ? 'charge' : 'transfer';
      out.push({ outTxnId: o.id, inTxnId: i.id, kind });
    }
  }
  return out;
}

// 検出して transfer_links に追記する。範囲を渡したときは、出金側の日付が範囲に入る組だけを作る。
// 1 対 1 の判定を範囲なしと揃えるため、明細は [from − 2w, to + 2w] を読む（相手の候補の、そのまた候補まで）。
export function detectTransfers(
  db: Db,
  opts: { windowDays: number; now: Date; from?: string; to?: string },
): TransferLinkRow[] {
  return tx(db, () => {
    const w = opts.windowDays;
    const txns = listTxnsWithAccount(db, {
      from: opts.from ? addDays(opts.from, -2 * w) : undefined,
      to: opts.to ? addDays(opts.to, 2 * w) : undefined,
    });
    const linked = new Set<string>();
    const rejected = new Set<string>();
    for (const l of listLatestTransferLinks(db)) {
      if (l.state === 'active') {
        linked.add(l.out_txn_id);
        if (l.in_txn_id) linked.add(l.in_txn_id);
      } else rejected.add(pairKey(l.out_txn_id, l.in_txn_id));
    }
    const cards = listAccounts(db)
      .filter((a) => a.kind === 'card' && a.card_settlement_account_id && a.card_settlement_pattern)
      .map((a) => ({ settlementAccountId: a.card_settlement_account_id!, pattern: a.card_settlement_pattern! }));
    const byId = new Map(txns.map((t) => [t.id, t]));
    const created: TransferLinkRow[] = [];
    for (const p of findTransferPairs(txns, cards, { windowDays: w, linked, rejected })) {
      const d = byId.get(p.outTxnId)!.txn_date;
      if ((opts.from && d < opts.from) || (opts.to && d > opts.to)) continue;
      created.push(insertTransferLink(db, { ...p, source: 'auto', state: 'active', now: opts.now.toISOString() }));
    }
    return created;
  });
}

// 人が組を外す。state=rejected の行を追記し、監査に残す。既に最新が rejected なら何もしない。組が無ければ null。
export function rejectTransfer(db: Db, linkId: string, actor: string, now: Date = new Date()): TransferLinkRow | null {
  return tx(db, () => {
    const l = getTransferLink(db, linkId);
    if (!l) return null;
    const latest = latestTransferLinkForPair(db, l.out_txn_id, l.in_txn_id)!;
    if (latest.state === 'rejected') return latest;
    const r = insertTransferLink(db, { outTxnId: l.out_txn_id, inTxnId: l.in_txn_id, kind: l.kind, source: 'human', state: 'rejected', now: now.toISOString() });
    appendAudit(db, { actor, action: 'transfer.rejected', entity: 'transfer_link', entityId: r.id, payload: { link_id: linkId, out_txn_id: l.out_txn_id, in_txn_id: l.in_txn_id, kind: l.kind } }, now);
    return r;
  });
}

// 有効な組の一覧。範囲は出金側の明細の日付で絞る。
export function listActiveTransfers(db: Db, range: { from?: string; to?: string } = {}) {
  return listActiveTransferLinks(db, range);
}

// 集計から除く明細の ID（有効な組の出金側と入金側）。月をまたぐ組の入金側も落とさないよう、範囲では絞らない。
export function excludedFromCashflow(db: Db): Set<string> {
  const s = new Set<string>();
  for (const l of listActiveTransferLinks(db)) {
    s.add(l.out_txn_id);
    if (l.in_txn_id) s.add(l.in_txn_id);
  }
  return s;
}
