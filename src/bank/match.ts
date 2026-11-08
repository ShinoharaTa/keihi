// 明細 ⇔ 証憑の照合と領収書待ち（docs/mvp-plan-v3.md T206・T207、docs/cashflow.md §15、0009_matches.sql）。
// - 経費の明細: 効くタグ（tags.ts）が business、side = expense、振替の除外（transfers.ts の excludedFromCashflow）でない、active な口座の明細。
//   照合の候補にできる明細は、これに加えてタグが unset の支出も入れる（private は入れない）。
// - 候補にできる証憑: documents.status が rejected / duplicate / personal 以外。値は最新の reviews の版（txn_date・amount・vendor）、
//   無ければ最新の extractions（txn_date・amount_total・vendor_name）。
// - 有効な紐付け: 組 (bank_txn_id, document_id) の最新の行が auto か confirmed で、証憑が候補にできる状態。auto はさらに
//   証憑の今の金額が明細の金額と等しいこと（確定で金額が直ったら自動の紐付けは効かなくなる）。人の紐付けは 1 対多・多対 1 でよい。
// - 候補（保存しない。読むたびに計算する）: 金額が等しく、証憑の日 − 1 ≤ 明細の日 ≤ 証憑の日 + W（W はカードの口座なら
//   [bank] match_card_date_window_days、それ以外は match_date_window_days）。その組に行がある（rejected を含む）か、
//   明細か証憑のどちらかが既に有効な紐付けを持つなら候補にしない。
//   相手名: 証憑の vendor を normalizeVendor にかけ、明細の description_norm と比べて、短いほうが 3 文字以上でどちらかが
//   もう一方を含めば vendor_match = 1。score = (vendor_match ? 50 : 0) + max(0, 50 − 5 × |date_diff|)。
// - 自動照合（runMatching）: 明細から見て候補が 1 件、証憑から見ても候補が 1 件、かつ（vendor_match = 1 か |date_diff| ≤ 1）なら
//   state=auto を追記し、1 件ごとに監査（txn_match.auto。摘要・金額は入れない）に残す。それ以外は何も書かない。
// - receipt（経費の明細だけ。それ以外は null）: matched（有効な紐付けの証憑が approved / sent / verified）/ pending_review
//   （有効な紐付けはあるが確認前）/ candidate（候補が 1 件以上）/ waiting（領収書待ち）。
// - receipt_hint: 経費か unset の支出に有効な紐付けがあるとき、最後に紐付けた証憑の {document_id, status}。
import { appendAudit } from '../audit.ts';
import { DEFAULT_MATCH_CARD_DATE_WINDOW_DAYS, DEFAULT_MATCH_DATE_WINDOW_DAYS } from '../config.ts';
import { tx, type Db } from '../db/index.ts';
import { normalizeVendor } from '../vendors/normalize.ts';
import { resolveTagsBulk, type ResolvedTag } from './tags.ts';
import { excludedFromCashflow } from './transfers.ts';

export const UNMATCHABLE_STATUSES: readonly string[] = ['rejected', 'duplicate', 'personal'];
export const MATCHED_STATUSES: readonly string[] = ['approved', 'sent', 'verified'];
export const RECEIPT_STATUSES = ['matched', 'pending_review', 'candidate', 'waiting'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const MAX_CANDIDATES = 10;
// 相手名を比べる短いほうの最小の文字数。
const VENDOR_MIN_LENGTH = 3;

export type MatchWindows = { bankDays: number; cardDays: number };
export const DEFAULT_MATCH_WINDOWS: MatchWindows = { bankDays: DEFAULT_MATCH_DATE_WINDOW_DAYS, cardDays: DEFAULT_MATCH_CARD_DATE_WINDOW_DAYS };

// config の [bank]（テストの config では省くことがある）から幅を作る。
export function matchWindowsOf(bank: { matchDateWindowDays: number; matchCardDateWindowDays: number } | undefined): MatchWindows {
  return bank ? { bankDays: bank.matchDateWindowDays, cardDays: bank.matchCardDateWindowDays } : DEFAULT_MATCH_WINDOWS;
}

export function isReceiptStatus(v: unknown): v is ReceiptStatus {
  return (RECEIPT_STATUSES as readonly unknown[]).includes(v);
}

export type TxnMatchState = 'auto' | 'confirmed' | 'rejected';
export type TxnMatchActor = 'system' | 'user' | 'agent';
export type TxnMatchRow = {
  seq: number;
  bank_txn_id: string;
  document_id: string;
  state: TxnMatchState;
  actor: TxnMatchActor;
  score: number | null;
  date_diff: number | null;
  vendor_match: 0 | 1 | null;
  created_at: string;
};

export type DocBrief = {
  id: string;
  status: string;
  kind: string;
  source: string;
  txn_date: string | null;
  amount: number | null;
  vendor: string | null;
  thumbnail_url: string | null;
};
export type TxnBrief = { id: string; account_name: string; txn_date: string; amount: number; description: string };
export type Link = {
  bank_txn_id: string;
  document_id: string;
  state: TxnMatchState;
  actor: TxnMatchActor;
  score: number | null;
  created_at: string;
  document: DocBrief;
  txn: TxnBrief;
};
export type Candidate = { document_id: string; score: number; date_diff: number; vendor_match: 0 | 1; document: DocBrief };
export type ReceiptInfo = { receipt: ReceiptStatus | null; receipt_hint: { document_id: string; status: string } | null };

export class MatchError extends Error {
  readonly status: 400 | 404 | 409 | 422;
  readonly reason: string;
  constructor(status: 400 | 404 | 409 | 422, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

// ---- 読み出し（SQL） ----

type DocValue = { id: string; status: string; kind: string; source: string; mime: string; txn_date: string | null; amount: number | null; vendor: string | null };

type DocSqlRow = {
  id: string;
  status: string;
  kind: string;
  source: string;
  mime: string;
  has_review: number;
  r_date: string | null;
  r_amount: number | null;
  r_vendor: string | null;
  e_date: string | null;
  e_amount: number | null;
  e_vendor: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// 証憑の今の値（最新の確定の版、無ければ最新の抽出）。ids を渡せばそれだけ。
function loadDocs(db: Db, ids?: readonly string[]): Map<string, DocValue> {
  const rows = db
    .prepare(
      `SELECT d.id, d.status, d.kind, d.source, d.mime, r.id IS NOT NULL AS has_review,
         r.txn_date AS r_date, r.amount AS r_amount, r.vendor AS r_vendor,
         e.txn_date AS e_date, e.amount_total AS e_amount, e.vendor_name AS e_vendor
       FROM documents d
       LEFT JOIN reviews r ON r.document_id = d.id AND r.version = (SELECT max(version) FROM reviews WHERE document_id = d.id)
       LEFT JOIN extractions e ON e.id = (SELECT id FROM extractions WHERE document_id = d.id ORDER BY created_at DESC, id DESC LIMIT 1)
       ${ids ? 'WHERE d.id IN (SELECT value FROM json_each(?))' : ''}`,
    )
    .all(...(ids ? [JSON.stringify(ids)] : [])) as DocSqlRow[];
  const out = new Map<string, DocValue>();
  for (const r of rows) {
    const reviewed = r.has_review === 1;
    const date = reviewed ? r.r_date : r.e_date;
    out.set(r.id, {
      id: r.id,
      status: r.status,
      kind: r.kind,
      source: r.source,
      mime: r.mime,
      txn_date: date !== null && DATE.test(date) ? date : null,
      amount: reviewed ? r.r_amount : r.e_amount,
      vendor: reviewed ? r.r_vendor : r.e_vendor,
    });
  }
  return out;
}

type MatchTxn = {
  id: string;
  account_name: string;
  account_kind: string;
  account_active: number;
  txn_date: string;
  amount: number;
  side: string;
  description: string;
  description_norm: string;
};

const TXN_SELECT = `SELECT t.id, a.name AS account_name, a.kind AS account_kind, a.active AS account_active, t.txn_date, t.amount, t.side,
  t.description, t.description_norm FROM bank_txns t JOIN money_accounts a ON a.id = t.account_id`;

function loadTxnsByIds(db: Db, ids: readonly string[]): MatchTxn[] {
  if (ids.length === 0) return [];
  return db.prepare(`${TXN_SELECT} WHERE t.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as MatchTxn[];
}

// 照合の候補になりうる明細（active な口座の支出）。タグと振替の除外は呼ぶ側で落とす。
function loadExpenseTxns(db: Db): MatchTxn[] {
  return db.prepare(`${TXN_SELECT} WHERE t.side = 'expense' AND a.active = 1 ORDER BY t.txn_date, t.id`).all() as MatchTxn[];
}

type LatestRow = TxnMatchRow & { txn_amount: number };

// 組ごとの最新の行（明細の金額付き）。
function loadLatestRows(db: Db): LatestRow[] {
  return db
    .prepare(
      `SELECT m.*, t.amount AS txn_amount FROM txn_matches m JOIN bank_txns t ON t.id = m.bank_txn_id
       WHERE m.seq = (SELECT max(seq) FROM txn_matches x WHERE x.bank_txn_id = m.bank_txn_id AND x.document_id = m.document_id)
       ORDER BY m.seq`,
    )
    .all() as LatestRow[];
}

function latestRowForPair(db: Db, txnId: string, docId: string): TxnMatchRow | null {
  return (
    (db.prepare('SELECT * FROM txn_matches WHERE bank_txn_id = ? AND document_id = ? ORDER BY seq DESC LIMIT 1').get(txnId, docId) as
      | TxnMatchRow
      | undefined) ?? null
  );
}

function insertMatchRow(
  db: Db,
  r: { txnId: string; docId: string; state: TxnMatchState; actor: TxnMatchActor; score: number | null; dateDiff: number | null; vendorMatch: 0 | 1 | null; now: string },
): TxnMatchRow {
  const res = db
    .prepare('INSERT INTO txn_matches (bank_txn_id, document_id, state, actor, score, date_diff, vendor_match, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.txnId, r.docId, r.state, r.actor, r.score, r.dateDiff, r.vendorMatch, r.now);
  return db.prepare('SELECT * FROM txn_matches WHERE seq = ?').get(res.lastInsertRowid) as TxnMatchRow;
}

// ---- 判定（純粋） ----

// a − b の日数。
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function vendorMatches(vendor: string | null, descriptionNorm: string): boolean {
  if (vendor === null) return false;
  const v = normalizeVendor(vendor);
  if (Math.min(v.length, descriptionNorm.length) < VENDOR_MIN_LENGTH) return false;
  return v.includes(descriptionNorm) || descriptionNorm.includes(v);
}

export function matchScore(vendorMatch: boolean, dateDiff: number): number {
  return (vendorMatch ? 50 : 0) + Math.max(0, 50 - 5 * Math.abs(dateDiff));
}

function windowDays(t: Pick<MatchTxn, 'account_kind'>, w: MatchWindows): number {
  return t.account_kind === 'card' ? w.cardDays : w.bankDays;
}

// 証憑の日 − 1 ≤ 明細の日 ≤ 証憑の日 + W。
function inWindow(dateDiff: number, w: number): boolean {
  return dateDiff >= -1 && dateDiff <= w;
}

type Pair = { txn: MatchTxn; doc: DocValue; date_diff: number; vendor_match: 0 | 1; score: number };

function pairOf(t: MatchTxn, d: DocValue, w: MatchWindows): Pair | null {
  if (d.amount !== t.amount || d.txn_date === null) return null;
  const diff = dayDiff(t.txn_date, d.txn_date);
  if (!inWindow(diff, windowDays(t, w))) return null;
  const vm = vendorMatches(d.vendor, t.description_norm);
  return { txn: t, doc: d, date_diff: diff, vendor_match: vm ? 1 : 0, score: matchScore(vm, diff) };
}

function isMatchableDoc(d: DocValue): boolean {
  return !UNMATCHABLE_STATUSES.includes(d.status);
}

function isEffective(r: LatestRow, d: DocValue | undefined): boolean {
  if (r.state === 'rejected' || !d || !isMatchableDoc(d)) return false;
  return r.state === 'confirmed' || d.amount === r.txn_amount;
}

// 経費の明細か（receipt を出す明細）。
function isExpenseTxn(t: MatchTxn, tag: ResolvedTag | undefined, excluded: ReadonlySet<string>): boolean {
  return t.side === 'expense' && t.account_active === 1 && !excluded.has(t.id) && tag?.tag === 'business';
}

// 照合の候補にできる明細か（経費 + unset の支出）。
function isMatchableTxn(t: MatchTxn, tag: ResolvedTag | undefined, excluded: ReadonlySet<string>): boolean {
  return t.side === 'expense' && t.account_active === 1 && !excluded.has(t.id) && (tag?.tag === 'business' || tag?.tag === 'unset');
}

const pairKey = (txnId: string, docId: string) => JSON.stringify([txnId, docId]);

// 1 回の読み出しで使う証憑・組の状態。
type Ctx = {
  windows: MatchWindows;
  docs: Map<string, DocValue>;
  pairs: Set<string>; // 行のある組（rejected を含む）
  linksByTxn: Map<string, LatestRow[]>; // 有効な紐付け（seq の昇順）
  linkedDocs: Set<string>;
  docsByAmount: Map<number, DocValue[]>; // 候補にできる証憑（金額と日付があるもの）
};

function loadContext(db: Db, windows: MatchWindows): Ctx {
  const docs = loadDocs(db);
  const pairs = new Set<string>();
  const linksByTxn = new Map<string, LatestRow[]>();
  const linkedDocs = new Set<string>();
  for (const r of loadLatestRows(db)) {
    pairs.add(pairKey(r.bank_txn_id, r.document_id));
    if (!isEffective(r, docs.get(r.document_id))) continue;
    const l = linksByTxn.get(r.bank_txn_id);
    if (l) l.push(r);
    else linksByTxn.set(r.bank_txn_id, [r]);
    linkedDocs.add(r.document_id);
  }
  const docsByAmount = new Map<number, DocValue[]>();
  for (const d of docs.values()) {
    if (!isMatchableDoc(d) || d.amount === null || d.txn_date === null) continue;
    const g = docsByAmount.get(d.amount);
    if (g) g.push(d);
    else docsByAmount.set(d.amount, [d]);
  }
  return { windows, docs, pairs, linksByTxn, linkedDocs, docsByAmount };
}

// 明細の候補（§4.3 の対象外を除く）。明細が既に有効な紐付けを持てば空。
function candidatesOf(ctx: Ctx, t: MatchTxn): Pair[] {
  if (ctx.linksByTxn.has(t.id)) return [];
  const out: Pair[] = [];
  for (const d of ctx.docsByAmount.get(t.amount) ?? []) {
    if (ctx.linkedDocs.has(d.id) || ctx.pairs.has(pairKey(t.id, d.id))) continue;
    const p = pairOf(t, d, ctx.windows);
    if (p) out.push(p);
  }
  return out.sort((a, b) => b.score - a.score || Math.abs(a.date_diff) - Math.abs(b.date_diff) || (a.doc.id < b.doc.id ? -1 : 1));
}

// ---- 表示用 ----

function docBrief(d: DocValue): DocBrief {
  return {
    id: d.id,
    status: d.status,
    kind: d.kind,
    source: d.source,
    txn_date: d.txn_date,
    amount: d.amount,
    vendor: d.vendor,
    thumbnail_url: d.mime === 'application/pdf' ? null : `/api/documents/${d.id}/thumbnail`,
  };
}

function txnBrief(t: MatchTxn): TxnBrief {
  return { id: t.id, account_name: t.account_name, txn_date: t.txn_date, amount: t.amount, description: t.description };
}

function linkView(r: TxnMatchRow, d: DocValue, t: MatchTxn): Link {
  return {
    bank_txn_id: r.bank_txn_id,
    document_id: r.document_id,
    state: r.state,
    actor: r.actor,
    score: r.score,
    created_at: r.created_at,
    document: docBrief(d),
    txn: txnBrief(t),
  };
}

function candidateView(p: Pair): Candidate {
  return { document_id: p.doc.id, score: p.score, date_diff: p.date_diff, vendor_match: p.vendor_match, document: docBrief(p.doc) };
}

// ---- 自動照合 ----

export type RunMatchingOptions = { windows?: MatchWindows };

// 候補を計算し、1 対 1 で決まる組を auto で追記する。作った行を返す。
export function runMatching(db: Db, now: Date, opts: RunMatchingOptions = {}): TxnMatchRow[] {
  const windows = opts.windows ?? DEFAULT_MATCH_WINDOWS;
  return tx(db, () => {
    const ctx = loadContext(db, windows);
    const excluded = excludedFromCashflow(db);
    const all = loadExpenseTxns(db).filter((t) => !excluded.has(t.id));
    const tags = resolveTagsBulk(db, all.map((t) => t.id));
    const txns = all.filter((t) => isMatchableTxn(t, tags.get(t.id), excluded));
    const byTxn = new Map<string, Pair[]>();
    const docCount = new Map<string, number>();
    for (const t of txns) {
      const cs = candidatesOf(ctx, t);
      if (cs.length === 0) continue;
      byTxn.set(t.id, cs);
      for (const p of cs) docCount.set(p.doc.id, (docCount.get(p.doc.id) ?? 0) + 1);
    }
    const iso = now.toISOString();
    const created: TxnMatchRow[] = [];
    for (const [txnId, cs] of byTxn) {
      if (cs.length !== 1) continue;
      const p = cs[0]!;
      if (docCount.get(p.doc.id) !== 1) continue;
      if (p.vendor_match !== 1 && Math.abs(p.date_diff) > 1) continue;
      const row = insertMatchRow(db, { txnId, docId: p.doc.id, state: 'auto', actor: 'system', score: p.score, dateDiff: p.date_diff, vendorMatch: p.vendor_match, now: iso });
      appendAudit(db, { actor: 'system', action: 'txn_match.auto', entity: 'bank_txn', entityId: txnId, payload: { bank_txn_id: txnId, document_id: p.doc.id, score: p.score } }, now);
      created.push(row);
    }
    return created;
  });
}

export type RunMatchingSafeResult = { created: number } | { error: string };

// 呼び元（同期・取り込み・抽出・確定・daily）を失敗にしないための版。失敗はログと監査（txn_match.failed。エラーの文だけ）に残す。
export function runMatchingSafe(
  db: Db,
  now: Date,
  opts: RunMatchingOptions & { log?: (s: string) => void } = {},
): RunMatchingSafeResult {
  try {
    return { created: runMatching(db, now, opts).length };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    (opts.log ?? ((s: string) => console.error(s)))(`照合に失敗: ${error}`);
    try {
      appendAudit(db, { actor: 'system', action: 'txn_match.failed', entity: 'bank_txn', payload: { error } }, now);
    } catch {
      // 監査も書けないときはログだけ残す（呼び元の結果は変えない）
    }
    return { error };
  }
}

// ---- receipt ----

// 明細 ID → receipt・receipt_hint を返す関数。証憑・組の状態は作るときに 1 回だけ読む（一覧のループで何度も呼ぶ）。
export function createReceiptResolver(db: Db, windows: MatchWindows = DEFAULT_MATCH_WINDOWS): (txnIds: readonly string[]) => Map<string, ReceiptInfo> {
  const ctx = loadContext(db, windows);
  const excluded = excludedFromCashflow(db);
  return (txnIds) => {
    const out = new Map<string, ReceiptInfo>();
    const txns = loadTxnsByIds(db, txnIds);
    const tags = resolveTagsBulk(db, txnIds);
    for (const t of txns) {
      const tag = tags.get(t.id);
      const links = ctx.linksByTxn.get(t.id) ?? [];
      const last = links[links.length - 1];
      const hint = last && isMatchableTxn(t, tag, excluded) ? { document_id: last.document_id, status: ctx.docs.get(last.document_id)!.status } : null;
      let receipt: ReceiptStatus | null = null;
      if (isExpenseTxn(t, tag, excluded)) {
        if (links.length > 0) receipt = links.some((l) => MATCHED_STATUSES.includes(ctx.docs.get(l.document_id)!.status)) ? 'matched' : 'pending_review';
        else receipt = candidatesOf(ctx, t).length > 0 ? 'candidate' : 'waiting';
      }
      out.set(t.id, { receipt, receipt_hint: hint });
    }
    return out;
  };
}

export function receiptStatusBulk(db: Db, txnIds: readonly string[], windows: MatchWindows = DEFAULT_MATCH_WINDOWS): Map<string, ReceiptInfo> {
  return createReceiptResolver(db, windows)(txnIds);
}

// ---- 人の操作（GET/POST /api/bank_txns/:id/matches、GET /api/documents/:id/matches） ----

// 明細の有効な紐付けと候補。明細が無ければ null。候補は照合の候補にできる明細のときだけ（score の高い順、最大 MAX_CANDIDATES 件）。
export function txnMatches(db: Db, txnId: string, windows: MatchWindows = DEFAULT_MATCH_WINDOWS): { links: Link[]; candidates: Candidate[] } | null {
  const t = loadTxnsByIds(db, [txnId])[0];
  if (!t) return null;
  const ctx = loadContext(db, windows);
  const links = (ctx.linksByTxn.get(t.id) ?? []).map((r) => linkView(r, ctx.docs.get(r.document_id)!, t));
  const excluded = excludedFromCashflow(db);
  const matchable = isMatchableTxn(t, resolveTagsBulk(db, [t.id]).get(t.id), excluded);
  const candidates = matchable ? candidatesOf(ctx, t).slice(0, MAX_CANDIDATES).map(candidateView) : [];
  return { links, candidates };
}

// 証憑の有効な紐付け。証憑が無ければ null。
export function documentMatches(db: Db, docId: string): { links: Link[] } | null {
  const d = loadDocs(db, [docId]).get(docId);
  if (!d) return null;
  const rows = (
    db
      .prepare(
        `SELECT m.*, t.amount AS txn_amount FROM txn_matches m JOIN bank_txns t ON t.id = m.bank_txn_id
         WHERE m.document_id = ? AND m.seq = (SELECT max(seq) FROM txn_matches x WHERE x.bank_txn_id = m.bank_txn_id AND x.document_id = m.document_id)
         ORDER BY m.seq`,
      )
      .all(docId) as LatestRow[]
  ).filter((r) => isEffective(r, d));
  const txns = new Map(loadTxnsByIds(db, rows.map((r) => r.bank_txn_id)).map((t) => [t.id, t]));
  return { links: rows.map((r) => linkView(r, d, txns.get(r.bank_txn_id)!)) };
}

export type LinkInput = { txnId: string; documentId: unknown; user: string | null; now: Date; windows?: MatchWindows };

// 人が紐付ける（state=confirmed を追記）。金額や日付が外れていても拒否せず warnings で返す。
export function linkDocument(db: Db, input: LinkInput): { link: Link; warnings: string[] } {
  if (typeof input.documentId !== 'string' || input.documentId === '') throw new MatchError(400, 'document_id_required');
  const docId = input.documentId;
  const windows = input.windows ?? DEFAULT_MATCH_WINDOWS;
  return tx(db, () => {
    const t = loadTxnsByIds(db, [input.txnId])[0];
    if (!t) throw new MatchError(404, 'not_found');
    const d = loadDocs(db, [docId]).get(docId);
    if (!d) throw new MatchError(404, 'document_not_found');
    if (!isMatchableDoc(d)) throw new MatchError(422, 'document_not_matchable');
    const latest = latestRowForPair(db, t.id, d.id);
    if (latest && isEffective({ ...latest, txn_amount: t.amount }, d)) throw new MatchError(409, 'already_linked');
    const warnings: string[] = [];
    if (d.amount !== t.amount) warnings.push('amount_mismatch');
    const diff = d.txn_date === null ? null : dayDiff(t.txn_date, d.txn_date);
    if (diff === null || !inWindow(diff, windowDays(t, windows))) warnings.push('date_out_of_window');
    const vm = vendorMatches(d.vendor, t.description_norm) ? 1 : 0;
    const row = insertMatchRow(db, { txnId: t.id, docId: d.id, state: 'confirmed', actor: 'user', score: null, dateDiff: diff, vendorMatch: vm, now: input.now.toISOString() });
    appendAudit(
      db,
      { actor: 'user', action: 'txn_match.linked', entity: 'bank_txn', entityId: t.id, payload: { bank_txn_id: t.id, document_id: d.id, warnings, user: input.user } },
      input.now,
    );
    return { link: linkView(row, d, t), warnings };
  });
}

// 人が外す（state=rejected を追記）。有効な紐付けが無ければ 409 not_linked。
export function unlinkDocument(db: Db, input: { txnId: string; documentId: string; user: string | null; now: Date }): { link: Link } {
  return tx(db, () => {
    const t = loadTxnsByIds(db, [input.txnId])[0];
    if (!t) throw new MatchError(404, 'not_found');
    const d = loadDocs(db, [input.documentId]).get(input.documentId);
    if (!d) throw new MatchError(404, 'document_not_found');
    const latest = latestRowForPair(db, t.id, d.id);
    if (!latest || !isEffective({ ...latest, txn_amount: t.amount }, d)) throw new MatchError(409, 'not_linked');
    const row = insertMatchRow(db, {
      txnId: t.id, docId: d.id, state: 'rejected', actor: 'user', score: null, dateDiff: latest.date_diff, vendorMatch: latest.vendor_match, now: input.now.toISOString(),
    });
    appendAudit(
      db,
      { actor: 'user', action: 'txn_match.unlinked', entity: 'bank_txn', entityId: t.id, payload: { bank_txn_id: t.id, document_id: d.id, from: latest.state, user: input.user } },
      input.now,
    );
    return { link: linkView(row, d, t) };
  });
}
